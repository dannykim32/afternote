import { createHash } from "node:crypto";

const RELEASE_ENVIRONMENT_KEYS = [
  "AFTERNOTE_CLIENT_SIGNER_PROVISIONING_PROFILE",
  "AFTERNOTE_KEYCHAIN_ACCESS_GROUP",
  "AFTERNOTE_NOTARY_KEYCHAIN_PROFILE",
  "AFTERNOTE_PROVISIONING_PROFILE",
  "AFTERNOTE_RELEASE_BUILD",
  "AFTERNOTE_RELEASE_DEPENDENCY_TREE_SHA256",
  "AFTERNOTE_SIGNING_IDENTITY",
  "AFTERNOTE_TEAM_ID",
  "HOME",
  "TMPDIR",
] as const;

export const REJECTED_RELEASE_ENVIRONMENT = [
  "AFTERNOTE_PACKAGE_VERSION",
  "BUN_CONFIG_VERBOSE_FETCH",
  "BUN_INSTALL",
  "BUN_OPTIONS",
  "CC",
  "CFLAGS",
  "CPATH",
  "CPP",
  "CPPFLAGS",
  "CPLUS_INCLUDE_PATH",
  "CXX",
  "CXXFLAGS",
  "DEVELOPER_DIR",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LDFLAGS",
  "LIBRARY_PATH",
  "MACOSX_DEPLOYMENT_TARGET",
  "NODE_OPTIONS",
  "SDKROOT",
] as const;

export function assertSafeReleaseEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): void {
  const rejected = Object.keys(source).filter((key) =>
    (REJECTED_RELEASE_ENVIRONMENT as readonly string[]).includes(key) ||
      key.startsWith("BUN_CONFIG_"),
  );
  if (rejected.length > 0) {
    throw new Error(`Release environment contains rejected build inputs: ${rejected.sort().join(", ")}`);
  }
}

export function releaseCommandEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  assertSafeReleaseEnvironment(source);
  const environment: Record<string, string> = {
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  for (const key of RELEASE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== "") environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

export function releaseEnvironmentSha256(
  environment: Readonly<Record<string, string>>,
): string {
  const nonSecret = Object.entries(environment)
    .filter(([key]) => ![
      "AFTERNOTE_NOTARY_KEYCHAIN_PROFILE",
      "AFTERNOTE_SIGNING_IDENTITY",
    ].includes(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(nonSecret)).digest("hex");
}
