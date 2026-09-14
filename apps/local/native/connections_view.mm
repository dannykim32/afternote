#import "connections_view.h"
#import "native_appearance.h"

namespace {
constexpr CGFloat kConnectionsMaximumWidth = 920;
constexpr CGFloat kConnectionsPageGutter = 32;
constexpr CGFloat kConnectionActionsWidth = 280;
constexpr CGFloat kConnectionColumnGap = 32;
}

@implementation AfternoteConnectionRow
@end

@interface AfternoteConnectionsView ()
@property(nonatomic, weak) id<AfternoteConnectionsActions> actionTarget;
@property(nonatomic, strong) NSStackView *content;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSProgressIndicator *progress;
@property(nonatomic, strong) NSButton *authenticateButton;
@end

@implementation AfternoteConnectionsView
- (NSTextField *)label:(NSString *)text size:(CGFloat)size weight:(NSFontWeight)weight {
  return AfternoteLabel(text, size, weight);
}

- (void)styleSecondaryButton:(NSButton *)button {
  AfternoteStyleSecondaryButton(button);
}

- (void)styleDestructiveButton:(NSButton *)button {
  AfternoteStyleDestructiveButton(button);
}

- (instancetype)initWithActionTarget:(id<AfternoteConnectionsActions>)target {
  self = [super init];
  if (self == nil) return nil;
  _actionTarget = target;
  NSView *root = self;
  StyleSurface(root, AfternoteCanvasColor());
  NSTextField *title = [self label:@"Connections" size:32 weight:NSFontWeightSemibold];
  NSTextField *subtitle = [self label:@"Access and recent activity for local tools. Note text and queries never appear here."
                                     size:15 weight:NSFontWeightRegular];
  subtitle.textColor = AfternoteMutedTextColor();
  self.statusLabel = [self label:@"Loading broker state…" size:13 weight:NSFontWeightMedium];
  self.statusLabel.identifier = @"ConnectionsStatus";
  self.statusLabel.textColor = AfternoteMutedTextColor();
  self.statusLabel.accessibilityLabel = @"Broker status";
  self.progress = [[NSProgressIndicator alloc] init];
  self.progress.identifier = @"ConnectionsProgress";
  self.progress.style = NSProgressIndicatorStyleSpinning;
  self.progress.controlSize = NSControlSizeSmall;
  [self.progress startAnimation:nil];
  self.authenticateButton = [AfternoteButton buttonWithTitle:@"Refresh"
                                               target:self.actionTarget
                                               action:@selector(refreshConnections:)];
  [self styleSecondaryButton:self.authenticateButton];
  self.authenticateButton.identifier = @"ConnectionsRefresh";
  self.authenticateButton.keyEquivalent = @"r";
  self.authenticateButton.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  self.authenticateButton.accessibilityLabel = @"Refresh connections";

  NSStackView *headingRow = [NSStackView stackViewWithViews:@[
    title, [NSView new], self.authenticateButton
  ]];
  headingRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  headingRow.alignment = NSLayoutAttributeCenterY;
  headingRow.spacing = 16;
  headingRow.identifier = @"ConnectionsHeading";
  [title setContentCompressionResistancePriority:NSLayoutPriorityRequired
                                 forOrientation:NSLayoutConstraintOrientationHorizontal];

  NSStackView *statusRow = [NSStackView stackViewWithViews:@[
    self.progress, self.statusLabel
  ]];
  statusRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  statusRow.spacing = 10;
  statusRow.alignment = NSLayoutAttributeCenterY;
  [self.statusLabel setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow
                                            forOrientation:NSLayoutConstraintOrientationHorizontal];

  self.content = [FlippedStackView stackViewWithViews:@[]];
  self.content.identifier = @"ConnectionsRows";
  self.content.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.content.alignment = NSLayoutAttributeLeading;
  self.content.spacing = 16;
  self.content.edgeInsets = NSEdgeInsetsMake(18, 0, 32, 0);

  NSScrollView *scroll = [[NSScrollView alloc] init];
  scroll.hasVerticalScroller = YES;
  scroll.drawsBackground = NO;
  scroll.documentView = self.content;
  scroll.autohidesScrollers = YES;
  scroll.identifier = @"ConnectionsScroll";

  NSStackView *layout = [NSStackView stackViewWithViews:@[
    headingRow, subtitle, statusRow, scroll
  ]];
  layout.orientation = NSUserInterfaceLayoutOrientationVertical;
  layout.alignment = NSLayoutAttributeLeading;
  layout.spacing = 12;
  layout.translatesAutoresizingMaskIntoConstraints = NO;
  layout.identifier = @"ConnectionsColumn";
  [root addSubview:layout];
  NSLayoutConstraint *preferredConnectionsWidth =
      [layout.widthAnchor constraintEqualToAnchor:root.widthAnchor
                                        constant:-2 * kConnectionsPageGutter];
  // Fill the available width without resizing the user's window to satisfy it.
  preferredConnectionsWidth.priority = NSLayoutPriorityWindowSizeStayPut - 1;
  preferredConnectionsWidth.active = YES;
  [NSLayoutConstraint activateConstraints:@[
    [layout.centerXAnchor constraintEqualToAnchor:root.centerXAnchor],
    [layout.leadingAnchor constraintGreaterThanOrEqualToAnchor:root.leadingAnchor constant:kConnectionsPageGutter],
    [layout.trailingAnchor constraintLessThanOrEqualToAnchor:root.trailingAnchor constant:-kConnectionsPageGutter],
    [layout.topAnchor constraintEqualToAnchor:root.topAnchor constant:30],
    [layout.bottomAnchor constraintEqualToAnchor:root.bottomAnchor constant:-16],
    [layout.widthAnchor constraintLessThanOrEqualToConstant:kConnectionsMaximumWidth],
    // Use the viewport's width so header actions align with row dividers even
    // when macOS is configured to reserve space for an always-visible scrollbar.
    [headingRow.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor],
    [subtitle.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor],
    [statusRow.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor],
    [scroll.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [scroll.heightAnchor constraintGreaterThanOrEqualToConstant:120],
    [self.content.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor],
  ]];
  return self;
}

- (NSButton *)integrationActionForKind:(NSString *)kind
                            displayName:(NSString *)displayName
                           presentation:(AfternoteConnectorPresentation *)presentation {
  NSButton *button = nil;
  if (presentation.action == AfternoteConnectorActionGetTool) {
    NSString *title = [kind isEqualToString:@"codex"]
        ? @"Get Codex"
        : [kind isEqualToString:@"claude-desktop"]
        ? @"Get Claude Desktop"
        : @"Get Claude Code";
    button = [AfternoteButton buttonWithTitle:title
                                       target:self.actionTarget
                                       action:@selector(openIntegrationDownload:)];
  } else if (presentation.action == AfternoteConnectorActionConnect) {
    button = [AfternoteButton buttonWithTitle:@"Connect Afternote"
                                       target:self.actionTarget
                                       action:@selector(installIntegration:)];
  } else if (presentation.action == AfternoteConnectorActionPrepareReconnect) {
    button = [AfternoteButton buttonWithTitle:@"Prepare reconnect"
                                       target:self.actionTarget
                                       action:@selector(reconnectIntegration:)];
  } else if (presentation.action == AfternoteConnectorActionRepair) {
    button = [AfternoteButton buttonWithTitle:@"Repair Afternote"
                                       target:self.actionTarget
                                       action:@selector(installIntegration:)];
  } else if (presentation.action == AfternoteConnectorActionCheckAgain) {
    button = [AfternoteButton buttonWithTitle:@"Check again"
                                       target:self.actionTarget
                                       action:@selector(refreshIntegrationStatusFromButton:)];
  } else if (presentation.action == AfternoteConnectorActionReviewSetup) {
    button = [AfternoteButton buttonWithTitle:@"Review setup"
                                       target:self.actionTarget
                                       action:@selector(reviewIntegrationSetup:)];
  }
  if (button == nil) return nil;
  button.identifier = kind;
  button.accessibilityLabel = [NSString stringWithFormat:@"%@ in %@",
      button.title, displayName];
  if (presentation.action == AfternoteConnectorActionRepair) {
    // Repair is contextual maintenance, not the primary onboarding action.
    // Match the page's text actions; reveal a surface only on interaction.
    button.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    button.contentTintColor = AfternoteBrandCaptureColor();
    AfternoteButton *repair = (AfternoteButton *)button;
    repair.afternoteHoverColor = AfternoteSurfaceColor();
    repair.afternotePressedColor = AfternoteRaisedSurfaceColor();
  } else {
    [self styleSecondaryButton:button];
  }
  return button;
}

- (NSView *)connectorFactWithTitle:(NSString *)title value:(NSString *)value {
  NSTextField *heading = [self label:title size:10 weight:NSFontWeightSemibold];
  heading.textColor = AfternoteMutedTextColor();
  NSTextField *copy = [self label:value size:12 weight:NSFontWeightRegular];
  copy.textColor = AfternoteTextColor();
  NSStackView *fact = [NSStackView stackViewWithViews:@[ heading, copy ]];
  fact.orientation = NSUserInterfaceLayoutOrientationVertical;
  fact.alignment = NSLayoutAttributeLeading;
  fact.spacing = 3;
  [heading.widthAnchor constraintEqualToAnchor:fact.widthAnchor].active = YES;
  [copy.widthAnchor constraintEqualToAnchor:fact.widthAnchor].active = YES;
  [copy setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow
                                forOrientation:NSLayoutConstraintOrientationHorizontal];
  return fact;
}

- (NSView *)rowView:(AfternoteConnectionRow *)row {
  NSString *commandKind = row.commandKind;
  NSString *brokerKind = row.brokerKind;
  NSString *displayName = row.displayName;
  AfternoteConnectorPresentation *presentation = row.presentation;
  BOOL connected = row.connected;
  NSArray<NSString *> *historyLines = row.historyLines;
  NSMutableArray<NSView *> *connectionViews = [NSMutableArray array];
  NSTextField *connectionLabel = [self label:@"Current connection"
                                         size:10
                                       weight:NSFontWeightSemibold];
  connectionLabel.textColor = AfternoteMutedTextColor();
  NSTextField *connectionValue = [self label:presentation.connectionTitle
                                         size:12
                                       weight:NSFontWeightSemibold];
  NSTextField *connectionCopy = [self label:presentation.connectionDetail
                                        size:11
                                      weight:NSFontWeightRegular];
  connectionCopy.textColor = AfternoteMutedTextColor();
  [connectionViews addObjectsFromArray:@[
    connectionLabel, connectionValue, connectionCopy
  ]];
  if (commandKind.length > 0) {
    NSButton *setup = [self integrationActionForKind:commandKind
                                          displayName:displayName
                                        presentation:presentation];
    if (setup != nil) [connectionViews addObject:setup];
  }
  if (connected) {
    NSButton *revoke = [AfternoteButton buttonWithTitle:@"Revoke access"
                                                   target:self.actionTarget
                                                   action:@selector(confirmRevocation:)];
    [self styleDestructiveButton:revoke];
    revoke.identifier = brokerKind;
    revoke.accessibilityLabel = [NSString stringWithFormat:@"Revoke %@ access", displayName];
    [connectionViews addObject:revoke];
  }

  NSTextField *heading = [self label:displayName size:16 weight:NSFontWeightSemibold];
  NSTextField *badge = [self label:[presentation.badge uppercaseString]
                                 size:10 weight:NSFontWeightBold];
  badge.textColor = StatusColor(presentation.tone);
  badge.accessibilityLabel = [NSString stringWithFormat:@"Status: %@", presentation.badge];
  NSStackView *header = [NSStackView stackViewWithViews:@[ heading, badge, [NSView new] ]];
  header.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  header.alignment = NSLayoutAttributeCenterY;
  header.spacing = 8;

  NSTextField *state = [self label:presentation.summary size:12 weight:NSFontWeightRegular];
  state.textColor = AfternoteMutedTextColor();
  NSStackView *facts = [NSStackView stackViewWithViews:@[
    [self connectorFactWithTitle:@"Permissions" value:row.permissions],
    [self connectorFactWithTitle:@"Recent activity" value:row.activity],
  ]];
  facts.orientation = NSUserInterfaceLayoutOrientationVertical;
  facts.alignment = NSLayoutAttributeLeading;
  facts.spacing = 12;
  [facts setHuggingPriority:NSLayoutPriorityRequired
            forOrientation:NSLayoutConstraintOrientationVertical];
  NSStackView *currentConnection = [NSStackView stackViewWithViews:connectionViews];
  currentConnection.orientation = NSUserInterfaceLayoutOrientationVertical;
  currentConnection.alignment = NSLayoutAttributeLeading;
  currentConnection.spacing = 4;
  currentConnection.identifier = @"ConnectionActions";
  [currentConnection.widthAnchor constraintEqualToConstant:kConnectionActionsWidth].active = YES;
  for (NSView *view in connectionViews) {
    if ([view isKindOfClass:[NSTextField class]]) {
      [view.widthAnchor constraintEqualToAnchor:currentConnection.widthAnchor].active = YES;
      [view setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow
                                     forOrientation:NSLayoutConstraintOrientationHorizontal];
    }
  }
  facts.identifier = @"ConnectionFacts";
  for (NSView *fact in facts.arrangedSubviews) {
    [fact.widthAnchor constraintEqualToAnchor:facts.widthAnchor].active = YES;
  }
  NSStackView *details = [NSStackView stackViewWithViews:@[
    facts, currentConnection
  ]];
  details.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  details.alignment = NSLayoutAttributeTop;
  details.spacing = kConnectionColumnGap;
  [facts.widthAnchor constraintEqualToAnchor:details.widthAnchor
                                  constant:-(kConnectionActionsWidth + kConnectionColumnGap)].active = YES;

  NSMutableArray<NSView *> *rows = [NSMutableArray arrayWithObjects:header, state, details, nil];
  BOOL expanded = row.historyExpanded;
  NSImage *image = [NSImage imageWithSystemSymbolName:expanded ? @"chevron.down" : @"chevron.right"
                            accessibilityDescription:expanded ? @"Hide history" : @"Show history"];
  NSButton *history = [AfternoteButton buttonWithTitle:@"Connection history"
                                                target:self.actionTarget
                                                action:@selector(toggleConnectorHistory:)];
  history.identifier = brokerKind;
  history.image = image;
  history.imagePosition = NSImageLeft;
  history.imageHugsTitle = YES;
  history.bordered = NO;
  history.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
  history.contentTintColor = AfternoteBrandCaptureColor();
  history.accessibilityLabel = [NSString stringWithFormat:@"%@ %@ connection history",
                                 expanded ? @"Hide" : @"Show", displayName];
  NSString *historyCountText = row.historyAuthorized
      ? [NSString stringWithFormat:@"%lu event%@",
          (unsigned long)historyLines.count, historyLines.count == 1 ? @"" : @"s"]
      : @"Authenticate to view";
  NSTextField *historyCount = [self label:historyCountText
                                         size:10
                                       weight:NSFontWeightRegular];
  historyCount.textColor = AfternoteMutedTextColor();
  NSStackView *historyDisclosure = [NSStackView stackViewWithViews:@[
    history, historyCount, [NSView new]
  ]];
  historyDisclosure.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  historyDisclosure.alignment = NSLayoutAttributeCenterY;
  historyDisclosure.spacing = 8;
  [rows addObject:historyDisclosure];
  if (expanded) {
    NSTextView *historyText = [[NSTextView alloc]
        initWithFrame:NSMakeRect(0, 0, 820, 104)];
    historyText.editable = NO;
    historyText.selectable = YES;
    historyText.richText = NO;
    historyText.drawsBackground = NO;
    historyText.font = [NSFont systemFontOfSize:11 weight:NSFontWeightRegular];
    historyText.textColor = AfternoteMutedTextColor();
    historyText.textContainerInset = NSMakeSize(0, 6);
    historyText.autoresizingMask = NSViewWidthSizable;
    historyText.string = historyLines.count > 0
        ? [historyLines componentsJoinedByString:@"\n"]
        : @"No connection history yet.";
    historyText.accessibilityLabel = [NSString stringWithFormat:@"%@ access history", displayName];
    NSScrollView *historyScroll = [[NSScrollView alloc] init];
    historyScroll.documentView = historyText;
    historyScroll.hasVerticalScroller = YES;
    historyScroll.drawsBackground = NO;
    historyScroll.borderType = NSNoBorder;
    [historyScroll.heightAnchor constraintEqualToConstant:104].active = YES;
    [rows addObject:historyScroll];
    if (row.hasOlderHistory) {
      NSButton *older = [AfternoteButton buttonWithTitle:@"Show older events"
                                                   target:self.actionTarget
                                                   action:@selector(loadMore:)];
      older.bordered = NO;
      older.font = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium];
      older.contentTintColor = AfternoteMutedTextColor();
      older.accessibilityLabel = [NSString stringWithFormat:
          @"Show older redacted %@ connection events", displayName];
      [rows addObject:older];
    }
  }
  NSStackView *content = [NSStackView stackViewWithViews:rows];
  content.orientation = NSUserInterfaceLayoutOrientationVertical;
  content.alignment = NSLayoutAttributeLeading;
  content.spacing = 10;
  content.edgeInsets = NSEdgeInsetsMake(15, 0, 15, 0);
  NSBox *divider = [[NSBox alloc] init];
  divider.boxType = NSBoxSeparator;
  NSStackView *group = [NSStackView stackViewWithViews:@[ content, divider ]];
  group.orientation = NSUserInterfaceLayoutOrientationVertical;
  group.alignment = NSLayoutAttributeLeading;
  group.spacing = 0;
  [content.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  [header.widthAnchor constraintEqualToAnchor:content.widthAnchor].active = YES;
  [divider.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  for (NSView *row in rows) {
    if (row != header) [row.widthAnchor constraintEqualToAnchor:content.widthAnchor].active = YES;
  }
  return group;
}

- (NSView *)connectionDetailRowWithTitle:(NSString *)title
                                  status:(NSString *)status
                                    body:(NSArray<NSString *> *)body
                                  button:(NSButton *)button {
  NSTextField *heading = [self label:title size:16 weight:NSFontWeightSemibold];
  NSTextField *badge = [self label:[status uppercaseString] size:10 weight:NSFontWeightBold];
  badge.textColor = StatusColor(status);
  badge.accessibilityLabel = [NSString stringWithFormat:@"Status: %@", status];
  NSMutableArray<NSView *> *headingViews = [NSMutableArray arrayWithObjects:heading, badge, [NSView new], nil];
  if (button != nil) [headingViews addObject:button];
  NSStackView *header = [NSStackView stackViewWithViews:headingViews];
  header.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  header.alignment = NSLayoutAttributeCenterY;
  header.spacing = 8;
  NSMutableArray<NSView *> *rows = [NSMutableArray arrayWithObject:header];
  for (NSString *line in body) {
    NSTextField *label = [self label:line size:12 weight:NSFontWeightRegular];
    label.textColor = AfternoteMutedTextColor();
    [rows addObject:label];
  }
  NSStackView *content = [NSStackView stackViewWithViews:rows];
  content.orientation = NSUserInterfaceLayoutOrientationVertical;
  content.alignment = NSLayoutAttributeLeading;
  content.spacing = 6;
  content.edgeInsets = NSEdgeInsetsMake(15, 0, 15, 0);
  NSBox *divider = [[NSBox alloc] init];
  divider.boxType = NSBoxSeparator;
  NSStackView *group = [NSStackView stackViewWithViews:@[ content, divider ]];
  group.orientation = NSUserInterfaceLayoutOrientationVertical;
  group.alignment = NSLayoutAttributeLeading;
  group.spacing = 0;
  [content.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  [header.widthAnchor constraintEqualToAnchor:content.widthAnchor].active = YES;
  [divider.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  return group;
}

- (void)addCard:(NSView *)card {
  [self.content addArrangedSubview:card];
  [card.widthAnchor constraintEqualToAnchor:self.content.widthAnchor].active = YES;
}

- (void)clearContent {
  for (NSView *view in [self.content.arrangedSubviews copy]) {
    [self.content removeArrangedSubview:view];
    [view removeFromSuperview];
  }
}


- (void)renderRows:(NSArray<AfternoteConnectionRow *> *)rows {
  [self clearContent];
  for (AfternoteConnectionRow *row in rows) [self addCard:[self rowView:row]];
}

- (void)setBusy:(BOOL)busy status:(NSString *)status {
  self.authenticateButton.enabled = !busy;
  self.statusLabel.stringValue = status;
  self.progress.hidden = !busy;
  if (busy) [self.progress startAnimation:nil];
  else [self.progress stopAnimation:nil];
}

- (void)setRefreshEnabled:(BOOL)enabled {
  self.authenticateButton.enabled = enabled;
}

- (void)showErrorMessage:(NSString *)message {
  [self clearContent];
  [self addCard:[self connectionDetailRowWithTitle:@"Connections unavailable"
      status:@"unavailable"
      body:@[message, @"No web session or local request can substitute for native owner authentication."]
      button:nil]];
}
@end
