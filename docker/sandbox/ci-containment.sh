#!/usr/bin/env bash
# L2-11: runs the containment suite (L2-01) on a sandbox host and fails unless every probe is
# contained, for both runners: the gVisor runner (packages/sandbox) and the witness jail
# (packages/judge). Meant for a CI job on a self-hosted sandbox host; also fine by hand.
#
# Run from the repo root: bash docker/sandbox/ci-containment.sh
#
# Checks the host first and stops with a clear message, rather than reporting a pass, when Docker,
# the runsc-affidavit runtime or its trace directory is missing. Both suites always run, so one
# failure does not hide the other. The suites rewrite docs/lanes/lane2/containment.md; this
# script never commits it and prints what changed.
set -euo pipefail

RUNTIME="runsc-affidavit"
TRACE_ROOT="/var/lib/affidavit-runsc"

fail_host() {
  echo "ERROR: not a sandbox host: $1 (see docs/lanes/lane2/sandbox-runner.md, Host setup)" >&2
  exit 2
}

command -v docker >/dev/null 2>&1 || fail_host "docker is not installed"
docker info >/dev/null 2>&1 || fail_host "the Docker daemon is not reachable by this user"
docker info --format '{{json .Runtimes}}' | grep -q "\"${RUNTIME}\"" ||
  fail_host "the ${RUNTIME} runtime is not configured"
[ -d "${TRACE_ROOT}" ] && [ -w "${TRACE_ROOT}" ] ||
  fail_host "${TRACE_ROOT} is missing or not writable by this user"
command -v pnpm >/dev/null 2>&1 || fail_host "pnpm is not installed"

status=0
echo "== containment: gVisor runner (packages/sandbox)"
pnpm --filter @affidavit/sandbox containment --require-pass || status=1
echo "== containment: witness jail (packages/judge)"
pnpm --filter @affidavit/judge containment --require-pass || status=1

if command -v git >/dev/null 2>&1; then
  echo "== containment.md changes (not committed)"
  git --no-pager diff --stat -- docs/lanes/lane2/containment.md || true
fi

if [ "${status}" -ne 0 ]; then
  echo "FAILED: at least one probe was not contained; see docs/lanes/lane2/containment.md" >&2
  exit 1
fi
echo "PASSED: every probe contained on both runners"
