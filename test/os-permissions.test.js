import assert from "node:assert/strict";
import test from "node:test";
import {
  createOsPermissionSnapshot,
  getMacOsPrivacySettingsUrl,
  getWindowsPrivacySettingsUrl,
  isKnownOsPermissionId,
  normalizeOsPermissionStatus,
  osPermissionDefinitions,
} from "../src/os-permissions.js";

test("OS permission definitions include activation instructions", () => {
  assert.deepEqual(
    osPermissionDefinitions.map((permission) => permission.id),
    ["microphone", "screen", "accessibility", "computer"],
  );
  for (const permission of osPermissionDefinitions) {
    assert.equal(typeof permission.label, "string");
    assert.equal(typeof permission.description, "string");
    assert.match(permission.activation, /Click Request/);
  }
  const accessibility = osPermissionDefinitions.find((p) => p.id === "accessibility");
  assert.match(accessibility.description, /Computer Use/);
});

test("createOsPermissionSnapshot normalizes statuses", () => {
  assert.deepEqual(
    createOsPermissionSnapshot({
      microphone: "granted",
      screen: "weird",
      accessibility: "unsupported",
      computer: "granted",
    }).map(({ id, status }) => ({ id, status })),
    [
      { id: "microphone", status: "granted" },
      { id: "screen", status: "unknown" },
      { id: "accessibility", status: "unsupported" },
      { id: "computer", status: "granted" },
    ],
  );
  assert.equal(normalizeOsPermissionStatus("denied"), "denied");
  assert.equal(normalizeOsPermissionStatus("nope"), "unknown");
});

test("permission ids and settings URLs are mapped", () => {
  assert.equal(isKnownOsPermissionId("microphone"), true);
  assert.equal(isKnownOsPermissionId("computer"), true);
  assert.equal(isKnownOsPermissionId("missing"), false);
  assert.match(getMacOsPrivacySettingsUrl("microphone"), /Privacy_Microphone/);
  assert.match(getMacOsPrivacySettingsUrl("screen"), /Privacy_ScreenCapture/);
  assert.match(getMacOsPrivacySettingsUrl("accessibility"), /Privacy_Accessibility/);
  assert.equal(getWindowsPrivacySettingsUrl("microphone"), "ms-settings:privacy-microphone");
});
