import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { probeCodexMcpReadiness } from "./codex-mcp-readiness";

describe("Codex-owned MCP readiness", () => {
  it("initializes an ephemeral Codex thread and discovers the exact Afternote tools", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    const logPath = join(directory, "requests.log");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: logPath,
          AFTERNOTE_TEST_CODEX_MODE: "ready",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 1_000,
      });

      expect(result).toEqual({
        healthy: true,
        state: "ready",
        tools: ["get_note", "recall", "remember"],
        startupMs: expect.any(Number),
        error: null,
      });
      expect(result.startupMs).toBeGreaterThanOrEqual(0);
      expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "mcpServerStatus/list",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("follows MCP inventory pages until it discovers Afternote", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    const logPath = join(directory, "requests.log");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: logPath,
          AFTERNOTE_TEST_CODEX_MODE: "multipage",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: true,
        state: "ready",
        tools: ["get_note", "recall", "remember"],
        error: null,
      });
      expect(result.startupMs).toBeGreaterThanOrEqual(200);
      expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
        "initialize",
        "initialized",
        "thread/start",
        "mcpServerStatus/list",
        "mcpServerStatus/list",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports startup failure only after the final inventory page omits Afternote", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    const logPath = join(directory, "requests.log");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: logPath,
          AFTERNOTE_TEST_CODEX_MODE: "absent-after-final-page",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "failed",
        tools: [],
        error: {
          code: "startup_failed",
          message: "Codex did not retain a connected Afternote MCP server",
        },
      });
      expect(
        readFileSync(logPath, "utf8").trim().split("\n").filter((method) =>
          method === "mcpServerStatus/list"
        ),
      ).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when Codex repeats an inventory cursor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    const logPath = join(directory, "requests.log");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: logPath,
          AFTERNOTE_TEST_CODEX_MODE: "repeated-cursor",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "failed",
        error: {
          code: "invalid_response",
          message: "Codex returned an invalid MCP server inventory cursor",
        },
      });
      expect(
        readFileSync(logPath, "utf8").trim().split("\n").filter((method) =>
          method === "mcpServerStatus/list"
        ),
      ).toHaveLength(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when Codex returns a malformed inventory cursor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: join(directory, "requests.log"),
          AFTERNOTE_TEST_CODEX_MODE: "invalid-cursor",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "failed",
        error: {
          code: "invalid_response",
          message: "Codex returned an invalid MCP server inventory cursor",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds inventory traversal when Codex never ends pagination", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    const logPath = join(directory, "requests.log");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: logPath,
          AFTERNOTE_TEST_CODEX_MODE: "unbounded-pages",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 2_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "failed",
        error: {
          code: "invalid_response",
          message: "Codex returned too many MCP server inventory pages",
        },
      });
      expect(
        readFileSync(logPath, "utf8").trim().split("\n").filter((method) =>
          method === "mcpServerStatus/list"
        ),
      ).toHaveLength(32);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("includes delayed tool inventory validation in startup latency", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    try {
      writeFakeCodex(command);
      const startedAt = performance.now();
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: join(directory, "requests.log"),
          AFTERNOTE_TEST_CODEX_MODE: "delayed-inventory",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 2_000,
      });
      const elapsedMs = performance.now() - startedAt;

      expect(result).toMatchObject({
        healthy: true,
        state: "ready",
        tools: ["get_note", "recall", "remember"],
        error: null,
      });
      expect(result.startupMs).toBeGreaterThanOrEqual(200);
      expect(elapsedMs - result.startupMs).toBeLessThan(100);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns the connector startup error as bounded structured data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: join(directory, "requests.log"),
          AFTERNOTE_TEST_CODEX_MODE: "failed",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "failed",
        tools: [],
        error: {
          code: "startup_failed",
          message: "Parent signature mismatch details",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("caps a connector startup error before exposing it in status", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: join(directory, "requests.log"),
          AFTERNOTE_TEST_CODEX_MODE: "long-failed",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 1_000,
      });

      expect(result.error?.code).toBe("startup_failed");
      expect(result.error?.message).toHaveLength(500);
      expect(result.error?.message).toBe("x".repeat(500));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when Codex discovers any tool set other than the expected three", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: join(directory, "requests.log"),
          AFTERNOTE_TEST_CODEX_MODE: "wrong-tools",
          AFTERNOTE_TEST_EXPECTED_CWD: directory,
        },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "failed",
        tools: ["forget", "recall", "remember"],
        error: { code: "unexpected_tools" },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("times out quickly and reaps a host that never answers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    const stoppedPath = join(directory, "stopped");
    try {
      writeFakeCodex(command);
      const startedAt = performance.now();
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: join(directory, "requests.log"),
          AFTERNOTE_TEST_CODEX_MODE: "hang",
          AFTERNOTE_TEST_CODEX_STOPPED: stoppedPath,
        },
        timeoutMs: 300,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "timed_out",
        tools: [],
        error: { code: "timeout" },
      });
      expect(performance.now() - startedAt).toBeLessThan(750);
      expect(readFileSync(stoppedPath, "utf8")).toMatch(/^(EXIT|SIGTERM)\n$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports the host's actual bounded stderr when app-server exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: join(directory, "requests.log"),
          AFTERNOTE_TEST_CODEX_MODE: "host-error",
        },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "failed",
        error: {
          code: "host_failed",
          message: "Afternote connector could not load its signed adapter",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed app-server output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-readiness-"));
    const command = join(directory, "codex");
    try {
      writeFakeCodex(command);
      const result = await probeCodexMcpReadiness(command, {
        cwd: directory,
        env: {
          ...process.env,
          AFTERNOTE_TEST_CODEX_LOG: join(directory, "requests.log"),
          AFTERNOTE_TEST_CODEX_MODE: "malformed",
        },
        timeoutMs: 1_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        state: "failed",
        error: {
          code: "invalid_response",
          message: "Codex returned malformed JSON-RPC output",
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function writeFakeCodex(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.AFTERNOTE_TEST_CODEX_LOG;
const input = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (method) => appendFileSync(logPath, method + "\\n");
let stoppedBySignal = false;
process.on("SIGTERM", () => {
  stoppedBySignal = true;
  if (process.env.AFTERNOTE_TEST_CODEX_STOPPED) {
    appendFileSync(process.env.AFTERNOTE_TEST_CODEX_STOPPED, "SIGTERM\\n");
  }
  process.exit(0);
});
process.on("exit", () => {
  if (!stoppedBySignal && process.env.AFTERNOTE_TEST_CODEX_STOPPED) {
    appendFileSync(process.env.AFTERNOTE_TEST_CODEX_STOPPED, "EXIT\\n");
  }
});

input.on("line", (line) => {
  const message = JSON.parse(line);
  log(message.method);
  if (process.env.AFTERNOTE_TEST_CODEX_MODE === "hang") return;
  if (process.env.AFTERNOTE_TEST_CODEX_MODE === "malformed") {
    process.stdout.write("not-json\\n");
    return;
  }
  if (process.env.AFTERNOTE_TEST_CODEX_MODE === "host-error") {
    process.stderr.write("Afternote connector could not load its signed adapter\\n");
    process.exit(2);
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (message.method === "thread/start") {
    if (message.params.cwd !== process.env.AFTERNOTE_TEST_EXPECTED_CWD) {
      send({ id: message.id, error: { message: "thread cwd did not match probe cwd" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "thread-ready" } } });
    const mode = process.env.AFTERNOTE_TEST_CODEX_MODE;
    const failed = mode === "failed" || mode === "long-failed";
    send({
      method: "mcpServer/startupStatus/updated",
      params: {
        threadId: "thread-ready",
        name: "afternote",
        status: failed ? "failed" : "ready",
        error: mode === "long-failed"
          ? "x".repeat(700)
          : failed ? "Parent signature mismatch\\ndetails" : null,
      },
    });
    return;
  }
  if (message.method === "mcpServerStatus/list") {
    const mode = process.env.AFTERNOTE_TEST_CODEX_MODE;
    if ((mode === "multipage" || mode === "absent-after-final-page") &&
        message.params.cursor !== "page-2") {
      send({
        id: message.id,
        result: {
          data: [{ name: "another-server", runtimeStatus: "connected", tools: {} }],
          nextCursor: "page-2",
        },
      });
      return;
    }
    if (mode === "absent-after-final-page") {
      send({
        id: message.id,
        result: {
          data: [{ name: "another-server", runtimeStatus: "connected", tools: {} }],
          nextCursor: null,
        },
      });
      return;
    }
    if (mode === "repeated-cursor") {
      send({
        id: message.id,
        result: {
          data: [{ name: "another-server", runtimeStatus: "connected", tools: {} }],
          nextCursor: "repeat",
        },
      });
      return;
    }
    if (mode === "invalid-cursor") {
      send({ id: message.id, result: { data: [], nextCursor: 7 } });
      return;
    }
    if (mode === "unbounded-pages") {
      const page = message.params.cursor
        ? Number(message.params.cursor.slice("page-".length)) + 1
        : 1;
      send({ id: message.id, result: { data: [], nextCursor: "page-" + page } });
      return;
    }
    const wrongTools = process.env.AFTERNOTE_TEST_CODEX_MODE === "wrong-tools";
    const response = {
      id: message.id,
      result: {
        data: [{
          name: "afternote",
          runtimeStatus: "connected",
          tools: {
            remember: { name: "remember", inputSchema: {} },
            recall: { name: "recall", inputSchema: {} },
            [wrongTools ? "forget" : "get_note"]: {
              name: wrongTools ? "forget" : "get_note",
              inputSchema: {},
            },
          },
        }],
        nextCursor: null,
      },
    };
    if (mode === "delayed-inventory" || mode === "multipage") {
      setTimeout(() => send(response), 250);
      return;
    }
    send(response);
  }
});
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
}
