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
  listChatMemory,
  listFacts,
  listSoulAspects,
  recordChatTurn,
  rememberFact,
  searchChatMemory,
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

test("chat turns are saved, searchable, and injected into context", async () => {
  await withMemoryDb((storePath) => {
    recordChatTurn(
      {
        source: "mobile",
        role: "user",
        content: "Remind me that the Android bridge can see all monitors.",
        createdAt: new Date("2026-05-30T15:00:00Z"),
      },
      storePath,
    );
    recordChatTurn(
      {
        source: "mobile",
        role: "assistant",
        content: "Got it — desktop Brah handles the screen tools.",
        createdAt: new Date("2026-05-30T15:01:00Z"),
      },
      storePath,
    );

    assert.equal(listChatMemory({ limit: 10 }, storePath).length, 2);
    assert.equal(searchChatMemory("monitors", {}, storePath)[0].role, "user");
    const context = buildMemoryContext(storePath, new Date("2026-05-30T15:02:00Z"), {
      chatQuery: "What did I say about monitors?",
    });
    assert.match(context, /Recent\/Recalled Chat Memory/);
    assert.match(context, /Android bridge can see all monitors/);

    const overview = getMemoryOverview(storePath, new Date("2026-05-30T15:02:00Z"));
    assert.equal(overview.chatMemory.length, 2);
    assert.ok(overview.usage.chatMemory.pct > 0);
  });
});

test("chat turn retention is capped and chat context can be disabled", async () => {
  await withMemoryDb((storePath) => {
    for (let index = 0; index < 5; index += 1) {
      recordChatTurn(
        {
          source: "mobile",
          role: "user",
          content: `Saved chat turn ${index}`,
          createdAt: new Date(`2026-05-30T15:0${index}:00Z`),
          retentionLimit: 3,
        },
        storePath,
      );
    }

    assert.deepEqual(
      listChatMemory({ limit: 10 }, storePath).map((turn) => turn.content),
      ["Saved chat turn 4", "Saved chat turn 3", "Saved chat turn 2"],
    );
    assert.doesNotMatch(
      buildMemoryContext(storePath, new Date(), { includeChatMemory: false }),
      /Recent\/Recalled Chat Memory/,
    );
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
