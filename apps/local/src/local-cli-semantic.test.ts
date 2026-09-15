import { expect, it, spyOn } from "bun:test";
import { runLocalCli } from "./local-cli";

it("keeps semantic install stdout machine-readable and status read-only", async () => {
  const status = { state: "ready", modelId: "fixture", revision: "1", dtype: "q8", dimensions: 384, bytes: 23_557_430, reason: null };
  let downloads = 0;
  const runtime = { open: () => null, status: () => status, acquire: async () => { downloads++; return status; }, help: "fixture" };
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    await runLocalCli(["semantic", "status"], runtime);
    expect(downloads).toBe(0);
    await runLocalCli(["semantic", "install"], runtime);
    expect(downloads).toBe(1);
    expect(stdout.mock.calls).toHaveLength(2);
    for (const call of stdout.mock.calls) expect(JSON.parse(call[0])).toEqual(status);
    expect(stderr.mock.calls).toHaveLength(1);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});


it("validates model choices before download and exposes the read-only catalog", async () => {
  const selected: unknown[] = [];
  const catalog = { selected: "balanced", models: [] };
  const runtime = { open: () => null, status: () => ({}), catalog: () => catalog,
    acquire: async (_path: string, options?: { profile?: string }) => { selected.push(options?.profile); return {}; }, help: "fixture" };
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    await runLocalCli(["semantic", "catalog"], runtime);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual(catalog);
    expect(selected).toEqual([]);
    await runLocalCli(["semantic", "install", "large"], runtime);
    expect(selected).toEqual(["large"]);
    await expect(runLocalCli(["semantic", "install", "https://example.com/model"], runtime)).rejects.toThrow();
    await expect(runLocalCli(["semantic", "status", "large"], runtime)).rejects.toThrow();
    expect(selected).toEqual(["large"]);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});
