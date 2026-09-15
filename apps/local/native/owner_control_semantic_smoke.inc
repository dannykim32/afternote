// Included after NotesReplyProbe in protocol-testing builds only.
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
  [delegate activateSemanticSearch:YES];
  BOOL duplicateBlocked = broker.requests.count == 1 &&
      [broker.requests[0][@"method"] isEqual:@"library.refresh_search"];
  BrokerReply first = broker.requests[0][@"reply"];
  first(@{ @"searchMode": @"hybrid" }, nil);
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
  late(@{ @"searchMode": @"hybrid" }, nil);
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
  NSDictionary *checks = @{ @"duplicateBlocked": @(duplicateBlocked), @"active": @(active),
    @"draftPreserved": @(draftPreserved), @"lockedBlocked": @(lockedBlocked),
    @"staleIgnored": @(staleIgnored), @"newSessionAllowed": @(newSessionAllowed), @"retryOffered": @(retryOffered) };
  NSData *data = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
  return 0;
}
