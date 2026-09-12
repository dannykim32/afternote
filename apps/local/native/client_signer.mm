#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#ifndef AFTERNOTE_ALLOWED_PARENT_CODE_REQUIREMENT
#error "Client signer requires a fixed parent code-signing requirement"
#endif

#ifndef AFTERNOTE_CLIENT_KEYCHAIN_ACCESS_GROUP
#error "Client signer requires a fixed Keychain access group"
#endif

namespace {

constexpr size_t kMaximumMessageBytes = 1024 * 1024;

bool HasAllowedTagPrefix(const std::string &tag) {
  static const char *prefixes[] = {
      "dev.afternote.mcp-client.codex.",
      "dev.afternote.mcp-client.claude.",
      "dev.afternote.mcp-client.claude-desktop.",
  };
  bool prefix_matches = false;
  size_t suffix_offset = 0;
  for (const char *prefix : prefixes) {
    const size_t length = std::strlen(prefix);
    if (tag.compare(0, length, prefix) == 0) {
      prefix_matches = true;
      suffix_offset = length;
      break;
    }
  }
  if (!prefix_matches || suffix_offset == tag.size() || tag.size() > 255) {
    return false;
  }
  for (size_t index = suffix_offset; index < tag.size(); ++index) {
    const char character = tag[index];
    if (!((character >= 'A' && character <= 'Z') ||
          (character >= 'a' && character <= 'z') ||
          (character >= '0' && character <= '9') || character == '.' ||
          character == '_' || character == ':' || character == '-')) {
      return false;
    }
  }
  return true;
}

bool ValidateParent() {
  const pid_t parent_pid = getppid();
  if (parent_pid <= 1) return false;
  int64_t pid_value = static_cast<int64_t>(parent_pid);
  CFNumberRef pid = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt64Type,
                                   &pid_value);
  if (pid == nullptr) return false;
  const void *keys[] = {kSecGuestAttributePid};
  const void *values[] = {pid};
  CFDictionaryRef attributes = CFDictionaryCreate(
      kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFRelease(pid);
  if (attributes == nullptr) return false;
  SecCodeRef parent = nullptr;
  OSStatus status = SecCodeCopyGuestWithAttributes(
      nullptr, attributes, kSecCSDefaultFlags, &parent);
  CFRelease(attributes);
  if (status != errSecSuccess || parent == nullptr) return false;

  static const char requirement_bytes[] = AFTERNOTE_ALLOWED_PARENT_CODE_REQUIREMENT;
  CFStringRef requirement_text = CFStringCreateWithBytes(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8 *>(requirement_bytes),
      static_cast<CFIndex>(sizeof(requirement_bytes) - 1),
      kCFStringEncodingUTF8, false);
  SecRequirementRef requirement = nullptr;
  status = requirement_text == nullptr
               ? errSecParam
               : SecRequirementCreateWithString(requirement_text,
                                                kSecCSDefaultFlags,
                                                &requirement);
  if (requirement_text != nullptr) CFRelease(requirement_text);
  if (status == errSecSuccess && requirement != nullptr) {
    status = SecCodeCheckValidity(parent, kSecCSStrictValidate, requirement);
  }
  if (requirement != nullptr) CFRelease(requirement);
  CFRelease(parent);
  return status == errSecSuccess;
}

CFStringRef AccessGroup() {
  static const char access_group_bytes[] = AFTERNOTE_CLIENT_KEYCHAIN_ACCESS_GROUP;
  return CFStringCreateWithBytes(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8 *>(access_group_bytes),
      static_cast<CFIndex>(sizeof(access_group_bytes) - 1),
      kCFStringEncodingUTF8, false);
}

CFDataRef SigningKeyTag(const std::string &tag) {
  return CFDataCreate(kCFAllocatorDefault,
                      reinterpret_cast<const UInt8 *>(tag.data()),
                      static_cast<CFIndex>(tag.size()));
}

SecKeyRef CopySigningKey(const std::string &tag, OSStatus *status) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFDataRef tag_data = SigningKeyTag(tag);
  CFStringRef access_group = AccessGroup();
  if (query == nullptr || tag_data == nullptr || access_group == nullptr) {
    if (query != nullptr) CFRelease(query);
    if (tag_data != nullptr) CFRelease(tag_data);
    if (access_group != nullptr) CFRelease(access_group);
    *status = errSecAllocate;
    return nullptr;
  }
  CFDictionarySetValue(query, kSecClass, kSecClassKey);
  CFDictionarySetValue(query, kSecAttrApplicationTag, tag_data);
  CFDictionarySetValue(query, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom);
  CFDictionarySetValue(query, kSecAttrAccessGroup, access_group);
  CFDictionarySetValue(query, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef result = nullptr;
  *status = SecItemCopyMatching(query, &result);
  CFRelease(access_group);
  CFRelease(tag_data);
  CFRelease(query);
  return *status == errSecSuccess
             ? const_cast<SecKeyRef>(static_cast<const __SecKey *>(result))
             : nullptr;
}

SecKeyRef CreateSigningKey(const std::string &tag, CFErrorRef *error) {
  CFMutableDictionaryRef private_attributes = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFDataRef tag_data = SigningKeyTag(tag);
  CFStringRef access_group = AccessGroup();
  if (private_attributes == nullptr || tag_data == nullptr ||
      access_group == nullptr) {
    if (private_attributes != nullptr) CFRelease(private_attributes);
    if (tag_data != nullptr) CFRelease(tag_data);
    if (access_group != nullptr) CFRelease(access_group);
    return nullptr;
  }
  CFErrorRef access_error = nullptr;
  SecAccessControlRef access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecAccessControlPrivateKeyUsage, &access_error);
  if (access == nullptr) {
    CFRelease(access_group);
    CFRelease(tag_data);
    CFRelease(private_attributes);
    if (error != nullptr) *error = access_error;
    else if (access_error != nullptr) CFRelease(access_error);
    return nullptr;
  }
  CFDictionarySetValue(private_attributes, kSecAttrIsPermanent, kCFBooleanTrue);
  CFDictionarySetValue(private_attributes, kSecAttrApplicationTag, tag_data);
  CFDictionarySetValue(private_attributes, kSecAttrAccessGroup, access_group);
  CFDictionarySetValue(private_attributes, kSecAttrAccessControl, access);
  CFDictionarySetValue(private_attributes, kSecUseDataProtectionKeychain,
                       kCFBooleanTrue);

  int key_size = 256;
  CFNumberRef key_size_value = CFNumberCreate(
      kCFAllocatorDefault, kCFNumberIntType, &key_size);
  CFMutableDictionaryRef attributes = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  SecKeyRef key = nullptr;
  if (key_size_value != nullptr && attributes != nullptr) {
    CFDictionarySetValue(attributes, kSecAttrKeyType,
                         kSecAttrKeyTypeECSECPrimeRandom);
    CFDictionarySetValue(attributes, kSecAttrKeySizeInBits, key_size_value);
    CFDictionarySetValue(attributes, kSecAttrTokenID,
                         kSecAttrTokenIDSecureEnclave);
    CFDictionarySetValue(attributes, kSecPrivateKeyAttrs, private_attributes);
    key = SecKeyCreateRandomKey(attributes, error);
  }

  if (attributes != nullptr) CFRelease(attributes);
  if (key_size_value != nullptr) CFRelease(key_size_value);
  CFRelease(access);
  CFRelease(access_group);
  CFRelease(tag_data);
  CFRelease(private_attributes);
  return key;
}

bool WriteJson(NSDictionary *value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0
                                                   error:&error];
  if (data == nil || error != nil) return false;
  return std::fwrite(data.bytes, 1, data.length, stdout) == data.length &&
         std::fwrite("\n", 1, 1, stdout) == 1;
}

std::vector<uint8_t> ReadBoundedStdin(bool *valid) {
  std::vector<uint8_t> bytes;
  bytes.reserve(4096);
  uint8_t buffer[4096];
  while (true) {
    const ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      *valid = false;
      return {};
    }
    if (bytes.size() + static_cast<size_t>(count) > kMaximumMessageBytes) {
      *valid = false;
      return {};
    }
    bytes.insert(bytes.end(), buffer, buffer + count);
  }
  *valid = !bytes.empty();
  return bytes;
}

int PublicKey(const std::string &tag) {
  OSStatus status = errSecSuccess;
  SecKeyRef private_key = CopySigningKey(tag, &status);
  if (status == errSecItemNotFound) {
    CFErrorRef error = nullptr;
    private_key = CreateSigningKey(tag, &error);
    if (private_key == nullptr) {
      const CFIndex code = error == nullptr ? errSecInternalError
                                             : CFErrorGetCode(error);
      if (error != nullptr) CFRelease(error);
      std::fprintf(stderr, "Could not create the Secure Enclave client key (%ld)\n",
                   static_cast<long>(code));
      return 1;
    }
  } else if (status != errSecSuccess || private_key == nullptr) {
    std::fprintf(stderr, "Could not read the client signing key (%d)\n",
                 static_cast<int>(status));
    return 1;
  }
  SecKeyRef public_key = SecKeyCopyPublicKey(private_key);
  CFRelease(private_key);
  if (public_key == nullptr) {
    std::fprintf(stderr, "Could not derive the client public key\n");
    return 1;
  }
  CFErrorRef error = nullptr;
  CFDataRef representation = SecKeyCopyExternalRepresentation(public_key, &error);
  CFRelease(public_key);
  if (representation == nullptr) {
    const CFIndex code = error == nullptr ? errSecInternalError
                                           : CFErrorGetCode(error);
    if (error != nullptr) CFRelease(error);
    std::fprintf(stderr, "Could not export the client public key (%ld)\n",
                 static_cast<long>(code));
    return 1;
  }
  NSData *data = (__bridge NSData *)representation;
  NSString *encoded = [data base64EncodedStringWithOptions:0];
  const bool written = WriteJson(@{ @"publicKeyRaw" : encoded });
  CFRelease(representation);
  return written ? 0 : 1;
}

int SignMessage(const std::string &tag) {
  bool valid = false;
  const std::vector<uint8_t> message = ReadBoundedStdin(&valid);
  if (!valid) {
    std::fprintf(stderr, "Client signing message is invalid\n");
    return 1;
  }
  OSStatus status = errSecSuccess;
  SecKeyRef private_key = CopySigningKey(tag, &status);
  if (status != errSecSuccess || private_key == nullptr) {
    std::fprintf(stderr, "Client signing key is unavailable (%d)\n",
                 static_cast<int>(status));
    return 1;
  }
  CFDataRef data = CFDataCreate(kCFAllocatorDefault, message.data(),
                                static_cast<CFIndex>(message.size()));
  CFErrorRef error = nullptr;
  CFDataRef signature = data == nullptr
                            ? nullptr
                            : SecKeyCreateSignature(
                                  private_key,
                                  kSecKeyAlgorithmECDSASignatureMessageX962SHA256,
                                  data, &error);
  if (data != nullptr) CFRelease(data);
  CFRelease(private_key);
  if (signature == nullptr) {
    const CFIndex code = error == nullptr ? errSecInternalError
                                           : CFErrorGetCode(error);
    if (error != nullptr) CFRelease(error);
    std::fprintf(stderr, "Could not sign with the client key (%ld)\n",
                 static_cast<long>(code));
    return 1;
  }
  NSData *signature_data = (__bridge NSData *)signature;
  NSString *encoded = [signature_data base64EncodedStringWithOptions:0];
  const bool written = WriteJson(@{ @"signature" : encoded });
  CFRelease(signature);
  return written ? 0 : 1;
}

int DeleteKey(const std::string &tag) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFDataRef tag_data = SigningKeyTag(tag);
  CFStringRef access_group = AccessGroup();
  if (query == nullptr || tag_data == nullptr || access_group == nullptr) {
    if (query != nullptr) CFRelease(query);
    if (tag_data != nullptr) CFRelease(tag_data);
    if (access_group != nullptr) CFRelease(access_group);
    return 1;
  }
  CFDictionarySetValue(query, kSecClass, kSecClassKey);
  CFDictionarySetValue(query, kSecAttrApplicationTag, tag_data);
  CFDictionarySetValue(query, kSecAttrAccessGroup, access_group);
  CFDictionarySetValue(query, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  const OSStatus status = SecItemDelete(query);
  CFRelease(access_group);
  CFRelease(tag_data);
  CFRelease(query);
  if (status != errSecSuccess && status != errSecItemNotFound) {
    std::fprintf(stderr, "Could not delete the client signing key (%d)\n",
                 static_cast<int>(status));
    return 1;
  }
  return WriteJson(@{ @"deleted" : @YES }) ? 0 : 1;
}

}  // namespace

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (!ValidateParent()) {
      std::fprintf(stderr,
                   "Parent process does not satisfy the required code signature\n");
      return 1;
    }
    if (argc != 3) {
      std::fprintf(stderr, "Client signer request is invalid\n");
      return 1;
    }
    const std::string action(argv[1]);
    const std::string tag(argv[2]);
    if (!HasAllowedTagPrefix(tag)) {
      std::fprintf(stderr, "Client signing-key tag is invalid\n");
      return 1;
    }
    if (action == "public-key") return PublicKey(tag);
    if (action == "sign") return SignMessage(tag);
    if (action == "delete") return DeleteKey(tag);
    std::fprintf(stderr, "Client signer action is invalid\n");
    return 1;
  }
}
