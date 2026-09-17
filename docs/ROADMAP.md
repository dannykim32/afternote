# Local beta status and roadmap

Updated 2026-09-17 for [Beta 5](https://github.com/dannykim32/afternote/releases/tag/v2.0.0-beta.5).
This repository is the complete Local Mac product. The earlier hosted application
and experimental browser/Slack adapters are outside this release.

## Available now

- Signed and notarized app for Apple Silicon Macs running macOS 13.3 or newer.
- Encrypted local notes, immutable revisions, exact and date-aware retrieval,
  included local semantic retrieval enabled by default, JSON export/restore, and Markdown export.
- Codex, Claude Code, and Claude Desktop Remember/Recall connectors with separate
  identities, attribution, activity counts, revocation, and owner-approved reconnect
  preparation that persists until the replacement pairs.
- Configurable routine authentication, explicit vault lock/unlock, owner-approved
  diagnostics, and signed updates through the app.
- Apache-2.0 source, release verification instructions, contribution guidance,
  and a private vulnerability-reporting route.

Beta 5 passed its clean release suite (644 passed, 10 explicit default-suite skips),
separate native gateway and actual-model UI readiness checks, package and performance gates,
dependency audit, signing and notarization. Independent read-only DMG verification also
confirmed the bundled model loads with network access denied. Founder acceptance on a second
Mac confirmed search readiness, Codex recall of a Claude Desktop note, and revocation.
These checks are scoped evidence, not a claim that every real-host or approval path has been
independently tested. See [beta readiness](BETA_READINESS.md) and
[the security model](SECURITY_MODEL.md) for limitations.

## Next validation

- Observe a new user installing and connecting a host from the published instructions.
- Run a two-week non-founder trial with at least three useful delayed recalls across
  more than one host. Record failed retrievals, setup friction, and unsupported answers.
- Prioritize installation, upgrade, security, retrieval, and data-loss defects from
  that trial before expanding the connector list.

## Engineering backlog

- Include search-mode/readiness information in MCP recall results. In this beta the tool
  returns matches but omits that status, so an AI host may not recognize exact-search fallback
  while semantic search is preparing or unavailable. An empty result is not proof that no
  relevant note exists. Check Notes for the ready status and retry once it is ready.

- Continue splitting large native UI, broker dispatch, authorization, and storage
  modules along their responsibilities. The architecture has explicit interfaces,
  but large implementation files remain. The released source extracts native
  broker contracts and Note schema migrations with verified backups into focused,
  behaviorally tested modules. Connections rendering and shared native appearance
  now also have focused modules. The Notes editor separately owns its draft,
  formatting, revision presentation, and undo cleanup. Both screens have standalone
  AppKit tests that do not link the broker or app coordinator. The native app is
  still approximately 5,900 lines. Submitted search/browse selection, page results,
  cursors, and request supersession now have a Foundation-only retrieval module.
  Search/browse layout, category loading, authorized dispatch, and shared lifecycle
  orchestration remain in the app. The editor implementation is approximately 600 lines;
  storage is approximately 2,800, and broker modules are approximately 3,200–4,000.
  Audit-history reading now owns snapshot pagination, signed cursors, validated
  metadata, and response limits; authorization retains approvals and transactional
  audit writes. Reader tests use the real encrypted database and the production schema.
  Broker dispatch now separates the wire contract and exact method/role allowlist
  from live operation handling. The worker preserves replay, recovery, and lock
  admission order before route resolution. Remaining file size alone is not a
  release blocker; further extraction should address a concrete ownership problem.
  See [the architecture guide](ARCHITECTURE.md) for ownership and the remaining work.
- Replace source-text checks with behavioral coverage where the check is intended
  to prove runtime behavior. Keep useful packaging and structural checks identified
  separately from behavioral tests.
- Review resource quotas and remaining same-login verification/use races around
  connector signing and optional model loading.
- Design a supported destructive erase workflow and evaluate vault rollback-freshness
  controls. Ordinary uninstall currently preserves notes and Keychain identities.

These are open work items, not claims that the current beta provides those controls.
The [enterprise review](ENTERPRISE_SECURITY.md) describes their implications.

## Deferred scope

Slack, browser capture, ChatGPT consumer connectors, cloud sync, Windows/Linux,
Intel Mac distribution, fleet management, and a stable 2.0 release require separate
design and acceptance work. They are not included in this Mac beta. Search by meaning runs locally and is enabled by default; turning it
off in Settings keeps notes intact and uses exact search in Notes and connected tools.

## Feedback

Use [GitHub issue forms](https://github.com/dannykim32/afternote/issues/new/choose)
for bugs and product feedback. The installed app's **Send feedback** button opens
email to `hello@afternote.dev`; **Save diagnostics** produces a report you can review
before sharing. Afternote does not upload that report automatically.

Report vulnerabilities privately through [SECURITY.md](../SECURITY.md).
