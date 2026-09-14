import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { BrokerAuditReader } from "./broker-audit-reader";
import { VaultBrokerAuthorization } from "./vault-broker";
import { SqlcipherDatabase } from "./sqlcipher-database";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("BrokerAuditReader", () => {
  it("reads a fixed snapshot without duplicates or concurrent inserts", () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) f.insert(`event-${i}`);
    const first = f.reader.read({ pageSize: 2 });
    f.insert("later-event");
    const second = f.reader.read({ pageSize: 2, cursor: first.nextCursor! });
    const third = f.reader.read({ pageSize: 2, cursor: second.nextCursor! });
    expect([...first.events, ...second.events, ...third.events].map(e => e.eventId))
      .toEqual(["event-4", "event-3", "event-2", "event-1", "event-0"]);
    expect(third.nextCursor).toBeNull();
    expect(f.reader.read({ pageSize: 1 }).events[0]!.eventId).toBe("later-event");
  });

  it("projects only metadata and reads through a query-only borrowed connection", () => {
    const f = fixture();
    f.database.exec(`
      insert into broker_clients (
        id, vault_id, kind, display_name, install_identity, public_key,
        code_requirement, status, paired_at
      ) values ('desktop', 'vault-one', 'claude-desktop', 'untrusted display text',
        'private-install', 'private-key-marker', 'private-requirement', 'paired', 'now');
    `);
    f.insert("desktop-event", "desktop", JSON.stringify([{ noteId: "note-1", revision: 2 }]));
    f.database.exec("pragma query_only = ON");
    expect(f.reader.read({})).toEqual({
      events: [{
        eventId: "desktop-event", occurredAt: "2026-09-14T12:00:00.000Z",
        clientId: "desktop", clientKind: "claude-desktop", clientDisplayLabel: "Claude Desktop",
        grantId: null, sessionId: null, operation: "memory.remember", outcome: "success",
        errorCode: null, noteRefs: [{ noteId: "note-1", revision: 2 }],
      }],
      nextCursor: null,
    });
    // Reading does not close the caller's connection.
    expect(f.database.query<{ count: number }>("select count(*) as count from broker_clients").get()!.count)
      .toBe(1);
  });

  it("uses fixed labels for non-connector audit actors", () => {
    const f = fixture();
    for (const actor of ["owner", "native-library", "pending:pairing", "missing-client"]) {
      f.insert(actor, actor);
    }
    expect(f.reader.read({}).events.map(e => e.clientDisplayLabel))
      .toEqual(["Unknown client", "Pending client", "Afternote Library", "Owner"]);
  });

  it("handles empty history and bounded default and explicit page sizes", () => {
    const f = fixture();
    expect(f.reader.read({})).toEqual({ events: [], nextCursor: null });
    for (let i = 0; i < 101; i++) f.insert(`event-${i}`);
    expect(f.reader.read({}).events).toHaveLength(50);
    expect(f.reader.read({ pageSize: 100 }).events).toHaveLength(100);
    for (const pageSize of [0, -1, 101, 1.5, NaN, Infinity]) {
      expect(() => f.reader.read({ pageSize })).toThrow("page size");
    }
  });

  it("rejects malformed, oversized, noncanonical, and modified cursors", () => {
    const f = fixture();
    f.insert("first"); f.insert("second");
    const cursor = f.reader.read({ pageSize: 1 }).nextCursor!;
    const [payload, signature] = cursor.split(".");
    const changed = Buffer.from(JSON.stringify({ beforeRowId: 999 })).toString("base64url");
    for (const invalid of ["x", "x".repeat(2049), "a.b.c", `${payload}.${signature}!`,
      `${payload}.${signature}=`, `${changed}.${signature}`, `${payload}.AA`]) {
      expect(() => f.reader.read({ cursor: invalid })).toThrow("cursor");
    }
  });

  it("keeps the original cursor deadline across pages and expires at the limit", () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) f.insert(`event-${i}`);
    const first = f.reader.read({ pageSize: 1 });
    f.advance(9 * 60_000);
    const second = f.reader.read({ pageSize: 1, cursor: first.nextCursor! });
    f.advance(60_000);
    expect(() => f.reader.read({ cursor: second.nextCursor! })).toThrow("stale");
    expect(f.reader.read({}).events).toHaveLength(4);
  });

  it("does not accept cursors from a different reader, vault, or broker boot", () => {
    const f = fixture();
    f.insert("first"); f.insert("second");
    const cursor = f.reader.read({ pageSize: 1 }).nextCursor!;
    const payload = JSON.parse(Buffer.from(cursor.split(".")[0]!, "base64url").toString());
    expect(payload).toMatchObject({ version: 1, vaultId: "vault-one", brokerBootId: "boot-one" });
    for (const context of [{}, { vaultId: "vault-two" }, { bootId: "boot-two" }]) {
      const reader = new BrokerAuditReader({
        database: f.database, vaultId: "vault-one", bootId: "boot-one", now: f.now, ...context,
      });
      expect(() => reader.read({ cursor })).toThrow("signature");
    }
  });

  it.each([
    "not-json", "{}", JSON.stringify(Array(21).fill({ noteId: "note", revision: 1 })),
    '[null]', '[{"noteId":"note","revision":0}]',
    '[{"noteId":"note","revision":1,"content":"private"}]',
    '[{"noteId":"invalid/path","revision":1}]',
    JSON.stringify([{ noteId: "a".repeat(128) + "\n", revision: 1 }]),
  ])("rejects malformed stored note references: %s", (refs) => {
    const f = fixture();
    f.insert("invalid", "owner", refs);
    expect(() => f.reader.read({})).toThrow();
  });

  it("refuses an oversized event page without returning a partial response", () => {
    const f = fixture();
    const refs = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({
      noteId: `${i}`.padEnd(128, "a"), revision: 1,
    })));
    for (let i = 0; i < 100; i++) f.insert(`event-${i}`, "owner", refs);
    expect(() => f.reader.read({ pageSize: 100 })).toThrow("byte limit");
    expect(f.reader.read({ pageSize: 1 }).events).toHaveLength(1);
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "afternote-audit-reader-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const path = join(directory, "vault.db");
  const database = new SqlcipherDatabase(path, { key });
  cleanups.push(() => database.close());
  let time = Date.parse("2026-09-14T12:00:00.000Z");
  const now = () => time;
  // Initialize the production schema, rather than duplicating it in the fixture.
  const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const broker = new VaultBrokerAuthorization({
    database, path, key, vaultId: "vault-one", bootId: "boot-one", now,
    ownerPublicKey: owner.publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
  broker.close(); // Borrowed database remains open; reads need no live authority.
  const reader = new BrokerAuditReader({ database, vaultId: "vault-one", bootId: "boot-one", now });
  return {
    database, reader, now,
    advance(ms: number) { time += ms; },
    insert(eventId: string, clientId = "owner", refs = "[]") {
      database.query(`insert into broker_audit_events (
        event_id, occurred_at, client_id, grant_id, session_id, operation, outcome, error_code, note_refs
      ) values (?, ?, ?, null, null, 'memory.remember', 'success', null, ?)`)
        .run(eventId, new Date(time).toISOString(), clientId, refs);
    },
  };
}
