import { matchesAncestorCodeSigningRequirements } from "./sqlcipher-database";

const serializedRequirements = process.env.AFTERNOTE_TEST_ANCESTOR_CODE_REQUIREMENTS;
if (!serializedRequirements) {
  throw new Error("Process-chain probe configuration is incomplete");
}

const requirements: unknown = JSON.parse(serializedRequirements);
if (!Array.isArray(requirements) ||
  !requirements.every((requirement) => typeof requirement === "string")) {
  throw new Error("Process-chain probe requirements are invalid");
}
if (!matchesAncestorCodeSigningRequirements(requirements)) {
  throw new Error("Ancestor process does not satisfy the required code signature");
}
process.stdout.write("verified\n");
