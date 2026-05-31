import {
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
} from "expo-audio";
import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

const STORED_DEVICE_KEY = "brah.mobile.device.v1";
const CLIENT_ID_KEY = "brah.mobile.clientId.v1";
const DEFAULT_PORT = "19455";
const REQUEST_TIMEOUT_MS = 8000;
const ASSISTANT_TIMEOUT_MS = 180000;
const VOICE_SAMPLE_RATE = 24000;
const VOICE_OUTPUT_SAMPLE_RATE = 24000;
const VOICE_CHANNELS = 1;
const APP_BUILD_LABEL = "mobile-realtime-conversation-v4-sdk56";
const APP_RUNTIME_LABEL = Constants.appOwnership === "expo" ? "Expo Go" : "dev client";
let nativeVoiceModule = null;

export default function App() {
  const socketRef = useRef(null);
  const pendingRef = useRef(new Map());
  const handledPairingUrlsRef = useRef(new Set());
  const pairingInFlightRef = useRef(false);
  const [clientId, setClientId] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(DEFAULT_PORT);
  const [pairingCode, setPairingCode] = useState("");
  const [deviceName, setDeviceName] = useState("Android");
  const [storedDevice, setStoredDevice] = useState(null);
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState(
    "Enter the host and pairing code from Brah desktop.",
  );
  const [openAIStatus, setOpenAIStatus] = useState(null);
  const [toolCount, setToolCount] = useState(null);
  const [toolName, setToolName] = useState("list_tasks");
  const [toolArgs, setToolArgs] = useState("{}");
  const [toolResult, setToolResult] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const chatMessagesRef = useRef([]);
  const voiceStartedAtRef = useRef(0);
  const activeVoiceTurnRef = useRef(null);
  const handleVoiceStreamEventRef = useRef(null);
  const voicePlayerRef = useRef(null);
  const voicePipelineConnectedRef = useRef(false);
  const voicePipelineTurnRef = useRef(null);
  const voicePipelineFirstChunkRef = useRef(true);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [streamingVoice, setStreamingVoice] = useState(false);
  const [voiceReady, setVoiceReady] = useState(false);
  const [conversationActive, setConversationActive] = useState(false);
  const [voiceSummary, setVoiceSummary] = useState("");
  const [scanning, setScanning] = useState(false);
  const [pendingAutoPair, setPendingAutoPair] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const { stream: voiceInputStream } = useAudioStream({
    sampleRate: VOICE_SAMPLE_RATE,
    channels: VOICE_CHANNELS,
    encoding: "int16",
    onBuffer: (buffer) => {
      queueVoiceStreamBuffer(activeVoiceTurnRef.current, buffer, sendBridgeRequest, (message) => {
        setStatusText(message);
      });
    },
  });
  const bridgeUrl = useMemo(() => {
    const cleanHost = host.trim();
    const cleanPort = port.trim() || DEFAULT_PORT;
    return cleanHost ? `ws://${cleanHost}:${cleanPort}` : "";
  }, [host, port]);

  const closeSocket = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    setConnected(false);
    setAuthenticated(false);
    if (
      socket &&
      socket.readyState !== WebSocket.CLOSED &&
      socket.readyState !== WebSocket.CLOSING
    ) {
      socket.close();
    }
  }, []);

  useEffect(() => {
    chatMessagesRef.current = chatMessages;
  }, [chatMessages]);

  useEffect(() => {
    return () => {
      stopNativeMicrophoneStream(activeVoiceTurnRef.current).catch(() => {});
      disconnectVoicePipeline(voicePipelineConnectedRef).catch(() => {});
      voicePlayerRef.current?.remove?.();
      voicePlayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    ensureClientId()
      .then(setClientId)
      .catch(() => setClientId(createClientId()));
    SecureStore.getItemAsync(STORED_DEVICE_KEY)
      .then((value) => {
        if (!value) return;
        const parsed = JSON.parse(value);
        setStoredDevice(parsed);
        if (parsed.host) setHost(parsed.host);
        if (parsed.port) setPort(String(parsed.port));
        if (parsed.device?.name) setDeviceName(parsed.device.name);
        setStatusText(`Loaded paired device: ${parsed.device?.name ?? "Android"}.`);
      })
      .catch(() => {
        setStatusText("Saved pairing could not be loaded.");
      });

    return () => {
      closeSocket();
      for (const pending of pendingRef.current.values()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error("App closed."));
      }
      pendingRef.current.clear();
    };
  }, [closeSocket]);

  const connect = useCallback(async () => {
    if (!bridgeUrl) {
      throw new Error("Enter the desktop bridge host first.");
    }
    const current = socketRef.current;
    if (current?.readyState === WebSocket.OPEN) {
      return current;
    }
    closeSocket();
    setStatusText(`Connecting to ${bridgeUrl}…`);
    const socket = new WebSocket(bridgeUrl);
    socketRef.current = socket;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("Connection timed out. Check Wi‑Fi, host, port, and macOS firewall."));
        closeSocket();
      }, REQUEST_TIMEOUT_MS);

      socket.onopen = () => {
        clearTimeout(timeoutId);
        setConnected(true);
        setAuthenticated(false);
        setStatusText(`Connected to ${bridgeUrl}.`);
        resolve(socket);
      };
      socket.onerror = () => {
        clearTimeout(timeoutId);
        reject(new Error("Could not connect to desktop bridge."));
      };
      socket.onclose = () => {
        setConnected(false);
        setAuthenticated(false);
      };
      socket.onmessage = (event) => {
        handleSocketMessage(pendingRef.current, event.data, (message) => {
          handleVoiceStreamEventRef.current?.(message);
        });
      };
    });
  }, [bridgeUrl, closeSocket]);

  const sendBridgeRequest = useCallback(
    async (message, options = {}) => {
      const socket = await connect();
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Bridge socket is not open.");
      }
      const requestId = message.requestId ?? createRequestId();
      const request = { ...message, requestId };
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingRef.current.delete(requestId);
          reject(new Error("Bridge request timed out."));
        }, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
        pendingRef.current.set(requestId, {
          resolve,
          reject,
          timeoutId,
          finalType: options.finalType,
          onEvent: options.onEvent,
        });
        socket.send(JSON.stringify(request));
      });
    },
    [connect],
  );

  const applyPairingPayload = useCallback((data) => {
    const parsed = parsePairingPayload(data);
    if (!parsed.payload) {
      if (!parsed.isExpoLaunchUrl) {
        Alert.alert(
          "Unsupported QR",
          "Scan the one-scan setup QR from Brah desktop, or use Manual pair QR from inside this app.",
        );
      }
      return;
    }
    const payload = parsed.payload;
    const pairingKey = `${payload.host}:${payload.port ?? DEFAULT_PORT}:${payload.pairingCode}`;
    if (handledPairingUrlsRef.current.has(pairingKey)) {
      return;
    }
    handledPairingUrlsRef.current.add(pairingKey);
    setHost(String(payload.host));
    setPort(String(payload.port ?? DEFAULT_PORT));
    setPairingCode(String(payload.pairingCode));
    setScanning(false);
    setPendingAutoPair(payload.autoPair === "1" || payload.autoPair === true);
    setStatusText(
      payload.autoPair === "1" || payload.autoPair === true
        ? "Pairing details loaded. Pairing automatically…"
        : "Pairing details loaded from QR. Tap Pair.",
    );
  }, []);

  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      if (url) {
        applyPairingPayload(url);
      }
    });
    const subscription = Linking.addEventListener("url", ({ url }) => {
      applyPairingPayload(url);
    });
    return () => subscription.remove();
  }, [applyPairingPayload]);

  const openScanner = useCallback(async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert("Camera permission needed", "Allow camera access to scan the Brah pairing QR.");
        return;
      }
    }
    setScanning(true);
  }, [cameraPermission, requestCameraPermission]);

  const pairDevice = useCallback(
    async ({ silent = false } = {}) => {
      if (pairingInFlightRef.current) {
        return false;
      }
      const code = pairingCode.trim();
      if (!code) {
        if (!silent) {
          Alert.alert(
            "Pairing code required",
            "Start pairing in Brah desktop and enter the 6-digit code.",
          );
        }
        return false;
      }
      pairingInFlightRef.current = true;
      setBusy(true);
      try {
        const response = await sendBridgeRequest({
          type: "pair.request",
          pairingCode: code,
          deviceName: deviceName.trim() || "Android",
          clientId,
        });
        ensureOk(response);
        const saved = {
          host: host.trim(),
          port: Number.parseInt(port.trim() || DEFAULT_PORT, 10),
          device: response.payload.device,
          deviceToken: response.payload.deviceToken,
        };
        await SecureStore.setItemAsync(STORED_DEVICE_KEY, JSON.stringify(saved));
        setStoredDevice(saved);
        setPairingCode("");
        setPendingAutoPair(false);
        setAuthenticated(true);
        setStatusText(`Paired as ${saved.device.name}.`);
        return true;
      } catch (error) {
        const message = formatPairingError(error.message);
        setStatusText(message);
        if (!silent) {
          Alert.alert("Pairing failed", message);
        }
        return false;
      } finally {
        pairingInFlightRef.current = false;
        setBusy(false);
      }
    },
    [clientId, deviceName, host, pairingCode, port, sendBridgeRequest],
  );

  useEffect(() => {
    if (!pendingAutoPair || storedDevice || busy || !bridgeUrl || !pairingCode || !clientId) {
      return;
    }
    setPendingAutoPair(false);
    pairDevice({ silent: true }).then((paired) => {
      if (!paired && !storedDevice) {
        Alert.alert(
          "Pairing failed",
          "Pairing expired or was stopped on desktop. Tap Start pairing in Brah desktop again, then use the new code.",
        );
      }
    });
  }, [bridgeUrl, busy, clientId, pairDevice, pairingCode, pendingAutoPair, storedDevice]);

  const authenticate = useCallback(async () => {
    if (!storedDevice?.device?.id || !storedDevice?.deviceToken) {
      Alert.alert("Not paired", "Pair this Android device first.");
      return null;
    }
    setBusy(true);
    try {
      const response = await sendBridgeRequest({
        type: "auth",
        deviceId: storedDevice.device.id,
        deviceToken: storedDevice.deviceToken,
      });
      ensureOk(response);
      setAuthenticated(true);
      setStatusText(`Authenticated as ${response.payload.device.name}.`);
      return response;
    } catch (error) {
      setStatusText(error.message);
      Alert.alert("Authentication failed", error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }, [sendBridgeRequest, storedDevice]);

  const refreshStatus = useCallback(async () => {
    setBusy(true);
    setStatusText("Checking desktop OpenAI status…");
    setOpenAIStatus(null);
    try {
      const auth = authenticated ? true : await authenticate();
      if (!auth) return;
      const response = await sendBridgeRequest({ type: "openai.status.get" });
      ensureOk(response);
      setOpenAIStatus(response.payload);
      setStatusText(
        response.payload.connected
          ? "Desktop OpenAI is connected."
          : "Desktop OpenAI is not connected.",
      );
    } catch (error) {
      setStatusText(error.message);
      Alert.alert("Status failed", error.message);
    } finally {
      setBusy(false);
    }
  }, [authenticate, authenticated, sendBridgeRequest]);

  const loadTools = useCallback(async () => {
    setBusy(true);
    try {
      const auth = authenticated ? true : await authenticate();
      if (!auth) return;
      const response = await sendBridgeRequest({ type: "tools.definitions.get" });
      ensureOk(response);
      const tools = Array.isArray(response.payload.tools) ? response.payload.tools : [];
      setToolCount(tools.length);
      setStatusText(`Loaded ${tools.length} desktop tools.`);
    } catch (error) {
      setStatusText(error.message);
      Alert.alert("Tools failed", error.message);
    } finally {
      setBusy(false);
    }
  }, [authenticate, authenticated, sendBridgeRequest]);

  const executeTool = useCallback(async () => {
    setBusy(true);
    try {
      const auth = authenticated ? true : await authenticate();
      if (!auth) return;
      let args;
      try {
        args = JSON.parse(toolArgs || "{}");
      } catch {
        throw new Error("Tool args must be valid JSON.");
      }
      const response = await sendBridgeRequest({
        type: "tools.execute",
        name: toolName.trim(),
        args,
      });
      ensureOk(response);
      setToolResult(JSON.stringify(response.payload, null, 2));
      setStatusText(`Executed ${toolName.trim()}.`);
    } catch (error) {
      setStatusText(error.message);
      Alert.alert("Tool failed", error.message);
    } finally {
      setBusy(false);
    }
  }, [authenticate, authenticated, sendBridgeRequest, toolArgs, toolName]);

  const reloadBridgeState = useCallback(async () => {
    if (conversationActive || recordingVoice || streamingVoice) {
      setStatusText("End the active voice conversation before reloading.");
      return;
    }
    setBusy(true);
    setStatusText("Reloading bridge state without disconnecting…");
    try {
      if (!storedDevice) {
        const socket = await connect();
        if (socket?.readyState === WebSocket.OPEN) {
          setStatusText("Connection is live. Pair this Android to reload desktop state.");
        }
        return;
      }
      const auth = await authenticate();
      if (!auth) return;
      const [statusResponse, toolsResponse] = await Promise.all([
        sendBridgeRequest({ type: "openai.status.get" }),
        sendBridgeRequest({ type: "tools.definitions.get" }),
      ]);
      ensureOk(statusResponse);
      ensureOk(toolsResponse);
      const tools = Array.isArray(toolsResponse.payload.tools) ? toolsResponse.payload.tools : [];
      setOpenAIStatus(statusResponse.payload);
      setToolCount(tools.length);
      setStatusText(
        `Reloaded bridge state. OpenAI ${
          statusResponse.payload.connected ? "connected" : "not connected"
        }; ${tools.length} tools loaded.`,
      );
    } catch (error) {
      setStatusText(`Reload failed: ${error.message}`);
      Alert.alert("Reload failed", error.message);
    } finally {
      setBusy(false);
    }
  }, [
    authenticate,
    connect,
    conversationActive,
    recordingVoice,
    sendBridgeRequest,
    storedDevice,
    streamingVoice,
  ]);

  const handleVoiceStreamEvent = useCallback(
    (message) => {
      const payload = message?.payload ?? {};
      const activeTurn = activeVoiceTurnRef.current;
      const payloadConversationId =
        typeof payload.conversationId === "string" ? payload.conversationId : null;
      if (payloadConversationId && activeTurn?.conversationId !== payloadConversationId) {
        return;
      }
      const turnId =
        typeof payload.turnId === "string"
          ? payload.turnId
          : activeTurn?.currentTurnId || activeTurn?.turnId || activeTurn?.conversationId;
      if (!turnId) {
        return;
      }
      const voiceSession = activeTurn ?? { turnId };
      activeVoiceTurnRef.current = voiceSession;

      if (message.type === "voice.input.speech_started") {
        const interruptedTurnId = voiceSession.currentTurnId ?? voiceSession.activeTurnId ?? turnId;
        const shouldCancelResponse = Boolean(
          voiceSession.conversationId && voiceSession.currentTurnId,
        );
        invalidateVoicePipelineTurn(interruptedTurnId).catch(() => {});
        if (shouldCancelResponse) {
          sendBridgeRequest(
            {
              type: "voice.conversation.cancel_response",
              conversationId: voiceSession.conversationId,
            },
            { timeoutMs: REQUEST_TIMEOUT_MS, finalType: "voice.conversation.response_cancelled" },
          ).catch(() => {});
        }
        voicePipelineFirstChunkRef.current = true;
        setStreamingVoice(false);
        setVoiceSummary("Listening — go ahead.");
        setStatusText("Listening — go ahead.");
        return;
      }

      if (message.type === "voice.input.speech_stopped") {
        setStatusText("Heard you. Brah replies when the pause is long enough…");
        return;
      }

      if (message.type === "voice.reply.started") {
        startConversationTurn(voiceSession, turnId, voicePipelineFirstChunkRef);
        setStreamingVoice(true);
        setVoiceReady(false);
        setStatusText("Brah is answering…");
        return;
      }

      if (message.type === "voice.reply.transcript") {
        startConversationTurn(voiceSession, turnId, voicePipelineFirstChunkRef);
        const transcript = cleanText(payload.transcript);
        if (transcript) {
          upsertChatMessageById(setChatMessages, voiceSession.userMessageId, "user", transcript);
          setVoiceSummary(`You: ${transcript}\nBrah: …`);
          setStatusText("Desktop transcribed your voice. Brah is answering…");
        }
        return;
      }

      if (message.type === "voice.reply.delta") {
        startConversationTurn(voiceSession, turnId, voicePipelineFirstChunkRef);
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        if (delta) {
          upsertChatMessageById(
            setChatMessages,
            voiceSession.assistantMessageId,
            "assistant",
            delta,
            {
              append: true,
            },
          );
          setStreamingVoice(true);
          setVoiceSummary("Brah is streaming a reply…");
          setStatusText("Streaming Brah’s response from desktop…");
        }
        return;
      }

      if (message.type === "voice.reply.audio_delta") {
        startConversationTurn(voiceSession, turnId, voicePipelineFirstChunkRef);
        const audioChunk = payload.audio?.base64;
        voiceSession.audioChunks = [...(voiceSession.audioChunks ?? []), audioChunk].filter(
          Boolean,
        );
        if (audioChunk) {
          const playedStreamingAudio = pushVoicePipelineAudio(
            audioChunk,
            turnId,
            voicePipelineConnectedRef,
            voicePipelineTurnRef,
            voicePipelineFirstChunkRef,
          );
          voiceSession.playedStreamingAudio =
            voiceSession.playedStreamingAudio || playedStreamingAudio;
        }
        setStreamingVoice(true);
        setStatusText("Playing streaming audio from desktop Brah…");
        return;
      }

      if (message.type === "voice.reply.tool") {
        startConversationTurn(voiceSession, turnId, voicePipelineFirstChunkRef);
        const name = cleanText(payload.name) || "desktop tool";
        const action = payload.status === "end" ? "Finished" : "Using";
        setVoiceSummary(`${action} ${name}…`);
        setStatusText(`${action} ${name} on desktop…`);
        return;
      }

      if (message.type === "voice.reply.cancelled") {
        invalidateVoicePipelineTurn(turnId).catch(() => {});
        finishConversationTurn(voiceSession, turnId);
        setStreamingVoice(false);
        setStatusText("Response cancelled; still listening.");
        return;
      }

      if (message.type === "voice.reply.error") {
        const errorMessage = cleanText(payload.message) || "Voice response failed.";
        setStreamingVoice(false);
        setVoiceSummary(`Voice error: ${errorMessage}`);
        setStatusText(errorMessage);
        return;
      }

      if (message.type === "voice.reply.done") {
        const reply = cleanText(payload.reply);
        const transcript = cleanText(payload.transcript);
        if (transcript && voiceSession.userMessageId) {
          upsertChatMessageById(setChatMessages, voiceSession.userMessageId, "user", transcript);
        }
        if (reply && voiceSession.assistantMessageId) {
          upsertChatMessageById(
            setChatMessages,
            voiceSession.assistantMessageId,
            "assistant",
            reply,
          );
        }
        markVoicePipelineTurnComplete(turnId, voicePipelineFirstChunkRef);
        finishConversationTurn(voiceSession, turnId);
        if (payload.audio?.base64) {
          void playAssistantAudio(payload.audio, voicePlayerRef, {
            autoplay: !voiceSession.playedStreamingAudio,
          });
          setVoiceReady(true);
        } else {
          setVoiceReady(false);
        }
        setStreamingVoice(false);
        setVoiceSummary(reply ? `Brah: ${reply}` : "Listening — speak naturally.");
        setStatusText("Brah finished. Still listening.");
      }
    },
    [sendBridgeRequest],
  );

  useEffect(() => {
    handleVoiceStreamEventRef.current = handleVoiceStreamEvent;
    return () => {
      handleVoiceStreamEventRef.current = null;
    };
  }, [handleVoiceStreamEvent]);

  const startVoiceConversation = useCallback(async () => {
    if (busy || conversationActive) {
      return;
    }
    setBusy(true);
    try {
      const auth = authenticated ? true : await authenticate();
      if (!auth) {
        setBusy(false);
        return;
      }
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        setBusy(false);
        Alert.alert("Microphone needed", "Allow microphone access to talk to desktop Brah.");
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
      });
      voicePlayerRef.current?.remove?.();
      voicePlayerRef.current = null;
      await connectVoicePipeline(voicePipelineConnectedRef);
      const conversationId = createRequestId();
      const startRequestId = createRequestId();
      activeVoiceTurnRef.current = {
        conversationId,
        startRequestId,
        activeTurnId: null,
        currentTurnId: null,
        userMessageId: null,
        assistantMessageId: null,
        audioSequence: 0,
        chunkSendChain: Promise.resolve(),
        audioChunks: [],
        cancelled: false,
        micSubscription: null,
      };
      voicePipelineTurnRef.current = null;
      voicePipelineFirstChunkRef.current = true;
      await invalidateVoicePipelineTurn(conversationId);
      const history = chatMessagesRef.current
        .map((item) => ({ role: item.role, text: item.text }))
        .slice(-12);
      const response = await sendBridgeRequest(
        {
          type: "voice.conversation.start",
          requestId: startRequestId,
          conversationId,
          audio: {
            sampleRate: VOICE_SAMPLE_RATE,
            channels: VOICE_CHANNELS,
            encoding: "pcm16",
          },
          history,
        },
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          finalType: "voice.conversation.started",
          onEvent: handleVoiceStreamEvent,
        },
      );
      ensureOk(response);
      await startNativeMicrophoneStream(activeVoiceTurnRef.current, voiceInputStream);
      voiceStartedAtRef.current = Date.now();
      setBusy(false);
      setRecordingVoice(true);
      setConversationActive(true);
      setStreamingVoice(false);
      setVoiceReady(false);
      setVoiceSummary("Listening — speak naturally. Brah replies when you pause.");
      setStatusText("Listening — speak naturally. Brah replies when you pause.");
    } catch (error) {
      await stopNativeMicrophoneStream(activeVoiceTurnRef.current);
      if (activeVoiceTurnRef.current?.conversationId) {
        try {
          await sendBridgeRequest(
            {
              type: "voice.conversation.stop",
              conversationId: activeVoiceTurnRef.current.conversationId,
            },
            { timeoutMs: REQUEST_TIMEOUT_MS, finalType: "voice.conversation.stopped" },
          );
        } catch {}
      }
      activeVoiceTurnRef.current = null;
      setBusy(false);
      setRecordingVoice(false);
      setConversationActive(false);
      setStreamingVoice(false);
      setVoiceSummary(`Voice start failed: ${error.message}`);
      setStatusText(error.message);
      Alert.alert("Voice failed", error.message);
    }
  }, [
    authenticate,
    authenticated,
    busy,
    conversationActive,
    handleVoiceStreamEvent,
    sendBridgeRequest,
    voiceInputStream,
  ]);

  const stopVoiceConversation = useCallback(async () => {
    if (!conversationActive && !recordingVoice) {
      return;
    }
    const activeTurn = activeVoiceTurnRef.current;
    await stopNativeMicrophoneStream(activeTurn);
    setRecordingVoice(false);
    setConversationActive(false);
    setBusy(true);
    setVoiceSummary("Stopping realtime conversation…");
    setStatusText("Stopping realtime conversation…");
    try {
      if (!activeTurn?.conversationId) {
        throw new Error("No active voice conversation to stop.");
      }
      await activeTurn.chunkSendChain;
      const response = await sendBridgeRequest(
        {
          type: "voice.conversation.stop",
          conversationId: activeTurn.conversationId,
        },
        { timeoutMs: REQUEST_TIMEOUT_MS, finalType: "voice.conversation.stopped" },
      );
      ensureOk(response);
      setVoiceSummary("Conversation stopped.");
      setStatusText("Conversation stopped.");
    } catch (error) {
      setVoiceSummary(`Stop failed: ${error.message}`);
      setStatusText(error.message);
      Alert.alert("Voice failed", error.message);
    } finally {
      setBusy(false);
      setStreamingVoice(false);
      activeVoiceTurnRef.current = null;
    }
  }, [conversationActive, recordingVoice, sendBridgeRequest]);

  const cancelConversationResponse = useCallback(async () => {
    const activeTurn = activeVoiceTurnRef.current;
    if (!activeTurn?.conversationId) {
      return;
    }
    const turnId = activeTurn.currentTurnId ?? activeTurn.activeTurnId ?? createRequestId();
    await invalidateVoicePipelineTurn(turnId);
    setStreamingVoice(false);
    setVoiceSummary("Response cancelled; still listening.");
    setStatusText("Response cancelled; still listening.");
    try {
      const response = await sendBridgeRequest(
        {
          type: "voice.conversation.cancel_response",
          conversationId: activeTurn.conversationId,
        },
        { timeoutMs: REQUEST_TIMEOUT_MS, finalType: "voice.conversation.response_cancelled" },
      );
      ensureOk(response);
    } catch (error) {
      setStatusText(`Cancel failed: ${error.message}`);
    }
  }, [sendBridgeRequest]);

  const replayAssistantAudio = useCallback(async () => {
    const player = voicePlayerRef.current;
    if (!player || conversationActive) {
      return;
    }
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
      });
      player.seekTo?.(0);
      player.play();
    } catch (error) {
      setVoiceSummary(`Replay failed: ${error.message}`);
    }
  }, [conversationActive]);

  const sendAssistantMessage = useCallback(async () => {
    const message = chatInput.trim();
    if (!message) {
      Alert.alert("Message required", "Type what you want Brah to do or answer.");
      return;
    }
    setChatInput("");
    setChatMessages((messages) => [
      ...messages,
      { id: createRequestId(), role: "user", text: message },
    ]);
    setBusy(true);
    setStatusText("Sending to desktop Brah…");
    try {
      const auth = authenticated ? true : await authenticate();
      if (!auth) return;
      setBusy(true);
      const history = chatMessagesRef.current
        .map((item) => ({ role: item.role, text: item.text }))
        .slice(-12);
      const response = await sendBridgeRequest(
        { type: "assistant.message", message, history },
        { timeoutMs: ASSISTANT_TIMEOUT_MS },
      );
      ensureOk(response);
      const reply =
        typeof response.payload?.reply === "string" && response.payload.reply.trim()
          ? response.payload.reply.trim()
          : "Done.";
      setChatMessages((messages) => [
        ...messages,
        { id: createRequestId(), role: "assistant", text: reply },
      ]);
      setStatusText("Brah replied from desktop.");
    } catch (error) {
      setStatusText(error.message);
      setChatMessages((messages) => [
        ...messages,
        { id: createRequestId(), role: "assistant", text: `Error: ${error.message}` },
      ]);
      Alert.alert("Chat failed", error.message);
    } finally {
      setBusy(false);
    }
  }, [authenticate, authenticated, chatInput, sendBridgeRequest]);

  const forgetDevice = useCallback(async () => {
    closeSocket();
    await SecureStore.deleteItemAsync(STORED_DEVICE_KEY);
    setStoredDevice(null);
    setAuthenticated(false);
    setOpenAIStatus(null);
    setToolCount(null);
    setToolResult("");
    setChatMessages([]);
    setStatusText("Forgot saved mobile pairing.");
  }, [closeSocket]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>
            Brah Mobile · {APP_BUILD_LABEL} · {APP_RUNTIME_LABEL}
          </Text>
          <Text style={styles.title}>Android bridge client</Text>
          <View style={styles.diagnosticPill}>
            <Text style={styles.diagnosticLabel}>Client ID</Text>
            <Text style={styles.diagnosticValue}>{clientId || "loading…"}</Text>
          </View>
          <Text style={styles.subtitle}>
            Pair with Brah desktop, then chat with the same OpenAI and desktop tools from your
            phone.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Desktop bridge</Text>
          <Field
            label="Host from Brah Mobile panel"
            value={host}
            onChangeText={setHost}
            placeholder="192.168.1.25"
            autoCapitalize="none"
          />
          <Field
            label="Port"
            value={port}
            onChangeText={setPort}
            placeholder={DEFAULT_PORT}
            keyboardType="number-pad"
          />
          <Text style={styles.hint}>
            {bridgeUrl || "Start pairing in Brah desktop to see the host and code."}
          </Text>
          <View style={styles.row}>
            <Button
              label={connected ? "Reconnect" : "Connect"}
              onPress={connect}
              disabled={busy || !bridgeUrl}
            />
            <Button
              label="Reload"
              onPress={reloadBridgeState}
              disabled={
                busy || !bridgeUrl || conversationActive || recordingVoice || streamingVoice
              }
              secondary
            />
            <Button label="Disconnect" onPress={closeSocket} disabled={!connected} secondary />
          </View>
        </View>

        {scanning ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Scan manual pair QR</Text>
            <Text style={styles.hint}>
              Only use this if the one-scan setup QR did not auto-fill pairing details.
            </Text>
            <View style={styles.scannerFrame}>
              <CameraView
                style={styles.scanner}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => applyPairingPayload(data)}
              />
            </View>
            <Button label="Cancel scan" onPress={() => setScanning(false)} secondary />
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Pair this Android</Text>
          <Field
            label="Device name"
            value={deviceName}
            onChangeText={setDeviceName}
            placeholder="Android"
          />
          <Field
            label="6-digit pairing code"
            value={pairingCode}
            onChangeText={setPairingCode}
            placeholder="123456"
            keyboardType="number-pad"
            maxLength={6}
          />
          <View style={styles.row}>
            <Button label="Scan QR" onPress={openScanner} disabled={busy} secondary />
            <Button label="Pair" onPress={() => pairDevice()} disabled={busy || !bridgeUrl} />
            <Button label="Forget" onPress={forgetDevice} disabled={!storedDevice} secondary />
          </View>
          {storedDevice ? (
            <Text style={styles.success}>
              Saved pairing: {storedDevice.device?.name ?? "Android"}
            </Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Bridge actions</Text>
          <View style={styles.row}>
            <Button label="Auth" onPress={authenticate} disabled={busy || !storedDevice} />
            <Button
              label="OpenAI"
              onPress={refreshStatus}
              disabled={busy || !storedDevice}
              secondary
            />
          </View>
          <View style={styles.row}>
            <Button
              label="Load tools"
              onPress={loadTools}
              disabled={busy || !storedDevice}
              secondary
            />
          </View>
          {openAIStatus ? (
            <View style={styles.resultCard}>
              <Text style={styles.resultLabel}>OpenAI status</Text>
              <Text style={styles.resultValue}>
                {openAIStatus.connected ? "Connected" : "Not connected"}
              </Text>
            </View>
          ) : null}
          {toolCount !== null ? (
            <Text style={styles.result}>Available tools: {toolCount}</Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Realtime conversation</Text>
          <Text style={styles.hint}>
            Start one continuous mic session, speak naturally, and Brah replies when you pause. Tap
            End conversation when you’re done.
          </Text>
          <Pressable
            onPress={conversationActive ? stopVoiceConversation : startVoiceConversation}
            disabled={(busy && !conversationActive) || !storedDevice}
            style={({ pressed }) => [
              styles.voiceButton,
              conversationActive && styles.voiceButtonRecording,
              ((busy && !conversationActive) || !storedDevice) && styles.buttonDisabled,
              pressed && !(busy && !conversationActive) && storedDevice && styles.buttonPressed,
            ]}
          >
            <Text style={styles.voiceButtonText}>
              {conversationActive ? "Listening… tap to end" : "Start conversation"}
            </Text>
          </Pressable>
          <View style={styles.row}>
            <Button
              label={conversationActive ? "End conversation" : "Start conversation"}
              onPress={conversationActive ? stopVoiceConversation : startVoiceConversation}
              disabled={(busy && !conversationActive) || !storedDevice}
              secondary={!conversationActive}
            />
            <Button
              label="Cancel response"
              onPress={cancelConversationResponse}
              disabled={!conversationActive || !streamingVoice}
              secondary
            />
            <Button
              label="Replay reply"
              onPress={replayAssistantAudio}
              disabled={!voiceReady || conversationActive}
              secondary
            />
          </View>
          {voiceSummary ? <Text style={styles.voiceSummary}>{voiceSummary}</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Talk to Brah</Text>
          <Text style={styles.hint}>
            Send natural language to desktop Brah. It can answer, use memory/tasks/calendar, inspect
            the screen, and run desktop tools.
          </Text>
          <View style={styles.chatTranscript}>
            {chatMessages.length === 0 ? (
              <Text style={styles.chatEmpty}>Ask something like “what’s on my task list?”</Text>
            ) : (
              chatMessages.map((message) => (
                <View
                  key={message.id}
                  style={[
                    styles.chatBubble,
                    message.role === "user" ? styles.chatBubbleUser : styles.chatBubbleAssistant,
                  ]}
                >
                  <Text style={styles.chatRole}>{message.role === "user" ? "You" : "Brah"}</Text>
                  <Text style={styles.chatText}>{message.text}</Text>
                </View>
              ))
            )}
          </View>
          <Field
            label="Message"
            value={chatInput}
            onChangeText={setChatInput}
            placeholder="Talk to Brah…"
            multiline
          />
          <Button label="Send" onPress={sendAssistantMessage} disabled={busy || !storedDevice} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Execute tool</Text>
          <Field
            label="Tool name"
            value={toolName}
            onChangeText={setToolName}
            placeholder="list_tasks"
            autoCapitalize="none"
          />
          <Field
            label="Args JSON"
            value={toolArgs}
            onChangeText={setToolArgs}
            placeholder="{}"
            multiline
          />
          <Button label="Run tool" onPress={executeTool} disabled={busy || !storedDevice} />
          {toolResult ? <Text style={styles.codeBlock}>{toolResult}</Text> : null}
        </View>

        <View style={styles.statusBar}>
          {busy ? (
            <ActivityIndicator color="#c7d2fe" />
          ) : (
            <View style={[styles.dot, connected && styles.dotConnected]} />
          )}
          <Text style={styles.statusText}>{statusText}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

async function ensureClientId() {
  const stored = await SecureStore.getItemAsync(CLIENT_ID_KEY);
  if (stored) {
    return stored;
  }
  const clientId = createClientId();
  await SecureStore.setItemAsync(CLIENT_ID_KEY, clientId);
  return clientId;
}

function createClientId() {
  return `android-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function handleSocketMessage(pendingRequests, data, onEvent) {
  let parsed;
  try {
    parsed = JSON.parse(String(data));
  } catch {
    return;
  }
  const pending = pendingRequests.get(parsed.requestId);
  if (!pending) {
    onEvent?.(parsed);
    return;
  }
  if (parsed.type === "error" || parsed.ok === false) {
    clearTimeout(pending.timeoutId);
    pendingRequests.delete(parsed.requestId);
    pending.reject(new Error(parsed.error?.message || "Bridge request failed."));
    return;
  }
  if (pending.finalType && parsed.type !== pending.finalType) {
    pending.onEvent?.(parsed);
    return;
  }
  clearTimeout(pending.timeoutId);
  pendingRequests.delete(parsed.requestId);
  pending.resolve(parsed);
}

function createRequestId() {
  return `android-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function arrayBufferToBase64(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    return "";
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const batchSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += batchSize) {
    const batch = bytes.subarray(offset, offset + batchSize);
    binary += String.fromCharCode(...batch);
  }
  return globalThis.btoa(binary);
}

function ensureOk(response) {
  if (!response?.ok) {
    throw new Error(response?.error?.message || "Bridge request failed.");
  }
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function loadNativeVoiceModule() {
  if (nativeVoiceModule !== null) {
    return nativeVoiceModule;
  }
  nativeVoiceModule = requireOptionalPipelineModule();
  return nativeVoiceModule;
}

function requireOptionalPipelineModule() {
  try {
    return globalThis.expo?.modules?.ExpoPlayAudioStream ?? null;
  } catch {
    return null;
  }
}

function queueVoiceStreamBuffer(activeTurn, buffer, sendBridgeRequest, setStatusText) {
  if ((!activeTurn?.turnId && !activeTurn?.conversationId) || activeTurn.cancelled) {
    return;
  }
  const chunk = arrayBufferToBase64(buffer?.data);
  if (!chunk) {
    return;
  }
  const sequence = activeTurn.audioSequence ?? 0;
  activeTurn.audioSequence = sequence + 1;
  const isConversation = Boolean(activeTurn.conversationId);
  activeTurn.chunkSendChain = (activeTurn.chunkSendChain ?? Promise.resolve())
    .then(() =>
      sendBridgeRequest(
        isConversation
          ? {
              type: "voice.conversation.audio",
              conversationId: activeTurn.conversationId,
              chunk,
              sequence,
            }
          : {
              type: "voice.stream.audio",
              turnId: activeTurn.turnId,
              chunk,
              sequence,
            },
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          finalType: isConversation ? "voice.conversation.audio.ack" : "voice.stream.audio.ack",
        },
      ),
    )
    .catch((error) => {
      setStatusText?.(`Mic stream chunk failed: ${error.message}`);
    });
}

async function startNativeMicrophoneStream(activeTurn, voiceInputStream) {
  if (!activeTurn?.turnId && !activeTurn?.conversationId) {
    throw new Error("No active voice session to stream.");
  }
  if (!voiceInputStream?.start) {
    throw new Error(
      "Expo audio stream is unavailable in this runtime. Update Expo Go for SDK 55 support.",
    );
  }
  activeTurn.voiceInputStream = voiceInputStream;
  await voiceInputStream.start();
}

async function stopNativeMicrophoneStream(activeTurn) {
  activeTurn?.micSubscription?.remove?.();
  activeTurn?.voiceInputStream?.stop?.();
  if (activeTurn) {
    activeTurn.micSubscription = null;
    activeTurn.voiceInputStream = null;
  }
}

async function connectVoicePipeline(connectedRef) {
  if (connectedRef.current) {
    return true;
  }
  const module = loadNativeVoiceModule();
  if (typeof module?.connectPipeline !== "function") {
    return false;
  }
  try {
    await module.connectPipeline({
      sampleRate: VOICE_OUTPUT_SAMPLE_RATE,
      channelCount: VOICE_CHANNELS,
      targetBufferMs: 80,
      audioMode: "doNotMix",
    });
    connectedRef.current = true;
    return true;
  } catch {
    connectedRef.current = false;
    return false;
  }
}

async function disconnectVoicePipeline(connectedRef) {
  if (!connectedRef.current || !nativeVoiceModule?.disconnectPipeline) {
    return;
  }
  try {
    await nativeVoiceModule.disconnectPipeline();
  } finally {
    connectedRef.current = false;
  }
}

async function invalidateVoicePipelineTurn(turnId) {
  const module = nativeVoiceModule ?? loadNativeVoiceModule();
  if (typeof module?.invalidatePipelineTurn !== "function") {
    return;
  }
  try {
    await module.invalidatePipelineTurn({ turnId });
  } catch {}
}

function pushVoicePipelineAudio(
  audio,
  turnId,
  connectedRef,
  currentTurnRef,
  firstChunkRef,
  { isLastChunk = false } = {},
) {
  const module = nativeVoiceModule;
  if (!connectedRef.current || typeof module?.pushPipelineAudioSync !== "function") {
    return false;
  }
  const isFirstChunk = firstChunkRef.current || currentTurnRef.current !== turnId;
  currentTurnRef.current = turnId;
  firstChunkRef.current = false;
  return module.pushPipelineAudioSync({
    audio,
    turnId,
    isFirstChunk,
    isLastChunk,
  });
}

function markVoicePipelineTurnComplete(turnId, firstChunkRef) {
  const module = nativeVoiceModule;
  if (firstChunkRef.current || typeof module?.pushPipelineAudioSync !== "function") {
    return;
  }
  module.pushPipelineAudioSync({
    audio: "",
    turnId,
    isLastChunk: true,
  });
}

function startConversationTurn(activeTurn, turnId, firstChunkRef) {
  if (!activeTurn) {
    return;
  }
  if (
    activeTurn.currentTurnId === turnId &&
    activeTurn.userMessageId &&
    activeTurn.assistantMessageId
  ) {
    return;
  }
  activeTurn.currentTurnId = turnId;
  activeTurn.activeTurnId = turnId;
  activeTurn.turnId = turnId;
  activeTurn.userMessageId = createRequestId();
  activeTurn.assistantMessageId = createRequestId();
  activeTurn.audioChunks = [];
  activeTurn.playedStreamingAudio = false;
  if (firstChunkRef) {
    firstChunkRef.current = true;
  }
}

function finishConversationTurn(activeTurn, turnId) {
  if (!activeTurn) {
    return;
  }
  if (!turnId || activeTurn.currentTurnId === turnId) {
    activeTurn.currentTurnId = null;
  }
}

function upsertChatMessageById(setChatMessages, id, role, text, { append = false } = {}) {
  const cleanId = typeof id === "string" && id ? id : createRequestId();
  setChatMessages((messages) => {
    const existingIndex = messages.findIndex((message) => message.id === cleanId);
    if (existingIndex === -1) {
      return [...messages, { id: cleanId, role, text }];
    }
    const next = [...messages];
    const existing = next[existingIndex];
    next[existingIndex] = {
      ...existing,
      text: append ? `${existing.text ?? ""}${text}` : text,
    };
    return next;
  });
  return cleanId;
}

async function playAssistantAudio(audio, playerRef, { autoplay = true } = {}) {
  if (typeof audio?.base64 !== "string" || !audio.base64) {
    return;
  }
  const file = new File(Paths.cache, `brah-reply-${Date.now()}.wav`);
  file.create({ overwrite: true });
  file.write(audio.base64, { encoding: "base64" });
  const previous = playerRef.current;
  previous?.remove?.();
  const player = createAudioPlayer({ uri: file.uri }, { keepAudioSessionActive: true });
  playerRef.current = player;
  if (autoplay) {
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
    });
    player.play();
  }
}

function formatPairingError(message) {
  return message === "Pairing is not active."
    ? "Pairing expired or was stopped on desktop. Tap Start pairing in Brah desktop again, then use the new code."
    : message;
}

function parsePairingPayload(data) {
  try {
    const text = String(data);
    if (text.startsWith("brahmobile://pair?") || text.startsWith("exp://")) {
      return {
        isExpoLaunchUrl: text.startsWith("exp://"),
        payload: normalizePairingPayload(Linking.parse(text).queryParams),
      };
    }
    return { isExpoLaunchUrl: false, payload: normalizePairingPayload(JSON.parse(text)) };
  } catch {
    return { isExpoLaunchUrl: false, payload: null };
  }
}

function normalizePairingPayload(payload) {
  if (
    !payload ||
    (payload.type !== "brah.mobile.pairing" && !(payload.host && payload.pairingCode))
  ) {
    return null;
  }
  return payload;
}

function Field({ label, ...props }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...props}
        style={[styles.input, props.multiline && styles.inputMultiline]}
        placeholderTextColor="rgba(235,238,246,0.35)"
      />
    </View>
  );
}

function Button({ label, onPress, disabled, secondary }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#07080c",
  },
  container: {
    gap: 14,
    padding: 18,
    paddingBottom: 36,
  },
  hero: {
    gap: 8,
    paddingVertical: 14,
  },
  eyebrow: {
    color: "#a5b4fc",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  title: {
    color: "#eef1f7",
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -1,
  },
  subtitle: {
    color: "rgba(235,238,246,0.62)",
    fontSize: 15,
    lineHeight: 22,
  },
  diagnosticPill: {
    gap: 4,
    borderColor: "rgba(165,180,252,0.34)",
    borderRadius: 14,
    borderWidth: 1,
    backgroundColor: "rgba(129,140,248,0.13)",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  diagnosticLabel: {
    color: "#a5b4fc",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  diagnosticValue: {
    color: "#eef1f7",
    fontFamily: "monospace",
    fontSize: 12,
  },
  card: {
    gap: 12,
    padding: 16,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 18,
    borderWidth: 1,
    backgroundColor: "rgba(255,255,255,0.045)",
  },
  cardTitle: {
    color: "#eef1f7",
    fontSize: 18,
    fontWeight: "750",
  },
  field: {
    gap: 6,
  },
  label: {
    color: "rgba(235,238,246,0.58)",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  input: {
    minHeight: 46,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 12,
    borderWidth: 1,
    color: "#eef1f7",
    backgroundColor: "rgba(0,0,0,0.24)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  inputMultiline: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  hint: {
    color: "rgba(235,238,246,0.44)",
    fontSize: 13,
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    minWidth: 116,
    borderRadius: 12,
    backgroundColor: "#6d7df5",
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  buttonSecondary: {
    borderColor: "rgba(255,255,255,0.12)",
    borderWidth: 1,
    backgroundColor: "rgba(255,255,255,0.07)",
  },
  buttonDisabled: {
    opacity: 0.42,
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
  },
  buttonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
  },
  success: {
    color: "#6ee7b7",
    fontSize: 13,
  },
  result: {
    color: "rgba(235,238,246,0.72)",
    fontSize: 14,
  },
  resultCard: {
    gap: 4,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: "rgba(0,0,0,0.22)",
    padding: 12,
  },
  resultLabel: {
    color: "rgba(235,238,246,0.52)",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  resultValue: {
    color: "#eef1f7",
    fontSize: 18,
    fontWeight: "800",
  },
  scannerFrame: {
    overflow: "hidden",
    height: 260,
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 18,
    borderWidth: 1,
    backgroundColor: "#000",
  },
  scanner: {
    flex: 1,
  },
  chatTranscript: {
    gap: 10,
  },
  chatEmpty: {
    color: "rgba(235,238,246,0.42)",
    fontSize: 13,
    fontStyle: "italic",
  },
  chatBubble: {
    gap: 4,
    maxWidth: "92%",
    borderRadius: 16,
    padding: 12,
  },
  chatBubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(109,125,245,0.35)",
  },
  chatBubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  chatRole: {
    color: "rgba(235,238,246,0.52)",
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  chatText: {
    color: "#eef1f7",
    fontSize: 15,
    lineHeight: 21,
  },
  codeBlock: {
    overflow: "hidden",
    borderRadius: 12,
    color: "#dbeafe",
    backgroundColor: "rgba(0,0,0,0.32)",
    padding: 12,
    fontFamily: "monospace",
    fontSize: 12,
  },
  voiceButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 92,
    borderColor: "rgba(199,210,254,0.26)",
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: "rgba(109,125,245,0.28)",
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  voiceButtonRecording: {
    borderColor: "rgba(248,113,113,0.5)",
    backgroundColor: "rgba(248,113,113,0.26)",
  },
  voiceButtonText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "900",
  },
  voiceSummary: {
    color: "rgba(235,238,246,0.76)",
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: "rgba(0,0,0,0.22)",
    padding: 12,
    fontSize: 14,
    lineHeight: 20,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderColor: "rgba(129,140,248,0.28)",
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: "rgba(129,140,248,0.12)",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: "rgba(235,238,246,0.35)",
  },
  dotConnected: {
    backgroundColor: "#6ee7b7",
  },
  statusText: {
    flex: 1,
    color: "rgba(235,238,246,0.72)",
    fontSize: 13,
    lineHeight: 18,
  },
});
