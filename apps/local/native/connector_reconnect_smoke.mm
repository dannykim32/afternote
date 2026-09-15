#import "connector_overview.h"
#import "connector_presentation.h"

// Consume the actual broker response, then run the same typed overview and
// presentation boundaries used by Connections in a fresh process.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 2;
    NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
    id result = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    AfternoteConnectorOverviewItem *item =
        AfternoteConnectorOverviewByKind(result)[[NSString stringWithUTF8String:argv[1]]];
    if (item == nil) { fputs("invalid overview\n", stderr); return 2; }
    AfternoteConnectorPresentation *view = [AfternoteConnectorPresentation
        presentationForTool:@"Fixture host"
        status:@{@"toolAvailable":@YES, @"installed":@YES, @"healthy":@YES}
        connected:item.hasCurrentAuthority revoked:[item.status isEqualToString:@"revoked"]
        reconnectPrepared:[item.status isEqualToString:@"reconnect-prepared"]
        lastActiveLabel:@""];
    NSData *output = [NSJSONSerialization dataWithJSONObject:@{
      @"status":item.status, @"hasAuthority":@(item.hasCurrentAuthority),
      @"action":@(view.action), @"title":view.connectionTitle,
    } options:0 error:nil];
    fwrite(output.bytes, 1, output.length, stdout);
    return 0;
  }
}
