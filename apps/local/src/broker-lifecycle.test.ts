import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

const temporaryDirectories: string[] = [];
const lifecycleScript = join(import.meta.dir, "../packaging/broker-lifecycle.sh");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("package legacy-runtime retirement", () => {
  it("uses the pre-cutover binary once and requires both bearer files to disappear", () => {
    const fixture = lifecycleFixture("success");
    writeFileSync(fixture.state, "legacy-state\n");
    writeFileSync(fixture.token, "legacy-token\n");
    writeExecutable(fixture.binary, `#!/bin/sh
set -eu
[ "\${1}" = stop ]
rm -f -- "$AFTERNOTE_RUNTIME_PATH/runtime.json" "$AFTERNOTE_RUNTIME_PATH/runtime.token"
printf 'stopped\n' > "$AFTERNOTE_TEST_LEGACY_STOP_LOG"
`);

    const result = runLegacyCleanup(fixture);

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(existsSync(fixture.state)).toBe(false);
    expect(existsSync(fixture.token)).toBe(false);
    expect(readFileSync(fixture.log, "utf8")).toBe("stopped\n");
  });

  it("refuses a symlinked legacy bearer without invoking the installed binary", () => {
    const fixture = lifecycleFixture("symlink");
    writeFileSync(fixture.state, "legacy-state\n");
    const outside = join(fixture.directory, "outside-token");
    writeFileSync(outside, "do-not-follow\n");
    symlinkSync(outside, fixture.token);
    writeExecutable(fixture.binary, `#!/bin/sh
printf 'invoked\n' > "$AFTERNOTE_TEST_LEGACY_STOP_LOG"
exit 0
`);

    const result = runLegacyCleanup(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "Refusing invalid legacy Afternote runtime state.",
    );
    expect(existsSync(fixture.log)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("do-not-follow\n");
  });
});

describe("package broker retirement", () => {
  it("fails closed when launchd still reports the broker", () => {
    const fixture = lifecycleFixture("broker-live");
    const launchctl = join(fixture.directory, "launchctl");
    writeExecutable(launchctl, `#!/bin/sh
case "\${1:-}" in
  bootout) exit 1 ;;
  print) exit 0 ;;
esac
exit 1
`);
    const result = runBrokerBootout(fixture, launchctl);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("still running after launchd bootout");
  });

  it("accepts an already absent broker", () => {
    const fixture = lifecycleFixture("broker-absent");
    const launchctl = join(fixture.directory, "launchctl");
    writeExecutable(launchctl, "#!/bin/sh\nexit 1\n");
    const result = runBrokerBootout(fixture, launchctl);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });
});

function lifecycleFixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `afternote-legacy-${name}-`));
  temporaryDirectories.push(directory);
  const home = join(directory, "home");
  const installRoot = join(directory, "install");
  const runtimePath = join(directory, "runtime");
  const binary = join(installRoot, "current", "afternote");
  mkdirSync(join(installRoot, "current"), { recursive: true });
  mkdirSync(runtimePath, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    binary,
    directory,
    home,
    installRoot,
    log: join(directory, "stop.log"),
    runtimePath,
    state: join(runtimePath, "runtime.json"),
    token: join(runtimePath, "runtime.token"),
  };
}

function runLegacyCleanup(fixture: ReturnType<typeof lifecycleFixture>) {
  return Bun.spawnSync([
    "/bin/sh",
    "-c",
    'install_root="$AFTERNOTE_INSTALL_ROOT"; . "$1"; stop_legacy_runtime "$AFTERNOTE_INSTALL_ROOT/current/afternote"',
    "afternote-legacy-cleanup",
    lifecycleScript,
  ], {
    env: {
      ...process.env,
      HOME: fixture.home,
      AFTERNOTE_INSTALL_ROOT: fixture.installRoot,
      AFTERNOTE_RUNTIME_PATH: fixture.runtimePath,
      AFTERNOTE_TEST_LEGACY_STOP_LOG: fixture.log,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function runBrokerBootout(
  fixture: ReturnType<typeof lifecycleFixture>,
  launchctl: string,
) {
  return Bun.spawnSync([
    "/bin/sh",
    "-c",
    'install_root="$AFTERNOTE_INSTALL_ROOT"; . "$1"; broker_bootout',
    "afternote-broker-bootout",
    lifecycleScript,
  ], {
    env: {
      ...process.env,
      HOME: fixture.home,
      AFTERNOTE_INSTALL_ROOT: fixture.installRoot,
      AFTERNOTE_LAUNCHCTL: launchctl,
      AFTERNOTE_BROKER_HEALTH_ATTEMPTS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}
