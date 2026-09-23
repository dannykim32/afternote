const CODEX_MCP_SERVER_NAME = "afternote";
const EXPECTED_CODEX_TOOLS = ["get_note", "read_archive", "recall", "remember", "search_archives"] as const;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARACTERS = 500;
const MAX_INVENTORY_PAGES = 32;
const MAX_INVENTORY_CURSOR_CHARACTERS = 4_096;

export type CodexMcpReadinessErrorCode =
  | "host_failed"
  | "invalid_response"
  | "startup_failed"
  | "timeout"
  | "unexpected_tools";

export type CodexMcpReadiness = {
  healthy: boolean;
  state: "ready" | "failed" | "timed_out";
  tools: string[];
  startupMs: number;
  error: {
    code: CodexMcpReadinessErrorCode;
    message: string;
  } | null;
};

type JsonRpcMessage = Record<string, unknown>;

export async function probeCodexMcpReadiness(
  codexCommand: string,
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<CodexMcpReadiness> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Codex MCP readiness timeout must be between 1 and 60000 milliseconds");
  }

  const startedAt = performance.now();
  const cwd = options.cwd ?? process.cwd();
  const child = Bun.spawn(
    [codexCommand, "app-server", "--listen", "stdio://"],
    {
      cwd,
      env: options.env ?? process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = readBoundedText(child.stderr, MAX_ERROR_CHARACTERS);
  const reader = new JsonLineReader(child.stdout);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const readiness = await Promise.race([
      runReadinessProtocol(child.stdin, reader, startedAt, cwd),
      new Promise<CodexMcpReadiness>((resolve) => {
        timeout = setTimeout(() => {
          resolve(failedReadiness(
            "timed_out",
            "timeout",
            `Codex MCP startup timed out after ${timeoutMs} milliseconds`,
            startedAt,
          ));
        }, timeoutMs);
      }),
    ]);
    if (readiness.error?.code === "host_failed") {
      await stopChild(child);
      const detail = await stderr;
      if (detail) {
        return {
          ...readiness,
          error: {
            code: "host_failed",
            message: boundedMessage(detail),
          },
        };
      }
    }
    return readiness;
  } finally {
    if (timeout) clearTimeout(timeout);
    await stopChild(child);
    await stderr;
  }
}

async function runReadinessProtocol(
  stdin: Bun.FileSink,
  reader: JsonLineReader,
  startedAt: number,
  cwd: string,
): Promise<CodexMcpReadiness> {
  let terminal: { status: "ready" | "failed"; error: string | null } | null = null;
  let threadId: string | null = null;
  const observe = (message: JsonRpcMessage): void => {
    if (message.method !== "mcpServer/startupStatus/updated") return;
    const params = objectValue(message.params);
    if (
      params?.name !== CODEX_MCP_SERVER_NAME ||
      (threadId !== null && params.threadId !== threadId) ||
      (params.status !== "ready" && params.status !== "failed")
    ) return;
    terminal = {
      status: params.status,
      error: typeof params.error === "string" ? params.error : null,
    };
  };

  try {
    await request(stdin, reader, 1, "initialize", {
      clientInfo: { name: "afternote-readiness", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    }, observe);
    notify(stdin, "initialized", {});
    const started = await request(stdin, reader, 2, "thread/start", {
      approvalPolicy: "never",
      cwd,
      ephemeral: true,
      sandbox: "read-only",
    }, observe);
    const startedResult = objectValue(started.result);
    const thread = objectValue(startedResult?.thread);
    if (typeof thread?.id !== "string" || thread.id.length === 0) {
      return failedReadiness(
        "failed",
        "invalid_response",
        "Codex returned an invalid ephemeral thread",
        startedAt,
      );
    }
    threadId = thread.id;

    while (terminal === null) observe(await reader.next());
    const startup = terminal as { status: "ready" | "failed"; error: string | null };
    if (startup.status === "failed") {
      return failedReadiness(
        "failed",
        "startup_failed",
        startup.error ?? "Codex reported that the Afternote MCP server failed to start",
        startedAt,
      );
    }

    let server: unknown;
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
      const listed = await request(
        stdin,
        reader,
        3 + page,
        "mcpServerStatus/list",
        {
          detail: "toolsAndAuthOnly",
          limit: 20,
          threadId,
          ...(cursor === null ? {} : { cursor }),
        },
        observe,
      );
      const result = objectValue(listed.result);
      if (!Array.isArray(result?.data)) {
        return failedReadiness(
          "failed",
          "invalid_response",
          "Codex returned an invalid MCP server inventory",
          startedAt,
        );
      }
      server = result.data.find((candidate) =>
        objectValue(candidate)?.name === CODEX_MCP_SERVER_NAME
      );
      if (server !== undefined) break;

      const nextCursor = result.nextCursor;
      if (nextCursor === null) break;
      if (
        typeof nextCursor !== "string" ||
        nextCursor.length === 0 ||
        nextCursor.length > MAX_INVENTORY_CURSOR_CHARACTERS ||
        seenCursors.has(nextCursor)
      ) {
        return failedReadiness(
          "failed",
          "invalid_response",
          "Codex returned an invalid MCP server inventory cursor",
          startedAt,
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;

      if (page === MAX_INVENTORY_PAGES - 1) {
        return failedReadiness(
          "failed",
          "invalid_response",
          "Codex returned too many MCP server inventory pages",
          startedAt,
        );
      }
    }
    const record = objectValue(server);
    const toolsRecord = objectValue(record?.tools);
    if (record?.runtimeStatus !== "connected" || toolsRecord === null) {
      return failedReadiness(
        "failed",
        "startup_failed",
        "Codex did not retain a connected Afternote MCP server",
        startedAt,
      );
    }
    const tools = Object.keys(toolsRecord).sort();
    const startupMs = elapsedMilliseconds(startedAt);
    if (tools.join("\n") !== EXPECTED_CODEX_TOOLS.join("\n")) {
      return {
        healthy: false,
        state: "failed",
        tools,
        startupMs,
        error: {
          code: "unexpected_tools",
          message: `Codex discovered unexpected Afternote tools: ${tools.join(", ") || "none"}`,
        },
      };
    }
    return {
      healthy: true,
      state: "ready",
      tools,
      startupMs,
      error: null,
    };
  } catch (error) {
    return failedReadiness(
      "failed",
      error instanceof JsonRpcProtocolError ? "invalid_response" : "host_failed",
      error instanceof Error ? error.message : "Codex MCP readiness failed",
      startedAt,
    );
  }
}

async function request(
  stdin: Bun.FileSink,
  reader: JsonLineReader,
  id: number,
  method: string,
  params: Record<string, unknown>,
  observe: (message: JsonRpcMessage) => void,
): Promise<JsonRpcMessage> {
  writeMessage(stdin, { id, method, params });
  while (true) {
    const message = await reader.next();
    observe(message);
    if (message.id !== id) continue;
    if (message.error !== undefined) {
      const error = objectValue(message.error);
      throw new JsonRpcProtocolError(
        typeof error?.message === "string"
          ? error.message
          : `Codex rejected ${method}`,
      );
    }
    if (!("result" in message)) {
      throw new JsonRpcProtocolError(`Codex returned an invalid ${method} response`);
    }
    return message;
  }
}

function notify(
  stdin: Bun.FileSink,
  method: string,
  params: Record<string, unknown>,
): void {
  writeMessage(stdin, { method, params });
}

function writeMessage(stdin: Bun.FileSink, message: JsonRpcMessage): void {
  stdin.write(`${JSON.stringify(message)}\n`);
  stdin.flush();
}

class JsonLineReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async next(): Promise<JsonRpcMessage> {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline >= 0) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new JsonRpcProtocolError("Codex returned malformed JSON-RPC output");
        }
        const message = objectValue(parsed);
        if (message === null) {
          throw new JsonRpcProtocolError("Codex returned an invalid JSON-RPC message");
        }
        return message;
      }

      const chunk = await this.#reader.read();
      if (chunk.done) {
        throw new Error("Codex app-server closed before MCP readiness completed");
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
      if (this.#buffer.length > 1_048_576) {
        throw new JsonRpcProtocolError("Codex returned oversized JSON-RPC output");
      }
    }
  }
}

class JsonRpcProtocolError extends Error {}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failedReadiness(
  state: "failed" | "timed_out",
  code: CodexMcpReadinessErrorCode,
  message: string,
  startedAt: number,
): CodexMcpReadiness {
  return {
    healthy: false,
    state,
    tools: [],
    startupMs: elapsedMilliseconds(startedAt),
    error: { code, message: boundedMessage(message) },
  };
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function boundedMessage(value: string): string {
  const safe = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? " "
        : character;
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return safe.slice(0, MAX_ERROR_CHARACTERS) || "Codex MCP readiness failed";
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maximumCharacters: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      const bounded = result.slice(0, maximumCharacters);
      return bounded.trim() ? boundedMessage(bounded) : "";
    }
    if (result.length < maximumCharacters) {
      result += decoder.decode(chunk.value, { stream: true });
    }
  }
}

async function stopChild(child: Bun.Subprocess): Promise<void> {
  try {
    if (child.stdin && typeof child.stdin !== "number") child.stdin.end();
  } catch {
    // The host may have already closed stdin after a startup failure.
  }
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(250)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
}
