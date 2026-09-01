#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/acl.h>
#else
#include <sys/xattr.h>
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif
#ifndef O_NOFOLLOW
#error "unix-artifact-handoff requires O_NOFOLLOW"
#endif

enum {
  MAX_RECORD_BYTES = 1024 * 1024,
  TEST_HOOK_ATTEMPTS = 1000,
};

struct expected_identity {
  dev_t device;
  ino_t inode;
};

static void fail(const char *message) {
  fprintf(stderr, "unix-artifact-handoff: %s\n", message);
  exit(1);
}

static unsigned long long parse_number(const char *text, const char *message) {
  char *end = NULL;
  unsigned long long value;
  if (text == NULL || *text == '\0' || *text == '-') fail(message);
  errno = 0;
  value = strtoull(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0') fail(message);
  return value;
}

static uid_t parse_uid(const char *text) {
  unsigned long long value = parse_number(text, "invalid UID");
  uid_t converted = (uid_t)value;
  if ((unsigned long long)converted != value) fail("invalid UID");
  return converted;
}

static gid_t parse_gid(const char *text) {
  unsigned long long value = parse_number(text, "invalid GID");
  gid_t converted = (gid_t)value;
  if ((unsigned long long)converted != value) fail("invalid GID");
  return converted;
}

static struct expected_identity parse_identity(const char *device, const char *inode) {
  struct expected_identity value;
  unsigned long long parsed_device = parse_number(device, "invalid directory device");
  unsigned long long parsed_inode = parse_number(inode, "invalid directory inode");
  value.device = (dev_t)parsed_device;
  value.inode = (ino_t)parsed_inode;
  if ((unsigned long long)value.device != parsed_device ||
      (unsigned long long)value.inode != parsed_inode) {
    fail("invalid directory identity");
  }
  return value;
}

static int open_directory_at(int parent, const char *name) {
  int descriptor = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) fail("directory no-follow open failed");
  return descriptor;
}

static int open_absolute_directory(const char *path) {
  char *copy;
  char *segment;
  char *state = NULL;
  int descriptor;
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX) {
    fail("directory path must be bounded and absolute");
  }
  copy = strdup(path);
  if (copy == NULL) fail("directory path allocation failed");
  descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) fail("filesystem root no-follow open failed");
  for (segment = strtok_r(copy, "/", &state); segment != NULL;
       segment = strtok_r(NULL, "/", &state)) {
    int child;
    if (strcmp(segment, ".") == 0 || strcmp(segment, "..") == 0 || *segment == '\0') {
      close(descriptor);
      free(copy);
      fail("directory path contains an unsafe component");
    }
    child = open_directory_at(descriptor, segment);
    if (close(descriptor) != 0) {
      close(child);
      free(copy);
      fail("directory descriptor close failed");
    }
    descriptor = child;
  }
  free(copy);
  return descriptor;
}

static void require_no_extended_acl(int descriptor) {
#if defined(__APPLE__)
  errno = 0;
  acl_t acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED);
  acl_entry_t entry;
  int result;
  if (acl == NULL && errno == ENOENT) return;
  if (acl == NULL) fail("ACL query failed");
  result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  if (result < 0) {
    acl_free(acl);
    fail("ACL entry query failed");
  }
  if (result == 1) {
    acl_free(acl);
    fail("extended ACL is not allowed");
  }
  if (acl_free(acl) != 0) fail("ACL release failed");
#else
  const char *names[] = {"system.posix_acl_access", "system.posix_acl_default"};
  size_t index;
  for (index = 0; index < sizeof(names) / sizeof(names[0]); index++) {
    errno = 0;
    if (fgetxattr(descriptor, names[index], NULL, 0) >= 0) {
      fail("extended ACL is not allowed");
    }
    if (errno != ENODATA && errno != ENOTSUP && errno != EOPNOTSUPP) {
      fail("ACL query failed");
    }
  }
#endif
}

static void validate_directory(
    int descriptor,
    struct expected_identity expected,
    uid_t owner,
    gid_t group,
    mode_t mode) {
  struct stat status;
  if (fstat(descriptor, &status) != 0) fail("directory identity query failed");
  if (!S_ISDIR(status.st_mode) || status.st_dev != expected.device ||
      status.st_ino != expected.inode || status.st_uid != owner ||
      status.st_gid != group || (status.st_mode & 07777) != mode) {
    fail("directory identity, owner, group, or mode changed");
  }
  require_no_extended_acl(descriptor);
}

static const char *record_name_from_relative(const char *relative_path) {
  static const char prefix[] = "workspace/.artifacts/";
  const char *name;
  if (relative_path == NULL || strncmp(relative_path, prefix, sizeof(prefix) - 1) != 0) {
    fail("record path is outside the fixed artifact directory");
  }
  name = relative_path + sizeof(prefix) - 1;
  if (*name == '\0' || strchr(name, '/') != NULL || strcmp(name, ".") == 0 ||
      strcmp(name, "..") == 0 || strlen(name) > 255) {
    fail("record name is unsafe");
  }
  return name;
}

static int open_source_tree(
    const char *root_path,
    struct expected_identity root_identity,
    struct expected_identity workspace_identity,
    struct expected_identity artifact_identity,
    uid_t owner,
    gid_t group,
    mode_t mode,
    int *workspace_out,
    int *artifact_out) {
  int root = open_absolute_directory(root_path);
  int workspace;
  int artifacts;
  validate_directory(root, root_identity, owner, group, mode);
  workspace = open_directory_at(root, "workspace");
  validate_directory(workspace, workspace_identity, owner, group, mode);
  artifacts = open_directory_at(workspace, ".artifacts");
  validate_directory(artifacts, artifact_identity, owner, group, mode);
  *workspace_out = workspace;
  *artifact_out = artifacts;
  return root;
}

static int same_timestamp(const struct stat *left, const struct stat *right) {
#if defined(__APPLE__)
  return left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
         left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
         left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
         left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
#else
  return left->st_mtim.tv_sec == right->st_mtim.tv_sec &&
         left->st_mtim.tv_nsec == right->st_mtim.tv_nsec &&
         left->st_ctim.tv_sec == right->st_ctim.tv_sec &&
         left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
#endif
}

static int same_file_status(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_uid == right->st_uid && left->st_gid == right->st_gid &&
         left->st_mode == right->st_mode && left->st_nlink == right->st_nlink &&
         left->st_size == right->st_size && same_timestamp(left, right);
}

static void validate_source_file(
    int descriptor,
    uid_t owner,
    gid_t group,
    mode_t mode,
    struct stat *status) {
  if (fstat(descriptor, status) != 0) fail("source identity query failed");
  if (!S_ISREG(status->st_mode) || status->st_nlink != 1 || status->st_uid != owner ||
      status->st_gid != group || (status->st_mode & 07777) != mode ||
      status->st_size < 1 || status->st_size > MAX_RECORD_BYTES) {
    fail("source must be one bounded, single-link, exactly owned regular file");
  }
  require_no_extended_acl(descriptor);
}

#if defined(OPENCOVEN_HANDOFF_TESTING)
static void testing_pause_after_source_snapshot(void) {
  const char *ready = getenv("OPENCOVEN_HANDOFF_TEST_READY");
  const char *release = getenv("OPENCOVEN_HANDOFF_TEST_RELEASE");
  int descriptor;
  int attempt;
  struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000L};
  if (ready == NULL && release == NULL) return;
  if (ready == NULL || release == NULL || ready[0] != '/' || release[0] != '/') {
    fail("invalid handoff testing synchronization paths");
  }
  descriptor = open(ready, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (descriptor < 0 || close(descriptor) != 0) fail("handoff testing ready signal failed");
  for (attempt = 0; attempt < TEST_HOOK_ATTEMPTS; attempt++) {
    if (access(release, F_OK) == 0) return;
    nanosleep(&delay, NULL);
  }
  fail("handoff testing release timed out");
}
#else
static void testing_pause_after_source_snapshot(void) {}
#endif

static void prepare_source(
    const char *root_path,
    const char *relative_path,
    uid_t producer_uid,
    gid_t producer_gid,
    gid_t handoff_gid,
    struct expected_identity root_identity,
    struct expected_identity workspace_identity,
    struct expected_identity artifact_identity) {
  const char *record_name = record_name_from_relative(relative_path);
  int workspace = -1;
  int artifacts = -1;
  int root = open_source_tree(
      root_path,
      root_identity,
      workspace_identity,
      artifact_identity,
      producer_uid,
      producer_gid,
      0700,
      &workspace,
      &artifacts);
  int record = openat(artifacts, record_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat before;
  struct stat after;
  if (record < 0) fail("source record no-follow open failed");
  validate_source_file(record, producer_uid, producer_gid, 0600, &before);
  if (fchown(record, producer_uid, handoff_gid) != 0 || fchmod(record, 0640) != 0) {
    fail("source handoff permission transition failed");
  }
  if (fchown(artifacts, producer_uid, handoff_gid) != 0 || fchmod(artifacts, 0750) != 0 ||
      fchown(workspace, producer_uid, handoff_gid) != 0 || fchmod(workspace, 0750) != 0 ||
      fchown(root, producer_uid, handoff_gid) != 0 || fchmod(root, 0750) != 0) {
    fail("source parent handoff permission transition failed");
  }
  validate_source_file(record, producer_uid, handoff_gid, 0640, &after);
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_size != after.st_size || before.st_nlink != after.st_nlink) {
    fail("source identity changed during handoff preparation");
  }
  validate_directory(root, root_identity, producer_uid, handoff_gid, 0750);
  validate_directory(workspace, workspace_identity, producer_uid, handoff_gid, 0750);
  validate_directory(artifacts, artifact_identity, producer_uid, handoff_gid, 0750);
  if (fsync(record) != 0 || fsync(artifacts) != 0 || fsync(workspace) != 0 ||
      fsync(root) != 0) {
    fail("source handoff synchronization failed");
  }
  if (close(record) != 0 || close(artifacts) != 0 || close(workspace) != 0 ||
      close(root) != 0) {
    fail("source handoff descriptor close failed");
  }
}

static void split_destination(
    const char *path,
    char *parent,
    size_t parent_size,
    const char **name_out) {
  const char *slash;
  size_t length;
  if (path == NULL || path[0] != '/' || strlen(path) >= PATH_MAX) {
    fail("destination path must be bounded and absolute");
  }
  slash = strrchr(path, '/');
  if (slash == NULL || slash[1] == '\0') fail("destination name is unsafe");
  length = (size_t)(slash - path);
  if (length == 0) length = 1;
  if (length >= parent_size) fail("destination parent path is too long");
  memcpy(parent, path, length);
  parent[length] = '\0';
  if (strchr(slash + 1, '/') != NULL || strcmp(slash + 1, ".") == 0 ||
      strcmp(slash + 1, "..") == 0 || strlen(slash + 1) > 255) {
    fail("destination name is unsafe");
  }
  *name_out = slash + 1;
}

static void destination_fail(int parent, const char *name, const char *message) {
  if (parent >= 0 && name != NULL) (void)unlinkat(parent, name, 0);
  fail(message);
}

static void copy_source_to_destination(
    const char *root_path,
    const char *relative_path,
    const char *destination_path,
    uid_t producer_uid,
    gid_t handoff_gid,
    uid_t broker_uid,
    struct expected_identity root_identity,
    struct expected_identity workspace_identity,
    struct expected_identity artifact_identity) {
  const char *record_name = record_name_from_relative(relative_path);
  int workspace = -1;
  int artifacts = -1;
  int root = open_source_tree(
      root_path,
      root_identity,
      workspace_identity,
      artifact_identity,
      producer_uid,
      handoff_gid,
      0750,
      &workspace,
      &artifacts);
  int source = openat(artifacts, record_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat before;
  struct stat after;
  unsigned char *bytes;
  size_t offset = 0;
  char destination_parent_path[PATH_MAX];
  const char *destination_name = NULL;
  int destination_parent;
  int destination;
  int verification;
  struct stat destination_status;
  struct stat verification_status;
  unsigned char *verified;
  if (source < 0) fail("source record no-follow open failed");
  validate_source_file(source, producer_uid, handoff_gid, 0640, &before);
  bytes = malloc((size_t)before.st_size);
  if (bytes == NULL) fail("source buffer allocation failed");
  testing_pause_after_source_snapshot();
  while (offset < (size_t)before.st_size) {
    ssize_t received = read(source, bytes + offset, (size_t)before.st_size - offset);
    if (received < 0) {
      if (errno == EINTR) continue;
      fail("source descriptor read failed");
    }
    if (received == 0) fail("source descriptor ended early");
    offset += (size_t)received;
  }
  if (fstat(source, &after) != 0 || !same_file_status(&before, &after)) {
    fail("source identity changed during handoff");
  }
  require_no_extended_acl(source);

  split_destination(
      destination_path, destination_parent_path, sizeof(destination_parent_path), &destination_name);
  destination_parent = open_absolute_directory(destination_parent_path);
  if (fstat(destination_parent, &destination_status) != 0 ||
      !S_ISDIR(destination_status.st_mode) || destination_status.st_uid != broker_uid ||
      (destination_status.st_mode & 0022) != 0) {
    fail("destination parent is not private and broker-owned");
  }
  require_no_extended_acl(destination_parent);
  destination = openat(
      destination_parent,
      destination_name,
      O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC,
      0600);
  if (destination < 0) fail("destination create-new open failed");
  if (fchmod(destination, 0600) != 0) {
    destination_fail(destination_parent, destination_name, "destination mode setup failed");
  }
  offset = 0;
  while (offset < (size_t)before.st_size) {
    ssize_t written = write(destination, bytes + offset, (size_t)before.st_size - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      destination_fail(destination_parent, destination_name, "destination descriptor write failed");
    }
    offset += (size_t)written;
  }
  if (fsync(destination) != 0 || fstat(destination, &destination_status) != 0 ||
      !S_ISREG(destination_status.st_mode) || destination_status.st_nlink != 1 ||
      destination_status.st_uid != broker_uid ||
      (destination_status.st_mode & 07777) != 0600 ||
      destination_status.st_size != before.st_size) {
    destination_fail(destination_parent, destination_name, "destination verification failed");
  }
  require_no_extended_acl(destination);
  verification =
      openat(destination_parent, destination_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (verification < 0 || fstat(verification, &verification_status) != 0 ||
      verification_status.st_dev != destination_status.st_dev ||
      verification_status.st_ino != destination_status.st_ino) {
    destination_fail(destination_parent, destination_name, "destination identity reopen failed");
  }
  verified = malloc((size_t)before.st_size);
  if (verified == NULL) {
    destination_fail(destination_parent, destination_name, "verification buffer allocation failed");
  }
  offset = 0;
  while (offset < (size_t)before.st_size) {
    ssize_t received = read(verification, verified + offset, (size_t)before.st_size - offset);
    if (received < 0) {
      if (errno == EINTR) continue;
      destination_fail(destination_parent, destination_name, "destination verification read failed");
    }
    if (received == 0) {
      destination_fail(destination_parent, destination_name, "destination verification ended early");
    }
    offset += (size_t)received;
  }
  if (memcmp(bytes, verified, (size_t)before.st_size) != 0 ||
      fstat(verification, &verification_status) != 0 ||
      verification_status.st_dev != destination_status.st_dev ||
      verification_status.st_ino != destination_status.st_ino ||
      verification_status.st_size != destination_status.st_size ||
      verification_status.st_nlink != 1 ||
      (verification_status.st_mode & 07777) != 0600) {
    destination_fail(destination_parent, destination_name, "destination bytes changed");
  }
  if (fsync(destination_parent) != 0) {
    destination_fail(destination_parent, destination_name, "destination parent sync failed");
  }
  free(verified);
  free(bytes);
  if (close(verification) != 0 || close(destination) != 0 ||
      close(destination_parent) != 0 || close(source) != 0 || close(artifacts) != 0 ||
      close(workspace) != 0 || close(root) != 0) {
    fail("handoff descriptor close failed");
  }
}

int main(int argc, char **argv) {
  struct expected_identity root_identity;
  struct expected_identity workspace_identity;
  struct expected_identity artifact_identity;
  umask(077);
  if (argc == 13 && strcmp(argv[1], "prepare") == 0) {
    root_identity = parse_identity(argv[7], argv[8]);
    workspace_identity = parse_identity(argv[9], argv[10]);
    artifact_identity = parse_identity(argv[11], argv[12]);
    prepare_source(
        argv[2],
        argv[3],
        parse_uid(argv[4]),
        parse_gid(argv[5]),
        parse_gid(argv[6]),
        root_identity,
        workspace_identity,
        artifact_identity);
    return 0;
  }
  if (argc == 14 && strcmp(argv[1], "copy") == 0) {
    root_identity = parse_identity(argv[8], argv[9]);
    workspace_identity = parse_identity(argv[10], argv[11]);
    artifact_identity = parse_identity(argv[12], argv[13]);
    copy_source_to_destination(
        argv[2],
        argv[3],
        argv[4],
        parse_uid(argv[5]),
        parse_gid(argv[6]),
        parse_uid(argv[7]),
        root_identity,
        workspace_identity,
        artifact_identity);
    return 0;
  }
  fail("usage: unix-artifact-handoff prepare|copy ...");
  return 1;
}
