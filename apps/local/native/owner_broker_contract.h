#pragma once
#import <Foundation/Foundation.h>

// The owner's preference and the broker response contract must accept the same
// durations. Keep these values shared by presentation and validation.
constexpr int64_t kRoutineAuthenticationFifteenMinutesMilliseconds = 15 * 60 * 1000;
constexpr int64_t kRoutineAuthenticationFourHoursMilliseconds = 4 * 60 * 60 * 1000;
constexpr int64_t kRoutineAuthenticationDailyMilliseconds = 24 * 60 * 60 * 1000;

// The owner app and its command-line entry points use the same response contract.
// No AppKit, transport, or live Vault state is needed to validate these dictionaries.
BOOL AfternoteBrokerResultIsValid(NSString *method, NSDictionary *result,
                                 NSDictionary *params);
BOOL AfternoteBrokerErrorIsValid(NSDictionary *error);
BOOL AfternoteBrokerLifecycleTransitionIsValid(NSString *method,
                                              NSDictionary *before,
                                              NSDictionary *after);
