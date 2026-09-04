#import "broker_recovery_state.h"

namespace {
constexpr NSUInteger kMaximumBrokerRecoveryAttempts = 3;
}

AfternoteBrokerRecoveryOutcome AfternoteBrokerRecoveryOutcomeForAttempt(
    NSUInteger attempt,
    BOOL brokerReady) {
  if (brokerReady) return AfternoteBrokerRecoveryOutcomeRecovered;
  return attempt < kMaximumBrokerRecoveryAttempts
      ? AfternoteBrokerRecoveryOutcomeRetry
      : AfternoteBrokerRecoveryOutcomeUnavailable;
}

NSTimeInterval AfternoteBrokerRecoveryDelaySeconds(NSUInteger attempt) {
  if (attempt <= 1) return 0.25;
  if (attempt == 2) return 0.75;
  return 1.5;
}

NSString *AfternoteBrokerRecoveryOutcomeName(
    AfternoteBrokerRecoveryOutcome outcome) {
  switch (outcome) {
    case AfternoteBrokerRecoveryOutcomeRetry: return @"retry";
    case AfternoteBrokerRecoveryOutcomeRecovered: return @"recovered";
    case AfternoteBrokerRecoveryOutcomeUnavailable: return @"unavailable";
  }
}
