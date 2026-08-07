import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const STORE_VERSION = 1;

export function createEncryptedTokenStore({ filePath, safeStorage }) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new TypeError("A Google token store file path is required.");
  }

  function assertEncryptionAvailable() {
    if (!safeStorage?.isEncryptionAvailable?.()) {
      const error = new Error("Secure credential storage is unavailable on this device.");
      error.code = "secure_storage_unavailable";
      throw error;
    }
  }

  return {
    isEncryptionAvailable() {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    },

    async load() {
      assertEncryptionAvailable();
      let parsed;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") {
          return null;
        }
        throw createStoreError("Google Calendar credentials could not be read.", error);
      }

      if (
        parsed?.version !== STORE_VERSION ||
        typeof parsed.refreshToken !== "string" ||
        !parsed.refreshToken ||
        !isValidMetadata(parsed.metadata)
      ) {
        throw createStoreError("Google Calendar credentials are malformed.");
      }

      try {
        const refreshToken = safeStorage.decryptString(Buffer.from(parsed.refreshToken, "base64"));
        if (!refreshToken) {
          throw new Error("Decrypted token was empty.");
        }
        return { refreshToken, metadata: parsed.metadata };
      } catch (error) {
        throw createStoreError("Google Calendar credentials could not be decrypted.", error);
      }
    },

    async save({ refreshToken, metadata = {} }) {
      assertEncryptionAvailable();
      if (typeof refreshToken !== "string" || !refreshToken.trim()) {
        throw new TypeError("A Google refresh token is required.");
      }
      if (!isValidMetadata(metadata)) {
        throw new TypeError("Google credential metadata is invalid.");
      }

      const directory = path.dirname(filePath);
      const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      const payload = JSON.stringify(
        {
          version: STORE_VERSION,
          refreshToken: safeStorage.encryptString(refreshToken).toString("base64"),
          metadata,
        },
        null,
        2,
      );

      await mkdir(directory, { recursive: true });
      try {
        await writeFile(temporaryPath, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, filePath);
        await chmod(filePath, 0o600);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw createStoreError("Google Calendar credentials could not be saved.", error);
      }
    },

    async delete() {
      try {
        await rm(filePath, { force: true });
      } catch (error) {
        throw createStoreError("Google Calendar credentials could not be removed.", error);
      }
    },
  };
}

function isValidMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  return Object.entries(metadata).every(
    ([key, value]) =>
      ["connectedAt", "scope"].includes(key) && typeof value === "string" && value.length <= 2048,
  );
}

function createStoreError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "credential_store_error";
  return error;
}
