import { describe, expect, it } from "bun:test";
import { validateCodexRecallEvidence } from "./codex-acceptance";

const NOTE_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("Codex Recall acceptance evidence", () => {
  it("accepts a completed Afternote Recall event with a matching citation", () => {
    expect(validateCodexRecallEvidence([successfulRecallEvent()])).toEqual({
      accepted: true,
      recallItemId: "item-1",
      citations: [{ noteId: NOTE_ID, revision: 2 }],
    });
  });

  it("rejects final prose without a successful Afternote Recall event", () => {
    expect(validateCodexRecallEvidence([{
      type: "item.completed",
      item: {
        id: "item-2",
        type: "agent_message",
        text: `Your saved note was ${NOTE_ID}, revision 2.`,
      },
    }])).toEqual({
      accepted: false,
      reason: "no_successful_afternote_recall",
    });
  });

  it("rejects an MCP event for the wrong tool", () => {
    expect(validateCodexRecallEvidence([{
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "afternote",
        tool: "get_note",
        status: "completed",
      },
    }])).toEqual({
      accepted: false,
      reason: "unexpected_mcp_tool",
    });
  });

  it("rejects a Recall event from a different MCP server", () => {
    expect(validateCodexRecallEvidence([{
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "repository-search",
        tool: "recall",
        status: "completed",
      },
    }])).toEqual({
      accepted: false,
      reason: "unexpected_mcp_server",
    });
  });

  it("rejects a failed Afternote Recall event", () => {
    expect(validateCodexRecallEvidence([{
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "afternote",
        tool: "recall",
        status: "failed",
        error: { message: "Afternote vault is locked" },
      },
    }])).toEqual({
      accepted: false,
      reason: "afternote_recall_failed",
    });
  });

  it("rejects malformed citation evidence", () => {
    expect(validateCodexRecallEvidence([successfulRecallEvent({
      note: { id: "not-a-uuid", revision: 2 },
      citation: { noteId: "not-a-uuid", revision: 2 },
    })])).toEqual({
      accepted: false,
      reason: "invalid_recall_citation",
    });
  });

  it("rejects a citation for a different note revision", () => {
    expect(validateCodexRecallEvidence([successfulRecallEvent({
      note: { id: NOTE_ID, revision: 2 },
      citation: { noteId: NOTE_ID, revision: 1 },
    })])).toEqual({
      accepted: false,
      reason: "mismatched_recall_citation",
    });
  });

  it("rejects repository command fallback even when Recall later succeeds", () => {
    expect(validateCodexRecallEvidence([
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "rg fixture-sentinel apps/local",
          status: "completed",
        },
      },
      successfulRecallEvent(),
    ])).toEqual({
      accepted: false,
      reason: "repository_fallback_detected",
    });
  });

  it("rejects search fallback even when Recall later succeeds", () => {
    expect(validateCodexRecallEvidence([
      {
        type: "item.completed",
        item: {
          type: "web_search",
          query: "fixture sentinel repository",
        },
      },
      successfulRecallEvent(),
    ])).toEqual({
      accepted: false,
      reason: "repository_fallback_detected",
    });
  });

  it("rejects repository fallback after an earlier successful Recall", () => {
    expect(validateCodexRecallEvidence([
      successfulRecallEvent(),
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "rg TEST_FIXTURE_NOT_A_SAVED_NOTE apps/local",
          status: "completed",
        },
      },
    ])).toEqual({
      accepted: false,
      reason: "repository_fallback_detected",
    });
  });

  it("rejects a failed Recall after an earlier successful Recall", () => {
    expect(validateCodexRecallEvidence([
      successfulRecallEvent(),
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          server: "afternote",
          tool: "recall",
          status: "failed",
        },
      },
    ])).toEqual({
      accepted: false,
      reason: "afternote_recall_failed",
    });
  });
});

function successfulRecallEvent(
  recalledResult: unknown = {
    note: { id: NOTE_ID, revision: 2 },
    citation: { noteId: NOTE_ID, revision: 2 },
  },
): unknown {
  return {
    type: "item.completed",
    item: {
      id: "item-1",
      type: "mcp_tool_call",
      server: "afternote",
      tool: "recall",
      status: "completed",
      result: {
        content: [],
        structured_content: {
          results: [recalledResult],
        },
      },
    },
  };
}
