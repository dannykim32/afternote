#import "semantic_settings.h"
#import "native_appearance.h"

static NSTextField *CopyLabel(NSString *text, CGFloat size) {
  NSTextField *label = [NSTextField wrappingLabelWithString:text];
  label.font = [NSFont systemFontOfSize:size];
  label.textColor = AfternoteMutedTextColor();
  return label;
}

@interface AfternoteSemanticSettings ()
@property(nonatomic, copy) AfternoteSemanticRunner runner;
@property(nonatomic, strong) NSButton *actionButton;
@property(nonatomic, strong) NSButton *toggleButton;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSProgressIndicator *spinner;
@property(nonatomic, copy) NSString *modelState;
@property(nonatomic, copy) NSString *modelId;
@property(nonatomic, copy) NSString *activeModelId;
@property(nonatomic, copy) NSString *searchMode;
@property(nonatomic, copy) NSString *failure;
@property(nonatomic) BOOL activationFailure;
@property(nonatomic) BOOL applicationPending;
@property(nonatomic) BOOL enabledPreference;
@property(nonatomic) BOOL busy;
@property(nonatomic) NSInteger indexedNotes;
@property(nonatomic) NSInteger totalNotes;
@property(nonatomic) NSUInteger generation;
@property(nonatomic, strong) NSWindowController *termsWindow;
@property(nonatomic, strong) NSTextView *termsText;
@property(nonatomic, strong) NSStackView *termsDocuments;
@end

@implementation AfternoteSemanticSettings
- (instancetype)initWithRunner:(AfternoteSemanticRunner)runner {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  _runner = [runner copy];
  _searchMode = @"checking";
  self.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.alignment = NSLayoutAttributeLeading;
  self.spacing = 8;
  self.edgeInsets = NSEdgeInsetsMake(20, 0, 16, 0);
  NSTextField *heading = CopyLabel(@"Search by meaning", 14);
  heading.font = [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
  heading.textColor = AfternoteTextColor();
  _toggleButton = [NSButton checkboxWithTitle:@"Enabled" target:self action:@selector(toggleSearch:)];
  _toggleButton.enabled = NO;
  [_toggleButton setContentHuggingPriority:NSLayoutPriorityRequired forOrientation:NSLayoutConstraintOrientationHorizontal];
  NSStackView *header = [NSStackView stackViewWithViews:@[heading, [NSView new], _toggleButton]];
  header.alignment = NSLayoutAttributeCenterY;
  NSTextField *explanation = CopyLabel(@"Find notes by meaning in Afternote and connected tools. Models are included with the app—no separate download. Search runs entirely on this Mac.", 12);
  _statusLabel = CopyLabel(@"Checking local search…", 12);
  _actionButton = [AfternoteButton buttonWithTitle:@"Retry" target:self action:@selector(performAction:)];
  AfternoteStyleSecondaryButton(_actionButton);
  _actionButton.hidden = YES;
  _spinner = [NSProgressIndicator new];
  _spinner.style = NSProgressIndicatorStyleSpinning;
  _spinner.controlSize = NSControlSizeSmall;
  _spinner.displayedWhenStopped = NO;
  NSStackView *status = [NSStackView stackViewWithViews:@[_statusLabel, [NSView new], _spinner, _actionButton]];
  status.spacing = 10;
  status.alignment = NSLayoutAttributeCenterY;
  for (NSView *view in @[header, explanation, status]) {
    [self addArrangedSubview:view];
    [view.widthAnchor constraintEqualToAnchor:self.widthAnchor].active = YES;
  }
  NSString *terms = [[NSBundle mainBundle].resourcePath stringByAppendingPathComponent:@"AfternoteRuntime/LICENSES/MODEL_TERMS.md"];
  if ([[NSFileManager defaultManager] fileExistsAtPath:terms]) {
    NSButton *termsButton = [NSButton buttonWithTitle:@"Model terms" target:self action:@selector(openModelTerms:)];
    termsButton.bordered = NO;
    termsButton.font = [NSFont systemFontOfSize:11];
    [self addArrangedSubview:termsButton];
  }
  return self;
}
- (void)openModelTerms:(id)sender {
  (void)sender;
  if (!self.termsWindow) {
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 720, 540)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    window.title = @"Local search model terms";
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    window.backgroundColor = AfternoteCanvasColor();
    window.minSize = NSMakeSize(560, 360);
    window.releasedWhenClosed = NO;
    self.termsWindow = [[NSWindowController alloc] initWithWindow:window];
    self.termsDocuments = [NSStackView new];
    self.termsDocuments.spacing = 8;
    NSArray *titles = @[@"Gemma terms", @"Use policy", @"Gemma notice", @"Ettin license"];
    for (NSUInteger i = 0; i < titles.count; i++) {
      NSButton *button = [AfternoteButton buttonWithTitle:titles[i] target:self action:@selector(selectModelTerms:)];
      button.tag = i;
      [self.termsDocuments addArrangedSubview:button];
    }
    NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 680, 430)];
    scroll.hasVerticalScroller = YES;
    scroll.borderType = NSBezelBorder;
    self.termsText = [[NSTextView alloc] initWithFrame:scroll.contentView.bounds];
    self.termsText.editable = NO;
    self.termsText.selectable = YES;
    self.termsText.richText = NO;
    self.termsText.font = [NSFont systemFontOfSize:13];
    self.termsText.textColor = AfternoteTextColor();
    self.termsText.backgroundColor = AfternoteSurfaceColor();
    self.termsText.textContainerInset = NSMakeSize(16, 16);
    self.termsText.verticallyResizable = YES;
    self.termsText.horizontallyResizable = NO;
    self.termsText.autoresizingMask = NSViewWidthSizable;
    self.termsText.textContainer.widthTracksTextView = YES;
    self.termsText.textContainer.containerSize = NSMakeSize(scroll.contentSize.width, CGFLOAT_MAX);
    self.termsText.accessibilityLabel = @"Model license text";
    scroll.documentView = self.termsText;
    NSTextField *explanation = CopyLabel(@"Afternote's code is Apache-2.0. The included models have their own terms, reproduced below. These copies are available offline.", 12);
    NSStackView *column = [NSStackView stackViewWithViews:@[explanation, self.termsDocuments, scroll]];
    column.orientation = NSUserInterfaceLayoutOrientationVertical;
    column.alignment = NSLayoutAttributeLeading;
    column.spacing = 12;
    column.translatesAutoresizingMaskIntoConstraints = NO;
    [window.contentView addSubview:column];
    [NSLayoutConstraint activateConstraints:@[
      [column.leadingAnchor constraintEqualToAnchor:window.contentView.leadingAnchor constant:20],
      [column.trailingAnchor constraintEqualToAnchor:window.contentView.trailingAnchor constant:-20],
      [column.topAnchor constraintEqualToAnchor:window.contentView.topAnchor constant:20],
      [column.bottomAnchor constraintEqualToAnchor:window.contentView.bottomAnchor constant:-20],
      [explanation.widthAnchor constraintEqualToAnchor:column.widthAnchor],
      [scroll.widthAnchor constraintEqualToAnchor:column.widthAnchor],
    ]];
    [self selectModelTerms:(NSButton *)self.termsDocuments.arrangedSubviews.firstObject];
    [window center];
  }
  [self.termsWindow showWindow:nil];
  [self.termsWindow.window makeKeyAndOrderFront:nil];
}
- (void)selectModelTerms:(NSButton *)sender {
  NSArray *files = @[@"GEMMA_TERMS.txt", @"GEMMA_PROHIBITED_USE_POLICY.txt", @"GEMMA_NOTICE.txt", @"ETTIN_LICENSE.txt"];
  if (sender.tag < 0 || sender.tag >= (NSInteger)files.count) return;
  NSString *file = files[sender.tag];
  for (NSButton *button in self.termsDocuments.arrangedSubviews) {
    button.state = button == sender ? NSControlStateValueOn : NSControlStateValueOff;
    if (button == sender) AfternoteStylePrimaryButton(button);
    else AfternoteStyleSecondaryButton(button);
  }
  NSURL *directory = [[NSBundle mainBundle].resourceURL URLByAppendingPathComponent:@"AfternoteRuntime/LICENSES" isDirectory:YES];
  NSString *contents = [NSString stringWithContentsOfURL:[directory URLByAppendingPathComponent:file]
                                               encoding:NSUTF8StringEncoding error:nil];
  self.termsText.string = contents ?: @"This included document is unavailable. Reinstall Afternote to restore its model terms.";
  [self.termsText scrollRangeToVisible:NSMakeRange(0, 0)];
}
- (void)render {
  self.toggleButton.enabled = !self.busy && self.modelState != nil;
  self.toggleButton.state = self.enabledPreference ? NSControlStateValueOn : NSControlStateValueOff;
  self.actionButton.enabled = !self.busy;
  if (self.busy) return;
  [self.spinner stopAnimation:nil];
  self.actionButton.hidden = self.failure.length == 0;
  if (self.failure.length) {
    self.statusLabel.stringValue = self.failure;
    return;
  }
  BOOL active = self.activeModelId && [self.activeModelId isEqual:self.modelId];
  if (self.applicationPending) self.statusLabel.stringValue = @"Setting saved. Open Notes to apply this change.";
  else if (!self.modelState) self.statusLabel.stringValue = @"Checking local search…";
  else if (!self.enabledPreference) self.statusLabel.stringValue = [self.searchMode isEqual:@"exact"]
      ? @"Off. Afternote and connected tools use exact search."
      : @"Setting saved. Open Notes to apply this change.";
  else if (![self.modelState isEqual:@"ready"]) self.statusLabel.stringValue = @"Search files are unavailable. Reinstall Afternote to restore them. Exact search remains available.";
  else if (active && [self.searchMode isEqual:@"hybrid"]) self.statusLabel.stringValue = @"Ready in Notes and connected tools.";
  else if (active && [self.searchMode isEqual:@"indexing"]) self.statusLabel.stringValue = self.totalNotes == 0
      ? @"Preparing local search. Exact search remains available."
      : [NSString stringWithFormat:@"Preparing %ld of %ld notes. Exact search remains available.", (long)self.indexedNotes, (long)self.totalNotes];
  else if ([self.searchMode isEqual:@"degraded"]) self.statusLabel.stringValue = @"Local search needs attention. Restart Afternote to retry. Exact search remains available.";
  else self.statusLabel.stringValue = @"Enabled. Local search prepares when you open your vault.";
}
- (void)setSearchMode:(NSString *)mode {
  _searchMode = [mode copy];
  if ([@[@"checking", @"exact"] containsObject:mode]) self.activeModelId = nil;
  [self render];
}
- (void)setIndexedNotes:(NSInteger)indexed total:(NSInteger)total {
  self.indexedNotes = indexed;
  self.totalNotes = total;
}
- (void)activationCompleted:(NSString *)mode modelId:(NSString *)modelId {
  self.activeModelId = modelId;
  self.searchMode = mode;
  BOOL applied = self.enabledPreference
      ? [self.modelId isEqual:modelId] && [@[@"hybrid", @"indexing"] containsObject:mode]
      : [mode isEqual:@"exact"];
  if (applied) self.applicationPending = NO;
  if (self.activationFailure && applied) { self.failure = nil; self.activationFailure = NO; }
  [self render];
}
- (void)activationFailed {
  self.activationFailure = YES;
  self.failure = @"Could not activate the search setting. Open Notes to check vault access, then retry.";
  [self render];
}
- (void)performAction:(id)sender {
  (void)sender;
  if (self.busy) return;
  if (self.activationFailure) {
    if (self.activate) self.activate(YES);
  } else [self refresh];
}
- (void)toggleSearch:(id)sender {
  (void)sender;
  if (self.busy || !self.modelState) return;
  [self runCommand:self.toggleButton.state == NSControlStateValueOn ? @"enable" : @"disable"];
}
- (void)refresh { if (!self.busy) [self runCommand:@"catalog"]; }
- (BOOL)acceptCatalog:(NSDictionary *)result {
  if (![result isKindOfClass:NSDictionary.class] ||
      (!result[@"enabled"] ? 0 : CFGetTypeID((__bridge CFTypeRef)result[@"enabled"])) != CFBooleanGetTypeID() ||
      ![result[@"models"] isKindOfClass:NSArray.class]) return NO;
  NSDictionary *selected = nil;
  for (id model in result[@"models"]) {
    if (![model isKindOfClass:NSDictionary.class]) return NO;
    if ([model[@"key"] isEqual:@"balanced"]) { if (selected) return NO; selected = model; }
  }
  if (![selected[@"modelId"] isKindOfClass:NSString.class] || [selected[@"modelId"] length] == 0 ||
      [selected[@"modelId"] length] > 256 ||
      ![@[@"not-installed", @"ready", @"invalid"] containsObject:selected[@"state"] ?: NSNull.null]) return NO;
  self.enabledPreference = [result[@"enabled"] boolValue];
  self.modelState = selected[@"state"];
  self.modelId = selected[@"modelId"];
  return YES;
}
- (void)runCommand:(NSString *)command {
  self.busy = YES;
  self.toggleButton.enabled = NO;
  self.actionButton.enabled = NO;
  self.statusLabel.stringValue = @"Checking local search…";
  [self.spinner startAnimation:nil];
  NSUInteger generation = ++self.generation;
  __weak AfternoteSemanticSettings *weakSelf = self;
  self.runner(@[@"semantic", command], ^(NSDictionary *result, NSString *error) {
    AfternoteSemanticSettings *view = weakSelf;
    if (!view || generation != view.generation || !view.busy) return;
    view.busy = NO;
    BOOL valid = error.length == 0 && [view acceptCatalog:result];
    if (!valid) {
      view.failure = @"Could not update local search. Retry to check the saved setting.";
      view.activationFailure = NO;
    } else {
      if (![command isEqual:@"catalog"]) view.applicationPending = YES;
      if (!view.activationFailure) view.failure = nil;
    }
    [view render];
    if (valid && view.activate) view.activate(![command isEqual:@"catalog"]);
  });
}
@end
