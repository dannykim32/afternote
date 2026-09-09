#import <Foundation/Foundation.h>

#import "product_surface_router.h"

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
    AfternoteProductSurfaceRouter *router =
        [[AfternoteProductSurfaceRouter alloc] init];
    Require(router.surface == AfternoteProductSurfaceMemory,
            @"Notes is the default surface");
    Require([router selectRequestedSurface:AfternoteProductSurfaceConnections
                             recoveryReady:YES] ==
                AfternoteProductSurfaceConnections,
            @"ready vault permits Connections");
    Require([router selectRequestedSurface:AfternoteProductSurfaceMemory
                             recoveryReady:NO] ==
                AfternoteProductSurfaceRecovery,
            @"recovery gates privileged surfaces");
    Require([router selectRequestedSurface:AfternoteProductSurfaceSettings
                             recoveryReady:NO] ==
                AfternoteProductSurfaceSettings,
            @"Settings remains available during recovery");
    Require(AfternoteNavigationSegmentForSurface(
                AfternoteProductSurfaceSettings) == -1,
            @"auxiliary surfaces do not select product navigation");

    [router beginBrokerRecoveryFromNavigationSegment:1];
    Require([router finishBrokerRecoveryWithVaultLocked:NO] ==
                AfternoteProductSurfaceConnections,
            @"reconnect restores Connections when safe");
    [router beginBrokerRecoveryFromNavigationSegment:1];
    Require([router finishBrokerRecoveryWithVaultLocked:YES] ==
                AfternoteProductSurfaceMemory,
            @"locked reconnect falls back to Notes");
  }
  return 0;
}
