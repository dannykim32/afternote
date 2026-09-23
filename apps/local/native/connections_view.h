#import <AppKit/AppKit.h>
#import "connector_presentation.h"

// Only redacted display data crosses this seam. The coordinator retains broker
// authority, history approval, generation guards, and revocation scopes.
@interface AfternoteConnectionRow : NSObject
@property(nonatomic, copy) NSString *commandKind;
@property(nonatomic, copy) NSString *brokerKind;
@property(nonatomic, copy) NSString *displayName;
@property(nonatomic, strong) AfternoteConnectorPresentation *presentation;
@property(nonatomic) BOOL connected;
@property(nonatomic) BOOL canApproveArchives;
@property(nonatomic, copy) NSString *permissions;
@property(nonatomic, copy) NSString *activity;
@property(nonatomic, copy) NSArray<NSString *> *historyLines;
@property(nonatomic) BOOL historyAuthorized;
@property(nonatomic) BOOL historyExpanded;
@property(nonatomic) BOOL hasOlderHistory;
@end

@protocol AfternoteConnectionsActions <NSObject>
- (void)refreshConnections:(id)sender;
- (void)openIntegrationDownload:(NSButton *)sender;
- (void)installIntegration:(NSButton *)sender;
- (void)reconnectIntegration:(NSButton *)sender;
- (void)refreshIntegrationStatusFromButton:(NSButton *)sender;
- (void)reviewIntegrationSetup:(NSButton *)sender;
- (void)confirmRevocation:(NSButton *)sender;
- (void)approveArchiveAccess:(NSButton *)sender;
- (void)toggleConnectorHistory:(NSButton *)sender;
- (void)loadMore:(id)sender;
@end

// AppKit-only, main-thread interface. Rendering never authenticates or performs
// an operation. Actions are forwarded to a weak target only on user interaction.
@interface AfternoteConnectionsView : NSView
- (instancetype)initWithActionTarget:(id<AfternoteConnectionsActions>)target;
- (void)renderRows:(NSArray<AfternoteConnectionRow *> *)rows;
- (void)setBusy:(BOOL)busy status:(NSString *)status;
- (void)setRefreshEnabled:(BOOL)enabled;
- (void)showErrorMessage:(NSString *)message;
@end
