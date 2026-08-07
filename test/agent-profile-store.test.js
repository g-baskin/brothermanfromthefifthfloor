import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGENT_PROFILE_LIMITS,
  buildAgentProfileInstructions,
  normalizeAgentProfile,
} from "../src/realtime/prompts.js";
import { loadAgentProfile, saveAgentProfile } from "../src/realtime/tools/agent-profile-store.js";
import { closeDatabase, getDatabase } from "../src/realtime/tools/database.js";

async function withProfileDb(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-agent-"));
  const filePath = path.join(directory, "brah.db");
  try {
    await callback(filePath);
  } finally {
    closeDatabase(filePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("missing agent profile falls back to extended defaults", async () => {
  await withProfileDb((filePath) => {
    assert.deepEqual(loadAgentProfile(filePath), {
      about: "",
      goals: [],
      name: "Greg",
      responsePreferences: [],
      standingInstructions: [],
    });
  });
});

test("legacy name and goals profiles migrate without data loss", async () => {
  await withProfileDb((filePath) => {
    getDatabase(filePath)
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(
        "agent_profile",
        JSON.stringify({ name: "  Sam  ", goals: ["Ship the app", "Learn guitar"] }),
      );

    assert.deepEqual(loadAgentProfile(filePath), {
      about: "",
      goals: ["Ship the app", "Learn guitar"],
      name: "Sam",
      responsePreferences: [],
      standingInstructions: [],
    });
  });
});

test("agent profile normalizes, deduplicates, and persists every field", async () => {
  await withProfileDb((filePath) => {
    const saved = saveAgentProfile(
      {
        about: "  Building Brah.\r\n\r\n  Likes   direct help.  ",
        goals: ["  Ship   the app  ", "", "ship the app", "Learn guitar"],
        name: "  Sam   Jones  ",
        responsePreferences: ["  Keep it short  ", "keep it short", "Lead with the answer"],
        standingInstructions: [
          "  Never send   messages without asking  ",
          "never send messages without asking",
          "Use metric units",
        ],
      },
      filePath,
    );

    assert.deepEqual(saved, {
      about: "Building Brah.\n\nLikes direct help.",
      goals: ["Ship the app", "Learn guitar"],
      name: "Sam Jones",
      responsePreferences: ["Keep it short", "Lead with the answer"],
      standingInstructions: ["Never send messages without asking", "Use metric units"],
    });

    closeDatabase(filePath);
    assert.deepEqual(loadAgentProfile(filePath), saved);
  });
});

test("legacy name and goals updates preserve extended profile fields", async () => {
  await withProfileDb((filePath) => {
    saveAgentProfile(
      {
        about: "Developer",
        goals: ["A"],
        name: "Sam",
        responsePreferences: ["Concise"],
        standingInstructions: ["Ask before sending"],
      },
      filePath,
    );

    const updated = saveAgentProfile({ name: "Alex", goals: ["B"] }, filePath);
    assert.deepEqual(updated, {
      about: "Developer",
      goals: ["B"],
      name: "Alex",
      responsePreferences: ["Concise"],
      standingInstructions: ["Ask before sending"],
    });
  });
});

test("normalization bounds every profile field", () => {
  const profile = normalizeAgentProfile({
    about: "a".repeat(AGENT_PROFILE_LIMITS.about + 50),
    goals: Array.from(
      { length: AGENT_PROFILE_LIMITS.goals.items + 5 },
      (_, index) => `${index}-${"g".repeat(AGENT_PROFILE_LIMITS.goals.itemLength + 10)}`,
    ),
    name: "n".repeat(AGENT_PROFILE_LIMITS.name + 50),
    responsePreferences: Array.from(
      { length: AGENT_PROFILE_LIMITS.responsePreferences.items + 5 },
      (_, index) =>
        `${index}-${"r".repeat(AGENT_PROFILE_LIMITS.responsePreferences.itemLength + 10)}`,
    ),
    standingInstructions: Array.from(
      { length: AGENT_PROFILE_LIMITS.standingInstructions.items + 5 },
      (_, index) =>
        `${index}-${"s".repeat(AGENT_PROFILE_LIMITS.standingInstructions.itemLength + 10)}`,
    ),
  });

  assert.equal(profile.about.length, AGENT_PROFILE_LIMITS.about);
  assert.equal(profile.name.length, AGENT_PROFILE_LIMITS.name);
  for (const [field, limits] of [
    ["goals", AGENT_PROFILE_LIMITS.goals],
    ["responsePreferences", AGENT_PROFILE_LIMITS.responsePreferences],
    ["standingInstructions", AGENT_PROFILE_LIMITS.standingInstructions],
  ]) {
    assert.equal(profile[field].length, limits.items);
    assert.ok(profile[field].every((item) => item.length <= limits.itemLength));
  }
});

test("profile prompt renders separated context, preferences, and explicit user rules", () => {
  const prompt = buildAgentProfileInstructions({
    about: "Builds desktop voice assistants.",
    goals: ["Ship Brah"],
    name: "Sam",
    responsePreferences: ["Lead with the answer"],
    standingInstructions: ["Ask before sending messages"],
  });

  assert.match(prompt, /^# User Profile/);
  assert.match(prompt, /## Name\nThe user's name is Sam\./);
  assert.match(prompt, /## About the User\nBuilds desktop voice assistants\./);
  assert.match(prompt, /## Current Goals\n- Ship Brah/);
  assert.match(prompt, /## Response Preferences\n- Lead with the answer/);
  assert.match(prompt, /## Standing Instructions — Explicit User Rules/);
  assert.match(prompt, /Treat every item below as an explicit rule from the user\./);
  assert.match(prompt, /- Ask before sending messages/);
  assert.ok(prompt.indexOf("## Response Preferences") < prompt.indexOf("## Standing Instructions"));
});
