#import "semantic_settings.h"
#import "native_appearance.h"

typedef NS_ENUM(NSInteger, AfternoteSemanticFailure) {
  AfternoteSemanticFailureNone,
  AfternoteSemanticFailureStatus,
  AfternoteSemanticFailureInstall,
  AfternoteSemanticFailureActivation,
};

@interface AfternoteSemanticSettings ()
@property(nonatomic, copy) AfternoteSemanticRunner runner;
@property(nonatomic, strong) NSButton *actionButton;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSProgressIndicator *spinner;
@property(nonatomic, copy) NSString *modelState;
@property(nonatomic, copy) NSString *searchMode;
@property(nonatomic, copy) NSString *failure;
@property(nonatomic) AfternoteSemanticFailure failureKind;
@property(nonatomic) BOOL busy;
@property(nonatomic) NSUInteger generation;
@end

@implementation AfternoteSemanticSettings
- (instancetype)initWithRunner:(AfternoteSemanticRunner)runner {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  _runner = [runner copy];
  _modelState = @"unknown";
  _searchMode = @"checking";
  self.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.alignment = NSLayoutAttributeLeading;
  self.spacing = 7;
  _statusLabel = [NSTextField wrappingLabelWithString:@"Check availability to get started."];
  _statusLabel.font = [NSFont systemFontOfSize:12];
  _statusLabel.textColor = AfternoteMutedTextColor();
  _actionButton = [AfternoteButton buttonWithTitle:@"Check availability" target:self action:@selector(performAction:)];
  AfternoteStyleSecondaryButton(_actionButton);
  _spinner = [NSProgressIndicator new];
  _spinner.style = NSProgressIndicatorStyleSpinning;
  _spinner.controlSize = NSControlSizeSmall;
  _spinner.displayedWhenStopped = NO;
  NSStackView *actions = [NSStackView stackViewWithViews:@[_actionButton, _spinner]];
  actions.spacing = 8;
  [self addArrangedSubview:_statusLabel];
  [self addArrangedSubview:actions];
  [self.widthAnchor constraintEqualToConstant:270].active = YES;
  [_statusLabel.widthAnchor constraintEqualToAnchor:self.widthAnchor].active = YES;
  return self;
}
- (void)render {
  self.actionButton.enabled = !self.busy;
  if (self.busy) return;
  [self.spinner stopAnimation:nil];
  if (self.failure.length > 0) {
    self.statusLabel.stringValue = self.failure;
    self.actionButton.title = [self.modelState isEqualToString:@"ready"] ? @"Retry activation" : @"Retry";
  } else if ([self.modelState isEqualToString:@"ready"]) {
    if ([self.searchMode isEqualToString:@"hybrid"]) {
      self.statusLabel.stringValue = @"Active in Notes and connected tools. Runs on this Mac.";
      self.actionButton.title = @"Check status";
    } else if ([self.searchMode isEqualToString:@"indexing"]) {
      self.statusLabel.stringValue = @"Indexing notes locally. Exact search remains available.";
      self.actionButton.title = @"Check status";
    } else if ([self.searchMode isEqualToString:@"degraded"]) {
      self.statusLabel.stringValue = @"Semantic search is unavailable. Exact search still works; restart Afternote to retry indexing.";
      self.actionButton.title = @"Check status";
    } else {
      self.statusLabel.stringValue = @"Model installed. Open Notes to activate with your usual authentication.";
      self.actionButton.title = @"Activate semantic search";
    }
  } else {
    self.statusLabel.stringValue = [self.modelState isEqualToString:@"invalid"]
        ? @"Model verification failed. Reinstall to repair it; exact search is available."
        : @"Exact search in Notes and connected tools. Download a 23 MB model to also search by meaning.";
    self.actionButton.title = [self.modelState isEqualToString:@"unknown"]
        ? @"Check availability" : @"Install semantic search";
  }
}
- (void)setSearchMode:(NSString *)mode {
  _searchMode = [mode copy];
  if (self.failureKind == AfternoteSemanticFailureActivation &&
      ([_searchMode isEqualToString:@"hybrid"] || [_searchMode isEqualToString:@"indexing"])) {
    self.failure = nil;
    self.failureKind = AfternoteSemanticFailureNone;
  }
  [self render];
}
- (void)activationFailed {
  self.failureKind = AfternoteSemanticFailureActivation;
  self.failure = @"Could not activate. Open Notes to check your vault access, then retry.";
  [self render];
}
- (void)performAction:(id)sender {
  (void)sender;
  if (self.busy) return;
  if ([self.modelState isEqualToString:@"ready"]) {
    self.failure = nil;
    self.failureKind = AfternoteSemanticFailureNone;
    if (self.activate) self.activate(YES);
  } else {
    [self runInstalling:![self.modelState isEqualToString:@"unknown"]];
  }
}
- (void)refresh { if (!self.busy) [self runInstalling:NO]; }
- (void)runInstalling:(BOOL)install {
  self.busy = YES;
  if (install || self.failureKind == AfternoteSemanticFailureStatus) {
    self.failure = nil;
    self.failureKind = AfternoteSemanticFailureNone;
  }
  self.actionButton.enabled = NO;
  self.statusLabel.stringValue = install ? @"Downloading and verifying the local model…" : @"Checking local model…";
  [self.spinner startAnimation:nil];
  NSUInteger generation = ++self.generation;
  __weak AfternoteSemanticSettings *weakSelf = self;
  self.runner(@[@"semantic", install ? @"install" : @"status"], ^(NSDictionary *result, NSString *error) {
    AfternoteSemanticSettings *view = weakSelf;
    if (!view || generation != view.generation || !view.busy) return;
    view.busy = NO;
    // The signed CLI owns pinned revision/hash verification. Reject incomplete or
    // malformed status output instead of reporting a successful installation.
    NSString *state = [result[@"state"] isKindOfClass:NSString.class] ? result[@"state"] : @"";
    BOOL valid = [@[@"not-installed", @"ready", @"invalid"] containsObject:state] &&
        [result[@"modelId"] isKindOfClass:NSString.class] && [result[@"modelId"] length] > 0 &&
        [result[@"revision"] isKindOfClass:NSString.class] && [result[@"revision"] length] > 0 &&
        [result[@"dtype"] isKindOfClass:NSString.class] &&
        [result[@"dimensions"] isKindOfClass:NSNumber.class] && [result[@"dimensions"] integerValue] > 0 &&
        [result[@"bytes"] isKindOfClass:NSNumber.class] && [result[@"bytes"] longLongValue] >= 0 &&
        (result[@"reason"] == NSNull.null || [result[@"reason"] isKindOfClass:NSString.class]);
    if (error.length > 0 || !valid || (install && ![state isEqualToString:@"ready"])) {
      if (install || view.failureKind != AfternoteSemanticFailureInstall) {
        view.failureKind = install ? AfternoteSemanticFailureInstall : AfternoteSemanticFailureStatus;
        view.failure = install ? @"Installation failed. Check your connection and retry. Exact search is available."
                             : @"Could not check the local model. Retry to check availability.";
      }
    } else {
      view.modelState = state;
      if (install || ([state isEqualToString:@"ready"] && view.failureKind == AfternoteSemanticFailureInstall)) {
        view.failure = nil;
        view.failureKind = AfternoteSemanticFailureNone;
      }
    }
    [view render];
    if (valid && error.length == 0 && [state isEqualToString:@"ready"] &&
        (view.failure.length == 0 || view.failureKind == AfternoteSemanticFailureActivation) && view.activate)
      view.activate(NO);
  });
}
@end
