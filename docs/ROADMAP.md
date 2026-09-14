# Local alpha status and roadmap

Updated 2026-09-13 for [Alpha 22](https://github.com/dannykim32/afternote/releases/tag/v2.0.0-alpha.22).
This repository is the complete Local Mac product. The earlier hosted application
and experimental browser/Slack adapters are outside this release.

## Available now

- Signed and notarized app for Apple Silicon Macs running macOS 13.3 or newer.
- Encrypted local notes, immutable revisions, exact and date-aware retrieval,
  optional local semantic retrieval, JSON export/restore, and Markdown export.
- Codex, Claude Code, and Claude Desktop Remember/Recall connectors with separate
  identities, attribution, activity counts, and revocation.
- Configurable routine authentication, explicit vault lock/unlock, owner-approved
  diagnostics, and signed updates through the app.
- Apache-2.0 source, release verification instructions, contribution guidance,
  and a private vulnerability-reporting route.

Alpha 22 passed its release-host test suite, package and performance gates,
dependency audit, notarization, and focused attribution/counter acceptance on a
second Mac. Public CI passed for its source and feed commit. Founder acceptance
does not replace testing by new users; see [RELEASING.md](RELEASING.md) for the
release checklist and [SECURITY_MODEL.md](SECURITY_MODEL.md) for assurance limits.

## Next validation

- Observe a new user installing and connecting a host from the published instructions.
- Run a two-week non-founder trial with at least three useful delayed recalls across
  more than one host. Record failed retrievals, setup friction, and unsupported answers.
- Prioritize installation, upgrade, security, retrieval, and data-loss defects from
  that trial before expanding the connector list.

## Engineering backlog

- Continue splitting large native UI, broker dispatch, authorization, and storage
  modules along their responsibilities. The architecture has explicit interfaces,
  but large implementation files remain. The next-release source extracts native
  broker contracts and Note schema migrations with verified backups into focused,
  behaviorally tested modules. Connections rendering and shared native appearance
  now also have focused modules, with a standalone AppKit test that does not link
  the broker or app coordinator. The native app is still approximately 6,500 lines;
  storage is approximately 2,800, and broker modules are approximately 3,400–4,200.
  See [the architecture guide](ARCHITECTURE.md) for ownership and the remaining work.
- Replace source-text checks with behavioral coverage where the check is intended
  to prove runtime behavior. Keep useful packaging and structural checks identified
  separately from behavioral tests.
- Review resource quotas and remaining same-login verification/use races around
  connector signing and optional model loading.
- Design a supported destructive erase workflow and evaluate vault rollback-freshness
  controls. Ordinary uninstall currently preserves notes and Keychain identities.

These are open work items, not claims that the current alpha provides those controls.
The [enterprise review](ENTERPRISE_SECURITY.md) describes their implications.

## Deferred scope

Slack, browser capture, ChatGPT consumer connectors, cloud sync, Windows/Linux,
Intel Mac distribution, fleet management, and a stable 2.0 release require separate
design and acceptance work. They are not included in this Mac alpha. Optional
semantic retrieval remains opt-in; exact retrieval remains the default.

## Feedback

Use [GitHub issue forms](https://github.com/dannykim32/afternote/issues/new/choose)
for bugs and product feedback. The installed app's **Send feedback** button opens
email to `hello@afternote.dev`; **Save diagnostics** produces a report you can review
before sharing. Afternote does not upload that report automatically.

Report vulnerabilities privately through [SECURITY.md](../SECURITY.md).
