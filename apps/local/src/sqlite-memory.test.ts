import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MAX_NOTE_CHARACTERS,
  MAX_SOURCE_LABEL_CHARACTERS,
  MemoryError,
} from "@afternote/memory";
import type { VaultContext } from "@afternote/memory";
import type { InterchangeDocument } from "./interchange";
import type { TextEmbeddingModel } from "./retrieval";
import { SqliteMemory } from "./sqlite-memory";

const localVault: VaultContext = {
  vaultId: "a".repeat(64),
  deployment: "local",
};

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteMemory interchange", () => {
  it("rejects non-contiguous revision history before creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-revision-gap-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "revision-gap.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, { content: "Revision one." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const invalid = JSON.parse(readFileSync(exportPath, "utf8")) as {
      notes: Array<{
        currentRevision: number;
        revisions: Array<{ revision: number }>;
      }>;
    };
    invalid.notes[0]!.currentRevision = 2;
    invalid.notes[0]!.revisions[0]!.revision = 2;
    writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("contiguous from 1");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects oversized imported source metadata before creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-source-import-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "source.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, {
      content: "One sourced note.",
      source: { label: "Bounded" },
    });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const invalid = JSON.parse(readFileSync(exportPath, "utf8")) as {
      notes: Array<{
        revisions: Array<{ source: { label: string } }>;
      }>;
    };
    invalid.notes[0]!.revisions[0]!.source.label = "x".repeat(201);
    writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("source.label cannot exceed 200 characters");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects a false manifest count before creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-manifest-count-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "manifest.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, { content: "One manifest note." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const invalid = JSON.parse(readFileSync(exportPath, "utf8")) as {
      manifest: { noteCount: number };
    };
    invalid.manifest.noteCount = 2;
    writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("manifest note count 2 does not match 1");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects unknown interchange fields before creating a vault", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-unknown-field-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "unknown-field.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const unknown = JSON.parse(readFileSync(exportPath, "utf8")) as Record<
      string,
      unknown
    >;
    unknown.unexpected = true;
    writeFileSync(exportPath, `${JSON.stringify(unknown)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow('unknown field "unexpected"');
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects an export from a newer application major before creating a vault", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-newer-application-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "future-app.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const future = JSON.parse(readFileSync(exportPath, "utf8")) as {
      applicationVersion: string;
    };
    future.applicationVersion = "3.0.0";
    writeFileSync(exportPath, `${JSON.stringify(future)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("newer application major 3");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects duplicate JSON object keys before creating a vault", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-duplicate-key-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "duplicate-key.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const duplicateKey = readFileSync(exportPath, "utf8").replace(
      '  "format": "afternote-vault",',
      '  "format": "wrong",\n  "format": "afternote-vault",',
    );
    writeFileSync(exportPath, duplicateKey);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow('Duplicate JSON object key "format"');
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects non-normalized durable timestamps before creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-timestamp-import-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "timestamp.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, { content: "Timestamped revision." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const invalid = JSON.parse(readFileSync(exportPath, "utf8")) as {
      notes: Array<{ createdAt: string }>;
    };
    invalid.notes[0]!.createdAt = "2026-08-26";
    writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("normalized ISO timestamp");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects noncanonical or impossible source timestamps during restore", async () => {
    for (const sourceTimestamp of [
      "2026-08-28T11:45:00-06:00",
      "last Friday",
      "2026-02-30T12:00:00.000Z",
    ]) {
      const directory = mkdtempSync(join(tmpdir(), "afternote-source-time-import-"));
      tempDirectories.push(directory);
      const exportPath = join(directory, "source-time.afternote.json");
      const destinationPath = join(directory, "restored.db");
      const memory = new SqliteMemory(join(directory, "source.db"), localVault);
      await memory.remember(localVault, {
        content: "Timestamped connector evidence.",
        source: { timestamp: "2026-08-28T17:45:00.000Z" },
      });
      memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
      memory.close();
      const invalid = JSON.parse(readFileSync(exportPath, "utf8")) as {
        notes: Array<{ revisions: Array<{ source: { timestamp: string } }> }>;
      };
      invalid.notes[0]!.revisions[0]!.source.timestamp = sourceTimestamp;
      writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

      expect(() =>
        SqliteMemory.restoreInterchange(
          exportPath,
          destinationPath,
          localVault,
          "2.0.0-alpha.0",
        ),
      ).toThrow("source.timestamp must be a normalized ISO timestamp");
      expect(existsSync(destinationPath)).toBe(false);
    }
  });

  it("rejects a missing current revision before creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-current-revision-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "missing-current.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, { content: "Revision one exists." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const invalid = JSON.parse(readFileSync(exportPath, "utf8")) as {
      notes: Array<{ currentRevision: number }>;
    };
    invalid.notes[0]!.currentRevision = 2;
    writeFileSync(exportPath, `${JSON.stringify(invalid)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("current revision 2");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects an oversized imported revision before creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-oversized-import-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "oversized.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, { content: "A bounded revision." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const oversized = JSON.parse(readFileSync(exportPath, "utf8")) as {
      notes: Array<{ revisions: Array<{ content: string }> }>;
    };
    oversized.notes[0]!.revisions[0]!.content = "x".repeat(100_001);
    writeFileSync(exportPath, `${JSON.stringify(oversized)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("cannot exceed 100000 characters");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects duplicate revisions before creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-duplicate-revision-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "duplicate-revision.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, { content: "One exported revision." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const duplicate = JSON.parse(readFileSync(exportPath, "utf8")) as {
      notes: Array<{ revisions: unknown[] }>;
    };
    duplicate.notes[0]!.revisions.push(
      structuredClone(duplicate.notes[0]!.revisions[0]),
    );
    writeFileSync(exportPath, `${JSON.stringify(duplicate, null, 2)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("Duplicate revision 1");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects duplicate note IDs before creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-duplicate-note-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "duplicate.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, { content: "One exported note." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const duplicate = JSON.parse(readFileSync(exportPath, "utf8")) as {
      notes: unknown[];
    };
    duplicate.notes.push(structuredClone(duplicate.notes[0]));
    writeFileSync(exportPath, `${JSON.stringify(duplicate, null, 2)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("Duplicate note id");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects a newer interchange schema before creating a vault", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-newer-interchange-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "future.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();
    const future = JSON.parse(readFileSync(exportPath, "utf8")) as {
      schemaVersion: number;
    };
    (future as { schemaVersion: number }).schemaVersion = 3;
    writeFileSync(exportPath, `${JSON.stringify(future, null, 2)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("newer interchange schema version 3");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("rejects a checksum-mismatched restore without creating a vault", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-checksum-restore-"));
    tempDirectories.push(directory);
    const sourceVaultPath = join(directory, "source.db");
    const exportPath = join(directory, "source.afternote.json");
    const destinationPath = join(directory, "restored.db");
    const memory = new SqliteMemory(sourceVaultPath, localVault);
    await memory.remember(localVault, { content: "Untampered export text." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();

    const tampered = JSON.parse(readFileSync(exportPath, "utf8")) as {
      notes: Array<{ revisions: Array<{ content: string }> }>;
    };
    tampered.notes[0]!.revisions[0]!.content = "Tampered after export.";
    writeFileSync(exportPath, `${JSON.stringify(tampered, null, 2)}\n`);

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("checksum");
    expect(existsSync(destinationPath)).toBe(false);
  });

  it("exports deterministic lossless JSON with every note revision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-interchange-export-"));
    tempDirectories.push(directory);
    const memory = new SqliteMemory(join(directory, "vault.db"), localVault);
    const note = await memory.remember(localVault, {
      content: "The original exact export text.",
      source: {
        application: "Afternote Local",
        label: "Export proof",
        timestamp: "2026-03-20T08:30:00-06:00",
      },
    });
    await memory.updateNote(localVault, note.id, {
      content: "The edited exact export text.",
      expectedRevision: 1,
      source: {
        application: "Afternote Local",
        label: "Export proof revised",
        timestamp: "2026-08-26T12:34:56.789Z",
      },
    });

    const firstPath = join(directory, "first.afternote.json");
    const secondPath = join(directory, "second.afternote.json");
    memory.exportInterchange(localVault, firstPath, "2.0.0-alpha.0");
    memory.exportInterchange(localVault, secondPath, "2.0.0-alpha.0");
    memory.close();

    const first = readFileSync(firstPath, "utf8");
    expect(readFileSync(secondPath, "utf8")).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      format: "afternote-vault",
      schemaVersion: 1,
      applicationVersion: "2.0.0-alpha.0",
      notes: [
        {
          id: note.id,
          currentRevision: 2,
          revisions: [
            {
              revision: 1,
              content: "The original exact export text.",
              source: {
                application: "Afternote Local",
                label: "Export proof",
                timestamp: "2026-03-20T14:30:00.000Z",
              },
            },
            {
              revision: 2,
              content: "The edited exact export text.",
              source: {
                application: "Afternote Local",
                label: "Export proof revised",
                timestamp: "2026-08-26T12:34:56.789Z",
              },
            },
          ],
        },
      ],
      manifest: {
        algorithm: "sha256",
        noteCount: 1,
        revisionCount: 2,
        payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const parsed = JSON.parse(first) as InterchangeDocument;
    const reorderedPath = join(directory, "reordered.afternote.json");
    writeFileSync(
      reorderedPath,
      JSON.stringify({
        manifest: parsed.manifest,
        notes: parsed.notes.map((exportedNote) => ({
          revisions: exportedNote.revisions.map((revision) => ({
            createdAt: revision.createdAt,
            source: revision.source
              ? Object.fromEntries(Object.entries(revision.source).reverse())
              : null,
            content: revision.content,
            revision: revision.revision,
            noteId: revision.noteId,
          })),
          updatedAt: exportedNote.updatedAt,
          createdAt: exportedNote.createdAt,
          currentRevision: exportedNote.currentRevision,
          id: exportedNote.id,
        })),
        applicationVersion: parsed.applicationVersion,
        schemaVersion: parsed.schemaVersion,
        format: parsed.format,
      }),
    );

    const restoredPath = join(directory, "restored", "vault.db");
    SqliteMemory.restoreInterchange(
      reorderedPath,
      restoredPath,
      localVault,
      "2.0.0-alpha.0",
    );
    const restored = new SqliteMemory(restoredPath, localVault);
    expect(await restored.getNote(localVault, note.id)).toMatchObject({
      id: note.id,
      revision: 2,
      content: "The edited exact export text.",
      source: {
        label: "Export proof revised",
        timestamp: "2026-08-26T12:34:56.789Z",
      },
    });
    expect(
      (await restored.listNoteRevisions(localVault, note.id)).revisions,
    ).toMatchObject([
      { revision: 2, content: "The edited exact export text." },
      { revision: 1, content: "The original exact export text." },
    ]);
    expect((await restored.recall(localVault, "edited exact"))[0]).toMatchObject({
      note: { id: note.id, revision: 2 },
      citation: { noteId: note.id, revision: 2 },
    });
    const roundTripPath = join(directory, "round-trip.afternote.json");
    restored.exportInterchange(
      localVault,
      roundTripPath,
      "2.0.0-alpha.0",
    );
    restored.close();
    expect(readFileSync(roundTripPath, "utf8")).toBe(first);
  });

  it("never overwrites an existing export or restore destination", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-no-overwrite-"));
    tempDirectories.push(directory);
    const sourcePath = join(directory, "source.db");
    const exportPath = join(directory, "vault.afternote.json");
    const destinationPath = join(directory, "destination.db");
    const memory = new SqliteMemory(sourcePath, localVault);
    await memory.remember(localVault, { content: "Keep both sentinels intact." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    writeFileSync(destinationPath, "existing-vault-sentinel");

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        destinationPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("clean vault path");
    expect(readFileSync(destinationPath, "utf8")).toBe(
      "existing-vault-sentinel",
    );

    expect(() =>
      memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0"),
    ).toThrow();
    expect(JSON.parse(readFileSync(exportPath, "utf8"))).toMatchObject({
      format: "afternote-vault",
      manifest: { noteCount: 1 },
    });
    memory.close();
  });

  it("removes staged plaintext when an export deadline expires before publication", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-export-deadline-"));
    tempDirectories.push(directory);
    for (const [filename, format] of [
      ["vault.json", "json"],
      ["vault.md", "markdown"],
    ] as const) {
      const memory = new SqliteMemory(join(directory, `${filename}.db`), localVault);
      await memory.remember(localVault, { content: "Deadline cleanup canary." });
      const destination = join(directory, filename);
      const assertCanContinue = () => {
        if (readdirSync(directory).some((entry) => entry.startsWith(`${filename}.tmp-`))) {
          throw new Error("export deadline");
        }
      };
      expect(() => format === "json"
        ? memory.exportInterchange(
          localVault,
          destination,
          "2.0.0-alpha.0",
          assertCanContinue,
        )
        : memory.exportMarkdown(
          localVault,
          destination,
          "2.0.0-alpha.0",
          assertCanContinue,
        )).toThrow("export deadline");
      expect(existsSync(destination)).toBe(false);
      expect(readdirSync(directory).some((entry) => entry.includes(`${filename}.tmp-`)))
        .toBe(false);
      expect(await memory.recall(localVault, "deadline cleanup")).toHaveLength(1);
      memory.close();
    }
  });

  it("verifies checksums against canonical note order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-canonical-order-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "vault.afternote.json");
    const reorderedPath = join(directory, "reordered.afternote.json");
    const restoredPath = join(directory, "restored.db");
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    await memory.remember(localVault, { content: "Canonical note one." });
    await memory.remember(localVault, { content: "Canonical note two." });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();

    const exported = JSON.parse(
      readFileSync(exportPath, "utf8"),
    ) as InterchangeDocument;
    exported.notes.reverse();
    writeFileSync(reorderedPath, JSON.stringify(exported));
    expect(() =>
      SqliteMemory.restoreInterchange(
        reorderedPath,
        restoredPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).not.toThrow();
  });

  it("uses JSON Schema code-point limits for astral text", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-code-points-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "vault.afternote.json");
    const restoredPath = join(directory, "restored.db");
    const content = "😀".repeat(MAX_NOTE_CHARACTERS);
    const label = "📝".repeat(MAX_SOURCE_LABEL_CHARACTERS);
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    const note = await memory.remember(localVault, {
      content,
      source: { label },
    });
    memory.exportInterchange(localVault, exportPath, "2.0.0-alpha.0");
    memory.close();

    expect(() =>
      SqliteMemory.restoreInterchange(
        exportPath,
        restoredPath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).not.toThrow();
    const restored = new SqliteMemory(restoredPath, localVault);
    expect(await restored.getNote(localVault, note.id)).toMatchObject({
      content,
      source: { label },
    });
    restored.close();
  });

  it("exports deterministic human-readable Markdown with current note evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-markdown-"));
    tempDirectories.push(directory);
    const firstPath = join(directory, "notes-first.md");
    const secondPath = join(directory, "notes-second.md");
    const currentContent =
      "Current text with a # heading and `code`.\n\n" +
      "## Note `fake`\n<img src=\"https://example.invalid/track\">\n" +
      "![remote](https://example.invalid/image)\n`````";
    const memory = new SqliteMemory(join(directory, "source.db"), localVault);
    const edited = await memory.remember(localVault, {
      content: "Original text must stay in the lossless export only.",
      source: { application: "Browser", label: "Original" },
    });
    await memory.updateNote(localVault, edited.id, {
      expectedRevision: 1,
      content: currentContent,
      source: {
        application: "Afternote Local",
        author: "Taylor \"T\" Morgan",
        label: "Current evidence",
      },
    });
    const second = await memory.remember(localVault, {
      content: "A second current note.",
    });

    memory.exportMarkdown(localVault, firstPath, "2.0.0-alpha.0");
    memory.exportMarkdown(localVault, secondPath, "2.0.0-alpha.0");
    memory.close();

    const markdown = readFileSync(firstPath, "utf8");
    expect(readFileSync(secondPath, "utf8")).toBe(markdown);
    expect(markdown).toContain("<!-- afternote-markdown-v1 -->");
    expect(markdown).toContain("current revisions only");
    expect(markdown).toContain("cannot be restored as a lossless vault backup");
    expect(markdown).toContain(currentContent);
    expect(markdown).toContain(`\`\`\`\`\`\`text\n${currentContent}\n\`\`\`\`\`\`\n`);
    expect(markdown).toContain("A second current note.");
    expect(markdown).not.toContain("Original text must stay");
    expect(markdown).toContain('author: "Taylor \\"T\\" Morgan"');
    expect(markdown).toContain("revision: 2");
    const editedIndex = markdown.indexOf(`## Note \`${edited.id}\``);
    const secondIndex = markdown.indexOf(`## Note \`${second.id}\``);
    if (edited.id < second.id) {
      expect(editedIndex).toBeLessThan(secondIndex);
    } else {
      expect(secondIndex).toBeLessThan(editedIndex);
    }
    const emptyMemory = new SqliteMemory(join(directory, "reopen.db"), localVault);
    expect(() =>
      emptyMemory.exportMarkdown(localVault, firstPath, "2.0.0-alpha.0"),
    ).toThrow();
    emptyMemory.close();
    expect(readFileSync(firstPath, "utf8")).toBe(markdown);
    const restorePath = join(directory, "markdown-restore.db");
    expect(() =>
      SqliteMemory.restoreInterchange(
        firstPath,
        restorePath,
        localVault,
        "2.0.0-alpha.0",
      ),
    ).toThrow("valid UTF-8 JSON");
    expect(existsSync(restorePath)).toBe(false);
  });

});

describe("SqliteMemory storage and schema migrations", () => {
  it("does not create a new revision when an update changes nothing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-noop-update-"));
    tempDirectories.push(directory);
    const memory = new SqliteMemory(join(directory, "vault.db"), localVault);
    const original = await memory.remember(localVault, {
      content: "Keep this revision unchanged.",
      source: { application: "Claude Code", label: "No-op canary" },
    });

    const unchanged = await memory.updateNote(localVault, original.id, {
      content: original.content,
      expectedRevision: original.revision,
      source: original.source,
    });

    expect(unchanged).toEqual(original);
    expect((await memory.listNoteRevisions(localVault, original.id)).revisions)
      .toHaveLength(1);
    memory.close();
  });

  it("normalizes source timestamps and rejects ambiguous connector dates", async () => {
    const memory = new SqliteMemory(":memory:", localVault);
    try {
      const note = await memory.remember(localVault, {
        content: "The vendor contract arrived Friday.",
        source: { timestamp: "2026-08-28T11:45:00-06:00" },
      });
      expect(note.source?.timestamp).toBe("2026-08-28T17:45:00.000Z");
      await expect(
        memory.remember(localVault, {
          content: "This timestamp is ambiguous.",
          source: { timestamp: "last Friday" },
        }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: "source.timestamp must be an ISO-8601 timestamp with a timezone",
      });
      await expect(
        memory.remember(localVault, {
          content: "This timestamp names a nonexistent day.",
          source: { timestamp: "2026-02-30T12:00:00Z" },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      memory.close();
    }
  });

  it("materializes source timestamps for indexed temporal recall", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-source-time-index-"));
    tempDirectories.push(directory);
    const path = join(directory, "vault.db");
    const memory = new SqliteMemory(path, localVault);
    const note = await memory.remember(localVault, {
      content: "The signed venue agreement is ready.",
      source: { timestamp: "2026-08-28T11:45:00-06:00" },
    });
    memory.close();

    const database = new Database(path, { readonly: true });
    try {
      expect(database.query<{ source_timestamp: string }, [string]>(
        "select source_timestamp from note_temporal_index where note_id = ?",
      ).get(note.id)?.source_timestamp).toBe("2026-08-28T17:45:00.000Z");
      expect(database.query<{ name: string }, []>(
        "select name from sqlite_schema where type = 'index' and name = 'note_temporal_index_source_timestamp'",
      ).get()?.name).toBe("note_temporal_index_source_timestamp");
    } finally {
      database.close();
    }
  });

  it("upgrades the earlier alpha.9 temporal-index shape without adding the column twice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-alpha9-time-index-"));
    tempDirectories.push(directory);
    const path = join(directory, "vault.db");
    const current = new SqliteMemory(path, localVault);
    const note = await current.remember(localVault, {
      content: "The signed venue agreement arrived on August 28.",
      source: { timestamp: "2026-08-28T11:45:00-06:00" },
    });
    current.close();

    const alpha9 = new Database(path);
    alpha9.exec("pragma user_version = 9");
    alpha9.close();

    const upgraded = new SqliteMemory(path, localVault, {
      now: () => new Date("2026-09-08T12:00:00.000Z"),
      timeZone: "America/Denver",
    });
    try {
      expect(upgraded.diagnosticSnapshot(localVault).schemaVersion).toBe(11);
      expect(await upgraded.recall(localVault, "What happened on August 28?")).toMatchObject([
        { note: { id: note.id }, citation: { noteId: note.id } },
      ]);
    } finally {
      upgraded.close();
    }
  });

  it("keeps browse order stable across edits and binds cursors to their search", async () => {
    const memory = new SqliteMemory(":memory:", localVault);
    const originalDateNow = Date.now;
    Date.now = () => Date.parse("2026-08-26T12:00:00.000Z");
    try {
      const notes = [];
      for (const content of [
        "Cedar trail marker alpha",
        "Cedar trail marker beta",
        "Cedar trail marker gamma",
      ]) {
        notes.push(await memory.remember(localVault, { content }));
      }
      expect(new Set(notes.map((note) => note.createdAt)).size).toBe(3);
      await expect(
        memory.remember(localVault, {
          content: "This source must be rejected at the domain boundary.",
          source: { label: "x".repeat(201) },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      const beforeEdit = await memory.browseNotes(localVault, { limit: 3 });
      expect(beforeEdit.notes).toHaveLength(3);
      await memory.updateNote(localVault, beforeEdit.notes[2].id, {
        content: `${beforeEdit.notes[2].content} edited`,
        expectedRevision: 1,
      });
      const afterEdit = await memory.browseNotes(localVault, { limit: 3 });
      expect(afterEdit.notes.map((note) => note.id)).toEqual(
        beforeEdit.notes.map((note) => note.id),
      );

      const firstPage = await memory.browseNotes(localVault, { limit: 1 });
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await memory.browseNotes(localVault, {
        limit: 1,
        cursor: firstPage.nextCursor ?? undefined,
      });
      expect(secondPage.notes[0]?.id).not.toBe(firstPage.notes[0]?.id);

      const searchPage = await memory.searchNotes(localVault, {
        query: "cedar trail",
        limit: 1,
      });
      expect(searchPage.nextCursor).not.toBeNull();
      await expect(
        memory.searchNotes(localVault, {
          query: "marker",
          limit: 1,
          cursor: searchPage.nextCursor ?? undefined,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      Date.now = originalDateNow;
      memory.close();
    }
  });

  it("keeps source-aware Recall synchronized across edits", async () => {
    const memory = new SqliteMemory(":memory:", localVault);
    try {
      const note = await memory.remember(localVault, {
        content: "The release checklist covers rollback verification.",
        source: { author: "Maya Chen", label: "ARC-42" },
      });
      expect(await memory.recall(localVault, "Maya Chen")).toMatchObject([
        { note: { id: note.id }, citation: { noteId: note.id } },
      ]);

      await memory.updateNote(localVault, note.id, {
        content: note.content,
        expectedRevision: 1,
        source: { author: "Noah Williams", label: "ARC-43" },
      });
      expect(await memory.recall(localVault, "Maya Chen")).toEqual([]);
      expect(await memory.recall(localVault, "Noah ARC-43")).toMatchObject([
        { note: { id: note.id, revision: 2 }, citation: { noteId: note.id } },
      ]);
      expect(await memory.recall(localVault, "application")).toEqual([]);
      expect(await memory.recall(localVault, "author")).toEqual([]);
    } finally {
      memory.close();
    }
  });

  it("refuses to open a vault created by a newer schema version", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-migration-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");
    const futureDatabase = new Database(databasePath, { create: true });
    futureDatabase.exec("PRAGMA user_version = 12;");
    futureDatabase.close();

    try {
      new SqliteMemory(databasePath, localVault);
      throw new Error("Expected the newer schema to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryError);
      expect((error as MemoryError).code).toBe("incompatible_schema");
      expect((error as Error).message).toContain("newer schema version 12");
    }

    const inspected = new Database(databasePath);
    const version = inspected
      .query<{ user_version: number }, []>("PRAGMA user_version;")
      .get();
    inspected.close();
    expect(version?.user_version).toBe(12);
  });

  it("reuses one content-bound backup when an unchanged migration keeps failing", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-failed-migration-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");
    const malformed = new Database(databasePath, { create: true });
    malformed.exec(`
      create table notes (
        rowid integer primary key autoincrement,
        id text not null unique,
        content text not null,
        created_at text not null,
        updated_at text not null
      );
      PRAGMA user_version = 1;
    `);
    malformed.close();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => new SqliteMemory(databasePath, localVault)).toThrow();
    }
    expect(
      readdirSync(directory).filter((name) =>
        name.startsWith("vault.db.pre-migration-v1-"),
      ),
    ).toHaveLength(1);
  });

  it("migrates an existing note into immutable revision history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-revisions-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");
    const legacy = new Database(databasePath, { create: true });
    legacy.exec(`
      create table notes (
        rowid integer primary key autoincrement,
        id text not null unique,
        content text not null,
        source_json text,
        created_at text not null,
        updated_at text not null
      );
      insert into notes (id, content, source_json, created_at, updated_at)
      values (
        '11111111-1111-4111-8111-111111111111',
        'The note that existed before revision history.',
        '{"label":"Legacy note"}',
        '2026-08-20T10:00:00.000Z',
        '2026-08-20T10:00:00.000Z'
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const staleBackupPath = `${databasePath}.pre-migration-v1.db`;
    const staleBackup = new Database(staleBackupPath, { create: true });
    staleBackup.exec(`
      create table notes (
        rowid integer primary key autoincrement,
        id text not null unique,
        content text not null,
        source_json text,
        created_at text not null,
        updated_at text not null
      );
      PRAGMA user_version = 1;
    `);
    staleBackup.close();
    chmodSync(staleBackupPath, 0o600);

    const memory = new SqliteMemory(databasePath, localVault);
    const id = "11111111-1111-4111-8111-111111111111";
    const backupPaths = readdirSync(directory)
      .filter((name) => name.startsWith("vault.db.pre-migration-v1"))
      .map((name) => join(directory, name));
    expect(backupPaths).toHaveLength(2);
    const backupPath = backupPaths.find((path) => {
      const candidate = new Database(path, { readonly: true });
      try {
        return Boolean(
          candidate
            .query<{ id: string }, [string]>("select id from notes where id = ?")
            .get(id),
        );
      } finally {
        candidate.close();
      }
    });
    expect(backupPath).toBeDefined();
    expect(existsSync(backupPath ?? "")).toBe(true);
    const backup = new Database(backupPath!, { readonly: true });
    expect(
      backup.query<{ user_version: number }, []>("PRAGMA user_version;").get()
        ?.user_version,
    ).toBe(1);
    expect(
      backup
        .query<{ content: string }, [string]>(
          "select content from notes where id = ?",
        )
        .get(id)?.content,
    ).toBe("The note that existed before revision history.");
    expect(
      backup.query<{ quick_check: string }, []>("PRAGMA quick_check;").get()
        ?.quick_check,
    ).toBe("ok");
    backup.close();
    expect(await memory.getNote(localVault, id)).toMatchObject({
      revision: 1,
      content: "The note that existed before revision history.",
    });
    expect((await memory.listNoteRevisions(localVault, id)).revisions).toMatchObject([
      {
        revision: 1,
        content: "The note that existed before revision history.",
        source: { label: "Legacy note" },
      },
    ]);

    await memory.updateNote(localVault, id, {
      content: "The migrated note now has a second revision.",
      expectedRevision: 1,
    });
    const firstHistoryPage = await memory.listNoteRevisions(localVault, id, {
      limit: 1,
    });
    expect(firstHistoryPage.revisions).toMatchObject([
      { revision: 2, content: "The migrated note now has a second revision." },
    ]);
    expect(firstHistoryPage.nextCursor).not.toBeNull();
    expect(
      (
        await memory.listNoteRevisions(localVault, id, {
          limit: 1,
          cursor: firstHistoryPage.nextCursor ?? undefined,
        })
      ).revisions,
    ).toMatchObject([
      { revision: 1, content: "The note that existed before revision history." },
    ]);
    memory.close();

    const migrated = new Database(databasePath, { readonly: true });
    const plan = migrated
      .query<{ detail: string }, []>(
        `explain query plan
         select id from notes order by created_at desc, id desc limit 20`,
      )
      .all();
    migrated.close();
    expect(plan.map((step) => step.detail).join(" ")).toContain(
      "notes_created_order",
    );
  });

  it("migrates the deterministic index to retrieve preserved source metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-source-index-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");
    const current = new SqliteMemory(databasePath, localVault);
    const note = await current.remember(localVault, {
      content: "The release checklist covers rollback verification.",
      source: { application: "Linear", label: "ARC-42", author: "Maya Chen" },
    });
    current.close();

    const previous = new Database(databasePath);
    previous.exec(`
      drop trigger notes_fts_insert;
      drop trigger notes_fts_delete;
      drop trigger notes_fts_update;
      drop table notes_fts;
      drop table note_embedding_chunks;
      drop table note_embeddings;
      drop table note_smart_views;
      drop table note_organization_facets;
      drop table note_organization;
      drop table note_temporal_annotations;
      drop table note_temporal_index;
      alter table notes drop column source_search;
      create virtual table notes_fts using fts5(
        content,
        content = 'notes',
        content_rowid = 'rowid',
        tokenize = 'unicode61'
      );
      create trigger notes_fts_insert after insert on notes begin
        insert into notes_fts(rowid, content) values (new.rowid, new.content);
      end;
      create trigger notes_fts_delete after delete on notes begin
        insert into notes_fts(notes_fts, rowid, content)
        values ('delete', old.rowid, old.content);
      end;
      create trigger notes_fts_update after update of content on notes begin
        insert into notes_fts(notes_fts, rowid, content)
        values ('delete', old.rowid, old.content);
        insert into notes_fts(rowid, content) values (new.rowid, new.content);
      end;
      insert into notes_fts(rowid, content)
      select rowid, content from notes;
      PRAGMA user_version = 3;
    `);
    previous.close();

    const migrated = new SqliteMemory(databasePath, localVault);
    try {
      expect(await migrated.recall(localVault, "Maya Chen ARC-42")).toMatchObject([
        {
          note: { id: note.id, source: { application: "Linear" } },
          citation: { noteId: note.id, revision: 1 },
        },
      ]);
    } finally {
      migrated.close();
    }
  });

  it("refuses to export through a different vault context", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-export-context-"));
    tempDirectories.push(directory);
    const exportPath = join(directory, "export.afternote.json");
    const memory = new SqliteMemory(":memory:", localVault);

    try {
      expect(() =>
        memory.exportInterchange(
          { vaultId: "b".repeat(64), deployment: "local" },
          exportPath,
          "2.0.0-alpha.0",
        ),
      ).toThrow("Vault context does not match this memory service");
      expect(existsSync(exportPath)).toBe(false);
    } finally {
      memory.close();
    }
  });

});

describe("SqliteMemory temporal recall", () => {
  it("filters visible search by an explicit month and day", async () => {
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
      embeddingModel: new RecordingEmbeddingModel(),
      retrievalMode: "hybrid",
    });
    try {
      const expected = await memory.remember(localVault, {
        content: "The badge handoff happened last Friday.",
      });
      await memory.remember(localVault, {
        content: "The cedar phrase happened yesterday.",
      });
      await memory.waitForDerivedIndex();

      expect(
        (await memory.searchNotes(localVault, {
          query: "What happened on August 28?",
          limit: 5,
        })).results.map((result) => result.note.id),
      ).toEqual([expected.id]);
      expect(
        (await memory.recall(localVault, "What happened on August 28?", 5))
          .map((result) => result.note.id),
      ).toEqual([expected.id]);
    } finally {
      memory.close();
    }
  });

  it("recalls a note with a relative range from a relative weekday query", async () => {
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
    });
    try {
      const expected = await memory.remember(localVault, {
        content: "Mike went to the farm last week.",
      });
      await memory.remember(localVault, {
        content: "Sarah filed the annual report last month.",
      });

      expect(
        (await memory.recall(localVault, "What did I have to do last Friday?", 5))
          .map((result) => result.note.id),
      ).toEqual([expected.id]);
      expect((await memory.getNote(localVault, expected.id))?.content)
        .toBe("Mike went to the farm last week.");
    } finally {
      memory.close();
    }
  });

  it("uses normalized source timestamps for relative-date recall", async () => {
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
    });
    try {
      const expected = await memory.remember(localVault, {
        content: "Maya posted the finalized rollout checklist.",
        source: {
          application: "Team Chat",
          author: "Maya Chen",
          timestamp: "2026-08-28T17:45:00.000Z",
          label: "#launch",
        },
      });
      await memory.remember(localVault, {
        content: "Maya posted the draft rollout checklist.",
        source: {
          application: "Team Chat",
          author: "Maya Chen",
          timestamp: "2026-09-04T17:45:00.000Z",
          label: "#launch",
        },
      });

      expect(
        (await memory.recall(
          localVault,
          "What did Maya post in Team Chat last Friday?",
          5,
        )).map((result) => result.note.id),
      ).toEqual([expected.id]);
    } finally {
      memory.close();
    }
  });

  it("replaces derived time metadata when a note is edited", async () => {
    let instant = new Date("2026-08-31T18:00:00.000Z");
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => instant,
      timeZone: "America/Denver",
    });
    try {
      const note = await memory.remember(localVault, {
        content: "Mike went to the farm last week.",
      });
      instant = new Date("2026-09-01T18:00:00.000Z");
      await memory.updateNote(localVault, note.id, {
        content: "Mike will go to the farm next week.",
        expectedRevision: 1,
      });

      expect(await memory.recall(localVault, "What happened last Friday?", 5))
        .toEqual([]);
      expect(await memory.recall(localVault, "What happens next Friday?", 5))
        .toMatchObject([{ note: { id: note.id, revision: 2 } }]);
    } finally {
      memory.close();
    }
  });

  it("keeps normalized time metadata across a vault reopen and timezone change", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-temporal-reopen-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");
    const first = new SqliteMemory(databasePath, localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
    });
    const note = await first.remember(localVault, {
      content: "Mike went to the farm last week.",
    });
    first.close();

    const reopened = new SqliteMemory(databasePath, localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/New_York",
    });
    try {
      expect(await reopened.recall(localVault, "What happened last Friday?", 5))
        .toMatchObject([{ note: { id: note.id } }]);
    } finally {
      reopened.close();
    }
  });

  it("adds absolute time context to local embeddings without changing citations", async () => {
    const model = new RecordingEmbeddingModel();
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const note = await memory.remember(localVault, {
        content: "Mike went to the farm last week.",
      });
      await memory.waitForDerivedIndex();
      const [result] = await memory.recall(localVault, "What happened last Friday?", 5);

      expect(model.texts.some((text) =>
        text.includes('"last week" means 2026-08-24T06:00:00.000Z'))).toBe(true);
      expect(model.texts.some((text) =>
        text.includes('"last Friday" means 2026-08-28T06:00:00.000Z'))).toBe(true);
      expect(result?.citation).toMatchObject({
        noteId: note.id,
        excerpt: "Mike went to the farm last week.",
      });
    } finally {
      memory.close();
    }
  });

  it("embeds useful source metadata without adding it to the citation", async () => {
    const model = new RecordingEmbeddingModel();
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const note = await memory.remember(localVault, {
        content: "The contractor renewal checklist is ready.",
        source: {
          application: "Basecamp",
          author: "Omar Haddad",
          timestamp: "2026-08-28T17:45:00.000Z",
          label: "Vendor operations",
        },
      });
      await memory.waitForDerivedIndex();

      const indexed = model.texts.find((text) =>
        text.startsWith("The contractor renewal checklist is ready."));
      expect(indexed).toContain("Source application: Basecamp.");
      expect(indexed).toContain("Source author: Omar Haddad.");
      expect(indexed).toContain("Source label: Vendor operations.");
      expect(indexed).toContain("Source timestamp: 2026-08-28T17:45:00.000Z.");
      const [result] = await memory.recall(localVault, "contractor renewal", 5);
      expect(result?.citation).toMatchObject({
        noteId: note.id,
        excerpt: "The contractor renewal checklist is ready.",
      });
    } finally {
      memory.close();
    }
  });

  it("adds each relative date only to the embedding chunk that contains it", async () => {
    const model = new RecordingEmbeddingModel();
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const firstChunk = "The farm visit happened last week.".padEnd(400, " x");
      await memory.remember(localVault, {
        content: `${firstChunk}The launch review happens next week.`,
      });
      await memory.waitForDerivedIndex();

      const indexedFirst = model.texts.find((text) => text.startsWith(firstChunk));
      const indexedSecond = model.texts.find((text) =>
        text.startsWith("The launch review happens next week."));
      expect(indexedFirst).toContain('"last week" means');
      expect(indexedFirst).not.toContain('"next week" means');
      expect(indexedSecond).toContain('"next week" means');
      expect(indexedSecond).not.toContain('"last week" means');
    } finally {
      memory.close();
    }
  });

  it("cites the dated passage that matched in a multi-date note", async () => {
    const firstChunk = "The farm visit happened last week.".padEnd(400, " x");
    const secondChunk = "The launch review happens next week.";
    const firstEmbedding = firstChunk +
      '\n\n[Afternote resolved time: "last week" means 2026-08-24T06:00:00.000Z through 2026-08-31T06:00:00.000Z in America/Denver]';
    const secondEmbedding = secondChunk +
      '\n\n[Afternote resolved time: "next week" means 2026-09-07T06:00:00.000Z through 2026-09-14T06:00:00.000Z in America/Denver]';
    const query = "What happens next Friday?";
    const queryEmbedding = query +
      '\n\n[Afternote resolved time: "next Friday" means 2026-09-11T06:00:00.000Z through 2026-09-12T06:00:00.000Z in America/Denver]';
    const model = new FixtureEmbeddingModel(new Map([
      [firstEmbedding, [0, 1]],
      [secondEmbedding, [1, 0]],
      [queryEmbedding, [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      await memory.remember(localVault, { content: firstChunk + secondChunk });
      await memory.waitForDerivedIndex();
      const [result] = await memory.recall(localVault, query, 5);
      expect(result?.citation.excerpt).toContain(secondChunk);
      expect(result?.citation.excerpt).not.toContain("last week");
    } finally {
      memory.close();
    }
  });

  it("keeps a relative phrase intact when it crosses a nominal chunk boundary", async () => {
    const model = new RecordingEmbeddingModel();
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-08-31T18:00:00.000Z"),
      timeZone: "America/Denver",
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const prefix = ".".repeat(395);
      await memory.remember(localVault, {
        content: `${prefix}next week contains the launch review.`,
      });
      await memory.waitForDerivedIndex();

      const indexedChunks = model.texts;
      expect(indexedChunks).toHaveLength(2);
      expect(indexedChunks[0]).toStartWith(`${prefix}next week`);
      expect(indexedChunks[0]).toContain('"next week" means');
      expect(indexedChunks[1]).not.toContain('"next week" means');
    } finally {
      memory.close();
    }
  });

  it("uses the current system timezone for each new save and query", async () => {
    let timeZone = "America/Denver";
    const model = new RecordingEmbeddingModel();
    const memory = new SqliteMemory(":memory:", localVault, {
      now: () => new Date("2026-09-01T02:00:00.000Z"),
      timeZoneProvider: () => timeZone,
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      await memory.remember(localVault, { content: "The Denver task is due today." });
      await memory.waitForDerivedIndex();
      expect(model.texts.some((text) =>
        text.includes('"today" means 2026-08-31T06:00:00.000Z'))).toBe(true);

      timeZone = "Asia/Tokyo";
      await memory.remember(localVault, { content: "The Tokyo task is due today." });
      await memory.waitForDerivedIndex();
      expect(model.texts.some((text) =>
        text.includes('"today" means 2026-08-31T15:00:00.000Z'))).toBe(true);

      await memory.recall(localVault, "What is due today?", 5);
      expect(model.texts.at(-1)).toContain(
        '"today" means 2026-08-31T15:00:00.000Z',
      );
    } finally {
      memory.close();
    }
  });
});

describe("SqliteMemory hybrid retrieval", () => {
  it("recalls a fresh note without an explicit index wait, and disables in-flight inference", async () => {
    const content = "The brass token opens the archive room.", query = "records storage access credential";
    const model: TextEmbeddingModel = new FixtureEmbeddingModel(new Map([[content, [1, 0]], [query, [1, 0]]]));
    const memory = new SqliteMemory(":memory:", localVault, {embeddingModel: model, retrievalMode: "hybrid"});
    try {
      const note = await memory.remember(localVault, {content});
      expect(await memory.recall(localVault, query, 5)).toMatchObject([{note: {id: note.id}}]);
      let release!: () => void, started!: () => void;
      const blocked = new Promise<void>(resolve => {release = resolve;});
      const running = new Promise<void>(resolve => {started = resolve;});
      model.embedQuery = async () => {started(); await blocked; return new Float32Array([1, 0]);};
      const pending = memory.recall(localVault, query, 5); await running;
      const pendingUi = memory.searchNotes(localVault, {query, limit: 5});
      await Bun.sleep(0);
      memory.disableSemanticSearch(localVault); release();
      expect(await pendingUi).toMatchObject({results: [], nextCursor: null});
      expect(await pending).toEqual([]);
      expect(memory.derivedIndexStatus(localVault).state).toBe("disabled");
      expect(await memory.recall(localVault, query, 5)).toEqual([]);
      expect(await memory.recall(localVault, "brass token", 5)).toMatchObject([{note: {id: note.id, revision: 1}}]);
      delete model.embedQuery;
      memory.enableSemanticSearch(localVault, model); await memory.waitForDerivedIndex();
      expect(await memory.recall(localVault, query, 5)).toMatchObject([{note: {id: note.id, revision: 1}}]);
    } finally { memory.close(); }
  });

  it("switches models during indexing and query inference without mixing vectors or editing notes", async () => {
    const content = "The brass token opens the archive room.";
    const query = "records storage access credential";
    const memory = new SqliteMemory(":memory:", localVault);
    let releaseOldIndex!: () => void;
    let startedOldIndex!: () => void;
    const started = new Promise<void>((resolve) => { startedOldIndex = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseOldIndex = resolve; });
    const oldModel: TextEmbeddingModel = {
      descriptor: { id: "old", revision: "1", dimensions: 2 }, minimumSimilarity: 0.8,
      embed: async (texts, stopped) => {
        startedOldIndex(); await blocked;
        expect(stopped?.()).toBe(true);
        return texts.map(() => new Float32Array([1, 0]));
      },
    };
    let releaseQuery!: () => void;
    let startedQuery!: () => void;
    const queryStarted = new Promise<void>((resolve) => { startedQuery = resolve; });
    const queryBlocked = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const newModel: TextEmbeddingModel = {
      descriptor: { id: "new", revision: "1", dimensions: 3 }, minimumSimilarity: 0.8,
      embed: async (texts) => texts.map(() => new Float32Array([0, 1, 0])),
      embedQuery: async () => { startedQuery(); await queryBlocked; return new Float32Array([0, 1, 0]); },
    };
    try {
      const note = await memory.remember(localVault, {content});
      memory.enableSemanticSearch(localVault, oldModel);
      await started;
      memory.enableSemanticSearch(localVault, newModel);
      expect(memory.derivedIndexStatus(localVault)).toMatchObject({state: "indexing", model: newModel.descriptor});
      expect(await memory.searchNotes(localVault, {query: "brass token", limit: 5})).toMatchObject({results: [{note: {id: note.id}}]});
      releaseOldIndex(); await memory.waitForDerivedIndex();
      expect(memory.derivedIndexStatus(localVault)).toMatchObject({state: "ready", indexedNotes: 1, lastError: null});
      const oldQuery = memory.recall(localVault, query, 5);
      await queryStarted;
      const thirdModel: TextEmbeddingModel = {
        descriptor: {id: "third", revision: "1", dimensions: 2}, minimumSimilarity: 0.8,
        embed: async (texts) => texts.map(() => new Float32Array([0, 1])),
      };
      memory.enableSemanticSearch(localVault, thirdModel);
      releaseQuery();
      expect(await oldQuery).toEqual([]);
      await memory.waitForDerivedIndex();
      expect(await memory.recall(localVault, query, 5)).toMatchObject([{note: {id: note.id, content, revision: 1}}]);
      expect(memory.derivedIndexStatus(localVault)).toMatchObject({state: "ready", model: thirdModel.descriptor});
    } finally { releaseOldIndex(); releaseQuery?.(); memory.close(); }
  });

  it("enables semantic agent recall on an open exact-search vault", async () => {
    const content = "The brass token opens the archive room.";
    const query = "records storage access credential";
    const memory = new SqliteMemory(":memory:", localVault);
    try {
      const note = await memory.remember(localVault, { content });
      expect(await memory.recall(localVault, query, 5)).toEqual([]);
      const model = new FixtureEmbeddingModel(new Map([[content, [1, 0]], [query, [1, 0]]]));
      memory.enableSemanticSearch(localVault, model);
      await memory.waitForDerivedIndex();
      expect(await memory.recall(localVault, query, 5)).toMatchObject([{ note: { id: note.id, content, revision: 1 } }]);
      memory.enableSemanticSearch(localVault, model);
      expect(memory.derivedIndexStatus(localVault).state).toBe("ready");
    } finally { memory.close(); }
  });

  it("invalidates the cached semantic index after saves, edits, and deletes", async () => {
    const first = "The brass token opens the archive room.";
    const second = "The indigo folder contains the vendor renewal.";
    const updated = "The archive token was replaced by a digital badge.";
    const firstQuery = "How do I enter the records storage area?";
    const secondQuery = "Where is the supplier extension paperwork?";
    const updatedQuery = "What replaced the physical archive credential?";
    const model = new FixtureEmbeddingModel(new Map([
      [first, [1, 0]],
      [second, [0, 1]],
      [updated, [-1, 0]],
      [firstQuery, [1, 0]],
      [secondQuery, [0, 1]],
      [updatedQuery, [-1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const original = await memory.remember(localVault, { content: first });
      await memory.waitForDerivedIndex();
      expect(await memory.recall(localVault, firstQuery, 5)).toMatchObject([
        { note: { id: original.id } },
      ]);

      const added = await memory.remember(localVault, { content: second });
      await memory.waitForDerivedIndex();
      expect(
        (await memory.recall(localVault, secondQuery, 5))
          .map((result) => result.note.id),
      ).toContain(added.id);

      await memory.updateNote(localVault, original.id, {
        content: updated,
        expectedRevision: 1,
      });
      await memory.waitForDerivedIndex();
      expect(await memory.recall(localVault, updatedQuery, 5)).toMatchObject([
        { note: { id: original.id, revision: 2 } },
      ]);

      await memory.forget(localVault, added.id);
      expect(
        (await memory.recall(localVault, secondQuery, 5))
          .map((result) => result.note.id),
      ).not.toContain(added.id);
    } finally {
      memory.close();
    }
  });

  it("corrects corpus hubness so near-duplicate distractors cannot crowd out evidence", async () => {
    const query = "What is blocking the release?";
    const relevant = "Security approval is required before shipping.";
    const distractors = Array.from(
      { length: 5 },
      (_, index) => `Routine planning placeholder ${index + 1}.`,
    );
    const model = new FixtureEmbeddingModel(new Map([
      [query, [1, 0]],
      [relevant, [0.78, -0.625]],
      ...distractors.map((content, index) => [
        content,
        [0.8, 0.6 + index * 0.002],
      ] as [string, number[]]),
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const expected = await memory.remember(localVault, { content: relevant });
      for (const content of distractors) {
        await memory.remember(localVault, { content });
      }
      await memory.waitForDerivedIndex();

      expect(
        (await memory.recall(localVault, query, 5)).map((result) => result.note.id),
      ).toContain(expected.id);
    } finally {
      memory.close();
    }
  });

  it("does not invent live inbox access from an unrelated semantic neighbor", async () => {
    const query = "Summarize my unread email inbox";
    const unrelated = "Routine message status placeholder.";
    const model = new FixtureEmbeddingModel(new Map([
      [query, [1, 0]],
      [unrelated, [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      await memory.remember(localVault, { content: unrelated });
      await memory.waitForDerivedIndex();
      expect(await memory.recall(localVault, query, 5)).toEqual([]);
    } finally {
      memory.close();
    }
  });

  it("still returns saved evidence about an inbox when the note actually says so", async () => {
    const query = "What did I save about my unread email inbox?";
    const content = "My unread email inbox was empty before the flight.";
    const model = new FixtureEmbeddingModel(new Map([
      [query, [1, 0]],
      [content, [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const expected = await memory.remember(localVault, { content });
      await memory.waitForDerivedIndex();
      expect(await memory.recall(localVault, query, 5)).toMatchObject([
        { note: { id: expected.id } },
      ]);
    } finally {
      memory.close();
    }
  });

  it("does not reinterpret an exact phrase found only in a superseded revision", async () => {
    const query = "crimson accordion";
    const current = "The emergency keycard moved to the green fireproof box upstairs.";
    const previous = "The emergency keycard is inside the crimson accordion folder.";
    const model = new FixtureEmbeddingModel(new Map([
      [previous, [0, 1]],
      [current, [1, 0]],
      [query, [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const note = await memory.remember(localVault, { content: previous });
      await memory.waitForDerivedIndex();
      await memory.updateNote(localVault, note.id, {
        content: current,
        expectedRevision: 1,
      });
      await memory.waitForDerivedIndex();

      expect(await memory.recall(localVault, query, 5)).toEqual([]);
    } finally {
      memory.close();
    }
  });

  it("removes only the stale semantic candidate when another current note is valid", async () => {
    const query = "crimson accordion";
    const previous = "The emergency keycard is inside the crimson accordion folder.";
    const current = "The emergency keycard moved to the green fireproof box upstairs.";
    const valid = "A scarlet concertina instrument is reserved for the stage performance.";
    const model = new FixtureEmbeddingModel(new Map([
      [previous, [0, 1]],
      [current, [1, 0]],
      [valid, [0.95, 0.05]],
      [query, [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const staleNote = await memory.remember(localVault, { content: previous });
      await memory.updateNote(localVault, staleNote.id, {
        content: current,
        expectedRevision: 1,
      });
      const validNote = await memory.remember(localVault, { content: valid });
      await memory.waitForDerivedIndex();
      expect(await memory.recall(localVault, query, 5)).toMatchObject([{
        note: { id: validNote.id },
      }]);
    } finally {
      memory.close();
    }
  });

  it("returns exact evidence with a degraded mode when a semantic query times out", async () => {
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: new SlowQueryEmbeddingModel("find launch blocker"),
      retrievalMode: "hybrid",
    });
    try {
      const note = await memory.remember(localVault, {
        content: "Exact launch blocker evidence remains available.",
      });
      await memory.waitForDerivedIndex();
      const startedAt = performance.now();
      const searched = await memory.searchNotesWithDeadline(
        localVault,
        { query: "find launch blocker", limit: 5 },
        50,
      );
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(searched.searchMode).toBe("degraded");
      expect(searched.results).toMatchObject([
        { note: { id: note.id }, citation: { noteId: note.id } },
      ]);
    } finally {
      memory.close();
    }
  });

  it("keeps a one-token lexical match when semantic query embedding fails", async () => {
    const query = "Where is the garage combination?";
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: new FailingQueryEmbeddingModel(query),
      retrievalMode: "hybrid",
    });
    try {
      const note = await memory.remember(localVault, {
        content: "The garage keypad code is written inside the blue envelope.",
      });
      await memory.waitForDerivedIndex();

      expect(await memory.recall(localVault, query, 5)).toMatchObject([
        { note: { id: note.id }, citation: { noteId: note.id } },
      ]);
    } finally {
      memory.close();
    }
  });

  it("recalls a paraphrased note through the same cited Memory interface", async () => {
    const model = new FixtureEmbeddingModel(new Map([
      ["The launch cannot proceed until the security review is approved.", [1, 0]],
      ["Buy oat milk after work.", [0, 1]],
      ["What is preventing us from shipping?", [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });

    try {
      const expected = await memory.remember(localVault, {
        content: "The launch cannot proceed until the security review is approved.",
      });
      await memory.remember(localVault, { content: "Buy oat milk after work." });
      await memory.waitForDerivedIndex();

      expect(
        await memory.recall(
          localVault,
          "What is preventing us from shipping?",
          5,
        ),
      ).toMatchObject([
        {
          note: { id: expected.id, revision: 1 },
          citation: { noteId: expected.id, revision: 1 },
        },
      ]);
      expect(
        await memory.searchNotes(localVault, {
          query: "What is preventing us from shipping?",
          limit: 5,
        }),
      ).toMatchObject({
        results: [{ note: { id: expected.id } }],
        nextCursor: null,
      });
    } finally {
      memory.close();
    }
  });

  it("lets visible search explore a broader semantic match without weakening agent recall", async () => {
    const queryVector = [0.72, Math.sqrt(1 - 0.72 ** 2)];
    const model = new FixtureEmbeddingModel(new Map([
      ["The backup building access badge is inside the red hiking boot.", [1, 0]],
      ["office", queryVector],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });

    try {
      const expected = await memory.remember(localVault, {
        content: "The backup building access badge is inside the red hiking boot.",
      });
      await memory.waitForDerivedIndex();

      expect(await memory.recall(localVault, "office", 5)).toEqual([]);
      expect(
        await memory.searchNotes(localVault, { query: "office", limit: 5 }),
      ).toMatchObject({
        results: [{ note: { id: expected.id } }],
        nextCursor: null,
      });
    } finally {
      memory.close();
    }
  });

  it("does not pad an exact visible-search match with weaker semantic neighbors", async () => {
    const weakNeighbor = [0.71, Math.sqrt(1 - 0.71 ** 2)];
    const model = new FixtureEmbeddingModel(new Map([
      ["The backup badge is inside the blue rain boot.", [1, 0]],
      ["My end-to-end test phrase is cedar 31.", weakNeighbor],
      ["blue rain boot", [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });

    try {
      const expected = await memory.remember(localVault, {
        content: "The backup badge is inside the blue rain boot.",
      });
      await memory.remember(localVault, {
        content: "My end-to-end test phrase is cedar 31.",
      });
      await memory.waitForDerivedIndex();

      expect(
        (await memory.searchNotes(localVault, {
          query: "blue rain boot",
          limit: 5,
        })).results.map((result) => result.note.id),
      ).toEqual([expected.id]);
    } finally {
      memory.close();
    }
  });

  it("returns lexical evidence while the semantic backfill is still running", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-indexing-fallback-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");
    const lexical = new SqliteMemory(databasePath, localVault);
    const expected = await lexical.remember(localVault, {
      content: "The exact fallback phrase remains searchable during indexing.",
    });
    lexical.close();

    const hybrid = new SqliteMemory(databasePath, localVault, {
      embeddingModel: new BlockingEmbeddingModel(),
      retrievalMode: "hybrid",
    });
    try {
      const results = await Promise.race([
        hybrid.recall(localVault, "exact fallback phrase", 5),
        Bun.sleep(250).then(() => {
          throw new Error("Recall waited for the semantic backfill");
        }),
      ]);
      expect(results[0]?.note.id).toBe(expected.id);
      expect(hybrid.derivedIndexStatus(localVault).state).toBe("indexing");
    } finally {
      hybrid.close();
    }
  });

  it("retries a failed note batch and reaches a complete index", async () => {
    const model = new RetryingEmbeddingModel();
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      await memory.remember(localVault, { content: "Retry this local index." });
      await memory.waitForDerivedIndex();
      expect(model.attempts).toBe(3);
      expect(memory.derivedIndexStatus(localVault)).toMatchObject({
        state: "ready",
        indexedNotes: 1,
        staleNotes: 0,
        lastError: null,
      });
    } finally {
      memory.close();
    }
  });

  it("backs off and recovers without a process restart after immediate retries fail", async () => {
    const model = new DelayedRecoveryEmbeddingModel();
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      await memory.remember(localVault, { content: "Recover this local index." });
      await memory.waitForDerivedIndex();
      expect(model.attempts).toBe(4);
      expect(memory.derivedIndexStatus(localVault)).toMatchObject({
        state: "ready",
        indexedNotes: 1,
        staleNotes: 0,
        lastError: null,
      });
    } finally {
      memory.close();
    }
  });

  it("paginates hybrid search with a query-bound cursor", async () => {
    const vectors = new Map<string, number[]>([["find launch notes", [1, 0]]]);
    for (const content of ["Launch note one", "Launch note two", "Launch note three"]) {
      vectors.set(content, [1, 0]);
    }
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: new FixtureEmbeddingModel(vectors),
      retrievalMode: "hybrid",
    });
    try {
      for (const content of ["Launch note one", "Launch note two", "Launch note three"]) {
        await memory.remember(localVault, { content });
      }
      await memory.waitForDerivedIndex();
      const first = await memory.searchNotes(localVault, {
        query: "find launch notes",
        limit: 1,
      });
      expect(first.results).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await memory.searchNotes(localVault, {
        query: "find launch notes",
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.results).toHaveLength(1);
      expect(second.results[0]?.note.id).not.toBe(first.results[0]?.note.id);
    } finally {
      memory.close();
    }
  });

  it("paginates every hybrid result beyond the per-page maximum", async () => {
    const vectors = new Map<string, number[]>([["find every launch note", [1, 0]]]);
    for (let index = 0; index < 55; index += 1) {
      vectors.set(`Launch archive item ${index}`, [1, 0]);
    }
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: new FixtureEmbeddingModel(vectors),
      retrievalMode: "hybrid",
    });
    try {
      for (let index = 0; index < 55; index += 1) {
        await memory.remember(localVault, { content: `Launch archive item ${index}` });
      }
      await memory.waitForDerivedIndex();
      const first = await memory.searchNotes(localVault, {
        query: "find every launch note",
        limit: 20,
      });
      expect(first.results).toHaveLength(20);
      expect(first.nextCursor).not.toBeNull();
      const second = await memory.searchNotes(localVault, {
        query: "find every launch note",
        limit: 20,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.results).toHaveLength(20);
      expect(second.nextCursor).not.toBeNull();
      const third = await memory.searchNotes(localVault, {
        query: "find every launch note",
        limit: 20,
        cursor: second.nextCursor ?? undefined,
      });
      expect(third.results).toHaveLength(15);
      expect(third.nextCursor).toBeNull();
      expect(
        new Set(
          [...first.results, ...second.results, ...third.results].map(
            (result) => result.note.id,
          ),
        ).size,
      ).toBe(55);
    } finally {
      memory.close();
    }
  });

  it("rejects a hybrid cursor after the retrieval snapshot changes", async () => {
    const vectors = new Map<string, number[]>([
      ["find launch notes", [1, 0]],
      ["Launch note one", [1, 0]],
      ["Launch note two", [1, 0]],
      ["Launch note three", [1, 0]],
    ]);
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: new FixtureEmbeddingModel(vectors),
      retrievalMode: "hybrid",
    });
    try {
      await memory.remember(localVault, { content: "Launch note one" });
      await memory.remember(localVault, { content: "Launch note two" });
      await memory.waitForDerivedIndex();
      const first = await memory.searchNotes(localVault, {
        query: "find launch notes",
        limit: 1,
      });
      await memory.remember(localVault, { content: "Launch note three" });
      expect(
        memory.searchNotes(localVault, {
          query: "find launch notes",
          limit: 1,
          cursor: first.nextCursor ?? undefined,
        }),
      ).rejects.toThrow("Hybrid search cursor does not match this query");
    } finally {
      memory.close();
    }
  });

  it("allows a grounded semantic query that contains a conversational pronoun", async () => {
    const model = new FixtureEmbeddingModel(new Map([
      ["The deployment cannot proceed until security approves it.", [1, 0]],
      ["What did we decide about that shipping obstacle?", [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      const expected = await memory.remember(localVault, {
        content: "The deployment cannot proceed until security approves it.",
      });
      await memory.waitForDerivedIndex();
      expect(
        await memory.recall(
          localVault,
          "What did we decide about that shipping obstacle?",
        ),
      ).toMatchObject([{ note: { id: expected.id } }]);
    } finally {
      memory.close();
    }
  });

  it("cites the exact chunk that produced a semantic match", async () => {
    const prefix = "x".repeat(400);
    const evidence = "The security review is the release blocker.";
    const model = new FixtureEmbeddingModel(new Map([
      [prefix, [0, 1]],
      [evidence, [1, 0]],
      ["What prevents shipping?", [1, 0]],
    ]));
    const memory = new SqliteMemory(":memory:", localVault, {
      embeddingModel: model,
      retrievalMode: "hybrid",
    });
    try {
      await memory.remember(localVault, { content: `${prefix}${evidence}` });
      await memory.waitForDerivedIndex();
      const [result] = await memory.recall(localVault, "What prevents shipping?");
      expect(result?.citation.excerpt).toBe(evidence);
      expect(result?.note.content.includes(result?.citation.excerpt ?? "")).toBe(true);
    } finally {
      memory.close();
    }
  });
});

describe("SqliteMemory smart views", () => {
  it("refiles multi-membership views when a note changes", async () => {
    const memory = new SqliteMemory(":memory:", localVault);
    try {
      const note = await memory.remember(localVault, {
        content: "We decided to ship Friday. I will send the follow-up tomorrow.",
        source: { application: "Zoom" },
      });

      expect(memory.smartViews(localVault)).toMatchObject([
        { id: "decisions", noteCount: 1 },
        { id: "commitments", noteCount: 1 },
        { id: "meetings", noteCount: 1 },
      ]);
      expect(
        await memory.browseSmartView(localVault, "decisions", { limit: 10 }),
      ).toMatchObject({ notes: [{ id: note.id }], nextCursor: null });

      await memory.updateNote(localVault, note.id, {
        content: "Copper owl 826 is the local dogfood phrase.",
        source: null,
        expectedRevision: 1,
      });
      expect(memory.smartViews(localVault).map((view) => view.noteCount)).toEqual([
        0,
        0,
        0,
      ]);
    } finally {
      memory.close();
    }
  });
});

describe("SqliteMemory derived-index consistency", () => {
  it("rolls back the canonical note and every synchronous projection together", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-derived-index-rollback-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");
    const memory = new SqliteMemory(databasePath, localVault);
    const fault = new Database(databasePath);
    fault.exec(`
      create trigger fail_organization_projection
      before insert on note_organization
      begin
        select raise(abort, 'projection failed');
      end;
    `);
    fault.close();

    try {
      await expect(memory.remember(localVault, {
        content: "This note must not survive a derived-index failure.",
      })).rejects.toThrow("projection failed");
      expect(await memory.browseNotes(localVault)).toEqual({
        notes: [],
        nextCursor: null,
      });
      expect(memory.smartViews(localVault).every((view) => view.noteCount === 0)).toBe(true);
    } finally {
      memory.close();
    }
  });
});

describe("SqliteMemory automatic organization", () => {
  it("derives labels, people, sources, topics, and date groups and refiles edits", async () => {
    const memory = new SqliteMemory(":memory:", localVault);
    try {
      const launch = await memory.remember(localVault, {
        content: "Met with Maya Chen about the rollout plan. Security review is Friday.",
        source: { application: "Team Chat", author: "Maya Chen", label: "#launch" },
      });
      const followUp = await memory.remember(localVault, {
        content: "Maya Chen approved the rollout checklist for the local alpha.",
        source: { application: "Team Chat", author: "Maya Chen", label: "#launch" },
      });
      const repair = await memory.remember(localVault, {
        content: "Call Elena Rivera about the kitchen repair before Tuesday.",
        source: { application: "Claude" },
      });

      expect(memory.noteOrganization(localVault, launch.id)).toMatchObject({
        label: "Met with Maya Chen about the rollout plan",
        people: ["Maya Chen"],
        sources: ["Team Chat"],
      });
      expect(memory.organizationOverview(localVault)).toMatchObject({
        people: expect.arrayContaining([
          { key: "maya chen", label: "Maya Chen", noteCount: 2 },
          { key: "elena rivera", label: "Elena Rivera", noteCount: 1 },
        ]),
        sources: [
          { key: "team chat", label: "Team Chat", noteCount: 2 },
          { key: "claude", label: "Claude", noteCount: 1 },
        ],
        topics: expect.arrayContaining([
          { key: "rollout", label: "Rollout", noteCount: 2 },
        ]),
        dates: expect.arrayContaining([
          { key: "today", label: "Today", noteCount: 3 },
        ]),
      });
      expect(
        await memory.browseOrganizationFacet(
          localVault,
          { kind: "people", key: "maya chen" },
          { limit: 10 },
        ),
      ).toMatchObject({
        notes: [{ id: followUp.id }, { id: launch.id }],
        nextCursor: null,
      });
      expect(
        (
          await memory.browseOrganizationFacet(
            localVault,
            { kind: "dates", key: "today" },
            { limit: 10 },
          )
        ).notes.map((note) => note.id),
      ).toContain(repair.id);

      await memory.updateNote(localVault, launch.id, {
        content: "Jordan Lee owns the release checklist now.",
        source: { application: "Linear", author: "Jordan Lee" },
        expectedRevision: 1,
      });
      const overview = memory.organizationOverview(localVault);
      expect(overview.people).toEqual([
        { key: "elena rivera", label: "Elena Rivera", noteCount: 1 },
        { key: "jordan lee", label: "Jordan Lee", noteCount: 1 },
        { key: "maya chen", label: "Maya Chen", noteCount: 1 },
      ]);
      expect(overview.sources).toEqual([
        { key: "claude", label: "Claude", noteCount: 1 },
        { key: "linear", label: "Linear", noteCount: 1 },
        { key: "team chat", label: "Team Chat", noteCount: 1 },
      ]);
      expect(
        (
          await memory.browseOrganizationFacet(
            localVault,
            { kind: "people", key: "maya chen" },
            { limit: 10 },
          )
        ).notes.map((note) => note.id),
      ).toEqual([followUp.id]);
    } finally {
      memory.close();
    }
  });
});

class FixtureEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.75;
  readonly descriptor = {
    id: "fixture-embedding",
    revision: "1",
    dimensions: 2,
  };

  constructor(private readonly vectors: ReadonlyMap<string, number[]>) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vector = this.vectors.get(text);
      if (!vector) throw new Error(`Missing fixture embedding for: ${text}`);
      return Float32Array.from(vector);
    });
  }
}

class RecordingEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.75;
  readonly descriptor = { id: "recording", revision: "1", dimensions: 2 };
  readonly texts: string[] = [];

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.texts.push(...texts);
    return texts.map(() => Float32Array.from([1, 0]));
  }
}

class BlockingEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.75;
  readonly descriptor = { id: "blocking", revision: "1", dimensions: 2 };

  async embed(): Promise<Float32Array[]> {
    return new Promise(() => {});
  }
}

class SlowQueryEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.75;
  readonly descriptor = { id: "slow-query", revision: "1", dimensions: 2 };

  constructor(private readonly blockedQuery: string) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 1 && texts[0] === this.blockedQuery) {
      return new Promise(() => {});
    }
    return texts.map(() => Float32Array.from([1, 0]));
  }
}

class FailingQueryEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.75;
  readonly descriptor = { id: "failing-query", revision: "1", dimensions: 2 };

  constructor(private readonly failedQuery: string) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 1 && texts[0] === this.failedQuery) {
      throw new Error("local query embedding failed");
    }
    return texts.map(() => Float32Array.from([1, 0]));
  }
}

class RetryingEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.75;
  readonly descriptor = { id: "retrying", revision: "1", dimensions: 2 };
  attempts = 0;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.attempts += 1;
    if (this.attempts < 3) throw new Error("temporary local model failure");
    return texts.map(() => Float32Array.from([1, 0]));
  }
}

class DelayedRecoveryEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.75;
  readonly descriptor = { id: "delayed-recovery", revision: "1", dimensions: 2 };
  attempts = 0;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.attempts += 1;
    if (this.attempts < 4) throw new Error("temporary local model outage");
    return texts.map(() => Float32Array.from([1, 0]));
  }
}
