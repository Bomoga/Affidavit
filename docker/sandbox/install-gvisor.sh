#!/usr/bin/env bash
# Installs gVisor (runsc) for Docker on a Lane 2 sandbox host, verifying the tarball against a
# SHA-512 pinned in this file, and registers the plain `runsc` runtime. Then run
# setup-runsc-audit.sh for the traced runtime.
# Run with: sudo bash docker/sandbox/install-gvisor.sh
# gVisor ships one tarball (gvisor.tar.zstd) holding runsc, the containerd shim and gvisor-bin/.
set -euo pipefail

# The release the containment suite last passed on (docs/lanes/lane2/containment.md). Change it
# only together with a fresh containment run and new pinned hashes below.
RELEASE="20261109.0"
ARCH="$(uname -m)"

# Expected SHA-512 of gvisor.tar.zstd for RELEASE, per architecture. Pinned here on purpose: the
# .sha512 file published next to the tarball comes from the same bucket, so checking against it
# only proves the download was not truncated, not that the bucket was not tampered with.
#
# Recorded 2026-11-17 by the Lane 2 owner. Each value was checked against two channels outside the
# bucket: SHA512SUMS on the google/gvisor GitHub release release-20261109.0, and the SHA-256 that
# GitHub computed for each uploaded asset. How: docs/lanes/lane2/sandbox-runner.md.
case "${ARCH}" in
  x86_64) EXPECTED_SHA512="0a0041fd862f4ea3042a9db8d41c742f48a01f909699adc2a0256e46d85e53f97b82b9fd154b3dce636f62b8d557677639f91c77d13f3f875ff9fa535275393c" ;;
  aarch64) EXPECTED_SHA512="a0b5d911512ef5fe70e833821e653a90c4d06c7027246ee49423f1d2fe2b2a509389a637797248958b90e49a069bb079ecde860efe1871b1d980ec0fe17e18ac" ;;
  *)
    echo "ERROR: no pinned gVisor checksum for architecture ${ARCH}" >&2
    exit 1
    ;;
esac
if ! [[ "${EXPECTED_SHA512}" =~ ^[0-9a-f]{128}$ ]]; then
  echo "ERROR: the pinned SHA-512 for gVisor ${RELEASE} on ${ARCH} is missing or a placeholder." >&2
  echo "Record the real value in docker/sandbox/install-gvisor.sh before installing." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "Downloading gVisor release ${RELEASE}..."
# Release directories are named either 20261109.0 or 20261109.
for dir in "${RELEASE}" "${RELEASE%.0}"; do
  URL="https://storage.googleapis.com/gvisor/releases/release/${dir}/${ARCH}"
  curl -fsSLO "${URL}/gvisor.tar.zstd" && break
done
test -f gvisor.tar.zstd || { echo "ERROR: release ${RELEASE} not found" >&2; exit 1; }
echo "${EXPECTED_SHA512}  gvisor.tar.zstd" | sha512sum -c --strict -

mkdir extracted
tar --zstd -xf gvisor.tar.zstd -C extracted --no-same-owner
test -x extracted/runsc || { echo "ERROR: the tarball has no runsc" >&2; exit 1; }

# runsc looks for gvisor-bin/ next to itself.
cp -a extracted/. /usr/local/bin/
chown -R root:root /usr/local/bin/runsc /usr/local/bin/gvisor-bin 2>/dev/null || true
restorecon -R /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1 /usr/local/bin/gvisor-bin 2>/dev/null || true

if [ -f /etc/docker/daemon.json ]; then
  cp /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%s)"
fi
/usr/local/bin/runsc install
systemctl restart docker

/usr/local/bin/runsc --version
# label=disable: gVisor cannot start under an SELinux process label (docs/lanes/lane2/sandbox-runner.md).
docker run --rm --runtime=runsc --security-opt label=disable --network none hello-world >/dev/null \
  && echo "gVisor OK: hello-world ran inside runsc"
