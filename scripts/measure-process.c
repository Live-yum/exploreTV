#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Linux-only benchmark helper: exec argv without a shell and reap full-lifetime
 * child usage. The normal overview CLI does not require a compiler or helper. */
static volatile sig_atomic_t child_pid = -1;
static void forward_signal(int signal_number) {
  if (child_pid > 0) kill((pid_t)child_pid, signal_number);
}
int main(int argc, char **argv) {
  sigset_t blocked, old_mask;
  sigemptyset(&blocked); sigaddset(&blocked, SIGTERM); sigaddset(&blocked, SIGINT);
  if (sigprocmask(SIG_BLOCK, &blocked, &old_mask) != 0) { perror("sigprocmask"); return 125; }
  if (argc < 3) { fprintf(stderr, "usage: measure-process report.json executable [args...]\n"); return 125; }
  FILE *report = fopen(argv[1], "wx");
  if (!report) { perror("measurement report"); return 125; }
  setvbuf(report, NULL, _IONBF, 0);
  struct sigaction action = {0};
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  struct timespec start, end;
  clock_gettime(CLOCK_MONOTONIC, &start);
  pid_t pid = fork();
  if (pid < 0) { perror("fork"); fclose(report); return 125; }
  if (pid == 0) {
    fclose(report);
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL);
    sigprocmask(SIG_SETMASK, &old_mask, NULL);
    execvp(argv[2], argv + 2);
    perror("execvp"); _exit(127);
  }
  child_pid = pid;
  sigprocmask(SIG_SETMASK, &old_mask, NULL);
  int status;
  struct rusage child_usage = {0}, own_usage = {0};
  while (wait4(pid, &status, 0, &child_usage) < 0) {
    if (errno == EINTR) continue;
    perror("wait4"); fclose(report); return 125;
  }
  child_pid = -1;
  clock_gettime(CLOCK_MONOTONIC, &end);
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  getrusage(RUSAGE_SELF, &own_usage);
  double elapsed = (double)(end.tv_sec-start.tv_sec) + (double)(end.tv_nsec-start.tv_nsec)/1e9;
  int written = fprintf(report,
    "{\"method\":\"Linux wait4 child lifetime plus monitor getrusage\",\"exitCode\":%d,\"elapsedSeconds\":%.6f,\"exporterOsPeakRssBytes\":%lld,\"monitorOsPeakRssBytes\":%lld}\n",
    code, elapsed, (long long)child_usage.ru_maxrss*1024LL, (long long)own_usage.ru_maxrss*1024LL);
  if (written < 0 || fclose(report) != 0) { perror("write measurement report"); return 125; }
  return code;
}
