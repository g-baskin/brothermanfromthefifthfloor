import { randomUUID } from "node:crypto";

const bridgeRequestTypes = new Set([
  "auth",
  "pair.request",
  "openai.status.get",
  "realtime.secret.create",
  "tools.definitions.get",
  "tools.execute",
  "assistant.message",
]);

const MAX_REQUEST_ID_LENGTH = 120;

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
