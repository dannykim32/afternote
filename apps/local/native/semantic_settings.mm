#import "semantic_settings.h"
#import "native_appearance.h"

typedef NS_ENUM(NSInteger, AfternoteSemanticFailure) {
  AfternoteSemanticFailureNone, AfternoteSemanticFailureStatus,
  AfternoteSemanticFailureInstall, AfternoteSemanticFailureActivation,
};

static BOOL KnownProfile(id value) {
  return [value isKindOfClass:NSString.class] && [@[@"light", @"balanced", @"large"] containsObject:value];
}
static NSTextField *CopyLabel(NSString *text, CGFloat size) {
  NSTextField *label = [NSTextField wrappingLabelWithString:text];
  label.font = [NSFont systemFontOfSize:size];
  label.textColor = AfternoteMutedTextColor();
  return label;
}

@interface AfternoteSemanticSettings ()
@property(nonatomic, copy) AfternoteSemanticRunner runner;
@property(nonatomic, strong) NSButton *actionButton;
@property(nonatomic, strong) NSPopUpButton *modelMenu;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSTextField *modelDetail;
@property(nonatomic, strong) NSTextField *stateLabel;
@property(nonatomic, strong) NSProgressIndicator *spinner;
@property(nonatomic, copy) NSDictionary *catalog;
@property(nonatomic, copy) NSString *chosenProfile;
@property(nonatomic, copy) NSString *selectedProfile;
@property(nonatomic, copy) NSString *activeModelId;
@property(nonatomic, copy) NSString *searchMode;
@property(nonatomic, copy) NSString *failure;
@property(nonatomic) AfternoteSemanticFailure failureKind;
@property(nonatomic) BOOL busy;
@property(nonatomic) NSInteger indexedNotes;
@property(nonatomic) NSInteger totalNotes;
@property(nonatomic) NSUInteger generation;
@end

@implementation AfternoteSemanticSettings
- (instancetype)initWithRunner:(AfternoteSemanticRunner)runner {
  self = [super initWithFrame:NSZeroRect];
  if (!self) return nil;
  _runner = [runner copy];
  _searchMode = @"checking";
  self.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.alignment = NSLayoutAttributeLeading;
  self.spacing = 12;
  self.edgeInsets = NSEdgeInsetsMake(20, 0, 16, 0);
  NSTextField *heading = CopyLabel(@"Search by meaning", 14);
  heading.font = [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
  heading.textColor = AfternoteTextColor();
  _stateLabel = CopyLabel(@"Off", 11);
  NSStackView *header = [NSStackView stackViewWithViews:@[heading, [NSView new], _stateLabel]];
  header.alignment = NSLayoutAttributeCenterY;
  NSTextField *explanation = CopyLabel(@"Find notes by meaning in Afternote and connected tools. Processing stays on this Mac.", 12);
  _modelMenu = [[NSPopUpButton alloc] initWithFrame:NSZeroRect pullsDown:NO];
  [_modelMenu addItemsWithTitles:@[@"Light", @"Balanced", @"Large"]];
  for (NSUInteger i = 0; i < 3; i++) _modelMenu.itemArray[i].representedObject = @[@"light", @"balanced", @"large"][i];
  _modelMenu.target = self;
  _modelMenu.action = @selector(modelChanged:);
  _modelMenu.accessibilityLabel = @"Search model";
  [_modelMenu.widthAnchor constraintEqualToConstant:220].active = YES;
  NSTextField *modelLabel = CopyLabel(@"Model", 12);
  modelLabel.textColor = AfternoteTextColor();
  NSStackView *choice = [NSStackView stackViewWithViews:@[modelLabel, [NSView new], _modelMenu]];
  choice.spacing = 16;
  choice.alignment = NSLayoutAttributeCenterY;
  _modelDetail = CopyLabel(@"Choose a model after checking availability.", 12);
  _statusLabel = CopyLabel(@"Check availability to get started.", 12);
  _actionButton = [AfternoteButton buttonWithTitle:@"Check availability" target:self action:@selector(performAction:)];
  AfternoteStyleSecondaryButton(_actionButton);
  _spinner = [NSProgressIndicator new];
  _spinner.style = NSProgressIndicatorStyleSpinning;
  _spinner.controlSize = NSControlSizeSmall;
  _spinner.displayedWhenStopped = NO;
  NSStackView *actions = [NSStackView stackViewWithViews:@[_statusLabel, [NSView new], _spinner, _actionButton]];
  actions.spacing = 10;
  actions.alignment = NSLayoutAttributeCenterY;
  for (NSView *view in @[header, explanation, choice, _modelDetail, actions]) [self addArrangedSubview:view];
  for (NSView *view in @[header, explanation, choice, _modelDetail, actions])
    [view.widthAnchor constraintEqualToAnchor:self.widthAnchor].active = YES;
  [self setCustomSpacing:8 afterView:header];
  [self setCustomSpacing:6 afterView:choice];
  [_statusLabel.widthAnchor constraintLessThanOrEqualToAnchor:self.widthAnchor constant:-250].active = YES;
  _modelMenu.enabled = NO;
  return self;
}
- (NSDictionary *)chosenModel { return self.catalog[self.chosenProfile ?: @""]; }
- (void)render {
  NSDictionary *model = [self chosenModel];
  BOOL ready = [model[@"state"] isEqual:@"ready"];
  BOOL selected = [self.chosenProfile isEqual:self.selectedProfile];
  BOOL active = selected && [model[@"modelId"] isEqual:self.activeModelId];
  self.actionButton.enabled = !self.busy;
  self.modelMenu.enabled = !self.busy && self.catalog != nil;
  if (self.busy) return;
  [self.spinner stopAnimation:nil];
  NSString *activeName = nil;
  for (NSString *key in self.catalog) {
    if ([self.catalog[key][@"modelId"] isEqual:self.activeModelId])
      activeName = [key isEqual:@"light"] ? @"Light" : [key isEqual:@"balanced"] ? @"Balanced" : @"Large";
  }
  self.stateLabel.stringValue = activeName && [self.searchMode isEqual:@"hybrid"]
      ? [@"On · " stringByAppendingString:activeName] : activeName && [self.searchMode isEqual:@"indexing"]
      ? [@"Indexing · " stringByAppendingString:activeName] : @"Off";
  if (self.failure.length > 0) {
    self.statusLabel.stringValue = self.failure;
    self.actionButton.title = self.failureKind == AfternoteSemanticFailureActivation ? @"Retry activation" : @"Retry";
  } else if (!model) {
    self.statusLabel.stringValue = @"Check availability to get started.";
    self.actionButton.title = @"Check availability";
  } else if (active && [self.searchMode isEqual:@"hybrid"]) {
    self.statusLabel.stringValue = @"Active in Notes and connected tools.";
    self.actionButton.title = @"Check status";
  } else if (active && [self.searchMode isEqual:@"indexing"]) {
    self.statusLabel.stringValue = [NSString stringWithFormat:@"Indexing %ld of %ld notes locally. Exact search remains available.", (long)self.indexedNotes, (long)self.totalNotes];
    self.actionButton.title = @"Check status";
  } else if (ready && selected) {
    self.statusLabel.stringValue = [self.searchMode isEqual:@"degraded"]
        ? @"Indexing needs attention. Exact search remains available. Restart Afternote to retry."
        : @"Installed. Open Notes with your usual authentication to activate.";
    self.actionButton.title = @"Activate model";
  } else {
    self.statusLabel.stringValue = ready
        ? @"Switching rebuilds the search index. Your saved notes stay the same."
        : @"Downloads from Hugging Face. Note content is never uploaded. Exact search works without a model.";
    self.actionButton.title = ready ? @"Use model" : [model[@"state"] isEqual:@"invalid"] ? @"Repair model" : @"Download model";
  }
}
- (void)updateModelDetail {
  NSDictionary *model = [self chosenModel];
  if (!model) return;
  NSString *resource = [self.chosenProfile isEqual:@"light"] ? @"Smallest download and memory footprint." :
      [self.chosenProfile isEqual:@"balanced"] ? @"A middle ground for download size and memory use." :
      @"Largest download; indexing takes more time and memory.";
  self.modelDetail.stringValue = [NSString stringWithFormat:@"%@ · %.0f MB download\n%@ Memory use is higher than download size.",
      model[@"name"], [model[@"downloadBytes"] doubleValue] / 1000000.0, resource];
}
- (void)modelChanged:(id)sender {
  (void)sender;
  self.chosenProfile = self.modelMenu.selectedItem.representedObject;
  self.failure = nil;
  self.failureKind = AfternoteSemanticFailureNone;
  [self updateModelDetail]; [self render];
}
- (void)setSearchMode:(NSString *)mode {
  _searchMode = [mode copy];
  if ([@[@"checking", @"exact"] containsObject:mode]) self.activeModelId = nil;
  [self render];
}
- (void)setIndexedNotes:(NSInteger)indexed total:(NSInteger)total {
  self.indexedNotes = indexed;
  self.totalNotes = total;
}
- (void)activationCompleted:(NSString *)mode modelId:(NSString *)modelId {
  self.activeModelId = modelId;
  self.searchMode = mode;
  if (self.failureKind == AfternoteSemanticFailureActivation &&
      [self.chosenModel[@"modelId"] isEqual:modelId] && [@[@"hybrid", @"indexing"] containsObject:mode]) {
    self.failure = nil; self.failureKind = AfternoteSemanticFailureNone;
  }
  [self render];
}
- (void)activationFailed {
  self.failureKind = AfternoteSemanticFailureActivation;
  self.failure = @"Could not activate the installed model. Open Notes to check vault access, then retry.";
  [self render];
}
- (void)performAction:(id)sender {
  (void)sender;
  if (self.busy) return;
  if (self.failureKind == AfternoteSemanticFailureStatus || !self.catalog) { [self refresh]; return; }
  if (self.failureKind == AfternoteSemanticFailureActivation ||
      ([self.chosenProfile isEqual:self.selectedProfile] && [self.chosenModel[@"state"] isEqual:@"ready"])) {
    self.failure = nil; self.failureKind = AfternoteSemanticFailureNone;
    [self render];
    if (self.activate) self.activate(YES);
  } else [self runInstalling:YES];
}
- (void)refresh { if (!self.busy) [self runInstalling:NO]; }
- (BOOL)acceptCatalog:(NSDictionary *)result {
  if (!KnownProfile(result[@"selected"]) || !KnownProfile(result[@"recommended"]) ||
      ![result[@"memoryGiB"] isKindOfClass:NSNumber.class] ||
      ![result[@"models"] isKindOfClass:NSArray.class] || [result[@"models"] count] != 3) return NO;
  NSMutableDictionary *models = [NSMutableDictionary dictionary];
  for (id model in result[@"models"]) {
    if (![model isKindOfClass:NSDictionary.class] || !KnownProfile(model[@"key"]) || models[model[@"key"]] ||
        ![model[@"name"] isKindOfClass:NSString.class] || [model[@"name"] length] == 0 || [model[@"name"] length] > 80 ||
        ![model[@"modelId"] isKindOfClass:NSString.class] || [model[@"modelId"] length] == 0 || [model[@"modelId"] length] > 256 ||
        ![model[@"downloadBytes"] isKindOfClass:NSNumber.class] || [model[@"downloadBytes"] longLongValue] <= 0 ||
        ![@[@"not-installed", @"ready", @"invalid"] containsObject:model[@"state"] ?: NSNull.null]) return NO;
    models[model[@"key"]] = model;
  }
  self.catalog = models;
  self.selectedProfile = result[@"selected"];
  if (!self.chosenProfile) self.chosenProfile = self.selectedProfile;
  for (NSMenuItem *item in self.modelMenu.itemArray) {
    NSString *key = item.representedObject;
    NSString *name = [key isEqual:@"light"] ? @"Light" : [key isEqual:@"balanced"] ? @"Balanced" : @"Large";
    item.title = [key isEqual:result[@"recommended"]] ? [name stringByAppendingString:@" — Recommended"] : name;
    if ([key isEqual:self.chosenProfile]) [self.modelMenu selectItem:item];
  }
  [self updateModelDetail];
  return YES;
}
- (void)runInstalling:(BOOL)install {
  self.busy = YES;
  if (install || self.failureKind == AfternoteSemanticFailureStatus) {
    self.failure = nil; self.failureKind = AfternoteSemanticFailureNone;
  }
  self.actionButton.enabled = NO;
  self.modelMenu.enabled = NO;
  self.statusLabel.stringValue = install ? @"Downloading and verifying the model. This may take several minutes…" : @"Checking local models…";
  [self.spinner startAnimation:nil];
  NSUInteger generation = ++self.generation;
  NSString *profile = self.chosenProfile;
  __weak AfternoteSemanticSettings *weakSelf = self;
  NSArray *arguments = install ? @[@"semantic", @"install", profile] : @[@"semantic", @"catalog"];
  self.runner(arguments, ^(NSDictionary *result, NSString *error) {
    AfternoteSemanticSettings *view = weakSelf;
    if (!view || generation != view.generation || !view.busy) return;
    view.busy = NO;
    BOOL valid;
    if (install) {
      NSDictionary *expected = view.catalog[profile];
      NSString *modelId = [result[@"modelId"] isKindOfClass:NSString.class] && [result[@"dtype"] isKindOfClass:NSString.class]
          ? [NSString stringWithFormat:@"%@:%@", result[@"modelId"], result[@"dtype"]] : @"";
      valid = [result[@"state"] isEqual:@"ready"] && [result[@"profile"] isEqual:profile] &&
          [expected[@"modelId"] isEqual:modelId] && [result[@"revision"] isKindOfClass:NSString.class] &&
          [result[@"revision"] length] > 0 && [result[@"dimensions"] isKindOfClass:NSNumber.class] &&
          [result[@"dimensions"] integerValue] > 0 && [result[@"bytes"] isEqual:expected[@"downloadBytes"]] && result[@"reason"] == NSNull.null;
      if (valid && error.length == 0) {
        NSMutableDictionary *models = [view.catalog mutableCopy];
        NSMutableDictionary *model = [expected mutableCopy]; model[@"state"] = @"ready";
        models[profile] = model; view.catalog = models; view.selectedProfile = profile;
        view.activeModelId = nil;
      }
    } else valid = error.length == 0 && [view acceptCatalog:result];
    if (error.length > 0 || !valid) {
      if (install || view.failureKind != AfternoteSemanticFailureInstall) {
        view.failureKind = install ? AfternoteSemanticFailureInstall : AfternoteSemanticFailureStatus;
        view.failure = install ? @"Installation failed. Check your connection and retry. Your previous search model is unchanged."
                             : @"Could not check local models. Retry to check availability.";
      }
    }
    [view render];
    if (valid && error.length == 0 && [view.catalog[view.selectedProfile][@"state"] isEqual:@"ready"] &&
        view.failureKind != AfternoteSemanticFailureInstall && view.activate) view.activate(NO);
  });
}
@end
