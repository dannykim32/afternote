import {
  createDataProtectionKeychainVaultKey,
  readDataProtectionKeychainVaultKey,
  requireParentCodeSigningRequirement,
} from "./sqlcipher-database";
import { runVaultBrokerWorkerXpc } from "./vault-broker-worker";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverLocalEmbeddingModel } from "./local-embedding";

declare const AFTERNOTE_BUILD_VERSION: string | undefined;
declare const AFTERNOTE_GATEWAY_CODE_REQUIREMENT: string | undefined;
declare const AFTERNOTE_KEYCHAIN_ACCESS_GROUP: string | undefined;
declare const AFTERNOTE_OWNER_PRESENCE_MODE: "required" | undefined;
declare const AFTERNOTE_RELEASE_BUILD: boolean | undefined;
declare const AFTERNOTE_STANDALONE: boolean | undefined;
declare const AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE: string | undefined;

if (typeof AFTERNOTE_RELEASE_BUILD !== "boolean" || !AFTERNOTE_RELEASE_BUILD) {
  throw new Error("The public vault worker requires a release build");
}
if (AFTERNOTE_OWNER_PRESENCE_MODE !== "required") {
  throw new Error("The public vault worker requires owner presence");
}
if (
  typeof AFTERNOTE_GATEWAY_CODE_REQUIREMENT !== "string" ||
  !AFTERNOTE_GATEWAY_CODE_REQUIREMENT
) {
  throw new Error("Authorized vault broker gateway requirement is unavailable");
}
requireParentCodeSigningRequirement(AFTERNOTE_GATEWAY_CODE_REQUIREMENT);
if (
  typeof AFTERNOTE_KEYCHAIN_ACCESS_GROUP !== "string" ||
  !AFTERNOTE_KEYCHAIN_ACCESS_GROUP
) {
  throw new Error("The public vault worker requires its private Keychain group");
}
if (
  typeof AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE !== "string" ||
  !AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE
) {
  throw new Error("The public vault worker requires its private gateway service");
}

const accessGroup = AFTERNOTE_KEYCHAIN_ACCESS_GROUP;
await runVaultBrokerWorkerXpc({
  applicationVersion: typeof AFTERNOTE_BUILD_VERSION === "string"
    ? AFTERNOTE_BUILD_VERSION
    : "2.0.0-release",
  standalone: typeof AFTERNOTE_STANDALONE === "boolean" && AFTERNOTE_STANDALONE,
  ownerPresenceMode: "required",
  trustPath: "production-signed",
  vaultPath: join(homedir(), ".afternote", "vault.db"),
  vaultKeyReader: (vaultId) =>
    readDataProtectionKeychainVaultKey(vaultId, accessGroup),
  vaultKeyCreator: (vaultId) =>
    createDataProtectionKeychainVaultKey(vaultId, accessGroup),
  embeddingDiscoveryProvider: (vaultPath) => {
    const discovery = discoverLocalEmbeddingModel(vaultPath);
    return {
      model: discovery.model,
      invalid: discovery.status.state === "invalid",
    };
  },
}, {
  service: AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE,
  gatewayCodeRequirement: AFTERNOTE_GATEWAY_CODE_REQUIREMENT,
});
