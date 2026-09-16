import { runLocalCli } from "./local-cli";
import {
  acquireLocalEmbeddingModel,
  setSemanticSearchEnabled,
  localEmbeddingStatus,
  semanticModelCatalog,
  openLocalEmbeddingModel,
} from "./local-embedding";

import { dirname, join } from "node:path";
declare const AFTERNOTE_STANDALONE: boolean | undefined;
const modelOptions = typeof AFTERNOTE_STANDALONE === "boolean" && AFTERNOTE_STANDALONE
  ? { bundledModelPath: join(dirname(process.execPath), "semantic-model") } : undefined;

try {
  await runLocalCli(process.argv.slice(2), {
    open: (path) => openLocalEmbeddingModel(path, modelOptions),
    status: (path) => localEmbeddingStatus(path, undefined, modelOptions),
    catalog: (path) => semanticModelCatalog(path, modelOptions),
    setEnabled: (path, enabled) => { setSemanticSearchEnabled(path, enabled); return semanticModelCatalog(path, modelOptions); },
    acquire: acquireLocalEmbeddingModel,
    help: `
  eval-recall [--semantic] [--noise 10|100] [--notes 10000]
                       Run deterministic Recall quality and noise-scaling gates
  semantic status|catalog|check|enable|disable
                       Inspect or change local search by meaning (on by default)`,
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
