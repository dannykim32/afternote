export type CodexRecallEvidenceFailureReason =
  | "repository_fallback_detected"
  | "unexpected_mcp_server"
  | "unexpected_mcp_tool"
  | "afternote_recall_failed"
  | "invalid_recall_citation"
  | "mismatched_recall_citation"
  | "no_successful_afternote_recall";

export type CodexRecallEvidence =
  | {
      accepted: true;
      recallItemId: string;
      citations: Array<{ noteId: string; revision: number }>;
    }
  | {
      accepted: false;
      reason: CodexRecallEvidenceFailureReason;
    };

export function validateCodexRecallEvidence(
  events: readonly unknown[],
): CodexRecallEvidence {
  if (events.some(isRepositoryFallback)) {
    return { accepted: false, reason: "repository_fallback_detected" };
  }
  for (const event of events) {
    const reason = mcpViolationReason(event);
    if (reason) return { accepted: false, reason };
  }
  for (const event of events) {
    if (!isRecord(event) || !isRecord(event.item)) continue;
    const item = event.item;
    if (event.type !== "item.completed") continue;
    if (item.type !== "mcp_tool_call") continue;
    if (item.status !== "completed") continue;
    if (typeof item.id !== "string" || item.id.length === 0) continue;
    const result = item.result;
    const structured = isRecord(result) ? result.structured_content : undefined;
    const results = isRecord(structured) ? structured.results : undefined;
    if (!Array.isArray(results) || results.length === 0) continue;
    const checked = results.map(citationFromResult);
    const invalid = checked.find((result) => !result.valid);
    if (invalid && !invalid.valid) {
      return { accepted: false, reason: invalid.reason };
    }
    return {
      accepted: true,
      recallItemId: item.id,
      citations: checked.flatMap((result) =>
        result.valid ? [result.citation] : []
      ),
    };
  }
  return { accepted: false, reason: "no_successful_afternote_recall" };
}

function mcpViolationReason(
  event: unknown,
): CodexRecallEvidenceFailureReason | null {
  if (
    !isRecord(event) ||
    event.type !== "item.completed" ||
    !isRecord(event.item) ||
    event.item.type !== "mcp_tool_call"
  ) return null;
  if (event.item.server !== "afternote") return "unexpected_mcp_server";
  if (event.item.tool !== "recall") return "unexpected_mcp_tool";
  return event.item.status === "failed" ? "afternote_recall_failed" : null;
}

function isRepositoryFallback(event: unknown): boolean {
  return isRecord(event) && isRecord(event.item) &&
    (event.item.type === "command_execution" || event.item.type === "web_search");
}

function citationFromResult(
  result: unknown,
):
  | { valid: true; citation: { noteId: string; revision: number } }
  | { valid: false; reason: CodexRecallEvidenceFailureReason } {
  if (!isRecord(result) || !isRecord(result.note) || !isRecord(result.citation)) {
    return { valid: false, reason: "invalid_recall_citation" };
  }
  const noteId = result.note.id;
  const noteRevision = result.note.revision;
  if (
    typeof noteId !== "string" ||
    !isUuid(noteId) ||
    typeof noteRevision !== "number" ||
    !Number.isInteger(noteRevision) ||
    noteRevision < 1
  ) return { valid: false, reason: "invalid_recall_citation" };
  if (
    result.citation.noteId !== noteId ||
    result.citation.revision !== noteRevision
  ) return { valid: false, reason: "mismatched_recall_citation" };
  return {
    valid: true,
    citation: { noteId, revision: noteRevision },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}
