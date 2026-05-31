import { getDatabase, getDatabasePath } from "./database.js";

export const FACTS_CHAR_BUDGET = 3000;
export const SOUL_CHAR_BUDGET = 1500;
export const DAILY_LOGS_CHAR_BUDGET = 2000;

export function getMemoryStorePath() {
  return getDatabasePath();
}

export function rememberFact(input, storePath = getMemoryStorePath()) {
  const fact = normalizeFactInput(input);
  const db = getDatabase(storePath);
  const existing = db
    .prepare("SELECT id FROM facts WHERE category = ? AND subject = ?")
    .get(fact.category, fact.subject);
  if (existing) {
    db.prepare(
      "UPDATE facts SET content = ?, importance = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?",
    ).run(fact.content, fact.importance, existing.id);
    return getFactById(existing.id, storePath);
  }
  const result = db
    .prepare("INSERT INTO facts (category, subject, content, importance) VALUES (?, ?, ?, ?)")
    .run(fact.category, fact.subject, fact.content, fact.importance);
  return getFactById(Number(result.lastInsertRowid), storePath);
}

export function listFacts({ category } = {}, storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  const trimmedCategory = normalizeOptionalString(category, 80);
  if (trimmedCategory) {
    return db
      .prepare(
        `SELECT id, category, subject, content, importance, last_accessed_at, created_at, updated_at
         FROM facts
         WHERE category = ?
         ORDER BY subject COLLATE NOCASE, updated_at DESC`,
      )
      .all(trimmedCategory)
      .map(normalizeFactRow);
  }
  return db
    .prepare(
      `SELECT id, category, subject, content, importance, last_accessed_at, created_at, updated_at
       FROM facts
       ORDER BY category COLLATE NOCASE, subject COLLATE NOCASE`,
    )
    .all()
    .map(normalizeFactRow);
}

export function searchFacts(query, { category, limit = 6 } = {}, storePath = getMemoryStorePath()) {
  const normalizedQuery = normalizeRequiredString(query, "query", 1, 120);
  const normalizedCategory = normalizeOptionalString(category, 80);
  const boundedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 6, 20));
  const pattern = `%${escapeLike(normalizedQuery)}%`;
  const db = getDatabase(storePath);
  if (normalizedCategory) {
    return db
      .prepare(
        `SELECT id, category, subject, content, importance, last_accessed_at, created_at, updated_at
         FROM facts
         WHERE category = ? AND (content LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(normalizedCategory, pattern, pattern, boundedLimit)
      .map(normalizeFactRow);
  }
  return db
    .prepare(
      `SELECT id, category, subject, content, importance, last_accessed_at, created_at, updated_at
       FROM facts
       WHERE content LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, boundedLimit)
    .map(normalizeFactRow);
}

export function forgetFact(query, storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  if (Number.isInteger(query?.id)) {
    const fact = getFactById(query.id, storePath);
    const result = db.prepare("DELETE FROM facts WHERE id = ?").run(query.id);
    return result.changes > 0 ? { deleted: true, fact } : { deleted: false, fact: null };
  }
  const category = normalizeRequiredString(query?.category, "category", 1, 80);
  const subject = normalizeRequiredString(query?.subject, "subject", 1, 120);
  const fact = db
    .prepare(
      `SELECT id, category, subject, content, importance, last_accessed_at, created_at, updated_at
       FROM facts
       WHERE category = ? AND subject = ?`,
    )
    .get(category, subject);
  const result = db
    .prepare("DELETE FROM facts WHERE category = ? AND subject = ?")
    .run(category, subject);
  return { deleted: result.changes > 0, fact: fact ? normalizeFactRow(fact) : null };
}

export function setSoulAspect(input, storePath = getMemoryStorePath()) {
  const aspect = normalizeRequiredString(input?.aspect, "aspect", 1, 80);
  const content = normalizeRequiredString(input?.content, "content", 1, 1200);
  const db = getDatabase(storePath);
  const existing = db.prepare("SELECT id FROM soul WHERE aspect = ?").get(aspect);
  if (existing) {
    db.prepare(
      "UPDATE soul SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id = ?",
    ).run(content, existing.id);
    return getSoulAspect(aspect, storePath);
  }
  const result = db
    .prepare("INSERT INTO soul (aspect, content) VALUES (?, ?)")
    .run(aspect, content);
  return getSoulAspectById(Number(result.lastInsertRowid), storePath);
}

export function getSoulAspect(aspect, storePath = getMemoryStorePath()) {
  const normalizedAspect = normalizeRequiredString(aspect, "aspect", 1, 80);
  const db = getDatabase(storePath);
  const row = db
    .prepare("SELECT id, aspect, content, created_at, updated_at FROM soul WHERE aspect = ?")
    .get(normalizedAspect);
  return row ? normalizeSoulRow(row) : null;
}

export function listSoulAspects(storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  return db
    .prepare(
      "SELECT id, aspect, content, created_at, updated_at FROM soul ORDER BY aspect COLLATE NOCASE",
    )
    .all()
    .map(normalizeSoulRow);
}

export function deleteSoulAspect(aspect, storePath = getMemoryStorePath()) {
  const normalizedAspect = normalizeRequiredString(aspect, "aspect", 1, 80);
  const db = getDatabase(storePath);
  const soulAspect = getSoulAspect(normalizedAspect, storePath);
  const result = db.prepare("DELETE FROM soul WHERE aspect = ?").run(normalizedAspect);
  return { deleted: result.changes > 0, aspect: soulAspect };
}

export function appendDailyLog(entry, storePath = getMemoryStorePath(), now = new Date()) {
  const normalizedEntry = normalizeRequiredString(entry, "entry", 1, 300);
  const db = getDatabase(storePath);
  const today = getLocalDate(now);
  const existing = getDailyLog(today, storePath);
  if (existing && isDuplicateLogEntry(existing.content, normalizedEntry)) {
    return { log: existing, skipped: true };
  }
  const formattedEntry = `[${getLocalTime(now)}] ${normalizedEntry}`;
  if (existing) {
    db.prepare(
      `UPDATE daily_logs
       SET content = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ')
       WHERE date = ?`,
    ).run(`${existing.content}\n${formattedEntry}`, today);
  } else {
    db.prepare(
      "INSERT INTO daily_logs (date, content, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ'))",
    ).run(today, formattedEntry);
  }
  return { log: getDailyLog(today, storePath), skipped: false };
}

export function getDailyLog(date = getLocalDate(), storePath = getMemoryStorePath()) {
  const normalizedDate = normalizeRequiredString(date, "date", 1, 20);
  const db = getDatabase(storePath);
  const row = db
    .prepare("SELECT id, date, content, updated_at FROM daily_logs WHERE date = ?")
    .get(normalizedDate);
  return row ? normalizeDailyLogRow(row) : null;
}

export function listDailyLogs(
  { days = 3 } = {},
  storePath = getMemoryStorePath(),
  now = new Date(),
) {
  const boundedDays = Math.max(1, Math.min(Number.isInteger(days) ? days : 3, 30));
  const db = getDatabase(storePath);
  return db
    .prepare(
      `SELECT id, date, content, updated_at
       FROM daily_logs
       WHERE date >= ?
       ORDER BY date DESC`,
    )
    .all(getLocalDate(addDays(now, -boundedDays)))
    .map(normalizeDailyLogRow);
}

export function deleteDailyLog(id, storePath = getMemoryStorePath()) {
  if (!Number.isInteger(id)) {
    throw new TypeError("id must be an integer.");
  }
  const db = getDatabase(storePath);
  const result = db.prepare("DELETE FROM daily_logs WHERE id = ?").run(id);
  return result.changes > 0;
}

export function buildMemoryContext(storePath = getMemoryStorePath(), now = new Date()) {
  return [
    buildFactsContext(storePath),
    buildSoulContext(storePath),
    buildDailyLogsContext(storePath, now),
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
}

export function buildFactsContext(storePath = getMemoryStorePath()) {
  const db = getDatabase(storePath);
  const facts = db
    .prepare(
      `SELECT id, category, subject, content, importance, last_accessed_at, created_at, updated_at
       FROM facts
       ORDER BY importance DESC, updated_at DESC`,
    )
    .all()
    .map(normalizeFactRow);
  if (facts.length === 0) {
    return "";
  }

  const headerReserve = 100;
  const contentBudget = FACTS_CHAR_BUDGET - headerReserve;
  const includedFacts = [];
  const byCategory = new Map();
  let usedChars = 0;

  for (const fact of facts) {
    const line = formatFactLine(fact);
    const categoryHeader = byCategory.has(fact.category) ? "" : `\n### ${fact.category}\n`;
    const additionalChars = categoryHeader.length + line.length + 1;
    if (usedChars + additionalChars > contentBudget) {
      break;
    }
    usedChars += additionalChars;
    includedFacts.push(fact);
    const categoryFacts = byCategory.get(fact.category) ?? [];
    categoryFacts.push(fact);
    byCategory.set(fact.category, categoryFacts);
  }

  if (includedFacts.length > 0) {
    const ids = includedFacts.map((fact) => fact.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE facts SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE id IN (${placeholders})`,
    ).run(...ids);
  }

  const lines = ["## Known Facts"];
  for (const [category, categoryFacts] of byCategory) {
    lines.push(`\n### ${category}`);
    for (const fact of categoryFacts) {
      lines.push(formatFactLine(fact));
    }
  }
  return lines.join("\n");
}

export function buildSoulContext(storePath = getMemoryStorePath()) {
  const aspects = listSoulAspects(storePath);
  if (aspects.length === 0) {
    return "";
  }
  const headerReserve = 80;
  const contentBudget = SOUL_CHAR_BUDGET - headerReserve;
  const lines = ["## Soul"];
  let usedChars = 0;

  for (const aspect of aspects) {
    const aspectHeader = `\n### ${aspect.aspect}`;
    const additionalChars = aspectHeader.length + 1 + aspect.content.length;
    if (usedChars + additionalChars > contentBudget) {
      break;
    }
    usedChars += additionalChars;
    lines.push(aspectHeader);
    lines.push(aspect.content);
  }
  return lines.join("\n");
}

export function buildDailyLogsContext(
  storePath = getMemoryStorePath(),
  now = new Date(),
  days = 3,
) {
  const logs = listDailyLogs({ days }, storePath, now);
  if (logs.length === 0) {
    return "";
  }
  const headerReserve = 90;
  const contentBudget = DAILY_LOGS_CHAR_BUDGET - headerReserve;
  const lines = ["## Recent Daily Logs"];
  let usedChars = 0;

  for (const log of [...logs].reverse()) {
    const dateLabel = log.date === getLocalDate(now) ? "Today" : log.date;
    const logHeader = `\n### ${dateLabel}`;
    const additionalChars = logHeader.length + 1 + log.content.length;
    if (usedChars + additionalChars > contentBudget) {
      const remaining = contentBudget - usedChars - logHeader.length - 1;
      if (remaining > 50) {
        lines.push(logHeader);
        lines.push(`${log.content.slice(0, remaining)}...`);
      }
      break;
    }
    usedChars += additionalChars;
    lines.push(logHeader);
    lines.push(log.content);
  }
  return lines.join("\n");
}

export function getMemoryOverview(storePath = getMemoryStorePath(), now = new Date()) {
  return {
    facts: listFacts({}, storePath),
    soul: listSoulAspects(storePath),
    dailyLogs: listDailyLogs({ days: 7 }, storePath, now),
    usage: {
      facts: getFactsUsage(storePath),
      soul: getSoulUsage(storePath),
      dailyLogs: getDailyLogsUsage(storePath, now),
    },
  };
}

export function getFactsUsage(storePath = getMemoryStorePath()) {
  const context = buildFactsContext(storePath);
  return createUsage(context.length, FACTS_CHAR_BUDGET);
}

export function getSoulUsage(storePath = getMemoryStorePath()) {
  const context = buildSoulContext(storePath);
  return createUsage(context.length, SOUL_CHAR_BUDGET);
}

export function getDailyLogsUsage(storePath = getMemoryStorePath(), now = new Date()) {
  const context = buildDailyLogsContext(storePath, now);
  return createUsage(context.length, DAILY_LOGS_CHAR_BUDGET);
}

function getFactById(id, storePath) {
  const db = getDatabase(storePath);
  const row = db
    .prepare(
      `SELECT id, category, subject, content, importance, last_accessed_at, created_at, updated_at
       FROM facts
       WHERE id = ?`,
    )
    .get(id);
  return row ? normalizeFactRow(row) : null;
}

function getSoulAspectById(id, storePath) {
  const db = getDatabase(storePath);
  const row = db
    .prepare("SELECT id, aspect, content, created_at, updated_at FROM soul WHERE id = ?")
    .get(id);
  return row ? normalizeSoulRow(row) : null;
}

function normalizeFactInput(input) {
  const category = normalizeRequiredString(input?.category, "category", 1, 80);
  const subject = normalizeRequiredString(input?.subject, "subject", 1, 120);
  const content = normalizeRequiredString(input?.content, "content", 1, 500);
  const importance = Number.isInteger(input?.importance)
    ? Math.max(1, Math.min(input.importance, 100))
    : 50;
  return { category, subject, content, importance };
}

function normalizeFactRow(row) {
  return {
    id: Number(row.id),
    category: String(row.category),
    subject: String(row.subject),
    content: String(row.content),
    importance: Number(row.importance ?? 50),
    last_accessed_at: row.last_accessed_at ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function normalizeSoulRow(row) {
  return {
    id: Number(row.id),
    aspect: String(row.aspect),
    content: String(row.content),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function normalizeDailyLogRow(row) {
  return {
    id: Number(row.id),
    date: String(row.date),
    content: String(row.content),
    updated_at: String(row.updated_at),
  };
}

function normalizeRequiredString(value, name, min, max) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new RangeError(`${name} must be between ${min} and ${max} characters.`);
  }
  return trimmed;
}

function normalizeOptionalString(value, max) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, max);
}

function formatFactLine(fact) {
  return fact.subject ? `- **${fact.subject}**: ${fact.content}` : `- ${fact.content}`;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function getLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLocalTime(date = new Date()) {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function extractWords(text) {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
}

function isDuplicateLogEntry(existingContent, newEntry) {
  const entries = existingContent.split(/\n/).filter((line) => line.startsWith("["));
  if (entries.length === 0) {
    return false;
  }
  const newWords = extractWords(newEntry);
  if (newWords.size === 0) {
    return false;
  }
  const newNormalized = newEntry
    .toLowerCase()
    .replace(/^\[.*?\]\s*/, "")
    .slice(0, 60);

  for (const entry of entries) {
    const entryBody = entry.replace(/^\[.*?\]\s*/, "").toLowerCase();
    if (newNormalized.length >= 20 && entryBody.startsWith(newNormalized)) {
      return true;
    }
    const entryWords = extractWords(entryBody);
    if (entryWords.size === 0) {
      continue;
    }
    let overlap = 0;
    for (const word of newWords) {
      if (entryWords.has(word)) {
        overlap += 1;
      }
    }
    if (overlap / newWords.size > 0.5) {
      return true;
    }
  }
  return false;
}

function createUsage(usedChars, budgetChars) {
  return {
    usedChars,
    budgetChars,
    pct: Math.round((usedChars / budgetChars) * 100),
  };
}
