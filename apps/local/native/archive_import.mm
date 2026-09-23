#import "archive_import.h"
#include <CommonCrypto/CommonDigest.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cerrno>
#include <functional>
#include <stdexcept>

namespace {
constexpr NSUInteger kMaximumBytes = 64 * 1024 * 1024;
constexpr NSUInteger kPassageCharacters = 8192;
struct Descriptor {
  int value;
  ~Descriptor() { if (value >= 0) close(value); }
};
void Require(bool condition, const char *message) {
  if (!condition) throw std::runtime_error(message);
}
bool IsWhitespace(unichar value) {
  return (value >= 0x0009 && value <= 0x000D) || value == 0x20 || value == 0xA0 ||
      value == 0x1680 || (value >= 0x2000 && value <= 0x200A) || value == 0x2028 ||
      value == 0x2029 || value == 0x202F || value == 0x205F || value == 0x3000 || value == 0xFEFF;
}

// Decode complete UTF-8 sequences only. Foundation rejects overlong encodings,
// surrogates and invalid continuation bytes; at most three bytes cross a read.
void ReadUTF8(int descriptor, BOOL (^stopped)(void),
              const std::function<void(NSString *, const void *, size_t)> &consume) {
  uint8_t buffer[65536];
  NSMutableData *pending = [NSMutableData data];
  off_t offset = 0;
  for (;;) {
    @autoreleasepool {
      Require(!stopped(), "Import paused. Select the same file to resume.");
      ssize_t count = pread(descriptor, buffer, sizeof(buffer), offset);
      if (count < 0 && errno == EINTR) continue;
      Require(count >= 0, "Could not read the transcript file.");
      if (count == 0) {
        Require(pending.length == 0, "Transcript is not valid UTF-8.");
        break;
      }
      offset += count;
      Require(offset <= kMaximumBytes, "Transcript exceeds 64 MiB.");
      [pending appendBytes:buffer length:(NSUInteger)count];
      const uint8_t *bytes = (const uint8_t *)pending.bytes;
      NSUInteger end = pending.length, lead = end;
      while (lead > 0 && (bytes[lead - 1] & 0xC0) == 0x80) lead--;
      if (lead > 0) {
        lead--;
        uint8_t first = bytes[lead];
        NSUInteger length = first >= 0xC2 && first <= 0xDF ? 2 :
            first >= 0xE0 && first <= 0xEF ? 3 : first >= 0xF0 && first <= 0xF4 ? 4 : 1;
        if (end - lead < length) end = lead;
      }
      NSString *decoded = [[NSString alloc] initWithBytes:bytes length:end encoding:NSUTF8StringEncoding];
      Require(decoded != nil, "Transcript is not valid UTF-8.");
      // NSString consumes a leading UTF-8 BOM on every decode, including one at
      // an internal chunk boundary. Archives preserve those bytes verbatim.
      if (end >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) {
        decoded = [@"\uFEFF" stringByAppendingString:decoded];
      }
      consume(decoded, buffer, (size_t)count);
      [pending replaceBytesInRange:NSMakeRange(0, end) withBytes:nullptr length:0];
      Require(pending.length <= 3, "Transcript is not valid UTF-8.");
    }
  }
}

NSUInteger PassageEnd(NSString *text) {
  NSUInteger position = 0, count = 0, whitespace = 0;
  while (position < text.length && count < kPassageCharacters) {
    unichar value = [text characterAtIndex:position++];
    if (CFStringIsSurrogateHighCharacter(value)) position++;
    count++;
    if (count > kPassageCharacters / 2 && IsWhitespace(value)) whitespace = position;
  }
  return count == kPassageCharacters ? (whitespace ?: position) : 0;
}
} // namespace

NSDictionary *AfternoteImportArchive(NSString *path, NSString *title, NSString *resumeId,
    AfternoteArchiveRequest request, BOOL (^shouldStop)(void),
    AfternoteArchiveProgress progress, NSDictionary **error) {
  try {
    Require(path.isAbsolutePath, "Select an absolute transcript path.");
    Descriptor descriptor{open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)};
    struct stat info;
    Require(descriptor.value >= 0 && fstat(descriptor.value, &info) == 0 && S_ISREG(info.st_mode) &&
        info.st_size > 0 && info.st_size <= kMaximumBytes,
        "Transcript must be a nonempty regular UTF-8 file of at most 64 MiB.");
    CC_SHA256_CTX hash;
    CC_SHA256_Init(&hash);
    NSUInteger bytes = 0;
    ReadUTF8(descriptor.value, shouldStop, [&](NSString *, const void *chunk, size_t count) {
      bytes += count;
      CC_SHA256_Update(&hash, chunk, (CC_LONG)count);
      if (progress) progress(@"verifying", 0, (NSUInteger)info.st_size, nil);
    });
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &hash);
    NSMutableString *sha = [NSMutableString stringWithCapacity:64];
    for (unsigned char value : digest) [sha appendFormat:@"%02x", value];
    auto call = [&](NSString *method, NSDictionary *params) -> NSDictionary * {
      Require(!shouldStop(), "Import paused. Select the same file to resume.");
      NSDictionary *failure = nil;
      NSDictionary *result = request(method, params, &failure);
      if (result == nil) {
        if (error) *error = failure ?: @{ @"code": @"unavailable", @"message": @"Archive request failed. The import can be resumed." };
        throw std::runtime_error("Archive request failed. The import can be resumed.");
      }
      return result;
    };
    NSDictionary *archive = call(resumeId.length ? @"library.archive_status" : @"library.archive_begin",
        resumeId.length ? @{ @"id": resumeId } : @{ @"title": title, @"bytes": @(bytes), @"sha256": sha })[@"archive"];
    Require([archive[@"sha256"] isEqual:sha] && [archive[@"expectedBytes"] unsignedIntegerValue] == bytes &&
        [archive[@"title"] isEqual:title], "Selected transcript does not match this pending Archive.");
    NSString *identifier = archive[@"id"];
    Require([identifier isKindOfClass:NSString.class], "Invalid Archive response.");
    if (progress) progress(@"saving", [archive[@"savedBytes"] unsignedIntegerValue], bytes, identifier);
    if ([archive[@"state"] isEqual:@"ready"]) return archive;
    NSMutableString *pending = [NSMutableString string];
    NSMutableArray<NSString *> *batch = [NSMutableArray array];
    NSUInteger index = 0;
    auto flush = [&]() {
      if (batch.count == 0) return;
      NSDictionary *saved = call(@"library.archive_append", @{ @"id": identifier, @"startIndex": @(index), @"passages": [batch copy] })[@"archive"];
      index += batch.count;
      [batch removeAllObjects];
      if (progress) progress(@"saving", [saved[@"savedBytes"] unsignedIntegerValue], bytes, identifier);
    };
    ReadUTF8(descriptor.value, shouldStop, [&](NSString *text, const void *, size_t) {
      [pending appendString:text];
      for (NSUInteger end = PassageEnd(pending); end > 0; end = PassageEnd(pending)) {
        [batch addObject:[pending substringToIndex:end]];
        [pending deleteCharactersInRange:NSMakeRange(0, end)];
        if (batch.count == 8) flush();
      }
    });
    if (pending.length) [batch addObject:[pending copy]];
    flush();
    NSDictionary *saved = call(@"library.archive_complete", @{ @"id": identifier })[@"archive"];
    if (progress) progress(@"saved", bytes, bytes, identifier);
    return saved;
  } catch (const std::exception &failure) {
    if (error && *error == nil) *error = @{ @"code": shouldStop() ? @"cancelled" : @"invalid_input",
        @"message": [NSString stringWithUTF8String:failure.what()] };
    return nil;
  }
}
