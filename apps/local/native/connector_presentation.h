#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, AfternoteConnectorState) {
  AfternoteConnectorStateChecking,
  AfternoteConnectorStateConnecting,
  AfternoteConnectorStateNotInstalled,
  AfternoteConnectorStateAvailable,
  AfternoteConnectorStateActive,
  AfternoteConnectorStateNeedsAttention,
};

typedef NS_ENUM(NSInteger, AfternoteConnectorAction) {
  AfternoteConnectorActionNone,
  AfternoteConnectorActionGetTool,
  AfternoteConnectorActionConnect,
  AfternoteConnectorActionPrepareReconnect,
  AfternoteConnectorActionRepair,
  AfternoteConnectorActionCheckAgain,
  AfternoteConnectorActionReviewSetup,
};

@interface AfternoteConnectorPresentation : NSObject

@property(nonatomic, readonly) AfternoteConnectorState state;
@property(nonatomic, readonly) AfternoteConnectorAction action;
@property(nonatomic, copy, readonly) NSString *badge;
@property(nonatomic, copy, readonly) NSString *tone;
@property(nonatomic, copy, readonly) NSString *summary;
@property(nonatomic, copy, readonly) NSString *connectionTitle;
@property(nonatomic, copy, readonly) NSString *connectionDetail;

+ (instancetype)presentationForTool:(NSString *)displayName
                             status:(NSDictionary *)status
                          connected:(BOOL)connected
                            revoked:(BOOL)revoked
                  reconnectPrepared:(BOOL)reconnectPrepared
                    lastActiveLabel:(NSString *)lastActiveLabel;

@end
