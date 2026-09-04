#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, AfternoteListStyle) {
  AfternoteListStyleBullet,
  AfternoteListStyleNumbered,
  AfternoteListStyleChecklist,
};

@interface AfternoteListTransform : NSObject
@property(nonatomic, copy, readonly) NSString *text;
@property(nonatomic, readonly) NSRange selection;
- (instancetype)initWithText:(NSString *)text selection:(NSRange)selection;
@end

@interface AfternoteListContinuation : NSObject
@property(nonatomic, readonly) NSRange range;
@property(nonatomic, copy, readonly) NSString *replacement;
- (instancetype)initWithRange:(NSRange)range replacement:(NSString *)replacement;
@end

FOUNDATION_EXPORT AfternoteListTransform *AfternoteToggleList(
    NSString *text,
    NSRange selection,
    AfternoteListStyle targetStyle);

FOUNDATION_EXPORT AfternoteListContinuation *_Nullable AfternoteContinueList(
    NSString *text,
    NSRange selection);

FOUNDATION_EXPORT AfternoteListTransform *_Nullable AfternoteIndentList(
    NSString *text,
    NSRange selection,
    BOOL outdent);

NS_ASSUME_NONNULL_END
