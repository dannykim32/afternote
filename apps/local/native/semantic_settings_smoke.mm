#import "semantic_settings.h"
int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSMutableArray *requests = [NSMutableArray array];
    AfternoteSemanticSettings *view = [[AfternoteSemanticSettings alloc] initWithRunner:
        ^(NSArray *args, AfternoteSemanticCompletion completion) {
      [requests addObject:@{@"args":args, @"reply":[completion copy]}];
    }];
    __block NSUInteger automatic = 0, explicitActivations = 0;
    view.activate = ^(BOOL user) { if (user) explicitActivations++; else automatic++; };
    NSDictionary *(^catalog)(BOOL) = ^NSDictionary *(BOOL enabled) {
      return @{@"enabled":@(enabled), @"models":@[@{@"key":@"balanced", @"modelId":@"fixture:q4", @"state":@"ready"}]};
    };
    void (^reply)(NSUInteger, NSDictionary *, NSString *) = ^(NSUInteger i, NSDictionary *result, NSString *error) {
      AfternoteSemanticCompletion completion = requests[i][@"reply"]; completion(result, error);
    };
    [view refresh]; [view refresh];
    BOOL checkOnly = requests.count == 1 && !view.toggleButton.enabled && [requests[0][@"args"] isEqual:@[@"semantic", @"catalog"]];
    reply(0, catalog(YES), nil);
    BOOL defaultOn = automatic == 1 && view.toggleButton.state == NSControlStateValueOn && view.toggleButton.enabled;
    [view activationCompleted:@"indexing" modelId:@"fixture:q4"];
    BOOL preparing = [view.statusLabel.stringValue containsString:@"Preparing local search"];
    [view setIndexedNotes:2 total:3]; [view activationCompleted:@"indexing" modelId:@"fixture:q4"];
    BOOL indexing = [view.statusLabel.stringValue containsString:@"2 of 3"] && !view.indexProgress.hidden &&
        !view.indexProgress.indeterminate && fabs(view.indexProgress.doubleValue - 2.0 / 3.0) < 0.001;
    [view activationCompleted:@"hybrid" modelId:@"fixture:q4"];
    BOOL active = [view.statusLabel.stringValue containsString:@"Ready in Notes"] && view.indexProgress.hidden;
    [view.toggleButton performClick:nil]; [view.toggleButton performClick:nil]; [view refresh];
    BOOL duplicateBlocked = requests.count == 2 && !view.toggleButton.enabled && [requests[1][@"args"] isEqual:@[@"semantic", @"disable"]];
    reply(0, catalog(YES), nil);
    BOOL staleIgnored = !view.toggleButton.enabled;
    reply(1, catalog(NO), nil);
    BOOL disableApplied = explicitActivations == 1 && view.toggleButton.state == NSControlStateValueOff && [view.statusLabel.stringValue containsString:@"Open Notes to apply"];
    [view activationCompleted:@"exact" modelId:@""];
    BOOL exact = [view.statusLabel.stringValue containsString:@"Off."];
    [view.toggleButton performClick:nil]; reply(2, nil, @"Failed");
    BOOL failure = !view.actionButton.hidden && view.toggleButton.state == NSControlStateValueOff;
    [view.actionButton performClick:nil]; reply(3, @{}, nil);
    BOOL malformedRejected = !view.actionButton.hidden && explicitActivations == 1;
    [view.actionButton performClick:nil]; reply(4, catalog(YES), nil);
    [view activationFailed]; [view.actionButton performClick:nil];
    BOOL retryActivation = requests.count == 5 && explicitActivations == 2 && [view.statusLabel.stringValue containsString:@"Could not activate"];
    [view activationCompleted:@"hybrid" modelId:@"fixture:q4"];
    BOOL recovered = view.actionButton.hidden && [view.statusLabel.stringValue containsString:@"Ready"];
    [view setSearchMode:@"checking"];
    BOOL lockedNotActive = [view.statusLabel.stringValue containsString:@"opens"] || [view.statusLabel.stringValue containsString:@"open your vault"];
    [view.toggleButton performClick:nil]; reply(5, catalog(NO), nil);
    BOOL pendingWithoutSession = [view.statusLabel.stringValue containsString:@"Open Notes to apply"];
    AfternoteSemanticSettings *reopened = [[AfternoteSemanticSettings alloc] initWithRunner:
        ^(NSArray *args, AfternoteSemanticCompletion completion) { completion(catalog(NO), nil); }];
    [reopened refresh]; [reopened refresh];
    BOOL reopenedPending = [reopened.statusLabel.stringValue containsString:@"Open Notes to apply"];
    [reopened activationCompleted:@"exact" modelId:@""];
    reopenedPending = reopenedPending && [reopened.statusLabel.stringValue containsString:@"Off."];
    BOOL noDownloads = YES;
    for (NSDictionary *request in requests) if ([request[@"args"] containsObject:@"install"]) noDownloads = NO;
    AfternoteSearchProgress *progress = [AfternoteSearchProgress new];
    [progress updateMode:@"indexing" indexed:7 total:15 stalled:NO unavailable:NO];
    BOOL visibleProgress = !progress.progressBar.hidden && !progress.progressBar.indeterminate &&
        [progress.countLabel.stringValue isEqual:@"7 of 15 notes"] && fabs(progress.progressBar.doubleValue - 7.0 / 15.0) < 0.001;
    [progress updateMode:@"indexing" indexed:7 total:15 stalled:YES unavailable:NO];
    BOOL stalled = !progress.retryButton.hidden && [progress.titleLabel.stringValue containsString:@"longer than expected"];
    [progress updateMode:@"indexing" indexed:7 total:15 stalled:NO unavailable:YES];
    BOOL unavailable = !progress.retryButton.hidden && progress.progressBar.hidden && [progress.titleLabel.stringValue containsString:@"unavailable"];
    [progress updateMode:@"hybrid" indexed:15 total:15 stalled:NO unavailable:NO];
    BOOL readyPresentation = progress.progressBar.hidden && progress.detailLabel.hidden && progress.retryButton.hidden &&
        [progress.titleLabel.stringValue isEqual:@"Search by meaning ready"];
    [progress updateMode:@"checking" indexed:-1 total:-1 stalled:NO unavailable:NO];
    BOOL clearedProgress = progress.progressBar.hidden && [progress.countLabel.stringValue isEqual:@"Private to this Mac"];
    NSDictionary *checks = @{@"visibleProgress":@(visibleProgress), @"stalled":@(stalled), @"unavailable":@(unavailable),
      @"readyPresentation":@(readyPresentation), @"clearedProgress":@(clearedProgress),
      @"reopenedPending":@(reopenedPending), @"pendingWithoutSession":@(pendingWithoutSession), @"checkOnly":@(checkOnly), @"defaultOn":@(defaultOn), @"preparing":@(preparing),
      @"indexing":@(indexing), @"active":@(active), @"duplicateBlocked":@(duplicateBlocked), @"staleIgnored":@(staleIgnored),
      @"disableApplied":@(disableApplied), @"exact":@(exact), @"failure":@(failure), @"malformedRejected":@(malformedRejected),
      @"retryActivation":@(retryActivation), @"recovered":@(recovered), @"lockedNotActive":@(lockedNotActive), @"noDownloads":@(noDownloads)};
    NSData *data = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
    return 0;
  }
}
