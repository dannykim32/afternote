import { VAULT_BROKER_IDENTIFIER } from "../apps/local/src/vault-broker-metadata";

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
  options: { teamId: string; accessGroup: string; identifier: string },
): string {
  const keychainGroups = kind === "worker" || kind === "client-signer"
    ? `\n<key>keychain-access-groups</key><array><string>${options.accessGroup}</string></array>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>${options.teamId}.${options.identifier}</string>${keychainGroups}
</dict></plist>
`;
}
