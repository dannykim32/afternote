#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, AfternoteProductSurface) {
  AfternoteProductSurfaceMemory = 0,
  AfternoteProductSurfaceConnections = 1,
  AfternoteProductSurfaceRecovery = 2,
  AfternoteProductSurfaceSetup = 3,
  AfternoteProductSurfaceSettings = 4,
};

NSInteger AfternoteNavigationSegmentForSurface(AfternoteProductSurface surface);

@interface AfternoteProductSurfaceRouter : NSObject

@property(nonatomic, readonly) AfternoteProductSurface surface;

- (AfternoteProductSurface)selectRequestedSurface:(AfternoteProductSurface)surface
                                     recoveryReady:(BOOL)recoveryReady;
- (void)beginBrokerRecoveryFromNavigationSegment:(NSInteger)segment;
- (AfternoteProductSurface)finishBrokerRecoveryWithVaultLocked:(BOOL)vaultLocked;

@end
