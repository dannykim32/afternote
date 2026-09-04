import { describe, expect, test } from "bun:test";
import { packagesFromBunLock, queryOsv } from "./audit-lockfile";

describe("lockfile dependency audit", () => {
  test("extracts unique resolved registry packages and excludes workspaces", () => {
    const packages = packagesFromBunLock(`
      "@afternote/local": ["@afternote/local@workspace:apps/local"],
      "zod": ["zod@4.4.3", "", {}, "sha512-test"],
      "@scope/library": ["@scope/library@1.2.3", "", {}, "sha512-test"],
      "zod/duplicate": ["zod@4.4.3", "", {}, "sha512-test"],
    `);
    expect(packages).toEqual([
      { name: "@scope/library", version: "1.2.3" },
      { name: "zod", version: "4.4.3" },
    ]);
  });

  test("maps OSV results back to the exact locked package", async () => {
    const packages = [{ name: "sharp", version: "0.35.3" }];
    const fakeFetch = async () => new Response(JSON.stringify({
      results: [{ vulns: [{ id: "GHSA-example" }] }],
    }), { status: 200 });
    expect(await queryOsv(packages, fakeFetch)).toEqual([{
      package: packages[0],
      vulnerabilities: [{ id: "GHSA-example" }],
    }]);
  });

  test("fails closed when OSV returns an incomplete batch", async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ results: [] }), {
      status: 200,
    });
    expect(queryOsv([{ name: "zod", version: "4.4.3" }], fakeFetch))
      .rejects.toThrow("incomplete response");
  });
});
