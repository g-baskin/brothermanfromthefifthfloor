/**
 * HTTP client for the local noledge RAG service.
 *
 * The service is a separate long-running app the user starts themselves; Brah
 * only queries it. Every failure is reported as a structured result rather than
 * a thrown error so the realtime tool can tell the model "your knowledge base is
 * offline" instead of dying mid-turn.
 */

export const defaultRagBaseUrl = "http://127.0.0.1:3009";

/** Sentinel the service uses to search across every space, not just the default one. */
const allSpacesId = "all-spaces";

// Deliberately short: this runs inside a live voice turn, where a long stall is
// worse than no answer. The model is told to carry on without the knowledge base.
// Measured semantic search is ~1-3s warm and ~3-6s on a cold embedder, so this
// tolerates a cold start while still bounding a live voice turn.
const requestTimeoutMs = 6_000;
const maxQueryLength = 1000;
// The corpus is 60k+ documents, so a narrow top-5 often misses the passage that
// actually answers the question. Kept in sync with the tool schema's default.
const defaultTopK = 8;
const maxTopK = 20;

/**
 * Normalize a user-entered base URL. Returns `{ ok: false }` for anything that
 * is not a plain http(s) origin so a typo in settings surfaces immediately.
 */
export function parseRagBaseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return { ok: false, message: "Knowledge base URL is empty." };
  }
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, message: "Knowledge base URL is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "Knowledge base URL must start with http:// or https://." };
  }
  // Keep only the origin; the client owns the path it appends.
  return { ok: true, value: url.origin };
}

function clampTopK(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return defaultTopK;
  }
  return Math.min(Math.max(parsed, 1), maxTopK);
}

/**
 * Query the knowledge base and return scored chunks.
 *
 * @returns {Promise<{ ok: true, query: string, chunks: Array<object> } | { ok: false, code: string, message: string }>}
 */
export async function searchKnowledgeBase({ baseUrl, query, topK, spaceId, fetchImpl = fetch }) {
  const origin = parseRagBaseUrl(baseUrl);
  if (!origin.ok) {
    return { ok: false, code: "invalid_base_url", message: origin.message };
  }

  const trimmedQuery = typeof query === "string" ? query.trim() : "";
  if (trimmedQuery.length === 0) {
    return { ok: false, code: "invalid_query", message: "query must be a non-empty string." };
  }
  if (trimmedQuery.length > maxQueryLength) {
    return {
      ok: false,
      code: "invalid_query",
      message: `query must be ${maxQueryLength} characters or fewer.`,
    };
  }

  const limit = clampTopK(topK);
  const space =
    typeof spaceId === "string" && spaceId.trim().length > 0 ? spaceId.trim() : allSpacesId;

  // Preferred path: semantic retrieval returning scored passages.
  const searchUrl = new URL("/api/search", origin.value);
  searchUrl.searchParams.set("q", trimmedQuery);
  searchUrl.searchParams.set("topK", String(limit));
  searchUrl.searchParams.set("spaceId", space);

  const searchResult = await requestJson(searchUrl, fetchImpl, origin.value);

  // A 404 means this service predates /api/search. Fall back to the document
  // listing, which only substring-matches and returns titles without passages.
  if (searchResult.ok) {
    return {
      ok: true,
      query: trimmedQuery,
      mode: "semantic",
      chunks: Array.isArray(searchResult.payload?.chunks) ? searchResult.payload.chunks : [],
    };
  }
  if (searchResult.code !== "not_found") {
    return { ok: false, code: searchResult.code, message: searchResult.message };
  }

  const url = new URL("/api/documents", origin.value);
  url.searchParams.set("q", trimmedQuery);
  url.searchParams.set("limit", String(limit));
  // Without an explicit space the service scopes to the default space only.
  url.searchParams.set("spaceId", space);

  const listing = await requestJson(url, fetchImpl, origin.value);
  if (!listing.ok) {
    return { ok: false, code: listing.code, message: listing.message };
  }

  return {
    ok: true,
    query: trimmedQuery,
    mode: "titles",
    documents: Array.isArray(listing.payload?.documents) ? listing.payload.documents : [],
    total: typeof listing.payload?.total === "number" ? listing.payload.total : undefined,
  };
}

/** Shared GET + JSON decode with a bounded timeout and normalized failures. */
async function requestJson(url, fetchImpl, origin) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, code: "timeout", message: "The knowledge base did not respond in time." };
    }
    return {
      ok: false,
      code: "unreachable",
      message: `The knowledge base is not reachable at ${origin}. Is it running?`,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    return { ok: false, code: "not_found", message: "Endpoint not found." };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      code: "bad_response",
      message: "The knowledge base returned a response that was not JSON.",
    };
  }

  if (!response.ok) {
    const message =
      payload && typeof payload.error === "string"
        ? payload.error
        : `The knowledge base returned HTTP ${response.status}.`;
    return { ok: false, code: "http_error", message };
  }

  return { ok: true, payload };
}

/**
 * Cheap liveness probe used by the settings screen. Lists a single document
 * rather than searching, so it succeeds even on an empty knowledge base.
 */
export async function checkKnowledgeBase({ baseUrl, fetchImpl = fetch }) {
  const origin = parseRagBaseUrl(baseUrl);
  if (!origin.ok) {
    return { ok: false, code: "invalid_base_url", message: origin.message };
  }

  const url = new URL("/api/documents", origin.value);
  url.searchParams.set("limit", "1");
  url.searchParams.set("spaceId", allSpacesId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        code: "http_error",
        message: `The knowledge base returned HTTP ${response.status}.`,
      };
    }
    const payload = await response.json();
    const total = typeof payload?.total === "number" ? payload.total : undefined;
    return {
      ok: true,
      total,
      message: total === undefined ? "Connected." : `Connected. ${total} documents indexed.`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, code: "timeout", message: "The knowledge base did not respond in time." };
    }
    return {
      ok: false,
      code: "unreachable",
      message: `The knowledge base is not reachable at ${origin.value}. Is it running?`,
    };
  } finally {
    clearTimeout(timeout);
  }
}
