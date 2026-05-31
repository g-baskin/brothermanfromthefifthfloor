import assert from "node:assert/strict";
import test from "node:test";
import {
  createBridgeError,
  createBridgeResponse,
  isBridgeRequestMessage,
  normalizeBridgeMessage,
} from "../src/mobile/message-protocol.js";

test("accepts valid auth, pair, assistant, voice, and tool messages", () => {
  const auth = normalizeBridgeMessage({
    type: "auth",
    deviceId: " phone-1 ",
    deviceToken: "secret",
  });
  assert.equal(auth.type, "auth");
  assert.match(auth.requestId, /./);
  assert.equal(auth.deviceId, "phone-1");
  assert.equal(auth.deviceToken, "secret");

  assert.deepEqual(
    normalizeBridgeMessage({
      type: "pair.request",
      requestId: "pair-1",
      pairingCode: " 123456 ",
      deviceName: " Ken's iPhone ",
      clientId: " android-install-1 ",
    }),
    {
      type: "pair.request",
      requestId: "pair-1",
      pairingCode: "123456",
      deviceName: "Ken's iPhone",
      clientId: "android-install-1",
    },
  );

  assert.deepEqual(
    normalizeBridgeMessage({
      type: "assistant.message",
      requestId: "chat-1",
      message: " what do I have today? ",
      history: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hey" },
        { role: "system", text: "ignore" },
      ],
    }),
    {
      type: "assistant.message",
      requestId: "chat-1",
      message: "what do I have today?",
      history: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hey" },
      ],
    },
  );

  assert.deepEqual(
    normalizeBridgeMessage({
      type: "tools.execute",
      requestId: "tool-1",
      name: " list_tasks ",
      args: { limit: 3 },
    }),
    {
      type: "tools.execute",
      requestId: "tool-1",
      name: "list_tasks",
      args: { limit: 3 },
    },
  );

  assert.deepEqual(
    normalizeBridgeMessage({
      type: "voice.turn",
      requestId: "voice-1",
      audio: {
        chunks: [" AAA= ", "AQID"],
        sampleRate: 24000,
        channels: 1,
        encoding: "PCM16",
      },
      history: [{ role: "assistant", text: "ready" }],
    }),
    {
      type: "voice.turn",
      requestId: "voice-1",
      audio: {
        chunks: ["AAA=", "AQID"],
        sampleRate: 24000,
        channels: 1,
        encoding: "pcm16",
        mimeType: null,
      },
      history: [{ role: "assistant", text: "ready" }],
    },
  );

  assert.deepEqual(
    normalizeBridgeMessage({
      type: "voice.turn",
      requestId: "voice-2",
      audio: {
        base64: "AQID",
        sampleRate: 44100,
        channels: 1,
        encoding: "aac_m4a",
        mimeType: " audio/mp4 ",
      },
    }),
    {
      type: "voice.turn",
      requestId: "voice-2",
      audio: {
        chunks: ["AQID"],
        sampleRate: 44100,
        channels: 1,
        encoding: "aac_m4a",
        mimeType: "audio/mp4",
      },
      history: [],
    },
  );
});

test("accepts simple authenticated request types", () => {
  assert.equal(
    normalizeBridgeMessage({ type: "openai.status.get", requestId: "status-1" }).requestId,
    "status-1",
  );
  assert.equal(
    normalizeBridgeMessage({ type: "realtime.secret.create", requestId: "secret-1" }).type,
    "realtime.secret.create",
  );
  assert.equal(
    normalizeBridgeMessage({ type: "tools.definitions.get", requestId: "tools-1" }).type,
    "tools.definitions.get",
  );
});

test("rejects non-object, unknown, and bad fields", () => {
  assert.throws(() => normalizeBridgeMessage(null), /object/);
  assert.throws(() => normalizeBridgeMessage({ type: "unknown" }), /Unsupported/);
  assert.throws(() => normalizeBridgeMessage({ type: "auth", deviceId: "x" }), /deviceToken/);
  assert.throws(
    () => normalizeBridgeMessage({ type: "pair.request", pairingCode: "123456" }),
    /deviceName/,
  );
  assert.throws(
    () => normalizeBridgeMessage({ type: "assistant.message", message: "" }),
    /message/,
  );
  assert.throws(() => normalizeBridgeMessage({ type: "tools.execute", name: "" }), /name/);
  assert.throws(
    () => normalizeBridgeMessage({ type: "tools.execute", name: "list_tasks", args: [] }),
    /args/,
  );
  assert.throws(() => normalizeBridgeMessage({ type: "voice.turn", audio: null }), /audio/);
  assert.throws(
    () =>
      normalizeBridgeMessage({
        type: "voice.turn",
        audio: { chunks: ["not base64?"], sampleRate: 24000, channels: 1, encoding: "pcm16" },
      }),
    /base64/,
  );
  assert.throws(
    () =>
      normalizeBridgeMessage({
        type: "voice.turn",
        audio: { chunks: ["AAAA"], sampleRate: 96000, channels: 1, encoding: "pcm16" },
      }),
    /sampleRate/,
  );
  assert.throws(
    () =>
      normalizeBridgeMessage({
        type: "voice.turn",
        audio: { chunks: ["AAAA"], sampleRate: 24000, channels: 3, encoding: "pcm16" },
      }),
    /channels/,
  );
  assert.throws(
    () =>
      normalizeBridgeMessage({
        type: "voice.turn",
        audio: { chunks: ["AAAA"], sampleRate: 24000, channels: 1, encoding: "aac" },
      }),
    /encoding/,
  );
  assert.throws(
    () => normalizeBridgeMessage({ type: "openai.status.get", requestId: "x".repeat(121) }),
    /requestId/,
  );
});

test("creates stable response and error envelopes", () => {
  assert.deepEqual(createBridgeResponse("openai.status", "req-1", { connected: true }), {
    type: "openai.status",
    requestId: "req-1",
    ok: true,
    payload: { connected: true },
  });

  assert.deepEqual(createBridgeError("Nope", "req-2"), {
    type: "error",
    requestId: "req-2",
    ok: false,
    error: { message: "Nope" },
  });
});

test("identifies bridge request messages", () => {
  assert.equal(isBridgeRequestMessage({ type: "auth" }), true);
  assert.equal(isBridgeRequestMessage({ type: "assistant.message" }), true);
  assert.equal(isBridgeRequestMessage({ type: "voice.turn" }), true);
  assert.equal(isBridgeRequestMessage({ type: "error" }), false);
  assert.equal(isBridgeRequestMessage(null), false);
});
