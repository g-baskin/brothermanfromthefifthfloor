/**
 * Shared microphone-input defaults for Realtime sessions.
 *
 * Kept DOM- and Electron-free so the values can be unit tested. These settings
 * were tuned against a real failure: the assistant was cutting itself off
 * mid-sentence with no input from the user.
 *
 * Two causes, both visible in the diagnostics log:
 *
 *  1. An unpinned transcriber hallucinated short foreign-language tokens
 *     ("굉장해요.", "きっと", "Καλημέρα.") out of room noise and breathing.
 *     Those were accepted as real user turns.
 *  2. A permissive VAD threshold (0.35) classified that same non-speech audio
 *     as speech, which fired a client-side barge-in and cancelled the in-flight
 *     response, truncating the assistant mid-word.
 */

/** Pinning the language sharply reduces noise-driven transcription hallucinations. */
export const defaultTranscription = Object.freeze({
  model: "gpt-4o-transcribe",
  language: "en",
});

export const defaultNoiseReduction = Object.freeze({ type: "near_field" });

/**
 * Acoustic server VAD for the desktop WebRTC session. The threshold is the
 * direct lever on false barge-in: lower is more trigger-happy.
 */
export const defaultServerTurnDetection = Object.freeze({
  type: "server_vad",
  threshold: 0.55,
  prefix_padding_ms: 300,
  silence_duration_ms: 700,
  create_response: true,
  interrupt_response: true,
});
