# Afternote

Local memory for Codex, Claude Code, and Claude Desktop on your Mac.

Tell a connected host to remember a decision, deadline, or useful piece of context. Ask for it
later from any connected host. Afternote keeps the note, its revision history, and its source in an
encrypted local vault you control.

![Afternote Notes showing a local semantic recall with synthetic data](docs/images/afternote-notes.png)

This repository is the complete local Mac product. It does not contain Afternote's former
hosted service, customer data, deployment configuration, or release credentials.

## Try it

Afternote is a beta for Apple Silicon Macs running macOS 13.3 or newer.

Download the signed and notarized DMG and its `SHA256SUMS` from
[GitHub Releases](https://github.com/dannykim32/afternote/releases), then follow
[the verification and installation steps](docs/VERIFY_RELEASE.md).
The installed app requires no Bun or Node installation.

1. Download the DMG and `SHA256SUMS` from the **same release** and verify them.
2. Open the DMG and drag **Afternote** into **Applications**. Replace the older app if
   upgrading manually; do not delete your vault or Keychain items.
3. Eject the installer, then open **/Applications/Afternote.app**. First launch installs
   the private runtime and the optional command at `~/.local/bin/afternote`.
4. Open **Connections** and connect the AI host you use, following the steps below.
5. Ask that host to save a test note explicitly to Afternote, then find it in **Notes**.

Already installed? Open **Settings** and choose **Check now** under Updates. Official builds check for updates
daily by default, but downloading and installing still require your approval.

### Build from source

You can build the current candidate from source with Bun 1.3.14, Node, and Apple's
command-line developer tools (`xcode-select --install` if they are missing).
Check the Bun version before proceeding: Homebrew may install a newer version than the
one this repository pins.

```bash
brew install bun node
bun --version # must print 1.3.14
git clone https://github.com/dannykim32/afternote.git
cd afternote
bun install --frozen-lockfile
bun run prepare:native-release
bun run typecheck
bun run test
bun run package:local
```

The development archive and its `SHA256SUMS` file are written to `build/local-alpha`. Verify
the checksum there, extract the archive, and run the enclosed `install.sh`. The app is ad hoc
signed for local development; it does not carry the maintainer's Developer ID, notarization
ticket, or release Keychain entitlements. Public binaries are produced only by the guarded
release flow in [RELEASING.md](docs/RELEASING.md).

Development and CI builds verify the pinned SQLCipher and OpenSSL source archives, record the
Apple toolchain that compiled them, and require a macOS 13.3 deployment target. Public release
builds additionally require the exact reviewed Apple toolchain and byte-for-byte native output
digests recorded in `scripts/native-release-inputs.json`.

## Remember and Recall

Once a connector is paired, the interaction stays deliberately small:

```text
You: Remember that the spare bicycle key is behind the green planter.
Codex: Saved to Afternote.

Later, in Claude Desktop:
You: Where did I put the spare bicycle key?
Claude: Behind the green planter. [Afternote note, revision 1]
```

The note is visible and editable in the native app. Edits create immutable revisions;
Recall cites the exact note revision it used.

For a first check, ask your host: **Use Afternote to remember exactly: "My test key is
in the green drawer."** Open Notes to confirm it was saved. In a new chat, ask the
host to **use Afternote to recall where my test key is**. Confirm it actually calls
an Afternote tool rather than answering from chat history.

Afternote currently supports the official signed native macOS builds of Codex, Claude Code,
and Claude Desktop. During setup it verifies the host's signing identity before changing or
opening that host's MCP setup. Claude Desktop uses a small local MCPB package and keeps its
own install confirmation. At runtime Afternote verifies Anthropic's launcher and its signed
Claude Desktop parent as one process chain; it never writes Claude's private extension configuration.
npm-installed scripts, wrapper launchers, and repackaged binaries are not supported in this
beta because they cannot satisfy the native runtime identity check.

### Connect Codex or Claude Code

1. Install and launch the official signed native macOS build of your host.
2. Open Afternote's **Connections** page and choose **Connect Afternote** under
   **Codex** or **Claude Code**. Approve the macOS owner-presence prompt if requested.
3. Restart the host so it loads its updated MCP configuration, then open a new chat.
4. Return to Connections and refresh. Use the first-check prompt above to verify a
   real Remember and Recall, not just an installed configuration.

If you prefer Terminal, the installed command provides the same connector setup:

```bash
"$HOME/.local/bin/afternote" codex install
"$HOME/.local/bin/afternote" codex status
# Or, for Claude Code:
"$HOME/.local/bin/afternote" claude-code install
"$HOME/.local/bin/afternote" claude-code status
```

Install only the connector you intend to use. A healthy status checks the configuration
and identity; the test note checks the full path through the host.

### Connect Claude Desktop

1. Install the official Claude Desktop app and open Afternote's **Connections** page.
2. Choose **Connect Afternote** for Claude Desktop. Afternote verifies Claude's publisher,
   creates a minimal local MCPB package, and opens it in Claude.
3. Review the extension in Claude Desktop and approve **Install** there.
4. Return to Afternote and choose **Check again**. The first Remember or Recall request asks
   for the normal Afternote owner approval; later requests use the configured work-session
   window.

Disable or remove the connector from Claude Desktop's **Settings > Extensions**. Afternote
does not edit Claude's private extension records directly.

Managed Claude accounts may disallow custom extensions. Ask your administrator to approve
Afternote; a disabled Install button is not a reason to bypass workplace policy.

### Manage your notes and access

- Use **Notes** to browse, search, edit, and inspect revision history. An unchanged save
  does not create a revision.
- Use **Settings** to change routine authentication, lock or unlock the vault, and export
  notes. JSON exports preserve revisions; Markdown exports are for reading, not lossless
  restore. Exports are plaintext: store them somewhere private.
- Use **Connections** to inspect connector activity and revoke access. Locking the vault
  blocks connector reads and writes; unlocking or starting a new work session can require
  fresh approval. Quitting the app alone is not the same as locking the vault.

### If something goes wrong

Open **Settings > Save diagnostics** for a redacted diagnostic file, or run:

```bash
"$HOME/.local/bin/afternote" doctor
```

Report ordinary bugs through [GitHub Issues](https://github.com/dannykim32/afternote/issues)
or **Settings > Send feedback** (email). Include the Afternote version, macOS version,
connector, reproduction steps, and diagnostic output after reviewing it. Do not attach
your vault, exports, credentials, or screenshots containing private notes.
Report suspected vulnerabilities privately using [SECURITY.md](SECURITY.md).

If an upgrade reports a missing vault key or recovery error, stop and ask for help before
changing the vault or any Keychain item. Reinstalling is not a substitute for recovering
the installation-bound key.

## How it is put together

```text
Codex / Claude Code / Claude Desktop
        |
        v
  Afternote MCP command
        |
        v
 signed native XPC gateway  <-----  native owner app
        |                              (Touch ID / password)
        v
 private vault worker
        |
        +---- SQLCipher vault
        +---- macOS Keychain key
```

The connector command is an adapter, not a database client. It can ask the signed gateway
for only the scopes the owner approved. The gateway verifies the native caller and binds the
connection to its process. The private worker owns the vault key, authorization policy,
audit trail, and note mutations.

Canonical notes and revisions share a transaction with their exact, temporal, and
organizational projections. The semantic index is derived locally and can be
rebuilt without changing canonical notes. Connector lifecycle, owner-presence claims,
release policy, XPC transport, and product-surface routing each have explicit module seams
and focused tests.

Start with [the architecture guide](docs/ARCHITECTURE.md) for code locations, ownership,
and tests. The project's domain language is documented in [CONTEXT.md](CONTEXT.md).

## Security model

- The vault is encrypted with SQLCipher. A random per-vault key lives in the macOS
  data-protection Keychain and is retrieved only by the signed private worker.
- Connectors never open the database or receive its key. Their Remember and Recall grants
  are scoped, device-bound, auditable, and revocable.
- Routine authentication defaults to one owner approval per day. You can change it to
  four hours or fifteen minutes. Within that window, paired connectors can open short-lived
  connections without another prompt. An approved work session can survive a broker restart;
  manual vault lock, expiry, and policy changes require fresh approval.
- Screen lock, sleep, logout, manual vault lock, and broker restart clear live authority.
  Export, deletion, recovery, lock, and unlock always require fresh owner approval.
- Exact search, date-aware retrieval, and semantic inference run locally. The
  installed product has no Afternote account, sync endpoint, analytics transport, or
  telemetry transport.
- Public artifacts are Developer ID signed, notarized, stapled, checksummed, and bound to a
  signed payload manifest. Each release includes an SPDX SBOM and third-party notices.
- Official builds check a signed GitHub-hosted update feed once per day by default. You can turn
  that off in Settings or check manually. Afternote sends no optional system profile, and it never
  downloads or installs an update without your approval.

These controls reduce risk; they do not make arbitrary note content trustworthy. Recalled
text and source metadata are untrusted input to an AI client. Exports contain plaintext.
SQLCipher detects invalid ciphertext, but Afternote does not detect a valid encrypted vault
being replaced with an older snapshot by malware already controlling the logged-in account.
An approved connector is trusted to call Remember only after an explicit user request;
Afternote cannot independently prove which natural-language instruction caused a host tool
call.

Read the full [security model](docs/SECURITY_MODEL.md),
[data and network inventory](docs/DATA_AND_NETWORK.md), and
[enterprise security review](docs/ENTERPRISE_SECURITY.md) for assumptions, local paths, and
current limits.

## Retrieval and verification

Search by meaning is on by default in the beta, in both Notes and Recall calls from
approved connected tools. The app includes one local search engine: EmbeddingGemma for
finding candidates and Ettin for checking their relevance. There is no first-run model
download. Indexing and search happen on your Mac, without uploading notes to a model service.
The included model files occupy about 375 MB; runtime memory use is higher.

**Settings → Search by meaning** turns it on or off. Exact-text and date-aware search remain
available while local search prepares and when it is off. Existing notes index while the
vault is unlocked, and saved or edited notes update the same local index automatically.
Turning search off leaves saved notes and their revisions intact. CLI status is available
through `afternote semantic catalog` and `afternote semantic status`.

Notes and connected tools use the same semantic relevance and ranking rules. A connected
model can reformulate a query, but it cannot reason about a note Afternote has not returned.
Search still has misses and can return related notes that do not answer a question; always
inspect the original citation. See [beta evidence and limits](docs/BETA_READINESS.md) and
[model licenses and use restrictions](apps/local/packaging/MODEL_TERMS.md).

Results remain subject to that connector's approved access. What a connected AI host sends
to its provider is governed by the host's own behavior.

The repository contains deterministic exact, temporal, semantic, adversarial lifecycle,
recovery, package, and 10,000-note scale tests. A passing evaluation is evidence for its
fixture corpus, not a guarantee that every natural-language query will find the intended
note.

To run the standard local gates:

```bash
bun run typecheck
bun run test
bun run test:quality
bun run audit
```

## Contributing

See the [current status and roadmap](docs/ROADMAP.md) for shipped features, open
engineering work, and the next user-validation goals.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing storage, authorization, lifecycle,
or connector code. Report vulnerabilities through the private process in
[SECURITY.md](SECURITY.md), not the public issue tracker.

## License and name

The source is licensed under the [Apache License 2.0](LICENSE). It permits use,
modification, and redistribution under its terms. It does not grant rights to present a
modified product as Afternote or reuse the Afternote branding; see
[TRADEMARKS.md](TRADEMARKS.md).
