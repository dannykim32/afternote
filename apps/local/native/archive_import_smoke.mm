#import "archive_import.h"
#include <CommonCrypto/CommonDigest.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 3) return 64;
    NSString *path = [NSString stringWithUTF8String:argv[1]];
    __block BOOL interrupt = strcmp(argv[2], "resume") == 0;
    __block BOOL stopped = NO;
    __block NSMutableDictionary *archive = nil;
    NSMutableArray<NSString *> *passages = [NSMutableArray array];
    __block NSUInteger begins = 0, retries = 0;
    AfternoteArchiveRequest request = ^NSDictionary *(NSString *method, NSDictionary *params, NSDictionary **error) {
      if ([method isEqual:@"library.archive_begin"]) {
        begins++;
        archive = [@{ @"id": @"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", @"state": @"importing",
          @"title": params[@"title"], @"sha256": params[@"sha256"], @"expectedBytes": params[@"bytes"], @"savedBytes": @0 } mutableCopy];
      } else if ([method isEqual:@"library.archive_append"]) {
        NSUInteger index = [params[@"startIndex"] unsignedIntegerValue];
        NSArray *batch = params[@"passages"];
        if (index < passages.count) {
          retries++;
          if (index + batch.count > passages.count || ![[passages subarrayWithRange:NSMakeRange(index, batch.count)] isEqual:batch]) return nil;
        } else {
          if (index != passages.count || batch.count > 8) return nil;
          NSUInteger bytes = [archive[@"savedBytes"] unsignedIntegerValue];
          for (NSString *text in batch) bytes += [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
          [passages addObjectsFromArray:batch];
          archive[@"savedBytes"] = @(bytes);
        }
        if (interrupt) stopped = YES;
      } else if ([method isEqual:@"library.archive_complete"]) {
        archive[@"state"] = @"ready";
      } else if (![method isEqual:@"library.archive_status"]) return nil;
      return @{ @"archive": [archive copy] };
    };
    NSDictionary *error = nil;
    NSDictionary *saved = AfternoteImportArchive(path, @"Fixture", nil, request, ^BOOL { return stopped; }, nil, &error);
    if (interrupt && saved == nil && archive != nil) {
      interrupt = NO;
      stopped = NO;
      error = nil;
      saved = AfternoteImportArchive(path, @"Fixture", archive[@"id"], request, ^BOOL { return stopped; }, nil, &error);
    }
    CC_SHA256_CTX hash;
    CC_SHA256_Init(&hash);
    for (NSString *text in passages) {
      NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
      CC_SHA256_Update(&hash, data.bytes, (CC_LONG)data.length);
    }
    unsigned char digest[32]; CC_SHA256_Final(digest, &hash);
    NSMutableString *sha = [NSMutableString string];
    for (unsigned char value : digest) [sha appendFormat:@"%02x", value];
    NSDictionary *output = @{ @"saved": @(saved != nil), @"begins": @(begins), @"retries": @(retries),
      @"passages": @(passages.count), @"contentSha256": sha, @"archive": saved ?: NSNull.null, @"error": error ?: NSNull.null };
    NSData *json = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
    return 0;
  }
}
