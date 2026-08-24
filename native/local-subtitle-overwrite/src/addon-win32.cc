#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <node_api.h>
#include <windows.h>
#include <winternl.h>

#if !defined(_WIN32)
#error "addon-win32.cc is supported only on Windows"
#endif

#if !defined(_M_X64) && !defined(__x86_64__)
#error "addon-win32.cc is supported only on Windows x64"
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <initializer_list>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x00001000L
#endif

namespace {

constexpr double kMaxSafeInteger = 9007199254740991.0;
constexpr uint32_t kProtocolVersion = 4;
constexpr uint32_t kJournalVersion = 3;
constexpr size_t kMaximumJournalBytes = 4096;
constexpr ULONG kFileRenameInformationEx = 65;
constexpr ULONG kFileLinkInformation = 11;
constexpr ULONG kFileDispositionInformationEx = 64;
constexpr ULONG kRenameReplaceIfExists = 0x00000001;
constexpr ULONG kRenamePosixSemantics = 0x00000002;
constexpr ULONG kDispositionDelete = 0x00000001;
constexpr ULONG kDispositionPosixSemantics = 0x00000002;
constexpr ULONG kDispositionIgnoreReadonly = 0x00000010;
constexpr ACCESS_MASK kJournalAccess =
    FILE_READ_ATTRIBUTES | FILE_READ_DATA | FILE_WRITE_DATA | DELETE;
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

[[noreturn]] void ThrowWindows(const std::string &operation, DWORD error) {
  throw NativeError(kFilesystemCode, operation + " failed with Windows error " +
                                         std::to_string(error));
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
  if (action != nullptr && std::strcmp(action, "exit") == 0)
    ::ExitProcess(kTestCrashExitCode);
  if (action != nullptr && std::strcmp(action, "error") == 0) {
    (void)::_putenv_s("FUSIONKIT_OVERWRITE_TEST_FAULT_POINT", "");
    (void)::_putenv_s("FUSIONKIT_OVERWRITE_TEST_FAULT_ACTION", "");
    throw NativeError(kFilesystemCode,
                      std::string("injected overwrite fault at ") + point);
  }
  throw NativeError(kInternalCode,
                    "the overwrite test fault action is invalid");
}
#else
void MaybeInjectTestFault(const char *) {}
#endif

class UniqueHandle final {
public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}
  UniqueHandle(const UniqueHandle &) = delete;
  UniqueHandle &operator=(const UniqueHandle &) = delete;
  UniqueHandle(UniqueHandle &&other) noexcept : value_(other.Release()) {}
  UniqueHandle &operator=(UniqueHandle &&other) noexcept {
    if (this != &other) {
      CloseIgnoringErrors();
      value_ = other.Release();
    }
    return *this;
  }
  ~UniqueHandle() { CloseIgnoringErrors(); }

  HANDLE get() const { return value_; }
  bool valid() const {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  HANDLE Release() {
    const HANDLE value = value_;
    value_ = INVALID_HANDLE_VALUE;
    return value;
  }
  void CloseIgnoringErrors() noexcept {
    if (!valid())
      return;
    const HANDLE value = value_;
    value_ = INVALID_HANDLE_VALUE;
    (void)::CloseHandle(value);
  }

private:
  HANDLE value_ = INVALID_HANDLE_VALUE;
};

void CloseHandleChecked(UniqueHandle &handle, const std::string &label) {
  if (!handle.valid())
    return;
  if (!::CloseHandle(handle.get()))
    ThrowWindows("CloseHandle(" + label + ")", ::GetLastError());
  (void)handle.Release();
}

using NtCreateFileFunction = NTSTATUS(NTAPI *)(
    PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER,
    ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtSetInformationFileFunction = NTSTATUS(NTAPI *)(
    HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
using NtFlushBuffersFileFunction = NTSTATUS(NTAPI *)(
    HANDLE, PIO_STATUS_BLOCK);
using RtlNtStatusToDosErrorFunction = ULONG(WINAPI *)(NTSTATUS);

struct NtApi {
  NtCreateFileFunction create_file = nullptr;
  NtSetInformationFileFunction set_information_file = nullptr;
  NtFlushBuffersFileFunction flush_buffers_file = nullptr;
  RtlNtStatusToDosErrorFunction status_to_error = nullptr;
};

const NtApi &GetNtApi() {
  static const NtApi api = [] {
    HMODULE module = ::GetModuleHandleW(L"ntdll.dll");
    if (module == nullptr)
      ThrowWindows("GetModuleHandleW(ntdll)", ::GetLastError());
    NtApi result;
    result.create_file = reinterpret_cast<NtCreateFileFunction>(
        ::GetProcAddress(module, "NtCreateFile"));
    result.set_information_file =
        reinterpret_cast<NtSetInformationFileFunction>(
            ::GetProcAddress(module, "NtSetInformationFile"));
    result.flush_buffers_file =
        reinterpret_cast<NtFlushBuffersFileFunction>(
            ::GetProcAddress(module, "NtFlushBuffersFile"));
    result.status_to_error =
        reinterpret_cast<RtlNtStatusToDosErrorFunction>(
            ::GetProcAddress(module, "RtlNtStatusToDosError"));
    if (result.create_file == nullptr ||
        result.set_information_file == nullptr ||
        result.flush_buffers_file == nullptr ||
        result.status_to_error == nullptr) {
      throw NativeError(kFilesystemCode,
                        "the required Windows native file APIs are unavailable");
    }
    return result;
  }();
  return api;
}

[[noreturn]] void ThrowNt(const std::string &operation, NTSTATUS status) {
  ThrowWindows(operation, GetNtApi().status_to_error(status));
}

bool IsMissingStatus(NTSTATUS status) {
  const ULONG value = static_cast<ULONG>(status);
  return value == 0xC0000034UL || value == 0xC000003AUL;
}

bool NtSucceeded(NTSTATUS status) { return status >= 0; }

std::wstring Utf8ToWide(const std::string &value,
                        const std::string &label) {
  if (value.empty())
    ThrowInvalidRequest(label + " must not be empty");
  const int count = ::MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0);
  if (count <= 0)
    ThrowInvalidRequest(label + " must be valid UTF-8");
  std::wstring result(static_cast<size_t>(count), L'\0');
  if (::MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), result.data(),
                            count) != count) {
    ThrowInvalidRequest(label + " must be valid UTF-8");
  }
  return result;
}

std::wstring ExtendedAbsolutePath(const std::string &value) {
  std::wstring path = Utf8ToWide(value, "directoryPath");
  if (path.find(L'\0') != std::wstring::npos)
    ThrowInvalidRequest("directoryPath must not contain NUL bytes");
  if (path.rfind(LR"(\\?\)", 0) == 0)
    return path;
  if (path.size() >= 3 &&
      ((path[0] >= L'A' && path[0] <= L'Z') ||
       (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) {
    std::replace(path.begin(), path.end(), L'/', L'\\');
    return LR"(\\?\)" + path;
  }
  if (path.rfind(LR"(\\)", 0) == 0) {
    std::replace(path.begin(), path.end(), L'/', L'\\');
    return LR"(\\?\UNC\)" + path.substr(2);
  }
  ThrowInvalidRequest("directoryPath must be an absolute Windows path");
}

struct Identity {
  std::string volume_serial_hex;
  std::string file_id_hex;
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

enum class RecoveryDecision { kFinalize, kRollback };

struct RecoveryRequest {
  std::string directory_path;
  Identity expected_directory_identity;
  std::string transaction_id;
  RecoveryDecision decision = RecoveryDecision::kRollback;
};

bool SameIdentity(const Identity &left, const Identity &right) {
  return left.volume_serial_hex == right.volume_serial_hex &&
         left.file_id_hex == right.file_id_hex;
}

std::string HexFixed(uint64_t value, size_t digits) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string result(digits, '0');
  for (size_t index = 0; index < digits; ++index) {
    result[digits - 1 - index] = kHex[value & 0xfU];
    value >>= 4U;
  }
  return result;
}

std::string FileIdHex(const FILE_ID_128 &file_id) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string result(32, '0');
  for (size_t index = 0; index < 16; ++index) {
    const unsigned char byte = file_id.Identifier[15 - index];
    result[index * 2] = kHex[(byte >> 4U) & 0xfU];
    result[index * 2 + 1] = kHex[byte & 0xfU];
  }
  return result;
}

Identity IdentityFromHandle(HANDLE handle) {
  FILE_ID_INFO id{};
  if (!::GetFileInformationByHandleEx(handle, FileIdInfo, &id, sizeof(id)))
    ThrowWindows("GetFileInformationByHandleEx(FileIdInfo)", ::GetLastError());
  return Identity{HexFixed(id.VolumeSerialNumber & 0xffffffffULL, 8),
                  FileIdHex(id.FileId)};
}

struct FileProof {
  Identity identity;
  int64_t byte_size = 0;
  uint32_t links = 0;
  bool directory = false;
};

FileProof ProofFromHandle(HANDLE handle, const std::string &label) {
  FILE_STANDARD_INFO standard{};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!::GetFileInformationByHandleEx(handle, FileStandardInfo, &standard,
                                       sizeof(standard))) {
    ThrowWindows("GetFileInformationByHandleEx(" + label + " standard)",
                 ::GetLastError());
  }
  if (!::GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag,
                                       sizeof(tag))) {
    ThrowWindows("GetFileInformationByHandleEx(" + label + " tag)",
                 ::GetLastError());
  }
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    throw NativeError(kFilesystemCode,
                      label + " is a reparse point");
  }
  return FileProof{IdentityFromHandle(handle),
                   standard.EndOfFile.QuadPart,
                   standard.NumberOfLinks,
                   standard.Directory != FALSE};
}

void RequireRegularIdentity(const FileProof &actual,
                            const Identity &expected,
                            const std::string &label,
                            const int64_t *expected_size = nullptr) {
  if (actual.directory)
    throw NativeError(kFilesystemCode, label + " is not a regular file");
  if (!SameIdentity(actual.identity, expected))
    throw NativeError(kFilesystemCode, label + " identity changed");
  if (expected_size != nullptr && actual.byte_size != *expected_size)
    throw NativeError(kFilesystemCode, label + " byte size changed");
}

void RequireSingleLink(const FileProof &actual, const std::string &label) {
  if (actual.links != 1)
    throw NativeError(kFilesystemCode,
                      label + " must have exactly one directory link");
}

std::string ReadString(napi_env env, napi_value value,
                       const std::string &label) {
  napi_valuetype type = napi_undefined;
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof");
  if (type != napi_string)
    ThrowInvalidRequest(label + " must be a string");
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
  if (type != napi_object || is_null || is_array)
    ThrowInvalidRequest(label + " must be an object");
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
  if (length != expected.size())
    ThrowInvalidRequest(label + " has unexpected own properties");
  std::unordered_set<std::string> remaining;
  for (const char *key : expected)
    remaining.emplace(key);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value key = nullptr;
    CheckNapi(env, napi_get_element(env, keys, index, &key),
              "napi_get_element");
    if (remaining.erase(ReadString(env, key, label + " property name")) != 1)
      ThrowInvalidRequest(label + " has unexpected own properties");
  }
  if (!remaining.empty())
    ThrowInvalidRequest(label + " is missing required own properties");
}

double ReadNumber(napi_env env, napi_value value, const std::string &label) {
  napi_valuetype type = napi_undefined;
  CheckNapi(env, napi_typeof(env, value, &type), "napi_typeof");
  if (type != napi_number)
    ThrowInvalidRequest(label + " must be a number");
  double result = 0;
  CheckNapi(env, napi_get_value_double(env, value, &result),
            "napi_get_value_double");
  if (!std::isfinite(result))
    ThrowInvalidRequest(label + " must be finite");
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

bool IsLowerHex(const std::string &value, size_t length) {
  if (value.size() != length)
    return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char byte) {
    return (byte >= '0' && byte <= '9') ||
           (byte >= 'a' && byte <= 'f');
  });
}

Identity ReadIdentity(napi_env env, napi_value value,
                      const std::string &label) {
  RequireExactOwnKeys(
      env, value, {"volumeSerialHex", "fileIdHex"}, label);
  Identity result{
      ReadString(env, GetNamed(env, value, "volumeSerialHex"),
                 label + ".volumeSerialHex"),
      ReadString(env, GetNamed(env, value, "fileIdHex"),
                 label + ".fileIdHex")};
  if (!IsLowerHex(result.volume_serial_hex, 8) ||
      !IsLowerHex(result.file_id_hex, 32)) {
    ThrowInvalidRequest(label + " is not a canonical Windows identity");
  }
  return result;
}

bool IsValidTransactionId(const std::string &value) {
  if (value.empty() || value.size() > 80)
    return false;
  return std::all_of(value.begin(), value.end(), [](unsigned char byte) {
    return (byte >= 'A' && byte <= 'Z') ||
           (byte >= 'a' && byte <= 'z') ||
           (byte >= '0' && byte <= '9') || byte == '-';
  });
}

void ValidateTransactionId(const std::string &value) {
  if (!IsValidTransactionId(value))
    ThrowInvalidRequest("transactionId is not a valid opaque identifier");
}

bool IsValidLeaf(const std::string &value) {
  if (value.empty() || value == "." || value == "..")
    return false;
  const std::wstring wide = Utf8ToWide(value, "leaf");
  if (wide.empty() || wide.size() > 220 || wide.back() == L'.' ||
      wide.back() == L' ')
    return false;
  for (wchar_t character : wide) {
    if (character < 0x20 || character == L'\\' || character == L'/' ||
        character == L':' || character == L'*' || character == L'?' ||
        character == L'"' || character == L'<' || character == L'>' ||
        character == L'|') {
      return false;
    }
  }
  return true;
}

void ValidateLeaf(const std::string &value, const std::string &label) {
  if (!IsValidLeaf(value))
    ThrowInvalidRequest(label + " is not a valid Windows leaf name");
}

bool SameLeaf(const std::string &left, const std::string &right) {
  const std::wstring left_wide = Utf8ToWide(left, "leaf");
  const std::wstring right_wide = Utf8ToWide(right, "leaf");
  return ::CompareStringOrdinal(left_wide.data(),
                                static_cast<int>(left_wide.size()),
                                right_wide.data(),
                                static_cast<int>(right_wide.size()), TRUE) ==
         CSTR_EQUAL;
}

std::string PartialLeafForTransactionId(const std::string &transaction_id) {
  return ".fusionkit-local-subtitle-" + transaction_id + ".partial";
}

struct JournalNames {
  std::string open;
  std::string finalize;
  std::string rollback;
  std::string victim;
};

JournalNames DeriveJournalNames(const std::string &transaction_id) {
  const std::string base =
      PartialLeafForTransactionId(transaction_id) + ".fusionkit-overwrite";
  JournalNames result{base + ".open", base + ".finalize",
                      base + ".rollback", base + ".victim"};
  ValidateLeaf(result.open, "open recovery journal");
  ValidateLeaf(result.finalize, "finalize recovery journal");
  ValidateLeaf(result.rollback, "rollback recovery journal");
  ValidateLeaf(result.victim, "victim recovery leaf");
  return result;
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
  (void)ExtendedAbsolutePath(result.directory_path);
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
  if (result.partial_leaf != PartialLeafForTransactionId(result.transaction_id))
    ThrowInvalidRequest("partialLeaf does not match transactionId");
  if (SameLeaf(result.partial_leaf, result.final_leaf))
    ThrowInvalidRequest("partialLeaf and finalLeaf must be different");
  const JournalNames names = DeriveJournalNames(result.transaction_id);
  for (const std::string *reserved :
       {&names.open, &names.finalize, &names.rollback, &names.victim}) {
    if (SameLeaf(*reserved, result.final_leaf))
      ThrowInvalidRequest("finalLeaf collides with a recovery leaf");
  }
  result.expected_partial_identity =
      ReadIdentity(env, GetNamed(env, value, "expectedPartialIdentity"),
                   "expectedPartialIdentity");
  const uint64_t byte_size = ReadSafeInteger(
      env, GetNamed(env, value, "expectedByteSize"), "expectedByteSize", false);
  if (byte_size > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()))
    ThrowInvalidRequest("expectedByteSize is too large");
  result.expected_byte_size = static_cast<int64_t>(byte_size);
  return result;
}

RecoveryRequest ReadRecoveryRequest(napi_env env, napi_value value) {
  RequireExactOwnKeys(env, value,
                      {"directoryPath", "expectedDirectoryIdentity",
                       "transactionId", "decision"},
                      "overwrite recovery request");
  RecoveryRequest result;
  result.directory_path =
      ReadString(env, GetNamed(env, value, "directoryPath"), "directoryPath");
  (void)ExtendedAbsolutePath(result.directory_path);
  result.expected_directory_identity =
      ReadIdentity(env, GetNamed(env, value, "expectedDirectoryIdentity"),
                   "expectedDirectoryIdentity");
  result.transaction_id =
      ReadString(env, GetNamed(env, value, "transactionId"), "transactionId");
  ValidateTransactionId(result.transaction_id);
  const std::string decision =
      ReadString(env, GetNamed(env, value, "decision"), "decision");
  if (decision == "finalize")
    result.decision = RecoveryDecision::kFinalize;
  else if (decision == "rollback")
    result.decision = RecoveryDecision::kRollback;
  else
    ThrowInvalidRequest("decision must be finalize or rollback");
  return result;
}

UniqueHandle OpenAndVerifyDirectory(const std::string &directory_path,
                                    const Identity &expected_identity) {
  const std::wstring path = ExtendedAbsolutePath(directory_path);
  HANDLE handle = ::CreateFileW(
      path.c_str(),
      FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | DELETE |
          SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (handle == INVALID_HANDLE_VALUE)
    ThrowWindows("CreateFileW(directoryPath)", ::GetLastError());
  UniqueHandle result(handle);
  const FileProof proof = ProofFromHandle(handle, "directoryPath");
  if (!proof.directory)
    throw NativeError(kFilesystemCode,
                      "directoryPath is not a directory object");
  if (!SameIdentity(proof.identity, expected_identity)) {
    throw NativeError(kFilesystemCode,
                      "directoryPath identity changed before transaction access");
  }
  return result;
}

UniqueHandle OpenAndVerifyDirectory(const Request &request) {
  return OpenAndVerifyDirectory(request.directory_path,
                                request.expected_directory_identity);
}

UniqueHandle OpenAndVerifyDirectory(const RecoveryRequest &request) {
  return OpenAndVerifyDirectory(request.directory_path,
                                request.expected_directory_identity);
}

struct RelativeOpen {
  UniqueHandle handle;
  bool missing = false;
};

RelativeOpen OpenRelative(HANDLE directory, const std::string &leaf,
                          ACCESS_MASK access, ULONG disposition,
                          bool allow_missing) {
  ValidateLeaf(leaf, "relative leaf");
  std::wstring wide = Utf8ToWide(leaf, "relative leaf");
  if (wide.size() >
      static_cast<size_t>(std::numeric_limits<USHORT>::max() /
                          sizeof(wchar_t))) {
    ThrowInvalidRequest("the relative leaf is too long");
  }
  UNICODE_STRING name{};
  name.Buffer = wide.data();
  name.Length = static_cast<USHORT>(wide.size() * sizeof(wchar_t));
  name.MaximumLength = name.Length;
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = directory;
  attributes.ObjectName = &name;
  attributes.Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE;
  IO_STATUS_BLOCK status_block{};
  HANDLE child = INVALID_HANDLE_VALUE;
  const NTSTATUS status = GetNtApi().create_file(
      &child, access | SYNCHRONIZE, &attributes, &status_block, nullptr,
      FILE_ATTRIBUTE_NORMAL,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, disposition,
      FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT |
          FILE_SYNCHRONOUS_IO_NONALERT,
      nullptr, 0);
  if (!NtSucceeded(status)) {
    if (allow_missing && IsMissingStatus(status))
      return RelativeOpen{UniqueHandle(), true};
    ThrowNt(
        (access & FILE_WRITE_DATA) != 0
            ? "NtCreateFile(relative journal leaf)"
            : "NtCreateFile(relative leaf)",
        status);
  }
  UniqueHandle result(child);
  const FileProof proof = ProofFromHandle(child, "relative leaf");
  if (proof.directory)
    throw NativeError(kFilesystemCode,
                      "the relative leaf is not a regular file");
  return RelativeOpen{std::move(result), false};
}

RelativeOpen TryOpenLeaf(HANDLE directory, const std::string &leaf,
                         ACCESS_MASK access = FILE_READ_ATTRIBUTES | DELETE) {
  return OpenRelative(directory, leaf, access, FILE_OPEN, true);
}

RelativeOpen TryOpenLeafFor(HANDLE directory, const std::string &leaf,
                            const std::string &label) {
  try {
    return TryOpenLeaf(directory, leaf);
  } catch (const NativeError &error) {
    throw NativeError(error.code(), label + ": " + error.what());
  }
}

UniqueHandle OpenRequiredLeaf(HANDLE directory, const std::string &leaf,
                              ACCESS_MASK access =
                                  FILE_READ_ATTRIBUTES | DELETE) {
  RelativeOpen opened = OpenRelative(directory, leaf, access, FILE_OPEN, false);
  return std::move(opened.handle);
}

void RequireAbsent(HANDLE directory, const std::string &leaf,
                   const std::string &label) {
  RelativeOpen opened;
  try {
    opened = TryOpenLeaf(directory, leaf,
                         FILE_READ_ATTRIBUTES | DELETE);
  } catch (const NativeError &error) {
    throw NativeError(error.code(), label + ": " + error.what());
  }
  if (!opened.missing)
    throw NativeError(kFilesystemCode, label + " is no longer absent");
}

FileProof RequireNamedIdentity(HANDLE directory, const std::string &leaf,
                               const Identity &expected,
                               const std::string &label,
                               const int64_t *expected_size = nullptr) {
  UniqueHandle handle;
  try {
    handle = OpenRequiredLeaf(directory, leaf);
  } catch (const NativeError &error) {
    throw NativeError(error.code(), label + ": " + error.what());
  }
  const FileProof proof = ProofFromHandle(handle.get(), label);
  RequireRegularIdentity(proof, expected, label, expected_size);
  return proof;
}

UniqueHandle OpenAndVerifyPartial(HANDLE directory, const Request &request) {
  UniqueHandle result = OpenRequiredLeaf(
      directory, request.partial_leaf, FILE_READ_ATTRIBUTES | DELETE);
  const FileProof proof = ProofFromHandle(result.get(), "partial leaf");
  RequireRegularIdentity(proof, request.expected_partial_identity,
                         "partial leaf", &request.expected_byte_size);
  RequireSingleLink(proof, "partial leaf");
  const FileProof named =
      RequireNamedIdentity(directory, request.partial_leaf,
                           request.expected_partial_identity, "partial leaf",
                           &request.expected_byte_size);
  RequireSingleLink(named, "partial leaf");
  return result;
}

struct RenameInformation {
  ULONG flags;
  HANDLE root_directory;
  ULONG file_name_length;
  wchar_t file_name[1];
};

struct LinkInformation {
  BOOLEAN replace_if_exists;
#if defined(_WIN64)
  unsigned char padding[7];
#else
  unsigned char padding[3];
#endif
  HANDLE root_directory;
  ULONG file_name_length;
  wchar_t file_name[1];
};

struct DispositionInformation {
  ULONG flags;
};

template <typename Header>
std::vector<unsigned char> BuildRelativeInformation(
    HANDLE directory, const std::string &leaf) {
  const std::wstring wide = Utf8ToWide(leaf, "relative target leaf");
  const size_t name_bytes = wide.size() * sizeof(wchar_t);
  std::vector<unsigned char> bytes(offsetof(Header, file_name) + name_bytes);
  Header *header = reinterpret_cast<Header *>(bytes.data());
  std::memset(header, 0, offsetof(Header, file_name));
  header->root_directory = directory;
  header->file_name_length = static_cast<ULONG>(name_bytes);
  std::memcpy(header->file_name, wide.data(), name_bytes);
  return bytes;
}

void RenameRelative(HANDLE source, HANDLE directory,
                    const std::string &target_leaf, bool replace) {
  std::vector<unsigned char> bytes =
      BuildRelativeInformation<RenameInformation>(directory, target_leaf);
  auto *info = reinterpret_cast<RenameInformation *>(bytes.data());
  info->flags =
      replace ? kRenameReplaceIfExists | kRenamePosixSemantics : 0;
  IO_STATUS_BLOCK status_block{};
  const NTSTATUS status = GetNtApi().set_information_file(
      source, &status_block, info, static_cast<ULONG>(bytes.size()),
      kFileRenameInformationEx);
  if (!NtSucceeded(status))
    ThrowNt("NtSetInformationFile(FileRenameInformationEx)", status);
}

void CreateHardLinkRelative(HANDLE source, HANDLE directory,
                            const std::string &target_leaf) {
  std::vector<unsigned char> bytes =
      BuildRelativeInformation<LinkInformation>(directory, target_leaf);
  auto *info = reinterpret_cast<LinkInformation *>(bytes.data());
  info->replace_if_exists = FALSE;
  IO_STATUS_BLOCK status_block{};
  const NTSTATUS status = GetNtApi().set_information_file(
      source, &status_block, info, static_cast<ULONG>(bytes.size()),
      kFileLinkInformation);
  if (!NtSucceeded(status))
    ThrowNt("NtSetInformationFile(FileLinkInformation)", status);
}

void DeleteOpenedLink(HANDLE handle, const std::string &label) {
  DispositionInformation info{kDispositionDelete |
                              kDispositionPosixSemantics |
                              kDispositionIgnoreReadonly};
  IO_STATUS_BLOCK status_block{};
  const NTSTATUS status = GetNtApi().set_information_file(
      handle, &status_block, &info, sizeof(info),
      kFileDispositionInformationEx);
  if (!NtSucceeded(status))
    ThrowNt("NtSetInformationFile(" + label + " disposition)", status);
}

void RequireZeroLinks(HANDLE handle, const std::string &label) {
  const FileProof proof = ProofFromHandle(handle, label);
  if (proof.links != 0)
    throw NativeError(kFilesystemCode, label + " cleanup is still pending");
}

constexpr unsigned char kJournalMagic[] = {'F', 'K', 'O', 'W', 'T', 'X', 'N',
                                            'W'};

struct JournalRecord {
  Request request;
  bool victim_existed = false;
  Identity victim_identity;
};

struct OpenedJournal {
  UniqueHandle handle;
  Identity identity;
  JournalRecord record;
};

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
  for (unsigned int shift = 0; shift < 32; shift += 8)
    bytes.push_back(static_cast<unsigned char>((value >> shift) & 0xffU));
}

void AppendU64(std::vector<unsigned char> &bytes, uint64_t value) {
  for (unsigned int shift = 0; shift < 64; shift += 8)
    bytes.push_back(static_cast<unsigned char>((value >> shift) & 0xffU));
}

void AppendString(std::vector<unsigned char> &bytes,
                  const std::string &value) {
  if (value.size() > std::numeric_limits<uint16_t>::max())
    ThrowInvalidRequest("the overwrite journal field is too long");
  AppendU16(bytes, static_cast<uint16_t>(value.size()));
  bytes.insert(bytes.end(), value.begin(), value.end());
}

void AppendIdentity(std::vector<unsigned char> &bytes,
                    const Identity &identity) {
  AppendString(bytes, identity.volume_serial_hex);
  AppendString(bytes, identity.file_id_hex);
}

std::vector<unsigned char> SerializeJournal(
    const Request &request, bool victim_existed,
    const Identity &victim_identity) {
  std::vector<unsigned char> bytes;
  bytes.reserve(384);
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
  std::string ReadString() {
    const size_t length = ReadU16();
    Require(length);
    const char *start =
        reinterpret_cast<const char *>(bytes_.data() + offset_);
    offset_ += length;
    return std::string(start, length);
  }
  Identity ReadIdentity() {
    return Identity{ReadString(), ReadString()};
  }
  bool complete() const { return offset_ == limit_; }

private:
  void Require(size_t length) const {
    if (length > limit_ - offset_)
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal is truncated");
  }
  const std::vector<unsigned char> &bytes_;
  size_t limit_ = 0;
  size_t offset_ = 0;
};

uint32_t DecodeTrailingU32(const std::vector<unsigned char> &bytes) {
  const size_t offset = bytes.size() - sizeof(uint32_t);
  uint32_t value = 0;
  for (unsigned int index = 0; index < sizeof(uint32_t); ++index)
    value |= static_cast<uint32_t>(bytes[offset + index]) << (index * 8U);
  return value;
}

bool IsCanonicalIdentity(const Identity &identity) {
  return IsLowerHex(identity.volume_serial_hex, 8) &&
         IsLowerHex(identity.file_id_hex, 32);
}

JournalRecord ParseJournal(const std::vector<unsigned char> &bytes,
                           const RecoveryRequest &recovery_request) {
  if (bytes.size() <= sizeof(kJournalMagic) + sizeof(uint32_t) * 2 ||
      bytes.size() > kMaximumJournalBytes)
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal size is invalid");
  const size_t content_length = bytes.size() - sizeof(uint32_t);
  if (DecodeTrailingU32(bytes) !=
      JournalChecksum(bytes.data(), content_length)) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal checksum is invalid");
  }
  JournalCursor cursor(bytes, content_length);
  for (unsigned char expected : kJournalMagic) {
    if (cursor.ReadU8() != expected)
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal magic is invalid");
  }
  if (cursor.ReadU32() != kJournalVersion)
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal version is invalid");
  const uint8_t victim_flag = cursor.ReadU8();
  if (victim_flag > 1U)
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal victim flag is invalid");
  for (int index = 0; index < 7; ++index) {
    if (cursor.ReadU8() != 0U)
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal is malformed");
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
      !IsValidLeaf(partial_leaf) || !IsValidLeaf(final_leaf) ||
      SameLeaf(partial_leaf, final_leaf) ||
      !IsCanonicalIdentity(partial_identity) ||
      (victim_flag == 1U && !IsCanonicalIdentity(victim_identity)) ||
      expected_byte_size == 0 ||
      expected_byte_size >
          static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal does not match the recovery request");
  }
  Request request;
  request.directory_path = recovery_request.directory_path;
  request.expected_directory_identity = directory_identity;
  request.transaction_id = transaction_id;
  request.partial_leaf = partial_leaf;
  request.final_leaf = final_leaf;
  request.expected_partial_identity = partial_identity;
  request.expected_byte_size = static_cast<int64_t>(expected_byte_size);
  return JournalRecord{std::move(request), victim_flag == 1U,
                       victim_identity};
}

void WriteAll(HANDLE handle, const std::vector<unsigned char> &bytes) {
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD written = 0;
    const DWORD remaining = static_cast<DWORD>(
        std::min(bytes.size() - offset,
                 static_cast<size_t>(std::numeric_limits<DWORD>::max())));
    if (!::WriteFile(handle, bytes.data() + offset, remaining, &written,
                     nullptr)) {
      ThrowWindows("WriteFile(overwrite journal)", ::GetLastError());
    }
    if (written == 0)
      throw NativeError(kFilesystemCode,
                        "WriteFile(overwrite journal) made no progress");
    offset += written;
  }
}

void FlushJournal(HANDLE handle) {
  IO_STATUS_BLOCK status_block{};
  const NTSTATUS status =
      GetNtApi().flush_buffers_file(handle, &status_block);
  if (!NtSucceeded(status))
    ThrowNt("NtFlushBuffersFile(overwrite journal)", status);
}

std::vector<unsigned char> ReadJournalBytes(HANDLE handle,
                                             int64_t byte_size) {
  if (byte_size <= 0 ||
      byte_size > static_cast<int64_t>(kMaximumJournalBytes)) {
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal size is invalid");
  }
  LARGE_INTEGER zero{};
  if (!::SetFilePointerEx(handle, zero, nullptr, FILE_BEGIN))
    ThrowWindows("SetFilePointerEx(overwrite journal)", ::GetLastError());
  std::vector<unsigned char> bytes(static_cast<size_t>(byte_size));
  size_t offset = 0;
  while (offset < bytes.size()) {
    DWORD read = 0;
    if (!::ReadFile(handle, bytes.data() + offset,
                    static_cast<DWORD>(bytes.size() - offset), &read,
                    nullptr)) {
      ThrowWindows("ReadFile(overwrite journal)", ::GetLastError());
    }
    if (read == 0)
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal is truncated");
    offset += read;
  }
  return bytes;
}

OpenedJournal OpenAndValidateJournal(HANDLE directory,
                                     const std::string &leaf,
                                     const RecoveryRequest &request) {
  UniqueHandle handle;
  try {
    handle = OpenRequiredLeaf(
        directory, leaf, kJournalAccess);
  } catch (const NativeError &error) {
    throw NativeError(error.code(),
                      std::string("recovery journal initial open: ") +
                          error.what());
  }
  const FileProof proof = ProofFromHandle(handle.get(), "overwrite journal");
  if (proof.directory || proof.links != 1)
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal is not an owned regular file");
  FileProof named;
  try {
    named = RequireNamedIdentity(directory, leaf, proof.identity,
                                 "named overwrite recovery journal");
  } catch (const NativeError &error) {
    throw NativeError(error.code(),
                      std::string("recovery journal named recheck: ") +
                          error.what());
  }
  if (named.links != 1)
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal link count changed");
  JournalRecord record =
      ParseJournal(ReadJournalBytes(handle.get(), proof.byte_size), request);
  return OpenedJournal{std::move(handle), proof.identity, std::move(record)};
}

UniqueHandle CreateOpenJournal(HANDLE directory, const Request &request,
                               const JournalNames &names,
                               bool victim_existed,
                               const Identity &victim_identity) {
  RequireAbsent(directory, names.open, "open recovery journal");
  RequireAbsent(directory, names.finalize, "finalize recovery journal");
  RequireAbsent(directory, names.rollback, "rollback recovery journal");
  RequireAbsent(directory, names.victim, "victim recovery leaf");
  RelativeOpen opened = OpenRelative(
      directory, names.open, kJournalAccess, FILE_CREATE, false);
  UniqueHandle result = std::move(opened.handle);
  try {
    WriteAll(result.get(),
             SerializeJournal(request, victim_existed, victim_identity));
    FlushJournal(result.get());
    return result;
  } catch (...) {
    const std::exception_ptr failure = std::current_exception();
    try {
      DeleteOpenedLink(result.get(), "failed overwrite journal");
      RequireZeroLinks(result.get(), "failed overwrite journal");
    } catch (...) {
      throw;
    }
    std::rethrow_exception(failure);
  }
}

void VerifyNamedJournal(HANDLE directory, const std::string &leaf,
                        HANDLE journal, const Identity &identity) {
  const FileProof pinned = ProofFromHandle(journal, "pinned overwrite journal");
  RequireRegularIdentity(pinned, identity, "pinned overwrite journal");
  const FileProof named =
      RequireNamedIdentity(directory, leaf, identity,
                           "named overwrite recovery journal");
  if (pinned.links != 1 || named.links != 1)
    throw NativeError(kFilesystemCode,
                      "the overwrite recovery journal link count changed");
}

void RenameOwnedJournal(HANDLE directory, HANDLE journal,
                        const Identity &identity, const std::string &from,
                        const std::string &to) {
  VerifyNamedJournal(directory, from, journal, identity);
  RequireAbsent(directory, to, "terminal recovery journal");
  RenameRelative(journal, directory, to, false);
}

void RemoveOwnedJournal(HANDLE directory, HANDLE journal,
                        const Identity &identity, const std::string &leaf) {
  RelativeOpen named = TryOpenLeaf(directory, leaf);
  if (!named.missing) {
    const FileProof proof =
        ProofFromHandle(named.handle.get(), "named overwrite journal");
    RequireRegularIdentity(proof, identity, "named overwrite journal");
    if (proof.links != 1)
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal link count changed");
    DeleteOpenedLink(named.handle.get(), "overwrite journal");
  } else {
    const FileProof pinned =
        ProofFromHandle(journal, "pinned overwrite journal");
    if (pinned.links != 0)
      throw NativeError(kFilesystemCode,
                        "the overwrite recovery journal name is missing");
  }
  MaybeInjectTestFault("journal_after_unlink_before_sync");
  RequireZeroLinks(journal, "overwrite recovery journal");
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
  kFinalizePendingAck,
  kRollbackPendingAck,
  kFinalized,
  kRolledBack,
};

class Transaction final {
public:
  Transaction(UniqueHandle directory, UniqueHandle new_file, Request request,
              bool victim_existed, Identity victim_identity,
              UniqueHandle victim)
      : directory_(std::move(directory)), new_file_(std::move(new_file)),
        victim_(std::move(victim)), request_(std::move(request)),
        victim_identity_(std::move(victim_identity)),
        journal_names_(DeriveJournalNames(request_.transaction_id)),
        victim_existed_(victim_existed),
        phase_(victim_existed ? Phase::kPreparedExisting
                              : Phase::kPreparedAbsent) {}

  Transaction(const Transaction &) = delete;
  Transaction &operator=(const Transaction &) = delete;
  ~Transaction() {
    BestEffortTerminalConvergence();
    CloseHandlesIgnoringErrors();
  }

  const Identity &expected_final_identity() const {
    return request_.expected_partial_identity;
  }

  void PrepareJournal() {
    if (phase_ != Phase::kPreparedExisting &&
        phase_ != Phase::kPreparedAbsent)
      ThrowInvalidState("the overwrite transaction cannot prepare a journal");
    journal_ = CreateOpenJournal(
        directory_.get(), request_, journal_names_,
        phase_ == Phase::kPreparedExisting, victim_identity_);
    journal_identity_ =
        IdentityFromHandle(journal_.get());
  }

  void CommitBegin() {
    if (!journal_.valid())
      ThrowInvalidState("the overwrite transaction journal is unavailable");
    VerifyNewPartial();
    if (phase_ == Phase::kPreparedExisting) {
      VerifyVictimAtFinal();
      RequireAbsent(directory_.get(), journal_names_.victim,
                    "victim recovery leaf");
      CreateHardLinkRelative(victim_.get(), directory_.get(),
                             journal_names_.victim);
      try {
        MaybeInjectTestFault("begin_after_victim_backup");
        RenameRelative(new_file_.get(), directory_.get(),
                       request_.final_leaf, true);
      } catch (...) {
        const std::exception_ptr failure = std::current_exception();
        UniqueHandle backup =
            OpenRequiredLeaf(directory_.get(), journal_names_.victim);
        const FileProof proof =
            ProofFromHandle(backup.get(), "begin victim backup");
        RequireRegularIdentity(proof, victim_identity_,
                               "begin victim backup");
        DeleteOpenedLink(backup.get(), "begin victim backup");
        std::rethrow_exception(failure);
      }
      phase_ = Phase::kOpenExisting;
      MaybeInjectTestFault("begin_after_namespace");
      return;
    }
    RequireAbsent(directory_.get(), request_.final_leaf, "final leaf");
    RenameRelative(new_file_.get(), directory_.get(), request_.final_leaf,
                   false);
    phase_ = Phase::kOpenAbsent;
    MaybeInjectTestFault("begin_after_namespace");
  }

  void Finalize() {
    TerminalGuard guard(*this);
    if (phase_ == Phase::kFinalized)
      return;
    if (phase_ == Phase::kFinalizePendingAck) {
      VerifyFinalizeCleanup();
      return;
    }
    if (phase_ == Phase::kRolledBack ||
        phase_ == Phase::kRollbackIntentExisting ||
        phase_ == Phase::kRollbackIntentAbsent ||
        phase_ == Phase::kRollbackCleanupExisting ||
        phase_ == Phase::kRollbackCleanupAbsent ||
        phase_ == Phase::kRollbackPendingAck)
      ThrowInvalidState("a rolled-back transaction cannot be finalized");
    if (phase_ == Phase::kOpenExisting) {
      VerifyOpenExisting();
      ArmFinalize(Phase::kFinalizeIntentExisting);
    } else if (phase_ == Phase::kOpenAbsent) {
      VerifyOpenAbsent();
      ArmFinalize(Phase::kFinalizeIntentAbsent);
    } else if (phase_ != Phase::kFinalizeIntentExisting &&
             phase_ != Phase::kFinalizeIntentAbsent &&
             phase_ != Phase::kFinalizeCleanupExisting &&
             phase_ != Phase::kFinalizeCleanupAbsent)
      ThrowInvalidState("the overwrite transaction is not open");

    if (phase_ == Phase::kFinalizeIntentExisting ||
        phase_ == Phase::kFinalizeIntentAbsent)
      ConvergeFinalizeNamespace();
    CompleteFinalizeCleanup();
  }

  void Rollback() {
    TerminalGuard guard(*this);
    if (phase_ == Phase::kRolledBack)
      return;
    if (phase_ == Phase::kRollbackPendingAck) {
      VerifyRollbackCleanup();
      return;
    }
    if (phase_ == Phase::kFinalized ||
        phase_ == Phase::kFinalizePendingAck)
      ThrowInvalidState("a finalized transaction cannot be rolled back");
    if (phase_ == Phase::kFinalizeIntentExisting ||
        phase_ == Phase::kFinalizeIntentAbsent ||
        phase_ == Phase::kFinalizeCleanupExisting ||
        phase_ == Phase::kFinalizeCleanupAbsent)
      ThrowInvalidState("a finalizing transaction cannot be rolled back");
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
        phase_ == Phase::kRollbackIntentAbsent)
      ConvergeRollbackNamespace();
    CompleteRollbackCleanup();
  }

  void Acknowledge() {
    TerminalGuard guard(*this);
    if (phase_ == Phase::kFinalized || phase_ == Phase::kRolledBack)
      return;
    if (phase_ == Phase::kFinalizePendingAck) {
      VerifyFinalizeCleanup();
      RequireAbsent(directory_.get(), journal_names_.open,
                    "open recovery journal");
      RequireAbsent(directory_.get(), journal_names_.rollback,
                    "rollback recovery journal");
      RemoveOwnedJournal(directory_.get(), journal_.get(), journal_identity_,
                         journal_names_.finalize);
      phase_ = Phase::kFinalized;
      CloseHandlesIgnoringErrors();
      return;
    }
    if (phase_ == Phase::kRollbackPendingAck) {
      VerifyRollbackCleanup();
      RequireAbsent(directory_.get(), journal_names_.open,
                    "open recovery journal");
      RequireAbsent(directory_.get(), journal_names_.finalize,
                    "finalize recovery journal");
      RemoveOwnedJournal(directory_.get(), journal_.get(), journal_identity_,
                         journal_names_.rollback);
      phase_ = Phase::kRolledBack;
      CloseHandlesIgnoringErrors();
      return;
    }
    ThrowInvalidState("the overwrite transaction has not settled");
  }

private:
  class TerminalGuard final {
  public:
    explicit TerminalGuard(Transaction &transaction)
        : transaction_(transaction) {
      if (transaction_.terminal_in_progress_)
        ThrowInvalidState("a terminal transaction operation is in progress");
      transaction_.terminal_in_progress_ = true;
    }
    ~TerminalGuard() { transaction_.terminal_in_progress_ = false; }

  private:
    Transaction &transaction_;
  };

  void VerifyNewPartial() const {
    const FileProof pinned =
        ProofFromHandle(new_file_.get(), "pinned partial");
    RequireRegularIdentity(pinned, request_.expected_partial_identity,
                           "pinned partial", &request_.expected_byte_size);
    RequireSingleLink(pinned, "pinned partial");
    const FileProof named =
        RequireNamedIdentity(directory_.get(), request_.partial_leaf,
                             request_.expected_partial_identity,
                             "partial leaf", &request_.expected_byte_size);
    RequireSingleLink(named, "partial leaf");
  }

  void VerifyVictimAtFinal() const {
    const FileProof victim =
        RequireNamedIdentity(directory_.get(), request_.final_leaf,
                             victim_identity_, "overwrite victim");
    if (SameIdentity(victim_identity_,
                     request_.expected_partial_identity)) {
      throw NativeError(kFilesystemCode,
                        "overwrite victim aliases the partial file");
    }
  }

  void VerifyOpenExisting() const {
    const FileProof installed =
        RequireNamedIdentity(directory_.get(), request_.final_leaf,
                             request_.expected_partial_identity,
                             "installed final leaf",
                             &request_.expected_byte_size);
    RequireSingleLink(installed, "installed final leaf");
    const FileProof backup =
        RequireNamedIdentity(directory_.get(), journal_names_.victim,
                             victim_identity_, "recoverable overwrite victim");
    RequireSingleLink(backup, "recoverable overwrite victim");
  }

  void VerifyOpenAbsent() const {
    const FileProof installed =
        RequireNamedIdentity(directory_.get(), request_.final_leaf,
                             request_.expected_partial_identity,
                             "installed final leaf",
                             &request_.expected_byte_size);
    RequireSingleLink(installed, "installed final leaf");
    RequireAbsent(directory_.get(), request_.partial_leaf, "partial leaf");
    RequireAbsent(directory_.get(), journal_names_.victim,
                  "victim recovery leaf");
  }

  void VerifyFinalizeCleanup() const {
    const FileProof installed =
        RequireNamedIdentity(directory_.get(), request_.final_leaf,
                             request_.expected_partial_identity,
                             "finalized overwrite leaf",
                             &request_.expected_byte_size);
    RequireSingleLink(installed, "finalized overwrite leaf");
    RequireAbsent(directory_.get(), request_.partial_leaf,
                  "finalized partial leaf");
    RequireAbsent(directory_.get(), journal_names_.victim,
                  "finalized victim recovery leaf");
  }

  void ArmFinalize(Phase phase) {
    RequireAbsent(directory_.get(), journal_names_.rollback,
                  "rollback recovery journal");
    RenameOwnedJournal(directory_.get(), journal_.get(), journal_identity_,
                       journal_names_.open, journal_names_.finalize);
    phase_ = phase;
    VerifyNamedJournal(directory_.get(), journal_names_.finalize,
                       journal_.get(), journal_identity_);
    FlushJournal(journal_.get());
    MaybeInjectTestFault("finalize_after_intent_sync");
  }

  void ConvergeFinalizeNamespace() {
    MaybeInjectTestFault("finalize_before_namespace");
    if (phase_ == Phase::kFinalizeIntentExisting) {
      UniqueHandle backup =
          OpenRequiredLeaf(directory_.get(), journal_names_.victim);
      const FileProof proof =
          ProofFromHandle(backup.get(), "overwrite victim backup");
      RequireRegularIdentity(proof, victim_identity_,
                             "overwrite victim backup");
      DeleteOpenedLink(backup.get(), "overwrite victim backup");
      phase_ = Phase::kFinalizeCleanupExisting;
      MaybeInjectTestFault("finalize_after_namespace_sync");
    } else if (phase_ == Phase::kFinalizeIntentAbsent) {
      phase_ = Phase::kFinalizeCleanupAbsent;
    } else {
      ThrowInvalidState("the overwrite transaction has no finalize intent");
    }
  }

  void CompleteFinalizeCleanup() {
    VerifyFinalizeCleanup();
    MaybeInjectTestFault("finalize_before_ack");
    phase_ = Phase::kFinalizePendingAck;
  }

  void ArmRollback(Phase phase) {
    RequireAbsent(directory_.get(), journal_names_.finalize,
                  "finalize recovery journal");
    RenameOwnedJournal(directory_.get(), journal_.get(), journal_identity_,
                       journal_names_.open, journal_names_.rollback);
    phase_ = phase;
    VerifyNamedJournal(directory_.get(), journal_names_.rollback,
                       journal_.get(), journal_identity_);
    FlushJournal(journal_.get());
    MaybeInjectTestFault("rollback_after_intent_sync");
  }

  void ConvergeRollbackNamespace() {
    MaybeInjectTestFault("rollback_before_namespace");
    if (phase_ == Phase::kRollbackIntentExisting) {
      UniqueHandle backup =
          OpenRequiredLeaf(directory_.get(), journal_names_.victim);
      const FileProof proof =
          ProofFromHandle(backup.get(), "rollback victim backup");
      RequireRegularIdentity(proof, victim_identity_,
                             "rollback victim backup");
      RenameRelative(backup.get(), directory_.get(), request_.final_leaf,
                     true);
      phase_ = Phase::kRollbackCleanupExisting;
    } else if (phase_ == Phase::kRollbackIntentAbsent) {
      UniqueHandle installed =
          OpenRequiredLeaf(directory_.get(), request_.final_leaf);
      const FileProof proof =
          ProofFromHandle(installed.get(), "rollback installed file");
      RequireRegularIdentity(proof, request_.expected_partial_identity,
                             "rollback installed file",
                             &request_.expected_byte_size);
      DeleteOpenedLink(installed.get(), "rollback installed file");
      phase_ = Phase::kRollbackCleanupAbsent;
    } else {
      ThrowInvalidState("the overwrite transaction has no rollback intent");
    }
    MaybeInjectTestFault("rollback_after_namespace_sync");
  }

  void CompleteRollbackCleanup() {
    VerifyRollbackCleanup();
    phase_ = Phase::kRollbackPendingAck;
  }

  void VerifyRollbackCleanup() const {
    const bool completing = phase_ == Phase::kRollbackCleanupExisting ||
                            phase_ == Phase::kRollbackCleanupAbsent;
    if (phase_ == Phase::kRollbackCleanupExisting ||
        (phase_ == Phase::kRollbackPendingAck && victim_existed_)) {
      const FileProof restored =
          RequireNamedIdentity(directory_.get(), request_.final_leaf,
                               victim_identity_, "restored overwrite victim");
      RequireSingleLink(restored, "restored overwrite victim");
    } else if (phase_ == Phase::kRollbackCleanupAbsent ||
               (phase_ == Phase::kRollbackPendingAck && !victim_existed_)) {
      RequireAbsent(directory_.get(), request_.final_leaf,
                    "restored final leaf");
    } else {
      ThrowInvalidState("the overwrite transaction has no rollback cleanup");
    }
    RequireAbsent(directory_.get(), request_.partial_leaf,
                  "rollback partial leaf");
    RequireAbsent(directory_.get(), journal_names_.victim,
                  "rollback victim recovery leaf");
    if (completing)
      MaybeInjectTestFault("rollback_before_cleanup_unlink");
    RequireZeroLinks(new_file_.get(), "rollback partial");
    if (completing) {
      MaybeInjectTestFault("rollback_after_cleanup_sync");
      MaybeInjectTestFault("rollback_before_ack");
    }
  }

  void BestEffortTerminalConvergence() noexcept {
    try {
      if ((phase_ == Phase::kPreparedExisting ||
           phase_ == Phase::kPreparedAbsent) &&
          journal_.valid()) {
        RelativeOpen backup =
            TryOpenLeaf(directory_.get(), journal_names_.victim);
        if (!backup.missing)
          DeleteOpenedLink(backup.handle.get(), "prepared victim backup");
        RemoveOwnedJournal(directory_.get(), journal_.get(),
                           journal_identity_, journal_names_.open);
        return;
      }
      if (phase_ == Phase::kFinalizeIntentExisting ||
          phase_ == Phase::kFinalizeIntentAbsent ||
          phase_ == Phase::kFinalizeCleanupExisting ||
          phase_ == Phase::kFinalizeCleanupAbsent) {
        Finalize();
        return;
      }
      // An open journal has no durable terminal direction. Preserve it for
      // the main-process recovery owner instead of choosing rollback here.
      if (phase_ == Phase::kRollbackIntentExisting ||
          phase_ == Phase::kRollbackIntentAbsent ||
          phase_ == Phase::kRollbackCleanupExisting ||
          phase_ == Phase::kRollbackCleanupAbsent) {
        Rollback();
      }
    } catch (...) {
    }
  }

  void CloseHandlesIgnoringErrors() noexcept {
    journal_.CloseIgnoringErrors();
    victim_.CloseIgnoringErrors();
    new_file_.CloseIgnoringErrors();
    directory_.CloseIgnoringErrors();
  }

  UniqueHandle directory_;
  UniqueHandle new_file_;
  UniqueHandle victim_;
  Request request_;
  Identity victim_identity_;
  JournalNames journal_names_;
  bool victim_existed_ = false;
  UniqueHandle journal_;
  Identity journal_identity_;
  Phase phase_;
  bool terminal_in_progress_ = false;
};

enum class RecoveryState { kNotFound, kFinalized, kRolledBack };

void ArmRecoveryJournal(HANDLE directory, const JournalNames &names,
                        OpenedJournal &journal,
                        RecoveryDecision decision) {
  const std::string &target = decision == RecoveryDecision::kFinalize
                                  ? names.finalize
                                  : names.rollback;
  RenameOwnedJournal(directory, journal.handle.get(), journal.identity,
                     names.open, target);
  VerifyNamedJournal(directory, target, journal.handle.get(), journal.identity);
  FlushJournal(journal.handle.get());
  MaybeInjectTestFault(decision == RecoveryDecision::kFinalize
                           ? "finalize_after_intent_sync"
                           : "rollback_after_intent_sync");
}

void RecoverRollback(HANDLE directory, const Request &request,
                     const JournalNames &names,
                     OpenedJournal &journal) {
  UniqueHandle new_file;
  if (journal.record.victim_existed) {
    RelativeOpen final =
        TryOpenLeafFor(directory, request.final_leaf,
                       "rollback recovery final leaf");
    RelativeOpen partial =
        TryOpenLeafFor(directory, request.partial_leaf,
                       "rollback recovery partial leaf");
    RelativeOpen backup =
        TryOpenLeafFor(directory, names.victim,
                       "rollback recovery victim backup");
    if (final.missing)
      throw NativeError(kFilesystemCode,
                        "the rollback recovery final leaf is missing");
    const FileProof final_proof =
        ProofFromHandle(final.handle.get(), "rollback recovery final leaf");
    const bool final_is_victim =
        SameIdentity(final_proof.identity, journal.record.victim_identity);
    const bool final_is_new =
        SameIdentity(final_proof.identity, request.expected_partial_identity);
    const bool partial_is_new = !partial.missing &&
        SameIdentity(ProofFromHandle(partial.handle.get(),
                                     "rollback recovery partial leaf").identity,
                     request.expected_partial_identity);
    const bool backup_is_victim = !backup.missing &&
        SameIdentity(ProofFromHandle(backup.handle.get(),
                                     "rollback recovery victim backup").identity,
                     journal.record.victim_identity);

    if (final_is_victim && partial_is_new) {
      RequireRegularIdentity(final_proof, journal.record.victim_identity,
                             "rollback recovery victim");
      const FileProof partial_proof =
          ProofFromHandle(partial.handle.get(), "rollback recovery partial");
      RequireRegularIdentity(partial_proof,
                             request.expected_partial_identity,
                             "rollback recovery partial",
                             &request.expected_byte_size);
      RequireSingleLink(partial_proof, "rollback recovery partial");
      if (!backup.missing) {
        const FileProof backup_proof =
            ProofFromHandle(backup.handle.get(), "rollback recovery backup");
        RequireRegularIdentity(backup_proof, journal.record.victim_identity,
                               "rollback recovery backup");
        DeleteOpenedLink(backup.handle.get(), "rollback recovery backup");
      }
      new_file = std::move(partial.handle);
      DeleteOpenedLink(new_file.get(), "rollback recovery partial");
    } else if (final_is_new && partial.missing && backup_is_victim) {
      const FileProof backup_proof =
          ProofFromHandle(backup.handle.get(), "recovery victim backup");
      RequireRegularIdentity(final_proof, request.expected_partial_identity,
                             "recovery installed file",
                             &request.expected_byte_size);
      RequireRegularIdentity(backup_proof,
                             journal.record.victim_identity,
                             "recovery victim backup");
      new_file = std::move(final.handle);
      RenameRelative(backup.handle.get(), directory, request.final_leaf, true);
    } else if (final_is_victim && partial.missing && backup.missing) {
      RequireRegularIdentity(final_proof, journal.record.victim_identity,
                             "recovered overwrite victim");
    } else {
      throw NativeError(kFilesystemCode,
                        "the rollback recovery layout is not owned");
    }
    if (new_file.valid()) {
      RequireZeroLinks(new_file.get(), "recovery rollback partial");
      CloseHandleChecked(new_file, "recovery rollback partial");
    }
    CloseHandleChecked(final.handle, "rollback recovery final leaf");
    CloseHandleChecked(partial.handle, "rollback recovery partial leaf");
    CloseHandleChecked(backup.handle, "rollback recovery victim backup");
    const FileProof restored =
        RequireNamedIdentity(directory, request.final_leaf,
                             journal.record.victim_identity,
                             "recovered overwrite victim");
    RequireSingleLink(restored, "recovered overwrite victim");
  } else {
    RelativeOpen final =
        TryOpenLeafFor(directory, request.final_leaf,
                       "absent rollback recovery final leaf");
    RelativeOpen partial =
        TryOpenLeafFor(directory, request.partial_leaf,
                       "absent rollback recovery partial leaf");
    if (!final.missing && partial.missing) {
      const FileProof proof =
          ProofFromHandle(final.handle.get(), "recovery installed file");
      RequireRegularIdentity(proof, request.expected_partial_identity,
                             "recovery installed file",
                             &request.expected_byte_size);
      new_file = std::move(final.handle);
      DeleteOpenedLink(new_file.get(), "recovery installed file");
      RequireZeroLinks(new_file.get(), "recovery installed file");
    } else if (final.missing && !partial.missing) {
      const FileProof proof =
          ProofFromHandle(partial.handle.get(), "recovery partial file");
      RequireRegularIdentity(proof, request.expected_partial_identity,
                             "recovery partial file",
                             &request.expected_byte_size);
      RequireSingleLink(proof, "recovery partial file");
      new_file = std::move(partial.handle);
      DeleteOpenedLink(new_file.get(), "recovery partial file");
      RequireZeroLinks(new_file.get(), "recovery partial file");
    } else if (!final.missing || !partial.missing) {
      throw NativeError(kFilesystemCode,
                        "the absent rollback recovery layout is not owned");
    }
    if (new_file.valid()) {
      RequireZeroLinks(new_file.get(), "recovery rollback partial");
      CloseHandleChecked(new_file, "recovery rollback partial");
    }
    CloseHandleChecked(final.handle,
                       "absent rollback recovery final leaf");
    CloseHandleChecked(partial.handle,
                       "absent rollback recovery partial leaf");
  }
  RequireAbsent(directory, request.partial_leaf,
                "recovery partial leaf");
  RequireAbsent(directory, names.victim,
                "recovery victim leaf");
}

void RecoverFinalize(HANDLE directory, const Request &request,
                     const JournalNames &names,
                     OpenedJournal &journal) {
  RelativeOpen final =
      TryOpenLeafFor(directory, request.final_leaf,
                     "finalize recovery final leaf");
  RelativeOpen partial =
      TryOpenLeafFor(directory, request.partial_leaf,
                     "finalize recovery partial leaf");
  RelativeOpen backup =
      TryOpenLeafFor(directory, names.victim,
                     "finalize recovery victim backup");
  if (journal.record.victim_existed) {
    if (final.missing)
      throw NativeError(kFilesystemCode,
                        "the finalize recovery final leaf is missing");
    const FileProof final_proof =
        ProofFromHandle(final.handle.get(), "finalize recovery final leaf");
    const bool final_is_victim =
        SameIdentity(final_proof.identity, journal.record.victim_identity);
    const bool final_is_new =
        SameIdentity(final_proof.identity, request.expected_partial_identity);
    if (final_is_victim && !partial.missing) {
      RequireRegularIdentity(final_proof, journal.record.victim_identity,
                             "finalize recovery victim");
      const FileProof partial_proof =
          ProofFromHandle(partial.handle.get(), "finalize recovery partial");
      RequireRegularIdentity(partial_proof,
                             request.expected_partial_identity,
                             "finalize recovery partial",
                             &request.expected_byte_size);
      RequireSingleLink(partial_proof, "finalize recovery partial");
      if (!backup.missing) {
        const FileProof backup_proof =
            ProofFromHandle(backup.handle.get(), "finalize recovery backup");
        RequireRegularIdentity(backup_proof, journal.record.victim_identity,
                               "finalize recovery backup");
      }
      RenameRelative(partial.handle.get(), directory, request.final_leaf, true);
    } else if (!(final_is_new && partial.missing)) {
      throw NativeError(kFilesystemCode,
                        "the finalize recovery layout is not owned");
    }
    if (!backup.missing) {
      const FileProof backup_proof =
          ProofFromHandle(backup.handle.get(), "recovery victim backup");
      RequireRegularIdentity(backup_proof, journal.record.victim_identity,
                             "recovery victim backup");
      DeleteOpenedLink(backup.handle.get(), "recovery victim backup");
      RequireZeroLinks(backup.handle.get(), "recovery victim backup");
    }
  } else {
    if (final.missing && !partial.missing) {
      const FileProof partial_proof =
          ProofFromHandle(partial.handle.get(), "finalize recovery partial");
      RequireRegularIdentity(partial_proof,
                             request.expected_partial_identity,
                             "finalize recovery partial",
                             &request.expected_byte_size);
      RequireSingleLink(partial_proof, "finalize recovery partial");
      RenameRelative(partial.handle.get(), directory, request.final_leaf,
                     false);
    } else if (!final.missing && partial.missing) {
      const FileProof final_proof =
          ProofFromHandle(final.handle.get(), "finalize recovery final");
      RequireRegularIdentity(final_proof, request.expected_partial_identity,
                             "finalize recovery final",
                             &request.expected_byte_size);
    } else {
      throw NativeError(kFilesystemCode,
                        "the absent finalize recovery layout is not owned");
    }
    if (!backup.missing)
      throw NativeError(kFilesystemCode,
                        "the absent finalize recovery victim leaf exists");
  }

  CloseHandleChecked(final.handle, "finalize recovery final leaf");
  CloseHandleChecked(partial.handle, "finalize recovery partial leaf");
  CloseHandleChecked(backup.handle, "finalize recovery victim backup");
  const FileProof installed =
      RequireNamedIdentity(directory, request.final_leaf,
                           request.expected_partial_identity,
                           "recovery finalized overwrite leaf",
                           &request.expected_byte_size);
  RequireSingleLink(installed, "recovery finalized overwrite leaf");
  RequireAbsent(directory, request.partial_leaf,
                "recovery finalized partial leaf");
  RequireAbsent(directory, names.victim,
                "recovery finalized victim leaf");
}

RecoveryState RecoverTransaction(const RecoveryRequest &request) {
  UniqueHandle directory = OpenAndVerifyDirectory(request);
  const JournalNames names = DeriveJournalNames(request.transaction_id);
  RelativeOpen open;
  RelativeOpen finalize;
  RelativeOpen rollback;
  try {
    open = TryOpenLeaf(directory.get(), names.open);
    finalize = TryOpenLeaf(directory.get(), names.finalize);
    rollback = TryOpenLeaf(directory.get(), names.rollback);
  } catch (const NativeError &error) {
    throw NativeError(error.code(),
                      std::string("recovery journal lookup: ") + error.what());
  }
  const int journal_count = (!open.missing ? 1 : 0) +
                            (!finalize.missing ? 1 : 0) +
                            (!rollback.missing ? 1 : 0);
  if (journal_count > 1)
    throw NativeError(kFilesystemCode,
                      "multiple overwrite recovery journals exist");
  if (journal_count == 0)
    return RecoveryState::kNotFound;
  if (!open.missing) {
    OpenedJournal journal =
        OpenAndValidateJournal(directory.get(), names.open, request);
    ArmRecoveryJournal(directory.get(), names, journal, request.decision);
    if (request.decision == RecoveryDecision::kFinalize) {
      RecoverFinalize(directory.get(), journal.record.request, names, journal);
      return RecoveryState::kFinalized;
    }
    RecoverRollback(directory.get(), journal.record.request, names, journal);
    return RecoveryState::kRolledBack;
  }
  if (!finalize.missing) {
    if (request.decision != RecoveryDecision::kFinalize) {
      throw NativeError(kFilesystemCode,
                        "the durable finalize decision conflicts with the recovery request");
    }
    OpenedJournal journal =
        OpenAndValidateJournal(directory.get(), names.finalize, request);
    RecoverFinalize(directory.get(), journal.record.request, names, journal);
    return RecoveryState::kFinalized;
  }
  if (request.decision != RecoveryDecision::kRollback) {
    throw NativeError(kFilesystemCode,
                      "the durable rollback decision conflicts with the recovery request");
  }
  OpenedJournal journal =
      OpenAndValidateJournal(directory.get(), names.rollback, request);
  RecoverRollback(directory.get(), journal.record.request, names, journal);
  return RecoveryState::kRolledBack;
}

enum class AcknowledgeState { kNotFound, kAcknowledged };

void VerifyRecoveredFinalizeLayout(HANDLE directory,
                                   const JournalRecord &record,
                                   const JournalNames &names) {
  const FileProof installed =
      RequireNamedIdentity(directory, record.request.final_leaf,
                           record.request.expected_partial_identity,
                           "acknowledged finalized overwrite leaf",
                           &record.request.expected_byte_size);
  RequireSingleLink(installed, "acknowledged finalized overwrite leaf");
  RequireAbsent(directory, record.request.partial_leaf,
                "acknowledged finalized partial leaf");
  RequireAbsent(directory, names.victim,
                "acknowledged finalized victim leaf");
}

void VerifyRecoveredRollbackLayout(HANDLE directory,
                                   const JournalRecord &record,
                                   const JournalNames &names) {
  if (record.victim_existed) {
    const FileProof restored =
        RequireNamedIdentity(directory, record.request.final_leaf,
                             record.victim_identity,
                             "acknowledged restored overwrite victim");
    RequireSingleLink(restored, "acknowledged restored overwrite victim");
  } else {
    RequireAbsent(directory, record.request.final_leaf,
                  "acknowledged absent final leaf");
  }
  RequireAbsent(directory, record.request.partial_leaf,
                "acknowledged rollback partial leaf");
  RequireAbsent(directory, names.victim,
                "acknowledged rollback victim leaf");
}

AcknowledgeState AcknowledgeTransaction(const RecoveryRequest &request) {
  UniqueHandle directory = OpenAndVerifyDirectory(request);
  const JournalNames names = DeriveJournalNames(request.transaction_id);
  RelativeOpen open = TryOpenLeaf(directory.get(), names.open);
  RelativeOpen finalize = TryOpenLeaf(directory.get(), names.finalize);
  RelativeOpen rollback = TryOpenLeaf(directory.get(), names.rollback);
  const int journal_count = (!open.missing ? 1 : 0) +
                            (!finalize.missing ? 1 : 0) +
                            (!rollback.missing ? 1 : 0);
  if (journal_count > 1)
    throw NativeError(kFilesystemCode,
                      "multiple overwrite recovery journals exist");
  if (journal_count == 0)
    return AcknowledgeState::kNotFound;
  if (!open.missing)
    throw NativeError(kFilesystemCode,
                      "an open overwrite recovery journal cannot be acknowledged");

  const bool acknowledge_finalize =
      request.decision == RecoveryDecision::kFinalize;
  if (acknowledge_finalize && finalize.missing)
    throw NativeError(kFilesystemCode,
                      "the durable rollback decision conflicts with the acknowledgement request");
  if (!acknowledge_finalize && rollback.missing)
    throw NativeError(kFilesystemCode,
                      "the durable finalize decision conflicts with the acknowledgement request");
  const std::string &leaf =
      acknowledge_finalize ? names.finalize : names.rollback;
  OpenedJournal journal =
      OpenAndValidateJournal(directory.get(), leaf, request);
  if (acknowledge_finalize)
    VerifyRecoveredFinalizeLayout(directory.get(), journal.record, names);
  else
    VerifyRecoveredRollbackLayout(directory.get(), journal.record, names);
  RemoveOwnedJournal(directory.get(), journal.handle.get(), journal.identity,
                     leaf);
  return AcknowledgeState::kAcknowledged;
}

napi_value CreateString(napi_env env, const std::string &value) {
  napi_value result = nullptr;
  CheckNapi(env,
            napi_create_string_utf8(env, value.data(), value.size(), &result),
            "napi_create_string_utf8");
  return result;
}

napi_value CreateIdentity(napi_env env, const Identity &identity) {
  napi_value result = nullptr;
  CheckNapi(env, napi_create_object(env, &result), "napi_create_object");
  CheckNapi(env,
            napi_set_named_property(
                env, result, "volumeSerialHex",
                CreateString(env, identity.volume_serial_hex)),
            "napi_set_named_property(volumeSerialHex)");
  CheckNapi(env,
            napi_set_named_property(
                env, result, "fileIdHex",
                CreateString(env, identity.file_id_hex)),
            "napi_set_named_property(fileIdHex)");
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
  if (status != napi_ok || transaction == nullptr)
    ThrowInvalidState("overwrite transaction method has an invalid receiver");
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

napi_value AcknowledgeReceiptCallback(napi_env env,
                                      napi_callback_info info) {
  try {
    napi_value result = nullptr;
    CheckNapi(env, napi_get_undefined(env, &result), "napi_get_undefined");
    UnwrapTransaction(env, info)->Acknowledge();
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
  if (removed != built.transaction)
    throw NativeError(kInternalCode,
                      "the failed overwrite receipt lost its native state");
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
    napi_value acknowledge = nullptr;
    CheckNapi(env,
              napi_create_function(env, "finalize", NAPI_AUTO_LENGTH,
                                   FinalizeCallback, nullptr, &finalize),
              "napi_create_function(finalize)");
    CheckNapi(env,
              napi_create_function(env, "rollback", NAPI_AUTO_LENGTH,
                                   RollbackCallback, nullptr, &rollback),
              "napi_create_function(rollback)");
    CheckNapi(env,
              napi_create_function(env, "acknowledge", NAPI_AUTO_LENGTH,
                                   AcknowledgeReceiptCallback, nullptr,
                                   &acknowledge),
              "napi_create_function(acknowledge)");
    CheckNapi(env,
              napi_set_named_property(
                  env, receipt, "expectedFinalIdentity",
                  CreateIdentity(env, raw->expected_final_identity())),
              "napi_set_named_property(expectedFinalIdentity)");
    CheckNapi(env, napi_set_named_property(env, receipt, "finalize", finalize),
              "napi_set_named_property(finalize)");
    CheckNapi(env, napi_set_named_property(env, receipt, "rollback", rollback),
              "napi_set_named_property(rollback)");
    CheckNapi(env,
              napi_set_named_property(env, receipt, "acknowledge",
                                      acknowledge),
              "napi_set_named_property(acknowledge)");
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
    if (argc != 1)
      ThrowInvalidRequest("begin requires exactly one request argument");
    Request request = ReadRequest(env, argv[0]);
    UniqueHandle directory = OpenAndVerifyDirectory(request);
    UniqueHandle new_file =
        OpenAndVerifyPartial(directory.get(), request);
    RelativeOpen final =
        TryOpenLeaf(directory.get(), request.final_leaf);
    Identity victim_identity;
    UniqueHandle victim;
    if (!final.missing) {
      const FileProof proof =
          ProofFromHandle(final.handle.get(), "overwrite victim");
      if (proof.directory)
        throw NativeError(kFilesystemCode,
                          "overwrite victim is not a regular file");
      victim_identity = proof.identity;
      victim = std::move(final.handle);
      if (SameIdentity(victim_identity,
                       request.expected_partial_identity)) {
        throw NativeError(kFilesystemCode,
                          "overwrite victim aliases the partial file");
      }
    }
    auto transaction = std::make_unique<Transaction>(
        std::move(directory), std::move(new_file), std::move(request),
        !final.missing, std::move(victim_identity), std::move(victim));
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
  case RecoveryState::kFinalized:
    name = "finalized";
    break;
  case RecoveryState::kRolledBack:
    name = "rolled_back";
    break;
  }
  napi_value result = nullptr;
  CheckNapi(env, napi_create_object(env, &result), "napi_create_object");
  CheckNapi(env,
            napi_set_named_property(env, result, "state",
                                    CreateString(env, name)),
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
    return CreateRecoveryResult(
        env, RecoverTransaction(ReadRecoveryRequest(env, argv[0])));
  } catch (const NativeError &error) {
    ThrowToJavaScript(env, error);
    return nullptr;
  } catch (const std::exception &error) {
    ThrowToJavaScript(env, NativeError(kInternalCode, error.what()));
    return nullptr;
  }
}

napi_value CreateAcknowledgeResult(napi_env env, AcknowledgeState state) {
  const char *name = state == AcknowledgeState::kAcknowledged
                         ? "acknowledged"
                         : "not_found";
  napi_value result = nullptr;
  CheckNapi(env, napi_create_object(env, &result), "napi_create_object");
  CheckNapi(env,
            napi_set_named_property(env, result, "state",
                                    CreateString(env, name)),
            "napi_set_named_property(acknowledge state)");
  return result;
}

napi_value AcknowledgeCallback(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    CheckNapi(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr),
              "napi_get_cb_info");
    if (argc != 1)
      ThrowInvalidRequest("acknowledge requires exactly one request argument");
    return CreateAcknowledgeResult(
        env, AcknowledgeTransaction(ReadRecoveryRequest(env, argv[0])));
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
    napi_value acknowledge = nullptr;
    CheckNapi(env, napi_create_uint32(env, kProtocolVersion,
                                     &protocol_version),
              "napi_create_uint32");
    CheckNapi(env,
              napi_create_string_utf8(env, "win32", NAPI_AUTO_LENGTH,
                                      &platform),
              "napi_create_string_utf8(platform)");
    CheckNapi(env,
              napi_create_string_utf8(env, "x64", NAPI_AUTO_LENGTH,
                                      &architecture),
              "napi_create_string_utf8(architecture)");
    CheckNapi(env,
              napi_create_function(env, "begin", NAPI_AUTO_LENGTH,
                                   BeginCallback, nullptr, &begin),
              "napi_create_function(begin)");
    CheckNapi(env,
              napi_create_function(env, "recover", NAPI_AUTO_LENGTH,
                                   RecoverCallback, nullptr, &recover),
              "napi_create_function(recover)");
    CheckNapi(env,
              napi_create_function(env, "acknowledge", NAPI_AUTO_LENGTH,
                                   AcknowledgeCallback, nullptr, &acknowledge),
              "napi_create_function(acknowledge)");
    SetNamed(env, exports, "protocolVersion", protocol_version);
    SetNamed(env, exports, "platform", platform);
    SetNamed(env, exports, "architecture", architecture);
    SetNamed(env, exports, "begin", begin);
    SetNamed(env, exports, "recover", recover);
    SetNamed(env, exports, "acknowledge", acknowledge);
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
