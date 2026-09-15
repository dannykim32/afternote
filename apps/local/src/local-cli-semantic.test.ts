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
