// Included only in protocol-testing builds, after the app coordinator.
@interface NotesReplyProbe : NSObject <AfternoteOwnerBroker>
@property(nonatomic, copy) void (^disconnectHandler)(void);
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *requests;
@end
@implementation NotesReplyProbe
- (instancetype)init {
  self = [super init];
  if (self) _requests = [NSMutableArray array];
  return self;
}
- (void)requestMethod:(NSString *)method params:(NSDictionary *)params reply:(BrokerReply)reply {
  [self.requests addObject:@{ @"method": method, @"params": params, @"reply": [reply copy] }];
}
- (void)replaceConnection {}
- (void)requestLifecycleTransitionMethod:(NSString *)method reply:(BrokerReply)reply {
  [self requestMethod:method params:@{} reply:reply];
}
@end

int RunNotesRetrievalCoordinatorSmoke() {
  [NSApplication sharedApplication];
  OwnerControlDelegate *delegate = [OwnerControlDelegate new];
  [delegate buildWindow];
  NotesReplyProbe *broker = [NotesReplyProbe new];
  delegate.broker = broker;
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  [delegate.noteEditorView displayNote:@{ @"id": @"draft-note", @"revision": @1, @"content": @"Saved" }
                             creating:NO inspectingCitation:NO];
  [delegate.noteEditorView restoreDraft:@"Unsaved editor draft"];
  void (^reply)(NSUInteger, NSDictionary *, NSDictionary *) = ^(NSUInteger index, NSDictionary *result, NSDictionary *error) {
    BrokerReply completion = broker.requests[index][@"reply"];
    completion(result, error);
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  };
  NSDictionary *(^page)(NSString *) = ^NSDictionary *(NSString *noteId) {
    return @{ @"results": @[@{ @"citation": @{
      @"noteId": noteId, @"revision": @7, @"excerpt": @"Frozen result", @"createdAt": @"2026-09-14T01:00:00.000Z"
    }}], @"nextCursor": @"next-page", @"searchMode": @"exact" };
  };
  delegate.librarySearch.stringValue = @"first query";
  [delegate searchLibrary:nil];
  delegate.librarySearch.stringValue = @"second query";
  [delegate searchLibrary:nil];
  delegate.librarySearch.stringValue = @"An unsent search draft";
  reply(0, page(@"stale-note"), nil);
  BOOL staleIgnored = delegate.notesRetrieval.inFlight && delegate.notesRetrieval.notes.count == 0;
  reply(1, page(@"current-note"), nil);
  BOOL currentApplied = [delegate.notesRetrieval.notes.firstObject[@"id"] isEqual:@"current-note"] &&
      [delegate.notesRetrieval.notes.firstObject[@"revision"] isEqual:@7] && !delegate.notesRetrieval.inFlight;
  BOOL draftsPreserved = [delegate.librarySearch.stringValue isEqual:@"An unsent search draft"] &&
      [delegate.noteEditorView.draft isEqual:@"Unsaved editor draft"];
  [delegate loadLibraryNotes:YES];
  [delegate loadLibraryNotes:YES];
  BOOL onePageRequest = broker.requests.count == 3 &&
      [broker.requests[2][@"params"][@"query"] isEqual:@"second query"] &&
      [broker.requests[2][@"params"][@"cursor"] isEqual:@"next-page"];
  [delegate clearLibraryPlaintext:@"Locked fixture"];
  reply(2, page(@"late-private-note"), nil);
  BOOL lockCleared = delegate.notesRetrieval.notes.count == 0 && delegate.notesRetrieval.query.length == 0 &&
      delegate.noteEditorView.draft.length == 0 && delegate.librarySearch.stringValue.length == 0 &&
      [delegate.libraryStatusLabel.stringValue isEqual:@"Locked fixture"];
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  delegate.librarySearch.stringValue = @"new session";
  [delegate searchLibrary:nil];
  reply(2, nil, @{ @"code": @"library_session_expired" });
  BOOL staleErrorIgnored = delegate.notesRetrieval.inFlight && delegate.libraryExpiresAt.length > 0;
  reply(3, page(@"new-session-note"), nil);
  BOOL freshSession = [delegate.notesRetrieval.notes.firstObject[@"id"] isEqual:@"new-session-note"];
  NSDictionary *checks = @{ @"staleIgnored": @(staleIgnored), @"currentApplied": @(currentApplied),
    @"draftsPreserved": @(draftsPreserved), @"onePageRequest": @(onePageRequest),
    @"lockCleared": @(lockCleared), @"staleErrorIgnored": @(staleErrorIgnored), @"freshSession": @(freshSession) };
  NSData *data = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  [delegate clearLibraryPlaintext:@"Test complete"];
  for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
  return 0;
}
