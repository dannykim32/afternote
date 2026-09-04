import { runLocalCli } from "./local-cli";
import {
  acquireLocalEmbeddingModel,
  localEmbeddingStatus,
  openLocalEmbeddingModel,
} from "./local-embedding";

try {
  await runLocalCli(process.argv.slice(2), {
    open: openLocalEmbeddingModel,
    status: localEmbeddingStatus,
    acquire: acquireLocalEmbeddingModel,
    help: `
  eval-recall [--semantic] [--noise 10|100] [--notes 10000]
                       Run deterministic Recall quality and noise-scaling gates
  semantic status|install
                       Inspect or install the pinned local semantic-search model`,
  });
} catch (error) {
  const rawMessage = error instanceof Error ? error.message : "";
  let displaySafeMessage = "";
  for (const character of rawMessage) {
    const codePoint = character.codePointAt(0) ?? 0;
    displaySafeMessage += codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? " "
      : character;
    if (displaySafeMessage.length >= 500) break;
  }
  const message = displaySafeMessage.replace(/\s+/gu, " ").trim() ||
    "Afternote command failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
