import {
  appendDailyLog,
  deleteSoulAspect,
  forgetFact,
  getSoulAspect,
  listFacts,
  listSoulAspects,
  rememberFact,
  searchFacts,
  setSoulAspect,
} from "./memory-store.js";

export async function executeMemoryTool(name, args = {}, options = {}) {
  try {
    switch (name) {
      case "remember":
        return rememberTool(args, options);
      case "forget":
        return forgetTool(args, options);
      case "list_facts":
        return listFactsTool(args, options);
      case "memory_search":
        return memorySearchTool(args, options);
      case "daily_log":
        return dailyLogTool(args, options);
      case "soul_set":
        return soulSetTool(args, options);
      case "soul_get":
        return soulGetTool(args, options);
      case "soul_list":
        return soulListTool(options);
      case "soul_delete":
        return soulDeleteTool(args, options);
      default:
        return null;
    }
  } catch (error) {
    return invalidArguments(error instanceof Error ? error.message : "Invalid memory arguments.");
  }
}

function rememberTool(args, options) {
  const fact = rememberFact(args, options.storePath);
  return {
    status: "remembered",
    message: `Remembered ${fact.subject}.`,
    fact,
  };
}

function forgetTool(args, options) {
  if (!isRecord(args)) {
    return invalidArguments("Arguments must be an object.");
  }
  if (!Number.isInteger(args.id) && (!args.category || !args.subject)) {
    return invalidArguments("Provide either id OR category and subject.");
  }
  const result = forgetFact(args, options.storePath);
  return result.deleted
    ? {
        status: "forgotten",
        message: "Fact forgotten.",
        fact: result.fact,
      }
    : {
        status: "not_found",
        message: "Fact not found.",
      };
}

function listFactsTool(args, options) {
  const facts = listFacts(isRecord(args) ? args : {}, options.storePath);
  return {
    status: "listed",
    message:
      facts.length > 0
        ? "Use fact ids for forget follow-ups."
        : "No long-term facts are stored yet.",
    facts: facts.map(formatFact),
  };
}

function memorySearchTool(args, options) {
  if (!isRecord(args) || typeof args.query !== "string") {
    return invalidArguments("query must be a string.");
  }
  const facts = searchFacts(
    args.query,
    { category: args.category, limit: Number.isInteger(args.limit) ? args.limit : 6 },
    options.storePath,
  );
  return {
    status: "searched",
    message: facts.length > 0 ? "Matching facts found." : "No matching facts found.",
    facts: facts.map(formatFact),
  };
}

function dailyLogTool(args, options) {
  if (!isRecord(args) || typeof args.entry !== "string") {
    return invalidArguments("entry must be a string.");
  }
  const { log, skipped } = appendDailyLog(args.entry, options.storePath, options.now ?? new Date());
  return {
    status: skipped ? "skipped" : "logged",
    message: skipped
      ? "Skipped — this topic is already logged today. Only log if something materially new happened."
      : "Entry added to daily log.",
    date: log.date,
    skipped,
  };
}

function soulSetTool(args, options) {
  const aspect = setSoulAspect(args, options.storePath);
  return {
    status: "updated",
    message: `Soul aspect updated: ${aspect.aspect}.`,
    aspect: formatSoulAspect(aspect),
  };
}

function soulGetTool(args, options) {
  if (!isRecord(args) || typeof args.aspect !== "string") {
    return invalidArguments("aspect must be a string.");
  }
  const aspect = getSoulAspect(args.aspect, options.storePath);
  return aspect
    ? {
        status: "found",
        message: `Soul aspect found: ${aspect.aspect}.`,
        aspect: formatSoulAspect(aspect),
      }
    : {
        status: "not_found",
        message: `Soul aspect not found: ${args.aspect.trim()}.`,
      };
}

function soulListTool(options) {
  const aspects = listSoulAspects(options.storePath);
  return {
    status: "listed",
    message: aspects.length > 0 ? "Soul aspects listed." : "No soul aspects are stored yet.",
    aspects: aspects.map(formatSoulAspect),
  };
}

function soulDeleteTool(args, options) {
  if (!isRecord(args) || typeof args.aspect !== "string") {
    return invalidArguments("aspect must be a string.");
  }
  const result = deleteSoulAspect(args.aspect, options.storePath);
  return result.deleted
    ? {
        status: "deleted",
        message: `Soul aspect deleted: ${result.aspect.aspect}.`,
        aspect: formatSoulAspect(result.aspect),
      }
    : {
        status: "not_found",
        message: `Soul aspect not found: ${args.aspect.trim()}.`,
      };
}

function formatFact(fact) {
  return {
    id: fact.id,
    category: fact.category,
    subject: fact.subject,
    content: fact.content,
    importance: fact.importance,
    updated_at: fact.updated_at,
  };
}

function formatSoulAspect(aspect) {
  return {
    id: aspect.id,
    aspect: aspect.aspect,
    content: aspect.content,
    updated_at: aspect.updated_at,
  };
}

function invalidArguments(message) {
  return {
    status: "invalid_arguments",
    message,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
