const GMAIL_TOOL_NAMES = new Set(["gmail_search_messages", "gmail_get_message"]);

export function isGmailTool(name) {
  return GMAIL_TOOL_NAMES.has(name);
}

export async function executeGmailTool(name, args, adapter) {
  if (!isGmailTool(name)) return null;
  if (!adapter) return integrationNotConnected();

  const validation = validateArguments(name, args);
  if (!validation.ok) {
    return { status: "invalid_arguments", message: validation.message };
  }

  try {
    if (name === "gmail_search_messages") {
      const result = await adapter.searchMessages(args);
      return {
        status: "listed",
        message: `Found ${result.messages.length} Gmail message${result.messages.length === 1 ? "" : "s"}.`,
        ...result,
      };
    }
    return {
      status: "retrieved",
      message: "Gmail message retrieved.",
      email: await adapter.getMessage(args.messageId),
    };
  } catch (error) {
    return {
      status: error?.code || "error",
      message: error instanceof Error ? error.message : "Gmail could not complete the request.",
    };
  }
}

function validateArguments(name, args) {
  if (!isRecord(args)) return invalid("Arguments must be an object.");
  const allowed =
    name === "gmail_search_messages" ? ["query", "maxResults", "includeSpamTrash"] : ["messageId"];
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) return invalid(`Unknown argument: ${unknown}.`);

  if (name === "gmail_get_message") {
    return validString(args.messageId, 1, 1024)
      ? { ok: true }
      : invalid("messageId must be between 1 and 1024 characters.");
  }
  if (args.query !== undefined && !validString(args.query, 1, 500)) {
    return invalid("query must be between 1 and 500 characters.");
  }
  if (
    args.maxResults !== undefined &&
    (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > 25)
  ) {
    return invalid("maxResults must be an integer from 1 to 25.");
  }
  if (args.includeSpamTrash !== undefined && typeof args.includeSpamTrash !== "boolean") {
    return invalid("includeSpamTrash must be a boolean.");
  }
  return { ok: true };
}

function integrationNotConnected() {
  return {
    status: "integration_not_connected",
    message: "Google is not connected. Connect Google Calendar + Gmail in Settings.",
  };
}

function validString(value, min, max) {
  return typeof value === "string" && value.trim().length >= min && value.length <= max;
}

function invalid(message) {
  return { ok: false, message };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
