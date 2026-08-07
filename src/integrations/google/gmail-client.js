const GMAIL_MESSAGES_API = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 25;
const MAX_SNIPPET_LENGTH = 1000;
const MAX_BODY_LENGTH = 20_000;

export function createGmailClient({ getAccessToken, fetchImpl = globalThis.fetch }) {
  async function request(url, retry401 = true) {
    const token = await getAccessToken({
      forceRefresh: !retry401,
      requiredScope: "https://www.googleapis.com/auth/gmail.readonly",
    });
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw gmailError("gmail_network_error", "Gmail could not be reached. Try again.");
    }

    if (response.status === 401 && retry401) {
      return request(url, false);
    }
    if (!response.ok) {
      throw mapGmailError(response.status);
    }
    try {
      return await response.json();
    } catch {
      throw gmailError("gmail_invalid_response", "Gmail returned an invalid response.");
    }
  }

  async function getMessageResource(messageId, format = "metadata") {
    const url = new URL(`${GMAIL_MESSAGES_API}/${encodeURIComponent(messageId)}`);
    url.searchParams.set("format", format);
    if (format === "metadata") {
      for (const header of ["From", "To", "Cc", "Subject", "Date"]) {
        url.searchParams.append("metadataHeaders", header);
      }
    }
    return request(url);
  }

  async function getAttachmentData(messageId, attachmentId) {
    const url = new URL(
      `${GMAIL_MESSAGES_API}/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    const payload = await request(url);
    if (typeof payload?.data !== "string") {
      throw gmailError("gmail_invalid_response", "Gmail returned an invalid attachment body.");
    }
    return payload.data;
  }

  return {
    async searchMessages({ query, maxResults = DEFAULT_MAX_RESULTS, includeSpamTrash = false }) {
      const boundedMaxResults = Math.min(
        MAX_RESULTS,
        Math.max(1, Number.isInteger(maxResults) ? maxResults : DEFAULT_MAX_RESULTS),
      );
      const url = new URL(GMAIL_MESSAGES_API);
      url.search = new URLSearchParams({
        maxResults: String(boundedMaxResults),
        ...(query ? { q: query } : {}),
        ...(includeSpamTrash ? { includeSpamTrash: "true" } : {}),
      }).toString();
      const payload = await request(url);
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const details = await Promise.all(
        messages.slice(0, boundedMaxResults).map(async (message) => {
          if (typeof message?.id !== "string" || !message.id) {
            throw gmailError("gmail_invalid_response", "Gmail returned an invalid message list.");
          }
          return mapMessage(await getMessageResource(message.id));
        }),
      );
      return {
        messages: details,
        nextPageToken: boundedString(payload?.nextPageToken, 2048) || null,
        resultSizeEstimate: Number.isInteger(payload?.resultSizeEstimate)
          ? payload.resultSizeEstimate
          : details.length,
      };
    },

    async getMessage(messageId) {
      const message = await getMessageResource(messageId, "full");
      return {
        ...mapMessage(message),
        body: await extractMessageBody(messageId, message.payload, getAttachmentData),
      };
    },
  };
}

function mapMessage(message) {
  if (!message || typeof message !== "object" || typeof message.id !== "string") {
    throw gmailError("gmail_invalid_response", "Gmail returned an invalid message.");
  }
  const headers = new Map(
    (Array.isArray(message.payload?.headers) ? message.payload.headers : [])
      .filter((header) => typeof header?.name === "string" && typeof header?.value === "string")
      .map((header) => [header.name.toLowerCase(), header.value]),
  );
  return {
    id: message.id,
    threadId: boundedString(message.threadId, 1024),
    from: boundedString(headers.get("from"), 2000),
    to: boundedString(headers.get("to"), 2000),
    cc: boundedString(headers.get("cc"), 2000),
    subject: boundedString(headers.get("subject"), 2000),
    date: boundedString(headers.get("date"), 500),
    snippet: boundedString(message.snippet, MAX_SNIPPET_LENGTH),
    labelIds: Array.isArray(message.labelIds)
      ? message.labelIds.filter((label) => typeof label === "string").slice(0, 50)
      : [],
  };
}

async function extractMessageBody(messageId, payload, getAttachmentData) {
  const plain = findMimePart(payload, "text/plain");
  const html = plain ? null : findMimePart(payload, "text/html");
  const part = plain || html;
  if (!part) return "";

  let data = typeof part.body?.data === "string" ? part.body.data : "";
  if (!data && typeof part.body?.attachmentId === "string" && part.body.attachmentId) {
    data = await getAttachmentData(messageId, part.body.attachmentId);
  }
  const decoded = decodeBase64Url(data);
  return boundedString(plain ? decoded : htmlToText(decoded), MAX_BODY_LENGTH);
}

function findMimePart(part, mimeType) {
  if (!part || typeof part !== "object") return null;
  if (part.mimeType === mimeType && part.body && typeof part.body === "object") {
    return part;
  }
  for (const child of Array.isArray(part.parts) ? part.parts : []) {
    const match = findMimePart(child, mimeType);
    if (match) return match;
  }
  return null;
}

function decodeBase64Url(value) {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function htmlToText(value) {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function boundedString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function mapGmailError(status) {
  if (status === 401) {
    return gmailError(
      "integration_not_connected",
      "Google authorization expired or was revoked. Reconnect in Settings.",
    );
  }
  if (status === 403) {
    return gmailError(
      "gmail_permission_denied",
      "Google denied Gmail access. Reconnect in Settings and approve Gmail read access.",
    );
  }
  if (status === 404) {
    return gmailError("gmail_message_not_found", "That Gmail message was not found.");
  }
  if (status === 429) {
    return gmailError("gmail_rate_limited", "Gmail is busy. Try again shortly.");
  }
  if (status >= 500) {
    return gmailError("gmail_service_unavailable", "Gmail is temporarily unavailable.");
  }
  return gmailError("gmail_request_failed", "Gmail could not complete the request.");
}

function gmailError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
