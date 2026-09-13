#import <Foundation/Foundation.h>

@interface AfternoteConnectorOverviewItem : NSObject

@property(nonatomic, copy, readonly) NSString *kind;
@property(nonatomic, copy, readonly) NSString *status;
@property(nonatomic, copy, readonly) NSArray<NSString *> *activeScopes;
@property(nonatomic, copy, readonly) NSString *lastActivityAt;
@property(nonatomic, readonly) NSUInteger savedCount;
@property(nonatomic, readonly) NSUInteger readCount;
@property(nonatomic, readonly) BOOL verifiedRoundTrip;
@property(nonatomic, readonly) BOOL hasCurrentAuthority;

@end

NSDictionary<NSString *, AfternoteConnectorOverviewItem *> *
AfternoteConnectorOverviewByKind(id result);
