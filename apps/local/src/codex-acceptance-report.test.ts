import { describe, expect, it } from "bun:test";
import {
  buildCodexRecallAcceptanceReport,
  DEFAULT_CODEX_RECALL_LATENCY_BUDGETS,
  requireCodexRecallAcceptanceReport,
  type TimestampedAcceptanceLine,
} from "./codex-acceptance-report";

const NOTE_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_NOTE_ID = "223e4567-e89b-42d3-a456-426614174001";

describe("Codex Recall acceptance report", () => {
  it("reports startup, activation, retrieval, synthesis, and total independently", () => {
    const report = buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex: successfulCodexLines(),
      trace: successfulTraceLines(),
    });

    expect(report).toEqual({
      accepted: true,
      citations: [{ noteId: NOTE_ID, revision: 2 }],
      latency: {
        startupMs: 40,
        activationMs: 5,
        retrievalMs: 30,
        synthesisMs: 30,
        totalMs: 140,
      },
    });
  });

  it("includes stale-session reactivation attempts in activation and retrieval time", () => {
    const trace = successfulTraceLines();
    trace.splice(1, 0,
      acceptanceLine(145, {
        kind: "mcp-broker-operation",
        operation: "recall",
        attempt: 1,
        reactivation: false,
        outcome: "stale_session",
        durationMs: 7,
      }),
      acceptanceLine(150, {
        kind: "mcp-broker-activation",
        operation: "recall",
        attempt: 2,
        reactivation: true,
        outcome: "succeeded",
        durationMs: 4,
      }),
    );
    trace[3] = acceptanceLine(165, {
      kind: "mcp-broker-operation",
      operation: "recall",
      attempt: 2,
      reactivation: true,
      outcome: "succeeded",
      durationMs: 19,
    });

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex: successfulCodexLines(),
      trace,
    })).toMatchObject({
      accepted: true,
      latency: { activationMs: 9, retrievalMs: 26 },
    });
  });

  it("accepts a single Recall trace read after the stdout completion event", () => {
    const trace = successfulTraceLines().map((line, index) => ({
      ...line,
      timestampMs: 210 + index * 10,
    }));

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex: successfulCodexLines(),
      trace,
    })).toEqual({
      accepted: true,
      citations: [{ noteId: NOTE_ID, revision: 2 }],
      latency: {
        startupMs: 40,
        activationMs: 5,
        retrievalMs: 30,
        synthesisMs: 30,
        totalMs: 140,
      },
    });
  });

  it("fails with the shared evidence reason when the MCP citation is invalid", () => {
    const codex = successfulCodexLines();
    codex[2] = codexLine(170, successfulRecallEvent({
      note: { id: NOTE_ID, revision: 2 },
      citation: { noteId: NOTE_ID, revision: 1 },
    }));

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex,
      trace: successfulTraceLines(),
    })).toEqual({
      accepted: false,
      reason: "mismatched_recall_citation",
    });
  });

  it("fails closed when the broker timing trace is missing", () => {
    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex: successfulCodexLines(),
      trace: [],
    })).toEqual({
      accepted: false,
      reason: "missing_timing_evidence",
    });
  });

  it("rejects evidence and timing taken from different Recall item IDs", () => {
    const codex = successfulCodexLines();
    codex[2] = codexLine(170, successfulRecallEvent([], "recall-1"));
    codex.splice(3, 0, codexLine(180, successfulRecallEvent(undefined, "recall-2")));

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex,
      trace: successfulTraceLines(),
    })).toEqual({
      accepted: false,
      reason: "uncorrelated_recall_evidence",
    });
  });

  it("rejects multiple Afternote Recall item IDs in one acceptance run", () => {
    const codex = successfulCodexLines();
    codex.splice(3, 0,
      codexLine(175, {
        type: "item.started",
        item: {
          id: "recall-2",
          type: "mcp_tool_call",
          server: "afternote",
          tool: "recall",
          status: "in_progress",
        },
      }),
      codexLine(185, successfulRecallEvent(undefined, "recall-2")),
    );

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex,
      trace: successfulTraceLines(),
    })).toEqual({
      accepted: false,
      reason: "uncorrelated_recall_evidence",
    });
  });

  it("rejects a final answer that omits the accepted UUID and revision", () => {
    const codex = successfulCodexLines();
    codex[3] = codexLine(200, {
      type: "item.completed",
      item: { id: "answer-1", type: "agent_message", text: "Saved note cited." },
    });

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex,
      trace: successfulTraceLines(),
    })).toEqual({
      accepted: false,
      reason: "missing_answer_citation",
    });
  });

  it("rejects a final answer that swaps revisions between accepted UUIDs", () => {
    const codex = successfulCodexLines();
    codex[2] = codexLine(170, successfulRecallEvent([{
      note: { id: NOTE_ID, revision: 2 },
      citation: { noteId: NOTE_ID, revision: 2 },
    }, {
      note: { id: SECOND_NOTE_ID, revision: 3 },
      citation: { noteId: SECOND_NOTE_ID, revision: 3 },
    }]));
    codex[3] = codexLine(200, {
      type: "item.completed",
      item: {
        id: "answer-1",
        type: "agent_message",
        text: `${NOTE_ID}, revision 3. ${SECOND_NOTE_ID}, revision 2.`,
      },
    });

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex,
      trace: successfulTraceLines(),
    })).toEqual({
      accepted: false,
      reason: "missing_answer_citation",
    });
  });

  it("accepts multiple citations when each UUID is followed by its own revision", () => {
    const codex = successfulCodexLines();
    codex[2] = codexLine(170, successfulRecallEvent([{
      note: { id: NOTE_ID, revision: 2 },
      citation: { noteId: NOTE_ID, revision: 2 },
    }, {
      note: { id: SECOND_NOTE_ID, revision: 3 },
      citation: { noteId: SECOND_NOTE_ID, revision: 3 },
    }]));
    codex[3] = codexLine(200, {
      type: "item.completed",
      item: {
        id: "answer-1",
        type: "agent_message",
        text: `${NOTE_ID}, revision 2. ${SECOND_NOTE_ID}, rev. 3.`,
      },
    });

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex,
      trace: successfulTraceLines(),
    })).toMatchObject({
      accepted: true,
      citations: [
        { noteId: NOTE_ID, revision: 2 },
        { noteId: SECOND_NOTE_ID, revision: 3 },
      ],
    });
  });

  it("rejects unknown acceptance trace kinds", () => {
    const trace = successfulTraceLines();
    trace.unshift(acceptanceLine(135, {
      kind: "broker-request-error",
      code: "denied",
    }));

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex: successfulCodexLines(),
      trace,
    })).toEqual({
      accepted: false,
      reason: "invalid_timing_evidence",
    });
  });

  it("rejects note, query, excerpt, and error fields in timing traces", () => {
    for (const prohibitedField of ["noteId", "query", "excerpt", "error"]) {
      const trace = successfulTraceLines();
      trace[0] = acceptanceLine(140, {
        kind: "mcp-broker-activation",
        operation: "recall",
        attempt: 1,
        reactivation: false,
        outcome: "succeeded",
        durationMs: 5,
        [prohibitedField]: "private value",
      });

      expect(buildCodexRecallAcceptanceReport({
        readiness: healthyReadiness(40),
        codex: successfulCodexLines(),
        trace,
      })).toEqual({
        accepted: false,
        reason: "invalid_timing_evidence",
      });
    }
  });

  it("rejects Codex JSONL whose monotonic timestamps move backward", () => {
    const codex = successfulCodexLines();
    codex.push(codexLine(190, { type: "turn.completed" }));

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex,
      trace: successfulTraceLines(),
    })).toEqual({
      accepted: false,
      reason: "non_monotonic_codex_timestamps",
    });
  });

  it("rejects timing traces whose monotonic timestamps move backward", () => {
    const trace = successfulTraceLines();
    trace[0] = { ...trace[0], timestampMs: 166 };

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex: successfulCodexLines(),
      trace,
    })).toEqual({
      accepted: false,
      reason: "non_monotonic_trace_timestamps",
    });
  });

  it("fails when retrieval exceeds the explicit default latency budget", () => {
    const trace = successfulTraceLines();
    trace[1] = acceptanceLine(165, {
      kind: "mcp-broker-operation",
      operation: "recall",
      attempt: 1,
      reactivation: false,
      outcome: "succeeded",
      durationMs: DEFAULT_CODEX_RECALL_LATENCY_BUDGETS.retrievalMs + 1,
    });

    expect(buildCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex: successfulCodexLines(),
      trace,
    })).toEqual({
      accepted: false,
      reason: "retrieval_latency_budget_exceeded",
    });
  });

  it("turns a failed report into a deterministic runner error", () => {
    expect(() => requireCodexRecallAcceptanceReport({
      readiness: healthyReadiness(40),
      codex: successfulCodexLines(),
      trace: [acceptanceLine(140, {
        kind: "mcp-broker-operation",
        operation: "recall",
      })],
    })).toThrow("Codex Recall acceptance failed: invalid_timing_evidence");
  });
});

function healthyReadiness(startupMs: number) {
  return {
    healthy: true as const,
    state: "ready" as const,
    tools: ["get_note", "recall", "remember"],
    startupMs,
    error: null,
  };
}

function successfulCodexLines(): TimestampedAcceptanceLine[] {
  return [
    codexLine(100, { type: "thread.started", thread_id: "thread-1" }),
    codexLine(130, {
      type: "item.started",
      item: {
        id: "recall-1",
        type: "mcp_tool_call",
        server: "afternote",
        tool: "recall",
        status: "in_progress",
      },
    }),
    codexLine(170, successfulRecallEvent()),
    codexLine(200, {
      type: "item.completed",
      item: {
        id: "answer-1",
        type: "agent_message",
        text: `Saved note ${NOTE_ID}, revision 2.`,
      },
    }),
  ];
}

function successfulTraceLines(): TimestampedAcceptanceLine[] {
  return [
    acceptanceLine(140, {
      kind: "mcp-broker-activation",
      operation: "recall",
      attempt: 1,
      reactivation: false,
      outcome: "succeeded",
      durationMs: 5,
    }),
    acceptanceLine(165, {
      kind: "mcp-broker-operation",
      operation: "recall",
      attempt: 1,
      reactivation: false,
      outcome: "succeeded",
      durationMs: 30,
    }),
  ];
}

function successfulRecallEvent(
  result: unknown = {
    note: { id: NOTE_ID, revision: 2 },
    citation: { noteId: NOTE_ID, revision: 2 },
  },
  itemId = "recall-1",
): unknown {
  return {
    type: "item.completed",
    item: {
      id: itemId,
      type: "mcp_tool_call",
      server: "afternote",
      tool: "recall",
      status: "completed",
      result: { structured_content: { results: Array.isArray(result) ? result : [result] } },
    },
  };
}

function codexLine(timestampMs: number, event: unknown): TimestampedAcceptanceLine {
  return { timestampMs, line: JSON.stringify(event) };
}

function acceptanceLine(
  timestampMs: number,
  event: unknown,
): TimestampedAcceptanceLine {
  return {
    timestampMs,
    line: `AFTERNOTE_ACCEPTANCE_TRACE ${JSON.stringify(event)}`,
  };
}
