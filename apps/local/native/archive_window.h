#pragma once
#import <AppKit/AppKit.h>
#import "owner_broker.h"

// A bounded, read-only Archive browser. Parent owns authentication/lifecycle;
// every invalidation clears this window and pauses any in-flight import.
@interface AfternoteArchiveWindow : NSWindowController
@property(nonatomic, strong) id<AfternoteOwnerBroker> broker;
@property(nonatomic, copy) void (^authenticate)(void);
- (void)openAuthenticated:(BOOL)authenticated;
- (void)clearPlaintext:(NSString *)message;
@end
