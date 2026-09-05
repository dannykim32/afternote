import { describe, expect, it } from "bun:test";
import {
  RetryableDownloadError,
  retryTransientDownload,
} from "./retry-transient-download";

describe("bounded release download retries", () => {
  it("retries transient failures with bounded backoff", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const value = await retryTransientDownload(async () => {
      attempts += 1;
      if (attempts < 3) throw new RetryableDownloadError("connection reset");
      return "verified bytes";
    }, {
      maximumAttempts: 3,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(value).toBe("verified bytes");
    expect(attempts).toBe(3);
    expect(waits).toEqual([500, 1_000]);
  });

  it("does not retry integrity or permanent failures", async () => {
    let attempts = 0;
    await expect(retryTransientDownload(async () => {
      attempts += 1;
      throw new Error("checksum mismatch");
    }, {
      maximumAttempts: 3,
      wait: async () => {},
    })).rejects.toThrow("checksum mismatch");
    expect(attempts).toBe(1);
  });

  it("returns the last transient failure after the bound", async () => {
    let attempts = 0;
    await expect(retryTransientDownload(async () => {
      attempts += 1;
      throw new RetryableDownloadError(`connection reset ${attempts}`);
    }, {
      maximumAttempts: 3,
      wait: async () => {},
    })).rejects.toThrow("connection reset 3");
    expect(attempts).toBe(3);
  });
});
