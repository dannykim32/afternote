#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>

#include <xpc/xpc.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <spawn.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS) && \
    (!defined(AFTERNOTE_DEVELOPMENT_BUILD) || defined(AFTERNOTE_RELEASE_BUILD))
#error "Owner-presence bypass is restricted to development builds"
#endif

extern char **environ;

@protocol AfternoteOwnerAuthenticationContext <NSObject>
- (void)invalidate;
@end

#if defined(AFTERNOTE_GATEWAY_TESTING)
@interface AfternoteTestAuthenticationContext : NSObject <AfternoteOwnerAuthenticationContext>
@property(nonatomic) BOOL invalidated;
@end

@implementation AfternoteTestAuthenticationContext
- (void)invalidate {
  self.invalidated = YES;
}
@end
#endif

namespace {

constexpr size_t kMaximumMessageBytes = 1024 * 1024;
constexpr int64_t kOwnerAuthenticationTimeoutSeconds = 120;

#if !defined(AFTERNOTE_GATEWAY_TESTING)
#if !defined(AFTERNOTE_CLIENT_CODE_REQUIREMENT) || \
    !defined(AFTERNOTE_OWNER_CONTROL_CODE_REQUIREMENT) || \
    !defined(AFTERNOTE_WORKER_CODE_REQUIREMENT)
#error "Production gateway requires fixed client, owner-control, and worker code-signing requirements"
#endif
#endif

struct Worker {
  pid_t pid = -1;
  std::mutex exchange_mutex;
  std::mutex channel_mutex;
  std::condition_variable channel_changed;
  xpc_object_t waiting_poll = nullptr;
  pid_t channel_pid = -1;
  uint64_t next_request_id = 1;
  uint64_t awaiting_response_id = 0;
  std::string response;
  bool response_ready = false;
  bool unavailable = false;
};

std::string SerializeObject(NSDictionary *value);

xpc_connection_t g_memory_listener = nullptr;
xpc_connection_t g_owner_listener = nullptr;
xpc_connection_t g_worker_listener = nullptr;
std::mutex g_owner_context_mutex;
NSMutableDictionary<NSString *, id<AfternoteOwnerAuthenticationContext>> *g_owner_contexts;
NSMutableSet<NSString *> *g_closed_owner_peers;
NSMutableDictionary<NSString *, id> *g_owner_peers;

void RegisterOwnerPeer(NSString *connection_id, xpc_connection_t peer) {
  std::lock_guard<std::mutex> lock(g_owner_context_mutex);
  if (g_owner_peers == nil) g_owner_peers = [NSMutableDictionary dictionary];
  if (g_closed_owner_peers == nil) g_closed_owner_peers = [NSMutableSet set];
  [g_closed_owner_peers removeObject:connection_id];
  g_owner_peers[connection_id] = peer;
}

NSString *OwnerContextKey(NSString *connection_id, NSString *challenge_id) {
  return [NSString stringWithFormat:@"%@:%@", connection_id, challenge_id];
}

bool RegisterOwnerContext(NSString *connection_id, NSString *challenge_id,
                          id<AfternoteOwnerAuthenticationContext> context) {
  std::lock_guard<std::mutex> lock(g_owner_context_mutex);
  if (g_owner_contexts == nil) g_owner_contexts = [NSMutableDictionary dictionary];
  if (g_closed_owner_peers == nil) g_closed_owner_peers = [NSMutableSet set];
  if ([g_closed_owner_peers containsObject:connection_id]) {
    [context invalidate];
    return false;
  }
  g_owner_contexts[OwnerContextKey(connection_id, challenge_id)] = context;
  return true;
}

void UnregisterOwnerContext(NSString *connection_id, NSString *challenge_id,
                            id<AfternoteOwnerAuthenticationContext> context) {
  std::lock_guard<std::mutex> lock(g_owner_context_mutex);
  NSString *key = OwnerContextKey(connection_id, challenge_id);
  if (g_owner_contexts[key] == context) [g_owner_contexts removeObjectForKey:key];
}

void CloseOwnerPeer(NSString *connection_id) {
  NSMutableArray<id<AfternoteOwnerAuthenticationContext>> *contexts = [NSMutableArray array];
  {
    std::lock_guard<std::mutex> lock(g_owner_context_mutex);
    if (g_owner_contexts == nil) g_owner_contexts = [NSMutableDictionary dictionary];
    if (g_closed_owner_peers == nil) g_closed_owner_peers = [NSMutableSet set];
    if (g_owner_peers == nil) g_owner_peers = [NSMutableDictionary dictionary];
    [g_closed_owner_peers addObject:connection_id];
    [g_owner_peers removeObjectForKey:connection_id];
    NSString *prefix = [connection_id stringByAppendingString:@":"];
    for (NSString *key in [g_owner_contexts.allKeys copy]) {
      if ([key hasPrefix:prefix]) {
        [contexts addObject:g_owner_contexts[key]];
        [g_owner_contexts removeObjectForKey:key];
      }
    }
  }
  for (id<AfternoteOwnerAuthenticationContext> context in contexts) [context invalidate];
}

void InvalidateOtherOwnerPeers(NSString *invoking_connection_id) {
  NSDictionary<NSString *, id> *snapshot;
  {
    std::lock_guard<std::mutex> lock(g_owner_context_mutex);
    snapshot = [g_owner_peers copy] ?: @{};
  }
  for (NSString *connection_id in snapshot) {
    if ([connection_id isEqualToString:invoking_connection_id]) continue;
    xpc_connection_t peer = (xpc_connection_t)snapshot[connection_id];
    CloseOwnerPeer(connection_id);
    xpc_connection_cancel(peer);
  }
}

NSDate *OwnerChallengeDeadline(NSString *value) {
  if (![value isKindOfClass:[NSString class]] || value.length == 0 || value.length > 40) return nil;
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
      NSISO8601DateFormatWithFractionalSeconds;
  return [formatter dateFromString:value];
}

NSTimeInterval OwnerAuthenticationWait(NSDate *challenge_deadline) {
  return MIN((NSTimeInterval)kOwnerAuthenticationTimeoutSeconds,
             MAX((NSTimeInterval)0, [challenge_deadline timeIntervalSinceNow]));
}

bool WaitForOwnerAuthentication(id<AfternoteOwnerAuthenticationContext> context,
                                dispatch_semaphore_t completed,
                                NSString *connection_id,
                                NSString *challenge_id,
                                NSDate *challenge_deadline) {
  NSTimeInterval wait = OwnerAuthenticationWait(challenge_deadline);
  bool completed_in_time = wait > 0 && dispatch_semaphore_wait(
      completed,
      dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC))) == 0;
  UnregisterOwnerContext(connection_id, challenge_id, context);
  [context invalidate];
  return completed_in_time;
}

bool ProcessSatisfiesRequirement(pid_t process_pid, const char *required) {
  if (required == nullptr || required[0] == '\0') return false;
  int64_t pid_value = static_cast<int64_t>(process_pid);
  if (pid_value <= 1) return false;
  CFNumberRef pid = CFNumberCreate(
      kCFAllocatorDefault, kCFNumberSInt64Type, &pid_value);
  const void *keys[] = {kSecGuestAttributePid};
  const void *values[] = {pid};
  CFDictionaryRef attributes = CFDictionaryCreate(
      kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = nullptr;
  OSStatus status = SecCodeCopyGuestWithAttributes(
      nullptr, attributes, kSecCSDefaultFlags, &code);
  CFRelease(attributes);
  CFRelease(pid);
  NSString *text = [NSString stringWithUTF8String:required];
  SecRequirementRef requirement = nullptr;
  if (status == errSecSuccess && text != nil) {
    status = SecRequirementCreateWithString(
        (__bridge CFStringRef)text, kSecCSDefaultFlags, &requirement);
  }
  if (status == errSecSuccess) {
    status = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
  }
  if (requirement != nullptr) CFRelease(requirement);
  if (code != nullptr) CFRelease(code);
  return status == errSecSuccess;
}

std::string ExecutableDirectory() {
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::string path(size, '\0');
  if (_NSGetExecutablePath(path.data(), &size) != 0) return {};
  path.resize(strlen(path.c_str()));
  const size_t slash = path.find_last_of('/');
  return slash == std::string::npos ? std::string() : path.substr(0, slash);
}

const char *WorkerCodeRequirement() {
#if defined(AFTERNOTE_GATEWAY_TESTING)
  return getenv("AFTERNOTE_TEST_WORKER_CODE_REQUIREMENT");
#else
  return AFTERNOTE_WORKER_CODE_REQUIREMENT;
#endif
}

bool SpawnWorker(Worker *worker, std::string *error) {
#if defined(AFTERNOTE_GATEWAY_TESTING)
  const char *configured = getenv("AFTERNOTE_BROKER_WORKER_PATH");
  const std::string worker_path =
      configured != nullptr && configured[0] != '\0'
          ? configured
          : ExecutableDirectory() + "/afternote-vault-worker";
#else
  const std::string executable_directory = ExecutableDirectory();
  const std::string worker_path = executable_directory.empty()
      ? std::string()
      : executable_directory +
            "/AfternoteVaultWorker.app/Contents/MacOS/afternote-vault-worker";
#endif
  if (worker_path.empty() || worker_path[0] != '/') {
    *error = "Broker worker path must be absolute";
    return false;
  }

  const char *worker_requirement = WorkerCodeRequirement();
  if (worker_requirement != nullptr && worker_requirement[0] != '\0') {
    NSString *path = [NSString stringWithUTF8String:worker_path.c_str()];
    NSURL *url = path == nil ? nil : [NSURL fileURLWithPath:path];
    SecStaticCodeRef code = nullptr;
    OSStatus status = url == nil
                          ? errSecParam
                          : SecStaticCodeCreateWithPath(
                                (__bridge CFURLRef)url, kSecCSDefaultFlags,
                                &code);
    NSString *text = [NSString stringWithUTF8String:worker_requirement];
    SecRequirementRef requirement = nullptr;
    if (status == errSecSuccess && text == nil) status = errSecParam;
    if (status == errSecSuccess) {
      status = SecRequirementCreateWithString(
          (__bridge CFStringRef)text, kSecCSDefaultFlags, &requirement);
    }
    if (status == errSecSuccess) {
      status = SecStaticCodeCheckValidity(
          code, kSecCSStrictValidate | kSecCSCheckAllArchitectures,
          requirement);
    }
    if (requirement != nullptr) CFRelease(requirement);
    if (code != nullptr) CFRelease(code);
    if (status != errSecSuccess) {
      *error = "Broker worker does not satisfy its code-signing requirement";
      return false;
    }
  }

  posix_spawn_file_actions_t actions = nullptr;
  int actions_status = posix_spawn_file_actions_init(&actions);
  if (actions_status == 0) {
    actions_status = posix_spawn_file_actions_addopen(
        &actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
  }
  if (actions_status == 0) {
    actions_status = posix_spawn_file_actions_addopen(
        &actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0);
  }
  if (actions_status != 0) {
    if (actions != nullptr) posix_spawn_file_actions_destroy(&actions);
    *error = "Could not isolate the private broker worker standard streams (" +
             std::to_string(actions_status) + ")";
    return false;
  }

  char *arguments[] = {const_cast<char *>(worker_path.c_str()), nullptr};
  std::vector<std::string> environment_values;
  for (char **entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
    std::string value(*entry);
    const bool runtime_value =
        value.rfind("HOME=", 0) == 0 ||
        value.rfind("TMPDIR=", 0) == 0 ||
        value.rfind("LANG=", 0) == 0 ||
        value.rfind("LC_", 0) == 0;
#if defined(AFTERNOTE_GATEWAY_TESTING) || defined(AFTERNOTE_ACCEPTANCE_TRACE)
    const bool test_value = value.rfind("AFTERNOTE_", 0) == 0;
#else
    const bool test_value = false;
#endif
    if (runtime_value || test_value) environment_values.push_back(value);
  }
  environment_values.push_back("DYLD_LIBRARY_PATH=" + ExecutableDirectory());
  std::vector<char *> child_environment;
  child_environment.reserve(environment_values.size() + 1);
  for (std::string &value : environment_values) child_environment.push_back(value.data());
  child_environment.push_back(nullptr);
  pid_t spawned_pid = -1;
  const int status = posix_spawn(&spawned_pid, worker_path.c_str(), &actions,
                                 nullptr, arguments, child_environment.data());
  posix_spawn_file_actions_destroy(&actions);
  if (status != 0) {
    *error = "Could not launch the private broker worker (" +
             std::to_string(status) + ")";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(worker->channel_mutex);
    worker->pid = spawned_pid;
    worker->channel_changed.notify_all();
  }
  if (worker_requirement == nullptr || worker_requirement[0] == '\0' ||
      !ProcessSatisfiesRequirement(spawned_pid, worker_requirement)) {
    kill(spawned_pid, SIGKILL);
    while (waitpid(spawned_pid, nullptr, 0) < 0 && errno == EINTR) {}
    std::lock_guard<std::mutex> lock(worker->channel_mutex);
    worker->pid = -1;
    worker->unavailable = true;
    worker->channel_changed.notify_all();
    *error = "Launched broker worker does not satisfy its code-signing requirement";
    return false;
  }
  return true;
}

bool Exchange(Worker *worker, const std::string &request, std::string *response,
              std::string *error) {
  if (request.empty() || request.size() > kMaximumMessageBytes ||
      request.find('\n') != std::string::npos) {
    *error = "Broker request is malformed or oversized";
    return false;
  }
  std::lock_guard<std::mutex> exchange_lock(worker->exchange_mutex);
  std::unique_lock<std::mutex> channel_lock(worker->channel_mutex);
  if (!worker->channel_changed.wait_for(
          channel_lock, std::chrono::seconds(5),
          [worker] { return worker->waiting_poll != nullptr || worker->unavailable; })) {
    *error = "Authenticated broker worker channel is unavailable";
    return false;
  }
  if (worker->unavailable || worker->waiting_poll == nullptr) {
    *error = "Authenticated broker worker channel is unavailable";
    return false;
  }

  const uint64_t request_id = worker->next_request_id++;
  worker->awaiting_response_id = request_id;
  worker->response.clear();
  worker->response_ready = false;
  xpc_object_t poll = worker->waiting_poll;
  worker->waiting_poll = nullptr;
  NSDictionary *delivery = @{
    @"protocolVersion" : @1,
    @"requestId" : @(request_id),
    @"request" : [NSString stringWithUTF8String:request.c_str()],
  };
  const std::string serialized_delivery = SerializeObject(delivery);
  xpc_object_t reply = xpc_dictionary_create_reply(poll);
  xpc_connection_t peer = xpc_dictionary_get_remote_connection(poll);
  if (reply == nullptr || peer == nullptr || serialized_delivery.empty()) {
    worker->unavailable = true;
    worker->awaiting_response_id = 0;
    *error = "Authenticated broker worker request could not be delivered";
    return false;
  }
  xpc_dictionary_set_string(reply, "response", serialized_delivery.c_str());
  xpc_connection_send_message(peer, reply);

  if (!worker->channel_changed.wait_for(
          channel_lock, std::chrono::seconds(kOwnerAuthenticationTimeoutSeconds + 10),
          [worker] { return worker->response_ready || worker->unavailable; })) {
    worker->unavailable = true;
    worker->awaiting_response_id = 0;
    *error = "Authenticated broker worker response timed out";
    return false;
  }
  if (!worker->response_ready) {
    worker->awaiting_response_id = 0;
    *error = "Authenticated broker worker channel closed";
    return false;
  }
  *response = worker->response;
  worker->response.clear();
  worker->response_ready = false;
  worker->awaiting_response_id = 0;
  return true;
}

void MonitorWorker(pid_t worker_pid) {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    int status = 0;
    while (waitpid(worker_pid, &status, 0) < 0 && errno == EINTR) {}
    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC),
        dispatch_get_main_queue(), ^{ _exit(70); });
  });
}

void RegisterSessionRevocationObservers(pid_t worker_pid) {
  void (^retire_worker)(NSNotification *) = ^(NSNotification *) {
    if (worker_pid > 0) kill(worker_pid, SIGTERM);
  };
  [[NSDistributedNotificationCenter defaultCenter]
      addObserverForName:@"com.apple.screenIsLocked"
                  object:nil
                   queue:nil
              usingBlock:retire_worker];
  [[[NSWorkspace sharedWorkspace] notificationCenter]
      addObserverForName:NSWorkspaceSessionDidResignActiveNotification
                  object:nil
                   queue:nil
              usingBlock:retire_worker];
  [[[NSWorkspace sharedWorkspace] notificationCenter]
      addObserverForName:NSWorkspaceWillSleepNotification
                  object:nil
                   queue:nil
              usingBlock:retire_worker];
}

NSString *ConnectionIdentifier() {
  return [[NSUUID UUID] UUIDString];
}

struct OwnerAuthenticationResult {
  bool approved;
  const char *outcome;
};

OwnerAuthenticationResult AuthenticateOwner(NSString *reason,
                                             NSString *connection_id,
                                             NSString *challenge_id,
                                             NSDate *challenge_deadline) {
  if (OwnerAuthenticationWait(challenge_deadline) <= 0) return {false, "timed_out"};
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
  return {true, "approved"};
#endif
#if defined(AFTERNOTE_GATEWAY_TESTING)
  const char *test_mode = getenv("AFTERNOTE_OWNER_PRESENCE_TEST_MODE");
  if (test_mode != nullptr) {
    return strcmp(test_mode, "approve") == 0
               ? OwnerAuthenticationResult{true, "approved"}
               : OwnerAuthenticationResult{false, "denied"};
  }
#endif
#if defined(AFTERNOTE_ACCEPTANCE_TRACE)
  NSData *prompt_data = [NSJSONSerialization dataWithJSONObject:@{
    @"kind" : @"owner-prompt",
    @"reasonCharacters" : @(reason.length),
  } options:0 error:nil];
  if (prompt_data != nil) {
    fprintf(stderr, "AFTERNOTE_ACCEPTANCE_DIAGNOSTIC %.*s\n",
            (int)prompt_data.length, (const char *)prompt_data.bytes);
    fflush(stderr);
  }
  const auto started_at = std::chrono::steady_clock::now();
#endif
  LAContext *context = [[LAContext alloc] init];
  if (!RegisterOwnerContext(connection_id, challenge_id, context)) {
    return {false, "cancelled"};
  }
  NSError *availability_error = nil;
  if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication
                            error:&availability_error]) {
    UnregisterOwnerContext(connection_id, challenge_id, context);
    [context invalidate];
    return {false, "unavailable"};
  }
  dispatch_semaphore_t completed = dispatch_semaphore_create(0);
  __block BOOL approved = NO;
  __block const char *outcome = "denied";
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
          localizedReason:reason
                    reply:^(BOOL success, NSError *error) {
                      approved = success;
                      if (success) {
                        outcome = "approved";
                      } else if (error != nil &&
                                 (error.code == LAErrorUserCancel ||
                                  error.code == LAErrorAppCancel ||
                                  error.code == LAErrorSystemCancel)) {
                        outcome = "cancelled";
                      }
                      dispatch_semaphore_signal(completed);
                    }];
  const bool completed_in_time = WaitForOwnerAuthentication(
      context, completed, connection_id, challenge_id, challenge_deadline);
  const bool accepted = completed_in_time && approved == YES;
  if (!completed_in_time) outcome = "timed_out";
#if defined(AFTERNOTE_ACCEPTANCE_TRACE)
  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started_at).count();
  NSData *decision_data = [NSJSONSerialization dataWithJSONObject:@{
    @"kind" : @"owner-decision",
    @"approved" : @(accepted),
    @"outcome" : [NSString stringWithUTF8String:outcome],
    @"completedInTime" : @(completed_in_time),
    @"elapsedMs" : @(elapsed),
  } options:0 error:nil];
  if (decision_data != nil) {
    fprintf(stderr, "AFTERNOTE_ACCEPTANCE_DIAGNOSTIC %.*s\n",
            (int)decision_data.length, (const char *)decision_data.bytes);
    fflush(stderr);
  }
#endif
  return {accepted, outcome};
}

NSDictionary *ParseObject(const std::string &json) {
  NSData *data = [NSData dataWithBytes:json.data() length:json.size()];
  id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [value isKindOfClass:[NSDictionary class]] ? value : nil;
}

std::string SerializeObject(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (data == nil) return {};
  return std::string(static_cast<const char *>(data.bytes), data.length);
}

bool HasExactKeys(NSDictionary *value, NSArray<NSString *> *keys) {
  return value != nil && [[NSSet setWithArray:value.allKeys]
      isEqualToSet:[NSSet setWithArray:keys]];
}

void RejectWorkerPoll(xpc_connection_t peer, xpc_object_t event,
                      const char *message) {
  xpc_object_t reply = xpc_dictionary_create_reply(event);
  if (reply != nullptr) {
    xpc_dictionary_set_string(reply, "error", message);
    xpc_connection_send_message(peer, reply);
  }
  xpc_connection_cancel(peer);
}

void CloseWorkerChannel(Worker *worker, pid_t peer_pid) {
  std::lock_guard<std::mutex> lock(worker->channel_mutex);
  if (worker->channel_pid != peer_pid) return;
  if (worker->waiting_poll != nullptr) {
    worker->waiting_poll = nullptr;
  }
  worker->channel_pid = -1;
  worker->unavailable = true;
  worker->channel_changed.notify_all();
}

void HandleWorkerPoll(Worker *worker, xpc_connection_t peer, pid_t peer_pid,
                      xpc_object_t event) {
  if (xpc_get_type(event) != XPC_TYPE_DICTIONARY) {
    if (xpc_get_type(event) == XPC_TYPE_ERROR) CloseWorkerChannel(worker, peer_pid);
    return;
  }
  const char *serialized = xpc_dictionary_get_string(event, "request");
  if (serialized == nullptr || serialized[0] == '\0' ||
      strlen(serialized) > kMaximumMessageBytes) {
    RejectWorkerPoll(peer, event, "Private worker message is invalid");
    CloseWorkerChannel(worker, peer_pid);
    return;
  }
  NSDictionary *message = ParseObject(serialized);
  if (!HasExactKeys(message, @[@"protocolVersion", @"responseTo", @"response", @"terminate"]) ||
      ![message[@"protocolVersion"] isEqual:@1] ||
      ![message[@"responseTo"] isKindOfClass:[NSNumber class]] ||
      ![message[@"terminate"] isKindOfClass:[NSNumber class]] ||
      (![message[@"response"] isKindOfClass:[NSString class]] &&
       message[@"response"] != NSNull.null)) {
    RejectWorkerPoll(peer, event, "Private worker protocol is invalid");
    CloseWorkerChannel(worker, peer_pid);
    return;
  }
  NSNumber *response_number = message[@"responseTo"];
  const int64_t signed_response_to = response_number.longLongValue;
  if (signed_response_to < 0 ||
      response_number.doubleValue != static_cast<double>(signed_response_to)) {
    RejectWorkerPoll(peer, event, "Private worker response ID is invalid");
    CloseWorkerChannel(worker, peer_pid);
    return;
  }
  const uint64_t response_to = static_cast<uint64_t>(signed_response_to);
  NSString *worker_response = [message[@"response"] isKindOfClass:[NSString class]]
      ? message[@"response"] : nil;
  const bool terminate = [message[@"terminate"] isEqual:@YES];
  if (![message[@"terminate"] isEqual:@YES] &&
      ![message[@"terminate"] isEqual:@NO]) {
    RejectWorkerPoll(peer, event, "Private worker termination state is invalid");
    CloseWorkerChannel(worker, peer_pid);
    return;
  }
  if (worker_response != nil &&
      [worker_response lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > kMaximumMessageBytes) {
    RejectWorkerPoll(peer, event, "Private worker response is oversized");
    CloseWorkerChannel(worker, peer_pid);
    return;
  }

  std::unique_lock<std::mutex> lock(worker->channel_mutex);
  if (worker->channel_pid != peer_pid || worker->unavailable ||
      worker->waiting_poll != nullptr ||
      response_to != worker->awaiting_response_id ||
      (response_to == 0 && worker_response != nil) ||
      (response_to != 0 && worker_response == nil)) {
    lock.unlock();
    RejectWorkerPoll(peer, event, "Private worker response is out of sequence");
    CloseWorkerChannel(worker, peer_pid);
    return;
  }
  if (response_to != 0) {
    worker->response.assign(worker_response.UTF8String);
    worker->response_ready = true;
  }
  if (terminate) {
    NSDictionary *acknowledgement = @{
      @"protocolVersion" : @1,
      @"shutdown" : @YES,
    };
    const std::string serialized_acknowledgement = SerializeObject(acknowledgement);
    xpc_object_t reply = xpc_dictionary_create_reply(event);
    if (reply != nullptr && !serialized_acknowledgement.empty()) {
      xpc_dictionary_set_string(reply, "response", serialized_acknowledgement.c_str());
      xpc_connection_send_message(peer, reply);
    }
    worker->channel_pid = -1;
    worker->unavailable = true;
  } else {
    worker->waiting_poll = event;
  }
  worker->channel_changed.notify_all();
}

xpc_connection_t CreateWorkerListener(Worker *worker, const char *service,
                                      const char *requirement) {
  if (service == nullptr || service[0] == '\0' || strlen(service) > 255 ||
      requirement == nullptr || requirement[0] == '\0') {
    fprintf(stderr, "Private worker Mach service configuration is invalid\n");
    return nullptr;
  }
  xpc_connection_t listener = xpc_connection_create_mach_service(
      service, dispatch_get_main_queue(), XPC_CONNECTION_MACH_SERVICE_LISTENER);
  if (listener == nullptr) {
    fprintf(stderr, "Could not claim the private worker Mach service\n");
    return nullptr;
  }
  if (xpc_connection_set_peer_code_signing_requirement(listener, requirement) != 0) {
    fprintf(stderr, "Private worker code-signing requirement is invalid\n");
    return nullptr;
  }
  xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
    if (xpc_get_type(event) != XPC_TYPE_CONNECTION) return;
    xpc_connection_t peer = static_cast<xpc_connection_t>(event);
    const pid_t peer_pid = xpc_connection_get_pid(peer);
    {
      std::unique_lock<std::mutex> lock(worker->channel_mutex);
      worker->channel_changed.wait_for(lock, std::chrono::seconds(5),
                                       [worker] { return worker->pid > 1; });
      if (peer_pid != worker->pid || worker->channel_pid != -1 || worker->unavailable) {
        lock.unlock();
        xpc_connection_cancel(peer);
        return;
      }
      worker->channel_pid = peer_pid;
    }
    xpc_connection_set_target_queue(
        peer, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    xpc_connection_set_event_handler(peer, ^(xpc_object_t message) {
      HandleWorkerPoll(worker, peer, peer_pid, message);
    });
    xpc_connection_resume(peer);
  });
  xpc_connection_resume(listener);
  return listener;
}

std::string GatewayEnvelope(NSString *kind, NSString *peer_role,
                            NSString *connection_id, pid_t peer_pid, id payload) {
  NSDictionary *envelope = @{
    @"kind" : kind,
    @"peerRole" : peer_role,
    @"connectionId" : connection_id,
    @"peerPid" : @(peer_pid),
    @"payload" : payload ?: [NSNull null],
  };
  return SerializeObject(envelope);
}

void SendError(xpc_object_t event, const char *message) {
  xpc_object_t reply = xpc_dictionary_create_reply(event);
  if (reply == nullptr) return;
  xpc_dictionary_set_string(reply, "error", message);
  xpc_connection_t remote = xpc_dictionary_get_remote_connection(event);
  xpc_connection_send_message(remote, reply);
}

void HandleRequest(Worker *worker, xpc_connection_t peer, NSString *peer_role,
                   NSString *connection_id, xpc_object_t event) {
  if (xpc_get_type(event) != XPC_TYPE_DICTIONARY) return;
  const char *request = xpc_dictionary_get_string(event, "request");
  if (request == nullptr) {
    SendError(event, "Broker request is missing");
    return;
  }
  const size_t length = strlen(request);
  if (length == 0 || length > kMaximumMessageBytes) {
    SendError(event, "Broker request is malformed or oversized");
    return;
  }
  NSData *request_data = [NSData dataWithBytes:request length:length];
  id payload = [NSJSONSerialization JSONObjectWithData:request_data options:0 error:nil];
  if (![payload isKindOfClass:[NSDictionary class]]) {
    SendError(event, "Broker request is not a JSON object");
    return;
  }

  const pid_t peer_pid = xpc_connection_get_pid(peer);
  std::string response;
  std::string error;
  if (!Exchange(worker,
                GatewayEnvelope(@"client", peer_role, connection_id, peer_pid,
                                payload),
                &response, &error)) {
    SendError(event, error.c_str());
    return;
  }

  NSDictionary *parsed = ParseObject(response);
  NSDictionary *challenge = [parsed[@"ownerPresenceChallenge"]
      isKindOfClass:[NSDictionary class]]
      ? parsed[@"ownerPresenceChallenge"]
      : nil;
  if (challenge != nil) {
    NSString *challenge_id = [challenge[@"challengeId"] isKindOfClass:[NSString class]]
                                 ? challenge[@"challengeId"]
                                 : nil;
    NSString *reason = [challenge[@"reason"] isKindOfClass:[NSString class]]
                           ? challenge[@"reason"]
                           : nil;
    NSString *expires_at = [challenge[@"expiresAt"] isKindOfClass:[NSString class]]
        ? challenge[@"expiresAt"] : nil;
    NSDate *challenge_deadline = OwnerChallengeDeadline(expires_at);
    if (challenge_id == nil || reason == nil || reason.length == 0 ||
        reason.length > 512 || challenge_deadline == nil) {
      SendError(event, "Broker owner-presence challenge is invalid");
      return;
    }
    const OwnerAuthenticationResult authentication = AuthenticateOwner(
        reason, connection_id, challenge_id, challenge_deadline);
    NSDictionary *presence = @{
      @"challengeId" : challenge_id,
      @"approved" : @(authentication.approved),
      @"outcome" : [NSString stringWithUTF8String:authentication.outcome],
    };
    if (!Exchange(worker,
                  GatewayEnvelope(@"owner-presence", peer_role, connection_id,
                                  peer_pid, presence),
                  &response, &error)) {
      SendError(event, error.c_str());
      return;
    }
  }

  NSDictionary *final_response = ParseObject(response);
  NSDictionary *result = [final_response[@"result"] isKindOfClass:[NSDictionary class]]
      ? final_response[@"result"] : nil;
  NSDictionary *response_error = [final_response[@"error"] isKindOfClass:[NSDictionary class]]
      ? final_response[@"error"] : nil;
  BOOL committed_lock = [peer_role isEqualToString:@"owner-control"] &&
      [payload[@"method"] isEqualToString:@"lifecycle.lock"] &&
      [final_response[@"ok"] isEqual:@YES] &&
      [result[@"state"] isEqualToString:@"locked"];
  BOOL uncertain_lock = [peer_role isEqualToString:@"owner-control"] &&
      [payload[@"method"] isEqualToString:@"lifecycle.lock"] &&
      [final_response[@"ok"] isEqual:@NO] &&
      [response_error[@"code"] isEqualToString:@"lifecycle_transition_failed"];
  BOOL invalidate_owner_peers = committed_lock || uncertain_lock;
  if (invalidate_owner_peers) InvalidateOtherOwnerPeers(connection_id);

  xpc_object_t reply = xpc_dictionary_create_reply(event);
  if (reply == nullptr) {
    if (invalidate_owner_peers) {
      CloseOwnerPeer(connection_id);
      xpc_connection_cancel(peer);
    }
    return;
  }
  xpc_dictionary_set_string(reply, "response", response.c_str());
  xpc_connection_send_message(peer, reply);
  if (invalidate_owner_peers) {
    CloseOwnerPeer(connection_id);
    xpc_connection_send_barrier(peer, ^{ xpc_connection_cancel(peer); });
  }
}

xpc_connection_t CreateListener(Worker *worker, const char *service,
                                const char *requirement,
                                NSString *peer_role) {
  if (service == nullptr || service[0] == '\0' || strlen(service) > 255) {
    fprintf(stderr, "Broker Mach service name is invalid\n");
    return nullptr;
  }
  xpc_connection_t listener = xpc_connection_create_mach_service(
      service, dispatch_get_main_queue(), XPC_CONNECTION_MACH_SERVICE_LISTENER);
  if (listener == nullptr) {
    fprintf(stderr, "Could not claim the broker Mach service\n");
    return nullptr;
  }
  if (requirement != nullptr && requirement[0] != '\0' &&
      xpc_connection_set_peer_code_signing_requirement(listener, requirement) != 0) {
    fprintf(stderr, "Broker client code-signing requirement is invalid\n");
    return nullptr;
  }
  Worker *worker_pointer = worker;
  xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
    if (xpc_get_type(event) != XPC_TYPE_CONNECTION) return;
    xpc_connection_t peer = static_cast<xpc_connection_t>(event);
    NSString *authenticated_role = peer_role;
    NSString *connection_id = ConnectionIdentifier();
    const pid_t peer_pid = xpc_connection_get_pid(peer);
    xpc_connection_set_target_queue(
        peer, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    if ([authenticated_role isEqualToString:@"owner-control"]) {
      RegisterOwnerPeer(connection_id, peer);
    }
    xpc_connection_set_event_handler(peer, ^(xpc_object_t event) {
      @autoreleasepool {
        if (xpc_get_type(event) == XPC_TYPE_ERROR) {
          if ([authenticated_role isEqualToString:@"owner-control"]) {
            CloseOwnerPeer(connection_id);
          }
          std::string ignored_response;
          std::string ignored_error;
          Exchange(worker_pointer,
                   GatewayEnvelope(@"connection-closed", authenticated_role,
                                   connection_id, peer_pid, [NSNull null]),
                   &ignored_response, &ignored_error);
          return;
        }
        HandleRequest(worker_pointer, peer, authenticated_role, connection_id, event);
      }
    });
    xpc_connection_resume(peer);
  });
  xpc_connection_resume(listener);
  return listener;
}

#if defined(AFTERNOTE_GATEWAY_TESTING)
int RunOwnerPromptLifetimeSmoke() {
  NSString *short_peer = @"prompt-short-peer";
  NSString *short_challenge = @"prompt-short-challenge";
  AfternoteTestAuthenticationContext *short_context =
      [[AfternoteTestAuthenticationContext alloc] init];
  dispatch_semaphore_t never_completed = dispatch_semaphore_create(0);
  NSDate *short_deadline = [NSDate dateWithTimeIntervalSinceNow:0.02];
  NSTimeInterval bounded_wait = OwnerAuthenticationWait(short_deadline);
  bool registered = RegisterOwnerContext(short_peer, short_challenge, short_context);
  const auto started = std::chrono::steady_clock::now();
  bool completed = WaitForOwnerAuthentication(
      short_context, never_completed, short_peer, short_challenge, short_deadline);
  const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - started).count();

  NSString *closed_peer = @"prompt-closed-peer";
  AfternoteTestAuthenticationContext *closed_one =
      [[AfternoteTestAuthenticationContext alloc] init];
  AfternoteTestAuthenticationContext *closed_two =
      [[AfternoteTestAuthenticationContext alloc] init];
  AfternoteTestAuthenticationContext *other_peer =
      [[AfternoteTestAuthenticationContext alloc] init];
  bool registered_closed = RegisterOwnerContext(closed_peer, @"one", closed_one) &&
      RegisterOwnerContext(closed_peer, @"two", closed_two);
  bool registered_other = RegisterOwnerContext(@"prompt-other-peer", @"one", other_peer);
  CloseOwnerPeer(closed_peer);
  bool disconnect_invalidated = closed_one.invalidated && closed_two.invalidated;
  bool other_peer_preserved = !other_peer.invalidated;
  AfternoteTestAuthenticationContext *late_context =
      [[AfternoteTestAuthenticationContext alloc] init];
  bool late_registered = RegisterOwnerContext(closed_peer, @"late", late_context);
  CloseOwnerPeer(@"prompt-other-peer");

  NSDictionary *output = @{
    @"shortDeadlineBounded" : @(registered && !completed && short_context.invalidated &&
        bounded_wait > 0 && bounded_wait <= 0.05 && elapsed_ms < 500),
    @"disconnectInvalidated" : @(registered_closed && disconnect_invalidated),
    @"otherPeerPreserved" : @(registered_other && other_peer_preserved),
    @"closedPeerRejected" : @(!late_registered && late_context.invalidated),
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return [output.allValues containsObject:@NO] ? 2 : 0;
}
#endif

#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
int RunDevelopmentOwnerPresenceBypassSmoke() {
  const OwnerAuthenticationResult result = AuthenticateOwner(
      @"Development bypass smoke test", @"bypass-smoke-peer",
      @"bypass-smoke-challenge", [NSDate dateWithTimeIntervalSinceNow:5]);
  NSDictionary *output = @{
    @"ownerPresenceMode" : @"development-bypass",
    @"approved" : @(result.approved),
    @"outcome" : [NSString stringWithUTF8String:result.outcome],
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:output options:0 error:nil];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  return result.approved && strcmp(result.outcome, "approved") == 0 ? 0 : 2;
}
#endif

}  // namespace

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
#if defined(AFTERNOTE_GATEWAY_TESTING)
    if (argc == 2 && strcmp(argv[1], "--owner-prompt-lifetime-smoke") == 0) {
      return RunOwnerPromptLifetimeSmoke();
    }
#endif
#if defined(AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS)
    if (argc == 2 && strcmp(argv[1], "--development-owner-presence-bypass-smoke") == 0) {
      return RunDevelopmentOwnerPresenceBypassSmoke();
    }
#endif
    Worker worker;
    std::string error;
    const char *worker_service = getenv("AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE");
    g_worker_listener = CreateWorkerListener(
        &worker, worker_service, WorkerCodeRequirement());
    if (g_worker_listener == nullptr) return 1;
    if (!SpawnWorker(&worker, &error)) {
      fprintf(stderr, "%s\n", error.c_str());
      return 1;
    }
    MonitorWorker(worker.pid);
    RegisterSessionRevocationObservers(worker.pid);
    const char *service = getenv("AFTERNOTE_BROKER_MACH_SERVICE");
    const char *owner_service = getenv("AFTERNOTE_OWNER_CONTROL_MACH_SERVICE");
    if (service == nullptr || owner_service == nullptr || worker_service == nullptr ||
        strcmp(service, owner_service) == 0 ||
        strcmp(service, worker_service) == 0 ||
        strcmp(owner_service, worker_service) == 0) {
      fprintf(stderr, "Broker Mach services must be distinct\n");
      return 1;
    }
#if defined(AFTERNOTE_GATEWAY_TESTING)
    const char *client_requirement =
        getenv("AFTERNOTE_TEST_CLIENT_CODE_REQUIREMENT");
    const char *owner_requirement =
        getenv("AFTERNOTE_TEST_OWNER_CONTROL_CODE_REQUIREMENT");
#else
    const char *client_requirement = AFTERNOTE_CLIENT_CODE_REQUIREMENT;
    const char *owner_requirement = AFTERNOTE_OWNER_CONTROL_CODE_REQUIREMENT;
#endif
    g_memory_listener = CreateListener(
        &worker, service, client_requirement, @"memory-client");
    g_owner_listener = CreateListener(
        &worker, owner_service, owner_requirement, @"owner-control");
    if (g_memory_listener == nullptr || g_owner_listener == nullptr) return 1;
    dispatch_main();
  }
  return 0;
}
