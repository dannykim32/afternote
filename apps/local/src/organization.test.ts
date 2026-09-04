import { describe, expect, it } from "bun:test";
import {
  compactNoteLabel,
  deriveNoteOrganization,
  organizationDateRanges,
} from "./organization";

describe("automatic organization date groups", () => {
  it("keeps Monday's Today, Yesterday, This week, and Older ranges disjoint", () => {
    const ranges = organizationDateRanges(new Date("2026-08-31T12:00:00-06:00"));
    const yesterday = ranges.find((range) => range.key === "yesterday")!;
    const thisWeek = ranges.find((range) => range.key === "this-week")!;
    const older = ranges.find((range) => range.key === "older")!;
    expect(thisWeek.start).toBe(thisWeek.end);
    expect(older.end).toBe(yesterday.start);
  });

  it("ends Today at the next local midnight", () => {
    const now = new Date("2026-08-27T12:00:00-06:00");
    const today = organizationDateRanges(now).find(
      (range) => range.key === "today",
    )!;
    expect(today.end).toBe(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
    );
  });

  it("deduplicates topic candidates before applying the per-note cap", () => {
    expect(
      deriveNoteOrganization({
        content:
          "Project project project project project project security review rollout decision.",
        source: null,
      }).topics,
    ).toEqual(["Project", "Security", "Review", "Rollout", "Decision"]);
  });

  it("removes checked and unchecked Markdown task markers from labels", () => {
    expect(compactNoteLabel("- [ ] Buy milk before Tuesday.")).toBe(
      "Buy milk before Tuesday",
    );
    expect(compactNoteLabel("- [x] Shipped the browser connector.")).toBe(
      "Shipped the browser connector",
    );
  });
});
