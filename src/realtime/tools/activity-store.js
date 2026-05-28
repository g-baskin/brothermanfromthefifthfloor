import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const storageVersion = 1;
const maxEntriesPerKind = 50;
const maxTextExcerpt = 600;
const activityKinds = Object.freeze(["web_search", "web_fetch", "computer_use"]);

export function getActivityStorePath() {
  return path.join(getUserDataPath(), "activity", "log.json");
}

export async function recordActivity(entry, storePath = getActivityStorePath()) {
  const normalized = normalizeEntry(entry);
  if (!normalized) {
    return null;
  }
  const state = await loadActivityState(storePath);
  const entries = [normalized, ...state.entries].slice(0, maxEntriesPerKind * activityKinds.length);
  const capped = capByKind(entries);
  await saveActivityState({ entries: capped }, storePath);
  return normalized;
}

export async function listActivity(kind, storePath = getActivityStorePath()) {
  const state = await loadActivityState(storePath);
  const sorted = [...state.entries].sort((a, b) => b.time.localeCompare(a.time));
  if (typeof kind === "string" && kind.trim()) {
    return sorted.filter((entry) => entry.kind === kind.trim());
  }
  return sorted;
}

export async function loadActivityState(storePath = getActivityStorePath()) {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    if (!raw.trim()) {
      return emptyActivityState();
    }
    return normalizeActivityState(JSON.parse(raw));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("Failed to load activity state", error);
    }
    return emptyActivityState();
  }
}

export async function saveActivityState(state, storePath = getActivityStorePath()) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: storageVersion,
        entries: capByKind(state.entries.map(normalizeEntry).filter(Boolean)),
      },
      null,
      2,
    ),
  );
}

export function emptyActivityState() {
  return { entries: [] };
}

function capByKind(entries) {
  const counts = new Map();
  const kept = [];
  for (const entry of entries) {
    const used = counts.get(entry.kind) ?? 0;
    if (used >= maxEntriesPerKind) {
      continue;
    }
    counts.set(entry.kind, used + 1);
    kept.push(entry);
  }
  return kept;
}

function normalizeActivityState(value) {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return emptyActivityState();
  }
  return { entries: value.entries.map(normalizeEntry).filter(Boolean) };
}

function normalizeEntry(value) {
  if (!isRecord(value) || !activityKinds.includes(value.kind)) {
    return null;
  }
  const base = {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : createActivityId(),
    kind: value.kind,
    time:
      typeof value.time === "string" && value.time.trim() ? value.time : new Date().toISOString(),
  };
  if (value.kind === "web_search") {
    return {
      ...base,
      query: clampText(value.query, 300),
      resultCount: Number.isInteger(value.resultCount) ? value.resultCount : 0,
      results: normalizeSearchResults(value.results),
    };
  }
  if (value.kind === "web_fetch") {
    return {
      ...base,
      url: clampText(value.url, 600),
      title: clampText(value.title, 300),
      text: clampText(value.text, maxTextExcerpt),
    };
  }
  return {
    ...base,
    task: clampText(value.task, 600),
    statusText: clampText(value.statusText, 60),
    steps: Number.isInteger(value.steps) ? value.steps : 0,
    finalText: clampText(value.finalText, maxTextExcerpt),
  };
}

function normalizeSearchResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }
  return results.slice(0, 10).map((result) => ({
    title: clampText(result?.title, 300),
    url: clampText(result?.url, 600),
    snippet: clampText(result?.snippet, 400),
  }));
}

function clampText(value, max) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, max);
}

function createActivityId() {
  return `activity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getUserDataPath() {
  if (globalThis.process?.type) {
    try {
      const electronApp = globalThis.require?.("electron")?.app;
      if (electronApp?.getPath) {
        return electronApp.getPath("userData");
      }
    } catch {
      // Fall through to the deterministic Node test/runtime path.
    }
  }
  return path.join(os.tmpdir(), "brah-user-data");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
