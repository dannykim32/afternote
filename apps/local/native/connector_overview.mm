#import "connector_overview.h"
#include <cmath>

namespace {

BOOL HasExactKeys(NSDictionary *dictionary, NSArray<NSString *> *keys) {
  return [[NSSet setWithArray:dictionary.allKeys]
      isEqualToSet:[NSSet setWithArray:keys]];
}

BOOL IsMember(id value, NSArray<NSString *> *allowed) {
  return [value isKindOfClass:[NSString class]] && [allowed containsObject:value];
}

BOOL IsNonnegativeInteger(id value) {
  if (![value isKindOfClass:[NSNumber class]] ||
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
  double number = [value doubleValue];
  return isfinite(number) && floor(number) == number && number >= 0 &&
      number <= (double)NSUIntegerMax;
}

BOOL IsBoolean(id value) {
  return [value isKindOfClass:[NSNumber class]] &&
      CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

BOOL IsNullableDate(id value) {
  if (value == NSNull.null) return YES;
  if (![value isKindOfClass:[NSString class]] || [value length] > 64) return NO;
  static NSISO8601DateFormatter *formatter;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
        NSISO8601DateFormatWithFractionalSeconds;
  });
  return [formatter dateFromString:value] != nil;
}

BOOL IsScopeList(id value) {
  if (![value isKindOfClass:[NSArray class]] || [value count] > 6) return NO;
  NSArray *allowed = @[
    @"memory.remember", @"memory.recall", @"memory.get_note", @"memory.forget",
    @"archive.search", @"archive.read"
  ];
  NSMutableSet *seen = [NSMutableSet set];
  for (id scope in value) {
    if (!IsMember(scope, allowed) || [seen containsObject:scope]) return NO;
    [seen addObject:scope];
  }
  return YES;
}

}  // namespace

@interface AfternoteConnectorOverviewItem ()
@property(nonatomic, copy) NSString *kind;
@property(nonatomic, copy) NSString *status;
@property(nonatomic, copy) NSArray<NSString *> *activeScopes;
@property(nonatomic, copy) NSString *lastActivityAt;
@property(nonatomic) NSUInteger savedCount;
@property(nonatomic) NSUInteger readCount;
@property(nonatomic) BOOL verifiedRoundTrip;
@end

@implementation AfternoteConnectorOverviewItem

- (BOOL)hasCurrentAuthority {
  return [self.status isEqualToString:@"active"] ||
      [self.status isEqualToString:@"paired"];
}

@end

NSDictionary<NSString *, AfternoteConnectorOverviewItem *> *
AfternoteConnectorOverviewByKind(id result) {
  if (![result isKindOfClass:[NSDictionary class]] ||
      !HasExactKeys(result, @[ @"connectors" ])) return nil;
  id connectors = result[@"connectors"];
  if (![connectors isKindOfClass:[NSArray class]] || [connectors count] > 4) return nil;
  NSMutableDictionary *items = [NSMutableDictionary dictionary];
  for (id value in connectors) {
    if (![value isKindOfClass:[NSDictionary class]]) return nil;
    NSDictionary *connector = value;
    if (!HasExactKeys(connector, @[
          @"kind", @"status", @"activeScopes", @"lastActivityAt",
          @"savedCount", @"readCount", @"verifiedRoundTrip"
        ]) ||
        !IsMember(connector[@"kind"], @[
          @"codex", @"claude", @"claude-desktop", @"local_ui"
        ]) ||
        !IsMember(connector[@"status"], @[
          @"paired", @"active", @"revoked", @"expired", @"reconnect-prepared"
        ]) ||
        !IsScopeList(connector[@"activeScopes"]) ||
        !IsNullableDate(connector[@"lastActivityAt"]) ||
        !IsNonnegativeInteger(connector[@"savedCount"]) ||
        !IsNonnegativeInteger(connector[@"readCount"]) ||
        !IsBoolean(connector[@"verifiedRoundTrip"])) return nil;
    NSString *kind = connector[@"kind"];
    if (items[kind] != nil) return nil;
    AfternoteConnectorOverviewItem *item = [[AfternoteConnectorOverviewItem alloc] init];
    item.kind = kind;
    item.status = connector[@"status"];
    item.activeScopes = connector[@"activeScopes"];
    item.lastActivityAt = connector[@"lastActivityAt"] == NSNull.null
        ? nil : connector[@"lastActivityAt"];
    item.savedCount = [connector[@"savedCount"] unsignedIntegerValue];
    item.readCount = [connector[@"readCount"] unsignedIntegerValue];
    item.verifiedRoundTrip = [connector[@"verifiedRoundTrip"] boolValue];
    items[kind] = item;
  }
  return [items copy];
}
