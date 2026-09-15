#import "owner_broker_contract.h"
#import "connector_overview.h"
#include <cmath>

namespace {

NSDate *DateValue(id value) {
  NSString *text = [value isKindOfClass:[NSString class]] ? value : @"";
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
         [operation isEqualToString:@"admin.telemetry.status"] ||
         [operation isEqualToString:@"admin.telemetry.enable"] ||
         [operation isEqualToString:@"admin.telemetry.disable"] ||
         [operation isEqualToString:@"admin.telemetry.reset"] ||
         [operation isEqualToString:@"admin.prepare_client_rotation"] ||
         [operation isEqualToString:@"admin.prepare_connector_reconnect"] ||
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
    @"claude-desktop" : @"Claude Desktop",
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
  if ([method isEqualToString:@"owner.connector_overview"]) {
    return AfternoteConnectorOverviewByKind(result) != nil;
  }
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
          @"codex", @"claude", @"claude-desktop", @"local_ui"
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
            @"codex", @"claude", @"claude-desktop", @"local_ui"
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

BOOL IsDiagnosticCountBucket(id value) {
  return IsOneOf(value, @[ @"0", @"1-9", @"10-99", @"100-999", @"1000+" ]);
}

BOOL IsDiagnosticOperationCounts(id value) {
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *counts = value;
  if (!ExactKeys(counts, @[
        @"authorizedBucket", @"successBucket", @"deniedBucket", @"errorBucket"
      ])) return NO;
  return IsDiagnosticCountBucket(counts[@"authorizedBucket"]) &&
      IsDiagnosticCountBucket(counts[@"successBucket"]) &&
      IsDiagnosticCountBucket(counts[@"deniedBucket"]) &&
      IsDiagnosticCountBucket(counts[@"errorBucket"]);
}

BOOL IsDiagnosticConnectorActivity(id value) {
  if (![value isKindOfClass:[NSDictionary class]]) return NO;
  NSDictionary *activity = value;
  NSDictionary *operations = activity[@"operations"];
  return ExactKeys(activity, @[ @"kind", @"attributedNotesBucket", @"operations" ]) &&
      IsOneOf(activity[@"kind"], @[ @"codex", @"claude", @"claude-desktop" ]) &&
      IsDiagnosticCountBucket(activity[@"attributedNotesBucket"]) &&
      [operations isKindOfClass:[NSDictionary class]] &&
      ExactKeys(operations, @[ @"remember", @"recall", @"getNote" ]) &&
      IsDiagnosticOperationCounts(operations[@"remember"]) &&
      IsDiagnosticOperationCounts(operations[@"recall"]) &&
      IsDiagnosticOperationCounts(operations[@"getNote"]);
}

BOOL IsDiagnosticResult(NSDictionary *result) {
  if (!ExactKeys(result, @[
        @"format", @"schemaVersion", @"generatedAt", @"application", @"system",
        @"runtime", @"vault", @"connectorActivity", @"checks", @"errors"
      ]) || ![result[@"format"] isEqual:@"afternote-diagnostics"] ||
      ![result[@"schemaVersion"] isEqual:@2] || !IsDate(result[@"generatedAt"])) return NO;
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
  NSArray *connectorActivity = result[@"connectorActivity"];
  if (!IsArrayOf(connectorActivity, 3, ^BOOL(id item) {
    return IsDiagnosticConnectorActivity(item);
  }) || connectorActivity.count != 3) return NO;
  NSMutableSet *connectorKinds = [NSMutableSet setWithCapacity:3];
  for (NSDictionary *activity in connectorActivity) {
    [connectorKinds addObject:activity[@"kind"]];
  }
  if (connectorKinds.count != 3) return NO;
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
  if ([method isEqualToString:@"admin.prepare_client_rotation"] ||
      [method isEqualToString:@"admin.prepare_connector_reconnect"]) {
    return ExactKeys(result, @[
          @"prepared", @"kind", @"installIdentity", @"replacementInstallIdentity",
          @"clientId"
        ]) &&
        [result[@"prepared"] isEqual:@YES] &&
        IsOneOf(result[@"kind"], @[ @"codex", @"claude", @"claude-desktop" ]) &&
        [result[@"kind"] isEqual:params[@"kind"]] &&
        IsUUID(result[@"installIdentity"]) &&
        [result[@"installIdentity"] isEqual:params[@"installIdentity"]] &&
        IsUUID(result[@"replacementInstallIdentity"]) &&
        [result[@"replacementInstallIdentity"]
            isEqual:params[@"replacementInstallIdentity"]] &&
        (result[@"clientId"] == NSNull.null || IsUUID(result[@"clientId"])) &&
        (![method isEqualToString:@"admin.prepare_connector_reconnect"] ||
         (IsUUID(result[@"clientId"]) &&
          ![result[@"installIdentity"] isEqual:result[@"replacementInstallIdentity"]]));
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

}  // namespace

BOOL AfternoteBrokerResultIsValid(NSString *method, NSDictionary *result,
                                 NSDictionary *params) {
  return IsBrokerResult(method, result, params);
}

BOOL AfternoteBrokerErrorIsValid(NSDictionary *error) {
  return IsKnownBrokerError(error);
}

BOOL AfternoteBrokerLifecycleTransitionIsValid(NSString *method,
                                              NSDictionary *before,
                                              NSDictionary *after) {
  return IsLifecycleTransitionConsistent(method, before, after);
}
