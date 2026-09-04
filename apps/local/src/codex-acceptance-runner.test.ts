import { describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, lstatSync } from "node:fs";
import {
  ACCEPTANCE_TRACE_PATH_ENV,
  runCodexRecallAcceptance,
  type CodexAcceptanceChildProcess,
  type CodexAcceptanceTraceChannel,
} from "./codex-acceptance-runner";

const NOTE_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("bounded Codex Recall acceptance runner", () => {
  it("captures Codex JSONL and its private timing channel on one monotonic clock", async () => {
    const child = controlledChild();
    const trace = controlledTraceChannel();
    const timestamps = [100, 130, 140, 165, 170, 200];
    const commands: string[][] = [];
    const running = runCodexRecallAcceptance({
      codexCommand: "/usr/local/bin/codex",
      prompt: "--dangerously-bypass-approvals-and-sandbox",
      readiness: healthyReadiness(40),
      cwd: "/tmp/acceptance-vault",
      deadlineMs: 1_000,
    }, {
      clock: () => timestamps.shift() ?? 999,
      createTraceChannel: () => trace.channel,
      spawn: (command, options) => {
        commands.push(command);
        expect(options.env[ACCEPTANCE_TRACE_PATH_ENV]).toBe(trace.channel.path);
        return child.process;
      },
    });

    await child.stdout.line({ type: "thread.started", thread_id: "thread-1" });
    await child.stdout.line({
      type: "item.started",
      item: recallItem("in_progress"),
    });
    await trace.output.line(acceptanceTrace({
      kind: "mcp-broker-activation",
      operation: "recall",
      attempt: 1,
      reactivation: false,
      outcome: "succeeded",
      durationMs: 5,
    }));
    await trace.output.line(acceptanceTrace({
      kind: "mcp-broker-operation",
      operation: "recall",
      attempt: 1,
      reactivation: false,
      outcome: "succeeded",
      durationMs: 30,
    }));
    await child.stdout.line({
      type: "item.completed",
      item: {
        ...recallItem("completed"),
        result: {
          structured_content: {
            results: [{
              note: { id: NOTE_ID, revision: 2 },
              citation: { noteId: NOTE_ID, revision: 2 },
            }],
          },
        },
      },
    });
    await child.stdout.line({
      type: "item.completed",
      item: {
        id: "answer-1",
        type: "agent_message",
        text: `Saved note ${NOTE_ID}, revision 2.`,
      },
    });
    child.complete(0);

    await expect(running).resolves.toEqual({
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
    expect(commands).toEqual([[
      "/usr/local/bin/codex",
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--",
      "--dangerously-bypass-approvals-and-sandbox",
    ]]);
    expect(child.kills).toEqual([]);
    expect(trace.isCleaned()).toBe(true);
  });

  it("forwards a fresh owner-private trace path and removes it after the run", async () => {
    const child = controlledChild();
    let tracePath = "";
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(20),
      deadlineMs: 1_000,
    }, {
      spawn: (_command, options) => {
        tracePath = options.env[ACCEPTANCE_TRACE_PATH_ENV] ?? "";
        return child.process;
      },
    });

    expect(tracePath).not.toBe("");
    const info = lstatSync(tracePath);
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o077).toBe(0);
    appendFileSync(tracePath, `${acceptanceTrace({
      kind: "mcp-broker-activation",
      operation: "recall",
      attempt: 1,
      reactivation: false,
      outcome: "succeeded",
      durationMs: 5,
    })}\n${acceptanceTrace({
      kind: "mcp-broker-operation",
      operation: "recall",
      attempt: 1,
      reactivation: false,
      outcome: "succeeded",
      durationMs: 30,
    })}\n`);
    await child.stdout.line({ type: "thread.started", thread_id: "thread-private-trace" });
    await child.stdout.line({
      type: "item.started",
      item: recallItem("in_progress"),
    });
    await child.stdout.line({
      type: "item.completed",
      item: {
        ...recallItem("completed"),
        result: {
          structured_content: {
            results: [{
              note: { id: NOTE_ID, revision: 2 },
              citation: { noteId: NOTE_ID, revision: 2 },
            }],
          },
        },
      },
    });
    await child.stdout.line({
      type: "item.completed",
      item: {
        id: "answer-private-trace",
        type: "agent_message",
        text: `${NOTE_ID} revision 2`,
      },
    });
    child.complete(0);

    await expect(running).resolves.toMatchObject({ accepted: true });
    expect(existsSync(tracePath)).toBe(false);
  });

  it("kills and reaps the child when the single wall-clock deadline expires", async () => {
    const child = controlledChild();
    let fireDeadline: (() => void) | undefined;
    let reaped = false;
    child.process.exited.then(() => {
      reaped = true;
    });
    child.process.kill = (signal) => {
      child.kills.push(signal);
      child.complete(137);
    };

    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 250,
    }, {
      spawn: () => child.process,
      scheduleDeadline(callback, milliseconds) {
        expect(milliseconds).toBe(250);
        fireDeadline = callback;
        return "deadline-1";
      },
      clearDeadline: () => {},
    });

    expect(fireDeadline).toBeDefined();
    fireDeadline?.();
    await expect(running).rejects.toThrow(
      "Codex Recall acceptance timed out after 250 milliseconds",
    );
    expect(child.kills).toEqual([15]);
    expect(reaped).toBe(true);
  });

  it("cancels retained output pipes after the child exits on deadline", async () => {
    const child = controlledChild();
    let fireDeadline: (() => void) | undefined;
    child.process.kill = (signal) => {
      child.kills.push(signal);
      child.exit(143);
    };
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 250,
    }, {
      spawn: () => child.process,
      cleanupGraceMs: 5,
      scheduleDeadline(callback) {
        fireDeadline = callback;
        return "deadline-retained-pipes";
      },
      clearDeadline: () => {},
    });

    fireDeadline?.();
    const observed = await Promise.race([
      running.catch((error: unknown) => error),
      Bun.sleep(40).then(() => "still-running" as const),
    ]);
    if (observed === "still-running") {
      child.stdout.close();
      child.stderr.close();
      await running.catch(() => {});
    }

    expect(observed).toMatchObject({
      name: "CodexAcceptanceRunnerError",
      code: "deadline_exceeded",
    });
    expect(child.kills).toEqual([15]);
    expect(child.stdout.isCancelled()).toBe(true);
    expect(child.stderr.isCancelled()).toBe(true);
  });

  it("returns after bounded TERM and KILL attempts when exit never resolves", async () => {
    const child = controlledChild();
    let fireDeadline: (() => void) | undefined;
    child.process.kill = (signal) => {
      child.kills.push(signal);
    };
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 250,
    }, {
      spawn: () => child.process,
      cleanupGraceMs: 5,
      scheduleDeadline(callback) {
        fireDeadline = callback;
        return "deadline-non-resolving-exit";
      },
      clearDeadline: () => {},
    });

    fireDeadline?.();
    const observed = await Promise.race([
      running.catch((error: unknown) => error),
      Bun.sleep(40).then(() => "still-running" as const),
    ]);
    if (observed === "still-running") {
      child.complete(137);
      await running.catch(() => {});
    }

    expect(observed).toMatchObject({
      name: "CodexAcceptanceRunnerError",
      code: "deadline_exceeded",
    });
    expect(child.kills).toEqual([15, 9]);
    expect(child.stdout.isCancelled()).toBe(true);
    expect(child.stderr.isCancelled()).toBe(true);
  });

  it("kills the detached group after TERM even when its leader already exited", async () => {
    const child = controlledChild();
    const groupSignals: Array<{ pid: number; signal: 9 | 15 }> = [];
    let descendantAlive = true;
    let fireDeadline: (() => void) | undefined;
    child.process.pid = 42_424;
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 250,
    }, {
      spawn: () => child.process,
      cleanupGraceMs: 5,
      terminateProcessGroup(pid, signal) {
        groupSignals.push({ pid, signal });
        if (signal === 15) child.exit(143);
        if (signal === 9) descendantAlive = false;
      },
      scheduleDeadline(callback) {
        fireDeadline = callback;
        return "deadline-process-group";
      },
      clearDeadline: () => {},
    });

    fireDeadline?.();
    await expect(running).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(groupSignals).toEqual([
      { pid: 42_424, signal: 15 },
      { pid: 42_424, signal: 9 },
    ]);
    expect(descendantAlive).toBe(false);
    expect(child.kills).toEqual([]);
  });

  it("never signals the runner's own process group", async () => {
    const child = controlledChild();
    const groupSignals: Array<{ pid: number; signal: 9 | 15 }> = [];
    let fireDeadline: (() => void) | undefined;
    child.process.pid = process.pid;
    child.process.kill = (signal) => {
      child.kills.push(signal);
      child.complete(143);
    };
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 250,
    }, {
      spawn: () => child.process,
      cleanupGraceMs: 5,
      terminateProcessGroup(pid, signal) {
        groupSignals.push({ pid, signal });
      },
      scheduleDeadline(callback) {
        fireDeadline = callback;
        return "deadline-parent-group";
      },
      clearDeadline: () => {},
    });

    fireDeadline?.();
    await expect(running).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(groupSignals).toEqual([]);
    expect(child.kills).toEqual([15]);
  });

  it("falls back to the direct child when group signaling is unavailable", async () => {
    const child = controlledChild();
    const groupSignals: Array<{ pid: number; signal: 9 | 15 }> = [];
    let fireDeadline: (() => void) | undefined;
    child.process.pid = 42_425;
    child.process.kill = (signal) => {
      child.kills.push(signal);
      child.complete(143);
    };
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 250,
    }, {
      spawn: () => child.process,
      cleanupGraceMs: 5,
      terminateProcessGroup(pid, signal) {
        groupSignals.push({ pid, signal });
        throw new Error("group is unavailable");
      },
      scheduleDeadline(callback) {
        fireDeadline = callback;
        return "deadline-group-fallback";
      },
      clearDeadline: () => {},
    });

    fireDeadline?.();
    await expect(running).rejects.toMatchObject({ code: "deadline_exceeded" });
    expect(groupSignals).toEqual([{ pid: 42_425, signal: 15 }]);
    expect(child.kills).toEqual([15]);
  });

  it("fails with a typed limit error on endless stdout without a newline", async () => {
    const child = controlledChild();
    child.process.kill = (signal) => {
      child.kills.push(signal);
      child.complete(143);
    };
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 1_000,
    }, {
      spawn: () => child.process,
      outputLimits: {
        cumulativeBytes: 128,
        lineBytes: 64,
        acceptedLines: 8,
      },
    });

    await child.stdout.bytes(new Uint8Array(65).fill(0x78));
    await Promise.resolve();

    await expect(running).rejects.toMatchObject({
      name: "CodexAcceptanceRunnerError",
      code: "output_limit_exceeded",
      stream: "stdout",
      limit: "line_bytes",
    });
    expect(child.kills).toEqual([15]);
    expect(child.stdout.isCancelled()).toBe(true);
    expect(child.stderr.isCancelled()).toBe(true);
  });

  it("caps cumulative stderr bytes independently of line length", async () => {
    const child = controlledChild();
    child.process.kill = (signal) => {
      child.kills.push(signal);
      child.complete(143);
    };
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
    }, {
      spawn: () => child.process,
      outputLimits: {
        cumulativeBytes: 16,
        lineBytes: 8,
        acceptedLines: 8,
      },
    });

    await child.stderr.bytes(new TextEncoder().encode("1234567\n1234567\nx"));

    await expect(running).rejects.toMatchObject({
      code: "output_limit_exceeded",
      stream: "stderr",
      limit: "cumulative_bytes",
    });
  });

  it("caps accepted stdout lines independently of the byte limits", async () => {
    const child = controlledChild();
    child.process.kill = (signal) => {
      child.kills.push(signal);
      child.complete(143);
    };
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
    }, {
      spawn: () => child.process,
      outputLimits: {
        cumulativeBytes: 64,
        lineBytes: 16,
        acceptedLines: 2,
      },
    });

    await child.stdout.line({});
    await child.stdout.line({});
    await child.stdout.line({});

    await expect(running).rejects.toMatchObject({
      code: "output_limit_exceeded",
      stream: "stdout",
      limit: "accepted_lines",
    });
  });

  it("clears the deadline and cleans up when either output reader rejects", async () => {
    const child = controlledChild();
    let cleared: unknown;
    child.process.kill = (signal) => {
      child.kills.push(signal);
      child.complete(143);
    };
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 1_000,
    }, {
      spawn: () => child.process,
      scheduleDeadline: () => "deadline-reader-failure",
      clearDeadline: (handle) => {
        cleared = handle;
      },
    });

    child.stderr.fail(new Error("injected stderr failure"));

    await expect(running).rejects.toMatchObject({
      name: "CodexAcceptanceRunnerError",
      code: "stream_failed",
      stream: "stderr",
      limit: null,
    });
    expect(cleared).toBe("deadline-reader-failure");
    expect(child.kills).toEqual([15]);
  });

  it("fails closed when a successful child produces no Recall evidence", async () => {
    const child = controlledChild();
    const running = runCodexRecallAcceptance({
      codexCommand: "codex",
      prompt: "Recall the acceptance note.",
      readiness: healthyReadiness(40),
      deadlineMs: 1_000,
    }, { spawn: () => child.process });

    child.complete(0);

    await expect(running).rejects.toThrow(
      "Codex Recall acceptance failed: no_successful_afternote_recall",
    );
    expect(child.kills).toEqual([]);
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

function recallItem(status: "in_progress" | "completed") {
  return {
    id: "recall-1",
    type: "mcp_tool_call",
    server: "afternote",
    tool: "recall",
    status,
  };
}

function acceptanceTrace(value: unknown): string {
  return `AFTERNOTE_ACCEPTANCE_TRACE ${JSON.stringify(value)}`;
}

function controlledTraceChannel(): {
  channel: CodexAcceptanceTraceChannel;
  output: ControlledStream;
  isCleaned(): boolean;
} {
  const output = controlledStream();
  let finished = false;
  let cleaned = false;
  return {
    channel: {
      path: "/private/tmp/afternote-test-acceptance-trace.jsonl",
      stream: output.stream,
      finish() {
        if (finished) return;
        finished = true;
        output.close();
      },
      cleanup() {
        cleaned = true;
        if (!finished) output.close();
      },
    },
    output,
    isCleaned: () => cleaned,
  };
}

function controlledChild(): {
  process: CodexAcceptanceChildProcess;
  stdout: ControlledStream;
  stderr: ControlledStream;
  kills: Array<number | undefined>;
  exit(exitCode: number): void;
  complete(exitCode: number): void;
} {
  const stdout = controlledStream();
  const stderr = controlledStream();
  const kills: Array<number | undefined> = [];
  let resolveExit: (exitCode: number) => void = () => {};
  let completed = false;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    process: {
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited,
      kill(signal) {
        kills.push(signal);
      },
    },
    stdout,
    stderr,
    kills,
    exit(exitCode) {
      if (completed) return;
      completed = true;
      resolveExit(exitCode);
    },
    complete(exitCode) {
      if (completed) return;
      completed = true;
      stdout.close();
      stderr.close();
      resolveExit(exitCode);
    },
  };
}

type ControlledStream = {
  stream: ReadableStream<Uint8Array>;
  bytes(value: Uint8Array): Promise<void>;
  line(value: unknown): Promise<void>;
  fail(error: Error): void;
  isCancelled(): boolean;
  close(): void;
};

function controlledStream(): ControlledStream {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
      closed = true;
    },
  });
  return {
    stream,
    async bytes(value) {
      controller.enqueue(value);
      await Promise.resolve();
      await Promise.resolve();
    },
    async line(value) {
      const line = typeof value === "string" ? value : JSON.stringify(value);
      controller.enqueue(new TextEncoder().encode(`${line}\n`));
      await Promise.resolve();
      await Promise.resolve();
    },
    fail(error) {
      if (closed) return;
      closed = true;
      controller.error(error);
    },
    isCancelled() {
      return cancelled;
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
}
