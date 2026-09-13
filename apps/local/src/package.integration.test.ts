import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  buildLocalAlpha,
  type LocalAlphaArtifacts,
} from "../../../scripts/build-local-alpha";
import {
  acceptanceBrokerMachService,
  developmentOwnerPresenceBypass,
  desktopRuntimeEntries,
  releaseVersionMetadata,
  softwareUpdatePolicy,
  releaseWorkerEntrypoint,
  renderPackagingText,
  signedRequirement,
} from "../../../scripts/release-policy";

describe("package policy", () => {
  it("selects a separate release worker and excludes retired connector payloads", () => {
    expect(releaseWorkerEntrypoint({ releaseBuild: "0" }))
      .toBe("vault-broker-worker-main.ts");
    expect(releaseWorkerEntrypoint({ releaseBuild: "1" }))
      .toBe("vault-broker-release-worker-main.ts");

    const entries = desktopRuntimeEntries(false);
    expect(entries).toContain("afternote");
    expect(entries).toContain("afternote-vault-broker");
    expect(entries).toContain("AfternoteVaultWorker.app");
    expect(entries).toContain("AfternoteClientSigner.app");
    expect(entries).toContain("install.sh");
    expect(entries).toContain("rollback.sh");
    expect(entries).toContain("uninstall.sh");
    expect(entries).toContain("SBOM.spdx.json");
    expect(entries).toContain("THIRD_PARTY_NOTICES.md");
    expect(entries.join("\n")).not.toMatch(/browser|slack/i);
    expect(desktopRuntimeEntries(true)).toContain("onnxruntime_binding.node");
  });

  it("strips development-only claims from public release documentation", () => {
    const template = `# __AFTERNOTE_RELEASE_CHANNEL__
<!-- BEGIN:semantic-runtime -->semantic install<!-- END:semantic-runtime -->
public exact
<!-- BEGIN:development-key -->development-vault.key<!-- END:development-key -->
`;
    expect(renderPackagingText(template, {
      includeSemanticRuntime: true,
      release: true,
    })).toBe("# public-alpha\nsemantic install\npublic exact\n");
  });

  it("allows owner-presence bypass only in an explicit development build", () => {
    expect(developmentOwnerPresenceBypass({})).toBe(false);
    expect(developmentOwnerPresenceBypass({ configured: "1" })).toBe(true);
    expect(() => developmentOwnerPresenceBypass({
      requested: true,
      releaseBuild: "1",
    })).toThrow("Release packaging cannot bypass owner presence");
  });

  it("requires acceptance services to be explicit, namespaced, and non-release", () => {
    expect(acceptanceBrokerMachService({})).toBe("dev.afternote.vault-broker");
    expect(() => acceptanceBrokerMachService({ acceptanceBuild: "1" }))
      .toThrow("requires AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE");
    expect(() => acceptanceBrokerMachService({
      acceptanceBuild: "1",
      configuredService: "dev.afternote.vault-broker.acceptance.test",
      releaseBuild: "1",
    })).toThrow("Release packaging cannot use");
  });

  it("pins the full Developer ID requirement instead of identifier and team alone", () => {
    const requirement = signedRequirement("dev.afternote.local", "486B2A8N8A");
    expect(requirement).toContain('identifier "dev.afternote.local"');
    expect(requirement).toContain('certificate leaf[subject.OU] = "486B2A8N8A"');
    expect(requirement).toContain("1.2.840.113635.100.6.1.13");
    expect(requirement).toContain("1.2.840.113635.100.6.2.6");
  });

  it("keeps package, marketing, and numeric Apple build versions distinct", () => {
    expect(releaseVersionMetadata({
      rootVersion: "2.0.0-alpha.9",
      workspaceVersions: ["2.0.0-alpha.9", "2.0.0-alpha.9"],
      bundleVersion: "9",
      release: true,
    })).toEqual({
      packageVersion: "2.0.0-alpha.9",
      marketingVersion: "2.0.0",
      bundleVersion: "9",
    });
    expect(() => releaseVersionMetadata({
      rootVersion: "2.0.0-alpha.9",
      workspaceVersions: ["2.0.0-alpha.8"],
      bundleVersion: "9",
      release: true,
    })).toThrow("Workspace package versions");
    expect(() => releaseVersionMetadata({
      rootVersion: "2.0.0-alpha.9",
      workspaceVersions: ["2.0.0-alpha.9"],
      bundleVersion: "alpha.9",
      release: true,
    })).toThrow("Apple bundle version");
  });

  it("enables only signed, privacy-preserving update checks in release builds", () => {
    expect(softwareUpdatePolicy({ release: false })).toEqual({ enabled: false });
    expect(softwareUpdatePolicy({
      release: true,
      feedUrl: "https://updates.example.test/appcast.xml",
      publicEdKey: "XvnOOnpqXBIE7Nq00NKD8cnMe3ZZHqLFbfykOD8tLOs=",
    })).toEqual({
      enabled: true,
      feedUrl: "https://updates.example.test/appcast.xml",
      publicEdKey: "XvnOOnpqXBIE7Nq00NKD8cnMe3ZZHqLFbfykOD8tLOs=",
      automaticallyChecks: true,
      automaticallyDownloads: false,
      allowsAutomaticUpdates: false,
      sendsSystemProfile: false,
      scheduledCheckIntervalSeconds: 86_400,
      verifiesBeforeExtraction: true,
      requiresSignedFeed: true,
      signedFeedFailureExpirationIntervalSeconds: 0,
    });
    expect(() => softwareUpdatePolicy({
      release: true,
      feedUrl: "http://updates.example.test/appcast.xml",
      publicEdKey: "XvnOOnpqXBIE7Nq00NKD8cnMe3ZZHqLFbfykOD8tLOs=",
    })).toThrow("HTTPS");
  });
});

const shouldRun = process.platform === "darwin" && process.arch === "arm64";
const describeMac = shouldRun ? describe : describe.skip;

describeMac("macOS package lifecycle", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-public-package-"));
  const launchctl = join(directory, "launchctl");
  const healthcheck = join(directory, "healthcheck");
  let alphaZero: LocalAlphaArtifacts;
  let alphaOne: LocalAlphaArtifacts;

  beforeAll(async () => {
    writeExecutable(launchctl, `#!/bin/sh
if [ "\${1:-}" = print ]; then exit 1; fi
exit 0
`);
    writeExecutable(healthcheck, `#!/bin/sh
set -eu
current=$(readlink "$AFTERNOTE_INSTALL_ROOT/current")
version=\${current#versions/}
printf '{"publicMetadata":{"applicationVersion":"%s"}}\\n' "$version"
`);
    alphaZero = await buildLocalAlpha({
      outputDirectory: join(directory, "alpha-zero"),
      version: "2.0.0-alpha.0",
    });
    alphaOne = await buildLocalAlpha({
      outputDirectory: join(directory, "alpha-one"),
      version: "2.0.0-alpha.1",
    });
  }, 180_000);

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("contains only the declared local MCP connector surface", () => {
    const help = run([alphaZero.binaryPath, "help"], baseEnvironment()).stdout;
    expect(help).toContain("mcp --client codex|claude|claude-desktop");
    expect(help).toContain("codex install|status|remove|rotate-identity");
    expect(help).toContain("claude-code install|status|remove|rotate-identity");
    expect(help).toContain("claude-desktop install|status|rotate-identity");
    expect(help).not.toMatch(/browser install|slack configure/i);

    const names = Bun.spawnSync([
      "/usr/bin/find",
      alphaZero.portableDirectory,
      "-maxdepth",
      "2",
      "-print",
    ]).stdout.toString();
    expect(names).not.toMatch(/afternote-browser|slack/i);
    expect(existsSync(alphaZero.sbomPath)).toBe(true);
    expect(existsSync(alphaZero.noticesPath)).toBe(true);
    for (const path of [alphaZero.sqlcipherLibraryPath, alphaZero.cryptoLibraryPath]) {
      const metadata = Bun.spawnSync(["/usr/bin/vtool", "-show-build", path]);
      expect(metadata.exitCode, metadata.stderr.toString()).toBe(0);
      expect(metadata.stdout.toString()).toContain("minos 13.3");
    }
  });

  it("labels the source-built application as a distinct development app", () => {
    const plist = join(alphaZero.ownerControlAppPath, "Contents/Info.plist");
    const displayName = run([
      "/usr/libexec/PlistBuddy",
      "-c",
      "Print :CFBundleDisplayName",
      plist,
    ], baseEnvironment()).stdout.trim();
    const identifier = run([
      "/usr/libexec/PlistBuddy",
      "-c",
      "Print :CFBundleIdentifier",
      plist,
    ], baseEnvironment()).stdout.trim();

    expect(displayName).toBe("Afternote Development");
    expect(identifier).toBe("dev.afternote.owner-control.development");
  });

  it("keeps development builds free of the production update network path", () => {
    const contents = join(alphaZero.ownerControlAppPath, "Contents");
    expect(existsSync(join(contents, "Frameworks/Sparkle.framework"))).toBe(false);
    const infoPlist = readFileSync(join(contents, "Info.plist"), "utf8");
    expect(infoPlist).not.toContain("SUFeedURL");
    expect(infoPlist).not.toContain("SUPublicEDKey");
  });

  it("installs, upgrades, rolls back, uninstalls, and reinstalls transactionally", () => {
    const home = join(directory, "lifecycle-home");
    const installRoot = join(home, "Library/Application Support/Afternote");
    const binRoot = join(home, ".local/bin");
    mkdirSync(home, { recursive: true });
    const environment = {
      ...baseEnvironment(),
      HOME: home,
      AFTERNOTE_INSTALL_ROOT: installRoot,
      AFTERNOTE_BIN_ROOT: binRoot,
      AFTERNOTE_LAUNCHCTL: launchctl,
      AFTERNOTE_BROKER_HEALTHCHECK: healthcheck,
      AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
    };

    run([join(alphaZero.portableDirectory, "install.sh")], environment);
    expect(readlinkSync(join(installRoot, "current"))).toBe("versions/2.0.0-alpha.0");
    const legacyTelemetry = join(home, ".afternote/.vault.db.afternote-telemetry.json");
    mkdirSync(join(home, ".afternote"), { recursive: true });
    writeFileSync(legacyTelemetry, '{"enabled":true,"installationId":"retired"}\n');
    run([join(alphaOne.portableDirectory, "install.sh")], environment);
    expect(readlinkSync(join(installRoot, "current"))).toBe("versions/2.0.0-alpha.1");
    expect(existsSync(legacyTelemetry)).toBe(false);
    run([
      join(alphaOne.portableDirectory, "rollback.sh"),
      "2.0.0-alpha.0",
    ], environment);
    expect(readlinkSync(join(installRoot, "current"))).toBe("versions/2.0.0-alpha.0");
    run([join(alphaZero.portableDirectory, "uninstall.sh")], environment);
    expect(existsSync(installRoot)).toBe(false);
    expect(existsSync(join(binRoot, "afternote"))).toBe(false);

    run([join(alphaOne.portableDirectory, "install.sh")], environment);
    expect(readlinkSync(join(installRoot, "current"))).toBe("versions/2.0.0-alpha.1");
    run([join(alphaOne.portableDirectory, "uninstall.sh")], environment);
    expect(existsSync(installRoot)).toBe(false);
  }, 30_000);

  it("refuses to cross from a signed installation into an ad-hoc development build", () => {
    const home = join(directory, "trust-domain-home");
    const installRoot = join(home, "Library/Application Support/Afternote");
    const binRoot = join(home, ".local/bin");
    const codesign = join(directory, "trust-domain-codesign");
    const signedApplication = join(directory, "SignedAfternote.app");
    mkdirSync(home, { recursive: true });
    mkdirSync(signedApplication, { recursive: true });
    writeExecutable(codesign, `#!/bin/sh
case "\${!#}" in
  "${signedApplication}") printf 'Identifier=dev.afternote.owner-control\\nTeamIdentifier=486B2A8N8A\\n' >&2 ;;
  *) printf 'Identifier=dev.afternote.owner-control.development\\nTeamIdentifier=not set\\n' >&2 ;;
esac
exit 0
`);
    const environment = {
      ...baseEnvironment(),
      HOME: home,
      AFTERNOTE_INSTALL_ROOT: installRoot,
      AFTERNOTE_BIN_ROOT: binRoot,
      AFTERNOTE_LAUNCHCTL: launchctl,
      AFTERNOTE_BROKER_HEALTHCHECK: healthcheck,
      AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
      AFTERNOTE_CODESIGN: codesign,
    };

    run([join(alphaZero.portableDirectory, "install.sh")], environment);
    writeFileSync(
      join(installRoot, "versions/2.0.0-alpha.0/application-path"),
      `${signedApplication}\n`,
    );
    const result = Bun.spawnSync([join(alphaOne.portableDirectory, "install.sh")], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "cannot replace an installation from a different signing trust domain",
    );
    expect(readlinkSync(join(installRoot, "current")))
      .toBe("versions/2.0.0-alpha.0");
    expect(existsSync(join(installRoot, "versions/2.0.0-alpha.1"))).toBe(false);
  }, 30_000);

  it("repairs a missing public command link for the active installed version", () => {
    const home = join(directory, "repair-link-home");
    const installRoot = join(home, "Library/Application Support/Afternote");
    const binRoot = join(home, ".local/bin");
    const commandLink = join(binRoot, "afternote");
    mkdirSync(home, { recursive: true });
    const environment = {
      ...baseEnvironment(),
      HOME: home,
      AFTERNOTE_INSTALL_ROOT: installRoot,
      AFTERNOTE_BIN_ROOT: binRoot,
      AFTERNOTE_LAUNCHCTL: launchctl,
      AFTERNOTE_BROKER_HEALTHCHECK: healthcheck,
      AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
    };

    run([join(alphaZero.portableDirectory, "install.sh")], environment);
    rmSync(commandLink);

    run([join(alphaZero.portableDirectory, "install.sh")], environment);

    expect(readlinkSync(commandLink))
      .toBe(join(installRoot, "current/afternote"));
    expect(readlinkSync(join(installRoot, "current")))
      .toBe("versions/2.0.0-alpha.0");
  }, 30_000);

  it("restarts a stale broker during same-version repair", () => {
    const home = join(directory, "repair-stale-broker-home");
    const installRoot = join(home, "Library/Application Support/Afternote");
    const binRoot = join(home, ".local/bin");
    const brokerVersionState = join(home, "broker-version");
    const statefulLaunchctl = join(home, "launchctl");
    const statefulHealthcheck = join(home, "healthcheck");
    mkdirSync(home, { recursive: true });
    writeExecutable(statefulLaunchctl, `#!/bin/sh
set -eu
if [ "\${1:-}" = print ]; then exit 1; fi
if [ "\${1:-}" = kickstart ]; then
  current=$(readlink "$AFTERNOTE_INSTALL_ROOT/current")
  printf '%s\\n' "\${current#versions/}" > "$AFTERNOTE_TEST_BROKER_VERSION_STATE"
fi
exit 0
`);
    writeExecutable(statefulHealthcheck, `#!/bin/sh
set -eu
version=$(sed -n '1p' "$AFTERNOTE_TEST_BROKER_VERSION_STATE")
printf '{"publicMetadata":{"applicationVersion":"%s"}}\\n' "$version"
`);
    const environment = {
      ...baseEnvironment(),
      HOME: home,
      AFTERNOTE_INSTALL_ROOT: installRoot,
      AFTERNOTE_BIN_ROOT: binRoot,
      AFTERNOTE_LAUNCHCTL: statefulLaunchctl,
      AFTERNOTE_BROKER_HEALTHCHECK: statefulHealthcheck,
      AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
      AFTERNOTE_TEST_BROKER_VERSION_STATE: brokerVersionState,
    };

    run([join(alphaOne.portableDirectory, "install.sh")], environment);
    expect(readFileSync(brokerVersionState, "utf8")).toBe("2.0.0-alpha.1\n");
    writeFileSync(brokerVersionState, "2.0.0-alpha.0\n");

    run([join(alphaOne.portableDirectory, "install.sh")], environment);

    expect(readFileSync(brokerVersionState, "utf8")).toBe("2.0.0-alpha.1\n");
  }, 30_000);

  it("removes a managed Codex entry when the host CLI is outside the sanitized PATH", async () => {
    const home = join(directory, "codex-uninstall-home");
    const installRoot = join(home, "Library/Application Support/Afternote");
    const binRoot = join(home, ".local/bin");
    const actions = join(home, "connector-actions");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    writeFileSync(
      join(home, ".codex/config.toml"),
      "[mcp_servers.afternote]\ncommand = \"afternote\"\n",
    );
    writeExecutable(join(binRoot, "codex"), "#!/bin/sh\nexit 0\n");
    const environment = {
      ...baseEnvironment(),
      HOME: home,
      AFTERNOTE_INSTALL_ROOT: installRoot,
      AFTERNOTE_BIN_ROOT: binRoot,
      AFTERNOTE_LAUNCHCTL: launchctl,
      AFTERNOTE_BROKER_HEALTHCHECK: healthcheck,
      AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
      AFTERNOTE_TEST_ACTIONS: actions,
    };

    run([join(alphaZero.portableDirectory, "install.sh")], environment);
    writeExecutable(
      join(installRoot, "versions/2.0.0-alpha.0/afternote"),
      `#!/bin/sh
if [ "\${1:-}" = codex ] && [ "\${2:-}" = status ]; then
  printf '{"configHealthy": true}\n'
  exit 0
fi
if [ "\${1:-}" = codex ] && [ "\${2:-}" = remove ]; then
  printf 'codex-remove\n' >> "$AFTERNOTE_TEST_ACTIONS"
  exit 0
fi
exit 1
`,
    );

    run([join(alphaZero.portableDirectory, "uninstall.sh")], environment);

    expect(await Bun.file(actions).text()).toContain("codex-remove");
    expect(existsSync(installRoot)).toBe(false);
  }, 30_000);

  it("warns about a stale Codex entry when every discovered host fails verification", () => {
    const home = join(directory, "codex-stale-uninstall-home");
    const installRoot = join(home, "Library/Application Support/Afternote");
    const binRoot = join(home, ".local/bin");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex/config.toml"),
      "[mcp_servers.afternote]\ncommand = \"afternote\"\n",
    );
    const environment = {
      ...baseEnvironment(),
      HOME: home,
      AFTERNOTE_INSTALL_ROOT: installRoot,
      AFTERNOTE_BIN_ROOT: binRoot,
      AFTERNOTE_LAUNCHCTL: launchctl,
      AFTERNOTE_BROKER_HEALTHCHECK: healthcheck,
      AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
    };

    run([join(alphaZero.portableDirectory, "install.sh")], environment);
    writeExecutable(
      join(installRoot, "versions/2.0.0-alpha.0/afternote"),
      `#!/bin/sh
if [ "\${1:-}" = codex ] && [ "\${2:-}" = status ]; then
  printf '{"toolAvailable": false}\n'
  exit 0
fi
exit 1
`,
    );
    const result = Bun.spawnSync([join(alphaZero.portableDirectory, "uninstall.sh")], {
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("Codex is unavailable or unverified");
    expect(existsSync(installRoot)).toBe(false);
  }, 30_000);

  it("requires Claude Desktop to remove its owned extension before uninstall", () => {
    const home = join(directory, "claude-desktop-uninstall-home");
    const installRoot = join(home, "Library/Application Support/Afternote");
    const binRoot = join(home, ".local/bin");
    const extension = join(
      home,
      "Library/Application Support/Claude/Claude Extensions/local.mcpb.danny-kim.afternote",
    );
    mkdirSync(extension, { recursive: true });
    const environment = {
      ...baseEnvironment(),
      HOME: home,
      AFTERNOTE_INSTALL_ROOT: installRoot,
      AFTERNOTE_BIN_ROOT: binRoot,
      AFTERNOTE_LAUNCHCTL: launchctl,
      AFTERNOTE_BROKER_HEALTHCHECK: healthcheck,
      AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
    };

    run([join(alphaZero.portableDirectory, "install.sh")], environment);
    writeExecutable(
      join(installRoot, "versions/2.0.0-alpha.0/afternote"),
      `#!/bin/sh
if [ "\${1:-}" = claude-desktop ] && [ "\${2:-}" = status ]; then
  printf '%s\n' "\${AFTERNOTE_TEST_CLAUDE_DESKTOP_STATUS:-{\"configHealthy\": true}}"
  exit 0
fi
exit 1
`,
    );
    for (const status of [
      '{"configHealthy": true}',
      '{"configHealthy": false, "problemCode": "connector_disabled"}',
    ]) {
      const result = Bun.spawnSync(
        [join(alphaZero.portableDirectory, "uninstall.sh")],
        {
          env: {
            ...environment,
            AFTERNOTE_TEST_CLAUDE_DESKTOP_STATUS: status,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "Remove Afternote in Claude Desktop Settings > Extensions",
      );
      expect(existsSync(installRoot)).toBe(true);
    }
  }, 30_000);

  it("rejects unsafe lifecycle roots and leaves unrelated files untouched", () => {
    const home = join(directory, "unsafe-home");
    mkdirSync(home, { recursive: true });
    const result = Bun.spawnSync([join(alphaZero.portableDirectory, "install.sh")], {
      env: {
        ...baseEnvironment(),
        HOME: home,
        AFTERNOTE_INSTALL_ROOT: home,
        AFTERNOTE_BIN_ROOT: join(home, ".local/bin"),
        AFTERNOTE_LAUNCHCTL: launchctl,
        AFTERNOTE_BROKER_HEALTHCHECK: healthcheck,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Refusing unsafe Afternote install root");
  });

  it("removes every owned runtime path after a failed fresh install", () => {
    const home = join(directory, "failed-fresh-home");
    const installRoot = join(home, "Library/Application Support/Afternote");
    const binRoot = join(home, ".local/bin");
    const failingHealthcheck = join(directory, "failing-healthcheck");
    mkdirSync(home, { recursive: true });
    writeExecutable(failingHealthcheck, "#!/bin/sh\nexit 1\n");
    const result = Bun.spawnSync([join(alphaZero.portableDirectory, "install.sh")], {
      env: {
        ...baseEnvironment(),
        HOME: home,
        AFTERNOTE_INSTALL_ROOT: installRoot,
        AFTERNOTE_BIN_ROOT: binRoot,
        AFTERNOTE_LAUNCHCTL: launchctl,
        AFTERNOTE_BROKER_HEALTHCHECK: failingHealthcheck,
        AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(installRoot)).toBe(false);
    expect(existsSync(join(binRoot, "afternote"))).toBe(false);
    expect(existsSync(join(home, "Library/LaunchAgents/dev.afternote.vault-broker.plist")))
      .toBe(false);
  });
});

function baseEnvironment(): Record<string, string> {
  return {
    LANG: process.env.LANG ?? "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function run(command: string[], environment: Record<string, string>): {
  stdout: string;
  stderr: string;
} {
  const result = Bun.spawnSync(command, {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${command.join(" ")}): ${stderr}`);
  }
  return { stdout, stderr };
}
