import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  CLAUDE_DESKTOP_EXTENSION_ID,
  createClaudeDesktopPackage,
  manageClaudeDesktopIntegration,
  parseClaudeDesktopIntegrationAction,
  resolveClaudeDesktopApplication,
} from "./claude-desktop-integration";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude Desktop integration", () => {
  it("accepts only the explicit lifecycle actions", () => {
    expect(parseClaudeDesktopIntegrationAction("install")).toBe("install");
    expect(parseClaudeDesktopIntegrationAction("status")).toBe("status");
    expect(parseClaudeDesktopIntegrationAction("remove")).toBe("remove");
    expect(parseClaudeDesktopIntegrationAction("rotate-identity"))
      .toBe("rotate-identity");
    expect(() => parseClaudeDesktopIntegrationAction("enable"))
      .toThrow("install, status, remove, or rotate-identity");
  });

  it("resolves only a publisher-verified Claude application", () => {
    const root = fixtureRoot();
    const application = join(root, "Claude.app");
    const executable = join(application, "Contents", "MacOS", "Claude");
    mkdirSync(join(application, "Contents", "MacOS"), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(executable, 0o755);

    expect(resolveClaudeDesktopApplication({
      candidates: [application],
      verifyCommand: (_host, command) => command,
    })).toBe(realpathSync.native(application));
    expect(resolveClaudeDesktopApplication({
      candidates: [application],
      verifyCommand: () => {
        throw new Error("wrong publisher");
      },
    })).toBeNull();
  });

  it("creates a minimal MCPB whose launcher delegates to the stable install", () => {
    const root = fixtureRoot();
    const destination = join(root, "out", "Afternote.mcpb");
    createClaudeDesktopPackage({
      afternoteCommand: "/Users/test/.local/bin/afternote",
      packageVersion: "2.0.0-alpha.14",
      destination,
    });

    const listing = Bun.spawnSync(["/usr/bin/unzip", "-Z1", destination]);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout.toString().trim().split("\n").sort()).toEqual([
      "bin/afternote-launcher",
      "manifest.json",
    ]);
    const manifest = JSON.parse(Bun.spawnSync([
      "/usr/bin/unzip",
      "-p",
      destination,
      "manifest.json",
    ]).stdout.toString()) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      manifest_version: "0.3",
      name: "afternote",
      display_name: "Afternote",
      version: "2.0.0-alpha.14",
      server: {
        type: "binary",
        entry_point: "bin/afternote-launcher",
        mcp_config: {
          command: "${__dirname}/bin/afternote-launcher",
        },
      },
    });
    expect(Bun.spawnSync([
      "/usr/bin/unzip",
      "-p",
      destination,
      "bin/afternote-launcher",
    ]).stdout.toString()).toBe(
      "#!/bin/sh\nset -eu\nexec '/Users/test/.local/bin/afternote' mcp --client claude-desktop\n",
    );
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    const first = readFileSync(destination);
    createClaudeDesktopPackage({
      afternoteCommand: "/Users/test/.local/bin/afternote",
      packageVersion: "2.0.0-alpha.14",
      destination,
    });
    expect(readFileSync(destination)).toEqual(first);
  });

  it("opens an MCPB for Claude's approval without claiming it is installed", async () => {
    const root = fixtureRoot();
    const opened: Array<{ application: string; packagePath: string }> = [];
    const result = await manageClaudeDesktopIntegration("install", true, {
      afternoteCommand: "/Users/test/.local/bin/afternote",
      packageVersion: "2.0.0-alpha.14",
      homeDirectory: root,
      resolveApplication: () => "/Applications/Claude.app",
      probeIdentity: () => true,
      openPackage: (application, packagePath) => {
        opened.push({ application, packagePath });
      },
    });

    expect(result).toMatchObject({
      format: "afternote-claude-desktop-integration",
      schemaVersion: 1,
      toolAvailable: true,
      installed: false,
      healthy: false,
      repairable: true,
      problemCode: "connector_missing",
      approvalRequired: true,
      changed: true,
      extensionId: CLAUDE_DESKTOP_EXTENSION_ID,
      args: ["mcp", "--client", "claude-desktop"],
    });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.application).toBe("/Applications/Claude.app");
    expect(opened[0]!.packagePath.endsWith("Afternote-2.0.0-alpha.14.mcpb"))
      .toBe(true);
  });

  it("recognizes only the enabled Afternote-owned extension", async () => {
    const root = fixtureRoot();
    installExtensionFixture(root, true);
    const healthy = await manageClaudeDesktopIntegration("status", true, {
      afternoteCommand: "/Users/test/.local/bin/afternote",
      packageVersion: "2.0.0-alpha.14",
      homeDirectory: root,
      resolveApplication: () => "/Applications/Claude.app",
      probeIdentity: () => true,
      probeRuntime: async () => true,
    });
    expect(healthy).toMatchObject({
      toolAvailable: true,
      installed: true,
      configHealthy: true,
      identityHealthy: true,
      runtimeHealthy: true,
      healthy: true,
      repairable: false,
      problemCode: null,
    });

    installExtensionFixture(root, false);
    const disabled = await manageClaudeDesktopIntegration("status", true, {
      afternoteCommand: "/Users/test/.local/bin/afternote",
      packageVersion: "2.0.0-alpha.14",
      homeDirectory: root,
      resolveApplication: () => "/Applications/Claude.app",
    });
    expect(disabled).toMatchObject({
      installed: true,
      configHealthy: false,
      repairable: true,
      problemCode: "connector_disabled",
    });
  });

  it("refuses to overwrite a foreign extension and keeps removal user-mediated", async () => {
    const root = fixtureRoot();
    const extension = extensionRoot(root);
    mkdirSync(extension, { recursive: true });
    writeFileSync(join(extension, "manifest.json"), JSON.stringify({
      manifest_version: "0.4",
      name: "not-afternote",
    }));

    await expect(manageClaudeDesktopIntegration("install", true, {
      afternoteCommand: "/Users/test/.local/bin/afternote",
      packageVersion: "2.0.0-alpha.14",
      homeDirectory: root,
      resolveApplication: () => "/Applications/Claude.app",
    })).rejects.toThrow("will not overwrite");
    await expect(manageClaudeDesktopIntegration("remove", true, {
      afternoteCommand: "/Users/test/.local/bin/afternote",
      packageVersion: "2.0.0-alpha.14",
      homeDirectory: root,
      resolveApplication: () => "/Applications/Claude.app",
    })).rejects.toThrow("remove Afternote there");
    expect(readFileSync(join(extension, "manifest.json"), "utf8"))
      .toContain("not-afternote");
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "afternote-claude-desktop-"));
  temporaryDirectories.push(root);
  return root;
}

function extensionRoot(homeDirectory: string): string {
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "Claude",
    "Claude Extensions",
    CLAUDE_DESKTOP_EXTENSION_ID,
  );
}

function installExtensionFixture(homeDirectory: string, enabled: boolean): void {
  const extension = extensionRoot(homeDirectory);
  mkdirSync(join(extension, "bin"), { recursive: true });
  writeFileSync(join(extension, "manifest.json"), JSON.stringify({
    manifest_version: "0.3",
    name: "afternote",
    display_name: "Afternote",
    version: "2.0.0-alpha.14",
    description: "Local, encrypted memory for Claude Desktop.",
    author: { name: "Danny Kim" },
    server: {
      type: "binary",
      entry_point: "bin/afternote-launcher",
      mcp_config: { command: "${__dirname}/bin/afternote-launcher" },
    },
  }));
  writeFileSync(
    join(extension, "bin", "afternote-launcher"),
    "#!/bin/sh\nset -eu\nexec '/Users/test/.local/bin/afternote' mcp --client claude-desktop\n",
    { mode: 0o755 },
  );
  const settingsRoot = join(
    homeDirectory,
    "Library",
    "Application Support",
    "Claude",
    "Claude Extensions Settings",
  );
  mkdirSync(settingsRoot, { recursive: true });
  writeFileSync(
    join(settingsRoot, `${CLAUDE_DESKTOP_EXTENSION_ID}.json`),
    JSON.stringify({ isEnabled: enabled }),
  );
}
