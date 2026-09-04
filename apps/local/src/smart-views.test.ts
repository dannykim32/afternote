import { describe, expect, it } from "bun:test";
import { deriveSystemSmartViewIds } from "./smart-views";

describe("system smart views", () => {
  it("allows one note to belong to several derived views", () => {
    expect(
      deriveSystemSmartViewIds({
        content: "We decided to ship Friday. I will send the follow-up tomorrow.",
        source: { application: "Zoom", label: "Product review" },
      }),
    ).toEqual(["decisions", "commitments", "meetings"]);
  });

  it("does not force unrelated notes into a view", () => {
    expect(
      deriveSystemSmartViewIds({
        content: "Copper owl 826 is the local dogfood phrase.",
        source: { application: "Codex" },
      }),
    ).toEqual([]);
  });
});
