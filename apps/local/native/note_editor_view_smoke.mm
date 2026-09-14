#import "note_editor_view.h"

// Exercise the public editor interface and actual AppKit controls. No app
// delegate, broker, filesystem, or authentication implementation is linked.
NSView *FindEditorControl(NSView *view, NSString *identifier) {
  if ([view.identifier isEqualToString:identifier]) return view;
  for (NSView *child in view.subviews) {
    NSView *found = FindEditorControl(child, identifier);
    if (found != nil) return found;
  }
  return nil;
}

@interface EditorActionProbe : NSObject <AfternoteNoteEditorActions>
@property(nonatomic, strong) NSMutableArray<NSString *> *actions;
@property(nonatomic, strong) NSDictionary *selectedRevision;
@end
@implementation EditorActionProbe
- (instancetype)init {
  self = [super init];
  if (self) _actions = [NSMutableArray array];
  return self;
}
- (void)returnToMemory:(id)sender { [self.actions addObject:@"back"]; }
- (void)saveNote:(id)sender { [self.actions addObject:@"save"]; }
- (void)discardEditorChanges:(id)sender { [self.actions addObject:@"discard"]; }
- (void)confirmDeleteNote:(id)sender { [self.actions addObject:@"delete"]; }
- (void)editCurrentNote:(id)sender { [self.actions addObject:@"edit-current"]; }
- (void)selectEditorRevision:(NSDictionary *)revision {
  self.selectedRevision = revision;
  [self.actions addObject:@"revision"];
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    EditorActionProbe *probe = [EditorActionProbe new];
    AfternoteNoteEditorView *editor = [[AfternoteNoteEditorView alloc] initWithActionTarget:probe];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1120, 820)
                                                 styleMask:NSWindowStyleMaskTitled
                                                   backing:NSBackingStoreBuffered defer:NO];
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    window.contentView = editor;
    NSTextView *text = (NSTextView *)FindEditorControl(editor, @"note-editor-draft");
    NSPopUpButton *history = (NSPopUpButton *)FindEditorControl(editor, @"note-editor-revisions");
    NSButton *(^button)(NSString *) = ^NSButton *(NSString *name) {
      return (NSButton *)FindEditorControl(editor, [@"note-editor-" stringByAppendingString:name]);
    };
    NSButton *save = button(@"saveButton");
    NSButton *discard = button(@"discardChangesButton");
    NSButton *bullet = button(@"bulletListButton");
    NSButton *checklist = button(@"checklistButton");
    NSButton *numbered = button(@"numberedListButton");
    NSButton *remove = button(@"deleteButton");
    NSButton *edit = button(@"editCurrentNoteButton");
    NSMutableDictionary *checks = [NSMutableDictionary dictionary];
    checks[@"empty"] = @(editor.draft.length == 0 && !text.editable && !save.enabled &&
        !editor.hasUnsavedChanges && history.hidden);
    NSDictionary *note = @{
      @"id": @"fixture-note", @"content": @"Saved text", @"revision": @3,
      @"updatedAt": @"2026-09-13T10:00:00.000Z", @"source": @{ @"application": @"Claude Desktop" }
    };
    NSArray *revisions = @[
      @{ @"noteId": @"fixture-note", @"revision": @3, @"createdAt": @"2026-09-13T10:00:00.000Z" },
      @{ @"noteId": @"fixture-note", @"revision": @2, @"createdAt": @"2026-09-12T10:00:00.000Z" },
      @{ @"noteId": @"fixture-note", @"revision": @2, @"createdAt": @"2026-09-12T10:00:00.000Z" },
    ];
    [editor displayNote:note creating:NO inspectingCitation:NO];
    [editor setBusy:NO authenticated:YES];
    [editor focusDraft];
    checks[@"current"] = @([editor.draft isEqualToString:@"Saved text"] && text.editable &&
        !text.richText && !text.importsGraphics && !save.enabled && !discard.enabled &&
        !remove.hidden && edit.hidden && !history.enabled && [save.keyEquivalent isEqualToString:@"s"]);

    [text insertText:@" + draft" replacementRange:NSMakeRange(text.string.length, 0)];
    checks[@"editing"] = @(editor.hasUnsavedChanges && save.enabled && discard.enabled && text.undoManager.canUndo);
    NSString *draft = editor.draft;
    [editor setHistory:revisions hasMore:YES loaded:YES];
    [editor setBusy:YES authenticated:YES];
    [editor setSaveState:AfternoteEditorSaveStateSaving animated:NO];
    [save performClick:nil];
    checks[@"busy"] = @([editor.draft isEqualToString:draft] && !text.editable && !save.enabled &&
        !discard.enabled && !history.enabled && !bullet.enabled && !remove.enabled && probe.actions.count == 0);
    [editor setBusy:NO authenticated:YES];
    [editor setSaveState:AfternoteEditorSaveStateDefault animated:NO];
    checks[@"passiveUpdatesPreserveDraft"] = @([editor.draft isEqualToString:draft] &&
        editor.hasUnsavedChanges && history.enabled && text.undoManager.canUndo);

    [save performClick:nil];
    [discard performClick:nil];
    [remove performClick:nil];
    [button(@"memoryBackButton") performClick:nil];
    checks[@"routes"] = @([probe.actions isEqualToArray:@[@"save", @"discard", @"delete", @"back"]]);
    [editor discardChanges];
    checks[@"discard"] = @([editor.draft isEqualToString:@"Saved text"] &&
        !editor.hasUnsavedChanges && !save.enabled && !discard.enabled && !text.undoManager.canUndo &&
        ![editor discardChanges]);

    [history selectItemAtIndex:1];
    [NSApp sendAction:history.action to:history.target from:history];
    BOOL historical = [probe.selectedRevision[@"revision"] integerValue] == 2;
    [history selectItemAtIndex:2];
    [NSApp sendAction:history.action to:history.target from:history];
    BOOL more = [probe.selectedRevision[@"loadMore"] boolValue] && history.indexOfSelectedItem == 0;
    [NSApp sendAction:history.action to:history.target from:history];
    checks[@"history"] = @(history.numberOfItems == 3 && historical && more && probe.selectedRevision == nil);

    [editor setSaveState:AfternoteEditorSaveStateSaved animated:NO];
    BOOL confirmed = [save.title isEqualToString:@"Saved locally"] && save.image != nil;
    [text insertText:@"!" replacementRange:NSMakeRange(text.string.length, 0)];
    checks[@"saveFeedback"] = @(confirmed && [save.title isEqualToString:@"Save changes"] &&
        save.image == nil && save.enabled);
    [editor displayNote:@{ @"noteId": @"fixture-note", @"revision": @2, @"content": @"Historical text" }
              creating:NO inspectingCitation:YES];
    checks[@"citation"] = @(!text.editable && save.hidden && discard.hidden && remove.hidden &&
        !edit.hidden && edit.enabled && !history.hidden && history.enabled &&
        history.indexOfSelectedItem == 1 && !text.undoManager.canUndo);
    [edit performClick:nil];
    checks[@"editCurrentRoute"] = @([probe.actions.lastObject isEqualToString:@"edit-current"]);

    [editor displayNote:@{ @"content": @"" } creating:YES inspectingCitation:NO];
    checks[@"newNote"] = @(text.editable && !editor.hasUnsavedChanges && !save.enabled &&
        remove.hidden && history.hidden);
    [editor restoreDraft:@"List item"];
    text.selectedRange = NSMakeRange(0, text.string.length);
    [bullet performClick:nil];
    BOOL bulletApplied = [editor.draft isEqualToString:@"- List item"];
    text.selectedRange = NSMakeRange(text.string.length, 0);
    BOOL continued = [text.delegate textView:text doCommandBySelector:@selector(insertNewline:)];
    BOOL continuedText = [editor.draft isEqualToString:@"- List item\n- "];
    [editor restoreDraft:@"Task"];
    text.selectedRange = NSMakeRange(0, text.string.length);
    [checklist performClick:nil];
    BOOL checklistApplied = [editor.draft isEqualToString:@"☐ Task"];
    [editor restoreDraft:@"Step"];
    text.selectedRange = NSMakeRange(0, text.string.length);
    [numbered performClick:nil];
    checks[@"formatting"] = @(bulletApplied && continued && continuedText && checklistApplied &&
        [editor.draft isEqualToString:@"1. Step"] && save.enabled);

    // Conflict rebasing is an explicit note snapshot followed by draft restore.
    [editor displayNote:note creating:NO inspectingCitation:NO];
    [editor restoreDraft:@"Preserved conflict draft"];
    [editor setHistory:revisions hasMore:NO loaded:YES];
    checks[@"conflictDraft"] = @([editor.draft isEqualToString:@"Preserved conflict draft"] && editor.hasUnsavedChanges);
    [editor discardChanges];
    checks[@"conflictBaseline"] = @([editor.draft isEqualToString:note[@"content"]]);

    [text insertText:@" old draft" replacementRange:NSMakeRange(0, 0)];
    [editor displayNote:@{ @"id": @"other-note", @"revision": @1, @"content": @"Other note" }
              creating:NO inspectingCitation:NO];
    checks[@"noteIsolation"] = @([editor.draft isEqualToString:@"Other note"] &&
        !text.undoManager.canUndo && !editor.hasUnsavedChanges && history.numberOfItems == 1 &&
        !history.enabled);

    [text insertText:@" sensitive" replacementRange:NSMakeRange(0, 0)];
    BOOL hadUndo = text.undoManager.canUndo;
    [editor clearPlaintext];
    // Undo and discard must not resurrect either the draft or its saved baseline.
    if (text.undoManager.canUndo) [text.undoManager undo];
    [editor discardChanges];
    checks[@"plaintextCleared"] = @(hadUndo && editor.draft.length == 0 && !text.undoManager.canUndo &&
        !text.editable && !editor.hasUnsavedChanges && !save.enabled && history.numberOfItems == 1 &&
        !history.enabled && history.hidden);
    [editor setBusy:NO authenticated:YES];
    checks[@"reauthDoesNotRestorePlaintext"] = @(editor.draft.length == 0 && !text.editable && !save.enabled);

    __weak EditorActionProbe *weakProbe;
    AfternoteNoteEditorView *retainedEditor;
    @autoreleasepool {
      EditorActionProbe *temporary = [EditorActionProbe new];
      weakProbe = temporary;
      retainedEditor = [[AfternoteNoteEditorView alloc] initWithActionTarget:temporary];
    }
    checks[@"weakTarget"] = @(weakProbe == nil && retainedEditor != nil);

    [editor displayNote:note creating:NO inspectingCitation:NO];
    [editor setHistory:revisions hasMore:NO loaded:YES];
    BOOL layout = YES;
    for (NSNumber *width in @[@900, @1120, @1600]) {
      [window setContentSize:NSMakeSize(width.doubleValue, 820)];
      [editor layoutSubtreeIfNeeded];
      NSRect draftFrame = [text convertRect:text.bounds toView:editor];
      layout = layout && !editor.hasAmbiguousLayout && draftFrame.size.width > 500 &&
          draftFrame.origin.x >= 32 && NSMaxX(draftFrame) <= editor.bounds.size.width - 32;
    }
    checks[@"layout"] = @(layout);
    if (argc == 2) {
      [window setContentSize:NSMakeSize(1120, 820)];
      [editor layoutSubtreeIfNeeded];
      NSBitmapImageRep *bitmap = [editor bitmapImageRepForCachingDisplayInRect:editor.bounds];
      [editor cacheDisplayInRect:editor.bounds toBitmapImageRep:bitmap];
      [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
          writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES];
    }
    NSData *output = [NSJSONSerialization dataWithJSONObject:checks options:NSJSONWritingSortedKeys error:nil];
    fwrite(output.bytes, 1, output.length, stdout);
    fputc('\n', stdout);
    for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
    return 0;
  }
}
