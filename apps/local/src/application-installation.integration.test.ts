import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("native application installation", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-application-installation-"));
  const home = join(directory, "home");
  const appRoot = join(directory, "AfternoteFixture.app");
  const contents = join(appRoot, "Contents");
  const executableRoot = join(contents, "MacOS");
  const resourceRoot = join(contents, "Resources", "AfternoteRuntime");
  const executable = join(executableRoot, "Afternote");
  const commandLink = join(home, ".local/bin/afternote");

  beforeAll(() => {
    mkdirSync(executableRoot, { recursive: true });
    mkdirSync(resourceRoot, { recursive: true });
    writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Afternote</string>
<key>CFBundleIdentifier</key><string>dev.afternote.installation-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>AfternotePackageVersion</key><string>2.0.0-alpha.9</string>
<key>CFBundleShortVersionString</key><string>2.0.0</string>
<key>CFBundleVersion</key><string>9</string>
</dict></plist>
`);
    writeFileSync(join(directory, "main.mm"), `#import <Foundation/Foundation.h>
#import "application_installation.h"
int main(void) {
  @autoreleasepool {
    NSString *error = nil;
    if (AfternoteEnsureRuntimeInstalled(&error)) return 0;
    fprintf(stderr, "%s\\n", error.UTF8String ?: "installation failed");
    return 1;
  }
}
`);
    writeFileSync(join(resourceRoot, "install.sh"), `#!/bin/sh
set -eu
mkdir -p "$HOME/.local/bin"
ln -sfn "$HOME/Library/Application Support/Afternote/current/afternote" "$HOME/.local/bin/afternote"
`);
    chmodSync(join(resourceRoot, "install.sh"), 0o755);
    const build = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-O2",
      "-fobjc-arc",
      "-framework",
      "Foundation",
      "-framework",
      "Security",
      "-I",
      join(import.meta.dir, "../native"),
      join(import.meta.dir, "../native/application_installation.mm"),
      join(directory, "main.mm"),
      "-o",
      executable,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("restores the public command link when the private runtime is already valid", () => {
    const installRoot = join(home, "Library/Application Support/Afternote");
    const versionRoot = join(installRoot, "versions/2.0.0-alpha.9");
    mkdirSync(versionRoot, { recursive: true });
    writeFileSync(join(versionRoot, "afternote"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(versionRoot, "afternote"), 0o755);
    symlinkSync("versions/2.0.0-alpha.9", join(installRoot, "current"));

    const result = Bun.spawnSync([executable], {
      env: {
        ...process.env,
        CFFIXED_USER_HOME: home,
        HOME: home,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(commandLink)).toBe(true);
    expect(readlinkSync(commandLink))
      .toBe(join(installRoot, "current/afternote"));
  });
});
