#import "owner_broker.h"

#ifndef AFTERNOTE_BROKER_CODE_REQUIREMENT
#error "AFTERNOTE_BROKER_CODE_REQUIREMENT must pin the owner-control app to its broker"
#endif

namespace {

constexpr size_t kMaximumResponseBytes = 1024 * 1024;
constexpr int64_t kOwnerPresenceTimeoutSeconds = 125;
constexpr int64_t kAdminOperationTimeoutSeconds = 10 * 60;

BOOL ExactKeys(NSDictionary *value, NSArray<NSString *> *keys) {
  return value != nil && [[NSSet setWithArray:value.allKeys]
      isEqualToSet:[NSSet setWithArray:keys]];
}

BOOL IsBoolean(id value) {
  return value != nil &&
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

NSString *Identifier() {
  return NSUUID.UUID.UUIDString;
}

}  // namespace

@implementation OwnerBrokerConnection

- (void)connectLocked {
  _connectionGeneration += 1;
  NSUInteger generation = _connectionGeneration;
  _connection = xpc_connection_create_mach_service(
      _service.UTF8String, _connectionQueue, 0);
  if (_connection == nullptr) return;
  xpc_connection_t connection = _connection;
  if (xpc_connection_set_peer_code_signing_requirement(
          connection, AFTERNOTE_BROKER_CODE_REQUIREMENT) != 0) {
    xpc_connection_cancel(connection);
    _connection = nullptr;
    return;
  }
  __weak OwnerBrokerConnection *weakSelf = self;
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) {
    OwnerBrokerConnection *strongSelf = weakSelf;
    if (strongSelf == nil || xpc_get_type(event) != XPC_TYPE_ERROR ||
        strongSelf->_connection != connection ||
        strongSelf->_connectionGeneration != generation ||
        strongSelf->_disconnectGenerationReported == generation) return;
    strongSelf->_disconnectGenerationReported = generation;
    void (^handler)(void) = strongSelf.disconnectHandler;
    if (handler != nil) handler();
  });
  xpc_connection_resume(connection);
}

- (void)resetConnectionLockedForGeneration:(NSUInteger)generation {
  if (generation != _connectionGeneration) return;
  if (_connection != nullptr) {
    xpc_connection_cancel(_connection);
    _connection = nullptr;
  }
  [self connectLocked];
}

- (instancetype)initWithService:(NSString *)service
                resultValidator:(AfternoteBrokerResultValidator)resultValidator
                 errorValidator:(AfternoteBrokerErrorValidator)errorValidator
             lifecycleValidator:(AfternoteLifecycleTransitionValidator)lifecycleValidator {
  self = [super init];
  if (self == nil) return nil;
  _service = [service copy];
  _resultValidator = [resultValidator copy];
  _errorValidator = [errorValidator copy];
  _lifecycleValidator = [lifecycleValidator copy];
  _connectionQueue = dispatch_queue_create(
      "dev.afternote.owner-control.xpc", DISPATCH_QUEUE_SERIAL);
  dispatch_sync(_connectionQueue, ^{ [self connectLocked]; });
  return self;
}

- (void)dealloc {
  if (_connection != nullptr) xpc_connection_cancel(_connection);
}

- (void)sendMethodLocked:(NSString *)method
                  params:(NSDictionary *)params
              connection:(xpc_connection_t)connection
              generation:(NSUInteger)generation
                   reply:(BrokerReply)reply {
  if (_connection != connection || _connectionGeneration != generation) {
    reply(nil, @{ @"code" : @"broker_unavailable",
                  @"message" : @"The Afternote broker connection changed." });
    return;
  }
  NSString *requestId = Identifier();
  NSDictionary *request = @{
    @"protocolVersion" : @1,
    @"requestId" : requestId,
    @"method" : method,
    @"params" : params,
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:request options:0 error:nil];
  if (data == nil || data.length == 0 || data.length > kMaximumResponseBytes) {
    reply(nil, @{ @"code" : @"invalid_request",
                  @"message" : @"The owner request could not be encoded." });
    return;
  }
  NSString *serialized = [[NSString alloc] initWithData:data
                                                encoding:NSUTF8StringEncoding];
  xpc_object_t message = xpc_dictionary_create(nullptr, nullptr, 0);
  xpc_dictionary_set_string(message, "request", serialized.UTF8String);
  xpc_connection_send_message_with_reply(
      connection, message,
      dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0),
      ^(xpc_object_t response) {
    dispatch_async(self->_connectionQueue, ^{
      if (self->_connection != connection ||
          self->_connectionGeneration != generation) return;
      if (response == nullptr || xpc_get_type(response) == XPC_TYPE_ERROR) {
        reply(nil, @{ @"code" : @"broker_unavailable",
                      @"message" : @"The Afternote broker is unavailable or restarting." });
        return;
      }
      const char *transportError = xpc_dictionary_get_string(response, "error");
      if (transportError != nullptr) {
        reply(nil, @{ @"code" : @"broker_unavailable",
                      @"message" : @"The Afternote broker refused the native connection." });
        return;
      }
      const char *bytes = xpc_dictionary_get_string(response, "response");
      if (bytes == nullptr || strlen(bytes) > kMaximumResponseBytes) {
        [self rejectInvalidResponseLocked:@"The broker returned an invalid response."
                               generation:generation reply:reply];
        return;
      }
      NSString *responseString = [[NSString alloc]
          initWithBytes:bytes length:strlen(bytes) encoding:NSUTF8StringEncoding];
      [self deliverSerializedResponseLocked:responseString requestId:requestId
                                     method:method params:params
                                 generation:generation reply:reply];
    });
  });
}

- (void)requestMethod:(NSString *)method
               params:(NSDictionary *)params
                reply:(BrokerReply)reply {
  dispatch_async(_connectionQueue, ^{
    if (self->_connection == nullptr) {
      reply(nil, @{ @"code" : @"broker_unavailable",
                    @"message" : @"The Afternote broker identity could not be verified." });
      return;
    }
    xpc_connection_t connection = self->_connection;
    NSUInteger generation = self->_connectionGeneration;
    [self sendMethodLocked:method params:params connection:connection
                generation:generation reply:reply];
  });
}

- (void)replaceConnection {
  dispatch_async(_connectionQueue, ^{
    [self resetConnectionLockedForGeneration:self->_connectionGeneration];
  });
}

- (void)requestLifecycleTransitionMethod:(NSString *)method
                                   reply:(BrokerReply)reply {
  if (![method isEqualToString:@"lifecycle.lock"] &&
      ![method isEqualToString:@"lifecycle.unlock"]) {
    reply(nil, @{ @"code" : @"invalid_request",
                  @"message" : @"Lifecycle transition is invalid." });
    return;
  }
  dispatch_async(_connectionQueue, ^{
    if (self->_connection == nullptr) {
      reply(nil, @{ @"code" : @"broker_unavailable",
                    @"message" : @"The Afternote broker identity could not be verified." });
      return;
    }
    xpc_connection_t connection = self->_connection;
    NSUInteger generation = self->_connectionGeneration;
    [self sendMethodLocked:@"lifecycle.status" params:@{} connection:connection
                generation:generation
                     reply:^(NSDictionary *before, NSDictionary *statusError) {
      if (statusError != nil) {
        reply(nil, statusError);
        return;
      }
      [self sendMethodLocked:method params:@{} connection:connection
                  generation:generation
                       reply:^(NSDictionary *after, NSDictionary *transitionError) {
        if (transitionError != nil) {
          reply(nil, transitionError);
          return;
        }
        if (self->_lifecycleValidator == nil ||
            !self->_lifecycleValidator(method, before, after)) {
          [self rejectInvalidResponseLocked:
              @"Lifecycle transition response did not match its preflight."
                                 generation:generation reply:reply];
          return;
        }
        reply(after, nil);
      }];
    }];
  });
}

- (BOOL)requestSynchronouslyMethod:(NSString *)method
                            params:(NSDictionary *)params
                            result:(NSDictionary **)result
                             error:(NSDictionary **)error {
  __block NSDictionary *receivedResult = nil;
  __block NSDictionary *receivedError = nil;
  dispatch_semaphore_t completed = dispatch_semaphore_create(0);
  [self requestMethod:method params:params
                reply:^(NSDictionary *value, NSDictionary *failure) {
    receivedResult = value;
    receivedError = failure;
    dispatch_semaphore_signal(completed);
  }];
  if (dispatch_semaphore_wait(
          completed, dispatch_time(DISPATCH_TIME_NOW,
              (kOwnerPresenceTimeoutSeconds + kAdminOperationTimeoutSeconds) *
                  NSEC_PER_SEC)) != 0) return NO;
  if (result != nullptr) *result = receivedResult;
  if (error != nullptr) *error = receivedError;
  return YES;
}

- (void)rejectInvalidResponseLocked:(NSString *)message
                         generation:(NSUInteger)generation
                              reply:(BrokerReply)reply {
  if (generation != _connectionGeneration) return;
  void (^handler)(void) = self.disconnectHandler;
  [self resetConnectionLockedForGeneration:generation];
  if (handler != nil) handler();
  reply(nil, @{ @"code" : @"invalid_response", @"message" : message });
}

- (void)deliverSerializedResponseLocked:(NSString *)serialized
                               requestId:(NSString *)requestId
                                  method:(NSString *)method
                                  params:(NSDictionary *)params
                              generation:(NSUInteger)generation
                                   reply:(BrokerReply)reply {
  NSData *responseData = [serialized dataUsingEncoding:NSUTF8StringEncoding];
  id decoded = responseData == nil ? nil :
      [NSJSONSerialization JSONObjectWithData:responseData options:0 error:nil];
  if (![decoded isKindOfClass:[NSDictionary class]]) {
    [self rejectInvalidResponseLocked:@"The broker returned an invalid response."
                           generation:generation reply:reply];
    return;
  }
  NSDictionary *object = decoded;
  id ok = object[@"ok"];
  if (![object[@"protocolVersion"] isEqual:@1] ||
      ![object[@"requestId"] isEqual:requestId] || !IsBoolean(ok)) {
    [self rejectInvalidResponseLocked:
        @"The broker response context did not match this request."
                           generation:generation reply:reply];
    return;
  }
  if ([ok boolValue]) {
    id result = object[@"result"];
    if (![result isKindOfClass:[NSDictionary class]] ||
        !ExactKeys(object, @[ @"protocolVersion", @"requestId", @"ok", @"result" ]) ||
        _resultValidator == nil || !_resultValidator(method, result, params)) {
      [self rejectInvalidResponseLocked:
          @"The broker returned a malformed operation result."
                             generation:generation reply:reply];
      return;
    }
    reply(result, nil);
    return;
  }
  id error = object[@"error"];
  if (![error isKindOfClass:[NSDictionary class]] ||
      !ExactKeys(object, @[ @"protocolVersion", @"requestId", @"ok", @"error" ]) ||
      _errorValidator == nil || !_errorValidator(error)) {
    [self rejectInvalidResponseLocked:
        @"The broker returned a malformed error result."
                           generation:generation reply:reply];
    return;
  }
  reply(nil, error);
}

#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
- (BOOL)testRejectsSerializedResponse:(NSString *)serialized
                               method:(NSString *)method
                               params:(NSDictionary *)params {
  __block BOOL rejected = NO;
  dispatch_sync(_connectionQueue, ^{
    NSString *requestId = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    NSUInteger generation = self->_connectionGeneration;
    [self deliverSerializedResponseLocked:serialized requestId:requestId
                                   method:method params:params
                               generation:generation
                                    reply:^(NSDictionary *result,
                                            NSDictionary *error) {
      rejected = result == nil &&
          [error[@"code"] isEqualToString:@"invalid_response"] &&
          self->_connectionGeneration == generation + 1;
    }];
  });
  return rejected;
}

- (BOOL)testAcceptsSerializedResponse:(NSString *)serialized
                               method:(NSString *)method
                               params:(NSDictionary *)params {
  __block BOOL accepted = NO;
  dispatch_sync(_connectionQueue, ^{
    NSString *requestId = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    NSUInteger generation = self->_connectionGeneration;
    [self deliverSerializedResponseLocked:serialized requestId:requestId
                                   method:method params:params
                               generation:generation
                                    reply:^(NSDictionary *result,
                                            NSDictionary *error) {
      accepted = result != nil && error == nil &&
          self->_connectionGeneration == generation;
    }];
  });
  return accepted;
}
#endif

@end
