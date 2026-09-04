import { acquireLocalEmbeddingModel } from "./local-embedding";

const vaultPath = process.env.AFTERNOTE_TEST_VAULT_PATH;
if (!vaultPath) throw new Error("AFTERNOTE_TEST_VAULT_PATH is required");
console.log(JSON.stringify(await acquireLocalEmbeddingModel(vaultPath)));
