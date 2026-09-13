#import "owner_broker_contract.h"

// Foundation-only test adapter. Exercises the same three functions used by the
// owner app without starting AppKit, a broker, or an authentication session.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 64;
    NSData *data = [NSData dataWithContentsOfFile:
        [NSString stringWithUTF8String:argv[1]]];
    if (data == nil) return 65;
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![value isKindOfClass:[NSDictionary class]]) return 65;
    NSDictionary *fixture = value;
    NSString *kind = fixture[@"kind"];
    NSString *method = fixture[@"method"];
    NSDictionary *result = fixture[@"result"];
    NSDictionary *params = fixture[@"params"];
    BOOL accepted = NO;
    if ([kind isEqual:@"result"] && [method isKindOfClass:[NSString class]] &&
        [result isKindOfClass:[NSDictionary class]] &&
        [params isKindOfClass:[NSDictionary class]]) {
      accepted = AfternoteBrokerResultIsValid(method, result, params);
    } else if ([kind isEqual:@"error"] &&
               [result isKindOfClass:[NSDictionary class]]) {
      accepted = AfternoteBrokerErrorIsValid(result);
    } else if ([kind isEqual:@"lifecycle"] &&
               [method isKindOfClass:[NSString class]] &&
               [fixture[@"before"] isKindOfClass:[NSDictionary class]] &&
               [result isKindOfClass:[NSDictionary class]]) {
      accepted = AfternoteBrokerLifecycleTransitionIsValid(
          method, fixture[@"before"], result);
    } else {
      return 65;
    }
    puts(accepted ? "true" : "false");
    return 0;
  }
}
