#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#import "plain_text_list_formatting.h"
#import "broker_recovery_state.h"
#import "connector_overview.h"
#import "connector_presentation.h"
#import "native_appearance.h"
#import "connections_view.h"
#import "note_editor_view.h"
#import "notes_retrieval.h"
#import "semantic_settings.h"
#import "owner_broker.h"
#import "owner_broker_contract.h"
#import "product_surface_router.h"
#import "setup_guide_state.h"
#import "application_installation.h"
#import "software_update.h"

#ifndef AFTERNOTE_OWNER_CONTROL_MACH_SERVICE
#define AFTERNOTE_OWNER_CONTROL_MACH_SERVICE "dev.afternote.vault-broker.owner-control"
#endif

#ifndef AFTERNOTE_BROKER_CODE_REQUIREMENT
#error "AFTERNOTE_BROKER_CODE_REQUIREMENT must pin the owner-control app to its broker"
#endif

#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS) && \
    (!defined(AFTERNOTE_DEVELOPMENT_BUILD) || defined(AFTERNOTE_RELEASE_BUILD))
#error "Owner-presence bypass is restricted to development builds"
#endif

namespace {

constexpr size_t kMaximumResponseBytes = 1024 * 1024;
constexpr int64_t kIntegrationCommandTimeoutSeconds = 45;
constexpr CGFloat kAskComposerHeight = 38;
constexpr CGFloat kAskComposerMaximumHeight = 78;
constexpr CGFloat kAskIconSize = 15;
constexpr CGFloat kAskFieldHeight = 20;
constexpr CGFloat kAskFieldMaximumHeight = 62;
constexpr CGFloat kAskSubmitButtonSize = 28;
typedef NS_ENUM(NSInteger, AfternoteLibraryMode) {
  AfternoteLibraryModeWrite = 0,
  AfternoteLibraryModeAsk = 1,
  AfternoteLibraryModeBrowse = 2,
};

NSString *const kLibraryResultKindKey = @"resultKind";
NSString *const kLibrarySearchResultKind = @"search";
NSString *const kSetupGuideDismissedDefaultsKey =
    @"dev.afternote.setup-guide-dismissed";
NSString *const kRoutineAuthenticationDefaultsKey =
    @"dev.afternote.routine-authentication-ttl-ms";

int64_t RoutineAuthenticationTtlMilliseconds() {
  NSNumber *stored = [NSUserDefaults.standardUserDefaults
      objectForKey:kRoutineAuthenticationDefaultsKey];
  int64_t value = [stored isKindOfClass:[NSNumber class]]
      ? stored.longLongValue
      : kRoutineAuthenticationDailyMilliseconds;
  for (NSNumber *allowed in @[
         @(kRoutineAuthenticationFifteenMinutesMilliseconds),
         @(kRoutineAuthenticationFourHoursMilliseconds),
         @(kRoutineAuthenticationDailyMilliseconds),
       ]) {
    if (value == allowed.longLongValue) return value;
  }
  return kRoutineAuthenticationDailyMilliseconds;
}

NSString *ServiceName() {
  return [NSString stringWithUTF8String:AFTERNOTE_OWNER_CONTROL_MACH_SERVICE];
}

NSString *StringValue(id value, NSString *fallback = @"") {
  return [value isKindOfClass:[NSString class]] ? value : fallback;
}

NSString *ActiveNoteIdentifier(NSDictionary *note) {
  NSString *identifier = StringValue(note[@"id"]);
  return identifier.length > 0 ? identifier : StringValue(note[@"noteId"]);
}

NSArray *ArrayValue(id value) {
  return [value isKindOfClass:[NSArray class]] ? value : @[];
}

BOOL WriteExclusivePrivateData(NSString *path, NSData *data) {
  if (path.length == 0 || data == nil || !path.isAbsolutePath ||
      [path rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location !=
          NSNotFound) return NO;
  int descriptor = open(path.fileSystemRepresentation,
                        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
                        S_IRUSR | S_IWUSR);
  if (descriptor < 0) return NO;
  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger remaining = data.length;
  BOOL complete = YES;
  while (remaining > 0) {
    ssize_t written = write(descriptor, bytes, remaining);
    if (written <= 0) {
      complete = NO;
      break;
    }
    bytes += written;
    remaining -= (NSUInteger)written;
  }
  if (complete && fsync(descriptor) != 0) complete = NO;
  if (close(descriptor) != 0) complete = NO;
  if (!complete) unlink(path.fileSystemRepresentation);
  return complete;
}

NSString *BoundedProcessMessage(NSData *data, NSString *fallback) {
  NSString *raw = data.length > 0
      ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
      : @"";
  NSString *line = [[raw componentsSeparatedByCharactersInSet:
      NSCharacterSet.newlineCharacterSet] componentsJoinedByString:@" "];
  line = [[line componentsSeparatedByCharactersInSet:
      NSCharacterSet.controlCharacterSet] componentsJoinedByString:@""];
  line = [line stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  if (line.length == 0) line = fallback;
  if (line.length > 280) line = [[line substringToIndex:277] stringByAppendingString:@"…"];
  return line;
}

NSString *IntegrationFailureMessage(NSData *data, NSString *fallback) {
  if (data.length > 0 && data.length <= kMaximumResponseBytes) {
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if ([value isKindOfClass:[NSDictionary class]]) {
      NSString *message = StringValue(((NSDictionary *)value)[@"message"]);
      if (message.length > 0) {
        NSData *messageData = [message dataUsingEncoding:NSUTF8StringEncoding];
        return BoundedProcessMessage(messageData, fallback);
      }
    }
  }
  return BoundedProcessMessage(data, fallback);
}

NSDictionary *RunIntegrationCommand(NSString *command, NSArray<NSString *> *arguments) {
  if (command.length == 0 ||
      !AfternoteIsAuthenticInstalledCommand(command)) {
    return @{ @"error" : @"The packaged Afternote command could not be found." };
  }
  NSTask *task = [[NSTask alloc] init];
  NSPipe *standardOutput = [NSPipe pipe];
  NSPipe *standardError = [NSPipe pipe];
  task.executableURL = [NSURL fileURLWithPath:command];
  task.arguments = arguments;
  task.currentDirectoryURL = [[NSURL fileURLWithPath:command] URLByDeletingLastPathComponent];
  NSDictionary<NSString *, NSString *> *processEnvironment =
      NSProcessInfo.processInfo.environment;
#if defined(AFTERNOTE_RELEASE_BUILD)
  NSMutableDictionary<NSString *, NSString *> *environment = [NSMutableDictionary dictionary];
  for (NSString *name in processEnvironment) {
    if ([name isEqualToString:@"TMPDIR"] || [name isEqualToString:@"LANG"] ||
        [name hasPrefix:@"LC_"]) {
      NSString *value = processEnvironment[name];
      if (value.length > 0) environment[name] = value;
    }
  }
#else
  NSMutableDictionary<NSString *, NSString *> *environment =
      [processEnvironment mutableCopy];
#endif
  NSString *home = NSHomeDirectory();
  NSArray<NSString *> *pathParts = @[
    [home stringByAppendingPathComponent:@".local/bin"],
    [command stringByDeletingLastPathComponent],
    @"/opt/homebrew/bin",
    @"/usr/local/bin",
    @"/usr/bin:/bin:/usr/sbin:/sbin",
  ];
  environment[@"HOME"] = home;
  environment[@"PATH"] = [pathParts componentsJoinedByString:@":"];
  task.environment = environment;
  task.standardOutput = standardOutput;
  task.standardError = standardError;
  NSError *launchError = nil;
  if (![task launchAndReturnError:&launchError]) {
    NSData *message = [[launchError localizedDescription] dataUsingEncoding:NSUTF8StringEncoding];
    return @{ @"error" : BoundedProcessMessage(
        message, @"Afternote could not start its integration helper.") };
  }
  __block BOOL timedOut = NO;
  NSTimeInterval timeoutSeconds = arguments.count >= 2 && [arguments[0] isEqualToString:@"semantic"] && [arguments[1] isEqualToString:@"install"]
      ? 900.0 : kIntegrationCommandTimeoutSeconds;
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
  NSString *testingTimeout = NSProcessInfo.processInfo.environment[
      @"AFTERNOTE_TEST_INTEGRATION_TIMEOUT_MS"];
  NSInteger testingMilliseconds = testingTimeout.integerValue;
  if (testingMilliseconds >= 10 && testingMilliseconds <= 5000) {
    timeoutSeconds = (NSTimeInterval)testingMilliseconds / 1000.0;
  }
#endif
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,
                               (int64_t)(timeoutSeconds * NSEC_PER_SEC)),
                 dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    if (!task.running) return;
    timedOut = YES;
    [task terminate];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
                   dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      if (task.running) kill(task.processIdentifier, SIGKILL);
    });
  });
  NSData *outputData = [standardOutput.fileHandleForReading readDataToEndOfFile];
  NSData *errorData = [standardError.fileHandleForReading readDataToEndOfFile];
  [task waitUntilExit];
  if (timedOut) {
    return @{ @"error" : @"Afternote integration setup timed out." };
  }
  if (task.terminationStatus != 0) {
    return @{ @"error" : IntegrationFailureMessage(
        errorData, @"Afternote could not update this integration.") };
  }
  NSError *parseError = nil;
  id value = [NSJSONSerialization JSONObjectWithData:outputData options:0 error:&parseError];
  if (![value isKindOfClass:[NSDictionary class]]) {
    return @{ @"error" : @"Afternote returned an invalid integration status." };
  }
  return @{ @"result" : value };
}

NSUInteger AdvanceIntegrationGeneration(
    NSMutableDictionary<NSString *, NSNumber *> *generations,
    NSString *kind) {
  NSUInteger generation = [generations[kind] unsignedIntegerValue] + 1;
  generations[kind] = @(generation);
  return generation;
}

BOOL IntegrationGenerationIsCurrent(
    NSDictionary<NSString *, NSNumber *> *generations,
    NSString *kind,
    NSUInteger generation) {
  return generation == [generations[kind] unsignedIntegerValue];
}

NSString *ScopeLabel(NSString *scope) {
  if ([scope isEqualToString:@"memory.remember"]) return @"Remember";
  if ([scope isEqualToString:@"memory.recall"]) return @"Recall";
  if ([scope isEqualToString:@"memory.get_note"]) return @"Read cited note";
  if ([scope isEqualToString:@"memory.forget"]) return @"Forget";
  return @"Unknown scope";
}

NSString *ScopesLabel(NSArray *scopes) {
  NSMutableArray<NSString *> *labels = [NSMutableArray array];
  for (id scope in scopes) {
    if ([scope isKindOfClass:[NSString class]]) [labels addObject:ScopeLabel(scope)];
  }
  return labels.count == 0 ? @"No scopes" : [labels componentsJoinedByString:@", "];
}

NSString *DayLabel(id value) {
  NSString *text = StringValue(value);
  if (text.length == 0) return @"UNKNOWN DATE";
  static NSDateFormatter *output;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    output = [[NSDateFormatter alloc] init];
    output.dateFormat = @"EEEE, MMM d";
  });
  NSDate *date = DateValue(text);
  return date == nil ? @"UNKNOWN DATE" : [[output stringFromDate:date] uppercaseString];
}

NSString *TimeLabel(id value) {
  NSString *text = StringValue(value);
  if (text.length == 0) return @"UNKNOWN TIME";
  static NSDateFormatter *output;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    output = [[NSDateFormatter alloc] init];
    output.timeStyle = NSDateFormatterShortStyle;
    output.dateStyle = NSDateFormatterNoStyle;
  });
  NSDate *date = DateValue(text);
  return date == nil ? @"UNKNOWN TIME" : [output stringFromDate:date];
}

#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING) || defined(AFTERNOTE_OWNER_CONTROL_UI_PREVIEW)
void SeedNotesFixture(AfternoteNotesRetrieval *state, NSArray *notes) {
  AfternoteNotesRequest *request = [state beginAppending:NO];
  NSMutableArray *matches = [NSMutableArray array];
  for (NSDictionary *note in notes) {
    NSMutableDictionary *citation = [note mutableCopy];
    citation[@"noteId"] = note[@"id"] ?: @"fixture-note";
    [matches addObject:@{ @"citation": citation }];
  }
  [state complete:request result:@{ @"notes": notes, @"results": matches,
                                   @"nextCursor": NSNull.null } error:nil];
}
#endif

BOOL ConnectorHasCurrentAuthority(NSDictionary *client) {
  NSString *status = StringValue(client[@"status"]);
  return [status isEqualToString:@"active"] || [status isEqualToString:@"paired"];
}

NSArray<NSString *> *ConnectorLifecycleHistory(
    NSArray<NSDictionary *> *clients,
    NSArray<NSDictionary *> *grants,
    NSArray<NSDictionary *> *events) {
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
  NSMutableSet<NSString *> *seen = [NSMutableSet set];
  void (^addEntry)(NSString *, NSString *) = ^(NSString *action, NSString *date) {
    if (date.length == 0) return;
    NSString *key = [NSString stringWithFormat:@"%@|%@", action, date];
    if ([seen containsObject:key]) return;
    [seen addObject:key];
    [entries addObject:@{
      @"date" : date,
      @"text" : [NSString stringWithFormat:@"%@ · %@", action, DateLabel(date)],
    }];
  };
  for (NSDictionary *event in events) {
    if (![StringValue(event[@"outcome"]) isEqualToString:@"success"]) continue;
    NSString *operation = StringValue(event[@"operation"]);
    if ([operation isEqualToString:@"client.pair"]) {
      addEntry(@"Connected", StringValue(event[@"occurredAt"]));
    } else if ([operation isEqualToString:@"client.revoke"]) {
      addEntry(@"Revoked", StringValue(event[@"occurredAt"]));
    }
  }
  for (NSDictionary *client in clients) {
    NSString *clientId = StringValue(client[@"clientId"]);
    addEntry(@"Connected", StringValue(client[@"pairedAt"]));
    NSArray *clientGrants = [grants filteredArrayUsingPredicate:
        [NSPredicate predicateWithBlock:^BOOL(NSDictionary *grant, NSDictionary *bindings) {
      (void)bindings;
      return [StringValue(grant[@"clientId"]) isEqualToString:clientId];
    }]];
    for (NSDictionary *grant in clientGrants) {
      addEntry(@"Revoked", StringValue(grant[@"revokedAt"]));
    }
  }
  [entries sortUsingComparator:^NSComparisonResult(NSDictionary *left,
                                                    NSDictionary *right) {
    return [StringValue(right[@"date"]) compare:StringValue(left[@"date"])];
  }];
  NSMutableArray<NSString *> *history = [NSMutableArray array];
  NSUInteger entryCount = MIN(entries.count, (NSUInteger)12);
  for (NSUInteger index = 0; index < entryCount; index++) {
    [history addObject:StringValue(entries[index][@"text"])];
  }
  return history;
}

OwnerBrokerConnection *NewOwnerBrokerConnection(NSString *service) {
  return [[OwnerBrokerConnection alloc]
      initWithService:service
      resultValidator:^BOOL(NSString *method, NSDictionary *result,
                            NSDictionary *params) {
        return AfternoteBrokerResultIsValid(method, result, params);
      }
      errorValidator:^BOOL(NSDictionary *error) {
        return AfternoteBrokerErrorIsValid(error);
      }
      lifecycleValidator:^BOOL(NSString *method, NSDictionary *before,
                               NSDictionary *after) {
        return AfternoteBrokerLifecycleTransitionIsValid(method, before, after);
      }];
}

}  // namespace


BOOL ParseRecoveryPolicy(NSString *value, NSString **action, id *destination) {
  if ([value isEqualToString:@"keep"] || [value isEqualToString:@"delete"]) {
    *action = value;
    *destination = NSNull.null;
    return YES;
  }
  if (![value hasPrefix:@"move:"]) return NO;
  NSString *path = [value substringFromIndex:5];
  if (path.length == 0 || path.length > 4096 || !path.isAbsolutePath ||
      [path rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
    return NO;
  }
  *action = @"move";
  *destination = path.stringByStandardizingPath;
  return YES;
}

int RunAdminCommand(int argc, const char *argv[]) {
  NSString *method = nil;
  NSDictionary *params = nil;
  if (argc == 4 && strcmp(argv[1], "--admin-export") == 0) {
    NSString *format = [NSString stringWithUTF8String:argv[2]];
    NSString *destination = [NSString stringWithUTF8String:argv[3]];
    if ((! [format isEqualToString:@"json"] && ![format isEqualToString:@"markdown"]) ||
        destination.length == 0 || destination.length > 4096 || !destination.isAbsolutePath ||
        [destination rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
      fputs("invalid admin export arguments\n", stderr);
      return 64;
    }
    method = @"admin.export";
    params = @{ @"format" : format, @"destination" : destination.stringByStandardizingPath };
  } else if (argc == 2 && strcmp(argv[1], "--admin-diagnostics") == 0) {
    method = @"admin.diagnostics";
    params = @{};
  } else if (argc == 5 &&
             (strcmp(argv[1], "--admin-prepare-client-rotation") == 0 ||
              strcmp(argv[1], "--admin-prepare-connector-reconnect") == 0)) {
    NSString *kind = [NSString stringWithUTF8String:argv[2]];
    NSString *installIdentity = [NSString stringWithUTF8String:argv[3]];
    NSString *replacementInstallIdentity = [NSString stringWithUTF8String:argv[4]];
    if (![@[ @"codex", @"claude", @"claude-desktop" ] containsObject:kind] ||
        !(installIdentity.length == 36 &&
          [[NSUUID alloc] initWithUUIDString:installIdentity] != nil) ||
        !(replacementInstallIdentity.length == 36 &&
          [[NSUUID alloc] initWithUUIDString:replacementInstallIdentity] != nil) ||
        [installIdentity isEqualToString:replacementInstallIdentity]) {
      fputs("invalid client rotation arguments\n", stderr);
      return 64;
    }
    method = strcmp(argv[1], "--admin-prepare-connector-reconnect") == 0
        ? @"admin.prepare_connector_reconnect" : @"admin.prepare_client_rotation";
    params = @{
      @"kind" : kind,
      @"installIdentity" : installIdentity,
      @"replacementInstallIdentity" : replacementInstallIdentity,
    };
  } else if (argc == 4 && strcmp(argv[1], "--admin-migrate") == 0) {
    NSString *liveValue = [NSString stringWithUTF8String:argv[2]];
    NSString *artifactValue = [NSString stringWithUTF8String:argv[3]];
    NSString *liveAction = nil;
    NSString *artifactAction = nil;
    id liveDestination = nil;
    id artifactDestination = nil;
    if (!ParseRecoveryPolicy(liveValue, &liveAction, &liveDestination) ||
        !ParseRecoveryPolicy(artifactValue, &artifactAction, &artifactDestination)) {
      fputs("invalid migration policy\n", stderr);
      return 64;
    }
    method = @"recovery.migrate";
    params = @{
      @"liveAction" : liveAction,
      @"liveDestination" : liveDestination,
      @"artifactAction" : artifactAction,
      @"artifactDestinationDirectory" : artifactDestination,
    };
  } else if (argc == 3 && strcmp(argv[1], "--admin-restore") == 0) {
    NSString *source = [NSString stringWithUTF8String:argv[2]];
    if (source.length == 0 || source.length > 4096 || !source.isAbsolutePath ||
        [source rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) {
      fputs("invalid restore source\n", stderr);
      return 64;
    }
    method = @"recovery.restore";
    params = @{ @"source" : source.stringByStandardizingPath };
  } else if (argc == 2 && strcmp(argv[1], "--admin-lock") == 0) {
    method = @"lifecycle.lock";
    params = @{};
  } else if (argc == 2 && strcmp(argv[1], "--admin-unlock") == 0) {
    method = @"lifecycle.unlock";
    params = @{};
  } else {
    fputs("invalid native admin command\n", stderr);
    return 64;
  }

  OwnerBrokerConnection *broker = NewOwnerBrokerConnection(ServiceName());
  if (broker == nil) return 1;
  NSDictionary *priorLifecycleStatus = nil;
  NSDictionary *result = nil;
  NSDictionary *error = nil;
  if ([method hasPrefix:@"lifecycle."] &&
      ![broker requestSynchronouslyMethod:@"lifecycle.status" params:@{}
                                   result:&priorLifecycleStatus error:&error]) {
    fputs("native admin request timed out\n", stderr);
    return 1;
  }
  if (error == nil &&
      ![broker requestSynchronouslyMethod:method params:params result:&result error:&error]) {
    fputs("native admin request timed out\n", stderr);
    return 1;
  }
  if (error != nil) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:error options:0 error:nil];
    if (data != nil) fwrite(data.bytes, 1, data.length, stderr);
    fputc('\n', stderr);
    return 1;
  }
  if (priorLifecycleStatus != nil &&
      !AfternoteBrokerLifecycleTransitionIsValid(method, priorLifecycleStatus, result)) {
    fputs("native lifecycle result did not match pre-transition status\n", stderr);
    return 1;
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  if (data == nil || data.length == 0 || data.length > kMaximumResponseBytes) {
    fputs("native admin result could not be encoded\n", stderr);
    return 1;
  }
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  if ([method isEqualToString:@"lifecycle.lock"]) {
    [NSDistributedNotificationCenter.defaultCenter
        postNotificationName:@"dev.afternote.vault-did-lock"
                      object:nil
                    userInfo:nil
          deliverImmediately:YES];
  } else if ([method isEqualToString:@"lifecycle.unlock"]) {
    [NSDistributedNotificationCenter.defaultCenter
        postNotificationName:@"dev.afternote.vault-did-unlock"
                      object:nil
                    userInfo:nil
          deliverImmediately:YES];
  } else if ([method isEqualToString:@"recovery.migrate"] ||
             [method isEqualToString:@"recovery.restore"]) {
    [NSDistributedNotificationCenter.defaultCenter
        postNotificationName:@"dev.afternote.vault-did-unlock"
                      object:nil
                    userInfo:nil
          deliverImmediately:YES];
  }
  return 0;
}

void AddResponderMenuItem(NSMenu *menu, NSString *title, SEL action,
                          NSString *keyEquivalent,
                          NSEventModifierFlags modifierMask) {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title
                                               action:action
                                        keyEquivalent:keyEquivalent];
  item.target = nil;
  item.keyEquivalentModifierMask = modifierMask;
  [menu addItem:item];
}

void InstallApplicationMenu(NSApplication *application) {
  NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@""];

  NSMenuItem *applicationMenuItem = [[NSMenuItem alloc] initWithTitle:@""
                                                               action:nil
                                                        keyEquivalent:@""];
  NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@""];
#if defined(AFTERNOTE_RELEASE_BUILD)
  AddResponderMenuItem(applicationMenu, @"Check for Updates…",
                       @selector(checkForUpdates:), @"", 0);
  [applicationMenu addItem:NSMenuItem.separatorItem];
#endif
  AddResponderMenuItem(applicationMenu, @"Quit Afternote", @selector(terminate:),
                       @"q", NSEventModifierFlagCommand);
  applicationMenuItem.submenu = applicationMenu;
  [mainMenu addItem:applicationMenuItem];

  NSMenuItem *editMenuItem = [[NSMenuItem alloc] initWithTitle:@"Edit"
                                                        action:nil
                                                 keyEquivalent:@""];
  NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
  AddResponderMenuItem(editMenu, @"Undo", @selector(undo:), @"z",
                       NSEventModifierFlagCommand);
  AddResponderMenuItem(editMenu, @"Redo", @selector(redo:), @"z",
                       NSEventModifierFlagCommand | NSEventModifierFlagShift);
  [editMenu addItem:NSMenuItem.separatorItem];
  AddResponderMenuItem(editMenu, @"Cut", @selector(cut:), @"x",
                       NSEventModifierFlagCommand);
  AddResponderMenuItem(editMenu, @"Copy", @selector(copy:), @"c",
                       NSEventModifierFlagCommand);
  AddResponderMenuItem(editMenu, @"Paste", @selector(paste:), @"v",
                       NSEventModifierFlagCommand);
  AddResponderMenuItem(editMenu, @"Select All", @selector(selectAll:), @"a",
                       NSEventModifierFlagCommand);
  editMenuItem.submenu = editMenu;
  [mainMenu addItem:editMenuItem];

  application.mainMenu = mainMenu;
}

NSString *LockedLibraryMessage() {
  return @"The vault is locked. Unlock it here, then authenticate to reopen Notes.";
}

NSString *OwnerApprovalWaitMessage() {
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
  return @"Development bypass active. Approving owner presence automatically…";
#else
  return @"Waiting for Touch ID or your Mac password…";
#endif
}

NSString *OwnerPresenceMode() {
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
  return @"development-bypass";
#else
  return @"required";
#endif
}

NSString *FreshOwnerApprovalDescription() {
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
  return @"The development build will approve owner presence automatically";
#else
  return @"macOS will ask for fresh owner authentication";
#endif
}

@interface AfternoteAskComposerView : NSView
@property(nonatomic) BOOL afternoteFocused;
@end

@implementation AfternoteAskComposerView
- (void)setAfternoteFocused:(BOOL)focused {
  _afternoteFocused = focused;
  self.layer.borderColor = (focused ? AfternoteBrandCaptureColor() : AfternoteBorderColor()).CGColor;
  self.layer.borderWidth = focused ? 1.25 : 1;
}
@end

@interface AfternoteTableRowView : NSTableRowView
@property(nonatomic, strong) NSTrackingArea *afternoteTrackingArea;
@property(nonatomic) BOOL afternoteHovered;
@end

@implementation AfternoteTableRowView
- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  if (self.afternoteTrackingArea != nil) {
    [self removeTrackingArea:self.afternoteTrackingArea];
  }
  self.afternoteTrackingArea = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveInKeyWindow |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:self.afternoteTrackingArea];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  self.afternoteHovered = YES;
  [self setNeedsDisplay:YES];
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  self.afternoteHovered = NO;
  [self setNeedsDisplay:YES];
}

- (void)drawBackgroundInRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  if (self.afternoteHovered && !self.isSelected) {
    NSRect hoverRect = NSInsetRect(self.bounds, 0, 3);
    [[AfternoteBrandCaptureColor() colorWithAlphaComponent:0.06] setFill];
    [[NSBezierPath bezierPathWithRoundedRect:hoverRect xRadius:6 yRadius:6] fill];
  }
  [AfternoteBorderColor() setFill];
  NSRectFill(NSMakeRect(0, NSMaxY(self.bounds) - 1, NSWidth(self.bounds), 1));
}

- (void)drawSelectionInRect:(NSRect)dirtyRect {
  if (self.selectionHighlightStyle == NSTableViewSelectionHighlightStyleNone) return;
  NSRect selectionRect = NSInsetRect(self.bounds, 0, 3);
  [AfternoteBrandCaptureWashColor() setFill];
  [[NSBezierPath bezierPathWithRoundedRect:selectionRect xRadius:6 yRadius:6] fill];
}
@end

@interface AfternoteIntegrationDescriptor : NSObject
@property(nonatomic, copy) NSString *commandKind;
@property(nonatomic, copy) NSString *brokerKind;
@property(nonatomic, copy) NSString *displayName;
+ (instancetype)commandKind:(NSString *)commandKind
                 brokerKind:(NSString *)brokerKind
                displayName:(NSString *)displayName;
@end

@implementation AfternoteIntegrationDescriptor
+ (instancetype)commandKind:(NSString *)commandKind
                 brokerKind:(NSString *)brokerKind
                displayName:(NSString *)displayName {
  AfternoteIntegrationDescriptor *descriptor = [[self alloc] init];
  descriptor.commandKind = commandKind;
  descriptor.brokerKind = brokerKind;
  descriptor.displayName = displayName;
  return descriptor;
}
@end

NSArray<AfternoteIntegrationDescriptor *> *IntegrationDescriptors() {
  static NSArray<AfternoteIntegrationDescriptor *> *descriptors;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    descriptors = @[
      [AfternoteIntegrationDescriptor commandKind:@"codex"
                                       brokerKind:@"codex"
                                      displayName:@"Codex"],
      [AfternoteIntegrationDescriptor commandKind:@"claude-code"
                                       brokerKind:@"claude"
                                      displayName:@"Claude Code"],
      [AfternoteIntegrationDescriptor commandKind:@"claude-desktop"
                                       brokerKind:@"claude-desktop"
                                      displayName:@"Claude Desktop"],
    ];
  });
  return descriptors;
}

@interface OwnerControlDelegate : NSObject <NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate,  NSOpenSavePanelDelegate, AfternoteConnectionsActions, AfternoteNoteEditorActions>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTabView *surfaceTabs;
@property(nonatomic, strong) AfternoteProductSurfaceRouter *surfaceRouter;
@property(nonatomic, strong) NSSegmentedControl *surfaceSelector;
@property(nonatomic, strong) NSButton *memoryNavigationButton;
@property(nonatomic, strong) NSButton *connectionsNavigationButton;
@property(nonatomic, strong) AfternoteConnectionsView *connectionsView;
@property(nonatomic, strong) AfternoteNoteEditorView *noteEditorView;
@property(nonatomic, strong) AfternoteNotesRetrieval *notesRetrieval;
@property(nonatomic, strong) NSStackView *setupContent;
@property(nonatomic, strong) NSView *setupBanner;
@property(nonatomic) BOOL setupGuideDismissed;
@property(nonatomic, strong) NSStackView *recoveryContent;
@property(nonatomic, strong) NSTextField *recoveryStatusLabel;
@property(nonatomic, strong) NSProgressIndicator *recoveryProgress;
@property(nonatomic, strong) NSButton *recoveryRefreshButton;
@property(nonatomic, copy) NSString *recoveryState;
@property(nonatomic, copy) NSString *recoveryErrorMessage;
@property(nonatomic, strong) NSMutableArray<NSButton *> *recoveryActionButtons;
@property(nonatomic) BOOL recoveryOperationInFlight;
@property(nonatomic) NSUInteger recoveryOperationSequence;
@property(nonatomic) NSUInteger recoveryStatusRequestSequence;
@property(nonatomic) NSUInteger brokerRecoverySequence;
@property(nonatomic) NSUInteger brokerRecoveryAttempt;
@property(nonatomic) BOOL brokerRecoveryInFlight;
@property(nonatomic, strong) id<AfternoteOwnerBroker> broker;
@property(nonatomic, strong) NSDictionary *connections;
@property(nonatomic, strong) NSDictionary<NSString *, AfternoteConnectorOverviewItem *> *connectorOverviewByKind;
@property(nonatomic) NSUInteger connectorOverviewGeneration;
@property(nonatomic, strong) NSMutableArray *auditEvents;
@property(nonatomic, copy) NSString *auditCursor;
@property(nonatomic, copy) NSString *ownerExpiresAt;
@property(nonatomic) NSUInteger ownerSessionGeneration;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *revocationTargets;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *integrationStatuses;
@property(nonatomic, strong) NSMutableSet<NSString *> *integrationOperations;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSNumber *> *integrationStatusGenerations;
@property(nonatomic, strong) NSMutableSet<NSString *> *expandedConnectorKinds;
@property(nonatomic, strong) NSTextField *libraryStatusLabel;
@property(nonatomic, strong) NSProgressIndicator *libraryProgress;
@property(nonatomic, strong) NSButton *libraryAuthenticateButton;
@property(nonatomic, strong) NSButton *libraryRefreshButton;
@property(nonatomic, strong) NSSegmentedControl *libraryModeSelector;
@property(nonatomic, strong) NSTabView *libraryWorkspaceTabs;
@property(nonatomic, strong) NSTextField *libraryWorkspaceTitle;
@property(nonatomic, strong) NSTextField *libraryWorkspaceSubtitle;
@property(nonatomic, strong) NSTextField *librarySearch;
@property(nonatomic, strong) AfternoteAskComposerView *askComposer;
@property(nonatomic, strong) NSButton *askButton;
@property(nonatomic, strong) NSButton *clearSearchButton;
@property(nonatomic, strong) NSLayoutConstraint *askComposerHeightConstraint;
@property(nonatomic, strong) NSLayoutConstraint *searchFieldHeightConstraint;
@property(nonatomic, strong) NSStackView *askControls;
@property(nonatomic, strong) NSStackView *browseControls;
@property(nonatomic) BOOL hasVisibleSmartCategories;
@property(nonatomic, strong) NSTextField *resultsHeadingLabel;
@property(nonatomic, strong) NSTableView *noteTable;
@property(nonatomic, strong) AfternoteSearchProgress *searchProgress;
@property(nonatomic, copy) NSString *currentSearchMode;
@property(nonatomic, strong) AfternoteSemanticSettings *semanticSettings;
@property(nonatomic) BOOL semanticActivationInFlight;
@property(nonatomic) BOOL semanticReloadPending;
@property(nonatomic) BOOL semanticPollPending;
@property(nonatomic) NSUInteger semanticPollSequence;
@property(nonatomic) NSInteger semanticIndexedNotes;
@property(nonatomic) NSInteger semanticTotalNotes;
@property(nonatomic) NSTimeInterval semanticLastProgressAt;
@property(nonatomic) NSUInteger semanticStatusFailures;
@property(nonatomic, strong) NSButton *loadMoreNotesButton;
@property(nonatomic, strong) NSButton *libraryRecentButton;
@property(nonatomic, strong) NSButton *createNoteButton;
@property(nonatomic, strong) NSButton *vaultAccessButton;
@property(nonatomic, strong) NSPopUpButton *routineAuthenticationMenu;
@property(nonatomic, strong) AfternoteSoftwareUpdateController *softwareUpdateController;
@property(nonatomic, strong) NSButton *automaticUpdateChecksButton;
@property(nonatomic, strong) NSButton *checkForUpdatesButton;
@property(nonatomic, strong) NSStackView *libraryViews;
@property(nonatomic, strong) NSDictionary *activeNote;
@property(nonatomic, strong) NSArray<NSDictionary *> *revisionSummaries;
@property(nonatomic, copy) NSString *libraryExpiresAt;
@property(nonatomic, copy) NSString *revisionCursor;
@property(nonatomic, copy) NSString *activeDeleteTarget;
@property(nonatomic, strong) NSAlert *librarySensitiveAlert;
@property(nonatomic, strong) NSTextView *librarySensitiveTextView;
@property(nonatomic) BOOL creatingNote;
@property(nonatomic) BOOL inspectingCitation;
@property(nonatomic) BOOL revisionHistoryLoaded;
@property(nonatomic) BOOL libraryMutationInFlight;
@property(nonatomic) BOOL editorSaveConfirmationPending;
@property(nonatomic) BOOL libraryRefreshPending;
@property(nonatomic) BOOL vaultLocked;
@property(nonatomic) BOOL vaultStatusCheckInFlight;
@property(nonatomic) NSUInteger librarySessionGeneration;
@property(nonatomic) NSUInteger libraryNoteRequestSequence;
@property(nonatomic) NSUInteger libraryRevisionRequestSequence;
@property(nonatomic) NSUInteger lifecycleStatusRequestSequence;
@end

@implementation OwnerControlDelegate

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  self.surfaceRouter = [[AfternoteProductSurfaceRouter alloc] init];
  self.notesRetrieval = [AfternoteNotesRetrieval new];
  self.semanticIndexedNotes = -1;
  self.semanticTotalNotes = -1;
  return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.auditEvents = [NSMutableArray array];
  self.connectorOverviewByKind = @{};
  self.revocationTargets = [NSMutableDictionary dictionary];
  self.integrationStatuses = [NSMutableDictionary dictionary];
  self.integrationOperations = [NSMutableSet set];
  self.integrationStatusGenerations = [NSMutableDictionary dictionary];
  self.expandedConnectorKinds = [NSMutableSet set];
  self.revisionSummaries = @[];
  [self.notesRetrieval selectQuery:@"" view:self.notesRetrieval.view];
  self.currentSearchMode = @"checking";
  self.setupGuideDismissed = [NSUserDefaults.standardUserDefaults
      boolForKey:kSetupGuideDismissedDefaultsKey];
  self.recoveryState = @"checking";
  self.recoveryActionButtons = [NSMutableArray array];
  self.softwareUpdateController = AfternoteCreateSoftwareUpdateController();
  [NSDistributedNotificationCenter.defaultCenter
      addObserver:self
         selector:@selector(vaultDidLock:)
             name:@"dev.afternote.vault-did-lock"
           object:nil];
  [NSDistributedNotificationCenter.defaultCenter
      addObserver:self
         selector:@selector(vaultDidUnlock:)
             name:@"dev.afternote.vault-did-unlock"
           object:nil];
#if !defined(AFTERNOTE_OWNER_CONTROL_UI_PREVIEW)
  self.broker = NewOwnerBrokerConnection(ServiceName());
  __weak OwnerControlDelegate *weakSelf = self;
  self.broker.disconnectHandler = ^{
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf brokerDidDisconnect];
    });
  };
#endif
  [self buildWindow];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
#if defined(AFTERNOTE_OWNER_CONTROL_UI_PREVIEW)
  self.integrationStatuses[@"codex"] = @{
    @"toolAvailable" : @YES,
    @"installed" : @YES, @"healthy" : @YES, @"configHealthy" : @YES,
    @"runtimeHealthy" : @YES, @"repairable" : @NO, @"problemCode" : NSNull.null,
  };
  self.integrationStatuses[@"claude-code"] = @{
    @"toolAvailable" : @YES,
    @"installed" : @NO, @"healthy" : @NO, @"configHealthy" : @NO,
    @"runtimeHealthy" : @NO, @"repairable" : @YES,
    @"problemCode" : @"connector_missing",
  };
  self.integrationStatuses[@"claude-desktop"] = @{
    @"toolAvailable" : @YES,
    @"installed" : @NO, @"healthy" : @NO, @"configHealthy" : @NO,
    @"runtimeHealthy" : @NO, @"repairable" : @YES,
    @"problemCode" : @"connector_missing",
  };
  [self setPrivilegedSurfacesReady:YES];
  self.connections = @{
    @"clients" : @[
      @{ @"clientId" : @"11111111-1111-4111-8111-111111111111", @"kind" : @"codex", @"displayLabel" : @"Codex", @"status" : @"active", @"trust" : @"development-only", @"pairedAt" : @"2026-08-28T15:12:00.000Z", @"lastActivityAt" : @"2026-08-28T16:42:00.000Z", @"authorityRevision" : @1, @"activeScopes" : @[ @"memory.remember", @"memory.recall", @"memory.get_note" ], @"sessionSummary" : @{ @"activeCount" : @1, @"latestStatus" : @"active" } },
      @{ @"clientId" : @"33333333-3333-4333-8333-333333333333", @"kind" : @"claude", @"displayLabel" : @"Claude Code", @"status" : @"revoked", @"trust" : @"development-only", @"pairedAt" : @"2026-08-26T10:00:00.000Z", @"lastActivityAt" : @"2026-08-27T11:15:00.000Z", @"authorityRevision" : @2, @"activeScopes" : @[], @"sessionSummary" : @{ @"activeCount" : @0, @"latestStatus" : @"revoked" } },
    ],
    @"grants" : @[
      @{ @"clientId" : @"11111111-1111-4111-8111-111111111111", @"scopes" : @[ @"memory.remember", @"memory.recall", @"memory.get_note" ], @"status" : @"active", @"createdAt" : @"2026-08-28T15:12:00.000Z", @"expiresAt" : NSNull.null, @"revokedAt" : NSNull.null },
      @{ @"clientId" : @"33333333-3333-4333-8333-333333333333", @"scopes" : @[ @"memory.remember", @"memory.recall", @"memory.get_note" ], @"status" : @"revoked", @"createdAt" : @"2026-08-26T10:00:00.000Z", @"expiresAt" : NSNull.null, @"revokedAt" : @"2026-08-27T11:15:00.000Z" },
    ],
    @"sessions" : @[
      @{ @"clientId" : @"11111111-1111-4111-8111-111111111111", @"status" : @"active", @"startedAt" : @"2026-08-28T15:15:00.000Z", @"expiresAt" : @"2026-08-28T19:15:00.000Z", @"lastActivityAt" : @"2026-08-28T16:42:00.000Z" },
      @{ @"clientId" : @"22222222-2222-4222-8222-222222222222", @"status" : @"expired", @"startedAt" : @"2026-08-28T01:05:00.000Z", @"expiresAt" : @"2026-08-28T13:05:00.000Z", @"lastActivityAt" : @"2026-08-28T13:05:00.000Z" },
      @{ @"clientId" : @"22222222-2222-4222-8222-222222222222", @"status" : @"disconnected", @"startedAt" : @"2026-08-27T12:35:00.000Z", @"expiresAt" : @"2026-08-28T00:35:00.000Z", @"lastActivityAt" : @"2026-08-27T18:00:00.000Z" },
      @{ @"clientId" : @"33333333-3333-4333-8333-333333333333", @"status" : @"revoked", @"startedAt" : @"2026-08-26T10:05:00.000Z", @"expiresAt" : @"2026-08-26T14:05:00.000Z", @"lastActivityAt" : @"2026-08-27T11:15:00.000Z" },
    ],
  };
  [self.auditEvents addObjectsFromArray:@[
    @{ @"clientKind" : @"codex", @"clientDisplayLabel" : @"Codex", @"operation" : @"memory.recall", @"occurredAt" : @"2026-08-28T16:42:00.000Z", @"outcome" : @"success", @"errorCode" : NSNull.null, @"noteRefs" : @[ @{} ] },
    @{ @"clientKind" : @"claude", @"clientDisplayLabel" : @"Claude Code", @"operation" : @"client.revoke", @"occurredAt" : @"2026-08-27T11:15:00.000Z", @"outcome" : @"success", @"errorCode" : NSNull.null, @"noteRefs" : @[] },
  ]];
  self.auditCursor = @"preview-next-page";
  self.ownerExpiresAt = @"2026-08-28T17:00:00.000Z";
  [self setBusy:NO status:@"Preview: authenticated until Aug 28, 5:00 PM"];
  [self render];
  [self renderLibraryViews:@[
    @{ @"id" : @"decisions", @"label" : @"Decisions", @"noteCount" : @12 },
    @{ @"id" : @"commitments", @"label" : @"Commitments", @"noteCount" : @7 },
    @{ @"id" : @"meetings", @"label" : @"Meetings", @"noteCount" : @4 },
  ]];

  self.activeNote = @{
    @"id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", @"revision" : @3,
    @"content" : @"The spare bicycle key is taped beneath the back edge of the green planter on the balcony.\n\nI put it there after the Saturday ride so it would stay dry but remain easy to reach.",
    @"source" : @{ @"label" : @"Weekend errands", @"application" : @"Afternote" },
    @"createdAt" : @"2026-08-28T14:00:00.000Z", @"updatedAt" : @"2026-08-28T16:30:00.000Z"
  };
  self.activeDeleteTarget = @"Weekend errands: The spare bicycle key is taped beneath the planter.";
  self.revisionSummaries = @[
    @{ @"noteId" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", @"revision" : @3, @"excerpt" : @"The spare bicycle key is taped beneath…", @"createdAt" : @"2026-08-28T16:30:00.000Z" },
    @{ @"noteId" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", @"revision" : @2, @"excerpt" : @"The spare key is behind the planter…", @"createdAt" : @"2026-08-28T15:10:00.000Z" },
  ];
  self.libraryExpiresAt = @"2026-08-28T17:00:00.000Z";
  self.libraryStatusLabel.stringValue = @"Notes open until 5:00 PM";
  self.libraryProgress.hidden = YES;
  [self.libraryProgress stopAnimation:nil];
  [self.notesRetrieval selectQuery:@"Where did I put the spare key for my bike?" view:nil];
  self.librarySearch.stringValue = self.notesRetrieval.query;
  [self updateSearchComposerHeight];
  self.clearSearchButton.hidden = NO;
  [self applySearchMode:@"hybrid"];
  SeedNotesFixture(self.notesRetrieval, @[
    @{ @"id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", @"revision" : @3,
       @"excerpt" : @"The spare bicycle key is taped beneath the back edge of the green planter on the balcony.",
       kLibraryResultKindKey : kLibrarySearchResultKind, @"rank" : @1,
       @"source" : @{ @"label" : @"Weekend errands", @"application" : @"Afternote" },
       @"createdAt" : @"2026-08-28T14:00:00.000Z", @"updatedAt" : @"2026-08-28T16:30:00.000Z" },
    @{ @"id" : @"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", @"revision" : @1,
       @"excerpt" : @"A backup bicycle key is in the blue tool roll on the garage shelf.",
       kLibraryResultKindKey : kLibrarySearchResultKind, @"rank" : @2,
       @"source" : @{ @"label" : @"Home reminders" },
       @"createdAt" : @"2026-08-28T13:00:00.000Z", @"updatedAt" : @"2026-08-28T13:00:00.000Z" },
  ]);
  [self showLibraryMode:AfternoteLibraryModeAsk loadBrowse:NO];
  self.resultsHeadingLabel.stringValue = @"Results · 2";
  [self.noteTable reloadData];
  [self renderActiveNote];
  [self renderRevisionMenu];
  [self setLibraryBusy:NO status:@"Notes open until 5:00 PM"];
  NSArray *previewNotes = self.notesRetrieval.notes;
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  if ([arguments containsObject:@"--preview-connector-setup"]) {
    self.connections = @{ @"clients" : @[], @"grants" : @[], @"sessions" : @[] };
    [self.auditEvents removeAllObjects];
    [self render];
    [self displaySurface:AfternoteProductSurfaceConnections recoveryReady:YES];
  } else if ([arguments containsObject:@"--preview-reconnect"]) {
    self.integrationStatuses[@"claude-code"] = @{
      @"toolAvailable" : @YES,
      @"installed" : @YES, @"healthy" : @YES, @"configHealthy" : @YES,
      @"runtimeHealthy" : @YES, @"repairable" : @NO,
      @"problemCode" : NSNull.null,
    };
    self.connections = @{
      @"clients" : @[ self.connections[@"clients"][2] ],
      @"grants" : @[ self.connections[@"grants"][3] ],
      @"sessions" : @[ self.connections[@"sessions"][3] ],
    };
    self.setupGuideDismissed = NO;
    [self renderSetupGuide];
    [self displaySurface:AfternoteProductSurfaceSetup recoveryReady:YES];
  } else if ([arguments containsObject:@"--preview-onboarding"]) {
    self.connections = @{ @"clients" : @[], @"grants" : @[], @"sessions" : @[] };
    [self.auditEvents removeAllObjects];
    self.setupGuideDismissed = NO;
    [self renderSetupGuide];
    [self displaySurface:AfternoteProductSurfaceSetup recoveryReady:YES];
  } else if ([arguments containsObject:@"--preview-onboarding-banner"]) {
    self.setupGuideDismissed = NO;
    [self.notesRetrieval selectQuery:@"" view:self.notesRetrieval.view];
    SeedNotesFixture(self.notesRetrieval, previewNotes);
    self.librarySearch.stringValue = @"";
    [self showLibraryMode:AfternoteLibraryModeBrowse loadBrowse:NO];
    [self updateSetupBannerVisibility];
    [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
  } else if ([arguments containsObject:@"--preview-settings"]) {
    [self.semanticSettings refresh];
    [self displaySurface:AfternoteProductSurfaceSettings recoveryReady:YES];
  } else if ([arguments containsObject:@"--preview-new-note"]) {
    [self beginNewNote:nil];
    [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
  } else if ([arguments containsObject:@"--preview-write"]) {
    [self showLibraryMode:AfternoteLibraryModeWrite loadBrowse:NO];
    [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
  } else if ([arguments containsObject:@"--preview-browse"]) {
    [self.notesRetrieval selectQuery:@"" view:self.notesRetrieval.view];
    SeedNotesFixture(self.notesRetrieval, previewNotes);
    self.librarySearch.stringValue = @"";
    [self showLibraryMode:AfternoteLibraryModeBrowse loadBrowse:NO];
    [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
  } else if ([arguments containsObject:@"--connections"]) {
    [self displaySurface:AfternoteProductSurfaceConnections recoveryReady:YES];
  } else if ([arguments containsObject:@"--library"]) {
    [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
  } else if ([arguments containsObject:@"--recovery"]) {
    [self displaySurface:AfternoteProductSurfaceRecovery recoveryReady:YES];
    self.recoveryState = @"ready";
    self.recoveryStatusLabel.stringValue = @"Vault ready";
    self.recoveryProgress.hidden = YES;
    [self.recoveryProgress stopAnimation:nil];
    [self renderRecoveryState];
  }
  if ([arguments containsObject:@"--preview-saved"]) {
    [self.noteEditorView setSaveState:AfternoteEditorSaveStateSaved animated:NO];
  }
  if ([arguments containsObject:@"--preview-focus-ask"]) {
    [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
    [self showLibraryMode:AfternoteLibraryModeAsk loadBrowse:NO];
    [self.window makeFirstResponder:self.librarySearch];
    self.askComposer.afternoteFocused = YES;
  }
  if ([arguments containsObject:@"--preview-indexing"] || [arguments containsObject:@"--preview-indexing-stalled"]) {
    self.semanticIndexedNotes = 7;
    self.semanticTotalNotes = 15;
    [self applySearchMode:@"indexing"];
    if ([arguments containsObject:@"--preview-indexing-stalled"])
      self.semanticLastProgressAt = NSProcessInfo.processInfo.systemUptime - 61;
    [self renderSemanticProgress];
  }
  [self updateProductNavigationState];
  NSUInteger renderIndex = [arguments indexOfObject:@"--render-preview"];
  if (renderIndex != NSNotFound && renderIndex + 1 < arguments.count) {
    NSString *path = arguments[renderIndex + 1];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 800 * NSEC_PER_MSEC),
                   dispatch_get_main_queue(), ^{
      NSView *view = self.window.contentView;
      [view setBoundsOrigin:NSZeroPoint];
      [view displayIfNeeded];
      NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
      [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
      NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      if (![png writeToFile:path atomically:YES]) {
        fputs("could not render owner-control preview\n", stderr);
      }
      [NSApp terminate:nil];
    });
  }
#else
  [self refreshConnections:nil];
  [self refreshRecoveryStatusAndContinue:YES];
#endif
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  (void)notification;
  if (self.window == nil || self.broker == nil ||
      self.surfaceTabs.selectedTabViewItem == nil) return;
  NSString *surface = self.surfaceTabs.selectedTabViewItem.identifier;
  if ([surface isEqual:@"connections"]) {
    [self refreshConnections:nil];
    return;
  }
  if (self.libraryExpiresAt.length == 0 ||
      self.libraryMutationInFlight || self.notesRetrieval.inFlight ||
      ![surface isEqual:@"library"]) return;
  if (self.libraryModeSelector.selectedSegment == AfternoteLibraryModeWrite) {
    self.libraryRefreshPending = YES;
    return;
  }
  [self refreshVisibleLibraryNotes:nil];
}

- (void)vaultDidLock:(NSNotification *)notification {
  (void)notification;
  self.lifecycleStatusRequestSequence += 1;
  self.connectorOverviewGeneration += 1;
  self.connectorOverviewByKind = @{};
  self.vaultLocked = YES;
  self.vaultStatusCheckInFlight = NO;
  self.libraryAuthenticateButton.title = @"Unlock vault";
  [self updateVaultAccessButton];
  [self clearLibraryPlaintext:LockedLibraryMessage()];
}

- (void)vaultDidUnlock:(NSNotification *)notification {
  (void)notification;
  NSUInteger requestSequence = ++self.lifecycleStatusRequestSequence;
  self.vaultLocked = YES;
  self.vaultStatusCheckInFlight = YES;
  self.libraryAuthenticateButton.title = @"Checking vault state…";
  [self updateVaultAccessButton];
  [self setLibraryBusy:YES status:@"Confirming the unlock with the Afternote broker…"];
  [self.broker requestMethod:@"lifecycle.status" params:@{}
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self applyVaultLifecycleStatus:result error:error requestSequence:requestSequence];
    });
  }];
}

- (void)applyVaultLifecycleStatus:(NSDictionary *)result
                            error:(NSDictionary *)error
                  requestSequence:(NSUInteger)requestSequence {
  if (requestSequence != self.lifecycleStatusRequestSequence) return;
  self.vaultStatusCheckInFlight = NO;
  if (error != nil || !AfternoteBrokerResultIsValid(@"lifecycle.status", result, @{}) ||
      ![result[@"state"] isEqualToString:@"unlocked"]) {
    self.vaultLocked = YES;
    self.libraryAuthenticateButton.title = @"Unlock vault";
    [self updateVaultAccessButton];
    [self setLibraryBusy:NO status:LockedLibraryMessage()];
    return;
  }
  self.vaultLocked = NO;
  self.libraryAuthenticateButton.title = @"Authenticate & Open";
  [self updateVaultAccessButton];
  [self setLibraryBusy:NO status:@"The vault is unlocked. Authenticate to reopen Notes."];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  (void)sender;
  [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
  [self clearLibraryPlaintext:@"Notes closed. Authenticate again to reopen them."];
  return YES;
}

- (NSTextField *)label:(NSString *)text size:(CGFloat)size weight:(NSFontWeight)weight {
  return AfternoteLabel(text, size, weight);
}

- (void)stylePrimaryButton:(NSButton *)button {
  AfternoteStylePrimaryButton(button);
}

- (void)styleSecondaryButton:(NSButton *)button {
  AfternoteStyleSecondaryButton(button);
}

- (void)styleDestructiveButton:(NSButton *)button {
  AfternoteStyleDestructiveButton(button);
}

- (void)styleNavigationButton:(NSButton *)button selected:(BOOL)selected {
  button.bordered = NO;
  button.alignment = NSTextAlignmentLeft;
  button.font = [NSFont systemFontOfSize:14 weight:selected ? NSFontWeightSemibold : NSFontWeightMedium];
  button.contentTintColor = selected ? AfternoteBrandCaptureColor() : AfternoteTextColor();
  StyleSurface(button, NSColor.clearColor, 0);
}

- (void)styleProductNavigationButton:(NSButton *)button selected:(BOOL)selected {
  button.bordered = NO;
  button.font = [NSFont systemFontOfSize:13
                                 weight:selected ? NSFontWeightSemibold : NSFontWeightMedium];
  button.contentTintColor = selected ? AfternoteBrandCaptureColor() : AfternoteMutedTextColor();
  button.accessibilityValue = selected ? @"Selected" : @"Not selected";
}

- (void)updateProductNavigationState {
  NSInteger selected = self.surfaceSelector.selectedSegment;
  [self styleProductNavigationButton:self.memoryNavigationButton
                            selected:selected == AfternoteNavigationSegmentForSurface(
                                AfternoteProductSurfaceMemory)];
  [self styleProductNavigationButton:self.connectionsNavigationButton
                            selected:selected == AfternoteNavigationSegmentForSurface(
                                AfternoteProductSurfaceConnections)];
}

- (AfternoteProductSurface)displaySurface:(AfternoteProductSurface)surface
                             recoveryReady:(BOOL)recoveryReady {
  AfternoteProductSurface resolved =
      [self.surfaceRouter selectRequestedSurface:surface
                                   recoveryReady:recoveryReady];
  self.surfaceSelector.selectedSegment =
      AfternoteNavigationSegmentForSurface(resolved);
  [self updateProductNavigationState];
  [self.surfaceTabs selectTabViewItemAtIndex:AfternoteTabIndexForSurface(resolved)];
  return resolved;
}

- (void)selectProductSurface:(NSButton *)sender {
  self.surfaceSelector.selectedSegment = sender.tag;
  [self switchSurface:self.surfaceSelector];
}

- (void)styleSearchField:(NSTextField *)searchField {
  searchField.font = [NSFont systemFontOfSize:16 weight:NSFontWeightRegular];
  searchField.textColor = AfternoteTextColor();
  searchField.bordered = NO;
  searchField.bezeled = NO;
  searchField.drawsBackground = NO;
  searchField.focusRingType = NSFocusRingTypeNone;
  searchField.lineBreakMode = NSLineBreakByWordWrapping;
  searchField.usesSingleLineMode = NO;
  searchField.cell.wraps = YES;
  searchField.cell.scrollable = NO;
  searchField.placeholderAttributedString = [[NSAttributedString alloc]
      initWithString:@"Search anything you've written down"
          attributes:@{
            NSForegroundColorAttributeName : AfternoteMutedTextColor(),
            NSFontAttributeName : [NSFont systemFontOfSize:16],
          }];
}

- (void)renderSemanticProgress {
  BOOL stalled = [self.currentSearchMode isEqual:@"indexing"] && self.semanticLastProgressAt > 0 &&
      NSProcessInfo.processInfo.systemUptime - self.semanticLastProgressAt >= 60;
  [self.searchProgress updateMode:self.currentSearchMode indexed:self.semanticIndexedNotes
                           total:self.semanticTotalNotes stalled:stalled unavailable:self.semanticStatusFailures > 0];
  [self.semanticSettings setProgressStalled:stalled unavailable:self.semanticStatusFailures > 0];
}

- (void)applySearchMode:(NSString *)mode {
  NSString *previous = self.currentSearchMode;
  self.currentSearchMode = mode.length > 0 ? mode : @"checking";
  if ([self.currentSearchMode isEqual:@"indexing"]) {
    if (![previous isEqual:@"indexing"] || self.semanticLastProgressAt == 0)
      self.semanticLastProgressAt = NSProcessInfo.processInfo.systemUptime;
  } else {
    self.semanticLastProgressAt = 0;
    self.semanticPollSequence += 1;
    self.semanticPollPending = NO;
  }
  if ([self.currentSearchMode isEqual:@"checking"]) {
    self.semanticIndexedNotes = -1;
    self.semanticTotalNotes = -1;
    self.semanticStatusFailures = 0;
    [self.semanticSettings setIndexedNotes:0 total:0];
  }
  [self.semanticSettings setSearchMode:self.currentSearchMode];
  [self renderSemanticProgress];
  [self renderSetupGuide];
  [self scheduleSemanticStatusPoll];
}

- (void)retrySemanticProgress:(id)sender {
  if ([self.currentSearchMode isEqual:@"degraded"]) { [self openSettings:sender]; return; }
  self.semanticStatusFailures = 0;
  [self refreshSemanticSearch:NO userInitiated:NO];
}

- (NSView *)buildSetupView {
  NSView *root = [[NSView alloc] init];
  StyleSurface(root, AfternoteCanvasColor());

  NSImage *backImage = [NSImage imageWithSystemSymbolName:@"chevron.left"
                                  accessibilityDescription:@"Back to Notes"];
  NSButton *back = [AfternoteButton buttonWithTitle:@"Notes"
                                             target:self
                                             action:@selector(returnFromSetupGuide:)];
  back.image = backImage;
  back.imagePosition = NSImageLeft;
  back.imageHugsTitle = YES;
  back.bordered = NO;
  back.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  back.contentTintColor = AfternoteBrandCaptureColor();
  back.accessibilityLabel = @"Back to Notes";
  NSTextField *title = [self label:@"Set up Afternote where you work"
                                  size:30 weight:NSFontWeightSemibold];
  title.maximumNumberOfLines = 2;
  NSTextField *subtitle = [self label:@"Connect a tool once, then save and recall notes without leaving it."
                                     size:15 weight:NSFontWeightRegular];
  subtitle.textColor = AfternoteMutedTextColor();
  self.setupContent = [NSStackView stackViewWithViews:@[]];
  self.setupContent.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.setupContent.alignment = NSLayoutAttributeLeading;
  self.setupContent.spacing = 0;
  NSButton *dismiss = [AfternoteButton buttonWithTitle:@"Hide this guide"
                                                 target:self
                                                 action:@selector(dismissSetupGuide:)];
  dismiss.bordered = NO;
  dismiss.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
  dismiss.contentTintColor = AfternoteMutedTextColor();
  dismiss.accessibilityLabel = @"Hide the Afternote setup guide";

  NSStackView *column = [NSStackView stackViewWithViews:@[
    back, title, subtitle, self.setupContent, dismiss
  ]];
  column.orientation = NSUserInterfaceLayoutOrientationVertical;
  column.alignment = NSLayoutAttributeLeading;
  column.spacing = 12;
  column.edgeInsets = NSEdgeInsetsMake(34, 0, 40, 0);

  column.translatesAutoresizingMaskIntoConstraints = NO;
  [root addSubview:column];
  [NSLayoutConstraint activateConstraints:@[
    [column.centerXAnchor constraintEqualToAnchor:root.centerXAnchor],
    [column.topAnchor constraintEqualToAnchor:root.topAnchor],
    [column.bottomAnchor constraintLessThanOrEqualToAnchor:root.bottomAnchor constant:-24],
    [column.widthAnchor constraintEqualToConstant:780],
    [self.setupContent.widthAnchor constraintEqualToConstant:780],
  ]];
  [self renderSetupGuide];
  return root;
}

- (NSView *)settingsRowWithTitle:(NSString *)title
                          detail:(NSString *)detail
                         control:(NSView *)control {
  NSTextField *titleLabel = [self label:title size:14 weight:NSFontWeightMedium];
  NSTextField *detailLabel = [self label:detail size:12 weight:NSFontWeightRegular];
  detailLabel.textColor = AfternoteMutedTextColor();
  detailLabel.maximumNumberOfLines = 2;
  NSStackView *copy = [NSStackView stackViewWithViews:@[ titleLabel, detailLabel ]];
  copy.orientation = NSUserInterfaceLayoutOrientationVertical;
  copy.alignment = NSLayoutAttributeLeading;
  copy.spacing = 3;
  NSStackView *row = [NSStackView stackViewWithViews:@[ copy, [NSView new], control ]];
  row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  row.alignment = NSLayoutAttributeCenterY;
  row.spacing = 16;
  row.edgeInsets = NSEdgeInsetsMake(10, 0, 10, 0);
  [row.widthAnchor constraintGreaterThanOrEqualToConstant:640].active = YES;
  return row;
}

- (NSView *)buildSettingsView {
  NSView *root = [[NSView alloc] init];
  StyleSurface(root, AfternoteCanvasColor());
  NSScrollView *scroll = [[NSScrollView alloc] init];
  scroll.drawsBackground = NO;
  scroll.hasVerticalScroller = YES;
  scroll.autohidesScrollers = YES;
  scroll.translatesAutoresizingMaskIntoConstraints = NO;
  FlippedStackView *document = [[FlippedStackView alloc] init];
  StyleSurface(document, AfternoteCanvasColor());
  document.translatesAutoresizingMaskIntoConstraints = NO;
  scroll.documentView = document;
  [root addSubview:scroll];
  NSTextField *title = [self label:@"Settings" size:30 weight:NSFontWeightSemibold];
  NSTextField *subtitle = [self label:@"Local memory, security, and product details."
                                     size:15 weight:NSFontWeightRegular];
  subtitle.textColor = AfternoteMutedTextColor();

  NSTextField *memoryHeading = [self label:@"Local memory" size:18 weight:NSFontWeightSemibold];
  NSTextField *vaultState = [self label:@"Encrypted on this Mac" size:12 weight:NSFontWeightMedium];
  vaultState.textColor = StatusColor(@"success");
  __weak OwnerControlDelegate *weakSelf = self;
  self.semanticSettings = [[AfternoteSemanticSettings alloc] initWithRunner:
      ^(NSArray<NSString *> *arguments, AfternoteSemanticCompletion completion) {
#if defined(AFTERNOTE_OWNER_CONTROL_UI_PREVIEW)
    completion(@{ @"enabled":@YES, @"models":@[@{@"key":@"balanced", @"modelId":@"preview:q4", @"state":@"ready"}] }, nil);
#else
    [weakSelf runPackagedCommand:arguments completion:completion];
#endif
  }];
  self.semanticSettings.checkProgress = ^{
    [weakSelf retrySemanticProgress:nil];
  };
  self.semanticSettings.activate = ^(BOOL userInitiated) {
#if defined(AFTERNOTE_OWNER_CONTROL_UI_PREVIEW)
    [weakSelf.semanticSettings activationCompleted:@"hybrid" modelId:@"preview:q4"];
#else
    [weakSelf activateSemanticSearch:userInitiated];
#endif
  };
  NSTextField *vaultLocationState = [self label:@"Afternote-managed" size:12 weight:NSFontWeightMedium];
  vaultLocationState.textColor = AfternoteMutedTextColor();
  NSButton *exportNotes = [AfternoteButton buttonWithTitle:@"Export notes"
                                                    target:self
                                                    action:@selector(exportNotes:)];
  [self styleSecondaryButton:exportNotes];
  exportNotes.accessibilityLabel = @"Export a lossless copy of Afternote notes";
  NSButton *saveDiagnostics = [AfternoteButton buttonWithTitle:@"Save diagnostics"
                                                       target:self
                                                       action:@selector(saveDiagnostics:)];
  [self styleSecondaryButton:saveDiagnostics];
  saveDiagnostics.accessibilityLabel = @"Save share-safe Afternote diagnostics";
  NSStackView *exportControls = [NSStackView stackViewWithViews:@[
    exportNotes, saveDiagnostics
  ]];
  exportControls.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  exportControls.alignment = NSLayoutAttributeCenterY;
  exportControls.spacing = 8;

  NSTextField *securityHeading = [self label:@"Security" size:18 weight:NSFontWeightSemibold];
  self.vaultAccessButton = [AfternoteButton buttonWithTitle:@"Lock vault"
                                                     target:self
                                                     action:@selector(toggleVaultLock:)];
  [self styleSecondaryButton:self.vaultAccessButton];
  [self updateVaultAccessButton];
  self.routineAuthenticationMenu = [[NSPopUpButton alloc] init];
  for (NSDictionary *option in @[
         @{ @"title" : @"15 minutes", @"ttl" : @(kRoutineAuthenticationFifteenMinutesMilliseconds) },
         @{ @"title" : @"4 hours", @"ttl" : @(kRoutineAuthenticationFourHoursMilliseconds) },
         @{ @"title" : @"Once a day", @"ttl" : @(kRoutineAuthenticationDailyMilliseconds) },
       ]) {
    [self.routineAuthenticationMenu addItemWithTitle:option[@"title"]];
    self.routineAuthenticationMenu.lastItem.representedObject = option[@"ttl"];
  }
  self.routineAuthenticationMenu.target = self;
  self.routineAuthenticationMenu.action = @selector(routineAuthenticationChanged:);
  self.routineAuthenticationMenu.accessibilityLabel = @"Routine authentication frequency";
  [self styleSecondaryButton:self.routineAuthenticationMenu];
  int64_t routineTtl = RoutineAuthenticationTtlMilliseconds();
  for (NSMenuItem *item in self.routineAuthenticationMenu.itemArray) {
    if ([item.representedObject longLongValue] == routineTtl) {
      [self.routineAuthenticationMenu selectItem:item];
      break;
    }
  }
  NSTextField *productHeading = [self label:@"Product" size:18 weight:NSFontWeightSemibold];
  NSString *packageVersion = [NSBundle.mainBundle
      objectForInfoDictionaryKey:@"AfternotePackageVersion"];
  if (![packageVersion isKindOfClass:[NSString class]] || packageVersion.length == 0) {
    packageVersion = @"Development";
  }
  NSTextField *version = [self label:packageVersion size:12 weight:NSFontWeightMedium];
  version.textColor = AfternoteMutedTextColor();
  self.automaticUpdateChecksButton = [NSButton checkboxWithTitle:@"Check automatically"
                                                            target:self
                                                            action:@selector(automaticUpdateChecksChanged:)];
  self.automaticUpdateChecksButton.state =
      self.softwareUpdateController.automaticallyChecksForUpdates
          ? NSControlStateValueOn
          : NSControlStateValueOff;
  self.automaticUpdateChecksButton.enabled = self.softwareUpdateController.available;
  self.automaticUpdateChecksButton.accessibilityLabel = @"Automatically check for Afternote updates";
  self.checkForUpdatesButton = [AfternoteButton buttonWithTitle:@"Check now"
                                                         target:self
                                                         action:@selector(checkForUpdates:)];
  [self styleSecondaryButton:self.checkForUpdatesButton];
  self.checkForUpdatesButton.enabled = self.softwareUpdateController.available;
  self.checkForUpdatesButton.accessibilityLabel = @"Check for Afternote updates";
  NSStackView *updateControls = [NSStackView stackViewWithViews:@[
    self.automaticUpdateChecksButton, self.checkForUpdatesButton
  ]];
  updateControls.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  updateControls.alignment = NSLayoutAttributeCenterY;
  updateControls.spacing = 10;
  NSButton *showSetup = [AfternoteButton buttonWithTitle:@"Show setup guide"
                                                   target:self
                                                   action:@selector(openSetupGuide:)];
  [self styleSecondaryButton:showSetup];
  showSetup.accessibilityLabel = @"Show the Afternote setup guide";
  NSButton *sendFeedback = [AfternoteButton buttonWithTitle:@"Send feedback"
                                                      target:self
                                                      action:@selector(sendFeedback:)];
  [self styleSecondaryButton:sendFeedback];
  sendFeedback.accessibilityLabel = @"Send Afternote feedback on GitHub";
  NSButton *uninstall = [AfternoteButton buttonWithTitle:@"Uninstall Afternote…"
                                                  target:self
                                                  action:@selector(uninstallAfternote:)];
  [self styleSecondaryButton:uninstall];
  uninstall.accessibilityLabel = @"Remove the Afternote runtime while preserving its encrypted vault and connector authorization";
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
  NSTextField *developmentState = [self label:@"Owner presence bypass active"
                                           size:12 weight:NSFontWeightSemibold];
  developmentState.textColor = StatusColor(@"warning");
#endif

  NSStackView *column = [NSStackView stackViewWithViews:@[
    title, subtitle,
    memoryHeading,
    [self settingsRowWithTitle:@"Vault" detail:@"Canonical notes and derived recall data stay encrypted locally." control:vaultState],
    [self settingsRowWithTitle:@"Vault location" detail:@"The broker owns the encrypted database path; connectors never receive it." control:vaultLocationState],
    self.semanticSettings,
    [self settingsRowWithTitle:@"Export & diagnostics" detail:@"Lossless export and share-safe diagnostics run through owner-approved native broker actions." control:exportControls],
    securityHeading,
    [self settingsRowWithTitle:@"Vault access" detail:@"Locking clears native plaintext and disconnects connector sessions." control:self.vaultAccessButton],
    [self settingsRowWithTitle:@"Routine authentication" detail:@"Used for Notes and for Codex, Claude Code, and Claude Desktop connections. Changing this setting applies to every connector. Export, deletion, recovery, lock, and unlock still require fresh approval." control:self.routineAuthenticationMenu],
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
    [self settingsRowWithTitle:@"Build policy" detail:@"Development convenience is isolated from release builds." control:developmentState],
#endif
    productHeading,
    [self settingsRowWithTitle:@"Version" detail:@"Afternote V2 local memory." control:version],
    [self settingsRowWithTitle:@"Updates" detail:self.softwareUpdateController.available
        ? @"Daily checks are private and signed. Download and installation always require approval."
        : @"Update checks are available only in signed release builds."
        control:updateControls],
    [self settingsRowWithTitle:@"Setup guide" detail:@"Reconnect a tool or repeat the save-and-recall walkthrough." control:showSetup],
    [self settingsRowWithTitle:@"Feedback" detail:@"Report a bug or suggestion. Diagnostics are attached only if you review and add them." control:sendFeedback],
    [self settingsRowWithTitle:@"Uninstall" detail:@"Remove connector configuration and background components. Your encrypted vault and reconnect authorization are preserved." control:uninstall],
  ]];
  column.orientation = NSUserInterfaceLayoutOrientationVertical;
  column.alignment = NSLayoutAttributeLeading;
  column.spacing = 4;
  [column setCustomSpacing:20 afterView:self.semanticSettings];
  [self.semanticSettings.widthAnchor constraintEqualToAnchor:column.widthAnchor].active = YES;
  column.edgeInsets = NSEdgeInsetsMake(30, 0, 30, 0);
  column.translatesAutoresizingMaskIntoConstraints = NO;
  [document addSubview:column];
  [NSLayoutConstraint activateConstraints:@[
    [scroll.leadingAnchor constraintEqualToAnchor:root.leadingAnchor],
    [scroll.trailingAnchor constraintEqualToAnchor:root.trailingAnchor],
    [scroll.topAnchor constraintEqualToAnchor:root.topAnchor],
    [scroll.bottomAnchor constraintEqualToAnchor:root.bottomAnchor],
    [document.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor],
    [document.heightAnchor constraintGreaterThanOrEqualToAnchor:scroll.contentView.heightAnchor],
    [column.leadingAnchor constraintGreaterThanOrEqualToAnchor:document.leadingAnchor constant:32],
    [column.trailingAnchor constraintLessThanOrEqualToAnchor:document.trailingAnchor constant:-32],
    [column.centerXAnchor constraintEqualToAnchor:document.centerXAnchor],
    [column.topAnchor constraintEqualToAnchor:document.topAnchor],
    [column.bottomAnchor constraintEqualToAnchor:document.bottomAnchor],
    [column.widthAnchor constraintLessThanOrEqualToConstant:820],
    [column.widthAnchor constraintGreaterThanOrEqualToConstant:640],
  ]];
  return root;
}

- (void)automaticUpdateChecksChanged:(NSButton *)sender {
  self.softwareUpdateController.automaticallyChecksForUpdates =
      sender.state == NSControlStateValueOn;
}

- (void)checkForUpdates:(id)sender {
  [self.softwareUpdateController checkForUpdates:sender];
}

- (void)uninstallAfternote:(id)sender {
  (void)sender;
  NSAlert *confirmation = [[NSAlert alloc] init];
  confirmation.messageText = @"Uninstall Afternote?";
  confirmation.informativeText = @"Afternote will remove its Codex and Claude Code configuration and background runtime. If the Claude Desktop extension is still installed, Afternote will stop and ask you to remove it in Claude first. Your encrypted vault and connector authorization in ~/.afternote and Keychain are preserved for reinstall.";
  [confirmation addButtonWithTitle:@"Uninstall"];
  [confirmation addButtonWithTitle:@"Cancel"];
  [confirmation beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    if (response != NSAlertFirstButtonReturn) return;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      NSString *errorMessage = nil;
      BOOL removed = AfternoteUninstallRuntime(&errorMessage);
      dispatch_async(dispatch_get_main_queue(), ^{
        if (!removed) {
          [self showSettingsResultWithTitle:@"Uninstall could not finish"
                                    message:errorMessage ?: @"Afternote did not remove any files."];
          return;
        }
        void (^finishUninstall)(void) = ^{
          NSURL *application = NSBundle.mainBundle.bundleURL;
          [NSWorkspace.sharedWorkspace recycleURLs:@[ application ]
                                 completionHandler:^(NSDictionary<NSURL *, NSURL *> *mappings,
                                                     NSError *error) {
            (void)mappings;
            dispatch_async(dispatch_get_main_queue(), ^{
              if (error != nil) {
                NSAlert *manual = [[NSAlert alloc] init];
                manual.messageText = @"Background components removed";
                manual.informativeText = @"Move Afternote from Applications to the Trash to finish uninstalling.";
                [manual addButtonWithTitle:@"Quit"];
                [manual runModal];
              }
              [NSApp terminate:nil];
            });
          }];
        };
        if (errorMessage.length > 0) {
          NSAlert *warning = [[NSAlert alloc] init];
          warning.messageText = @"Background components removed with a warning";
          warning.informativeText = errorMessage;
          [warning addButtonWithTitle:@"Continue"];
          [warning beginSheetModalForWindow:self.window
                          completionHandler:^(__unused NSModalResponse response) {
            finishUninstall();
          }];
          return;
        }
        finishUninstall();
      });
    });
  }];
}

- (void)showSettingsResultWithTitle:(NSString *)title
                            message:(NSString *)message {
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = title;
  alert.informativeText = message;
  [alert addButtonWithTitle:@"Done"];
  [alert beginSheetModalForWindow:self.window completionHandler:nil];
}

- (BOOL)panel:(id)sender validateURL:(NSURL *)url error:(NSError **)outError {
  (void)sender;
  if (![NSFileManager.defaultManager fileExistsAtPath:url.path]) return YES;
  if (outError != nil) {
    *outError = [NSError errorWithDomain:@"dev.afternote.owner-control"
                                    code:1
                                userInfo:@{
      NSLocalizedDescriptionKey : @"Choose a new filename. Afternote never overwrites an existing export."
    }];
  }
  return NO;
}

- (void)exportNotes:(id)sender {
  (void)sender;
  NSSavePanel *panel = [NSSavePanel savePanel];
  panel.title = @"Export Afternote notes";
  panel.nameFieldStringValue = @"Afternote Export.json";
  panel.allowedContentTypes = @[ UTTypeJSON ];
  panel.canCreateDirectories = YES;
  panel.delegate = self;
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    if (response != NSModalResponseOK || panel.URL.path.length == 0) return;
    NSString *destination = panel.URL.path.stringByStandardizingPath;
    [self.broker requestMethod:@"admin.export"
                        params:@{ @"format" : @"json", @"destination" : destination }
                         reply:^(NSDictionary *result, NSDictionary *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (error != nil) {
          [self showSettingsResultWithTitle:@"Export failed"
                                    message:StringValue(error[@"message"], @"Afternote could not export your notes.")];
          return;
        }
        [self showSettingsResultWithTitle:@"Notes exported"
                                  message:[NSString stringWithFormat:@"Saved to %@.",
                                           StringValue(result[@"destination"], destination)]];
      });
    }];
  }];
}

- (void)saveDiagnostics:(id)sender {
  (void)sender;
  NSSavePanel *panel = [NSSavePanel savePanel];
  panel.title = @"Save Afternote diagnostics";
  panel.nameFieldStringValue = @"Afternote Diagnostics.json";
  panel.allowedContentTypes = @[ UTTypeJSON ];
  panel.canCreateDirectories = YES;
  panel.delegate = self;
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    if (response != NSModalResponseOK || panel.URL.path.length == 0) return;
    NSString *destination = panel.URL.path.stringByStandardizingPath;
    [self.broker requestMethod:@"admin.diagnostics" params:@{}
                         reply:^(NSDictionary *result, NSDictionary *error) {
      if (error != nil) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [self showSettingsResultWithTitle:@"Diagnostics failed"
                                    message:StringValue(error[@"message"], @"Afternote could not create diagnostics.")];
        });
        return;
      }
      NSData *data = [NSJSONSerialization dataWithJSONObject:result
                                                     options:(NSJSONWritingPrettyPrinted |
                                                              NSJSONWritingSortedKeys)
                                                       error:nil];
      BOOL written = WriteExclusivePrivateData(destination, data);
      dispatch_async(dispatch_get_main_queue(), ^{
        [self showSettingsResultWithTitle:written ? @"Diagnostics saved" : @"Diagnostics failed"
                                  message:written
                                      ? [NSString stringWithFormat:@"Saved to %@.", destination]
                                      : @"Afternote could not write the diagnostics file."];
      });
    }];
  }];
}

- (void)sendFeedback:(id)sender {
  (void)sender;
  NSURL *url = [NSURL URLWithString:@"mailto:hello@afternote.dev?subject=Afternote%20feedback"];
  if (url != nil) [NSWorkspace.sharedWorkspace openURL:url];
}

- (void)buildWindow {
  self.window = [[NSWindow alloc]
      initWithContentRect:NSMakeRect(0, 0, 1280, 800)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                          NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                  backing:NSBackingStoreBuffered
                    defer:NO];
  self.window.title = @"Afternote";
  self.window.restorable = NO;
  self.window.minSize = NSMakeSize(900, 640);
  self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
  self.window.backgroundColor = AfternoteCanvasColor();
  self.window.titlebarAppearsTransparent = YES;
  self.window.titleVisibility = NSWindowTitleHidden;
  [self.window center];

  NSView *root = [[NSView alloc] init];
  StyleSurface(root, AfternoteCanvasColor());
  self.window.contentView = root;

  NSTextField *wordmark = [self label:@"afternote" size:18 weight:NSFontWeightSemibold];
  wordmark.textColor = AfternoteTextColor();
  wordmark.accessibilityLabel = @"Afternote";
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
  NSTextField *developmentWarning = [self label:@"DEVELOPMENT BUILD - OWNER PRESENCE BYPASS ACTIVE - DO NOT DISTRIBUTE"
                                            size:10 weight:NSFontWeightSemibold];
  developmentWarning.textColor = StatusColor(@"warning");
  developmentWarning.accessibilityLabel = @"Development build warning. Owner presence bypass is active. Do not distribute.";
#endif
  self.surfaceSelector = [NSSegmentedControl segmentedControlWithLabels:@[ @"Notes", @"Connections" ]
                                                            trackingMode:NSSegmentSwitchTrackingSelectOne
                                                                  target:self
                                                                  action:@selector(switchSurface:)];
  self.surfaceSelector.selectedSegment =
      AfternoteNavigationSegmentForSurface(AfternoteProductSurfaceMemory);
  self.surfaceSelector.accessibilityLabel = @"Afternote section";
  self.surfaceSelector.controlSize = NSControlSizeRegular;
  self.surfaceSelector.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
  self.surfaceSelector.segmentStyle = NSSegmentStyleSeparated;
  self.surfaceSelector.selectedSegmentBezelColor = AfternoteAccentColor();
  self.surfaceSelector.hidden = YES;
  self.memoryNavigationButton = [NSButton buttonWithTitle:@"Notes"
                                                   target:self
                                                   action:@selector(selectProductSurface:)];
  self.memoryNavigationButton.tag =
      AfternoteNavigationSegmentForSurface(AfternoteProductSurfaceMemory);
  self.memoryNavigationButton.accessibilityLabel = @"Open Notes";
  self.connectionsNavigationButton = [NSButton buttonWithTitle:@"Connections"
                                                        target:self
                                                        action:@selector(selectProductSurface:)];
  self.connectionsNavigationButton.tag =
      AfternoteNavigationSegmentForSurface(AfternoteProductSurfaceConnections);
  self.connectionsNavigationButton.accessibilityLabel = @"Open Connections";
  NSStackView *productNavigation = [NSStackView stackViewWithViews:@[
    self.memoryNavigationButton,
    self.connectionsNavigationButton,
  ]];
  productNavigation.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  productNavigation.alignment = NSLayoutAttributeCenterY;
  productNavigation.spacing = 18;
  [self updateProductNavigationState];
  NSImage *settingsImage = [NSImage imageWithSystemSymbolName:@"gearshape"
                                      accessibilityDescription:@"Settings"];
  NSButton *settingsButton = [NSButton buttonWithImage:settingsImage
                                                target:self
                                                action:@selector(openSettings:)];
  settingsButton.bordered = NO;
  settingsButton.contentTintColor = AfternoteMutedTextColor();
  settingsButton.toolTip = @"Settings (Command-,)";
  settingsButton.accessibilityLabel = @"Open Settings";
  settingsButton.keyEquivalent = @",";
  settingsButton.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  NSStackView *navigation = [NSStackView stackViewWithViews:@[
    wordmark,
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
    developmentWarning,
#endif
    [NSView new], settingsButton
  ]];
  navigation.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  navigation.alignment = NSLayoutAttributeCenterY;
  navigation.spacing = 16;
  navigation.edgeInsets = NSEdgeInsetsMake(0, 24, 0, 24);
  StyleSurface(navigation, AfternoteSidebarColor());
  productNavigation.translatesAutoresizingMaskIntoConstraints = NO;
  [navigation addSubview:productNavigation];
  [NSLayoutConstraint activateConstraints:@[
    [productNavigation.centerXAnchor constraintEqualToAnchor:navigation.centerXAnchor],
    [productNavigation.centerYAnchor constraintEqualToAnchor:navigation.centerYAnchor],
  ]];

  self.surfaceTabs = [[NSTabView alloc] init];
  self.surfaceTabs.tabViewType = NSNoTabsNoBorder;
  NSTabViewItem *libraryItem = [[NSTabViewItem alloc] initWithIdentifier:@"library"];
  libraryItem.view = [self buildLibraryView];
  NSTabViewItem *connectionsItem = [[NSTabViewItem alloc] initWithIdentifier:@"connections"];
  connectionsItem.view = [self buildConnectionsView];
  NSTabViewItem *recoveryItem = [[NSTabViewItem alloc] initWithIdentifier:@"recovery"];
  recoveryItem.view = [self buildRecoveryView];
  NSTabViewItem *setupItem = [[NSTabViewItem alloc] initWithIdentifier:@"setup"];
  setupItem.view = [self buildSetupView];
  NSTabViewItem *settingsItem = [[NSTabViewItem alloc] initWithIdentifier:@"settings"];
  settingsItem.view = [self buildSettingsView];
  [self.surfaceTabs addTabViewItem:libraryItem];
  [self.surfaceTabs addTabViewItem:connectionsItem];
  [self.surfaceTabs addTabViewItem:recoveryItem];
  [self.surfaceTabs addTabViewItem:setupItem];
  [self.surfaceTabs addTabViewItem:settingsItem];
  [self.surfaceTabs selectTabViewItemAtIndex:AfternoteTabIndexForSurface(
      AfternoteProductSurfaceMemory)];
  [self.surfaceSelector setEnabled:NO forSegment:0];
  [self.surfaceSelector setEnabled:NO forSegment:1];
  self.libraryAuthenticateButton.enabled = NO;
  [self.connectionsView setRefreshEnabled:NO];

  navigation.translatesAutoresizingMaskIntoConstraints = NO;
  self.surfaceTabs.translatesAutoresizingMaskIntoConstraints = NO;
  [root addSubview:navigation];
  [root addSubview:self.surfaceTabs];
  [NSLayoutConstraint activateConstraints:@[
    [navigation.leadingAnchor constraintEqualToAnchor:root.leadingAnchor],
    [navigation.trailingAnchor constraintEqualToAnchor:root.trailingAnchor],
    [navigation.topAnchor constraintEqualToAnchor:root.topAnchor],
    [navigation.heightAnchor constraintEqualToConstant:58],
    [self.surfaceTabs.leadingAnchor constraintEqualToAnchor:root.leadingAnchor],
    [self.surfaceTabs.trailingAnchor constraintEqualToAnchor:root.trailingAnchor],
    [self.surfaceTabs.topAnchor constraintEqualToAnchor:navigation.bottomAnchor constant:1],
    [self.surfaceTabs.bottomAnchor constraintEqualToAnchor:root.bottomAnchor],
  ]];
}

- (NSView *)buildConnectionsView {
  self.connectionsView = [[AfternoteConnectionsView alloc] initWithActionTarget:self];
  return self.connectionsView;
}

- (NSView *)buildRecoveryView {
  NSView *root = [[NSView alloc] init];
  StyleSurface(root, AfternoteCanvasColor());
  NSTextField *title = [self label:@"Recovery" size:32 weight:NSFontWeightSemibold];
  NSTextField *subtitle = [self label:@"Get the vault back to a verified state before anything opens it."
                                    size:15 weight:NSFontWeightRegular];
  subtitle.textColor = AfternoteMutedTextColor();
  self.recoveryStatusLabel = [self label:@"Checking vault readiness…" size:13 weight:NSFontWeightMedium];
  self.recoveryStatusLabel.textColor = AfternoteMutedTextColor();
  self.recoveryStatusLabel.accessibilityLabel = @"Vault recovery status";
  self.recoveryProgress = [[NSProgressIndicator alloc] init];
  self.recoveryProgress.style = NSProgressIndicatorStyleSpinning;
  self.recoveryProgress.controlSize = NSControlSizeSmall;
  [self.recoveryProgress startAnimation:nil];
  self.recoveryRefreshButton = [AfternoteButton buttonWithTitle:@"Check again"
                                                  target:self
                                                  action:@selector(refreshRecovery:)];
  [self styleSecondaryButton:self.recoveryRefreshButton];
  self.recoveryRefreshButton.accessibilityLabel = @"Check vault recovery readiness again";
  NSStackView *statusRow = [NSStackView stackViewWithViews:@[
    self.recoveryProgress, self.recoveryStatusLabel, [NSView new], self.recoveryRefreshButton
  ]];
  statusRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  statusRow.spacing = 10;
  statusRow.alignment = NSLayoutAttributeCenterY;
  statusRow.edgeInsets = NSEdgeInsetsMake(10, 12, 10, 12);
  StyleSurface(statusRow, AfternoteSurfaceColor(), 8);

  self.recoveryContent = [FlippedStackView stackViewWithViews:@[]];
  self.recoveryContent.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.recoveryContent.alignment = NSLayoutAttributeLeading;
  self.recoveryContent.spacing = 16;
  self.recoveryContent.edgeInsets = NSEdgeInsetsMake(18, 0, 32, 0);
  NSScrollView *scroll = [[NSScrollView alloc] init];
  scroll.hasVerticalScroller = YES;
  scroll.drawsBackground = NO;
  scroll.documentView = self.recoveryContent;
  NSStackView *layout = [NSStackView stackViewWithViews:@[
    title, subtitle, statusRow, scroll
  ]];
  layout.orientation = NSUserInterfaceLayoutOrientationVertical;
  layout.alignment = NSLayoutAttributeLeading;
  layout.spacing = 12;
  layout.translatesAutoresizingMaskIntoConstraints = NO;
  NSLayoutConstraint *preferredRecoveryWidth = [layout.widthAnchor constraintEqualToConstant:920];
  preferredRecoveryWidth.priority = NSLayoutPriorityDefaultHigh;
  preferredRecoveryWidth.active = YES;
  [root addSubview:layout];
  [NSLayoutConstraint activateConstraints:@[
    [layout.leadingAnchor constraintEqualToAnchor:root.leadingAnchor constant:32],
    [layout.trailingAnchor constraintLessThanOrEqualToAnchor:root.trailingAnchor constant:-32],
    [layout.topAnchor constraintEqualToAnchor:root.topAnchor constant:30],
    [layout.bottomAnchor constraintEqualToAnchor:root.bottomAnchor constant:-16],
    [layout.widthAnchor constraintLessThanOrEqualToConstant:920],
    [statusRow.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [scroll.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [scroll.heightAnchor constraintGreaterThanOrEqualToConstant:420],
    [self.recoveryContent.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor],
  ]];
  return root;
}

- (NSView *)buildSetupBanner {
  NSTextField *title = [self label:@"Set up Afternote where you work"
                                  size:14 weight:NSFontWeightSemibold];
  NSTextField *detail = [self label:@"Connect Codex, Claude Code, or Claude Desktop, then test saving and recalling a note."
                                   size:12 weight:NSFontWeightRegular];
  detail.textColor = AfternoteMutedTextColor();
  detail.maximumNumberOfLines = 2;
  NSStackView *copy = [NSStackView stackViewWithViews:@[ title, detail ]];
  copy.orientation = NSUserInterfaceLayoutOrientationVertical;
  copy.alignment = NSLayoutAttributeLeading;
  copy.spacing = 3;

  NSButton *start = [AfternoteButton buttonWithTitle:@"Start setup"
                                               target:self
                                               action:@selector(openSetupGuide:)];
  [self styleSecondaryButton:start];
  start.accessibilityLabel = @"Start the Afternote setup guide";
  NSImage *dismissImage = [NSImage imageWithSystemSymbolName:@"xmark"
                                    accessibilityDescription:@"Hide setup guide"];
  NSButton *dismiss = [AfternoteButton buttonWithImage:dismissImage
                                                 target:self
                                                 action:@selector(dismissSetupGuide:)];
  dismiss.bordered = NO;
  dismiss.contentTintColor = AfternoteMutedTextColor();
  dismiss.toolTip = @"Hide setup guide";
  dismiss.accessibilityLabel = @"Hide the Afternote setup guide";
  [dismiss.widthAnchor constraintEqualToConstant:28].active = YES;
  [dismiss.heightAnchor constraintEqualToConstant:28].active = YES;

  NSStackView *row = [NSStackView stackViewWithViews:@[
    copy, [NSView new], start, dismiss
  ]];
  row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  row.alignment = NSLayoutAttributeCenterY;
  row.spacing = 10;
  row.edgeInsets = NSEdgeInsetsMake(13, 14, 13, 10);
  NSBox *box = [[NSBox alloc] init];
  box.boxType = NSBoxCustom;
  box.cornerRadius = 8;
  box.borderWidth = 1;
  box.borderColor = AfternoteBorderColor();
  box.fillColor = AfternoteSurfaceColor();
  box.contentViewMargins = NSZeroSize;
  NSView *content = [[NSView alloc] init];
  box.contentView = content;
  row.translatesAutoresizingMaskIntoConstraints = NO;
  [content addSubview:row];
  [NSLayoutConstraint activateConstraints:@[
    [row.leadingAnchor constraintEqualToAnchor:content.leadingAnchor],
    [row.trailingAnchor constraintEqualToAnchor:content.trailingAnchor],
    [row.topAnchor constraintEqualToAnchor:content.topAnchor],
    [row.bottomAnchor constraintEqualToAnchor:content.bottomAnchor],
  ]];
  return box;
}

- (void)updateSetupBannerVisibility {
  if (self.setupBanner == nil) return;
  BOOL showingBank = self.libraryModeSelector.selectedSegment == AfternoteLibraryModeBrowse &&
      self.notesRetrieval.query.length == 0;
  self.setupBanner.hidden = self.setupGuideDismissed || !showingBank;
}

- (NSView *)buildLibraryView {
  NSView *root = [[NSView alloc] init];
  StyleSurface(root, AfternoteCanvasColor());
  self.libraryStatusLabel = [self label:@"Owner authentication required" size:13 weight:NSFontWeightMedium];
  self.libraryStatusLabel.textColor = AfternoteMutedTextColor();
  self.libraryStatusLabel.accessibilityLabel = @"Notes status";
  self.libraryProgress = [[NSProgressIndicator alloc] init];
  self.libraryProgress.style = NSProgressIndicatorStyleSpinning;
  self.libraryProgress.controlSize = NSControlSizeSmall;
  self.libraryProgress.hidden = YES;
  self.libraryAuthenticateButton = [AfternoteButton buttonWithTitle:@"Authenticate & Open"
                                                      target:self
                                                      action:@selector(authenticateLibrary:)];
  [self stylePrimaryButton:self.libraryAuthenticateButton];
  self.libraryAuthenticateButton.keyEquivalent = @"r";
  self.libraryAuthenticateButton.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  self.libraryAuthenticateButton.accessibilityLabel = @"Authenticate and open Notes";
  self.libraryModeSelector = [NSSegmentedControl segmentedControlWithLabels:@[ @"Write", @"Ask", @"Browse" ]
                                                                    trackingMode:NSSegmentSwitchTrackingSelectOne
                                                                          target:self
                                                                          action:@selector(switchLibraryMode:)];
  self.libraryModeSelector.selectedSegment = AfternoteLibraryModeBrowse;
  self.libraryModeSelector.controlSize = NSControlSizeRegular;
  self.libraryModeSelector.segmentStyle = NSSegmentStyleCapsule;
  self.libraryModeSelector.selectedSegmentBezelColor = AfternoteAccentColor();
  self.libraryModeSelector.accessibilityLabel = @"Notes state";
  self.libraryModeSelector.hidden = YES;
  self.createNoteButton = [AfternoteButton buttonWithTitle:@"New note" target:self action:@selector(beginNewNote:)];
  [self styleSecondaryButton:self.createNoteButton];
  self.createNoteButton.keyEquivalent = @"n";
  self.createNoteButton.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  self.createNoteButton.accessibilityLabel = @"Create a new local memory";
  self.libraryRefreshButton = [AfternoteButton buttonWithTitle:@"Refresh"
                                                        target:self
                                                        action:@selector(refreshVisibleLibraryNotes:)];
  [self styleSecondaryButton:self.libraryRefreshButton];
  self.libraryRefreshButton.accessibilityLabel = @"Refresh notes";
  NSStackView *statusRow = [NSStackView stackViewWithViews:@[
    self.libraryProgress, self.libraryStatusLabel, self.libraryAuthenticateButton
  ]];
  statusRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  statusRow.alignment = NSLayoutAttributeCenterY;
  statusRow.spacing = 10;

  self.librarySearch = [[NSTextField alloc] init];
  self.librarySearch.delegate = self;
  self.librarySearch.target = self;
  self.librarySearch.action = @selector(searchLibrary:);
  self.librarySearch.accessibilityLabel = @"Search your notes";
  [self styleSearchField:self.librarySearch];
  self.librarySearch.placeholderString = @"Search anything you've written down";
  NSImage *searchImage = [NSImage imageWithSystemSymbolName:@"magnifyingglass"
                                  accessibilityDescription:@"Search your notes"];
  searchImage = [searchImage imageWithSymbolConfiguration:
      [NSImageSymbolConfiguration configurationWithPointSize:15
                                                      weight:NSFontWeightRegular]];
  NSImageView *searchIcon = [NSImageView imageViewWithImage:searchImage];
  searchIcon.contentTintColor = AfternoteMutedTextColor();
  searchIcon.accessibilityElement = NO;
  NSImage *submitImage = [NSImage imageWithSystemSymbolName:@"arrow.right"
                                    accessibilityDescription:@"Search"];
  self.askButton = [AfternoteButton buttonWithImage:submitImage
                                      target:self
                                      action:@selector(searchLibrary:)];
  [self stylePrimaryButton:self.askButton];
  self.askButton.accessibilityLabel = @"Search notes";
  ((AfternoteButton *)self.askButton).afternoteCornerRadius = 4;
  NSImage *clearImage = [NSImage imageWithSystemSymbolName:@"xmark.circle.fill"
                                    accessibilityDescription:@"Clear search"];
  self.clearSearchButton = [AfternoteButton buttonWithImage:clearImage
                                                     target:self
                                                     action:@selector(clearSearch:)];
  self.clearSearchButton.bordered = NO;
  self.clearSearchButton.contentTintColor = AfternoteMutedTextColor();
  self.clearSearchButton.toolTip = @"Clear search and return to your notes";
  self.clearSearchButton.accessibilityLabel = @"Clear search and show your notes";
  self.clearSearchButton.hidden = YES;
  NSStackView *queryRow = [NSStackView stackViewWithViews:@[
    searchIcon, self.librarySearch, self.clearSearchButton, self.askButton
  ]];
  queryRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  queryRow.alignment = NSLayoutAttributeCenterY;
  queryRow.spacing = 10;
  self.askComposer = [[AfternoteAskComposerView alloc] init];
  StyleSurface(self.askComposer, AfternoteSurfaceColor(), 10);
  self.askComposer.wantsLayer = YES;
  self.askComposer.afternoteFocused = NO;
  queryRow.translatesAutoresizingMaskIntoConstraints = NO;
  [self.askComposer addSubview:queryRow];
  self.askComposerHeightConstraint =
      [self.askComposer.heightAnchor constraintEqualToConstant:kAskComposerHeight];
  self.searchFieldHeightConstraint =
      [self.librarySearch.heightAnchor constraintEqualToConstant:kAskFieldHeight];
  [NSLayoutConstraint activateConstraints:@[
    [queryRow.leadingAnchor constraintEqualToAnchor:self.askComposer.leadingAnchor constant:14],
    [queryRow.trailingAnchor constraintEqualToAnchor:self.askComposer.trailingAnchor constant:-8],
    [queryRow.centerYAnchor constraintEqualToAnchor:self.askComposer.centerYAnchor],
    self.askComposerHeightConstraint,
    [searchIcon.widthAnchor constraintEqualToConstant:kAskIconSize],
    [searchIcon.heightAnchor constraintEqualToConstant:kAskIconSize],
    [self.clearSearchButton.widthAnchor constraintEqualToConstant:24],
    [self.clearSearchButton.heightAnchor constraintEqualToConstant:24],
    [self.askButton.widthAnchor constraintEqualToConstant:kAskSubmitButtonSize],
    [self.askButton.heightAnchor constraintEqualToConstant:kAskSubmitButtonSize],
    self.searchFieldHeightConstraint,
  ]];
  self.searchProgress = [AfternoteSearchProgress new];
  self.searchProgress.retryButton.target = self;
  self.searchProgress.retryButton.action = @selector(retrySemanticProgress:);
  self.askControls = [NSStackView stackViewWithViews:@[ self.askComposer, self.searchProgress ]];
  self.askControls.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.askControls.alignment = NSLayoutAttributeLeading;
  self.askControls.spacing = 8;

  self.libraryViews = [NSStackView stackViewWithViews:@[]];
  self.libraryViews.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  self.libraryViews.alignment = NSLayoutAttributeCenterY;
  self.libraryViews.spacing = 8;
  NSTextField *viewsHeading = [self label:@"SMART CATEGORIES" size:11 weight:NSFontWeightSemibold];
  viewsHeading.textColor = AfternoteMutedTextColor();
  viewsHeading.accessibilityLabel = @"Smart categories";
  NSButton *recent = [NSButton buttonWithTitle:@"Recent" target:self action:@selector(selectLibraryView:)];
  self.libraryRecentButton = recent;
  recent.identifier = @"";
  [self styleNavigationButton:recent selected:YES];
  recent.accessibilityLabel = @"Recent notes";
  [recent.heightAnchor constraintEqualToConstant:34].active = YES;
  NSStackView *browseButtons = [NSStackView stackViewWithViews:@[ recent, self.libraryViews, [NSView new] ]];
  browseButtons.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  browseButtons.alignment = NSLayoutAttributeCenterY;
  browseButtons.spacing = 8;
  self.browseControls = [NSStackView stackViewWithViews:@[ viewsHeading, browseButtons ]];
  self.browseControls.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.browseControls.alignment = NSLayoutAttributeLeading;
  self.browseControls.spacing = 8;
  self.browseControls.hidden = YES;

  self.noteTable = [[NSTableView alloc] init];
  NSTableColumn *noteColumn = [[NSTableColumn alloc] initWithIdentifier:@"note"];
  noteColumn.title = @"Notes";
  noteColumn.resizingMask = NSTableColumnAutoresizingMask;
  noteColumn.width = 600;
  noteColumn.minWidth = 0;
  [self.noteTable addTableColumn:noteColumn];
  self.noteTable.columnAutoresizingStyle = NSTableViewLastColumnOnlyAutoresizingStyle;
  self.noteTable.headerView = nil;
  self.noteTable.style = NSTableViewStylePlain;
  self.noteTable.delegate = self;
  self.noteTable.dataSource = self;
  self.noteTable.rowHeight = 120;
  self.noteTable.intercellSpacing = NSMakeSize(0, 0);
  self.noteTable.backgroundColor = AfternoteCanvasColor();
  self.noteTable.selectionHighlightStyle = NSTableViewSelectionHighlightStyleRegular;
  self.noteTable.allowsEmptySelection = YES;
  self.noteTable.accessibilityLabel = @"Saved notes";
  NSScrollView *noteScroll = [[NSScrollView alloc] init];
  noteScroll.documentView = self.noteTable;
  noteScroll.hasVerticalScroller = YES;
  noteScroll.scrollerStyle = NSScrollerStyleOverlay;
  noteScroll.autohidesScrollers = YES;
  noteScroll.borderType = NSNoBorder;
  noteScroll.contentInsets = NSEdgeInsetsZero;
  noteScroll.drawsBackground = NO;
  self.loadMoreNotesButton = [AfternoteButton buttonWithTitle:@"Load more" target:self action:@selector(loadMoreNotes:)];
  [self styleSecondaryButton:self.loadMoreNotesButton];
  self.loadMoreNotesButton.hidden = YES;
  self.resultsHeadingLabel = [self label:@"Recent notes"
                                      size:12 weight:NSFontWeightSemibold];
  self.resultsHeadingLabel.textColor = AfternoteMutedTextColor();

  self.noteEditorView = [[AfternoteNoteEditorView alloc] initWithActionTarget:self];
  NSView *writeWorkspace = self.noteEditorView;

  self.libraryWorkspaceTitle = [self label:@"Notes" size:28 weight:NSFontWeightSemibold];
  self.libraryWorkspaceSubtitle = [self label:@"Your local notes."
                                             size:15 weight:NSFontWeightRegular];
  self.libraryWorkspaceSubtitle.textColor = AfternoteMutedTextColor();
  self.setupBanner = [self buildSetupBanner];
  NSStackView *discoveryColumn = [NSStackView stackViewWithViews:@[
    self.libraryWorkspaceTitle, self.libraryWorkspaceSubtitle,
    self.setupBanner, self.askControls, self.browseControls, self.resultsHeadingLabel,
    noteScroll, self.loadMoreNotesButton
  ]];
  discoveryColumn.orientation = NSUserInterfaceLayoutOrientationVertical;
  discoveryColumn.alignment = NSLayoutAttributeLeading;
  discoveryColumn.spacing = 10;
  NSView *discoveryWorkspace = [[NSView alloc] init];
  StyleSurface(discoveryWorkspace, AfternoteCanvasColor());
  discoveryColumn.translatesAutoresizingMaskIntoConstraints = NO;
  [discoveryWorkspace addSubview:discoveryColumn];
  [NSLayoutConstraint activateConstraints:@[
    [discoveryColumn.leadingAnchor constraintGreaterThanOrEqualToAnchor:discoveryWorkspace.leadingAnchor constant:32],
    [discoveryColumn.trailingAnchor constraintLessThanOrEqualToAnchor:discoveryWorkspace.trailingAnchor constant:-32],
    [discoveryColumn.centerXAnchor constraintEqualToAnchor:discoveryWorkspace.centerXAnchor],
    [discoveryColumn.topAnchor constraintEqualToAnchor:discoveryWorkspace.topAnchor constant:34],
    [discoveryColumn.bottomAnchor constraintEqualToAnchor:discoveryWorkspace.bottomAnchor constant:-28],
    [discoveryColumn.widthAnchor constraintGreaterThanOrEqualToConstant:600],
    [discoveryColumn.widthAnchor constraintLessThanOrEqualToConstant:780],
    [self.askComposer.widthAnchor constraintEqualToAnchor:discoveryColumn.widthAnchor],
    [self.searchProgress.widthAnchor constraintEqualToAnchor:discoveryColumn.widthAnchor],
    [self.askControls.widthAnchor constraintEqualToAnchor:discoveryColumn.widthAnchor],
    [self.setupBanner.widthAnchor constraintEqualToAnchor:discoveryColumn.widthAnchor],
    [noteScroll.widthAnchor constraintEqualToAnchor:discoveryColumn.widthAnchor],
    [noteScroll.heightAnchor constraintGreaterThanOrEqualToConstant:260],
  ]];
  [self updateSetupBannerVisibility];

  self.libraryWorkspaceTabs = [[NSTabView alloc] init];
  self.libraryWorkspaceTabs.tabViewType = NSNoTabsNoBorder;
  NSTabViewItem *writeItem = [[NSTabViewItem alloc] initWithIdentifier:@"write"];
  writeItem.view = writeWorkspace;
  NSTabViewItem *discoveryItem = [[NSTabViewItem alloc] initWithIdentifier:@"discovery"];
  discoveryItem.view = discoveryWorkspace;
  [self.libraryWorkspaceTabs addTabViewItem:writeItem];
  [self.libraryWorkspaceTabs addTabViewItem:discoveryItem];
  [self.libraryWorkspaceTabs selectTabViewItemAtIndex:1];

  NSStackView *modeRow = [NSStackView stackViewWithViews:@[
    statusRow, [NSView new], self.libraryRefreshButton, self.createNoteButton
  ]];
  modeRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  modeRow.alignment = NSLayoutAttributeCenterY;
  modeRow.spacing = 12;
  NSStackView *header = [NSStackView stackViewWithViews:@[ modeRow ]];
  header.orientation = NSUserInterfaceLayoutOrientationVertical;
  header.alignment = NSLayoutAttributeLeading;
  header.spacing = 0;
  header.edgeInsets = NSEdgeInsetsMake(12, 24, 12, 24);
  StyleSurface(header, AfternoteSidebarColor());
  NSStackView *layout = [NSStackView stackViewWithViews:@[ header, self.libraryWorkspaceTabs ]];
  layout.orientation = NSUserInterfaceLayoutOrientationVertical;
  layout.alignment = NSLayoutAttributeLeading;
  layout.spacing = 1;
  layout.translatesAutoresizingMaskIntoConstraints = NO;
  [root addSubview:layout];
  [NSLayoutConstraint activateConstraints:@[
    [layout.leadingAnchor constraintEqualToAnchor:root.leadingAnchor],
    [layout.trailingAnchor constraintEqualToAnchor:root.trailingAnchor],
    [layout.topAnchor constraintEqualToAnchor:root.topAnchor],
    [layout.bottomAnchor constraintEqualToAnchor:root.bottomAnchor],
    [header.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
    [modeRow.widthAnchor constraintEqualToAnchor:header.widthAnchor constant:-48],
    [self.libraryWorkspaceTabs.widthAnchor constraintEqualToAnchor:layout.widthAnchor],
  ]];
  [self renderActiveNote];
  return root;
}

- (void)switchSurface:(NSSegmentedControl *)sender {
  NSInteger segment = sender.selectedSegment;
  BOOL recoveryReady = self.recoveryState.length == 0 ||
      [self.recoveryState isEqualToString:@"ready"];
  AfternoteProductSurface requested = segment == AfternoteNavigationSegmentForSurface(
      AfternoteProductSurfaceMemory)
      ? AfternoteProductSurfaceMemory
      : AfternoteProductSurfaceConnections;
  AfternoteProductSurface resolved = [self displaySurface:requested
                                             recoveryReady:recoveryReady];
  if (resolved == AfternoteProductSurfaceRecovery) {
    [self refreshRecovery:nil];
    return;
  }
  if (resolved == AfternoteProductSurfaceMemory) {
    if (self.libraryExpiresAt.length == 0) {
      if (self.vaultLocked) [self setLibraryBusy:NO status:LockedLibraryMessage()];
      else [self authenticateLibrary:nil];
    } else [self refreshVisibleLibraryNotes:nil];
    return;
  }
  [self refreshConnections:nil];
}

- (void)scheduleSemanticStatusPoll {
  if (self.semanticPollPending || self.semanticActivationInFlight || self.semanticStatusFailures >= 3 || self.vaultLocked ||
      self.libraryExpiresAt.length == 0 || ![self.currentSearchMode isEqualToString:@"indexing"]) return;
  self.semanticPollPending = YES;
  NSUInteger sequence = ++self.semanticPollSequence;
  NSUInteger generation = self.librarySessionGeneration;
  __weak OwnerControlDelegate *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    OwnerControlDelegate *view = weakSelf;
    if (!view || generation != view.librarySessionGeneration || sequence != view.semanticPollSequence) return;
    view.semanticPollPending = NO;
    if ([view.currentSearchMode isEqualToString:@"indexing"])
      [view refreshSemanticSearch:NO userInitiated:NO];
  });
}

- (void)activateSemanticSearch:(BOOL)userInitiated {
  [self refreshSemanticSearch:YES userInitiated:userInitiated];
}

- (void)refreshSemanticSearch:(BOOL)reloadModel userInitiated:(BOOL)userInitiated {
  if (self.broker == nil) return;
  if (self.semanticActivationInFlight) {
    if (reloadModel) self.semanticReloadPending = YES;
    return;
  }
  if (self.vaultLocked || self.libraryExpiresAt.length == 0) {
    if (userInitiated) {
      // Normal Notes authentication owns access and any draft-navigation policy.
      [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
      [self setLibraryBusy:NO status:@"Open Notes with your usual authentication to activate semantic search."];
    }
    return;
  }
  self.semanticPollSequence += 1;
  self.semanticPollPending = NO;
  self.semanticActivationInFlight = YES;
  NSUInteger generation = self.librarySessionGeneration;
  [self.broker requestMethod:@"library.refresh_search" params:@{ @"reloadModel": @(reloadModel) }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration) return;
      self.semanticActivationInFlight = NO;
      if (self.semanticReloadPending) {
        self.semanticReloadPending = NO;
        [self refreshSemanticSearch:YES userInitiated:NO];
        return;
      }
      if (error != nil) {
        [self showLibraryError:error];
        if (reloadModel) [self.semanticSettings activationFailed];
        if (self.libraryExpiresAt.length > 0 && !self.vaultLocked) {
          self.semanticStatusFailures += 1;
          [self renderSemanticProgress];
          [self scheduleSemanticStatusPoll];
        }
        return;
      }
      NSInteger indexed = [result[@"indexedNotes"] integerValue];
      NSInteger total = [result[@"totalNotes"] integerValue];
      if (indexed != self.semanticIndexedNotes || total != self.semanticTotalNotes)
        self.semanticLastProgressAt = NSProcessInfo.processInfo.systemUptime;
      self.semanticIndexedNotes = indexed;
      self.semanticTotalNotes = total;
      self.semanticStatusFailures = 0;
      [self.semanticSettings setIndexedNotes:indexed total:total];
      [self applySearchMode:StringValue(result[@"searchMode"], @"exact")];
      [self.semanticSettings activationCompleted:self.currentSearchMode modelId:StringValue(result[@"modelId"], @"")];
    });
  }];
}

- (void)openSettings:(id)sender {
  (void)sender;
  [self displaySurface:AfternoteProductSurfaceSettings recoveryReady:YES];
  [self.semanticSettings refresh];
  if (self.broker == nil) return;
  [self refreshRoutineAuthenticationPreference];
  NSUInteger requestSequence = ++self.lifecycleStatusRequestSequence;
  self.vaultStatusCheckInFlight = YES;
  [self updateVaultAccessButton];
  [self.broker requestMethod:@"lifecycle.status" params:@{}
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self applyVaultLifecycleStatus:result error:error requestSequence:requestSequence];
    });
  }];
}

- (void)selectRoutineAuthenticationTtl:(int64_t)ttlMs {
  for (NSMenuItem *item in self.routineAuthenticationMenu.itemArray) {
    if ([item.representedObject longLongValue] == ttlMs) {
      [self.routineAuthenticationMenu selectItem:item];
      return;
    }
  }
}

- (void)refreshRoutineAuthenticationPreference {
  [self.broker requestMethod:@"owner.routine_authentication" params:@{}
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error != nil) return;
      int64_t ttlMs = [result[@"ttlMs"] longLongValue];
      [NSUserDefaults.standardUserDefaults setInteger:ttlMs
                                                forKey:kRoutineAuthenticationDefaultsKey];
      [self selectRoutineAuthenticationTtl:ttlMs];
    });
  }];
}

- (void)updateVaultAccessButton {
  if (self.vaultAccessButton == nil) return;
  if (self.vaultStatusCheckInFlight) {
    self.vaultAccessButton.enabled = NO;
    self.vaultAccessButton.title = @"Checking…";
    self.vaultAccessButton.accessibilityLabel = @"Checking the Afternote vault state";
    return;
  }
  self.vaultAccessButton.enabled = YES;
  self.vaultAccessButton.title = self.vaultLocked ? @"Unlock vault" : @"Lock vault";
  self.vaultAccessButton.accessibilityLabel = self.vaultLocked
      ? @"Unlock the Afternote vault"
      : @"Lock the Afternote vault and disconnect all sessions";
}

- (void)routineAuthenticationChanged:(NSPopUpButton *)sender {
  NSNumber *ttl = [sender.selectedItem.representedObject isKindOfClass:[NSNumber class]]
      ? sender.selectedItem.representedObject
      : @(kRoutineAuthenticationDailyMilliseconds);
  int64_t previousTtl = RoutineAuthenticationTtlMilliseconds();
  if (self.broker == nil) {
    [NSUserDefaults.standardUserDefaults setInteger:ttl.longLongValue
                                              forKey:kRoutineAuthenticationDefaultsKey];
    return;
  }
  sender.enabled = NO;
  [self.broker requestMethod:@"owner.set_routine_authentication"
                      params:@{ @"ttlMs" : ttl }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      sender.enabled = YES;
      if (error != nil) {
        [self selectRoutineAuthenticationTtl:previousTtl];
        [self showSettingsResultWithTitle:@"Authentication setting unchanged"
                                  message:StringValue(error[@"message"],
                                                      @"Afternote could not save this setting.")];
        return;
      }
      int64_t savedTtl = [result[@"ttlMs"] longLongValue];
      [NSUserDefaults.standardUserDefaults setInteger:savedTtl
                                                forKey:kRoutineAuthenticationDefaultsKey];
      [self selectRoutineAuthenticationTtl:savedTtl];
      if (savedTtl != previousTtl) {
        self.ownerSessionGeneration += 1;
        self.connections = nil;
        self.ownerExpiresAt = nil;
        self.auditCursor = nil;
        [self.auditEvents removeAllObjects];
        [self.revocationTargets removeAllObjects];
        [self clearLibraryPlaintext:
            @"Authentication frequency changed. Authenticate again to reopen Notes."];
        if (self.connectionsView != nil) [self render];
        [self setBusy:NO status:
            @"Authentication frequency changed. Authenticate again to inspect connections."];
      }
    });
  }];
}

- (void)toggleVaultLock:(id)sender {
  if (self.vaultLocked) {
    [self unlockVaultFromSettings:sender];
  } else {
    [self lockVault:sender];
  }
}

- (void)lockVault:(id)sender {
  NSButton *button = [sender isKindOfClass:[NSButton class]] ? sender : nil;
  button.enabled = NO;
  [self.broker requestLifecycleTransitionMethod:@"lifecycle.lock"
                                          reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      button.enabled = YES;
      if (error != nil || !AfternoteBrokerResultIsValid(@"lifecycle.lock", result, @{})) {
        [self setLibraryBusy:NO status:StringValue(error[@"message"], @"The vault could not be locked.")];
        return;
      }
      self.vaultLocked = YES;
      self.vaultStatusCheckInFlight = NO;
      [self updateVaultAccessButton];
      [self clearLibraryPlaintext:@"Vault locked. Connector sessions were disconnected."];
      [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
    });
  }];
}

- (void)unlockVaultFromSettings:(id)sender {
  NSButton *button = [sender isKindOfClass:[NSButton class]] ? sender : self.vaultAccessButton;
  button.enabled = NO;
  button.title = @"Unlocking…";
  [self.broker requestLifecycleTransitionMethod:@"lifecycle.unlock"
                                          reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error != nil || !AfternoteBrokerResultIsValid(@"lifecycle.unlock", result, @{})) {
        [self updateVaultAccessButton];
        [self showSettingsResultWithTitle:@"Vault could not unlock"
                                  message:StringValue(error[@"message"],
                                                      @"The broker returned an invalid unlock response.")];
        return;
      }
      self.vaultLocked = NO;
      self.vaultStatusCheckInFlight = NO;
      self.libraryAuthenticateButton.title = @"Authenticate & Open";
      [self updateVaultAccessButton];
      [self setLibraryBusy:NO status:@"Vault unlocked. Open Notes when you are ready."];
    });
  }];
}

- (void)setRecoveryBusy:(BOOL)busy status:(NSString *)status {
  void (^apply)(void) = ^{
    self.recoveryRefreshButton.enabled = !busy;
    for (NSButton *button in self.recoveryActionButtons) {
      button.enabled = !busy && !self.recoveryOperationInFlight;
    }
    self.recoveryStatusLabel.stringValue = status;
    self.recoveryProgress.hidden = !busy;
    if (busy) [self.recoveryProgress startAnimation:nil];
    else [self.recoveryProgress stopAnimation:nil];
  };
  if (NSThread.isMainThread) apply();
  else dispatch_async(dispatch_get_main_queue(), apply);
}

- (void)setPrivilegedSurfacesReady:(BOOL)ready {
  [self.surfaceSelector setEnabled:ready forSegment:0];
  [self.surfaceSelector setEnabled:ready forSegment:1];
  self.memoryNavigationButton.enabled = ready;
  self.connectionsNavigationButton.enabled = ready;
  if (!ready) {
    self.libraryAuthenticateButton.enabled = NO;
    [self.connectionsView setRefreshEnabled:NO];
  }
}

- (void)enterNonReadyRecoveryState:(NSString *)state
                            status:(NSString *)status
                           message:(NSString *)message {
  self.lifecycleStatusRequestSequence += 1;
  self.ownerSessionGeneration += 1;
  self.connectorOverviewGeneration += 1;
  self.recoveryState = state;
  [self setPrivilegedSurfacesReady:NO];
  [self clearLibraryPlaintext:message];
  self.connections = nil;
  self.connectorOverviewByKind = @{};
  self.ownerExpiresAt = nil;
  self.auditCursor = nil;
  [self.auditEvents removeAllObjects];
  [self.revocationTargets removeAllObjects];
  if (self.connectionsView != nil) [self render];
  [self displaySurface:AfternoteProductSurfaceRecovery recoveryReady:YES];
  [self setRecoveryBusy:NO status:status];
  [self renderRecoveryState];
}

- (void)brokerDidDisconnect {
  if (self.brokerRecoveryInFlight) {
    NSUInteger sequence = ++self.brokerRecoverySequence;
    [self finishBrokerRecoveryForSequence:sequence
                                   attempt:self.brokerRecoveryAttempt
                                     ready:NO];
    return;
  }
  self.brokerRecoveryInFlight = YES;
  self.brokerRecoveryAttempt = 0;
  self.lifecycleStatusRequestSequence += 1;
  self.recoveryStatusRequestSequence += 1;
  self.recoveryOperationSequence += 1;
  self.recoveryOperationInFlight = NO;
  self.ownerSessionGeneration += 1;
  self.connectorOverviewGeneration += 1;
  [self.surfaceRouter beginBrokerRecoveryFromNavigationSegment:
      self.surfaceSelector.selectedSegment];
  NSUInteger sequence = ++self.brokerRecoverySequence;
  [self setPrivilegedSurfacesReady:NO];
  [self clearLibraryPlaintext:@"The broker restarted. Reconnecting…"];
  self.connections = nil;
  self.connectorOverviewByKind = @{};
  self.ownerExpiresAt = nil;
  self.auditCursor = nil;
  [self.auditEvents removeAllObjects];
  [self.revocationTargets removeAllObjects];
  if (self.connectionsView != nil) [self render];
  [self setBusy:NO status:@"The broker restarted. Reconnecting…"];
  [self attemptBrokerRecoveryForSequence:sequence attempt:1];
}

- (void)finishBrokerRecoveryForSequence:(NSUInteger)sequence
                                 attempt:(NSUInteger)attempt
                                   ready:(BOOL)ready {
  if (sequence != self.brokerRecoverySequence) return;
  AfternoteBrokerRecoveryOutcome outcome =
      AfternoteBrokerRecoveryOutcomeForAttempt(attempt, ready);
  if (outcome == AfternoteBrokerRecoveryOutcomeRetry) {
    [self attemptBrokerRecoveryForSequence:sequence attempt:attempt + 1];
    return;
  }
  if (outcome == AfternoteBrokerRecoveryOutcomeUnavailable) {
    self.brokerRecoveryInFlight = NO;
    [self enterNonReadyRecoveryState:@"unavailable"
                              status:@"Broker unavailable"
                             message:@"Afternote could not reconnect after the service interruption. Plaintext and local authority were cleared."];
    return;
  }
  self.brokerRecoveryInFlight = NO;
  self.recoveryState = @"ready";
  [self setPrivilegedSurfacesReady:YES];
  AfternoteProductSurface surface =
      [self.surfaceRouter finishBrokerRecoveryWithVaultLocked:self.vaultLocked];
  [self displaySurface:surface recoveryReady:YES];
  self.libraryAuthenticateButton.enabled = YES;
  [self.connectionsView setRefreshEnabled:YES];
  self.libraryAuthenticateButton.title = self.vaultLocked
      ? @"Unlock vault" : @"Authenticate & Open";
  [self setLibraryBusy:NO status:self.vaultLocked
      ? LockedLibraryMessage()
      : @"Broker reconnected. Authenticate to reopen Notes."];
  [self setBusy:NO
         status:@"Broker reconnected. Authenticate to refresh connections."];
}

- (void)attemptBrokerRecoveryForSequence:(NSUInteger)sequence
                                 attempt:(NSUInteger)attempt {
  NSTimeInterval delay = AfternoteBrokerRecoveryDelaySeconds(attempt);
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
  delay = 0.001;
#endif
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,
                               (int64_t)(delay * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    if (sequence != self.brokerRecoverySequence) return;
    self.brokerRecoveryAttempt = attempt;
    [self.broker replaceConnection];
    [self.broker requestMethod:@"recovery.status" params:@{}
                         reply:^(NSDictionary *result, NSDictionary *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (sequence != self.brokerRecoverySequence) return;
        if (error != nil || !AfternoteBrokerResultIsValid(@"recovery.status", result, @{})) {
          [self finishBrokerRecoveryForSequence:sequence attempt:attempt ready:NO];
          return;
        }
        NSString *state = StringValue(result[@"state"]);
        if (![state isEqualToString:@"encrypted-candidate"]) {
          self.brokerRecoveryInFlight = NO;
          [self enterNonReadyRecoveryState:state
                                    status:@"Recovery action required"
                                   message:@"The broker reconnected, but the vault requires recovery before it can be opened."];
          return;
        }
        [self.broker requestMethod:@"lifecycle.status" params:@{}
                             reply:^(NSDictionary *lifecycle, NSDictionary *lifecycleError) {
          dispatch_async(dispatch_get_main_queue(), ^{
            if (sequence != self.brokerRecoverySequence) return;
            BOOL verified = lifecycleError == nil &&
                AfternoteBrokerResultIsValid(@"lifecycle.status", lifecycle, @{});
            if (verified) {
              self.vaultLocked = ![StringValue(lifecycle[@"state"])
                  isEqualToString:@"unlocked"];
              self.vaultStatusCheckInFlight = NO;
              [self updateVaultAccessButton];
            }
            [self finishBrokerRecoveryForSequence:sequence
                                           attempt:attempt ready:verified];
          });
        }];
      });
    }];
  });
}

- (void)clearRecoveryContent {
  for (NSView *view in [self.recoveryContent.arrangedSubviews copy]) {
    [self.recoveryContent removeArrangedSubview:view];
    [view removeFromSuperview];
  }
}

- (void)addRecoveryCard:(NSView *)card {
  [self.recoveryContent addArrangedSubview:card];
  [card.widthAnchor constraintEqualToAnchor:self.recoveryContent.widthAnchor constant:-8].active = YES;
}

- (void)renderRecoveryState {
  [self clearRecoveryContent];
  [self.recoveryActionButtons removeAllObjects];
  if (self.recoveryErrorMessage.length > 0) {
    [self addRecoveryCard:[self cardWithTitle:@"Last recovery attempt"
                                       status:@"error"
                                         body:@[self.recoveryErrorMessage]
                                       button:nil]];
  }
  NSString *state = self.recoveryState ?: @"unavailable";
  if ([state isEqualToString:@"ready"]) {
    NSButton *open = [AfternoteButton buttonWithTitle:@"Open Notes" target:self action:@selector(openReadyLibrary:)];
    [self stylePrimaryButton:open];
    [self.recoveryActionButtons addObject:open];
    open.accessibilityLabel = @"Open the ready Afternote Notes surface";
    [self addRecoveryCard:[self cardWithTitle:@"Vault ready"
                                       status:@"success"
                                         body:@[@"Encrypted storage is ready. No migration or interrupted recovery is pending."]
                                       button:open]];
    return;
  }
  if ([state isEqualToString:@"empty"]) {
    NSButton *restore = [AfternoteButton buttonWithTitle:@"Choose backup…" target:self action:@selector(chooseRestoreBackup:)];
    [self stylePrimaryButton:restore];
    [self.recoveryActionButtons addObject:restore];
    restore.accessibilityLabel = @"Choose an Afternote export to restore";
    [self addRecoveryCard:[self cardWithTitle:@"Restore an export"
                                       status:@"available"
                                         body:@[@"Choose an Afternote JSON export. The broker verifies it before creating the encrypted vault."]
                                       button:restore]];
    NSButton *empty = [AfternoteButton buttonWithTitle:@"Start with an empty vault" target:self action:@selector(createEmptyVault:)];
    [self styleSecondaryButton:empty];
    [self.recoveryActionButtons addObject:empty];
    empty.accessibilityLabel = @"Create a new empty encrypted vault";
    [self addRecoveryCard:[self cardWithTitle:@"Start empty"
                                       status:@"available"
                                         body:@[@"Create a new encrypted vault without importing any notes."]
                                       button:empty]];
    return;
  }
  if ([state isEqualToString:@"migration-required"] ||
      [state isEqualToString:@"migration-resume-required"]) {
    BOOL resume = [state isEqualToString:@"migration-resume-required"];
    NSButton *migrate = [AfternoteButton buttonWithTitle:resume ? @"Resume migration" : @"Migrate now"
                                           target:self
                                           action:@selector(beginSafeMigration:)];
    [self stylePrimaryButton:migrate];
    [self.recoveryActionButtons addObject:migrate];
    migrate.accessibilityLabel = @"Migrate the vault while preserving plaintext originals";
    [self addRecoveryCard:[self cardWithTitle:resume ? @"Migration interrupted" : @"Plaintext vault found"
                                       status:@"action required"
                                         body:@[
                                           resume ? @"Afternote can safely resume the interrupted encryption migration." : @"Encrypt this vault before opening Notes.",
                                           @"The live plaintext source and discovered plaintext backups will be preserved."
                                         ]
                                       button:migrate]];
    return;
  }
  if ([state isEqualToString:@"migration-manual-resume-required"]) {
    [self addRecoveryCard:[self cardWithTitle:@"Migration needs its original choices"
                                       status:@"action required"
                                         body:@[
                                           @"This migration began with move or delete choices. Resume it with the same encrypt-vault arguments so Afternote can verify the original plan.",
                                           @"No new migration or restore will start until that exact recovery completes."
                                         ]
                                       button:nil]];
    return;
  }
  if ([state isEqualToString:@"restore-resume-required"]) {
    NSButton *restore = [AfternoteButton buttonWithTitle:@"Choose original backup…" target:self action:@selector(chooseRestoreBackup:)];
    [self stylePrimaryButton:restore];
    [self.recoveryActionButtons addObject:restore];
    restore.accessibilityLabel = @"Choose the original Afternote export to resume restore";
    [self addRecoveryCard:[self cardWithTitle:@"Restore interrupted"
                                       status:@"action required"
                                         body:@[@"Choose the same export again. Afternote will verify its identity before resuming."]
                                       button:restore]];
    return;
  }
  if ([state isEqualToString:@"vault-key-unavailable"]) {
    [self addRecoveryCard:[self cardWithTitle:@"Vault key unavailable"
                                       status:@"action required"
                                         body:@[
                                           @"This encrypted vault cannot be opened because its installation-bound Keychain item is unavailable.",
                                           @"Restore a supported Afternote export or contact support before changing the vault or any Keychain item."
                                         ]
                                       button:nil]];
    return;
  }
  NSString *body = [state isEqualToString:@"conflict"]
      ? @"Migration and restore markers both exist. Afternote will not guess which operation owns the vault."
      : @"Afternote could not verify the recovery state. No vault operation was started.";
  [self addRecoveryCard:[self cardWithTitle:@"Recovery blocked"
                                     status:@"error"
                                       body:@[body]
                                     button:nil]];
}

- (void)refreshRecovery:(id)sender {
  (void)sender;
  self.recoveryErrorMessage = nil;
  [self refreshRecoveryStatusAndContinue:NO];
}

- (void)refreshRecoveryStatusAndContinue:(BOOL)continueToRequestedSurface {
  NSUInteger sequence = ++self.recoveryStatusRequestSequence;
  [self setRecoveryBusy:YES status:@"Checking vault readiness…"];
  [self.broker requestMethod:@"recovery.status" params:@{} reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (sequence != self.recoveryStatusRequestSequence) return;
      if (error != nil || !AfternoteBrokerResultIsValid(@"recovery.status", result, @{})) {
        self.recoveryErrorMessage = error != nil
            ? StringValue(error[@"message"], @"Recovery state could not be verified.")
            : @"The broker returned an invalid recovery status.";
        [self enterNonReadyRecoveryState:@"unavailable"
                                  status:@"Recovery state unavailable"
                                 message:@"Vault readiness could not be verified. Plaintext and local authority were cleared."];
        return;
      }
      self.recoveryState = result[@"state"];
      if ([self.recoveryState isEqualToString:@"encrypted-candidate"]) {
        [self confirmEncryptedCandidateForSequence:sequence
                         continueToRequestedSurface:continueToRequestedSurface];
        return;
      }
      [self setRecoveryBusy:NO status:[self.recoveryState isEqualToString:@"ready"]
          ? @"Vault ready" : @"Recovery action required"];
      [self renderRecoveryState];
      if (![self.recoveryState isEqualToString:@"ready"]) {
        [self enterNonReadyRecoveryState:self.recoveryState
                                  status:@"Recovery action required"
                                 message:@"Vault recovery is required. Plaintext and local authority were cleared."];
        return;
      }
      if (!continueToRequestedSurface) return;
      if ([NSProcessInfo.processInfo.arguments containsObject:@"--connections"]) {
        [self displaySurface:AfternoteProductSurfaceConnections recoveryReady:YES];
        [self authenticate:nil];
      } else if ([NSProcessInfo.processInfo.arguments containsObject:@"--library"]) {
        [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
        [self authenticateLibrary:nil];
      } else {
        [self openReadyLibrary:nil];
      }
    });
  }];
}

- (void)confirmEncryptedCandidateForSequence:(NSUInteger)sequence
                   continueToRequestedSurface:(BOOL)continueToRequestedSurface {
  [self setRecoveryBusy:YES status:@"Verifying encrypted vault state…"];
  [self.broker requestMethod:@"lifecycle.status" params:@{}
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (sequence != self.recoveryStatusRequestSequence) return;
      if (error != nil || !AfternoteBrokerResultIsValid(@"lifecycle.status", result, @{})) {
        self.recoveryErrorMessage = error != nil
            ? StringValue(error[@"message"], @"Encrypted vault could not be verified.")
            : @"The broker returned an invalid lifecycle status.";
        [self enterNonReadyRecoveryState:@"unavailable"
                                  status:@"Encrypted vault could not be verified"
                                 message:@"Encrypted vault verification failed. Plaintext and local authority were cleared."];
        return;
      }
      self.recoveryState = @"ready";
      [self setPrivilegedSurfacesReady:YES];
      self.vaultLocked = ![result[@"state"] isEqualToString:@"unlocked"];
      self.vaultStatusCheckInFlight = NO;
      [self updateVaultAccessButton];
      self.libraryAuthenticateButton.title = self.vaultLocked
          ? @"Unlock vault" : @"Authenticate & Open";
      [self setRecoveryBusy:NO status:@"Vault ready"];
      [self renderRecoveryState];
      if (!continueToRequestedSurface) return;
      if (self.vaultLocked) {
        [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
        [self setLibraryBusy:NO status:LockedLibraryMessage()];
      } else if ([NSProcessInfo.processInfo.arguments containsObject:@"--connections"]) {
        [self displaySurface:AfternoteProductSurfaceConnections recoveryReady:YES];
        [self authenticate:nil];
      } else if ([NSProcessInfo.processInfo.arguments containsObject:@"--library"]) {
        [self openReadyLibrary:nil];
      } else {
        [self openReadyLibrary:nil];
      }
    });
  }];
}

- (void)openReadyLibrary:(id)sender {
  (void)sender;
  [self setPrivilegedSurfacesReady:YES];
  [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
  [self authenticateLibrary:nil];
}

- (void)createEmptyVault:(id)sender {
  (void)sender;
  self.recoveryState = @"ready";
  [self setPrivilegedSurfacesReady:YES];
  [self openReadyLibrary:nil];
}

- (void)beginSafeMigration:(id)sender {
  if (self.recoveryOperationInFlight) return;
  self.recoveryOperationInFlight = YES;
  NSUInteger operationSequence = ++self.recoveryOperationSequence;
  self.recoveryErrorMessage = nil;
  [(NSButton *)sender setEnabled:NO];
  [self setRecoveryBusy:YES status:@"Waiting for owner approval to encrypt the vault…"];
  [self.broker requestMethod:@"recovery.migrate"
                      params:@{
                        @"liveAction" : @"keep",
                        @"liveDestination" : NSNull.null,
                        @"artifactAction" : @"keep",
                        @"artifactDestinationDirectory" : NSNull.null,
                      }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (operationSequence != self.recoveryOperationSequence) return;
      self.recoveryOperationInFlight = NO;
      if (error != nil) {
        self.recoveryErrorMessage = StringValue(
          error[@"message"], @"Migration did not complete.");
        [self refreshRecoveryStatusAndContinue:NO];
        return;
      }
      (void)result;
      [self refreshRecoveryStatusAndContinue:NO];
    });
  }];
}

- (void)chooseRestoreBackup:(id)sender {
  (void)sender;
  if (self.recoveryOperationInFlight) return;
  self.recoveryOperationInFlight = YES;
  NSUInteger operationSequence = ++self.recoveryOperationSequence;
  self.recoveryErrorMessage = nil;
  [self setRecoveryBusy:YES status:@"Choose the exact Afternote export…"];
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = YES;
  panel.canChooseDirectories = NO;
  panel.allowsMultipleSelection = NO;
  panel.resolvesAliases = NO;
  panel.title = @"Choose an Afternote export";
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    if (operationSequence != self.recoveryOperationSequence) return;
    if (response != NSModalResponseOK || panel.URL == nil || !panel.URL.isFileURL) {
      self.recoveryOperationInFlight = NO;
      [self setRecoveryBusy:NO status:@"Restore cancelled. No vault changes were made."];
      [self renderRecoveryState];
      return;
    }
    [self setRecoveryBusy:YES status:@"Waiting for owner approval to restore the export…"];
    [self.broker requestMethod:@"recovery.restore"
                        params:@{ @"source" : panel.URL.path }
                         reply:^(NSDictionary *result, NSDictionary *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (operationSequence != self.recoveryOperationSequence) return;
        self.recoveryOperationInFlight = NO;
        if (error != nil) {
          self.recoveryErrorMessage = StringValue(
            error[@"message"], @"Restore did not complete.");
          [self refreshRecoveryStatusAndContinue:NO];
          return;
        }
        (void)result;
        [self refreshRecoveryStatusAndContinue:NO];
      });
    }];
  }];
}

- (void)setLibraryBusy:(BOOL)busy status:(NSString *)status {
  void (^apply)(void) = ^{
    BOOL controlsBusy = busy || self.libraryMutationInFlight;
    self.libraryAuthenticateButton.enabled = !controlsBusy;
    self.libraryAuthenticateButton.hidden = !self.vaultLocked && self.libraryExpiresAt.length > 0;
    // Retrieval may disable submission, but it never takes the draft away from the typist.
    self.librarySearch.enabled = self.libraryExpiresAt.length > 0;
    self.askButton.enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
    self.noteTable.enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
    self.loadMoreNotesButton.enabled = !controlsBusy && self.notesRetrieval.cursor != nil;
    self.libraryRecentButton.enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
    self.createNoteButton.enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
    self.libraryRefreshButton.enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
    for (NSView *view in self.libraryViews.arrangedSubviews) {
      if ([view isKindOfClass:[NSButton class]]) {
        ((NSButton *)view).enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
      }
    }
    [self.noteEditorView setBusy:controlsBusy authenticated:self.libraryExpiresAt.length > 0];
    self.libraryStatusLabel.stringValue = status;
    self.libraryProgress.hidden = !controlsBusy;
    if (controlsBusy) [self.libraryProgress startAnimation:nil];
    else [self.libraryProgress stopAnimation:nil];
  };
  if (NSThread.isMainThread) apply();
  else dispatch_async(dispatch_get_main_queue(), apply);
}

- (void)showLibraryMode:(AfternoteLibraryMode)mode loadBrowse:(BOOL)loadBrowse {
  BOOL retrievalWasPending = self.notesRetrieval.inFlight;
  [self.notesRetrieval cancelPendingRequest];
  if (retrievalWasPending) {
    NSString *status = self.libraryExpiresAt.length > 0
        ? [NSString stringWithFormat:@"Authenticated until %@", DateLabel(self.libraryExpiresAt)]
        : @"Authenticate to open Notes.";
    [self setLibraryBusy:NO status:status];
  }
  AfternoteLibraryMode normalizedMode = MAX(AfternoteLibraryModeWrite,
      MIN(AfternoteLibraryModeBrowse, mode));
  self.libraryModeSelector.selectedSegment = normalizedMode;
  self.libraryRefreshButton.hidden = normalizedMode == AfternoteLibraryModeWrite;
  if (normalizedMode == AfternoteLibraryModeWrite) {
    [self.libraryWorkspaceTabs selectTabViewItemAtIndex:0];
    [self updateSetupBannerVisibility];
    return;
  }
  [self.libraryWorkspaceTabs selectTabViewItemAtIndex:1];
  BOOL refreshPending = self.libraryRefreshPending &&
      self.libraryExpiresAt.length > 0 && self.broker != nil;
  self.libraryRefreshPending = NO;
  BOOL asking = normalizedMode == AfternoteLibraryModeAsk;
  self.askControls.hidden = NO;
  self.browseControls.hidden = asking || !self.hasVisibleSmartCategories;
  self.clearSearchButton.hidden = !asking && self.librarySearch.stringValue.length == 0;
  if (asking) {
    self.libraryWorkspaceTitle.stringValue = @"Notes";
    self.libraryWorkspaceSubtitle.stringValue = @"Results from your saved notes.";
    NSUInteger matchCount = self.notesRetrieval.notes.count;
    self.resultsHeadingLabel.stringValue = self.notesRetrieval.query.length == 0
        ? @"Finding results…"
        : matchCount == 0
          ? @"No results"
          : [NSString stringWithFormat:@"Results · %lu", (unsigned long)matchCount];
    [self.noteTable reloadData];
    [self updateSetupBannerVisibility];
    if (refreshPending) [self loadLibraryNotes:NO];
    return;
  }
  self.libraryWorkspaceTitle.stringValue = @"Notes";
  self.libraryWorkspaceSubtitle.stringValue = @"Your local notes.";
  self.resultsHeadingLabel.stringValue = @"Recent notes";
  if (self.notesRetrieval.query.length > 0) {
    [self.notesRetrieval selectQuery:@"" view:self.notesRetrieval.view];
    self.librarySearch.stringValue = @"";
    [self updateSearchComposerHeight];
  }
  self.clearSearchButton.hidden = self.librarySearch.stringValue.length == 0;
  if (loadBrowse) {
    [self.notesRetrieval selectQuery:@"" view:self.notesRetrieval.view];
    self.loadMoreNotesButton.hidden = YES;
  }
  [self.noteTable reloadData];
  [self updateSetupBannerVisibility];
  if ((loadBrowse || refreshPending) && self.libraryExpiresAt.length > 0 && self.broker != nil) {
    [self loadLibraryNotes:NO];
  }
}

- (void)switchLibraryMode:(NSSegmentedControl *)sender {
  AfternoteLibraryMode mode = (AfternoteLibraryMode)sender.selectedSegment;
  if (mode == AfternoteLibraryModeWrite && self.activeNote == nil && !self.creatingNote) {
    [self beginNewNote:sender];
    return;
  }
  [self showLibraryMode:mode loadBrowse:YES];
}

- (void)authenticateLibrary:(id)sender {
  (void)sender;
  if (self.vaultLocked) {
    [self unlockVaultAndOpenLibrary];
    return;
  }
  [self clearLibraryPlaintext:OwnerApprovalWaitMessage()];
  NSUInteger generation = self.librarySessionGeneration;
  [self setLibraryBusy:YES status:OwnerApprovalWaitMessage()];
  NSArray *scopes = @[
    @"library.browse", @"library.search", @"library.get_note",
    @"library.list_revisions", @"library.inspect_source",
    @"library.remember", @"library.update_note"
  ];
  [self.broker requestMethod:@"library.session.begin"
                      params:@{ @"requestedScopes" : scopes,
                                @"ttlMs" : @(RoutineAuthenticationTtlMilliseconds()) }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration) return;
      if (error != nil) {
        [self showLibraryError:error];
        return;
      }
      self.vaultLocked = NO;
      self.vaultStatusCheckInFlight = NO;
      [self updateVaultAccessButton];
      self.libraryAuthenticateButton.title = @"Authenticate & Open";
      self.libraryExpiresAt = StringValue(result[@"expiresAt"]);
      [self applySearchMode:StringValue(result[@"searchMode"], @"exact")];
      NSString *expectedExpiry = self.libraryExpiresAt;
      NSDate *expiry = DateValue(expectedExpiry);
      NSTimeInterval delay = expiry == nil ? 0 : MAX(0, [expiry timeIntervalSinceNow]);
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((delay + 0.05) * NSEC_PER_SEC)),
                     dispatch_get_main_queue(), ^{
        if (generation == self.librarySessionGeneration &&
            [self.libraryExpiresAt isEqualToString:expectedExpiry]) {
          [self clearLibraryPlaintext:@"The Notes session ended. Plaintext was cleared; authenticate again."];
        }
      });
      [self loadLibraryViewsAndNotes];
      [self.semanticSettings refresh];
    });
  }];
}

- (void)unlockVaultAndOpenLibrary {
  [self clearLibraryPlaintext:@"Waiting for owner approval to unlock the vault…"];
  [self setLibraryBusy:YES status:@"Waiting for owner approval to unlock the vault…"];
  [self.broker requestLifecycleTransitionMethod:@"lifecycle.unlock"
                                          reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error != nil || !AfternoteBrokerResultIsValid(@"lifecycle.unlock", result, @{})) {
        [self showLibraryError:error ?: @{
          @"code" : @"invalid_response",
          @"message" : @"The broker returned an invalid unlock response."
        }];
        return;
      }
      self.vaultLocked = NO;
      self.vaultStatusCheckInFlight = NO;
      [self updateVaultAccessButton];
      self.libraryAuthenticateButton.title = @"Authenticate & Open";
      [self refreshRecoveryStatusAndContinue:YES];
    });
  }];
}

- (void)loadLibraryViewsAndNotes {
  NSUInteger generation = self.librarySessionGeneration;
  [self setLibraryBusy:YES status:@"Reading local memory…"];
  [self.broker requestMethod:@"library.views" params:@{} reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration) return;
      if (error != nil) {
        [self showLibraryError:error];
        return;
      }
      [self renderLibraryViews:ArrayValue(result[@"views"])];
      if (self.libraryModeSelector.selectedSegment == AfternoteLibraryModeBrowse) {
        [self loadLibraryNotes:NO];
      } else {
        [self setLibraryBusy:NO status:[NSString stringWithFormat:@"Authenticated until %@",
                                                                 DateLabel(self.libraryExpiresAt)]];
      }
    });
  }];
}

- (void)renderLibraryViews:(NSArray *)views {
  for (NSView *view in [self.libraryViews.arrangedSubviews copy]) {
    [self.libraryViews removeArrangedSubview:view];
    [view removeFromSuperview];
  }
  NSUInteger visibleCount = 0;
  for (NSDictionary *view in views) {
    if ([view[@"noteCount"] unsignedIntegerValue] == 0) continue;
    NSString *label = [NSString stringWithFormat:@"%@  %@",
                       StringValue(view[@"label"], @"View"), view[@"noteCount"] ?: @0];
    NSButton *button = [NSButton buttonWithTitle:label target:self action:@selector(selectLibraryView:)];
    button.identifier = StringValue(view[@"id"]);
    [self styleNavigationButton:button selected:[button.identifier isEqualToString:self.notesRetrieval.view ?: @""]];
    button.accessibilityLabel = [NSString stringWithFormat:@"%@ smart view, %@ notes",
                                 StringValue(view[@"label"]), view[@"noteCount"] ?: @0];
    [self.libraryViews addArrangedSubview:button];
    [button.heightAnchor constraintEqualToConstant:34].active = YES;
    visibleCount += 1;
  }
  self.hasVisibleSmartCategories = visibleCount > 0;
  self.browseControls.hidden = !self.hasVisibleSmartCategories ||
      self.libraryModeSelector.selectedSegment == AfternoteLibraryModeAsk;
}

- (void)selectLibraryView:(NSButton *)sender {
  self.libraryNoteRequestSequence += 1;
  self.libraryRevisionRequestSequence += 1;
  [self.notesRetrieval selectQuery:@"" view:sender.identifier];
  self.librarySearch.stringValue = @"";
  [self styleNavigationButton:self.libraryRecentButton selected:self.notesRetrieval.view == nil];
  for (NSButton *button in self.libraryViews.arrangedSubviews) {
    if (![button isKindOfClass:[NSButton class]]) continue;
    [self styleNavigationButton:button selected:[button.identifier isEqualToString:self.notesRetrieval.view ?: @""]];
  }
  [self showLibraryMode:AfternoteLibraryModeBrowse loadBrowse:NO];
  [self loadLibraryNotes:NO];
}

- (void)controlTextDidBeginEditing:(NSNotification *)notification {
  if (notification.object == self.librarySearch) self.askComposer.afternoteFocused = YES;
}

- (void)controlTextDidChange:(NSNotification *)notification {
  if (notification.object != self.librarySearch) return;
  [self updateSearchComposerHeight];
  NSString *draft = [self.librarySearch.stringValue
      stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  self.clearSearchButton.hidden = self.notesRetrieval.query.length == 0 && draft.length == 0;
}

- (void)controlTextDidEndEditing:(NSNotification *)notification {
  if (notification.object == self.librarySearch) self.askComposer.afternoteFocused = NO;
}

- (BOOL)control:(NSControl *)control
        textView:(NSTextView *)textView
doCommandBySelector:(SEL)commandSelector {
  if (control != self.librarySearch || commandSelector != @selector(insertNewline:)) return NO;
  NSEventModifierFlags modifiers = NSApp.currentEvent.modifierFlags;
  if ((modifiers & NSEventModifierFlagShift) != 0) {
    [textView insertNewlineIgnoringFieldEditor:nil];
    dispatch_async(dispatch_get_main_queue(), ^{ [self updateSearchComposerHeight]; });
    return YES;
  }
  [self searchLibrary:self.librarySearch];
  return YES;
}

- (void)updateSearchComposerHeight {
  if (self.librarySearch == nil || self.askComposerHeightConstraint == nil ||
      self.searchFieldHeightConstraint == nil) return;
  CGFloat availableWidth = self.librarySearch.bounds.size.width;
  if (availableWidth < 220) availableWidth = 620;
  NSString *text = self.librarySearch.stringValue.length > 0
      ? self.librarySearch.stringValue
      : @"Search anything you've written down";
  NSRect measured = [text boundingRectWithSize:NSMakeSize(availableWidth, CGFLOAT_MAX)
                                       options:NSStringDrawingUsesLineFragmentOrigin |
                                               NSStringDrawingUsesFontLeading
                                    attributes:@{
                                      NSFontAttributeName : self.librarySearch.font ?: [NSFont systemFontOfSize:16]
                                    }];
  CGFloat fieldHeight = MIN(kAskFieldMaximumHeight,
      MAX(kAskFieldHeight, ceil(measured.size.height) + 2));
  self.searchFieldHeightConstraint.constant = fieldHeight;
  self.askComposerHeightConstraint.constant = MIN(kAskComposerMaximumHeight,
      kAskComposerHeight + fieldHeight - kAskFieldHeight);
  [self.askComposer.superview layoutSubtreeIfNeeded];
}

- (void)clearSearch:(id)sender {
  (void)sender;
  [self.notesRetrieval selectQuery:@"" view:self.notesRetrieval.view];
  self.librarySearch.stringValue = @"";
  [self updateSearchComposerHeight];
  self.clearSearchButton.hidden = YES;
  [self showLibraryMode:AfternoteLibraryModeBrowse loadBrowse:YES];
  [self.librarySearch.window makeFirstResponder:self.librarySearch];
}

- (void)refreshVisibleLibraryNotes:(id)sender {
  (void)sender;
  if (self.libraryExpiresAt.length == 0 || self.vaultLocked ||
      self.libraryMutationInFlight || self.notesRetrieval.inFlight ||
      self.libraryModeSelector.selectedSegment == AfternoteLibraryModeWrite) return;
  [self loadLibraryNotes:NO];
}

- (void)searchLibrary:(id)sender {
  (void)sender;
  self.libraryNoteRequestSequence += 1;
  self.libraryRevisionRequestSequence += 1;
  [self.notesRetrieval selectQuery:self.librarySearch.stringValue view:nil];
  if (self.notesRetrieval.query.length == 0) {
    [self clearSearch:nil];
    return;
  }
  [self showLibraryMode:AfternoteLibraryModeAsk loadBrowse:NO];
  self.clearSearchButton.hidden = NO;
  self.resultsHeadingLabel.stringValue = @"Finding results…";
  [self loadLibraryNotes:NO];
}

- (void)loadLibraryNotes:(BOOL)append {
  if (self.libraryExpiresAt.length == 0 || self.vaultLocked || self.broker == nil) return;
  NSUInteger generation = self.librarySessionGeneration;
  AfternoteNotesRequest *request = [self.notesRetrieval beginAppending:append];
  if (request == nil) return;
  if (!append) [self.noteTable reloadData];
  BOOL searching = self.notesRetrieval.query.length > 0;
  [self setLibraryBusy:YES status:searching ? @"Searching without logging the query…" : @"Loading notes…"];
  [self.broker requestMethod:request.method params:request.params reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration ||
          ![self.notesRetrieval complete:request result:result error:error]) return;
      if (error != nil) {
        [self showLibraryError:error];
        return;
      }
      if (searching) [self applySearchMode:self.notesRetrieval.searchMode];
      else if ([@[@"hybrid", @"indexing"] containsObject:self.currentSearchMode])
        [self refreshSemanticSearch:NO userInitiated:NO];
      self.loadMoreNotesButton.hidden = self.notesRetrieval.cursor == nil;
      [self.noteTable reloadData];
      NSUInteger count = self.notesRetrieval.notes.count;
      self.resultsHeadingLabel.stringValue = count == 0
          ? (searching ? @"No results" : @"No notes yet")
          : (searching ? [NSString stringWithFormat:@"Results · %lu", (unsigned long)count] : @"Recent notes");
      NSString *status = count == 0
          ? (searching ? @"No search results" : @"No notes yet")
          : [NSString stringWithFormat:@"%lu %@%@ loaded · authenticated until %@",
             (unsigned long)count, searching ? @"match" : @"note", count == 1 ? @"" : @"s",
             DateLabel(self.libraryExpiresAt)];
      [self setLibraryBusy:NO status:status];
    });
  }];
}

- (void)showUpdateConflictForNoteId:(NSString *)noteId
                              draft:(NSString *)draft
                         generation:(NSUInteger)generation {
  NSUInteger requestSequence = ++self.libraryNoteRequestSequence;
  [self setLibraryBusy:YES status:@"Loading the newer revision without discarding your draft…"];
  [self.broker requestMethod:@"library.get_note"
                      params:@{ @"id" : noteId, @"revision" : NSNull.null }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration ||
          requestSequence != self.libraryNoteRequestSequence ||
          ![StringValue(self.activeNote[@"id"]) isEqualToString:noteId]) return;
      if (error != nil) {
        [self showLibraryError:error];
        return;
      }
      NSDictionary *latest = [result[@"note"] isKindOfClass:[NSDictionary class]] ? result[@"note"] : nil;
      if (latest == nil) {
        [self setLibraryBusy:NO status:@"The note was removed elsewhere. Your draft remains visible until you leave this view."];
        return;
      }
      self.activeNote = latest;
      self.activeDeleteTarget = StringValue(result[@"deleteTarget"]);
      [self loadRevisionHistory:NO];

      NSTextView *comparison = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 520, 220)];
      comparison.editable = NO;
      comparison.selectable = YES;
      comparison.font = [NSFont systemFontOfSize:12];
      comparison.string = [NSString stringWithFormat:
          @"LATEST SAVED REVISION %@\n\n%@\n\nYOUR UNSAVED DRAFT\n\n%@",
          latest[@"revision"] ?: @0, StringValue(latest[@"content"]), draft];
      comparison.accessibilityLabel = @"Latest saved revision and unsaved draft comparison";
      NSScrollView *comparisonScroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 520, 220)];
      comparisonScroll.documentView = comparison;
      comparisonScroll.hasVerticalScroller = YES;
      comparisonScroll.borderType = NSBezelBorder;

      NSAlert *alert = [[NSAlert alloc] init];
      alert.alertStyle = NSAlertStyleWarning;
      alert.messageText = @"This note has a newer revision";
      alert.informativeText = @"Compare the latest saved text with your draft. Keeping the draft rebases the next save on the latest revision; using latest replaces the editor.";
      alert.accessoryView = comparisonScroll;
      [alert addButtonWithTitle:@"Keep draft and retry"];
      [alert addButtonWithTitle:@"Use latest"];
      self.librarySensitiveAlert = alert;
      self.librarySensitiveTextView = comparison;
      [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        self.librarySensitiveAlert = nil;
        self.librarySensitiveTextView = nil;
        if (generation != self.librarySessionGeneration ||
            ![StringValue(self.activeNote[@"id"]) isEqualToString:noteId]) return;
        [self renderActiveNote];
        if (response == NSAlertFirstButtonReturn) {
          [self.noteEditorView restoreDraft:draft];
          [self setLibraryBusy:NO status:[NSString stringWithFormat:
              @"Draft preserved against revision %@. Review it, then Save to create the next revision.",
              latest[@"revision"] ?: @0]];
        } else {
          [self setLibraryBusy:NO status:@"Loaded the latest saved revision."];
        }
      }];
    });
  }];
}

- (void)loadMoreNotes:(NSButton *)sender {
  sender.enabled = NO;
  [self loadLibraryNotes:YES];
}

- (NSInteger)numberOfRowsInTableView:(NSTableView *)tableView {
  return tableView == self.noteTable ? self.notesRetrieval.notes.count : 0;
}

- (NSTableRowView *)tableView:(NSTableView *)tableView rowViewForRow:(NSInteger)row {
  (void)row;
  return tableView == self.noteTable ? [[AfternoteTableRowView alloc] init] : nil;
}

- (CGFloat)tableView:(NSTableView *)tableView heightOfRow:(NSInteger)row {
  if (tableView != self.noteTable || row < 0 || row >= (NSInteger)self.notesRetrieval.notes.count) {
    return tableView.rowHeight;
  }
  NSDictionary *summary = self.notesRetrieval.notes[(NSUInteger)row];
  BOOL searchResult = self.libraryModeSelector.selectedSegment == AfternoteLibraryModeAsk &&
      [StringValue(summary[kLibraryResultKindKey]) isEqualToString:kLibrarySearchResultKind];
  if (searchResult) return 112;
  NSString *day = DayLabel(summary[@"createdAt"] ?: summary[@"updatedAt"]);
  BOOL beginsDay = row == 0;
  if (!beginsDay) {
    NSDictionary *previous = self.notesRetrieval.notes[(NSUInteger)row - 1];
    beginsDay = ![DayLabel(previous[@"createdAt"] ?: previous[@"updatedAt"])
        isEqualToString:day];
  }
  return beginsDay ? 128 : 104;
}

- (NSView *)tableView:(NSTableView *)tableView
   viewForTableColumn:(NSTableColumn *)tableColumn
                  row:(NSInteger)row {
  (void)tableColumn;
  if (tableView != self.noteTable || row < 0 || row >= (NSInteger)self.notesRetrieval.notes.count) return nil;
  NSDictionary *summary = self.notesRetrieval.notes[(NSUInteger)row];
  NSTableCellView *cell = [tableView makeViewWithIdentifier:@"LibraryNoteCell" owner:self];
  if (cell == nil) {
    cell = [[NSTableCellView alloc] init];
    cell.identifier = @"LibraryNoteCell";
    NSTextField *text = [self label:@"" size:16 weight:NSFontWeightRegular];
    text.identifier = @"VisibleNoteExcerpt";
    text.maximumNumberOfLines = 3;
    text.lineBreakMode = NSLineBreakByWordWrapping;
    text.cell.wraps = YES;
    text.cell.scrollable = NO;
    text.cell.usesSingleLineMode = NO;
    NSTextField *dayHeading = [self label:@"" size:11 weight:NSFontWeightSemibold];
    dayHeading.identifier = @"VisibleNoteDay";
    dayHeading.textColor = AfternoteTextColor();
    NSTextField *context = [self label:@"" size:10 weight:NSFontWeightSemibold];
    context.identifier = @"VisibleNoteContext";
    context.font = [NSFont monospacedSystemFontOfSize:10 weight:NSFontWeightSemibold];
    context.textColor = AfternoteMutedTextColor();
    NSStackView *content = [NSStackView stackViewWithViews:@[ dayHeading, context, text ]];
    content.identifier = @"VisibleNoteContent";
    content.orientation = NSUserInterfaceLayoutOrientationVertical;
    content.alignment = NSLayoutAttributeLeading;
    content.spacing = 7;
    content.translatesAutoresizingMaskIntoConstraints = NO;
    cell.textField = text;
    [cell addSubview:content];
    [NSLayoutConstraint activateConstraints:@[
      [content.leadingAnchor constraintEqualToAnchor:cell.leadingAnchor constant:8],
      [content.trailingAnchor constraintEqualToAnchor:cell.trailingAnchor constant:-8],
      [content.topAnchor constraintEqualToAnchor:cell.topAnchor constant:14],
      [content.bottomAnchor constraintLessThanOrEqualToAnchor:cell.bottomAnchor constant:-14],
      [dayHeading.trailingAnchor constraintLessThanOrEqualToAnchor:content.trailingAnchor],
      [context.trailingAnchor constraintLessThanOrEqualToAnchor:content.trailingAnchor],
      [text.trailingAnchor constraintEqualToAnchor:content.trailingAnchor],
    ]];
  }
  NSTextField *context = nil;
  NSTextField *dayHeading = nil;
  for (NSView *subview in cell.subviews) {
    if ([subview.identifier isEqualToString:@"VisibleNoteContent"] &&
               [subview isKindOfClass:[NSStackView class]]) {
      for (NSView *contentSubview in ((NSStackView *)subview).arrangedSubviews) {
        if ([contentSubview.identifier isEqualToString:@"VisibleNoteContext"]) {
          context = (NSTextField *)contentSubview;
        } else if ([contentSubview.identifier isEqualToString:@"VisibleNoteDay"]) {
          dayHeading = (NSTextField *)contentSubview;
        }
      }
    }
  }
  BOOL searchResult = self.libraryModeSelector.selectedSegment == AfternoteLibraryModeAsk &&
      [StringValue(summary[kLibraryResultKindKey]) isEqualToString:kLibrarySearchResultKind];
  NSDictionary *source = [summary[@"source"] isKindOfClass:[NSDictionary class]]
      ? summary[@"source"] : @{};
  NSString *sourceName = StringValue(source[@"label"], StringValue(source[@"application"], @"Afternote"));
  NSString *capturedAt = TimeLabel(summary[@"createdAt"] ?: summary[@"updatedAt"]);
  NSString *day = DayLabel(summary[@"createdAt"] ?: summary[@"updatedAt"]);
  BOOL beginsDay = row == 0;
  if (!beginsDay) {
    NSDictionary *previous = self.notesRetrieval.notes[(NSUInteger)row - 1];
    beginsDay = ![DayLabel(previous[@"createdAt"] ?: previous[@"updatedAt"]) isEqualToString:day];
  }
  NSNumber *revisionNumber = [summary[@"revision"] isKindOfClass:[NSNumber class]]
      ? summary[@"revision"] : @0;
  NSInteger revision = revisionNumber.integerValue;
  BOOL defaultSource = [sourceName caseInsensitiveCompare:@"Afternote"] == NSOrderedSame;
  NSMutableArray<NSString *> *metadata = [NSMutableArray arrayWithObject:capturedAt];
  if (!defaultSource) [metadata addObject:sourceName];
  if (revision > 1) {
    [metadata addObject:[NSString stringWithFormat:@"%ld revisions", (long)revision]];
  }
  dayHeading.stringValue = day;
  dayHeading.hidden = searchResult || !beginsDay;
  context.stringValue = searchResult
      ? [NSString stringWithFormat:@"RESULT  ·  %@  ·  R%@  ·  OPEN NOTE",
                                   sourceName, revisionNumber]
      : [metadata componentsJoinedByString:@"  ·  "];
  cell.textField.stringValue = StringValue(summary[@"excerpt"], @"Untitled note");
  cell.textField.preferredMaxLayoutWidth = MAX(240, tableView.bounds.size.width - 16);
  [cell.textField invalidateIntrinsicContentSize];
  [cell setNeedsLayout:YES];
  cell.accessibilityLabel = searchResult
      ? [NSString stringWithFormat:@"Search result from revision %@. Open note: %@",
                                   summary[@"revision"] ?: @0,
                                   cell.textField.stringValue]
      : [NSString stringWithFormat:@"Note: %@", cell.textField.stringValue];
  return cell;
}

- (void)tableViewSelectionDidChange:(NSNotification *)notification {
  if (notification.object != self.noteTable) return;
  NSInteger row = self.noteTable.selectedRow;
  if (row < 0 || row >= (NSInteger)self.notesRetrieval.notes.count) return;
  NSDictionary *summary = self.notesRetrieval.notes[(NSUInteger)row];
  BOOL searchResult = [StringValue(summary[kLibraryResultKindKey])
      isEqualToString:kLibrarySearchResultKind];
  self.inspectingCitation = searchResult;
  [self openNoteId:StringValue(summary[@"id"])
           revision:searchResult ? summary[@"revision"] : nil];
}

- (void)openNoteId:(NSString *)noteId revision:(NSNumber *)revision {
  if (noteId.length == 0) return;
  BOOL showSavedStateAfterOpen = self.editorSaveConfirmationPending && revision == nil;
  self.editorSaveConfirmationPending = NO;
  [self.noteEditorView setSaveState:AfternoteEditorSaveStateDefault animated:NO];
  BOOL changingNote = ![StringValue(self.activeNote[@"id"]) isEqualToString:noteId];
  if (changingNote) {
    self.activeNote = nil;
    self.activeDeleteTarget = nil;
    self.revisionSummaries = @[];
    self.revisionCursor = nil;
    self.revisionHistoryLoaded = NO;
    [self renderActiveNote];
    [self renderRevisionMenu];
  }
  NSUInteger generation = self.librarySessionGeneration;
  NSUInteger requestSequence = ++self.libraryNoteRequestSequence;
  self.libraryRevisionRequestSequence += 1;
  [self setLibraryBusy:YES status:revision == nil ? @"Opening note…" : @"Opening historical revision…"];
  [self.broker requestMethod:@"library.get_note"
                      params:@{ @"id" : noteId, @"revision" : revision ?: NSNull.null }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration ||
          requestSequence != self.libraryNoteRequestSequence) return;
      if (error != nil) {
        [self showLibraryError:error];
        return;
      }
      NSDictionary *note = [result[@"note"] isKindOfClass:[NSDictionary class]] ? result[@"note"] : nil;
      if (note == nil) {
        [self loadLibraryNotes:NO];
        return;
      }
      self.activeNote = note;
      self.activeDeleteTarget = StringValue(result[@"deleteTarget"]);
      self.creatingNote = NO;
      [self renderActiveNote];
      [self showLibraryMode:AfternoteLibraryModeWrite loadBrowse:NO];
      if (showSavedStateAfterOpen) {
        [self.noteEditorView setSaveState:AfternoteEditorSaveStateSaved animated:YES];
      }
      if (revision == nil || self.inspectingCitation) [self loadRevisionHistory:NO];
      [self setLibraryBusy:NO status:[NSString stringWithFormat:@"Authenticated until %@", DateLabel(self.libraryExpiresAt)]];
    });
  }];
}

- (void)loadRevisionHistory:(BOOL)append {
  NSUInteger generation = self.librarySessionGeneration;
  NSUInteger requestSequence = ++self.libraryRevisionRequestSequence;
  NSString *noteId = ActiveNoteIdentifier(self.activeNote);
  if (noteId.length == 0) return;
  NSString *cursor = append ? self.revisionCursor : nil;
  [self.broker requestMethod:@"library.list_revisions"
                      params:@{ @"id" : noteId, @"limit" : @20,
                                @"cursor" : cursor ?: NSNull.null }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration ||
          requestSequence != self.libraryRevisionRequestSequence ||
          ![ActiveNoteIdentifier(self.activeNote) isEqualToString:noteId]) return;
      if (error != nil) {
        [self showLibraryError:error];
        return;
      }
      NSArray *loaded = ArrayValue(result[@"revisions"]);
      if (append) {
        NSMutableArray *combined = [self.revisionSummaries mutableCopy];
        NSMutableSet *seen = [NSMutableSet set];
        for (NSDictionary *revision in combined) {
          [seen addObject:revision[@"revision"] ?: @0];
        }
        for (NSDictionary *revision in loaded) {
          id number = revision[@"revision"] ?: @0;
          if (![seen containsObject:number]) {
            [combined addObject:revision];
            [seen addObject:number];
          }
        }
        self.revisionSummaries = combined;
      } else {
        self.revisionSummaries = loaded;
      }
      id cursor = result[@"nextCursor"];
      self.revisionCursor = [cursor isKindOfClass:[NSString class]] ? cursor : nil;
      self.revisionHistoryLoaded = YES;
      [self renderRevisionMenu];
      [self.noteEditorView setBusy:self.libraryMutationInFlight
                    authenticated:self.libraryExpiresAt.length > 0];
    });
  }];
}

- (void)selectEditorRevision:(NSDictionary *)revision {
  if ([revision[@"loadMore"] boolValue]) {
    [self loadRevisionHistory:YES];
    return;
  }
  if (revision == nil) {
    self.inspectingCitation = NO;
    NSString *noteId = ActiveNoteIdentifier(self.activeNote);
    if (noteId.length == 0) {
      NSInteger row = self.noteTable.selectedRow;
      if (row >= 0 && row < (NSInteger)self.notesRetrieval.notes.count) {
        noteId = StringValue(self.notesRetrieval.notes[(NSUInteger)row][@"id"]);
      }
    }
    if (noteId.length > 0) [self openNoteId:noteId revision:nil];
    return;
  }
  self.inspectingCitation = YES;
  [self openNoteId:StringValue(revision[@"noteId"]) revision:revision[@"revision"]];
}

- (void)renderActiveNote {
  [self.noteEditorView displayNote:self.activeNote creating:self.creatingNote
               inspectingCitation:self.inspectingCitation];
}

- (void)renderRevisionMenu {
  [self.noteEditorView setHistory:self.revisionSummaries ?: @[]
                       hasMore:self.revisionCursor != nil loaded:self.revisionHistoryLoaded];
}

- (void)editCurrentNote:(id)sender {
  (void)sender;
  NSString *noteId = ActiveNoteIdentifier(self.activeNote);
  if (noteId.length == 0) return;
  self.inspectingCitation = NO;
  [self openNoteId:noteId revision:nil];
}

- (void)beginNewNote:(id)sender {
  (void)sender;
  self.editorSaveConfirmationPending = NO;
  [self.noteEditorView setSaveState:AfternoteEditorSaveStateDefault animated:NO];
  self.libraryNoteRequestSequence += 1;
  self.libraryRevisionRequestSequence += 1;
  self.creatingNote = YES;
  self.inspectingCitation = NO;
  self.revisionHistoryLoaded = NO;
  self.activeNote = @{ @"content" : @"" };
  self.activeDeleteTarget = nil;
  self.revisionSummaries = @[];
  [self.noteTable deselectAll:nil];
  [self renderActiveNote];
  [self showLibraryMode:AfternoteLibraryModeWrite loadBrowse:NO];
  [self.noteEditorView focusDraft];
}

- (void)discardEditorChanges:(id)sender {
  (void)sender;
  if (![self.noteEditorView discardChanges]) return;
  [self setLibraryBusy:NO status:self.creatingNote
      ? @"Draft cleared."
      : @"Changes discarded. The saved revision is unchanged."];
  [self.noteEditorView focusDraft];
}

- (void)returnToMemory:(id)sender {
  (void)sender;
  BOOL hasUnsavedChanges = self.noteEditorView.hasUnsavedChanges;
  void (^finish)(void) = ^{
    if (self.creatingNote) {
      self.creatingNote = NO;
      self.activeNote = nil;
      self.activeDeleteTarget = nil;
      self.revisionSummaries = @[];
    }
    [self renderActiveNote];
    AfternoteLibraryMode destination = self.notesRetrieval.query.length > 0
        ? AfternoteLibraryModeAsk
        : AfternoteLibraryModeBrowse;
    [self showLibraryMode:destination loadBrowse:NO];
  };
  if (!hasUnsavedChanges) {
    finish();
    return;
  }
  NSAlert *alert = [[NSAlert alloc] init];
  alert.alertStyle = NSAlertStyleWarning;
  alert.messageText = self.creatingNote
      ? @"Discard this new memory?"
      : @"Discard unsaved changes?";
  alert.informativeText = @"Your unsaved text will not be kept.";
  [alert addButtonWithTitle:@"Discard"];
  [alert addButtonWithTitle:@"Keep editing"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    if (response == NSAlertFirstButtonReturn) finish();
  }];
}

- (void)saveNote:(id)sender {
  (void)sender;
  NSString *content = self.noteEditorView.draft;
  if ([[content stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] length] == 0) {
    [self setLibraryBusy:NO status:@"A note cannot be empty."];
    return;
  }
  if (!self.noteEditorView.hasUnsavedChanges) {
    [self.noteEditorView setSaveState:AfternoteEditorSaveStateSaved animated:YES];
    [self setLibraryBusy:NO status:@"No changes to save. The revision is unchanged."];
    return;
  }
  self.editorSaveConfirmationPending = NO;
  [self.noteEditorView setSaveState:AfternoteEditorSaveStateSaving animated:YES];
  BOOL creating = self.creatingNote;
  NSString *submittedNoteId = creating ? @"" : StringValue(self.activeNote[@"id"]);
  NSString *method = creating ? @"library.remember" : @"library.update_note";
  NSUInteger generation = self.librarySessionGeneration;
  NSDictionary *params = creating
      ? @{ @"content" : content, @"source" : NSNull.null }
      : @{ @"id" : submittedNoteId, @"content" : content,
           @"expectedRevision" : self.activeNote[@"revision"] ?: @0,
           @"source" : self.activeNote[@"source"] ?: NSNull.null };
  self.libraryNoteRequestSequence += 1;
  self.libraryRevisionRequestSequence += 1;
  self.libraryMutationInFlight = YES;
  [self setLibraryBusy:YES status:creating ? @"Creating note…" : @"Saving revision…"];
  [self.broker requestMethod:method params:params reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration) return;
      if (!creating && ![StringValue(self.activeNote[@"id"]) isEqualToString:submittedNoteId]) {
        self.libraryMutationInFlight = NO;
        [self.noteEditorView setSaveState:AfternoteEditorSaveStateDefault animated:NO];
        [self loadLibraryNotes:NO];
        return;
      }
      if (error != nil) {
        self.libraryMutationInFlight = NO;
        [self.noteEditorView setSaveState:AfternoteEditorSaveStateDefault animated:NO];
        if ([StringValue(error[@"code"]) isEqualToString:@"conflict"] && !creating) {
          [self showUpdateConflictForNoteId:submittedNoteId draft:content generation:generation];
          return;
        }
        [self showLibraryError:error];
        return;
      }
      NSDictionary *note = [result[@"note"] isKindOfClass:[NSDictionary class]] ? result[@"note"] : nil;
      self.libraryMutationInFlight = NO;
      self.creatingNote = NO;
      self.activeNote = note;
      [self renderActiveNote];
      [self loadLibraryNotes:NO];
      if (note != nil) {
        self.editorSaveConfirmationPending = YES;
        [self openNoteId:StringValue(note[@"id"]) revision:nil];
      } else {
        [self.noteEditorView setSaveState:AfternoteEditorSaveStateDefault animated:NO];
      }
    });
  }];
}

- (void)confirmDeleteNote:(id)sender {
  (void)sender;
  if (self.activeNote == nil || self.activeDeleteTarget.length == 0) return;
  NSString *noteId = StringValue(self.activeNote[@"id"]);
  NSNumber *revision = self.activeNote[@"revision"] ?: @0;
  NSString *target = self.activeDeleteTarget;
  NSUInteger generation = self.librarySessionGeneration;
  NSAlert *alert = [[NSAlert alloc] init];
  alert.alertStyle = NSAlertStyleCritical;
  alert.messageText = [NSString stringWithFormat:@"Permanently delete revision %@?", revision];
  alert.informativeText = [NSString stringWithFormat:@"“%@”\n\nThis cannot be undone. %@, and Afternote will recheck the exact revision before deleting.", target, FreshOwnerApprovalDescription()];
  [alert addButtonWithTitle:@"Delete permanently"];
  [alert addButtonWithTitle:@"Cancel"];
  self.librarySensitiveAlert = alert;
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    self.librarySensitiveAlert = nil;
    self.librarySensitiveTextView = nil;
    if (response != NSAlertFirstButtonReturn) return;
    if (generation != self.librarySessionGeneration) return;
    self.libraryNoteRequestSequence += 1;
    self.libraryRevisionRequestSequence += 1;
    self.libraryMutationInFlight = YES;
    [self setLibraryBusy:YES status:OwnerApprovalWaitMessage()];
    [self.broker requestMethod:@"library.delete"
                        params:@{ @"id" : noteId, @"expectedRevision" : revision,
                                  @"targetDescription" : target }
                         reply:^(NSDictionary *result, NSDictionary *error) {
      dispatch_async(dispatch_get_main_queue(), ^{
        if (generation != self.librarySessionGeneration ||
            ![StringValue(self.activeNote[@"id"]) isEqualToString:noteId]) return;
        if (error != nil) {
          self.libraryMutationInFlight = NO;
          [self showLibraryError:error];
          return;
        }
        (void)result;
        self.libraryMutationInFlight = NO;
        self.activeNote = nil;
        self.activeDeleteTarget = nil;
        self.revisionSummaries = @[];
        [self renderActiveNote];
        [self loadLibraryNotes:NO];
      });
    }];
  }];
}

- (void)clearLibraryPlaintext:(NSString *)status {
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{ [self clearLibraryPlaintext:status]; });
    return;
  }
  self.librarySessionGeneration += 1;
  self.semanticActivationInFlight = NO;
  self.semanticReloadPending = NO;
  self.librarySensitiveTextView.string = @"";
  if (self.librarySensitiveAlert != nil) {
    self.librarySensitiveAlert.messageText = @"Notes session ended";
    self.librarySensitiveAlert.informativeText = @"Sensitive content was cleared. Authenticate again to continue.";
    NSWindow *sheet = self.librarySensitiveAlert.window;
    NSWindow *parent = sheet.sheetParent;
    if (parent != nil) [parent endSheet:sheet returnCode:NSModalResponseCancel];
    else [sheet orderOut:nil];
  }
  self.librarySensitiveAlert = nil;
  self.librarySensitiveTextView = nil;
  self.libraryExpiresAt = nil;
  self.revisionCursor = nil;
  self.activeDeleteTarget = nil;
  self.activeNote = nil;
  self.creatingNote = NO;
  self.libraryMutationInFlight = NO;
  self.editorSaveConfirmationPending = NO;
  [self.noteEditorView setSaveState:AfternoteEditorSaveStateDefault animated:NO];
  self.libraryRefreshPending = NO;
  self.revisionHistoryLoaded = NO;
  self.revisionSummaries = @[];
  [self.notesRetrieval clear];
  self.librarySearch.stringValue = @"";
  [self updateSearchComposerHeight];
  self.clearSearchButton.hidden = YES;
  [self applySearchMode:@"checking"];
  [self.noteTable reloadData];
  [self.noteEditorView clearPlaintext];
  [self setLibraryBusy:NO status:status];
}

- (void)showLibraryError:(NSDictionary *)error {
  NSString *code = StringValue(error[@"code"], @"denied");
  NSDictionary *messages = @{
    @"owner_cancelled" : @"Owner authentication was cancelled. Notes stayed closed.",
    @"owner_denied" : @"Owner authentication was denied. Notes stayed closed.",
    @"owner_timeout" : @"Owner authentication timed out. Authenticate again to continue.",
    @"owner_auth_unavailable" : @"Owner authentication is unavailable on this Mac.",
    @"library_session_expired" : @"The Notes session ended. Plaintext was cleared; authenticate again.",
    @"library_session_required" : @"Authenticate to open Notes.",
    @"vault_locked" : LockedLibraryMessage(),
    @"broker_unavailable" : @"The Afternote broker is unavailable or restarting.",
    @"invalid_request" : @"The Notes request was invalid and its session was closed. Authenticate again to continue.",
    @"invalid_cursor" : @"The Notes cursor was invalid and its session was closed. Authenticate again to continue.",
    @"invalid_response" : @"The broker response was malformed. Plaintext was cleared and the connection was replaced.",
    @"replayed" : @"The Notes request could not be replayed. Its session was closed; authenticate again.",
    @"identity_mismatch" : @"The Notes connection identity changed. Plaintext was cleared; authenticate again.",
    @"conflict" : @"The note changed. Refresh it before saving or deleting.",
    @"audit_commit_failed" : @"Afternote could not commit the save or deletion audit. The change was rolled back; retry when ready.",
  };
  NSString *message = messages[code] ?: StringValue(error[@"message"], @"The broker denied the Notes request.");
  if ([code isEqualToString:@"vault_locked"]) {
    self.vaultLocked = YES;
    self.vaultStatusCheckInFlight = NO;
    self.libraryAuthenticateButton.title = @"Unlock vault";
    [self updateVaultAccessButton];
  }
  BOOL mustClear = [code isEqualToString:@"library_session_expired"] ||
      [code isEqualToString:@"library_session_required"] ||
      [code isEqualToString:@"vault_locked"] ||
      [code isEqualToString:@"broker_unavailable"] ||
      [code isEqualToString:@"invalid_request"] ||
      [code isEqualToString:@"invalid_cursor"] ||
      [code isEqualToString:@"invalid_response"] ||
      [code isEqualToString:@"replayed"] ||
      [code isEqualToString:@"identity_mismatch"] ||
      [code hasPrefix:@"owner_"];
  if (mustClear) [self clearLibraryPlaintext:message];
  dispatch_async(dispatch_get_main_queue(), ^{
    [self setLibraryBusy:NO status:message];
  });
}

- (NSView *)cardWithTitle:(NSString *)title
                   status:(NSString *)status
                     body:(NSArray<NSString *> *)body
                   button:(NSButton *)button {
  NSTextField *heading = [self label:title size:16 weight:NSFontWeightSemibold];
  NSTextField *badge = [self label:[status uppercaseString] size:11 weight:NSFontWeightBold];
  badge.textColor = StatusColor(status);
  badge.accessibilityLabel = [NSString stringWithFormat:@"Status: %@", status];
  [heading setContentCompressionResistancePriority:NSLayoutPriorityDefaultLow
                                    forOrientation:NSLayoutConstraintOrientationHorizontal];
  [badge setContentCompressionResistancePriority:NSLayoutPriorityRequired
                                  forOrientation:NSLayoutConstraintOrientationHorizontal];
  [badge setContentHuggingPriority:NSLayoutPriorityRequired
                    forOrientation:NSLayoutConstraintOrientationHorizontal];
  NSStackView *header = [NSStackView stackViewWithViews:@[heading, badge, [NSView new]]];
  header.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  header.alignment = NSLayoutAttributeCenterY;
  NSMutableArray<NSView *> *views = [NSMutableArray arrayWithObject:header];
  NSMutableArray<NSTextField *> *bodyLabels = [NSMutableArray array];
  for (NSString *line in body) {
    NSTextField *label = [self label:line size:13 weight:NSFontWeightRegular];
    label.textColor = AfternoteMutedTextColor();
    [bodyLabels addObject:label];
    [views addObject:label];
  }
  if (button != nil) [views addObject:button];
  NSStackView *stack = [NSStackView stackViewWithViews:views];
  stack.orientation = NSUserInterfaceLayoutOrientationVertical;
  stack.alignment = NSLayoutAttributeLeading;
  stack.spacing = 8;
  stack.edgeInsets = NSEdgeInsetsMake(18, 18, 18, 18);
  [header.widthAnchor constraintEqualToAnchor:stack.widthAnchor constant:-36].active = YES;
  for (NSTextField *label in bodyLabels) {
    [label.widthAnchor constraintEqualToAnchor:stack.widthAnchor constant:-36].active = YES;
  }
  NSBox *box = [[NSBox alloc] init];
  box.boxType = NSBoxCustom;
  box.cornerRadius = 8;
  box.borderWidth = 1;
  box.borderColor = AfternoteBorderColor();
  box.fillColor = AfternoteRaisedSurfaceColor();
  box.contentViewMargins = NSZeroSize;
  NSView *cardContent = [[NSView alloc] init];
  box.contentView = cardContent;
  stack.translatesAutoresizingMaskIntoConstraints = NO;
  [cardContent addSubview:stack];
  [NSLayoutConstraint activateConstraints:@[
    [stack.leadingAnchor constraintEqualToAnchor:cardContent.leadingAnchor],
    [stack.trailingAnchor constraintEqualToAnchor:cardContent.trailingAnchor],
    [stack.topAnchor constraintEqualToAnchor:cardContent.topAnchor],
    [stack.bottomAnchor constraintEqualToAnchor:cardContent.bottomAnchor],
  ]];
  const CGFloat contentHeight = 32 + 22 + body.count * 20 +
      (button == nil ? 0 : 30) + (views.count - 1) * 7;
  [box.heightAnchor constraintGreaterThanOrEqualToConstant:contentHeight].active = YES;
  return box;
}

- (NSString *)packagedCommandPath {
  NSString *installed = AfternoteInstalledCommandPath();
  if (AfternoteIsAuthenticInstalledCommand(installed)) return installed;
  NSURL *versionRoot = [NSBundle.mainBundle.bundleURL URLByDeletingLastPathComponent];
  NSString *candidate = [[versionRoot URLByAppendingPathComponent:@"afternote"] path];
  return AfternoteIsAuthenticInstalledCommand(candidate) ? candidate : nil;
}

- (void)runPackagedCommand:(NSArray<NSString *> *)arguments
                 completion:(void (^)(NSDictionary *result, NSString *errorMessage))completion {
  NSString *command = [self packagedCommandPath];
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSDictionary *outcome = RunIntegrationCommand(command, arguments);
    dispatch_async(dispatch_get_main_queue(), ^{
      completion(outcome[@"result"], StringValue(outcome[@"error"]));
    });
  });
}

- (void)refreshIntegrationStatuses {
  NSMutableDictionary<NSString *, NSNumber *> *requestedGenerations = [NSMutableDictionary dictionary];
  for (AfternoteIntegrationDescriptor *descriptor in IntegrationDescriptors()) {
    NSString *kind = descriptor.commandKind;
    if (![self.integrationOperations containsObject:kind]) {
      NSUInteger generation = AdvanceIntegrationGeneration(
          self.integrationStatusGenerations, kind);
      requestedGenerations[kind] = @(generation);
      NSMutableDictionary *checking = [self.integrationStatuses[kind] mutableCopy]
          ?: [NSMutableDictionary dictionary];
      checking[@"uiState"] = @"checking";
      [checking removeObjectForKey:@"uiError"];
      self.integrationStatuses[kind] = checking;
    }
  }
  [self render];
  for (AfternoteIntegrationDescriptor *descriptor in IntegrationDescriptors()) {
    NSString *kind = descriptor.commandKind;
    if ([self.integrationOperations containsObject:kind]) continue;
    NSUInteger generation = [requestedGenerations[kind] unsignedIntegerValue];
    [self runPackagedCommand:@[ kind, @"status" ]
                  completion:^(NSDictionary *result, NSString *errorMessage) {
      if (!IntegrationGenerationIsCurrent(
              self.integrationStatusGenerations, kind, generation)) return;
      if (result != nil) {
        self.integrationStatuses[kind] = result;
      } else {
        NSMutableDictionary *failed = [self.integrationStatuses[kind] mutableCopy]
            ?: [NSMutableDictionary dictionary];
        failed[@"uiState"] = @"error";
        failed[@"uiError"] = errorMessage ?: @"Integration status is unavailable.";
        self.integrationStatuses[kind] = failed;
      }
      [self render];
      [self renderSetupGuide];
    }];
  }
}

- (void)refreshIntegrationStatusFromButton:(NSButton *)sender {
  (void)sender;
  [self refreshConnections:nil];
}

- (void)refreshConnections:(id)sender {
  (void)sender;
  NSUInteger generation = ++self.connectorOverviewGeneration;
  [self refreshIntegrationStatuses];
  [self setBusy:YES status:@"Refreshing connections…"];
  [self.broker requestMethod:@"owner.connector_overview"
                      params:@{}
                       reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.connectorOverviewGeneration) return;
      if (error != nil) {
        [self finishReconnectRefresh:StringValue(error[@"message"], @"Connection status is unavailable.")];
        [self render];
        [self setBusy:NO status:StringValue(
            error[@"message"], @"Connection status is unavailable.")];
        return;
      }
      NSDictionary *overview = AfternoteConnectorOverviewByKind(result);
      if (overview == nil) {
        [self finishReconnectRefresh:@"Connection status is unavailable."];
        [self render];
        [self setBusy:NO status:@"Connection status is unavailable."];
        return;
      }
      self.connectorOverviewByKind = overview;
      if ([self finishReconnectRefresh:nil]) [self refreshIntegrationStatuses];
      [self render];
      [self renderSetupGuide];
      [self setBusy:NO status:@"Connections are up to date."];
    });
  }];
}

- (BOOL)finishReconnectRefresh:(NSString *)errorMessage {
  BOOL finished = NO;
  for (NSString *kind in self.integrationOperations.allObjects) {
    NSDictionary *status = self.integrationStatuses[kind];
    if (![status[@"uiState"] isEqualToString:@"reconnect-refresh"] &&
        ![status[@"uiState"] isEqualToString:@"reconnect-refresh-failed"]) continue;
    NSMutableDictionary *updated = [status mutableCopy];
    [updated removeObjectForKey:@"uiState"];
    [updated removeObjectForKey:@"uiError"];
    if (errorMessage.length > 0) {
      // Keep stale revoked state from offering preparation again until a valid overview arrives.
      updated[@"uiState"] = @"reconnect-refresh-failed";
      updated[@"uiError"] = errorMessage;
    } else {
      [self.integrationOperations removeObject:kind];
      finished = YES;
    }
    self.integrationStatuses[kind] = updated;
  }
  return finished;
}

- (void)installIntegration:(NSButton *)sender {
  NSString *kind = sender.identifier;
  if (![kind isEqualToString:@"codex"] &&
      ![kind isEqualToString:@"claude-code"] &&
      ![kind isEqualToString:@"claude-desktop"]) return;
  if ([self.integrationOperations containsObject:kind]) return;
  AdvanceIntegrationGeneration(self.integrationStatusGenerations, kind);
  [self.integrationOperations addObject:kind];
  NSMutableDictionary *installing = [self.integrationStatuses[kind] mutableCopy]
      ?: [NSMutableDictionary dictionary];
  installing[@"uiState"] = @"installing";
  [installing removeObjectForKey:@"uiError"];
  self.integrationStatuses[kind] = installing;
  [self render];
  [self runPackagedCommand:@[ kind, @"install" ]
                completion:^(NSDictionary *result, NSString *errorMessage) {
    [self.integrationOperations removeObject:kind];
    if (result != nil) {
      self.integrationStatuses[kind] = result;
      if ([result[@"approvalRequired"] boolValue]) {
        NSAlert *approval = [[NSAlert alloc] init];
        approval.messageText = @"Finish in Claude Desktop";
        approval.informativeText = @"Claude opened an extension preview. Review it, choose Install, then return to Afternote and click Check again. Afternote does not bypass Claude’s approval step.";
        [approval addButtonWithTitle:@"Got it"];
        [approval beginSheetModalForWindow:self.window completionHandler:nil];
      }
    } else {
      NSMutableDictionary *failed = [self.integrationStatuses[kind] mutableCopy]
          ?: [NSMutableDictionary dictionary];
      failed[@"uiState"] = @"error";
      failed[@"uiError"] = errorMessage ?: @"Integration setup failed.";
      self.integrationStatuses[kind] = failed;
    }
    [self render];
    [self renderSetupGuide];
  }];
}

- (NSString *)integrationDisplayNameForKind:(NSString *)kind {
  for (AfternoteIntegrationDescriptor *descriptor in IntegrationDescriptors()) {
    if ([descriptor.commandKind isEqualToString:kind]) return descriptor.displayName;
  }
  return @"this tool";
}

- (void)reconnectIntegration:(NSButton *)sender {
  NSString *kind = sender.identifier;
  if (![kind isEqualToString:@"codex"] &&
      ![kind isEqualToString:@"claude-code"] &&
      ![kind isEqualToString:@"claude-desktop"]) return;
  if ([self.integrationOperations containsObject:kind]) return;
  for (AfternoteIntegrationDescriptor *descriptor in IntegrationDescriptors()) {
    if ([descriptor.commandKind isEqualToString:kind] &&
        [self.connectorOverviewByKind[descriptor.brokerKind].status isEqualToString:@"reconnect-prepared"])
      return;
  }
  AdvanceIntegrationGeneration(self.integrationStatusGenerations, kind);
  [self.integrationOperations addObject:kind];
  NSMutableDictionary *pending = [self.integrationStatuses[kind] mutableCopy]
      ?: [NSMutableDictionary dictionary];
  pending[@"uiState"] = @"reconnecting";
  self.integrationStatuses[kind] = pending;
  [self render];
  [self renderSetupGuide];
  [self runPackagedCommand:@[ kind, @"prepare-reconnect" ]
                completion:^(NSDictionary *result, NSString *errorMessage) {
    (void)result;
    if (errorMessage.length > 0) {
      [self.integrationOperations removeObject:kind];
      NSMutableDictionary *failed = [self.integrationStatuses[kind] mutableCopy]
          ?: [NSMutableDictionary dictionary];
      failed[@"uiState"] = @"error";
      failed[@"healthy"] = @NO;
      failed[@"uiError"] = errorMessage;
      self.integrationStatuses[kind] = failed;
      [self render];
      [self renderSetupGuide];
      return;
    }
    NSString *displayName = [self integrationDisplayNameForKind:kind];
    // Hold the operation gate until a current broker overview arrives. A host
    // configuration check alone cannot distinguish revoked from prepared access.
    NSMutableDictionary *refreshing = [self.integrationStatuses[kind] mutableCopy];
    refreshing[@"uiState"] = @"reconnect-refresh";
    self.integrationStatuses[kind] = refreshing;
    [self refreshConnections:nil];
    NSAlert *ready = [[NSAlert alloc] init];
    ready.messageText = @"Reconnect prepared";
    ready.informativeText = [NSString stringWithFormat:
        @"Next, fully quit and reopen %@. In a new chat, use Afternote to save or recall a note and approve the fresh connection. You do not need to prepare reconnect again.",
        displayName];
    [ready addButtonWithTitle:@"Got it"];
    [ready beginSheetModalForWindow:self.window completionHandler:nil];
  }];
}

- (void)openIntegrationDownload:(NSButton *)sender {
  NSString *urlString = [sender.identifier isEqualToString:@"codex"]
      ? @"https://openai.com/codex/"
      : [sender.identifier isEqualToString:@"claude-desktop"]
      ? @"https://claude.ai/download"
      : @"https://docs.anthropic.com/en/docs/claude-code/getting-started";
  NSURL *url = [NSURL URLWithString:urlString];
  if (url != nil) [NSWorkspace.sharedWorkspace openURL:url];
}

- (void)reviewIntegrationSetup:(NSButton *)sender {
  NSString *displayName = [self integrationDisplayNameForKind:sender.identifier];
  NSDictionary *status = self.integrationStatuses[sender.identifier];
  NSAlert *alert = [[NSAlert alloc] init];
  if ([status[@"problemCode"] isEqualToString:@"connector_disabled"]) {
    alert.messageText = @"Enable Afternote in Claude Desktop";
    alert.informativeText = @"Open Claude Desktop Settings > Extensions, enable Afternote, then return here and click Check again.";
  } else {
    alert.messageText = @"Existing connector needs review";
    alert.informativeText = [NSString stringWithFormat:
        @"%@ already has an Afternote MCP connector that was not created by this installation. Afternote will not overwrite it. Remove or rename that entry in %@, then return here and check again.",
        displayName, displayName];
  }
  [alert addButtonWithTitle:@"Got it"];
  [alert beginSheetModalForWindow:self.window completionHandler:nil];
}

- (void)setBusy:(BOOL)busy status:(NSString *)status {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self.connectionsView setBusy:busy status:status];
  });
}

- (void)authenticate:(id)sender {
  (void)sender;
  NSUInteger generation = ++self.ownerSessionGeneration;
  [self setBusy:YES status:OwnerApprovalWaitMessage()];
  NSArray *scopes = @[
    @"owner.inspect_clients", @"owner.inspect_grants",
    @"owner.inspect_sessions", @"owner.inspect_audit"
  ];
  [self.broker requestMethod:@"owner.session.begin"
                      params:@{ @"requestedScopes" : scopes,
                                @"ttlMs" : @(RoutineAuthenticationTtlMilliseconds()) }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    [self applyOwnerSessionResult:result error:error generation:generation];
  }];
}

- (void)applyOwnerSessionResult:(NSDictionary *)result
                          error:(NSDictionary *)error
                     generation:(NSUInteger)generation {
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self applyOwnerSessionResult:result error:error generation:generation];
    });
    return;
  }
  if (generation != self.ownerSessionGeneration) return;
  if (error != nil) {
    [self showError:error];
    return;
  }
  self.ownerExpiresAt = StringValue(result[@"expiresAt"]);
  [self loadConnectionsAndAudit];
}

- (void)loadConnectionsAndAudit {
  NSUInteger generation = self.ownerSessionGeneration;
  [self setBusy:YES status:@"Reading broker connections…"];
  [self.broker requestMethod:@"owner.inspect_connections" params:@{} reply:^(NSDictionary *result, NSDictionary *error) {
    [self applyConnectionsResult:result error:error generation:generation];
  }];
}

- (void)applyConnectionsResult:(NSDictionary *)result
                         error:(NSDictionary *)error
                    generation:(NSUInteger)generation {
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self applyConnectionsResult:result error:error generation:generation];
    });
    return;
  }
  if (generation != self.ownerSessionGeneration) return;
  if (error != nil) {
    [self showError:error];
    return;
  }
  self.connections = result;
  [self.auditEvents removeAllObjects];
  self.auditCursor = nil;
  [self loadAuditPage:NO];
}

- (void)loadAuditPage:(BOOL)append {
  NSUInteger generation = self.ownerSessionGeneration;
  [self.broker requestMethod:@"owner.inspect_audit"
                      params:@{ @"pageSize" : @25, @"cursor" : append && self.auditCursor != nil ? self.auditCursor : NSNull.null }
                       reply:^(NSDictionary *result, NSDictionary *error) {
    [self applyAuditResult:result error:error generation:generation];
  }];
}

- (void)applyAuditResult:(NSDictionary *)result
                   error:(NSDictionary *)error
              generation:(NSUInteger)generation {
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self applyAuditResult:result error:error generation:generation];
    });
    return;
  }
  if (generation != self.ownerSessionGeneration) return;
  if (error != nil) {
    [self showError:error];
    return;
  }
  [self.auditEvents addObjectsFromArray:ArrayValue(result[@"events"])];
  id cursor = result[@"nextCursor"];
  self.auditCursor = [cursor isKindOfClass:[NSString class]] ? cursor : nil;
  [self render];
  [self setBusy:NO status:[NSString stringWithFormat:@"Authenticated until %@", DateLabel(self.ownerExpiresAt)]];
}

- (void)clearSetupContent {
  for (NSView *view in [self.setupContent.arrangedSubviews copy]) {
    [self.setupContent removeArrangedSubview:view];
    [view removeFromSuperview];
  }
}

- (void)openConnectionsFromSetup:(id)sender {
  (void)sender;
  BOOL recoveryReady = self.recoveryState.length == 0 ||
      [self.recoveryState isEqualToString:@"ready"];
  AfternoteProductSurface resolved =
      [self displaySurface:AfternoteProductSurfaceConnections
             recoveryReady:recoveryReady];
  if (resolved == AfternoteProductSurfaceRecovery) {
    [self refreshRecovery:nil];
    return;
  }
  [self refreshConnections:nil];
}

- (void)openSetupGuide:(id)sender {
  (void)sender;
  self.setupGuideDismissed = NO;
  [NSUserDefaults.standardUserDefaults setBool:NO
                                        forKey:kSetupGuideDismissedDefaultsKey];
  [self updateSetupBannerVisibility];
  [self displaySurface:AfternoteProductSurfaceSetup recoveryReady:YES];
  [self renderSetupGuide];
  if (self.connectorOverviewByKind.count == 0) [self refreshConnections:nil];
}

- (void)returnFromSetupGuide:(id)sender {
  (void)sender;
  [self displaySurface:AfternoteProductSurfaceMemory recoveryReady:YES];
}

- (void)dismissSetupGuide:(id)sender {
  (void)sender;
  self.setupGuideDismissed = YES;
  [NSUserDefaults.standardUserDefaults setBool:YES
                                        forKey:kSetupGuideDismissedDefaultsKey];
  [self updateSetupBannerVisibility];
  [self returnFromSetupGuide:nil];
}

- (NSView *)setupRowWithTitle:(NSString *)title
                       detail:(NSString *)detail
                        badge:(NSString *)badge
                         tone:(NSString *)tone
                       button:(NSButton *)button {
  NSTextField *name = [self label:title size:15 weight:NSFontWeightSemibold];
  NSTextField *status = [self label:[badge uppercaseString]
                                 size:10 weight:NSFontWeightBold];
  status.textColor = StatusColor(tone);
  status.accessibilityLabel = [NSString stringWithFormat:@"Status: %@", badge];
  NSTextField *copy = [self label:detail size:12 weight:NSFontWeightRegular];
  copy.textColor = AfternoteMutedTextColor();
  copy.maximumNumberOfLines = 3;
  copy.lineBreakMode = NSLineBreakByWordWrapping;
  copy.preferredMaxLayoutWidth = 530;
  NSStackView *text = [NSStackView stackViewWithViews:@[ name, copy ]];
  text.orientation = NSUserInterfaceLayoutOrientationVertical;
  text.alignment = NSLayoutAttributeLeading;
  text.spacing = 4;
  NSView *actionSlot = [[NSView alloc] init];
  if (button != nil) {
    button.translatesAutoresizingMaskIntoConstraints = NO;
    [actionSlot addSubview:button];
    [NSLayoutConstraint activateConstraints:@[
      [button.trailingAnchor constraintEqualToAnchor:actionSlot.trailingAnchor],
      [button.centerYAnchor constraintEqualToAnchor:actionSlot.centerYAnchor],
    ]];
  }
  NSStackView *row = [NSStackView stackViewWithViews:@[ text, status, actionSlot ]];
  row.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  row.alignment = NSLayoutAttributeCenterY;
  row.spacing = 14;
  row.edgeInsets = NSEdgeInsetsMake(12, 0, 12, 0);
  NSBox *divider = [[NSBox alloc] init];
  divider.boxType = NSBoxSeparator;
  NSStackView *group = [NSStackView stackViewWithViews:@[ row, divider ]];
  group.orientation = NSUserInterfaceLayoutOrientationVertical;
  group.alignment = NSLayoutAttributeLeading;
  group.spacing = 0;
  [group.widthAnchor constraintEqualToConstant:780].active = YES;
  [row.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  [divider.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  [text.widthAnchor constraintEqualToConstant:496].active = YES;
  [status.widthAnchor constraintEqualToConstant:90].active = YES;
  [actionSlot.widthAnchor constraintEqualToConstant:166].active = YES;
  if (button != nil) {
    [button setContentHuggingPriority:NSLayoutPriorityRequired
                       forOrientation:NSLayoutConstraintOrientationHorizontal];
  }
  return group;
}

- (NSString *)localSearchReadinessDetail {
  if ([self.currentSearchMode isEqualToString:@"hybrid"]) {
    return @"Your encrypted vault and local semantic recall are ready on this Mac.";
  }
  if ([self.currentSearchMode isEqualToString:@"indexing"]) {
    return @"Your encrypted vault and exact search are ready. Semantic recall is indexing locally.";
  }
  if ([self.currentSearchMode isEqualToString:@"exact"] ||
      [self.currentSearchMode isEqualToString:@"degraded"]) {
    return @"Your encrypted vault and exact search are ready. Semantic recall is not active yet.";
  }
  return @"Your encrypted vault is ready. Open Notes once to check the local search capability.";
}

- (void)renderSetupGuide {
  if (self.setupContent == nil) return;
  [self clearSetupContent];
  NSArray *allClients = ArrayValue(self.connections[@"clients"]);
  [self.setupContent addArrangedSubview:
      [self setupRowWithTitle:@"Local notes"
                       detail:[self localSearchReadinessDetail]
                        badge:@"Ready"
                         tone:@"success"
                       button:nil]];

  BOOL integrationActive = NO;
  for (AfternoteConnectorOverviewItem *connector in self.connectorOverviewByKind.allValues) {
    if (connector.hasCurrentAuthority) {
      integrationActive = YES;
      break;
    }
  }
  AfternoteIntegrationDescriptor *revokedDescriptor = nil;
  AfternoteIntegrationDescriptor *preparedDescriptor = nil;
  for (AfternoteIntegrationDescriptor *descriptor in IntegrationDescriptors()) {
    NSArray *matching = [self clients:allClients forKind:descriptor.brokerKind];
    AfternoteConnectorOverviewItem *overview =
        self.connectorOverviewByKind[descriptor.brokerKind];
    if ([overview.status isEqualToString:@"reconnect-prepared"]) preparedDescriptor = descriptor;
    NSDictionary *current = [self currentClientFromClients:matching];
    BOOL revoked = overview != nil
        ? [overview.status isEqualToString:@"revoked"]
        : [[StringValue(current[@"status"]) lowercaseString]
            isEqualToString:@"revoked"];
    if (revoked && ![self.integrationOperations containsObject:descriptor.commandKind] &&
        [self.integrationStatuses[descriptor.commandKind][@"healthy"] boolValue]) {
      revokedDescriptor = descriptor;
      break;
    }
  }
  NSButton *connectionsButton = nil;
  if (revokedDescriptor != nil) {
    connectionsButton = [AfternoteButton buttonWithTitle:@"Prepare reconnect"
                                                   target:self
                                                   action:@selector(reconnectIntegration:)];
    connectionsButton.identifier = revokedDescriptor.commandKind;
    [self stylePrimaryButton:connectionsButton];
  } else if (!integrationActive) {
    connectionsButton = [AfternoteButton buttonWithTitle:@"Open Connections"
                                                   target:self
                                                   action:@selector(openConnectionsFromSetup:)];
    [self stylePrimaryButton:connectionsButton];
  }
  [self.setupContent addArrangedSubview:
      [self setupRowWithTitle:@"Connect one tool"
                       detail:revokedDescriptor != nil
                           ? [NSString stringWithFormat:@"%@ access was revoked. Prepare a fresh identity, then start a new session.",
                                                        revokedDescriptor.displayName]
                           : preparedDescriptor != nil
                           ? [NSString stringWithFormat:@"Reconnect is prepared. Quit and reopen %@, then use Remember or Recall to approve the fresh connection.",
                                                        preparedDescriptor.displayName]
                           : integrationActive
                           ? @"Afternote is available in at least one of your local tools."
                           : @"Choose Codex, Claude Code, or Claude Desktop. Afternote guides the connection for you."
                        badge:revokedDescriptor != nil ? @"Reconnect" : preparedDescriptor != nil ? @"Prepared" : integrationActive ? @"Active" : @"Next"
                         tone:integrationActive && revokedDescriptor == nil && preparedDescriptor == nil ? @"success" : @"warning"
                       button:connectionsButton]];

  BOOL proofComplete = AfternoteHasCorrelatedRecallProof(self.auditEvents);
  if (!proofComplete) {
    for (AfternoteConnectorOverviewItem *connector in self.connectorOverviewByKind.allValues) {
      if (connector.verifiedRoundTrip) {
        proofComplete = YES;
        break;
      }
    }
  }
  if (proofComplete && !self.setupGuideDismissed) {
    self.setupGuideDismissed = YES;
    [NSUserDefaults.standardUserDefaults setBool:YES
                                          forKey:kSetupGuideDismissedDefaultsKey];
    [self updateSetupBannerVisibility];
  }
  [self.setupContent addArrangedSubview:
      [self setupRowWithTitle:@"Test the connection"
                       detail:proofComplete
                           ? @"A connected tool saved a note and recalled that exact note with a citation."
                           : @"In your connected tool, save: “My Afternote test phrase is cedar 31.” Then ask: “What is my Afternote test phrase?”"
                        badge:proofComplete ? @"Complete" : @"Waiting"
                         tone:proofComplete ? @"success" : @"warning"
                       button:nil]];
}

- (NSArray<NSDictionary *> *)clients:(NSArray<NSDictionary *> *)clients
                              forKind:(NSString *)kind {
  return [clients filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSDictionary *client, NSDictionary *bindings) {
    (void)bindings;
    return [StringValue(client[@"kind"]) isEqualToString:kind];
  }]];
}

- (NSDictionary *)currentClientFromClients:(NSArray<NSDictionary *> *)clients {
  NSArray<NSDictionary *> *sorted = [clients sortedArrayUsingComparator:
      ^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    NSString *leftDate = StringValue(left[@"lastActivityAt"], StringValue(left[@"pairedAt"]));
    NSString *rightDate = StringValue(right[@"lastActivityAt"], StringValue(right[@"pairedAt"]));
    return [rightDate compare:leftDate];
  }];
  for (NSDictionary *client in sorted) {
    if (ConnectorHasCurrentAuthority(client)) return client;
  }
  return sorted.firstObject;
}

- (NSArray<NSString *> *)connectorHistoryForKind:(NSString *)kind
                                         clients:(NSArray<NSDictionary *> *)clients
                                          grants:(NSArray<NSDictionary *> *)grants {
  NSArray *events = [self.auditEvents filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSDictionary *event, NSDictionary *bindings) {
    (void)bindings;
    return [StringValue(event[@"clientKind"]) isEqualToString:kind];
  }]];
  return ConnectorLifecycleHistory(clients, grants, events);
}

- (AfternoteConnectionRow *)connectorRowForCommandKind:(NSString *)commandKind
                             brokerKind:(NSString *)brokerKind
                            displayName:(NSString *)displayName
                                clients:(NSArray<NSDictionary *> *)clients
                                 grants:(NSArray<NSDictionary *> *)grants {
  NSDictionary *integrationStatus = commandKind.length > 0
      ? self.integrationStatuses[commandKind] : nil;
  AfternoteConnectorOverviewItem *overview = self.connectorOverviewByKind[brokerKind];
  NSDictionary *current = [self currentClientFromClients:clients];
  BOOL connected = overview != nil
      ? overview.hasCurrentAuthority : ConnectorHasCurrentAuthority(current);
  BOOL explicitlyRevoked = overview != nil
      ? [overview.status isEqualToString:@"revoked"]
      : [[StringValue(current[@"status"]) lowercaseString]
          isEqualToString:@"revoked"];

  NSArray *events = [self.auditEvents filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSDictionary *event, NSDictionary *bindings) {
    (void)bindings;
    return [StringValue(event[@"clientKind"]) isEqualToString:brokerKind];
  }]];
  NSArray *defaultScopes = commandKind.length > 0
      ? @[ @"memory.remember", @"memory.recall", @"memory.get_note" ]
      : @[];
  NSArray *visibleScopes = connected
      ? overview != nil ? overview.activeScopes : ArrayValue(current[@"activeScopes"])
      : defaultScopes;
  NSString *lastUsed = overview != nil
      ? overview.lastActivityAt : StringValue(current[@"lastActivityAt"]);
  if (lastUsed.length == 0 && events.count > 0) {
    lastUsed = StringValue(events.firstObject[@"occurredAt"]);
  }
  if (commandKind.length == 0 && integrationStatus == nil) {
    integrationStatus = @{
      @"toolAvailable" : @YES,
      @"installed" : @YES,
      @"healthy" : @(connected),
      @"problemCode" : connected ? NSNull.null : @"runtime_unavailable",
    };
  }
  AfternoteConnectorPresentation *presentation =
      [AfternoteConnectorPresentation presentationForTool:displayName
                                                   status:integrationStatus
                                                connected:connected
                                                  revoked:explicitlyRevoked
                                        reconnectPrepared:[overview.status isEqualToString:@"reconnect-prepared"]
                                          lastActiveLabel:lastUsed.length > 0
                                              ? DateLabel(lastUsed) : @""];
  NSString *activityValue = [NSString stringWithFormat:@"%lu saved · %lu recalled",
      (unsigned long)(overview != nil ? overview.savedCount : 0),
      (unsigned long)(overview != nil ? overview.readCount : 0)];
  if (lastUsed.length > 0) {
    activityValue = [activityValue stringByAppendingFormat:@" · Last used %@",
                     DateLabel(lastUsed)];
  }

  NSArray<NSString *> *historyLines = [self connectorHistoryForKind:brokerKind
                                                            clients:clients
                                                             grants:grants];
  if (connected) {
    self.revocationTargets[brokerKind] = @{
      @"kind": brokerKind, @"displayLabel": displayName,
      @"scopes": overview != nil ? overview.activeScopes : ArrayValue(current[@"activeScopes"]),
    };
  }
  AfternoteConnectionRow *row = [[AfternoteConnectionRow alloc] init];
  row.commandKind = commandKind;
  row.brokerKind = brokerKind;
  row.displayName = displayName;
  row.presentation = presentation;
  row.connected = connected;
  row.permissions = ScopesLabel(visibleScopes);
  row.activity = activityValue;
  row.historyLines = historyLines;
  row.historyAuthorized = self.ownerExpiresAt.length > 0;
  row.historyExpanded = [self.expandedConnectorKinds containsObject:brokerKind];
  row.hasOlderHistory = self.auditCursor != nil;
  return row;
}

- (void)toggleConnectorHistory:(NSButton *)sender {
  NSString *kind = sender.identifier;
  if (kind.length == 0) return;
  if ([self.expandedConnectorKinds containsObject:kind]) {
    [self.expandedConnectorKinds removeObject:kind];
  } else {
    [self.expandedConnectorKinds addObject:kind];
    if (self.ownerExpiresAt.length == 0) {
      [self authenticate:nil];
      return;
    }
  }
  [self render];
}

- (void)render {
  [self renderSetupGuide];
  NSMutableArray<AfternoteConnectionRow *> *rows = [NSMutableArray array];
  NSArray *clients = ArrayValue(self.connections[@"clients"]);
  NSArray *grants = ArrayValue(self.connections[@"grants"]);
  [self.revocationTargets removeAllObjects];
  NSMutableSet<NSString *> *renderedKinds = [NSMutableSet set];
  for (AfternoteIntegrationDescriptor *descriptor in IntegrationDescriptors()) {
    NSArray *matching = [self clients:clients forKind:descriptor.brokerKind];
    [rows addObject:[self connectorRowForCommandKind:descriptor.commandKind
                                        brokerKind:descriptor.brokerKind
                                       displayName:descriptor.displayName
                                           clients:matching
                                            grants:grants]];
    [renderedKinds addObject:descriptor.brokerKind];
  }
  for (NSDictionary *client in clients) {
    NSString *kind = StringValue(client[@"kind"]);
    if (kind.length == 0 || [renderedKinds containsObject:kind]) continue;
    NSArray *matching = [self clients:clients forKind:kind];
    NSDictionary *current = [self currentClientFromClients:matching];
    [rows addObject:[self connectorRowForCommandKind:nil
                                        brokerKind:kind
                                       displayName:StringValue(current[@"displayLabel"], @"Local tool")
                                           clients:matching
                                            grants:grants]];
    [renderedKinds addObject:kind];
  }
  [self.connectionsView renderRows:rows];
}

- (void)loadMore:(id)sender {
  [(NSButton *)sender setEnabled:NO];
  [self setBusy:YES status:@"Loading more audit events…"];
  [self loadAuditPage:YES];
}

- (void)confirmRevocation:(NSButton *)sender {
  NSDictionary *target = self.revocationTargets[sender.identifier ?: @""];
  if (target == nil) return;
  NSUInteger generation = self.ownerSessionGeneration;
  NSString *label = StringValue(target[@"displayLabel"], @"this client");
  NSString *scopes = ScopesLabel(ArrayValue(target[@"scopes"]));
  NSAlert *alert = [[NSAlert alloc] init];
  alert.alertStyle = NSAlertStyleCritical;
  alert.messageText = [NSString stringWithFormat:@"Revoke %@?", label];
  alert.informativeText = [NSString stringWithFormat:@"Scopes: %@. Active and pending sessions will fail on their next operation. %@.", scopes, FreshOwnerApprovalDescription()];
  [alert addButtonWithTitle:[NSString stringWithFormat:@"Revoke %@", label]];
  [alert addButtonWithTitle:@"Cancel"];
  [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
    if (response != NSAlertFirstButtonReturn ||
        generation != self.ownerSessionGeneration) return;
    [self setBusy:YES status:OwnerApprovalWaitMessage()];
    sender.enabled = NO;
    [self.broker requestMethod:@"owner.revoke_connector"
                        params:@{ @"kind" : target[@"kind"] ?: @"" }
                         reply:^(NSDictionary *result, NSDictionary *error) {
      [self applyRevocationResult:result error:error generation:generation
                           sender:sender label:label];
    }];
  }];
}

- (void)applyRevocationResult:(NSDictionary *)result
                        error:(NSDictionary *)error
                   generation:(NSUInteger)generation
                       sender:(NSButton *)sender
                        label:(NSString *)label {
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self applyRevocationResult:result error:error generation:generation
                           sender:sender label:label];
    });
    return;
  }
  if (generation != self.ownerSessionGeneration) return;
  if (error != nil) {
    sender.enabled = YES;
    [self showError:error];
    return;
  }
  (void)result;
  [self setBusy:YES status:[NSString stringWithFormat:
      @"%@ revoked. Refreshing broker truth…", label]];
  self.connections = nil;
  self.ownerExpiresAt = nil;
  self.auditCursor = nil;
  [self.auditEvents removeAllObjects];
  [self refreshConnections:nil];
}

- (void)showError:(NSDictionary *)error {
  NSString *code = StringValue(error[@"code"], @"denied");
  NSDictionary *messages = @{
    @"owner_cancelled" : @"Owner authentication was cancelled. No authority was granted.",
    @"owner_denied" : @"Owner authentication was denied. No authority was granted.",
    @"owner_timeout" : @"Owner authentication timed out. Authenticate again to continue.",
    @"owner_auth_unavailable" : @"Owner authentication is unavailable on this Mac.",
    @"owner_session_expired" : @"The inspection session expired. Authenticate again to continue.",
    @"owner_session_required" : @"Authenticate to inspect broker connections.",
    @"broker_unavailable" : @"The Afternote broker is unavailable or restarting.",
  };
  NSString *message = messages[code] ?: StringValue(error[@"message"], @"The broker denied the request.");
  if ([code isEqualToString:@"owner_session_expired"] ||
      [code isEqualToString:@"owner_session_required"] ||
      [code isEqualToString:@"broker_unavailable"]) {
    self.ownerExpiresAt = nil;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    [self setBusy:NO status:message];
    [self.connectionsView showErrorMessage:message];
  });
}

@end


#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
#include "owner_control_connections_layout_smoke.inc"
#include "owner_control_notes_retrieval_smoke.inc"
#include "owner_control_semantic_smoke.inc"
#include "owner_control_reconnect_smoke.inc"
NSTextView *FixtureEditorText(NSView *view) {
  if ([view.identifier isEqualToString:@"note-editor-draft"]) return (NSTextView *)view;
  for (NSView *child in view.subviews) {
    NSTextView *text = FixtureEditorText(child);
    if (text != nil) return text;
  }
  return nil;
}
@interface RevisionNavigationProbeDelegate : OwnerControlDelegate
@property(nonatomic, copy) NSString *openedNoteId;
@property(nonatomic, strong) NSNumber *openedRevision;
@end

@implementation RevisionNavigationProbeDelegate
- (void)openNoteId:(NSString *)noteId revision:(NSNumber *)revision {
  self.openedNoteId = noteId;
  self.openedRevision = revision;
}
@end

int RunRevisionNavigationSmoke() {
  [NSApplication sharedApplication];
  NSString *noteId = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  RevisionNavigationProbeDelegate *delegate =
      [[RevisionNavigationProbeDelegate alloc] init];
  delegate.activeNote = @{
    @"noteId" : noteId,
    @"revision" : @2,
    @"content" : @"Historical text",
  };
  delegate.noteTable = [[NSTableView alloc] init];
  [delegate selectEditorRevision:nil];
  BOOL historicalRevisionReturnsToCurrent =
      [delegate.openedNoteId isEqualToString:noteId] &&
      delegate.openedRevision == nil;
  NSDictionary *output = @{
    @"historicalRevisionReturnsToCurrent" : @(historicalRevisionReturnsToCurrent),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return historicalRevisionReturnsToCurrent ? 0 : 2;
}

int RunCitationInspectorSmoke() {
  [NSApplication sharedApplication];
  NSString *noteId = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  RevisionNavigationProbeDelegate *delegate =
      [[RevisionNavigationProbeDelegate alloc] init];
  delegate.noteTable = [[NSTableView alloc] init];
  [delegate.noteTable addTableColumn:[[NSTableColumn alloc] initWithIdentifier:@"note"]];
  delegate.noteTable.dataSource = delegate;
  delegate.noteTable.delegate = delegate;
  SeedNotesFixture(delegate.notesRetrieval, @[@{
    @"id" : noteId,
    @"revision" : @3,
    @"excerpt" : @"Frozen citation",
    kLibraryResultKindKey : kLibrarySearchResultKind,
  }]);
  [delegate.noteTable reloadData];
  [delegate.noteTable selectRowIndexes:[NSIndexSet indexSetWithIndex:0]
                  byExtendingSelection:NO];
  [delegate tableViewSelectionDidChange:
      [NSNotification notificationWithName:NSTableViewSelectionDidChangeNotification
                                    object:delegate.noteTable]];
  BOOL citationUsesExactRevision = delegate.inspectingCitation &&
      [delegate.openedNoteId isEqualToString:noteId] &&
      delegate.openedRevision.integerValue == 3;

  SeedNotesFixture(delegate.notesRetrieval, @[@{
    @"id" : noteId,
    @"revision" : @4,
    @"excerpt" : @"Current note",
  }]);
  [delegate.noteTable reloadData];
  [delegate.noteTable selectRowIndexes:[NSIndexSet indexSetWithIndex:0]
                  byExtendingSelection:NO];
  [delegate tableViewSelectionDidChange:
      [NSNotification notificationWithName:NSTableViewSelectionDidChangeNotification
                                    object:delegate.noteTable]];
  BOOL browseUsesCurrent = !delegate.inspectingCitation &&
      [delegate.openedNoteId isEqualToString:noteId] &&
      delegate.openedRevision == nil;
  NSDictionary *output = @{
    @"citationUsesExactRevision" : @(citationUsesExactRevision),
    @"browseUsesCurrent" : @(browseUsesCurrent),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return citationUsesExactRevision && browseUsesCurrent ? 0 : 2;
}

@interface LibrarySearchSubmissionProbe : NSObject
@property(nonatomic) NSUInteger submissionCount;
- (void)submit:(id)sender;
@end

@implementation LibrarySearchSubmissionProbe
- (void)submit:(id)sender {
  (void)sender;
  self.submissionCount += 1;
}
@end

int RunLibrarySearchSubmissionSmoke() {
  [NSApplication sharedApplication];
  LibrarySearchSubmissionProbe *probe = [[LibrarySearchSubmissionProbe alloc] init];
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 480, 120)
                                                 styleMask:NSWindowStyleMaskBorderless
                                                   backing:NSBackingStoreBuffered
                                                     defer:NO];
  AfternoteAskComposerView *composer = [[AfternoteAskComposerView alloc]
      initWithFrame:NSMakeRect(20, 35, 440, kAskComposerHeight)];
  composer.wantsLayer = YES;
  composer.layer.cornerRadius = 10;
  composer.afternoteFocused = NO;
  NSImageView *icon = [[NSImageView alloc]
      initWithFrame:NSMakeRect(14, (kAskComposerHeight - kAskIconSize) / 2,
                               kAskIconSize, kAskIconSize)];
  NSTextField *field = [[NSTextField alloc]
      initWithFrame:NSMakeRect(40, (kAskComposerHeight - kAskFieldHeight) / 2,
                               348, kAskFieldHeight)];
  field.bordered = NO;
  field.bezeled = NO;
  field.drawsBackground = NO;
  field.focusRingType = NSFocusRingTypeNone;
  field.usesSingleLineMode = NO;
  field.lineBreakMode = NSLineBreakByWordWrapping;
  field.cell.wraps = YES;
  field.cell.scrollable = NO;
  field.placeholderString = @"Search anything you've written down";
  [composer addSubview:icon];
  [composer addSubview:field];
  [window.contentView addSubview:composer];
  field.target = probe;
  field.action = @selector(submit:);
  OwnerControlDelegate *delegate = [[OwnerControlDelegate alloc] init];
  delegate.librarySearch = field;
  delegate.askComposer = composer;
  field.delegate = delegate;
  [window makeFirstResponder:field];
  [delegate controlTextDidBeginEditing:
      [NSNotification notificationWithName:NSControlTextDidBeginEditingNotification
                                    object:field]];
  NSText *fieldEditor = field.currentEditor;
  NSString *longQuery = @"Where is the spare bicycle key, and which note explains why it was moved after the Saturday ride?";
  [fieldEditor insertText:longQuery];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];
  BOOL typedThroughFieldEditor = fieldEditor != nil &&
      [field.stringValue isEqualToString:longQuery];
  BOOL pauseDidNotSubmit = typedThroughFieldEditor && probe.submissionCount == 0;
  BOOL focusUsesOuterComposer =
      field.focusRingType == NSFocusRingTypeNone && composer.afternoteFocused;
  [field sendAction:field.action to:field.target];
  BOOL explicitActionSubmittedOnce = probe.submissionCount == 1;
  BOOL placeholderMatchesProductCopy =
      [field.placeholderString isEqualToString:@"Search anything you've written down"];
  BOOL multilineEnabled = !field.usesSingleLineMode && field.cell.wraps &&
      !field.cell.scrollable && field.lineBreakMode == NSLineBreakByWordWrapping;
  BOOL searchIconDoesNotOverlapText = NSMaxX(icon.frame) <= NSMinX(field.frame);
  BOOL verticallyAligned =
      fabs(NSMidY(icon.frame) - NSMidY(field.frame)) < 0.5 &&
      fabs(NSMidY(field.frame) - NSMidY(composer.bounds)) < 0.5;
  NSDictionary *output = @{
    @"typedThroughFieldEditor" : @(typedThroughFieldEditor),
    @"multilineEnabled" : @(multilineEnabled),
    @"pauseDidNotSubmit" : @(pauseDidNotSubmit),
    @"explicitActionSubmittedOnce" : @(explicitActionSubmittedOnce),
    @"placeholderMatchesProductCopy" : @(placeholderMatchesProductCopy),
    @"searchIconDoesNotOverlapText" : @(searchIconDoesNotOverlapText),
    @"verticallyAligned" : @(verticallyAligned),
    @"focusUsesOuterComposer" : @(focusUsesOuterComposer),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return typedThroughFieldEditor && pauseDidNotSubmit && explicitActionSubmittedOnce &&
      placeholderMatchesProductCopy && searchIconDoesNotOverlapText && verticallyAligned &&
      focusUsesOuterComposer && multilineEnabled ? 0 : 2;
}

int RunConnectorHistorySmoke() {
  NSString *clientId = @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  NSMutableArray<NSDictionary *> *events = [NSMutableArray array];
  for (NSUInteger day = 1; day <= 14; day++) {
    [events addObject:@{
      @"operation" : day % 2 == 0 ? @"client.revoke" : @"client.pair",
      @"occurredAt" : [NSString stringWithFormat:@"2026-08-%02luT12:00:00.000Z",
                       (unsigned long)day],
      @"outcome" : @"success",
    }];
  }
  [events addObject:@{
    @"operation" : @"memory.recall",
    @"occurredAt" : @"2026-08-15T12:00:00.000Z",
    @"outcome" : @"success",
  }];
  NSArray *clients = @[
    @{ @"clientId" : clientId,
       @"status" : @"expired",
       @"pairedAt" : @"2026-08-01T12:00:00.000Z" },
  ];
  NSArray *grants = @[
    @{ @"clientId" : clientId,
       @"revokedAt" : @"2026-08-02T12:00:00.000Z" },
    @{ @"clientId" : @"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
       @"revokedAt" : @"2026-08-16T12:00:00.000Z" },
  ];
  NSArray<NSString *> *history = ConnectorLifecycleHistory(clients, grants, events);
  NSArray<NSString *> *deduplicated = ConnectorLifecycleHistory(
      clients, @[ grants.firstObject ], @[ events.firstObject ]);
  NSArray<NSDictionary *> *reconnectEvents = @[
    @{ @"operation" : @"client.pair", @"occurredAt" : @"2026-08-01T12:00:00.000Z", @"outcome" : @"success" },
    @{ @"operation" : @"client.revoke", @"occurredAt" : @"2026-08-02T12:00:00.000Z", @"outcome" : @"success" },
    @{ @"operation" : @"client.pair", @"occurredAt" : @"2026-08-03T12:00:00.000Z", @"outcome" : @"success" },
  ];
  NSArray<NSString *> *reconnectHistory = ConnectorLifecycleHistory(@[], @[], reconnectEvents);
  NSUInteger connectedCount = [reconnectHistory indexesOfObjectsPassingTest:
      ^BOOL(NSString *line, NSUInteger index, BOOL *stop) {
    (void)index;
    (void)stop;
    return [line hasPrefix:@"Connected ·"];
  }].count;
  BOOL capsAtTwelve = history.count == 12;
  BOOL deduplicatesLifecycleRecords = deduplicated.count == 2;
  BOOL excludesUnrelatedGrants = [history indexOfObjectPassingTest:
      ^BOOL(NSString *line, NSUInteger index, BOOL *stop) {
    (void)index;
    (void)stop;
    return [line containsString:DateLabel(@"2026-08-16T12:00:00.000Z")];
  }] == NSNotFound;
  BOOL newestFirst = [history.firstObject containsString:DateLabel(@"2026-08-14T12:00:00.000Z")] &&
      [history.lastObject containsString:DateLabel(@"2026-08-03T12:00:00.000Z")];
  BOOL expiredDoesNotConnect = !ConnectorHasCurrentAuthority(clients.firstObject);
  BOOL preservesReconnects = reconnectHistory.count == 3 && connectedCount == 2;
  NSDictionary *output = @{
    @"capsAtTwelve" : @(capsAtTwelve),
    @"deduplicatesLifecycleRecords" : @(deduplicatesLifecycleRecords),
    @"expiredDoesNotConnect" : @(expiredDoesNotConnect),
    @"excludesUnrelatedGrants" : @(excludesUnrelatedGrants),
    @"newestFirst" : @(newestFirst),
    @"preservesReconnects" : @(preservesReconnects),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return capsAtTwelve && deduplicatesLifecycleRecords && expiredDoesNotConnect &&
      excludesUnrelatedGrants && newestFirst && preservesReconnects ? 0 : 2;
}

int RunIntegrationCommandSmoke(int argc, const char *argv[]) {
  if (argc != 3) return 64;
  NSString *command = [NSString stringWithUTF8String:argv[2]];
  NSDictionary *outcome = RunIntegrationCommand(command, @[ @"status" ]);
  NSData *data = [NSJSONSerialization dataWithJSONObject:outcome options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return 0;
}

int RunIntegrationGenerationSmoke() {
  NSMutableDictionary<NSString *, NSNumber *> *generations = [NSMutableDictionary dictionary];
  NSUInteger codexFirst = AdvanceIntegrationGeneration(generations, @"codex");
  NSUInteger claudeFirst = AdvanceIntegrationGeneration(generations, @"claude-code");
  NSUInteger claudeDesktopFirst = AdvanceIntegrationGeneration(
      generations, @"claude-desktop");
  NSUInteger codexInstall = AdvanceIntegrationGeneration(generations, @"codex");
  BOOL codexStatusBecameStale = !IntegrationGenerationIsCurrent(
      generations, @"codex", codexFirst);
  BOOL codexInstallStayedCurrent = IntegrationGenerationIsCurrent(
      generations, @"codex", codexInstall);
  BOOL claudeStatusStayedCurrent = IntegrationGenerationIsCurrent(
      generations, @"claude-code", claudeFirst);
  BOOL claudeDesktopStatusStayedCurrent = IntegrationGenerationIsCurrent(
      generations, @"claude-desktop", claudeDesktopFirst);
  NSDictionary *output = @{
    @"claudeDesktopStatusStayedCurrent" : @(claudeDesktopStatusStayedCurrent),
    @"codexStatusBecameStale" : @(codexStatusBecameStale),
    @"codexInstallStayedCurrent" : @(codexInstallStayedCurrent),
    @"claudeStatusStayedCurrent" : @(claudeStatusStayedCurrent),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return codexStatusBecameStale && codexInstallStayedCurrent &&
      claudeStatusStayedCurrent && claudeDesktopStatusStayedCurrent ? 0 : 2;
}

@interface BrokerRecoveryProbeConnection : NSObject <AfternoteOwnerBroker>
@property(nonatomic) NSUInteger recoveryFailuresRemaining;
@property(nonatomic) NSUInteger replacementCount;
@property(nonatomic, strong) NSMutableArray<NSString *> *requestedMethods;
@property(nonatomic, copy) NSString *lifecycleState;
@property(nonatomic, copy) void (^afterLifecycleReply)(void);
@property(nonatomic, copy) void (^disconnectHandler)(void);
- (instancetype)initWithRecoveryFailures:(NSUInteger)failures;
@end

@implementation BrokerRecoveryProbeConnection
- (instancetype)initWithRecoveryFailures:(NSUInteger)failures {
  self = [super init];
  if (self == nil) return nil;
  _recoveryFailuresRemaining = failures;
  _requestedMethods = [NSMutableArray array];
  _lifecycleState = @"unlocked";
  return self;
}

- (void)replaceConnection {
  self.replacementCount += 1;
}

- (void)requestMethod:(NSString *)method
               params:(NSDictionary *)params
                reply:(BrokerReply)reply {
  (void)params;
  [self.requestedMethods addObject:method];
  if ([method isEqualToString:@"recovery.status"]) {
    if (self.recoveryFailuresRemaining > 0) {
      self.recoveryFailuresRemaining -= 1;
      reply(nil, @{ @"code" : @"broker_unavailable",
                    @"message" : @"Fixture restart in progress." });
    } else {
      reply(@{ @"state" : @"encrypted-candidate" }, nil);
    }
    return;
  }
  if ([method isEqualToString:@"lifecycle.status"]) {
    reply(@{ @"state" : self.lifecycleState,
             @"epoch" : @"11111111-1111-4111-8111-111111111111" }, nil);
    if (self.afterLifecycleReply != nil) {
      void (^afterReply)(void) = self.afterLifecycleReply;
      self.afterLifecycleReply = nil;
      afterReply();
    }
    return;
  }
  reply(nil, @{ @"code" : @"invalid_request",
                @"message" : @"Unexpected fixture request." });
}

- (void)requestLifecycleTransitionMethod:(NSString *)method
                                   reply:(BrokerReply)reply {
  [self requestMethod:method params:@{} reply:reply];
}
@end

OwnerControlDelegate *BrokerRecoveryProbeDelegate(
    BrokerRecoveryProbeConnection *broker) {
  OwnerControlDelegate *delegate = [[OwnerControlDelegate alloc] init];
  delegate.broker = broker;
  SeedNotesFixture(delegate.notesRetrieval, @[@{
    @"id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"revision" : @1,
    @"excerpt" : @"Sensitive fixture",
  }]);
  delegate.revisionSummaries = @[];
  delegate.activeNote = @{
    @"id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"revision" : @1,
    @"content" : @"Sensitive fixture",
  };
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  delegate.ownerExpiresAt = @"2099-01-01T00:00:00.000Z";
  delegate.connections = @{ @"fixture" : @YES };
  delegate.auditEvents = [NSMutableArray array];
  delegate.revocationTargets = [NSMutableDictionary dictionary];
  delegate.librarySearch = [[NSSearchField alloc] init];
  delegate.noteTable = [[NSTableView alloc] init];
  delegate.noteEditorView = [[AfternoteNoteEditorView alloc] initWithActionTarget:delegate];
  [delegate renderActiveNote];
  [delegate.noteEditorView restoreDraft:@"Sensitive fixture"];
  delegate.libraryAuthenticateButton = [[NSButton alloc] init];
  delegate.libraryRecentButton = [[NSButton alloc] init];
  delegate.createNoteButton = [[NSButton alloc] init];
  delegate.loadMoreNotesButton = [[NSButton alloc] init];
  delegate.libraryStatusLabel = [[NSTextField alloc] init];
  delegate.libraryProgress = [[NSProgressIndicator alloc] init];
  delegate.libraryViews = [NSStackView stackViewWithViews:@[]];
  delegate.connectionsView = [[AfternoteConnectionsView alloc] initWithActionTarget:delegate];
  delegate.memoryNavigationButton = [[NSButton alloc] init];
  delegate.connectionsNavigationButton = [[NSButton alloc] init];
  delegate.surfaceSelector = [NSSegmentedControl
      segmentedControlWithLabels:@[ @"Notes", @"Connections" ]
                  trackingMode:NSSegmentSwitchTrackingSelectOne
                        target:nil action:nil];
  delegate.surfaceSelector.selectedSegment =
      AfternoteNavigationSegmentForSurface(AfternoteProductSurfaceMemory);
  delegate.surfaceTabs = [[NSTabView alloc] init];
  for (NSString *label in @[ @"Notes", @"Connections", @"Recovery", @"Setup", @"Settings" ]) {
    [delegate.surfaceTabs addTabViewItem:
        [[NSTabViewItem alloc] initWithIdentifier:label]];
  }
  delegate.recoveryContent = [NSStackView stackViewWithViews:@[]];
  delegate.recoveryStatusLabel = [[NSTextField alloc] init];
  delegate.recoveryProgress = [[NSProgressIndicator alloc] init];
  delegate.recoveryRefreshButton = [[NSButton alloc] init];
  delegate.recoveryActionButtons = [NSMutableArray array];
  return delegate;
}

void WaitForBrokerRecovery(OwnerControlDelegate *delegate) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:0.5];
  while (delegate.brokerRecoveryInFlight && deadline.timeIntervalSinceNow > 0) {
    [[NSRunLoop mainRunLoop]
        runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.005]];
  }
}

int RunBrokerRecoverySmoke() {
  [NSApplication sharedApplication];
  BrokerRecoveryProbeConnection *recoveringBroker =
      [[BrokerRecoveryProbeConnection alloc] initWithRecoveryFailures:2];
  OwnerControlDelegate *recovered = BrokerRecoveryProbeDelegate(recoveringBroker);
  [recovered brokerDidDisconnect];
  BOOL immediateAuthorityClear = recovered.activeNote == nil &&
      recovered.noteEditorView.draft.length == 0 && recovered.libraryExpiresAt == nil &&
      recovered.ownerExpiresAt == nil && recovered.connections == nil;
  WaitForBrokerRecovery(recovered);
  NSSet<NSString *> *readOnlyRecoveryMethods = [NSSet setWithArray:@[
    @"recovery.status", @"lifecycle.status"
  ]];
  BOOL zeroMutationReplay = YES;
  for (NSString *method in recoveringBroker.requestedMethods) {
    zeroMutationReplay = zeroMutationReplay &&
        [readOnlyRecoveryMethods containsObject:method];
  }
  BOOL retriesWereBounded = recoveringBroker.replacementCount == 3 &&
      recoveringBroker.requestedMethods.count == 4 &&
      [recoveringBroker.requestedMethods.lastObject isEqualToString:@"lifecycle.status"];
  BOOL recoversUnauthenticated = !recovered.brokerRecoveryInFlight &&
      [recovered.recoveryState isEqualToString:@"ready"] &&
      recovered.libraryExpiresAt == nil && recovered.ownerExpiresAt == nil &&
      [recovered.surfaceSelector isEnabledForSegment:0] &&
      recovered.libraryAuthenticateButton.enabled &&
      [recovered.libraryStatusLabel.stringValue containsString:@"Authenticate"];

  BrokerRecoveryProbeConnection *lockedBroker =
      [[BrokerRecoveryProbeConnection alloc] initWithRecoveryFailures:0];
  lockedBroker.lifecycleState = @"locked";
  OwnerControlDelegate *locked = BrokerRecoveryProbeDelegate(lockedBroker);
  locked.surfaceSelector.selectedSegment =
      AfternoteNavigationSegmentForSurface(AfternoteProductSurfaceConnections);
  [locked brokerDidDisconnect];
  WaitForBrokerRecovery(locked);
  BOOL lockedVaultRemainsActionable = !locked.brokerRecoveryInFlight &&
      [locked.recoveryState isEqualToString:@"ready"] && locked.vaultLocked &&
      locked.surfaceSelector.selectedSegment == AfternoteNavigationSegmentForSurface(
          AfternoteProductSurfaceMemory) &&
      [locked.libraryAuthenticateButton.title isEqualToString:@"Unlock vault"];

  BrokerRecoveryProbeConnection *racingBroker =
      [[BrokerRecoveryProbeConnection alloc] initWithRecoveryFailures:0];
  OwnerControlDelegate *racing = BrokerRecoveryProbeDelegate(racingBroker);
  __weak OwnerControlDelegate *weakRacing = racing;
  racingBroker.afterLifecycleReply = ^{
    [weakRacing brokerDidDisconnect];
  };
  [racing brokerDidDisconnect];
  WaitForBrokerRecovery(racing);
  BOOL disconnectRaceRestartsRecovery = !racing.brokerRecoveryInFlight &&
      [racing.recoveryState isEqualToString:@"ready"] &&
      racingBroker.replacementCount == 2 &&
      racingBroker.requestedMethods.count == 4;

  BrokerRecoveryProbeConnection *freshGenerationBroker =
      [[BrokerRecoveryProbeConnection alloc] initWithRecoveryFailures:0];
  OwnerControlDelegate *freshGeneration =
      BrokerRecoveryProbeDelegate(freshGenerationBroker);
  freshGeneration.brokerRecoveryAttempt = 3;
  [freshGeneration brokerDidDisconnect];
  [freshGeneration brokerDidDisconnect];
  WaitForBrokerRecovery(freshGeneration);
  BOOL freshGenerationClearsStaleAttempt =
      !freshGeneration.brokerRecoveryInFlight &&
      [freshGeneration.recoveryState isEqualToString:@"ready"] &&
      freshGenerationBroker.replacementCount == 1 &&
      freshGenerationBroker.requestedMethods.count == 2;

  BrokerRecoveryProbeConnection *failingBroker =
      [[BrokerRecoveryProbeConnection alloc] initWithRecoveryFailures:NSUIntegerMax];
  OwnerControlDelegate *failed = BrokerRecoveryProbeDelegate(failingBroker);
  [failed brokerDidDisconnect];
  WaitForBrokerRecovery(failed);
  BOOL boundedFailure = !failed.brokerRecoveryInFlight &&
      failingBroker.replacementCount == 3 &&
      failingBroker.requestedMethods.count == 3 &&
      [failed.recoveryState isEqualToString:@"unavailable"] &&
      [failed.surfaceTabs.selectedTabViewItem.identifier isEqual:@"Recovery"];

  NSDictionary *output = @{
    @"boundedFailure" : @(boundedFailure),
    @"disconnectRaceRestartsRecovery" : @(disconnectRaceRestartsRecovery),
    @"freshGenerationClearsStaleAttempt" : @(freshGenerationClearsStaleAttempt),
    @"immediateAuthorityClear" : @(immediateAuthorityClear),
    @"lockedVaultRemainsActionable" : @(lockedVaultRemainsActionable),
    @"recoversUnauthenticated" : @(recoversUnauthenticated),
    @"retriesWereBounded" : @(retriesWereBounded),
    @"zeroMutationReplay" : @(zeroMutationReplay),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return boundedFailure && disconnectRaceRestartsRecovery &&
      freshGenerationClearsStaleAttempt &&
      immediateAuthorityClear && lockedVaultRemainsActionable &&
      recoversUnauthenticated && retriesWereBounded && zeroMutationReplay ? 0 : 2;
}

int RunSaveDestinationSmoke() {
  OwnerControlDelegate *delegate = [[OwnerControlDelegate alloc] init];
  NSString *directory = [NSTemporaryDirectory() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"afternote-save-panel-%@", NSUUID.UUID.UUIDString]];
  [NSFileManager.defaultManager createDirectoryAtPath:directory
                          withIntermediateDirectories:YES
                                           attributes:nil error:nil];
  NSString *existingPath = [directory stringByAppendingPathComponent:@"existing.json"];
  NSString *newPath = [directory stringByAppendingPathComponent:@"new.json"];
  [@"fixture" writeToFile:existingPath atomically:YES
                  encoding:NSUTF8StringEncoding error:nil];
  NSError *existingError = nil;
  BOOL existingPathRejected = ![delegate panel:nil
      validateURL:[NSURL fileURLWithPath:existingPath] error:&existingError];
  NSError *newError = nil;
  BOOL newPathAccepted = [delegate panel:nil
      validateURL:[NSURL fileURLWithPath:newPath] error:&newError];
  BOOL rejectionExplainsNoOverwrite =
      [existingError.localizedDescription containsString:@"never overwrites"];
  [NSFileManager.defaultManager removeItemAtPath:directory error:nil];
  NSDictionary *output = @{
    @"existingPathRejected" : @(existingPathRejected),
    @"newPathAccepted" : @(newPathAccepted && newError == nil),
    @"rejectionExplainsNoOverwrite" : @(rejectionExplainsNoOverwrite),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return existingPathRejected && newPathAccepted &&
      rejectionExplainsNoOverwrite ? 0 : 2;
}

int RunFormattingSmoke() {
  AfternoteListTransform *emptyList = AfternoteToggleList(
      @"", NSMakeRange(0, 0), AfternoteListStyleBullet);
  AfternoteListTransform *bulleted = AfternoteToggleList(
      @"alpha\nbeta", NSMakeRange(0, 10), AfternoteListStyleBullet);
  NSString *bulletedText = bulleted.text;
  AfternoteListTransform *numbered = AfternoteToggleList(
      bulletedText, NSMakeRange(0, bulletedText.length), AfternoteListStyleNumbered);
  NSString *numberedText = numbered.text;
  AfternoteListTransform *plain = AfternoteToggleList(
      numberedText, NSMakeRange(0, numberedText.length), AfternoteListStyleNumbered);
  AfternoteListTransform *checklist = AfternoteToggleList(
      @"pack cable\ncharge battery", NSMakeRange(0, 25), AfternoteListStyleChecklist);
  NSString *mixedSource = @"☐ task one\nplain thought\n- existing bullet";
  AfternoteListTransform *mixed = AfternoteToggleList(
      mixedSource, NSMakeRange(16, 0), AfternoteListStyleNumbered);
  NSString *indentSource = @"- first\n1. second\n☐ third\nplain";
  AfternoteListTransform *indented = AfternoteIndentList(
      indentSource, NSMakeRange(8, 19), NO);
  AfternoteListTransform *outdented = AfternoteIndentList(
      indented.text, indented.selection, YES);
  AfternoteListTransform *plainIndent = AfternoteIndentList(
      @"plain", NSMakeRange(2, 0), NO);
  NSString *tailSource = @"1. first\n2. second\n3. ";
  AfternoteListTransform *tailIndent = AfternoteIndentList(
      tailSource, NSMakeRange(tailSource.length, 0), NO);
  AfternoteListContinuation *bulletContinuation = AfternoteContinueList(
      @"- alpha", NSMakeRange(7, 0));
  AfternoteListContinuation *numberContinuation = AfternoteContinueList(
      @"9. alpha", NSMakeRange(8, 0));
  AfternoteListContinuation *exitList = AfternoteContinueList(@"- ", NSMakeRange(2, 0));
  AfternoteListContinuation *checklistContinuation = AfternoteContinueList(
      @"☑ pack cable", NSMakeRange(12, 0));
  AfternoteListContinuation *exitChecklist = AfternoteContinueList(
      @"☐ ", NSMakeRange(2, 0));
  BOOL togglesLists = [bulletedText isEqualToString:@"- alpha\n- beta"] &&
      [numberedText isEqualToString:@"1. alpha\n2. beta"] &&
      [plain.text isEqualToString:@"alpha\nbeta"];
  BOOL startsEmptyList = [emptyList.text isEqualToString:@"- "] &&
      emptyList.selection.location == 2 && emptyList.selection.length == 0;
  BOOL continuesLists = [bulletContinuation.replacement isEqualToString:@"\n- "] &&
      [numberContinuation.replacement isEqualToString:@"\n10. "] &&
      [checklistContinuation.replacement isEqualToString:@"\n☐ "];
  BOOL exitsEmptyList = [exitList.replacement isEqualToString:@"\n"] &&
      exitList.range.location == 0 && exitList.range.length == 2 &&
      [exitChecklist.replacement isEqualToString:@"\n"] &&
      exitChecklist.range.location == 0 && exitChecklist.range.length == 2;
  BOOL togglesChecklists = [checklist.text
      isEqualToString:@"☐ pack cable\n☐ charge battery"];
  BOOL preservesMixedLists = [mixed.text
      isEqualToString:@"☐ task one\n1. plain thought\n- existing bullet"];
  BOOL indentsSelectedListItems = [indented.text
      isEqualToString:@"- first\n\t1. second\n\t☐ third\nplain"];
  BOOL outdentsSelectedListItems = [outdented.text isEqualToString:indentSource];
  BOOL leavesPlainParagraphsAlone = plainIndent == nil;
  BOOL indentsListAtEndOfNote = [tailIndent.text
      isEqualToString:@"1. first\n2. second\n\t3. "];
  NSDictionary *output = @{
    @"togglesLists" : @(togglesLists),
    @"startsEmptyList" : @(startsEmptyList),
    @"continuesLists" : @(continuesLists),
    @"exitsEmptyList" : @(exitsEmptyList),
    @"togglesChecklists" : @(togglesChecklists),
    @"preservesMixedLists" : @(preservesMixedLists),
    @"indentsSelectedListItems" : @(indentsSelectedListItems),
    @"outdentsSelectedListItems" : @(outdentsSelectedListItems),
    @"leavesPlainParagraphsAlone" : @(leavesPlainParagraphsAlone),
    @"indentsListAtEndOfNote" : @(indentsListAtEndOfNote),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return startsEmptyList && togglesLists && togglesChecklists && preservesMixedLists &&
      continuesLists && exitsEmptyList && indentsSelectedListItems &&
      outdentsSelectedListItems && leavesPlainParagraphsAlone &&
      indentsListAtEndOfNote ? 0 : 2;
}

int RunLifecyclePeerInvalidationSmoke(BOOL expectFailure) {
  OwnerBrokerConnection *observer = NewOwnerBrokerConnection(ServiceName());
  OwnerBrokerConnection *locker = NewOwnerBrokerConnection(ServiceName());
  if (observer == nil || locker == nil) return 2;
  dispatch_semaphore_t disconnected = dispatch_semaphore_create(0);
  observer.disconnectHandler = ^{ dispatch_semaphore_signal(disconnected); };
  NSDictionary *observerStatus = nil;
  NSDictionary *observerError = nil;
  if (![observer requestSynchronouslyMethod:@"lifecycle.status" params:@{}
                                     result:&observerStatus error:&observerError] ||
      observerError != nil) return 2;

  NSDictionary *prior = nil;
  NSDictionary *lockResult = nil;
  NSDictionary *error = nil;
  if (![locker requestSynchronouslyMethod:@"lifecycle.status" params:@{}
                                   result:&prior error:&error] || error != nil) return 2;
  if (![locker requestSynchronouslyMethod:@"lifecycle.lock" params:@{}
                                   result:&lockResult error:&error]) return 2;
  BOOL observerInvalidated = dispatch_semaphore_wait(
      disconnected, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0;
  BOOL expectedOutcome = expectFailure
      ? [error[@"code"] isEqualToString:@"lifecycle_transition_failed"]
      : error == nil && AfternoteBrokerLifecycleTransitionIsValid(@"lifecycle.lock", prior, lockResult);
  NSDictionary *output = @{
    @"observerInvalidated" : @(observerInvalidated),
    @"prior" : observerStatus ?: @{},
    @"result" : lockResult ?: @{},
    @"error" : error ?: @{},
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return observerInvalidated && expectedOutcome ? 0 : 2;
}

int RunLibraryCleanupSmoke() {
  [NSApplication sharedApplication];
  OwnerControlDelegate *delegate = [[OwnerControlDelegate alloc] init];
  NSString *canary = [NSString stringWithFormat:@"PLAINTEXT-%@-%@", @"CLEANUP", @"CANARY"];
  delegate.revisionSummaries = @[ @{ @"revision" : @1, @"excerpt" : canary } ];
  [delegate.notesRetrieval selectQuery:canary view:nil];
  SeedNotesFixture(delegate.notesRetrieval, @[@{ @"excerpt" : canary }]);
  delegate.activeDeleteTarget = canary;
  delegate.activeNote = @{ @"id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                           @"revision" : @1, @"content" : canary };
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  delegate.librarySearch = [[NSSearchField alloc] init];
  delegate.librarySearch.stringValue = canary;
  delegate.noteTable = [[NSTableView alloc] init];
  delegate.noteEditorView = [[AfternoteNoteEditorView alloc] initWithActionTarget:delegate];
  [delegate renderActiveNote];
  [delegate.noteEditorView restoreDraft:canary];
  [FixtureEditorText(delegate.noteEditorView).undoManager registerUndoWithTarget:delegate handler:^(id target) {
    (void)target;
  }];
  delegate.libraryAuthenticateButton = [[NSButton alloc] init];
  delegate.libraryRecentButton = [[NSButton alloc] init];
  delegate.createNoteButton = [[NSButton alloc] init];
  delegate.loadMoreNotesButton = [[NSButton alloc] init];
  delegate.libraryStatusLabel = [[NSTextField alloc] init];
  delegate.libraryProgress = [[NSProgressIndicator alloc] init];
  NSButton *libraryViewButton = [[NSButton alloc] init];
  delegate.libraryViews = [NSStackView stackViewWithViews:@[ libraryViewButton ]];
  NSAlert *sensitiveAlert = [[NSAlert alloc] init];
  sensitiveAlert.messageText = @"Sensitive fixture";
  sensitiveAlert.informativeText = canary;
  NSTextView *sensitiveText = [[NSTextView alloc] init];
  sensitiveText.string = canary;
  delegate.librarySensitiveAlert = sensitiveAlert;
  delegate.librarySensitiveTextView = sensitiveText;
  delegate.surfaceSelector = [NSSegmentedControl
      segmentedControlWithLabels:@[ @"Notes", @"Connections" ]
                  trackingMode:NSSegmentSwitchTrackingSelectOne
                        target:nil action:nil];
  delegate.surfaceTabs = [[NSTabView alloc] init];
  for (NSString *label in @[ @"Notes", @"Connections", @"Recovery", @"Setup", @"Settings" ]) {
    NSTabViewItem *item = [[NSTabViewItem alloc] initWithIdentifier:label];
    item.label = label;
    [delegate.surfaceTabs addTabViewItem:item];
  }
  delegate.connectionsView = [[AfternoteConnectionsView alloc] initWithActionTarget:delegate];
  delegate.recoveryContent = [NSStackView stackViewWithViews:@[]];
  delegate.recoveryStatusLabel = [[NSTextField alloc] init];
  delegate.recoveryProgress = [[NSProgressIndicator alloc] init];
  delegate.recoveryRefreshButton = [[NSButton alloc] init];
  delegate.recoveryActionButtons = [NSMutableArray array];
  delegate.auditEvents = [NSMutableArray array];
  delegate.revocationTargets = [NSMutableDictionary dictionary];

  delegate.recoveryErrorMessage = @"Fixture recovery error remains visible";
  delegate.recoveryState = @"migration-manual-resume-required";
  [delegate renderRecoveryState];
  BOOL manualResumeRendered = delegate.recoveryContent.arrangedSubviews.count == 2 &&
      delegate.recoveryActionButtons.count == 0 &&
      [delegate.recoveryErrorMessage containsString:@"remains visible"];
  delegate.recoveryState = @"empty";
  delegate.recoveryOperationInFlight = YES;
  [delegate renderRecoveryState];
  [delegate setRecoveryBusy:NO status:@"Fixture operation in progress"];
  BOOL recoveryOperationSerialized = delegate.recoveryActionButtons.count == 2;
  for (NSButton *button in delegate.recoveryActionButtons) {
    recoveryOperationSerialized = recoveryOperationSerialized && !button.enabled;
  }
  NSUInteger staleRecoverySequence = delegate.recoveryStatusRequestSequence;
  __block BOOL staleRecoveryApplied = NO;
  delegate.recoveryStatusRequestSequence += 1;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (staleRecoverySequence != delegate.recoveryStatusRequestSequence) return;
    staleRecoveryApplied = YES;
  });
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  delegate.connections = @{ @"plaintextFixture" : canary };
  delegate.ownerExpiresAt = @"2099-01-01T00:00:00.000Z";
  delegate.activeNote = @{ @"content" : canary };
  [delegate.noteEditorView restoreDraft:canary];
  NSUInteger staleOwnerGeneration = delegate.ownerSessionGeneration;
  dispatch_semaphore_t staleOwnerQueued = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [delegate applyOwnerSessionResult:@{
      @"expiresAt" : @"2099-12-31T23:59:59.000Z"
    } error:nil generation:staleOwnerGeneration];
    dispatch_semaphore_signal(staleOwnerQueued);
  });
  dispatch_semaphore_wait(staleOwnerQueued,
                          dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC));
  NSButton *staleRevocationSender = [[NSButton alloc] init];
  dispatch_semaphore_t staleRevocationQueued = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [delegate applyRevocationResult:@{ @"revoked" : @YES } error:nil
                         generation:staleOwnerGeneration
                             sender:staleRevocationSender
                              label:@"Fixture client"];
    dispatch_semaphore_signal(staleRevocationQueued);
  });
  dispatch_semaphore_wait(staleRevocationQueued,
                          dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC));
  [delegate enterNonReadyRecoveryState:@"unavailable"
                                status:@"Fixture unavailable"
                               message:@"Fixture authority cleared"];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  BOOL nonReadyRecoveryClearedAuthority = delegate.connections == nil &&
      delegate.ownerExpiresAt == nil && delegate.activeNote == nil &&
      delegate.noteEditorView.draft.length == 0 &&
      ![delegate.surfaceSelector isEnabledForSegment:0] &&
      ![delegate.surfaceSelector isEnabledForSegment:1] &&
      delegate.surfaceSelector.selectedSegment == -1;
  BOOL staleOwnerReplyRejected = delegate.ownerExpiresAt == nil &&
      delegate.connections == nil;
  BOOL staleRevocationReplyRejected =
      ![((NSTextField *)ConnectionLayoutView(delegate.connectionsView, @"ConnectionsStatus")).stringValue containsString:@"Fixture client revoked"];
  BOOL recoveryErrorPersisted =
      [delegate.recoveryErrorMessage isEqualToString:@"Fixture recovery error remains visible"] &&
      delegate.recoveryContent.arrangedSubviews.count == 2;

  OwnerBrokerConnection *responseBroker = NewOwnerBrokerConnection(
      @"dev.afternote.invalid-response-fixture");
  NSArray<NSDictionary *> *malformedResponses = @[
    @{ @"method" : @"library.session.begin",
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{}}" },
    @{ @"method" : @"library.browse",
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"notes\":[\"not-a-note\"],\"nextCursor\":null}}" },
    @{ @"method" : @"library.get_note",
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"note\":{\"unexpected\":true},\"deleteTarget\":null}}" },
    @{ @"method" : @"library.views",
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":false,\"error\":{\"code\":\"invented\",\"message\":\"hostile\"}}" },
    @{ @"method" : @"library.views", @"response" : @"not-json" },
    @{ @"method" : @"admin.diagnostics",
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"format\":\"afternote-diagnostics\",\"schemaVersion\":1,\"generatedAt\":\"2026-08-28T12:00:00.000Z\",\"application\":{\"version\":\"2.0.0-test\",\"standalone\":true},\"system\":{\"osFamily\":\"darwin\",\"architecture\":\"arm64\"},\"runtime\":{\"status\":\"running\",\"apiVersion\":7,\"networkBoundary\":\"broker-only\"},\"vault\":{\"schemaVersion\":8,\"integrity\":\"ok\",\"noteCountBucket\":\"1-9\",\"revisionCountBucket\":\"1-9\",\"databaseBytesBucket\":\"under-1-mib\"},\"checks\":[{\"code\":\"runtime.running\",\"status\":\"ok\"},{\"code\":\"PLAINTEXT-CLEANUP-CANARY\",\"status\":\"failed\"}],\"errors\":[]}}" },
    @{ @"method" : @"admin.export",
       @"params" : @{ @"format" : @"json", @"destination" : @"/tmp/requested.json" },
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"exported\":true,\"destination\":\"/tmp/substituted.json\",\"format\":\"afternote-markdown-v1\"}}" },
    @{ @"method" : @"admin.prepare_client_rotation",
       @"params" : @{ @"kind" : @"codex", @"installIdentity" : @"11111111-1111-4111-8111-111111111111" },
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"prepared\":true,\"kind\":\"claude\",\"installIdentity\":\"11111111-1111-4111-8111-111111111111\",\"clientId\":\"22222222-2222-4222-8222-222222222222\"}}" },
    @{ @"method" : @"admin.prepare_client_rotation",
       @"params" : @{ @"kind" : @"codex", @"installIdentity" : @"11111111-1111-4111-8111-111111111111" },
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"prepared\":true,\"kind\":\"codex\",\"installIdentity\":\"33333333-3333-4333-8333-333333333333\",\"clientId\":\"22222222-2222-4222-8222-222222222222\"}}" },
    @{ @"method" : @"admin.prepare_client_rotation",
       @"params" : @{ @"kind" : @"codex", @"installIdentity" : @"11111111-1111-4111-8111-111111111111" },
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"prepared\":true,\"kind\":\"codex\",\"installIdentity\":\"11111111-1111-4111-8111-111111111111\",\"clientId\":\"22222222-2222-4222-8222-222222222222\",\"secret\":\"not-allowed\"}}" },
    @{ @"method" : @"lifecycle.lock",
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"state\":\"unlocked\",\"epoch\":\"11111111-1111-4111-8111-111111111111\"}}" },
    @{ @"method" : @"lifecycle.unlock",
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"state\":\"unlocked\",\"epoch\":\"11111111-1111-4111-8111-111111111111\",\"vaultPath\":\"/secret\"}}" },
    @{ @"method" : @"lifecycle.status",
       @"response" : @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"state\":\"unknown\",\"epoch\":\"not-an-epoch\"}}" },
  ];
  BOOL malformedResponseRejected = YES;
  for (NSDictionary *fixture in malformedResponses) {
    malformedResponseRejected = malformedResponseRejected &&
        [responseBroker testRejectsSerializedResponse:fixture[@"response"]
                                                method:fixture[@"method"]
                                                params:fixture[@"params"] ?: @{}];
  }
  NSDictionary *unlockedEpoch = @{
    @"state" : @"unlocked", @"epoch" : @"11111111-1111-4111-8111-111111111111"
  };
  NSDictionary *lockedSameEpoch = @{
    @"state" : @"locked", @"epoch" : @"11111111-1111-4111-8111-111111111111"
  };
  NSDictionary *lockedOtherEpoch = @{
    @"state" : @"locked", @"epoch" : @"22222222-2222-4222-8222-222222222222"
  };
  NSDictionary *unlockedRotatedEpoch = @{
    @"state" : @"unlocked", @"epoch" : @"22222222-2222-4222-8222-222222222222"
  };
  BOOL lifecycleEpochConsistency =
      AfternoteBrokerLifecycleTransitionIsValid(@"lifecycle.lock", unlockedEpoch, lockedSameEpoch) &&
      !AfternoteBrokerLifecycleTransitionIsValid(@"lifecycle.lock", unlockedEpoch, lockedOtherEpoch) &&
      AfternoteBrokerLifecycleTransitionIsValid(@"lifecycle.unlock", lockedSameEpoch,
                                      unlockedRotatedEpoch) &&
      !AfternoteBrokerLifecycleTransitionIsValid(@"lifecycle.unlock", lockedSameEpoch, unlockedEpoch);
  NSDictionary *validAuditEnvelope = @{
    @"protocolVersion" : @1,
    @"requestId" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"ok" : @YES,
    @"result" : @{
      @"events" : @[
        @{ @"eventId" : @"11111111-1111-4111-8111-111111111111",
           @"occurredAt" : @"2026-08-28T12:00:00.000Z",
           @"clientId" : @"native-library", @"clientKind" : NSNull.null,
           @"clientDisplayLabel" : @"Afternote Library", @"grantId" : @"native-library",
           @"sessionId" : @"22222222-2222-4222-8222-222222222222",
           @"operation" : @"library.browse", @"outcome" : @"success",
           @"errorCode" : NSNull.null,
           @"noteRefs" : @[ @{ @"noteId" : @"33333333-3333-4333-8333-333333333333",
                                @"revision" : @1 } ] },
        @{ @"eventId" : @"44444444-4444-4444-8444-444444444444",
           @"occurredAt" : @"2026-08-28T12:01:00.000Z",
           @"clientId" : @"owner", @"clientKind" : NSNull.null,
           @"clientDisplayLabel" : @"Owner", @"grantId" : NSNull.null,
           @"sessionId" : NSNull.null, @"operation" : @"audit.prune",
           @"outcome" : @"success", @"errorCode" : NSNull.null, @"noteRefs" : @[] },
        @{ @"eventId" : @"55555555-5555-4555-8555-555555555555",
           @"occurredAt" : @"2026-08-28T12:02:00.000Z",
           @"clientId" : @"pending:66666666-6666-4666-8666-666666666666",
           @"clientKind" : NSNull.null, @"clientDisplayLabel" : @"Pending client",
           @"grantId" : NSNull.null, @"sessionId" : NSNull.null,
           @"operation" : @"client.pair", @"outcome" : @"denied",
           @"errorCode" : @"owner_denied", @"noteRefs" : @[] },
      ],
      @"nextCursor" : NSNull.null,
    },
  };
  NSData *validAuditData = [NSJSONSerialization dataWithJSONObject:validAuditEnvelope options:0 error:nil];
  NSString *validAuditResponse = [[NSString alloc] initWithData:validAuditData encoding:NSUTF8StringEncoding];
  BOOL validReservedAuditAccepted = [responseBroker
      testAcceptsSerializedResponse:validAuditResponse method:@"owner.inspect_audit" params:@{}];
  NSArray *validAuditEvents = validAuditEnvelope[@"result"][@"events"];
  NSMutableDictionary *misattributedOwner = [validAuditEvents[1] mutableCopy];
  misattributedOwner[@"clientKind"] = @"codex";
  misattributedOwner[@"clientDisplayLabel"] = @"Codex";
  misattributedOwner[@"grantId"] = @"native-library";
  NSMutableDictionary *misattributedPending = [validAuditEvents[2] mutableCopy];
  misattributedPending[@"sessionId"] = @"22222222-2222-4222-8222-222222222222";
  BOOL malformedAuditRelationshipsRejected = YES;
  for (NSDictionary *event in @[ misattributedOwner, misattributedPending ]) {
    NSDictionary *envelope = @{
      @"protocolVersion" : @1,
      @"requestId" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      @"ok" : @YES,
      @"result" : @{ @"events" : @[ event ], @"nextCursor" : NSNull.null },
    };
    NSData *fixtureData = [NSJSONSerialization dataWithJSONObject:envelope options:0 error:nil];
    NSString *fixtureResponse = [[NSString alloc] initWithData:fixtureData encoding:NSUTF8StringEncoding];
    malformedAuditRelationshipsRejected = malformedAuditRelationshipsRejected &&
        [responseBroker testRejectsSerializedResponse:fixtureResponse
                                                method:@"owner.inspect_audit" params:@{}];
  }

  delegate.activeNote = @{ @"content" : canary };
  [delegate.noteEditorView restoreDraft:canary];
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  __weak OwnerControlDelegate *weakDelegate = delegate;
  responseBroker.disconnectHandler = ^{
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakDelegate clearLibraryPlaintext:@"The broker connection was replaced after an invalid response."];
    });
  };
  BOOL malformedOwnerRejected = [responseBroker testRejectsSerializedResponse:
      @"{\"protocolVersion\":1,\"requestId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"ok\":true,\"result\":{\"events\":[\"bad\"],\"nextCursor\":null}}"
      method:@"owner.inspect_audit" params:@{}];
  NSDate *crossSurfaceDeadline = [NSDate dateWithTimeIntervalSinceNow:0.2];
  while ((delegate.activeNote != nil || delegate.noteEditorView.draft.length > 0 ||
          delegate.libraryExpiresAt != nil) && [crossSurfaceDeadline timeIntervalSinceNow] > 0) {
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  BOOL crossSurfaceMalformedOwnerCleared = malformedOwnerRejected &&
      delegate.activeNote == nil && delegate.noteEditorView.draft.length == 0 &&
      delegate.libraryExpiresAt == nil;

  NSUInteger staleGeneration = delegate.librarySessionGeneration;
  __block BOOL staleReplyApplied = NO;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (staleGeneration != delegate.librarySessionGeneration) return;
    staleReplyApplied = YES;
    delegate.activeNote = @{ @"content" : canary };
  });
  [delegate clearLibraryPlaintext:@"Broker disconnected"];
  [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  BOOL disconnectCleared = delegate.activeNote == nil &&
      delegate.notesRetrieval.notes.count == 0 && delegate.revisionSummaries.count == 0 &&
      delegate.notesRetrieval.query.length == 0 && delegate.notesRetrieval.view == nil &&
      delegate.activeDeleteTarget == nil && delegate.noteEditorView.draft.length == 0 &&
      delegate.librarySearch.stringValue.length == 0 &&
      !FixtureEditorText(delegate.noteEditorView).undoManager.canUndo && !staleReplyApplied &&
      !delegate.libraryRecentButton.enabled && !libraryViewButton.enabled;
  BOOL sensitiveSheetCleared = delegate.librarySensitiveAlert == nil &&
      delegate.librarySensitiveTextView == nil && sensitiveText.string.length == 0 &&
      ![sensitiveAlert.informativeText containsString:canary];

  delegate.activeNote = @{ @"content" : canary };
  [delegate.noteEditorView restoreDraft:canary];
  [delegate clearLibraryPlaintext:@"Library session expired"];
  BOOL expiryCleared = delegate.activeNote == nil && delegate.noteEditorView.draft.length == 0;
  BOOL protocolInvalidationCleared = YES;
  BOOL lockedResponseFeedback = NO;
  for (NSString *code in @[
    @"invalid_request", @"invalid_cursor", @"invalid_response",
    @"replayed", @"identity_mismatch", @"vault_locked"
  ]) {
    delegate.activeNote = @{ @"content" : canary };
    [delegate.noteEditorView restoreDraft:canary];
    delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
    NSUInteger priorGeneration = delegate.librarySessionGeneration;
    [delegate showLibraryError:@{ @"code" : code }];
    protocolInvalidationCleared = protocolInvalidationCleared &&
        delegate.librarySessionGeneration == priorGeneration + 1 &&
        delegate.activeNote == nil && delegate.noteEditorView.draft.length == 0 &&
        delegate.libraryExpiresAt == nil;
    if ([code isEqualToString:@"vault_locked"]) {
      lockedResponseFeedback = delegate.vaultLocked &&
          delegate.libraryAuthenticateButton.enabled &&
          [delegate.libraryAuthenticateButton.title isEqualToString:@"Unlock vault"] &&
          [delegate.libraryStatusLabel.stringValue containsString:@"Unlock it here"];
    }
  }
  [delegate vaultDidLock:nil];
  BOOL lockedLibraryFeedback = delegate.vaultLocked &&
      delegate.libraryAuthenticateButton.enabled &&
      [delegate.libraryAuthenticateButton.title isEqualToString:@"Unlock vault"] &&
      [delegate.libraryStatusLabel.stringValue containsString:@"Unlock it here"];
  [delegate vaultDidUnlock:nil];
  BOOL spoofedUnlockRemainsLocked = delegate.vaultLocked;
  NSUInteger staleLifecycleStatusSequence = delegate.lifecycleStatusRequestSequence;
  [delegate vaultDidLock:nil];
  [delegate applyVaultLifecycleStatus:@{ @"state" : @"unlocked",
                                          @"epoch" : @"22222222-2222-4222-8222-222222222222" }
                                error:nil
                      requestSequence:staleLifecycleStatusSequence];
  BOOL staleLifecycleStatusIgnored = delegate.vaultLocked;
  [delegate vaultDidUnlock:nil];
  NSUInteger lifecycleErrorSequence = delegate.lifecycleStatusRequestSequence;
  [delegate applyVaultLifecycleStatus:nil
                                error:@{ @"code" : @"unavailable", @"message" : @"fixture" }
                      requestSequence:lifecycleErrorSequence];
  BOOL lifecycleStatusErrorRemainsLocked = delegate.vaultLocked;
  [delegate vaultDidUnlock:nil];
  NSUInteger malformedLifecycleSequence = delegate.lifecycleStatusRequestSequence;
  [delegate applyVaultLifecycleStatus:@{ @"state" : @"unlocked",
                                          @"epoch" : @"22222222-2222-4222-8222-222222222222",
                                          @"extra" : @YES }
                                error:nil
                      requestSequence:malformedLifecycleSequence];
  BOOL malformedLifecycleStatusRemainsLocked = delegate.vaultLocked;
  [delegate vaultDidUnlock:nil];
  NSUInteger validLifecycleSequence = delegate.lifecycleStatusRequestSequence;
  [delegate applyVaultLifecycleStatus:@{ @"state" : @"unlocked",
                                          @"epoch" : @"22222222-2222-4222-8222-222222222222" }
                                error:nil
                      requestSequence:validLifecycleSequence];
  BOOL unlockedLibraryFeedback = !delegate.vaultLocked &&
      delegate.libraryAuthenticateButton.enabled &&
      [delegate.libraryAuthenticateButton.title isEqualToString:@"Authenticate & Open"] &&
      [delegate.libraryStatusLabel.stringValue containsString:@"vault is unlocked"];
  BOOL processArgumentsPlaintext = [[NSProcessInfo.processInfo.arguments componentsJoinedByString:@"\n"] containsString:canary];
  NSData *plistData = [NSJSONSerialization dataWithJSONObject:NSBundle.mainBundle.infoDictionary ?: @{}
                                                       options:0 error:nil];
  BOOL bundlePlistPlaintext = plistData != nil &&
      [plistData rangeOfData:[canary dataUsingEncoding:NSUTF8StringEncoding]
                     options:0 range:NSMakeRange(0, plistData.length)].location != NSNotFound;
  BOOL statusPlaintext = [delegate.libraryStatusLabel.stringValue containsString:canary];
  NSMutableDictionary *output = [@{
    @"disconnectCleared" : @(disconnectCleared),
    @"expiryCleared" : @(expiryCleared),
    @"protocolInvalidationCleared" : @(protocolInvalidationCleared),
    @"malformedResponseRejected" : @(malformedResponseRejected),
    @"lifecycleEpochConsistency" : @(lifecycleEpochConsistency),
    @"validReservedAuditAccepted" : @(validReservedAuditAccepted),
    @"malformedAuditRelationshipsRejected" : @(malformedAuditRelationshipsRejected),
    @"lockedLibraryFeedback" : @(lockedLibraryFeedback),
    @"lockedResponseFeedback" : @(lockedResponseFeedback),
    @"lifecycleStatusErrorRemainsLocked" : @(lifecycleStatusErrorRemainsLocked),
    @"malformedLifecycleStatusRemainsLocked" : @(malformedLifecycleStatusRemainsLocked),
    @"crossSurfaceMalformedOwnerCleared" : @(crossSurfaceMalformedOwnerCleared),
    @"sensitiveSheetCleared" : @(sensitiveSheetCleared),
    @"staleReplyRejected" : @(!staleReplyApplied),
    @"undoHistoryCleared" : @(!FixtureEditorText(delegate.noteEditorView).undoManager.canUndo),
    @"processArgumentsPlaintext" : @(processArgumentsPlaintext),
    @"bundlePlistPlaintext" : @(bundlePlistPlaintext),
    @"statusPlaintext" : @(statusPlaintext),
    @"spoofedUnlockRemainsLocked" : @(spoofedUnlockRemainsLocked),
    @"staleLifecycleStatusIgnored" : @(staleLifecycleStatusIgnored),
    @"unlockedLibraryFeedback" : @(unlockedLibraryFeedback),
    @"manualResumeRendered" : @(manualResumeRendered),
    @"recoveryOperationSerialized" : @(recoveryOperationSerialized),
    @"staleRecoveryReplyRejected" : @(!staleRecoveryApplied),
    @"staleOwnerReplyRejected" : @(staleOwnerReplyRejected),
    @"staleRevocationReplyRejected" : @(staleRevocationReplyRejected),
    @"nonReadyRecoveryClearedAuthority" : @(nonReadyRecoveryClearedAuthority),
    @"recoveryErrorPersisted" : @(recoveryErrorPersisted),
  } mutableCopy];
  NSData *candidate = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  BOOL serializedPlaintext = [candidate rangeOfData:[canary dataUsingEncoding:NSUTF8StringEncoding]
                                            options:0 range:NSMakeRange(0, candidate.length)].location != NSNotFound;
  output[@"serializedPlaintext"] = @(serializedPlaintext);
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return disconnectCleared && expiryCleared && protocolInvalidationCleared &&
      malformedResponseRejected && lifecycleEpochConsistency &&
      validReservedAuditAccepted && malformedAuditRelationshipsRejected &&
      lockedLibraryFeedback && lockedResponseFeedback &&
      lifecycleStatusErrorRemainsLocked && malformedLifecycleStatusRemainsLocked &&
      spoofedUnlockRemainsLocked && staleLifecycleStatusIgnored &&
      unlockedLibraryFeedback &&
      manualResumeRendered && recoveryOperationSerialized &&
      !staleRecoveryApplied && staleOwnerReplyRejected &&
      staleRevocationReplyRejected &&
      nonReadyRecoveryClearedAuthority &&
      recoveryErrorPersisted &&
      crossSurfaceMalformedOwnerCleared &&
      sensitiveSheetCleared && !staleReplyApplied &&
      !processArgumentsPlaintext && !bundlePlistPlaintext && !statusPlaintext &&
      !serializedPlaintext ? 0 : 2;
}

// Real OwnerBrokerConnection -> XPC gateway -> encrypted worker. Available only
// in the isolated test executable; owner approval is simulated by its test gateway.
int RunOwnerControlPollingSmoke(BOOL locked) {
  OwnerBrokerConnection *broker = NewOwnerBrokerConnection(ServiceName());
  auto request = ^NSDictionary *(NSString *method, NSDictionary *params) {
    NSDictionary *result = nil;
    NSDictionary *error = nil;
    if (![broker requestSynchronouslyMethod:method params:params result:&result error:&error]) {
      fprintf(stderr, "%s: %s\n", method.UTF8String, error.description.UTF8String);
      return (NSDictionary *)nil;
    }
    return result;
  };
  NSDictionary *sessionParams = @{ @"requestedScopes" : @[ @"library.browse", @"library.search" ], @"ttlMs" : @900000 };
  if (locked) {
    if (request(@"lifecycle.lock", @{}) == nil) return 2;
  } else if (request(@"library.session.begin", sessionParams) == nil) return 2;
  for (NSUInteger poll = 0; poll < 2048; poll++) {
    if (request(locked ? @"lifecycle.status" : @"library.refresh_search",
                locked ? @{} : @{ @"reloadModel" : @NO }) == nil) return 2;
  }
  if (locked) {
    if (request(@"lifecycle.unlock", @{}) == nil ||
        request(@"library.session.begin", sessionParams) == nil) return 2;
  }
  NSDictionary *notes = request(@"library.browse", @{ @"view" : NSNull.null, @"limit" : @20, @"cursor" : NSNull.null });
  if (notes == nil) return 2;
  if (!locked) {
    if (request(@"owner.connector_overview", @{}) == nil ||
        request(@"owner.revoke_connector", @{ @"kind" : @"codex" }) == nil) return 2;
  }
  NSDictionary *output = @{ @"polls" : @2048, @"unlockedAfterPolling" : @(locked),
                            @"revokedAfterPolling" : @(!locked), @"library" : notes };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return 0;
}

// Wait through real gateway idle periods; direct worker fixtures cannot cover this.
int RunOwnerControlSemanticStartupSmoke() {
  OwnerBrokerConnection *broker = NewOwnerBrokerConnection(ServiceName());
  auto request = ^NSDictionary *(NSString *method, NSDictionary *params) {
    NSDictionary *result = nil, *error = nil;
    if (![broker requestSynchronouslyMethod:method params:params result:&result error:&error]) {
      fprintf(stderr, "%s: %s\n", method.UTF8String, error.description.UTF8String);
      return (NSDictionary *)nil;
    }
    return result;
  };
  NSDictionary *session = @{ @"requestedScopes": @[@"library.browse", @"library.search"], @"ttlMs": @900000 };
  if (request(@"library.session.begin", session) == nil ||
      request(@"library.refresh_search", @{@"reloadModel": @YES}) == nil) return 2;
  // A query awaits background work, establishing persisted embeddings first.
  if (request(@"library.search", @{@"query": @"quartz unmatched paraphrase", @"limit": @5, @"cursor": NSNull.null}) == nil) return 2;
  NSDictionary *before = nil;
  for (NSUInteger i = 0; i < 100; i++) {
    before = request(@"library.refresh_search", @{@"reloadModel": @NO});
    if ([before[@"searchMode"] isEqual:@"hybrid"]) break;
    [NSThread sleepForTimeInterval:0.1];
  }
  if (![before[@"searchMode"] isEqual:@"hybrid"] || [before[@"totalNotes"] integerValue] < 1) return 2;
  if (request(@"lifecycle.lock", @{}) == nil || request(@"lifecycle.unlock", @{}) == nil) return 2;
  NSDictionary *opened = request(@"library.session.begin", session);
  if (opened == nil) return 2;
  [NSApplication sharedApplication];
  OwnerControlDelegate *delegate = [OwnerControlDelegate new];
  [delegate buildWindow];
  delegate.broker = broker;
  delegate.libraryExpiresAt = opened[@"expiresAt"];
  [delegate applySearchMode:opened[@"searchMode"]];
  [delegate refreshSemanticSearch:NO userInitiated:NO];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
  while ((![delegate.currentSearchMode isEqual:@"hybrid"] || delegate.semanticActivationInFlight ||
          delegate.semanticIndexedNotes < 0) && deadline.timeIntervalSinceNow > 0)
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
  BOOL ready = [delegate.currentSearchMode isEqual:@"hybrid"];
  BOOL reused = delegate.semanticIndexedNotes == [before[@"indexedNotes"] integerValue] &&
      delegate.semanticTotalNotes == [before[@"totalNotes"] integerValue];
  BOOL uiReady = [delegate.searchProgress.titleLabel.stringValue isEqual:@"Search by meaning ready"] &&
      delegate.searchProgress.progressBar.hidden && !delegate.semanticPollPending;
  NSDictionary *output = @{@"readyAfterIdleReopen": @(ready), @"preservedIndex": @(reused), @"uiReady": @(uiReady),
      @"status": @{ @"searchMode": delegate.currentSearchMode ?: @"", @"indexedNotes": @(delegate.semanticIndexedNotes),
                     @"totalNotes": @(delegate.semanticTotalNotes) }};
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  return ready && reused && uiReady ? 0 : 2;
}

int RunProtocolSmoke() {
  OwnerBrokerConnection *broker = NewOwnerBrokerConnection(ServiceName());
  if (broker == nil) return 2;
  NSDictionary *connectorOverview = nil;
  NSDictionary *connectorOverviewError = nil;
  if (![broker requestSynchronouslyMethod:@"owner.connector_overview" params:@{}
                                   result:&connectorOverview
                                    error:&connectorOverviewError] ||
      connectorOverviewError != nil) {
    fputs("connector overview failed\n", stderr);
    return 2;
  }
  __block NSDictionary *sessionResult = nil;
  __block NSDictionary *sessionError = nil;
  dispatch_semaphore_t first = dispatch_semaphore_create(0);
  [broker requestMethod:@"owner.session.begin"
                 params:@{
                   @"requestedScopes" : @[
                     @"owner.inspect_clients", @"owner.inspect_grants",
                     @"owner.inspect_sessions", @"owner.inspect_audit"
                   ],
                   @"ttlMs" : @300000,
                 }
                  reply:^(NSDictionary *result, NSDictionary *error) {
    sessionResult = result;
    sessionError = error;
    dispatch_semaphore_signal(first);
  }];
  if (dispatch_semaphore_wait(
          first, dispatch_time(DISPATCH_TIME_NOW, 125 * NSEC_PER_SEC)) != 0) {
    fputs("owner session timed out\n", stderr);
    return 2;
  }
  if (sessionError != nil) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:sessionError options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stderr);
    fputc('\n', stderr);
    return 2;
  }
  __block NSDictionary *snapshot = nil;
  __block NSDictionary *snapshotError = nil;
  dispatch_semaphore_t second = dispatch_semaphore_create(0);
  [broker requestMethod:@"owner.inspect_connections" params:@{} reply:^(NSDictionary *result, NSDictionary *error) {
    snapshot = result;
    snapshotError = error;
    dispatch_semaphore_signal(second);
  }];
  if (dispatch_semaphore_wait(
          second, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0 ||
      snapshotError != nil) {
    fputs("owner inspection failed\n", stderr);
    return 2;
  }
  __block NSDictionary *librarySession = nil;
  __block NSDictionary *librarySessionError = nil;
  dispatch_semaphore_t third = dispatch_semaphore_create(0);
  [broker requestMethod:@"library.session.begin"
                 params:@{
                   @"requestedScopes" : @[
                     @"library.browse", @"library.search", @"library.get_note",
                     @"library.list_revisions", @"library.inspect_source",
                     @"library.remember", @"library.update_note"
                   ],
                   @"ttlMs" : @900000,
                 }
                  reply:^(NSDictionary *result, NSDictionary *error) {
    librarySession = result;
    librarySessionError = error;
    dispatch_semaphore_signal(third);
  }];
  if (dispatch_semaphore_wait(
          third, dispatch_time(DISPATCH_TIME_NOW, 125 * NSEC_PER_SEC)) != 0 ||
      librarySessionError != nil) {
    fputs("library session failed\n", stderr);
    return 2;
  }
  __block NSDictionary *libraryViews = nil;
  __block NSDictionary *libraryViewsError = nil;
  dispatch_semaphore_t libraryViewsReply = dispatch_semaphore_create(0);
  [broker requestMethod:@"library.views"
                 params:@{}
                  reply:^(NSDictionary *result, NSDictionary *error) {
    libraryViews = result;
    libraryViewsError = error;
    dispatch_semaphore_signal(libraryViewsReply);
  }];
  if (dispatch_semaphore_wait(
          libraryViewsReply, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0 ||
      libraryViewsError != nil) {
    fputs("library views failed\n", stderr);
    return 2;
  }
  __block NSDictionary *libraryPage = nil;
  __block NSDictionary *libraryPageError = nil;
  dispatch_semaphore_t libraryBrowseReply = dispatch_semaphore_create(0);
  [broker requestMethod:@"library.browse"
                 params:@{ @"view" : NSNull.null, @"limit" : @20, @"cursor" : NSNull.null }
                  reply:^(NSDictionary *result, NSDictionary *error) {
    libraryPage = result;
    libraryPageError = error;
    dispatch_semaphore_signal(libraryBrowseReply);
  }];
  if (dispatch_semaphore_wait(
          libraryBrowseReply, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) != 0 ||
      libraryPageError != nil) {
    fputs("library browse failed\n", stderr);
    return 2;
  }
  NSDictionary *output = @{
    @"connectorOverview" : connectorOverview ?: @{},
    @"session" : sessionResult ?: @{},
    @"connections" : snapshot ?: @{},
    @"librarySession" : librarySession ?: @{},
    @"libraryViews" : libraryViews ?: @{},
    @"library" : libraryPage ?: @{},
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return 0;
}

int RunDiagnosticContractSmoke(const char *path) {
  NSData *data = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:path]];
  if (data == nil) {
    fputs("diagnostic fixture could not be read\n", stderr);
    return 2;
  }
  NSError *error = nil;
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
  if (error != nil || ![value isKindOfClass:[NSDictionary class]]) {
    fputs("diagnostic fixture was not a JSON object\n", stderr);
    return 2;
  }
  NSDictionary *output = @{ @"accepted" : @(AfternoteBrokerResultIsValid(@"admin.diagnostics", value, @{})) };
  NSData *encoded = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(encoded.bytes, 1, encoded.length, stdout);
  fputc('\n', stdout);
  return 0;
}
#endif


int main(int argc, const char *argv[]) {
  @autoreleasepool {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
    if (argc == 2 && strcmp(argv[1], "--semantic-startup-smoke") == 0) return RunOwnerControlSemanticStartupSmoke();
    if (argc == 2 && strcmp(argv[1], "--owner-polling-smoke") == 0) return RunOwnerControlPollingSmoke(NO);
    if (argc == 2 && strcmp(argv[1], "--owner-locked-polling-smoke") == 0) return RunOwnerControlPollingSmoke(YES);
    if (argc == 2 && strcmp(argv[1], "--semantic-progress-smoke") == 0) {
      return RunSemanticProgressSmoke();
    }
    if (argc == 2 && strcmp(argv[1], "--semantic-coordinator-smoke") == 0) {
      return RunSemanticCoordinatorSmoke();
    }
    if (argc == 2 && strcmp(argv[1], "--notes-retrieval-smoke") == 0) {
      return RunNotesRetrievalCoordinatorSmoke();
    }
    if (argc == 2 && strcmp(argv[1], "--reconnect-coordinator-smoke") == 0) {
      return RunReconnectCoordinatorSmoke();
    }
    if ((argc == 2 || argc == 3) && strcmp(argv[1], "--connections-layout-smoke") == 0) {
      return RunConnectionsLayoutSmoke(argc == 3
          ? [NSString stringWithUTF8String:argv[2]] : nil);
    }
#endif
    if (argc >= 2 && strncmp(argv[1], "--admin-", strlen("--admin-")) == 0) {
      return RunAdminCommand(argc, argv);
    }
    if (argc == 2 && strcmp(argv[1], "--accessibility-contract") == 0) {
      NSDictionary *contract = @{
        @"applicationIdentifier" : @"dev.afternote.owner-control",
        @"appearanceMode" : @"dark",
        @"gatewayIdentityPinned" : @YES,
        @"surfaces" : @[ @"Notes", @"Connections", @"Settings" ],
        @"setupGuide" : @"dismissible-and-restorable",
        @"conditionalRecovery" : @YES,
        @"connectorDetailsAlwaysVisible" : @YES,
        @"connectorHistoryInline" : @YES,
        @"connectorHistoryLifecycleOnly" : @YES,
        @"connectorHistoryStartsCollapsed" : @YES,
        @"ownerPresenceMode" : OwnerPresenceMode(),
        @"keyboardOperable" : @YES,
        @"visibleFocus" : @YES,
        @"statusUsesText" : @YES,
        @"voiceOverLabels" : @YES,
        @"revocationNamesTargetAndScopes" : @YES,
        @"nativeNoteControls" : @YES,
        @"plainTextEditor" : @YES,
        @"plainTextListFormatting" : @YES,
        @"noteStateRestoration" : @NO,
        @"plaintextClearsOnDisconnectOrExpiry" : @YES,
        @"deleteNamesExactTargetAndRevision" : @YES,
        @"privilegedLoopbackEndpoints" : @[],
      };
      NSData *data = [NSJSONSerialization dataWithJSONObject:contract options:0 error:nil];
      fwrite(data.bytes, 1, data.length, stdout);
      fputc('\n', stdout);
      return 0;
    }
    if (argc == 2 && strcmp(argv[1], "--protocol-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunProtocolSmoke();
#else
      fputs("protocol smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--library-cleanup-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunLibraryCleanupSmoke();
#else
      fputs("library cleanup smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--formatting-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunFormattingSmoke();
#else
      fputs("formatting smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--connector-history-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunConnectorHistorySmoke();
#else
      fputs("connector history smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--library-search-submission-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunLibrarySearchSubmissionSmoke();
#else
      fputs("library search submission smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--revision-navigation-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunRevisionNavigationSmoke();
#else
      fputs("revision navigation smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--citation-inspector-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunCitationInspectorSmoke();
#else
      fputs("citation inspector smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 3 && strcmp(argv[1], "--integration-command-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunIntegrationCommandSmoke(argc, argv);
#else
      fputs("integration command smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--integration-generation-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunIntegrationGenerationSmoke();
#else
      fputs("integration generation smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--broker-recovery-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunBrokerRecoverySmoke();
#else
      fputs("broker recovery smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--save-destination-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunSaveDestinationSmoke();
#else
      fputs("save destination smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 3 && strcmp(argv[1], "--diagnostic-contract-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunDiagnosticContractSmoke(argv[2]);
#else
      fputs("diagnostic contract smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--lifecycle-peer-invalidation-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunLifecyclePeerInvalidationSmoke(NO);
#else
      fputs("lifecycle invalidation smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    if (argc == 2 && strcmp(argv[1], "--lifecycle-teardown-failure-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunLifecyclePeerInvalidationSmoke(YES);
#else
      fputs("lifecycle failure smoke is unavailable in packaged builds\n", stderr);
      return 64;
#endif
    }
    BOOL renderingPreview = NO;
    for (int index = 1; index < argc; index++) {
      if (strcmp(argv[index], "--render-preview") == 0) {
        renderingPreview = YES;
        break;
      }
    }
    NSApplication *application = [NSApplication sharedApplication];
    application.activationPolicy = renderingPreview
        ? NSApplicationActivationPolicyProhibited
        : NSApplicationActivationPolicyRegular;
    if (!renderingPreview) {
      NSString *installationError = nil;
      if (!AfternoteEnsureRuntimeInstalled(&installationError)) {
        NSAlert *alert = [[NSAlert alloc] init];
        alert.messageText = @"Afternote could not finish setup";
        alert.informativeText = installationError ?: @"Move Afternote to Applications and try again.";
        [alert addButtonWithTitle:@"Quit"];
        [alert runModal];
        return 1;
      }
    }
    InstallApplicationMenu(application);
    OwnerControlDelegate *delegate = [[OwnerControlDelegate alloc] init];
    application.delegate = delegate;
    [application run];
  }
  return 0;
}
