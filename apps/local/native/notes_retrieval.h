#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface AfternoteNotesRequest : NSObject
@property(nonatomic, readonly, copy) NSString *method;
@property(nonatomic, readonly, copy) NSDictionary *params;
@end

// Main-thread-confined retrieval state, with no transport or authentication.
// The coordinator submits requests through its authorized broker and must still
// check its session generation before completing them here. Query text is the
// submitted query, not the text currently being typed into the search field.
@interface AfternoteNotesRetrieval : NSObject
@property(nonatomic, readonly, copy) NSString *query;
@property(nonatomic, readonly, copy, nullable) NSString *view;
@property(nonatomic, readonly, copy) NSArray<NSDictionary *> *notes;
@property(nonatomic, readonly, copy, nullable) NSString *cursor;
@property(nonatomic, readonly, copy, nullable) NSString *searchMode;
@property(nonatomic, readonly) BOOL inFlight;
- (void)selectQuery:(NSString *)query view:(nullable NSString *)view;
// Refresh replaces results. Append requires an idle request and a valid cursor.
- (nullable AfternoteNotesRequest *)beginAppending:(BOOL)append;
// Accept only the most recent pending request, once. Result shapes have already
// been validated by the broker contract. Errors retain prior append-page results.
- (BOOL)complete:(AfternoteNotesRequest *)request
          result:(nullable NSDictionary *)result error:(nullable NSDictionary *)error;
- (void)cancelPendingRequest;
// Clears query, view, excerpts, cursor, and pending identity; late replies cannot
// restore them. Required on lock, expiry, disconnect, and recovery invalidation.
- (void)clear;
@end

NS_ASSUME_NONNULL_END
