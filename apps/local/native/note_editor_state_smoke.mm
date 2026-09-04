#import <Foundation/Foundation.h>

#import "note_editor_state.h"

namespace {

void Require(BOOL condition, NSString *message) {
  if (!condition) {
    NSLog(@"%@", message);
    exit(1);
  }
}

}  // namespace

int main() {
  @autoreleasepool {
    AfternoteEditorSavePresentation *idle =
        AfternoteEditorSavePresentationForState(AfternoteEditorSaveStateDefault);
    Require([idle.title isEqualToString:@"Save changes"], @"default save label");
    Require(!idle.showsSavedConfirmation, @"default is not confirmation");

    AfternoteEditorSavePresentation *saving =
        AfternoteEditorSavePresentationForState(AfternoteEditorSaveStateSaving);
    Require([saving.title isEqualToString:@"Saving…"], @"saving label");

    AfternoteEditorSavePresentation *saved =
        AfternoteEditorSavePresentationForState(AfternoteEditorSaveStateSaved);
    Require([saved.title isEqualToString:@"Saved locally"], @"saved label");
    Require(saved.showsSavedConfirmation, @"saved confirmation");

    NSArray<NSDictionary *> *rows = AfternoteHistoricalRevisionRows(
        @{ @"id" : @"note-1", @"revision" : @3 },
        @[
          @{ @"revision" : @3 },
          @{ @"revision" : @2 },
          @{ @"revision" : @2 },
          @{ @"revision" : @1 },
        ]);
    Require(rows.count == 2, @"current and duplicate revisions are hidden");
    Require([rows[0][@"revision"] integerValue] == 2, @"revision order preserved");
    Require([rows[1][@"revision"] integerValue] == 1, @"oldest revision preserved");
  }
  return 0;
}
