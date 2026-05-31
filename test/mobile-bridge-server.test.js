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
      sendVoiceTurn: async (audio, history) => {
        calls.push({ type: "voice", audio, history });
        return {
          transcript: "hello",
          reply: "Voice echo",
          audio: { base64: "UklGRgAAAAA=", mimeType: "audio/wav" },
        };
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

test("authenticated voice.turn routes audio and returns assistant audio", async () => {
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
        type: "voice.turn",
        requestId: "voice-1",
        audio: {
          chunks: ["AAAA", "AQID"],
          sampleRate: 24000,
          channels: 1,
          encoding: "pcm16",
        },
        history: [{ role: "assistant", text: "ready" }],
      });

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
        },
      ]);
      assert.deepEqual(response, {
        type: "voice.reply",
        requestId: "voice-1",
        ok: true,
        payload: {
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
