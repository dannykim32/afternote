#import "note_editor_view.h"
#import "native_appearance.h"
#import "plain_text_list_formatting.h"

namespace {
NSString *StringValue(id value) { return [value isKindOfClass:NSString.class] ? value : @""; }
}

@interface AfternoteNoteTextView : NSTextView
@end

@implementation AfternoteNoteTextView

- (void)mouseDown:(NSEvent *)event {
  if (!self.editable || self.string.length == 0 || self.layoutManager == nil ||
      self.textContainer == nil) {
    [super mouseDown:event];
    return;
  }
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  NSPoint containerPoint = NSMakePoint(point.x - self.textContainerOrigin.x,
                                       point.y - self.textContainerOrigin.y);
  CGFloat fraction = 0;
  NSUInteger glyphIndex = [self.layoutManager glyphIndexForPoint:containerPoint
                                                  inTextContainer:self.textContainer
                                   fractionOfDistanceThroughGlyph:&fraction];
  if (glyphIndex >= self.layoutManager.numberOfGlyphs) {
    [super mouseDown:event];
    return;
  }
  NSUInteger characterIndex = [self.layoutManager characterIndexForGlyphAtIndex:glyphIndex];
  if (characterIndex >= self.string.length) {
    [super mouseDown:event];
    return;
  }
  NSRange lineRange = [self.string lineRangeForRange:NSMakeRange(characterIndex, 0)];
  NSUInteger markerIndex = lineRange.location;
  while (markerIndex < NSMaxRange(lineRange)) {
    unichar character = [self.string characterAtIndex:markerIndex];
    if (character != ' ' && character != '\t') break;
    markerIndex += 1;
  }
  if (markerIndex >= self.string.length) {
    [super mouseDown:event];
    return;
  }
  unichar marker = [self.string characterAtIndex:markerIndex];
  if (marker != 0x2610 && marker != 0x2611) {
    [super mouseDown:event];
    return;
  }
  NSRange glyphRange = [self.layoutManager glyphRangeForCharacterRange:NSMakeRange(markerIndex, 1)
                                                   actualCharacterRange:nullptr];
  NSRect markerRect = [self.layoutManager boundingRectForGlyphRange:glyphRange
                                                    inTextContainer:self.textContainer];
  markerRect.origin.x += self.textContainerOrigin.x;
  markerRect.origin.y += self.textContainerOrigin.y;
  markerRect = NSInsetRect(markerRect, -5, -4);
  if (!NSPointInRect(point, markerRect)) {
    [super mouseDown:event];
    return;
  }
  NSString *replacement = marker == 0x2610 ? @"☑" : @"☐";
  if ([self shouldChangeTextInRange:NSMakeRange(markerIndex, 1)
                  replacementString:replacement]) {
    [self.textStorage replaceCharactersInRange:NSMakeRange(markerIndex, 1)
                                     withString:replacement];
    [self didChangeText];
  }
}

@end


@interface AfternoteNoteEditorView () <NSTextViewDelegate>
@property(nonatomic, strong) NSTextView *noteEditor;
@property(nonatomic, strong) NSButton *memoryBackButton;
@property(nonatomic, strong) NSButton *checklistButton;
@property(nonatomic, strong) NSButton *bulletListButton;
@property(nonatomic, strong) NSButton *numberedListButton;
@property(nonatomic, strong) NSTextField *sourceLabel;
@property(nonatomic, strong) NSTextField *revisionLabel;
@property(nonatomic, strong) NSPopUpButton *revisionMenu;
@property(nonatomic, strong) NSButton *saveButton;
@property(nonatomic, strong) NSButton *discardChangesButton;
@property(nonatomic, strong) NSButton *deleteButton;
@property(nonatomic, strong) NSButton *editCurrentNoteButton;
@property(nonatomic) AfternoteEditorSaveState editorSaveState;
@property(nonatomic, weak) id<AfternoteNoteEditorActions> actionTarget;
@property(nonatomic, copy) NSDictionary *activeNote;
@property(nonatomic, copy) NSArray<NSDictionary *> *revisionSummaries;
@property(nonatomic) BOOL creatingNote;
@property(nonatomic) BOOL inspectingCitation;
@property(nonatomic) BOOL revisionHistoryLoaded;
@property(nonatomic) BOOL hasMoreRevisions;
@property(nonatomic) BOOL busy;
@property(nonatomic) BOOL authenticated;
@end

@implementation AfternoteNoteEditorView
- (instancetype)initWithActionTarget:(id<AfternoteNoteEditorActions>)target {
  self = [super initWithFrame:NSZeroRect];
  if (self) {
    _actionTarget = target;
    _revisionSummaries = @[];
    [self buildEditor];
    [self clearPlaintext];
  }
  return self;
}
- (void)buildEditor {
  self.revisionLabel = AfternoteLabel(@"Choose a note", 12, NSFontWeightSemibold);
  self.revisionLabel.textColor = AfternoteMutedTextColor();
  self.sourceLabel = AfternoteLabel(@"The note and its source will appear here."
                                 , 13, NSFontWeightRegular);
  self.sourceLabel.textColor = AfternoteMutedTextColor();
  NSScrollView *editorScroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 720, 480)];
  NSSize editorContentSize = editorScroll.contentSize;
  self.noteEditor = [[AfternoteNoteTextView alloc]
      initWithFrame:NSMakeRect(0, 0, editorContentSize.width, editorContentSize.height)];
  self.noteEditor.minSize = NSMakeSize(0, editorContentSize.height);
  self.noteEditor.maxSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
  self.noteEditor.verticallyResizable = YES;
  self.noteEditor.horizontallyResizable = NO;
  self.noteEditor.autoresizingMask = NSViewWidthSizable;
  self.noteEditor.textContainer.containerSize = NSMakeSize(editorContentSize.width, CGFLOAT_MAX);
  self.noteEditor.textContainer.widthTracksTextView = YES;
  self.noteEditor.textContainerInset = NSMakeSize(8, 16);
  self.noteEditor.richText = NO;
  self.noteEditor.importsGraphics = NO;
  self.noteEditor.allowsImageEditing = NO;
  self.noteEditor.automaticQuoteSubstitutionEnabled = NO;
  self.noteEditor.automaticDashSubstitutionEnabled = NO;
  self.noteEditor.automaticTextReplacementEnabled = NO;
  self.noteEditor.delegate = self;
  self.noteEditor.accessibilityLabel = @"Note text";
  self.noteEditor.identifier = @"note-editor-draft";
  self.noteEditor.allowsUndo = YES;
  [self applyEditorTheme];
  editorScroll.documentView = self.noteEditor;
  editorScroll.hasVerticalScroller = YES;
  editorScroll.borderType = NSNoBorder;
  editorScroll.drawsBackground = NO;
  self.revisionMenu = [[NSPopUpButton alloc] init];
  self.revisionMenu.target = self;
  self.revisionMenu.action = @selector(selectRevision:);
  self.revisionMenu.identifier = @"note-editor-revisions";
  self.revisionMenu.accessibilityLabel = @"Revision history";
  AfternoteStyleSecondaryButton(self.revisionMenu);
  NSImage *backImage = [NSImage imageWithSystemSymbolName:@"chevron.left"
                                 accessibilityDescription:@"Back to Notes"];
  self.memoryBackButton = [AfternoteButton buttonWithTitle:@"Notes"
                                                   target:self
                                                   action:@selector(returnToMemory:)];
  self.memoryBackButton.image = backImage;
  self.memoryBackButton.imagePosition = NSImageLeft;
  self.memoryBackButton.imageHugsTitle = YES;
  self.memoryBackButton.bordered = NO;
  self.memoryBackButton.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  self.memoryBackButton.contentTintColor = AfternoteAccentColor();
  self.memoryBackButton.accessibilityLabel = @"Back to Notes";
  NSImageSymbolConfiguration *formatSymbolConfiguration =
      [NSImageSymbolConfiguration configurationWithPointSize:14 weight:NSFontWeightRegular];
  NSImage *checklistImage = [[NSImage imageWithSystemSymbolName:@"checklist"
                                      accessibilityDescription:@"Checklist"]
      imageWithSymbolConfiguration:formatSymbolConfiguration];
  self.checklistButton = [AfternoteButton buttonWithImage:checklistImage
                                                   target:self
                                                   action:@selector(toggleChecklist:)];
  AfternoteStyleToolButton(self.checklistButton);
  self.checklistButton.keyEquivalent = @"9";
  self.checklistButton.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  self.checklistButton.toolTip = @"Checklist (Command-Shift-9)";
  self.checklistButton.accessibilityLabel = @"Toggle checklist";
  NSImage *bulletImage = [[NSImage imageWithSystemSymbolName:@"list.bullet"
                                   accessibilityDescription:@"Bullet list"]
      imageWithSymbolConfiguration:formatSymbolConfiguration];
  self.bulletListButton = [AfternoteButton buttonWithImage:bulletImage
                                                    target:self
                                                    action:@selector(toggleBulletList:)];
  AfternoteStyleToolButton(self.bulletListButton);
  self.bulletListButton.keyEquivalent = @"8";
  self.bulletListButton.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  self.bulletListButton.toolTip = @"Bullet list (Command-Shift-8)";
  self.bulletListButton.accessibilityLabel = @"Toggle bullet list";
  NSImage *numberedImage = [[NSImage imageWithSystemSymbolName:@"list.number"
                                     accessibilityDescription:@"Numbered list"]
      imageWithSymbolConfiguration:formatSymbolConfiguration];
  self.numberedListButton = [AfternoteButton buttonWithImage:numberedImage
                                                      target:self
                                                      action:@selector(toggleNumberedList:)];
  AfternoteStyleToolButton(self.numberedListButton);
  self.numberedListButton.keyEquivalent = @"7";
  self.numberedListButton.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  self.numberedListButton.toolTip = @"Numbered list (Command-Shift-7)";
  self.numberedListButton.accessibilityLabel = @"Toggle numbered list";
  NSStackView *formatting = [NSStackView stackViewWithViews:@[
    self.checklistButton, self.bulletListButton, self.numberedListButton
  ]];
  formatting.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  formatting.alignment = NSLayoutAttributeCenterY;
  formatting.spacing = 4;
  for (NSButton *button in @[
         self.checklistButton, self.bulletListButton, self.numberedListButton
       ]) {
    [button.widthAnchor constraintEqualToConstant:28].active = YES;
    [button.heightAnchor constraintEqualToConstant:28].active = YES;
  }
  NSStackView *formattingBar = [NSStackView stackViewWithViews:@[
    formatting, [NSView new]
  ]];
  formattingBar.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  formattingBar.alignment = NSLayoutAttributeCenterY;
  formattingBar.edgeInsets = NSEdgeInsetsMake(0, 12, 0, 12);
  NSStackView *editorSurface = [NSStackView stackViewWithViews:@[
    formattingBar, editorScroll
  ]];
  editorSurface.orientation = NSUserInterfaceLayoutOrientationVertical;
  editorSurface.alignment = NSLayoutAttributeLeading;
  editorSurface.spacing = 8;
  StyleSurface(editorSurface, AfternoteCanvasColor());
  [formattingBar.widthAnchor constraintEqualToAnchor:editorSurface.widthAnchor].active = YES;
  [editorScroll.widthAnchor constraintEqualToAnchor:editorSurface.widthAnchor].active = YES;
  self.saveButton = [AfternoteButton buttonWithTitle:@"Save changes" target:self action:@selector(saveNote:)];
  AfternoteStylePrimaryButton(self.saveButton);
  self.saveButton.keyEquivalent = @"s";
  self.saveButton.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  [self.saveButton.widthAnchor constraintEqualToConstant:132].active = YES;
  self.discardChangesButton = [AfternoteButton buttonWithTitle:@"Discard changes"
                                                         target:self
                                                         action:@selector(discardEditorChanges:)];
  AfternoteStyleSecondaryButton(self.discardChangesButton);
  self.discardChangesButton.accessibilityLabel = @"Discard unsaved note changes";
  self.deleteButton = [AfternoteButton buttonWithTitle:@"Delete permanently" target:self action:@selector(confirmDeleteNote:)];
  AfternoteStyleDestructiveButton(self.deleteButton);
  self.editCurrentNoteButton = [AfternoteButton buttonWithTitle:@"Edit current note"
                                                          target:self
                                                          action:@selector(editCurrentNote:)];
  AfternoteStyleSecondaryButton(self.editCurrentNoteButton);
  self.editCurrentNoteButton.hidden = YES;
  NSStackView *actions = [NSStackView stackViewWithViews:@[
    self.revisionMenu, [NSView new], self.editCurrentNoteButton,
    self.deleteButton, self.discardChangesButton, self.saveButton
  ]];
  actions.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  actions.alignment = NSLayoutAttributeCenterY;
  actions.spacing = 10;
  NSStackView *editorHeading = [NSStackView stackViewWithViews:@[
    self.memoryBackButton, [NSView new], self.revisionLabel
  ]];
  editorHeading.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  editorHeading.alignment = NSLayoutAttributeCenterY;
  NSStackView *detail = [NSStackView stackViewWithViews:@[
    editorHeading, self.sourceLabel, editorSurface, actions
  ]];
  detail.orientation = NSUserInterfaceLayoutOrientationVertical;
  detail.alignment = NSLayoutAttributeLeading;
  detail.spacing = 12;
  detail.edgeInsets = NSEdgeInsetsMake(38, 0, 28, 0);
  StyleSurface(detail, AfternoteCanvasColor());

  NSView *writeWorkspace = self;
  StyleSurface(writeWorkspace, AfternoteCanvasColor());
  detail.translatesAutoresizingMaskIntoConstraints = NO;
  [writeWorkspace addSubview:detail];
  [NSLayoutConstraint activateConstraints:@[
    [detail.leadingAnchor constraintGreaterThanOrEqualToAnchor:writeWorkspace.leadingAnchor constant:32],
    [detail.trailingAnchor constraintLessThanOrEqualToAnchor:writeWorkspace.trailingAnchor constant:-32],
    [detail.centerXAnchor constraintEqualToAnchor:writeWorkspace.centerXAnchor],
    [detail.topAnchor constraintEqualToAnchor:writeWorkspace.topAnchor],
    [detail.bottomAnchor constraintEqualToAnchor:writeWorkspace.bottomAnchor],
    [detail.widthAnchor constraintLessThanOrEqualToConstant:760],
    [detail.widthAnchor constraintGreaterThanOrEqualToConstant:600],
    [editorHeading.widthAnchor constraintEqualToAnchor:detail.widthAnchor],
    [editorSurface.widthAnchor constraintEqualToAnchor:detail.widthAnchor],
    [actions.widthAnchor constraintEqualToAnchor:detail.widthAnchor],
  ]];

  self.memoryBackButton.identifier = @"note-editor-memoryBackButton";
  self.checklistButton.identifier = @"note-editor-checklistButton";
  self.bulletListButton.identifier = @"note-editor-bulletListButton";
  self.numberedListButton.identifier = @"note-editor-numberedListButton";
  self.saveButton.identifier = @"note-editor-saveButton";
  self.discardChangesButton.identifier = @"note-editor-discardChangesButton";
  self.deleteButton.identifier = @"note-editor-deleteButton";
  self.editCurrentNoteButton.identifier = @"note-editor-editCurrentNoteButton";
}

- (void)applyEditorTheme {
  if (self.noteEditor == nil) return;
  NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
  paragraph.lineSpacing = 4;
  paragraph.paragraphSpacing = 7;
  NSDictionary *typingAttributes = @{
    NSFontAttributeName : [NSFont systemFontOfSize:17 weight:NSFontWeightRegular],
    NSForegroundColorAttributeName : AfternoteTextColor(),
    NSParagraphStyleAttributeName : paragraph,
  };
  self.noteEditor.typingAttributes = typingAttributes;
  self.noteEditor.font = typingAttributes[NSFontAttributeName];
  self.noteEditor.textColor = AfternoteTextColor();
  self.noteEditor.backgroundColor = AfternoteCanvasColor();
  self.noteEditor.insertionPointColor = AfternoteBrandCaptureColor();
  if (self.noteEditor.textStorage.length > 0) {
    [self.noteEditor.textStorage addAttributes:typingAttributes
                                         range:NSMakeRange(0, self.noteEditor.textStorage.length)];
  }
}

- (void)renderRevisionMenu {
  [self.revisionMenu removeAllItems];
  [self.revisionMenu addItemWithTitle:self.creatingNote ? @"New note" : @"Current revision"];
  for (NSDictionary *revision in AfternoteHistoricalRevisionRows(
           self.activeNote ?: @{}, self.revisionSummaries ?: @[])) {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:
        [NSString stringWithFormat:@"Revision %@ · %@", revision[@"revision"] ?: @0,
                                   DateLabel(revision[@"createdAt"])]
                                             action:nil keyEquivalent:@""];
    item.representedObject = revision;
    [self.revisionMenu.menu addItem:item];
  }
  if (self.hasMoreRevisions) {
    NSMenuItem *more = [[NSMenuItem alloc] initWithTitle:@"More revisions available…"
                                                 action:nil keyEquivalent:@""];
    more.representedObject = @{ @"loadMore" : @YES };
    [self.revisionMenu.menu addItem:more];
  }
  if (self.inspectingCitation) {
    NSInteger displayedRevision = [self.activeNote[@"revision"] integerValue];
    for (NSMenuItem *item in self.revisionMenu.itemArray) {
      NSDictionary *revision = [item.representedObject isKindOfClass:[NSDictionary class]]
          ? item.representedObject
          : nil;
      if ([revision[@"revision"] integerValue] == displayedRevision) {
        [self.revisionMenu selectItem:item];
        break;
      }
    }
  }
}

- (void)renderActiveNote {
  if (self.activeNote == nil && !self.creatingNote) {
    [self setSaveState:AfternoteEditorSaveStateDefault animated:NO];
    self.noteEditor.string = @"";
    self.revisionLabel.stringValue = @"Choose a note";
    self.sourceLabel.stringValue = @"The note and its source will appear here.";
    [self applyEditorTheme];
    self.deleteButton.hidden = YES;
    self.discardChangesButton.hidden = YES;
    self.editCurrentNoteButton.hidden = YES;
    self.saveButton.hidden = NO;
    self.revisionMenu.hidden = YES;
    [self updateControls];
    return;
  }
  self.noteEditor.string = StringValue(self.activeNote[@"content"]);
  self.noteEditor.selectedRange = NSMakeRange(0, 0);
  [self applyEditorTheme];
  BOOL isCurrentRevision = [self.activeNote[@"id"] isKindOfClass:[NSString class]];
  self.revisionLabel.stringValue = self.inspectingCitation
      ? [NSString stringWithFormat:@"Cited result · Revision %@",
           self.activeNote[@"revision"] ?: @0]
      : (self.creatingNote
          ? @"New note"
          : [NSString stringWithFormat:@"Revision %@ · updated %@",
             self.activeNote[@"revision"] ?: @0,
             DateLabel(self.activeNote[@"updatedAt"] ?: self.activeNote[@"createdAt"])]);
  NSDictionary *source = [self.activeNote[@"source"] isKindOfClass:[NSDictionary class]] ? self.activeNote[@"source"] : @{};
  NSMutableArray<NSString *> *parts = [NSMutableArray array];
  for (NSString *key in @[ @"label", @"application", @"author", @"url", @"timestamp" ]) {
    NSString *value = StringValue(source[key]);
    if (value.length > 0) [parts addObject:value];
  }
  self.sourceLabel.stringValue = parts.count > 0
      ? [parts componentsJoinedByString:@" · "]
      : @"Saved locally · No source attached";
  self.saveButton.hidden = self.inspectingCitation;
  self.editCurrentNoteButton.hidden = !self.inspectingCitation;
  self.discardChangesButton.hidden = self.inspectingCitation;
  self.deleteButton.hidden = self.inspectingCitation || self.creatingNote ||
      !isCurrentRevision;
  self.revisionMenu.hidden = self.creatingNote;
  [self updateControls];
}

- (void)applyListTransform:(AfternoteListTransform *)updated
                toTextView:(NSTextView *)textView {
  if (updated == nil) return;
  NSString *text = updated.text;
  NSRange selection = updated.selection;
  if (![text isEqualToString:textView.string]) {
    [textView insertText:text
         replacementRange:NSMakeRange(0, textView.string.length)];
    [self applyEditorTheme];
  }
  textView.selectedRange = selection;
  [textView.window makeFirstResponder:textView];
}

- (void)applyListStyle:(AfternoteListStyle)style {
  if (!self.noteEditor.editable) return;
  [self applyListTransform:AfternoteToggleList(
      self.noteEditor.string, self.noteEditor.selectedRange, style)
                toTextView:self.noteEditor];
}

- (void)toggleBulletList:(id)sender {
  (void)sender;
  [self applyListStyle:AfternoteListStyleBullet];
}

- (void)toggleChecklist:(id)sender {
  (void)sender;
  [self applyListStyle:AfternoteListStyleChecklist];
}

- (void)toggleNumberedList:(id)sender {
  (void)sender;
  [self applyListStyle:AfternoteListStyleNumbered];
}

- (BOOL)textView:(NSTextView *)textView doCommandBySelector:(SEL)commandSelector {
  if (textView != self.noteEditor) return NO;
  if (commandSelector == @selector(insertNewline:)) {
    AfternoteListContinuation *continuation =
        AfternoteContinueList(textView.string, textView.selectedRange);
    if (continuation == nil) return NO;
    [textView insertText:continuation.replacement replacementRange:continuation.range];
    return YES;
  }
  BOOL outdent = commandSelector == @selector(insertBacktab:);
  if (!outdent && commandSelector != @selector(insertTab:)) return NO;
  AfternoteListTransform *updated =
      AfternoteIndentList(textView.string, textView.selectedRange, outdent);
  if (updated == nil) return NO;
  [self applyListTransform:updated toTextView:textView];
  return YES;
}

- (void)setSaveState:(AfternoteEditorSaveState)state
                         animated:(BOOL)animated {
  self.editorSaveState = state;
  AfternoteEditorSavePresentation *presentation =
      AfternoteEditorSavePresentationForState(state);
  AfternoteButton *button = (AfternoteButton *)self.saveButton;
  button.image = nil;
  button.imagePosition = NSNoImage;
  if (presentation.showsSavedConfirmation) {
    NSImageSymbolConfiguration *configuration =
        [NSImageSymbolConfiguration configurationWithPointSize:12
                                                        weight:NSFontWeightSemibold];
    button.image = [[NSImage imageWithSystemSymbolName:@"checkmark"
                              accessibilityDescription:@"Saved"]
        imageWithSymbolConfiguration:configuration];
    button.imagePosition = NSImageLeft;
    button.imageHugsTitle = YES;
    button.title = presentation.title;
    button.contentTintColor = AfternoteCanvasColor();
    button.afternoteFillColor = StatusColor(@"success");
    button.afternoteHoverColor = [StatusColor(@"success")
        blendedColorWithFraction:0.08 ofColor:NSColor.whiteColor];
    button.afternotePressedColor = [StatusColor(@"success")
        blendedColorWithFraction:0.10 ofColor:NSColor.blackColor];
    button.afternoteBorderColor = nil;
    button.accessibilityLabel = presentation.accessibilityLabel;
  } else {
    button.title = presentation.title;
    button.accessibilityLabel = presentation.accessibilityLabel;
    AfternoteStylePrimaryButton(button);
  }
  [button invalidateIntrinsicContentSize];
  [button setNeedsDisplay:YES];
  if (animated && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
    button.alphaValue = 0.72;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.14;
      button.animator.alphaValue = 1;
    } completionHandler:nil];
  } else {
    button.alphaValue = 1;
  }
}


- (NSString *)draft { return self.noteEditor.string ?: @""; }
- (BOOL)hasUnsavedChanges {
  return !self.inspectingCitation && (self.activeNote != nil || self.creatingNote) &&
      AfternoteEditorHasUnsavedChanges(self.activeNote ?: @{}, self.draft, self.creatingNote);
}
- (void)displayNote:(NSDictionary *)note creating:(BOOL)creating
 inspectingCitation:(BOOL)inspectingCitation {
  NSString *previousId = StringValue(self.activeNote[@"id"] ?: self.activeNote[@"noteId"]);
  NSString *nextId = StringValue(note[@"id"] ?: note[@"noteId"]);
  if (![previousId isEqualToString:nextId] || creating != self.creatingNote || note == nil) {
    self.revisionSummaries = @[];
    self.hasMoreRevisions = NO;
    self.revisionHistoryLoaded = NO;
  }
  self.activeNote = [note copy];
  self.creatingNote = creating;
  self.inspectingCitation = inspectingCitation;
  [self.noteEditor.undoManager removeAllActions];
  [self renderActiveNote];
  [self renderRevisionMenu];
}
- (void)setHistory:(NSArray<NSDictionary *> *)revisions hasMore:(BOOL)hasMore loaded:(BOOL)loaded {
  self.revisionSummaries = [revisions copy];
  self.hasMoreRevisions = hasMore;
  self.revisionHistoryLoaded = loaded;
  [self renderRevisionMenu];
  [self updateControls];
}
- (void)setBusy:(BOOL)busy authenticated:(BOOL)authenticated {
  self.busy = busy;
  self.authenticated = authenticated;
  [self updateControls];
}
- (void)updateControls {
  BOOL available = !self.busy && self.authenticated;
  BOOL current = [self.activeNote[@"id"] isKindOfClass:NSString.class];
  self.noteEditor.editable = available && !self.inspectingCitation && (self.creatingNote || current);
  self.saveButton.enabled = self.noteEditor.editable && self.hasUnsavedChanges;
  self.discardChangesButton.enabled = self.saveButton.enabled;
  self.deleteButton.enabled = available && !self.inspectingCitation && !self.creatingNote && current;
  self.editCurrentNoteButton.enabled = available && self.inspectingCitation;
  self.memoryBackButton.enabled = !self.busy;
  self.revisionMenu.enabled = available && self.revisionHistoryLoaded && !self.creatingNote;
  for (NSButton *button in @[self.checklistButton, self.bulletListButton, self.numberedListButton]) {
    button.enabled = self.noteEditor.editable;
  }
}
- (void)restoreDraft:(NSString *)draft {
  self.noteEditor.string = draft;
  [self.noteEditor.undoManager removeAllActions];
  [self applyEditorTheme];
  [self setSaveState:AfternoteEditorSaveStateDefault animated:NO];
  [self updateControls];
}
- (BOOL)discardChanges {
  if (!self.hasUnsavedChanges || self.busy) return NO;
  [self restoreDraft:StringValue(self.activeNote[@"content"])];
  return YES;
}
- (void)focusDraft { [self.window makeFirstResponder:self.noteEditor]; }
- (void)clearPlaintext {
  self.activeNote = nil;
  self.creatingNote = NO;
  self.inspectingCitation = NO;
  self.revisionSummaries = @[];
  self.hasMoreRevisions = NO;
  self.revisionHistoryLoaded = NO;
  self.authenticated = NO;
  self.busy = NO;
  [self.noteEditor.undoManager removeAllActions];
  [self renderActiveNote];
  [self renderRevisionMenu];
}
- (void)textDidChange:(NSNotification *)notification {
  if (notification.object != self.noteEditor) return;
  if (self.editorSaveState == AfternoteEditorSaveStateSaved) {
    [self setSaveState:AfternoteEditorSaveStateDefault animated:YES];
  }
  [self updateControls];
}
- (void)selectRevision:(NSPopUpButton *)sender {
  if (!sender.enabled) return;
  NSDictionary *revision = [sender.selectedItem.representedObject isKindOfClass:NSDictionary.class]
      ? sender.selectedItem.representedObject : nil;
  if ([revision[@"loadMore"] boolValue]) [sender selectItemAtIndex:0];
  [self.actionTarget selectEditorRevision:revision];
}
- (void)returnToMemory:(id)sender {
  (void)sender;
  if (self.memoryBackButton.enabled && !self.memoryBackButton.hidden) [self.actionTarget returnToMemory:self];
}
- (void)saveNote:(id)sender {
  (void)sender;
  if (self.saveButton.enabled && !self.saveButton.hidden) [self.actionTarget saveNote:self];
}
- (void)discardEditorChanges:(id)sender {
  (void)sender;
  if (self.discardChangesButton.enabled && !self.discardChangesButton.hidden) [self.actionTarget discardEditorChanges:self];
}
- (void)confirmDeleteNote:(id)sender {
  (void)sender;
  if (self.deleteButton.enabled && !self.deleteButton.hidden) [self.actionTarget confirmDeleteNote:self];
}
- (void)editCurrentNote:(id)sender {
  (void)sender;
  if (self.editCurrentNoteButton.enabled && !self.editCurrentNoteButton.hidden) [self.actionTarget editCurrentNote:self];
}

@end
