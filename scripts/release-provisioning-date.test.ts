import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import {
  assertReleaseProvisioningProfile,
  readProvisioningExpirationDate,
} from "./build-local-alpha";

it("reads provisioning expiration as UTC rather than locale-dependent display text", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-profile-date-"));
  const path = join(directory, "profile.plist");
  const options = {
    teamId: "ABCDEFGHIJ",
    identifier: "dev.afternote.worker",
    accessGroup: "ABCDEFGHIJ.dev.afternote.vault-key",
    now: new Date("2026-09-23T00:00:00Z"),
  };
  const profile = {
    TeamIdentifier: [options.teamId],
    Platform: ["OSX"],
    ProvisionsAllDevices: true,
    DeveloperCertificateType: "developer-id-application",
    Entitlements: {
      "com.apple.application-identifier": `${options.teamId}.${options.identifier}`,
      "keychain-access-groups": [options.accessGroup],
    },
  };
  const writeExpiration = (xml: string) => writeFileSync(path,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>ExpirationDate</key>${xml}</dict></plist>`);
  try {
    writeExpiration("<date>2044-08-27T20:50:42Z</date>");
    const expiration = readProvisioningExpirationDate(path);
    expect(expiration).toBe("2044-08-27T20:50:42Z");
    expect(() => assertReleaseProvisioningProfile({
      ...profile, ExpirationDate: expiration,
    }, options)).not.toThrow();
    writeExpiration("<date>2020-01-01T00:00:00Z</date>");
    expect(() => assertReleaseProvisioningProfile({
      ...profile, ExpirationDate: readProvisioningExpirationDate(path),
    }, options)).toThrow("expired");
    writeExpiration("<string>2044-08-27T20:50:42Z</string>");
    expect(() => readProvisioningExpirationDate(path)).toThrow();
    writeFileSync(path, "not a plist");
    expect(() => readProvisioningExpirationDate(path)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
