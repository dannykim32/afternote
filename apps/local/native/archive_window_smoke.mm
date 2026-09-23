#import "archive_window.h"

@interface ArchiveFixtureBroker : NSObject <AfternoteOwnerBroker>
@property(nonatomic, copy) void (^disconnectHandler)(void);
@property(nonatomic, strong) NSMutableArray *requests;
@end
@implementation ArchiveFixtureBroker
- (instancetype)init { if ((self = [super init])) self.requests = [NSMutableArray array]; return self; }
- (void)requestMethod:(NSString *)method params:(NSDictionary *)params reply:(BrokerReply)reply {
  [self.requests addObject:@{ @"method": method, @"params": params, @"reply": [reply copy] }];
}
- (void)replaceConnection {}
- (void)requestLifecycleTransitionMethod:(NSString *)method reply:(BrokerReply)reply {}
@end

static void Drain() {
  [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.03]];
}
static void Reply(NSDictionary *request, NSDictionary *result) {
  BrokerReply reply = request[@"reply"]; reply(result, nil); Drain();
}
static void Action(id object, NSString *name) {
  [NSApp sendAction:NSSelectorFromString(name) to:object from:nil];
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    AfternoteArchiveWindow *window = [AfternoteArchiveWindow new];
    ArchiveFixtureBroker *broker = [ArchiveFixtureBroker new]; window.broker = broker;
    NSMutableDictionary *checks = [NSMutableDictionary dictionary];
    NSString *identifier = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    NSDictionary *archive = @{ @"id": identifier, @"title": @"Product research · September", @"state": @"ready" };
    NSDictionary *list = @{ @"archives": @[ archive ], @"nextCursor": NSNull.null };
    [window openAuthenticated:YES];
    NSDictionary *lateList = broker.requests.lastObject;
    [window clearPlaintext:@"Vault locked"];
    Reply(lateList, list);
    checks[@"staleListIgnored"] = @([[window valueForKey:@"rows"] count] == 0);
    [window openAuthenticated:YES]; Reply(broker.requests.lastObject, list);
    NSTableView *table = [window valueForKey:@"table"];
    [table selectRowIndexes:[NSIndexSet indexSetWithIndex:0] byExtendingSelection:NO]; Drain();
    NSDictionary *read = broker.requests.lastObject;
    checks[@"boundedRead"] = @([read[@"method"] isEqual:@"library.archive_read"] && [read[@"params"] isEqual:@{ @"id": identifier, @"startIndex": @0, @"limit": @2 }]);
    NSDictionary *page = @{ @"passages": @[ @{ @"archiveId": identifier, @"index": @0,
      @"text": @"User: What did we learn from the onboarding interviews?\n\nAssistant: Three people could not find the first import action.\n\nUser: Keep the import action visible. Show paused work explicitly so a failed upload never looks like a saved transcript.\n\nAssistant: We can preserve the original text and retrieve only the passages needed for the next question." } ], @"nextIndex": @2 };
    Reply(read, page);
    NSTextView *reader = [window valueForKey:@"reader"];
    checks[@"readOnly"] = @(!reader.editable && !reader.richText && reader.string.length > 0);
    if (argc == 2) {
      NSString *directory = [NSString stringWithUTF8String:argv[1]];
      for (NSNumber *width in @[ @820, @980, @1280 ]) {
        [window.window setContentSize:NSMakeSize(width.doubleValue, 720)];
        [window.window.contentView layoutSubtreeIfNeeded]; Drain();
        NSView *view = window.window.contentView;
        NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
        [view.effectiveAppearance performAsCurrentDrawingAppearance:^{
          [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
        }];
        [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
          writeToFile:[directory stringByAppendingPathComponent:[NSString stringWithFormat:@"archives-%@.png", width]] atomically:YES];
      }
    }
    Action(window, @"next:");
    checks[@"nextPage"] = @([broker.requests.lastObject[@"params"][@"startIndex"] isEqual:@2]);
    NSDictionary *lateRead = broker.requests.lastObject;
    NSSearchField *query = [window valueForKey:@"query"]; query.stringValue = @"private query";
    [window clearPlaintext:@"Session ended"];
    Reply(lateRead, page);
    checks[@"lockClears"] = @(reader.string.length == 0 && query.stringValue.length == 0 &&
      [[window valueForKey:@"rows"] count] == 0 && ![[window valueForKey:@"nextPage"] isEnabled]);
    [window openAuthenticated:YES]; Reply(broker.requests.lastObject, list);
    query.stringValue = @"onboarding"; Action(window, @"search:");
    checks[@"staleRowsCleared"] = @([[window valueForKey:@"rows"] count] == 0 && !table.enabled &&
      [[[window valueForKey:@"pageLabel"] stringValue] isEqual:@"Select a matching passage"]);
    checks[@"boundedSearch"] = @([broker.requests.lastObject[@"method"] isEqual:@"library.archive_search"] &&
      [broker.requests.lastObject[@"params"][@"limit"] isEqual:@20]);
    [window clearPlaintext:@"Broker disconnected"];
    Reply(broker.requests.lastObject, @{ @"results": @[ @{ @"archiveId": identifier, @"index": @2, @"title": @"Private", @"excerpt": @"Private" } ] });
    checks[@"staleSearchIgnored"] = @([[window valueForKey:@"rows"] count] == 0);
    [window.window close];
    NSData *json = [NSJSONSerialization dataWithJSONObject:checks options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
    return 0;
  }
}
