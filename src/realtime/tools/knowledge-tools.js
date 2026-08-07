import { searchKnowledgeBase } from "../../integrations/noledge/noledge-client.js";

// Indexed chunks run to roughly 1,500 characters. Cap above that so a whole
// passage arrives intact -- truncating mid-sentence makes it impossible to
// quote a definition or clause word for word.
const maxChunkChars = 2000;

export async function executeKnowledgeTool(name, args = {}, options = {}) {
  if (name !== "knowledge_search") {
    return null;
  }

  const result = await searchKnowledgeBase({
    baseUrl: options.baseUrl,
    query: args?.query,
    topK: args?.topK,
    spaceId: args?.spaceId,
  });

  // The knowledge base is an optional source, not a dependency. On any failure
  // return a non-fatal "unavailable" result telling the model to carry on with
  // its own memory and the web rather than stalling the turn.
  if (!result.ok) {
    return {
      status: "unavailable",
      code: result.code,
      message: result.message,
      guidance:
        "The knowledge base is optional. Answer from your memory or other tools, and say you could not check his saved documents.",
    };
  }

  if (result.mode === "semantic") {
    if (result.chunks.length === 0) {
      return {
        status: "ok",
        query: result.query,
        matches: [],
        message:
          "No passages matched that phrasing. Retry once with a shorter, barer keyword before giving up or using the web.",
      };
    }
    return {
      status: "ok",
      query: result.query,
      matches: result.chunks.map((chunk) => ({
        title: typeof chunk.documentTitle === "string" ? chunk.documentTitle : "Untitled",
        content: typeof chunk.content === "string" ? chunk.content.slice(0, maxChunkChars) : "",
        truncated: typeof chunk.content === "string" && chunk.content.length > maxChunkChars,
        score: typeof chunk.score === "number" ? Number(chunk.score.toFixed(3)) : undefined,
      })),
      note: "These passages are exact stored text from Greg's documents. Answer from them and quote verbatim for legal or contractual wording, naming the document title. Do not claim the knowledge base lacks this material, and do not switch to the web when a passage already answers the question.",
    };
  }

  // Fallback shape: substring title matching, no passage text available.
  if (result.documents.length === 0) {
    return {
      status: "ok",
      query: result.query,
      matches: [],
      message:
        "No saved document titles matched that exact phrase. This fallback search only matches exact wording, so do not tell Greg he has nothing saved; try a shorter single keyword or answer from memory.",
    };
  }

  return {
    status: "ok",
    query: result.query,
    totalMatches: result.total,
    matches: result.documents.map((document) => ({
      title: typeof document.title === "string" ? document.title : "Untitled",
      sourceUrl: typeof document.sourceUrl === "string" ? document.sourceUrl : undefined,
    })),
    note: "These are document titles only, not their text. Offer to open one if Greg wants detail.",
  };
}
