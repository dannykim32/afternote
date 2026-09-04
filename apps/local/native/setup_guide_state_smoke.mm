#import <Foundation/Foundation.h>

#import "setup_guide_state.h"

NSDictionary *Event(
    NSString *clientId,
    NSString *operation,
    NSString *outcome,
    NSString *occurredAt,
    NSString *noteId) {
  NSArray *references = noteId.length > 0
      ? @[ @{ @"noteId" : noteId, @"revision" : @1 } ] : @[];
  return @{
    @"clientId" : clientId,
    @"operation" : operation,
    @"outcome" : outcome,
    @"occurredAt" : occurredAt,
    @"noteRefs" : references,
  };
}

int main(void) {
  @autoreleasepool {
    NSDictionary *remember = Event(@"codex-a", @"memory.remember", @"success",
                                   @"2026-09-01T01:00:00.000Z", @"note-a");
    NSArray *cases = @[
      @{ @"name" : @"correlated", @"value" : @(
          AfternoteHasCorrelatedRecallProof(@[
            remember,
            Event(@"codex-a", @"memory.recall", @"success",
                  @"2026-09-01T01:01:00.000Z", @"note-a"),
          ])) },
      @{ @"name" : @"different-client", @"value" : @(
          AfternoteHasCorrelatedRecallProof(@[
            remember,
            Event(@"claude-b", @"memory.recall", @"success",
                  @"2026-09-01T01:01:00.000Z", @"note-a"),
          ])) },
      @{ @"name" : @"different-note", @"value" : @(
          AfternoteHasCorrelatedRecallProof(@[
            remember,
            Event(@"codex-a", @"memory.recall", @"success",
                  @"2026-09-01T01:01:00.000Z", @"note-b"),
          ])) },
      @{ @"name" : @"recall-before-save", @"value" : @(
          AfternoteHasCorrelatedRecallProof(@[
            remember,
            Event(@"codex-a", @"memory.recall", @"success",
                  @"2026-09-01T00:59:00.000Z", @"note-a"),
          ])) },
      @{ @"name" : @"failed-recall", @"value" : @(
          AfternoteHasCorrelatedRecallProof(@[
            remember,
            Event(@"codex-a", @"memory.recall", @"error",
                  @"2026-09-01T01:01:00.000Z", @"note-a"),
          ])) },
      @{ @"name" : @"missing-outcome", @"value" : @(
          AfternoteHasCorrelatedRecallProof(@[
            remember,
            @{
              @"clientId" : @"codex-a", @"operation" : @"memory.recall",
              @"occurredAt" : @"2026-09-01T01:01:00.000Z",
              @"noteRefs" : @[ @{ @"noteId" : @"note-a", @"revision" : @1 } ],
            },
          ])) },
    ];
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:cases options:0 error:nil];
    fwrite(encoded.bytes, 1, encoded.length, stdout);
    fputc('\n', stdout);
  }
  return 0;
}
