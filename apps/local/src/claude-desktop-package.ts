import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeExclusivePrivateFile } from "./exclusive-export";

export const CLAUDE_DESKTOP_EXTENSION_ID = "local.mcpb.danny-kim.afternote";
export const CLAUDE_DESKTOP_MANIFEST_VERSION = "0.3";

export function createClaudeDesktopPackage(options: {
  afternoteCommand: string;
  packageVersion: string;
  destination: string;
}): string {
  assertAbsoluteExecutablePath(options.afternoteCommand);
  assertPackageVersion(options.packageVersion);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "afternote-mcpb-"));
  const payloadRoot = join(temporaryRoot, "payload");
  const launcherPath = join(payloadRoot, "bin", "afternote-launcher");
  const archivePath = join(temporaryRoot, "Afternote.mcpb");
  try {
    mkdirSync(dirname(launcherPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(payloadRoot, "manifest.json"),
      `${JSON.stringify(claudeDesktopManifest(options.packageVersion), null, 2)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      launcherPath,
      claudeDesktopLauncher(options.afternoteCommand),
      { mode: 0o700 },
    );
    chmodSync(launcherPath, 0o700);
    const zipEpoch = new Date("1980-01-01T00:00:00.000Z");
    utimesSync(join(payloadRoot, "manifest.json"), zipEpoch, zipEpoch);
    utimesSync(launcherPath, zipEpoch, zipEpoch);
    const zipped = Bun.spawnSync([
      "/usr/bin/zip",
      "-X",
      "-q",
      archivePath,
      "manifest.json",
      "bin/afternote-launcher",
    ], { cwd: payloadRoot, stdout: "pipe", stderr: "pipe" });
    if (zipped.exitCode !== 0) {
      throw new Error("Could not create the Claude Desktop extension package");
    }
    const archive = readFileSync(archivePath);
    if (existsSync(options.destination)) {
      const info = lstatSync(options.destination);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("Claude Desktop extension package path is invalid");
      }
      const existing = readFileSync(options.destination);
      if (sha256(existing) !== sha256(archive)) {
        throw new Error(
          "A different Claude Desktop extension package already exists for this Afternote version",
        );
      }
      return options.destination;
    }
    writeExclusivePrivateFile(options.destination, (descriptor) => {
      writeSync(descriptor, archive);
    });
    return options.destination;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function claudeDesktopLauncher(afternoteCommand: string): string {
  return `#!/bin/sh\nset -eu\nexec ${shellQuote(afternoteCommand)} mcp --client claude-desktop\n`;
}

function claudeDesktopManifest(packageVersion: string): Record<string, unknown> {
  return {
    manifest_version: CLAUDE_DESKTOP_MANIFEST_VERSION,
    name: "afternote",
    display_name: "Afternote",
    version: packageVersion,
    description: "Local, encrypted memory for Claude Desktop.",
    author: { name: "Danny Kim" },
    repository: {
      type: "git",
      url: "https://github.com/dannykim32/afternote",
    },
    homepage: "https://github.com/dannykim32/afternote",
    license: "Apache-2.0",
    compatibility: {
      platforms: ["darwin"],
    },
    server: {
      type: "binary",
      entry_point: "bin/afternote-launcher",
      mcp_config: {
        command: "${__dirname}/bin/afternote-launcher",
      },
    },
    tools: [
      { name: "remember", description: "Save a note to Afternote." },
      { name: "recall", description: "Recall relevant notes from Afternote." },
      { name: "get_note", description: "Read one Afternote note by ID." },
    ],
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertAbsoluteExecutablePath(path: string): void {
  if (!path.startsWith("/") || /[\0\r\n]/u.test(path)) {
    throw new Error("Installed Afternote command path is invalid");
  }
}

function assertPackageVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("Afternote package version is invalid");
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
