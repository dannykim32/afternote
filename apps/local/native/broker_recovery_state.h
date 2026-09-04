#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, AfternoteBrokerRecoveryOutcome) {
  AfternoteBrokerRecoveryOutcomeRetry = 0,
  AfternoteBrokerRecoveryOutcomeRecovered = 1,
  AfternoteBrokerRecoveryOutcomeUnavailable = 2,
};

AfternoteBrokerRecoveryOutcome AfternoteBrokerRecoveryOutcomeForAttempt(
    NSUInteger attempt,
    BOOL brokerReady);
NSTimeInterval AfternoteBrokerRecoveryDelaySeconds(NSUInteger attempt);
NSString *AfternoteBrokerRecoveryOutcomeName(
    AfternoteBrokerRecoveryOutcome outcome);
