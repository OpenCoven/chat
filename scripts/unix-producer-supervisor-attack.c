#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void fail(const char *message) {
  perror(message);
  exit(1);
}

static void write_all(int descriptor, const char *bytes, size_t size) {
  while (size > 0) {
    ssize_t written = write(descriptor, bytes, size);
    if (written < 0) {
      if (errno == EINTR) continue;
      fail("write");
    }
    bytes += written;
    size -= (size_t)written;
  }
}

static void write_file(const char *path, const char *bytes, mode_t mode) {
  int descriptor = open(path, O_CREAT | O_TRUNC | O_WRONLY | O_CLOEXEC, mode);
  if (descriptor < 0) fail("open");
  if (fchmod(descriptor, mode) != 0) fail("fchmod");
  write_all(descriptor, bytes, strlen(bytes));
  if (fsync(descriptor) != 0) fail("fsync");
  if (close(descriptor) != 0) fail("close");
}

static long required_number(const char *name) {
  const char *value = getenv(name);
  char *end = NULL;
  long parsed;
  if (value == NULL || *value == '\0') {
    fprintf(stderr, "missing %s\n", name);
    exit(1);
  }
  errno = 0;
  parsed = strtol(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed < 0) {
    fprintf(stderr, "invalid %s\n", name);
    exit(1);
  }
  return parsed;
}

static const char *required_text(const char *name) {
  const char *value = getenv(name);
  if (value == NULL || *value == '\0') {
    fprintf(stderr, "missing %s\n", name);
    exit(1);
  }
  return value;
}

static void sleep_millis(long milliseconds) {
  struct timespec duration = {
      .tv_sec = milliseconds / 1000,
      .tv_nsec = (milliseconds % 1000) * 1000000L,
  };
  while (nanosleep(&duration, &duration) != 0 && errno == EINTR) {
  }
}

static void write_record(const char *path, pid_t escape_pid) {
  char record[1024];
  int length = snprintf(
      record,
      sizeof(record),
      "{\"brokerUid\":%ld,\"escapePid\":%ld,\"platform\":\"%s\","
      "\"producerName\":\"%s\",\"producerUid\":%ld,\"schemaVersion\":2}\n",
      required_number("OPENCOVEN_UNIX_BROKER_UID"),
      (long)escape_pid,
      required_text("OPENCOVEN_UNIX_PRODUCER_PLATFORM"),
      required_text("OPENCOVEN_UNIX_PRODUCER_NAME"),
      required_number("OPENCOVEN_UNIX_PRODUCER_UID"));
  if (length <= 0 || (size_t)length >= sizeof(record)) {
    fprintf(stderr, "record overflow\n");
    exit(1);
  }
  write_file(path, record, 0600);
}

static void run_escape(const char *record_path) {
  const char *workspace = required_text("OPENCOVEN_UNIX_ARTIFACT_DIRECTORY");
  char pid_path[4096];
  char trigger_path[4096];
  pid_t first;
  snprintf(pid_path, sizeof(pid_path), "%s/escape.pid", workspace);
  snprintf(trigger_path, sizeof(trigger_path), "%s/escape.trigger", workspace);

  first = fork();
  if (first < 0) fail("fork");
  if (first == 0) {
    pid_t second;
    if (setsid() < 0) fail("setsid");
    second = fork();
    if (second < 0) fail("fork");
    if (second > 0) _exit(0);
    {
      char pid_text[64];
      snprintf(pid_text, sizeof(pid_text), "%ld\n", (long)getpid());
      write_file(pid_path, pid_text, 0600);
    }
    while (access(trigger_path, F_OK) != 0) sleep_millis(5);
    sleep_millis(250);
    for (;;) {
      char replacement[4096];
      snprintf(replacement, sizeof(replacement), "%s.replacement.%ld", record_path, (long)getpid());
      write_file(replacement, "{\"canary\":\"escaped-replacement\",\"schemaVersion\":2}\n", 0600);
      (void)rename(replacement, record_path);
      sleep_millis(5);
    }
  }
  if (waitpid(first, NULL, 0) < 0) fail("waitpid");

  for (int attempt = 0; attempt < 100 && access(pid_path, F_OK) != 0; attempt++) {
    sleep_millis(10);
  }
  {
    FILE *pid_file = fopen(pid_path, "r");
    long escape_pid = 0;
    if (pid_file == NULL || fscanf(pid_file, "%ld", &escape_pid) != 1 || escape_pid <= 0) {
      fprintf(stderr, "escaped pid unavailable\n");
      exit(1);
    }
    fclose(pid_file);
    write_record(record_path, (pid_t)escape_pid);
  }
  write_file(trigger_path, "go\n", 0600);
}

int main(int argc, char **argv) {
  const char *record_path = required_text("OPENCOVEN_UNIX_SOURCE_RECORD");
  const char *artifacts = required_text("OPENCOVEN_UNIX_ARTIFACT_DIRECTORY");
  if (argc != 2) {
    fprintf(stderr, "usage: unix-producer-supervisor-attack CASE\n");
    return 2;
  }
  if (strcmp(argv[1], "escape") == 0 || strcmp(argv[1], "success") == 0) {
    if (strcmp(argv[1], "escape") == 0) {
      run_escape(record_path);
    } else {
      write_record(record_path, 0);
    }
    return 0;
  }
  if (strcmp(argv[1], "symlink") == 0) {
    char target[4096];
    snprintf(target, sizeof(target), "%s/symlink-target.json", artifacts);
    write_file(target, "{\"canary\":\"symlink\"}\n", 0600);
    if (symlink(target, record_path) != 0) fail("symlink");
    return 0;
  }
  if (strcmp(argv[1], "hardlink") == 0) {
    char sibling[4096];
    write_record(record_path, 0);
    snprintf(sibling, sizeof(sibling), "%s/second-link.json", artifacts);
    if (link(record_path, sibling) != 0) fail("link");
    return 0;
  }
  if (strcmp(argv[1], "parent-replacement") == 0) {
    if (rmdir(artifacts) != 0) fail("rmdir");
    if (mkdir(artifacts, 0700) != 0) fail("mkdir");
    write_record(record_path, 0);
    return 0;
  }
  fprintf(stderr, "unknown attack case\n");
  return 2;
}
