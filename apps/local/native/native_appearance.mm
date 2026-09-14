#import "native_appearance.h"

NSColor *StatusColor(NSString *status) {
  if ([status isEqualToString:@"active"] || [status isEqualToString:@"paired"] ||
      [status isEqualToString:@"ready"] || [status isEqualToString:@"installed"] ||
      [status isEqualToString:@"success"]) {
    return [NSColor colorWithSRGBRed:0.41 green:0.79 blue:0.60 alpha:1.0];
  }
  if ([status isEqualToString:@"revoked"] || [status isEqualToString:@"denied"] ||
      [status isEqualToString:@"error"]) {
    return [NSColor colorWithSRGBRed:0.88 green:0.44 blue:0.42 alpha:1.0];
  }
  return [NSColor colorWithSRGBRed:0.84 green:0.66 blue:0.37 alpha:1.0];
}

NSColor *AfternoteCanvasColor() {
  return [NSColor colorWithSRGBRed:0.043 green:0.051 blue:0.055 alpha:1.0];
}

NSColor *AfternoteSidebarColor() {
  return [NSColor colorWithSRGBRed:0.055 green:0.063 blue:0.067 alpha:1.0];
}

NSColor *AfternoteSurfaceColor() {
  return [NSColor colorWithSRGBRed:0.078 green:0.086 blue:0.094 alpha:1.0];
}

NSColor *AfternoteRaisedSurfaceColor() {
  return [NSColor colorWithSRGBRed:0.110 green:0.118 blue:0.129 alpha:1.0];
}

NSColor *AfternoteBorderColor() {
  return [NSColor colorWithSRGBRed:0.176 green:0.188 blue:0.204 alpha:1.0];
}

NSColor *AfternoteTextColor() {
  return [NSColor colorWithSRGBRed:0.949 green:0.941 blue:0.914 alpha:1.0];
}

NSColor *AfternoteMutedTextColor() {
  return [NSColor colorWithSRGBRed:0.573 green:0.592 blue:0.588 alpha:1.0];
}

NSColor *AfternoteAccentColor() {
  return [NSColor colorWithSRGBRed:47.0 / 255.0
                            green:154.0 / 255.0
                             blue:163.0 / 255.0
                            alpha:1.0];
}

NSColor *AfternoteBrandCaptureColor() {
  return [NSColor colorWithSRGBRed:47.0 / 255.0
                            green:154.0 / 255.0
                             blue:163.0 / 255.0
                            alpha:1.0];
}

NSColor *AfternoteAccentWashColor() {
  return [AfternoteAccentColor() colorWithAlphaComponent:0.14];
}

NSColor *AfternoteBrandCaptureWashColor() {
  return [AfternoteBrandCaptureColor() colorWithAlphaComponent:0.14];
}

NSColor *AfternoteMemoryThreadColor() {
  return [AfternoteAccentColor() colorWithAlphaComponent:0.72];
}

void StyleSurface(NSView *view, NSColor *color, CGFloat cornerRadius) {
  view.wantsLayer = YES;
  view.layer.backgroundColor = color.CGColor;
  view.layer.cornerRadius = cornerRadius;
  view.layer.masksToBounds = cornerRadius > 0;
}

@implementation FlippedStackView
- (BOOL)isFlipped {
  return YES;
}
@end

@implementation AfternoteButton

+ (instancetype)buttonWithTitle:(NSString *)title
                          target:(id)target
                          action:(SEL)action {
  AfternoteButton *button = [[self alloc] init];
  button.title = title;
  button.target = target;
  button.action = action;
  button.buttonType = NSButtonTypeMomentaryPushIn;
  return button;
}

+ (instancetype)buttonWithImage:(NSImage *)image
                          target:(id)target
                          action:(SEL)action {
  AfternoteButton *button = [[self alloc] init];
  button.image = image;
  button.target = target;
  button.action = action;
  button.buttonType = NSButtonTypeMomentaryPushIn;
  return button;
}

- (instancetype)init {
  self = [super init];
  if (self == nil) return nil;
  self.wantsLayer = YES;
  self.bordered = NO;
  self.focusRingType = NSFocusRingTypeExterior;
  self.afternoteCornerRadius = 6;
  return self;
}

- (BOOL)wantsUpdateLayer {
  return YES;
}

- (NSSize)intrinsicContentSize {
  NSSize size = [super intrinsicContentSize];
  if (self.afternoteFillColor == nil && self.afternoteBorderColor == nil) return size;
  return NSMakeSize(size.width + 18, MAX(30, size.height + 8));
}

- (void)updateTrackingAreas {
  if (self.afternoteTrackingArea != nil) {
    [self removeTrackingArea:self.afternoteTrackingArea];
  }
  self.afternoteTrackingArea = [[NSTrackingArea alloc]
      initWithRect:NSZeroRect
           options:NSTrackingMouseEnteredAndExited | NSTrackingActiveInKeyWindow |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:self.afternoteTrackingArea];
  [super updateTrackingAreas];
}

- (void)mouseEntered:(NSEvent *)event {
  (void)event;
  self.afternotePointerInside = YES;
  [self setNeedsDisplay:YES];
}

- (void)mouseExited:(NSEvent *)event {
  (void)event;
  self.afternotePointerInside = NO;
  [self setNeedsDisplay:YES];
}

- (void)setHighlighted:(BOOL)highlighted {
  [super setHighlighted:highlighted];
  [self setNeedsDisplay:YES];
}

- (void)setEnabled:(BOOL)enabled {
  [super setEnabled:enabled];
  [self setNeedsDisplay:YES];
}

- (void)updateLayer {
  NSColor *fill = self.afternoteFillColor ?: NSColor.clearColor;
  if (!self.enabled) {
    fill = [fill colorWithAlphaComponent:0.42];
  } else if (self.highlighted && self.afternotePressedColor != nil) {
    fill = self.afternotePressedColor;
  } else if (self.afternotePointerInside && self.afternoteHoverColor != nil) {
    fill = self.afternoteHoverColor;
  }
  self.layer.backgroundColor = fill.CGColor;
  self.layer.borderColor = (self.afternoteBorderColor ?: NSColor.clearColor).CGColor;
  self.layer.borderWidth = self.afternoteBorderColor == nil ? 0 : 1;
  self.layer.cornerRadius = self.afternoteCornerRadius;
  self.layer.masksToBounds = YES;
  self.alphaValue = self.enabled ? 1 : 0.72;
}

@end

NSTextField *AfternoteLabel(NSString *text, CGFloat size, NSFontWeight weight) {
  NSTextField *label = [NSTextField labelWithString:text];
  label.font = [NSFont systemFontOfSize:size weight:weight];
  label.textColor = AfternoteTextColor();
  label.maximumNumberOfLines = 0;
  label.lineBreakMode = NSLineBreakByWordWrapping;
  label.cell.wraps = YES;
  label.cell.usesSingleLineMode = NO;
  return label;
}

void AfternoteStyleSecondaryButton(NSButton *button) {
  button.bordered = NO;
  button.controlSize = NSControlSizeRegular;
  button.contentTintColor = AfternoteTextColor();
  button.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
  if ([button isKindOfClass:[AfternoteButton class]]) {
    AfternoteButton *flatButton = (AfternoteButton *)button;
    flatButton.afternoteFillColor = AfternoteRaisedSurfaceColor();
    flatButton.afternoteHoverColor = [AfternoteRaisedSurfaceColor()
        blendedColorWithFraction:0.08 ofColor:NSColor.whiteColor];
    flatButton.afternotePressedColor = AfternoteSurfaceColor();
    flatButton.afternoteBorderColor = AfternoteBorderColor();
    [flatButton invalidateIntrinsicContentSize];
    [flatButton setNeedsDisplay:YES];
  } else {
    button.bordered = YES;
    button.bezelStyle = NSBezelStyleInline;
    button.bezelColor = AfternoteRaisedSurfaceColor();
  }
}

void AfternoteStyleDestructiveButton(NSButton *button) {
  button.bordered = NO;
  button.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
  button.contentTintColor = StatusColor(@"error");
}
