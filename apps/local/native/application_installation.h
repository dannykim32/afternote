#import <Foundation/Foundation.h>

BOOL AfternoteEnsureRuntimeInstalled(NSString **errorMessage);
BOOL AfternoteUninstallRuntime(NSString **errorMessage);
NSString *AfternoteInstalledCommandPath(void);
BOOL AfternoteIsAuthenticInstalledCommand(NSString *path);
