#import <AppKit/AppKit.h>

NS_ASSUME_NONNULL_BEGIN
typedef void (^AfternoteSemanticCompletion)(NSDictionary * _Nullable, NSString * _Nullable);
typedef void (^AfternoteSemanticRunner)(NSArray<NSString *> *, AfternoteSemanticCompletion);
// Main-thread UI. Only explicit installation invokes the downloader. The owner
// coordinator supplies authenticated activation; this view holds no vault access.
@interface AfternoteSemanticSettings : NSStackView
@property(nonatomic, readonly) NSButton *actionButton;
@property(nonatomic, readonly) NSTextField *statusLabel;
@property(nonatomic, copy, nullable) void (^activate)(BOOL userInitiated);
- (instancetype)initWithRunner:(AfternoteSemanticRunner)runner;
- (void)refresh;
- (void)setSearchMode:(NSString *)mode;
- (void)setIndexedNotes:(NSInteger)indexed total:(NSInteger)total;
- (void)activationFailed;
- (void)activationCompleted:(NSString *)mode modelId:(NSString *)modelId;
@end
NS_ASSUME_NONNULL_END
