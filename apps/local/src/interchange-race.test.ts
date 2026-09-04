import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import { readInterchangeSnapshot } from "./interchange";
import { localVaultContext } from "./local-vault";
import { SqliteMemory } from "./sqlite-memory";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects an interchange source that grows during its bounded descriptor read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-interchange-race-"));
  directories.push(directory);
  const vaultPath = join(directory, "source.db");
  const exportPath = join(directory, "backup.afternote.json");
  const vault = localVaultContext(vaultPath);
  const memory = new SqliteMemory(vaultPath, vault);
  await memory.remember(vault, { content: "descriptor snapshot canary" });
  memory.exportInterchange(vault, exportPath, "2.0.0-test.0");
  memory.close();

  expect(() => readInterchangeSnapshot(
    exportPath,
    "2.0.0-test.0",
    () => appendFileSync(exportPath, " "),
  )).toThrow("Interchange source changed while it was read");
});

it("rejects hostile container amplification before JSON.parse builds the object graph", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-interchange-amplification-"));
  directories.push(directory);
  const exportPath = join(directory, "hostile.afternote.json");
  writeFileSync(
    exportPath,
    `[${"0,".repeat(500_000)}0]`,
    { mode: 0o600 },
  );

  expect(() => readInterchangeSnapshot(exportPath, "2.0.0-test.0"))
    .toThrow("Interchange JSON array has too many entries");
});
