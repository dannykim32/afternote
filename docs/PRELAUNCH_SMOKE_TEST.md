# Prelaunch second-Mac smoke test

Run this against the signed and notarized **2.0.0-alpha.23** candidate containing the
post-Alpha-22 refactors, not the existing Alpha 22 download. Packaging and signing must finish first.
Record the candidate version and checksum supplied with that build. Allow about 30
minutes, including a 16-minute connector-session check.

Use synthetic notes, not employer data, and only accounts/connectors permitted by your
organization. Do not work around managed extension restrictions. Keep exports private.

## 1. Preserve the existing install and verify the candidate

Before upgrading, export existing notes from Settings to a new private local file.
Do not uninstall, remove version directories, reset the Vault, or edit Keychain items.

Transfer the candidate DMG and its matching `SHA256SUMS` into the same folder. From that
folder, run `shasum -a 256 -c SHA256SUMS`. It must name the candidate and report `OK`.
Run `hdiutil verify` with that DMG's filename; it must report a valid image.

Quit Afternote, install into Applications using the DMG, eject it, and open the copy in
Applications. Then run these as separate single-line commands:

```bash
/usr/libexec/PlistBuddy -c 'Print :AfternotePackageVersion' /Applications/Afternote.app/Contents/Info.plist
"$HOME/.local/bin/afternote" version
readlink "$HOME/Library/Application Support/Afternote/current"
codesign --verify --deep --strict --verbose=2 /Applications/Afternote.app
spctl --assess --type execute --verbose=4 /Applications/Afternote.app
xcrun stapler validate /Applications/Afternote.app
"$HOME/.local/bin/afternote" doctor
```

The app, CLI, runtime symlink, and doctor's application version must match the candidate.
Signatures, Gatekeeper, and stapling must pass. Doctor must report running/integrity OK
with no errors. Existing notes and revisions must remain, and the Dock must open this copy.

## 2. Check each connector with a new real tool call

Fully quit and reopen Codex, Claude Code, and Claude Desktop once after the upgrade.
In Afternote, set routine authentication to **Once a day**. Check:

```bash
"$HOME/.local/bin/afternote" codex status
"$HOME/.local/bin/afternote" claude-code status
"$HOME/.local/bin/afternote" claude-desktop status
```

Each connected host should report healthy. In each host, start a fresh conversation
and ask it to save a unique canary through Afternote, for example:

> Use Afternote's remember tool to save exactly: "Prelaunch Codex canary - Birch 731".
> Return the actual tool result's note ID and revision.

Use different host names and numbers for Claude Code and Claude Desktop. Confirm actual
tool calls, not only the assistant's claim. Ask each host to recall its canary through
Afternote and fetch its saved note by ID. Check exact content and revision.

In Afternote Notes, all three notes must appear with their correct host attribution.
On Connections, saved/recall activity must increase for the host used. Compare changes
from the starting counters, not assumed totals; a host may issue more than one tool call.
Repeated passive refresh must not demand fresh Touch ID/password approval.

## 3. Exercise editor and retrieval state

Open a canary, edit it, append a second line, and save. Confirm revision 2, then inspect
revision 1 without changing the current note. An unchanged draft must not enable Save.
Type a temporary edit and discard it: the saved text and revision must remain unchanged.

Search for two different canaries in quick succession. The final query's results must
remain on screen; late results must not replace them or overwrite text being typed.
Switch between Notes and Connections and back. If there are enough notes for **Show more**,
load a second page and check for duplicates or unexpected result replacement. Record
pagination as not exercised if the Vault has too few notes; do not manufacture a large corpus.

Resize the window narrow and wide. Notes and Connections should remain centered, action
columns should align, and Refresh/Repair/Revoke should be legible without clipping.

## 4. Read connection history

Expand a host's connection history. Fresh approval for history inspection may be required;
that is different from passive refresh. Events must load for the appropriate host, with
no raw errors. If **Show older events** is available, page once and check for duplicates.
Collapse/reopen the history and confirm the page remains usable.

## 5. Cross the 15-minute connector-session limit

Leave Afternote and all hosts running with the Once-a-day setting. Wait at least 16
minutes after the initial routine approval, without locking or changing authentication
settings. Then make a fresh Afternote save and recall in each host.

Routine Touch ID/password approval should not recur solely because a 15-minute connector
session expired. Verify the actual tools ran and attribution/activity still updates.

## 6. Lock, unlock, and revoke

Lock the Vault in Afternote. In each existing host conversation, request a fresh recall
and direct fetch of its canary. Both must fail as locked; the host must not receive new
note text. Text already in the conversation is not evidence of a successful tool call.
Native Notes/editor content must clear and must not reappear from a delayed reply.

Unlock in Afternote and repeat one recall in each host. Fresh approval after an explicit
lock/unlock is expected. Access must recover without reinstalling or resetting anything.

Revoke one test connector in Connections, approving the exact action. Its next real
tool call must fail; another connector should still work. Reconnect the revoked host
through the supported UI flow and verify save/recall again. Report a missing repair or
reconnect control instead of editing host configuration manually.

For the reconnect fix after Alpha 23, test each supported connector: **Prepare reconnect**
must request fresh Touch ID/password approval. Cancel once and verify access stays
revoked. Prepare again, approve, then start a fresh host session and verify a real
save/recall. The old session must remain denied. A healthy CLI status alone proves
installation/tool discovery, not restoration of revoked access.

## 7. Export and final restart

Export through Settings to a new private filename and confirm it succeeds after approval.
Quit/reopen Afternote, then verify the canaries, revision history, connector state, and
Once-a-day preference remain. Run doctor again and save the output.

Restore testing is optional here if the earlier export/restore acceptance already passed.
If repeated, use only a disposable macOS test account/Vault and synthetic data. Never
replace the existing work-laptop Vault just to exercise restore.

## Report back

Send the version, checksum result, signature/Gatekeeper/stapler results, final doctor
output, and pass/fail/not-exercised for steps 2–7. For a failure, include the host, exact
action, whether a real tool call ran, and a screenshot or redacted error. Do not share
the export, Vault database, signing material, or unrelated private notes.

A passing smoke test verifies these flows on a second Mac. It does not replace the
[release gates](RELEASING.md), a fresh-install trial, or broader security review.
