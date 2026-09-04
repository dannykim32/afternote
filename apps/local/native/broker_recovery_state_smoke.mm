#import <Foundation/Foundation.h>

#import "broker_recovery_state.h"

int main() {
  @autoreleasepool {
    NSDictionary *output = @{
      @"firstDelayMs" : @((NSInteger)(
          AfternoteBrokerRecoveryDelaySeconds(1) * 1000)),
      @"firstFailure" : AfternoteBrokerRecoveryOutcomeName(
          AfternoteBrokerRecoveryOutcomeForAttempt(1, NO)),
      @"maxFailure" : AfternoteBrokerRecoveryOutcomeName(
          AfternoteBrokerRecoveryOutcomeForAttempt(3, NO)),
      @"recovered" : AfternoteBrokerRecoveryOutcomeName(
          AfternoteBrokerRecoveryOutcomeForAttempt(2, YES)),
    };
    NSData *data = [NSJSONSerialization dataWithJSONObject:output
                                                   options:0
                                                     error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
  }
  return 0;
}
