#import <AppKit/AppKit.h>

// Shared native appearance. No broker, persistence, or screen lifecycle ownership.
NSColor *StatusColor(NSString *status);
NSColor *AfternoteCanvasColor();
NSColor *AfternoteSidebarColor();
NSColor *AfternoteSurfaceColor();
NSColor *AfternoteRaisedSurfaceColor();
NSColor *AfternoteBorderColor();
NSColor *AfternoteTextColor();
NSColor *AfternoteMutedTextColor();
NSColor *AfternoteAccentColor();
NSColor *AfternoteBrandCaptureColor();
NSColor *AfternoteAccentWashColor();
NSColor *AfternoteBrandCaptureWashColor();
NSColor *AfternoteMemoryThreadColor();
void StyleSurface(NSView *view, NSColor *color, CGFloat cornerRadius = 0);
NSTextField *AfternoteLabel(NSString *text, CGFloat size, NSFontWeight weight);
void AfternoteStyleSecondaryButton(NSButton *button);
void AfternoteStyleDestructiveButton(NSButton *button);

@interface FlippedStackView : NSStackView
@end

@interface AfternoteButton : NSButton
@property(nonatomic, strong) NSColor *afternoteFillColor;
@property(nonatomic, strong) NSColor *afternoteHoverColor;
@property(nonatomic, strong) NSColor *afternotePressedColor;
@property(nonatomic, strong) NSColor *afternoteBorderColor;
@property(nonatomic) CGFloat afternoteCornerRadius;
@property(nonatomic) BOOL afternotePointerInside;
@property(nonatomic, strong) NSTrackingArea *afternoteTrackingArea;
@end
