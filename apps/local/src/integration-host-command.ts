import { accessSync, constants, realpathSync, statSync } from "node:fs";
import {
  INTEGRATION_HOST_CODE_REQUIREMENTS,
  type IntegrationHostName,
} from "./integration-host-policy";
export { INTEGRATION_HOST_CODE_REQUIREMENTS } from "./integration-host-policy";

const DEFAULT_INTEGRATION_HOST_TIMEOUT_MS = 15_000;

export function verifyIntegrationHostCommand(
  hostName: IntegrationHostName,
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
    `-R=${INTEGRATION_HOST_CODE_REQUIREMENTS[hostName]}`,
    resolved,
  ], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${hostName} executable publisher could not be verified`);
  }
  return resolved;
}

export function runIntegrationHostCommand(
  hostName: IntegrationHostName,
  command: string,
  args: readonly string[],
  timeoutMs = DEFAULT_INTEGRATION_HOST_TIMEOUT_MS,
  verifyHost: (hostName: IntegrationHostName, command: string) => string =
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
