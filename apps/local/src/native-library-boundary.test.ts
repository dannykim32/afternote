import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const sourceDirectory = import.meta.dir;
const nativeAppearanceSource = ["native_appearance.h", "native_appearance.mm"]
  .map((file) => readFileSync(join(sourceDirectory, "../native", file), "utf8"))
  .join("\n");
const nativeAppSource = readFileSync(
  join(sourceDirectory, "../native/owner_control_app.mm"),
  "utf8",
);
const editorViewSource = readFileSync(join(sourceDirectory, "../native/note_editor_view.mm"), "utf8");
const ownerBrokerSource = readFileSync(
  join(sourceDirectory, "../native/owner_broker.mm"),
  "utf8",
);
const setupGuideStateSource = readFileSync(
  join(sourceDirectory, "../native/setup_guide_state.mm"),
  "utf8",
);
const noteEditorStateSource = readFileSync(
  join(sourceDirectory, "../native/note_editor_state.mm"),
  "utf8",
);
const brokerContractSource = readFileSync(
  join(sourceDirectory, "../native/owner_broker_contract.mm"), "utf8",
);
const cliSource = readFileSync(join(sourceDirectory, "local-cli.ts"), "utf8");
const applicationInstallationSource = readFileSync(
  join(sourceDirectory, "../native/application_installation.mm"),
  "utf8",
);
const nativeLaunchSource = cliSource.slice(
  cliSource.indexOf("function openNativeApplication("),
  cliSource.indexOf("async function relaunchWithBundledLibraries("),
);

describe("native Library production boundary", () => {
  it("uses the single dark Afternote design system without weakening native controls", () => {
    for (const token of [
      "AfternoteCanvasColor",
      "AfternoteSidebarColor",
      "AfternoteSurfaceColor",
      "AfternoteBorderColor",
      "AfternoteTextColor",
      "AfternoteMutedTextColor",
      "AfternoteAccentColor",
      "AfternoteBrandCaptureColor",
      "AfternoteMemoryThreadColor",
    ]) {
      expect(nativeAppearanceSource).toContain(token);
    }
    expect(nativeAppSource).toContain("NSAppearanceNameDarkAqua");
    expect(nativeAppSource).toContain("selectedSegmentBezelColor");
    expect(editorViewSource).toContain("typingAttributes");
    expect(editorViewSource).toContain("NSForegroundColorAttributeName");
    expect(editorViewSource).toContain("noteEditor.richText = NO");
    expect(editorViewSource).toContain("noteEditor.importsGraphics = NO");
    expect(nativeAppSource).toContain('@"Smart categories"');
    expect(nativeAppSource).toContain('@"appearanceMode" : @"dark"');
    expect(nativeAppSource).toContain('@"plainTextEditor" : @YES');
    expect(nativeAppSource).toContain('@"plainTextListFormatting" : @YES');
    expect(editorViewSource).toContain('action:@selector(toggleBulletList:)');
    expect(editorViewSource).toContain('action:@selector(toggleNumberedList:)');
    expect(editorViewSource).toContain('doCommandBySelector:(SEL)commandSelector');
    expect(nativeAppSource).toContain("libraryAuthenticateButton.hidden");
    // Refresh title, enabled state, and dispatch are covered by the standalone screen test.
    expect(nativeAppSource).not.toContain("VisibleNoteMetadata");
    expect(nativeAppSource).not.toContain("NSAppearanceNameAqua");
  });

  it("uses Capture Teal consistently for selected and focused controls", () => {
    const navigationStyle = nativeAppSource.slice(
      nativeAppSource.indexOf("- (void)styleProductNavigationButton:"),
      nativeAppSource.indexOf("- (void)updateProductNavigationState"),
    );
    expect(navigationStyle).toContain(
      "selected ? AfternoteBrandCaptureColor() : AfternoteMutedTextColor()",
    );
    expect(nativeAppSource).toContain(
      "selected ? AfternoteBrandCaptureColor() : AfternoteTextColor()",
    );
    expect(nativeAppSource).toContain(
      "focused ? AfternoteBrandCaptureColor() : AfternoteBorderColor()",
    );
  });

  it("uses quiet flat controls instead of glossy rounded push buttons", () => {
    expect(nativeAppearanceSource).toContain("@interface AfternoteButton : NSButton");
    expect(nativeAppearanceSource).toContain("flatButton.afternoteFillColor");
    expect(nativeAppearanceSource).toContain("flatButton.afternoteHoverColor");
    expect(nativeAppearanceSource).toContain("flatButton.afternotePressedColor");
    expect(nativeAppearanceSource).not.toContain("NSBezelStyleRounded");
    expect(nativeAppearanceSource).not.toContain("NSBezelStyleTexturedRounded");
  });

  it("presents one Notes bank with disposable search results and an editor", () => {
    expect(nativeAppSource).toContain(
      'segmentedControlWithLabels:@[ @"Write", @"Ask", @"Browse" ]',
    );
    expect(nativeAppSource).toContain("switchLibraryMode:");
    expect(nativeAppSource).toContain("AfternoteLibraryModeWrite");
    expect(nativeAppSource).toContain("AfternoteLibraryModeAsk");
    expect(nativeAppSource).toContain("AfternoteLibraryModeBrowse");
    expect(nativeAppSource).toContain("libraryWorkspaceTabs");
    expect(nativeAppSource).toContain('@interface AfternoteAskComposerView : NSView');
    expect(nativeAppSource).toContain('searchField.focusRingType = NSFocusRingTypeNone');
    expect(nativeAppSource).toContain('@"Search anything you\'ve written down"');
    expect(nativeAppSource).toContain("RunLibrarySearchSubmissionSmoke");
    expect(nativeAppSource).toContain('"--library-search-submission-smoke"');
    expect(nativeAppSource).toContain('@"Your local notes."');
    expect(nativeAppSource).toContain('@"Results from your saved notes."');
    expect(nativeAppSource).toContain('@"Results · %lu"');
    expect(nativeAppSource).toContain(
      '@"RESULT  ·  %@  ·  R%@  ·  OPEN NOTE"',
    );
    expect(nativeAppSource).toContain('@"VisibleNoteDay"');
    expect(nativeAppSource).not.toContain('@"VisibleResultMarker"');
    expect(nativeAppSource).toContain('@"%ld revisions"');
    expect(nativeAppSource).toContain("defaultSource");
    expect(nativeAppSource).toContain("return beginsDay ? 128 : 104");
    expect(nativeAppSource).toContain("self.afternoteHovered && !self.isSelected");
    expect(nativeAppSource).not.toContain('@"QUESTION"');
    expect(nativeAppSource).not.toContain("conversationThreads");
    expect(nativeAppSource).not.toContain("beginNewConversation:");
    expect(nativeAppSource).toContain("RunRevisionNavigationSmoke");
    expect(nativeAppSource).toContain('"--revision-navigation-smoke"');
    expect(nativeAppSource).toContain("RunCitationInspectorSmoke");
    expect(nativeAppSource).toContain('"--citation-inspector-smoke"');
    expect(nativeAppSource).toContain("self.inspectingCitation = searchResult");
    expect(nativeAppSource).toContain(
      '[self openNoteId:StringValue(summary[@"id"])',
    );
    expect(nativeAppSource).toContain(
      'revision:searchResult ? summary[@"revision"] : nil]',
    );
    expect(editorViewSource).toContain('buttonWithTitle:@"Edit current note"');
    expect(editorViewSource).toContain('action:@selector(editCurrentNote:)');
    expect(editorViewSource).toContain('@"Cited result · Revision %@"');
    expect(nativeAppSource).toContain("clearSearch:");
    expect(nativeAppSource).toContain('@"SMART CATEGORIES"');
    expect(nativeAppSource).not.toContain("AfternoteMemoryThreadView");
    expect(nativeAppSource).toContain("StyleSurface(self.askComposer, AfternoteSurfaceColor(), 10)");
    expect(nativeAppSource).toContain('imageWithSystemSymbolName:@"arrow.right"');
    expect(nativeAppSource).toContain("kAskSubmitButtonSize = 28");
    expect(editorViewSource).toContain('imageWithSystemSymbolName:@"checklist"');
    expect(editorViewSource).toContain('imageWithSystemSymbolName:@"list.bullet"');
    expect(editorViewSource).toContain('imageWithSystemSymbolName:@"list.number"');
    expect(editorViewSource).toContain("AfternoteListStyleChecklist");
    expect(nativeAppSource).toContain('preservesMixedLists');
    expect(editorViewSource).toContain("AfternoteIndentList");
    expect(editorViewSource).toContain("@selector(insertTab:)");
    expect(editorViewSource).toContain("@selector(insertBacktab:)");
    expect(editorViewSource).toContain("AfternoteNoteTextView");
    expect(editorViewSource).toContain("formattingBar, editorScroll");
    expect(nativeAppSource).toContain("kAskComposerMaximumHeight");
    expect(nativeAppSource).toContain("NSLineBreakByWordWrapping");
    expect(editorViewSource).toContain('action:@selector(returnToMemory:)');
    expect(nativeAppSource).toContain('@"Discard this new memory?"');
    expect(editorViewSource).toContain('buttonWithTitle:@"Discard changes"');
    expect(editorViewSource).toContain("AfternoteEditorHasUnsavedChanges");
    expect(editorViewSource).toContain("self.noteEditor.textContainerInset = NSMakeSize(8, 16)");
    expect(nativeAppSource).toContain("noteColumn.width = 600");
    expect(nativeAppSource).toContain("NSTableViewLastColumnOnlyAutoresizingStyle");
    expect(nativeAppSource).toContain("self.noteTable.style = NSTableViewStylePlain");
    expect(nativeAppSource).toContain("[content.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor constant:8]");
    expect(nativeAppSource).toContain("[content.trailingAnchor constraintEqualToAnchor:cell.trailingAnchor constant:-8]");
    expect(editorViewSource).toContain('imageWithSystemSymbolName:@"checkmark"');
    expect(noteEditorStateSource).toContain('presentation.title = @"Saved locally"');
    expect(nativeAppSource).toContain("[self.noteEditorView setSaveState:");
    expect(nativeAppSource).toContain('containsObject:@"--preview-saved"');
    expect(nativeAppSource).toContain("editorSaveConfirmationPending");
    expect(editorViewSource).toContain("constraintEqualToConstant:132");
    expect(nativeAppSource).not.toContain("showEditorSavedState");
    expect(editorViewSource).toContain("AfternoteHistoricalRevisionRows(");
    expect(noteEditorStateSource).toContain("number.integerValue == currentRevision");
    expect(editorViewSource).toContain("- (void)textDidChange:(NSNotification *)notification");
    expect(nativeAppSource).not.toContain(
      '// Search citations identify the evidence revision, but editing always opens',
    );
    expect(nativeAppSource).toContain("view[@\"noteCount\"] unsignedIntegerValue] == 0");
    expect(nativeAppSource).not.toContain('@"Most relevant passage"');
    expect(nativeAppSource).not.toContain('@"CITED PASSAGE');
    expect(nativeAppSource).not.toContain("bezierPathWithRoundedRect:cardRect");
    expect(nativeAppSource).not.toContain(
      "stackViewWithViews:@[viewRail, noteRail, detail]",
    );
    expect(nativeAppSource).toContain("self.libraryModeSelector.hidden = YES");
    expect(nativeAppSource).toContain(
      'segmentedControlWithLabels:@[ @"Notes", @"Connections" ]',
    );
    expect(nativeAppSource).toContain("buildSetupView");
    expect(nativeAppSource).toContain("buildSettingsView");
    expect(nativeAppSource).toContain("AfternoteTabIndexForSurface(resolved)");
    expect(nativeAppSource).not.toMatch(/k(?:Memory|Connections|Recovery|Setup|Settings)TabIndex/);
  });

  it("refreshes Notes after connector writes and exposes history from a search citation", () => {
    expect(nativeAppSource).toContain("applicationDidBecomeActive:");
    expect(nativeAppSource).toContain("libraryRefreshPending");
    expect(nativeAppSource).toContain('buttonWithTitle:@"Refresh"');
    expect(nativeAppSource).toContain("refreshVisibleLibraryNotes:");
    expect(nativeAppSource).toContain("ActiveNoteIdentifier(");
    expect(nativeAppSource).toContain(
      "![ActiveNoteIdentifier(self.activeNote) isEqualToString:noteId]",
    );
    expect(nativeAppSource).toContain("if (revision == nil || self.inspectingCitation) [self loadRevisionHistory:NO]");
    expect(nativeAppSource).not.toContain(
      "self.revisionMenu.hidden = self.inspectingCitation || self.creatingNote",
    );
  });

  it("tracks vault lock state in Settings and defaults routine authentication to once a day", () => {
    expect(nativeAppSource).toContain("vaultAccessButton");
    expect(nativeAppSource).toContain("updateVaultAccessButton");
    expect(nativeAppSource).toContain('action:@selector(toggleVaultLock:)');
    expect(nativeAppSource).toContain('@"Unlock vault"');
    expect(nativeAppSource).toContain('@"Once a day"');
    expect(nativeAppSource).toContain("RoutineAuthenticationTtlMilliseconds()");
    expect(nativeAppSource).toContain("kRoutineAuthenticationDailyMilliseconds");
    expect(nativeAppSource).toContain("vaultStatusCheckInFlight");
    expect(nativeAppSource).toContain('@"owner.routine_authentication"');
    expect(nativeAppSource).toContain('@"owner.set_routine_authentication"');
    expect(nativeAppSource).toContain("Changing this setting applies to every connector.");
    expect(nativeAppSource).toContain("Claude Desktop connections");
    expect(nativeAppSource).toContain("clearLibraryPlaintext:");
  });

  it("opens on Notes and keeps a dismissible setup guide available", () => {
    expect(cliSource).toContain('openNativeApplication("library"');
    expect(nativeAppSource).toContain('@"Set up Afternote where you work"');
    expect(nativeAppSource).toContain('@"Connect one tool"');
    expect(nativeAppSource).toContain('@"Test the connection"');
    expect(nativeAppSource).toContain('@"Start setup"');
    expect(nativeAppSource).toContain('@"Hide this guide"');
    expect(nativeAppSource).toContain("kSetupGuideDismissedDefaultsKey");
    expect(nativeAppSource).toContain('@"dev.afternote.setup-guide-dismissed"');
    expect(nativeAppSource).toContain("boolForKey:kSetupGuideDismissedDefaultsKey");
    expect(nativeAppSource).toContain("setBool:YES");
    expect(nativeAppSource).not.toContain("setObject:");
    expect(nativeAppSource).toContain('@"Show setup guide"');
    expect(nativeAppSource).toContain("AfternoteHasCorrelatedRecallProof");
    expect(setupGuideStateSource).toContain('event[@"outcome"] isEqualToString:@"success"');
    expect(setupGuideStateSource).toContain('recall[@"clientId"] isEqualToString:clientId');
    expect(setupGuideStateSource).toContain("intersectsSet:ReferencedNoteIds(recall)");
    expect(nativeAppSource).not.toContain('@"Prove it works"');
    expect(nativeAppSource).toContain('[text.widthAnchor constraintEqualToConstant:496]');
    expect(nativeAppSource).toContain('[status.widthAnchor constraintEqualToConstant:90]');
    expect(nativeAppSource).toContain('[actionSlot.widthAnchor constraintEqualToConstant:166]');
    expect(nativeAppSource).toContain('@"Prepare reconnect"');
    expect(nativeAppSource).toContain('action:@selector(reconnectIntegration:)');
    expect(nativeAppSource).toContain('[self runPackagedCommand:@[ kind, @"prepare-reconnect" ]');
    expect(nativeAppSource).toContain('You do not need to prepare reconnect again.');
    expect(nativeAppSource).toContain('![self.integrationOperations containsObject:descriptor.commandKind]');
  });

  it("installs and removes the private runtime without asking users to open Terminal", () => {
    expect(applicationInstallationSource).toContain('@"AfternoteRuntime"');
    expect(applicationInstallationSource).toContain('@"AFTERNOTE_APPLICATION_PATH"');
    expect(applicationInstallationSource).toContain('@"/Volumes/"');
    expect(applicationInstallationSource).toContain('@"/bin/sh"');
    expect(applicationInstallationSource).toContain("AfternoteEnsureRuntimeInstalled");
    expect(applicationInstallationSource).toContain("AfternoteUninstallRuntime");
    expect(nativeAppSource).toContain("AfternoteEnsureRuntimeInstalled");
    expect(nativeAppSource).toContain('buttonWithTitle:@"Uninstall Afternote…"');
    expect(nativeAppSource).toContain("AfternoteUninstallRuntime");
    expect(nativeAppSource).toContain("recycleURLs");
    expect(nativeAppSource).toContain("scroll.hasVerticalScroller = YES");
    expect(nativeAppSource).toContain("FlippedStackView *document");
    expect(cliSource).toContain("installedApplicationBundle");
    expect(cliSource).toContain('"application-path"');
  });

  it("combines installation and broker truth into one row per connector", () => {
    const surfaceSwitch = nativeAppSource.slice(
      nativeAppSource.indexOf("- (void)switchSurface:"),
      nativeAppSource.indexOf("- (void)openSettings:"),
    );
    expect(nativeAppSource).toContain("packagedCommandPath");
    expect(nativeAppSource).toContain("RunIntegrationCommand");
    expect(nativeAppSource).toContain("IntegrationFailureMessage");
    expect(nativeAppSource).toContain('((NSDictionary *)value)[@"message"]');
    expect(nativeAppSource).toContain('environment[@"PATH"]');
    expect(nativeAppSource).toContain('"--integration-command-smoke"');
    expect(nativeAppSource).toContain("refreshIntegrationStatuses");
    // Rendering and action dispatch are exercised by native-connections-view.test.ts.
    expect(nativeAppSource).toContain("AfternoteIntegrationDescriptor");
    expect(nativeAppSource).toContain('displayName:@"Codex"');
    expect(nativeAppSource).toContain('displayName:@"Claude Code"');
    expect(nativeAppSource).toContain('displayName:@"Claude Desktop"');
    expect(nativeAppSource).toContain("connectorRowForCommandKind:");
    expect(nativeAppSource).toContain("toggleConnectorHistory:");
    expect(nativeAppSource).toContain("expandedConnectorKinds");
    expect(nativeAppSource).toContain('requestMethod:@"owner.revoke_connector"');
    expect(nativeAppSource).toContain("self.revocationTargets[brokerKind]");
    expect(nativeAppSource).not.toContain("self.revocationTargets[clientId]");
    expect(nativeAppSource).not.toContain('@"Load earlier activity"');
    expect(nativeAppSource).not.toContain("AfternoteMemoryThreadView");
    const connectorHistory = nativeAppSource.slice(
      nativeAppSource.indexOf("NSArray<NSString *> *ConnectorLifecycleHistory("),
      nativeAppSource.indexOf("OwnerBrokerConnection *NewOwnerBrokerConnection"),
    );
    expect(connectorHistory).toContain('addEntry(@"Connected"');
    expect(connectorHistory).toContain('addEntry(@"Revoked"');
    expect(connectorHistory).not.toContain('isEqualToString:@"memory.recall"');
    expect(nativeAppSource).not.toContain('@"No tools paired yet"');
    expect(nativeAppSource).not.toContain(
      '@"Previous access was revoked and cannot be reused."',
    );
    expect(surfaceSwitch).toContain("[self refreshConnections:nil];");
    expect(surfaceSwitch).not.toContain("[self authenticate:nil]");
    expect(nativeAppSource).not.toContain(
      'Connect from Terminal with `afternote codex install` or `afternote claude-code install`.',
    );
  });

  it("refreshes connector status and share-safe activity without owner presence", () => {
    const refreshAction = nativeAppSource.slice(
      nativeAppSource.indexOf("- (void)refreshConnections:"),
      nativeAppSource.indexOf("- (void)installIntegration:"),
    );
    expect(refreshAction).toContain("[self refreshIntegrationStatuses];");
    expect(refreshAction).toContain('requestMethod:@"owner.connector_overview"');
    expect(refreshAction).not.toContain('requestMethod:@"owner.session.begin"');
    // The screen's unauthenticated history label is covered through its render interface.
  });

  it("refreshes passive connector activity when Afternote returns to the foreground", () => {
    const activation = nativeAppSource.slice(
      nativeAppSource.indexOf("- (void)applicationDidBecomeActive:"),
      nativeAppSource.indexOf("- (void)vaultDidLock:"),
    );
    expect(activation).toContain('isEqual:@"connections"');
    expect(activation).toContain("[self refreshConnections:nil];");
  });

  it("keeps note plaintext in native AppKit controls without storage or browser authority", () => {
    expect(nativeAppSource).toContain("NSTextView");
    expect(nativeAppSource).toContain("library.session.begin");
    expect(nativeAppSource).toContain("library.browse");
    expect(nativeAppSource).toContain("library.search");
    expect(nativeAppSource).toContain("library.get_note");
    expect(nativeAppSource).toContain("library.list_revisions");
    expect(nativeAppSource).toContain("library.remember");
    expect(nativeAppSource).toContain("library.update_note");
    expect(nativeAppSource).toContain("library.delete");
    for (const prohibited of [
      "WKWebView",
      "WebKit",
      "SqliteMemory",
      "SQLCipher",
      "afternote_sqlcipher",
      "runtime.token",
      "ensureLocalRuntime",
      "LocalRuntimeAdminClient",
      "browser bootstrap",
      "document.cookie",
      "localStorage",
      "NSPasteboard",
    ]) {
      expect(nativeAppSource).not.toContain(prohibited);
    }
  });

  it("routes standard Edit commands through the native responder chain", () => {
    expect(nativeAppSource).toContain("InstallApplicationMenu");
    for (const selector of [
      "@selector(undo:)",
      "@selector(redo:)",
      "@selector(cut:)",
      "@selector(copy:)",
      "@selector(paste:)",
      "@selector(selectAll:)",
    ]) {
      expect(nativeAppSource).toContain(selector);
    }
    expect(nativeAppSource).not.toContain("NSPasteboard");
  });

  it("exposes signed updates through one owner-controlled native seam", () => {
    expect(nativeAppSource).toContain('#import "software_update.h"');
    expect(nativeAppSource).toContain('@"Check for Updates…"');
    expect(nativeAppSource).toContain("AfternoteCreateSoftwareUpdateController");
    expect(nativeAppSource).toContain('@"Check automatically"');
    expect(nativeAppSource).toContain("automaticallyChecksForUpdates");
  });

  it("routes both CLI entry points through macOS to the signed native application bundle", () => {
    expect(cliSource).toContain('openNativeApplication("library"');
    expect(cliSource).toContain('openNativeApplication("connections"');
    expect(nativeLaunchSource).toContain('"Afternote.app"');
    expect(nativeLaunchSource).toContain('Bun.spawnSync(["/usr/bin/open", appBundle');
    expect(nativeLaunchSource).not.toContain('["/usr/bin/open", "-n"');
    expect(nativeLaunchSource).toContain('"--args", `--${surface}`');
    expect(nativeLaunchSource).toContain("if (launch.exitCode !== 0)");
    expect(nativeLaunchSource).not.toContain("Bun.spawn([appExecutable");
    for (const prohibited of [
      "ensureLocalRuntime",
      "LocalRuntimeAdminClient",
      "SqliteMemory",
      "runtime.token",
      "http://",
      "https://",
      "Cookie",
      "bootstrap",
      "sh -c",
      "/bin/sh",
      "osascript",
      "open location",
    ]) {
      expect(nativeLaunchSource).not.toContain(prohibited);
    }
  });

  it("declares plaintext cleanup and disables sensitive restoration", () => {
    expect(nativeAppSource).toContain("clearLibraryPlaintext");
    expect(nativeAppSource).toContain("librarySessionGeneration");
    expect(nativeAppSource).toContain("generation != self.librarySessionGeneration");
    expect(nativeAppSource).toContain("![self.notesRetrieval complete:request result:result error:error]");
    expect(nativeAppSource).toContain("requestSequence != self.libraryNoteRequestSequence");
    expect(nativeAppSource).toContain("requestSequence != self.libraryRevisionRequestSequence");
    expect(nativeAppSource).toContain("if (!NSThread.isMainThread)");
    expect(editorViewSource).toContain("noteEditor.undoManager removeAllActions");
    expect(nativeAppSource).toContain("librarySensitiveAlert");
    expect(ownerBrokerSource).toContain("resetConnection");
    expect(ownerBrokerSource).toContain("invalid_response");
    expect(nativeAppSource).toContain("libraryMutationInFlight");
    expect(ownerBrokerSource).toContain("testRejectsSerializedResponse");
    expect(ownerBrokerSource).toContain("testAcceptsSerializedResponse");
    expect(brokerContractSource).toContain("IsAuditClientId");
    expect(brokerContractSource).toContain("IsAuditPrincipal");
    expect(brokerContractSource).toContain("IsBrokerResult");
    expect(nativeAppSource).toContain("protocolInvalidationCleared");
    expect(nativeAppSource).toContain("RunLibraryCleanupSmoke");
    expect(nativeAppSource).toContain("self.window.restorable = NO");
    expect(nativeAppSource).toContain("plaintextClearsOnDisconnectOrExpiry");
    expect(nativeAppSource).toContain("noteStateRestoration");
    expect(nativeAppSource).toContain("dev.afternote.vault-did-lock");
    expect(nativeAppSource).toContain("dev.afternote.vault-did-unlock");
    expect(nativeAppSource).toContain("vaultDidLock:");
    expect(nativeAppSource).toContain("vaultDidUnlock:");
    expect(nativeAppSource).toContain('@"Unlock vault"');
    expect(nativeAppSource).toContain('@"vault_locked"');
  });

  it("routes lock and unlock only through strict native owner-control responses", () => {
    expect(cliSource).toContain('case "lock"');
    expect(cliSource).toContain('case "unlock"');
    expect(cliSource).toContain('"--admin-lock"');
    expect(cliSource).toContain('"--admin-unlock"');
    expect(nativeAppSource).toContain('@"lifecycle.lock"');
    expect(nativeAppSource).toContain('@"lifecycle.unlock"');
    expect(brokerContractSource).toContain("IsLifecycleResult");
    expect(brokerContractSource).toContain("IsLifecycleTransitionConsistent");
    expect(nativeAppSource).toContain('requestSynchronouslyMethod:@"lifecycle.status"');
    expect(brokerContractSource).toContain('ExactKeys(result, @[ @"state", @"epoch" ])');
    for (const prohibited of [
      "LocalRuntimeAdminClient",
      "runtime.token",
      "SqliteMemory",
      "getOrCreateKeychainVaultKey",
      "http://",
      "127.0.0.1",
    ]) {
      expect(nativeLaunchSource).not.toContain(prohibited);
    }
  });

  it("checks recovery readiness before opening Notes plaintext", () => {
    expect(nativeAppSource).toContain('requestMethod:@"recovery.status"');
    expect(brokerContractSource).toContain("IsRecoveryStatusResult");
    expect(nativeAppSource).toContain('segmentedControlWithLabels:@[ @"Notes", @"Connections" ]');
    expect(nativeAppSource).toContain(
      "[self displaySurface:AfternoteProductSurfaceRecovery recoveryReady:YES]",
    );
    expect(nativeAppSource).toContain('requestMethod:@"recovery.migrate"');
    expect(nativeAppSource).toContain('requestMethod:@"recovery.restore"');
    expect(nativeAppSource).toContain("NSOpenPanel");
    expect(nativeAppSource).toContain('liveAction" : @"keep"');
    expect(nativeAppSource).toContain('artifactAction" : @"keep"');
    expect(nativeAppSource).toContain("[self refreshRecoveryStatusAndContinue:YES]");
    const setupConnections = nativeAppSource.slice(
      nativeAppSource.indexOf("- (void)openConnectionsFromSetup:"),
      nativeAppSource.indexOf("- (void)openSetupGuide:"),
    );
    expect(setupConnections).toContain(
      "[self.recoveryState isEqualToString:@\"ready\"]",
    );
    expect(setupConnections).toContain("recoveryReady:recoveryReady");
    expect(setupConnections).toContain(
      "if (resolved == AfternoteProductSurfaceRecovery)",
    );
    expect(setupConnections).toContain("[self refreshRecovery:nil]");
    expect(setupConnections).toContain("[self refreshConnections:nil]");
    expect(setupConnections).not.toContain("[self authenticate:nil]");
  });

  it("recovers bounded broker interruptions without replaying note operations", () => {
    expect(nativeAppSource).toContain('#import "broker_recovery_state.h"');
    expect(nativeAppSource).toContain("brokerDidDisconnect");
    expect(nativeAppSource).toContain("attemptBrokerRecoveryForSequence:");
    expect(nativeAppSource).toContain("if (self.brokerRecoveryInFlight) {");
    expect(nativeAppSource).toContain(
      "attempt:self.brokerRecoveryAttempt\n                                     ready:NO",
    );
    expect(nativeAppSource).toContain("[self.broker replaceConnection]");
    const recovery = nativeAppSource.slice(
      nativeAppSource.indexOf("- (void)brokerDidDisconnect"),
      nativeAppSource.indexOf("- (void)clearRecoveryContent"),
    );
    expect(recovery).toContain('requestMethod:@"recovery.status"');
    expect(recovery).toContain('requestMethod:@"lifecycle.status"');
    expect(recovery).toContain("AfternoteBrokerRecoveryOutcomeForAttempt");
    expect(recovery).not.toContain('requestMethod:@"library.remember"');
    expect(recovery).not.toContain('requestMethod:@"library.update_note"');
    expect(recovery).not.toContain('requestMethod:@"library.delete"');
    expect(recovery).not.toContain("[self authenticate:nil]");
  });
});
