// Included only by the protocol-test target, after OwnerControlDelegate is defined.
// Exercises the real AppKit hierarchy with synthetic state; no broker is created.
NSView *ConnectionLayoutView(NSView *root, NSString *identifier) {
  if ([root.identifier isEqualToString:identifier]) return root;
  for (NSView *child in root.subviews) {
    NSView *found = ConnectionLayoutView(child, identifier);
    if (found != nil) return found;
  }
  return nil;
}

BOOL ConnectionLayoutTextFits(NSView *view) {
  if ([view isKindOfClass:[NSTextField class]]) {
    NSTextField *field = (NSTextField *)view;
    NSSize needed = [field.cell cellSizeForBounds:
        NSMakeRect(0, 0, field.bounds.size.width, CGFLOAT_MAX)];
    if (needed.height > field.bounds.size.height + 1) return NO;
  }
  for (NSView *child in view.subviews) {
    if (!ConnectionLayoutTextFits(child)) return NO;
  }
  return YES;
}

int RunConnectionsLayoutSmoke(NSString *previewDirectory) {
  [NSApplication sharedApplication].activationPolicy = NSApplicationActivationPolicyProhibited;
  OwnerControlDelegate *delegate = [[OwnerControlDelegate alloc] init];
  delegate.auditEvents = [NSMutableArray array];
  delegate.revocationTargets = [NSMutableDictionary dictionary];
  delegate.integrationOperations = [NSMutableSet set];
  delegate.expandedConnectorKinds = [NSMutableSet set];
  delegate.noteSummaries = [NSMutableArray array];
  delegate.revisionSummaries = @[];
  delegate.setupGuideDismissed = YES;
  delegate.connectorOverviewByKind = @{};
  delegate.integrationStatuses = [@{
    @"codex" : @{ @"toolAvailable": @YES, @"installed": @YES, @"healthy": @YES },
    @"claude-code" : @{ @"toolAvailable": @YES, @"installed": @YES, @"healthy": @NO,
                        @"repairable": @YES, @"problemCode": @"connector_legacy" },
    @"claude-desktop" : @{ @"toolAvailable": @YES, @"installed": @YES, @"healthy": @YES },
  } mutableCopy];
  NSMutableArray *clients = [NSMutableArray array];
  for (NSString *kind in @[ @"codex", @"claude", @"claude-desktop" ]) {
    [clients addObject:@{
      @"kind": kind, @"status": @"active", @"clientId": NSUUID.UUID.UUIDString,
      @"pairedAt": @"2026-09-13T12:00:00.000Z",
      @"lastActivityAt": @"2026-09-13T19:33:00.000Z",
      @"activeScopes": @[ @"memory.remember", @"memory.recall", @"memory.get_note" ],
    }];
  }
  delegate.connections = @{ @"clients": clients, @"grants": @[], @"sessions": @[] };
  [delegate buildWindow];
  [delegate setPrivilegedSurfacesReady:YES];
  [delegate displaySurface:AfternoteProductSurfaceConnections recoveryReady:YES];
  // setBusy dispatches asynchronously; this fixture does not run an app event loop.
  delegate.statusLabel.stringValue = @"Connections are up to date.";
  delegate.progress.hidden = YES;
  [delegate.progress stopAnimation:nil];
  delegate.authenticateButton.enabled = YES;
  NSMutableArray *results = [NSMutableArray array];
  NSArray *cases = @[
    @{ @"name": @"minimum", @"width": @900, @"height": @618, @"legacy": @NO },
    @{ @"name": @"regular", @"width": @1120, @"height": @800, @"legacy": @NO },
    @{ @"name": @"wide", @"width": @1600, @"height": @1000, @"legacy": @NO },
    @{ @"name": @"history-legacy-scrollbar", @"width": @900, @"height": @618, @"legacy": @YES },
    @{ @"name": @"setup", @"width": @1120, @"height": @800, @"legacy": @NO },
  ];
  for (NSDictionary *fixture in cases) {
    NSString *name = fixture[@"name"];
    if ([name isEqual:@"history-legacy-scrollbar"]) {
      [delegate.expandedConnectorKinds addObject:@"claude"];
      delegate.ownerExpiresAt = @"2099-01-01T00:00:00.000Z";
      delegate.auditCursor = @"synthetic-next-page";
    }
    if ([name isEqual:@"setup"]) {
      [delegate.expandedConnectorKinds removeAllObjects];
      delegate.connections = @{ @"clients": @[], @"grants": @[], @"sessions": @[] };
      for (NSString *kind in delegate.integrationStatuses.allKeys) {
        delegate.integrationStatuses[kind] = @{
          @"toolAvailable": @YES, @"installed": @NO, @"healthy": @NO,
          @"problemCode": @"connector_missing", @"repairable": @YES,
        };
      }
    }
    [delegate render];
    [delegate.window setContentSize:NSMakeSize([fixture[@"width"] doubleValue],
                                               [fixture[@"height"] doubleValue])];
    NSView *root = delegate.window.contentView;
    NSView *column = ConnectionLayoutView(root, @"ConnectionsColumn");
    NSScrollView *scroll = (NSScrollView *)ConnectionLayoutView(root, @"ConnectionsScroll");
    scroll.scrollerStyle = [fixture[@"legacy"] boolValue]
        ? NSScrollerStyleLegacy : NSScrollerStyleOverlay;
    [root layoutSubtreeIfNeeded];
    [root displayIfNeeded];
    NSRect columnFrame = [column convertRect:column.bounds toView:root];
    NSRect refreshFrame = [delegate.authenticateButton
        convertRect:delegate.authenticateButton.bounds toView:delegate.content];
    BOOL columnsAligned = YES;
    BOOL textFits = YES;
    BOOL noOverlap = YES;
    BOOL actionsReachable = YES;
    BOOL factSpacing = YES;
    BOOL repairActionPreserved = YES;
    NSUInteger repairActions = 0;
    CGFloat actionX = -1;
    for (NSView *row in delegate.content.arrangedSubviews) {
      NSView *actions = ConnectionLayoutView(row, @"ConnectionActions");
      NSView *facts = ConnectionLayoutView(row, @"ConnectionFacts");
      for (NSView *view in ((NSStackView *)actions).arrangedSubviews) {
        if (![view isKindOfClass:[AfternoteButton class]]) continue;
        AfternoteButton *button = (AfternoteButton *)view;
        if (![button.title isEqualToString:@"Repair Afternote"]) continue;
        repairActions++;
        repairActionPreserved &= button.afternoteFillColor == nil &&
            button.afternoteBorderColor == nil && !button.bordered &&
            button.afternoteHoverColor != nil && button.afternotePressedColor != nil &&
            [button.contentTintColor isEqual:AfternoteBrandCaptureColor()] &&
            button.action == @selector(installIntegration:) && button.target == delegate &&
            [button.identifier isEqualToString:@"claude-code"] &&
            [button.accessibilityLabel isEqualToString:@"Repair Afternote in Claude Code"] &&
            button.focusRingType == NSFocusRingTypeExterior;
      }
      NSRect actionFrame = [actions convertRect:actions.bounds toView:delegate.content];
      NSRect factFrame = [facts convertRect:facts.bounds toView:delegate.content];
      if (actionX < 0) actionX = NSMinX(actionFrame);
      columnsAligned &= fabs(NSMinX(actionFrame) - actionX) < 1 &&
          fabs(NSWidth(actionFrame) - kConnectionActionsWidth) < 1;
      noOverlap &= NSMaxX(factFrame) + kConnectionColumnGap <= NSMinX(actionFrame) + 1;
      textFits &= ConnectionLayoutTextFits(row);
      actionsReachable &= NSMaxX(actionFrame) <= delegate.content.bounds.size.width + 1;
      NSArray<NSView *> *factViews = ((NSStackView *)facts).arrangedSubviews;
      CGFloat gap = NSMinY(factViews[0].frame) - NSMaxY(factViews[1].frame);
      factSpacing &= fabs(gap - 12) < 1;
    }
    BOOL centered = fabs(NSMidX(columnFrame) - NSMidX(root.bounds)) < 1;
    BOOL refreshAligned = fabs(NSMaxX(refreshFrame) - delegate.content.bounds.size.width) < 1;
    BOOL gutters = NSMinX(columnFrame) >= kConnectionsPageGutter - 1 &&
        NSMaxX(columnFrame) <= NSWidth(root.bounds) - kConnectionsPageGutter + 1;
    BOOL scrollFits = scroll.frame.size.height >= 120 &&
        scroll.frame.size.height < root.bounds.size.height;
    [results addObject:@{
      @"name": name, @"centered": @(centered), @"columnsAligned": @(columnsAligned),
      @"refreshAligned": @(refreshAligned), @"gutters": @(gutters),
      @"textFits": @(textFits), @"noOverlap": @(noOverlap),
      @"actionsReachable": @(actionsReachable), @"scrollFits": @(scrollFits),
      @"columnWidth": @(columnFrame.size.width),
      @"fillsAvailableWidth": @(fabs(columnFrame.size.width -
          MIN(kConnectionsMaximumWidth, root.bounds.size.width - 2 * kConnectionsPageGutter)) < 1),
      @"factSpacing": @(factSpacing),
      @"repairActionPreserved": @(repairActionPreserved &&
          repairActions == ([name isEqualToString:@"setup"] ? 0u : 1u)),
      @"requestedSize": @(fabs(root.bounds.size.width - [fixture[@"width"] doubleValue]) < 1 &&
                            fabs(root.bounds.size.height - [fixture[@"height"] doubleValue]) < 1),
    }];
    if (previewDirectory.length > 0) {
      NSBitmapImageRep *bitmap = [root bitmapImageRepForCachingDisplayInRect:root.bounds];
      [root cacheDisplayInRect:root.bounds toBitmapImageRep:bitmap];
      NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      NSString *path = [previewDirectory stringByAppendingPathComponent:
          [name stringByAppendingPathExtension:@"png"]];
      if (![png writeToFile:path atomically:YES]) return 2;
    }
  }
  [delegate.window orderOut:nil];
  NSData *data = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return 0;
}
