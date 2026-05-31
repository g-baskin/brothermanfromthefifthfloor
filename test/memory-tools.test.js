import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { closeDatabase } from "../src/realtime/tools/database.js";
import { executeMemoryTool } from "../src/realtime/tools/memory-tools.js";

async function withMemoryToolDb(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "brah-memory-tools-"));
  const storePath = path.join(directory, "brah.db");
  try {
    await callback({ storePath, now: new Date("2026-05-30T09:15:00") });
  } finally {
    closeDatabase(storePath);
    await rm(directory, { force: true, recursive: true });
  }
}

test("executeMemoryTool handles fact and soul tools", async () => {
  await withMemoryToolDb(async (options) => {
    let result = await executeMemoryTool(
      "remember",
      { category: "projects", subject: "brah", content: "Brah is Greg's desktop assistant." },
      options,
    );
    assert.equal(result.status, "remembered");
    assert.equal(result.fact.subject, "brah");

    result = await executeMemoryTool("memory_search", { query: "desktop" }, options);
    assert.equal(result.status, "searched");
    assert.equal(result.facts.length, 1);

    result = await executeMemoryTool(
      "soul_set",
      { aspect: "repair", content: "Acknowledge misses plainly and fix them." },
      options,
    );
    assert.equal(result.status, "updated");

    result = await executeMemoryTool("soul_list", {}, options);
    assert.equal(result.status, "listed");
    assert.equal(result.aspects[0].aspect, "repair");

    result = await executeMemoryTool("forget", { category: "projects", subject: "brah" }, options);
    assert.equal(result.status, "forgotten");
  });
});

test("executeMemoryTool logs daily entries and ignores unrelated tools", async () => {
  await withMemoryToolDb(async (options) => {
    const result = await executeMemoryTool(
      "daily_log",
      { entry: "Ported Pocket memory tools." },
      options,
    );
    assert.equal(result.status, "logged");
    assert.equal(result.date, "2026-05-30");

    assert.equal(await executeMemoryTool("web_search", { query: "x" }, options), null);
  });
});
