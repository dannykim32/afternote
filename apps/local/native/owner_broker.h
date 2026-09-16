#import <Foundation/Foundation.h>
#include <xpc/xpc.h>

typedef void (^BrokerReply)(NSDictionary *result, NSDictionary *error);
typedef BOOL (^AfternoteBrokerResultValidator)(
    NSString *method, NSDictionary *result, NSDictionary *params);
typedef BOOL (^AfternoteBrokerErrorValidator)(NSDictionary *error);
typedef BOOL (^AfternoteLifecycleTransitionValidator)(
    NSString *method, NSDictionary *before, NSDictionary *after);

@protocol AfternoteOwnerBroker <NSObject>
@property(nonatomic, copy) void (^disconnectHandler)(void);
- (void)requestMethod:(NSString *)method
               params:(NSDictionary *)params
                reply:(BrokerReply)reply;
- (void)replaceConnection;
- (void)requestLifecycleTransitionMethod:(NSString *)method
                                   reply:(BrokerReply)reply;
@end

@interface OwnerBrokerConnection : NSObject <AfternoteOwnerBroker> {
  xpc_connection_t _connection;
  NSString *_service;
  dispatch_queue_t _connectionQueue;
  NSUInteger _connectionGeneration;
  uint64_t _requestSequence;
  NSUInteger _disconnectGenerationReported;
  AfternoteBrokerResultValidator _resultValidator;
  AfternoteBrokerErrorValidator _errorValidator;
  AfternoteLifecycleTransitionValidator _lifecycleValidator;
}
@property(nonatomic, copy) void (^disconnectHandler)(void);
- (instancetype)initWithService:(NSString *)service
                resultValidator:(AfternoteBrokerResultValidator)resultValidator
                 errorValidator:(AfternoteBrokerErrorValidator)errorValidator
             lifecycleValidator:(AfternoteLifecycleTransitionValidator)lifecycleValidator;
- (BOOL)requestSynchronouslyMethod:(NSString *)method
                            params:(NSDictionary *)params
                            result:(NSDictionary **)result
                             error:(NSDictionary **)error;
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
- (BOOL)testRejectsSerializedResponse:(NSString *)serialized
                               method:(NSString *)method
                               params:(NSDictionary *)params;
- (BOOL)testAcceptsSerializedResponse:(NSString *)serialized
                               method:(NSString *)method
                               params:(NSDictionary *)params;
#endif
@end
