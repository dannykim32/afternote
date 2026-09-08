#import "application_installation.h"
#import <Security/Security.h>

#if defined(AFTERNOTE_RELEASE_BUILD) && !defined(AFTERNOTE_APPLICATION_CODE_REQUIREMENT)
#error "Release app installation must pin its own code-signing requirement"
#endif
#if defined(AFTERNOTE_RELEASE_BUILD) && !defined(AFTERNOTE_CLI_CODE_REQUIREMENT)
#error "Release app installation must pin the installed CLI code-signing requirement"
#endif

namespace {

NSString *InstallRoot(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:
      @"Library/Application Support/Afternote"];
}

NSString *CommandLinkPath(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".local/bin/afternote"];
}

BOOL IsRegularExecutable(NSString *path) {
  NSDictionary *attributes = [NSFileManager.defaultManager
      attributesOfItemAtPath:path error:nil];
  return [attributes[NSFileType] isEqualToString:NSFileTypeRegular] &&
      [NSFileManager.defaultManager isExecutableFileAtPath:path];
}

NSString *SingleLineMessage(NSData *data, NSString *fallback) {
  NSString *value = data.length > 0
      ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
      : nil;
  value = [[value componentsSeparatedByCharactersInSet:
      NSCharacterSet.newlineCharacterSet] componentsJoinedByString:@" "];
  value = [value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
  if (value.length == 0) value = fallback;
  if (value.length > 320) value = [[value substringToIndex:317] stringByAppendingString:@"…"];
  return value;
}

BOOL CodeAtURLSatisfiesRequirement(NSURL *url, NSString *requirementText) {
  if (url == nil || requirementText.length == 0) return NO;
  SecStaticCodeRef code = nullptr;
  SecRequirementRef requirement = nullptr;
  OSStatus status = SecStaticCodeCreateWithPath(
      (__bridge CFURLRef)url, kSecCSDefaultFlags, &code);
  if (status == errSecSuccess) {
    status = SecRequirementCreateWithString(
        (__bridge CFStringRef)requirementText,
        kSecCSDefaultFlags,
        &requirement);
  }
  if (status == errSecSuccess) {
    status = SecStaticCodeCheckValidity(
        code,
        kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode,
        requirement);
  }
  if (requirement != nullptr) CFRelease(requirement);
  if (code != nullptr) CFRelease(code);
  return status == errSecSuccess;
}

BOOL MainBundleIsAuthentic(void) {
#if !defined(AFTERNOTE_RELEASE_BUILD)
  return YES;
#else
  return CodeAtURLSatisfiesRequirement(
      NSBundle.mainBundle.bundleURL,
      [NSString stringWithUTF8String:AFTERNOTE_APPLICATION_CODE_REQUIREMENT]);
#endif
}

BOOL CommandLinkTargetsInstalledCommand(void) {
  NSString *linkPath = CommandLinkPath();
  NSDictionary *attributes = [NSFileManager.defaultManager
      attributesOfItemAtPath:linkPath error:nil];
  if (![attributes[NSFileType] isEqualToString:NSFileTypeSymbolicLink]) return NO;
  NSString *destination = [NSFileManager.defaultManager
      destinationOfSymbolicLinkAtPath:linkPath error:nil];
  if (destination.length == 0) return NO;
  if (![destination isAbsolutePath]) {
    destination = [[linkPath stringByDeletingLastPathComponent]
        stringByAppendingPathComponent:destination];
  }
  return [destination.stringByStandardizingPath
      isEqualToString:AfternoteInstalledCommandPath().stringByStandardizingPath] &&
      AfternoteIsAuthenticInstalledCommand(linkPath);
}

BOOL RunLifecycleScript(NSString *script,
                        NSDictionary<NSString *, NSString *> *extraEnvironment,
                        NSString *fallback,
                        NSString **errorMessage) {
  NSDictionary *attributes = [NSFileManager.defaultManager
      attributesOfItemAtPath:script error:nil];
  if (![attributes[NSFileType] isEqualToString:NSFileTypeRegular]) {
    if (errorMessage != nil) *errorMessage = @"The signed Afternote runtime is incomplete.";
    return NO;
  }
  if (!MainBundleIsAuthentic()) {
    if (errorMessage != nil) {
      *errorMessage = @"Afternote refused to run a lifecycle script from a modified or untrusted application bundle.";
    }
    return NO;
  }
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:@"/bin/sh"];
  task.arguments = @[ script ];
  NSDictionary<NSString *, NSString *> *processEnvironment =
      NSProcessInfo.processInfo.environment;
#if defined(AFTERNOTE_RELEASE_BUILD)
  NSMutableDictionary<NSString *, NSString *> *environment =
      [@{ @"HOME" : NSHomeDirectory(),
          @"PATH" : @"/usr/bin:/bin:/usr/sbin:/sbin" } mutableCopy];
  for (NSString *name in processEnvironment) {
    if ([name isEqualToString:@"TMPDIR"] || [name isEqualToString:@"LANG"] ||
        [name hasPrefix:@"LC_"]) {
      NSString *value = processEnvironment[name];
      if (value.length > 0) environment[name] = value;
    }
  }
#else
  NSMutableDictionary<NSString *, NSString *> *environment =
      [processEnvironment mutableCopy];
#endif
  [environment addEntriesFromDictionary:extraEnvironment ?: @{}];
  task.environment = environment;
  NSPipe *standardOutput = [NSPipe pipe];
  NSPipe *standardError = [NSPipe pipe];
  task.standardOutput = standardOutput;
  task.standardError = standardError;
  NSError *launchError = nil;
  if (![task launchAndReturnError:&launchError]) {
    if (errorMessage != nil) *errorMessage = fallback;
    return NO;
  }
  [task waitUntilExit];
  NSData *stderrData = [standardError.fileHandleForReading readDataToEndOfFile];
  if (task.terminationStatus != 0) {
    if (errorMessage != nil) *errorMessage = SingleLineMessage(stderrData, fallback);
    return NO;
  }
  if (errorMessage != nil && stderrData.length > 0) {
    *errorMessage = SingleLineMessage(stderrData, fallback);
  }
  return YES;
}

}  // namespace

NSString *AfternoteInstalledCommandPath(void) {
  return [InstallRoot() stringByAppendingPathComponent:@"current/afternote"];
}

BOOL AfternoteIsAuthenticInstalledCommand(NSString *path) {
  if (!IsRegularExecutable(path)) return NO;
#if !defined(AFTERNOTE_RELEASE_BUILD)
  return YES;
#else
  return CodeAtURLSatisfiesRequirement(
      [NSURL fileURLWithPath:path],
      [NSString stringWithUTF8String:AFTERNOTE_CLI_CODE_REQUIREMENT]);
#endif
}

BOOL AfternoteEnsureRuntimeInstalled(NSString **errorMessage) {
  NSURL *bundleURL = NSBundle.mainBundle.bundleURL;
  NSURL *runtimeURL = [NSBundle.mainBundle.resourceURL
      URLByAppendingPathComponent:@"AfternoteRuntime" isDirectory:YES];
  NSString *installScript = [[runtimeURL URLByAppendingPathComponent:@"install.sh"] path];
  if (![NSFileManager.defaultManager fileExistsAtPath:installScript]) return YES;

  NSString *bundlePath = bundleURL.path.stringByStandardizingPath;
  if ([bundlePath hasPrefix:@"/Volumes/"]) {
    if (errorMessage != nil) {
      *errorMessage = @"Drag Afternote into the Applications folder, eject the installer, then open Afternote from Applications.";
    }
    return NO;
  }

  NSString *version = NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"];
  if (version.length == 0) {
    if (errorMessage != nil) *errorMessage = @"This copy of Afternote has no valid version.";
    return NO;
  }
  NSString *installedVersion = [InstallRoot() stringByAppendingPathComponent:
      [NSString stringWithFormat:@"versions/%@/afternote", version]];
  NSString *currentCommand = AfternoteInstalledCommandPath();
  if (AfternoteIsAuthenticInstalledCommand(installedVersion) &&
      AfternoteIsAuthenticInstalledCommand(currentCommand) &&
      CommandLinkTargetsInstalledCommand()) return YES;

  if (!RunLifecycleScript(
          installScript,
          @{ @"AFTERNOTE_APPLICATION_PATH" : bundlePath },
          @"Afternote could not install its private local runtime.",
          errorMessage) || !AfternoteIsAuthenticInstalledCommand(currentCommand)) {
    if (errorMessage != nil && (*errorMessage).length == 0) {
      *errorMessage = @"Afternote could not activate its private local runtime.";
    }
    return NO;
  }
  return YES;
}

BOOL AfternoteUninstallRuntime(NSString **errorMessage) {
  NSString *script = [[[NSBundle.mainBundle.resourceURL
      URLByAppendingPathComponent:@"AfternoteRuntime" isDirectory:YES]
      URLByAppendingPathComponent:@"uninstall.sh"] path];
  return RunLifecycleScript(
      script, @{}, @"Afternote could not remove its local runtime.", errorMessage);
}
