import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDatabase } from "../src/realtime/tools/database.js";
import {
  appendDailyLog,
  buildMemoryContext,
  forgetFact,
  getMemoryOverview,
  listFacts,
  listSoulAspects,
  rememberFact,
  searchFacts,
  setSoulAspect,
} from "../src/realtime/tools/memory-store.js";

async function withMemoryDb(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-memory-"));
  const filePath = path.join(directory, "brah.db");
  try {
    await callback(filePath);
  } finally {
    closeDatabase(filePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("facts upsert by category and subject and can be searched/forgotten", async () => {
  await withMemoryDb((storePath) => {
    const first = rememberFact(
      { category: "preferences", subject: "coffee", content: "Likes iced coffee." },
      storePath,
    );
    const second = rememberFact(
      {
        category: "preferences",
        subject: "coffee",
        content: "Prefers hot coffee.",
        importance: 80,
      },
      storePath,
    );

    assert.equal(second.id, first.id);
    assert.deepEqual(
      listFacts({}, storePath).map((fact) => fact.content),
      ["Prefers hot coffee."],
    );
    assert.equal(searchFacts("hot", {}, storePath)[0].subject, "coffee");

    const result = forgetFact({ id: second.id }, storePath);
    assert.equal(result.deleted, true);
    assert.deepEqual(listFacts({}, storePath), []);
  });
});

test("soul aspects upsert and are injected into memory context", async () => {
  await withMemoryDb((storePath) => {
    setSoulAspect(
      { aspect: "communication_style", content: "Be direct when Greg is frustrated." },
      storePath,
    );
    setSoulAspect(
      { aspect: "communication_style", content: "Be direct and own misses fast." },
      storePath,
    );

    const aspects = listSoulAspects(storePath);
    assert.equal(aspects.length, 1);
    assert.equal(aspects[0].content, "Be direct and own misses fast.");
    assert.match(buildMemoryContext(storePath), /## Soul/);
    assert.match(buildMemoryContext(storePath), /own misses fast/);
  });
});

test("daily logs skip duplicate entries and appear in overview", async () => {
  await withMemoryDb((storePath) => {
    const now = new Date("2026-05-30T14:30:00");
    const first = appendDailyLog("Discussed Pocket Agent memory port.", storePath, now);
    const duplicate = appendDailyLog("Discussed Pocket Agent memory port.", storePath, now);

    assert.equal(first.skipped, false);
    assert.equal(duplicate.skipped, true);

    const overview = getMemoryOverview(storePath, now);
    assert.equal(overview.dailyLogs.length, 1);
    assert.match(overview.dailyLogs[0].content, /Pocket Agent memory port/);
    assert.ok(overview.usage.dailyLogs.pct > 0);
  });
});
