#!/usr/bin/env bash
# Registers the `runsc-affidavit` Docker runtime: gVisor with a syscall trace, one file per
# container in /var/lib/affidavit-runsc, readable and deletable by the docker group. The sandbox
# runner (packages/sandbox/src/gvisor) parses that trace to record escape attempts. The plain
# `runsc` runtime is left untouched. Run after install-gvisor.sh, with:
#   sudo bash docker/sandbox/setup-runsc-audit.sh
set -euo pipefail

USER_NAME="${SUDO_USER:?run this with sudo from your normal user}"
LOG_ROOT=/var/lib/affidavit-runsc
# Keep in sync with packages/sandbox/src/gvisor/trace.ts.
SYSCALLS="socket,connect,sendto,sendmsg,sendmmsg,bind,open,openat,openat2,creat,mkdir,mkdirat,unlink,unlinkat,rename,renameat,renameat2,link,linkat,symlink,symlinkat,truncate,clone,clone3,fork,vfork,execve"

# 1. Trace directory: group docker can read and delete traces, nobody else. The SELinux label lets
#    dockerd (container_runtime_t) write there.
mkdir -p "$LOG_ROOT"
chown root:docker "$LOG_ROOT"
chmod 2770 "$LOG_ROOT"
setfacl -m g:docker:rwx -d -m g:docker:rwx -d -m o::--- "$LOG_ROOT"
if command -v semanage >/dev/null 2>&1; then
  semanage fcontext -a -t container_var_lib_t "${LOG_ROOT}(/.*)?" 2>/dev/null \
    || semanage fcontext -m -t container_var_lib_t "${LOG_ROOT}(/.*)?"
  restorecon -R "$LOG_ROOT"
elif command -v chcon >/dev/null 2>&1 && selinuxenabled 2>/dev/null; then
  chcon -R -t container_var_lib_t "$LOG_ROOT"
fi

# 2. Add the runtime to daemon.json (backup first). The trace is a FILE per container written
#    straight into LOG_ROOT: runsc creates per-container directories with mode 0750, which the
#    docker group could read but never delete.
cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)"
python3 - "$LOG_ROOT" "$SYSCALLS" <<'PY'
import json, sys
log_root, syscalls = sys.argv[1], sys.argv[2]
path = '/etc/docker/daemon.json'
cfg = json.load(open(path))
cfg.setdefault('runtimes', {})['runsc-affidavit'] = {
    'path': '/usr/local/bin/runsc',
    'runtimeArgs': [
        '--strace',
        f'--strace-syscalls={syscalls}',
        '--debug',
        f'--debug-log={log_root}/%ID%.%COMMAND%.txt',
        '--debug-command=boot',
    ],
}
json.dump(cfg, open(path, 'w'), indent=4)
PY
systemctl restart docker

# 3. Smoke test: a container tries to connect out; the trace must show it, and the calling user
#    must be able to read and delete it.
IMG=node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
docker run --name affidavit-audit-smoke --runtime=runsc-affidavit --security-opt label=disable \
  --network none "$IMG" node -e 'require("net").connect(443,"1.1.1.1").on("error",()=>{})' || true
ID="$(docker inspect --format '{{.Id}}' affidavit-audit-smoke)"
docker rm -f affidavit-audit-smoke >/dev/null
FILE="$LOG_ROOT/$ID.boot.txt"
sudo -u "$USER_NAME" grep -q "connect(" "$FILE" || { echo "ERROR: connect not found in $FILE, or not readable"; exit 1; }
sudo -u "$USER_NAME" rm -f "$FILE" || { echo "ERROR: $USER_NAME cannot delete $FILE"; exit 1; }
test ! -e "$FILE" || { echo "ERROR: $FILE was not deleted"; exit 1; }
echo "AUDIT OK: the connect was traced, and $USER_NAME can read and delete the trace"
