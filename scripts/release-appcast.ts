const RELEASE_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function releaseAssetUrlPrefix(version: string): string {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return `https://github.com/dannykim32/afternote/releases/download/v${version}/`;
}

export function appcastGenerationCommand(options: {
  toolPath: string;
  account: string;
  outputPath: string;
  archiveDirectory: string;
  downloadUrlPrefix: string;
}): string[] {
  if (!options.toolPath.startsWith("/") || !options.outputPath.startsWith("/") ||
    !options.archiveDirectory.startsWith("/") ||
    !options.downloadUrlPrefix.startsWith("https://") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.account)) {
    throw new Error("Invalid signed appcast generation configuration");
  }
  return [
    options.toolPath,
    "--account", options.account,
    "--download-url-prefix", options.downloadUrlPrefix,
    "--embed-release-notes",
    "--maximum-versions", "10",
    "--maximum-deltas", "0",
    "-o", options.outputPath,
    options.archiveDirectory,
  ];
}

export function assertSparkleSigningIdentity(
  commandOutput: string,
  expectedPublicKey: string,
): void {
  const actualPublicKey = commandOutput.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(expectedPublicKey) ||
    actualPublicKey !== expectedPublicKey) {
    throw new Error("Sparkle signing account does not match the public key embedded in Afternote");
  }
}

export function assertSignedUpdateAppcast(
  contents: string,
  expected: {
    artifactFilename: string;
    artifactBytes: number;
    bundleVersion: string;
    downloadUrlPrefix: string;
  },
): void {
  if (!contents.includes("<rss") || !contents.includes("xmlns:sparkle=") ||
    !contents.includes(`<sparkle:version>${expected.bundleVersion}</sparkle:version>`)) {
    throw new Error("Generated appcast does not describe the expected release version");
  }
  if (!/<!--\s*sparkle-signatures:\s*edSignature:\s*[A-Za-z0-9+/]{86}==\s*length:\s*\d+\s*-->/s
    .test(contents)) {
    throw new Error("Generated appcast is missing its feed signature");
  }
  const expectedUrl = `${expected.downloadUrlPrefix}${encodeURIComponent(expected.artifactFilename)}`;
  const enclosures = contents.match(/<enclosure\b[^>]*>/g) ?? [];
  const expectedEnclosure = enclosures.find((entry) => entry.includes(`url="${expectedUrl}"`));
  if (!expectedEnclosure ||
    !expectedEnclosure.includes(`length="${expected.artifactBytes}"`) ||
    !/sparkle:edSignature="[A-Za-z0-9+/]{86}=="/.test(expectedEnclosure)) {
    throw new Error("Generated appcast is missing the exact signed release enclosure");
  }
  if (/\burl="http:\/\//.test(contents)) {
    throw new Error("Generated appcast contains an insecure download URL");
  }
}

export function releaseNotesForVersion(changelog: string, version: string): string {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const marker = `## ${version}`;
  const start = changelog.indexOf(marker);
  if (start < 0) throw new Error(`CHANGELOG is missing ${version}`);
  const next = changelog.indexOf("\n## ", start + marker.length);
  const section = changelog.slice(start, next < 0 ? undefined : next).trim();
  if (!section.includes("\n- ")) {
    throw new Error(`CHANGELOG section for ${version} has no release notes`);
  }
  return `${section}\n`;
}

export function signedUpdateSignature(contents: string, artifactUrl: string): string {
  const enclosure = (contents.match(/<enclosure\b[^>]*>/g) ?? [])
    .find((entry) => entry.includes(`url="${artifactUrl}"`));
  const signature = enclosure?.match(
    /sparkle:edSignature="([A-Za-z0-9+/]{86}==)"/,
  )?.[1];
  if (!signature) throw new Error("Generated appcast is missing the update signature");
  return signature;
}
