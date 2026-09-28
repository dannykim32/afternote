import { describe, expect, it } from "bun:test";
import { brokerDispatchTarget } from "./broker-request-policy";
import { runLocalCli } from "./local-cli";

describe("notes-only product surface", () => {
  it.each([
    "library.archive_begin", "library.archive_append", "library.archive_complete",
    "library.archive_cancel", "library.archive_status", "library.archive_list",
    "library.archive_search", "library.archive_read", "admin.archive_delete",
    "admin.approve_archive_access",
  ])("does not dispatch retired operation %s", (method) => {
    expect(() => brokerDispatchTarget(method, "owner-control"))
      .toThrow("Broker method is not available");
  });

  it("rejects the retired archive command before opening an import flow", async () => {
    await expect(runLocalCli(["archive"]))
      .rejects.toThrow("Unknown Afternote Local command: archive");
  });
});
