#include <node_api.h>
#include <sqlite3.h>
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dispatch/dispatch.h>
#include <xpc/xpc.h>
#endif
#include <fcntl.h>
#include <sys/file.h>
#include <sys/sysctl.h>
#include <pwd.h>
#include <sys/stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <mutex>
#include <memory>
#include <string>
#include <vector>

extern "C" int sqlite3_key_v2(sqlite3 *, const char *, const void *, int);

namespace {

struct DatabaseHandle {
  sqlite3 *database = nullptr;
  bool progress_deadline_active = false;
  std::chrono::steady_clock::time_point progress_deadline;
};

struct StatementHandle {
  sqlite3_stmt *statement = nullptr;
};

struct FileLockHandle {
  int descriptor = -1;
};

napi_value Undefined(napi_env environment) {
  napi_value value;
  napi_get_undefined(environment, &value);
  return value;
}

napi_value Null(napi_env environment) {
  napi_value value;
  napi_get_null(environment, &value);
  return value;
}

napi_value Throw(napi_env environment, const std::string &message) {
  napi_throw_error(environment, "AFTERNOTE_SQLCIPHER", message.c_str());
  return Undefined(environment);
}

napi_value ThrowSqlite(napi_env environment, sqlite3 *database,
                       const std::string &operation) {
  const char *detail = database == nullptr ? "database is closed" : sqlite3_errmsg(database);
  return Throw(environment, operation + ": " + detail);
}

bool StringValue(napi_env environment, napi_value value, std::string *output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(environment, value, nullptr, 0, &length) != napi_ok) {
    Throw(environment, "Expected a UTF-8 string");
    return false;
  }
  output->resize(length + 1);
  size_t written = 0;
  if (napi_get_value_string_utf8(environment, value, output->data(), length + 1,
                                 &written) != napi_ok) {
    Throw(environment, "Could not read UTF-8 string");
    return false;
  }
  output->resize(written);
  return true;
}

template <typename T>
T *ExternalValue(napi_env environment, napi_value value, const char *kind) {
  void *pointer = nullptr;
  if (napi_get_value_external(environment, value, &pointer) != napi_ok || pointer == nullptr) {
    Throw(environment, std::string("Invalid ") + kind + " handle");
    return nullptr;
  }
  return static_cast<T *>(pointer);
}

bool ByteView(napi_env environment, napi_value value, const void **data, size_t *length) {
  bool is_buffer = false;
  napi_is_buffer(environment, value, &is_buffer);
  if (is_buffer) {
    void *bytes = nullptr;
    if (napi_get_buffer_info(environment, value, &bytes, length) != napi_ok) return false;
    *data = bytes;
    return true;
  }

  bool is_typed_array = false;
  napi_is_typedarray(environment, value, &is_typed_array);
  if (!is_typed_array) return false;
  napi_typedarray_type type;
  size_t elements = 0;
  void *bytes = nullptr;
  napi_value array_buffer;
  size_t byte_offset = 0;
  if (napi_get_typedarray_info(environment, value, &type, &elements, &bytes,
                               &array_buffer, &byte_offset) != napi_ok ||
      type != napi_uint8_array) {
    return false;
  }
  *data = bytes;
  *length = elements;
  return true;
}

bool Float32View(napi_env environment, napi_value value, const float **data,
                 size_t *length) {
  bool is_typed_array = false;
  napi_is_typedarray(environment, value, &is_typed_array);
  if (!is_typed_array) return false;
  napi_typedarray_type type;
  size_t elements = 0;
  void *bytes = nullptr;
  napi_value array_buffer;
  size_t byte_offset = 0;
  if (napi_get_typedarray_info(environment, value, &type, &elements, &bytes,
                               &array_buffer, &byte_offset) != napi_ok ||
      type != napi_float32_array) {
    return false;
  }
  *data = static_cast<const float *>(bytes);
  *length = elements;
  return true;
}

bool BindValue(napi_env environment, sqlite3_stmt *statement, int index,
               napi_value value) {
  napi_valuetype type;
  napi_typeof(environment, value, &type);
  int status = SQLITE_OK;
  if (type == napi_null || type == napi_undefined) {
    status = sqlite3_bind_null(statement, index);
  } else if (type == napi_string) {
    std::string text;
    if (!StringValue(environment, value, &text)) return false;
    status = sqlite3_bind_text(statement, index, text.data(),
                               static_cast<int>(text.size()), SQLITE_TRANSIENT);
  } else if (type == napi_number) {
    double number = 0;
    napi_get_value_double(environment, value, &number);
    if (std::isfinite(number) && std::floor(number) == number &&
        number >= static_cast<double>(std::numeric_limits<int64_t>::min()) &&
        number <= static_cast<double>(std::numeric_limits<int64_t>::max())) {
      status = sqlite3_bind_int64(statement, index, static_cast<int64_t>(number));
    } else {
      status = sqlite3_bind_double(statement, index, number);
    }
  } else if (type == napi_bigint) {
    int64_t number = 0;
    bool lossless = false;
    napi_get_value_bigint_int64(environment, value, &number, &lossless);
    if (!lossless) {
      Throw(environment, "SQLite integer parameter is outside signed 64-bit range");
      return false;
    }
    status = sqlite3_bind_int64(statement, index, number);
  } else if (type == napi_boolean) {
    bool boolean = false;
    napi_get_value_bool(environment, value, &boolean);
    status = sqlite3_bind_int(statement, index, boolean ? 1 : 0);
  } else {
    const void *bytes = nullptr;
    size_t length = 0;
    if (!ByteView(environment, value, &bytes, &length)) {
      Throw(environment, "SQLite parameters support strings, numbers, booleans, null, and bytes");
      return false;
    }
    if (length > static_cast<size_t>(std::numeric_limits<int>::max())) {
      Throw(environment, "SQLite byte parameter is too large");
      return false;
    }
    status = length == 0
        ? sqlite3_bind_zeroblob(statement, index, 0)
        : sqlite3_bind_blob(statement, index, bytes, static_cast<int>(length),
                            SQLITE_TRANSIENT);
  }

  if (status != SQLITE_OK) {
    ThrowSqlite(environment, sqlite3_db_handle(statement), "Could not bind SQLite value");
    return false;
  }
  return true;
}

bool BindParameters(napi_env environment, sqlite3_stmt *statement, napi_value parameters) {
  bool is_array = false;
  napi_is_array(environment, parameters, &is_array);
  if (!is_array) {
    Throw(environment, "SQLite parameters must be an array");
    return false;
  }
  uint32_t length = 0;
  napi_get_array_length(environment, parameters, &length);
  if (static_cast<int>(length) != sqlite3_bind_parameter_count(statement)) {
    Throw(environment, "SQLite parameter count does not match statement");
    return false;
  }
  sqlite3_reset(statement);
  sqlite3_clear_bindings(statement);
  for (uint32_t offset = 0; offset < length; ++offset) {
    napi_value value;
    napi_get_element(environment, parameters, offset, &value);
    if (!BindValue(environment, statement, static_cast<int>(offset + 1), value)) {
      sqlite3_reset(statement);
      sqlite3_clear_bindings(statement);
      return false;
    }
  }
  return true;
}

napi_value ColumnValue(napi_env environment, sqlite3_stmt *statement, int column) {
  napi_value value;
  switch (sqlite3_column_type(statement, column)) {
    case SQLITE_INTEGER:
      napi_create_int64(environment, sqlite3_column_int64(statement, column), &value);
      break;
    case SQLITE_FLOAT:
      napi_create_double(environment, sqlite3_column_double(statement, column), &value);
      break;
    case SQLITE_TEXT: {
      const auto *text = reinterpret_cast<const char *>(sqlite3_column_text(statement, column));
      const int length = sqlite3_column_bytes(statement, column);
      napi_create_string_utf8(environment, text, static_cast<size_t>(length), &value);
      break;
    }
    case SQLITE_BLOB: {
      const void *bytes = sqlite3_column_blob(statement, column);
      const int length = sqlite3_column_bytes(statement, column);
      void *copied = nullptr;
      napi_create_buffer_copy(environment, static_cast<size_t>(length), bytes, &copied, &value);
      break;
    }
    default:
      napi_get_null(environment, &value);
  }
  return value;
}

napi_value CurrentRow(napi_env environment, sqlite3_stmt *statement) {
  napi_value row;
  napi_create_object(environment, &row);
  const int columns = sqlite3_column_count(statement);
  for (int column = 0; column < columns; ++column) {
    napi_value value = ColumnValue(environment, statement, column);
    napi_set_named_property(environment, row, sqlite3_column_name(statement, column), value);
  }
  return row;
}

void FinalizeDatabase(napi_env, void *data, void *) {
  auto *handle = static_cast<DatabaseHandle *>(data);
  if (handle->database != nullptr) sqlite3_close_v2(handle->database);
  delete handle;
}

void FinalizeStatement(napi_env, void *data, void *) {
  auto *handle = static_cast<StatementHandle *>(data);
  if (handle->statement != nullptr) sqlite3_finalize(handle->statement);
  delete handle;
}

void FinalizeFileLock(napi_env, void *data, void *) {
  auto *handle = static_cast<FileLockHandle *>(data);
  if (handle->descriptor >= 0) {
    flock(handle->descriptor, LOCK_UN);
    close(handle->descriptor);
  }
  delete handle;
}

napi_value Open(napi_env environment, napi_callback_info information) {
  size_t count = 3;
  napi_value arguments[3];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  if (count != 3) return Throw(environment, "open requires path, 32-byte key, and readonly flag");

  std::string path;
  if (!StringValue(environment, arguments[0], &path)) return Undefined(environment);
  const void *key = nullptr;
  size_t key_length = 0;
  if (!ByteView(environment, arguments[1], &key, &key_length) || key_length != 32) {
    return Throw(environment, "SQLCipher key must be exactly 32 bytes");
  }
  bool readonly = false;
  if (napi_get_value_bool(environment, arguments[2], &readonly) != napi_ok) {
    return Throw(environment, "readonly must be a boolean");
  }

  auto *handle = new DatabaseHandle();
  const int flags = readonly ? SQLITE_OPEN_READONLY
                             : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
  int status = sqlite3_open_v2(path.c_str(), &handle->database, flags, nullptr);
  if (status == SQLITE_OK) {
    status = sqlite3_key_v2(handle->database, "main", key, static_cast<int>(key_length));
  }
  if (status == SQLITE_OK) {
    status = sqlite3_exec(handle->database,
      readonly
        ? "PRAGMA cipher_compatibility=4; PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; PRAGMA cipher_hmac_algorithm=HMAC_SHA512; PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512; PRAGMA cipher_plaintext_header_size=0; PRAGMA cipher_memory_security=ON; PRAGMA temp_store=MEMORY;"
        : "PRAGMA cipher_compatibility=4; PRAGMA cipher_page_size=4096; PRAGMA kdf_iter=256000; PRAGMA cipher_hmac_algorithm=HMAC_SHA512; PRAGMA cipher_kdf_algorithm=PBKDF2_HMAC_SHA512; PRAGMA cipher_plaintext_header_size=0; PRAGMA cipher_memory_security=ON; PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY;",
      nullptr, nullptr, nullptr);
  }
  sqlite3_stmt *validation = nullptr;
  if (status == SQLITE_OK) {
    status = sqlite3_prepare_v2(handle->database,
      "SELECT count(*) FROM sqlite_schema", -1, &validation, nullptr);
  }
  if (status == SQLITE_OK) status = sqlite3_step(validation) == SQLITE_ROW ? SQLITE_OK : SQLITE_ERROR;
  if (validation != nullptr) sqlite3_finalize(validation);
  if (status != SQLITE_OK) {
    std::string message = handle->database == nullptr
      ? "Could not open SQLCipher database"
      : std::string("Could not unlock SQLCipher database: ") + sqlite3_errmsg(handle->database);
    if (handle->database != nullptr) sqlite3_close_v2(handle->database);
    delete handle;
    return Throw(environment, message);
  }

  napi_value external;
  napi_create_external(environment, handle, FinalizeDatabase, nullptr, &external);
  return external;
}

napi_value Close(napi_env environment, napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<DatabaseHandle>(environment, arguments[0], "database");
  if (handle == nullptr) return Undefined(environment);
  if (handle->database != nullptr) {
    const int status = sqlite3_close_v2(handle->database);
    if (status != SQLITE_OK) return ThrowSqlite(environment, handle->database, "Could not close database");
    handle->database = nullptr;
  }
  return Undefined(environment);
}

napi_value CosineSimilarities(napi_env environment,
                              napi_callback_info information) {
  size_t count = 3;
  napi_value arguments[3];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  if (count != 3) {
    return Throw(environment,
                 "cosineSimilarities requires a query, packed vectors, and magnitudes");
  }

  const float *query = nullptr;
  const float *vectors = nullptr;
  const float *magnitudes = nullptr;
  size_t dimensions = 0;
  size_t vector_elements = 0;
  size_t magnitude_count = 0;
  if (!Float32View(environment, arguments[0], &query, &dimensions) ||
      dimensions == 0 ||
      !Float32View(environment, arguments[1], &vectors, &vector_elements) ||
      vector_elements % dimensions != 0 ||
      !Float32View(environment, arguments[2], &magnitudes,
                   &magnitude_count) ||
      magnitude_count != vector_elements / dimensions) {
    return Throw(environment, "Cosine similarity vector dimensions are invalid");
  }

  double query_squared = 0;
  for (size_t index = 0; index < dimensions; index += 1) {
    query_squared += static_cast<double>(query[index]) * query[index];
  }
  const double query_magnitude = std::sqrt(query_squared);
  if (magnitude_count >
      std::numeric_limits<size_t>::max() / sizeof(double)) {
    return Throw(environment, "Cosine similarity result is too large");
  }

  napi_value array_buffer;
  void *output_bytes = nullptr;
  if (napi_create_arraybuffer(environment, magnitude_count * sizeof(double),
                              &output_bytes, &array_buffer) != napi_ok) {
    return Throw(environment, "Could not allocate cosine similarity results");
  }
  auto *output = static_cast<double *>(output_bytes);
  if (!std::isfinite(query_magnitude) || query_magnitude <= 0) {
    for (size_t candidate = 0; candidate < magnitude_count; candidate += 1) {
      output[candidate] = std::numeric_limits<double>::quiet_NaN();
    }
  } else {
    for (size_t candidate = 0; candidate < magnitude_count; candidate += 1) {
      const double magnitude = magnitudes[candidate];
      if (!std::isfinite(magnitude) || magnitude <= 0) {
        output[candidate] = std::numeric_limits<double>::quiet_NaN();
        continue;
      }
      double dot = 0;
      const size_t offset = candidate * dimensions;
      for (size_t dimension = 0; dimension < dimensions; dimension += 1) {
        dot += static_cast<double>(query[dimension]) *
               vectors[offset + dimension];
      }
      output[candidate] = dot / (query_magnitude * magnitude);
    }
  }

  napi_value result;
  if (napi_create_typedarray(environment, napi_float64_array, magnitude_count,
                             array_buffer, 0, &result) != napi_ok) {
    return Throw(environment, "Could not create cosine similarity results");
  }
  return result;
}

napi_value Exec(napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<DatabaseHandle>(environment, arguments[0], "database");
  if (handle == nullptr || handle->database == nullptr) return Throw(environment, "Database is closed");
  std::string sql;
  if (!StringValue(environment, arguments[1], &sql)) return Undefined(environment);
  char *detail = nullptr;
  const int status = sqlite3_exec(handle->database, sql.c_str(), nullptr, nullptr, &detail);
  if (status != SQLITE_OK) {
    std::string message = "Could not execute SQL: ";
    message += detail == nullptr ? sqlite3_errmsg(handle->database) : detail;
    sqlite3_free(detail);
    return Throw(environment, message);
  }
  return Undefined(environment);
}

napi_value Prepare(napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *database = ExternalValue<DatabaseHandle>(environment, arguments[0], "database");
  if (database == nullptr || database->database == nullptr) return Throw(environment, "Database is closed");
  std::string sql;
  if (!StringValue(environment, arguments[1], &sql)) return Undefined(environment);
  auto *handle = new StatementHandle();
  const int status = sqlite3_prepare_v2(database->database, sql.c_str(), -1,
                                        &handle->statement, nullptr);
  if (status != SQLITE_OK || handle->statement == nullptr) {
    delete handle;
    return ThrowSqlite(environment, database->database, "Could not prepare SQL");
  }
  napi_value external;
  napi_create_external(environment, handle, FinalizeStatement, nullptr, &external);
  return external;
}

int ProgressDeadline(void *context) {
  auto *handle = static_cast<DatabaseHandle *>(context);
  return handle != nullptr && handle->progress_deadline_active &&
      std::chrono::steady_clock::now() >= handle->progress_deadline;
}

napi_value SetProgressDeadline(napi_env environment,
                               napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  auto *handle = ExternalValue<DatabaseHandle>(environment, arguments[0],
                                                "database");
  int32_t timeout_ms = 0;
  if (handle == nullptr || handle->database == nullptr) {
    return Throw(environment, "Database is closed");
  }
  if (count != 2 ||
      napi_get_value_int32(environment, arguments[1], &timeout_ms) != napi_ok ||
      timeout_ms < 1 || timeout_ms > 30'000) {
    return Throw(environment, "SQLite progress deadline is invalid");
  }
  handle->progress_deadline = std::chrono::steady_clock::now() +
      std::chrono::milliseconds(timeout_ms);
  handle->progress_deadline_active = true;
  sqlite3_progress_handler(handle->database, 1000, ProgressDeadline, handle);
  return Undefined(environment);
}

napi_value ClearProgressDeadline(napi_env environment,
                                 napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  auto *handle = ExternalValue<DatabaseHandle>(environment, arguments[0],
                                                "database");
  if (handle == nullptr || handle->database == nullptr) {
    return Throw(environment, "Database is closed");
  }
  sqlite3_progress_handler(handle->database, 0, nullptr, nullptr);
  handle->progress_deadline_active = false;
  return Undefined(environment);
}

napi_value Backup(napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *source = ExternalValue<DatabaseHandle>(environment, arguments[0], "source database");
  auto *destination = ExternalValue<DatabaseHandle>(environment, arguments[1], "destination database");
  if (source == nullptr || destination == nullptr || source->database == nullptr ||
      destination->database == nullptr) {
    return Throw(environment, "Backup database is closed");
  }
  sqlite3_backup *backup = sqlite3_backup_init(destination->database, "main",
                                                source->database, "main");
  if (backup == nullptr) {
    return ThrowSqlite(environment, destination->database, "Could not start encrypted backup");
  }
  const int step = sqlite3_backup_step(backup, -1);
  const int finish = sqlite3_backup_finish(backup);
  if (step != SQLITE_DONE || finish != SQLITE_OK) {
    return ThrowSqlite(environment, destination->database, "Could not complete encrypted backup");
  }
  return Undefined(environment);
}

napi_value ImportPlaintext(napi_env environment, napi_callback_info information) {
  size_t count = 3;
  napi_value arguments[3];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *destination = ExternalValue<DatabaseHandle>(environment, arguments[0], "database");
  if (destination == nullptr || destination->database == nullptr) {
    return Throw(environment, "Database is closed");
  }
  std::string path;
  if (!StringValue(environment, arguments[1], &path)) return Undefined(environment);
  int32_t schema_version = 0;
  if (napi_get_value_int32(environment, arguments[2], &schema_version) != napi_ok ||
      schema_version < 0) {
    return Throw(environment, "Schema version must be a non-negative integer");
  }
  char *attach = sqlite3_mprintf("ATTACH DATABASE %Q AS plaintext KEY '';", path.c_str());
  char *version = sqlite3_mprintf("PRAGMA user_version = %d;", schema_version);
  char *detail = nullptr;
  int status = sqlite3_exec(destination->database, attach, nullptr, nullptr, &detail);
  if (status == SQLITE_OK) {
    status = sqlite3_exec(destination->database,
      "SELECT sqlcipher_export('main', 'plaintext');", nullptr, nullptr, &detail);
  }
  if (status == SQLITE_OK) status = sqlite3_exec(destination->database, version, nullptr, nullptr, &detail);
  if (status == SQLITE_OK) status = sqlite3_exec(destination->database, "DETACH DATABASE plaintext", nullptr, nullptr, &detail);
  if (status != SQLITE_OK) {
    sqlite3_exec(destination->database, "DETACH DATABASE plaintext", nullptr, nullptr, nullptr);
  }
  sqlite3_free(attach);
  sqlite3_free(version);
  if (status != SQLITE_OK) {
    std::string message = "Could not import plaintext SQLite: ";
    message += detail == nullptr ? sqlite3_errmsg(destination->database) : detail;
    sqlite3_free(detail);
    return Throw(environment, message);
  }
  sqlite3_free(detail);
  return Undefined(environment);
}

napi_value ExchangeFiles(napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  std::string first;
  std::string second;
  if (!StringValue(environment, arguments[0], &first) ||
      !StringValue(environment, arguments[1], &second)) {
    return Undefined(environment);
  }
  if (renameatx_np(AT_FDCWD, first.c_str(), AT_FDCWD, second.c_str(), RENAME_SWAP) != 0) {
    return Throw(environment, std::string("Could not atomically exchange vault files: ") +
                              std::strerror(errno));
  }
  return Undefined(environment);
}

napi_value AcquireFileLock(napi_env environment, napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  std::string path;
  if (!StringValue(environment, arguments[0], &path)) return Undefined(environment);
  int descriptor = open(path.c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (descriptor < 0) {
    return Throw(environment, std::string("Could not open vault lifecycle lock: ") +
                              std::strerror(errno));
  }
  struct stat descriptor_info;
  struct stat path_info;
  if (fstat(descriptor, &descriptor_info) != 0 ||
      lstat(path.c_str(), &path_info) != 0 ||
      !S_ISREG(descriptor_info.st_mode) || S_ISLNK(path_info.st_mode) ||
      descriptor_info.st_dev != path_info.st_dev ||
      descriptor_info.st_ino != path_info.st_ino ||
      descriptor_info.st_uid != geteuid()) {
    close(descriptor);
    return Throw(environment, "Vault lifecycle lock path is invalid");
  }
  if (fchmod(descriptor, 0600) != 0) {
    close(descriptor);
    return Throw(environment, "Could not secure vault lifecycle lock");
  }
  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) {
    close(descriptor);
    return Throw(environment, "Another Afternote process owns the requested exclusive lock");
  }
  auto *handle = new FileLockHandle();
  handle->descriptor = descriptor;
  napi_value external;
  napi_create_external(environment, handle, FinalizeFileLock, nullptr, &external);
  return external;
}

napi_value ReleaseFileLock(napi_env environment, napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<FileLockHandle>(environment, arguments[0], "file lock");
  if (handle == nullptr) return Undefined(environment);
  if (handle->descriptor >= 0) {
    flock(handle->descriptor, LOCK_UN);
    close(handle->descriptor);
    handle->descriptor = -1;
  }
  return Undefined(environment);
}

napi_value Get(napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<StatementHandle>(environment, arguments[0], "statement");
  if (handle == nullptr || handle->statement == nullptr) return Throw(environment, "Statement is closed");
  if (!BindParameters(environment, handle->statement, arguments[1])) return Undefined(environment);
  const int status = sqlite3_step(handle->statement);
  napi_value result;
  if (status == SQLITE_ROW) {
    result = CurrentRow(environment, handle->statement);
  } else if (status == SQLITE_DONE) {
    result = Undefined(environment);
  } else {
    sqlite3_reset(handle->statement);
    sqlite3_clear_bindings(handle->statement);
    return ThrowSqlite(environment, sqlite3_db_handle(handle->statement), "Could not read SQL row");
  }
  sqlite3_reset(handle->statement);
  sqlite3_clear_bindings(handle->statement);
  return result;
}

napi_value All(napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<StatementHandle>(environment, arguments[0], "statement");
  if (handle == nullptr || handle->statement == nullptr) return Throw(environment, "Statement is closed");
  if (!BindParameters(environment, handle->statement, arguments[1])) return Undefined(environment);
  napi_value rows;
  napi_create_array(environment, &rows);
  uint32_t index = 0;
  int status = SQLITE_ROW;
  while ((status = sqlite3_step(handle->statement)) == SQLITE_ROW) {
    napi_set_element(environment, rows, index++, CurrentRow(environment, handle->statement));
  }
  sqlite3_reset(handle->statement);
  sqlite3_clear_bindings(handle->statement);
  if (status != SQLITE_DONE) {
    return ThrowSqlite(environment, sqlite3_db_handle(handle->statement), "Could not read SQL rows");
  }
  return rows;
}

napi_value Run(napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<StatementHandle>(environment, arguments[0], "statement");
  if (handle == nullptr || handle->statement == nullptr) return Throw(environment, "Statement is closed");
  if (!BindParameters(environment, handle->statement, arguments[1])) return Undefined(environment);
  const int status = sqlite3_step(handle->statement);
  sqlite3 *database = sqlite3_db_handle(handle->statement);
  sqlite3_reset(handle->statement);
  sqlite3_clear_bindings(handle->statement);
  if (status != SQLITE_DONE && status != SQLITE_ROW) {
    return ThrowSqlite(environment, database, "Could not run SQL statement");
  }
  napi_value result;
  napi_create_object(environment, &result);
  napi_value changes;
  napi_create_int64(environment, sqlite3_changes64(database), &changes);
  napi_set_named_property(environment, result, "changes", changes);
  napi_value row_id;
  napi_create_int64(environment, sqlite3_last_insert_rowid(database), &row_id);
  napi_set_named_property(environment, result, "lastInsertRowid", row_id);
  return result;
}

napi_value Start(napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<StatementHandle>(environment, arguments[0], "statement");
  if (handle == nullptr || handle->statement == nullptr) return Throw(environment, "Statement is closed");
  if (!BindParameters(environment, handle->statement, arguments[1])) return Undefined(environment);
  return Undefined(environment);
}

napi_value Next(napi_env environment, napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<StatementHandle>(environment, arguments[0], "statement");
  if (handle == nullptr || handle->statement == nullptr) return Throw(environment, "Statement is closed");
  const int status = sqlite3_step(handle->statement);
  napi_value result;
  napi_create_object(environment, &result);
  napi_value done;
  napi_get_boolean(environment, status == SQLITE_DONE, &done);
  napi_set_named_property(environment, result, "done", done);
  if (status == SQLITE_ROW) {
    napi_set_named_property(environment, result, "value", CurrentRow(environment, handle->statement));
  } else if (status != SQLITE_DONE) {
    return ThrowSqlite(environment, sqlite3_db_handle(handle->statement), "Could not iterate SQL rows");
  }
  return result;
}

napi_value Reset(napi_env environment, napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<StatementHandle>(environment, arguments[0], "statement");
  if (handle == nullptr || handle->statement == nullptr) return Throw(environment, "Statement is closed");
  sqlite3_reset(handle->statement);
  sqlite3_clear_bindings(handle->statement);
  return Undefined(environment);
}

napi_value Finalize(napi_env environment, napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr, nullptr);
  auto *handle = ExternalValue<StatementHandle>(environment, arguments[0], "statement");
  if (handle == nullptr) return Undefined(environment);
  if (handle->statement != nullptr) {
    sqlite3_finalize(handle->statement);
    handle->statement = nullptr;
  }
  return Undefined(environment);
}

#ifdef __APPLE__
std::mutex xpc_mutex;
xpc_connection_t xpc_connection = nullptr;
std::string xpc_service;
std::string xpc_code_requirement;

void ResetXpcBrokerConnection() {
  if (xpc_connection != nullptr) {
    xpc_connection_cancel(xpc_connection);
    xpc_release(xpc_connection);
    xpc_connection = nullptr;
  }
  xpc_service.clear();
  xpc_code_requirement.clear();
}

napi_value CopyKeyToJavaScript(napi_env environment, const void *bytes,
                               size_t length);

struct XpcRequestInput {
  std::string service;
  std::string code_requirement;
  std::string request;
  int32_t timeout_ms = 0;
};

struct XpcRequestResult {
  std::string response;
  std::string error;
};

// The reply block can outlive a timeout. Its shared state releases both the
// semaphore and any late retained response after the last owner finishes.
struct XpcPendingReply {
  dispatch_semaphore_t completed = dispatch_semaphore_create(0);
  xpc_object_t received = nullptr;
  ~XpcPendingReply() {
    if (received != nullptr) xpc_release(received);
    dispatch_release(completed);
  }
};

bool ReadXpcRequestInput(napi_env environment, napi_callback_info information,
                         XpcRequestInput *input) {
  size_t count = 4;
  napi_value arguments[4];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  auto &[service, code_requirement, request, timeout_ms] = *input;
  if (count != 4 || !StringValue(environment, arguments[0], &service) ||
      !StringValue(environment, arguments[1], &code_requirement) ||
      !StringValue(environment, arguments[2], &request) ||
      napi_get_value_int32(environment, arguments[3], &timeout_ms) != napi_ok ||
      service.empty() || service.size() > 255 || code_requirement.empty() ||
      code_requirement.size() > 4096 ||
      code_requirement.find('\0') != std::string::npos ||
      code_requirement.find('\n') != std::string::npos ||
      code_requirement.find('\r') != std::string::npos || request.empty() ||
      request.size() > 1024 * 1024 || timeout_ms < 1 || timeout_ms > 86400000) {
    return false;
  }

  return true;
}

XpcRequestResult ExecuteXpcBrokerRequest(const XpcRequestInput &input) {
  const auto &[service, code_requirement, request, timeout_ms] = input;
  std::lock_guard<std::mutex> lock(xpc_mutex);
  if (xpc_connection == nullptr || xpc_service != service ||
      xpc_code_requirement != code_requirement) {
    ResetXpcBrokerConnection();
    xpc_connection = xpc_connection_create_mach_service(
        service.c_str(), dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0),
        0);
    if (xpc_connection == nullptr) {
      return {"", "Could not create the broker XPC connection"};
    }
    xpc_service = service;
    xpc_code_requirement = code_requirement;
    const int requirement_status =
        xpc_connection_set_peer_code_signing_requirement(
            xpc_connection, code_requirement.c_str());
    if (requirement_status != 0) {
      ResetXpcBrokerConnection();
      return {"", "Broker code-signing requirement is invalid (" + std::to_string(requirement_status) + ")"};
    }
    xpc_connection_set_event_handler(xpc_connection, ^(xpc_object_t event) {
      (void)event;
    });
    xpc_connection_resume(xpc_connection);
  }

  xpc_object_t message = xpc_dictionary_create(nullptr, nullptr, 0);
  xpc_dictionary_set_string(message, "request", request.c_str());
  auto pending = std::make_shared<XpcPendingReply>();
  xpc_connection_send_message_with_reply(
      xpc_connection, message,
      dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0),
      ^(xpc_object_t response) {
        pending->received = xpc_retain(response);
        dispatch_semaphore_signal(pending->completed);
      });
  xpc_release(message);
  const dispatch_time_t deadline = dispatch_time(
      DISPATCH_TIME_NOW, static_cast<int64_t>(timeout_ms) * NSEC_PER_MSEC);
  if (dispatch_semaphore_wait(pending->completed, deadline) != 0) {
    ResetXpcBrokerConnection();
    return {"", "Broker XPC request timed out"};
  }
  xpc_object_t received = pending->received;
  if (received == nullptr || xpc_get_type(received) == XPC_TYPE_ERROR) {
    ResetXpcBrokerConnection();
    return {"", "Broker XPC service is unavailable"};
  }
  const char *error = xpc_dictionary_get_string(received, "error");
  if (error != nullptr) {
    const std::string detail(error);
    return {"", detail};
  }
  const char *response = xpc_dictionary_get_string(received, "response");
  if (response == nullptr || strlen(response) > 1024 * 1024) {
    return {"", "Broker XPC response is invalid"};
  }
  return {response, ""};
}


napi_value XpcBrokerRequest(napi_env environment, napi_callback_info information) {
  XpcRequestInput input;
  if (!ReadXpcRequestInput(environment, information, &input))
    return Throw(environment, "XPC broker request is invalid");
  const auto result = ExecuteXpcBrokerRequest(input);
  if (!result.error.empty()) return Throw(environment, result.error);
  napi_value response;
  napi_create_string_utf8(environment, result.response.c_str(), result.response.size(), &response);
  return response;
}

struct AsyncXpcRequest {
  XpcRequestInput input;
  XpcRequestResult result;
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
};

napi_value XpcBrokerRequestAsync(napi_env environment, napi_callback_info information) {
  auto request = std::make_unique<AsyncXpcRequest>();
  if (!ReadXpcRequestInput(environment, information, &request->input))
    return Throw(environment, "XPC broker request is invalid");
  napi_value promise, name;
  if (napi_create_promise(environment, &request->deferred, &promise) != napi_ok ||
      napi_create_string_utf8(environment, "Afternote private worker poll", NAPI_AUTO_LENGTH, &name) != napi_ok)
    return Throw(environment, "Could not create asynchronous broker request");
  const napi_status created = napi_create_async_work(environment, nullptr, name,
      [](napi_env, void *data) {
        auto *request = static_cast<AsyncXpcRequest *>(data);
        request->result = ExecuteXpcBrokerRequest(request->input);
      },
      [](napi_env env, napi_status status, void *data) {
        std::unique_ptr<AsyncXpcRequest> request(static_cast<AsyncXpcRequest *>(data));
        if (status != napi_ok && request->result.error.empty())
          request->result.error = "Asynchronous broker request was cancelled";
        napi_value value;
        if (request->result.error.empty()) {
          napi_create_string_utf8(env, request->result.response.c_str(), request->result.response.size(), &value);
          napi_resolve_deferred(env, request->deferred, value);
        } else {
          napi_value message;
          napi_create_string_utf8(env, request->result.error.c_str(), request->result.error.size(), &message);
          napi_create_error(env, nullptr, message, &value);
          napi_reject_deferred(env, request->deferred, value);
        }
        napi_delete_async_work(env, request->work);
      }, request.get(), &request->work);
  if (created != napi_ok || napi_queue_async_work(environment, request->work) != napi_ok) {
    if (request->work != nullptr) napi_delete_async_work(environment, request->work);
    return Throw(environment, "Could not schedule asynchronous broker request");
  }
  request.release(); // Owned by the completion callback after successful queueing.
  return promise;
}

enum class ProcessCodeValidation {
  kValid,
  kUnavailable,
  kMismatch,
};

bool IsValidCodeRequirement(const std::string &requirement) {
  return !requirement.empty() && requirement.size() <= 4096 &&
         requirement.find('\0') == std::string::npos &&
         requirement.find('\n') == std::string::npos &&
         requirement.find('\r') == std::string::npos;
}

ProcessCodeValidation ValidateProcessCode(
    pid_t process_pid, const std::string &code_requirement) {
  if (process_pid <= 1) return ProcessCodeValidation::kUnavailable;
  int64_t process_pid_value = static_cast<int64_t>(process_pid);
  CFNumberRef process_pid_number = CFNumberCreate(
      kCFAllocatorDefault, kCFNumberSInt64Type, &process_pid_value);
  const void *keys[] = {kSecGuestAttributePid};
  const void *values[] = {process_pid_number};
  CFDictionaryRef attributes = CFDictionaryCreate(
      kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  SecCodeRef process_code = nullptr;
  OSStatus status = SecCodeCopyGuestWithAttributes(
      nullptr, attributes, kSecCSDefaultFlags, &process_code);
  CFRelease(attributes);
  CFRelease(process_pid_number);
  if (status != errSecSuccess || process_code == nullptr) {
    return ProcessCodeValidation::kUnavailable;
  }

  CFStringRef requirement_text = CFStringCreateWithBytes(
      kCFAllocatorDefault,
      reinterpret_cast<const UInt8 *>(code_requirement.data()),
      static_cast<CFIndex>(code_requirement.size()), kCFStringEncodingUTF8,
      false);
  SecRequirementRef requirement = nullptr;
  status = requirement_text == nullptr
               ? errSecParam
               : SecRequirementCreateWithString(requirement_text,
                                                kSecCSDefaultFlags,
                                                &requirement);
  if (requirement_text != nullptr) CFRelease(requirement_text);
  if (status == errSecSuccess && requirement != nullptr) {
    status = SecCodeCheckValidity(process_code, kSecCSStrictValidate,
                                  requirement);
  }
  if (requirement != nullptr) CFRelease(requirement);
  CFRelease(process_code);
  return status == errSecSuccess
      ? ProcessCodeValidation::kValid
      : ProcessCodeValidation::kMismatch;
}

pid_t ParentProcessIdentifier(pid_t process_pid) {
  int selectors[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, process_pid};
  struct kinfo_proc process = {};
  size_t size = sizeof(process);
  if (sysctl(selectors, 4, &process, &size, nullptr, 0) != 0 ||
      size != sizeof(process) || process.kp_proc.p_pid != process_pid) {
    return -1;
  }
  return process.kp_eproc.e_ppid;
}

napi_value RequireParentCodeSigningRequirement(
    napi_env environment, napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string code_requirement;
  if (count != 1 ||
      !StringValue(environment, arguments[0], &code_requirement) ||
      !IsValidCodeRequirement(code_requirement)) {
    return Throw(environment, "Parent code-signing requirement is invalid");
  }

  const pid_t parent_pid = getppid();
  if (parent_pid <= 1) {
    return Throw(environment, "Authorized parent process is unavailable");
  }
  const ProcessCodeValidation validation =
      ValidateProcessCode(parent_pid, code_requirement);
  if (validation == ProcessCodeValidation::kUnavailable) {
    return Throw(environment, "Could not identify the parent process");
  }
  if (validation == ProcessCodeValidation::kMismatch) {
    return Throw(environment,
                 "Parent process does not satisfy the required code signature");
  }
  return Undefined(environment);
}

napi_value RequireParentAndGrandparentCodeSigningRequirements(
    napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string parent_requirement;
  std::string grandparent_requirement;
  if (count != 2 ||
      !StringValue(environment, arguments[0], &parent_requirement) ||
      !StringValue(environment, arguments[1], &grandparent_requirement) ||
      !IsValidCodeRequirement(parent_requirement) ||
      !IsValidCodeRequirement(grandparent_requirement)) {
    return Throw(environment, "Process-chain code-signing requirements are invalid");
  }

  const pid_t parent_pid = getppid();
  const pid_t grandparent_pid = ParentProcessIdentifier(parent_pid);
  if (parent_pid <= 1 || grandparent_pid <= 1) {
    return Throw(environment, "Authorized parent process chain is unavailable");
  }
  const ProcessCodeValidation parent_validation =
      ValidateProcessCode(parent_pid, parent_requirement);
  if (parent_validation == ProcessCodeValidation::kUnavailable) {
    return Throw(environment, "Could not identify the parent process");
  }
  if (parent_validation == ProcessCodeValidation::kMismatch) {
    return Throw(environment,
                 "Parent process does not satisfy the required code signature");
  }
  const ProcessCodeValidation grandparent_validation =
      ValidateProcessCode(grandparent_pid, grandparent_requirement);
  if (grandparent_validation == ProcessCodeValidation::kUnavailable) {
    return Throw(environment, "Could not identify the grandparent process");
  }
  if (grandparent_validation == ProcessCodeValidation::kMismatch) {
    return Throw(environment,
                 "Grandparent process does not satisfy the required code signature");
  }
  if (getppid() != parent_pid ||
      ParentProcessIdentifier(parent_pid) != grandparent_pid) {
    return Throw(environment, "Authorized parent process chain changed during verification");
  }
  return Undefined(environment);
}

napi_value MatchesAncestorCodeSigningRequirements(
    napi_env environment, napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  bool is_array = false;
  if (count != 1 ||
      napi_is_array(environment, arguments[0], &is_array) != napi_ok ||
      !is_array) {
    return Throw(environment,
                 "Ancestor code-signing requirements must be an array");
  }
  uint32_t length = 0;
  napi_get_array_length(environment, arguments[0], &length);
  if (length < 1 || length > 8) {
    return Throw(environment,
                 "Ancestor code-signing chain must contain 1 to 8 requirements");
  }
  std::vector<std::string> requirements;
  requirements.reserve(length);
  for (uint32_t offset = 0; offset < length; ++offset) {
    napi_value value;
    std::string requirement;
    napi_get_element(environment, arguments[0], offset, &value);
    if (!StringValue(environment, value, &requirement) ||
        !IsValidCodeRequirement(requirement)) {
      return Throw(environment,
                   "Ancestor code-signing requirement is invalid");
    }
    requirements.push_back(requirement);
  }

  std::vector<pid_t> process_ids;
  process_ids.reserve(length);
  pid_t process_pid = getppid();
  for (uint32_t offset = 0; offset < length; ++offset) {
    if (process_pid <= 1) {
      return Throw(environment,
                   "Authorized ancestor process chain is unavailable");
    }
    process_ids.push_back(process_pid);
    process_pid = ParentProcessIdentifier(process_pid);
  }
  for (uint32_t offset = 0; offset < length; ++offset) {
    const ProcessCodeValidation validation =
        ValidateProcessCode(process_ids[offset], requirements[offset]);
    if (validation == ProcessCodeValidation::kUnavailable) {
      return Throw(environment,
                   "Could not identify an authorized ancestor process");
    }
    if (validation == ProcessCodeValidation::kMismatch) {
      napi_value matches;
      napi_get_boolean(environment, false, &matches);
      return matches;
    }
  }
  process_pid = getppid();
  for (uint32_t offset = 0; offset < length; ++offset) {
    if (process_pid != process_ids[offset]) {
      return Throw(environment,
                   "Authorized ancestor process chain changed during verification");
    }
    process_pid = ParentProcessIdentifier(process_pid);
  }
  napi_value matches;
  napi_get_boolean(environment, true, &matches);
  return matches;
}

CFDataRef SigningKeyTag(const std::string &tag) {
  return CFDataCreate(kCFAllocatorDefault,
                      reinterpret_cast<const UInt8 *>(tag.data()),
                      static_cast<CFIndex>(tag.size()));
}

SecKeyRef CopyClientSigningKey(const std::string &tag, OSStatus *status) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFDataRef tag_data = SigningKeyTag(tag);
  CFDictionarySetValue(query, kSecClass, kSecClassKey);
  CFDictionarySetValue(query, kSecAttrApplicationTag, tag_data);
  CFDictionarySetValue(query, kSecAttrKeyType, kSecAttrKeyTypeECSECPrimeRandom);
  CFDictionarySetValue(query, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef result = nullptr;
  *status = SecItemCopyMatching(query, &result);
  CFRelease(tag_data);
  CFRelease(query);
  return *status == errSecSuccess
             ? const_cast<SecKeyRef>(static_cast<const __SecKey *>(result))
             : nullptr;
}

SecKeyRef CreateClientSigningKey(const std::string &tag, CFErrorRef *error) {
  CFMutableDictionaryRef private_attributes = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFDataRef tag_data = SigningKeyTag(tag);
  CFErrorRef access_error = nullptr;
  SecAccessControlRef access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecAccessControlPrivateKeyUsage, &access_error);
  if (access == nullptr) {
    CFRelease(tag_data);
    CFRelease(private_attributes);
    if (error != nullptr) *error = access_error;
    else if (access_error != nullptr) CFRelease(access_error);
    return nullptr;
  }
  CFDictionarySetValue(private_attributes, kSecAttrIsPermanent, kCFBooleanTrue);
  CFDictionarySetValue(private_attributes, kSecAttrApplicationTag, tag_data);
  CFDictionarySetValue(private_attributes, kSecAttrAccessControl, access);
  CFDictionarySetValue(private_attributes, kSecUseDataProtectionKeychain,
                       kCFBooleanTrue);

  int key_size = 256;
  CFNumberRef key_size_value = CFNumberCreate(
      kCFAllocatorDefault, kCFNumberIntType, &key_size);
  CFMutableDictionaryRef attributes = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(attributes, kSecAttrKeyType,
                       kSecAttrKeyTypeECSECPrimeRandom);
  CFDictionarySetValue(attributes, kSecAttrKeySizeInBits, key_size_value);
  CFDictionarySetValue(attributes, kSecAttrTokenID, kSecAttrTokenIDSecureEnclave);
  CFDictionarySetValue(attributes, kSecPrivateKeyAttrs, private_attributes);
  SecKeyRef key = SecKeyCreateRandomKey(attributes, error);

  CFRelease(attributes);
  CFRelease(key_size_value);
  CFRelease(access);
  CFRelease(tag_data);
  CFRelease(private_attributes);
  return key;
}

napi_value ClientSigningPublicKey(napi_env environment,
                                  napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string tag;
  if (count != 1 || !StringValue(environment, arguments[0], &tag) ||
      tag.empty() || tag.size() > 255) {
    return Throw(environment, "Client signing-key tag is invalid");
  }
  OSStatus status = errSecSuccess;
  SecKeyRef private_key = CopyClientSigningKey(tag, &status);
  if (status == errSecItemNotFound) {
    CFErrorRef error = nullptr;
    private_key = CreateClientSigningKey(tag, &error);
    if (private_key == nullptr) {
      const CFIndex code = error == nullptr ? errSecInternalError
                                             : CFErrorGetCode(error);
      if (error != nullptr) CFRelease(error);
      return Throw(environment,
                   "Could not create the Secure Enclave client key (" +
                       std::to_string(code) + ")");
    }
  } else if (status != errSecSuccess || private_key == nullptr) {
    return Throw(environment, "Could not read the client signing key (" +
                                  std::to_string(status) + ")");
  }
  SecKeyRef public_key = SecKeyCopyPublicKey(private_key);
  CFRelease(private_key);
  if (public_key == nullptr) {
    return Throw(environment, "Could not derive the client public key");
  }
  CFErrorRef error = nullptr;
  CFDataRef representation = SecKeyCopyExternalRepresentation(public_key, &error);
  CFRelease(public_key);
  if (representation == nullptr) {
    const CFIndex code = error == nullptr ? errSecInternalError
                                           : CFErrorGetCode(error);
    if (error != nullptr) CFRelease(error);
    return Throw(environment, "Could not export the client public key (" +
                                  std::to_string(code) + ")");
  }
  napi_value result = CopyKeyToJavaScript(
      environment, CFDataGetBytePtr(representation),
      static_cast<size_t>(CFDataGetLength(representation)));
  CFRelease(representation);
  return result;
}

napi_value SignWithClientKey(napi_env environment,
                             napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string tag;
  const void *message = nullptr;
  size_t message_length = 0;
  if (count != 2 || !StringValue(environment, arguments[0], &tag) ||
      tag.empty() || tag.size() > 255 ||
      !ByteView(environment, arguments[1], &message, &message_length) ||
      message_length == 0 || message_length > 1024 * 1024) {
    return Throw(environment, "Client signing request is invalid");
  }
  OSStatus status = errSecSuccess;
  SecKeyRef private_key = CopyClientSigningKey(tag, &status);
  if (status != errSecSuccess || private_key == nullptr) {
    return Throw(environment, "Client signing key is unavailable");
  }
  CFDataRef data = CFDataCreate(
      kCFAllocatorDefault, static_cast<const UInt8 *>(message),
      static_cast<CFIndex>(message_length));
  CFErrorRef error = nullptr;
  CFDataRef signature = SecKeyCreateSignature(
      private_key, kSecKeyAlgorithmECDSASignatureMessageX962SHA256, data,
      &error);
  CFRelease(data);
  CFRelease(private_key);
  if (signature == nullptr) {
    const CFIndex code = error == nullptr ? errSecInternalError
                                           : CFErrorGetCode(error);
    if (error != nullptr) CFRelease(error);
    return Throw(environment, "Could not sign with the client key (" +
                                  std::to_string(code) + ")");
  }
  napi_value result = CopyKeyToJavaScript(
      environment, CFDataGetBytePtr(signature),
      static_cast<size_t>(CFDataGetLength(signature)));
  CFRelease(signature);
  return result;
}

napi_value DeleteClientSigningKey(napi_env environment,
                                  napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string tag;
  if (count != 1 || !StringValue(environment, arguments[0], &tag) ||
      tag.empty() || tag.size() > 255) {
    return Throw(environment, "Client signing-key tag is invalid");
  }
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFDataRef tag_data = SigningKeyTag(tag);
  CFDictionarySetValue(query, kSecClass, kSecClassKey);
  CFDictionarySetValue(query, kSecAttrApplicationTag, tag_data);
  CFDictionarySetValue(query, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  const OSStatus status = SecItemDelete(query);
  CFRelease(tag_data);
  CFRelease(query);
  if (status != errSecSuccess && status != errSecItemNotFound) {
    return Throw(environment, "Could not delete the client signing key");
  }
  return Undefined(environment);
}

napi_value CopyKeyToJavaScript(napi_env environment, const void *bytes,
                               size_t length) {
  napi_value result;
  void *copied = nullptr;
  if (napi_create_buffer_copy(environment, length, bytes, &copied, &result) !=
      napi_ok) {
    return Throw(environment, "Could not copy the Keychain vault key");
  }
  return result;
}

#if !defined(AFTERNOTE_RELEASE_BUILD)
OSStatus CopyLoginKeychain(SecKeychainRef *keychain) {
  const passwd *account = getpwuid(getuid());
  if (account == nullptr || account->pw_dir == nullptr || account->pw_dir[0] == '\0') {
    return errSecNoSuchKeychain;
  }
  const std::string path =
      std::string(account->pw_dir) + "/Library/Keychains/login.keychain-db";
  return SecKeychainOpen(path.c_str(), keychain);
}

OSStatus FindVaultKey(SecKeychainRef keychain, const std::string &service,
                      void **bytes, UInt32 *length,
                      SecKeychainItemRef *item = nullptr) {
  static const char account[] = "vault-key";
  return SecKeychainFindGenericPassword(
      keychain, static_cast<UInt32>(service.size()), service.data(),
      static_cast<UInt32>(sizeof(account) - 1), account, length, bytes, item);
}

napi_value GetOrCreateVaultKey(napi_env environment,
                               napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  if (count != 1 || !StringValue(environment, arguments[0], &service) ||
      service.empty() || service.size() > 255) {
    return Throw(environment, "Keychain service is invalid");
  }
  SecKeychainSetUserInteractionAllowed(false);
  SecKeychainRef keychain = nullptr;
  OSStatus status = CopyLoginKeychain(&keychain);
  if (status != errSecSuccess || keychain == nullptr) {
    return Throw(environment, "Could not open the login Keychain (" +
                                  std::to_string(status) + ")");
  }
  void *existing = nullptr;
  UInt32 existing_length = 0;
  status = FindVaultKey(keychain, service, &existing, &existing_length);
  if (status == errSecSuccess) {
    if (existing_length != 32) {
      if (existing != nullptr) {
        std::memset(existing, 0, existing_length);
        SecKeychainItemFreeContent(nullptr, existing);
      }
      CFRelease(keychain);
      return Throw(environment, "Keychain vault key has an invalid length");
    }
    napi_value result =
        CopyKeyToJavaScript(environment, existing, existing_length);
    std::memset(existing, 0, existing_length);
    SecKeychainItemFreeContent(nullptr, existing);
    CFRelease(keychain);
    return result;
  }
  if (status != errSecItemNotFound) {
    CFRelease(keychain);
    return Throw(environment, "Could not read the Keychain vault key (" +
                                  std::to_string(status) + ")");
  }

  uint8_t key[32];
  status = SecRandomCopyBytes(kSecRandomDefault, sizeof(key), key);
  if (status != errSecSuccess) {
    CFRelease(keychain);
    return Throw(environment, "Could not generate the vault key");
  }
  SecTrustedApplicationRef trusted = nullptr;
  status = SecTrustedApplicationCreateFromPath(nullptr, &trusted);
  if (status != errSecSuccess || trusted == nullptr) {
    std::memset(key, 0, sizeof(key));
    CFRelease(keychain);
    return Throw(environment, "Could not identify the signed broker executable");
  }
  const void *trusted_values[] = {trusted};
  CFArrayRef trusted_applications = CFArrayCreate(
      kCFAllocatorDefault, trusted_values, 1, &kCFTypeArrayCallBacks);
  SecAccessRef access = nullptr;
  status = SecAccessCreate(CFSTR("Afternote encrypted vault key"),
                           trusted_applications, &access);
  CFRelease(trusted_applications);
  CFRelease(trusted);
  if (status != errSecSuccess || access == nullptr) {
    std::memset(key, 0, sizeof(key));
    CFRelease(keychain);
    return Throw(environment, "Could not create the vault-key access control");
  }
  static const char account[] = "vault-key";
  SecKeychainAttribute attributes[] = {
      {kSecAccountItemAttr, static_cast<UInt32>(sizeof(account) - 1),
       const_cast<char *>(account)},
      {kSecServiceItemAttr, static_cast<UInt32>(service.size()),
       const_cast<char *>(service.data())},
  };
  SecKeychainAttributeList attribute_list = {2, attributes};
  SecKeychainItemRef item = nullptr;
  status = SecKeychainItemCreateFromContent(
      kSecGenericPasswordItemClass, &attribute_list,
      static_cast<UInt32>(sizeof(key)), key, keychain, access, &item);
  CFRelease(access);
  if (item != nullptr) CFRelease(item);
  if (status == errSecDuplicateItem) {
    std::memset(key, 0, sizeof(key));
    void *raced = nullptr;
    UInt32 raced_length = 0;
    status = FindVaultKey(keychain, service, &raced, &raced_length);
    if (status != errSecSuccess || raced == nullptr || raced_length != 32) {
      if (raced != nullptr) {
        std::memset(raced, 0, raced_length);
        SecKeychainItemFreeContent(nullptr, raced);
      }
      CFRelease(keychain);
      return Throw(environment, "Could not recover a concurrently created vault key");
    }
    napi_value result = CopyKeyToJavaScript(environment, raced, raced_length);
    std::memset(raced, 0, raced_length);
    SecKeychainItemFreeContent(nullptr, raced);
    CFRelease(keychain);
    return result;
  }
  if (status != errSecSuccess) {
    std::memset(key, 0, sizeof(key));
    CFRelease(keychain);
    return Throw(environment, "Could not store the Keychain vault key (" +
                                  std::to_string(status) + ")");
  }
  napi_value result = CopyKeyToJavaScript(environment, key, sizeof(key));
  std::memset(key, 0, sizeof(key));
  CFRelease(keychain);
  return result;
}

napi_value DeleteVaultKey(napi_env environment,
                          napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  if (count != 1 || !StringValue(environment, arguments[0], &service) ||
      service.empty() || service.size() > 255) {
    return Throw(environment, "Keychain service is invalid");
  }
  SecKeychainRef keychain = nullptr;
  OSStatus status = CopyLoginKeychain(&keychain);
  if (status != errSecSuccess || keychain == nullptr) {
    return Throw(environment, "Could not open the login Keychain");
  }
  SecKeychainItemRef item = nullptr;
  void *contents = nullptr;
  UInt32 content_length = 0;
  status = FindVaultKey(keychain, service, &contents, &content_length, &item);
  if (status == errSecItemNotFound) {
    CFRelease(keychain);
    return Undefined(environment);
  }
  if (status != errSecSuccess || item == nullptr) {
    CFRelease(keychain);
    return Throw(environment, "Could not locate the Keychain vault key");
  }
  if (contents != nullptr) {
    std::memset(contents, 0, content_length);
    SecKeychainItemFreeContent(nullptr, contents);
  }
  status = SecKeychainItemDelete(item);
  CFRelease(item);
  CFRelease(keychain);
  if (status != errSecSuccess) {
    return Throw(environment, "Could not delete the Keychain vault key");
  }
  return Undefined(environment);
}
#endif

#if !defined(AFTERNOTE_RELEASE_BUILD)
OSStatus FindDevelopmentClientKey(SecKeychainRef keychain,
                                  const std::string &service, void **bytes,
                                  UInt32 *length,
                                  SecKeychainItemRef *item = nullptr) {
  static const char account[] = "client-signing-key";
  return SecKeychainFindGenericPassword(
      keychain, static_cast<UInt32>(service.size()), service.data(),
      static_cast<UInt32>(sizeof(account) - 1), account, length, bytes, item);
}

napi_value GetOrCreateDevelopmentClientKey(
    napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  const void *candidate = nullptr;
  size_t candidate_length = 0;
  if (count != 2 || !StringValue(environment, arguments[0], &service) ||
      service.empty() || service.size() > 255 ||
      !ByteView(environment, arguments[1], &candidate, &candidate_length) ||
      candidate_length < 100 || candidate_length > 512) {
    return Throw(environment, "Development client key request is invalid");
  }
  SecKeychainSetUserInteractionAllowed(false);
  SecKeychainRef keychain = nullptr;
  OSStatus status = CopyLoginKeychain(&keychain);
  if (status != errSecSuccess || keychain == nullptr) {
    return Throw(environment, "Could not open the login Keychain");
  }
  void *existing = nullptr;
  UInt32 existing_length = 0;
  status = FindDevelopmentClientKey(keychain, service, &existing,
                                    &existing_length);
  if (status == errSecSuccess) {
    napi_value result =
        CopyKeyToJavaScript(environment, existing, existing_length);
    std::memset(existing, 0, existing_length);
    SecKeychainItemFreeContent(nullptr, existing);
    CFRelease(keychain);
    return result;
  }
  if (status != errSecItemNotFound) {
    CFRelease(keychain);
    return Throw(environment, "Could not read the development client key (" +
                                  std::to_string(status) + ")");
  }
  SecTrustedApplicationRef trusted = nullptr;
  status = SecTrustedApplicationCreateFromPath(nullptr, &trusted);
  if (status != errSecSuccess || trusted == nullptr) {
    CFRelease(keychain);
    return Throw(environment, "Could not identify the development client executable");
  }
  const void *trusted_values[] = {trusted};
  CFArrayRef trusted_applications = CFArrayCreate(
      kCFAllocatorDefault, trusted_values, 1, &kCFTypeArrayCallBacks);
  SecAccessRef access = nullptr;
  status = SecAccessCreate(CFSTR("Afternote development MCP client key"),
                           trusted_applications, &access);
  CFRelease(trusted_applications);
  CFRelease(trusted);
  if (status != errSecSuccess || access == nullptr) {
    CFRelease(keychain);
    return Throw(environment, "Could not create development client-key access control");
  }
  static const char account[] = "client-signing-key";
  SecKeychainAttribute attributes[] = {
      {kSecAccountItemAttr, static_cast<UInt32>(sizeof(account) - 1),
       const_cast<char *>(account)},
      {kSecServiceItemAttr, static_cast<UInt32>(service.size()),
       const_cast<char *>(service.data())},
  };
  SecKeychainAttributeList attribute_list = {2, attributes};
  SecKeychainItemRef item = nullptr;
  status = SecKeychainItemCreateFromContent(
      kSecGenericPasswordItemClass, &attribute_list,
      static_cast<UInt32>(candidate_length), candidate, keychain, access,
      &item);
  CFRelease(access);
  if (item != nullptr) CFRelease(item);
  if (status != errSecSuccess && status != errSecDuplicateItem) {
    CFRelease(keychain);
    return Throw(environment, "Could not store the development client key (" +
                                  std::to_string(status) + ")");
  }
  void *stored = nullptr;
  UInt32 stored_length = 0;
  status = FindDevelopmentClientKey(keychain, service, &stored, &stored_length);
  if (status != errSecSuccess || stored == nullptr) {
    CFRelease(keychain);
    return Throw(environment, "Could not verify the development client key (" +
                                  std::to_string(status) + ")");
  }
  napi_value result = CopyKeyToJavaScript(environment, stored, stored_length);
  std::memset(stored, 0, stored_length);
  SecKeychainItemFreeContent(nullptr, stored);
  CFRelease(keychain);
  return result;
}

napi_value DeleteDevelopmentClientKey(napi_env environment,
                                      napi_callback_info information) {
  size_t count = 1;
  napi_value arguments[1];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  if (count != 1 || !StringValue(environment, arguments[0], &service) ||
      service.empty() || service.size() > 255) {
    return Throw(environment, "Development client-key service is invalid");
  }
  SecKeychainRef keychain = nullptr;
  OSStatus status = CopyLoginKeychain(&keychain);
  if (status != errSecSuccess || keychain == nullptr) {
    return Throw(environment, "Could not open the login Keychain");
  }
  SecKeychainItemRef item = nullptr;
  void *contents = nullptr;
  UInt32 content_length = 0;
  status = FindDevelopmentClientKey(keychain, service, &contents,
                                    &content_length, &item);
  if (status == errSecItemNotFound) {
    CFRelease(keychain);
    return Undefined(environment);
  }
  if (contents != nullptr) {
    std::memset(contents, 0, content_length);
    SecKeychainItemFreeContent(nullptr, contents);
  }
  if (status != errSecSuccess || item == nullptr) {
    CFRelease(keychain);
    return Throw(environment, "Could not locate the development client key");
  }
  status = SecKeychainItemDelete(item);
  CFRelease(item);
  CFRelease(keychain);
  if (status != errSecSuccess) {
    return Throw(environment, "Could not delete the development client key");
  }
  return Undefined(environment);
}
#endif

CFStringRef StringToCF(const std::string &value) {
  return CFStringCreateWithBytes(
      kCFAllocatorDefault, reinterpret_cast<const UInt8 *>(value.data()),
      static_cast<CFIndex>(value.size()), kCFStringEncodingUTF8, false);
}

CFMutableDictionaryRef DataProtectionQuery(const std::string &service,
                                            const std::string &access_group) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks);
  CFStringRef service_value = StringToCF(service);
  CFStringRef group_value = StringToCF(access_group);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, service_value);
  CFDictionarySetValue(query, kSecAttrAccount, CFSTR("vault-key"));
  CFDictionarySetValue(query, kSecAttrAccessGroup, group_value);
  CFDictionarySetValue(query, kSecUseDataProtectionKeychain, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecAttrSynchronizable, kCFBooleanFalse);
  CFRelease(service_value);
  CFRelease(group_value);
  return query;
}

napi_value CopyDataProtectionVaultKey(napi_env environment,
                                      const std::string &service,
                                      const std::string &access_group,
                                      OSStatus *result_status) {
  CFMutableDictionaryRef query = DataProtectionQuery(service, access_group);
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecReturnAttributes, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef result = nullptr;
  *result_status = SecItemCopyMatching(query, &result);
  CFRelease(query);
  if (*result_status != errSecSuccess) {
    if (result != nullptr) CFRelease(result);
    return Undefined(environment);
  }
  if (result == nullptr || CFGetTypeID(result) != CFDictionaryGetTypeID()) {
    if (result != nullptr) CFRelease(result);
    *result_status = errSecDecode;
    return Undefined(environment);
  }
  CFDictionaryRef values = static_cast<CFDictionaryRef>(result);
  CFDataRef data = static_cast<CFDataRef>(
      CFDictionaryGetValue(values, kSecValueData));
  CFStringRef returned_group = static_cast<CFStringRef>(
      CFDictionaryGetValue(values, kSecAttrAccessGroup));
  CFStringRef expected_group = StringToCF(access_group);
  const bool valid_group = returned_group != nullptr &&
      CFEqual(returned_group, expected_group);
  CFRelease(expected_group);
  if (data == nullptr || CFGetTypeID(data) != CFDataGetTypeID() ||
      CFDataGetLength(data) != 32 || !valid_group) {
    CFRelease(result);
    *result_status = errSecDecode;
    return Undefined(environment);
  }
  CFStringRef accessibility = static_cast<CFStringRef>(
      CFDictionaryGetValue(values, kSecAttrAccessible));
  if (accessibility == nullptr ||
      !CFEqual(accessibility, kSecAttrAccessibleWhenUnlockedThisDeviceOnly)) {
    CFMutableDictionaryRef update_query =
        DataProtectionQuery(service, access_group);
    CFMutableDictionaryRef update = CFDictionaryCreateMutable(
        kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(update, kSecAttrAccessible,
                         kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
    *result_status = SecItemUpdate(update_query, update);
    CFRelease(update);
    CFRelease(update_query);
    if (*result_status != errSecSuccess) {
      CFRelease(result);
      return Undefined(environment);
    }
  }
  napi_value output = CopyKeyToJavaScript(
      environment, CFDataGetBytePtr(data),
      static_cast<size_t>(CFDataGetLength(data)));
  CFRelease(result);
  return output;
}

napi_value ReadDataProtectionVaultKey(
    napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  std::string access_group;
  if (count != 2 || !StringValue(environment, arguments[0], &service) ||
      !StringValue(environment, arguments[1], &access_group) ||
      service.empty() || service.size() > 255 || access_group.empty() ||
      access_group.size() > 255) {
    return Throw(environment, "Data-protection Keychain attributes are invalid");
  }
  OSStatus status = errSecSuccess;
  napi_value existing = CopyDataProtectionVaultKey(
      environment, service, access_group, &status);
  if (status == errSecSuccess) return existing;
  if (status == errSecItemNotFound) return Null(environment);
  return Throw(environment,
               "Could not read the data-protection vault key (" +
                   std::to_string(status) + ")");
}

bool ConstantTimeEqual(const void *first, const void *second, size_t length) {
  uint8_t difference = 0;
  const auto *left = static_cast<const uint8_t *>(first);
  const auto *right = static_cast<const uint8_t *>(second);
  for (size_t index = 0; index < length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}

napi_value EnrollDataProtectionVaultKey(
    napi_env environment, napi_callback_info information) {
  size_t count = 3;
  napi_value arguments[3];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  std::string access_group;
  const void *candidate = nullptr;
  size_t candidate_length = 0;
  if (count != 3 || !StringValue(environment, arguments[0], &service) ||
      !StringValue(environment, arguments[1], &access_group) ||
      !ByteView(environment, arguments[2], &candidate, &candidate_length) ||
      service.empty() || service.size() > 255 || access_group.empty() ||
      access_group.size() > 255 || candidate_length != 32) {
    return Throw(environment, "Data-protection vault key must be exactly 32 bytes");
  }

  OSStatus status = errSecSuccess;
  napi_value existing = CopyDataProtectionVaultKey(
      environment, service, access_group, &status);
  if (status == errSecSuccess) {
    const void *existing_bytes = nullptr;
    size_t existing_length = 0;
    if (!ByteView(environment, existing, &existing_bytes, &existing_length) ||
        existing_length != candidate_length) {
      return Throw(environment, "Data-protection vault key verification failed");
    }
    const bool matches = ConstantTimeEqual(
        existing_bytes, candidate, candidate_length);
    std::memset(const_cast<void *>(existing_bytes), 0, existing_length);
    if (!matches) {
      return Throw(environment,
                   "Data-protection vault key already exists with different bytes");
    }
    return Undefined(environment);
  }
  if (status != errSecItemNotFound) {
    return Throw(environment,
                 "Could not read the data-protection vault key (" +
                     std::to_string(status) + ")");
  }

  CFMutableDictionaryRef item = DataProtectionQuery(service, access_group);
  CFMutableDataRef key_data = CFDataCreateMutable(
      kCFAllocatorDefault, static_cast<CFIndex>(candidate_length));
  CFDataSetLength(key_data, static_cast<CFIndex>(candidate_length));
  std::memcpy(CFDataGetMutableBytePtr(key_data), candidate, candidate_length);
  CFDictionarySetValue(item, kSecValueData, key_data);
  CFDictionarySetValue(item, kSecAttrAccessible,
                       kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
  status = SecItemAdd(item, nullptr);
  std::memset(CFDataGetMutableBytePtr(key_data), 0, candidate_length);
  CFRelease(key_data);
  CFRelease(item);
  if (status != errSecSuccess && status != errSecDuplicateItem) {
    return Throw(environment,
                 "Could not enroll the data-protection vault key (" +
                     std::to_string(status) + ")");
  }

  napi_value verified = CopyDataProtectionVaultKey(
      environment, service, access_group, &status);
  const void *verified_bytes = nullptr;
  size_t verified_length = 0;
  if (status != errSecSuccess ||
      !ByteView(environment, verified, &verified_bytes, &verified_length) ||
      verified_length != candidate_length) {
    return Throw(environment,
                 "Could not verify the enrolled data-protection vault key");
  }
  const bool matches = ConstantTimeEqual(
      verified_bytes, candidate, candidate_length);
  std::memset(const_cast<void *>(verified_bytes), 0, verified_length);
  if (!matches) {
    return Throw(environment,
                 "Enrolled data-protection vault key verification failed");
  }
  return Undefined(environment);
}

napi_value GetOrCreateDataProtectionVaultKey(
    napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  std::string access_group;
  if (count != 2 || !StringValue(environment, arguments[0], &service) ||
      !StringValue(environment, arguments[1], &access_group) ||
      service.empty() || service.size() > 255 || access_group.empty() ||
      access_group.size() > 255) {
    return Throw(environment, "Data-protection Keychain attributes are invalid");
  }
  OSStatus status = errSecSuccess;
  napi_value existing = CopyDataProtectionVaultKey(
      environment, service, access_group, &status);
  if (status == errSecSuccess) return existing;
  if (status != errSecItemNotFound) {
    return Throw(environment,
                 "Could not read the data-protection vault key (" +
                     std::to_string(status) + ")");
  }
  uint8_t key[32] = {};
  status = SecRandomCopyBytes(kSecRandomDefault, sizeof(key), key);
  if (status != errSecSuccess) {
    return Throw(environment, "Could not generate the vault key");
  }
  CFMutableDictionaryRef item = DataProtectionQuery(service, access_group);
  CFMutableDataRef key_data = CFDataCreateMutable(
      kCFAllocatorDefault, static_cast<CFIndex>(sizeof(key)));
  CFDataSetLength(key_data, static_cast<CFIndex>(sizeof(key)));
  std::memcpy(CFDataGetMutableBytePtr(key_data), key, sizeof(key));
  CFDictionarySetValue(item, kSecValueData, key_data);
  CFDictionarySetValue(item, kSecAttrAccessible,
                       kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
  status = SecItemAdd(item, nullptr);
  std::memset(CFDataGetMutableBytePtr(key_data), 0, sizeof(key));
  CFRelease(key_data);
  CFRelease(item);
  std::memset(key, 0, sizeof(key));
  if (status != errSecSuccess && status != errSecDuplicateItem) {
    return Throw(environment,
                 "Could not store the data-protection vault key (" +
                     std::to_string(status) + ")");
  }
  napi_value created = CopyDataProtectionVaultKey(
      environment, service, access_group, &status);
  if (status != errSecSuccess) {
    return Throw(environment,
                 "Could not verify the data-protection vault key (" +
                     std::to_string(status) + ")");
  }
  return created;
}

napi_value CreateDataProtectionVaultKey(
    napi_env environment, napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  std::string access_group;
  if (count != 2 || !StringValue(environment, arguments[0], &service) ||
      !StringValue(environment, arguments[1], &access_group) ||
      service.empty() || service.size() > 255 || access_group.empty() ||
      access_group.size() > 255) {
    return Throw(environment, "Data-protection Keychain attributes are invalid");
  }

  OSStatus status = errSecSuccess;
  napi_value existing = CopyDataProtectionVaultKey(
      environment, service, access_group, &status);
  if (status == errSecSuccess) {
    const void *existing_bytes = nullptr;
    size_t existing_length = 0;
    if (ByteView(environment, existing, &existing_bytes, &existing_length)) {
      std::memset(const_cast<void *>(existing_bytes), 0, existing_length);
    }
    return Throw(environment, "Data-protection vault key already exists");
  }
  if (status != errSecItemNotFound) {
    return Throw(environment,
                 "Could not read the data-protection vault key (" +
                     std::to_string(status) + ")");
  }

  uint8_t key[32] = {};
  status = SecRandomCopyBytes(kSecRandomDefault, sizeof(key), key);
  if (status != errSecSuccess) {
    std::memset(key, 0, sizeof(key));
    return Throw(environment, "Could not generate the vault key");
  }
  CFMutableDictionaryRef item = DataProtectionQuery(service, access_group);
  CFMutableDataRef key_data = CFDataCreateMutable(
      kCFAllocatorDefault, static_cast<CFIndex>(sizeof(key)));
  CFDataSetLength(key_data, static_cast<CFIndex>(sizeof(key)));
  std::memcpy(CFDataGetMutableBytePtr(key_data), key, sizeof(key));
  CFDictionarySetValue(item, kSecValueData, key_data);
  CFDictionarySetValue(item, kSecAttrAccessible,
                       kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
  status = SecItemAdd(item, nullptr);
  std::memset(CFDataGetMutableBytePtr(key_data), 0, sizeof(key));
  CFRelease(key_data);
  CFRelease(item);
  if (status != errSecSuccess) {
    std::memset(key, 0, sizeof(key));
    if (status == errSecDuplicateItem) {
      return Throw(environment, "Data-protection vault key already exists");
    }
    return Throw(environment,
                 "Could not store the data-protection vault key (" +
                     std::to_string(status) + ")");
  }

  napi_value created = CopyDataProtectionVaultKey(
      environment, service, access_group, &status);
  const void *created_bytes = nullptr;
  size_t created_length = 0;
  if (status != errSecSuccess ||
      !ByteView(environment, created, &created_bytes, &created_length) ||
      created_length != sizeof(key)) {
    std::memset(key, 0, sizeof(key));
    return Throw(environment, "Could not verify the data-protection vault key");
  }
  const bool matches = ConstantTimeEqual(created_bytes, key, sizeof(key));
  std::memset(key, 0, sizeof(key));
  if (!matches) {
    std::memset(const_cast<void *>(created_bytes), 0, created_length);
    return Throw(environment, "Created data-protection vault key verification failed");
  }
  return created;
}

napi_value DeleteDataProtectionVaultKey(napi_env environment,
                                        napi_callback_info information) {
  size_t count = 2;
  napi_value arguments[2];
  napi_get_cb_info(environment, information, &count, arguments, nullptr,
                   nullptr);
  std::string service;
  std::string access_group;
  if (count != 2 || !StringValue(environment, arguments[0], &service) ||
      !StringValue(environment, arguments[1], &access_group)) {
    return Throw(environment, "Data-protection Keychain attributes are invalid");
  }
  CFMutableDictionaryRef query = DataProtectionQuery(service, access_group);
  OSStatus status = SecItemDelete(query);
  CFRelease(query);
  if (status != errSecSuccess && status != errSecItemNotFound) {
    return Throw(environment,
                 "Could not delete the data-protection vault key (" +
                     std::to_string(status) + ")");
  }
  return Undefined(environment);
}
#else
napi_value XpcBrokerRequestAsync(napi_env environment, napi_callback_info) {
  return Throw(environment, "XPC broker requests require macOS");
}

napi_value XpcBrokerRequest(napi_env environment, napi_callback_info) {
  return Throw(environment, "macOS XPC is required");
}
napi_value RequireParentCodeSigningRequirement(napi_env environment,
                                               napi_callback_info) {
  return Throw(environment, "macOS code signing is required");
}
napi_value ClientSigningPublicKey(napi_env environment, napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
napi_value SignWithClientKey(napi_env environment, napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
napi_value DeleteClientSigningKey(napi_env environment, napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
#if !defined(AFTERNOTE_RELEASE_BUILD)
napi_value GetOrCreateDevelopmentClientKey(napi_env environment,
                                           napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
napi_value DeleteDevelopmentClientKey(napi_env environment,
                                      napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
napi_value GetOrCreateVaultKey(napi_env environment, napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
napi_value DeleteVaultKey(napi_env environment, napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
#endif
napi_value GetOrCreateDataProtectionVaultKey(napi_env environment,
                                             napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
napi_value ReadDataProtectionVaultKey(napi_env environment,
                                      napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
napi_value EnrollDataProtectionVaultKey(napi_env environment,
                                        napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
napi_value DeleteDataProtectionVaultKey(napi_env environment,
                                        napi_callback_info) {
  return Throw(environment, "macOS Keychain is required");
}
#endif

napi_value Init(napi_env environment, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"exec", nullptr, Exec, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"prepare", nullptr, Prepare, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setProgressDeadline", nullptr, SetProgressDeadline, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"clearProgressDeadline", nullptr, ClearProgressDeadline, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"backup", nullptr, Backup, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"importPlaintext", nullptr, ImportPlaintext, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"exchangeFiles", nullptr, ExchangeFiles, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"acquireFileLock", nullptr, AcquireFileLock, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseFileLock", nullptr, ReleaseFileLock, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cosineSimilarities", nullptr, CosineSimilarities, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"get", nullptr, Get, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"all", nullptr, All, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"run", nullptr, Run, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"next", nullptr, Next, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"reset", nullptr, Reset, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"finalize", nullptr, Finalize, nullptr, nullptr, nullptr, napi_default, nullptr},
#if !defined(AFTERNOTE_RELEASE_BUILD)
    {"getOrCreateVaultKey", nullptr, GetOrCreateVaultKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteVaultKey", nullptr, DeleteVaultKey, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
    {"getOrCreateDataProtectionVaultKey", nullptr, GetOrCreateDataProtectionVaultKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"readDataProtectionVaultKey", nullptr, ReadDataProtectionVaultKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createDataProtectionVaultKey", nullptr, CreateDataProtectionVaultKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"enrollDataProtectionVaultKey", nullptr, EnrollDataProtectionVaultKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteDataProtectionVaultKey", nullptr, DeleteDataProtectionVaultKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"xpcBrokerRequest", nullptr, XpcBrokerRequest, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"xpcBrokerRequestAsync", nullptr, XpcBrokerRequestAsync, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requireParentCodeSigningRequirement", nullptr, RequireParentCodeSigningRequirement, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"requireParentAndGrandparentCodeSigningRequirements", nullptr, RequireParentAndGrandparentCodeSigningRequirements, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"matchesAncestorCodeSigningRequirements", nullptr, MatchesAncestorCodeSigningRequirements, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"clientSigningPublicKey", nullptr, ClientSigningPublicKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"signWithClientKey", nullptr, SignWithClientKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteClientSigningKey", nullptr, DeleteClientSigningKey, nullptr, nullptr, nullptr, napi_default, nullptr},
#if !defined(AFTERNOTE_RELEASE_BUILD)
    {"getOrCreateDevelopmentClientKey", nullptr, GetOrCreateDevelopmentClientKey, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"deleteDevelopmentClientKey", nullptr, DeleteDevelopmentClientKey, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  napi_define_properties(environment, exports,
                         sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
