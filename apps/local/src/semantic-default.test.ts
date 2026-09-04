import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

describe("semantic recall release default", () => {
  it("keeps packaged installs on exact search until the pinned model passes its quality gate", () => {
    const installer = readFileSync(
      join(import.meta.dir, "../packaging/install.sh"),
      "utf8",
    );
    const packagingReadme = readFileSync(
      join(import.meta.dir, "../packaging/README.md"),
      "utf8",
    );

    expect(installer).not.toContain("install-semantic-default.sh");
    expect(packagingReadme).toContain("afternote semantic install");
    expect(packagingReadme).toContain(
      "Exact search remains the release default",
    );
  });
});
