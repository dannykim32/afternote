import { describe, expect, it } from "bun:test";
import { resolveTemporalExpressions } from "./temporal";

describe("temporal expression resolution", () => {
  it("resolves explicit dates with or without a written year", () => {
    const options = {
      referenceTimestamp: "2026-08-31T18:00:00.000Z",
      timeZone: "America/Denver",
    };
    expect(resolveTemporalExpressions(
      "August 28, 2026; Aug 28th; 2026-08-28",
      options,
    )).toMatchObject([
      { phrase: "August 28, 2026", rangeStart: "2026-08-28T06:00:00.000Z" },
      { phrase: "Aug 28th", rangeStart: "2026-08-28T06:00:00.000Z" },
      { phrase: "2026-08-28", rangeStart: "2026-08-28T06:00:00.000Z" },
    ]);
  });

  it("leaves invalid explicit dates untouched", () => {
    expect(resolveTemporalExpressions("February 30, 2026", {
      referenceTimestamp: "2026-08-31T18:00:00.000Z",
      timeZone: "America/Denver",
    })).toEqual([]);
  });

  it("resolves last week and last Friday against the same local calendar", () => {
    const options = {
      referenceTimestamp: "2026-08-31T18:00:00.000Z",
      timeZone: "America/Denver",
    };
    expect(resolveTemporalExpressions("Mike went to the farm last week", options)).toMatchObject([
      {
        phrase: "last week",
        rangeStart: "2026-08-24T06:00:00.000Z",
        rangeEnd: "2026-08-31T06:00:00.000Z",
      },
    ]);
    expect(resolveTemporalExpressions("What happened last Friday?", options)).toMatchObject([
      {
        phrase: "last Friday",
        rangeStart: "2026-08-28T06:00:00.000Z",
        rangeEnd: "2026-08-29T06:00:00.000Z",
      },
    ]);
  });

  it("uses the correct offset on both sides of a daylight-saving boundary", () => {
    const [lastWeek] = resolveTemporalExpressions("last week", {
      referenceTimestamp: "2026-03-09T18:00:00.000Z",
      timeZone: "America/Denver",
    });
    expect(lastWeek).toMatchObject({
      rangeStart: "2026-03-02T07:00:00.000Z",
      rangeEnd: "2026-03-09T06:00:00.000Z",
    });
  });

  it("uses the first valid instant when daylight saving skips local midnight", () => {
    expect(resolveTemporalExpressions("today", {
      referenceTimestamp: "2026-03-08T16:00:00.000Z",
      timeZone: "America/Havana",
    })[0]).toMatchObject({
      rangeStart: "2026-03-08T05:00:00.000Z",
      rangeEnd: "2026-03-09T04:00:00.000Z",
    });
    expect(resolveTemporalExpressions("today", {
      referenceTimestamp: "2026-09-06T16:00:00.000Z",
      timeZone: "America/Santiago",
    })[0]).toMatchObject({
      rangeStart: "2026-09-06T04:00:00.000Z",
      rangeEnd: "2026-09-07T03:00:00.000Z",
    });
  });

  it("crosses month and year boundaries without losing the local date", () => {
    expect(resolveTemporalExpressions("last Friday", {
      referenceTimestamp: "2027-01-04T18:00:00.000Z",
      timeZone: "America/Denver",
    })[0]).toMatchObject({
      rangeStart: "2027-01-01T07:00:00.000Z",
      rangeEnd: "2027-01-02T07:00:00.000Z",
    });
  });

  it("leaves ambiguous dates untouched instead of inventing precision", () => {
    expect(resolveTemporalExpressions("We should ship Friday", {
      referenceTimestamp: "2026-08-31T18:00:00.000Z",
      timeZone: "America/Denver",
    })).toEqual([]);
  });

  it("records the exact source span for each resolved phrase", () => {
    expect(resolveTemporalExpressions("Before last week, then next Friday.", {
      referenceTimestamp: "2026-08-31T18:00:00.000Z",
      timeZone: "America/Denver",
    })).toMatchObject([
      { phrase: "last week", start: 7, end: 16 },
      { phrase: "next Friday", start: 23, end: 34 },
    ]);
  });

  it("resolves conversational offsets and weekend ranges", () => {
    const options = {
      referenceTimestamp: "2026-08-31T18:00:00.000Z",
      timeZone: "America/Denver",
    };
    expect(resolveTemporalExpressions(
      "The reminder was three days ago and the trip is in two weeks.",
      options,
    )).toMatchObject([
      {
        phrase: "three days ago",
        rangeStart: "2026-08-28T06:00:00.000Z",
        rangeEnd: "2026-08-29T06:00:00.000Z",
      },
      {
        phrase: "in two weeks",
        rangeStart: "2026-09-14T06:00:00.000Z",
        rangeEnd: "2026-09-21T06:00:00.000Z",
      },
    ]);
    expect(resolveTemporalExpressions("What is happening next weekend?", options))
      .toMatchObject([{
        phrase: "next weekend",
        rangeStart: "2026-09-12T06:00:00.000Z",
        rangeEnd: "2026-09-14T06:00:00.000Z",
      }]);
  });

  it("resolves adjacent-day phrases and named month ranges", () => {
    const options = {
      referenceTimestamp: "2026-12-31T18:00:00.000Z",
      timeZone: "America/Denver",
    };
    expect(resolveTemporalExpressions(
      "Check the day after tomorrow and review March 2027.",
      options,
    )).toMatchObject([
      {
        phrase: "day after tomorrow",
        rangeStart: "2027-01-02T07:00:00.000Z",
        rangeEnd: "2027-01-03T07:00:00.000Z",
      },
      {
        phrase: "March 2027",
        rangeStart: "2027-03-01T07:00:00.000Z",
        rangeEnd: "2027-04-01T06:00:00.000Z",
      },
    ]);
  });
});
