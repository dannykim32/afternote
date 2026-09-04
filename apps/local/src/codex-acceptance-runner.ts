import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requireCodexRecallAcceptanceReport,
  type CodexRecallAcceptanceInput,
  type CodexRecallAcceptanceReport,
  type TimestampedAcceptanceLine,
} from "./codex-acceptance-report";
import type { CodexMcpReadiness } from "./codex-mcp-readiness";

const TRACE_PREFIX = "AFTERNOTE_ACCEPTANCE_TRACE ";
export const ACCEPTANCE_TRACE_PATH_ENV = "AFTERNOTE_ACCEPTANCE_TRACE_PATH";
export const DEFAULT_CODEX_RECALL_RUNNER_DEADLINE_MS = 60_000;
const DEFAULT_OUTPUT_LIMITS = {
  cumulativeBytes: 8 * 1_048_576,
  lineBytes: 1_048_576,
  acceptedLines: 10_000,
} as const;
const TERMINATE_SIGNAL = 15;
const KILL_SIGNAL = 9;

type CodexAcceptanceStream = "stdout" | "stderr" | "trace";
type CodexAcceptanceOutputLimit = "cumulative_bytes" | "line_bytes" | "accepted_lines";
type CodexAcceptanceOutputLimits = {
  cumulativeBytes: number;
  lineBytes: number;
  acceptedLines: number;
};

export class CodexAcceptanceRunnerError extends Error {
  readonly name = "CodexAcceptanceRunnerError";

  constructor(
    readonly code: "deadline_exceeded" | "output_limit_exceeded" | "stream_failed",
    readonly stream: CodexAcceptanceStream | null,
    readonly limit: CodexAcceptanceOutputLimit | null,
    message?: string,
  ) {
    super(message ?? (code === "stream_failed"
      ? `Codex Recall acceptance ${stream} stream failed`
      : `Codex Recall acceptance ${stream} exceeded its ${limit} limit`));
  }
}

export type CodexAcceptanceChildProcess = {
  pid?: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number): void;
};

export type CodexAcceptanceTraceChannel = {
  path: string;
  stream: ReadableStream<Uint8Array>;
  finish(): void;
  cleanup(): void;
};

export type CodexAcceptanceRunnerOptions = {
  codexCommand: string;
  prompt: string;
  readiness: CodexMcpReadiness;
  cwd?: string;
  env?: Record<string, string | undefined>;
  deadlineMs?: number;
  budgets?: CodexRecallAcceptanceInput["budgets"];
};

export type CodexAcceptanceRunnerDependencies = {
  clock?: () => number;
  scheduleDeadline?: (callback: () => void, milliseconds: number) => unknown;
  clearDeadline?: (handle: unknown) => void;
  cleanupGraceMs?: number;
  outputLimits?: CodexAcceptanceOutputLimits;
  createTraceChannel?: () => CodexAcceptanceTraceChannel;
  terminateProcessGroup?: (pid: number, signal: 9 | 15) => void;
  spawn?: (
    command: string[],
    options: {
      cwd: string;
      detached: true;
      env: Record<string, string | undefined>;
      stdin: "ignore";
      stdout: "pipe";
      stderr: "pipe";
    },
  ) => CodexAcceptanceChildProcess;
};

export async function runCodexRecallAcceptance(
  options: CodexAcceptanceRunnerOptions,
  dependencies: CodexAcceptanceRunnerDependencies = {},
): Promise<Extract<CodexRecallAcceptanceReport, { accepted: true }>> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_CODEX_RECALL_RUNNER_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10 * 60_000) {
    throw new Error("Codex Recall acceptance deadline must be between 1 and 600000 milliseconds");
  }
  if (options.prompt.trim().length === 0) {
    throw new Error("Codex Recall acceptance prompt must not be empty");
  }

  const clock = dependencies.clock ?? (() => performance.now());
  const spawn = dependencies.spawn ?? spawnCodex;
  const scheduleDeadline = dependencies.scheduleDeadline ??
    ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearDeadline = dependencies.clearDeadline ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const outputLimits = dependencies.outputLimits ?? DEFAULT_OUTPUT_LIMITS;
  assertOutputLimits(outputLimits);
  const cleanupGraceMs = dependencies.cleanupGraceMs ?? 250;
  if (!Number.isInteger(cleanupGraceMs) || cleanupGraceMs < 1 || cleanupGraceMs > 10_000) {
    throw new Error("Codex Recall acceptance cleanup grace must be between 1 and 10000 milliseconds");
  }
  const traceChannel = (dependencies.createTraceChannel ??
    createPrivateAcceptanceTraceChannel)();
  try {
    const child = spawn([
      options.codexCommand,
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--",
      options.prompt,
    ], {
      cwd: options.cwd ?? process.cwd(),
      detached: true,
      env: {
        ...(options.env ?? process.env),
        [ACCEPTANCE_TRACE_PATH_ENV]: traceChannel.path,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const abortOutput = new AbortController();
    const codex: TimestampedAcceptanceLine[] = [];
    const trace: TimestampedAcceptanceLine[] = [];
    const stdout = captureLines(
      "stdout",
      child.stdout,
      clock,
      outputLimits,
      abortOutput.signal,
      (line) => {
        codex.push(line);
      },
    );
    const stderr = captureLines(
      "stderr",
      child.stderr,
      clock,
      outputLimits,
      abortOutput.signal,
      () => {},
    );
    const traceOutput = captureLines(
      "trace",
      traceChannel.stream,
      clock,
      outputLimits,
      abortOutput.signal,
      (line) => {
        if (line.line.startsWith(TRACE_PREFIX)) trace.push(line);
      },
    );
    const exited = child.exited.finally(() => traceChannel.finish());
    let deadline: unknown;

    const completed = Promise.all([exited, stdout, stderr, traceOutput]);
    const terminal = completed.then(
      ([exitCode]) => ({ kind: "completed" as const, exitCode }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    let outcome:
      | { kind: "completed"; exitCode: number }
      | { kind: "failed"; error: unknown }
      | { kind: "timed_out" };
    try {
      outcome = await Promise.race([
        terminal,
        new Promise<{ kind: "timed_out" }>((resolve) => {
          deadline = scheduleDeadline(() => resolve({ kind: "timed_out" }), deadlineMs);
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearDeadline(deadline);
    }

    if (outcome.kind === "timed_out") {
      await cleanupChild(child, abortOutput, cleanupGraceMs, dependencies);
      throw new CodexAcceptanceRunnerError(
        "deadline_exceeded",
        null,
        null,
        `Codex Recall acceptance timed out after ${deadlineMs} milliseconds`,
      );
    }
    if (outcome.kind === "failed") {
      await cleanupChild(child, abortOutput, cleanupGraceMs, dependencies);
      throw outcome.error;
    }
    if (outcome.exitCode !== 0) {
      throw new Error(`Codex Recall acceptance host exited with code ${outcome.exitCode}`);
    }

    return requireCodexRecallAcceptanceReport({
      readiness: options.readiness,
      codex,
      trace,
      ...(options.budgets ? { budgets: options.budgets } : {}),
    });
  } finally {
    traceChannel.cleanup();
  }
}

function createPrivateAcceptanceTraceChannel(): CodexAcceptanceTraceChannel {
  const directory = mkdtempSync(join(tmpdir(), "afternote-codex-acceptance-"));
  const path = join(directory, "trace.jsonl");
  const descriptor = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const stop = (error?: unknown): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    closeSync(descriptor);
    if (error === undefined) controller.close();
    else controller.error(error);
  };
  const drain = (): void => {
    if (stopped) return;
    try {
      while (true) {
        const bytes = readSync(descriptor, buffer, 0, buffer.byteLength, null);
        if (bytes === 0) break;
        controller.enqueue(Uint8Array.from(buffer.subarray(0, bytes)));
      }
    } catch (error) {
      stop(error);
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      timer = setInterval(drain, 5);
    },
    cancel() {
      stop();
    },
  });

  return {
    path,
    stream,
    finish() {
      drain();
      stop();
    },
    cleanup() {
      stop();
      rmSync(path, { force: true });
      try {
        rmdirSync(directory);
      } catch {
        // Never recursively remove a directory if another entry appeared in it.
      }
    },
  };
}

function spawnCodex(
  command: string[],
  options: {
    cwd: string;
    detached: true;
    env: Record<string, string | undefined>;
    stdin: "ignore";
    stdout: "pipe";
    stderr: "pipe";
  },
): CodexAcceptanceChildProcess {
  // Bun creates a new POSIX process group for a detached child. Cleanup can
  // therefore terminate Codex and descendants without signaling this runner.
  return Bun.spawn(command, options) as unknown as CodexAcceptanceChildProcess;
}

async function captureLines(
  streamName: CodexAcceptanceStream,
  stream: ReadableStream<Uint8Array>,
  clock: () => number,
  limits: CodexAcceptanceOutputLimits,
  signal: AbortSignal,
  receive: (line: TimestampedAcceptanceLine) => void,
): Promise<void> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffered = "";
  let cumulativeBytes = 0;
  let currentLineBytes = 0;
  let acceptedLines = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      cumulativeBytes += next.value.byteLength;
      if (cumulativeBytes > limits.cumulativeBytes) {
        throw new CodexAcceptanceRunnerError(
          "output_limit_exceeded",
          streamName,
          "cumulative_bytes",
        );
      }
      for (const byte of next.value) {
        if (byte === 0x0a) {
          currentLineBytes = 0;
        } else {
          currentLineBytes += 1;
          if (currentLineBytes > limits.lineBytes) {
            throw new CodexAcceptanceRunnerError(
              "output_limit_exceeded",
              streamName,
              "line_bytes",
            );
          }
        }
      }
      buffered += decoder.decode(next.value, { stream: true });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          acceptedLines += 1;
          if (acceptedLines > limits.acceptedLines) {
            throw new CodexAcceptanceRunnerError(
              "output_limit_exceeded",
              streamName,
              "accepted_lines",
            );
          }
          receive({ timestampMs: clock(), line });
        }
      }
    }
    buffered += decoder.decode();
    const finalLine = buffered.replace(/\r$/u, "");
    if (finalLine.length > 0) {
      acceptedLines += 1;
      if (acceptedLines > limits.acceptedLines) {
        throw new CodexAcceptanceRunnerError(
          "output_limit_exceeded",
          streamName,
          "accepted_lines",
        );
      }
      receive({ timestampMs: clock(), line: finalLine });
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof CodexAcceptanceRunnerError) throw error;
    throw new CodexAcceptanceRunnerError("stream_failed", streamName, null);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function cleanupChild(
  child: CodexAcceptanceChildProcess,
  abortOutput: AbortController,
  graceMs: number,
  dependencies: CodexAcceptanceRunnerDependencies,
): Promise<void> {
  abortOutput.abort();
  const target = signalChild(child, TERMINATE_SIGNAL, dependencies);
  if (target === "group") {
    await waitFor(graceMs);
    signalChild(child, KILL_SIGNAL, dependencies);
    await settlesWithin(child.exited, graceMs);
    return;
  }
  if (await settlesWithin(child.exited, graceMs)) return;
  signalChild(child, KILL_SIGNAL, dependencies);
  await settlesWithin(child.exited, graceMs);
}

function signalChild(
  child: CodexAcceptanceChildProcess,
  signal: 9 | 15,
  dependencies: CodexAcceptanceRunnerDependencies,
): "group" | "child" {
  if (
    (dependencies.spawn === undefined || dependencies.terminateProcessGroup !== undefined) &&
    typeof child.pid === "number" &&
    Number.isInteger(child.pid) &&
    child.pid > 1 &&
    child.pid !== process.pid
  ) {
    try {
      const terminateGroup = dependencies.terminateProcessGroup ?? terminateProcessGroup;
      terminateGroup(child.pid, signal);
      return "group";
    } catch {
      // If group signaling races a child exit, the direct signal below is still bounded.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the settlement check and the signal.
  }
  return "child";
}

function terminateProcessGroup(pid: number, signal: 9 | 15): void {
  process.kill(-pid, signal);
}

async function waitFor(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function settlesWithin(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertOutputLimits(limits: CodexAcceptanceOutputLimits): void {
  if (
    !Number.isInteger(limits.cumulativeBytes) || limits.cumulativeBytes < 1 ||
    !Number.isInteger(limits.lineBytes) || limits.lineBytes < 1 ||
    limits.lineBytes > limits.cumulativeBytes ||
    !Number.isInteger(limits.acceptedLines) || limits.acceptedLines < 1
  ) {
    throw new Error("Codex Recall acceptance output limits are invalid");
  }
}
