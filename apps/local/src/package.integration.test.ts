import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  acceptanceBrokerMachService,
  buildLocalAlpha,
  developmentOwnerPresenceBypass,
  desktopRuntimeEntries,
  releaseWorkerEntrypoint,
  renderPackagingText,
  signedRequirement,
  type LocalAlphaArtifacts,
} from "../../../scripts/build-local-alpha";

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
    writeExecutable(launchctl, "#!/bin/sh\nexit 0\n");
    writeExecutable(healthcheck, "#!/bin/sh\nexit 0\n");
    alphaZero = await buildLocalAlpha({
      outputDirectory: join(directory, "alpha-zero"),
      version: "2.0.0-alpha.0",
    });
    alphaOne = await buildLocalAlpha({
      outputDirectory: join(directory, "alpha-one"),
      version: "2.0.0-alpha.1",
    });
  }, 90_000);

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("contains only the declared Codex and Claude public surface", () => {
    const help = run([alphaZero.binaryPath, "help"], baseEnvironment()).stdout;
    expect(help).toContain("mcp --client codex|claude");
    expect(help).toContain("codex install|status|remove|rotate-identity");
    expect(help).toContain("claude-code install|status|remove|rotate-identity");
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
    run([join(alphaOne.portableDirectory, "install.sh")], environment);
    expect(readlinkSync(join(installRoot, "current"))).toBe("versions/2.0.0-alpha.1");
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
