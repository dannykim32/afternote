#import <Foundation/Foundation.h>

@protocol AfternoteSoftwareUpdateDriver <NSObject>
@property(nonatomic) BOOL automaticallyChecksForUpdates;
@property(nonatomic, readonly) BOOL canCheckForUpdates;
- (void)checkForUpdates:(id)sender;
@end

@interface AfternoteSoftwareUpdateController : NSObject

- (instancetype)initWithDriver:(id<AfternoteSoftwareUpdateDriver>)driver;

@property(nonatomic, readonly) BOOL available;
@property(nonatomic) BOOL automaticallyChecksForUpdates;
@property(nonatomic, readonly) BOOL canCheckForUpdates;

- (void)checkForUpdates:(id)sender;

@end

AfternoteSoftwareUpdateController *AfternoteCreateSoftwareUpdateController(void);
