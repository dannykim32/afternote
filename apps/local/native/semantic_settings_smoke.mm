#import "semantic_settings.h"

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSMutableArray *requests = [NSMutableArray array];
    AfternoteSemanticSettings *view = [[AfternoteSemanticSettings alloc] initWithRunner:
        ^(NSArray *args, AfternoteSemanticCompletion completion) {
      [requests addObject:@{ @"args": args, @"reply": [completion copy] }];
    }];
    __block NSUInteger automaticActivations = 0, explicitActivations = 0;
    view.activate = ^(BOOL userInitiated) { if (userInitiated) explicitActivations++; else automaticActivations++; };
    NSDictionary *(^catalog)(void) = ^NSDictionary * {
      NSMutableArray *models = [NSMutableArray array];
      for (NSString *key in @[@"light", @"balanced", @"large"])
        [models addObject:@{ @"key":key, @"name":key, @"modelId":[key stringByAppendingString:@":q8"],
          @"downloadBytes":@23000000, @"state":@"not-installed" }];
      return @{ @"selected":@"balanced", @"recommended":@"balanced", @"memoryGiB":@16, @"models":models };
    };
    NSDictionary *(^status)(NSString *) = ^NSDictionary *(NSString *key) {
      return @{ @"state":@"ready", @"profile":key, @"modelId":key, @"revision":@"pinned",
        @"dtype":@"q8", @"dimensions":@384, @"bytes":@23000000, @"reason":NSNull.null };
    };
    void (^reply)(NSUInteger, NSDictionary *, NSString *) = ^(NSUInteger i, NSDictionary *result, NSString *error) {
      AfternoteSemanticCompletion completion = requests[i][@"reply"]; completion(result, error);
    };
    [view refresh]; [view refresh];
    BOOL checkOnly = requests.count == 1 && [requests[0][@"args"] isEqual:@[@"semantic", @"catalog"]];
    reply(0, catalog(), nil);
    BOOL explicitInstall = automaticActivations == 0 && [view.actionButton.title isEqual:@"Enable search by meaning"];
    [view.actionButton performClick:nil]; [view.actionButton performClick:nil]; [view refresh];
    BOOL duplicateBlocked = requests.count == 2 && !view.actionButton.enabled &&
        [requests[1][@"args"] isEqual:@[@"semantic", @"install", @"balanced"]];
    reply(0, catalog(), nil);
    BOOL staleIgnored = !view.actionButton.enabled && automaticActivations == 0;
    reply(1, nil, @"Network failed");
    BOOL retryOffered = view.actionButton.enabled && [view.actionButton.title isEqual:@"Retry"];
    [view setSearchMode:@"hybrid"];
    BOOL failureSurvivesSearch = [view.actionButton.title isEqual:@"Retry"];
    [view refresh]; reply(2, catalog(), nil);
    BOOL failureSurvivesNavigation = [view.actionButton.title isEqual:@"Retry"] &&
        [view.statusLabel.stringValue containsString:@"Installation failed"];
    [view.actionButton performClick:nil]; reply(3, @{ @"state":@"ready" }, nil);
    BOOL malformedRejected = automaticActivations == 0 && [view.actionButton.title isEqual:@"Retry"];
    [view.actionButton performClick:nil]; reply(4, status(@"balanced"), nil);
    BOOL installed = automaticActivations == 1 && [view.actionButton.title isEqual:@"Activate search"];
    [view.actionButton performClick:nil];
    BOOL explicitActivation = explicitActivations == 1;
    [view setIndexedNotes:32 total:100];
    [view activationCompleted:@"indexing" modelId:@"balanced:q8"];
    BOOL indexing = [view.statusLabel.stringValue containsString:@"Indexing 32 of 100"];
    [view activationCompleted:@"hybrid" modelId:@"balanced:q8"];
    BOOL active = [view.statusLabel.stringValue containsString:@"Active in Notes and connected tools"];
    BOOL oneSearchEngine = ![view respondsToSelector:NSSelectorFromString(@"modelMenu")];
    [view activationFailed];
    [view.actionButton performClick:nil];
    BOOL activationRetryDoesNotDownload = requests.count == 5 && explicitActivations == 2;
    [view activationCompleted:@"hybrid" modelId:@"large:q8"];
    BOOL oldModelNotActive = [view.actionButton.title isEqual:@"Activate search"];
    [view activationCompleted:@"hybrid" modelId:@"balanced:q8"];
    [view setSearchMode:@"checking"];
    BOOL lockedNotActive = [view.actionButton.title isEqual:@"Activate search"];
    NSDictionary *checks = @{ @"checkOnly":@(checkOnly), @"explicitInstall":@(explicitInstall),
      @"duplicateBlocked":@(duplicateBlocked), @"staleIgnored":@(staleIgnored),
      @"failureSurvivesSearch":@(failureSurvivesSearch), @"failureSurvivesNavigation":@(failureSurvivesNavigation),
      @"retryOffered":@(retryOffered), @"malformedRejected":@(malformedRejected),
      @"installed":@(installed), @"explicitActivation":@(explicitActivation),
      @"indexing":@(indexing), @"active":@(active), @"lockedNotActive":@(lockedNotActive),
      @"activationRetryDoesNotDownload":@(activationRetryDoesNotDownload), @"oneSearchEngine":@(oneSearchEngine), @"oldModelNotActive":@(oldModelNotActive) };
    NSData *data = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
    return 0;
  }
}
