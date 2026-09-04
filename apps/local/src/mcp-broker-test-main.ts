import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { runBrokerMcpAdapter } from "./mcp-broker-adapter";

const service = process.env.AFTERNOTE_BROKER_MACH_SERVICE;
const clientStatePath = process.env.AFTERNOTE_TEST_CLIENT_STATE_PATH;
const privateKeyPath = process.env.AFTERNOTE_TEST_CLIENT_PRIVATE_KEY_PATH;
const codeRequirement = process.env.AFTERNOTE_TEST_BROKER_CODE_REQUIREMENT;
const hostCodeRequirement = process.env.AFTERNOTE_TEST_HOST_CODE_REQUIREMENT;
if (
  !service ||
  !clientStatePath ||
  !privateKeyPath ||
  !codeRequirement
) {
  throw new Error("Broker MCP test configuration is incomplete");
}
const privateKey = createPrivateKey(readFileSync(privateKeyPath));
const publicKey = createPublicKey(privateKey)
  .export({ type: "spki", format: "pem" })
  .toString();

await runBrokerMcpAdapter("codex", {
  service,
  clientStatePath,
  codeRequirement,
  ...(hostCodeRequirement ? { hostCodeRequirement } : {}),
  signer: {
    publicKey,
    signingMode: "development-exact-build",
    sign(message) {
      return sign("sha256", Buffer.from(message), privateKey).toString("base64url");
    },
  },
});
