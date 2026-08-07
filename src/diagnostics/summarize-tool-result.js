/**
 * Bounded, non-sensitive summary of a tool result for the diagnostics log.
 *
 * Extracted from main.js so it is testable without loading Electron. Diagnostics
 * must stay small and free of user content: the point is to make a tool's
 * behavior auditable after the fact, not to mirror its payload.
 */

const maxMessageChars = 500;
const maxLoggedMatches = 3;
const maxTitleChars = 80;

export function summarizeToolResult(result) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const summary = {
    status: result.status,
    message:
      typeof result.message === "string" ? result.message.slice(0, maxMessageChars) : undefined,
    path: result.path,
    dimensions: result.dimensions,
    source: result.source,
    resultCount: result.resultCount,
    // Retrieval tools return a matches array. Log a bounded shape (count plus the
    // top few titles and scores, never passage text) so a silently empty or
    // low-relevance search is visible instead of collapsing to a bare status.
    matchCount: Array.isArray(result.matches) ? result.matches.length : undefined,
    topMatches: Array.isArray(result.matches)
      ? result.matches.slice(0, maxLoggedMatches).map((match) => ({
          title: typeof match?.title === "string" ? match.title.slice(0, maxTitleChars) : undefined,
          score: match?.score,
        }))
      : undefined,
  };
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}
