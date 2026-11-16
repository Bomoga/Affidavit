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
# [sha512] PLACEHOLDER: the real values have not been recorded yet. Until a maintainer fills them
# in (from a verified download of RELEASE, noted in docs/lanes/lane2/sandbox-runner.md), this
# script refuses to install anything.
case "${ARCH}" in
  x86_64) EXPECTED_SHA512="[sha512]" ;;
  aarch64) EXPECTED_SHA512="[sha512]" ;;
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
