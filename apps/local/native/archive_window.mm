#import "archive_window.h"
#import "archive_import.h"
#import "native_appearance.h"
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

// Operate/Read extension of the existing dark AppKit Notes surface: system type,
// Capture Teal actions, aligned toolbars, a bounded transcript list and plain-text
// reader. Import is explicit; paused work is visible; lock clears every page.
@interface ArchiveImportToken : NSObject
@property(atomic) BOOL cancelled;
@end
@implementation ArchiveImportToken
@end

// NSScrollView's clip view changes independently of the text container during
// Auto Layout. Keep the plain-text measure tied to the visible page, not the
// initial text-view frame, so long transcript lines wrap at every window size.
@interface ArchiveReadingScrollView : NSScrollView
@end
@implementation ArchiveReadingScrollView
- (void)layout {
  [super layout];
  NSTextView *text = (NSTextView *)self.documentView;
  if (![text isKindOfClass:NSTextView.class]) return;
  CGFloat width = self.contentSize.width;
  [text setFrameSize:NSMakeSize(width, MAX(self.contentSize.height, text.frame.size.height))];
  text.textContainer.containerSize = NSMakeSize(MAX(1, width - 2 * text.textContainerInset.width), CGFLOAT_MAX);
  [text.layoutManager ensureLayoutForTextContainer:text.textContainer];
}
@end

@interface AfternoteArchiveWindow () <NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate>
@property(nonatomic) BOOL authenticated;
@property(nonatomic) NSUInteger generation;
@property(nonatomic) BOOL importing;
@property(nonatomic) BOOL loading;
@property(nonatomic, strong) ArchiveImportToken *importToken;
@property(nonatomic, strong) NSTextField *status;
@property(nonatomic, strong) NSSearchField *query;
@property(nonatomic, strong) NSTableView *table;
@property(nonatomic, strong) NSTextView *reader;
@property(nonatomic, strong) NSTextField *pageLabel;
@property(nonatomic, strong) NSSegmentedControl *mode;
@property(nonatomic, strong) NSArray<NSDictionary *> *rows;
@property(nonatomic, strong) NSDictionary *selected;
@property(nonatomic, copy) NSString *cursor;
@property(nonatomic, copy) NSString *archiveId;
@property(nonatomic) NSUInteger pageStart;
@property(nonatomic, strong) NSNumber *nextIndex;
@property(nonatomic, strong) NSButton *importButton;
@property(nonatomic, strong) NSButton *pauseButton;
@property(nonatomic, strong) NSButton *resumeButton;
@property(nonatomic, strong) NSButton *deleteButton;
@property(nonatomic, strong) NSButton *nextPage;
@property(nonatomic, strong) NSButton *previousPage;
@property(nonatomic, strong) NSButton *more;
@property(nonatomic, strong) NSButton *authenticateButton;
@end

@implementation AfternoteArchiveWindow
- (instancetype)init {
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 980, 720)
      styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
      backing:NSBackingStoreBuffered defer:NO];
  self = [super initWithWindow:window];
  if (!self) return nil;
  window.title = @"Conversation Archives";
  window.minSize = NSMakeSize(820, 600);
  window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
  window.backgroundColor = AfternoteCanvasColor();
  window.restorable = NO;
  window.delegate = self;
  [window center];
  self.rows = @[];
  NSView *root = window.contentView;
  NSTextField *heading = AfternoteLabel(@"Conversation Archives", 26, NSFontWeightSemibold);
  NSTextField *description = AfternoteLabel(@"Import a transcript you choose. Read it here, or approve a connector to retrieve passages.", 12, NSFontWeightRegular);
  description.textColor = AfternoteMutedTextColor();
  self.importButton = [self button:@"Import transcript…" action:@selector(importFile:)];
  self.pauseButton = [self button:@"Pause import" action:@selector(pauseImport:)];
  self.pauseButton.hidden = YES;
  NSButton *open = [self button:@"Authenticate" action:@selector(authenticateClicked:)];
  self.authenticateButton = open;
  self.status = AfternoteLabel(@"Authenticate to open Archives.", 12, NSFontWeightRegular);
  self.status.textColor = AfternoteMutedTextColor();
  self.status.accessibilityLabel = @"Archive status";
  self.status.selectable = YES;
  self.mode = [NSSegmentedControl segmentedControlWithLabels:@[ @"Saved", @"Paused imports" ]
      trackingMode:NSSegmentSwitchTrackingSelectOne target:self action:@selector(refresh:)];
  self.mode.selectedSegment = 0;
  self.query = [NSSearchField new];
  self.query.placeholderString = @"Search transcript words (exact search)";
  self.query.accessibilityLabel = @"Search Archives by exact words";
  self.query.target = self;
  self.query.action = @selector(search:);
  self.query.sendsSearchStringImmediately = NO;
  self.query.sendsWholeSearchString = YES;
  NSButton *refresh = [self button:@"Refresh" action:@selector(refresh:)];
  NSStackView *actions = [NSStackView stackViewWithViews:@[ self.importButton, self.pauseButton, open, [NSView new], refresh ]];
  NSStackView *filter = [NSStackView stackViewWithViews:@[ self.mode, self.query ]];
  actions.spacing = filter.spacing = 12;
  [self.query.widthAnchor constraintGreaterThanOrEqualToConstant:260].active = YES;

  self.table = [NSTableView new];
  NSTableColumn *column = [[NSTableColumn alloc] initWithIdentifier:@"archives"];
  column.width = 270;
  [self.table addTableColumn:column];
  self.table.headerView = nil;
  self.table.rowHeight = 76;
  self.table.delegate = self; self.table.dataSource = self;
  self.table.backgroundColor = AfternoteCanvasColor();
  self.table.accessibilityLabel = @"Archives";
  NSScrollView *list = [NSScrollView new];
  list.hasVerticalScroller = YES; list.documentView = self.table;
  [list.widthAnchor constraintEqualToConstant:270].active = YES;
  self.reader = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 580, 400)];
  self.reader.editable = NO; self.reader.selectable = YES; self.reader.richText = NO;
  self.reader.importsGraphics = NO; self.reader.automaticLinkDetectionEnabled = NO;
  self.reader.font = [NSFont systemFontOfSize:14];
  self.reader.textColor = AfternoteTextColor(); self.reader.backgroundColor = AfternoteCanvasColor();
  self.reader.textContainerInset = NSMakeSize(16, 12);
  self.reader.autoresizingMask = NSViewWidthSizable;
  self.reader.textContainer.widthTracksTextView = YES;
  self.reader.horizontallyResizable = NO;
  self.reader.verticallyResizable = YES;
  self.reader.minSize = NSMakeSize(0, 0);
  self.reader.maxSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
  self.reader.textContainer.containerSize = NSMakeSize(580, CGFLOAT_MAX);
  self.reader.accessibilityLabel = @"Read-only transcript passages";
  NSScrollView *reading = [ArchiveReadingScrollView new];
  reading.hasVerticalScroller = YES; reading.documentView = self.reader;
  self.pageLabel = AfternoteLabel(@"Select an Archive", 12, NSFontWeightMedium);
  self.previousPage = [self button:@"Previous passages" action:@selector(previous:)];
  self.nextPage = [self button:@"Next passages" action:@selector(next:)];
  NSStackView *paging = [NSStackView stackViewWithViews:@[ self.previousPage, self.nextPage, [NSView new] ]];
  paging.spacing = 12;
  NSStackView *detail = [NSStackView stackViewWithViews:@[ self.pageLabel, reading, paging ]];
  detail.orientation = NSUserInterfaceLayoutOrientationVertical; detail.alignment = NSLayoutAttributeLeading; detail.spacing = 12;
  [reading.widthAnchor constraintEqualToAnchor:detail.widthAnchor].active = YES;
  NSStackView *body = [NSStackView stackViewWithViews:@[ list, detail ]];
  body.spacing = 20; body.alignment = NSLayoutAttributeTop;
  [detail.widthAnchor constraintEqualToAnchor:body.widthAnchor constant:-290].active = YES;
  [list.heightAnchor constraintEqualToAnchor:body.heightAnchor].active = YES;
  [detail.heightAnchor constraintEqualToAnchor:body.heightAnchor].active = YES;
  self.more = [self button:@"Next Archives" action:@selector(moreArchives:)];
  self.resumeButton = [self button:@"Resume with same file…" action:@selector(resume:)];
  self.deleteButton = [self button:@"Delete Archive…" action:@selector(deleteArchive:)];
  AfternoteStyleDestructiveButton(self.deleteButton);
  NSStackView *footer = [NSStackView stackViewWithViews:@[ self.more, [NSView new], self.resumeButton, self.deleteButton ]];
  footer.spacing = 12;
  NSStackView *stack = [NSStackView stackViewWithViews:@[ heading, description, actions, self.status, filter, body, footer ]];
  stack.orientation = NSUserInterfaceLayoutOrientationVertical; stack.alignment = NSLayoutAttributeLeading; stack.spacing = 16;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [root addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:root.leadingAnchor constant:28],
    [stack.trailingAnchor constraintEqualToAnchor:root.trailingAnchor constant:-28],
    [stack.topAnchor constraintEqualToAnchor:root.topAnchor constant:24],
    [stack.bottomAnchor constraintEqualToAnchor:root.bottomAnchor constant:-24],
    [body.heightAnchor constraintGreaterThanOrEqualToConstant:260],
  ]];
  for (NSView *view in @[ actions, filter, body, footer, description, self.status ]) {
    [view.widthAnchor constraintEqualToAnchor:stack.widthAnchor].active = YES;
  }
  [self updateControls];
  return self;
}
- (NSButton *)button:(NSString *)title action:(SEL)action {
  NSButton *button = [AfternoteButton buttonWithTitle:title target:self action:action];
  AfternoteStyleSecondaryButton(button); return button;
}
- (void)authenticateClicked:(id)sender { if (self.authenticate) self.authenticate(); }
- (void)openAuthenticated:(BOOL)authenticated {
  [self showWindow:nil];
  self.authenticated = authenticated;
  [self updateControls];
  if (authenticated) [self refresh:nil];
}
- (void)clearPlaintext:(NSString *)message {
  self.generation++;
  self.importToken.cancelled = YES;
  self.importing = NO; self.loading = NO; self.authenticated = NO;
  self.rows = @[]; self.selected = nil; self.cursor = nil; self.archiveId = nil; self.nextIndex = nil;
  self.reader.string = @""; [self.reader.undoManager removeAllActions]; self.query.stringValue = @"";
  self.pageLabel.stringValue = @"Select an Archive"; self.status.stringValue = message;
  [self.table reloadData]; [self updateControls];
}
- (void)windowWillClose:(NSNotification *)notification {
  [self clearPlaintext:@"Archives closed. Any partial import can be resumed."];
}
- (void)updateControls {
  self.authenticateButton.hidden = self.authenticated;
  self.importButton.enabled = self.authenticated && !self.importing && !self.loading;
  self.pauseButton.hidden = !self.importing;
  self.query.enabled = self.authenticated && !self.importing;
  self.mode.enabled = self.authenticated && !self.importing;
  self.table.enabled = self.authenticated && !self.importing && !self.loading;
  self.more.enabled = self.authenticated && self.cursor != nil && !self.importing && !self.loading;
  self.resumeButton.enabled = self.authenticated && [self.selected[@"state"] isEqual:@"importing"] && !self.importing && !self.loading;
  self.deleteButton.enabled = self.authenticated && self.selected != nil && !self.importing && !self.loading;
  self.deleteButton.title = [self.selected[@"state"] isEqual:@"importing"] ? @"Discard paused import…" : @"Delete Archive…";
  self.previousPage.enabled = self.authenticated && !self.importing && !self.loading && self.archiveId != nil && self.pageStart > 0;
  self.nextPage.enabled = self.authenticated && !self.importing && !self.loading && self.nextIndex != nil;
}
- (void)request:(NSString *)method params:(NSDictionary *)params apply:(void (^)(NSDictionary *))apply {
  if (!self.authenticated) return;
  self.loading = YES; [self updateControls];
  NSUInteger generation = self.generation;
  [self.broker requestMethod:method params:params reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.generation) return;
      self.loading = NO;
      if (error != nil) {
        [self clearPlaintext:error[@"message"] ?: @"Archive request failed. Authenticate to try again."];
        return;
      }
      apply(result); [self updateControls];
    });
  }];
}
- (void)refresh:(id)sender {
  if (self.importing || !self.authenticated) return;
  self.generation++; self.cursor = nil; self.query.stringValue = @"";
  [self loadList:nil];
}
- (void)loadList:(NSString *)cursor {
  self.rows = @[]; [self.table reloadData];
  self.selected = nil; self.reader.string = @""; self.archiveId = nil; self.nextIndex = nil;
  self.pageLabel.stringValue = @"Select an Archive";
  self.status.stringValue = @"Loading Archives…";
  [self request:@"library.archive_list" params:@{ @"state": self.mode.selectedSegment == 1 ? @"importing" : @"ready",
      @"cursor": cursor ?: NSNull.null, @"limit": @20 } apply:^(NSDictionary *result) {
    self.rows = result[@"archives"]; self.cursor = result[@"nextCursor"] == NSNull.null ? nil : result[@"nextCursor"];
    self.status.stringValue = self.rows.count ? @"Exact passage search · Private to this Mac" :
      (self.mode.selectedSegment == 1 ? @"No paused imports." : @"No Archives yet. Import a UTF-8 text or Markdown transcript (up to 64 MiB).");
    [self.table reloadData];
  }];
}
- (void)moreArchives:(id)sender { if (!self.importing && self.cursor) { self.generation++; [self loadList:self.cursor]; } }
- (void)search:(id)sender {
  if (self.importing) return;
  if (self.query.stringValue.length == 0) { [self refresh:nil]; return; }
  self.generation++; self.selected = nil; self.reader.string = @""; self.archiveId = nil; self.nextIndex = nil; self.cursor = nil;
  self.rows = @[]; [self.table reloadData];
  self.pageLabel.stringValue = @"Select a matching passage";
  self.status.stringValue = @"Searching transcript words…";
  self.mode.selectedSegment = 0;
  [self request:@"library.archive_search" params:@{ @"query": self.query.stringValue, @"limit": @20 } apply:^(NSDictionary *result) {
    self.rows = result[@"results"]; self.status.stringValue = self.rows.count ? @"Matching passages · Exact search" : @"No matching passages. Try fewer or different words.";
    [self.table reloadData];
  }];
}
- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView { return self.rows.count; }
- (NSView *)tableView:(NSTableView *)tableView viewForTableColumn:(NSTableColumn *)column row:(NSInteger)row {
  NSDictionary *item = self.rows[(NSUInteger)row];
  NSString *summary = item[@"index"] == nil ? item[@"title"] : [NSString stringWithFormat:@"%@\nPassage %lu · %@",
      item[@"title"], [item[@"index"] unsignedIntegerValue] + 1, item[@"excerpt"]];
  NSTextField *label = AfternoteLabel(summary ?: @"Archive", 13, NSFontWeightMedium);
  label.lineBreakMode = NSLineBreakByTruncatingTail; label.maximumNumberOfLines = 3;
  label.accessibilityLabel = summary; label.toolTip = summary; return label;
}
- (void)tableViewSelectionDidChange:(NSNotification *)notification {
  NSInteger row = self.table.selectedRow;
  if (row < 0 || (NSUInteger)row >= self.rows.count || self.importing || self.loading) return;
  self.generation++; self.selected = self.rows[(NSUInteger)row];
  self.reader.string = @""; self.archiveId = nil; self.nextIndex = nil;
  if ([self.selected[@"state"] isEqual:@"importing"]) {
    self.pageLabel.stringValue = [NSString stringWithFormat:@"Paused · %@", self.selected[@"id"]];
    self.status.stringValue = [NSString stringWithFormat:@"%@ of %@ bytes saved. Resume with the original file, or discard this partial import.", self.selected[@"savedBytes"], self.selected[@"expectedBytes"]];
    [self updateControls]; return;
  }
  self.archiveId = self.selected[@"id"] ?: self.selected[@"archiveId"];
  [self loadPassages:[self.selected[@"index"] unsignedIntegerValue]];
}
- (void)loadPassages:(NSUInteger)index {
  if (!self.archiveId) return;
  self.reader.string = @"";
  self.pageLabel.stringValue = @"Loading passages…";
  [self request:@"library.archive_read" params:@{ @"id": self.archiveId, @"startIndex": @(index), @"limit": @2 } apply:^(NSDictionary *result) {
    self.pageStart = index;
    self.nextIndex = result[@"nextIndex"] == NSNull.null ? nil : result[@"nextIndex"];
    NSMutableArray *text = [NSMutableArray array];
    for (NSDictionary *passage in result[@"passages"]) [text addObject:passage[@"text"]];
    self.reader.string = [text componentsJoinedByString:@""];
    [self.reader scrollRangeToVisible:NSMakeRange(0, 0)];
    self.pageLabel.stringValue = [NSString stringWithFormat:@"Passages %lu–%lu · Read only", (unsigned long)index + 1, (unsigned long)index + text.count];
  }];
}
- (void)next:(id)sender { if (self.nextIndex) { self.generation++; [self loadPassages:self.nextIndex.unsignedIntegerValue]; } }
- (void)previous:(id)sender { self.generation++; [self loadPassages:self.pageStart >= 2 ? self.pageStart - 2 : 0]; }
- (void)pauseImport:(id)sender { self.importToken.cancelled = YES; self.status.stringValue = @"Pausing after the current batch…"; }
- (void)resume:(id)sender { if ([self.selected[@"state"] isEqual:@"importing"]) [self chooseFileForArchive:self.selected]; }
- (void)importFile:(id)sender { [self chooseFileForArchive:nil]; }
- (void)chooseFileForArchive:(NSDictionary *)archive {
  if (!self.authenticated || self.importing) return;
  NSUInteger generation = self.generation;
  NSOpenPanel *panel = NSOpenPanel.openPanel;
  panel.canChooseDirectories = NO; panel.allowsMultipleSelection = NO;
  panel.allowedContentTypes = @[ UTTypePlainText, [UTType typeWithFilenameExtension:@"md"] ];
  panel.message = @"Import an actual UTF-8 transcript, up to 64 MiB. The original file remains unchanged outside the encrypted Vault.";
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    if (response != NSModalResponseOK || generation != self.generation) return;
    [self startImport:panel.URL.path title:archive[@"title"] ?: panel.URL.lastPathComponent resumeId:archive[@"id"]];
  }];
}
- (void)startImport:(NSString *)path title:(NSString *)title resumeId:(NSString *)resumeId {
  self.generation++;
  NSUInteger generation = self.generation;
  ArchiveImportToken *token = [ArchiveImportToken new]; self.importToken = token;
  id<AfternoteOwnerBroker> broker = self.broker;
  self.importing = YES; [self updateControls];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSDictionary *error = nil;
    AfternoteArchiveRequest request = ^NSDictionary *(NSString *method, NSDictionary *params, NSDictionary **failure) {
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      __block NSDictionary *answer = nil, *problem = nil;
      [broker requestMethod:method params:params reply:^(NSDictionary *result, NSDictionary *error) {
        answer = result; problem = error; dispatch_semaphore_signal(done);
      }];
      if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 130 * NSEC_PER_SEC)) != 0) {
        *failure = @{ @"code": @"timed_out", @"message": @"Import timed out. Resume with the same file to safely retry." }; return nil;
      }
      *failure = problem; return answer;
    };
    NSDictionary *saved = AfternoteImportArchive(path, title, resumeId, request, ^BOOL { return token.cancelled; },
        ^(NSString *phase, NSUInteger bytes, NSUInteger total, NSString *identifier) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (generation != self.generation) return;
        self.status.stringValue = [phase isEqual:@"verifying"] ? @"Verifying transcript encoding and checksum…" :
          [NSString stringWithFormat:@"Saving transcript: %.0f%%", total ? bytes * 100.0 / total : 0];
      });
    }, &error);
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.generation) return;
      self.importing = NO; self.importToken = nil; self.mode.selectedSegment = saved ? 0 : 1;
      if (error != nil && !token.cancelled) {
        [self clearPlaintext:error[@"message"] ?: @"Import failed. Authenticate and resume with the same file."];
      } else {
        [self refresh:nil];
      }
      [self updateControls];
    });
  });
}
- (void)deleteArchive:(id)sender {
  if (!self.selected || self.importing) return;
  NSDictionary *selected = self.selected;
  NSString *identifier = selected[@"id"] ?: selected[@"archiveId"];
  BOOL paused = [selected[@"state"] isEqual:@"importing"];
  NSUInteger generation = self.generation;
  NSAlert *alert = [NSAlert new];
  alert.messageText = paused ? @"Discard this paused import?" : @"Delete this Archive?";
  alert.informativeText = @"This removes the Archive and its saved passages from Afternote. The original transcript file is not changed.";
  [alert addButtonWithTitle:paused ? @"Discard import" : @"Delete Archive"]; [alert addButtonWithTitle:@"Cancel"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    if (response != NSAlertFirstButtonReturn || generation != self.generation) return;
    [self request:paused ? @"library.archive_cancel" : @"admin.archive_delete" params:@{ @"id": identifier }
        apply:^(NSDictionary *result) { [self refresh:nil]; }];
  }];
}
@end
