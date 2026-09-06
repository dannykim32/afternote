#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, AfternoteEditorSaveState) {
  AfternoteEditorSaveStateDefault = 0,
  AfternoteEditorSaveStateSaving = 1,
  AfternoteEditorSaveStateSaved = 2,
};

@interface AfternoteEditorSavePresentation : NSObject
@property(nonatomic, copy) NSString *title;
@property(nonatomic, copy) NSString *accessibilityLabel;
@property(nonatomic) BOOL showsSavedConfirmation;
@end

AfternoteEditorSavePresentation *AfternoteEditorSavePresentationForState(
    AfternoteEditorSaveState state);

BOOL AfternoteEditorHasUnsavedChanges(NSDictionary *activeNote,
                                      NSString *editorText,
                                      BOOL creatingNote);

NSArray<NSDictionary *> *AfternoteHistoricalRevisionRows(
    NSDictionary *activeNote,
    NSArray<NSDictionary *> *revisionSummaries);
