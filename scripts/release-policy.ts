import {
  VAULT_BROKER_IDENTIFIER,
  clientSignerAccessGroup,
  vaultKeyAccessGroup,
} from "../apps/local/src/vault-broker-metadata";

const PACKAGE_VERSION =
  /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export type SoftwareUpdatePolicy =
  | { enabled: false }
  | {
    enabled: true;
    feedUrl: string;
    publicEdKey: string;
    automaticallyChecks: true;
    automaticallyDownloads: false;
    allowsAutomaticUpdates: false;
    sendsSystemProfile: false;
    scheduledCheckIntervalSeconds: 86_400;
    verifiesBeforeExtraction: true;
    requiresSignedFeed: true;
    signedFeedFailureExpirationIntervalSeconds: 0;
  };

export function softwareUpdatePolicy(options: {
  release: boolean;
  feedUrl?: string;
  publicEdKey?: string;
}): SoftwareUpdatePolicy {
  if (!options.release) return { enabled: false };
  if (!options.feedUrl?.startsWith("https://")) {
    throw new Error("Release software update feed must use HTTPS");
  }
  if (!options.publicEdKey || !/^[A-Za-z0-9+/]{43}=$/.test(options.publicEdKey)) {
    throw new Error("Release software update public EdDSA key is invalid");
  }
  return {
    enabled: true,
    feedUrl: options.feedUrl,
    publicEdKey: options.publicEdKey,
    automaticallyChecks: true,
    automaticallyDownloads: false,
    allowsAutomaticUpdates: false,
    sendsSystemProfile: false,
    scheduledCheckIntervalSeconds: 86_400,
    verifiesBeforeExtraction: true,
    requiresSignedFeed: true,
    signedFeedFailureExpirationIntervalSeconds: 0,
  };
}

export function releaseVersionMetadata(options: {
  rootVersion: string;
  workspaceVersions: readonly string[];
  bundleVersion: string;
  requestedVersion?: string;
  release: boolean;
}): {
  packageVersion: string;
  marketingVersion: string;
  bundleVersion: string;
} {
  const rootMatch = options.rootVersion.match(PACKAGE_VERSION);
  if (!rootMatch || options.rootVersion.length > 128) {
    throw new Error(`Invalid Afternote package version: ${options.rootVersion}`);
  }
  if (options.workspaceVersions.some((version) => version !== options.rootVersion)) {
    throw new Error("Workspace package versions must match the root package version");
  }
  const packageVersion = options.requestedVersion ?? options.rootVersion;
  const packageMatch = packageVersion.match(PACKAGE_VERSION);
  if (!packageMatch || packageVersion.length > 128) {
    throw new Error(`Invalid Afternote package version: ${packageVersion}`);
  }
  if (options.release && packageVersion !== options.rootVersion) {
    throw new Error("Public release version must match the reviewed package version");
  }
  const bundleParts = options.bundleVersion.split(".");
  if (
    bundleParts.length < 1 || bundleParts.length > 3 ||
    !bundleParts.every((part) => /^\d+$/.test(part)) ||
    bundleParts[0]!.length > 4 ||
    (bundleParts[1]?.length ?? 0) > 2 ||
    (bundleParts[2]?.length ?? 0) > 2
  ) {
    throw new Error("Apple bundle version must contain one to three bounded integers");
  }
  return {
    packageVersion,
    marketingVersion: `${packageMatch[1]}.${packageMatch[2]}.${packageMatch[3]}`,
    bundleVersion: options.bundleVersion,
  };
}

export function desktopRuntimeEntries(includeSemanticRuntime: boolean): string[] {
  return [
    "afternote",
    "afternote-vault-broker",
    "AfternoteVaultWorker.app",
    "AfternoteClientSigner.app",
    "afternote_sqlcipher.node",
    "libsqlcipher.3.dylib",
    "libcrypto.4.dylib",
    ...(includeSemanticRuntime ? ["libonnxruntime.1.21.0.dylib"] : []),
    ...(includeSemanticRuntime ? ["onnxruntime_binding.node"] : []),
    "install.sh",
    "rollback.sh",
    "uninstall.sh",
    "broker-lifecycle.sh",
    "launch-agent.plist",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "SBOM.spdx.json",
    "LICENSES",
  ];
}

export function renderPackagingText(
  contents: string,
  options: { includeSemanticRuntime: boolean; release: boolean },
): string {
  let rendered = contents.replaceAll(
    "__AFTERNOTE_RELEASE_CHANNEL__",
    options.release ? "public-alpha" : "development-alpha",
  );
  if (!options.includeSemanticRuntime) {
    rendered = rendered.replace(
      /<!-- BEGIN:semantic-runtime -->[\s\S]*?<!-- END:semantic-runtime -->\n?/g,
      "",
    );
  } else {
    rendered = rendered
      .replaceAll("<!-- BEGIN:semantic-runtime -->", "")
      .replaceAll("<!-- END:semantic-runtime -->", "");
  }
  if (options.release) {
    rendered = rendered.replace(
      /<!-- BEGIN:development-key -->[\s\S]*?<!-- END:development-key -->\n?/g,
      "",
    );
  } else {
    rendered = rendered
      .replaceAll("<!-- BEGIN:development-key -->", "")
      .replaceAll("<!-- END:development-key -->", "");
  }
  return rendered;
}

export function developmentOwnerPresenceBypass(options: {
  requested?: boolean;
  configured?: string;
  releaseBuild?: string;
}): boolean {
  if (
    options.configured !== undefined &&
    options.configured !== "0" && options.configured !== "1"
  ) {
    throw new Error(
      "AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS must be 0 or 1",
    );
  }
  const enabled = options.requested ?? options.configured === "1";
  if (enabled && options.releaseBuild === "1") {
    throw new Error("Release packaging cannot bypass owner presence");
  }
  return enabled;
}

export function releaseWorkerEntrypoint(options: {
  releaseBuild?: string;
}): string {
  return options.releaseBuild === "1"
    ? "vault-broker-release-worker-main.ts"
    : "vault-broker-worker-main.ts";
}

export function acceptanceBrokerMachService(options: {
  acceptanceBuild?: string;
  configuredService?: string;
  releaseBuild?: string;
}): string {
  const configured = options.configuredService?.trim();
  if (options.acceptanceBuild === "1" && !configured) {
    throw new Error(
      "AFTERNOTE_ACCEPTANCE_BUILD=1 requires AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE",
    );
  }
  if (!configured) return VAULT_BROKER_IDENTIFIER;
  if (options.acceptanceBuild !== "1") {
    throw new Error(
      "AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE requires AFTERNOTE_ACCEPTANCE_BUILD=1",
    );
  }
  if (options.releaseBuild === "1") {
    throw new Error("Release packaging cannot use an acceptance broker Mach service");
  }
  if (
    configured.length > 255 ||
    !/^dev\.afternote\.vault-broker\.acceptance\.[A-Za-z0-9][A-Za-z0-9.-]*$/.test(
      configured,
    )
  ) {
    throw new Error(
      "Acceptance broker Mach service must use dev.afternote.vault-broker.acceptance.<unique-suffix>",
    );
  }
  return configured;
}

export function signedRequirement(identifier: string, teamId: string): string {
  return `anchor apple generic and identifier "${identifier}" and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${teamId}"`;
}

export function resolvedPeerRequirement(options: {
  name: string;
  override: string | undefined;
  expected: string;
  release: boolean;
}): string {
  const override = options.override?.trim();
  if (options.override !== undefined && !override) {
    throw new Error(`${options.name} cannot be empty`);
  }
  if (options.release && override !== undefined && override !== options.expected) {
    throw new Error(`${options.name} cannot weaken the release code requirement`);
  }
  return override ?? options.expected;
}

export function releaseEntitlements(
  kind: "client" | "worker" | "client-signer",
  options: { teamId: string; identifier: string },
): string {
  const accessGroup = kind === "worker"
    ? vaultKeyAccessGroup(options.teamId)
    : kind === "client-signer"
      ? clientSignerAccessGroup(options.teamId)
      : null;
  const keychainGroups = accessGroup
    ? `\n<key>keychain-access-groups</key><array><string>${accessGroup}</string></array>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>${options.teamId}.${options.identifier}</string>${keychainGroups}
</dict></plist>
`;
}
