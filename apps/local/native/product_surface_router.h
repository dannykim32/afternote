#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, AfternoteProductSurface) {
  AfternoteProductSurfaceMemory = 10,
  AfternoteProductSurfaceConnections = 20,
  AfternoteProductSurfaceRecovery = 30,
  AfternoteProductSurfaceSetup = 40,
  AfternoteProductSurfaceSettings = 50,
};

NSInteger AfternoteNavigationSegmentForSurface(AfternoteProductSurface surface);
NSInteger AfternoteTabIndexForSurface(AfternoteProductSurface surface);

@interface AfternoteProductSurfaceRouter : NSObject

@property(nonatomic, readonly) AfternoteProductSurface surface;

- (AfternoteProductSurface)selectRequestedSurface:(AfternoteProductSurface)surface
                                     recoveryReady:(BOOL)recoveryReady;
- (void)beginBrokerRecoveryFromNavigationSegment:(NSInteger)segment;
- (AfternoteProductSurface)finishBrokerRecoveryWithVaultLocked:(BOOL)vaultLocked;

@end
