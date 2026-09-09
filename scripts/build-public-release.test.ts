import { describe, expect, it } from "bun:test";
import { PUBLIC_RELEASE_COMMANDS } from "./build-public-release";

describe("public release command gates", () => {
  it("runs the 10,000-note performance gate in its own process", () => {
    expect(PUBLIC_RELEASE_COMMANDS).toContainEqual({
      args: ["run", "test:quality"],
      phase: "quality",
    });
  });

  it("prepares pinned native dependencies before any gate that builds them", () => {
    expect(PUBLIC_RELEASE_COMMANDS[0]).toEqual({
      args: ["run", "prepare:native-release"],
      phase: "release-preparation",
    });
    expect(PUBLIC_RELEASE_COMMANDS.findIndex(({ args }) =>
      args[1] === "test"
    )).toBeGreaterThan(0);
  });
});
