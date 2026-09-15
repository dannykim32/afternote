#import "semantic_settings.h"

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    NSMutableArray *requests = [NSMutableArray array];
    AfternoteSemanticSettings *view = [[AfternoteSemanticSettings alloc] initWithRunner:
        ^(NSArray *args, AfternoteSemanticCompletion completion) {
      [requests addObject:@{ @"args": args, @"reply": [completion copy] }];
    }];
    __block NSUInteger automaticActivations = 0, explicitActivations = 0;
    view.activate = ^(BOOL userInitiated) { if (userInitiated) explicitActivations++; else automaticActivations++; };
    NSDictionary *(^status)(NSString *) = ^NSDictionary *(NSString *state) {
      return @{ @"state": state, @"modelId": @"fixture-model", @"revision": @"pinned",
        @"dtype": @"q8", @"dimensions": @384, @"bytes": @23557430, @"reason": NSNull.null };
    };
    void (^reply)(NSUInteger, NSDictionary *, NSString *) = ^(NSUInteger i, NSDictionary *result, NSString *error) {
      AfternoteSemanticCompletion completion = requests[i][@"reply"];
      completion(result, error);
    };
    [view refresh]; [view refresh];
    BOOL checkOnly = requests.count == 1 && [requests[0][@"args"] isEqual:@[@"semantic", @"status"]];
    reply(0, status(@"not-installed"), nil);
    BOOL explicitInstall = automaticActivations == 0 && [view.actionButton.title isEqual:@"Install semantic search"];
    [view.actionButton performClick:nil]; [view.actionButton performClick:nil]; [view refresh];
    BOOL duplicateBlocked = requests.count == 2 && !view.actionButton.enabled &&
        [requests[1][@"args"] isEqual:@[@"semantic", @"install"]];
    reply(0, status(@"ready"), nil);
    BOOL staleIgnored = !view.actionButton.enabled && automaticActivations == 0;
    reply(1, nil, @"Network failed");
    BOOL retryOffered = view.actionButton.enabled && [view.actionButton.title isEqual:@"Retry"];
    [view.actionButton performClick:nil];
    reply(2, @{ @"state": @"ready" }, nil);
    BOOL malformedRejected = automaticActivations == 0 && [view.actionButton.title isEqual:@"Retry"];
    [view.actionButton performClick:nil];
    reply(3, status(@"ready"), nil);
    BOOL installed = automaticActivations == 1 && [view.actionButton.title isEqual:@"Activate semantic search"];
    [view.actionButton performClick:nil];
    BOOL explicitActivation = explicitActivations == 1;
    [view setSearchMode:@"indexing"];
    BOOL indexing = [view.statusLabel.stringValue containsString:@"Indexing"];
    [view setSearchMode:@"hybrid"];
    BOOL active = [view.statusLabel.stringValue containsString:@"Active in Notes and connected tools"];
    [view setSearchMode:@"checking"];
    BOOL lockedNotActive = [view.actionButton.title isEqual:@"Activate semantic search"];
    if (argc == 2) {
      [view setFrame:NSMakeRect(0, 0, 270, 100)];
      [view layoutSubtreeIfNeeded];
      NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
      [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
      [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:@(argv[1]) atomically:YES];
    }
    NSDictionary *checks = @{ @"checkOnly": @(checkOnly), @"explicitInstall": @(explicitInstall),
      @"duplicateBlocked": @(duplicateBlocked), @"staleIgnored": @(staleIgnored),
      @"retryOffered": @(retryOffered), @"malformedRejected": @(malformedRejected),
      @"installed": @(installed), @"explicitActivation": @(explicitActivation),
      @"indexing": @(indexing), @"active": @(active), @"lockedNotActive": @(lockedNotActive) };
    NSData *data = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    for (NSNumber *passed in checks.allValues) if (!passed.boolValue) return 2;
    return 0;
  }
}
