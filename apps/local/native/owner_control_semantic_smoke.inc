// Included after NotesReplyProbe in protocol-testing builds only.
int RunSemanticProgressSmoke() {
  [NSApplication sharedApplication];
  OwnerControlDelegate *delegate = [OwnerControlDelegate new];
  [delegate buildWindow];
  NotesReplyProbe *broker = [NotesReplyProbe new];
  delegate.broker = broker;
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  [delegate applySearchMode:@"hybrid"];
  delegate.librarySearch.stringValue = @"fixture query";
  [delegate searchLibrary:nil];
  BrokerReply search = broker.requests[0][@"reply"];
  search(@{ @"results": @[], @"nextCursor": NSNull.null, @"searchMode": @"indexing" }, nil);
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2.5];
  while (broker.requests.count < 2 && deadline.timeIntervalSinceNow > 0)
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
  BOOL polling = broker.requests.count == 2 &&
      [broker.requests[1][@"method"] isEqual:@"library.refresh_search"] &&
      [broker.requests[1][@"params"][@"reloadModel"] isEqual:@NO];
  void (^drain)(void) = ^{
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.03]];
  };
  if (!polling) return 3;
  BrokerReply status = broker.requests[1][@"reply"];
  status(@{ @"searchMode": @"indexing", @"modelId": @"fixture:q4", @"indexedNotes": @3, @"totalNotes": @15 }, nil);
  drain();
  BOOL counts = [delegate.searchProgress.countLabel.stringValue isEqual:@"3 of 15 notes"] &&
      !delegate.searchProgress.progressBar.hidden && !delegate.searchProgress.progressBar.indeterminate;
  [delegate applySearchMode:@"indexing"];
  BOOL deduplicated = broker.requests.count == 2 && delegate.semanticPollPending;
  delegate.semanticLastProgressAt = NSProcessInfo.processInfo.systemUptime - 61;
  [delegate renderSemanticProgress];
  BOOL stalled = [delegate.searchProgress.titleLabel.stringValue containsString:@"longer than expected"] &&
      !delegate.searchProgress.retryButton.hidden;
  for (NSUInteger attempt = 0; attempt < 3; attempt++) {
    [delegate refreshSemanticSearch:NO userInitiated:NO];
    BrokerReply failure = broker.requests.lastObject[@"reply"];
    failure(nil, @{ @"code": @"internal_error", @"message": @"Fixture status failure" });
    drain();
  }
  BOOL failureVisible = [delegate.searchProgress.titleLabel.stringValue isEqual:@"Search status unavailable"] &&
      !delegate.searchProgress.retryButton.hidden && delegate.searchProgress.progressBar.hidden &&
      [delegate.semanticSettings.statusLabel.stringValue containsString:@"Search status unavailable"] &&
      [delegate.semanticSettings.actionButton.title isEqual:@"Check again"];
  BOOL retriesBounded = delegate.semanticStatusFailures == 3 && !delegate.semanticPollPending;
  [delegate.semanticSettings.actionButton performClick:nil];
  BOOL statusOnlyRetry = [broker.requests.lastObject[@"params"][@"reloadModel"] isEqual:@NO];
  BrokerReply retry = broker.requests.lastObject[@"reply"];
  retry(@{ @"searchMode": @"hybrid", @"modelId": @"fixture:q4", @"indexedNotes": @15, @"totalNotes": @15 }, nil);
  drain();
  BOOL ready = [delegate.currentSearchMode isEqual:@"hybrid"] && delegate.searchProgress.progressBar.hidden &&
      delegate.searchProgress.detailLabel.hidden && delegate.semanticStatusFailures == 0;
  NSUInteger completedRequests = broker.requests.count;
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:2.1]];
  BOOL stopped = broker.requests.count == completedRequests && !delegate.semanticPollPending;
  [delegate applySearchMode:@"indexing"];
  [delegate clearLibraryPlaintext:@"Test complete"];
  BOOL cleared = !delegate.semanticPollPending && delegate.semanticIndexedNotes == -1 &&
      delegate.searchProgress.progressBar.hidden && [delegate.searchProgress.countLabel.stringValue isEqual:@"Private to this Mac"];
  NSDictionary *checks = @{ @"pollingAfterSearch": @(polling), @"readyWithoutNavigation": @(ready),
      @"counts": @(counts), @"deduplicated": @(deduplicated), @"stalled": @(stalled),
      @"failureVisible": @(failureVisible), @"retriesBounded": @(retriesBounded), @"stopped": @(stopped), @"cleared": @(cleared), @"statusOnlyRetry": @(statusOnlyRetry) };
  NSData *data = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
  return 0;
}

void DrainSemanticReplies() {
  __block BOOL drained = NO;
  dispatch_async(dispatch_get_main_queue(), ^{ drained = YES; });
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.5];
  while (!drained && deadline.timeIntervalSinceNow > 0)
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
}
int RunSemanticCoordinatorSmoke() {
  [NSApplication sharedApplication];
  OwnerControlDelegate *delegate = [OwnerControlDelegate new];
  [delegate buildWindow];
  NotesReplyProbe *broker = [NotesReplyProbe new];
  delegate.broker = broker;
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  [delegate.noteEditorView displayNote:@{ @"id": @"draft-note", @"revision": @1, @"content": @"Saved" }
                             creating:NO inspectingCitation:NO];
  [delegate.noteEditorView restoreDraft:@"Unsaved semantic activation draft"];
  [delegate activateSemanticSearch:NO];
  [delegate refreshSemanticSearch:NO userInitiated:NO];
  BOOL duplicateBlocked = broker.requests.count == 1 &&
      [broker.requests[0][@"method"] isEqual:@"library.refresh_search"];
  BrokerReply first = broker.requests[0][@"reply"];
  first(@{ @"searchMode": @"hybrid", @"modelId": @"fixture:q8" }, nil);
  DrainSemanticReplies();
  BOOL active = [delegate.currentSearchMode isEqual:@"hybrid"];
  BOOL draftPreserved = [delegate.noteEditorView.draft isEqual:@"Unsaved semantic activation draft"];
  [delegate activateSemanticSearch:NO];
  if (broker.requests.count < 2) return 3;
  BrokerReply late = broker.requests[1][@"reply"];
  [delegate clearLibraryPlaintext:@"Locked fixture"];
  delegate.vaultLocked = YES;
  [delegate activateSemanticSearch:NO];
  BOOL lockedBlocked = broker.requests.count == 2;
  late(@{ @"searchMode": @"hybrid", @"modelId": @"fixture:q8" }, nil);
  DrainSemanticReplies();
  BOOL staleIgnored = ![delegate.currentSearchMode isEqual:@"hybrid"] && !delegate.semanticActivationInFlight;
  delegate.vaultLocked = NO;
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  [delegate activateSemanticSearch:NO];
  BOOL newSessionAllowed = broker.requests.count == 3;
  BrokerReply current = broker.requests[2][@"reply"];
  current(nil, @{ @"code": @"library_session_expired" });
  DrainSemanticReplies();
  BOOL retryOffered = !delegate.semanticActivationInFlight &&
      [delegate.semanticSettings.statusLabel.stringValue containsString:@"Could not activate"];
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  [delegate refreshSemanticSearch:NO userInitiated:NO];
  [delegate activateSemanticSearch:NO];
  BrokerReply oldPoll = broker.requests[3][@"reply"];
  oldPoll(@{ @"searchMode":@"hybrid", @"modelId":@"old:q8" }, nil);
  DrainSemanticReplies();
  BOOL reloadQueued = broker.requests.count == 5 && delegate.semanticActivationInFlight &&
      [broker.requests[4][@"params"][@"reloadModel"] boolValue];
  BrokerReply reload = broker.requests[4][@"reply"];
  reload(@{ @"searchMode":@"hybrid", @"modelId":@"new:q8" }, nil);
  DrainSemanticReplies();
  reloadQueued = reloadQueued && !delegate.semanticActivationInFlight;
  NSDictionary *checks = @{ @"duplicateBlocked": @(duplicateBlocked), @"active": @(active),
    @"draftPreserved": @(draftPreserved), @"lockedBlocked": @(lockedBlocked),
    @"staleIgnored": @(staleIgnored), @"newSessionAllowed": @(newSessionAllowed), @"retryOffered": @(retryOffered), @"reloadQueued": @(reloadQueued) };
  NSData *data = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
  return 0;
}
