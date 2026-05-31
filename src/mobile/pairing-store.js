import { createHash, randomBytes } from "node:crypto";
import { getDatabase, getDatabasePath } from "../realtime/tools/database.js";

const PAIRING_DURATION_MS = 15 * 60 * 1000;
const COMPLETED_PAIRING_REPLAY_MS = 10 * 60 * 1000;
const DEVICE_TOKEN_BYTES = 32;
const DEVICE_ID_BYTES = 16;
const MAX_DEVICE_NAME_LENGTH = 80;

let activePairingSession = null;
let recentCompletedPairing = null;

export function createPairingSession(options = {}) {
  const now = resolveNow(options.now);
  recentCompletedPairing = null;
  activePairingSession = {
    code: createPairingCode(),
    createdAt: now,
    expiresAt: now + PAIRING_DURATION_MS,
  };
  return { ...activePairingSession };
}

export function getPairingSession() {
  if (!activePairingSession) {
    return null;
  }
  if (activePairingSession.expiresAt <= Date.now()) {
    clearPairingSession();
    return null;
  }
  return { ...activePairingSession };
}

export function clearPairingSession() {
  activePairingSession = null;
  recentCompletedPairing = null;
}

export function completePairing(
  { pairingCode, deviceName, clientId },
  storePath = getDatabasePath(),
) {
  const code = typeof pairingCode === "string" ? pairingCode.trim() : "";
  const name = normalizeDeviceName(deviceName);
  const normalizedClientId = normalizeClientId(clientId);
  const session = getPairingSession();
  if (!session) {
    const replay = getRecentCompletedPairing(code, name, normalizedClientId);
    if (replay) {
      return replay;
    }
    return { ok: false, error: "Pairing is not active." };
  }
  if (!code || code !== session.code) {
    return { ok: false, error: "Pairing code is invalid." };
  }

  if (!name) {
    return { ok: false, error: "Device name is required." };
  }

  const db = getDatabase(storePath);
  const existingDevice = normalizedClientId
    ? db
        .prepare("SELECT id, created_at FROM mobile_devices WHERE client_id = ?")
        .get(normalizedClientId)
    : null;
  const deviceId = existingDevice?.id ?? createDeviceId();
  const deviceToken = createDeviceToken();
  const createdAt = existingDevice?.created_at ?? new Date().toISOString();
  const tokenHash = hashDeviceToken(deviceToken);
  if (existingDevice) {
    db.prepare(
      "UPDATE mobile_devices SET name = ?, token_hash = ?, last_seen_at = NULL WHERE id = ?",
    ).run(name, tokenHash, deviceId);
  } else {
    db.prepare(
      "INSERT INTO mobile_devices (id, name, token_hash, created_at, last_seen_at, client_id) VALUES (?, ?, ?, ?, NULL, ?)",
    ).run(deviceId, name, tokenHash, createdAt, normalizedClientId);
  }
  activePairingSession = null;

  const result = {
    ok: true,
    device: {
      id: deviceId,
      name,
      createdAt,
      lastSeenAt: null,
    },
    deviceToken,
  };
  recentCompletedPairing = {
    pairingCode: code,
    deviceName: name,
    clientId: normalizedClientId,
    expiresAt: Date.now() + COMPLETED_PAIRING_REPLAY_MS,
    result,
  };
  return clonePairingResult(result);
}

export function verifyMobileDevice({ deviceId, deviceToken }, storePath = getDatabasePath()) {
  if (typeof deviceId !== "string" || !deviceId.trim()) {
    return null;
  }
  if (typeof deviceToken !== "string" || !deviceToken.trim()) {
    return null;
  }

  const db = getDatabase(storePath);
  const row = db
    .prepare(
      "SELECT id, name, token_hash, created_at, last_seen_at, client_id FROM mobile_devices WHERE id = ?",
    )
    .get(deviceId.trim());
  if (!row || row.token_hash !== hashDeviceToken(deviceToken)) {
    return null;
  }

  const lastSeenAt = new Date().toISOString();
  db.prepare("UPDATE mobile_devices SET last_seen_at = ? WHERE id = ?").run(lastSeenAt, row.id);
  return normalizeDeviceRow({ ...row, last_seen_at: lastSeenAt });
}

export function listMobileDevices(storePath = getDatabasePath()) {
  return getDatabase(storePath)
    .prepare(
      "SELECT id, name, created_at, last_seen_at, client_id FROM mobile_devices ORDER BY created_at DESC, rowid DESC",
    )
    .all()
    .map(normalizeDeviceRow);
}

export function deleteMobileDevice(deviceId, storePath = getDatabasePath()) {
  if (typeof deviceId !== "string" || !deviceId.trim()) {
    return false;
  }
  const result = getDatabase(storePath)
    .prepare("DELETE FROM mobile_devices WHERE id = ?")
    .run(deviceId.trim());
  return result.changes > 0;
}

function getRecentCompletedPairing(pairingCode, deviceName, clientId) {
  if (
    !recentCompletedPairing ||
    recentCompletedPairing.expiresAt <= Date.now() ||
    recentCompletedPairing.pairingCode !== pairingCode ||
    recentCompletedPairing.deviceName !== deviceName
  ) {
    return null;
  }
  if (recentCompletedPairing.clientId && recentCompletedPairing.clientId !== clientId) {
    return null;
  }
  return { ...clonePairingResult(recentCompletedPairing.result), replayed: true };
}

function clonePairingResult(result) {
  return {
    ok: result.ok,
    device: { ...result.device },
    deviceToken: result.deviceToken,
  };
}

function createPairingCode() {
  const value = Number.parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000;
  return String(value).padStart(6, "0");
}

function createDeviceId() {
  return `mobile_${randomBytes(DEVICE_ID_BYTES).toString("base64url")}`;
}

function createDeviceToken() {
  return randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
}

function hashDeviceToken(deviceToken) {
  return createHash("sha256").update(deviceToken).digest("hex");
}

function normalizeDeviceName(value) {
  return typeof value === "string" ? value.trim().slice(0, MAX_DEVICE_NAME_LENGTH) : "";
}

function normalizeClientId(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function normalizeDeviceRow(row) {
  return {
    id: row.id,
    name: row.name,
    clientId: row.client_id ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? null,
  };
}

function resolveNow(now) {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}
