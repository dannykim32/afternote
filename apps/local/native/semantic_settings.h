#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN
typedef void (^AfternoteSemanticCompletion)(NSDictionary * _Nullable, NSString * _Nullable);
typedef void (^AfternoteSemanticRunner)(NSArray<NSString *> *, AfternoteSemanticCompletion);
// Passive presentation of authenticated progress. The coordinator owns polling and retry.
@interface AfternoteSearchProgress : NSStackView
@property(nonatomic, readonly) NSTextField *titleLabel;
@property(nonatomic, readonly) NSTextField *detailLabel;
@property(nonatomic, readonly) NSTextField *countLabel;
@property(nonatomic, readonly) NSProgressIndicator *progressBar;
@property(nonatomic, readonly) NSButton *retryButton;
- (void)updateMode:(NSString *)mode indexed:(NSInteger)indexed total:(NSInteger)total
           stalled:(BOOL)stalled unavailable:(BOOL)unavailable;
@end
// Main-thread UI. Models ship in the app; the control changes a local preference. The owner
// coordinator supplies authenticated activation; this view holds no vault access.
@interface AfternoteSemanticSettings : NSStackView
@property(nonatomic, readonly) NSButton *actionButton;
@property(nonatomic, readonly) NSButton *toggleButton;
@property(nonatomic, readonly) NSTextField *statusLabel;
@property(nonatomic, readonly) NSProgressIndicator *indexProgress;
@property(nonatomic, copy, nullable) void (^activate)(BOOL userInitiated);
@property(nonatomic, copy, nullable) void (^checkProgress)(void);
- (instancetype)initWithRunner:(AfternoteSemanticRunner)runner;
- (void)refresh;
- (void)setSearchMode:(NSString *)mode;
- (void)setIndexedNotes:(NSInteger)indexed total:(NSInteger)total;
- (void)setProgressStalled:(BOOL)stalled unavailable:(BOOL)unavailable;
- (void)activationFailed;
- (void)activationCompleted:(NSString *)mode modelId:(NSString *)modelId;
@end
NS_ASSUME_NONNULL_END
