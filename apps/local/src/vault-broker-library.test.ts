/* eslint-disable @typescript-eslint/no-explicit-any -- public protocol fixtures decode JSON */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { VaultContext } from "@afternote/memory";
import { SqlcipherDatabase } from "./sqlcipher-database";
import { SqliteMemory } from "./sqlite-memory";
import type { TextEmbeddingModel } from "./retrieval";
import { LOCAL_EMBEDDING_MODEL } from "./transformers-embedding";
import { discoverLocalEmbeddingModel } from "./local-embedding";
import { VaultBrokerWorker } from "./vault-broker-worker";
import { LIBRARY_SCOPES } from "./vault-broker-library";

const directories: string[] = [];
const workers: VaultBrokerWorker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("native Library broker protocol", () => {
  it("activates a newly installed model without reopening the vault or changing a note", async () => {
    const note = "The launch cannot proceed until the security review is approved.";
    const query = "What is preventing us from shipping?";
    let installed = false;
    let discoveries = 0;
    const model = new FixtureEmbeddingModel(new Map([[note, [1, 0]], [query, [1, 0]]]));
    const fixture = workerFixture({ embeddingModelProvider: () => { discoveries++; return installed ? model : null; } });
    const connection = { connectionId: randomUUID(), peerPid: 51007 };
    expect((await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES])).searchMode).toBe("exact");
    const saved = (await ownerRequest(fixture.worker, connection, "library.remember", { content: note, source: null })).note;
    installed = true;
    const stranger = { connectionId: randomUUID(), peerPid: 51008 };
    const denied = await rawOwnerRequest(fixture.worker, stranger, "library.refresh_search", {});
    expect(denied.ok).toBe(false);
    const refreshed = await ownerRequest(fixture.worker, connection, "library.refresh_search", {});
    expect(["indexing", "hybrid"]).toContain(refreshed.searchMode);
    expect(refreshed.modelId).toBe(model.descriptor.id);
    const beforePoll = discoveries;
    await ownerRequest(fixture.worker, connection, "library.refresh_search", { reloadModel: false });
    expect(discoveries).toBe(beforePoll);
    let searched;
    for (let attempt = 0; attempt < 30; attempt++) {
      searched = await ownerRequest(fixture.worker, connection, "library.search", { cursor: null, limit: 10, query });
      if (searched.searchMode === "hybrid") break;
      await Bun.sleep(5);
    }
    expect(searched.searchMode).toBe("hybrid");
    expect(searched.results).toMatchObject([{ citation: { noteId: saved.id, revision: 1 } }]);
    expect((await ownerRequest(fixture.worker, connection, "library.get_note", { id: saved.id, revision: null })).note).toMatchObject({ content: note, revision: 1 });
    expect((await ownerRequest(fixture.worker, connection, "library.refresh_search", {})).searchMode).toBe("hybrid");
    installed = false;
    expect((await ownerRequest(fixture.worker, connection, "library.refresh_search", {})).searchMode).toBe("exact");
    expect((await ownerRequest(fixture.worker, connection, "library.search", {cursor: null, limit: 10, query})).results).toEqual([]);
    expect((await ownerRequest(fixture.worker, connection, "library.get_note", {id: saved.id, revision: null})).note).toMatchObject({content: note, revision: 1});
    installed = true;
    await ownerRequest(fixture.worker, connection, "library.refresh_search", {});
    expect((await ownerRequest(fixture.worker, connection, "library.search", {cursor: null, limit: 10, query})).results).toMatchObject([{citation: {noteId: saved.id}}]);
  });

  it("requires a current search scope and rejects activation parameters", async () => {
    let now = Date.parse("2026-09-15T12:00:00.000Z");
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 51009 };
    await beginLibrarySession(fixture.worker, connection, ["library.browse"]);
    expect((await rawOwnerRequest(fixture.worker, connection, "library.refresh_search", {})).ok).toBe(false);
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    expect(await rawOwnerRequest(fixture.worker, connection, "library.refresh_search", { path: "/tmp/untrusted" }))
      .toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await rawOwnerRequest(fixture.worker, connection, "library.refresh_search", { reloadModel: "yes" }))
      .toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const session = await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    now = Date.parse(session.expiresAt) + 1;
    expect((await rawOwnerRequest(fixture.worker, connection, "library.refresh_search", {})).ok).toBe(false);
  });

  it("reports and uses hybrid Library search when a verified local model is available", async () => {
    const note = "The launch cannot proceed until the security review is approved.";
    const query = "What is preventing us from shipping?";
    const model = new FixtureEmbeddingModel(new Map([
      [note, [1, 0]],
      [query, [1, 0]],
    ]));
    const fixture = workerFixture({ embeddingModel: model });
    const connection = { connectionId: randomUUID(), peerPid: 51000 };
    const session = await beginLibrarySession(
      fixture.worker,
      connection,
      [...LIBRARY_SCOPES],
    );
    expect(session.searchMode).toBe("hybrid");

    const remembered = (await ownerRequest(
      fixture.worker,
      connection,
      "library.remember",
      { content: note, source: null },
    )).note;

    let searched;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      searched = await ownerRequest(fixture.worker, connection, "library.search", {
        cursor: null,
        limit: 10,
        query,
      });
      if (searched.searchMode === "hybrid") break;
      await Bun.sleep(5);
    }
    expect(searched.searchMode).toBe("hybrid");
    expect(searched.results).toMatchObject([
      { citation: { noteId: remembered.id, revision: 1 } },
    ]);
  });

  it("keeps exact results available and reports degraded when model discovery fails", async () => {
    const fixture = workerFixture({
      embeddingModelProvider: () => {
        throw new Error("fixture model inspection failure");
      },
    });
    const connection = { connectionId: randomUUID(), peerPid: 51005 };
    const session = await beginLibrarySession(
      fixture.worker,
      connection,
      [...LIBRARY_SCOPES],
    );
    expect(session.searchMode).toBe("degraded");
  });

  it("reports degraded for an incomplete local semantic model installation", async () => {
    const fixture = workerFixture({ invalidEmbeddingInstallation: true });
    const connection = { connectionId: randomUUID(), peerPid: 51006 };
    const session = await beginLibrarySession(
      fixture.worker,
      connection,
      [...LIBRARY_SCOPES],
    );
    expect(session.searchMode).toBe("degraded");
  });

  it("admits only owner-control with fresh presence and binds the session to boot, vault, connection, PID, scopes, replay, and expiry", async () => {
    let now = Date.now();
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 51001 };
    const otherConnection = { connectionId: randomUUID(), peerPid: 51002 };
    await ownerRequest(
      fixture.worker,
      connection,
      "owner.set_routine_authentication",
      { ttlMs: 15 * 60 * 1_000 },
    );
    const params = {
      requestedScopes: ["library.browse", "library.search"],
      ttlMs: 1_000,
    };

    expect(await rawRequest(
      fixture.worker,
      connection,
      "memory-client",
      "library.session.begin",
      params,
      true,
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    const first = await beginOwnerRequest(
      fixture.worker,
      connection,
      "library.session.begin",
      params,
    );
    expect(first.ownerPresenceChallenge.reason).toContain("Open the Afternote Library");
    const approved = await completeOwnerPresence(
      fixture.worker,
      connection,
      first.ownerPresenceChallenge.challengeId,
      "approved",
    );
    expect(approved).toMatchObject({
      ok: true,
      result: {
        scopes: params.requestedScopes,
        brokerBootId: fixture.worker.bootId,
        vaultId: fixture.vault.vaultId,
      },
    });
    expect(await completeOwnerPresence(
      fixture.worker,
      connection,
      first.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });

    expect(await rawOwnerRequest(
      fixture.worker,
      connection,
      "library.browse",
      { cursor: null, limit: 10, view: null },
    )).toMatchObject({ ok: false, error: { code: "library_session_required" } });
    await ownerRequest(
      fixture.worker,
      connection,
      "library.session.begin",
      params,
      true,
    );

    expect(await rawOwnerRequest(
      fixture.worker,
      otherConnection,
      "library.browse",
      { cursor: null, limit: 10, view: null },
    )).toMatchObject({ ok: false, error: { code: "library_session_required" } });
    expect(await rawOwnerRequest(
      fixture.worker,
      connection,
      "library.remember",
      { content: "scope escalation", source: null },
    )).toMatchObject({ ok: false, error: { code: "scope_denied" } });

    expect(await rawOwnerRequest(
      fixture.worker,
      connection,
      "library.browse",
      { cursor: null, limit: 0, view: null },
    )).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await rawOwnerRequest(
      fixture.worker,
      connection,
      "library.browse",
      { cursor: null, limit: 10, view: null },
    )).toMatchObject({ ok: false, error: { code: "library_session_required" } });
    await ownerRequest(
      fixture.worker,
      connection,
      "library.session.begin",
      params,
      true,
    );

    now += 15 * 60 * 1_000 + 1;
    expect(await rawOwnerRequest(
      fixture.worker,
      connection,
      "library.browse",
      { cursor: null, limit: 10, view: null },
    )).toMatchObject({ ok: false, error: { code: "library_session_expired" } });

    await beginLibrarySession(fixture.worker, connection, ["library.browse"]);
    await fixture.worker.handleSerialized(JSON.stringify({
      kind: "connection-closed",
      peerRole: "owner-control",
      ...connection,
      payload: {},
    }));
    expect(await rawOwnerRequest(
      fixture.worker,
      connection,
      "library.browse",
      { cursor: null, limit: 10, view: null },
    )).toMatchObject({ ok: false, error: { code: "library_session_required" } });

    fixture.worker.close();
    workers.splice(workers.indexOf(fixture.worker), 1);
    const restarted = new VaultBrokerWorker({
      applicationVersion: "test-worker-restarted",
      vaultPath: fixture.path,
      vaultKey: fixture.key,
      vault: fixture.vault,
      bootId: randomUUID(),
      now: () => now,
    });
    workers.push(restarted);
    expect(await rawOwnerRequest(
      restarted,
      connection,
      "library.browse",
      { cursor: null, limit: 10, view: null },
    )).toMatchObject({ ok: false, error: { code: "library_session_required" } });
  });

  it("distinguishes failed authentication outcomes without creating a session", async () => {
    for (const [outcome, code] of [
      ["denied", "owner_denied"],
      ["cancelled", "owner_cancelled"],
      ["timed_out", "owner_timeout"],
      ["unavailable", "owner_auth_unavailable"],
    ] as const) {
      const fixture = workerFixture();
      const connection = { connectionId: randomUUID(), peerPid: 51100 };
      await beginLibrarySession(fixture.worker, connection, ["library.browse"]);
      const response = await rawOwnerRequest(
        fixture.worker,
        connection,
        "library.session.begin",
        { requestedScopes: ["library.browse"], ttlMs: 60_000 },
        outcome,
      );
      expect(response).toMatchObject({ ok: false, error: { code } });
      expect(await rawOwnerRequest(
        fixture.worker,
        connection,
        "library.browse",
        { cursor: null, limit: 10, view: null },
      )).toMatchObject({ ok: false, error: { code: "library_session_required" } });
    }
  });

  it("supports the user-selectable daily routine Notes session", async () => {
    const now = Date.parse("2026-09-06T12:00:00.000Z");
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 51150 };
    const ttlMs = 24 * 60 * 60 * 1_000;

    const session = await ownerRequest(
      fixture.worker,
      connection,
      "library.session.begin",
      { requestedScopes: ["library.browse"], ttlMs },
      true,
    );

    expect(session.expiresAt).toBe(new Date(now + ttlMs).toISOString());
  });

  it("pages bounded summaries and exact search citations with authenticated operation-bound cursors", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 51200 };
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    const remembered = [];
    for (const content of [
      "Approved the north-star release decision with exact redwood phrase.",
      "We will follow up on the migration tomorrow.",
      "Meeting notes from the weekly product review.",
    ]) {
      remembered.push((await ownerRequest(
        fixture.worker,
        connection,
        "library.remember",
        { content, source: { application: "Afternote test", label: "Fixture" } },
      )).note);
    }

    const views = await ownerRequest(fixture.worker, connection, "library.views", {});
    expect(views.views).toEqual([
      { id: "decisions", label: "Decisions", noteCount: 1 },
      { id: "commitments", label: "Commitments", noteCount: 1 },
      { id: "meetings", label: "Meetings", noteCount: 1 },
    ]);

    const first = await ownerRequest(fixture.worker, connection, "library.browse", {
      cursor: null,
      limit: 1,
      view: null,
    });
    expect(first.notes).toHaveLength(1);
    expect(first.notes[0]).not.toHaveProperty("content");
    expect(first.notes[0].excerpt.length).toBeGreaterThan(0);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const second = await ownerRequest(fixture.worker, connection, "library.browse", {
      cursor: first.nextCursor,
      limit: 1,
      view: null,
    });
    expect(second.notes[0].id).not.toBe(first.notes[0].id);

    const [cursorPayload, cursorSignature] = first.nextCursor.split(".");
    const invalidSignature = `${cursorSignature[0] === "A" ? "B" : "A"}${cursorSignature.slice(1)}`;
    const expectCursorRejectionClosesSession = async (cursor: string, view: string | null) => {
      expect(await rawOwnerRequest(fixture.worker, connection, "library.browse", {
        cursor,
        limit: 1,
        view,
      })).toMatchObject({ ok: false, error: { code: "invalid_cursor" } });
      expect(await rawOwnerRequest(fixture.worker, connection, "library.browse", {
        cursor: null,
        limit: 1,
        view: null,
      })).toMatchObject({ ok: false, error: { code: "library_session_required" } });
      await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    };
    await expectCursorRejectionClosesSession(`${cursorPayload}.${invalidSignature}`, null);
    const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalSignatureIndex = base64urlAlphabet.indexOf(cursorSignature.at(-1)!);
    expect(finalSignatureIndex).toBeGreaterThanOrEqual(0);
    expect(finalSignatureIndex % 4).toBe(0);
    const aliasedSignature = `${cursorSignature.slice(0, -1)}${base64urlAlphabet[finalSignatureIndex + 1]}`;
    expect(Buffer.from(aliasedSignature, "base64url")).toEqual(Buffer.from(cursorSignature, "base64url"));
    await expectCursorRejectionClosesSession(`${cursorPayload}.${aliasedSignature}`, null);
    await expectCursorRejectionClosesSession(`${first.nextCursor}=`, null);
    await expectCursorRejectionClosesSession(first.nextCursor, "decisions");

    const searched = await ownerRequest(fixture.worker, connection, "library.search", {
      cursor: null,
      limit: 10,
      query: "exact redwood",
    });
    expect(searched.results).toHaveLength(1);
    expect(searched.results[0]).toMatchObject({
      citation: { noteId: remembered[0].id, revision: 1 },
    });
    expect(Object.keys(searched.results[0])).toEqual(["citation"]);
    expect(Object.keys(searched.results[0].citation).sort()).toEqual([
      "createdAt", "excerpt", "noteId", "revision", "source",
    ]);
    expect(searched.results[0].citation).toMatchObject({
      source: { application: "Afternote test", label: "Fixture" },
      createdAt: expect.any(String),
    });
    expect(Object.keys(first.notes[0]).sort()).toEqual([
      "createdAt", "excerpt", "id", "revision", "source", "updatedAt",
    ]);

    const decisionPage = await ownerRequest(fixture.worker, connection, "library.browse", {
      cursor: null,
      limit: 20,
      view: "decisions",
    });
    expect(decisionPage.notes.map((note: any) => note.id)).toEqual([remembered[0].id]);
    expect(await rawOwnerRequest(fixture.worker, connection, "library.search", {
      cursor: null,
      limit: 21,
      query: "redwood",
    })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await rawOwnerRequest(fixture.worker, connection, "library.search", {
      cursor: null,
      limit: 10,
      query: "redwood",
    })).toMatchObject({ ok: false, error: { code: "library_session_required" } });
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    expect(await rawOwnerRequest(fixture.worker, connection, "library.search", {
      cursor: null,
      limit: 10,
      query: "x".repeat(2_001),
    })).toMatchObject({ ok: false, error: { code: "invalid_request" } });

    await beginLibrarySession(
      fixture.worker,
      connection,
      ["library.browse", "library.search"],
    );
    const boundedBrowse = await ownerRequest(
      fixture.worker,
      connection,
      "library.browse",
      { cursor: null, limit: 1, view: null },
    );
    expect(boundedBrowse.notes[0]).toHaveProperty("source");
    expect(boundedBrowse.notes[0]).not.toHaveProperty("content");
    const boundedSearch = await ownerRequest(
      fixture.worker,
      connection,
      "library.search",
      { cursor: null, limit: 10, query: "exact redwood" },
    );
    expect(boundedSearch.results[0]).not.toHaveProperty("note");
    expect(boundedSearch.results[0].citation).toHaveProperty("source");
    expect(await rawOwnerRequest(fixture.worker, connection, "library.get_note", {
      id: remembered[0].id,
      revision: null,
    })).toMatchObject({ ok: false, error: { code: "scope_denied" } });
  });

  it("uses a stable creation boundary while concurrent inserts, updates, and deletes remain live", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 51250 };
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    const originals = [];
    for (const content of ["Boundary alpha", "Boundary beta", "Boundary gamma"]) {
      originals.push((await ownerRequest(
        fixture.worker,
        connection,
        "library.remember",
        { content, source: null },
      )).note);
      await Bun.sleep(2);
    }
    const first = await ownerRequest(fixture.worker, connection, "library.browse", {
      cursor: null,
      limit: 1,
      view: null,
    });
    const unseen = originals.filter((note) => note.id !== first.notes[0].id);
    await Bun.sleep(2);
    const laterInsert = (await ownerRequest(
      fixture.worker,
      connection,
      "library.remember",
      { content: "Inserted after the browse boundary", source: null },
    )).note;
    const updated = (await ownerRequest(
      fixture.worker,
      connection,
      "library.update_note",
      {
        id: unseen[0].id,
        content: "Updated after the browse boundary",
        expectedRevision: unseen[0].revision,
        source: null,
      },
    )).note;
    const deleteDetail = await ownerRequest(
      fixture.worker,
      connection,
      "library.get_note",
      { id: unseen[1].id, revision: null },
    );
    await ownerRequest(fixture.worker, connection, "library.delete", {
      id: unseen[1].id,
      expectedRevision: unseen[1].revision,
      targetDescription: deleteDetail.deleteTarget,
    }, true);

    const second = await ownerRequest(fixture.worker, connection, "library.browse", {
      cursor: first.nextCursor,
      limit: 20,
      view: null,
    });
    expect(second.notes.map((note: any) => note.id)).toEqual([updated.id]);
    expect(second.notes[0].revision).toBe(2);
    expect(second.notes.map((note: any) => note.id)).not.toContain(laterInsert.id);
    expect(second.notes.map((note: any) => note.id)).not.toContain(first.notes[0].id);
  });

  it("returns exact note and revision data while keeping list responses bounded", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 51300 };
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    const source = {
      application: "Test harness",
      url: "https://example.com/source",
      author: "Owner",
      timestamp: "2026-08-28T12:00:00.000Z",
      label: "Exact source",
    };
    const created = (await ownerRequest(fixture.worker, connection, "library.remember", {
      content: "Revision one plaintext",
      source,
    })).note;
    const updated = (await ownerRequest(fixture.worker, connection, "library.update_note", {
      id: created.id,
      content: "Revision two plaintext",
      expectedRevision: 1,
      source,
    })).note;
    const detail = await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    });
    expect(detail.note).toEqual(updated);
    expect(detail.deleteTarget).toContain("Exact source");
    const historical = await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: 1,
    });
    expect(historical.note).toMatchObject({
      noteId: created.id,
      revision: 1,
      content: "Revision one plaintext",
      source,
    });
    const history = await ownerRequest(
      fixture.worker,
      connection,
      "library.list_revisions",
      { id: created.id, cursor: null, limit: 1 },
    );
    expect(history.revisions[0]).not.toHaveProperty("content");
    expect(history.revisions[0]).not.toHaveProperty("excerpt");
    expect(history.revisions[0]).not.toHaveProperty("source");
    expect(history.revisions[0]).toMatchObject({ noteId: created.id, revision: 2 });
    expect(history.nextCursor).toBeString();
  });

  it("commits create and revision-safe update with redacted audit and rolls mutation back when success audit fails", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 51400 };
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    const canary = "PLAINTEXT-LIBRARY-CANARY-f45f8e90";
    let inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    inspection.exec(`
      create trigger fail_library_create_success_audit
      before update on broker_audit_events
      when new.operation = 'library.remember'
      begin select raise(abort, 'forced native library create audit failure'); end;
    `);
    inspection.close();
    expect(await rawOwnerRequest(fixture.worker, connection, "library.remember", {
      content: "create audit rollback content",
      source: null,
    })).toMatchObject({ ok: false, error: { code: "audit_commit_failed" } });
    inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    expect(inspection.query<{ count: number }>("select count(*) as count from notes").get())
      .toEqual({ count: 0 });
    inspection.exec("drop trigger fail_library_create_success_audit");
    inspection.close();

    const created = (await ownerRequest(fixture.worker, connection, "library.remember", {
      content: canary,
      source: { label: "SECRET-SOURCE-CANARY" },
    })).note;
    expect(await rawOwnerRequest(fixture.worker, connection, "library.update_note", {
      id: created.id,
      content: "must not overwrite",
      expectedRevision: 99,
      source: null,
    })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).note.content).toBe(canary);

    inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    inspection.exec(`
      create trigger fail_library_success_audit
      before update on broker_audit_events
      when new.operation = 'library.update_note' and new.outcome = 'success'
      begin select raise(abort, 'forced native library audit failure'); end;
    `);
    inspection.close();
    expect(await rawOwnerRequest(fixture.worker, connection, "library.update_note", {
      id: created.id,
      content: "audit rollback content",
      expectedRevision: 1,
      source: null,
    })).toMatchObject({ ok: false, error: { code: "audit_commit_failed" } });
    inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    expect(inspection.query<{ content: string; current_revision: number }>(
      "select content, current_revision from notes where id = ?",
    ).get(created.id)).toEqual({ content: canary, current_revision: 1 });
    inspection.exec("drop trigger fail_library_success_audit");
    inspection.close();

    const auditText = JSON.stringify(fixture.worker.readAuditForTest());
    expect(auditText).not.toContain(canary);
    expect(auditText).not.toContain("SECRET-SOURCE-CANARY");
    expect(auditText).not.toContain("audit rollback content");
    expect(readFileSync(fixture.path).includes(Buffer.from(canary))).toBe(false);
  });

  it("requires a fresh exact-target presence decision for deletion and detects revision races", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 51500 };
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    let created = (await ownerRequest(fixture.worker, connection, "library.remember", {
      content: "Harmless deletion fixture",
      source: { label: "Delete fixture" },
    })).note;
    let detail = await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    });

    const cancelled = await rawOwnerRequest(fixture.worker, connection, "library.delete", {
      id: created.id,
      expectedRevision: created.revision,
      targetDescription: detail.deleteTarget,
    }, "cancelled");
    expect(cancelled).toMatchObject({ ok: false, error: { code: "owner_cancelled" } });
    expect(await rawOwnerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).toMatchObject({ ok: false, error: { code: "library_session_required" } });
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);

    const wrongRoleDelete = await beginOwnerRequest(
      fixture.worker,
      connection,
      "library.delete",
      {
        id: created.id,
        expectedRevision: created.revision,
        targetDescription: detail.deleteTarget,
      },
    );
    expect(await completePresence(
      fixture.worker,
      connection,
      "memory-client",
      wrongRoleDelete.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(fixture.worker.readAuditForTest()).toContainEqual(expect.objectContaining({
      operation: "library.delete",
      outcome: "error",
      errorCode: "identity_mismatch",
    }));
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);

    const wrongBindingDelete = await beginOwnerRequest(
      fixture.worker,
      connection,
      "library.delete",
      {
        id: created.id,
        expectedRevision: created.revision,
        targetDescription: detail.deleteTarget,
      },
    );
    expect(await completePresence(
      fixture.worker,
      { connectionId: randomUUID(), peerPid: connection.peerPid },
      "owner-control",
      wrongBindingDelete.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(fixture.worker.readAuditForTest().filter((event) =>
      event.operation === "library.delete" &&
      event.outcome === "error" &&
      event.errorCode === "identity_mismatch"
    )).toHaveLength(2);
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);

    for (const [outcome, code] of [
      ["denied", "owner_denied"],
      ["timed_out", "owner_timeout"],
      ["unavailable", "owner_auth_unavailable"],
    ] as const) {
      expect(await rawOwnerRequest(fixture.worker, connection, "library.delete", {
        id: created.id,
        expectedRevision: created.revision,
        targetDescription: detail.deleteTarget,
      }, outcome)).toMatchObject({ ok: false, error: { code } });
      expect(await rawOwnerRequest(fixture.worker, connection, "library.get_note", {
        id: created.id,
        revision: null,
      })).toMatchObject({ ok: false, error: { code: "library_session_required" } });
      await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    }

    const staleSessionDelete = await beginOwnerRequest(
      fixture.worker,
      connection,
      "library.delete",
      {
        id: created.id,
        expectedRevision: created.revision,
        targetDescription: detail.deleteTarget,
      },
    );
    await beginOwnerRequest(fixture.worker, connection, "library.session.begin", {
      requestedScopes: [...LIBRARY_SCOPES],
      ttlMs: 15 * 60 * 1_000,
    });
    expect(await completeOwnerPresence(
      fixture.worker,
      connection,
      staleSessionDelete.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "library_session_required" } });
    expect(fixture.worker.readAuditForTest()).toContainEqual(expect.objectContaining({
      operation: "library.delete",
      outcome: "error",
      errorCode: "library_session_required",
    }));
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);

    const pending = await beginOwnerRequest(fixture.worker, connection, "library.delete", {
      id: created.id,
      expectedRevision: created.revision,
      targetDescription: detail.deleteTarget,
    });
    created = (await ownerRequest(fixture.worker, connection, "library.update_note", {
      id: created.id,
      content: "Changed during deletion approval",
      expectedRevision: created.revision,
      source: { label: "Delete fixture" },
    })).note;
    expect(await completeOwnerPresence(
      fixture.worker,
      connection,
      pending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).note.revision).toBe(2);

    detail = await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    });
    expect(await rawOwnerRequest(fixture.worker, connection, "library.delete", {
      id: created.id,
      expectedRevision: created.revision,
      targetDescription: `${detail.deleteTarget} forged`,
    }, true)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(fixture.worker.readAuditForTest()).toContainEqual(expect.objectContaining({
      operation: "library.delete",
      outcome: "error",
      errorCode: "conflict",
    }));
    let inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    inspection.exec(`
      create trigger fail_library_delete_success_audit
      before update on broker_audit_events
      when new.operation = 'library.delete' and new.outcome = 'success'
      begin select raise(abort, 'forced native library delete audit failure'); end;
    `);
    inspection.close();
    expect(await rawOwnerRequest(fixture.worker, connection, "library.delete", {
      id: created.id,
      expectedRevision: created.revision,
      targetDescription: detail.deleteTarget,
    }, true)).toMatchObject({ ok: false, error: { code: "audit_commit_failed" } });
    expect((await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).note.revision).toBe(created.revision);
    inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    inspection.exec("drop trigger fail_library_delete_success_audit");
    inspection.close();
    const deleted = await ownerRequest(fixture.worker, connection, "library.delete", {
      id: created.id,
      expectedRevision: created.revision,
      targetDescription: detail.deleteTarget,
    }, true);
    expect(deleted).toEqual({ deleted: true, noteId: created.id, revision: 2 });
    expect((await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).note).toBeNull();
  });

  it("expires an exact-target delete challenge after thirty seconds", async () => {
    let now = Date.now();
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 51525 };
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    const created = (await ownerRequest(fixture.worker, connection, "library.remember", {
      content: "Delete challenge lifetime fixture",
      source: null,
    })).note;
    const detail = await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    });
    const pending = await beginOwnerRequest(fixture.worker, connection, "library.delete", {
      id: created.id,
      expectedRevision: created.revision,
      targetDescription: detail.deleteTarget,
    });
    expect(pending.ownerPresenceChallenge.expiresAt).toBe(
      new Date(now + 30_000).toISOString(),
    );
    now += 30_001;
    expect(await completeOwnerPresence(
      fixture.worker,
      connection,
      pending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "owner_timeout" } });
    expect(await rawOwnerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).toMatchObject({ ok: false, error: { code: "library_session_required" } });
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    expect((await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).note.id).toBe(created.id);

    await ownerRequest(fixture.worker, connection, "library.session.begin", {
      requestedScopes: [...LIBRARY_SCOPES],
      ttlMs: 1_000,
    }, true);
    const sessionBoundDelete = await beginOwnerRequest(
      fixture.worker,
      connection,
      "library.delete",
      {
        id: created.id,
        expectedRevision: created.revision,
        targetDescription: detail.deleteTarget,
      },
    );
    expect(sessionBoundDelete.ownerPresenceChallenge.expiresAt).toBe(
      new Date(now + 30_000).toISOString(),
    );
    now += 30_001;
    expect(await completeOwnerPresence(
      fixture.worker,
      connection,
      sessionBoundDelete.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "owner_timeout" } });
    expect(await rawOwnerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).toMatchObject({ ok: false, error: { code: "library_session_required" } });
  });

  it("leaves a pending deletion intact across a broker restart", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 51550 };
    await beginLibrarySession(fixture.worker, connection, [...LIBRARY_SCOPES]);
    const created = (await ownerRequest(fixture.worker, connection, "library.remember", {
      content: "Restart-safe deletion fixture",
      source: null,
    })).note;
    const detail = await ownerRequest(fixture.worker, connection, "library.get_note", {
      id: created.id,
      revision: null,
    });
    const pending = await beginOwnerRequest(fixture.worker, connection, "library.delete", {
      id: created.id,
      expectedRevision: created.revision,
      targetDescription: detail.deleteTarget,
    });
    fixture.worker.close();
    const restarted = new VaultBrokerWorker({
      applicationVersion: "test-worker-restarted",
      vaultPath: fixture.path,
      vaultKey: fixture.key,
      vault: fixture.vault,
      bootId: randomUUID(),
    });
    workers.push(restarted);
    expect(await completeOwnerPresence(
      restarted,
      connection,
      pending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });
    await beginLibrarySession(restarted, connection, [...LIBRARY_SCOPES]);
    expect((await ownerRequest(restarted, connection, "library.get_note", {
      id: created.id,
      revision: null,
    })).note.id).toBe(created.id);
  });

  it("pages and searches 10,000 encrypted fixture notes with bounded responses", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-library-scale-"));
    directories.push(directory);
    const path = join(directory, "vault.db");
    const key = randomBytes(32);
    const vault: VaultContext = { vaultId: "8".repeat(64), deployment: "local" };
    const memory = new SqliteMemory(path, vault, { encryptionKey: key });
    memory.close();
    const fixtureDatabase = new SqlcipherDatabase(path, { key });
    const insertNote = fixtureDatabase.query(`
      insert into notes (
        id, content, current_revision, source_json, source_search, created_at, updated_at
      ) values (?, ?, 1, null, '', ?, ?)
    `);
    const insertRevision = fixtureDatabase.query(`
      insert into note_revisions (note_id, revision, content, source_json, created_at)
      values (?, 1, ?, null, ?)
    `);
    fixtureDatabase.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        const id = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
        const content = index === 9_999
          ? "Scale fixture needle9999 exact citation"
          : `Scale fixture ordinary note ${index}`;
        const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString();
        insertNote.run(id, content, createdAt, createdAt);
        insertRevision.run(id, content, createdAt);
      }
    })();
    fixtureDatabase.close();
    const worker = new VaultBrokerWorker({
      applicationVersion: "test-worker-scale",
      vaultPath: path,
      vaultKey: key,
      vault,
      bootId: randomUUID(),
    });
    workers.push(worker);
    const connection = { connectionId: randomUUID(), peerPid: 51600 };
    await beginLibrarySession(worker, connection, [...LIBRARY_SCOPES]);
    const first = await ownerRequest(worker, connection, "library.browse", {
      cursor: null,
      limit: 20,
      view: null,
    });
    const second = await ownerRequest(worker, connection, "library.browse", {
      cursor: first.nextCursor,
      limit: 20,
      view: null,
    });
    expect(first.notes).toHaveLength(20);
    expect(second.notes).toHaveLength(20);
    expect(new Set([...first.notes, ...second.notes].map((note: any) => note.id)).size)
      .toBe(40);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(64 * 1_024);
    const searched = await ownerRequest(worker, connection, "library.search", {
      cursor: null,
      limit: 20,
      query: "needle9999",
    });
    expect(searched.results).toHaveLength(1);
    expect(searched.results[0].citation).toMatchObject({ revision: 1 });
    expect(searched.results[0].citation.noteId).toBeString();
    expect(searched.results[0].citation.excerpt).toContain("needle9999");
    expect(readFileSync(path).includes(Buffer.from("needle9999"))).toBe(false);
  }, 30_000);
});

function workerFixture(options: {
  now?: () => number;
  embeddingModel?: TextEmbeddingModel;
  embeddingModelProvider?: (vaultPath: string) => TextEmbeddingModel | null;
  invalidEmbeddingInstallation?: boolean;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "afternote-library-worker-"));
  directories.push(directory);
  const path = join(directory, "vault.db");
  if (options.invalidEmbeddingInstallation) {
    const snapshot = join(
      directory,
      "models",
      LOCAL_EMBEDDING_MODEL.id,
      LOCAL_EMBEDDING_MODEL.revision,
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "config.json"), "{}", { mode: 0o600 });
  }
  const key = randomBytes(32);
  const vault: VaultContext = { vaultId: "9".repeat(64), deployment: "local" };
  const worker = new VaultBrokerWorker({
    applicationVersion: "test-worker",
    vaultPath: path,
    vaultKey: key,
    vault,
    bootId: "d89ae0cf-9094-4a97-8b16-1876dd82d0a3",
    now: options.now,
    embeddingModelProvider: options.embeddingModelProvider ?? (options.embeddingModel
      ? () => options.embeddingModel ?? null
      : undefined),
    embeddingDiscoveryProvider: options.invalidEmbeddingInstallation
      ? (vaultPath) => {
          const discovery = discoverLocalEmbeddingModel(vaultPath);
          return {
            model: discovery.model,
            invalid: discovery.status.state === "invalid",
          };
        }
      : undefined,
  });
  workers.push(worker);
  return { worker, path, key, vault };
}

class FixtureEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.75;
  readonly descriptor = { id: "fixture-embedding", revision: "1", dimensions: 2 };

  constructor(private readonly vectors: ReadonlyMap<string, number[]>) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vector = this.vectors.get(text);
      if (!vector) throw new Error(`Missing fixture embedding for: ${text}`);
      return Float32Array.from(vector);
    });
  }
}

async function beginLibrarySession(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  requestedScopes: string[],
) {
  return ownerRequest(worker, connection, "library.session.begin", {
    requestedScopes,
    ttlMs: 15 * 60 * 1_000,
  }, true);
}

async function ownerRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
  outcome?: true | "denied" | "cancelled" | "timed_out" | "unavailable",
): Promise<any> {
  const response = await rawOwnerRequest(worker, connection, method, params, outcome);
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

async function rawOwnerRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
  outcome?: true | "denied" | "cancelled" | "timed_out" | "unavailable",
): Promise<any> {
  return rawRequest(worker, connection, "owner-control", method, params, outcome);
}

async function rawRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  peerRole: "owner-control" | "memory-client" | "browser-client",
  method: string,
  params: Record<string, unknown>,
  outcome?: true | "denied" | "cancelled" | "timed_out" | "unavailable",
): Promise<any> {
  const first = await beginRequest(worker, connection, peerRole, method, params);
  if (!first.ownerPresenceChallenge) return first;
  return completePresence(
    worker,
    connection,
    peerRole,
    first.ownerPresenceChallenge.challengeId,
    outcome === true ? "approved" : outcome ?? "denied",
  );
}

async function beginOwnerRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
) {
  return beginRequest(worker, connection, "owner-control", method, params);
}

async function beginRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  peerRole: "owner-control" | "memory-client" | "browser-client",
  method: string,
  params: Record<string, unknown>,
) {
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "client",
    peerRole,
    ...connection,
    payload: { protocolVersion: 1, requestId: randomUUID(), method, params },
  })));
}

async function completeOwnerPresence(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  challengeId: string,
  outcome: "approved" | "denied" | "cancelled" | "timed_out" | "unavailable",
) {
  return completePresence(worker, connection, "owner-control", challengeId, outcome);
}

async function completePresence(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  peerRole: "owner-control" | "memory-client" | "browser-client",
  challengeId: string,
  outcome: "approved" | "denied" | "cancelled" | "timed_out" | "unavailable",
) {
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "owner-presence",
    peerRole,
    ...connection,
    payload: {
      challengeId,
      approved: outcome === "approved",
      outcome,
    },
  })));
}
