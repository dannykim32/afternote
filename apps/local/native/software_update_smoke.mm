#import <AppKit/AppKit.h>

#import "software_update.h"

@interface UpdateDriverProbe : NSObject <AfternoteSoftwareUpdateDriver>
@property(nonatomic) BOOL automaticallyChecksForUpdates;
@property(nonatomic) BOOL canCheckForUpdates;
@property(nonatomic) NSUInteger checkCount;
@end

@implementation UpdateDriverProbe
- (void)checkForUpdates:(id)sender {
  (void)sender;
  self.checkCount += 1;
}
@end

namespace {

void Require(BOOL condition, NSString *message) {
  if (!condition) {
    NSLog(@"%@", message);
    exit(1);
  }
}

}  // namespace

int main() {
  @autoreleasepool {
    UpdateDriverProbe *driver = [[UpdateDriverProbe alloc] init];
    driver.automaticallyChecksForUpdates = YES;
    driver.canCheckForUpdates = YES;
    AfternoteSoftwareUpdateController *controller =
        [[AfternoteSoftwareUpdateController alloc] initWithDriver:driver];

    Require(controller.available, @"configured updates are available");
    Require(controller.automaticallyChecksForUpdates,
            @"background-check preference crosses the update seam");
    controller.automaticallyChecksForUpdates = NO;
    Require(!driver.automaticallyChecksForUpdates,
            @"the owner can disable background checks");
    [controller checkForUpdates:nil];
    Require(driver.checkCount == 1, @"manual checks reach the update driver");

    driver.canCheckForUpdates = NO;
    [controller checkForUpdates:nil];
    Require(driver.checkCount == 1, @"busy update drivers reject duplicate checks");

    AfternoteSoftwareUpdateController *unavailable =
        [[AfternoteSoftwareUpdateController alloc] initWithDriver:nil];
    Require(!unavailable.available && !unavailable.canCheckForUpdates,
            @"source builds expose no network update path");
  }
  return 0;
}
