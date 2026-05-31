import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearPairingSession,
  completePairing,
  createPairingSession,
  deleteMobileDevice,
  getPairingSession,
  listMobileDevices,
  verifyMobileDevice,
} from "../src/mobile/pairing-store.js";
import { closeDatabase, getDatabase } from "../src/realtime/tools/database.js";

async function withMobileStore(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-mobile-"));
  const dbPath = path.join(directory, "mobile.db");
  try {
    await callback(dbPath);
  } finally {
    clearPairingSession();
    closeDatabase(dbPath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("pairing session creates a six-digit code", () => {
  clearPairingSession();
  const session = createPairingSession();
  assert.match(session.code, /^\d{6}$/);
  assert.equal(getPairingSession().code, session.code);
  assert.equal(session.expiresAt - session.createdAt, 15 * 60 * 1000);
  clearPairingSession();
});

test("expired pairing fails", async () => {
  await withMobileStore(async (dbPath) => {
    const session = createPairingSession({ now: Date.now() - 16 * 60 * 1000 });
    assert.equal(getPairingSession(), null);
    const result = completePairing(
      { pairingCode: session.code, deviceName: "Ken's iPhone" },
      dbPath,
    );
    assert.equal(result.ok, false);
  });
});

test("successful pairing stores hashed token and returns plaintext token once", async () => {
  await withMobileStore(async (dbPath) => {
    const session = createPairingSession();
    const result = completePairing(
      { pairingCode: session.code, deviceName: " Ken's iPhone " },
      dbPath,
    );

    assert.equal(result.ok, true);
    assert.equal(result.device.name, "Ken's iPhone");
    assert.match(result.device.id, /^mobile_/);
    assert.equal(typeof result.deviceToken, "string");
    assert.equal(getPairingSession(), null);

    const row = getDatabase(dbPath)
      .prepare("SELECT token_hash FROM mobile_devices WHERE id = ?")
      .get(result.device.id);
    assert.notEqual(row.token_hash, result.deviceToken);
    assert.equal(row.token_hash, createHash("sha256").update(result.deviceToken).digest("hex"));
  });
});

test("duplicate pairing retry returns the same completed device", async () => {
  await withMobileStore(async (dbPath) => {
    const session = createPairingSession();
    const first = completePairing({ pairingCode: session.code, deviceName: "Android" }, dbPath);
    const second = completePairing({ pairingCode: session.code, deviceName: "Android" }, dbPath);

    assert.equal(second.ok, true);
    assert.equal(second.device.id, first.device.id);
    assert.equal(second.deviceToken, first.deviceToken);
    assert.equal(listMobileDevices(dbPath).length, 1);
  });
});

test("re-pairing the same client updates one listed device", async () => {
  await withMobileStore(async (dbPath) => {
    const firstSession = createPairingSession();
    const first = completePairing(
      { pairingCode: firstSession.code, deviceName: "Android", clientId: "install-1" },
      dbPath,
    );
    const secondSession = createPairingSession();
    const second = completePairing(
      { pairingCode: secondSession.code, deviceName: "Android", clientId: "install-1" },
      dbPath,
    );

    assert.equal(second.ok, true);
    assert.equal(second.device.id, first.device.id);
    assert.notEqual(second.deviceToken, first.deviceToken);
    assert.equal(listMobileDevices(dbPath).length, 1);
  });
});

test("verify succeeds with correct token and fails with wrong token", async () => {
  await withMobileStore(async (dbPath) => {
    const session = createPairingSession();
    const result = completePairing({ pairingCode: session.code, deviceName: "Android" }, dbPath);

    assert.equal(
      verifyMobileDevice({ deviceId: result.device.id, deviceToken: "wrong" }, dbPath),
      null,
    );
    const verified = verifyMobileDevice(
      { deviceId: result.device.id, deviceToken: result.deviceToken },
      dbPath,
    );
    assert.equal(verified.id, result.device.id);
    assert.equal(verified.name, "Android");
    assert.equal(typeof verified.lastSeenAt, "string");
  });
});

test("list and delete devices work", async () => {
  await withMobileStore(async (dbPath) => {
    const firstSession = createPairingSession();
    const first = completePairing({ pairingCode: firstSession.code, deviceName: "First" }, dbPath);
    const secondSession = createPairingSession();
    const second = completePairing(
      { pairingCode: secondSession.code, deviceName: "Second" },
      dbPath,
    );

    assert.deepEqual(
      listMobileDevices(dbPath).map((device) => device.name),
      ["Second", "First"],
    );
    assert.equal(deleteMobileDevice(first.device.id, dbPath), true);
    assert.deepEqual(
      listMobileDevices(dbPath).map((device) => device.id),
      [second.device.id],
    );
    assert.equal(deleteMobileDevice(first.device.id, dbPath), false);
  });
});
