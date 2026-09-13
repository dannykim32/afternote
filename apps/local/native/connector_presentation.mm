#import "connector_presentation.h"

@interface AfternoteConnectorPresentation ()
@property(nonatomic) AfternoteConnectorState state;
@property(nonatomic) AfternoteConnectorAction action;
@property(nonatomic, copy) NSString *badge;
@property(nonatomic, copy) NSString *tone;
@property(nonatomic, copy) NSString *summary;
@property(nonatomic, copy) NSString *connectionTitle;
@property(nonatomic, copy) NSString *connectionDetail;
@end

@implementation AfternoteConnectorPresentation

+ (instancetype)presentationForTool:(NSString *)displayName
                             status:(NSDictionary *)status
                          connected:(BOOL)connected
                            revoked:(BOOL)revoked
                    lastActiveLabel:(NSString *)lastActiveLabel {
  AfternoteConnectorPresentation *view = [[self alloc] init];
  NSString *uiState = [status[@"uiState"] isKindOfClass:[NSString class]]
      ? status[@"uiState"] : @"";
  NSString *problemCode = [status[@"problemCode"] isKindOfClass:[NSString class]]
      ? status[@"problemCode"] : @"";
  NSString *uiError = [status[@"uiError"] isKindOfClass:[NSString class]]
      ? status[@"uiError"] : @"";
  BOOL toolAvailable = [status[@"toolAvailable"] boolValue];
  BOOL installed = [status[@"installed"] boolValue];
  BOOL healthy = [status[@"healthy"] boolValue];
  BOOL repairable = [status[@"repairable"] boolValue];
  BOOL approvalRequired = [status[@"approvalRequired"] boolValue];

  if (connected && toolAvailable && installed && healthy) {
    NSString *detail = lastActiveLabel.length > 0
        ? [NSString stringWithFormat:@"Last active %@", lastActiveLabel]
        : @"Current access is approved";
    [view applyState:AfternoteConnectorStateActive
              action:AfternoteConnectorActionNone
               badge:@"Active"
                tone:@"success"
             summary:[NSString stringWithFormat:@"Connected. Afternote is available to %@.", displayName]
     connectionTitle:@"Connected"
    connectionDetail:detail];
    return view;
  }
  if ([uiState isEqualToString:@"checking"] || status == nil) {
    [view applyState:AfternoteConnectorStateChecking
              action:AfternoteConnectorActionNone
               badge:@"Checking"
                tone:@"neutral"
             summary:[NSString stringWithFormat:@"Checking whether %@ is available…", displayName]
     connectionTitle:@"Checking"
    connectionDetail:@"This usually takes a few seconds"];
    return view;
  }
  if ([uiState isEqualToString:@"installing"] ||
      [uiState isEqualToString:@"reconnecting"]) {
    NSString *verb = [uiState isEqualToString:@"reconnecting"]
        ? @"Preparing a fresh connection" : @"Connecting Afternote";
    [view applyState:AfternoteConnectorStateConnecting
              action:AfternoteConnectorActionNone
               badge:@"Connecting"
                tone:@"warning"
             summary:[NSString stringWithFormat:@"%@ in %@…", verb, displayName]
     connectionTitle:@"Connecting"
    connectionDetail:@"This usually takes a few seconds"];
    return view;
  }
  if ([uiState isEqualToString:@"error"]) {
    [view applyState:AfternoteConnectorStateNeedsAttention
              action:AfternoteConnectorActionCheckAgain
               badge:@"Needs attention"
                tone:@"error"
             summary:uiError.length > 0 ? uiError : @"Afternote could not check this connector."
     connectionTitle:@"Check failed"
    connectionDetail:@"Check the connector again to refresh its status"];
    return view;
  }
  if (!toolAvailable) {
    [view applyState:AfternoteConnectorStateNotInstalled
              action:AfternoteConnectorActionGetTool
               badge:@"Not installed"
                tone:@"neutral"
             summary:[NSString stringWithFormat:@"%@ was not found on this Mac.", displayName]
     connectionTitle:@"Unavailable"
    connectionDetail:[NSString stringWithFormat:@"Install %@ first", displayName]];
    return view;
  }
  if (healthy && revoked) {
    [view applyState:AfternoteConnectorStateAvailable
              action:AfternoteConnectorActionPrepareReconnect
               badge:@"Available"
                tone:@"warning"
             summary:@"Previous access was revoked. Prepare a fresh connection, then use Remember or Recall again."
     connectionTitle:@"Access revoked"
    connectionDetail:@"A fresh connection requires your approval"];
    return view;
  }
  if (healthy) {
    [view applyState:AfternoteConnectorStateActive
              action:AfternoteConnectorActionNone
               badge:@"Active"
                tone:@"success"
             summary:[NSString stringWithFormat:@"The Afternote connector is active in %@.", displayName]
     connectionTitle:@"Ready for next use"
    connectionDetail:@"A connection starts automatically with Remember or Recall"];
    return view;
  }
  if (approvalRequired) {
    [view applyState:AfternoteConnectorStateAvailable
              action:AfternoteConnectorActionCheckAgain
               badge:@"Finish in Claude"
                tone:@"warning"
             summary:@"Claude Desktop is showing Afternote's extension preview. Approve it there, then check again."
     connectionTitle:@"Waiting for Claude"
    connectionDetail:@"Install the extension in Claude Desktop, then check again"];
    return view;
  }
  if (!installed || [problemCode isEqualToString:@"connector_missing"]) {
    [view applyState:AfternoteConnectorStateAvailable
              action:AfternoteConnectorActionConnect
               badge:@"Available"
                tone:@"warning"
             summary:[NSString stringWithFormat:@"%@ is available. Connect Afternote without opening Terminal.", displayName]
     connectionTitle:@"Not connected"
    connectionDetail:@"Connect Afternote to continue"];
    return view;
  }
  if ([problemCode isEqualToString:@"connector_legacy"] && repairable) {
    [view applyState:AfternoteConnectorStateNeedsAttention
              action:AfternoteConnectorActionRepair
               badge:@"Needs attention"
                tone:@"error"
             summary:[NSString stringWithFormat:@"%@ has an older Afternote connector that can be upgraded safely.", displayName]
     connectionTitle:@"Connector update required"
    connectionDetail:@"Repair replaces only the Afternote-owned entry"];
    return view;
  }
  if ([problemCode isEqualToString:@"connector_disabled"] && repairable) {
    [view applyState:AfternoteConnectorStateNeedsAttention
              action:AfternoteConnectorActionReviewSetup
               badge:@"Disabled"
                tone:@"warning"
             summary:[NSString stringWithFormat:@"The Afternote extension is installed in %@, but it is disabled.", displayName]
     connectionTitle:@"Extension disabled"
    connectionDetail:@"Enable Afternote in the tool, then check again"];
    return view;
  }
  if ([problemCode isEqualToString:@"runtime_unavailable"]) {
    [view applyState:AfternoteConnectorStateNeedsAttention
              action:AfternoteConnectorActionCheckAgain
               badge:@"Needs attention"
                tone:@"error"
             summary:[NSString stringWithFormat:@"The Afternote connector is configured in %@, but its runtime check failed.", displayName]
     connectionTitle:@"Runtime unavailable"
    connectionDetail:@"Restart the tool, then check again"];
    return view;
  }
  if ([problemCode isEqualToString:@"identity_unavailable"]) {
    [view applyState:AfternoteConnectorStateNeedsAttention
              action:AfternoteConnectorActionCheckAgain
               badge:@"Needs attention"
                tone:@"error"
             summary:[NSString stringWithFormat:@"The Afternote connector is configured in %@, but its device-bound signing identity is unavailable.", displayName]
     connectionTitle:@"Signing identity unavailable"
    connectionDetail:@"Repair the Afternote installation, then check again"];
    return view;
  }

  [view applyState:AfternoteConnectorStateNeedsAttention
            action:AfternoteConnectorActionReviewSetup
             badge:@"Needs attention"
              tone:@"error"
           summary:[NSString stringWithFormat:@"%@ already has a different Afternote connector registration.", displayName]
   connectionTitle:@"Connector conflict"
  connectionDetail:@"Review the existing entry before changing it"];
  return view;
}

- (void)applyState:(AfternoteConnectorState)state
            action:(AfternoteConnectorAction)action
             badge:(NSString *)badge
              tone:(NSString *)tone
           summary:(NSString *)summary
   connectionTitle:(NSString *)connectionTitle
  connectionDetail:(NSString *)connectionDetail {
  self.state = state;
  self.action = action;
  self.badge = badge;
  self.tone = tone;
  self.summary = summary;
  self.connectionTitle = connectionTitle;
  self.connectionDetail = connectionDetail;
}

@end
