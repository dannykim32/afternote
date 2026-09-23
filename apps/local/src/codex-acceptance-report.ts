import {
  validateCodexRecallEvidence,
  type CodexRecallEvidenceFailureReason,
} from "./codex-acceptance";
import type { CodexMcpReadiness } from "./codex-mcp-readiness";
import type { McpBrokerAcceptanceTraceEvent } from "./mcp-broker-adapter";

const TRACE_PREFIX = "AFTERNOTE_ACCEPTANCE_TRACE ";
const ANSWER_UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const ANSWER_REVISION_PATTERN =
  /\b(?:revision|rev\.?)\s*[#:=-]?\s*([1-9][0-9]*)\b/i;
const MAX_ANSWER_CITATION_LABEL_DISTANCE = 32;

export const DEFAULT_CODEX_RECALL_LATENCY_BUDGETS = {
  startupMs: 10_000,
  activationMs: 20_000,
  retrievalMs: 5_000,
  synthesisMs: 30_000,
  totalMs: 60_000,
} as const;

export type CodexRecallLatency = {
  startupMs: number;
  activationMs: number;
  retrievalMs: number;
  synthesisMs: number;
  totalMs: number;
};

export type CodexRecallLatencyBudgets = Record<keyof CodexRecallLatency, number>;

export type TimestampedAcceptanceLine = {
  timestampMs: number;
  line: string;
};

export type CodexRecallAcceptanceFailureReason =
  | CodexRecallEvidenceFailureReason
  | "startup_not_ready"
  | "malformed_codex_jsonl"
  | "non_monotonic_codex_timestamps"
  | "malformed_acceptance_trace"
  | "non_monotonic_trace_timestamps"
  | "uncorrelated_recall_evidence"
  | "missing_answer_citation"
  | "missing_timing_evidence"
  | "invalid_timing_evidence"
  | "startup_latency_budget_exceeded"
  | "activation_latency_budget_exceeded"
  | "retrieval_latency_budget_exceeded"
  | "synthesis_latency_budget_exceeded"
  | "total_latency_budget_exceeded";

export type CodexRecallAcceptanceReport =
  | {
      accepted: true;
      citations: Array<{ noteId: string; revision: number }>;
      latency: CodexRecallLatency;
    }
  | {
      accepted: false;
      reason: CodexRecallAcceptanceFailureReason;
    };

export type CodexRecallAcceptanceInput = {
  readiness: CodexMcpReadiness;
  codex: readonly TimestampedAcceptanceLine[];
  trace: readonly TimestampedAcceptanceLine[];
  budgets?: CodexRecallLatencyBudgets;
};

export function buildCodexRecallAcceptanceReport(
  input: CodexRecallAcceptanceInput,
): CodexRecallAcceptanceReport {
  if (
    !input.readiness.healthy ||
    input.readiness.state !== "ready" ||
    !validDuration(input.readiness.startupMs)
  ) return { accepted: false, reason: "startup_not_ready" };

  const codex = parseCodexLines(input.codex);
  if (!codex.valid) return { accepted: false, reason: codex.reason };
  const evidence = validateCodexRecallEvidence(codex.events.map((event) => event.value));
  if (!evidence.accepted) return evidence;

  const trace = parseTraceLines(input.trace);
  if (!trace.valid) return { accepted: false, reason: trace.reason };
  const timing = findTimingWindow(
    codex.events,
    trace.events,
    evidence.recallItemId,
    evidence.citations,
  );
  if (!timing.valid) return { accepted: false, reason: timing.reason };

  const latency: CodexRecallLatency = {
    startupMs: input.readiness.startupMs,
    activationMs: sumDurations(timing.trace, "mcp-broker-activation"),
    retrievalMs: sumDurations(timing.trace, "mcp-broker-operation"),
    synthesisMs: timing.answerAt - timing.recallCompletedAt,
    totalMs: input.readiness.startupMs + timing.answerAt - timing.threadStartedAt,
  };
  const exceeded = exceededLatencyBudget(
    latency,
    input.budgets ?? DEFAULT_CODEX_RECALL_LATENCY_BUDGETS,
  );
  if (exceeded) return { accepted: false, reason: exceeded };
  return { accepted: true, citations: evidence.citations, latency };
}

export function requireCodexRecallAcceptanceReport(
  input: CodexRecallAcceptanceInput,
): Extract<CodexRecallAcceptanceReport, { accepted: true }> {
  const report = buildCodexRecallAcceptanceReport(input);
  if (!report.accepted) {
    throw new Error(`Codex Recall acceptance failed: ${report.reason}`);
  }
  return report;
}

type TimedValue<Value> = { timestampMs: number; value: Value };

function parseCodexLines(lines: readonly TimestampedAcceptanceLine[]):
  | { valid: true; events: Array<TimedValue<unknown>> }
  | {
      valid: false;
      reason: "malformed_codex_jsonl" | "non_monotonic_codex_timestamps";
    } {
  const events: Array<TimedValue<unknown>> = [];
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const item of lines) {
    if (!validTimestampedLine(item)) {
      return { valid: false, reason: "malformed_codex_jsonl" };
    }
    if (item.timestampMs < previousTimestamp) {
      return { valid: false, reason: "non_monotonic_codex_timestamps" };
    }
    previousTimestamp = item.timestampMs;
    try {
      const value: unknown = JSON.parse(item.line);
      if (!isRecord(value)) {
        return { valid: false, reason: "malformed_codex_jsonl" };
      }
      events.push({ timestampMs: item.timestampMs, value });
    } catch {
      return { valid: false, reason: "malformed_codex_jsonl" };
    }
  }
  return { valid: true, events };
}

function parseTraceLines(lines: readonly TimestampedAcceptanceLine[]):
  | { valid: true; events: Array<TimedValue<McpBrokerAcceptanceTraceEvent>> }
  | {
      valid: false;
      reason:
        | "malformed_acceptance_trace"
        | "non_monotonic_trace_timestamps"
        | "invalid_timing_evidence";
    } {
  const events: Array<TimedValue<McpBrokerAcceptanceTraceEvent>> = [];
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const item of lines) {
    if (!validTimestampedLine(item) || !item.line.startsWith(TRACE_PREFIX)) {
      return { valid: false, reason: "malformed_acceptance_trace" };
    }
    if (item.timestampMs < previousTimestamp) {
      return { valid: false, reason: "non_monotonic_trace_timestamps" };
    }
    previousTimestamp = item.timestampMs;
    let value: unknown;
    try {
      value = JSON.parse(item.line.slice(TRACE_PREFIX.length));
    } catch {
      return { valid: false, reason: "malformed_acceptance_trace" };
    }
    if (!isRecord(value)) {
      return { valid: false, reason: "malformed_acceptance_trace" };
    }
    if (value.kind !== "mcp-broker-activation" && value.kind !== "mcp-broker-operation") {
      return { valid: false, reason: "invalid_timing_evidence" };
    }
    if (!isBrokerTraceEvent(value)) {
      return { valid: false, reason: "invalid_timing_evidence" };
    }
    events.push({ timestampMs: item.timestampMs, value });
  }
  return { valid: true, events };
}

function findTimingWindow(
  codex: readonly TimedValue<unknown>[],
  trace: readonly TimedValue<McpBrokerAcceptanceTraceEvent>[],
  recallItemId: string,
  citations: readonly { noteId: string; revision: number }[],
):
  | {
      valid: true;
      threadStartedAt: number;
      recallCompletedAt: number;
      answerAt: number;
      trace: Array<TimedValue<McpBrokerAcceptanceTraceEvent>>;
    }
  | {
      valid: false;
      reason:
        | "missing_timing_evidence"
        | "invalid_timing_evidence"
        | "uncorrelated_recall_evidence"
        | "missing_answer_citation";
    } {
  const thread = codex.find((event) => field(event.value, "type") === "thread.started");
  const recallStarts = codex.filter((event) =>
    isRecallItemEvent(event.value, "item.started")
  );
  const recallCompletions = codex.filter((event) =>
    isRecallItemEvent(event.value, "item.completed")
  );
  if (recallStarts.length !== 1 || recallCompletions.length !== 1) {
    return { valid: false, reason: "uncorrelated_recall_evidence" };
  }
  const recallStarted = recallStarts[0]!;
  const recallCompleted = recallCompletions[0]!;
  if (
    field(field(recallStarted.value, "item"), "id") !== recallItemId ||
    field(field(recallCompleted.value, "item"), "id") !== recallItemId
  ) return { valid: false, reason: "uncorrelated_recall_evidence" };
  const answers = codex.filter((event) =>
    event.timestampMs >= recallCompleted.timestampMs &&
    field(event.value, "type") === "item.completed" &&
    field(field(event.value, "item"), "type") === "agent_message"
  );
  const answer = answers[answers.length - 1];
  if (!thread || !answer) {
    return { valid: false, reason: "missing_timing_evidence" };
  }
  const answerText = field(field(answer.value, "item"), "text");
  if (
    typeof answerText !== "string" ||
    !citations.every((citation) => answerPreservesCitation(answerText, citation))
  ) return { valid: false, reason: "missing_answer_citation" };
  if (
    thread.timestampMs > recallStarted.timestampMs ||
    recallStarted.timestampMs > recallCompleted.timestampMs ||
    recallCompleted.timestampMs > answer.timestampMs
  ) return { valid: false, reason: "invalid_timing_evidence" };

  if (trace.length === 0) {
    return { valid: false, reason: "missing_timing_evidence" };
  }
  if (
    trace.some((event) => event.value.operation !== "recall") ||
    !validRecallTraceSequence(trace.map((event) => event.value))
  ) {
    return { valid: false, reason: "invalid_timing_evidence" };
  }
  return {
    valid: true,
    threadStartedAt: thread.timestampMs,
    recallCompletedAt: recallCompleted.timestampMs,
    answerAt: answer.timestampMs,
    trace: [...trace],
  };
}

function validRecallTraceSequence(events: readonly McpBrokerAcceptanceTraceEvent[]): boolean {
  if (events.length !== 2 && events.length !== 4) return false;
  const [activation, operation, reactivation, retry] = events;
  if (
    activation.kind !== "mcp-broker-activation" ||
    activation.attempt !== 1 ||
    activation.reactivation ||
    activation.outcome !== "succeeded" ||
    operation.kind !== "mcp-broker-operation" ||
    operation.attempt !== 1 ||
    operation.reactivation
  ) return false;
  if (events.length === 2) return operation.outcome === "succeeded";
  return (
    operation.outcome === "stale_session" ||
    operation.outcome === "transport_restart"
  ) &&
    reactivation.kind === "mcp-broker-activation" &&
    reactivation.attempt === 2 &&
    reactivation.reactivation &&
    reactivation.outcome === "succeeded" &&
    retry.kind === "mcp-broker-operation" &&
    retry.attempt === 2 &&
    retry.reactivation &&
    retry.outcome === "succeeded";
}

function isRecallItemEvent(value: unknown, type: string): boolean {
  const item = field(value, "item");
  return field(value, "type") === type &&
    field(item, "type") === "mcp_tool_call" &&
    field(item, "server") === "afternote" &&
    field(item, "tool") === "recall";
}

function answerPreservesCitation(
  answer: string,
  citation: { noteId: string; revision: number },
): boolean {
  const normalizedAnswer = answer.toLowerCase();
  const normalizedNoteId = citation.noteId.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < normalizedAnswer.length) {
    const relativeIndex = normalizedAnswer.slice(searchFrom).indexOf(normalizedNoteId);
    if (relativeIndex < 0) return false;
    const citationEnd = searchFrom + relativeIndex + normalizedNoteId.length;
    const followingAnswer = answer.slice(citationEnd);
    const nextUuid = followingAnswer.search(ANSWER_UUID_PATTERN);
    const citationClause = followingAnswer.slice(
      0,
      nextUuid < 0 ? undefined : nextUuid,
    );
    const revision = citationClause.match(ANSWER_REVISION_PATTERN);
    if (
      revision?.index !== undefined &&
      revision.index <= MAX_ANSWER_CITATION_LABEL_DISTANCE &&
      Number(revision[1]) === citation.revision
    ) return true;
    searchFrom = citationEnd;
  }
  return false;
}

function isBrokerTraceEvent(value: Record<string, unknown>): value is McpBrokerAcceptanceTraceEvent {
  const allowedKeys = [
    "attempt",
    "durationMs",
    "kind",
    "operation",
    "outcome",
    "reactivation",
  ];
  return Object.keys(value).every((key) => allowedKeys.includes(key)) &&
    Object.keys(value).length === allowedKeys.length &&
    (value.kind === "mcp-broker-activation" || value.kind === "mcp-broker-operation") &&
    (["remember", "recall", "get_note", "archive_search", "archive_read"].includes(value.operation as string)) &&
    (value.attempt === 1 || value.attempt === 2) &&
    typeof value.reactivation === "boolean" &&
    (value.outcome === "succeeded" ||
      value.outcome === "failed" ||
      value.outcome === "stale_session" ||
      value.outcome === "transport_restart") &&
    validDuration(value.durationMs);
}

function sumDurations(
  events: readonly TimedValue<McpBrokerAcceptanceTraceEvent>[],
  kind: McpBrokerAcceptanceTraceEvent["kind"],
): number {
  return events.reduce((total, event) =>
    event.value.kind === kind ? total + event.value.durationMs : total, 0);
}

function exceededLatencyBudget(
  latency: CodexRecallLatency,
  budgets: CodexRecallLatencyBudgets,
): Extract<CodexRecallAcceptanceFailureReason, `${string}_latency_budget_exceeded`> | null {
  for (const metric of [
    "startupMs",
    "activationMs",
    "retrievalMs",
    "synthesisMs",
    "totalMs",
  ] as const) {
    if (!validDuration(budgets[metric]) || latency[metric] > budgets[metric]) {
      return `${metric.slice(0, -2)}_latency_budget_exceeded` as Extract<
        CodexRecallAcceptanceFailureReason,
        `${string}_latency_budget_exceeded`
      >;
    }
  }
  return null;
}

function validTimestampedLine(value: TimestampedAcceptanceLine): boolean {
  return validDuration(value.timestampMs) && typeof value.line === "string";
}

function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
