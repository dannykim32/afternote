import { accessSync, constants, realpathSync, statSync } from "node:fs";

const DEFAULT_INTEGRATION_HOST_TIMEOUT_MS = 15_000;

const HOST_REQUIREMENTS = {
  Codex: 'anchor apple generic and identifier "codex" and certificate leaf[subject.OU] = "2DC432GLL2"',
  "Claude Code": 'anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
} as const;

export function verifyIntegrationHostCommand(
  hostName: "Codex" | "Claude Code",
  command: string,
): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(command);
    if (!statSync(resolved).isFile()) throw new Error("not a file");
    accessSync(resolved, constants.X_OK);
  } catch {
    throw new Error(`${hostName} executable is unavailable`);
  }
  const result = Bun.spawnSync([
    "/usr/bin/codesign",
    "--verify",
    "--strict",
    `-R=${HOST_REQUIREMENTS[hostName]}`,
    resolved,
  ], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${hostName} executable publisher could not be verified`);
  }
  return resolved;
}

export function runIntegrationHostCommand(
  hostName: "Codex" | "Claude Code",
  command: string,
  args: readonly string[],
  timeoutMs = DEFAULT_INTEGRATION_HOST_TIMEOUT_MS,
  verifyHost: (hostName: "Codex" | "Claude Code", command: string) => string =
    verifyIntegrationHostCommand,
): string {
  const verifiedCommand = verifyHost(hostName, command);
  const result = Bun.spawnSync([verifiedCommand, ...args], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.signalCode !== null && result.signalCode !== undefined) {
    throw new Error(`${hostName} configuration timed out`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${hostName} configuration failed`);
  }
  return result.stdout.toString();
}
