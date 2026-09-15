// Protocol-test target only. Fake the OS command/XPC boundaries, not app state logic.
typedef void (^IntegrationCommandCompletion)(NSDictionary *, NSString *);
@interface ReconnectCommandProbe : OwnerControlDelegate
@property(nonatomic, copy) IntegrationCommandCompletion prepareReply;
@property(nonatomic) NSUInteger prepareCount;
@end
@implementation ReconnectCommandProbe
- (void)runPackagedCommand:(NSArray<NSString *> *)arguments
               completion:(IntegrationCommandCompletion)completion {
  if ([arguments.lastObject isEqualToString:@"prepare-reconnect"]) {
    self.prepareCount += 1;
    self.prepareReply = completion;
  } else {
    completion(@{@"toolAvailable":@YES, @"installed":@YES, @"healthy":@YES}, nil);
  }
}
@end

NSDictionary *ReconnectOverview(NSString *status) {
  return @{@"connectors":@[@{@"kind":@"codex", @"status":status, @"activeScopes":@[],
    @"lastActivityAt":NSNull.null, @"savedCount":@0, @"readCount":@0, @"verifiedRoundTrip":@NO}]};
}

int RunReconnectCoordinatorSmoke() {
  [NSApplication sharedApplication].activationPolicy = NSApplicationActivationPolicyProhibited;
  ReconnectCommandProbe *delegate = [ReconnectCommandProbe new];
  delegate.integrationStatuses = [@{@"codex":@{@"toolAvailable":@YES, @"installed":@YES, @"healthy":@YES}} mutableCopy];
  delegate.integrationOperations = [NSMutableSet set];
  delegate.integrationStatusGenerations = [NSMutableDictionary dictionary];
  delegate.connectorOverviewByKind = AfternoteConnectorOverviewByKind(ReconnectOverview(@"revoked"));
  delegate.auditEvents = [NSMutableArray array];
  delegate.revocationTargets = [NSMutableDictionary dictionary];
  delegate.expandedConnectorKinds = [NSMutableSet set];
  delegate.setupGuideDismissed = YES;
  [delegate buildWindow];
  NotesReplyProbe *broker = [NotesReplyProbe new];
  delegate.broker = broker;
  NSButton *sender = [NSButton new];
  sender.identifier = @"codex";
  [delegate reconnectIntegration:sender];
  delegate.prepareReply(@{@"rotated":@YES}, nil);
  if (delegate.window.attachedSheet) [delegate.window endSheet:delegate.window.attachedSheet];
  BOOL requestedOverview = [broker.requests.lastObject[@"method"] isEqualToString:@"owner.connector_overview"];
  [delegate reconnectIntegration:sender];
  BOOL duplicateBlocked = delegate.prepareCount == 1;
  BOOL staleOverviewIgnored = NO;
  BOOL failedRefreshBlocked = YES;
  BOOL invalidRefreshBlocked = YES;
  if (requestedOverview) {
    for (NSNumber *invalid in @[@NO, @YES]) {
      BrokerReply failedReply = broker.requests.lastObject[@"reply"];
      failedReply(invalid.boolValue ? @{} : nil,
          invalid.boolValue ? nil : @{@"message":@"Temporary overview failure"});
      __block BOOL failureHandled = NO;
      dispatch_async(dispatch_get_main_queue(), ^{ failureHandled = YES; });
      NSDate *failureDeadline = [NSDate dateWithTimeIntervalSinceNow:0.5];
      while (!failureHandled && failureDeadline.timeIntervalSinceNow > 0)
        [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
      AfternoteConnectionRow *failedRow = [delegate connectorRowForCommandKind:@"codex" brokerKind:@"codex"
          displayName:@"Codex" clients:@[] grants:@[]];
      [delegate reconnectIntegration:sender];
      BOOL blocked = failureHandled && [delegate.integrationOperations containsObject:@"codex"] && delegate.prepareCount == 1 &&
          failedRow.presentation.action == AfternoteConnectorActionCheckAgain;
      [delegate refreshConnections:nil];
      blocked = blocked && [delegate.integrationOperations containsObject:@"codex"];
      if (invalid.boolValue) invalidRefreshBlocked = blocked;
      else failedRefreshBlocked = blocked;
    }
    BrokerReply staleReply = broker.requests.lastObject[@"reply"];
    [delegate refreshConnections:nil];
    staleReply(ReconnectOverview(@"revoked"), nil);
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.03]];
    staleOverviewIgnored = [delegate.integrationOperations containsObject:@"codex"];
    BrokerReply reply = broker.requests.lastObject[@"reply"];
    reply(ReconnectOverview(@"reconnect-prepared"), nil);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.5];
    while ([delegate.integrationOperations containsObject:@"codex"] && deadline.timeIntervalSinceNow > 0)
      [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  AfternoteConnectionRow *row = [delegate connectorRowForCommandKind:@"codex" brokerKind:@"codex"
      displayName:@"Codex" clients:@[] grants:@[]];
  BOOL prepared = [row.presentation.connectionTitle isEqualToString:@"Reconnect prepared"] &&
      row.presentation.action == AfternoteConnectorActionNone;
  BOOL finished = ![delegate.integrationOperations containsObject:@"codex"];
  [delegate reconnectIntegration:sender];
  BOOL preparedRetryBlocked = delegate.prepareCount == 1;
  NSDictionary *checks = @{@"requestedOverview":@(requestedOverview), @"duplicateBlocked":@(duplicateBlocked),
    @"prepared":@(prepared), @"finished":@(finished), @"preparedRetryBlocked":@(preparedRetryBlocked),
    @"staleOverviewIgnored":@(staleOverviewIgnored), @"failedRefreshBlocked":@(failedRefreshBlocked),
    @"invalidRefreshBlocked":@(invalidRefreshBlocked)};
  NSData *data = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
  return 0;
}
