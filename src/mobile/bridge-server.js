import WebSocket, { WebSocketServer } from "ws";
import {
  createBridgeError,
  createBridgeResponse,
  normalizeBridgeMessage,
} from "./message-protocol.js";
import { completePairing, getPairingSession, verifyMobileDevice } from "./pairing-store.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 19455;
const MAX_BRIDGE_MESSAGE_BYTES = 10_000_000;
const responseTypes = Object.freeze({
  "openai.status.get": "openai.status",
  "realtime.secret.create": "realtime.secret",
  "tools.definitions.get": "tools.definitions",
  "tools.execute": "tools.result",
  "assistant.message": "assistant.reply",
  "voice.turn": "voice.reply",
  "voice.stream.start": "voice.stream.started",
  "voice.stream.audio": "voice.stream.audio.ack",
  "voice.stream.end": "voice.reply",
  "voice.stream.cancel": "voice.stream.cancelled",
});

export function createMobileBridgeServer(options = {}) {
  const host =
    typeof options.host === "string" && options.host.trim() ? options.host.trim() : DEFAULT_HOST;
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
  const pairingStorePath = options.pairingStorePath;
  const handlers = options.handlers ?? {};
  const logger = options.logger ?? console;

  let server = null;
  let running = false;

  async function start() {
    if (running) {
      return getStatus();
    }

    server = new WebSocketServer({
      host,
      port,
      maxPayload: MAX_BRIDGE_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
    server.on("connection", handleConnection);
    server.on("error", (error) => log("error", "Mobile bridge server error", error));

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        server?.off("listening", handleListening);
        server?.off("error", handleError);
      };
      const handleListening = () => {
        cleanup();
        resolve();
      };
      const handleError = (error) => {
        cleanup();
        reject(error);
      };
      server.once("listening", handleListening);
      server.once("error", handleError);
    });

    running = true;
    log("info", "Mobile bridge listening", getStatus());
    return getStatus();
  }

  async function stop() {
    if (!server) {
      running = false;
      return getStatus();
    }

    const closingServer = server;
    server = null;
    for (const client of closingServer.clients) {
      client.close(1001, "Bridge stopping");
    }
    await new Promise((resolve) => {
      closingServer.close(() => resolve());
    });
    running = false;
    return getStatus();
  }

  function getStatus() {
    const address = server?.address();
    const bound = address && typeof address === "object" ? address : null;
    return {
      running,
      host,
      port: bound?.port ?? port,
      pairing: formatPairingSession(getPairingSession()),
      clients: server?.clients?.size ?? 0,
    };
  }

  function broadcast(payload) {
    if (!server) {
      return 0;
    }
    const data = JSON.stringify(payload);
    let sent = 0;
    for (const client of server.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
        sent += 1;
      }
    }
    return sent;
  }

  function handleConnection(socket) {
    const state = { device: null };
    socket.on("message", (data, isBinary) => {
      void handleSocketMessage(socket, state, data, isBinary);
    });
    socket.on("error", (error) => log("warn", "Mobile bridge socket error", error));
  }

  async function handleSocketMessage(socket, state, data, isBinary) {
    let requestId = null;
    try {
      if (isBinary) {
        throw new Error("Bridge messages must be JSON text.");
      }
      if (data.length > MAX_BRIDGE_MESSAGE_BYTES) {
        throw new Error("Bridge message is too large.");
      }
      const parsed = JSON.parse(data.toString("utf8"));
      requestId = typeof parsed?.requestId === "string" ? parsed.requestId : null;
      const message = normalizeBridgeMessage(parsed);
      requestId = message.requestId;
      const response = await routeMessage(socket, state, message);
      sendJson(socket, response);
    } catch (error) {
      sendJson(
        socket,
        createBridgeError(error instanceof Error ? error.message : String(error), requestId),
      );
    }
  }

  async function routeMessage(socket, state, message) {
    if (message.type === "auth") {
      const device = verifyMobileDevice(
        { deviceId: message.deviceId, deviceToken: message.deviceToken },
        pairingStorePath,
      );
      if (!device) {
        throw new Error("Mobile device authentication failed.");
      }
      state.device = device;
      return createBridgeResponse("auth.ok", message.requestId, { device });
    }

    if (message.type === "pair.request") {
      if (!getPairingSession()) {
        throw new Error("Pairing is not active.");
      }
      const result = completePairing(
        {
          pairingCode: message.pairingCode,
          deviceName: message.deviceName,
          clientId: message.clientId,
        },
        pairingStorePath,
      );
      if (!result.ok) {
        log("warn", "Mobile pairing failed", {
          reason: result.error,
          hasClientId: Boolean(message.clientId),
        });
        throw new Error(result.error);
      }
      log("info", "Mobile pairing completed", {
        deviceId: result.device.id,
        deviceName: result.device.name,
        hasClientId: Boolean(message.clientId),
        replayed: Boolean(result.replayed),
      });
      state.device = result.device;
      const response = createBridgeResponse("pair.result", message.requestId, {
        device: result.device,
        deviceToken: result.deviceToken,
      });
      queueMicrotask(() => {
        options.onPairingComplete?.(result.device);
      });
      return response;
    }

    if (!state.device) {
      throw new Error("Authenticate before using the mobile bridge.");
    }

    return routeAuthenticatedMessage(socket, state, message);
  }

  async function routeAuthenticatedMessage(socket, state, message) {
    log("info", "Mobile authenticated request", {
      type: message.type,
      requestId: message.requestId,
    });
    switch (message.type) {
      case "openai.status.get":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler("getOpenAIStatus"),
        );
      case "realtime.secret.create":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler("createRealtimeSecret"),
        );
      case "tools.definitions.get":
        return createBridgeResponse(responseTypes[message.type], message.requestId, {
          tools: await callHandler("getRealtimeTools"),
        });
      case "tools.execute":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler("executeRealtimeTool", message.name, message.args),
        );
      case "assistant.message":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler("sendAssistantMessage", message.message, message.history),
        );
      case "voice.turn":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler("sendVoiceTurn", message.audio, message.history, {
            ...createClientContext(socket, state),
            requestId: message.requestId,
          }),
        );
      case "voice.stream.start":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler("startVoiceStream", message.turnId, message.audio, message.history, {
            ...createClientContext(socket, state),
            requestId: message.requestId,
          }),
        );
      case "voice.stream.audio":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler(
            "appendVoiceStreamAudio",
            message.turnId,
            message.chunk,
            message.sequence,
            createClientContext(socket, state),
          ),
        );
      case "voice.stream.end":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler("endVoiceStream", message.turnId, {
            ...createClientContext(socket, state),
            requestId: message.requestId,
          }),
        );
      case "voice.stream.cancel":
        return createBridgeResponse(
          responseTypes[message.type],
          message.requestId,
          await callHandler(
            "cancelVoiceStream",
            message.turnId,
            createClientContext(socket, state),
          ),
        );
      default:
        throw new Error(`Unsupported authenticated bridge message: ${message.type}`);
    }
  }

  async function callHandler(name, ...args) {
    const handler = handlers[name];
    if (typeof handler !== "function") {
      throw new Error(`Mobile bridge handler is not configured: ${name}`);
    }
    return handler(...args);
  }

  function log(level, message, details) {
    const method =
      typeof logger[level] === "function" ? logger[level].bind(logger) : logger.log?.bind(logger);
    method?.(message, details);
  }

  return { start, stop, getStatus, broadcast };
}

function createClientContext(socket, state) {
  return {
    device: state.device,
    sendEvent(type, requestId, payload = {}) {
      sendJson(socket, createBridgeResponse(type, requestId, payload));
    },
    isOpen() {
      return socket.readyState === WebSocket.OPEN;
    },
  };
}

function sendJson(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function formatPairingSession(session) {
  return session
    ? {
        active: true,
        code: session.code,
        expiresAt: session.expiresAt,
      }
    : {
        active: false,
        code: null,
        expiresAt: null,
      };
}
