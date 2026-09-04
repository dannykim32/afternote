#import "note_editor_state.h"

@implementation AfternoteEditorSavePresentation
@end

AfternoteEditorSavePresentation *AfternoteEditorSavePresentationForState(
    AfternoteEditorSaveState state) {
  AfternoteEditorSavePresentation *presentation =
      [[AfternoteEditorSavePresentation alloc] init];
  if (state == AfternoteEditorSaveStateSaved) {
    presentation.title = @"Saved locally";
    presentation.accessibilityLabel = @"Saved locally";
    presentation.showsSavedConfirmation = YES;
    return presentation;
  }
  presentation.title = state == AfternoteEditorSaveStateSaving
      ? @"Saving…"
      : @"Save changes";
  presentation.accessibilityLabel = presentation.title;
  presentation.showsSavedConfirmation = NO;
  return presentation;
}

NSArray<NSDictionary *> *AfternoteHistoricalRevisionRows(
    NSDictionary *activeNote,
    NSArray<NSDictionary *> *revisionSummaries) {
  NSInteger currentRevision =
      [activeNote[@"id"] isKindOfClass:[NSString class]]
          ? [activeNote[@"revision"] integerValue]
          : 0;
  for (NSDictionary *revision in revisionSummaries) {
    currentRevision = MAX(currentRevision, [revision[@"revision"] integerValue]);
  }

  NSMutableArray<NSDictionary *> *historical = [NSMutableArray array];
  NSMutableSet<NSNumber *> *seen = [NSMutableSet set];
  for (NSDictionary *revision in revisionSummaries) {
    NSNumber *number = [revision[@"revision"] isKindOfClass:[NSNumber class]]
        ? revision[@"revision"]
        : nil;
    if (number == nil || number.integerValue == currentRevision ||
        [seen containsObject:number]) {
      continue;
    }
    [historical addObject:revision];
    [seen addObject:number];
  }
  return historical;
}
