#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#import "plain_text_list_formatting.h"
#import "broker_recovery_state.h"
#import "connector_presentation.h"
#import "note_editor_state.h"
#import "owner_broker.h"
#import "product_surface_router.h"
#import "setup_guide_state.h"
#import "application_installation.h"

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
constexpr int64_t kRoutineAuthenticationFifteenMinutesMilliseconds =
    15 * 60 * 1000;
constexpr int64_t kRoutineAuthenticationFourHoursMilliseconds =
    4 * 60 * 60 * 1000;
constexpr int64_t kRoutineAuthenticationDailyMilliseconds =
    24 * 60 * 60 * 1000;
typedef NS_ENUM(NSInteger, AfternoteLibraryMode) {
  AfternoteLibraryModeWrite = 0,
  AfternoteLibraryModeAsk = 1,
  AfternoteLibraryModeBrowse = 2,
};

constexpr NSInteger kMemoryTabIndex = 0;
constexpr NSInteger kConnectionsTabIndex = 1;
constexpr NSInteger kRecoveryTabIndex = 2;
constexpr NSInteger kSetupTabIndex = 3;
constexpr NSInteger kSettingsTabIndex = 4;

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
  NSTimeInterval timeoutSeconds = kIntegrationCommandTimeoutSeconds;
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

NSDate *DateValue(id value) {
  NSString *text = StringValue(value);
  if (text.length == 0) return nil;
  static NSDateFormatter *input;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    input = [[NSDateFormatter alloc] init];
    input.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
    input.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX";
  });
  return [input dateFromString:text];
}

NSString *DateLabel(id value) {
  NSString *text = StringValue(value);
  if (text.length == 0) return @"Never";
  static NSDateFormatter *output;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    output = [[NSDateFormatter alloc] init];
    output.dateStyle = NSDateFormatterMediumStyle;
    output.timeStyle = NSDateFormatterShortStyle;
  });
  NSDate *date = DateValue(text);
  return date == nil ? @"Unavailable" : [output stringFromDate:date];
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

NSColor *StatusColor(NSString *status) {
  if ([status isEqualToString:@"active"] || [status isEqualToString:@"paired"] ||
      [status isEqualToString:@"ready"] || [status isEqualToString:@"installed"] ||
      [status isEqualToString:@"success"]) {
    return [NSColor colorWithSRGBRed:0.41 green:0.79 blue:0.60 alpha:1.0];
  }
  if ([status isEqualToString:@"revoked"] || [status isEqualToString:@"denied"] ||
      [status isEqualToString:@"error"]) {
    return [NSColor colorWithSRGBRed:0.88 green:0.44 blue:0.42 alpha:1.0];
  }
  return [NSColor colorWithSRGBRed:0.84 green:0.66 blue:0.37 alpha:1.0];
}

NSColor *AfternoteCanvasColor() {
  return [NSColor colorWithSRGBRed:0.043 green:0.051 blue:0.055 alpha:1.0];
}

NSColor *AfternoteSidebarColor() {
  return [NSColor colorWithSRGBRed:0.055 green:0.063 blue:0.067 alpha:1.0];
}

NSColor *AfternoteSurfaceColor() {
  return [NSColor colorWithSRGBRed:0.078 green:0.086 blue:0.094 alpha:1.0];
}

NSColor *AfternoteRaisedSurfaceColor() {
  return [NSColor colorWithSRGBRed:0.110 green:0.118 blue:0.129 alpha:1.0];
}

NSColor *AfternoteBorderColor() {
  return [NSColor colorWithSRGBRed:0.176 green:0.188 blue:0.204 alpha:1.0];
}

NSColor *AfternoteTextColor() {
  return [NSColor colorWithSRGBRed:0.949 green:0.941 blue:0.914 alpha:1.0];
}

NSColor *AfternoteMutedTextColor() {
  return [NSColor colorWithSRGBRed:0.573 green:0.592 blue:0.588 alpha:1.0];
}

NSColor *AfternoteAccentColor() {
  return [NSColor colorWithSRGBRed:47.0 / 255.0
                            green:154.0 / 255.0
                             blue:163.0 / 255.0
                            alpha:1.0];
}

NSColor *AfternoteBrandCaptureColor() {
  return [NSColor colorWithSRGBRed:47.0 / 255.0
                            green:154.0 / 255.0
                             blue:163.0 / 255.0
                            alpha:1.0];
}

NSColor *AfternoteAccentWashColor() {
  return [AfternoteAccentColor() colorWithAlphaComponent:0.14];
}

NSColor *AfternoteBrandCaptureWashColor() {
  return [AfternoteBrandCaptureColor() colorWithAlphaComponent:0.14];
}

NSColor *AfternoteMemoryThreadColor() {
  return [AfternoteAccentColor() colorWithAlphaComponent:0.72];
}

void StyleSurface(NSView *view, NSColor *color, CGFloat cornerRadius = 0) {
  view.wantsLayer = YES;
  view.layer.backgroundColor = color.CGColor;
  view.layer.cornerRadius = cornerRadius;
  view.layer.masksToBounds = cornerRadius > 0;
}

BOOL ExactKeys(NSDictionary *value, NSArray<NSString *> *keys) {
  return value != nil && [[NSSet setWithArray:value.allKeys]
      isEqualToSet:[NSSet setWithArray:keys]];
}

BOOL IsBoolean(id value) {
  return value != nil && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

BOOL IsInteger(id value, NSUInteger minimum, NSUInteger maximum) {
  if (![value isKindOfClass:[NSNumber class]] || IsBoolean(value)) return NO;
  double number = [value doubleValue];
  return isfinite(number) && floor(number) == number &&
      number >= minimum && number <= maximum;
}

BOOL IsString(id value, NSUInteger maximum, BOOL allowEmpty) {
  return [value isKindOfClass:[NSString class]] &&
      (allowEmpty || [value length] > 0) && [value length] <= maximum;
}

BOOL IsNullableString(id value, NSUInteger maximum) {
  return value == NSNull.null || IsString(value, maximum, NO);
}

BOOL IsOneOf(id value, NSArray<NSString *> *allowed) {
  return IsString(value, 120, NO) && [allowed containsObject:value];
}

BOOL IsUUID(id value) {
  return IsString(value, 36, NO) && [value length] == 36 &&
      [[NSUUID alloc] initWithUUIDString:value] != nil;
}

BOOL IsDate(id value) {
  return IsString(value, 40, NO) && DateValue(value) != nil;
}

BOOL IsNullableDate(id value) {
  return value == NSNull.null || IsDate(value);
}

BOOL IsNullableUUID(id value) {
  return value == NSNull.null || IsUUID(value);
}

BOOL IsAuditClientId(id value) {
  if (IsUUID(value) || [value isEqual:@"owner"] || [value isEqual:@"native-library"]) return YES;
  if (![value isKindOfClass:[NSString class]] || ![value hasPrefix:@"pending:"]) return NO;
  return IsUUID([value substringFromIndex:[@"pending:" length]]);
}

BOOL IsAuditGrantId(id value) {
  return value == NSNull.null || IsUUID(value) || [value isEqual:@"native-library"];
}

BOOL IsAuditPrincipal(NSDictionary *event) {
  NSString *clientId = event[@"clientId"];
  id kind = event[@"clientKind"];
  NSString *label = event[@"clientDisplayLabel"];
  id grantId = event[@"grantId"];
  id sessionId = event[@"sessionId"];
  NSString *operation = event[@"operation"];
  if (!IsString(clientId, 128, NO) || !IsString(label, 120, NO) ||
      !IsString(operation, 120, NO)) return NO;
  if ([clientId isEqualToString:@"native-library"]) {
    return kind == NSNull.null && [label isEqualToString:@"Afternote Library"] &&
        [grantId isEqual:@"native-library"] && IsUUID(sessionId) &&
        [operation hasPrefix:@"library."];
  }
  if ([clientId isEqualToString:@"owner"]) {
    return kind == NSNull.null && [label isEqualToString:@"Owner"] &&
        grantId == NSNull.null && sessionId == NSNull.null &&
        ([operation isEqualToString:@"audit.prune"] ||
         [operation isEqualToString:@"admin.export"] ||
         [operation isEqualToString:@"admin.diagnostics"] ||
         [operation isEqualToString:@"admin.prepare_client_rotation"] ||
         [operation isEqualToString:@"lifecycle.authority_invalidate"] ||
         [operation isEqualToString:@"lifecycle.lock"] ||
         [operation isEqualToString:@"lifecycle.unlock"]);
  }
  if ([clientId hasPrefix:@"pending:"]) {
    return IsAuditClientId(clientId) && kind == NSNull.null &&
        [label isEqualToString:@"Pending client"] && grantId == NSNull.null &&
        sessionId == NSNull.null && [operation isEqualToString:@"client.pair"];
  }
  if (!IsUUID(clientId) || !IsAuditGrantId(grantId) ||
      [grantId isEqual:@"native-library"] || !IsNullableUUID(sessionId)) return NO;
  NSDictionary *labels = @{
    @"codex" : @"Codex", @"claude" : @"Claude Code",
    @"local_ui" : @"Afternote Local",
  };
  return IsOneOf(kind, labels.allKeys) && [label isEqualToString:labels[kind]];
}

BOOL IsStringArray(id value, NSUInteger maximumCount, NSUInteger maximumLength) {
  if (![value isKindOfClass:[NSArray class]] || [value count] > maximumCount) return NO;
  NSMutableSet *seen = [NSMutableSet set];
  for (id item in value) {
    if (!IsString(item, maximumLength, NO) || [seen containsObject:item]) return NO;
    [seen addObject:item];
  }
  return YES;
}

BOOL IsStringArrayFrom(id value, NSArray<NSString *> *allowed, BOOL mayBeEmpty) {
  if (!IsStringArray(value, allowed.count, 64) || (!mayBeEmpty && [value count] == 0)) return NO;
  for (NSString *item in value) if (![allowed containsObject:item]) return NO;
  return YES;
}

BOOL IsCursor(id value) {
  if (value == NSNull.null) return YES;
  if (!IsString(value, 4096, NO)) return NO;
  NSArray<NSString *> *parts = [value componentsSeparatedByString:@"."];
  if (parts.count != 2) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet
      characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"] invertedSet];
  return [parts[0] length] > 0 && [parts[1] length] > 0 &&
      [parts[0] rangeOfCharacterFromSet:invalid].location == NSNotFound &&
      [parts[1] rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

BOOL IsSource(id value) {
  if (value == NSNull.null) return YES;
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *source = value;
  NSSet *allowed = [NSSet setWithArray:@[ @"application", @"url", @"author", @"timestamp", @"label" ]];
  if (source.count == 0 || ![[NSSet setWithArray:source.allKeys] isSubsetOfSet:allowed]) return NO;
  NSDictionary *maximums = @{
    @"application" : @200, @"url" : @4096, @"author" : @400,
    @"timestamp" : @200, @"label" : @400,
  };
  for (NSString *key in source) {
    if (!IsString(source[key], [maximums[key] unsignedIntegerValue], NO)) return NO;
  }
  return YES;
}

BOOL IsCurrentNote(id value) {
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *note = value;
  return ExactKeys(note, @[ @"id", @"content", @"revision", @"source", @"createdAt", @"updatedAt" ]) &&
      IsUUID(note[@"id"]) && IsString(note[@"content"], 200000, NO) &&
      IsInteger(note[@"revision"], 1, NSUIntegerMax) && IsSource(note[@"source"]) &&
      IsDate(note[@"createdAt"]) && IsDate(note[@"updatedAt"]);
}

BOOL IsHistoricalNote(id value) {
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *note = value;
  return ExactKeys(note, @[ @"noteId", @"content", @"revision", @"source", @"createdAt" ]) &&
      IsUUID(note[@"noteId"]) && IsString(note[@"content"], 200000, NO) &&
      IsInteger(note[@"revision"], 1, NSUIntegerMax) && IsSource(note[@"source"]) &&
      IsDate(note[@"createdAt"]);
}

BOOL IsNoteSummary(id value) {
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *note = value;
  return ExactKeys(note, @[ @"id", @"revision", @"excerpt", @"source", @"createdAt", @"updatedAt" ]) &&
      IsUUID(note[@"id"]) && IsInteger(note[@"revision"], 1, NSUIntegerMax) &&
      IsString(note[@"excerpt"], 560, YES) && IsSource(note[@"source"]) &&
      IsDate(note[@"createdAt"]) && IsDate(note[@"updatedAt"]);
}

BOOL IsRevisionSummary(id value) {
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *revision = value;
  return ExactKeys(revision, @[ @"noteId", @"revision", @"createdAt" ]) &&
      IsUUID(revision[@"noteId"]) && IsInteger(revision[@"revision"], 1, NSUIntegerMax) &&
      IsDate(revision[@"createdAt"]);
}

BOOL IsSearchResult(id value) {
  if (![value isKindOfClass:[NSDictionary class]] || !ExactKeys(value, @[ @"citation" ])) return NO;
  NSDictionary *citation = value[@"citation"];
  return [citation isKindOfClass:[NSDictionary class]] &&
      ExactKeys(citation, @[ @"noteId", @"revision", @"excerpt", @"source", @"createdAt" ]) &&
      IsUUID(citation[@"noteId"]) && IsInteger(citation[@"revision"], 1, NSUIntegerMax) &&
      IsString(citation[@"excerpt"], 560, YES) && IsSource(citation[@"source"]) &&
      IsDate(citation[@"createdAt"]);
}

NSArray<NSDictionary *> *SearchResultsByApplyingPage(
    NSArray<NSDictionary *> *current,
    NSArray<NSDictionary *> *page,
    BOOL append) {
  if (!append) return [page copy];
  NSMutableArray<NSDictionary *> *combined = [current mutableCopy];
  [combined addObjectsFromArray:page];
  return combined;
}

NSDictionary *ConnectorActivitySummary(NSArray<NSDictionary *> *events) {
  NSUInteger reads = 0;
  NSUInteger saves = 0;
  for (NSDictionary *event in events) {
    NSString *operation = StringValue(event[@"operation"]);
    if ([operation isEqualToString:@"memory.recall"] ||
        [operation isEqualToString:@"memory.get_note"]) reads += 1;
    if ([operation isEqualToString:@"memory.remember"]) saves += 1;
  }
  return @{ @"reads" : @(reads), @"saves" : @(saves) };
}

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

BOOL IsSearchMode(id value) {
  return IsOneOf(value, @[ @"exact", @"indexing", @"hybrid", @"degraded" ]);
}

BOOL IsArrayOf(id value, NSUInteger maximumCount, BOOL (^validator)(id)) {
  if (![value isKindOfClass:[NSArray class]] || [value count] > maximumCount) return NO;
  for (id item in value) if (!validator(item)) return NO;
  return YES;
}

BOOL IsKnownBrokerError(NSDictionary *error) {
  static NSSet<NSString *> *codes;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    codes = [NSSet setWithArray:@[
      @"audit_commit_failed", @"conflict", @"denied", @"expired",
      @"identity_mismatch", @"incompatible_schema", @"invalid_cursor",
      @"invalid_input", @"invalid_request", @"invalid_vault",
      @"library_session_expired", @"library_session_required", @"not_found",
      @"owner_auth_unavailable", @"owner_cancelled", @"owner_denied",
      @"owner_session_expired", @"owner_session_required", @"owner_timeout",
      @"rate_limited", @"replayed", @"response_too_large", @"scope_denied", @"signature_invalid",
      @"already_locked", @"already_unlocked", @"lifecycle_transition_failed",
      @"recovery_failed", @"recovery_required", @"recovery_state_invalid", @"transition_conflict", @"transition_in_progress", @"unlock_failed", @"vault_locked",
      @"unauthorized", @"unavailable", @"unsupported_capability",
      @"unsupported_version"
    ]];
  });
  return ExactKeys(error, @[ @"code", @"message" ]) &&
      [codes containsObject:error[@"code"]] && IsString(error[@"message"], 500, NO);
}

BOOL IsLibraryResult(NSString *method, NSDictionary *result) {
  if ([method isEqualToString:@"library.session.begin"]) {
    return ExactKeys(result, @[ @"sessionId", @"scopes", @"brokerBootId", @"vaultId", @"expiresAt", @"searchMode" ]) &&
        IsUUID(result[@"sessionId"]) && IsStringArrayFrom(result[@"scopes"], @[
          @"library.browse", @"library.search", @"library.get_note",
          @"library.list_revisions", @"library.inspect_source",
          @"library.remember", @"library.update_note"
        ], NO) &&
        IsUUID(result[@"brokerBootId"]) && IsString(result[@"vaultId"], 128, NO) &&
        IsDate(result[@"expiresAt"]) && IsSearchMode(result[@"searchMode"]);
  }
  if ([method isEqualToString:@"library.views"]) {
    return ExactKeys(result, @[ @"views" ]) && IsArrayOf(result[@"views"], 20, ^BOOL(id item) {
      if (![item isKindOfClass:[NSDictionary class]]) return NO;
      return ExactKeys(item, @[ @"id", @"label", @"noteCount" ]) &&
          IsOneOf(item[@"id"], @[ @"decisions", @"commitments", @"meetings" ]) &&
          IsString(item[@"label"], 120, NO) &&
          IsInteger(item[@"noteCount"], 0, NSUIntegerMax);
    });
  }
  if ([method isEqualToString:@"library.browse"]) {
    return ExactKeys(result, @[ @"notes", @"nextCursor" ]) &&
        IsArrayOf(result[@"notes"], 20, ^BOOL(id item) { return IsNoteSummary(item); }) &&
        IsCursor(result[@"nextCursor"]);
  }
  if ([method isEqualToString:@"library.search"]) {
    return ExactKeys(result, @[ @"results", @"nextCursor", @"searchMode" ]) &&
        IsArrayOf(result[@"results"], 20, ^BOOL(id item) { return IsSearchResult(item); }) &&
        IsCursor(result[@"nextCursor"]) && IsSearchMode(result[@"searchMode"]);
  }
  if ([method isEqualToString:@"library.get_note"]) {
    if (!ExactKeys(result, @[ @"note", @"deleteTarget" ])) return NO;
    id note = result[@"note"];
    if (note == NSNull.null) return result[@"deleteTarget"] == NSNull.null;
    return (IsCurrentNote(note) || IsHistoricalNote(note)) &&
        IsNullableString(result[@"deleteTarget"], 280);
  }
  if ([method isEqualToString:@"library.list_revisions"]) {
    return ExactKeys(result, @[ @"revisions", @"nextCursor" ]) &&
        IsArrayOf(result[@"revisions"], 20, ^BOOL(id item) { return IsRevisionSummary(item); }) &&
        IsCursor(result[@"nextCursor"]);
  }
  if ([method isEqualToString:@"library.remember"] ||
      [method isEqualToString:@"library.update_note"]) {
    return ExactKeys(result, @[ @"note" ]) && IsCurrentNote(result[@"note"]);
  }
  if ([method isEqualToString:@"library.delete"]) {
    return ExactKeys(result, @[ @"deleted", @"noteId", @"revision" ]) &&
        [result[@"deleted"] isEqual:@YES] && IsUUID(result[@"noteId"]) &&
        IsInteger(result[@"revision"], 1, NSUIntegerMax);
  }
  return NO;
}

BOOL IsOwnerResult(NSString *method, NSDictionary *result, NSDictionary *params) {
  if ([method isEqualToString:@"owner.routine_authentication"] ||
      [method isEqualToString:@"owner.set_routine_authentication"]) {
    if (!ExactKeys(result, @[ @"ttlMs" ]) ||
        ![result[@"ttlMs"] isKindOfClass:[NSNumber class]]) return NO;
    int64_t ttlMs = [result[@"ttlMs"] longLongValue];
    BOOL allowed = ttlMs == kRoutineAuthenticationFifteenMinutesMilliseconds ||
        ttlMs == kRoutineAuthenticationFourHoursMilliseconds ||
        ttlMs == kRoutineAuthenticationDailyMilliseconds;
    return allowed && (![method isEqualToString:@"owner.set_routine_authentication"] ||
        [params[@"ttlMs"] isEqual:result[@"ttlMs"]]);
  }
  if ([method isEqualToString:@"owner.session.begin"]) {
    return ExactKeys(result, @[ @"scopes", @"expiresAt" ]) &&
        IsStringArrayFrom(result[@"scopes"], @[
          @"owner.inspect_clients", @"owner.inspect_grants",
          @"owner.inspect_sessions", @"owner.inspect_audit"
        ], NO) && IsDate(result[@"expiresAt"]);
  }
  if ([method isEqualToString:@"owner.revoke_client"]) {
    return ExactKeys(result, @[ @"revoked", @"clientId" ]) &&
        [result[@"revoked"] isEqual:@YES] && IsUUID(result[@"clientId"]);
  }
  if ([method isEqualToString:@"owner.revoke_connector"]) {
    return ExactKeys(result, @[ @"revoked", @"kind", @"clientIds" ]) &&
        [result[@"revoked"] isEqual:@YES] &&
        IsOneOf(result[@"kind"], @[
          @"codex", @"claude", @"local_ui"
        ]) &&
        IsArrayOf(result[@"clientIds"], 256, ^BOOL(id item) { return IsUUID(item); });
  }
  if ([method isEqualToString:@"owner.inspect_connections"]) {
    if (!ExactKeys(result, @[ @"clients", @"grants", @"sessions" ])) return NO;
    BOOL clients = IsArrayOf(result[@"clients"], 256, ^BOOL(id item) {
      if (![item isKindOfClass:[NSDictionary class]]) return NO;
      NSDictionary *client = item;
      NSDictionary *summary = client[@"sessionSummary"];
      return ExactKeys(client, @[ @"clientId", @"kind", @"displayLabel", @"status", @"trust", @"pairedAt", @"revokedAt", @"lastActivityAt", @"authorityRevision", @"activeScopes", @"sessionSummary" ]) &&
          IsUUID(client[@"clientId"]) && IsOneOf(client[@"kind"], @[
            @"codex", @"claude", @"local_ui"
          ]) &&
          IsString(client[@"displayLabel"], 120, NO) &&
          IsOneOf(client[@"status"], @[ @"paired", @"active", @"revoked", @"expired" ]) &&
          IsOneOf(client[@"trust"], @[ @"production-signed", @"development-only" ]) &&
          IsDate(client[@"pairedAt"]) &&
          IsNullableDate(client[@"revokedAt"]) && IsNullableDate(client[@"lastActivityAt"]) &&
          IsInteger(client[@"authorityRevision"], 1, NSUIntegerMax) &&
          IsStringArrayFrom(client[@"activeScopes"], @[
            @"memory.remember", @"memory.recall", @"memory.get_note", @"memory.forget"
          ], YES) &&
          [summary isKindOfClass:[NSDictionary class]] &&
          ExactKeys(summary, @[ @"activeCount", @"latestStatus" ]) &&
          IsInteger(summary[@"activeCount"], 0, NSUIntegerMax) &&
          IsOneOf(summary[@"latestStatus"], @[ @"active", @"expired", @"disconnected", @"revoked", @"none" ]);
    });
    BOOL grants = IsArrayOf(result[@"grants"], 256, ^BOOL(id item) {
      if (![item isKindOfClass:[NSDictionary class]]) return NO;
      NSDictionary *grant = item;
      return ExactKeys(grant, @[ @"grantId", @"clientId", @"scopes", @"status", @"createdAt", @"expiresAt", @"revokedAt" ]) &&
          IsUUID(grant[@"grantId"]) && IsUUID(grant[@"clientId"]) &&
          IsStringArrayFrom(grant[@"scopes"], @[
            @"memory.remember", @"memory.recall", @"memory.get_note", @"memory.forget"
          ], NO) &&
          IsOneOf(grant[@"status"], @[ @"active", @"revoked", @"expired" ]) &&
          IsDate(grant[@"createdAt"]) && IsNullableDate(grant[@"expiresAt"]) &&
          IsNullableDate(grant[@"revokedAt"]);
    });
    BOOL sessions = IsArrayOf(result[@"sessions"], 256, ^BOOL(id item) {
      if (![item isKindOfClass:[NSDictionary class]]) return NO;
      NSDictionary *session = item;
      return ExactKeys(session, @[ @"sessionId", @"clientId", @"grantId", @"status", @"startedAt", @"expiresAt", @"lastActivityAt" ]) &&
          IsUUID(session[@"sessionId"]) && IsUUID(session[@"clientId"]) && IsUUID(session[@"grantId"]) &&
          IsOneOf(session[@"status"], @[ @"active", @"expired", @"disconnected", @"revoked" ]) &&
          IsDate(session[@"startedAt"]) && IsDate(session[@"expiresAt"]) &&
          IsNullableDate(session[@"lastActivityAt"]);
    });
    return clients && grants && sessions;
  }
  if ([method isEqualToString:@"owner.inspect_audit"]) {
    return ExactKeys(result, @[ @"events", @"nextCursor" ]) &&
        IsArrayOf(result[@"events"], 100, ^BOOL(id item) {
          if (![item isKindOfClass:[NSDictionary class]]) return NO;
          NSDictionary *event = item;
          return ExactKeys(event, @[ @"eventId", @"occurredAt", @"clientId", @"clientKind", @"clientDisplayLabel", @"grantId", @"sessionId", @"operation", @"outcome", @"errorCode", @"noteRefs" ]) &&
              IsUUID(event[@"eventId"]) && IsDate(event[@"occurredAt"]) &&
              IsString(event[@"clientDisplayLabel"], 120, NO) && IsAuditPrincipal(event) &&
              IsString(event[@"operation"], 120, NO) &&
              IsOneOf(event[@"outcome"], @[ @"authorized", @"success", @"denied", @"error" ]) &&
              IsNullableString(event[@"errorCode"], 64) &&
              IsArrayOf(event[@"noteRefs"], 100, ^BOOL(id noteRef) {
                return [noteRef isKindOfClass:[NSDictionary class]] &&
                    ExactKeys(noteRef, @[ @"noteId", @"revision" ]) &&
                    IsUUID(noteRef[@"noteId"]) && IsInteger(noteRef[@"revision"], 1, NSUIntegerMax);
              });
        }) && IsCursor(result[@"nextCursor"]);
  }
  return NO;
}

BOOL IsDiagnosticCheck(id value) {
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *check = value;
  if (!ExactKeys(check, @[ @"code", @"status" ])) return NO;
  NSString *code = check[@"code"];
  NSString *status = check[@"status"];
  if ([code isEqualToString:@"runtime.running"] || [code isEqualToString:@"runtime.stopped"]) {
    return [status isEqualToString:@"ok"];
  }
  if ([code isEqualToString:@"runtime.unavailable"]) {
    return [status isEqualToString:@"failed"];
  }
  if ([code isEqualToString:@"vault.integrity"]) {
    return IsOneOf(status, @[ @"ok", @"failed", @"not-created" ]);
  }
  return NO;
}

BOOL IsDiagnosticResult(NSDictionary *result) {
  if (!ExactKeys(result, @[
        @"format", @"schemaVersion", @"generatedAt", @"application", @"system",
        @"runtime", @"vault", @"checks", @"errors"
      ]) || ![result[@"format"] isEqual:@"afternote-diagnostics"] ||
      ![result[@"schemaVersion"] isEqual:@1] || !IsDate(result[@"generatedAt"])) return NO;
  NSDictionary *application = result[@"application"];
  NSDictionary *system = result[@"system"];
  NSDictionary *runtime = result[@"runtime"];
  NSDictionary *vault = result[@"vault"];
  if (![application isKindOfClass:[NSDictionary class]] ||
      !ExactKeys(application, @[ @"version", @"standalone", @"ownerPresenceMode" ]) ||
      !IsString(application[@"version"], 120, NO) ||
      !IsBoolean(application[@"standalone"]) ||
      !IsOneOf(application[@"ownerPresenceMode"], @[ @"required", @"development-bypass" ])) return NO;
  if (![system isKindOfClass:[NSDictionary class]] ||
      !ExactKeys(system, @[ @"osFamily", @"architecture" ]) ||
      !IsString(system[@"osFamily"], 40, NO) || !IsString(system[@"architecture"], 40, NO)) return NO;
  if (![runtime isKindOfClass:[NSDictionary class]] ||
      !ExactKeys(runtime, @[ @"status", @"apiVersion", @"networkBoundary" ]) ||
      !IsOneOf(runtime[@"status"], @[ @"running", @"stopped", @"unavailable" ]) ||
      !IsInteger(runtime[@"apiVersion"], 1, NSUIntegerMax) ||
      ![runtime[@"networkBoundary"] isEqual:@"broker-only"]) return NO;
  if (![vault isKindOfClass:[NSDictionary class]] ||
      !ExactKeys(vault, @[
        @"schemaVersion", @"integrity", @"noteCountBucket",
        @"revisionCountBucket", @"databaseBytesBucket"
      ]) || !(vault[@"schemaVersion"] == NSNull.null || IsInteger(vault[@"schemaVersion"], 0, NSUIntegerMax)) ||
      !IsOneOf(vault[@"integrity"], @[ @"ok", @"failed", @"not-created", @"unknown" ]) ||
      !IsOneOf(vault[@"noteCountBucket"], @[ @"0", @"1-9", @"10-99", @"100-999", @"1000+", @"unknown" ]) ||
      !IsOneOf(vault[@"revisionCountBucket"], @[ @"0", @"1-9", @"10-99", @"100-999", @"1000+", @"unknown" ]) ||
      !IsOneOf(vault[@"databaseBytesBucket"], @[
        @"under-1-mib", @"1-9-mib", @"10-99-mib", @"100-mib-plus", @"unknown"
      ])) return NO;
  NSArray *checks = result[@"checks"];
  if (![checks isKindOfClass:[NSArray class]] || checks.count != 2 ||
      !IsArrayOf(checks, 2, ^BOOL(id item) { return IsDiagnosticCheck(item); })) return NO;
  NSMutableDictionary *checksByCode = [NSMutableDictionary dictionaryWithCapacity:2];
  for (NSDictionary *check in checks) {
    if (checksByCode[check[@"code"]] != nil) return NO;
    checksByCode[check[@"code"]] = check[@"status"];
  }
  NSString *runtimeCode = [@"runtime." stringByAppendingString:runtime[@"status"]];
  NSString *runtimeCheckStatus = [runtime[@"status"] isEqualToString:@"unavailable"]
      ? @"failed" : @"ok";
  NSString *vaultCheckStatus = [vault[@"integrity"] isEqualToString:@"ok"]
      ? @"ok"
      : [vault[@"integrity"] isEqualToString:@"not-created"]
        ? @"not-created" : @"failed";
  if (checksByCode.count != 2 ||
      ![checksByCode[runtimeCode] isEqual:runtimeCheckStatus] ||
      ![checksByCode[@"vault.integrity"] isEqual:vaultCheckStatus]) return NO;
  NSArray *errors = result[@"errors"];
  if (!IsArrayOf(errors, 3, ^BOOL(id item) {
    return [item isKindOfClass:[NSDictionary class]] &&
        ExactKeys(item, @[ @"code" ]) &&
        IsOneOf(item[@"code"], @[ @"runtime.unavailable", @"vault.unavailable", @"vault.permissions" ]);
  })) return NO;
  NSMutableSet *errorCodes = [NSMutableSet setWithCapacity:errors.count];
  for (NSDictionary *error in errors) [errorCodes addObject:error[@"code"]];
  return errorCodes.count == errors.count;
}

BOOL IsAdminResult(NSString *method, NSDictionary *result, NSDictionary *params) {
  if ([method isEqualToString:@"admin.export"]) {
    NSString *expectedFormat = [params[@"format"] isEqualToString:@"json"]
        ? @"afternote-vault-v1"
        : [params[@"format"] isEqualToString:@"markdown"]
          ? @"afternote-markdown-v1" : nil;
    return ExactKeys(result, @[ @"exported", @"destination", @"format" ]) &&
        [result[@"exported"] isEqual:@YES] && IsString(result[@"destination"], 4096, NO) &&
        [result[@"destination"] isEqual:params[@"destination"]] && expectedFormat != nil &&
        [result[@"format"] isEqual:expectedFormat];
  }
  if ([method isEqualToString:@"admin.diagnostics"]) return IsDiagnosticResult(result);
  if ([method isEqualToString:@"admin.prepare_client_rotation"]) {
    return ExactKeys(result, @[
          @"prepared", @"kind", @"installIdentity", @"replacementInstallIdentity",
          @"clientId"
        ]) &&
        [result[@"prepared"] isEqual:@YES] &&
        IsOneOf(result[@"kind"], @[ @"codex", @"claude" ]) &&
        [result[@"kind"] isEqual:params[@"kind"]] &&
        IsUUID(result[@"installIdentity"]) &&
        [result[@"installIdentity"] isEqual:params[@"installIdentity"]] &&
        IsUUID(result[@"replacementInstallIdentity"]) &&
        [result[@"replacementInstallIdentity"]
            isEqual:params[@"replacementInstallIdentity"]] &&
        (result[@"clientId"] == NSNull.null || IsUUID(result[@"clientId"]));
  }
  return NO;
}

BOOL IsLifecycleResult(NSString *method, NSDictionary *result) {
  if (!ExactKeys(result, @[ @"state", @"epoch" ]) || !IsUUID(result[@"epoch"])) return NO;
  if ([method isEqualToString:@"lifecycle.status"]) {
    return IsOneOf(result[@"state"], @[ @"unlocked", @"locking", @"locked", @"unlocking" ]);
  }
  if ([method isEqualToString:@"lifecycle.lock"]) {
    return [result[@"state"] isEqualToString:@"locked"];
  }
  if ([method isEqualToString:@"lifecycle.unlock"]) {
    return [result[@"state"] isEqualToString:@"unlocked"];
  }
  return NO;
}

BOOL IsRecoveryResult(NSString *method, NSDictionary *result) {
  if ([method isEqualToString:@"recovery.restore"]) {
    return ExactKeys(result, @[ @"restored", @"state", @"epoch", @"noteCount", @"format" ]) &&
        [result[@"restored"] isEqual:@YES] &&
        [result[@"state"] isEqualToString:@"unlocked"] &&
        IsUUID(result[@"epoch"]) &&
        IsInteger(result[@"noteCount"], 0, NSUIntegerMax) &&
        [result[@"format"] isEqualToString:@"afternote-vault-v1"];
  }
  if (![method isEqualToString:@"recovery.migrate"] || !ExactKeys(result, @[
        @"migrated", @"state", @"epoch", @"encryptedRollbackCreated",
        @"legacyPlaintextRetained", @"legacyArtifacts"
      ]) || ![result[@"migrated"] isEqual:@YES] ||
      ![result[@"state"] isEqualToString:@"unlocked"] ||
      !IsUUID(result[@"epoch"]) ||
      ![result[@"encryptedRollbackCreated"] isEqual:@YES] ||
      !IsBoolean(result[@"legacyPlaintextRetained"])) return NO;
  NSDictionary *artifacts = result[@"legacyArtifacts"];
  return [artifacts isKindOfClass:[NSDictionary class]] &&
      ExactKeys(artifacts, @[ @"found", @"retained" ]) &&
      IsInteger(artifacts[@"found"], 0, NSUIntegerMax) &&
      IsInteger(artifacts[@"retained"], 0, NSUIntegerMax) &&
      [artifacts[@"retained"] unsignedIntegerValue] <=
          [artifacts[@"found"] unsignedIntegerValue];
}

BOOL IsRecoveryStatusResult(NSDictionary *result) {
  return ExactKeys(result, @[ @"state" ]) && IsOneOf(result[@"state"], @[
    @"encrypted-candidate", @"empty", @"migration-required",
    @"migration-resume-required", @"migration-manual-resume-required",
    @"restore-resume-required", @"vault-key-unavailable", @"conflict"
  ]);
}

BOOL IsLifecycleTransitionConsistent(NSString *method, NSDictionary *before,
                                     NSDictionary *after) {
  if (!IsLifecycleResult(@"lifecycle.status", before) ||
      !IsLifecycleResult(method, after)) return NO;
  NSString *priorEpoch = before[@"epoch"];
  NSString *nextEpoch = after[@"epoch"];
  if ([method isEqualToString:@"lifecycle.lock"]) {
    return [before[@"state"] isEqualToString:@"unlocked"] &&
        [nextEpoch isEqualToString:priorEpoch];
  }
  if ([method isEqualToString:@"lifecycle.unlock"]) {
    return [before[@"state"] isEqualToString:@"locked"] &&
        ![nextEpoch isEqualToString:priorEpoch];
  }
  return NO;
}

BOOL IsBrokerResult(NSString *method, NSDictionary *result, NSDictionary *params) {
  return [method hasPrefix:@"library."]
      ? IsLibraryResult(method, result)
      : [method hasPrefix:@"owner."]
        ? IsOwnerResult(method, result, params)
        : [method hasPrefix:@"admin."]
          ? IsAdminResult(method, result, params)
          : [method hasPrefix:@"lifecycle."]
            ? IsLifecycleResult(method, result)
          : [method isEqualToString:@"recovery.status"]
            ? IsRecoveryStatusResult(result)
            : [method hasPrefix:@"recovery."] && IsRecoveryResult(method, result);
}

OwnerBrokerConnection *NewOwnerBrokerConnection(NSString *service) {
  return [[OwnerBrokerConnection alloc]
      initWithService:service
      resultValidator:^BOOL(NSString *method, NSDictionary *result,
                            NSDictionary *params) {
        return IsBrokerResult(method, result, params);
      }
      errorValidator:^BOOL(NSDictionary *error) {
        return IsKnownBrokerError(error);
      }
      lifecycleValidator:^BOOL(NSString *method, NSDictionary *before,
                               NSDictionary *after) {
        return IsLifecycleTransitionConsistent(method, before, after);
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
  } else if (argc == 5 && strcmp(argv[1], "--admin-prepare-client-rotation") == 0) {
    NSString *kind = [NSString stringWithUTF8String:argv[2]];
    NSString *installIdentity = [NSString stringWithUTF8String:argv[3]];
    NSString *replacementInstallIdentity = [NSString stringWithUTF8String:argv[4]];
    if (!IsOneOf(kind, @[ @"codex", @"claude" ]) ||
        !IsUUID(installIdentity) || !IsUUID(replacementInstallIdentity) ||
        [installIdentity isEqualToString:replacementInstallIdentity]) {
      fputs("invalid client rotation arguments\n", stderr);
      return 64;
    }
    method = @"admin.prepare_client_rotation";
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
      !IsLifecycleTransitionConsistent(method, priorLifecycleStatus, result)) {
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

@interface FlippedStackView : NSStackView
@end

@implementation FlippedStackView
- (BOOL)isFlipped {
  return YES;
}
@end

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

@interface AfternoteNoteTextView : NSTextView
@end

@implementation AfternoteNoteTextView

- (void)mouseDown:(NSEvent *)event {
  if (!self.editable || self.string.length == 0 || self.layoutManager == nil ||
      self.textContainer == nil) {
    [super mouseDown:event];
    return;
  }
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  NSPoint containerPoint = NSMakePoint(point.x - self.textContainerOrigin.x,
                                       point.y - self.textContainerOrigin.y);
  CGFloat fraction = 0;
  NSUInteger glyphIndex = [self.layoutManager glyphIndexForPoint:containerPoint
                                                  inTextContainer:self.textContainer
                                   fractionOfDistanceThroughGlyph:&fraction];
  if (glyphIndex >= self.layoutManager.numberOfGlyphs) {
    [super mouseDown:event];
    return;
  }
  NSUInteger characterIndex = [self.layoutManager characterIndexForGlyphAtIndex:glyphIndex];
  if (characterIndex >= self.string.length) {
    [super mouseDown:event];
    return;
  }
  NSRange lineRange = [self.string lineRangeForRange:NSMakeRange(characterIndex, 0)];
  NSUInteger markerIndex = lineRange.location;
  while (markerIndex < NSMaxRange(lineRange)) {
    unichar character = [self.string characterAtIndex:markerIndex];
    if (character != ' ' && character != '\t') break;
    markerIndex += 1;
  }
  if (markerIndex >= self.string.length) {
    [super mouseDown:event];
    return;
  }
  unichar marker = [self.string characterAtIndex:markerIndex];
  if (marker != 0x2610 && marker != 0x2611) {
    [super mouseDown:event];
    return;
  }
  NSRange glyphRange = [self.layoutManager glyphRangeForCharacterRange:NSMakeRange(markerIndex, 1)
                                                   actualCharacterRange:nullptr];
  NSRect markerRect = [self.layoutManager boundingRectForGlyphRange:glyphRange
                                                    inTextContainer:self.textContainer];
  markerRect.origin.x += self.textContainerOrigin.x;
  markerRect.origin.y += self.textContainerOrigin.y;
  markerRect = NSInsetRect(markerRect, -5, -4);
  if (!NSPointInRect(point, markerRect)) {
    [super mouseDown:event];
    return;
  }
  NSString *replacement = marker == 0x2610 ? @"☑" : @"☐";
  if ([self shouldChangeTextInRange:NSMakeRange(markerIndex, 1)
                  replacementString:replacement]) {
    [self.textStorage replaceCharactersInRange:NSMakeRange(markerIndex, 1)
                                     withString:replacement];
    [self didChangeText];
  }
}

@end

@interface AfternoteButton : NSButton
@property(nonatomic, strong) NSColor *afternoteFillColor;
@property(nonatomic, strong) NSColor *afternoteHoverColor;
@property(nonatomic, strong) NSColor *afternotePressedColor;
@property(nonatomic, strong) NSColor *afternoteBorderColor;
@property(nonatomic) CGFloat afternoteCornerRadius;
@property(nonatomic) BOOL afternotePointerInside;
@property(nonatomic, strong) NSTrackingArea *afternoteTrackingArea;
@end

@implementation AfternoteButton

+ (instancetype)buttonWithTitle:(NSString *)title
                          target:(id)target
                          action:(SEL)action {
  AfternoteButton *button = [[self alloc] init];
  button.title = title;
  button.target = target;
  button.action = action;
  button.buttonType = NSButtonTypeMomentaryPushIn;
  return button;
}

+ (instancetype)buttonWithImage:(NSImage *)image
                          target:(id)target
                          action:(SEL)action {
  AfternoteButton *button = [[self alloc] init];
  button.image = image;
  button.target = target;
  button.action = action;
  button.buttonType = NSButtonTypeMomentaryPushIn;
  return button;
}

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  self.wantsLayer = YES;
  self.bordered = NO;
  self.focusRingType = NSFocusRingTypeExterior;
  self.afternoteCornerRadius = 6;
  return self;
}

- (BOOL)wantsUpdateLayer {
  return YES;
}

- (NSSize)intrinsicContentSize {
  NSSize size = [super intrinsicContentSize];
  if (self.afternoteFillColor == nil && self.afternoteBorderColor == nil) return size;
  return NSMakeSize(size.width + 18, MAX(30, size.height + 8));
}

- (void)updateTrackingAreas {
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
  [super updateTrackingAreas];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  self.afternotePointerInside = YES;
  [self setNeedsDisplay:YES];
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  self.afternotePointerInside = NO;
  [self setNeedsDisplay:YES];
}

- (void)setHighlighted:(BOOL)highlighted {
  [super setHighlighted:highlighted];
  [self setNeedsDisplay:YES];
}

- (void)setEnabled:(BOOL)enabled {
  [super setEnabled:enabled];
  [self setNeedsDisplay:YES];
}

- (void)updateLayer {
  NSColor *fill = self.afternoteFillColor ?: NSColor.clearColor;
  if (!self.enabled) {
    fill = [fill colorWithAlphaComponent:0.42];
  } else if (self.highlighted && self.afternotePressedColor != nil) {
    fill = self.afternotePressedColor;
  } else if (self.afternotePointerInside && self.afternoteHoverColor != nil) {
    fill = self.afternoteHoverColor;
  }
  self.layer.backgroundColor = fill.CGColor;
  self.layer.borderColor = (self.afternoteBorderColor ?: NSColor.clearColor).CGColor;
  self.layer.borderWidth = self.afternoteBorderColor == nil ? 0 : 1;
  self.layer.cornerRadius = self.afternoteCornerRadius;
  self.layer.masksToBounds = YES;
  self.alphaValue = self.enabled ? 1 : 0.72;
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
    ];
  });
  return descriptors;
}

@interface OwnerControlDelegate : NSObject <NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate, NSTextViewDelegate, NSOpenSavePanelDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTabView *surfaceTabs;
@property(nonatomic, strong) AfternoteProductSurfaceRouter *surfaceRouter;
@property(nonatomic, strong) NSSegmentedControl *surfaceSelector;
@property(nonatomic, strong) NSButton *memoryNavigationButton;
@property(nonatomic, strong) NSButton *connectionsNavigationButton;
@property(nonatomic, strong) NSStackView *content;
@property(nonatomic, strong) NSStackView *setupContent;
@property(nonatomic, strong) NSView *setupBanner;
@property(nonatomic) BOOL setupGuideDismissed;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSProgressIndicator *progress;
@property(nonatomic, strong) NSButton *authenticateButton;
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
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *noteSummaries;
@property(nonatomic, strong) NSTextView *noteEditor;
@property(nonatomic, strong) NSButton *memoryBackButton;
@property(nonatomic, strong) NSButton *checklistButton;
@property(nonatomic, strong) NSButton *bulletListButton;
@property(nonatomic, strong) NSButton *numberedListButton;
@property(nonatomic, strong) NSTextField *searchModeLabel;
@property(nonatomic, copy) NSString *currentSearchMode;
@property(nonatomic, strong) NSTextField *semanticSettingsState;
@property(nonatomic, strong) NSTextField *sourceLabel;
@property(nonatomic, strong) NSTextField *revisionLabel;
@property(nonatomic, strong) NSPopUpButton *revisionMenu;
@property(nonatomic, strong) NSButton *saveButton;
@property(nonatomic, strong) NSButton *discardChangesButton;
@property(nonatomic, strong) NSButton *deleteButton;
@property(nonatomic, strong) NSButton *editCurrentNoteButton;
@property(nonatomic, strong) NSButton *loadMoreNotesButton;
@property(nonatomic, strong) NSButton *libraryRecentButton;
@property(nonatomic, strong) NSButton *createNoteButton;
@property(nonatomic, strong) NSButton *vaultAccessButton;
@property(nonatomic, strong) NSPopUpButton *routineAuthenticationMenu;
@property(nonatomic, strong) NSStackView *libraryViews;
@property(nonatomic, strong) NSDictionary *activeNote;
@property(nonatomic, strong) NSArray<NSDictionary *> *revisionSummaries;
@property(nonatomic, copy) NSString *libraryExpiresAt;
@property(nonatomic, copy) NSString *noteCursor;
@property(nonatomic, copy) NSString *revisionCursor;
@property(nonatomic, copy) NSString *activeQuery;
@property(nonatomic, copy) NSString *activeView;
@property(nonatomic, copy) NSString *activeDeleteTarget;
@property(nonatomic, strong) NSAlert *librarySensitiveAlert;
@property(nonatomic, strong) NSTextView *librarySensitiveTextView;
@property(nonatomic) BOOL creatingNote;
@property(nonatomic) BOOL inspectingCitation;
@property(nonatomic) BOOL revisionHistoryLoaded;
@property(nonatomic) BOOL libraryMutationInFlight;
@property(nonatomic) BOOL editorSaveConfirmationPending;
@property(nonatomic) AfternoteEditorSaveState editorSaveState;
@property(nonatomic) BOOL libraryListInFlight;
@property(nonatomic) BOOL libraryRefreshPending;
@property(nonatomic) BOOL vaultLocked;
@property(nonatomic) BOOL vaultStatusCheckInFlight;
@property(nonatomic) NSUInteger librarySessionGeneration;
@property(nonatomic) NSUInteger libraryListRequestSequence;
@property(nonatomic) NSUInteger libraryNoteRequestSequence;
@property(nonatomic) NSUInteger libraryRevisionRequestSequence;
@property(nonatomic) NSUInteger lifecycleStatusRequestSequence;
@end

@implementation OwnerControlDelegate

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  self.surfaceRouter = [[AfternoteProductSurfaceRouter alloc] init];
  return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  self.auditEvents = [NSMutableArray array];
  self.revocationTargets = [NSMutableDictionary dictionary];
  self.integrationStatuses = [NSMutableDictionary dictionary];
  self.integrationOperations = [NSMutableSet set];
  self.integrationStatusGenerations = [NSMutableDictionary dictionary];
  self.expandedConnectorKinds = [NSMutableSet set];
  self.noteSummaries = [NSMutableArray array];
  self.revisionSummaries = @[];
  self.activeQuery = @"";
  self.currentSearchMode = @"checking";
  self.setupGuideDismissed = [NSUserDefaults.standardUserDefaults
      boolForKey:kSetupGuideDismissedDefaultsKey];
  self.recoveryState = @"checking";
  self.recoveryActionButtons = [NSMutableArray array];
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
  [self.noteSummaries addObjectsFromArray:@[
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
  self.libraryStatusLabel.stringValue = @"Preview: Notes open until Aug 28, 5:00 PM";
  self.libraryProgress.hidden = YES;
  [self.libraryProgress stopAnimation:nil];
  self.activeQuery = @"Where did I put the spare key for my bike?";
  self.librarySearch.stringValue = self.activeQuery;
  [self updateSearchComposerHeight];
  self.clearSearchButton.hidden = NO;
  [self applySearchMode:@"hybrid"];
  [self showLibraryMode:AfternoteLibraryModeAsk loadBrowse:NO];
  self.resultsHeadingLabel.stringValue = @"Results · 2";
  [self.noteTable reloadData];
  [self renderActiveNote];
  [self renderRevisionMenu];
  [self setLibraryBusy:NO status:@"Preview: Notes open until Aug 28, 5:00 PM"];
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  if ([arguments containsObject:@"--preview-connector-setup"]) {
    self.connections = @{ @"clients" : @[], @"grants" : @[], @"sessions" : @[] };
    [self.auditEvents removeAllObjects];
    [self render];
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceConnections;
    [self.surfaceTabs selectTabViewItemAtIndex:kConnectionsTabIndex];
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
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
    [self.surfaceTabs selectTabViewItemAtIndex:kSetupTabIndex];
  } else if ([arguments containsObject:@"--preview-onboarding"]) {
    self.connections = @{ @"clients" : @[], @"grants" : @[], @"sessions" : @[] };
    [self.auditEvents removeAllObjects];
    self.setupGuideDismissed = NO;
    [self renderSetupGuide];
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
    [self.surfaceTabs selectTabViewItemAtIndex:kSetupTabIndex];
  } else if ([arguments containsObject:@"--preview-onboarding-banner"]) {
    self.setupGuideDismissed = NO;
    self.activeQuery = @"";
    self.librarySearch.stringValue = @"";
    [self showLibraryMode:AfternoteLibraryModeBrowse loadBrowse:NO];
    [self updateSetupBannerVisibility];
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
    [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
  } else if ([arguments containsObject:@"--preview-settings"]) {
    self.surfaceSelector.selectedSegment = -1;
    [self.surfaceTabs selectTabViewItemAtIndex:kSettingsTabIndex];
  } else if ([arguments containsObject:@"--preview-new-note"]) {
    [self beginNewNote:nil];
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
    [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
  } else if ([arguments containsObject:@"--preview-write"]) {
    [self showLibraryMode:AfternoteLibraryModeWrite loadBrowse:NO];
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
    [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
  } else if ([arguments containsObject:@"--preview-browse"]) {
    self.activeQuery = @"";
    self.librarySearch.stringValue = @"";
    [self showLibraryMode:AfternoteLibraryModeBrowse loadBrowse:NO];
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
    [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
  } else if ([arguments containsObject:@"--connections"]) {
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceConnections;
    [self.surfaceTabs selectTabViewItemAtIndex:kConnectionsTabIndex];
  } else if ([arguments containsObject:@"--library"]) {
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
    [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
  } else if ([arguments containsObject:@"--recovery"]) {
    self.surfaceSelector.selectedSegment = -1;
    [self.surfaceTabs selectTabViewItemAtIndex:kRecoveryTabIndex];
    self.recoveryState = @"ready";
    self.recoveryStatusLabel.stringValue = @"Vault ready";
    self.recoveryProgress.hidden = YES;
    [self.recoveryProgress stopAnimation:nil];
    [self renderRecoveryState];
  }
  if ([arguments containsObject:@"--preview-saved"]) {
    [self setEditorSaveButtonState:AfternoteEditorSaveStateSaved animated:NO];
  }
  if ([arguments containsObject:@"--preview-focus-ask"]) {
    self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
    [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
    [self showLibraryMode:AfternoteLibraryModeAsk loadBrowse:NO];
    [self.window makeFirstResponder:self.librarySearch];
    self.askComposer.afternoteFocused = YES;
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
  [self refreshIntegrationStatuses];
  [self refreshRecoveryStatusAndContinue:YES];
#endif
}

- (void)applicationDidBecomeActive:(NSNotification *)notification {
  (void)notification;
  if (self.window == nil || self.broker == nil || self.libraryExpiresAt.length == 0 ||
      self.libraryMutationInFlight || self.libraryListInFlight ||
      self.surfaceTabs.selectedTabViewItem == nil ||
      ![self.surfaceTabs.selectedTabViewItem.identifier isEqual:@"library"]) return;
  if (self.libraryModeSelector.selectedSegment == AfternoteLibraryModeWrite) {
    self.libraryRefreshPending = YES;
    return;
  }
  [self refreshVisibleLibraryNotes:nil];
}

- (void)vaultDidLock:(NSNotification *)notification {
  (void)notification;
  self.lifecycleStatusRequestSequence += 1;
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
  if (error != nil || !IsLifecycleResult(@"lifecycle.status", result) ||
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
  NSTextField *label = [NSTextField labelWithString:text];
  label.font = [NSFont systemFontOfSize:size weight:weight];
  label.textColor = AfternoteTextColor();
  label.maximumNumberOfLines = 0;
  label.lineBreakMode = NSLineBreakByWordWrapping;
  label.cell.wraps = YES;
  label.cell.usesSingleLineMode = NO;
  return label;
}

- (void)stylePrimaryButton:(NSButton *)button {
  button.bordered = NO;
  button.controlSize = NSControlSizeRegular;
  button.contentTintColor = AfternoteCanvasColor();
  button.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  if ([button isKindOfClass:[AfternoteButton class]]) {
    AfternoteButton *flatButton = (AfternoteButton *)button;
    flatButton.afternoteFillColor = AfternoteTextColor();
    flatButton.afternoteHoverColor = [AfternoteTextColor()
        blendedColorWithFraction:0.08 ofColor:NSColor.whiteColor];
    flatButton.afternotePressedColor = [AfternoteTextColor()
        blendedColorWithFraction:0.14 ofColor:NSColor.blackColor];
    flatButton.afternoteBorderColor = nil;
    [flatButton invalidateIntrinsicContentSize];
    [flatButton setNeedsDisplay:YES];
  }
}

- (void)styleSecondaryButton:(NSButton *)button {
  button.bordered = NO;
  button.controlSize = NSControlSizeRegular;
  button.contentTintColor = AfternoteTextColor();
  button.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
  if ([button isKindOfClass:[AfternoteButton class]]) {
    AfternoteButton *flatButton = (AfternoteButton *)button;
    flatButton.afternoteFillColor = AfternoteRaisedSurfaceColor();
    flatButton.afternoteHoverColor = [AfternoteRaisedSurfaceColor()
        blendedColorWithFraction:0.08 ofColor:NSColor.whiteColor];
    flatButton.afternotePressedColor = AfternoteSurfaceColor();
    flatButton.afternoteBorderColor = AfternoteBorderColor();
    [flatButton invalidateIntrinsicContentSize];
    [flatButton setNeedsDisplay:YES];
  } else {
    button.bordered = YES;
    button.bezelStyle = NSBezelStyleInline;
    button.bezelColor = AfternoteRaisedSurfaceColor();
  }
}

- (void)styleToolButton:(NSButton *)button {
  button.bordered = NO;
  button.controlSize = NSControlSizeSmall;
  button.contentTintColor = AfternoteTextColor();
  button.font = [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
  if ([button isKindOfClass:[AfternoteButton class]]) {
    AfternoteButton *flatButton = (AfternoteButton *)button;
    flatButton.afternoteFillColor = AfternoteSurfaceColor();
    flatButton.afternoteHoverColor = AfternoteRaisedSurfaceColor();
    flatButton.afternotePressedColor = AfternoteCanvasColor();
    flatButton.afternoteBorderColor = AfternoteBorderColor();
    [flatButton invalidateIntrinsicContentSize];
    [flatButton setNeedsDisplay:YES];
  }
}

- (void)styleDestructiveButton:(NSButton *)button {
  button.bordered = NO;
  button.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  button.contentTintColor = StatusColor(@"error");
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
                            selected:selected == AfternoteProductSurfaceMemory];
  [self styleProductNavigationButton:self.connectionsNavigationButton
                            selected:selected == AfternoteProductSurfaceConnections];
}

- (AfternoteProductSurface)displaySurface:(AfternoteProductSurface)surface
                             recoveryReady:(BOOL)recoveryReady {
  AfternoteProductSurface resolved =
      [self.surfaceRouter selectRequestedSurface:surface
                                   recoveryReady:recoveryReady];
  self.surfaceSelector.selectedSegment =
      AfternoteNavigationSegmentForSurface(resolved);
  [self updateProductNavigationState];
  [self.surfaceTabs selectTabViewItemAtIndex:(NSInteger)resolved];
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

- (void)applySearchMode:(NSString *)mode {
  self.currentSearchMode = mode.length > 0 ? mode : @"checking";
  if ([mode isEqualToString:@"hybrid"]) {
    self.searchModeLabel.stringValue = @"Semantic recall";
    self.searchModeLabel.textColor = AfternoteBrandCaptureColor();
  } else if ([mode isEqualToString:@"indexing"]) {
    self.searchModeLabel.stringValue = @"Exact search ready · improving recall";
    self.searchModeLabel.textColor = StatusColor(@"warning");
  } else if ([mode isEqualToString:@"degraded"]) {
    self.searchModeLabel.stringValue = @"Exact search only";
    self.searchModeLabel.textColor = StatusColor(@"error");
  } else if ([mode isEqualToString:@"checking"]) {
    self.searchModeLabel.stringValue = @"Search capability checking…";
    self.searchModeLabel.textColor = AfternoteMutedTextColor();
  } else {
    self.searchModeLabel.stringValue = @"Exact search only";
    self.searchModeLabel.textColor = AfternoteMutedTextColor();
  }
  self.searchModeLabel.accessibilityLabel =
      [NSString stringWithFormat:@"Search mode: %@", self.searchModeLabel.stringValue];
  if ([mode isEqualToString:@"hybrid"]) {
    self.semanticSettingsState.stringValue = @"Active · local 23 MB model";
    self.semanticSettingsState.textColor = StatusColor(@"success");
  } else if ([mode isEqualToString:@"indexing"]) {
    self.semanticSettingsState.stringValue = @"Indexing locally · exact fallback ready";
    self.semanticSettingsState.textColor = StatusColor(@"warning");
  } else if ([mode isEqualToString:@"exact"] || [mode isEqualToString:@"degraded"]) {
    self.semanticSettingsState.stringValue = @"Exact search active · semantic model unavailable";
    self.semanticSettingsState.textColor = StatusColor(
        [mode isEqualToString:@"degraded"] ? @"error" : @"neutral");
  } else {
    self.semanticSettingsState.stringValue = @"Checked when Notes opens";
    self.semanticSettingsState.textColor = AfternoteMutedTextColor();
  }
  [self renderSetupGuide];
}

- (void)applyEditorTheme {
  if (self.noteEditor == nil) return;
  NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
  paragraph.lineSpacing = 4;
  paragraph.paragraphSpacing = 7;
  NSDictionary *typingAttributes = @{
    NSFontAttributeName : [NSFont systemFontOfSize:17 weight:NSFontWeightRegular],
    NSForegroundColorAttributeName : AfternoteTextColor(),
    NSParagraphStyleAttributeName : paragraph,
  };
  self.noteEditor.typingAttributes = typingAttributes;
  self.noteEditor.font = typingAttributes[NSFontAttributeName];
  self.noteEditor.textColor = AfternoteTextColor();
  self.noteEditor.backgroundColor = AfternoteCanvasColor();
  self.noteEditor.insertionPointColor = AfternoteBrandCaptureColor();
  if (self.noteEditor.textStorage.length > 0) {
    [self.noteEditor.textStorage addAttributes:typingAttributes
                                         range:NSMakeRange(0, self.noteEditor.textStorage.length)];
  }
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
  self.semanticSettingsState = [self label:@"Checked when Notes opens"
                                        size:12 weight:NSFontWeightMedium];
  self.semanticSettingsState.textColor = AfternoteMutedTextColor();
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
  NSTextField *identityState = [self label:@"One identity per tool" size:12 weight:NSFontWeightMedium];
  identityState.textColor = AfternoteMutedTextColor();

  NSTextField *productHeading = [self label:@"Product" size:18 weight:NSFontWeightSemibold];
  NSTextField *version = [self label:@"2.0 local alpha" size:12 weight:NSFontWeightMedium];
  version.textColor = AfternoteMutedTextColor();
  NSTextField *updateState = [self label:@"Manual during alpha" size:12 weight:NSFontWeightMedium];
  updateState.textColor = AfternoteMutedTextColor();
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
#else
  NSTextField *developmentState = [self label:@"Production authentication policy"
                                           size:12 weight:NSFontWeightMedium];
  developmentState.textColor = AfternoteMutedTextColor();
#endif

  NSStackView *column = [NSStackView stackViewWithViews:@[
    title, subtitle,
    memoryHeading,
    [self settingsRowWithTitle:@"Vault" detail:@"Canonical notes and derived recall data stay encrypted locally." control:vaultState],
    [self settingsRowWithTitle:@"Vault location" detail:@"The broker owns the encrypted database path; connectors never receive it." control:vaultLocationState],
    [self settingsRowWithTitle:@"Semantic recall" detail:@"Optional local semantic recall can be installed explicitly. Exact search is the release default." control:self.semanticSettingsState],
    [self settingsRowWithTitle:@"Export & diagnostics" detail:@"Lossless export and share-safe diagnostics run through owner-approved native broker actions." control:exportControls],
    securityHeading,
    [self settingsRowWithTitle:@"Vault access" detail:@"Locking clears native plaintext and disconnects connector sessions." control:self.vaultAccessButton],
    [self settingsRowWithTitle:@"Routine authentication" detail:@"Used for Notes, Connections, Codex, and Claude Code while Afternote stays open. Export, deletion, recovery, lock, and unlock still require fresh approval." control:self.routineAuthenticationMenu],
    [self settingsRowWithTitle:@"Connector identities" detail:@"Rotation and exact revocation remain scoped to one local connector." control:identityState],
    [self settingsRowWithTitle:@"Build policy" detail:@"Development convenience is isolated from release builds." control:developmentState],
    productHeading,
    [self settingsRowWithTitle:@"Version" detail:@"Afternote V2 local memory." control:version],
    [self settingsRowWithTitle:@"Updates" detail:@"Signed automatic updates are a release gate, not an alpha default." control:updateState],
    [self settingsRowWithTitle:@"Setup guide" detail:@"Reconnect a tool or repeat the save-and-recall walkthrough." control:showSetup],
    [self settingsRowWithTitle:@"Feedback" detail:@"Report a bug or suggestion. Diagnostics are attached only if you review and add them." control:sendFeedback],
    [self settingsRowWithTitle:@"Uninstall" detail:@"Remove connector configuration and background components. Your encrypted vault and reconnect authorization are preserved." control:uninstall],
  ]];
  column.orientation = NSUserInterfaceLayoutOrientationVertical;
  column.alignment = NSLayoutAttributeLeading;
  column.spacing = 4;
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

- (void)uninstallAfternote:(id)sender {
  (void)sender;
  NSAlert *confirmation = [[NSAlert alloc] init];
  confirmation.messageText = @"Uninstall Afternote?";
  confirmation.informativeText = @"Afternote will remove its Codex and Claude Code configuration and background runtime. Your encrypted vault and connector authorization in ~/.afternote and Keychain are preserved for reinstall.";
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
  panel.allowedFileTypes = @[ @"json" ];
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
  panel.allowedFileTypes = @[ @"json" ];
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
  self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
  self.surfaceSelector.accessibilityLabel = @"Afternote section";
  self.surfaceSelector.controlSize = NSControlSizeRegular;
  self.surfaceSelector.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
  self.surfaceSelector.segmentStyle = NSSegmentStyleSeparated;
  self.surfaceSelector.selectedSegmentBezelColor = AfternoteAccentColor();
  self.surfaceSelector.hidden = YES;
  self.memoryNavigationButton = [NSButton buttonWithTitle:@"Notes"
                                                   target:self
                                                   action:@selector(selectProductSurface:)];
  self.memoryNavigationButton.tag = AfternoteProductSurfaceMemory;
  self.memoryNavigationButton.accessibilityLabel = @"Open Notes";
  self.connectionsNavigationButton = [NSButton buttonWithTitle:@"Connections"
                                                        target:self
                                                        action:@selector(selectProductSurface:)];
  self.connectionsNavigationButton.tag = AfternoteProductSurfaceConnections;
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
  [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
  [self.surfaceSelector setEnabled:NO forSegment:0];
  [self.surfaceSelector setEnabled:NO forSegment:1];
  self.libraryAuthenticateButton.enabled = NO;
  self.authenticateButton.enabled = NO;

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
  NSView *root = [[NSView alloc] init];
  StyleSurface(root, AfternoteCanvasColor());
  NSTextField *title = [self label:@"Connections" size:32 weight:NSFontWeightSemibold];
  NSTextField *subtitle = [self label:@"Access and recent activity for local tools. Note text and queries never appear here."
                                     size:15 weight:NSFontWeightRegular];
  subtitle.textColor = AfternoteMutedTextColor();
  self.statusLabel = [self label:@"Loading broker state…" size:13 weight:NSFontWeightMedium];
  self.statusLabel.textColor = AfternoteMutedTextColor();
  self.statusLabel.accessibilityLabel = @"Broker status";
  self.progress = [[NSProgressIndicator alloc] init];
  self.progress.style = NSProgressIndicatorStyleSpinning;
  self.progress.controlSize = NSControlSizeSmall;
  [self.progress startAnimation:nil];
  self.authenticateButton = [AfternoteButton buttonWithTitle:@"Authenticate & Refresh"
                                               target:self
                                               action:@selector(authenticate:)];
  [self stylePrimaryButton:self.authenticateButton];
  self.authenticateButton.keyEquivalent = @"r";
  self.authenticateButton.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  self.authenticateButton.accessibilityLabel = @"Authenticate and refresh connections";

  NSStackView *statusRow = [NSStackView stackViewWithViews:@[
    self.progress, self.statusLabel, [NSView new], self.authenticateButton
  ]];
  statusRow.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  statusRow.spacing = 10;
  statusRow.alignment = NSLayoutAttributeCenterY;
  statusRow.edgeInsets = NSEdgeInsetsMake(10, 12, 10, 12);
  StyleSurface(statusRow, AfternoteSurfaceColor(), 8);

  self.content = [FlippedStackView stackViewWithViews:@[]];
  self.content.orientation = NSUserInterfaceLayoutOrientationVertical;
  self.content.alignment = NSLayoutAttributeLeading;
  self.content.spacing = 16;
  self.content.edgeInsets = NSEdgeInsetsMake(18, 0, 32, 0);

  NSScrollView *scroll = [[NSScrollView alloc] init];
  scroll.hasVerticalScroller = YES;
  scroll.drawsBackground = NO;
  scroll.documentView = self.content;

  NSStackView *layout = [NSStackView stackViewWithViews:@[
    title, subtitle, statusRow, scroll
  ]];
  layout.orientation = NSUserInterfaceLayoutOrientationVertical;
  layout.alignment = NSLayoutAttributeLeading;
  layout.spacing = 12;
  layout.translatesAutoresizingMaskIntoConstraints = NO;
  NSLayoutConstraint *preferredConnectionsWidth = [layout.widthAnchor constraintEqualToConstant:920];
  preferredConnectionsWidth.priority = NSLayoutPriorityDefaultHigh;
  preferredConnectionsWidth.active = YES;
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
    [self.content.widthAnchor constraintEqualToAnchor:scroll.contentView.widthAnchor],
  ]];
  return root;
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
  NSTextField *detail = [self label:@"Connect Codex or Claude Code, then test saving and recalling a note."
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
      self.activeQuery.length == 0;
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
  self.searchModeLabel = [self label:@"Search capability checking…" size:11 weight:NSFontWeightMedium];
  self.searchModeLabel.textColor = AfternoteMutedTextColor();
  self.searchModeLabel.accessibilityLabel = @"Search capability checking";
  NSTextField *localQueryLabel = [self label:@"Private to this Mac" size:11 weight:NSFontWeightRegular];
  localQueryLabel.textColor = AfternoteMutedTextColor();
  NSStackView *queryMeta = [NSStackView stackViewWithViews:@[
    localQueryLabel, [NSView new], self.searchModeLabel
  ]];
  queryMeta.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  queryMeta.alignment = NSLayoutAttributeCenterY;
  self.askControls = [NSStackView stackViewWithViews:@[ self.askComposer, queryMeta ]];
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

  self.revisionLabel = [self label:@"Choose a note" size:12 weight:NSFontWeightSemibold];
  self.revisionLabel.textColor = AfternoteMutedTextColor();
  self.sourceLabel = [self label:@"The note and its source will appear here."
                                  size:13 weight:NSFontWeightRegular];
  self.sourceLabel.textColor = AfternoteMutedTextColor();
  NSScrollView *editorScroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(0, 0, 720, 480)];
  NSSize editorContentSize = editorScroll.contentSize;
  self.noteEditor = [[AfternoteNoteTextView alloc]
      initWithFrame:NSMakeRect(0, 0, editorContentSize.width, editorContentSize.height)];
  self.noteEditor.minSize = NSMakeSize(0, editorContentSize.height);
  self.noteEditor.maxSize = NSMakeSize(CGFLOAT_MAX, CGFLOAT_MAX);
  self.noteEditor.verticallyResizable = YES;
  self.noteEditor.horizontallyResizable = NO;
  self.noteEditor.autoresizingMask = NSViewWidthSizable;
  self.noteEditor.textContainer.containerSize = NSMakeSize(editorContentSize.width, CGFLOAT_MAX);
  self.noteEditor.textContainer.widthTracksTextView = YES;
  self.noteEditor.textContainerInset = NSMakeSize(8, 16);
  self.noteEditor.richText = NO;
  self.noteEditor.importsGraphics = NO;
  self.noteEditor.allowsImageEditing = NO;
  self.noteEditor.automaticQuoteSubstitutionEnabled = NO;
  self.noteEditor.automaticDashSubstitutionEnabled = NO;
  self.noteEditor.automaticTextReplacementEnabled = NO;
  self.noteEditor.delegate = self;
  self.noteEditor.accessibilityLabel = @"Note text";
  [self applyEditorTheme];
  editorScroll.documentView = self.noteEditor;
  editorScroll.hasVerticalScroller = YES;
  editorScroll.borderType = NSNoBorder;
  editorScroll.drawsBackground = NO;
  self.revisionMenu = [[NSPopUpButton alloc] init];
  self.revisionMenu.target = self;
  self.revisionMenu.action = @selector(selectRevision:);
  self.revisionMenu.accessibilityLabel = @"Revision history";
  [self styleSecondaryButton:self.revisionMenu];
  NSImage *backImage = [NSImage imageWithSystemSymbolName:@"chevron.left"
                                 accessibilityDescription:@"Back to Notes"];
  self.memoryBackButton = [AfternoteButton buttonWithTitle:@"Notes"
                                                   target:self
                                                   action:@selector(returnToMemory:)];
  self.memoryBackButton.image = backImage;
  self.memoryBackButton.imagePosition = NSImageLeft;
  self.memoryBackButton.imageHugsTitle = YES;
  self.memoryBackButton.bordered = NO;
  self.memoryBackButton.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  self.memoryBackButton.contentTintColor = AfternoteAccentColor();
  self.memoryBackButton.accessibilityLabel = @"Back to Notes";
  NSImageSymbolConfiguration *formatSymbolConfiguration =
      [NSImageSymbolConfiguration configurationWithPointSize:14 weight:NSFontWeightRegular];
  NSImage *checklistImage = [[NSImage imageWithSystemSymbolName:@"checklist"
                                      accessibilityDescription:@"Checklist"]
      imageWithSymbolConfiguration:formatSymbolConfiguration];
  self.checklistButton = [AfternoteButton buttonWithImage:checklistImage
                                                   target:self
                                                   action:@selector(toggleChecklist:)];
  [self styleToolButton:self.checklistButton];
  self.checklistButton.keyEquivalent = @"9";
  self.checklistButton.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  self.checklistButton.toolTip = @"Checklist (Command-Shift-9)";
  self.checklistButton.accessibilityLabel = @"Toggle checklist";
  NSImage *bulletImage = [[NSImage imageWithSystemSymbolName:@"list.bullet"
                                   accessibilityDescription:@"Bullet list"]
      imageWithSymbolConfiguration:formatSymbolConfiguration];
  self.bulletListButton = [AfternoteButton buttonWithImage:bulletImage
                                                    target:self
                                                    action:@selector(toggleBulletList:)];
  [self styleToolButton:self.bulletListButton];
  self.bulletListButton.keyEquivalent = @"8";
  self.bulletListButton.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  self.bulletListButton.toolTip = @"Bullet list (Command-Shift-8)";
  self.bulletListButton.accessibilityLabel = @"Toggle bullet list";
  NSImage *numberedImage = [[NSImage imageWithSystemSymbolName:@"list.number"
                                     accessibilityDescription:@"Numbered list"]
      imageWithSymbolConfiguration:formatSymbolConfiguration];
  self.numberedListButton = [AfternoteButton buttonWithImage:numberedImage
                                                      target:self
                                                      action:@selector(toggleNumberedList:)];
  [self styleToolButton:self.numberedListButton];
  self.numberedListButton.keyEquivalent = @"7";
  self.numberedListButton.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  self.numberedListButton.toolTip = @"Numbered list (Command-Shift-7)";
  self.numberedListButton.accessibilityLabel = @"Toggle numbered list";
  NSStackView *formatting = [NSStackView stackViewWithViews:@[
    self.checklistButton, self.bulletListButton, self.numberedListButton
  ]];
  formatting.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  formatting.alignment = NSLayoutAttributeCenterY;
  formatting.spacing = 4;
  for (NSButton *button in @[
         self.checklistButton, self.bulletListButton, self.numberedListButton
       ]) {
    [button.widthAnchor constraintEqualToConstant:28].active = YES;
    [button.heightAnchor constraintEqualToConstant:28].active = YES;
  }
  NSStackView *formattingBar = [NSStackView stackViewWithViews:@[
    formatting, [NSView new]
  ]];
  formattingBar.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  formattingBar.alignment = NSLayoutAttributeCenterY;
  formattingBar.edgeInsets = NSEdgeInsetsMake(0, 12, 0, 12);
  NSStackView *editorSurface = [NSStackView stackViewWithViews:@[
    formattingBar, editorScroll
  ]];
  editorSurface.orientation = NSUserInterfaceLayoutOrientationVertical;
  editorSurface.alignment = NSLayoutAttributeLeading;
  editorSurface.spacing = 8;
  StyleSurface(editorSurface, AfternoteCanvasColor());
  [formattingBar.widthAnchor constraintEqualToAnchor:editorSurface.widthAnchor].active = YES;
  [editorScroll.widthAnchor constraintEqualToAnchor:editorSurface.widthAnchor].active = YES;
  self.saveButton = [AfternoteButton buttonWithTitle:@"Save changes" target:self action:@selector(saveNote:)];
  [self stylePrimaryButton:self.saveButton];
  self.saveButton.keyEquivalent = @"s";
  self.saveButton.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  [self.saveButton.widthAnchor constraintEqualToConstant:132].active = YES;
  self.discardChangesButton = [AfternoteButton buttonWithTitle:@"Discard changes"
                                                         target:self
                                                         action:@selector(discardEditorChanges:)];
  [self styleSecondaryButton:self.discardChangesButton];
  self.discardChangesButton.accessibilityLabel = @"Discard unsaved note changes";
  self.deleteButton = [AfternoteButton buttonWithTitle:@"Delete permanently" target:self action:@selector(confirmDeleteNote:)];
  [self styleDestructiveButton:self.deleteButton];
  self.editCurrentNoteButton = [AfternoteButton buttonWithTitle:@"Edit current note"
                                                          target:self
                                                          action:@selector(editCurrentNote:)];
  [self styleSecondaryButton:self.editCurrentNoteButton];
  self.editCurrentNoteButton.hidden = YES;
  NSStackView *actions = [NSStackView stackViewWithViews:@[
    self.revisionMenu, [NSView new], self.editCurrentNoteButton,
    self.deleteButton, self.discardChangesButton, self.saveButton
  ]];
  actions.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  actions.alignment = NSLayoutAttributeCenterY;
  actions.spacing = 10;
  NSStackView *editorHeading = [NSStackView stackViewWithViews:@[
    self.memoryBackButton, [NSView new], self.revisionLabel
  ]];
  editorHeading.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  editorHeading.alignment = NSLayoutAttributeCenterY;
  NSStackView *detail = [NSStackView stackViewWithViews:@[
    editorHeading, self.sourceLabel, editorSurface, actions
  ]];
  detail.orientation = NSUserInterfaceLayoutOrientationVertical;
  detail.alignment = NSLayoutAttributeLeading;
  detail.spacing = 12;
  detail.edgeInsets = NSEdgeInsetsMake(38, 0, 28, 0);
  StyleSurface(detail, AfternoteCanvasColor());

  NSView *writeWorkspace = [[NSView alloc] init];
  StyleSurface(writeWorkspace, AfternoteCanvasColor());
  detail.translatesAutoresizingMaskIntoConstraints = NO;
  [writeWorkspace addSubview:detail];
  [NSLayoutConstraint activateConstraints:@[
    [detail.leadingAnchor constraintGreaterThanOrEqualToAnchor:writeWorkspace.leadingAnchor constant:32],
    [detail.trailingAnchor constraintLessThanOrEqualToAnchor:writeWorkspace.trailingAnchor constant:-32],
    [detail.centerXAnchor constraintEqualToAnchor:writeWorkspace.centerXAnchor],
    [detail.topAnchor constraintEqualToAnchor:writeWorkspace.topAnchor],
    [detail.bottomAnchor constraintEqualToAnchor:writeWorkspace.bottomAnchor],
    [detail.widthAnchor constraintLessThanOrEqualToConstant:760],
    [detail.widthAnchor constraintGreaterThanOrEqualToConstant:600],
    [editorHeading.widthAnchor constraintEqualToAnchor:detail.widthAnchor],
    [editorSurface.widthAnchor constraintEqualToAnchor:detail.widthAnchor],
    [actions.widthAnchor constraintEqualToAnchor:detail.widthAnchor],
  ]];

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
    [queryMeta.widthAnchor constraintEqualToAnchor:discoveryColumn.widthAnchor],
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
  AfternoteProductSurface requested = segment == AfternoteProductSurfaceMemory
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
  if (self.ownerExpiresAt.length > 0) [self loadConnectionsAndAudit];
  else [self authenticate:nil];
}

- (void)openSettings:(id)sender {
  (void)sender;
  [self displaySurface:AfternoteProductSurfaceSettings recoveryReady:YES];
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
        if (self.content != nil) [self render];
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
      if (error != nil || !IsLifecycleResult(@"lifecycle.lock", result)) {
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
      if (error != nil || !IsLifecycleResult(@"lifecycle.unlock", result)) {
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
    self.authenticateButton.enabled = NO;
  }
}

- (void)enterNonReadyRecoveryState:(NSString *)state
                            status:(NSString *)status
                           message:(NSString *)message {
  self.lifecycleStatusRequestSequence += 1;
  self.ownerSessionGeneration += 1;
  self.recoveryState = state;
  [self setPrivilegedSurfacesReady:NO];
  [self clearLibraryPlaintext:message];
  self.connections = nil;
  self.ownerExpiresAt = nil;
  self.auditCursor = nil;
  [self.auditEvents removeAllObjects];
  [self.revocationTargets removeAllObjects];
  if (self.content != nil) [self render];
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
  [self.surfaceRouter beginBrokerRecoveryFromNavigationSegment:
      self.surfaceSelector.selectedSegment];
  NSUInteger sequence = ++self.brokerRecoverySequence;
  [self setPrivilegedSurfacesReady:NO];
  [self clearLibraryPlaintext:@"The broker restarted. Reconnecting…"];
  self.connections = nil;
  self.ownerExpiresAt = nil;
  self.auditCursor = nil;
  [self.auditEvents removeAllObjects];
  [self.revocationTargets removeAllObjects];
  if (self.content != nil) [self render];
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
  self.authenticateButton.enabled = YES;
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
        if (error != nil || !IsRecoveryStatusResult(result)) {
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
                IsLifecycleResult(@"lifecycle.status", lifecycle);
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
      if (error != nil || !IsRecoveryStatusResult(result)) {
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
        self.surfaceSelector.selectedSegment = AfternoteProductSurfaceConnections;
        [self updateProductNavigationState];
        [self.surfaceTabs selectTabViewItemAtIndex:kConnectionsTabIndex];
        [self authenticate:nil];
      } else if ([NSProcessInfo.processInfo.arguments containsObject:@"--library"]) {
        self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
        [self updateProductNavigationState];
        [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
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
      if (error != nil || !IsLifecycleResult(@"lifecycle.status", result)) {
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
        self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
        [self updateProductNavigationState];
        [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
        [self setLibraryBusy:NO status:LockedLibraryMessage()];
      } else if ([NSProcessInfo.processInfo.arguments containsObject:@"--connections"]) {
        self.surfaceSelector.selectedSegment = AfternoteProductSurfaceConnections;
        [self updateProductNavigationState];
        [self.surfaceTabs selectTabViewItemAtIndex:kConnectionsTabIndex];
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
  self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
  [self updateProductNavigationState];
  [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
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
    self.revisionMenu.enabled = !controlsBusy && self.libraryExpiresAt.length > 0 &&
        self.revisionHistoryLoaded;
    self.loadMoreNotesButton.enabled = !controlsBusy && self.noteCursor != nil;
    self.libraryRecentButton.enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
    self.createNoteButton.enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
    self.libraryRefreshButton.enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
    for (NSView *view in self.libraryViews.arrangedSubviews) {
      if ([view isKindOfClass:[NSButton class]]) {
        ((NSButton *)view).enabled = !controlsBusy && self.libraryExpiresAt.length > 0;
      }
    }
    BOOL hasUnsavedChanges = AfternoteEditorHasUnsavedChanges(
        self.activeNote ?: @{}, self.noteEditor.string, self.creatingNote);
    self.saveButton.enabled = !controlsBusy && !self.inspectingCitation &&
        hasUnsavedChanges && (self.activeNote != nil || self.creatingNote);
    self.discardChangesButton.enabled = !controlsBusy && !self.inspectingCitation &&
        hasUnsavedChanges;
    self.deleteButton.enabled = !controlsBusy && self.activeNote != nil && !self.creatingNote;
    self.memoryBackButton.enabled = !controlsBusy;
    self.checklistButton.enabled = !controlsBusy && self.noteEditor.editable;
    self.bulletListButton.enabled = !controlsBusy && self.noteEditor.editable;
    self.numberedListButton.enabled = !controlsBusy && self.noteEditor.editable;
    self.libraryStatusLabel.stringValue = status;
    self.libraryProgress.hidden = !controlsBusy;
    if (controlsBusy) [self.libraryProgress startAnimation:nil];
    else [self.libraryProgress stopAnimation:nil];
  };
  if (NSThread.isMainThread) apply();
  else dispatch_async(dispatch_get_main_queue(), apply);
}

- (void)showLibraryMode:(AfternoteLibraryMode)mode loadBrowse:(BOOL)loadBrowse {
  self.libraryListRequestSequence += 1;
  if (self.libraryListInFlight) {
    self.libraryListInFlight = NO;
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
    NSUInteger matchCount = self.noteSummaries.count;
    self.resultsHeadingLabel.stringValue = self.activeQuery.length == 0
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
  if (self.activeQuery.length > 0) {
    self.activeQuery = @"";
    self.librarySearch.stringValue = @"";
    [self updateSearchComposerHeight];
  }
  self.clearSearchButton.hidden = self.librarySearch.stringValue.length == 0;
  if (loadBrowse) {
    self.noteCursor = nil;
    [self.noteSummaries removeAllObjects];
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
    });
  }];
}

- (void)unlockVaultAndOpenLibrary {
  [self clearLibraryPlaintext:@"Waiting for owner approval to unlock the vault…"];
  [self setLibraryBusy:YES status:@"Waiting for owner approval to unlock the vault…"];
  [self.broker requestLifecycleTransitionMethod:@"lifecycle.unlock"
                                          reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (error != nil || !IsLifecycleResult(@"lifecycle.unlock", result)) {
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
    [self styleNavigationButton:button selected:[button.identifier isEqualToString:self.activeView ?: @""]];
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
  self.activeView = sender.identifier.length > 0 ? sender.identifier : nil;
  self.activeQuery = @"";
  self.librarySearch.stringValue = @"";
  [self styleNavigationButton:self.libraryRecentButton selected:self.activeView == nil];
  for (NSButton *button in self.libraryViews.arrangedSubviews) {
    if (![button isKindOfClass:[NSButton class]]) continue;
    [self styleNavigationButton:button selected:[button.identifier isEqualToString:self.activeView ?: @""]];
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
  self.clearSearchButton.hidden = self.activeQuery.length == 0 && draft.length == 0;
}

- (void)controlTextDidEndEditing:(NSNotification *)notification {
  if (notification.object == self.librarySearch) self.askComposer.afternoteFocused = NO;
}

- (void)textDidChange:(NSNotification *)notification {
  if (notification.object != self.noteEditor) return;
  if (self.editorSaveState == AfternoteEditorSaveStateSaved) {
    [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:YES];
  }
  BOOL hasUnsavedChanges = AfternoteEditorHasUnsavedChanges(
      self.activeNote ?: @{}, self.noteEditor.string, self.creatingNote);
  self.saveButton.enabled = hasUnsavedChanges && !self.libraryMutationInFlight;
  self.discardChangesButton.enabled = hasUnsavedChanges && !self.libraryMutationInFlight;
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
  self.activeQuery = @"";
  self.librarySearch.stringValue = @"";
  [self updateSearchComposerHeight];
  self.clearSearchButton.hidden = YES;
  [self showLibraryMode:AfternoteLibraryModeBrowse loadBrowse:YES];
  [self.librarySearch.window makeFirstResponder:self.librarySearch];
}

- (void)refreshVisibleLibraryNotes:(id)sender {
  (void)sender;
  if (self.libraryExpiresAt.length == 0 || self.vaultLocked ||
      self.libraryMutationInFlight || self.libraryListInFlight ||
      self.libraryModeSelector.selectedSegment == AfternoteLibraryModeWrite) return;
  [self loadLibraryNotes:NO];
}

- (void)searchLibrary:(id)sender {
  (void)sender;
  self.libraryNoteRequestSequence += 1;
  self.libraryRevisionRequestSequence += 1;
  self.activeQuery = [self.librarySearch.stringValue stringByTrimmingCharactersInSet:
      NSCharacterSet.whitespaceAndNewlineCharacterSet];
  self.activeView = nil;
  if (self.activeQuery.length == 0) {
    [self clearSearch:nil];
    return;
  }
  [self showLibraryMode:AfternoteLibraryModeAsk loadBrowse:NO];
  self.clearSearchButton.hidden = NO;
  self.resultsHeadingLabel.stringValue = @"Finding results…";
  [self loadLibraryNotes:NO];
}

- (void)loadLibraryNotes:(BOOL)append {
  NSUInteger generation = self.librarySessionGeneration;
  NSUInteger requestSequence = ++self.libraryListRequestSequence;
  if (!append) {
    self.noteCursor = nil;
    [self.noteSummaries removeAllObjects];
    [self.noteTable reloadData];
  }
  self.libraryListInFlight = YES;
  [self setLibraryBusy:YES status:self.activeQuery.length > 0 ? @"Searching without logging the query…" : @"Loading notes…"];
  BOOL searching = self.activeQuery.length > 0;
  NSString *method = searching ? @"library.search" : @"library.browse";
  NSDictionary *params = searching
      ? @{ @"query" : self.activeQuery, @"limit" : @20,
           @"cursor" : append && self.noteCursor != nil ? self.noteCursor : NSNull.null }
      : @{ @"view" : self.activeView ?: NSNull.null, @"limit" : @20,
           @"cursor" : append && self.noteCursor != nil ? self.noteCursor : NSNull.null };
  [self.broker requestMethod:method params:params reply:^(NSDictionary *result, NSDictionary *error) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (generation != self.librarySessionGeneration ||
          requestSequence != self.libraryListRequestSequence) return;
      if (error != nil) {
        self.libraryListInFlight = NO;
        [self showLibraryError:error];
        return;
      }
      NSArray *loaded = ArrayValue(result[@"notes"]);
      if (searching) {
        [self applySearchMode:StringValue(result[@"searchMode"], @"exact")];
        NSMutableArray *searchNotes = [NSMutableArray array];
        NSUInteger rank = 0;
        for (NSDictionary *searchResult in ArrayValue(result[@"results"])) {
          NSDictionary *citation = [searchResult[@"citation"] isKindOfClass:[NSDictionary class]]
              ? searchResult[@"citation"] : @{};
          NSString *noteId = StringValue(citation[@"noteId"]);
          if (noteId.length == 0) continue;
          [searchNotes addObject:@{
            @"id" : noteId,
            @"revision" : citation[@"revision"] ?: @0,
            @"excerpt" : StringValue(citation[@"excerpt"]),
            @"source" : citation[@"source"] ?: NSNull.null,
            @"createdAt" : StringValue(citation[@"createdAt"]),
            @"updatedAt" : StringValue(citation[@"createdAt"]),
            kLibraryResultKindKey : kLibrarySearchResultKind,
            @"rank" : @(++rank),
          }];
        }
        loaded = searchNotes;
      }
      id cursor = result[@"nextCursor"];
      NSArray *displayed = SearchResultsByApplyingPage(self.noteSummaries, loaded, append);
      [self.noteSummaries removeAllObjects];
      [self.noteSummaries addObjectsFromArray:displayed];
      self.noteCursor = [cursor isKindOfClass:[NSString class]] ? cursor : nil;
      self.loadMoreNotesButton.hidden = self.noteCursor == nil;
      self.loadMoreNotesButton.enabled = YES;
      self.libraryListInFlight = NO;
      [self.noteTable reloadData];
      NSUInteger displayedMatchCount = self.noteSummaries.count;
      self.resultsHeadingLabel.stringValue = displayedMatchCount == 0
          ? (searching ? @"No results" : @"No notes yet")
          : (searching
              ? [NSString stringWithFormat:@"Results · %lu",
                   (unsigned long)displayedMatchCount]
              : @"Recent notes");
      NSString *empty = searching ? @"No search results" : @"No notes yet";
      NSString *status = displayedMatchCount == 0
          ? empty
          : [NSString stringWithFormat:@"%lu %@%@ loaded · authenticated until %@",
             (unsigned long)displayedMatchCount,
             searching ? @"match" : @"note",
             displayedMatchCount == 1 ? @"" : @"s",
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
          self.noteEditor.string = draft;
          [self applyEditorTheme];
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
  return tableView == self.noteTable ? self.noteSummaries.count : 0;
}

- (NSTableRowView *)tableView:(NSTableView *)tableView rowViewForRow:(NSInteger)row {
  (void)row;
  return tableView == self.noteTable ? [[AfternoteTableRowView alloc] init] : nil;
}

- (CGFloat)tableView:(NSTableView *)tableView heightOfRow:(NSInteger)row {
  if (tableView != self.noteTable || row < 0 || row >= (NSInteger)self.noteSummaries.count) {
    return tableView.rowHeight;
  }
  NSDictionary *summary = self.noteSummaries[(NSUInteger)row];
  BOOL searchResult = self.libraryModeSelector.selectedSegment == AfternoteLibraryModeAsk &&
      [StringValue(summary[kLibraryResultKindKey]) isEqualToString:kLibrarySearchResultKind];
  if (searchResult) return 112;
  NSString *day = DayLabel(summary[@"createdAt"] ?: summary[@"updatedAt"]);
  BOOL beginsDay = row == 0;
  if (!beginsDay) {
    NSDictionary *previous = self.noteSummaries[(NSUInteger)row - 1];
    beginsDay = ![DayLabel(previous[@"createdAt"] ?: previous[@"updatedAt"])
        isEqualToString:day];
  }
  return beginsDay ? 128 : 104;
}

- (NSView *)tableView:(NSTableView *)tableView
   viewForTableColumn:(NSTableColumn *)tableColumn
                  row:(NSInteger)row {
  (void)tableColumn;
  if (tableView != self.noteTable || row < 0 || row >= (NSInteger)self.noteSummaries.count) return nil;
  NSDictionary *summary = self.noteSummaries[(NSUInteger)row];
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
    NSDictionary *previous = self.noteSummaries[(NSUInteger)row - 1];
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
  if (row < 0 || row >= (NSInteger)self.noteSummaries.count) return;
  NSDictionary *summary = self.noteSummaries[(NSUInteger)row];
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
  [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:NO];
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
        [self setEditorSaveButtonState:AfternoteEditorSaveStateSaved animated:YES];
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
      self.revisionMenu.enabled = !self.libraryMutationInFlight && self.libraryExpiresAt.length > 0;
    });
  }];
}

- (void)renderRevisionMenu {
  [self.revisionMenu removeAllItems];
  [self.revisionMenu addItemWithTitle:self.creatingNote ? @"New note" : @"Current revision"];
  for (NSDictionary *revision in AfternoteHistoricalRevisionRows(
           self.activeNote ?: @{}, self.revisionSummaries ?: @[])) {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:
        [NSString stringWithFormat:@"Revision %@ · %@", revision[@"revision"] ?: @0,
                                   DateLabel(revision[@"createdAt"])]
                                             action:nil keyEquivalent:@""];
    item.representedObject = revision;
    [self.revisionMenu.menu addItem:item];
  }
  if (self.revisionCursor != nil) {
    NSMenuItem *more = [[NSMenuItem alloc] initWithTitle:@"More revisions available…"
                                                 action:nil keyEquivalent:@""];
    more.representedObject = @{ @"loadMore" : @YES };
    [self.revisionMenu.menu addItem:more];
  }
  if (self.inspectingCitation) {
    NSInteger displayedRevision = [self.activeNote[@"revision"] integerValue];
    for (NSMenuItem *item in self.revisionMenu.itemArray) {
      NSDictionary *revision = [item.representedObject isKindOfClass:[NSDictionary class]]
          ? item.representedObject
          : nil;
      if ([revision[@"revision"] integerValue] == displayedRevision) {
        [self.revisionMenu selectItem:item];
        break;
      }
    }
  }
}

- (void)selectRevision:(NSPopUpButton *)sender {
  NSDictionary *revision = [sender.selectedItem.representedObject isKindOfClass:[NSDictionary class]]
      ? sender.selectedItem.representedObject : nil;
  if ([revision[@"loadMore"] boolValue]) {
    [sender selectItemAtIndex:0];
    [self loadRevisionHistory:YES];
    return;
  }
  if (revision == nil) {
    self.inspectingCitation = NO;
    NSString *noteId = ActiveNoteIdentifier(self.activeNote);
    if (noteId.length == 0) {
      NSInteger row = self.noteTable.selectedRow;
      if (row >= 0 && row < (NSInteger)self.noteSummaries.count) {
        noteId = StringValue(self.noteSummaries[(NSUInteger)row][@"id"]);
      }
    }
    if (noteId.length > 0) [self openNoteId:noteId revision:nil];
    return;
  }
  self.inspectingCitation = YES;
  [self openNoteId:StringValue(revision[@"noteId"]) revision:revision[@"revision"]];
}

- (void)renderActiveNote {
  if (self.activeNote == nil && !self.creatingNote) {
    [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:NO];
    self.noteEditor.string = @"";
    self.noteEditor.editable = NO;
    self.revisionLabel.stringValue = @"Choose a note";
    self.sourceLabel.stringValue = @"The note and its source will appear here.";
    [self applyEditorTheme];
    self.saveButton.enabled = NO;
    self.checklistButton.enabled = NO;
    self.bulletListButton.enabled = NO;
    self.numberedListButton.enabled = NO;
    self.deleteButton.hidden = YES;
    self.discardChangesButton.hidden = YES;
    self.editCurrentNoteButton.hidden = YES;
    self.saveButton.hidden = NO;
    self.revisionMenu.hidden = YES;
    return;
  }
  self.noteEditor.string = StringValue(self.activeNote[@"content"]);
  self.noteEditor.selectedRange = NSMakeRange(0, 0);
  [self applyEditorTheme];
  BOOL isCurrentRevision = [self.activeNote[@"id"] isKindOfClass:[NSString class]];
  self.noteEditor.editable = !self.inspectingCitation &&
      (self.creatingNote || isCurrentRevision);
  self.checklistButton.enabled = self.noteEditor.editable && !self.libraryMutationInFlight;
  self.bulletListButton.enabled = self.noteEditor.editable && !self.libraryMutationInFlight;
  self.numberedListButton.enabled = self.noteEditor.editable && !self.libraryMutationInFlight;
  self.revisionLabel.stringValue = self.inspectingCitation
      ? [NSString stringWithFormat:@"Cited result · Revision %@",
           self.activeNote[@"revision"] ?: @0]
      : (self.creatingNote
          ? @"New note"
          : [NSString stringWithFormat:@"Revision %@ · updated %@",
             self.activeNote[@"revision"] ?: @0,
             DateLabel(self.activeNote[@"updatedAt"] ?: self.activeNote[@"createdAt"])]);
  NSDictionary *source = [self.activeNote[@"source"] isKindOfClass:[NSDictionary class]] ? self.activeNote[@"source"] : @{};
  NSMutableArray<NSString *> *parts = [NSMutableArray array];
  for (NSString *key in @[ @"label", @"application", @"author", @"url", @"timestamp" ]) {
    NSString *value = StringValue(source[key]);
    if (value.length > 0) [parts addObject:value];
  }
  self.sourceLabel.stringValue = parts.count > 0
      ? [parts componentsJoinedByString:@" · "]
      : @"Saved locally · No source attached";
  BOOL hasUnsavedChanges = AfternoteEditorHasUnsavedChanges(
      self.activeNote ?: @{}, self.noteEditor.string, self.creatingNote);
  self.saveButton.enabled = !self.inspectingCitation && hasUnsavedChanges &&
      (self.creatingNote || isCurrentRevision);
  self.saveButton.hidden = self.inspectingCitation;
  self.editCurrentNoteButton.hidden = !self.inspectingCitation;
  self.discardChangesButton.hidden = self.inspectingCitation;
  self.discardChangesButton.enabled = hasUnsavedChanges;
  self.deleteButton.hidden = self.inspectingCitation || self.creatingNote ||
      !isCurrentRevision;
  self.revisionMenu.hidden = self.creatingNote;
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
  [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:NO];
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
  [self.noteEditor.window makeFirstResponder:self.noteEditor];
}

- (void)discardEditorChanges:(id)sender {
  (void)sender;
  if (!AfternoteEditorHasUnsavedChanges(
          self.activeNote ?: @{}, self.noteEditor.string, self.creatingNote)) return;
  self.noteEditor.string = StringValue(self.activeNote[@"content"]);
  [self.noteEditor.undoManager removeAllActions];
  [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:NO];
  [self renderActiveNote];
  [self setLibraryBusy:NO status:self.creatingNote
      ? @"Draft cleared."
      : @"Changes discarded. The saved revision is unchanged."];
  [self.noteEditor.window makeFirstResponder:self.noteEditor];
}

- (void)returnToMemory:(id)sender {
  (void)sender;
  BOOL hasUnsavedChanges = self.noteEditor.editable &&
      AfternoteEditorHasUnsavedChanges(
          self.activeNote ?: @{}, self.noteEditor.string, self.creatingNote);
  void (^finish)(void) = ^{
    if (self.creatingNote) {
      self.creatingNote = NO;
      self.activeNote = nil;
      self.activeDeleteTarget = nil;
      self.revisionSummaries = @[];
    }
    [self renderActiveNote];
    AfternoteLibraryMode destination = self.activeQuery.length > 0
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

- (void)applyListTransform:(AfternoteListTransform *)updated
                toTextView:(NSTextView *)textView {
  if (updated == nil) return;
  NSString *text = updated.text;
  NSRange selection = updated.selection;
  if (![text isEqualToString:textView.string]) {
    [textView insertText:text
         replacementRange:NSMakeRange(0, textView.string.length)];
    [self applyEditorTheme];
  }
  textView.selectedRange = selection;
  [textView.window makeFirstResponder:textView];
}

- (void)applyListStyle:(AfternoteListStyle)style {
  if (!self.noteEditor.editable) return;
  [self applyListTransform:AfternoteToggleList(
      self.noteEditor.string, self.noteEditor.selectedRange, style)
                toTextView:self.noteEditor];
}

- (void)toggleBulletList:(id)sender {
  (void)sender;
  [self applyListStyle:AfternoteListStyleBullet];
}

- (void)toggleChecklist:(id)sender {
  (void)sender;
  [self applyListStyle:AfternoteListStyleChecklist];
}

- (void)toggleNumberedList:(id)sender {
  (void)sender;
  [self applyListStyle:AfternoteListStyleNumbered];
}

- (BOOL)textView:(NSTextView *)textView doCommandBySelector:(SEL)commandSelector {
  if (textView != self.noteEditor) return NO;
  if (commandSelector == @selector(insertNewline:)) {
    AfternoteListContinuation *continuation =
        AfternoteContinueList(textView.string, textView.selectedRange);
    if (continuation == nil) return NO;
    [textView insertText:continuation.replacement replacementRange:continuation.range];
    return YES;
  }
  BOOL outdent = commandSelector == @selector(insertBacktab:);
  if (!outdent && commandSelector != @selector(insertTab:)) return NO;
  AfternoteListTransform *updated =
      AfternoteIndentList(textView.string, textView.selectedRange, outdent);
  if (updated == nil) return NO;
  [self applyListTransform:updated toTextView:textView];
  return YES;
}

- (void)setEditorSaveButtonState:(AfternoteEditorSaveState)state
                         animated:(BOOL)animated {
  self.editorSaveState = state;
  AfternoteEditorSavePresentation *presentation =
      AfternoteEditorSavePresentationForState(state);
  AfternoteButton *button = (AfternoteButton *)self.saveButton;
  button.image = nil;
  button.imagePosition = NSNoImage;
  if (presentation.showsSavedConfirmation) {
    NSImageSymbolConfiguration *configuration =
        [NSImageSymbolConfiguration configurationWithPointSize:12
                                                        weight:NSFontWeightSemibold];
    button.image = [[NSImage imageWithSystemSymbolName:@"checkmark"
                              accessibilityDescription:@"Saved"]
        imageWithSymbolConfiguration:configuration];
    button.imagePosition = NSImageLeft;
    button.imageHugsTitle = YES;
    button.title = presentation.title;
    button.contentTintColor = AfternoteCanvasColor();
    button.afternoteFillColor = StatusColor(@"success");
    button.afternoteHoverColor = [StatusColor(@"success")
        blendedColorWithFraction:0.08 ofColor:NSColor.whiteColor];
    button.afternotePressedColor = [StatusColor(@"success")
        blendedColorWithFraction:0.10 ofColor:NSColor.blackColor];
    button.afternoteBorderColor = nil;
    button.accessibilityLabel = presentation.accessibilityLabel;
  } else {
    button.title = presentation.title;
    button.accessibilityLabel = presentation.accessibilityLabel;
    [self stylePrimaryButton:button];
  }
  [button invalidateIntrinsicContentSize];
  [button setNeedsDisplay:YES];
  if (animated && !NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
    button.alphaValue = 0.72;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
      context.duration = 0.14;
      button.animator.alphaValue = 1;
    } completionHandler:nil];
  } else {
    button.alphaValue = 1;
  }
}

- (void)saveNote:(NSButton *)sender {
  NSString *content = self.noteEditor.string;
  if ([[content stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] length] == 0) {
    [self setLibraryBusy:NO status:@"A note cannot be empty."];
    return;
  }
  if (!AfternoteEditorHasUnsavedChanges(
          self.activeNote ?: @{}, content, self.creatingNote)) {
    [self setEditorSaveButtonState:AfternoteEditorSaveStateSaved animated:YES];
    [self setLibraryBusy:NO status:@"No changes to save. The revision is unchanged."];
    return;
  }
  self.editorSaveConfirmationPending = NO;
  [self setEditorSaveButtonState:AfternoteEditorSaveStateSaving animated:YES];
  sender.enabled = NO;
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
        [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:NO];
        [self loadLibraryNotes:NO];
        return;
      }
      if (error != nil) {
        self.libraryMutationInFlight = NO;
        [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:NO];
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
        [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:NO];
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
  self.noteCursor = nil;
  self.revisionCursor = nil;
  self.activeQuery = @"";
  self.activeView = nil;
  self.activeDeleteTarget = nil;
  self.activeNote = nil;
  self.creatingNote = NO;
  self.libraryMutationInFlight = NO;
  self.editorSaveConfirmationPending = NO;
  [self setEditorSaveButtonState:AfternoteEditorSaveStateDefault animated:NO];
  self.libraryListInFlight = NO;
  self.libraryRefreshPending = NO;
  self.revisionHistoryLoaded = NO;
  self.revisionSummaries = @[];
  [self.noteSummaries removeAllObjects];
  self.librarySearch.stringValue = @"";
  [self updateSearchComposerHeight];
  self.clearSearchButton.hidden = YES;
  [self applySearchMode:@"checking"];
  [self.noteTable reloadData];
  [self renderActiveNote];
  [self.noteEditor.undoManager removeAllActions];
  [self renderRevisionMenu];
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

- (NSView *)connectionDetailRowWithTitle:(NSString *)title
                                  status:(NSString *)status
                                    body:(NSArray<NSString *> *)body
                                  button:(NSButton *)button {
  NSTextField *heading = [self label:title size:16 weight:NSFontWeightSemibold];
  NSTextField *badge = [self label:[status uppercaseString] size:10 weight:NSFontWeightBold];
  badge.textColor = StatusColor(status);
  badge.accessibilityLabel = [NSString stringWithFormat:@"Status: %@", status];
  NSMutableArray<NSView *> *headingViews = [NSMutableArray arrayWithObjects:heading, badge, [NSView new], nil];
  if (button != nil) [headingViews addObject:button];
  NSStackView *header = [NSStackView stackViewWithViews:headingViews];
  header.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  header.alignment = NSLayoutAttributeCenterY;
  header.spacing = 8;
  NSMutableArray<NSView *> *rows = [NSMutableArray arrayWithObject:header];
  for (NSString *line in body) {
    NSTextField *label = [self label:line size:12 weight:NSFontWeightRegular];
    label.textColor = AfternoteMutedTextColor();
    [rows addObject:label];
  }
  NSStackView *content = [NSStackView stackViewWithViews:rows];
  content.orientation = NSUserInterfaceLayoutOrientationVertical;
  content.alignment = NSLayoutAttributeLeading;
  content.spacing = 6;
  content.edgeInsets = NSEdgeInsetsMake(15, 0, 15, 0);
  NSBox *divider = [[NSBox alloc] init];
  divider.boxType = NSBoxSeparator;
  NSStackView *group = [NSStackView stackViewWithViews:@[ content, divider ]];
  group.orientation = NSUserInterfaceLayoutOrientationVertical;
  group.alignment = NSLayoutAttributeLeading;
  group.spacing = 0;
  [content.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  [header.widthAnchor constraintEqualToAnchor:content.widthAnchor].active = YES;
  [divider.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  return group;
}

- (void)addCard:(NSView *)card {
  [self.content addArrangedSubview:card];
  [card.widthAnchor constraintEqualToAnchor:self.content.widthAnchor].active = YES;
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
  [self refreshIntegrationStatuses];
}

- (void)installIntegration:(NSButton *)sender {
  NSString *kind = sender.identifier;
  if (![kind isEqualToString:@"codex"] && ![kind isEqualToString:@"claude-code"]) return;
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
  if (![kind isEqualToString:@"codex"] && ![kind isEqualToString:@"claude-code"]) return;
  if ([self.integrationOperations containsObject:kind]) return;
  AdvanceIntegrationGeneration(self.integrationStatusGenerations, kind);
  [self.integrationOperations addObject:kind];
  NSMutableDictionary *pending = [self.integrationStatuses[kind] mutableCopy]
      ?: [NSMutableDictionary dictionary];
  pending[@"uiState"] = @"reconnecting";
  self.integrationStatuses[kind] = pending;
  [self render];
  [self renderSetupGuide];
  [self runPackagedCommand:@[ kind, @"rotate-identity" ]
                completion:^(NSDictionary *result, NSString *errorMessage) {
    (void)result;
    [self.integrationOperations removeObject:kind];
    if (errorMessage.length > 0) {
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
    [self refreshIntegrationStatuses];
    NSAlert *ready = [[NSAlert alloc] init];
    ready.messageText = @"Reconnect prepared";
    ready.informativeText = [NSString stringWithFormat:
        @"The Afternote MCP server is already installed in %@. Its revoked identity has been replaced. Close any open sessions, start a new one, then use Remember or Recall once to approve the fresh connection.",
        displayName];
    [ready addButtonWithTitle:@"Got it"];
    [ready beginSheetModalForWindow:self.window completionHandler:nil];
  }];
}

- (void)openIntegrationDownload:(NSButton *)sender {
  NSString *urlString = [sender.identifier isEqualToString:@"codex"]
      ? @"https://openai.com/codex/"
      : @"https://docs.anthropic.com/en/docs/claude-code/getting-started";
  NSURL *url = [NSURL URLWithString:urlString];
  if (url != nil) [NSWorkspace.sharedWorkspace openURL:url];
}

- (void)reviewIntegrationSetup:(NSButton *)sender {
  NSString *displayName = [self integrationDisplayNameForKind:sender.identifier];
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"Existing connector needs review";
  alert.informativeText = [NSString stringWithFormat:
      @"%@ already has an MCP connector named “afternote” that was not created by this Afternote installation. Afternote will not overwrite it. Remove or rename that entry in %@, then return here and check again.",
      displayName, displayName];
  [alert addButtonWithTitle:@"Got it"];
  [alert beginSheetModalForWindow:self.window completionHandler:nil];
}

- (NSButton *)integrationActionForKind:(NSString *)kind
                            displayName:(NSString *)displayName
                           presentation:(AfternoteConnectorPresentation *)presentation {
  NSButton *button = nil;
  if (presentation.action == AfternoteConnectorActionGetTool) {
    button = [AfternoteButton buttonWithTitle:
        [kind isEqualToString:@"codex"] ? @"Get Codex" : @"Get Claude Code"
                                       target:self
                                       action:@selector(openIntegrationDownload:)];
  } else if (presentation.action == AfternoteConnectorActionConnect) {
    button = [AfternoteButton buttonWithTitle:@"Connect Afternote"
                                       target:self
                                       action:@selector(installIntegration:)];
  } else if (presentation.action == AfternoteConnectorActionPrepareReconnect) {
    button = [AfternoteButton buttonWithTitle:@"Prepare reconnect"
                                       target:self
                                       action:@selector(reconnectIntegration:)];
  } else if (presentation.action == AfternoteConnectorActionRepair) {
    button = [AfternoteButton buttonWithTitle:@"Repair Afternote"
                                       target:self
                                       action:@selector(installIntegration:)];
  } else if (presentation.action == AfternoteConnectorActionCheckAgain) {
    button = [AfternoteButton buttonWithTitle:@"Check again"
                                       target:self
                                       action:@selector(refreshIntegrationStatusFromButton:)];
  } else if (presentation.action == AfternoteConnectorActionReviewSetup) {
    button = [AfternoteButton buttonWithTitle:@"Review setup"
                                       target:self
                                       action:@selector(reviewIntegrationSetup:)];
  }
  if (button == nil) return nil;
  button.identifier = kind;
  button.accessibilityLabel = [NSString stringWithFormat:@"%@ in %@",
      button.title, displayName];
  [self styleSecondaryButton:button];
  return button;
}

- (void)setBusy:(BOOL)busy status:(NSString *)status {
  dispatch_async(dispatch_get_main_queue(), ^{
    BOOL authenticated = self.ownerExpiresAt.length > 0;
    self.authenticateButton.title = authenticated ? @"Refresh" : @"Authenticate";
    if (authenticated) [self styleSecondaryButton:self.authenticateButton];
    else [self stylePrimaryButton:self.authenticateButton];
    self.authenticateButton.enabled = !busy;
    self.statusLabel.stringValue = status;
    self.progress.hidden = !busy;
    if (busy) [self.progress startAnimation:nil];
    else [self.progress stopAnimation:nil];
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

- (void)clearContent {
  for (NSView *view in [self.content.arrangedSubviews copy]) {
    [self.content removeArrangedSubview:view];
    [view removeFromSuperview];
  }
}

- (void)clearSetupContent {
  for (NSView *view in [self.setupContent.arrangedSubviews copy]) {
    [self.setupContent removeArrangedSubview:view];
    [view removeFromSuperview];
  }
}

- (void)openConnectionsFromSetup:(id)sender {
  (void)sender;
  self.surfaceSelector.selectedSegment = AfternoteProductSurfaceConnections;
  [self switchSurface:self.surfaceSelector];
}

- (void)openSetupGuide:(id)sender {
  (void)sender;
  self.setupGuideDismissed = NO;
  [NSUserDefaults.standardUserDefaults setBool:NO
                                        forKey:kSetupGuideDismissedDefaultsKey];
  [self updateSetupBannerVisibility];
  self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
  [self updateProductNavigationState];
  [self.surfaceTabs selectTabViewItemAtIndex:kSetupTabIndex];
  [self renderSetupGuide];
  if (self.connections == nil) [self authenticate:nil];
}

- (void)returnFromSetupGuide:(id)sender {
  (void)sender;
  self.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
  [self updateProductNavigationState];
  [self.surfaceTabs selectTabViewItemAtIndex:kMemoryTabIndex];
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
  NSArray *activeClients = [allClients filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSDictionary *client, NSDictionary *bindings) {
    (void)bindings;
    return ConnectorHasCurrentAuthority(client);
  }]];
  [self.setupContent addArrangedSubview:
      [self setupRowWithTitle:@"Local notes"
                       detail:[self localSearchReadinessDetail]
                        badge:@"Ready"
                         tone:@"success"
                       button:nil]];

  BOOL integrationActive = activeClients.count > 0;
  AfternoteIntegrationDescriptor *revokedDescriptor = nil;
  for (AfternoteIntegrationDescriptor *descriptor in IntegrationDescriptors()) {
    NSArray *matching = [self clients:allClients forKind:descriptor.brokerKind];
    NSDictionary *current = [self currentClientFromClients:matching];
    BOOL revoked = [[StringValue(current[@"status"]) lowercaseString]
        isEqualToString:@"revoked"];
    if (revoked && [self.integrationStatuses[descriptor.commandKind][@"healthy"] boolValue]) {
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
                           : integrationActive
                           ? @"Afternote is available in at least one of your local tools."
                           : @"Choose Codex or Claude Code. Afternote configures the connection for you."
                        badge:revokedDescriptor != nil ? @"Reconnect" : integrationActive ? @"Active" : @"Next"
                         tone:integrationActive && revokedDescriptor == nil ? @"success" : @"warning"
                       button:connectionsButton]];

  BOOL proofComplete = AfternoteHasCorrelatedRecallProof(self.auditEvents);
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

- (NSView *)connectorFactWithTitle:(NSString *)title value:(NSString *)value {
  NSTextField *heading = [self label:title size:10 weight:NSFontWeightSemibold];
  heading.textColor = AfternoteMutedTextColor();
  NSTextField *copy = [self label:value size:12 weight:NSFontWeightRegular];
  copy.textColor = AfternoteTextColor();
  NSStackView *fact = [NSStackView stackViewWithViews:@[ heading, copy ]];
  fact.orientation = NSUserInterfaceLayoutOrientationVertical;
  fact.alignment = NSLayoutAttributeLeading;
  fact.spacing = 3;
  return fact;
}

- (NSView *)connectorRowForCommandKind:(NSString *)commandKind
                             brokerKind:(NSString *)brokerKind
                            displayName:(NSString *)displayName
                                clients:(NSArray<NSDictionary *> *)clients
                                 grants:(NSArray<NSDictionary *> *)grants {
  NSDictionary *integrationStatus = commandKind.length > 0
      ? self.integrationStatuses[commandKind] : nil;
  NSDictionary *current = [self currentClientFromClients:clients];
  BOOL connected = ConnectorHasCurrentAuthority(current);
  BOOL explicitlyRevoked = [[StringValue(current[@"status"]) lowercaseString]
      isEqualToString:@"revoked"];

  NSArray *events = [self.auditEvents filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSDictionary *event, NSDictionary *bindings) {
    (void)bindings;
    return [StringValue(event[@"clientKind"]) isEqualToString:brokerKind];
  }]];
  NSDictionary *activity = ConnectorActivitySummary(events);
  NSArray *defaultScopes = commandKind.length > 0
      ? @[ @"memory.remember", @"memory.recall", @"memory.get_note" ]
      : @[];
  NSArray *visibleScopes = connected
      ? ArrayValue(current[@"activeScopes"])
      : defaultScopes;
  NSString *lastUsed = StringValue(current[@"lastActivityAt"]);
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
                                          lastActiveLabel:lastUsed.length > 0
                                              ? DateLabel(lastUsed) : @""];
  NSString *activityValue = [NSString stringWithFormat:@"%@ saved · %@ recalled",
      activity[@"saves"], activity[@"reads"]];
  if (lastUsed.length > 0) {
    activityValue = [activityValue stringByAppendingFormat:@" · Last used %@",
                     DateLabel(lastUsed)];
  }

  NSArray<NSString *> *historyLines = [self connectorHistoryForKind:brokerKind
                                                            clients:clients
                                                             grants:grants];
  NSMutableArray<NSView *> *connectionViews = [NSMutableArray array];
  NSTextField *connectionLabel = [self label:@"Current connection"
                                         size:10
                                       weight:NSFontWeightSemibold];
  connectionLabel.textColor = AfternoteMutedTextColor();
  NSTextField *connectionValue = [self label:presentation.connectionTitle
                                         size:12
                                       weight:NSFontWeightSemibold];
  NSTextField *connectionCopy = [self label:presentation.connectionDetail
                                        size:11
                                      weight:NSFontWeightRegular];
  connectionCopy.textColor = AfternoteMutedTextColor();
  [connectionViews addObjectsFromArray:@[
    connectionLabel, connectionValue, connectionCopy
  ]];
  if (connected) {
    NSArray *scopes = ArrayValue(current[@"activeScopes"]);
    NSButton *revoke = [AfternoteButton buttonWithTitle:@"Revoke access"
                                                   target:self
                                                   action:@selector(confirmRevocation:)];
    [self styleDestructiveButton:revoke];
    self.revocationTargets[brokerKind] = @{
      @"kind" : brokerKind,
      @"displayLabel" : displayName,
      @"scopes" : scopes,
    };
    revoke.identifier = brokerKind;
    revoke.accessibilityLabel = [NSString stringWithFormat:@"Revoke %@ access", displayName];
    [connectionViews addObject:revoke];
  } else if (commandKind.length > 0) {
    NSButton *setup = [self integrationActionForKind:commandKind
                                          displayName:displayName
                                        presentation:presentation];
    if (setup != nil) [connectionViews addObject:setup];
  }

  NSTextField *heading = [self label:displayName size:16 weight:NSFontWeightSemibold];
  NSTextField *badge = [self label:[presentation.badge uppercaseString]
                                 size:10 weight:NSFontWeightBold];
  badge.textColor = StatusColor(presentation.tone);
  badge.accessibilityLabel = [NSString stringWithFormat:@"Status: %@", presentation.badge];
  NSStackView *header = [NSStackView stackViewWithViews:@[ heading, badge, [NSView new] ]];
  header.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  header.alignment = NSLayoutAttributeCenterY;
  header.spacing = 8;

  NSTextField *state = [self label:presentation.summary size:12 weight:NSFontWeightRegular];
  state.textColor = AfternoteMutedTextColor();
  NSStackView *facts = [NSStackView stackViewWithViews:@[
    [self connectorFactWithTitle:@"Permissions" value:ScopesLabel(visibleScopes)],
    [self connectorFactWithTitle:@"Recent activity" value:activityValue],
  ]];
  facts.orientation = NSUserInterfaceLayoutOrientationVertical;
  facts.alignment = NSLayoutAttributeLeading;
  facts.spacing = 12;
  NSStackView *currentConnection = [NSStackView stackViewWithViews:connectionViews];
  currentConnection.orientation = NSUserInterfaceLayoutOrientationVertical;
  currentConnection.alignment = NSLayoutAttributeLeading;
  currentConnection.spacing = 4;
  [currentConnection.widthAnchor constraintGreaterThanOrEqualToConstant:210].active = YES;
  NSStackView *details = [NSStackView stackViewWithViews:@[
    facts, [NSView new], currentConnection
  ]];
  details.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  details.alignment = NSLayoutAttributeTop;
  details.spacing = 24;

  NSMutableArray<NSView *> *rows = [NSMutableArray arrayWithObjects:header, state, details, nil];
  BOOL expanded = [self.expandedConnectorKinds containsObject:brokerKind];
  NSImage *image = [NSImage imageWithSystemSymbolName:expanded ? @"chevron.down" : @"chevron.right"
                            accessibilityDescription:expanded ? @"Hide history" : @"Show history"];
  NSButton *history = [AfternoteButton buttonWithTitle:@"Connection history"
                                                target:self
                                                action:@selector(toggleConnectorHistory:)];
  history.identifier = brokerKind;
  history.image = image;
  history.imagePosition = NSImageLeft;
  history.imageHugsTitle = YES;
  history.bordered = NO;
  history.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
  history.contentTintColor = AfternoteBrandCaptureColor();
  history.accessibilityLabel = [NSString stringWithFormat:@"%@ %@ connection history",
                                 expanded ? @"Hide" : @"Show", displayName];
  NSTextField *historyCount = [self label:[NSString stringWithFormat:@"%lu event%@",
      (unsigned long)historyLines.count, historyLines.count == 1 ? @"" : @"s"]
                                         size:10
                                       weight:NSFontWeightRegular];
  historyCount.textColor = AfternoteMutedTextColor();
  NSStackView *historyDisclosure = [NSStackView stackViewWithViews:@[
    history, historyCount, [NSView new]
  ]];
  historyDisclosure.orientation = NSUserInterfaceLayoutOrientationHorizontal;
  historyDisclosure.alignment = NSLayoutAttributeCenterY;
  historyDisclosure.spacing = 8;
  [rows addObject:historyDisclosure];
  if (expanded) {
    NSTextView *historyText = [[NSTextView alloc]
        initWithFrame:NSMakeRect(0, 0, 820, 104)];
    historyText.editable = NO;
    historyText.selectable = YES;
    historyText.richText = NO;
    historyText.drawsBackground = NO;
    historyText.font = [NSFont systemFontOfSize:11 weight:NSFontWeightRegular];
    historyText.textColor = AfternoteMutedTextColor();
    historyText.textContainerInset = NSMakeSize(0, 6);
    historyText.autoresizingMask = NSViewWidthSizable;
    historyText.string = historyLines.count > 0
        ? [historyLines componentsJoinedByString:@"\n"]
        : @"No connection history yet.";
    historyText.accessibilityLabel = [NSString stringWithFormat:@"%@ access history", displayName];
    NSScrollView *historyScroll = [[NSScrollView alloc] init];
    historyScroll.documentView = historyText;
    historyScroll.hasVerticalScroller = YES;
    historyScroll.drawsBackground = NO;
    historyScroll.borderType = NSNoBorder;
    [historyScroll.heightAnchor constraintEqualToConstant:104].active = YES;
    [rows addObject:historyScroll];
    if (self.auditCursor != nil) {
      NSButton *older = [AfternoteButton buttonWithTitle:@"Show older events"
                                                   target:self
                                                   action:@selector(loadMore:)];
      older.bordered = NO;
      older.font = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium];
      older.contentTintColor = AfternoteMutedTextColor();
      older.accessibilityLabel = [NSString stringWithFormat:
          @"Show older redacted %@ connection events", displayName];
      [rows addObject:older];
    }
  }
  NSStackView *content = [NSStackView stackViewWithViews:rows];
  content.orientation = NSUserInterfaceLayoutOrientationVertical;
  content.alignment = NSLayoutAttributeLeading;
  content.spacing = 10;
  content.edgeInsets = NSEdgeInsetsMake(15, 0, 15, 0);
  NSBox *divider = [[NSBox alloc] init];
  divider.boxType = NSBoxSeparator;
  NSStackView *group = [NSStackView stackViewWithViews:@[ content, divider ]];
  group.orientation = NSUserInterfaceLayoutOrientationVertical;
  group.alignment = NSLayoutAttributeLeading;
  group.spacing = 0;
  [content.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  [header.widthAnchor constraintEqualToAnchor:content.widthAnchor].active = YES;
  [divider.widthAnchor constraintEqualToAnchor:group.widthAnchor].active = YES;
  for (NSView *row in rows) {
    if (row != header) [row.widthAnchor constraintEqualToAnchor:content.widthAnchor].active = YES;
  }
  return group;
}

- (void)toggleConnectorHistory:(NSButton *)sender {
  NSString *kind = sender.identifier;
  if (kind.length == 0) return;
  if ([self.expandedConnectorKinds containsObject:kind]) {
    [self.expandedConnectorKinds removeObject:kind];
  } else {
    [self.expandedConnectorKinds addObject:kind];
  }
  [self render];
}

- (void)render {
  [self renderSetupGuide];
  [self clearContent];
  NSArray *clients = ArrayValue(self.connections[@"clients"]);
  NSArray *grants = ArrayValue(self.connections[@"grants"]);
  [self.revocationTargets removeAllObjects];
  NSMutableSet<NSString *> *renderedKinds = [NSMutableSet set];
  for (AfternoteIntegrationDescriptor *descriptor in IntegrationDescriptors()) {
    NSArray *matching = [self clients:clients forKind:descriptor.brokerKind];
    [self addCard:[self connectorRowForCommandKind:descriptor.commandKind
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
    [self addCard:[self connectorRowForCommandKind:nil
                                        brokerKind:kind
                                       displayName:StringValue(current[@"displayLabel"], @"Local tool")
                                           clients:matching
                                            grants:grants]];
    [renderedKinds addObject:kind];
  }
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
  [self loadConnectionsAndAudit];
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
    [self clearContent];
    [self addCard:[self connectionDetailRowWithTitle:@"Connections unavailable"
                                              status:@"unavailable"
                                                body:@[message, @"No web session or local request can substitute for native owner authentication."]
                                              button:nil]];
  });
}

@end


#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
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
  delegate.noteSummaries = [NSMutableArray array];
  delegate.noteTable = [[NSTableView alloc] init];
  delegate.revisionMenu = [[NSPopUpButton alloc] init];
  [delegate.revisionMenu addItemWithTitle:@"Current revision"];
  [delegate.revisionMenu selectItemAtIndex:0];
  [delegate selectRevision:delegate.revisionMenu];
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
  delegate.noteSummaries = [NSMutableArray arrayWithObject:@{
    @"id" : noteId,
    @"revision" : @3,
    @"excerpt" : @"Frozen citation",
    kLibraryResultKindKey : kLibrarySearchResultKind,
  }];
  [delegate.noteTable reloadData];
  [delegate.noteTable selectRowIndexes:[NSIndexSet indexSetWithIndex:0]
                  byExtendingSelection:NO];
  [delegate tableViewSelectionDidChange:
      [NSNotification notificationWithName:NSTableViewSelectionDidChangeNotification
                                    object:delegate.noteTable]];
  BOOL citationUsesExactRevision = delegate.inspectingCitation &&
      [delegate.openedNoteId isEqualToString:noteId] &&
      delegate.openedRevision.integerValue == 3;

  delegate.noteSummaries = [NSMutableArray arrayWithObject:@{
    @"id" : noteId,
    @"revision" : @4,
    @"excerpt" : @"Current note",
  }];
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

int RunSearchStateSmoke() {
  NSDictionary *firstNote = @{
    @"id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"revision" : @1,
    @"excerpt" : @"The release phrase is northstar 42.",
    @"source" : @{ @"application" : @"Codex" },
    @"createdAt" : @"2026-08-31T01:00:00.000Z",
    @"updatedAt" : @"2026-08-31T01:00:00.000Z",
    kLibraryResultKindKey : kLibrarySearchResultKind,
  };
  NSDictionary *secondNote = @{
    @"id" : @"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    @"revision" : @2,
    @"excerpt" : @"The production push waits for notarization.",
    @"source" : @{ @"application" : @"Claude Code" },
    @"createdAt" : @"2026-08-31T02:00:00.000Z",
    @"updatedAt" : @"2026-08-31T02:00:00.000Z",
    kLibraryResultKindKey : kLibrarySearchResultKind,
  };
  NSArray *firstSearch = SearchResultsByApplyingPage(@[], @[ firstNote ], NO);
  NSArray *replaced = SearchResultsByApplyingPage(firstSearch, @[ secondNote ], NO);
  NSArray *appended = SearchResultsByApplyingPage(replaced, @[ firstNote ], YES);
  BOOL newSearchReplacedResults = replaced.count == 1 &&
      [StringValue(replaced[0][@"excerpt"])
          isEqualToString:@"The production push waits for notarization."];
  BOOL pageAppendPreservedResults = appended.count == 2 &&
      [StringValue(appended[0][@"excerpt"])
          isEqualToString:@"The production push waits for notarization."] &&
      [StringValue(appended[1][@"excerpt"])
          isEqualToString:@"The release phrase is northstar 42."];
  NSDictionary *output = @{
    @"newSearchReplacedResults" : @(newSearchReplacedResults),
    @"pageAppendPreservedResults" : @(pageAppendPreservedResults),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return newSearchReplacedResults && pageAppendPreservedResults ? 0 : 2;
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
  NSUInteger codexInstall = AdvanceIntegrationGeneration(generations, @"codex");
  BOOL codexStatusBecameStale = !IntegrationGenerationIsCurrent(
      generations, @"codex", codexFirst);
  BOOL codexInstallStayedCurrent = IntegrationGenerationIsCurrent(
      generations, @"codex", codexInstall);
  BOOL claudeStatusStayedCurrent = IntegrationGenerationIsCurrent(
      generations, @"claude-code", claudeFirst);
  NSDictionary *output = @{
    @"codexStatusBecameStale" : @(codexStatusBecameStale),
    @"codexInstallStayedCurrent" : @(codexInstallStayedCurrent),
    @"claudeStatusStayedCurrent" : @(claudeStatusStayedCurrent),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return codexStatusBecameStale && codexInstallStayedCurrent &&
      claudeStatusStayedCurrent ? 0 : 2;
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
  delegate.noteSummaries = [NSMutableArray arrayWithObject:@{
    @"id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    @"revision" : @1,
    @"excerpt" : @"Sensitive fixture",
  }];
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
  delegate.noteEditor = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 320, 180)];
  delegate.noteEditor.string = @"Sensitive fixture";
  delegate.revisionLabel = [[NSTextField alloc] init];
  delegate.sourceLabel = [[NSTextField alloc] init];
  delegate.revisionMenu = [[NSPopUpButton alloc] init];
  delegate.libraryAuthenticateButton = [[NSButton alloc] init];
  delegate.libraryRecentButton = [[NSButton alloc] init];
  delegate.createNoteButton = [[NSButton alloc] init];
  delegate.loadMoreNotesButton = [[NSButton alloc] init];
  delegate.saveButton = [[AfternoteButton alloc] init];
  delegate.deleteButton = [[NSButton alloc] init];
  delegate.memoryBackButton = [[NSButton alloc] init];
  delegate.libraryStatusLabel = [[NSTextField alloc] init];
  delegate.libraryProgress = [[NSProgressIndicator alloc] init];
  delegate.libraryViews = [NSStackView stackViewWithViews:@[]];
  delegate.authenticateButton = [[NSButton alloc] init];
  delegate.statusLabel = [[NSTextField alloc] init];
  delegate.progress = [[NSProgressIndicator alloc] init];
  delegate.memoryNavigationButton = [[NSButton alloc] init];
  delegate.connectionsNavigationButton = [[NSButton alloc] init];
  delegate.surfaceSelector = [NSSegmentedControl
      segmentedControlWithLabels:@[ @"Notes", @"Connections" ]
                  trackingMode:NSSegmentSwitchTrackingSelectOne
                        target:nil action:nil];
  delegate.surfaceSelector.selectedSegment = AfternoteProductSurfaceMemory;
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
      recovered.noteEditor.string.length == 0 && recovered.libraryExpiresAt == nil &&
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
  locked.surfaceSelector.selectedSegment = AfternoteProductSurfaceConnections;
  [locked brokerDidDisconnect];
  WaitForBrokerRecovery(locked);
  BOOL lockedVaultRemainsActionable = !locked.brokerRecoveryInFlight &&
      [locked.recoveryState isEqualToString:@"ready"] && locked.vaultLocked &&
      locked.surfaceSelector.selectedSegment == AfternoteProductSurfaceMemory &&
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
      : error == nil && IsLifecycleTransitionConsistent(@"lifecycle.lock", prior, lockResult);
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
  delegate.noteSummaries = [NSMutableArray arrayWithObject:@{ @"excerpt" : canary }];
  delegate.revisionSummaries = @[ @{ @"revision" : @1, @"excerpt" : canary } ];
  delegate.activeQuery = canary;
  delegate.activeView = @"decisions";
  delegate.activeDeleteTarget = canary;
  delegate.activeNote = @{ @"id" : @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                           @"revision" : @1, @"content" : canary };
  delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
  delegate.librarySearch = [[NSSearchField alloc] init];
  delegate.librarySearch.stringValue = canary;
  delegate.noteTable = [[NSTableView alloc] init];
  delegate.noteEditor = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 320, 180)];
  delegate.noteEditor.string = canary;
  [delegate.noteEditor.undoManager registerUndoWithTarget:delegate handler:^(id target) {
    (void)target;
  }];
  delegate.revisionLabel = [[NSTextField alloc] init];
  delegate.sourceLabel = [[NSTextField alloc] init];
  delegate.revisionMenu = [[NSPopUpButton alloc] init];
  delegate.libraryAuthenticateButton = [[NSButton alloc] init];
  delegate.libraryRecentButton = [[NSButton alloc] init];
  delegate.createNoteButton = [[NSButton alloc] init];
  delegate.loadMoreNotesButton = [[NSButton alloc] init];
  delegate.saveButton = [[AfternoteButton alloc] init];
  delegate.deleteButton = [[NSButton alloc] init];
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
  delegate.content = [NSStackView stackViewWithViews:@[]];
  delegate.authenticateButton = [[NSButton alloc] init];
  delegate.statusLabel = [[NSTextField alloc] init];
  delegate.progress = [[NSProgressIndicator alloc] init];
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
  delegate.noteEditor.string = canary;
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
      delegate.noteEditor.string.length == 0 &&
      ![delegate.surfaceSelector isEnabledForSegment:0] &&
      ![delegate.surfaceSelector isEnabledForSegment:1] &&
      delegate.surfaceSelector.selectedSegment == -1;
  BOOL staleOwnerReplyRejected = delegate.ownerExpiresAt == nil &&
      delegate.connections == nil;
  BOOL staleRevocationReplyRejected =
      ![delegate.statusLabel.stringValue containsString:@"Fixture client revoked"];
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
      IsLifecycleTransitionConsistent(@"lifecycle.lock", unlockedEpoch, lockedSameEpoch) &&
      !IsLifecycleTransitionConsistent(@"lifecycle.lock", unlockedEpoch, lockedOtherEpoch) &&
      IsLifecycleTransitionConsistent(@"lifecycle.unlock", lockedSameEpoch,
                                      unlockedRotatedEpoch) &&
      !IsLifecycleTransitionConsistent(@"lifecycle.unlock", lockedSameEpoch, unlockedEpoch);
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
  delegate.noteEditor.string = canary;
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
  while ((delegate.activeNote != nil || delegate.noteEditor.string.length > 0 ||
          delegate.libraryExpiresAt != nil) && [crossSurfaceDeadline timeIntervalSinceNow] > 0) {
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  BOOL crossSurfaceMalformedOwnerCleared = malformedOwnerRejected &&
      delegate.activeNote == nil && delegate.noteEditor.string.length == 0 &&
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
      delegate.noteSummaries.count == 0 && delegate.revisionSummaries.count == 0 &&
      delegate.activeQuery.length == 0 && delegate.activeView == nil &&
      delegate.activeDeleteTarget == nil && delegate.noteEditor.string.length == 0 &&
      delegate.librarySearch.stringValue.length == 0 &&
      !delegate.noteEditor.undoManager.canUndo && !staleReplyApplied &&
      !delegate.libraryRecentButton.enabled && !libraryViewButton.enabled;
  BOOL sensitiveSheetCleared = delegate.librarySensitiveAlert == nil &&
      delegate.librarySensitiveTextView == nil && sensitiveText.string.length == 0 &&
      ![sensitiveAlert.informativeText containsString:canary];

  delegate.activeNote = @{ @"content" : canary };
  delegate.noteEditor.string = canary;
  [delegate clearLibraryPlaintext:@"Library session expired"];
  BOOL expiryCleared = delegate.activeNote == nil && delegate.noteEditor.string.length == 0;
  BOOL protocolInvalidationCleared = YES;
  BOOL lockedResponseFeedback = NO;
  for (NSString *code in @[
    @"invalid_request", @"invalid_cursor", @"invalid_response",
    @"replayed", @"identity_mismatch", @"vault_locked"
  ]) {
    delegate.activeNote = @{ @"content" : canary };
    delegate.noteEditor.string = canary;
    delegate.libraryExpiresAt = @"2099-01-01T00:00:00.000Z";
    NSUInteger priorGeneration = delegate.librarySessionGeneration;
    [delegate showLibraryError:@{ @"code" : code }];
    protocolInvalidationCleared = protocolInvalidationCleared &&
        delegate.librarySessionGeneration == priorGeneration + 1 &&
        delegate.activeNote == nil && delegate.noteEditor.string.length == 0 &&
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
    @"undoHistoryCleared" : @(!delegate.noteEditor.undoManager.canUndo),
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

int RunProtocolSmoke() {
  OwnerBrokerConnection *broker = NewOwnerBrokerConnection(ServiceName());
  if (broker == nil) return 2;
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
#endif


int main(int argc, const char *argv[]) {
  @autoreleasepool {
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
    if (argc == 2 && strcmp(argv[1], "--search-state-smoke") == 0) {
#if defined(AFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING)
      return RunSearchStateSmoke();
#else
      fputs("search state smoke is unavailable in packaged builds\n", stderr);
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
