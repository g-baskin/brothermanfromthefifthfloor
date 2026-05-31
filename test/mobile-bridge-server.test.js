import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createMobileBridgeServer } from "../src/mobile/bridge-server.js";
import { clearPairingSession, createPairingSession } from "../src/mobile/pairing-store.js";
import { closeDatabase } from "../src/realtime/tools/database.js";

async function withBridge(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-bridge-"));
  const dbPath = path.join(directory, "mobile.db");
  const calls = [];
  const bridge = createMobileBridgeServer({
    host: "127.0.0.1",
    port: 0,
    pairingStorePath: dbPath,
    handlers: {
      getOpenAIStatus: async () => ({ connected: true }),
      createRealtimeSecret: async () => ({ value: "short-lived", expiresAt: 123 }),
      getRealtimeTools: () => [{ name: "list_tasks", type: "function" }],
      executeRealtimeTool: async (name, args) => {
        calls.push({ type: "tool", name, args });
        return { status: "ok", name, args };
      },
      sendAssistantMessage: async (message, history) => {
        calls.push({ type: "assistant", message, history });
        return { reply: `Echo: ${message}` };
      },
      sendVoiceTurn: async (audio, history, context) => {
        calls.push({
          type: "voice",
          audio,
          history,
          context: {
            deviceId: context?.device?.id,
            requestId: context?.requestId,
            isOpen: context?.isOpen?.(),
          },
        });
        context?.sendEvent?.("voice.reply.delta", context.requestId, {
          turnId: "turn-1",
          delta: "Voice ",
        });
        return {
          turnId: "turn-1",
          transcript: "hello",
          reply: "Voice echo",
          audio: { base64: "UklGRgAAAAA=", mimeType: "audio/wav" },
        };
      },
      startVoiceStream: async (turnId, audio, history, context) => {
        calls.push({
          type: "voice.stream.start",
          turnId,
          audio,
          history,
          context: {
            deviceId: context?.device?.id,
            requestId: context?.requestId,
            isOpen: context?.isOpen?.(),
          },
        });
        return { turnId, started: true };
      },
      appendVoiceStreamAudio: async (turnId, chunk, sequence, context) => {
        calls.push({
          type: "voice.stream.audio",
          turnId,
          chunk,
          sequence,
          deviceId: context?.device?.id,
          isOpen: context?.isOpen?.(),
        });
        return { turnId, sequence, received: true };
      },
      endVoiceStream: async (turnId, context) => {
        calls.push({
          type: "voice.stream.end",
          turnId,
          deviceId: context?.device?.id,
          requestId: context?.requestId,
          isOpen: context?.isOpen?.(),
        });
        context?.sendEvent?.("voice.reply.delta", context.requestId, {
          turnId,
          delta: "Live ",
        });
        return {
          turnId,
          transcript: "live hello",
          reply: "Live echo",
          audio: { base64: "UklGRgAAAAA=", mimeType: "audio/wav" },
        };
      },
      cancelVoiceStream: async (turnId, context) => {
        calls.push({
          type: "voice.cancel",
          turnId,
          deviceId: context?.device?.id,
          isOpen: context?.isOpen?.(),
        });
        return { turnId, cancelled: true };
      },
      startVoiceConversation: async (conversationId, audio, history, context) => {
        calls.push({
          type: "voice.conversation.start",
          conversationId,
          audio,
          history,
          context: {
            deviceId: context?.device?.id,
            requestId: context?.requestId,
            isOpen: context?.isOpen?.(),
          },
        });
        context?.sendEvent?.("voice.reply.started", context.requestId, {
          conversationId,
          turnId: "conversation-turn-1",
        });
        return { conversationId, started: true };
      },
      appendVoiceConversationAudio: async (conversationId, chunk, sequence, context) => {
        calls.push({
          type: "voice.conversation.audio",
          conversationId,
          chunk,
          sequence,
          deviceId: context?.device?.id,
          isOpen: context?.isOpen?.(),
        });
        return { conversationId, sequence, received: true };
      },
      stopVoiceConversation: async (conversationId, context) => {
        calls.push({
          type: "voice.conversation.stop",
          conversationId,
          deviceId: context?.device?.id,
          requestId: context?.requestId,
          isOpen: context?.isOpen?.(),
        });
        return { conversationId, stopped: true, chunks: 1, byteLength: 3 };
      },
      cancelVoiceConversationResponse: async (conversationId, context) => {
        calls.push({
          type: "voice.conversation.cancel_response",
          conversationId,
          deviceId: context?.device?.id,
          isOpen: context?.isOpen?.(),
        });
        context?.sendEvent?.("voice.reply.cancelled", null, {
          conversationId,
          turnId: "conversation-turn-1",
        });
        return { conversationId, cancelled: true };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    await bridge.start();
    await callback({ bridge, dbPath, calls });
  } finally {
    await bridge.stop();
    clearPairingSession();
    closeDatabase(dbPath);
    await rm(directory, { force: true, recursive: true });
  }
}

async function connectClient(bridge) {
  const { port } = bridge.getStatus();
  const client = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false });
  await once(client, "open");
  return client;
}

async function sendBridgeMessage(client, message) {
  client.send(JSON.stringify(message));
  const [data] = await once(client, "message");
  return JSON.parse(data.toString("utf8"));
}

function readMessagesUntil(client, predicate, limit = 5) {
  const messages = [];
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for message. Received: ${JSON.stringify(messages)}`));
    }, 1000);
    const cleanup = () => {
      clearTimeout(timeoutId);
      client.off("message", handleMessage);
      client.off("error", handleError);
    };
    const handleMessage = (data) => {
      const message = JSON.parse(data.toString("utf8"));
      messages.push(message);
      if (predicate(message, messages)) {
        cleanup();
        resolve(messages);
        return;
      }
      if (messages.length >= limit) {
        cleanup();
        reject(new Error(`Expected bridge message was not received: ${JSON.stringify(messages)}`));
      }
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    client.on("message", handleMessage);
    client.on("error", handleError);
  });
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      emitter.off(event, handleEvent);
      emitter.off("error", handleError);
    };
    const handleEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    emitter.once(event, handleEvent);
    emitter.once("error", handleError);
  });
}

test("unauthenticated request is rejected", async () => {
  await withBridge(async ({ bridge }) => {
    const client = await connectClient(bridge);
    try {
      const response = await sendBridgeMessage(client, {
        type: "openai.status.get",
        requestId: "status-1",
      });
      assert.equal(response.ok, false);
      assert.equal(response.requestId, "status-1");
      assert.match(response.error.message, /Authenticate/);
    } finally {
      client.close();
    }
  });
});

test("active pairing accepts pair.request", async () => {
  await withBridge(async ({ bridge }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const response = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Ken's iPhone",
      });
      assert.equal(response.ok, true);
      assert.equal(response.type, "pair.result");
      assert.equal(response.payload.device.name, "Ken's iPhone");
      assert.equal(typeof response.payload.deviceToken, "string");
    } finally {
      client.close();
    }
  });
});

test("authenticated openai.status.get routes to injected handler", async () => {
  await withBridge(async ({ bridge }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      const auth = await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });
      assert.equal(auth.ok, true);

      const response = await sendBridgeMessage(client, {
        type: "openai.status.get",
        requestId: "status-1",
      });
      assert.deepEqual(response, {
        type: "openai.status",
        requestId: "status-1",
        ok: true,
        payload: { connected: true },
      });
    } finally {
      client.close();
    }
  });
});

test("authenticated tools.definitions.get returns wrapped tool definitions", async () => {
  await withBridge(async ({ bridge }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });
      const response = await sendBridgeMessage(client, {
        type: "tools.definitions.get",
        requestId: "tools-1",
      });

      assert.deepEqual(response, {
        type: "tools.definitions",
        requestId: "tools-1",
        ok: true,
        payload: { tools: [{ name: "list_tasks", type: "function" }] },
      });
    } finally {
      client.close();
    }
  });
});

test("authenticated tools.execute routes name and args", async () => {
  await withBridge(async ({ bridge, calls }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });
      const response = await sendBridgeMessage(client, {
        type: "tools.execute",
        requestId: "tool-1",
        name: "list_tasks",
        args: { includeDone: true },
      });

      assert.deepEqual(calls, [{ type: "tool", name: "list_tasks", args: { includeDone: true } }]);
      assert.equal(response.type, "tools.result");
      assert.deepEqual(response.payload, {
        status: "ok",
        name: "list_tasks",
        args: { includeDone: true },
      });
    } finally {
      client.close();
    }
  });
});

test("authenticated assistant.message routes prompt and returns reply", async () => {
  await withBridge(async ({ bridge, calls }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });
      const response = await sendBridgeMessage(client, {
        type: "assistant.message",
        requestId: "chat-1",
        message: "What is on my task list?",
        history: [{ role: "user", text: "hello" }],
      });

      assert.deepEqual(calls, [
        {
          type: "assistant",
          message: "What is on my task list?",
          history: [{ role: "user", text: "hello" }],
        },
      ]);
      assert.deepEqual(response, {
        type: "assistant.reply",
        requestId: "chat-1",
        ok: true,
        payload: { reply: "Echo: What is on my task list?" },
      });
    } finally {
      client.close();
    }
  });
});

test("authenticated voice.turn can stream deltas before final assistant audio", async () => {
  await withBridge(async ({ bridge, calls }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });
      const messagesPromise = readMessagesUntil(
        client,
        (message) => message.type === "voice.reply",
      );
      client.send(
        JSON.stringify({
          type: "voice.turn",
          requestId: "voice-1",
          audio: {
            chunks: ["AAAA", "AQID"],
            sampleRate: 24000,
            channels: 1,
            encoding: "pcm16",
          },
          history: [{ role: "assistant", text: "ready" }],
        }),
      );
      const [delta, response] = await messagesPromise;

      assert.deepEqual(calls, [
        {
          type: "voice",
          audio: {
            chunks: ["AAAA", "AQID"],
            sampleRate: 24000,
            channels: 1,
            encoding: "pcm16",
            mimeType: null,
          },
          history: [{ role: "assistant", text: "ready" }],
          context: {
            deviceId: pair.payload.device.id,
            requestId: "voice-1",
            isOpen: true,
          },
        },
      ]);
      assert.deepEqual(delta, {
        type: "voice.reply.delta",
        requestId: "voice-1",
        ok: true,
        payload: { turnId: "turn-1", delta: "Voice " },
      });
      assert.deepEqual(response, {
        type: "voice.reply",
        requestId: "voice-1",
        ok: true,
        payload: {
          turnId: "turn-1",
          transcript: "hello",
          reply: "Voice echo",
          audio: { base64: "UklGRgAAAAA=", mimeType: "audio/wav" },
        },
      });
    } finally {
      client.close();
    }
  });
});

test("authenticated live voice stream routes chunks and final reply", async () => {
  await withBridge(async ({ bridge, calls }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });

      const start = await sendBridgeMessage(client, {
        type: "voice.stream.start",
        requestId: "stream-start-1",
        turnId: "turn-live-1",
        audio: { sampleRate: 24000, channels: 1, encoding: "pcm16" },
        history: [{ role: "user", text: "before" }],
      });
      const audioAck = await sendBridgeMessage(client, {
        type: "voice.stream.audio",
        requestId: "stream-audio-1",
        turnId: "turn-live-1",
        chunk: "AAAA",
        sequence: 0,
      });
      const messagesPromise = readMessagesUntil(
        client,
        (message) => message.type === "voice.reply",
      );
      client.send(
        JSON.stringify({
          type: "voice.stream.end",
          requestId: "stream-end-1",
          turnId: "turn-live-1",
        }),
      );
      const [delta, response] = await messagesPromise;

      assert.deepEqual(calls, [
        {
          type: "voice.stream.start",
          turnId: "turn-live-1",
          audio: { sampleRate: 24000, channels: 1, encoding: "pcm16", mimeType: null },
          history: [{ role: "user", text: "before" }],
          context: {
            deviceId: pair.payload.device.id,
            requestId: "stream-start-1",
            isOpen: true,
          },
        },
        {
          type: "voice.stream.audio",
          turnId: "turn-live-1",
          chunk: "AAAA",
          sequence: 0,
          deviceId: pair.payload.device.id,
          isOpen: true,
        },
        {
          type: "voice.stream.end",
          turnId: "turn-live-1",
          deviceId: pair.payload.device.id,
          requestId: "stream-end-1",
          isOpen: true,
        },
      ]);
      assert.deepEqual(start, {
        type: "voice.stream.started",
        requestId: "stream-start-1",
        ok: true,
        payload: { turnId: "turn-live-1", started: true },
      });
      assert.deepEqual(audioAck, {
        type: "voice.stream.audio.ack",
        requestId: "stream-audio-1",
        ok: true,
        payload: { turnId: "turn-live-1", sequence: 0, received: true },
      });
      assert.deepEqual(delta, {
        type: "voice.reply.delta",
        requestId: "stream-end-1",
        ok: true,
        payload: { turnId: "turn-live-1", delta: "Live " },
      });
      assert.deepEqual(response, {
        type: "voice.reply",
        requestId: "stream-end-1",
        ok: true,
        payload: {
          turnId: "turn-live-1",
          transcript: "live hello",
          reply: "Live echo",
          audio: { base64: "UklGRgAAAAA=", mimeType: "audio/wav" },
        },
      });
    } finally {
      client.close();
    }
  });
});

test("authenticated realtime voice conversation routes chunks and streamed events", async () => {
  await withBridge(async ({ bridge, calls }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });

      const startMessagesPromise = readMessagesUntil(
        client,
        (message) => message.type === "voice.conversation.started",
      );
      client.send(
        JSON.stringify({
          type: "voice.conversation.start",
          requestId: "conversation-start-1",
          conversationId: "conversation-1",
          audio: { sampleRate: 24000, channels: 1, encoding: "pcm16" },
          history: [{ role: "user", text: "before" }],
        }),
      );
      const [startedEvent, start] = await startMessagesPromise;

      const audioAck = await sendBridgeMessage(client, {
        type: "voice.conversation.audio",
        requestId: "conversation-audio-1",
        conversationId: "conversation-1",
        chunk: "AAAA",
        sequence: 0,
      });
      const stop = await sendBridgeMessage(client, {
        type: "voice.conversation.stop",
        requestId: "conversation-stop-1",
        conversationId: "conversation-1",
      });

      assert.deepEqual(calls, [
        {
          type: "voice.conversation.start",
          conversationId: "conversation-1",
          audio: { sampleRate: 24000, channels: 1, encoding: "pcm16", mimeType: null },
          history: [{ role: "user", text: "before" }],
          context: {
            deviceId: pair.payload.device.id,
            requestId: "conversation-start-1",
            isOpen: true,
          },
        },
        {
          type: "voice.conversation.audio",
          conversationId: "conversation-1",
          chunk: "AAAA",
          sequence: 0,
          deviceId: pair.payload.device.id,
          isOpen: true,
        },
        {
          type: "voice.conversation.stop",
          conversationId: "conversation-1",
          deviceId: pair.payload.device.id,
          requestId: "conversation-stop-1",
          isOpen: true,
        },
      ]);
      assert.deepEqual(startedEvent, {
        type: "voice.reply.started",
        requestId: "conversation-start-1",
        ok: true,
        payload: { conversationId: "conversation-1", turnId: "conversation-turn-1" },
      });
      assert.deepEqual(start, {
        type: "voice.conversation.started",
        requestId: "conversation-start-1",
        ok: true,
        payload: { conversationId: "conversation-1", started: true },
      });
      assert.deepEqual(audioAck, {
        type: "voice.conversation.audio.ack",
        requestId: "conversation-audio-1",
        ok: true,
        payload: { conversationId: "conversation-1", sequence: 0, received: true },
      });
      assert.deepEqual(stop, {
        type: "voice.conversation.stopped",
        requestId: "conversation-stop-1",
        ok: true,
        payload: { conversationId: "conversation-1", stopped: true, chunks: 1, byteLength: 3 },
      });
    } finally {
      client.close();
    }
  });
});

test("authenticated voice.conversation.cancel_response routes conversation id", async () => {
  await withBridge(async ({ bridge, calls }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });
      const messagesPromise = readMessagesUntil(
        client,
        (message) => message.type === "voice.conversation.response_cancelled",
      );
      client.send(
        JSON.stringify({
          type: "voice.conversation.cancel_response",
          requestId: "conversation-cancel-1",
          conversationId: "conversation-1",
        }),
      );
      const [cancelledEvent, response] = await messagesPromise;

      assert.deepEqual(calls, [
        {
          type: "voice.conversation.cancel_response",
          conversationId: "conversation-1",
          deviceId: pair.payload.device.id,
          isOpen: true,
        },
      ]);
      assert.deepEqual(cancelledEvent, {
        type: "voice.reply.cancelled",
        requestId: null,
        ok: true,
        payload: { conversationId: "conversation-1", turnId: "conversation-turn-1" },
      });
      assert.deepEqual(response, {
        type: "voice.conversation.response_cancelled",
        requestId: "conversation-cancel-1",
        ok: true,
        payload: { conversationId: "conversation-1", cancelled: true },
      });
    } finally {
      client.close();
    }
  });
});

test("authenticated voice.stream.cancel routes turn id", async () => {
  await withBridge(async ({ bridge, calls }) => {
    const session = createPairingSession();
    const client = await connectClient(bridge);
    try {
      const pair = await sendBridgeMessage(client, {
        type: "pair.request",
        requestId: "pair-1",
        pairingCode: session.code,
        deviceName: "Android",
      });
      await sendBridgeMessage(client, {
        type: "auth",
        requestId: "auth-1",
        deviceId: pair.payload.device.id,
        deviceToken: pair.payload.deviceToken,
      });
      const response = await sendBridgeMessage(client, {
        type: "voice.stream.cancel",
        requestId: "cancel-1",
        turnId: "turn-1",
      });

      assert.deepEqual(calls, [
        {
          type: "voice.cancel",
          turnId: "turn-1",
          deviceId: pair.payload.device.id,
          isOpen: true,
        },
      ]);
      assert.deepEqual(response, {
        type: "voice.stream.cancelled",
        requestId: "cancel-1",
        ok: true,
        payload: { turnId: "turn-1", cancelled: true },
      });
    } finally {
      client.close();
    }
  });
});
