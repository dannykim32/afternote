#import "setup_guide_state.h"

namespace {

BOOL IsSuccessfulOperation(NSDictionary *event, NSString *operation) {
  return [event[@"operation"] isEqualToString:operation] &&
      [event[@"outcome"] isEqualToString:@"success"] &&
      [event[@"clientId"] isKindOfClass:[NSString class]] &&
      [event[@"occurredAt"] isKindOfClass:[NSString class]] &&
      [event[@"noteRefs"] isKindOfClass:[NSArray class]];
}

NSSet<NSString *> *ReferencedNoteIds(NSDictionary *event) {
  NSMutableSet<NSString *> *identifiers = [NSMutableSet set];
  for (id value in event[@"noteRefs"]) {
    if (![value isKindOfClass:[NSDictionary class]]) continue;
    NSString *noteId = value[@"noteId"];
    if ([noteId isKindOfClass:[NSString class]] && noteId.length > 0) {
      [identifiers addObject:noteId];
    }
  }
  return identifiers;
}

}  // namespace

BOOL AfternoteHasCorrelatedRecallProof(NSArray<NSDictionary *> *events) {
  for (NSDictionary *remember in events) {
    if (!IsSuccessfulOperation(remember, @"memory.remember")) continue;
    NSSet<NSString *> *remembered = ReferencedNoteIds(remember);
    if (remembered.count == 0) continue;
    NSString *clientId = remember[@"clientId"];
    NSString *rememberedAt = remember[@"occurredAt"];
    for (NSDictionary *recall in events) {
      if (!IsSuccessfulOperation(recall, @"memory.recall") ||
          ![recall[@"clientId"] isEqualToString:clientId] ||
          [recall[@"occurredAt"] compare:rememberedAt] == NSOrderedAscending) {
        continue;
      }
      if ([remembered intersectsSet:ReferencedNoteIds(recall)]) return YES;
    }
  }
  return NO;
}
