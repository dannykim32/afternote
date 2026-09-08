#import <Foundation/Foundation.h>

typedef void (^BrokerReply)(NSDictionary *result, NSDictionary *error);

@protocol AfternoteOwnerBroker <NSObject>
@property(nonatomic, copy) void (^disconnectHandler)(void);
- (void)requestMethod:(NSString *)method
               params:(NSDictionary *)params
                reply:(BrokerReply)reply;
- (void)replaceConnection;
- (void)requestLifecycleTransitionMethod:(NSString *)method
                                   reply:(BrokerReply)reply;
@end
