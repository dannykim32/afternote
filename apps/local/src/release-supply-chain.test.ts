import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BUN_EMBEDDED_COMPONENTS,
  bundledPackageRoots,
  npmPackagePurl,
} from "../../../scripts/release-supply-chain";

const directories: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "../../..");

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release supply-chain inventory", () => {
  it("accounts for Bun's statically linked LGPL JavaScriptCore component", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../scripts/release-supply-chain.ts"),
      "utf8",
    );
    expect(source).toContain('name: "JavaScriptCore (Bun runtime component)"');
    expect(source).toContain('license: "LGPL-2.1-only"');
    expect(source).toContain('licenseFilename: "LGPL-2.1.txt"');
  });

  it("accounts for the pinned Sparkle update framework", () => {
    const source = readFileSync(
      join(import.meta.dir, "../../../scripts/release-supply-chain.ts"),
      "utf8",
    );
    expect(source).toContain('name: "Sparkle"');
    expect(source).toContain('licenseFilename: "SPARKLE_LICENSE.txt"');
    expect(source).toContain("sparkleVersion");
  });

  it("enumerates every linked library and embedded polyfill named by pinned Bun", () => {
    expect(BUN_EMBEDDED_COMPONENTS.length).toBe(47);
    expect(BUN_EMBEDDED_COMPONENTS.map(({ name }) => name)).toContain("BoringSSL");
    expect(BUN_EMBEDDED_COMPONENTS.map(({ name }) => name)).toContain("tinycc");
    expect(BUN_EMBEDDED_COMPONENTS.map(({ name }) => name)).toContain("vm-browserify polyfill");
  });

  it("discovers every package represented by Bun's bundled module graph", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-sbom-"));
    directories.push(directory);
    const metafile = join(directory, "meta.json");
    const dependencyBase = join(repositoryRoot, "packages/mcp");
    const serverInput = Bun.resolveSync("@modelcontextprotocol/server", dependencyBase);
    const packageInputs = [
      Bun.resolveSync("zod", dependencyBase),
      serverInput,
      Bun.resolveSync("@modelcontextprotocol/core", dirname(serverInput)),
    ];
    writeFileSync(metafile, JSON.stringify({
      inputs: Object.fromEntries([
        ["apps/local/src/main-release.ts", {}],
        ...packageInputs.map((path) => [relative(repositoryRoot, path), {}]),
      ]),
    }));

    const names = bundledPackageRoots(repositoryRoot, [metafile]).map((root) =>
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name
    );
    expect(names).toEqual([
      "@modelcontextprotocol/core",
      "@modelcontextprotocol/server",
      "zod",
    ]);
  });

  it("fails when a bundled package has no installed metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-sbom-missing-"));
    directories.push(directory);
    const metafile = join(directory, "meta.json");
    writeFileSync(metafile, JSON.stringify({
      inputs: { "node_modules/not-installed/index.js": {} },
    }));
    expect(() => bundledPackageRoots(repositoryRoot, [metafile]))
      .toThrow("Bundled package metadata is missing");
  });

  it("emits valid npm purls for scoped and unscoped packages", () => {
    expect(npmPackagePurl("@huggingface/transformers", "3.8.1")).toBe(
      "pkg:npm/%40huggingface/transformers@3.8.1",
    );
    expect(npmPackagePurl("zod", "4.4.3")).toBe("pkg:npm/zod@4.4.3");
  });
});
