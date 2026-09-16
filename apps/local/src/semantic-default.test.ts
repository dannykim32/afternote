import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { PUBLIC_RELEASE_COMMANDS } from "../../../scripts/build-public-release";

it("prepares pinned model data for the signed release and keeps installation offline", () => {
  expect(PUBLIC_RELEASE_COMMANDS).toContainEqual({args: ["run", "prepare:semantic-release"], phase: "release-preparation"});
  const installer = readFileSync(join(import.meta.dir, "../packaging/install.sh"), "utf8");
  expect(installer).toContain('cp -R "$script_dir/semantic-model" "$version_stage/semantic-model"');
  expect(installer).not.toContain("semantic install");
  expect(readFileSync(join(import.meta.dir, "../packaging/README.md"), "utf8")).toContain("Search by meaning is on by default");
});
