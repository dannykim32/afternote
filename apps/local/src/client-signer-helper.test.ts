import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  invokeClientSignerHelper,
  rawP256PublicKeyToPem,
} from "./client-signer-helper";

const generatedPublicKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).publicKey.export({ type: "spki", format: "der" });
const rawPublicKey = generatedPublicKey.subarray(generatedPublicKey.length - 65);

describe("client signer helper boundary", () => {
  it("verifies the helper before requesting a public key", () => {
    const commands: string[][] = [];
    const result = invokeClientSignerHelper("public-key", "dev.afternote.mcp-client.codex.123", undefined, {
      helperPath: "/tmp/AfternoteClientSigner.app/Contents/MacOS/afternote-client-signer",
      codeRequirement: 'anchor apple generic and identifier "dev.afternote.client-signer"',
      exists: () => true,
      run(command, input) {
        commands.push(command);
        expect(input).toBeUndefined();
        if (command[0] === "/usr/bin/codesign") {
          return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify({
            publicKeyRaw: rawPublicKey.toString("base64"),
          })),
          stderr: Buffer.alloc(0),
        };
      },
    });
    expect(result).toEqual({ publicKeyRaw: rawPublicKey.toString("base64") });
    expect(commands[0]).toEqual([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      '-R=anchor apple generic and identifier "dev.afternote.client-signer"',
      "/tmp/AfternoteClientSigner.app/Contents/MacOS/afternote-client-signer",
    ]);
    expect(commands[1]?.slice(1)).toEqual([
      "public-key",
      "dev.afternote.mcp-client.codex.123",
    ]);
  });

  it("passes signing bytes only on stdin and validates the response", () => {
    const result = invokeClientSignerHelper("sign", "dev.afternote.mcp-client.claude.123", "proof", {
      helperPath: "/tmp/signer",
      codeRequirement: 'identifier "dev.afternote.client-signer"',
      exists: () => true,
      run(command, input) {
        if (command[0] === "/usr/bin/codesign") {
          return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        expect(command).toEqual([
          "/tmp/signer",
          "sign",
          "dev.afternote.mcp-client.claude.123",
        ]);
        expect(input?.toString()).toBe("proof");
        return {
          exitCode: 0,
          stdout: Buffer.from(JSON.stringify({
            signature: Buffer.alloc(70, 0x30).toString("base64"),
          })),
          stderr: Buffer.alloc(0),
        };
      },
    });
    expect(result).toEqual({
      signature: Buffer.alloc(70, 0x30).toString("base64"),
    });
  });

  it("accepts a distinct Claude Desktop signing-key namespace", () => {
    const commands: string[][] = [];
    const result = invokeClientSignerHelper(
      "public-key",
      "dev.afternote.mcp-client.claude-desktop.123",
      undefined,
      {
        helperPath: "/tmp/signer",
        codeRequirement: 'identifier "dev.afternote.client-signer"',
        exists: () => true,
        run(command) {
          commands.push(command);
          if (command[0] === "/usr/bin/codesign") {
            return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
          }
          return {
            exitCode: 0,
            stdout: Buffer.from(JSON.stringify({
              publicKeyRaw: rawPublicKey.toString("base64"),
            })),
            stderr: Buffer.alloc(0),
          };
        },
      },
    );
    expect(result).toEqual({ publicKeyRaw: rawPublicKey.toString("base64") });
    expect(commands.at(-1)?.slice(1)).toEqual([
      "public-key",
      "dev.afternote.mcp-client.claude-desktop.123",
    ]);
  });

  it("rejects malformed requests and helper output", () => {
    const dependencies = {
      helperPath: "/tmp/signer",
      codeRequirement: 'identifier "dev.afternote.client-signer"',
      exists: () => true,
      run(command: string[]) {
        if (command[0] === "/usr/bin/codesign") {
          return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        return {
          exitCode: 0,
          stdout: Buffer.from('{"signature":"not base64"}'),
          stderr: Buffer.alloc(0),
        };
      },
    };
    expect(() => invokeClientSignerHelper("sign", "bad/tag", "proof", dependencies))
      .toThrow("tag is invalid");
    expect(() => invokeClientSignerHelper(
      "sign",
      "dev.afternote.mcp-client.unknown.123",
      "proof",
      dependencies,
    )).toThrow("tag is invalid");
    expect(() => invokeClientSignerHelper("sign", "dev.afternote.mcp-client.codex.123", "", dependencies))
      .toThrow("message is invalid");
    expect(() => invokeClientSignerHelper(
      "sign",
      "dev.afternote.mcp-client.codex.123",
      "proof",
      dependencies,
    )).toThrow("invalid signing response");
  });

  it("converts only uncompressed P-256 public keys", () => {
    const pem = rawP256PublicKeyToPem(rawPublicKey);
    expect(pem).toContain("BEGIN PUBLIC KEY");
    expect(() => rawP256PublicKeyToPem(Buffer.alloc(65))).toThrow(
      "invalid P-256 public key",
    );
  });
});
