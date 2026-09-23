# Getting started with Afternote

[Back to Afternote](../README.md)

## Try it

Afternote is a beta for Apple Silicon Macs running macOS 13.3 or newer.
Read the [beta notice](../BETA_NOTICE.md) and [Local privacy notice](https://afternote.dev/privacy#local)
before using it with information you need. Keep independent backups.

Download the signed and notarized DMG and its `SHA256SUMS` from
[GitHub Releases](https://github.com/dannykim32/afternote/releases), then follow
[the verification and installation steps](VERIFY_RELEASE.md).
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

## Remember and Recall

Once a connector is paired, the interaction stays deliberately small:

```text
You: Use Afternote to remember: The Atlas launch is on hold until Priya approves the security review.
Claude Desktop: Saved to Afternote.

Later, in Codex:
You: Using Afternote, what's holding up the Atlas release?
Codex: The launch is waiting for Priya to approve the security review. [Afternote note, revision 1]
```

The note is visible and editable in the native app. Edits create immutable revisions;
Recall cites the exact note revision it used.

For a first check, ask your host: **Use Afternote to remember exactly: "The Atlas launch is
on hold until Priya approves the security review."** Open Notes to confirm it was saved. Once Notes reports **Search by meaning ready**,
open a new chat and ask the host to **use Afternote to recall what’s holding up the Atlas release**. Confirm it actually calls
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
  the Vault. JSON exports preserve revisions, Archives and paused imports; Markdown exports contain only current Notes and are for reading, not lossless
  restore. Exports are plaintext: store them somewhere private.
- Use **Connections** to inspect connector activity and revoke access. Locking the vault
  blocks connector reads and writes; unlocking or starting a new work session can require
  fresh approval. Quitting the app alone is not the same as locking the vault.

### Conversation Archives

For larger transcripts, use **Notes > Conversation Archives… > Import transcript…**.
Imports accept UTF-8 text/Markdown up to 64 MiB. The viewer supports pause/resume,
exact passage search and bounded pages. Connectors require separate **Allow Archive
access** approval in Connections. See the [full Archive walkthrough](CONVERSATION_ARCHIVES.md#use).

### Troubleshooting

Open **Settings > Save diagnostics** for a redacted diagnostic file, or run:

```bash
"$HOME/.local/bin/afternote" doctor
```

Report ordinary bugs through [GitHub Issues](https://github.com/dannykim32/afternote/issues)
or **Settings > Send feedback** (email). Include the Afternote version, macOS version,
connector, reproduction steps, and diagnostic output after reviewing it. Do not attach
your vault, exports, credentials, or screenshots containing private notes.
Report suspected vulnerabilities privately using [SECURITY.md](../SECURITY.md).

If an upgrade reports a missing vault key or recovery error, stop and ask for help before
changing the vault or any Keychain item. Reinstalling is not a substitute for recovering
the installation-bound key.
