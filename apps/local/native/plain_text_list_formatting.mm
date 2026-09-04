#import "plain_text_list_formatting.h"

@implementation AfternoteListTransform
- (instancetype)initWithText:(NSString *)text selection:(NSRange)selection {
  self = [super init];
  if (self) {
    _text = [text copy];
    _selection = selection;
  }
  return self;
}
@end

@implementation AfternoteListContinuation
- (instancetype)initWithRange:(NSRange)range replacement:(NSString *)replacement {
  self = [super init];
  if (self) {
    _range = range;
    _replacement = [replacement copy];
  }
  return self;
}
@end

typedef struct {
  NSRange lineRange;
  NSRange markerRange;
  NSUInteger insertionLocation;
  BOOL eligible;
  AfternoteListStyle style;
} AnalyzedLine;

@interface AfternoteListEdit : NSObject
@property(nonatomic) NSRange range;
@property(nonatomic, copy) NSString *replacement;
@end

@implementation AfternoteListEdit
@end

static NSUInteger ListIndentLength(NSString *line) {
  NSUInteger index = 0;
  while (index < line.length) {
    unichar character = [line characterAtIndex:index];
    if (character != ' ' && character != '\t') break;
    index += 1;
  }
  return index;
}

static NSRange ListMarkerRange(NSString *line,
                               AfternoteListStyle *style,
                               NSUInteger *number) {
  NSUInteger start = ListIndentLength(line);
  if (start + 2 <= line.length) {
    unichar marker = [line characterAtIndex:start];
    if ((marker == 0x2610 || marker == 0x2611) &&
        [line characterAtIndex:start + 1] == ' ') {
      if (style != nullptr) *style = AfternoteListStyleChecklist;
      if (number != nullptr) *number = 0;
      return NSMakeRange(start, 2);
    }
  }
  if (start + 2 <= line.length && [line characterAtIndex:start] == '-' &&
      [line characterAtIndex:start + 1] == ' ') {
    if (style != nullptr) *style = AfternoteListStyleBullet;
    if (number != nullptr) *number = 0;
    return NSMakeRange(start, 2);
  }
  NSUInteger cursor = start;
  while (cursor < line.length &&
         [NSCharacterSet.decimalDigitCharacterSet characterIsMember:
             [line characterAtIndex:cursor]]) {
    cursor += 1;
  }
  if (cursor > start && cursor + 2 <= line.length &&
      [line characterAtIndex:cursor] == '.' && [line characterAtIndex:cursor + 1] == ' ') {
    if (style != nullptr) *style = AfternoteListStyleNumbered;
    if (number != nullptr) {
      unsigned long long parsed =
          [[line substringWithRange:NSMakeRange(start, cursor - start)] longLongValue];
      *number = parsed > NSUIntegerMax ? NSUIntegerMax : (NSUInteger)parsed;
    }
    return NSMakeRange(start, cursor - start + 2);
  }
  return NSMakeRange(NSNotFound, 0);
}

static NSString *LineTextWithoutTerminator(NSString *text, NSRange lineRange) {
  NSUInteger length = lineRange.length;
  while (length > 0) {
    unichar character = [text characterAtIndex:lineRange.location + length - 1];
    if (character != '\n' && character != '\r') break;
    length -= 1;
  }
  return [text substringWithRange:NSMakeRange(lineRange.location, length)];
}

static NSArray<NSValue *> *SelectedLineRanges(NSString *text, NSRange selection) {
  NSUInteger safeLocation = MIN(selection.location, text.length);
  NSUInteger availableLength = text.length - safeLocation;
  NSRange safeSelection = NSMakeRange(
      safeLocation, MIN(selection.length, availableLength));
  NSRange selectedLines = [text lineRangeForRange:safeSelection];
  NSMutableArray<NSValue *> *ranges = [NSMutableArray array];
  NSUInteger cursor = selectedLines.location;
  NSUInteger end = NSMaxRange(selectedLines);
  while (cursor < end) {
    NSRange line = [text lineRangeForRange:NSMakeRange(cursor, 0)];
    [ranges addObject:[NSValue valueWithRange:line]];
    NSUInteger next = NSMaxRange(line);
    if (next <= cursor) break;
    cursor = next;
  }
  if (ranges.count == 0) [ranges addObject:[NSValue valueWithRange:selectedLines]];
  return ranges;
}

static NSArray<NSValue *> *AnalyzeLines(NSString *text, NSRange selection) {
  NSArray<NSValue *> *lineRanges = SelectedLineRanges(text, selection);
  NSMutableArray<NSValue *> *analyzed = [NSMutableArray arrayWithCapacity:lineRanges.count];
  for (NSValue *value in lineRanges) {
    NSRange lineRange = value.rangeValue;
    NSString *line = LineTextWithoutTerminator(text, lineRange);
    AfternoteListStyle style = AfternoteListStyleBullet;
    NSRange marker = ListMarkerRange(line, &style, nullptr);
    NSString *body = marker.location == NSNotFound
        ? [line substringFromIndex:ListIndentLength(line)]
        : [line substringFromIndex:NSMaxRange(marker)];
    BOOL emptyInsertionLine = selection.length == 0 && lineRanges.count == 1;
    BOOL eligible = marker.location != NSNotFound || emptyInsertionLine ||
        [body stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length > 0;
    AnalyzedLine item = {
      lineRange,
      marker,
      lineRange.location + ListIndentLength(line),
      eligible,
      style,
    };
    [analyzed addObject:[NSValue valueWithBytes:&item objCType:@encode(AnalyzedLine)]];
  }
  return analyzed;
}

static NSUInteger MapTextOffset(NSUInteger offset,
                                NSArray<AfternoteListEdit *> *edits,
                                BOOL trailingAffinity) {
  NSInteger delta = 0;
  for (AfternoteListEdit *edit in edits) {
    if (offset < edit.range.location) break;
    if (offset > NSMaxRange(edit.range) ||
        (offset == NSMaxRange(edit.range) && edit.range.length > 0)) {
      delta += (NSInteger)edit.replacement.length - (NSInteger)edit.range.length;
      continue;
    }
    return (NSUInteger)MAX(0, (NSInteger)edit.range.location + delta) +
        (trailingAffinity ? edit.replacement.length : 0);
  }
  return (NSUInteger)MAX(0, (NSInteger)offset + delta);
}

static AfternoteListTransform *ApplyListEdits(
    NSString *text,
    NSRange selection,
    NSArray<AfternoteListEdit *> *edits) {
  BOOL insertionPoint = selection.length == 0;
  NSUInteger mappedStart = MapTextOffset(selection.location, edits, insertionPoint);
  NSUInteger mappedEnd = MapTextOffset(NSMaxRange(selection), edits, YES);
  NSMutableString *updated = [text mutableCopy];
  for (AfternoteListEdit *edit in [edits reverseObjectEnumerator]) {
    [updated replaceCharactersInRange:edit.range withString:edit.replacement];
  }
  return [[AfternoteListTransform alloc]
      initWithText:updated
         selection:NSMakeRange(mappedStart, mappedEnd - mappedStart)];
}

AfternoteListTransform *AfternoteToggleList(NSString *text,
                                            NSRange selection,
                                            AfternoteListStyle targetStyle) {
  NSArray<NSValue *> *lines = AnalyzeLines(text, selection);
  BOOL hasEligibleLine = NO;
  BOOL allTarget = YES;
  for (NSValue *value in lines) {
    AnalyzedLine line;
    [value getValue:&line];
    if (!line.eligible) continue;
    hasEligibleLine = YES;
    if (line.markerRange.location == NSNotFound || line.style != targetStyle) allTarget = NO;
  }
  if (!hasEligibleLine) {
    return [[AfternoteListTransform alloc] initWithText:text selection:selection];
  }

  NSMutableArray<AfternoteListEdit *> *edits = [NSMutableArray array];
  NSUInteger ordinal = 1;
  for (NSValue *value in lines) {
    AnalyzedLine line;
    [value getValue:&line];
    if (!line.eligible) continue;
    AfternoteListEdit *edit = [[AfternoteListEdit alloc] init];
    edit.replacement = allTarget
        ? @""
        : targetStyle == AfternoteListStyleBullet
          ? @"- "
          : targetStyle == AfternoteListStyleChecklist
            ? @"☐ "
          : [NSString stringWithFormat:@"%lu. ", (unsigned long)ordinal];
    edit.range = line.markerRange.location == NSNotFound
        ? NSMakeRange(line.insertionLocation, 0)
        : NSMakeRange(line.lineRange.location + line.markerRange.location,
                      line.markerRange.length);
    [edits addObject:edit];
    ordinal += 1;
  }

  return ApplyListEdits(text, selection, edits);
}

AfternoteListTransform *_Nullable AfternoteIndentList(NSString *text,
                                                      NSRange selection,
                                                      BOOL outdent) {
  NSArray<NSValue *> *lines = AnalyzeLines(text, selection);
  NSMutableArray<AfternoteListEdit *> *edits = [NSMutableArray array];
  for (NSValue *value in lines) {
    AnalyzedLine line;
    [value getValue:&line];
    if (line.markerRange.location == NSNotFound) continue;

    AfternoteListEdit *edit = [[AfternoteListEdit alloc] init];
    if (!outdent) {
      edit.range = NSMakeRange(line.lineRange.location, 0);
      edit.replacement = @"\t";
    } else if (line.markerRange.location > 0) {
      NSString *lineText = LineTextWithoutTerminator(text, line.lineRange);
      unichar firstCharacter = [lineText characterAtIndex:0];
      NSUInteger removalLength = firstCharacter == '\t'
          ? 1
          : MIN((NSUInteger)2, line.markerRange.location);
      edit.range = NSMakeRange(line.lineRange.location, removalLength);
      edit.replacement = @"";
    } else {
      continue;
    }
    [edits addObject:edit];
  }
  if (edits.count == 0) return nil;

  return ApplyListEdits(text, selection, edits);
}

AfternoteListContinuation *AfternoteContinueList(NSString *text, NSRange selection) {
  if (selection.length != 0 || selection.location > text.length) return nil;
  NSRange lineRange = [text lineRangeForRange:NSMakeRange(selection.location, 0)];
  NSString *line = LineTextWithoutTerminator(text, lineRange);
  if (selection.location != lineRange.location + line.length) return nil;
  AfternoteListStyle style = AfternoteListStyleBullet;
  NSUInteger number = 0;
  NSRange marker = ListMarkerRange(line, &style, &number);
  if (marker.location == NSNotFound) return nil;
  NSString *body = [line substringFromIndex:NSMaxRange(marker)];
  if ([body stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet].length == 0) {
    return [[AfternoteListContinuation alloc]
        initWithRange:NSMakeRange(lineRange.location + marker.location, marker.length)
          replacement:@"\n"];
  }
  NSString *nextMarker = style == AfternoteListStyleBullet
      ? @"- "
      : style == AfternoteListStyleChecklist
        ? @"☐ "
        : [NSString stringWithFormat:@"%lu. ",
            (unsigned long)(number == NSUIntegerMax ? NSUIntegerMax : number + 1)];
  NSString *indent = [line substringToIndex:marker.location];
  return [[AfternoteListContinuation alloc]
      initWithRange:selection
        replacement:[NSString stringWithFormat:@"\n%@%@", indent, nextMarker]];
}
