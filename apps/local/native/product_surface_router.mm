#import "product_surface_router.h"

NSInteger AfternoteNavigationSegmentForSurface(AfternoteProductSurface surface) {
  if (surface == AfternoteProductSurfaceMemory ||
      surface == AfternoteProductSurfaceSetup) return 0;
  if (surface == AfternoteProductSurfaceConnections) return 1;
  return -1;
}

NSInteger AfternoteTabIndexForSurface(AfternoteProductSurface surface) {
  switch (surface) {
    case AfternoteProductSurfaceMemory: return 0;
    case AfternoteProductSurfaceConnections: return 1;
    case AfternoteProductSurfaceRecovery: return 2;
    case AfternoteProductSurfaceSetup: return 3;
    case AfternoteProductSurfaceSettings: return 4;
  }
  return NSNotFound;
}

@interface AfternoteProductSurfaceRouter ()
@property(nonatomic) AfternoteProductSurface surface;
@property(nonatomic) AfternoteProductSurface recoveryDestination;
@end

@implementation AfternoteProductSurfaceRouter

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  self.surface = AfternoteProductSurfaceMemory;
  self.recoveryDestination = AfternoteProductSurfaceMemory;
  return self;
}

- (AfternoteProductSurface)selectRequestedSurface:(AfternoteProductSurface)surface
                                     recoveryReady:(BOOL)recoveryReady {
  BOOL privileged = surface == AfternoteProductSurfaceMemory ||
      surface == AfternoteProductSurfaceConnections;
  self.surface = !recoveryReady && privileged
      ? AfternoteProductSurfaceRecovery
      : surface;
  return self.surface;
}

- (void)beginBrokerRecoveryFromNavigationSegment:(NSInteger)segment {
  self.recoveryDestination = segment ==
      AfternoteNavigationSegmentForSurface(AfternoteProductSurfaceConnections)
      ? AfternoteProductSurfaceConnections
      : AfternoteProductSurfaceMemory;
}

- (AfternoteProductSurface)finishBrokerRecoveryWithVaultLocked:(BOOL)vaultLocked {
  self.surface = !vaultLocked &&
      self.recoveryDestination == AfternoteProductSurfaceConnections
      ? AfternoteProductSurfaceConnections
      : AfternoteProductSurfaceMemory;
  return self.surface;
}

@end
