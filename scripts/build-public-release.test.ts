import { describe, expect, it } from "bun:test";
import { PUBLIC_RELEASE_COMMANDS } from "./build-public-release";

describe("public release command gates", () => {
  it("runs the 10,000-note performance gate in its own process", () => {
    expect(PUBLIC_RELEASE_COMMANDS).toContainEqual(["run", "test:quality"]);
  });
});
