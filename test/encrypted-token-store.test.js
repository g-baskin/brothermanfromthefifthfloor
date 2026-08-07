import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEncryptedTokenStore } from "../src/integrations/google/encrypted-token-store.js";

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => {
      const decoded = value.toString("utf8");
      if (!decoded.startsWith("encrypted:")) {
        throw new Error("invalid ciphertext");
      }
      return decoded.slice("encrypted:".length);
    },
  };
}

async function withStore(callback, safeStorage = fakeSafeStorage()) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-google-store-"));
  const filePath = path.join(directory, "google-calendar.json");
  try {
    await callback(createEncryptedTokenStore({ filePath, safeStorage }), filePath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("encrypted token store round trips without plaintext token storage", async () => {
  await withStore(async (store, filePath) => {
    await store.save({
      refreshToken: "refresh-secret",
      metadata: { connectedAt: "2026-08-06T12:00:00.000Z", scope: "calendar.events.owned" },
    });

    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes("refresh-secret"), false);
    assert.deepEqual(await store.load(), {
      refreshToken: "refresh-secret",
      metadata: { connectedAt: "2026-08-06T12:00:00.000Z", scope: "calendar.events.owned" },
    });
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });
});

test("encrypted token store refuses unavailable encryption", async () => {
  await withStore(async (store, filePath) => {
    assert.equal(store.isEncryptionAvailable(), false);
    await assert.rejects(
      store.save({ refreshToken: "secret" }),
      (error) => error.code === "secure_storage_unavailable",
    );
    await assert.rejects(store.load(), (error) => error.code === "secure_storage_unavailable");
    await assert.rejects(stat(filePath), { code: "ENOENT" });
  }, fakeSafeStorage(false));
});

test("encrypted token store rejects malformed files", async () => {
  await withStore(async (store, filePath) => {
    await writeFile(filePath, '{"version":1,"refreshToken":"no-metadata"}', { mode: 0o600 });
    await assert.rejects(store.load(), (error) => error.code === "credential_store_error");
  });
});

test("encrypted token store delete is idempotent", async () => {
  await withStore(async (store, filePath) => {
    await store.save({ refreshToken: "secret" });
    await chmod(filePath, 0o600);
    await store.delete();
    await store.delete();
    assert.equal(await store.load(), null);
  });
});
