#import <AppKit/AppKit.h>
#import "note_editor_state.h"

NS_ASSUME_NONNULL_BEGIN

// Intent callbacks only. The coordinator owns broker operations, authorization,
// confirmation dialogs, and generation checks before applying a result.
@protocol AfternoteNoteEditorActions <NSObject>
- (void)returnToMemory:(id)sender;
- (void)saveNote:(id)sender;
- (void)discardEditorChanges:(id)sender;
- (void)confirmDeleteNote:(id)sender;
- (void)editCurrentNote:(id)sender;
- (void)selectEditorRevision:(nullable NSDictionary *)revision;
@end

// Main-thread-only, in-memory editor. No broker, storage, or authentication.
// displayNote replaces the draft and clears undo (and history when changing
// notes); availability/history updates never replace the draft. Call
// clearPlaintext on lock, expiry, disconnect, or teardown.
@interface AfternoteNoteEditorView : NSView
- (instancetype)initWithActionTarget:(id<AfternoteNoteEditorActions>)target;
@property(nonatomic, readonly, copy) NSString *draft;
@property(nonatomic, readonly) BOOL hasUnsavedChanges;
- (void)displayNote:(nullable NSDictionary *)note creating:(BOOL)creating
 inspectingCitation:(BOOL)inspectingCitation;
- (void)setHistory:(NSArray<NSDictionary *> *)revisions hasMore:(BOOL)hasMore loaded:(BOOL)loaded;
- (void)setBusy:(BOOL)busy authenticated:(BOOL)authenticated;
- (void)setSaveState:(AfternoteEditorSaveState)state animated:(BOOL)animated;
- (void)restoreDraft:(NSString *)draft;
- (BOOL)discardChanges;
- (void)focusDraft;
- (void)clearPlaintext;
@end

NS_ASSUME_NONNULL_END
