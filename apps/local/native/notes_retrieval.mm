#import "notes_retrieval.h"

@interface AfternoteNotesRequest ()
@property(nonatomic, copy) NSString *method;
@property(nonatomic, copy) NSDictionary *params;
@property(nonatomic) BOOL append;
@end
@implementation AfternoteNotesRequest
@end

@interface AfternoteNotesRetrieval ()
@property(nonatomic, copy) NSString *query;
@property(nonatomic, copy) NSString *view;
@property(nonatomic, copy) NSArray<NSDictionary *> *notes;
@property(nonatomic, copy) NSString *cursor;
@property(nonatomic, copy) NSString *searchMode;
@property(nonatomic, strong) AfternoteNotesRequest *pending;
@end

@implementation AfternoteNotesRetrieval
- (instancetype)init {
  self = [super init];
  if (self) [self clear];
  return self;
}
- (BOOL)inFlight { return self.pending != nil; }
- (void)cancelPendingRequest { self.pending = nil; }
- (void)clear {
  [self cancelPendingRequest];
  self.query = @"";
  self.view = nil;
  self.notes = @[];
  self.cursor = nil;
  self.searchMode = nil;
}
- (void)selectQuery:(NSString *)query view:(NSString *)view {
  NSString *submitted = [query stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  NSString *selectedView = submitted.length > 0 || view.length == 0 ? nil : view;
  [self clear];
  self.query = submitted;
  self.view = selectedView;
}
- (AfternoteNotesRequest *)beginAppending:(BOOL)append {
  if (append && (self.inFlight || self.cursor == nil)) return nil;
  if (!append) {
    self.notes = @[];
    self.cursor = nil;
  }
  AfternoteNotesRequest *request = [AfternoteNotesRequest new];
  request.append = append;
  BOOL searching = self.query.length > 0;
  request.method = searching ? @"library.search" : @"library.browse";
  request.params = searching
      ? @{ @"query": self.query, @"limit": @20, @"cursor": self.cursor ?: NSNull.null }
      : @{ @"view": self.view ?: NSNull.null, @"limit": @20, @"cursor": self.cursor ?: NSNull.null };
  self.pending = request;
  return request;
}
- (BOOL)complete:(AfternoteNotesRequest *)request
          result:(NSDictionary *)result error:(NSDictionary *)error {
  if (request == nil || request != self.pending) return NO;
  self.pending = nil;
  if (error != nil) return YES;
  NSArray *loaded = [result[@"notes"] isKindOfClass:NSArray.class] ? result[@"notes"] : @[];
  if ([request.method isEqualToString:@"library.search"]) {
    self.searchMode = [result[@"searchMode"] isKindOfClass:NSString.class] ? result[@"searchMode"] : @"exact";
    NSMutableArray *rows = [NSMutableArray array];
    NSUInteger rank = request.append ? self.notes.count : 0;
    for (NSDictionary *match in result[@"results"]) {
      NSDictionary *citation = match[@"citation"];
      if (![citation[@"noteId"] isKindOfClass:NSString.class] || [citation[@"noteId"] length] == 0) continue;
      [rows addObject:@{
        @"id": citation[@"noteId"], @"revision": citation[@"revision"] ?: @0,
        @"excerpt": citation[@"excerpt"] ?: @"", @"source": citation[@"source"] ?: NSNull.null,
        @"createdAt": citation[@"createdAt"] ?: @"", @"updatedAt": citation[@"createdAt"] ?: @"",
        @"resultKind": @"search", @"rank": @(++rank),
      }];
    }
    loaded = rows;
  }
  self.notes = request.append ? [self.notes arrayByAddingObjectsFromArray:loaded] : loaded;
  NSString *cursor = [result[@"nextCursor"] isKindOfClass:NSString.class] ? result[@"nextCursor"] : nil;
  self.cursor = cursor.length > 0 ? cursor : nil;
  return YES;
}
@end
