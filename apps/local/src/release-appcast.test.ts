import { describe, expect, it } from "bun:test";
import {
  appcastGenerationCommand,
  assertSparkleSigningIdentity,
  assertSignedUpdateAppcast,
  releaseAssetUrlPrefix,
  releaseNotesForVersion,
  signedUpdateSignature,
} from "../../../scripts/release-appcast";

describe("signed update appcast", () => {
  it("pins release assets to the versioned GitHub release", () => {
    expect(releaseAssetUrlPrefix("2.0.0-alpha.12")).toBe(
      "https://github.com/dannykim32/afternote/releases/download/v2.0.0-alpha.12/",
    );
    expect(() => releaseAssetUrlPrefix("../../bad")).toThrow("Invalid release version");
  });

  it("invokes Sparkle with the dedicated Keychain identity and no deltas", () => {
    expect(appcastGenerationCommand({
      toolPath: "/release-deps/generate_appcast",
      account: "afternote-updates",
      outputPath: "/stage/appcast-alpha.xml",
      archiveDirectory: "/stage",
      downloadUrlPrefix: "https://example.test/releases/v1/",
    })).toEqual([
      "/release-deps/generate_appcast",
      "--account", "afternote-updates",
      "--download-url-prefix", "https://example.test/releases/v1/",
      "--embed-release-notes",
      "--maximum-versions", "10",
      "--maximum-deltas", "0",
      "-o", "/stage/appcast-alpha.xml",
      "/stage",
    ]);
  });

  it("requires the release signing account to match the public key embedded in the app", () => {
    const publicKey = "XvnOOnpqXBIE7Nq00NKD8cnMe3ZZHqLFbfykOD8tLOs=";
    expect(() => assertSparkleSigningIdentity(`${publicKey}\n`, publicKey)).not.toThrow();
    expect(() => assertSparkleSigningIdentity(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      publicKey,
    )).toThrow("does not match");
  });

  it("requires the exact signed artifact in the generated appcast", () => {
    const xml = `<?xml version="1.0"?><!-- sparkle-sign-warning: signed --><rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item>
      <sparkle:version>12</sparkle:version>
      <enclosure url="https://example.test/releases/v12/afternote.dmg" length="1234" sparkle:edSignature="${"A".repeat(86)}==" />
    </item></channel></rss><!-- sparkle-signatures:\n edSignature: ${"B".repeat(86)}==\n length: 900\n-->`;
    expect(() => assertSignedUpdateAppcast(xml, {
      artifactFilename: "afternote.dmg",
      artifactBytes: 1234,
      bundleVersion: "12",
      downloadUrlPrefix: "https://example.test/releases/v12/",
    })).not.toThrow();
    expect(signedUpdateSignature(
      xml,
      "https://example.test/releases/v12/afternote.dmg",
    )).toBe(`${"A".repeat(86)}==`);
    expect(() => assertSignedUpdateAppcast(xml.replace("sparkle-signatures", "unsigned"), {
      artifactFilename: "afternote.dmg",
      artifactBytes: 1234,
      bundleVersion: "12",
      downloadUrlPrefix: "https://example.test/releases/v12/",
    })).toThrow("feed signature");
    expect(() => assertSignedUpdateAppcast(xml.replace("length=\"1234\"", "length=\"9\""), {
      artifactFilename: "afternote.dmg",
      artifactBytes: 1234,
      bundleVersion: "12",
      downloadUrlPrefix: "https://example.test/releases/v12/",
    })).toThrow("signed release enclosure");
  });

  it("extracts only the current changelog section for release notes", () => {
    expect(releaseNotesForVersion(
      "# Changelog\n\n## 2.0.0-alpha.12\n\n- Updater.\n\n## 2.0.0-alpha.11\n\n- Earlier.\n",
      "2.0.0-alpha.12",
    )).toBe("## 2.0.0-alpha.12\n\n- Updater.\n");
  });
});
