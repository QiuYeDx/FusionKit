#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif

#include <node_api.h>

#if !defined(__APPLE__)
#error "local_subtitle_overwrite is supported only on macOS"
#endif

#if !defined(__arm64__) && !defined(__aarch64__)
#error "local_subtitle_overwrite is supported only on macOS arm64"
#endif

#include <cerrno>
#include <cstddef>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <fcntl.h>
#include <initializer_list>
#include <limits.h>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/stdio.h>
#include <unistd.h>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;
constexpr uint32_t kProtocolVersion = 3;
constexpr uint32_t kJournalVersion = 2;
constexpr size_t kMaximumJournalBytes = 4096;
constexpr const char *kInvalidRequestCode =
    "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_REQUEST";
constexpr const char *kFilesystemCode =
    "ERR_LOCAL_SUBTITLE_OVERWRITE_FILESYSTEM";
constexpr const char *kInvalidStateCode =
    "ERR_LOCAL_SUBTITLE_OVERWRITE_INVALID_STATE";
constexpr const char *kInternalCode = "ERR_LOCAL_SUBTITLE_OVERWRITE_INTERNAL";

class NativeError final : public std::runtime_error {
public:
  NativeError(std::string code, std::string message)
      : std::runtime_error(std::move(message)), code_(std::move(code)) {}

  const std::string &code() const { return code_; }

private:
  std::string code_;
};

[[noreturn]] void ThrowInvalidRequest(const std::string &message) {
  throw NativeError(kInvalidRequestCode, message);
}

[[noreturn]] void ThrowInvalidState(const std::string &message) {
  throw NativeError(kInvalidStateCode, message);
}

[[noreturn]] void ThrowErrno(const std::string &operation, int error) {
  throw NativeError(kFilesystemCode,
                    operation + " failed: " + std::strerror(error));
}

void CheckNapi(napi_env env, napi_status status, const char *operation) {
  if (status == napi_ok)
    return;

  const napi_extended_error_info *info = nullptr;
  napi_get_last_error_info(env, &info);
  std::string message(operation);
  message += " failed";
  if (info != nullptr && info->error_message != nullptr) {
    message += ": ";
    message += info->error_message;
  }
  throw NativeError(kInternalCode, std::move(message));
}

void ThrowToJavaScript(napi_env env, const NativeError &error) {
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) == napi_ok && pending)
    return;
  napi_throw_error(env, error.code().c_str(), error.what());
}

#if defined(FUSIONKIT_OVERWRITE_TEST_FAULTS)
constexpr int kTestCrashExitCode = 86;
void MaybeInjectTestFault(const char *point) {
  const char *configured =
      std::getenv("FUSIONKIT_OVERWRITE_TEST_FAULT_POINT");
  if (configured == nullptr || std::strcmp(configured, point) != 0)
    return;

  const char *action =
      std::getenv("FUSIONKIT_OVERWRITE_TEST_FAULT_ACTION");
  if (action != nullptr && std::strcmp(action, "exit") == 0) {
    ::_exit(kTestCrashExitCode);
  }
  if (action != nullptr && std::strcmp(action, "error") == 0) {
    throw NativeError(kFilesystemCode,
                      std::string("injected overwrite fault at ") + point);
  }
  throw NativeError(kInternalCode,
                    "the overwrite test fault action is invalid");
}
#else
void MaybeInjectTestFault(const char *) {}
#endif

class UniqueFd final {
public:
  UniqueFd() = default;
  explicit UniqueFd(int value) : value_(value) {}
  UniqueFd(const UniqueFd &) = delete;
  UniqueFd &operator=(const UniqueFd &) = delete;

  UniqueFd(UniqueFd &&other) noexcept : value_(other.Release()) {}
  UniqueFd &operator=(UniqueFd &&other) noexcept {
    if (this != &other) {
      CloseIgnoringErrors();
      value_ = other.Release();
    }
    return *this;
  }

  ~UniqueFd() { CloseIgnoringErrors(); }

  int get() const { return value_; }
  bool valid() const { return value_ >= 0; }

  int Release() {
    const int result = value_;
    value_ = -1;
    return result;
  }

  void CloseIgnoringErrors() noexcept {
    if (value_ < 0)
      return;
    const int value = value_;
    value_ = -1;
    // A close error is never allowed to turn a completed filesystem terminal
    // operation back into a retryable transaction.
    (void)::close(value);
  }

private:
  int value_ = -1;
};

struct Identity {
  uint64_t dev = 0;
  uint64_t ino = 0;
  double birthtime_ms = 0;
};

struct Request {
  std::string directory_path;
  Identity expected_directory_identity;
  std::string transaction_id;
  std::string partial_leaf;
  std::string final_leaf;
  Identity expected_partial_identity;
  int64_t expected_byte_size = 0;
};

struct RecoveryRequest {
  std::string directory_path;
  Identity expected_directory_identity;
  std::string transaction_id;
};

double BirthtimeMs(const struct stat &value) {
  return static_cast<double>(value.st_birthtimespec.tv_sec) * 1000.0 +
         static_cast<double>(value.st_birthtimespec.tv_nsec) / 1000000.0;
}

Identity IdentityFromStat(const struct stat &value) {
  return Identity{static_cast<uint64_t>(value.st_dev),
                  static_cast<uint64_t>(value.st_ino), BirthtimeMs(value)};
}

bool SameIdentity(const Identity &left, const Identity &right) {
  return left.dev == right.dev && left.ino == right.ino &&
         left.birthtime_ms == right.birthtime_ms;
}

bool SameIdentity(const struct stat &actual, const Identity &expected) {
  return SameIdentity(IdentityFromStat(actual), expected);
}

struct LeafStat {
  bool exists = false;
  struct stat value{};
};

LeafStat StatLeaf(int directory_fd, const std::string &leaf) {
  LeafStat result;
  if (::fstatat(directory_fd, leaf.c_str(), &result.value,
                AT_SYMLINK_NOFOLLOW) == 0) {
    result.exists = true;
    return result;
  }
  const int error = errno;
  if (error == ENOENT)
    return result;
  ThrowErrno("fstatat(" + leaf + ")", error);
}

void RequireRegularIdentity(const LeafStat &actual, const Identity &expected,
                            const std::string &label,
                            const int64_t *expected_size = nullptr) {
  if (!actual.exists) {
    throw NativeError(kFilesystemCode, label + " is missing");
  }
  if (!S_ISREG(actual.value.st_mode)) {
    throw NativeError(kFilesystemCode,
                      label + " is not a no-follow regular file");
  }
  if (!SameIdentity(actual.value, expected)) {
    throw NativeError(kFilesystemCode, label + " identity changed");
  }
  if (expected_size != nullptr &&
      actual.value.st_size != static_cast<off_t>(*expected_size)) {
    throw NativeError(kFilesystemCode, label + " byte size changed");
  }
}

void RequireSingleLink(const struct stat &actual, const std::string &label) {
  if (actual.st_nlink != 1) {
    throw NativeError(kFilesystemCode,
                      label + " must have exactly one directory link");
  }
}

void RequireAbsent(const LeafStat &actual, const std::string &label) {
  if (actual.exists) {
    throw NativeError(kFilesystemCode, label + " is no longer absent");
  }
}

std::string ReadString(napi_env env, napi_value value,
                       const std::string &label) {
  napi_valuetype type = napi_undefined;
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof");
  if (type != napi_string) {
    ThrowInvalidRequest(label + " must be a string");
  }

  size_t byte_length = 0;
  CheckNapi(env,
            napi_get_value_string_utf8(env, value, nullptr, 0, &byte_length),
            "napi_get_value_string_utf8");
  std::vector<char> buffer(byte_length + 1);
  size_t written = 0;
  CheckNapi(env,
            napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(),
                                       &written),
            "napi_get_value_string_utf8");
  return std::string(buffer.data(), written);
}

napi_value GetNamed(napi_env env, napi_value object, const char *name) {
  napi_value result = nullptr;
  CheckNapi(env, napi_get_named_property(env, object, name, &result),
            "napi_get_named_property");
  return result;
}

void RequireObject(napi_env env, napi_value value, const std::string &label) {
  napi_valuetype type = napi_undefined;
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof");
  napi_value null_value = nullptr;
  CheckNapi(env, napi_get_null(env, &null_value), "napi_get_null");
  bool is_null = false;
  CheckNapi(env, napi_strict_equals(env, value, null_value, &is_null),
            "napi_strict_equals");
  bool is_array = false;
  CheckNapi(env, napi_is_array(env, value, &is_array), "napi_is_array");
  if (type != napi_object || is_null || is_array) {
    ThrowInvalidRequest(label + " must be an object");
  }
}

void RequireExactOwnKeys(napi_env env, napi_value object,
                         std::initializer_list<const char *> expected,
                         const std::string &label) {
  RequireObject(env, object, label);

  napi_value keys = nullptr;
  CheckNapi(env,
            napi_get_all_property_names(env, object, napi_key_own_only,
                                        napi_key_all_properties,
                                        napi_key_numbers_to_strings, &keys),
            "napi_get_all_property_names");

  uint32_t length = 0;
  CheckNapi(env, napi_get_array_length(env, keys, &length),
            "napi_get_array_length");
  if (length != expected.size()) {
    ThrowInvalidRequest(label + " has unexpected own properties");
  }

  std::unordered_set<std::string> remaining;
  for (const char *key : expected)
    remaining.emplace(key);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value key = nullptr;
    CheckNapi(env, napi_get_element(env, keys, index, &key),
              "napi_get_element");
    napi_valuetype type = napi_undefined;
    CheckNapi(env, napi_typeof(env, key, &type), "napi_typeof");
    if (type != napi_string) {
      ThrowInvalidRequest(label + " has a non-string own property");
    }
    const std::string name = ReadString(env, key, label + " property name");
    if (remaining.erase(name) != 1) {
      ThrowInvalidRequest(label + " has unexpected own properties");
    }
  }
  if (!remaining.empty()) {
    ThrowInvalidRequest(label + " is missing required own properties");
  }
}

double ReadNumber(napi_env env, napi_value value, const std::string &label) {
  napi_valuetype type = napi_undefined;
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof");
  if (type != napi_number) {
    ThrowInvalidRequest(label + " must be a number");
  }
  double result = 0;
  CheckNapi(env, napi_get_value_double(env, value, &result),
            "napi_get_value_double");
  if (!std::isfinite(result)) {
    ThrowInvalidRequest(label + " must be finite");
  }
  return result;
}

uint64_t ReadSafeInteger(napi_env env, napi_value value,
                         const std::string &label, bool allow_zero = true) {
  const double number = ReadNumber(env, value, label);
  if (number < 0 || number > kMaxSafeInteger || std::floor(number) != number ||
      (!allow_zero && number == 0)) {
    ThrowInvalidRequest(label + " must be a non-negative safe integer");
  }
  return static_cast<uint64_t>(number);
}

Identity ReadIdentity(napi_env env, napi_value value,
                      const std::string &label) {
  RequireExactOwnKeys(env, value, {"dev", "ino", "birthtimeMs"}, label);
  Identity result;
  result.dev =
      ReadSafeInteger(env, GetNamed(env, value, "dev"), label + ".dev");
  result.ino =
      ReadSafeInteger(env, GetNamed(env, value, "ino"), label + ".ino");
  result.birthtime_ms = ReadNumber(env, GetNamed(env, value, "birthtimeMs"),
                                   label + ".birthtimeMs");
  if (result.birthtime_ms < 0) {
    ThrowInvalidRequest(label + ".birthtimeMs must be non-negative");
  }
  return result;
}

bool IsValidLeaf(const std::string &value) {
  if (value.empty() || value == "." || value == ".." ||
      value.size() > NAME_MAX) {
    return false;
  }
  for (const unsigned char byte : value) {
    if (byte == '/' || byte == '\\' || byte == 0 || byte < 0x20 ||
        byte == 0x7f) {
      return false;
    }
  }
  return true;
}

void ValidateLeaf(const std::string &value, const std::string &label) {
  if (!IsValidLeaf(value))
    ThrowInvalidRequest(label + " is not a valid leaf name");
}

bool IsValidTransactionId(const std::string &value) {
  if (value.empty() || value.size() > 80)
    return false;
  for (const unsigned char byte : value) {
    const bool ascii_letter = (byte >= 'A' && byte <= 'Z') ||
                              (byte >= 'a' && byte <= 'z');
    const bool ascii_digit = byte >= '0' && byte <= '9';
    if (!ascii_letter && !ascii_digit && byte != '-')
      return false;
  }
  return true;
}

void ValidateTransactionId(const std::string &value) {
  if (!IsValidTransactionId(value))
    ThrowInvalidRequest("transactionId is not a valid opaque identifier");
}

std::string PartialLeafForTransactionId(const std::string &transaction_id) {
  return ".fusionkit-local-subtitle-" + transaction_id + ".partial";
}

Request ReadRequest(napi_env env, napi_value value) {
  RequireExactOwnKeys(env, value,
                      {"directoryPath", "expectedDirectoryIdentity",
                       "transactionId", "partialLeaf", "finalLeaf",
                       "expectedPartialIdentity", "expectedByteSize"},
                      "overwrite transaction request");

  Request result;
  result.directory_path =
      ReadString(env, GetNamed(env, value, "directoryPath"), "directoryPath");
  if (result.directory_path.empty() || result.directory_path.front() != '/' ||
      result.directory_path.find('\0') != std::string::npos) {
    ThrowInvalidRequest("directoryPath must be an absolute path");
  }
  result.expected_directory_identity =
      ReadIdentity(env, GetNamed(env, value, "expectedDirectoryIdentity"),
                   "expectedDirectoryIdentity");
  result.transaction_id =
      ReadString(env, GetNamed(env, value, "transactionId"), "transactionId");
  ValidateTransactionId(result.transaction_id);
  result.partial_leaf =
      ReadString(env, GetNamed(env, value, "partialLeaf"), "partialLeaf");
  result.final_leaf =
      ReadString(env, GetNamed(env, value, "finalLeaf"), "finalLeaf");
  ValidateLeaf(result.partial_leaf, "partialLeaf");
  ValidateLeaf(result.final_leaf, "finalLeaf");
  if (result.partial_leaf == result.final_leaf) {
    ThrowInvalidRequest("partialLeaf and finalLeaf must be different");
  }
  if (result.partial_leaf != PartialLeafForTransactionId(result.transaction_id)) {
    ThrowInvalidRequest("partialLeaf does not match transactionId");
  }
  result.expected_partial_identity =
      ReadIdentity(env, GetNamed(env, value, "expectedPartialIdentity"),
                   "expectedPartialIdentity");
  const uint64_t byte_size = ReadSafeInteger(
      env, GetNamed(env, value, "expectedByteSize"), "expectedByteSize", false);
  if (byte_size > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    ThrowInvalidRequest("expectedByteSize is too large");
  }
  result.expected_byte_size = static_cast<int64_t>(byte_size);
  return result;
}

RecoveryRequest ReadRecoveryRequest(napi_env env, napi_value value) {
  RequireExactOwnKeys(env, value,
                      {"directoryPath", "expectedDirectoryIdentity",
                       "transactionId"},
                      "overwrite recovery request");

  RecoveryRequest result;
  result.directory_path =
      ReadString(env, GetNamed(env, value, "directoryPath"), "directoryPath");
  if (result.directory_path.empty() || result.directory_path.front() != '/' ||
      result.directory_path.find('\0') != std::string::npos) {
    ThrowInvalidRequest("directoryPath must be an absolute path");
  }
  result.expected_directory_identity =
      ReadIdentity(env, GetNamed(env, value, "expectedDirectoryIdentity"),
                   "expectedDirectoryIdentity");
  result.transaction_id =
      ReadString(env, GetNamed(env, value, "transactionId"), "transactionId");
  ValidateTransactionId(result.transaction_id);
  return result;
}

UniqueFd OpenAndVerifyDirectory(const std::string &directory_path,
                                const Identity &expected_identity) {
  const int fd = ::open(directory_path.c_str(),
                        O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    ThrowErrno("open(directoryPath)", errno);
  UniqueFd result(fd);

  struct stat value{};
  if (::fstat(result.get(), &value) != 0) {
    ThrowErrno("fstat(directoryPath)", errno);
  }
  if (!S_ISDIR(value.st_mode)) {
    throw NativeError(kFilesystemCode,
                      "directoryPath is not a directory object");
  }
  if (!SameIdentity(value, expected_identity)) {
    throw NativeError(kFilesystemCode,
                      "directoryPath identity changed before transaction access");
  }
  return result;
}

UniqueFd OpenAndVerifyDirectory(const Request &request) {
  return OpenAndVerifyDirectory(request.directory_path,
                                request.expected_directory_identity);
}

UniqueFd OpenAndVerifyDirectory(const RecoveryRequest &request) {
  return OpenAndVerifyDirectory(request.directory_path,
                                request.expected_directory_identity);
}

UniqueFd OpenAndVerifyPartial(int directory_fd, const Request &request) {
  const int fd = ::openat(directory_fd, request.partial_leaf.c_str(),
                          O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    ThrowErrno("openat(partialLeaf)", errno);
  UniqueFd result(fd);

  struct stat value{};
  if (::fstat(result.get(), &value) != 0) {
    ThrowErrno("fstat(partialLeaf)", errno);
  }
  const LeafStat partial{true, value};
  RequireRegularIdentity(partial, request.expected_partial_identity,
                         "partial leaf", &request.expected_byte_size);
  RequireSingleLink(partial.value, "partial leaf");

  // Prove the leaf still names the opened object before the first atomic
  // rename. The descriptor remains pinned until the receipt reaches a terminal
  // state, preventing inode reuse from satisfying later identity checks.
  const LeafStat named = StatLeaf(directory_fd, request.partial_leaf);
  RequireRegularIdentity(named, request.expected_partial_identity,
                         "partial leaf", &request.expected_byte_size);
  RequireSingleLink(named.value, "partial leaf");
  return result;
}

struct JournalNames {
  std::string open;
  std::string rollback;
};

struct JournalRecord {
  Request request;
  bool victim_existed = false;
  Identity victim_identity;
};

struct OpenedJournal {
  UniqueFd fd;
  Identity identity;
  JournalRecord record;
};

constexpr unsigned char kJournalMagic[] = {'F', 'K', 'O', 'W', 'T', 'X', 'N',
                                            '1'};

uint32_t JournalChecksum(const unsigned char *bytes, size_t length) {
  uint32_t value = 0xffffffffU;
  for (size_t index = 0; index < length; ++index) {
    value ^= bytes[index];
    for (int bit = 0; bit < 8; ++bit) {
      value = (value >> 1U) ^
              (0xedb88320U & static_cast<uint32_t>(
                                   -static_cast<int32_t>(value & 1U)));
    }
  }
  return ~value;
}

void AppendU16(std::vector<unsigned char> &bytes, uint16_t value) {
  bytes.push_back(static_cast<unsigned char>(value & 0xffU));
  bytes.push_back(static_cast<unsigned char>((value >> 8U) & 0xffU));
}

void AppendU32(std::vector<unsigned char> &bytes, uint32_t value) {
  for (unsigned int shift = 0; shift < 32; shift += 8) {
    bytes.push_back(static_cast<unsigned char>((value >> shift) & 0xffU));
  }
}

void AppendU64(std::vector<unsigned char> &bytes, uint64_t value) {
  for (unsigned int shift = 0; shift < 64; shift += 8) {
    bytes.push_back(static_cast<unsigned char>((value >> shift) & 0xffU));
  }
}

void AppendDouble(std::vector<unsigned char> &bytes, double value) {
  uint64_t bits = 0;
  static_assert(sizeof(bits) == sizeof(value));
  std::memcpy(&bits, &value, sizeof(bits));
  AppendU64(bytes, bits);
}

void AppendIdentity(std::vector<unsigned char> &bytes,
                    const Identity &identity) {
  AppendU64(bytes, identity.dev);
  AppendU64(bytes, identity.ino);
  AppendDouble(bytes, identity.birthtime_ms);
}

void AppendString(std::vector<unsigned char> &bytes, const std::string &value) {
  if (value.size() > std::numeric_limits<uint16_t>::max()) {
    ThrowInvalidRequest("the overwrite journal leaf is too long");
  }
  AppendU16(bytes, static_cast<uint16_t>(value.size()));
  bytes.insert(bytes.end(), value.begin(), value.end());
}

std::vector<unsigned char> SerializeJournal(const Request &request,
                                            bool victim_existed,
                                            const Identity &victim_identity) {
  std::vector<unsigned char> bytes;
  bytes.reserve(256);
  bytes.insert(bytes.end(), std::begin(kJournalMagic),
               std::end(kJournalMagic));
  AppendU32(bytes, kJournalVersion);
  bytes.push_back(victim_existed ? 1U : 0U);
  bytes.insert(bytes.end(), 7, 0U);
  AppendString(bytes, request.transaction_id);
  AppendIdentity(bytes, request.expected_directory_identity);
  AppendIdentity(bytes, request.expected_partial_identity);
  AppendU64(bytes, static_cast<uint64_t>(request.expected_byte_size));
  AppendIdentity(bytes, victim_identity);
  AppendString(bytes, request.partial_leaf);
  AppendString(bytes, request.final_leaf);
  AppendU32(bytes, JournalChecksum(bytes.data(), bytes.size()));
  return bytes;
}

class JournalCursor final {
public:
  JournalCursor(const std::vector<unsigned char> &bytes, size_t limit)
      : bytes_(bytes), limit_(limit) {}

  uint8_t ReadU8() {
    Require(1);
    return bytes_[offset_++];
  }

  uint16_t ReadU16() {
    uint16_t value = 0;
    for (unsigned int shift = 0; shift < 16; shift += 8)
      value |= static_cast<uint16_t>(ReadU8()) << shift;
    return value;
  }

  uint32_t ReadU32() {
    uint32_t value = 0;
    for (unsigned int shift = 0; shift < 32; shift += 8)
      value |= static_cast<uint32_t>(ReadU8()) << shift;
    return value;
  }

  uint64_t ReadU64() {
    uint64_t value = 0;
    for (unsigned int shift = 0; shift < 64; shift += 8)
      value |= static_cast<uint64_t>(ReadU8()) << shift;
    return value;
  }

  double ReadDouble() {
    const uint64_t bits = ReadU64();
    double value = 0;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
  }

  Identity ReadIdentity() {
    return Identity{ReadU64(), ReadU64(), ReadDouble()};
  }

  std::string ReadString() {
    const size_t length = ReadU16();
    Require(length);
    const char *start =
        reinterpret_cast<const char *>(bytes_.data() + offset_);
    offset_ += length;
    return std::string(start, length);
  }

  bool complete() const { return offset_ == limit_; }

private:
  void Require(size_t length) const {
    if (length > limit_ - offset_) {
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal is truncated");
    }
  }

  const std::vector<unsigned char> &bytes_;
  size_t limit_ = 0;
  size_t offset_ = 0;
};

uint32_t DecodeTrailingU32(const std::vector<unsigned char> &bytes) {
  const size_t offset = bytes.size() - sizeof(uint32_t);
  uint32_t value = 0;
  for (unsigned int index = 0; index < sizeof(uint32_t); ++index) {
    value |= static_cast<uint32_t>(bytes[offset + index]) << (index * 8U);
  }
  return value;
}

JournalRecord ParseJournal(const std::vector<unsigned char> &bytes,
                           const RecoveryRequest &recovery_request) {
  if (bytes.size() <= sizeof(kJournalMagic) + sizeof(uint32_t) * 2 ||
      bytes.size() > kMaximumJournalBytes) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal size is invalid");
  }
  const size_t content_length = bytes.size() - sizeof(uint32_t);
  if (DecodeTrailingU32(bytes) !=
      JournalChecksum(bytes.data(), content_length)) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal checksum is invalid");
  }

  JournalCursor cursor(bytes, content_length);
  for (const unsigned char expected : kJournalMagic) {
    if (cursor.ReadU8() != expected) {
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal magic is invalid");
    }
  }
  if (cursor.ReadU32() != kJournalVersion) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal version is invalid");
  }
  const uint8_t victim_flag = cursor.ReadU8();
  if (victim_flag > 1U) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal victim flag is invalid");
  }
  for (int index = 0; index < 7; ++index) {
    if (cursor.ReadU8() != 0U) {
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal is malformed");
    }
  }
  const std::string transaction_id = cursor.ReadString();
  const Identity directory_identity = cursor.ReadIdentity();
  const Identity partial_identity = cursor.ReadIdentity();
  const uint64_t expected_byte_size = cursor.ReadU64();
  const Identity victim_identity = cursor.ReadIdentity();
  const std::string partial_leaf = cursor.ReadString();
  const std::string final_leaf = cursor.ReadString();
  if (!cursor.complete() || !IsValidTransactionId(transaction_id) ||
      transaction_id != recovery_request.transaction_id ||
      !SameIdentity(directory_identity,
                    recovery_request.expected_directory_identity) ||
      partial_leaf != PartialLeafForTransactionId(transaction_id) ||
      !IsValidLeaf(partial_leaf) || !IsValidLeaf(final_leaf)) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal does not match the recovery request");
  }
  if (partial_leaf == final_leaf || expected_byte_size == 0 ||
      expected_byte_size >
          static_cast<uint64_t>(std::numeric_limits<int64_t>::max()) ||
      partial_identity.dev > static_cast<uint64_t>(kMaxSafeInteger) ||
      partial_identity.ino > static_cast<uint64_t>(kMaxSafeInteger) ||
      !std::isfinite(partial_identity.birthtime_ms) ||
      partial_identity.birthtime_ms < 0) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal request is invalid");
  }
  if (victim_identity.dev > static_cast<uint64_t>(kMaxSafeInteger) ||
      victim_identity.ino > static_cast<uint64_t>(kMaxSafeInteger) ||
      !std::isfinite(victim_identity.birthtime_ms) ||
      victim_identity.birthtime_ms < 0) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal victim is invalid");
  }
  Request request;
  request.directory_path = recovery_request.directory_path;
  request.expected_directory_identity = directory_identity;
  request.transaction_id = transaction_id;
  request.partial_leaf = partial_leaf;
  request.final_leaf = final_leaf;
  request.expected_partial_identity = partial_identity;
  request.expected_byte_size = static_cast<int64_t>(expected_byte_size);
  return JournalRecord{std::move(request), victim_flag == 1U, victim_identity};
}

JournalNames DeriveJournalNames(const std::string &transaction_id) {
  const std::string base =
      PartialLeafForTransactionId(transaction_id) + ".fusionkit-overwrite";
  JournalNames names{base + ".open", base + ".rollback"};
  if (names.open.size() > NAME_MAX || names.rollback.size() > NAME_MAX) {
    ThrowInvalidRequest(
        "partialLeaf is too long for the overwrite recovery journal");
  }
  return names;
}

JournalNames DeriveJournalNames(const Request &request) {
  return DeriveJournalNames(request.transaction_id);
}

void WriteAll(int fd, const std::vector<unsigned char> &bytes) {
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t written =
        ::write(fd, bytes.data() + offset, bytes.size() - offset);
    if (written < 0) {
      if (errno == EINTR)
        continue;
      ThrowErrno("write(overwrite journal)", errno);
    }
    if (written == 0) {
      throw NativeError(kFilesystemCode,
                        "write(overwrite journal) made no progress");
    }
    offset += static_cast<size_t>(written);
  }
}

void FullSyncFile(int fd, const std::string &label) {
  if (::fcntl(fd, F_FULLFSYNC) != 0)
    ThrowErrno("fcntl(F_FULLFSYNC " + label + ")", errno);
}

void SyncDirectory(int directory_fd) {
  if (::fsync(directory_fd) != 0)
    ThrowErrno("fsync(overwrite directory)", errno);
}

std::vector<unsigned char> ReadJournalBytes(int fd, off_t size) {
  if (size <= 0 || size > static_cast<off_t>(kMaximumJournalBytes)) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal size is invalid");
  }
  std::vector<unsigned char> bytes(static_cast<size_t>(size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    const ssize_t count =
        ::pread(fd, bytes.data() + offset, bytes.size() - offset,
                static_cast<off_t>(offset));
    if (count < 0) {
      if (errno == EINTR)
        continue;
      ThrowErrno("pread(overwrite journal)", errno);
    }
    if (count == 0) {
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal is truncated");
    }
    offset += static_cast<size_t>(count);
  }
  return bytes;
}

OpenedJournal OpenAndValidateJournal(int directory_fd, const std::string &leaf,
                                     const RecoveryRequest &request) {
  const int fd = ::openat(directory_fd, leaf.c_str(),
                          O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    ThrowErrno("openat(overwrite journal)", errno);
  UniqueFd journal_fd(fd);

  struct stat value {};
  if (::fstat(journal_fd.get(), &value) != 0)
    ThrowErrno("fstat(overwrite journal)", errno);
  if (!S_ISREG(value.st_mode) || value.st_nlink != 1) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal is not an owned regular file");
  }
  const LeafStat named = StatLeaf(directory_fd, leaf);
  RequireRegularIdentity(named, IdentityFromStat(value),
                         "named overwrite recovery journal");
  const JournalRecord record =
      ParseJournal(ReadJournalBytes(journal_fd.get(), value.st_size), request);
  return OpenedJournal{std::move(journal_fd), IdentityFromStat(value), record};
}

UniqueFd CreateOpenJournal(int directory_fd, const Request &request,
                           const JournalNames &names, bool victim_existed,
                           const Identity &victim_identity) {
  RequireAbsent(StatLeaf(directory_fd, names.open), "open recovery journal");
  RequireAbsent(StatLeaf(directory_fd, names.rollback),
                "rollback recovery journal");
  const int fd = ::openat(directory_fd, names.open.c_str(),
                          O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                          0600);
  if (fd < 0)
    ThrowErrno("openat(create overwrite journal)", errno);
  UniqueFd result(fd);
  try {
    const std::vector<unsigned char> bytes =
        SerializeJournal(request, victim_existed, victim_identity);
    WriteAll(result.get(), bytes);
    FullSyncFile(result.get(), "overwrite journal");
    SyncDirectory(directory_fd);
    return result;
  } catch (...) {
    const std::exception_ptr failure = std::current_exception();
    struct stat pinned {};
    if (::fstat(result.get(), &pinned) != 0)
      ThrowErrno("fstat(failed overwrite journal)", errno);
    const LeafStat named = StatLeaf(directory_fd, names.open);
    RequireRegularIdentity(named, IdentityFromStat(pinned),
                           "failed overwrite recovery journal");
    if (::unlinkat(directory_fd, names.open.c_str(), 0) != 0)
      ThrowErrno("unlinkat(failed overwrite journal)", errno);
    SyncDirectory(directory_fd);
    std::rethrow_exception(failure);
  }
}

void VerifyNamedJournal(int directory_fd, const std::string &leaf,
                        int journal_fd) {
  struct stat pinned {};
  if (::fstat(journal_fd, &pinned) != 0)
    ThrowErrno("fstat(pinned overwrite journal)", errno);
  const LeafStat named = StatLeaf(directory_fd, leaf);
  RequireRegularIdentity(named, IdentityFromStat(pinned),
                         "named overwrite recovery journal");
  if (pinned.st_nlink != 1 || named.value.st_nlink != 1) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal link count changed");
  }
}

void RenameOwnedJournal(int directory_fd, int journal_fd,
                        const std::string &from, const std::string &to) {
  VerifyNamedJournal(directory_fd, from, journal_fd);
  RequireAbsent(StatLeaf(directory_fd, to), "terminal recovery journal");
  if (::renameatx_np(directory_fd, from.c_str(), directory_fd, to.c_str(),
                     RENAME_EXCL | RENAME_NOFOLLOW_ANY) != 0) {
    ThrowErrno("renameatx_np(overwrite journal intent)", errno);
  }
}

void RemoveOwnedJournal(int directory_fd, int journal_fd,
                        const std::string &leaf) {
  struct stat pinned {};
  if (::fstat(journal_fd, &pinned) != 0)
    ThrowErrno("fstat(pinned overwrite journal)", errno);

  const LeafStat named = StatLeaf(directory_fd, leaf);
  if (named.exists) {
    RequireRegularIdentity(named, IdentityFromStat(pinned),
                           "named overwrite recovery journal");
    if (pinned.st_nlink != 1 || named.value.st_nlink != 1) {
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal link count changed");
    }
    if (::unlinkat(directory_fd, leaf.c_str(), 0) != 0)
      ThrowErrno("unlinkat(overwrite journal)", errno);
  } else if (pinned.st_nlink != 0) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal name is missing");
  }

  MaybeInjectTestFault("journal_after_unlink_before_sync");
  SyncDirectory(directory_fd);

  if (::fstat(journal_fd, &pinned) != 0)
    ThrowErrno("fstat(removed overwrite journal)", errno);
  if (pinned.st_nlink != 0) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal cleanup is pending");
  }
}

enum class Phase {
  kPreparedExisting,
  kPreparedAbsent,
  kOpenExisting,
  kOpenAbsent,
  kRollbackIntentExisting,
  kRollbackIntentAbsent,
  kRollbackCleanupExisting,
  kRollbackCleanupAbsent,
  kFinalizeIntentExisting,
  kFinalizeIntentAbsent,
  kFinalizeCleanupExisting,
  kFinalizeCleanupAbsent,
  kFinalized,
  kRolledBack,
};

class Transaction final {
public:
  Transaction(UniqueFd directory_fd, UniqueFd new_file_fd, Request request,
              bool victim_existed, Identity victim_identity)
      : directory_fd_(std::move(directory_fd)),
        new_file_fd_(std::move(new_file_fd)), request_(std::move(request)),
        victim_identity_(victim_identity), journal_names_(DeriveJournalNames(request_)),
        phase_(victim_existed ? Phase::kPreparedExisting
                              : Phase::kPreparedAbsent) {}

  Transaction(const Transaction &) = delete;
  Transaction &operator=(const Transaction &) = delete;

  ~Transaction() {
    BestEffortRollback();
    directory_fd_.CloseIgnoringErrors();
  }

  const Identity &expected_final_identity() const {
    return request_.expected_partial_identity;
  }

  void PrepareJournal() {
    if (phase_ != Phase::kPreparedExisting &&
        phase_ != Phase::kPreparedAbsent) {
      ThrowInvalidState("the overwrite transaction cannot prepare a journal");
    }
    if (journal_fd_.valid())
      ThrowInvalidState("the overwrite transaction journal already exists");
    journal_fd_ = CreateOpenJournal(
        directory_fd_.get(), request_, journal_names_,
        phase_ == Phase::kPreparedExisting, victim_identity_);
  }

  void CommitBegin() {
    if (!journal_fd_.valid())
      ThrowInvalidState("the overwrite transaction journal is unavailable");
    VerifyNewPartial();
    if (phase_ == Phase::kPreparedExisting) {
      const LeafStat victim =
          StatLeaf(directory_fd_.get(), request_.final_leaf);
      RequireRegularIdentity(victim, victim_identity_, "overwrite victim");
      if (SameIdentity(victim_identity_, request_.expected_partial_identity)) {
        throw NativeError(kFilesystemCode,
                          "overwrite victim aliases the partial file");
      }
      if (::renameatx_np(directory_fd_.get(), request_.partial_leaf.c_str(),
                         directory_fd_.get(), request_.final_leaf.c_str(),
                         RENAME_SWAP | RENAME_NOFOLLOW_ANY) != 0) {
        ThrowErrno("renameatx_np(RENAME_SWAP)", errno);
      }
      // Everything that can throw is complete before the atomic rename. The
      // immediately following Registry activation verifies the installed
      // identity while this reachable receipt retains rollback authority.
      phase_ = Phase::kOpenExisting;
      MaybeInjectTestFault("begin_after_namespace");
      return;
    }

    RequireAbsent(StatLeaf(directory_fd_.get(), request_.final_leaf),
                  "final leaf");
    if (::renameatx_np(directory_fd_.get(), request_.partial_leaf.c_str(),
                       directory_fd_.get(), request_.final_leaf.c_str(),
                       RENAME_EXCL | RENAME_NOFOLLOW_ANY) != 0) {
      ThrowErrno("renameatx_np(RENAME_EXCL)", errno);
    }
    phase_ = Phase::kOpenAbsent;
    MaybeInjectTestFault("begin_after_namespace");
  }

  void Finalize() {
    TerminalGuard guard(*this);
    if (phase_ == Phase::kFinalized)
      return;
    if (phase_ == Phase::kRolledBack ||
        phase_ == Phase::kRollbackIntentExisting ||
        phase_ == Phase::kRollbackIntentAbsent ||
        phase_ == Phase::kRollbackCleanupExisting ||
        phase_ == Phase::kRollbackCleanupAbsent) {
      ThrowInvalidState("a rolled-back transaction cannot be finalized");
    }
    if (phase_ != Phase::kOpenExisting && phase_ != Phase::kOpenAbsent &&
        phase_ != Phase::kFinalizeIntentExisting &&
        phase_ != Phase::kFinalizeIntentAbsent &&
        phase_ != Phase::kFinalizeCleanupExisting &&
        phase_ != Phase::kFinalizeCleanupAbsent) {
      ThrowInvalidState("the overwrite transaction is not open");
    }

    if (phase_ == Phase::kOpenExisting) {
      phase_ = Phase::kFinalizeIntentExisting;
    } else if (phase_ == Phase::kOpenAbsent) {
      phase_ = Phase::kFinalizeIntentAbsent;
    }

    if (phase_ == Phase::kFinalizeIntentExisting) {
      VerifyOpenExisting();
      MaybeInjectTestFault("finalize_before_namespace");
      if (::unlinkat(directory_fd_.get(), request_.partial_leaf.c_str(), 0) !=
          0) {
        ThrowErrno("unlinkat(overwrite victim)", errno);
      }
      phase_ = Phase::kFinalizeCleanupExisting;
      SyncDirectory(directory_fd_.get());
      MaybeInjectTestFault("finalize_after_namespace_sync");
    } else if (phase_ == Phase::kFinalizeIntentAbsent) {
      VerifyOpenAbsent();
      MaybeInjectTestFault("finalize_before_namespace");
      phase_ = Phase::kFinalizeCleanupAbsent;
    }

    VerifyFinalizeCleanup();
    RemoveOwnedJournal(directory_fd_.get(), journal_fd_.get(),
                       journal_names_.open);
    phase_ = Phase::kFinalized;
    CloseHandlesIgnoringErrors();
  }

  void Rollback() {
    TerminalGuard guard(*this);
    if (phase_ == Phase::kRolledBack)
      return;
    if (phase_ == Phase::kFinalized) {
      ThrowInvalidState("a finalized transaction cannot be rolled back");
    }
    if (phase_ == Phase::kFinalizeIntentExisting ||
        phase_ == Phase::kFinalizeIntentAbsent ||
        phase_ == Phase::kFinalizeCleanupExisting ||
        phase_ == Phase::kFinalizeCleanupAbsent) {
      ThrowInvalidState("a finalizing transaction cannot be rolled back");
    }

    if (phase_ == Phase::kOpenExisting) {
      VerifyOpenExisting();
      ArmRollback(Phase::kRollbackIntentExisting);
    } else if (phase_ == Phase::kOpenAbsent) {
      VerifyOpenAbsent();
      ArmRollback(Phase::kRollbackIntentAbsent);
    } else if (phase_ != Phase::kRollbackIntentExisting &&
               phase_ != Phase::kRollbackIntentAbsent &&
               phase_ != Phase::kRollbackCleanupExisting &&
               phase_ != Phase::kRollbackCleanupAbsent) {
      ThrowInvalidState("the overwrite transaction is not open");
    }

    if (phase_ == Phase::kRollbackIntentExisting ||
        phase_ == Phase::kRollbackIntentAbsent) {
      ConvergeRollbackNamespace();
    }
    CompleteRollbackCleanup();
  }

private:
  class TerminalGuard final {
  public:
    explicit TerminalGuard(Transaction &transaction)
        : transaction_(transaction) {
      if (transaction_.terminal_in_progress_) {
        ThrowInvalidState("a terminal transaction operation is in progress");
      }
      transaction_.terminal_in_progress_ = true;
    }

    ~TerminalGuard() { transaction_.terminal_in_progress_ = false; }

  private:
    Transaction &transaction_;
  };

  void VerifyNewPartial() const {
    struct stat pinned{};
    if (::fstat(new_file_fd_.get(), &pinned) != 0) {
      ThrowErrno("fstat(pinned partial)", errno);
    }
    const LeafStat pinned_leaf{true, pinned};
    RequireRegularIdentity(pinned_leaf, request_.expected_partial_identity,
                           "pinned partial file", &request_.expected_byte_size);
    const LeafStat partial =
        StatLeaf(directory_fd_.get(), request_.partial_leaf);
    RequireRegularIdentity(partial, request_.expected_partial_identity,
                           "partial leaf", &request_.expected_byte_size);
    RequireSingleLink(pinned, "pinned partial file");
    RequireSingleLink(partial.value, "partial leaf");
  }

  void VerifyOpenExisting() const {
    const LeafStat installed =
        StatLeaf(directory_fd_.get(), request_.final_leaf);
    RequireRegularIdentity(installed, request_.expected_partial_identity,
                           "installed final leaf",
                           &request_.expected_byte_size);
    const LeafStat victim =
        StatLeaf(directory_fd_.get(), request_.partial_leaf);
    RequireRegularIdentity(victim, victim_identity_,
                           "recoverable overwrite victim");
  }

  void VerifyOpenAbsent() const {
    const LeafStat installed =
        StatLeaf(directory_fd_.get(), request_.final_leaf);
    RequireRegularIdentity(installed, request_.expected_partial_identity,
                           "installed final leaf",
                           &request_.expected_byte_size);
    RequireAbsent(StatLeaf(directory_fd_.get(), request_.partial_leaf),
                  "partial leaf");
  }

  void VerifyFinalizeCleanup() const {
    const LeafStat installed =
        StatLeaf(directory_fd_.get(), request_.final_leaf);
    RequireRegularIdentity(installed, request_.expected_partial_identity,
                           "finalized overwrite leaf",
                           &request_.expected_byte_size);
    RequireAbsent(StatLeaf(directory_fd_.get(), request_.partial_leaf),
                  "finalized overwrite victim leaf");
  }

  void ArmRollback(Phase intent_phase) {
    RenameOwnedJournal(directory_fd_.get(), journal_fd_.get(),
                       journal_names_.open, journal_names_.rollback);
    phase_ = intent_phase;
    VerifyNamedJournal(directory_fd_.get(), journal_names_.rollback,
                       journal_fd_.get());
    SyncDirectory(directory_fd_.get());
    MaybeInjectTestFault("rollback_after_intent_sync");
  }

  void ConvergeRollbackNamespace() {
    MaybeInjectTestFault("rollback_before_namespace");
    if (phase_ == Phase::kRollbackIntentExisting) {
      if (::renameatx_np(directory_fd_.get(), request_.partial_leaf.c_str(),
                         directory_fd_.get(), request_.final_leaf.c_str(),
                         RENAME_SWAP | RENAME_NOFOLLOW_ANY) != 0) {
        ThrowErrno("renameatx_np(rollback RENAME_SWAP)", errno);
      }
      phase_ = Phase::kRollbackCleanupExisting;
    } else if (phase_ == Phase::kRollbackIntentAbsent) {
      if (::renameatx_np(directory_fd_.get(), request_.final_leaf.c_str(),
                         directory_fd_.get(), request_.partial_leaf.c_str(),
                         RENAME_EXCL | RENAME_NOFOLLOW_ANY) != 0) {
        ThrowErrno("renameatx_np(rollback RENAME_EXCL)", errno);
      }
      phase_ = Phase::kRollbackCleanupAbsent;
    } else {
      ThrowInvalidState("the overwrite transaction has no rollback intent");
    }
    SyncDirectory(directory_fd_.get());
    MaybeInjectTestFault("rollback_after_namespace_sync");
  }

  void CompleteRollbackCleanup() {
    if (phase_ == Phase::kRollbackCleanupExisting) {
      const LeafStat restored =
          StatLeaf(directory_fd_.get(), request_.final_leaf);
      RequireRegularIdentity(restored, victim_identity_,
                             "restored overwrite victim");
    } else if (phase_ == Phase::kRollbackCleanupAbsent) {
      RequireAbsent(StatLeaf(directory_fd_.get(), request_.final_leaf),
                    "restored final leaf");
    } else {
      ThrowInvalidState("the overwrite transaction has no rollback cleanup");
    }

    const LeafStat partial =
        StatLeaf(directory_fd_.get(), request_.partial_leaf);
    if (partial.exists) {
      RequireRegularIdentity(partial, request_.expected_partial_identity,
                             "rollback partial leaf",
                             &request_.expected_byte_size);
      RequireSingleLink(partial.value, "rollback partial leaf");
      MaybeInjectTestFault("rollback_before_cleanup_unlink");
      if (::unlinkat(directory_fd_.get(), request_.partial_leaf.c_str(), 0) !=
          0) {
        ThrowErrno("unlinkat(rollback partial)", errno);
      }
      SyncDirectory(directory_fd_.get());
    }

    struct stat pinned{};
    if (::fstat(new_file_fd_.get(), &pinned) != 0) {
      ThrowErrno("fstat(rollback partial)", errno);
    }
    const LeafStat pinned_leaf{true, pinned};
    RequireRegularIdentity(pinned_leaf, request_.expected_partial_identity,
                           "rollback pinned partial",
                           &request_.expected_byte_size);
    if (pinned.st_nlink != 0) {
      throw NativeError(kFilesystemCode,
                        "rollback partial cleanup is still pending");
    }

    MaybeInjectTestFault("rollback_after_cleanup_sync");
    MaybeInjectTestFault("rollback_before_journal_remove");
    RemoveOwnedJournal(directory_fd_.get(), journal_fd_.get(),
                       journal_names_.rollback);
    phase_ = Phase::kRolledBack;
    CloseHandlesIgnoringErrors();
  }

  void BestEffortRollback() noexcept {
    if ((phase_ == Phase::kPreparedExisting ||
         phase_ == Phase::kPreparedAbsent) &&
        journal_fd_.valid()) {
      try {
        RemoveOwnedJournal(directory_fd_.get(), journal_fd_.get(),
                           journal_names_.open);
      } catch (...) {
      }
      return;
    }
    if (phase_ == Phase::kFinalizeIntentExisting ||
        phase_ == Phase::kFinalizeIntentAbsent ||
        phase_ == Phase::kFinalizeCleanupExisting ||
        phase_ == Phase::kFinalizeCleanupAbsent) {
      try {
        Finalize();
      } catch (...) {
      }
      return;
    }
    if (phase_ != Phase::kOpenExisting && phase_ != Phase::kOpenAbsent &&
        phase_ != Phase::kRollbackIntentExisting &&
        phase_ != Phase::kRollbackIntentAbsent &&
        phase_ != Phase::kRollbackCleanupExisting &&
        phase_ != Phase::kRollbackCleanupAbsent) {
      return;
    }
    try {
      Rollback();
    } catch (...) {
      // A finalizer cannot report recovery failure. The explicit receipt path
      // retains the dirfd and supports retry until this last-resort boundary.
    }
  }

  void CloseHandlesIgnoringErrors() noexcept {
    journal_fd_.CloseIgnoringErrors();
    new_file_fd_.CloseIgnoringErrors();
    directory_fd_.CloseIgnoringErrors();
  }

  UniqueFd directory_fd_;
  UniqueFd new_file_fd_;
  Request request_;
  Identity victim_identity_;
  JournalNames journal_names_;
  UniqueFd journal_fd_;
  Phase phase_;
  bool terminal_in_progress_ = false;
};

enum class RecoveryState {
  kNotFound,
  kDecisionRequired,
  kRolledBack,
};

bool MatchesRegularIdentity(const LeafStat &actual, const Identity &expected,
                            const int64_t *expected_size = nullptr) {
  return actual.exists && S_ISREG(actual.value.st_mode) &&
         SameIdentity(actual.value, expected) &&
         (expected_size == nullptr ||
          actual.value.st_size == static_cast<off_t>(*expected_size));
}

UniqueFd OpenExpectedNewLeaf(int directory_fd, const std::string &leaf,
                             const Request &request) {
  const int fd = ::openat(directory_fd, leaf.c_str(),
                          O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0)
    ThrowErrno("openat(recovery new leaf)", errno);
  UniqueFd result(fd);
  struct stat value {};
  if (::fstat(result.get(), &value) != 0)
    ThrowErrno("fstat(recovery new leaf)", errno);
  const LeafStat opened{true, value};
  RequireRegularIdentity(opened, request.expected_partial_identity,
                         "recovery new leaf", &request.expected_byte_size);
  RequireSingleLink(value, "recovery new leaf");
  return result;
}

void RecoverRollback(int directory_fd, const Request &request,
                     const JournalNames &names, OpenedJournal &journal) {
  const LeafStat initial_final = StatLeaf(directory_fd, request.final_leaf);
  const LeafStat initial_partial = StatLeaf(directory_fd, request.partial_leaf);
  const bool final_is_new = MatchesRegularIdentity(
      initial_final, request.expected_partial_identity,
      &request.expected_byte_size);
  const bool partial_is_new = MatchesRegularIdentity(
      initial_partial, request.expected_partial_identity,
      &request.expected_byte_size);
  UniqueFd new_file_fd;

  if (journal.record.victim_existed) {
    const bool final_is_victim = MatchesRegularIdentity(
        initial_final, journal.record.victim_identity);
    const bool partial_is_victim = MatchesRegularIdentity(
        initial_partial, journal.record.victim_identity);
    if (final_is_new && partial_is_victim) {
      new_file_fd =
          OpenExpectedNewLeaf(directory_fd, request.final_leaf, request);
      if (::renameatx_np(directory_fd, request.partial_leaf.c_str(),
                         directory_fd, request.final_leaf.c_str(),
                         RENAME_SWAP | RENAME_NOFOLLOW_ANY) != 0) {
        ThrowErrno("renameatx_np(recover rollback RENAME_SWAP)", errno);
      }
      SyncDirectory(directory_fd);
    } else if (final_is_victim && partial_is_new) {
      new_file_fd =
          OpenExpectedNewLeaf(directory_fd, request.partial_leaf, request);
    } else if (!(final_is_victim && !initial_partial.exists)) {
      throw NativeError(kFilesystemCode,
                        "the rollback recovery layout is not owned");
    }

    const LeafStat restored = StatLeaf(directory_fd, request.final_leaf);
    RequireRegularIdentity(restored, journal.record.victim_identity,
                           "recovered overwrite victim");
  } else {
    if (final_is_new && !initial_partial.exists) {
      new_file_fd =
          OpenExpectedNewLeaf(directory_fd, request.final_leaf, request);
      if (::renameatx_np(directory_fd, request.final_leaf.c_str(), directory_fd,
                         request.partial_leaf.c_str(),
                         RENAME_EXCL | RENAME_NOFOLLOW_ANY) != 0) {
        ThrowErrno("renameatx_np(recover rollback RENAME_EXCL)", errno);
      }
      SyncDirectory(directory_fd);
    } else if (!initial_final.exists && partial_is_new) {
      new_file_fd =
          OpenExpectedNewLeaf(directory_fd, request.partial_leaf, request);
    } else if (!(!initial_final.exists && !initial_partial.exists)) {
      throw NativeError(kFilesystemCode,
                        "the absent rollback recovery layout is not owned");
    }
    RequireAbsent(StatLeaf(directory_fd, request.final_leaf),
                  "recovered absent final leaf");
  }

  const LeafStat cleanup = StatLeaf(directory_fd, request.partial_leaf);
  if (cleanup.exists) {
    RequireRegularIdentity(cleanup, request.expected_partial_identity,
                           "recovery rollback partial",
                           &request.expected_byte_size);
    RequireSingleLink(cleanup.value, "recovery rollback partial");
    if (!new_file_fd.valid()) {
      new_file_fd =
          OpenExpectedNewLeaf(directory_fd, request.partial_leaf, request);
    }
    if (::unlinkat(directory_fd, request.partial_leaf.c_str(), 0) != 0)
      ThrowErrno("unlinkat(recovery rollback partial)", errno);
    SyncDirectory(directory_fd);
  }
  if (new_file_fd.valid()) {
    struct stat pinned {};
    if (::fstat(new_file_fd.get(), &pinned) != 0)
      ThrowErrno("fstat(recovery rollback partial)", errno);
    if (pinned.st_nlink != 0) {
      throw NativeError(kFilesystemCode,
                        "the recovery rollback cleanup is still pending");
    }
  }

  RemoveOwnedJournal(directory_fd, journal.fd.get(), names.rollback);
}

RecoveryState RecoverTransaction(const RecoveryRequest &request) {
  UniqueFd directory_fd = OpenAndVerifyDirectory(request);
  const JournalNames names = DeriveJournalNames(request.transaction_id);
  const LeafStat open = StatLeaf(directory_fd.get(), names.open);
  const LeafStat rollback = StatLeaf(directory_fd.get(), names.rollback);
  if (open.exists && rollback.exists) {
    throw NativeError(kFilesystemCode,
                      "multiple overwrite recovery journals exist");
  }
  if (!open.exists && !rollback.exists)
    return RecoveryState::kNotFound;
  if (open.exists) {
    (void)OpenAndValidateJournal(directory_fd.get(), names.open, request);
    return RecoveryState::kDecisionRequired;
  }

  OpenedJournal journal =
      OpenAndValidateJournal(directory_fd.get(), names.rollback, request);
  RecoverRollback(directory_fd.get(), journal.record.request, names, journal);
  return RecoveryState::kRolledBack;
}

napi_value CreateNumber(napi_env env, double value) {
  napi_value result = nullptr;
  CheckNapi(env, napi_create_double(env, value, &result), "napi_create_double");
  return result;
}

napi_value CreateIdentity(napi_env env, const Identity &identity) {
  napi_value result = nullptr;
  CheckNapi(env, napi_create_object(env, &result), "napi_create_object");
  CheckNapi(env,
            napi_set_named_property(env, result, "dev",
                                    CreateNumber(env, identity.dev)),
            "napi_set_named_property(dev)");
  CheckNapi(env,
            napi_set_named_property(env, result, "ino",
                                    CreateNumber(env, identity.ino)),
            "napi_set_named_property(ino)");
  CheckNapi(env,
            napi_set_named_property(env, result, "birthtimeMs",
                                    CreateNumber(env, identity.birthtime_ms)),
            "napi_set_named_property(birthtimeMs)");
  return result;
}

Transaction *UnwrapTransaction(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  napi_value receiver = nullptr;
  CheckNapi(env,
            napi_get_cb_info(env, info, &argc, nullptr, &receiver, nullptr),
            "napi_get_cb_info");
  Transaction *transaction = nullptr;
  const napi_status status =
      napi_unwrap(env, receiver, reinterpret_cast<void **>(&transaction));
  if (status != napi_ok || transaction == nullptr) {
    ThrowInvalidState("overwrite transaction method has an invalid receiver");
  }
  return transaction;
}

napi_value FinalizeCallback(napi_env env, napi_callback_info info) {
  try {
    napi_value result = nullptr;
    CheckNapi(env, napi_get_undefined(env, &result), "napi_get_undefined");
    UnwrapTransaction(env, info)->Finalize();
    return result;
  } catch (const NativeError &error) {
    ThrowToJavaScript(env, error);
    return nullptr;
  } catch (const std::exception &error) {
    ThrowToJavaScript(env, NativeError(kInternalCode, error.what()));
    return nullptr;
  }
}

napi_value RollbackCallback(napi_env env, napi_callback_info info) {
  try {
    napi_value result = nullptr;
    CheckNapi(env, napi_get_undefined(env, &result), "napi_get_undefined");
    UnwrapTransaction(env, info)->Rollback();
    return result;
  } catch (const NativeError &error) {
    ThrowToJavaScript(env, error);
    return nullptr;
  } catch (const std::exception &error) {
    ThrowToJavaScript(env, NativeError(kInternalCode, error.what()));
    return nullptr;
  }
}

void ReceiptFinalizer(napi_env, void *data, void *) {
  delete static_cast<Transaction *>(data);
}

struct BuiltReceipt {
  napi_value value = nullptr;
  Transaction *transaction = nullptr;
};

void DisposeBuiltReceipt(napi_env env, BuiltReceipt &built) {
  if (built.value == nullptr || built.transaction == nullptr)
    return;

  void *removed = nullptr;
  CheckNapi(env, napi_remove_wrap(env, built.value, &removed),
            "napi_remove_wrap(begin failure)");
  if (removed != built.transaction) {
    throw NativeError(kInternalCode,
                      "the failed overwrite receipt lost its native state");
  }

  Transaction *transaction = built.transaction;
  built.value = nullptr;
  built.transaction = nullptr;
  delete transaction;
}

BuiltReceipt BuildReceipt(napi_env env,
                          std::unique_ptr<Transaction> transaction) {
  napi_value receipt = nullptr;
  CheckNapi(env, napi_create_object(env, &receipt), "napi_create_object");

  Transaction *raw = transaction.get();
  CheckNapi(env,
            napi_wrap(env, receipt, raw, ReceiptFinalizer, nullptr, nullptr),
            "napi_wrap");
  transaction.release();

  try {
    napi_value finalize = nullptr;
    napi_value rollback = nullptr;
    CheckNapi(env,
              napi_create_function(env, "finalize", NAPI_AUTO_LENGTH,
                                   FinalizeCallback, nullptr, &finalize),
              "napi_create_function(finalize)");
    CheckNapi(env,
              napi_create_function(env, "rollback", NAPI_AUTO_LENGTH,
                                   RollbackCallback, nullptr, &rollback),
              "napi_create_function(rollback)");
    CheckNapi(env,
              napi_set_named_property(
                  env, receipt, "expectedFinalIdentity",
                  CreateIdentity(env, raw->expected_final_identity())),
              "napi_set_named_property(expectedFinalIdentity)");
    CheckNapi(env, napi_set_named_property(env, receipt, "finalize", finalize),
              "napi_set_named_property(finalize)");
    CheckNapi(env, napi_set_named_property(env, receipt, "rollback", rollback),
              "napi_set_named_property(rollback)");
  } catch (...) {
    BuiltReceipt failed{receipt, raw};
    DisposeBuiltReceipt(env, failed);
    throw;
  }

  return BuiltReceipt{receipt, raw};
}

napi_value BeginCallback(napi_env env, napi_callback_info info) {
  BuiltReceipt built;
  try {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
              "napi_get_cb_info");
    if (argc != 1) {
      ThrowInvalidRequest("begin requires exactly one request argument");
    }

    Request request = ReadRequest(env, argv[0]);
    UniqueFd directory_fd = OpenAndVerifyDirectory(request);
    UniqueFd new_file_fd = OpenAndVerifyPartial(directory_fd.get(), request);

    const LeafStat final = StatLeaf(directory_fd.get(), request.final_leaf);
    Identity victim_identity;
    if (final.exists) {
      if (!S_ISREG(final.value.st_mode)) {
        throw NativeError(kFilesystemCode,
                          "overwrite victim is not a no-follow regular file");
      }
      victim_identity = IdentityFromStat(final.value);
      if (SameIdentity(victim_identity, request.expected_partial_identity)) {
        throw NativeError(kFilesystemCode,
                          "overwrite victim aliases the partial file");
      }
    }

    auto transaction = std::make_unique<Transaction>(
        std::move(directory_fd), std::move(new_file_fd), std::move(request),
        final.exists, victim_identity);
    built = BuildReceipt(env, std::move(transaction));
    built.transaction->PrepareJournal();
    built.transaction->CommitBegin();
    return built.value;
  } catch (const NativeError &error) {
    try {
      DisposeBuiltReceipt(env, built);
    } catch (const NativeError &cleanup_error) {
      ThrowToJavaScript(env, cleanup_error);
      return nullptr;
    }
    ThrowToJavaScript(env, error);
    return nullptr;
  } catch (const std::exception &error) {
    try {
      DisposeBuiltReceipt(env, built);
    } catch (const NativeError &cleanup_error) {
      ThrowToJavaScript(env, cleanup_error);
      return nullptr;
    }
    ThrowToJavaScript(env, NativeError(kInternalCode, error.what()));
    return nullptr;
  }
}

napi_value CreateRecoveryResult(napi_env env, RecoveryState state) {
  const char *name = nullptr;
  switch (state) {
  case RecoveryState::kNotFound:
    name = "not_found";
    break;
  case RecoveryState::kDecisionRequired:
    name = "decision_required";
    break;
  case RecoveryState::kRolledBack:
    name = "rolled_back";
    break;
  }
  napi_value result = nullptr;
  napi_value state_value = nullptr;
  CheckNapi(env, napi_create_object(env, &result), "napi_create_object");
  CheckNapi(env,
            napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &state_value),
            "napi_create_string_utf8(recovery state)");
  CheckNapi(env, napi_set_named_property(env, result, "state", state_value),
            "napi_set_named_property(recovery state)");
  return result;
}

napi_value RecoverCallback(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
              "napi_get_cb_info");
    if (argc != 1)
      ThrowInvalidRequest("recover requires exactly one request argument");
    const RecoveryRequest request = ReadRecoveryRequest(env, argv[0]);
    return CreateRecoveryResult(env, RecoverTransaction(request));
  } catch (const NativeError &error) {
    ThrowToJavaScript(env, error);
    return nullptr;
  } catch (const std::exception &error) {
    ThrowToJavaScript(env, NativeError(kInternalCode, error.what()));
    return nullptr;
  }
}

void SetNamed(napi_env env, napi_value object, const char *name,
              napi_value value) {
  CheckNapi(env, napi_set_named_property(env, object, name, value),
            "napi_set_named_property");
}

napi_value Init(napi_env env, napi_value exports) {
  try {
    napi_value protocol_version = nullptr;
    napi_value platform = nullptr;
    napi_value architecture = nullptr;
    napi_value begin = nullptr;
    napi_value recover = nullptr;
    CheckNapi(env, napi_create_uint32(env, kProtocolVersion, &protocol_version),
              "napi_create_uint32");
    CheckNapi(
        env,
        napi_create_string_utf8(env, "darwin", NAPI_AUTO_LENGTH, &platform),
        "napi_create_string_utf8(platform)");
    CheckNapi(
        env,
        napi_create_string_utf8(env, "arm64", NAPI_AUTO_LENGTH, &architecture),
        "napi_create_string_utf8(architecture)");
    CheckNapi(env,
              napi_create_function(env, "begin", NAPI_AUTO_LENGTH,
                                   BeginCallback, nullptr, &begin),
              "napi_create_function(begin)");
    CheckNapi(env,
              napi_create_function(env, "recover", NAPI_AUTO_LENGTH,
                                   RecoverCallback, nullptr, &recover),
              "napi_create_function(recover)");
    SetNamed(env, exports, "protocolVersion", protocol_version);
    SetNamed(env, exports, "platform", platform);
    SetNamed(env, exports, "architecture", architecture);
    SetNamed(env, exports, "begin", begin);
    SetNamed(env, exports, "recover", recover);
#if defined(FUSIONKIT_OVERWRITE_TEST_FAULTS)
    napi_value test_fault_injection = nullptr;
    CheckNapi(env, napi_get_boolean(env, true, &test_fault_injection),
              "napi_get_boolean(testFaultInjection)");
    SetNamed(env, exports, "testFaultInjection", test_fault_injection);
#endif
    return exports;
  } catch (const NativeError &error) {
    ThrowToJavaScript(env, error);
    return nullptr;
  } catch (const std::exception &error) {
    ThrowToJavaScript(env, NativeError(kInternalCode, error.what()));
    return nullptr;
  }
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
