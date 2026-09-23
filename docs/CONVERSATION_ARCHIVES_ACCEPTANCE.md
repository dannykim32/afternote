# Beta 6 Archive acceptance

Use the exact signed Beta 6 candidate and synthetic transcripts. These are manual
checks, not results. Complete the install/upgrade/lifecycle checks in
[RELEASING.md](RELEASING.md) and the signature checks in
[VERIFY_RELEASE.md](VERIFY_RELEASE.md) as well. Keep the current Vault's JSON
backup before upgrading; that backup is plaintext and must be stored privately.

Beta 6 advances the Vault to schema 11. Beta 5 cannot open that newer schema or
restore an Archive-inclusive schema-2 export. Replacing the app with Beta 5 is
not a data downgrade. Keep the pre-upgrade export and original transcript files;
test older-version recovery only on a disposable account with the corresponding
older-format backup. Never delete the active Vault or its Keychain items to make
a downgrade appear to work.

## Install and ordinary Notes

1. Install/open the candidate. Confirm the app's `AfternotePackageVersion`,
   `afternote version`, and `afternote doctor` identify `2.0.0-beta.6`, and doctor
   reports valid Vault integrity. Existing Notes and their revisions must survive.
2. Save and recall a synthetic ordinary Note in each supported host you use:
   Codex, Claude Code, and Claude Desktop. Confirm source attribution and existing
   Notes behavior have not changed. Record hosts not tested rather than assuming
   another host's pass covers them.

## Explicit import and reading

3. Save a plain UTF-8 `.txt` or `.md` file containing:

   ```text
   User: Archive beta six canary - Juniper 643.
   Assistant: The planning meeting is about a blue notebook.
   User: Preserve this line exactly: café 🌲.
   ```

4. Open **Notes > Conversation Archives…**, approve authentication, choose
   **Import transcript…**, and select the file. Confirm it appears under Saved,
   opens read-only, and preserves all three lines. The source file must remain
   unchanged. Search for `Juniper`; the hit should identify the Archive and passage.
   Searching an absent word must not leave old matches or text on screen.
5. With a larger synthetic UTF-8 transcript, pause an import, close/reopen the
   viewer, select it under Paused imports, and resume with the same file. Check
   beginning, middle and final passages. Retrying must not duplicate passages.
   A paused import must not appear in Saved or connector search. Also discard a
   separate paused import and verify it disappears.
6. Resize to the minimum window size. Long transcript lines should wrap within
   the reader. Verify keyboard focus reaches search, list, reader and paging
   controls; check VoiceOver labels if available. Record any clipped text or
   inaccessible action.

## Separate connector permission

7. Restart the AI host if its tool list predates this update. Before granting
   Archive access, ask it to call `search_archives` for `Juniper`. Access must be
   denied; ordinary Note access should still work. A host's verbal assertion is
   not evidence: expand its tool call and inspect the result.
8. In Connections, choose **Allow Archive access** for that connector. Confirm
   fresh macOS approval is requested. This grants access to all completed
   Archives, including future imports. Ask the host to search again, then call
   `read_archive` using the returned Archive ID. It should return the original
   text with passage citations, not fetch the whole large transcript by default.
9. Lock the Vault. The viewer must clear its text, and a new Archive tool call
   must fail. Unlock and establish a new approved session; reading should recover.
   Revoke that connector and repeat a new Archive read: it must fail. Reconnection
   must not silently restore Archive permission; approve it separately again.
10. Repeat the permission/read check for the other supported hosts. With the
    once-a-day routine setting, cross the 15-minute session boundary and confirm
    routine use does not unexpectedly demand another password. Explicit lock,
    revocation and sensitive operations still reset or require approval.

## Backup and deletion

11. Export the Vault as JSON after importing both a completed Archive and a paused
    one. On a separate disposable test account/Vault, restore it and verify Notes,
    revisions, completed Archive text and paused progress survive. Do not restore
    over the original test Vault just to exercise this check. Markdown is not an
    Archive backup.
12. Delete a completed synthetic Archive through the viewer. Confirm fresh owner
    approval, disappearance from search, and failure to read its old ID through
    the connector. The original transcript file must remain unchanged. Run
    `afternote doctor` again and retain any error text without sharing private
    transcript content or JSON backups.

Archive search in this beta is exact-word search, not semantic or fuzzy search.
The 64 MiB per-transcript limit is a byte limit, not a promised token capacity.
Archive operations are separate from the existing Note save/recall counters.
