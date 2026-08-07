import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultServerTurnDetection,
  defaultTranscription,
} from "../src/realtime/audio-input-defaults.js";

// Regression: with an unpinned transcriber the model invented short
// foreign-language turns ("굉장해요.", "きっと", "Καλημέρα.") out of room noise.
// Each phantom turn was treated as a real barge-in and truncated the assistant.
test("transcription pins the language so noise is not transcribed as speech", () => {
  assert.equal(defaultTranscription.language, "en");
  assert.equal(defaultTranscription.model, "gpt-4o-transcribe");
});

// Regression: threshold 0.35 let breathing and speaker bleed register as speech,
// firing a client-side response.cancel that cut the assistant off mid-word.
test("server VAD threshold stays above the level that caused false barge-in", () => {
  assert.ok(
    defaultServerTurnDetection.threshold >= 0.5,
    `VAD threshold ${defaultServerTurnDetection.threshold} is sensitive enough to re-introduce self-interruption`,
  );
  assert.equal(defaultServerTurnDetection.type, "server_vad");
  // Barge-in must still work; these being false would break interruption entirely.
  assert.equal(defaultServerTurnDetection.create_response, true);
  assert.equal(defaultServerTurnDetection.interrupt_response, true);
});

test("audio input defaults are frozen so a caller cannot mutate shared config", () => {
  assert.throws(() => {
    defaultServerTurnDetection.threshold = 0.1;
  }, TypeError);
  assert.equal(defaultServerTurnDetection.threshold >= 0.5, true);
});
