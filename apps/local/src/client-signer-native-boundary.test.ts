import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const source = readFileSync(
  join(import.meta.dir, "../native/client_signer.mm"),
  "utf8",
);

describe("native client signer boundary", () => {
  it("pins parent identity and an explicit connector-only Keychain group", () => {
    expect(source).toContain("AFTERNOTE_ALLOWED_PARENT_CODE_REQUIREMENT");
    expect(source).toContain("SecCodeCheckValidity(parent, kSecCSStrictValidate");
    expect(source).toContain("AFTERNOTE_CLIENT_KEYCHAIN_ACCESS_GROUP");
    expect(source).toContain("kSecAttrAccessGroup");
    expect(source).toContain("kSecUseDataProtectionKeychain");
    expect(source).toContain("kSecAttrTokenIDSecureEnclave");
    for (const prefix of [
      "dev.afternote.mcp-client.codex.",
      "dev.afternote.mcp-client.claude.",
      "dev.afternote.mcp-client.claude-desktop.",
    ]) {
      expect(source).toContain(prefix);
    }
  });

  it("has no vault, database, network, shell, or generic process-launch surface", () => {
    for (const prohibited of [
      "vault-key",
      "Sqlite",
      "sqlcipher",
      "NSURLSession",
      "WebSocket",
      "system(",
      "popen(",
      "posix_spawn",
      "NSTask",
    ]) {
      expect(source).not.toContain(prohibited);
    }
  });
});
