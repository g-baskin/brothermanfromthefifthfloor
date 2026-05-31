import { randomUUID } from "node:crypto";

const bridgeRequestTypes = new Set([
  "auth",
  "pair.request",
  "openai.status.get",
  "realtime.secret.create",
  "tools.definitions.get",
  "tools.execute",
  "assistant.message",
  "voice.turn",
  "voice.stream.start",
  "voice.stream.audio",
  "voice.stream.end",
  "voice.stream.cancel",
]);

const MAX_REQUEST_ID_LENGTH = 120;
const MAX_TURN_ID_LENGTH = 120;
const MAX_VOICE_CHUNKS = 800;
const MAX_VOICE_BASE64_BYTES = 8 * 1024 * 1024;
const MAX_VOICE_STREAM_CHUNK_BASE64_BYTES = 256 * 1024;
const MAX_VOICE_STREAM_SEQUENCE = 1_000_000;
const supportedVoiceEncodings = new Set(["pcm16", "aac_m4a"]);

export function normalizeBridgeMessage(value) {
  if (!isPlainObject(value)) {
    throw new Error("Bridge message must be an object.");
  }
  if (typeof value.type !== "string" || !value.type.trim()) {
    throw new Error("Bridge message type must be a non-empty string.");
  }

  const type = value.type.trim();
  if (!bridgeRequestTypes.has(type)) {
    throw new Error(`Unsupported bridge message type: ${type}`);
  }

  const requestId = normalizeRequestId(value.requestId);
  switch (type) {
    case "auth":
      return normalizeAuthMessage(value, requestId);
    case "pair.request":
      return normalizePairRequestMessage(value, requestId);
    case "tools.execute":
      return normalizeToolExecuteMessage(value, requestId);
    case "assistant.message":
      return normalizeAssistantMessage(value, requestId);
    case "voice.turn":
      return normalizeVoiceTurnMessage(value, requestId);
    case "voice.stream.start":
      return normalizeVoiceStreamStartMessage(value, requestId);
    case "voice.stream.audio":
      return normalizeVoiceStreamAudioMessage(value, requestId);
    case "voice.stream.end":
      return normalizeVoiceStreamEndMessage(value, requestId);
    case "voice.stream.cancel":
      return normalizeVoiceStreamCancelMessage(value, requestId);
    default:
      return { type, requestId };
  }
}

export function createBridgeResponse(type, requestId, payload = {}) {
  return {
    type,
    requestId: normalizeResponseRequestId(requestId),
    ok: true,
    payload: isPlainObject(payload) ? payload : { value: payload },
  };
}

export function createBridgeError(message, requestId) {
  return {
    type: "error",
    requestId: normalizeResponseRequestId(requestId),
    ok: false,
    error: {
      message:
        typeof message === "string" && message.trim() ? message.trim() : "Bridge request failed.",
    },
  };
}

export function isBridgeRequestMessage(message) {
  return isPlainObject(message) && bridgeRequestTypes.has(message.type);
}

function normalizeAuthMessage(value, requestId) {
  if (typeof value.deviceId !== "string" || !value.deviceId.trim()) {
    throw new Error("auth.deviceId must be a non-empty string.");
  }
  if (typeof value.deviceToken !== "string" || !value.deviceToken.trim()) {
    throw new Error("auth.deviceToken must be a non-empty string.");
  }
  return {
    type: "auth",
    requestId,
    deviceId: value.deviceId.trim(),
    deviceToken: value.deviceToken,
  };
}

function normalizePairRequestMessage(value, requestId) {
  if (typeof value.pairingCode !== "string" || !value.pairingCode.trim()) {
    throw new Error("pair.request.pairingCode must be a non-empty string.");
  }
  if (typeof value.deviceName !== "string" || !value.deviceName.trim()) {
    throw new Error("pair.request.deviceName must be a non-empty string.");
  }
  return {
    type: "pair.request",
    requestId,
    pairingCode: value.pairingCode.trim(),
    deviceName: value.deviceName.trim(),
    clientId: normalizeOptionalString(value.clientId),
  };
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function normalizeAssistantMessage(value, requestId) {
  if (typeof value.message !== "string" || !value.message.trim()) {
    throw new Error("assistant.message.message must be a non-empty string.");
  }
  return {
    type: "assistant.message",
    requestId,
    message: value.message.trim().slice(0, 4000),
    history: normalizeAssistantHistory(value.history),
  };
}

function normalizeAssistantHistory(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const history = [];
  for (const item of value.slice(-12)) {
    if (!isPlainObject(item)) {
      continue;
    }
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (role && text) {
      history.push({ role, text: text.slice(0, 2000) });
    }
  }
  return history;
}

function normalizeToolExecuteMessage(value, requestId) {
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("tools.execute.name must be a non-empty string.");
  }
  if (value.args !== undefined && !isPlainObject(value.args)) {
    throw new Error("tools.execute.args must be an object when provided.");
  }
  return {
    type: "tools.execute",
    requestId,
    name: value.name.trim(),
    args: value.args ?? {},
  };
}

function normalizeVoiceTurnMessage(value, requestId) {
  if (!isPlainObject(value.audio)) {
    throw new Error("voice.turn.audio must be an object.");
  }
  const encoding = normalizeVoiceEncoding(value.audio.encoding);
  const chunks = normalizeVoiceAudioChunks(value.audio);
  const sampleRate = normalizeVoiceSampleRate(value.audio.sampleRate);
  const channels = normalizeVoiceChannels(value.audio.channels);
  return {
    type: "voice.turn",
    requestId,
    audio: {
      chunks,
      sampleRate,
      channels,
      encoding,
      mimeType: normalizeOptionalString(value.audio.mimeType),
    },
    history: normalizeAssistantHistory(value.history),
  };
}

export function normalizeVoiceStreamStartMessage(value, requestId) {
  if (!isPlainObject(value.audio)) {
    throw new Error("voice.stream.start.audio must be an object.");
  }
  return {
    type: "voice.stream.start",
    requestId,
    turnId: normalizeTurnId(value.turnId, "voice.stream.start.turnId"),
    audio: {
      sampleRate: normalizeVoiceSampleRate(value.audio.sampleRate),
      channels: normalizeVoiceChannels(value.audio.channels),
      encoding: normalizePcmVoiceEncoding(
        value.audio.encoding,
        "voice.stream.start.audio.encoding",
      ),
      mimeType: normalizeOptionalString(value.audio.mimeType),
    },
    history: normalizeAssistantHistory(value.history),
  };
}

export function normalizeVoiceStreamAudioMessage(value, requestId) {
  return {
    type: "voice.stream.audio",
    requestId,
    turnId: normalizeTurnId(value.turnId, "voice.stream.audio.turnId"),
    chunk: normalizeVoiceStreamChunk(value.chunk),
    sequence: normalizeVoiceStreamSequence(value.sequence),
  };
}

export function normalizeVoiceStreamEndMessage(value, requestId) {
  return {
    type: "voice.stream.end",
    requestId,
    turnId: normalizeTurnId(value.turnId, "voice.stream.end.turnId"),
  };
}

export function normalizeVoiceStreamCancelMessage(value, requestId) {
  return {
    type: "voice.stream.cancel",
    requestId,
    turnId: normalizeTurnId(value.turnId, "voice.stream.cancel.turnId"),
  };
}

function normalizeVoiceAudioChunks(audio) {
  const rawChunks = Array.isArray(audio.chunks)
    ? audio.chunks
    : typeof audio.base64 === "string"
      ? [audio.base64]
      : [];
  if (rawChunks.length === 0 || rawChunks.length > MAX_VOICE_CHUNKS) {
    throw new Error("voice.turn.audio.chunks must include a reasonable number of chunks.");
  }

  let totalLength = 0;
  const chunks = [];
  for (const chunk of rawChunks) {
    if (typeof chunk !== "string" || !chunk.trim()) {
      throw new Error("voice.turn.audio chunks must be non-empty base64 strings.");
    }
    const trimmed = chunk.trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
      throw new Error("voice.turn.audio chunks must be base64 encoded.");
    }
    totalLength += trimmed.length;
    if (totalLength > MAX_VOICE_BASE64_BYTES) {
      throw new Error("voice.turn.audio is too large.");
    }
    chunks.push(trimmed);
  }
  return chunks;
}

function normalizeVoiceSampleRate(value) {
  const sampleRate = Number(value);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    throw new Error("voice.turn.audio.sampleRate must be between 8000 and 48000.");
  }
  return sampleRate;
}

function normalizeVoiceChannels(value) {
  const channels = Number(value);
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new Error("voice.turn.audio.channels must be 1 or 2.");
  }
  return channels;
}

function normalizeVoiceEncoding(value) {
  const encoding = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!supportedVoiceEncodings.has(encoding)) {
    throw new Error("voice.turn.audio.encoding must be pcm16 or aac_m4a.");
  }
  return encoding;
}

function normalizePcmVoiceEncoding(value, fieldName) {
  const encoding = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (encoding !== "pcm16") {
    throw new Error(`${fieldName} must be pcm16.`);
  }
  return encoding;
}

function normalizeVoiceStreamChunk(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("voice.stream.audio.chunk must be a non-empty base64 string.");
  }
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error("voice.stream.audio.chunk must be base64 encoded.");
  }
  if (trimmed.length > MAX_VOICE_STREAM_CHUNK_BASE64_BYTES) {
    throw new Error("voice.stream.audio.chunk is too large.");
  }
  return trimmed;
}

function normalizeVoiceStreamSequence(value) {
  const sequence = Number(value);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > MAX_VOICE_STREAM_SEQUENCE) {
    throw new Error("voice.stream.audio.sequence must be a reasonable non-negative integer.");
  }
  return sequence;
}

function normalizeTurnId(value, fieldName) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TURN_ID_LENGTH) {
    throw new Error(`${fieldName} must be a non-empty short string.`);
  }
  return value.trim();
}

function normalizeRequestId(value) {
  if (value === undefined || value === null) {
    return randomUUID();
  }
  if (typeof value !== "string" || !value.trim() || value.length > MAX_REQUEST_ID_LENGTH) {
    throw new Error("Bridge message requestId must be a short string when provided.");
  }
  return value.trim();
}

function normalizeResponseRequestId(value) {
  if (typeof value === "string" && value.trim() && value.length <= MAX_REQUEST_ID_LENGTH) {
    return value.trim();
  }
  return null;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
