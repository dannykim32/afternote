import { createPublicKey } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CLIENT_SIGNER_APP_NAME,
  CLIENT_SIGNER_EXECUTABLE_NAME,
} from "./vault-broker-metadata";

declare const AFTERNOTE_CLIENT_SIGNER_CODE_REQUIREMENT: string | undefined;

const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_HELPER_OUTPUT_BYTES = 16_384;

type HelperAction = "public-key" | "sign" | "delete";
type HelperResult =
  | { publicKeyRaw: string }
  | { signature: string }
  | { deleted: true };

type ProcessResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
};

type HelperDependencies = {
  helperPath?: string;
  codeRequirement?: string;
  exists?: (path: string) => boolean;
  run?: (command: string[], input?: Uint8Array) => ProcessResult;
};

export type PackagedClientSigner = {
  publicKey: string;
  signingMode: "secure-enclave";
  sign(message: string): string;
};

export function openPackagedClientSigner(tag: string): PackagedClientSigner {
  const response = invokeClientSignerHelper("public-key", tag);
  if (!("publicKeyRaw" in response)) {
    throw new Error("Afternote client signer returned an invalid public-key response");
  }
  return {
    publicKey: rawP256PublicKeyToPem(Buffer.from(response.publicKeyRaw, "base64")),
    signingMode: "secure-enclave",
    sign(message: string): string {
      const signed = invokeClientSignerHelper("sign", tag, message);
      if (!("signature" in signed)) {
        throw new Error("Afternote client signer returned an invalid signing response");
      }
      return Buffer.from(signed.signature, "base64").toString("base64url");
    },
  };
}

export function deletePackagedClientSigner(tag: string): void {
  const response = invokeClientSignerHelper("delete", tag);
  if (!("deleted" in response) || response.deleted !== true) {
    throw new Error("Afternote client signer returned an invalid deletion response");
  }
}

export function invokeClientSignerHelper(
  action: HelperAction,
  tag: string,
  message?: string,
  dependencies: HelperDependencies = {},
): HelperResult {
  assertClientSigningTag(tag);
  let input: Uint8Array | undefined;
  if (action === "sign") {
    if (!message || Buffer.byteLength(message) > MAX_MESSAGE_BYTES) {
      throw new Error("Client signing message is invalid");
    }
    input = Buffer.from(message);
  } else if (message !== undefined) {
    throw new Error("Client signer helper request has unexpected input");
  }

  const helperPath = dependencies.helperPath ?? packagedClientSignerHelperPath();
  const exists = dependencies.exists ?? isRegularNonSymlinkFile;
  if (!exists(helperPath)) {
    throw new Error("The signed Afternote client signer helper is unavailable");
  }
  const requirement = dependencies.codeRequirement ?? packagedSignerRequirement();
  assertCodeSigningRequirement(requirement);
  const run = dependencies.run ?? runProcess;
  const verification = run([
    "/usr/bin/codesign",
    "--verify",
    "--strict",
    `-R=${requirement}`,
    helperPath,
  ]);
  if (verification.exitCode !== 0) {
    throw new Error("The Afternote client signer helper failed signature verification");
  }

  const completed = run([helperPath, action, tag], input);
  if (completed.exitCode !== 0) {
    const detail = boundedText(completed.stderr, 4_096).trim();
    throw new Error(detail || "The Afternote client signer helper failed");
  }
  if (completed.stdout.byteLength === 0 ||
      completed.stdout.byteLength > MAX_HELPER_OUTPUT_BYTES) {
    throw new Error("The Afternote client signer helper returned invalid output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(completed.stdout).toString("utf8"));
  } catch (error) {
    throw new Error("The Afternote client signer helper returned invalid JSON", {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Afternote client signer helper returned an invalid response");
  }
  const record = parsed as Record<string, unknown>;
  if (action === "public-key") {
    if (
      Object.keys(record).join("\n") !== "publicKeyRaw" ||
      typeof record.publicKeyRaw !== "string" ||
      !isCanonicalBase64(record.publicKeyRaw, 65)
    ) {
      throw new Error("The Afternote client signer helper returned an invalid public-key response");
    }
    return { publicKeyRaw: record.publicKeyRaw };
  }
  if (action === "sign") {
    if (
      Object.keys(record).join("\n") !== "signature" ||
      typeof record.signature !== "string" ||
      !isCanonicalBase64(record.signature) ||
      Buffer.from(record.signature, "base64").byteLength < 64 ||
      Buffer.from(record.signature, "base64").byteLength > 80
    ) {
      throw new Error("The Afternote client signer helper returned an invalid signing response");
    }
    return { signature: record.signature };
  }
  if (
    Object.keys(record).join("\n") !== "deleted" ||
    record.deleted !== true
  ) {
    throw new Error("The Afternote client signer helper returned an invalid deletion response");
  }
  return { deleted: true };
}

export function rawP256PublicKeyToPem(raw: Uint8Array): string {
  if (raw.byteLength !== 65 || raw[0] !== 0x04) {
    throw new Error("Secure Enclave returned an invalid P-256 public key");
  }
  const spkiPrefix = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200",
    "hex",
  );
  return createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  }).export({ type: "spki", format: "pem" }).toString();
}

function packagedClientSignerHelperPath(): string {
  return join(
    dirname(process.execPath),
    CLIENT_SIGNER_APP_NAME,
    "Contents",
    "MacOS",
    CLIENT_SIGNER_EXECUTABLE_NAME,
  );
}

function packagedSignerRequirement(): string {
  const requirement = typeof AFTERNOTE_CLIENT_SIGNER_CODE_REQUIREMENT === "string"
    ? AFTERNOTE_CLIENT_SIGNER_CODE_REQUIREMENT
    : undefined;
  if (!requirement) {
    throw new Error("Client signer code-signing requirement is unavailable");
  }
  return requirement;
}

function runProcess(command: string[], input?: Uint8Array): ProcessResult {
  const result = Bun.spawnSync(command, {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function assertClientSigningTag(tag: string): void {
  if (
    !/^dev\.afternote\.mcp-client\.(?:codex|claude|claude-desktop)\.[A-Za-z0-9._:-]{1,180}$/.test(
      tag,
    )
  ) {
    throw new Error("Client signing-key tag is invalid");
  }
}

function assertCodeSigningRequirement(requirement: string): void {
  if (
    !requirement ||
    Buffer.byteLength(requirement) > 4_096 ||
    /[\0\r\n]/.test(requirement)
  ) {
    throw new Error("Client signer code-signing requirement is invalid");
  }
}

function isCanonicalBase64(value: string, expectedBytes?: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return (expectedBytes === undefined || decoded.byteLength === expectedBytes) &&
    decoded.toString("base64") === value;
}

function isRegularNonSymlinkFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink();
}

function boundedText(value: Uint8Array, maximumBytes: number): string {
  return Buffer.from(value.subarray(0, maximumBytes)).toString("utf8");
}
