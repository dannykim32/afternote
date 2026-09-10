#import "software_update.h"

#if defined(AFTERNOTE_RELEASE_BUILD)
#import <Sparkle/Sparkle.h>
#endif

@interface AfternoteSoftwareUpdateController ()
@property(nonatomic, strong) id<AfternoteSoftwareUpdateDriver> driver;
@end

@implementation AfternoteSoftwareUpdateController

- (instancetype)initWithDriver:(id<AfternoteSoftwareUpdateDriver>)driver {
  self = [super init];
  if (self == nil) return nil;
  self.driver = driver;
  return self;
}

- (BOOL)available {
  return self.driver != nil;
}

- (BOOL)automaticallyChecksForUpdates {
  return self.driver != nil && self.driver.automaticallyChecksForUpdates;
}

- (void)setAutomaticallyChecksForUpdates:(BOOL)enabled {
  if (self.driver != nil) self.driver.automaticallyChecksForUpdates = enabled;
}

- (BOOL)canCheckForUpdates {
  return self.driver != nil && self.driver.canCheckForUpdates;
}

- (void)checkForUpdates:(id)sender {
  if (self.canCheckForUpdates) [self.driver checkForUpdates:sender];
}

@end

#if defined(AFTERNOTE_RELEASE_BUILD)

@interface AfternoteSparkleUpdateDriver : NSObject <AfternoteSoftwareUpdateDriver>
@property(nonatomic, strong) SPUStandardUpdaterController *controller;
@end

@implementation AfternoteSparkleUpdateDriver

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  self.controller = [[SPUStandardUpdaterController alloc]
      initWithStartingUpdater:YES
              updaterDelegate:nil
           userDriverDelegate:nil];
  return self;
}

- (BOOL)automaticallyChecksForUpdates {
  return self.controller.updater.automaticallyChecksForUpdates;
}

- (void)setAutomaticallyChecksForUpdates:(BOOL)enabled {
  self.controller.updater.automaticallyChecksForUpdates = enabled;
}

- (BOOL)canCheckForUpdates {
  return self.controller.updater.canCheckForUpdates;
}

- (void)checkForUpdates:(id)sender {
  [self.controller checkForUpdates:sender];
}

@end

#endif

AfternoteSoftwareUpdateController *AfternoteCreateSoftwareUpdateController(void) {
#if defined(AFTERNOTE_RELEASE_BUILD)
  return [[AfternoteSoftwareUpdateController alloc]
      initWithDriver:[[AfternoteSparkleUpdateDriver alloc] init]];
#else
  return [[AfternoteSoftwareUpdateController alloc] initWithDriver:nil];
#endif
}
