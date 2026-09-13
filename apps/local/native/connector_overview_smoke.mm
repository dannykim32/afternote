#import <Foundation/Foundation.h>

#import "connector_overview.h"

NSDictionary *Result(NSDictionary *connector) {
  return @{ @"connectors" : @[ connector ] };
}

int main(void) {
  @autoreleasepool {
    NSDictionary *valid = @{
      @"kind" : @"claude-desktop",
      @"status" : @"active",
      @"activeScopes" : @[ @"memory.remember", @"memory.recall" ],
      @"lastActivityAt" : @"2026-09-12T20:00:00.000Z",
      @"savedCount" : @2,
      @"readCount" : @1,
      @"verifiedRoundTrip" : @YES,
    };
    NSDictionary *parsed = AfternoteConnectorOverviewByKind(Result(valid));
    AfternoteConnectorOverviewItem *item = parsed[@"claude-desktop"];
    NSMutableDictionary *extra = [valid mutableCopy];
    extra[@"clientId"] = @"secret";
    NSMutableDictionary *unknownScope = [valid mutableCopy];
    unknownScope[@"activeScopes"] = @[ @"memory.everything" ];
    NSDictionary *output = @{
      @"accepted" : @(item != nil),
      @"active" : @(item.hasCurrentAuthority),
      @"rejectedExtraField" : @(AfternoteConnectorOverviewByKind(Result(extra)) == nil),
      @"rejectedUnknownScope" : @(AfternoteConnectorOverviewByKind(Result(unknownScope)) == nil),
      @"savedCount" : @(item.savedCount),
      @"verifiedRoundTrip" : @(item.verifiedRoundTrip),
    };
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
    fwrite(encoded.bytes, 1, encoded.length, stdout);
    fputc('\n', stdout);
  }
  return 0;
}
