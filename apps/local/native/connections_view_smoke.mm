#import "connections_view.h"

@interface ActionProbe : NSObject <AfternoteConnectionsActions>
@property(nonatomic, strong) NSMutableArray<NSString *> *calls;
@end
@implementation ActionProbe
- (instancetype)init {
  if ((self = [super init])) _calls = [NSMutableArray array];
  return self;
}
#define RECORD_ACTION(method) \
- (void)method:(NSButton *)sender { \
  [self.calls addObject:[NSString stringWithFormat:@"%s:%@", #method, sender.identifier ?: @""]]; \
}
RECORD_ACTION(refreshConnections)
RECORD_ACTION(openIntegrationDownload)
RECORD_ACTION(installIntegration)
RECORD_ACTION(reconnectIntegration)
RECORD_ACTION(refreshIntegrationStatusFromButton)
RECORD_ACTION(reviewIntegrationSetup)
RECORD_ACTION(confirmRevocation)
RECORD_ACTION(toggleConnectorHistory)
RECORD_ACTION(loadMore)
#undef RECORD_ACTION
@end

NSView *Find(NSView *root, NSString *identifier) {
  if ([root.identifier isEqualToString:identifier]) return root;
  for (NSView *child in root.subviews) {
    NSView *found = Find(child, identifier);
    if (found) return found;
  }
  return nil;
}
NSButton *Button(NSView *root, NSString *title) {
  if ([root isKindOfClass:NSButton.class] && [((NSButton *)root).title isEqual:title])
    return (NSButton *)root;
  for (NSView *child in root.subviews) {
    NSButton *found = Button(child, title);
    if (found) return found;
  }
  return nil;
}
BOOL ContainsText(NSView *root, NSString *text) {
  if ([root isKindOfClass:NSTextField.class] &&
      [((NSTextField *)root).stringValue containsString:text]) return YES;
  if ([root isKindOfClass:NSTextView.class] &&
      [((NSTextView *)root).string containsString:text]) return YES;
  for (NSView *child in root.subviews) if (ContainsText(child, text)) return YES;
  return NO;
}
AfternoteConnectionRow *Row(NSDictionary *status, BOOL connected, BOOL revoked) {
  AfternoteConnectionRow *row = [AfternoteConnectionRow new];
  row.commandKind = @"claude-code";
  row.brokerKind = @"claude";
  row.displayName = @"Claude Code";
  row.presentation = [AfternoteConnectorPresentation presentationForTool:row.displayName
      status:status connected:connected revoked:revoked reconnectPrepared:NO lastActiveLabel:@"Yesterday"];
  row.connected = connected;
  row.permissions = @"Remember, Recall, Read cited note";
  row.activity = @"3 saved · 2 recalled";
  row.historyLines = @[@"Connected · Synthetic history"];
  row.historyAuthorized = YES;
  row.historyExpanded = YES;
  row.hasOlderHistory = YES;
  return row;
}

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication].activationPolicy = NSApplicationActivationPolicyProhibited;
    ActionProbe *probe = [ActionProbe new];
    AfternoteConnectionsView *view = [[AfternoteConnectionsView alloc] initWithActionTarget:probe];
    NSArray *cases = @[
      @[@{@"toolAvailable":@NO}, @NO, @NO, @"Get Claude Code", @"openIntegrationDownload:claude-code"],
      @[@{@"toolAvailable":@YES}, @NO, @NO, @"Connect Afternote", @"installIntegration:claude-code"],
      @[@{@"toolAvailable":@YES,@"installed":@YES,@"healthy":@YES}, @NO, @YES, @"Prepare reconnect", @"reconnectIntegration:claude-code"],
      @[@{@"toolAvailable":@YES,@"installed":@YES,@"repairable":@YES,@"problemCode":@"connector_legacy"}, @YES, @NO, @"Repair Afternote", @"installIntegration:claude-code"],
      @[@{@"uiState":@"error"}, @NO, @NO, @"Check again", @"refreshIntegrationStatusFromButton:claude-code"],
      @[@{@"toolAvailable":@YES,@"installed":@YES,@"problemCode":@"connector_conflict"}, @NO, @NO, @"Review setup", @"reviewIntegrationSetup:claude-code"],
    ];
    BOOL routes = YES, passive = YES, replacement = YES;
    for (NSArray *fixture in cases) {
      NSUInteger before = probe.calls.count;
      AfternoteConnectionRow *row = Row(fixture[0], [fixture[1] boolValue], [fixture[2] boolValue]);
      [view renderRows:@[row]];
      passive &= probe.calls.count == before;
      replacement &= ((NSStackView *)Find(view, @"ConnectionsRows")).arrangedSubviews.count == 1;
      NSButton *action = Button(view, fixture[3]);
      [action performClick:nil];
      routes &= action != nil && probe.calls.count == before + 1 &&
          [probe.calls.lastObject isEqualToString:fixture[4]];
    }
    AfternoteConnectionRow *row = Row(@{@"toolAvailable":@YES,@"installed":@YES,@"healthy":@YES}, YES, NO);
    [view renderRows:@[row]];
    BOOL history = ContainsText(view, @"Synthetic history") && ContainsText(view, @"3 saved");
    for (NSArray *action in @[
      @[@"Revoke access", @"confirmRevocation:claude"],
      @[@"Connection history", @"toggleConnectorHistory:claude"],
      @[@"Show older events", @"loadMore:"],
    ]) {
      [Button(view, action[0]) performClick:nil];
      routes &= [probe.calls.lastObject isEqualToString:action[1]];
    }
    NSUInteger before = probe.calls.count;
    [view setBusy:YES status:@"Reading status"];
    NSButton *refresh = Button(view, @"Refresh");
    BOOL busy = !refresh.enabled && !Find(view, @"ConnectionsProgress").hidden &&
        ContainsText(view, @"Reading status") && probe.calls.count == before;
    [view setBusy:NO status:@"Up to date"];
    busy &= refresh.enabled && Find(view, @"ConnectionsProgress").hidden;
    [view setRefreshEnabled:NO];
    busy &= !refresh.enabled;
    [view setRefreshEnabled:YES];
    [refresh performClick:nil];
    routes &= [probe.calls.lastObject isEqualToString:@"refreshConnections:ConnectionsRefresh"];
    row.historyExpanded = NO;
    row.historyAuthorized = NO;
    row.activity = @"4 saved";
    [view renderRows:@[row]];
    history &= !ContainsText(view, @"Synthetic history") &&
        ContainsText(view, @"Authenticate to view") && ContainsText(view, @"4 saved");
    [view showErrorMessage:@"Synthetic broker failure"];
    replacement &= ContainsText(view, @"Synthetic broker failure") &&
        !ContainsText(view, @"4 saved") && Button(view, @"Revoke access") == nil;
    [view renderRows:@[]];
    replacement &= ((NSStackView *)Find(view, @"ConnectionsRows")).arrangedSubviews.count == 0;
    __weak ActionProbe *weakProbe;
    AfternoteConnectionsView *orphan;
    @autoreleasepool {
      ActionProbe *temporary = [ActionProbe new];
      weakProbe = temporary;
      orphan = [[AfternoteConnectionsView alloc] initWithActionTarget:temporary];
      [orphan renderRows:@[row]];
    }
    BOOL weakTarget = weakProbe == nil && Button(orphan, @"Revoke access").target == nil;
    NSDictionary *result = @{@"routes":@(routes), @"passive":@(passive),
      @"replacement":@(replacement), @"history":@(history), @"busy":@(busy),
      @"weakTarget":@(weakTarget)};
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
    return 0;
  }
}
