import { writeFileSync } from "node:fs";
import type { SourceContext } from "@afternote/memory";
import { assertApplicationVersion } from "./application-version";
import { writeExclusivePrivateFile } from "./exclusive-export";

export const AFTERNOTE_MARKDOWN_FORMAT = "afternote-markdown-v1";
export const MAX_MARKDOWN_EXPORT_BYTES = 256 * 1_024 * 1_024;
export const MAX_MARKDOWN_EXPORT_NOTES = 100_000;

export type MarkdownExportNote = {
  id: string;
  revision: number;
  content: string;
  source: SourceContext | null;
  createdAt: string;
  updatedAt: string;
};

export function writeMarkdownExport(
  path: string,
  notes: () => Iterable<MarkdownExportNote>,
  expectedNoteCount: number,
  applicationVersion: string,
  beforePublish: () => void = () => {},
): void {
  assertApplicationVersion(applicationVersion);
  if (expectedNoteCount > MAX_MARKDOWN_EXPORT_NOTES) {
    throw new Error(
      `Markdown export cannot exceed ${MAX_MARKDOWN_EXPORT_NOTES} notes`,
    );
  }
  writeExclusivePrivateFile(path, (descriptor) => {
    let bytesWritten = 0;
    const write = (chunk: string) => {
      bytesWritten += Buffer.byteLength(chunk);
      if (bytesWritten > MAX_MARKDOWN_EXPORT_BYTES) {
        throw new Error(
          `Markdown export cannot exceed ${MAX_MARKDOWN_EXPORT_BYTES} bytes`,
        );
      }
      writeFileSync(descriptor, chunk);
    };

    write(`<!-- ${AFTERNOTE_MARKDOWN_FORMAT} -->\n`);
    write("# Afternote notes\n\n");
    write(
      "This human-readable export contains current revisions only and cannot " +
        "be restored as a lossless vault backup.\n\n",
    );
    write(`- Application version: \`${applicationVersion}\`\n`);
    write(`- Notes: ${expectedNoteCount}\n`);

    let noteCount = 0;
    for (const note of notes()) {
      write("\n---\n\n");
      write(`## Note \`${note.id}\`\n\n`);
      write("```yaml\n");
      write(`id: ${JSON.stringify(note.id)}\n`);
      write(`revision: ${note.revision}\n`);
      write(`created_at: ${JSON.stringify(note.createdAt)}\n`);
      write(`updated_at: ${JSON.stringify(note.updatedAt)}\n`);
      writeSource(write, note.source);
      write("```\n\n### Content\n\n");
      const contentFence = markdownCodeFence(note.content);
      write(`${contentFence}text\n`);
      write(note.content);
      if (!note.content.endsWith("\n")) write("\n");
      write(`${contentFence}\n`);
      noteCount += 1;
    }
    if (noteCount !== expectedNoteCount) {
      throw new Error("Markdown export source changed during export");
    }
  }, beforePublish);
}

function writeSource(
  write: (chunk: string) => void,
  source: SourceContext | null,
): void {
  if (!source) {
    write("source: null\n");
    return;
  }
  write("source:\n");
  for (const key of [
    "application",
    "url",
    "author",
    "timestamp",
    "label",
  ] as const) {
    if (source[key] !== undefined) {
      write(`  ${key}: ${JSON.stringify(source[key])}\n`);
    }
  }
}

function markdownCodeFence(content: string): string {
  let longestRun = 0;
  for (const run of content.matchAll(/`+/g)) {
    longestRun = Math.max(longestRun, run[0].length);
  }
  return "`".repeat(Math.max(3, longestRun + 1));
}
