#import <Foundation/Foundation.h>

#import "connector_presentation.h"

NSDictionary *Summary(
    NSString *name,
    NSDictionary *status,
    BOOL connected,
    BOOL revoked) {
  AfternoteConnectorPresentation *view =
      [AfternoteConnectorPresentation presentationForTool:@"Codex"
                                                   status:status
                                                connected:connected
                                                  revoked:revoked
                                          lastActiveLabel:@"today at 4:00 PM"];
  return @{
    @"name" : name,
    @"state" : @(view.state),
    @"action" : @(view.action),
    @"badge" : view.badge,
    @"summary" : view.summary,
  };
}

int main(void) {
  @autoreleasepool {
    NSArray *cases = @[
      Summary(@"connected-and-healthy", @{
        @"toolAvailable" : @YES, @"installed" : @YES, @"healthy" : @YES,
      }, YES, NO),
      Summary(@"connected-but-disabled", @{
        @"toolAvailable" : @YES, @"installed" : @YES, @"healthy" : @NO,
        @"repairable" : @YES, @"problemCode" : @"connector_disabled",
      }, YES, NO),
      Summary(@"tool-missing", @{
        @"toolAvailable" : @NO, @"installed" : @NO, @"healthy" : @NO,
      }, NO, YES),
      Summary(@"available", @{
        @"toolAvailable" : @YES, @"installed" : @NO, @"healthy" : @NO,
        @"problemCode" : @"connector_missing",
      }, NO, NO),
      Summary(@"approval", @{
        @"toolAvailable" : @YES, @"installed" : @NO, @"healthy" : @NO,
        @"approvalRequired" : @YES, @"problemCode" : @"connector_missing",
      }, NO, NO),
      Summary(@"revoked", @{
        @"toolAvailable" : @YES, @"installed" : @YES, @"healthy" : @YES,
      }, NO, YES),
      Summary(@"legacy", @{
        @"toolAvailable" : @YES, @"installed" : @YES, @"healthy" : @NO,
        @"repairable" : @YES, @"problemCode" : @"connector_legacy",
      }, NO, NO),
      Summary(@"disabled", @{
        @"toolAvailable" : @YES, @"installed" : @YES, @"healthy" : @NO,
        @"repairable" : @YES, @"problemCode" : @"connector_disabled",
      }, NO, NO),
      Summary(@"runtime", @{
        @"toolAvailable" : @YES, @"installed" : @YES, @"healthy" : @NO,
        @"repairable" : @NO, @"problemCode" : @"runtime_unavailable",
      }, NO, NO),
      Summary(@"identity", @{
        @"toolAvailable" : @YES, @"installed" : @YES, @"healthy" : @NO,
        @"repairable" : @NO, @"problemCode" : @"identity_unavailable",
      }, NO, NO),
      Summary(@"conflict", @{
        @"toolAvailable" : @YES, @"installed" : @YES, @"healthy" : @NO,
        @"repairable" : @NO, @"problemCode" : @"connector_conflict",
      }, NO, NO),
      Summary(@"command-error", @{
        @"uiState" : @"error", @"uiError" : @"Status command failed",
      }, NO, NO),
    ];
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:cases options:0 error:nil];
    fwrite(encoded.bytes, 1, encoded.length, stdout);
    fputc('\n', stdout);
  }
  return 0;
}
