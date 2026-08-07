import assert from "node:assert/strict";
import test from "node:test";
import { acquireMicrophoneWithPermission } from "../src/renderer/microphone-access.js";

for (const staleStatus of ["denied", "restricted"]) {
  test(`stale macOS ${staleStatus} status still proceeds to microphone capture`, async () => {
    const calls = [];
    const stream = { id: `${staleStatus}-stream` };

    const result = await acquireMicrophoneWithPermission({
      getPermissions: async () => [{ id: "microphone", status: staleStatus }],
      requestPermission: async () => {
        calls.push("request");
        return [];
      },
      acquireStream: async () => {
        calls.push("capture");
        return stream;
      },
      openSettings: async () => calls.push("settings"),
    });

    assert.equal(result, stream);
    assert.deepEqual(calls, ["capture"]);
  });
}

test("a real getUserMedia denial opens Microphone Settings", async () => {
  const calls = [];
  const denial = new Error("Permission denied");
  denial.name = "NotAllowedError";

  await assert.rejects(
    acquireMicrophoneWithPermission({
      getPermissions: async () => [{ id: "microphone", status: "denied" }],
      requestPermission: async () => [],
      acquireStream: async () => {
        calls.push("capture");
        throw denial;
      },
      openSettings: async () => calls.push("settings"),
    }),
    (error) => {
      assert.equal(error.cause, denial);
      assert.match(error.message, /Microphone access is required/);
      return true;
    },
  );

  assert.deepEqual(calls, ["capture", "settings"]);
});
