import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RUNTIME_PROBE_TIMEOUT_MS = 10_000;

export function installedAfternoteCommand(): string {
  const installedLink = join(
    process.env.AFTERNOTE_BIN_ROOT ?? join(homedir(), ".local", "bin"),
    "afternote",
  );
  if (
    existsSync(installedLink) &&
    realpathSync.native(installedLink) === realpathSync.native(process.execPath)
  ) {
    return installedLink;
  }
  throw new Error(
    "Could not identify this Afternote installation; install Afternote Local first, then run the installed afternote command",
  );
}

export async function probeMcpRuntime(
  command: string,
  args: readonly string[],
): Promise<boolean> {
  void args;
  const healthcheck = process.env.AFTERNOTE_BROKER_HEALTHCHECK;
  const child = Bun.spawn(healthcheck ? [healthcheck] : [command, "broker-health"], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const exitCode = await withTimeout(child.exited, "health response");
    if (exitCode !== 0) return false;
    const output = await new Response(child.stdout).text();
    const health = JSON.parse(output) as {
      protocolVersion?: unknown;
      publicMetadata?: { transport?: unknown };
    };
    return health.protocolVersion === 1 &&
      health.publicMetadata?.transport === "launchd-mach-service";
  } catch {
    return false;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Afternote MCP ${label} timed out`)),
          RUNTIME_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
