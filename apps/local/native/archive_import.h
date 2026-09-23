#pragma once
#import <Foundation/Foundation.h>

// Owner-side streaming only. The broker receives bounded text batches, never a path.
typedef NSDictionary *(^AfternoteArchiveRequest)(NSString *method, NSDictionary *params, NSDictionary **error);
typedef void (^AfternoteArchiveProgress)(NSString *phase, NSUInteger savedBytes, NSUInteger totalBytes, NSString *archiveId);
NSDictionary *AfternoteImportArchive(NSString *path, NSString *title, NSString *resumeId,
    AfternoteArchiveRequest request, BOOL (^shouldStop)(void),
    AfternoteArchiveProgress progress, NSDictionary **error);
