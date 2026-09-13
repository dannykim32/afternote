import { requireParentAndGrandparentCodeSigningRequirements } from "./sqlcipher-database";

const parentRequirement = process.env.AFTERNOTE_TEST_PARENT_CODE_REQUIREMENT;
const grandparentRequirement = process.env.AFTERNOTE_TEST_GRANDPARENT_CODE_REQUIREMENT;
if (!parentRequirement || !grandparentRequirement) {
  throw new Error("Process-chain probe configuration is incomplete");
}

requireParentAndGrandparentCodeSigningRequirements(
  parentRequirement,
  grandparentRequirement,
);
process.stdout.write("verified\n");
