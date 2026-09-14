#import "notes_retrieval.h"

NSDictionary *SearchPage(NSString *noteId, id cursor) {
  return @{ @"results": @[@{ @"citation": @{
    @"noteId": noteId, @"revision": @7, @"excerpt": @"Fixture excerpt",
    @"source": @{ @"application": @"Claude Desktop" }, @"createdAt": @"2026-09-14T01:00:00.000Z"
  }}], @"nextCursor": cursor, @"searchMode": @"hybrid" };
}

int main() {
  @autoreleasepool {
    NSMutableDictionary *checks = [NSMutableDictionary dictionary];
    AfternoteNotesRetrieval *state = [AfternoteNotesRetrieval new];
    checks[@"initial"] = @(state.notes.count == 0 && state.query.length == 0 &&
        state.view == nil && !state.inFlight && [state beginAppending:YES] == nil);
    [state selectQuery:@"  first query\n" view:@"ignored"];
    AfternoteNotesRequest *first = [state beginAppending:NO];
    checks[@"searchRequest"] = @([first.method isEqualToString:@"library.search"] &&
        [first.params isEqual:@{ @"query": @"first query", @"limit": @20, @"cursor": NSNull.null }] &&
        state.view == nil && state.inFlight && [state beginAppending:YES] == nil);
    [state selectQuery:@"second query" view:nil];
    AfternoteNotesRequest *second = [state beginAppending:NO];
    BOOL rejected = ![state complete:first result:SearchPage(@"old", @"old-cursor") error:nil];
    checks[@"superseded"] = @(rejected && state.inFlight && state.notes.count == 0 && state.cursor == nil);
    [state complete:second result:SearchPage(@"current", @"page-two") error:nil];
    checks[@"citation"] = @([state.notes.firstObject[@"id"] isEqual:@"current"] &&
        [state.notes.firstObject[@"revision"] isEqual:@7] &&
        [state.notes.firstObject[@"resultKind"] isEqual:@"search"] &&
        [state.notes.firstObject[@"source"] isEqual:@{ @"application": @"Claude Desktop" }] &&
        [state.searchMode isEqual:@"hybrid"]);
    checks[@"duplicateCompletion"] = @(![state complete:second result:SearchPage(@"duplicate", NSNull.null) error:nil] &&
        state.notes.count == 1);
    AfternoteNotesRequest *page = [state beginAppending:YES];
    checks[@"pageRequest"] = @([page.params[@"query"] isEqual:@"second query"] &&
        [page.params[@"cursor"] isEqual:@"page-two"] && [state beginAppending:YES] == nil);
    [state complete:page result:SearchPage(@"next", NSNull.null) error:nil];
    checks[@"pagination"] = @(state.notes.count == 2 && [state.notes[0][@"id"] isEqual:@"current"] &&
        [state.notes[1][@"id"] isEqual:@"next"] && [state.notes[1][@"rank"] isEqual:@2] &&
        state.cursor == nil && [state beginAppending:YES] == nil);

    AfternoteNotesRequest *refresh = [state beginAppending:NO];
    checks[@"refreshReplaces"] = @(state.notes.count == 0 && refresh.params[@"cursor"] == NSNull.null);
    [state complete:refresh result:SearchPage(@"refreshed", @"retry-cursor") error:nil];
    page = [state beginAppending:YES];
    NSDictionary *error = @{ @"code": @"fixture-error" };
    BOOL errorAccepted = [state complete:page result:nil error:error];
    checks[@"appendErrorRetry"] = @(errorAccepted && !state.inFlight && state.notes.count == 1 &&
        [state.cursor isEqual:@"retry-cursor"]);
    page = [state beginAppending:YES];
    [state cancelPendingRequest];
    checks[@"navigationCancellation"] = @(!state.inFlight && state.notes.count == 1 &&
        [state.query isEqual:@"second query"] && ![state complete:page result:nil error:error]);

    [state selectQuery:@" \n" view:@"decisions"];
    AfternoteNotesRequest *browse = [state beginAppending:NO];
    checks[@"browseRequest"] = @([browse.method isEqual:@"library.browse"] &&
        [browse.params isEqual:@{ @"view": @"decisions", @"limit": @20, @"cursor": NSNull.null }] &&
        state.notes.count == 0 && state.query.length == 0);
    [state complete:browse result:@{ @"notes": @[@{ @"id": @"browse-note", @"revision": @8 }],
                                    @"nextCursor": @"browse-page" } error:nil];
    checks[@"browseResult"] = @(state.notes.firstObject[@"resultKind"] == nil &&
        [state.notes.firstObject[@"revision"] isEqual:@8]);
    page = [state beginAppending:YES];
    [state selectQuery:@"new search" view:nil];
    first = [state beginAppending:NO];
    checks[@"cursorIsolation"] = @(![state complete:page result:SearchPage(@"wrong-page", @"bad") error:nil] &&
        first.params[@"cursor"] == NSNull.null && state.notes.count == 0);
    [state clear];
    BOOL lateSuccess = [state complete:first result:SearchPage(@"late-private-note", @"private-cursor") error:nil];
    BOOL lateError = [state complete:first result:nil error:error];
    checks[@"clearRejectsLateReplies"] = @(!lateSuccess && !lateError && !state.inFlight &&
        state.notes.count == 0 && state.query.length == 0 && state.view == nil &&
        state.cursor == nil && state.searchMode == nil);
    browse = [state beginAppending:NO];
    checks[@"freshSession"] = @(browse.params[@"view"] == NSNull.null &&
        ![state complete:first result:SearchPage(@"stale-after-reopen", NSNull.null) error:nil] && state.inFlight);
    AfternoteNotesRetrieval *other = [AfternoteNotesRetrieval new];
    AfternoteNotesRequest *foreign = [other beginAppending:NO];
    checks[@"foreignRequest"] = @(![state complete:foreign result:@{} error:nil] && state.inFlight);
    [state complete:browse result:@{ @"notes": @[], @"nextCursor": NSNull.null } error:nil];
    checks[@"emptyResults"] = @(state.notes.count == 0 && !state.inFlight && state.cursor == nil);
    NSData *output = [NSJSONSerialization dataWithJSONObject:checks options:NSJSONWritingSortedKeys error:nil];
    fwrite(output.bytes, 1, output.length, stdout);
    fputc('\n', stdout);
    for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
    return 0;
  }
}
