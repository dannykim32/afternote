# Architecture and code navigation

Afternote has one canonical Vault on one Mac. Connectors request scoped operations;
they never open the database. The Owner approves privileged actions through the
native app. Start with [CONTEXT.md](../CONTEXT.md) for domain terms and the
[security model](SECURITY_MODEL.md) for trust assumptions.

## Where behavior belongs

Paths below are relative to the repository root.

| Module | Owns | Does not own |
| --- | --- | --- |
| `packages/memory` | Note, Revision, Recall, and Vault contracts | Platform storage or host configuration |
| `packages/mcp`, `apps/local/src/mcp-broker-adapter.ts` | MCP adaptation to broker operations | Vault keys or direct database access |
| `apps/local/src/integration-host-policy.ts`, `mcp-client-identity.ts` | Supported signed hosts and Connector identity selection | Note content or natural-language intent verification |
| `apps/local/native/vault_broker_gateway.mm` | Native caller verification, XPC routing, worker lifecycle | Note mutations or retrieval ranking |
| `apps/local/src/vault-broker-worker.ts` | Dispatch and coordination of Owner, Connector, and recovery operations | UI rendering |
| `apps/local/src/vault-broker.ts` | Pairing, grants, Connections, Work sessions, and authorization audit | Host configuration or UI rendering |
| `apps/local/src/sqlite-memory.ts` | Canonical Note/Revision operations and retrieval | Schema upgrade/backup implementation |
| `apps/local/src/note-database.ts` | Database adapter selection, Note schema versions, verified pre-migration backups | Note edits, retrieval, or Keychain access |
| `apps/local/src/derived-index-coordinator.ts` | Derived index initialization, invalidation, and background work coordination | Independent canonical state |
| `apps/local/native/owner_broker.mm` | Owner-side transport, response correlation, invalidation | Method-specific result schemas |
| `apps/local/native/owner_broker_contract.mm` | Owner-facing result/error validation and lifecycle epoch consistency | XPC connections, AppKit, or live Vault state |
| `apps/local/native/connections_view.mm` | Connections layout, controls, redacted rows, and transient display state | Broker requests, authorization, host configuration, or navigation |
| `apps/local/native/native_appearance.mm` | Shared native colors, labels, button appearance, and interaction feedback | Product state or authorization |
| `apps/local/native/owner_control_app.mm` | Owner interaction, shared lifecycle coordination, Connections display-data assembly, and remaining screens | Direct Vault storage access |

Filenames shortened in a row share its first directory. Connector lifecycle,
Owner-presence coordination, recovery state, editor state, and software updates
also have focused modules alongside these entry points.

## Invariants to preserve

- A canonical mutation and its synchronous derived projections share a transaction.
  Embeddings remain disposable; a background failure must not discard the Note.
- Upgrading an existing on-disk Note schema first creates and verifies a private
  backup. An encrypted Vault's backup remains encrypted. Each schema version is
  applied transactionally, and a newer unsupported schema is rejected.
- `migrateNoteSchema` borrows its connection and key; its caller retains ownership
  and cleanup responsibility. `openNoteDatabase` selects the real SQLite or SQLCipher
  adapter and does not implicitly migrate a read-only connection.
- Native result validation uses the same three-function interface for the app and
  command-line Owner operations. Unknown result methods and unexpected fields fail
  validation. Transport validation still checks envelopes and request correlation.
- A lock acknowledgment preserves its epoch; an unlock acknowledgment must advance
  it. Late replies must not repopulate plaintext after lock or invalidation.
- Connector attribution follows verified host identity, not a model-supplied source
  label. Desktop-hosted Claude Code launch chains and terminal Claude Code remain
  distinct cases.
- Connections rendering accepts redacted display rows, not a broker connection or
  revocation authority. User actions return to the app coordinator through a weak
  AppKit target. The coordinator retains history approval, exact revocation scopes,
  lifecycle generations, and stale-reply checks. Rendering itself performs no operation.
- The Connections view is main-thread-only. Each render replaces its previous rows;
  an error replaces the rows with the error state. The view does not own background
  requests, authentication, or window navigation.

## Testing the seams

`note-database.test.ts` exercises the migration interface with both real database
adapters: initialization, upgrade backups, unsupported versions, failed-version
rollback, and connection ownership. `sqlite-memory.test.ts` and
`encrypted-sqlite-memory.test.ts` retain end-to-end Note, Revision, retrieval,
export, and restore coverage.

`native-owner-broker-contract.test.ts` compiles a Foundation-only executable and
calls the same validation interface as production. It checks method allowlisting,
request/result binding, diagnostic redaction, and lifecycle epochs.
`native-integration-command.test.ts` still compiles the full owner app to exercise
transport recovery and interaction. Source-text tests are structural assertions,
not substitutes for runtime behavior.

`native-connections-view.test.ts` compiles the Connections view without the app
coordinator or broker. It exercises actual AppKit buttons for setup, repair,
reconnect, review, refresh, history, and revocation routing, plus passive rendering,
history replacement, busy state, error clearing, and weak action-target lifetime.
The full-app layout fixture separately checks real window sizes and scrollbar modes.
Together these replace the old source-string checks for the extracted controls.

## Remaining organization work

The current source separates Note migrations, native broker contracts, Connections
rendering, and native appearance from their former large callers. It is not the end
of the refactor: the Owner app still combines Notes, Settings, Recovery, shared
lifecycle coordination, and substantial conditional test fixtures. Broker dispatch
and authorization also remain large.

The next useful seam is Notes screen ownership with explicit shared lifecycle
coordination, following the Connections separation. Notes additionally owns pending
edits and plaintext, so its extraction needs tests for pending edits, lock-time
plaintext clearing, stale asynchronous replies, and navigation through Recovery.
Keep those responsibilities explicit rather than splitting methods by file size.
