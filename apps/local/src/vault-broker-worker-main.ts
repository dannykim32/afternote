import { runVaultBrokerWorkerXpc } from "./vault-broker-worker";
import {
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { requireParentCodeSigningRequirement } from "./sqlcipher-database";
import {
  developmentVaultKeyPath,
  getOrCreateDevelopmentVaultKey,
} from "./development-vault-key";
import { discoverLocalEmbeddingModel } from "./local-embedding";
import localPackage from "../package.json";

declare const AFTERNOTE_BUILD_VERSION: string | undefined;
declare const AFTERNOTE_BROKER_TESTING: boolean | undefined;
declare const AFTERNOTE_GATEWAY_CODE_REQUIREMENT: string | undefined;
declare const AFTERNOTE_RELEASE_BUILD: boolean | undefined;
declare const AFTERNOTE_STANDALONE: boolean | undefined;
declare const AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE: string | undefined;
declare const AFTERNOTE_OWNER_PRESENCE_MODE:
  | "required"
  | "development-bypass"
  | undefined;

const applicationVersion =
  typeof AFTERNOTE_BUILD_VERSION === "string"
    ? AFTERNOTE_BUILD_VERSION
    : `${localPackage.version}-dev`;
const gatewayCodeRequirement =
  typeof AFTERNOTE_GATEWAY_CODE_REQUIREMENT === "string"
    ? AFTERNOTE_GATEWAY_CODE_REQUIREMENT
    : typeof AFTERNOTE_BROKER_TESTING === "boolean" &&
        AFTERNOTE_BROKER_TESTING
      ? process.env.AFTERNOTE_TEST_GATEWAY_CODE_REQUIREMENT
      : undefined;
if (!gatewayCodeRequirement) {
  throw new Error("Authorized vault broker gateway requirement is unavailable");
}
requireParentCodeSigningRequirement(gatewayCodeRequirement);
const workerGatewayService =
  typeof AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE === "string"
    ? AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE
    : typeof AFTERNOTE_BROKER_TESTING === "boolean" && AFTERNOTE_BROKER_TESTING
      ? process.env.AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE
      : undefined;
if (!workerGatewayService) {
  throw new Error("Private worker gateway service is unavailable");
}

const testKeyPath =
  typeof AFTERNOTE_BROKER_TESTING === "boolean" &&
  AFTERNOTE_BROKER_TESTING &&
  process.env.AFTERNOTE_TEST_VAULT_KEY_PATH
    ? process.env.AFTERNOTE_TEST_VAULT_KEY_PATH
    : undefined;
const testCloseFailurePath =
  typeof AFTERNOTE_BROKER_TESTING === "boolean" &&
  AFTERNOTE_BROKER_TESTING &&
  process.env.AFTERNOTE_TEST_VAULT_CLOSE_FAILURE_PATH
    ? process.env.AFTERNOTE_TEST_VAULT_CLOSE_FAILURE_PATH
    : undefined;
const ownerPresenceMode =
  typeof AFTERNOTE_OWNER_PRESENCE_MODE === "string"
    ? AFTERNOTE_OWNER_PRESENCE_MODE
    : "required";
if (
  ownerPresenceMode === "development-bypass" &&
  typeof AFTERNOTE_RELEASE_BUILD === "boolean" &&
  AFTERNOTE_RELEASE_BUILD
) {
  throw new Error("Release broker cannot use the development vault-key fallback");
}
const developmentKeyPath = ownerPresenceMode === "development-bypass"
  ? developmentVaultKeyPath(homedir())
  : undefined;

await runVaultBrokerWorkerXpc(testKeyPath
  ? {
      applicationVersion,
      standalone: typeof AFTERNOTE_STANDALONE === "boolean" && AFTERNOTE_STANDALONE,
      ownerPresenceMode,
      vaultPath: process.env.AFTERNOTE_VAULT_PATH,
      vaultKeyProvider: () => readFileSync(testKeyPath),
      // Only the compile-time test branch can inject asynchronous preparation.
      embeddingModelProvider: () => {
        if (!existsSync(`${testKeyPath}.semantic`)) return null;
        if (process.env.AFTERNOTE_TEST_MODEL_DIRECTORY) {
          return discoverLocalEmbeddingModel(process.env.AFTERNOTE_VAULT_PATH!, {
            bundledModelPath: process.env.AFTERNOTE_TEST_MODEL_DIRECTORY,
          }).model;
        }
        return {
        descriptor: {id: "native-startup-fixture", revision: "1", dimensions: 2},
        minimumSimilarity: 2,
        prepare: async () => { await Bun.sleep(25); },
        embed: async (texts) => { await Bun.sleep(25); return texts.map(() => new Float32Array([1, 0])); },
        };
      },
      onVaultHandleClosedForTest: testCloseFailurePath
        ? (handle) => {
            if (handle !== "memory" || !existsSync(testCloseFailurePath)) return;
            unlinkSync(testCloseFailurePath);
            throw new Error("Injected acceptance close failure");
          }
        : undefined,
      trustPath: "development-only",
    }
  : {
      applicationVersion,
      standalone: typeof AFTERNOTE_STANDALONE === "boolean" && AFTERNOTE_STANDALONE,
      ownerPresenceMode,
      vaultKeyProvider: developmentKeyPath
        ? () => getOrCreateDevelopmentVaultKey(developmentKeyPath)
        : undefined,
      embeddingDiscoveryProvider: (vaultPath) => {
        const discovery = discoverLocalEmbeddingModel(vaultPath);
        return {
          model: discovery.model,
          invalid: discovery.status.state === "invalid",
        };
      },
      trustPath: typeof AFTERNOTE_RELEASE_BUILD === "boolean" && AFTERNOTE_RELEASE_BUILD
        ? "production-signed"
        : "development-only",
    }, {
  service: workerGatewayService,
  gatewayCodeRequirement,
});
