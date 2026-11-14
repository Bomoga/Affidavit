#!/usr/bin/env bash
# Installs gVisor (runsc) for Docker on a Lane 2 sandbox host, verifying the checksum, and
# registers the plain `runsc` runtime. Then run setup-runsc-audit.sh for the traced runtime.
# Run with: sudo bash docker/sandbox/install-gvisor.sh
# gVisor ships one tarball (gvisor.tar.zstd) holding runsc, the containerd shim and gvisor-bin/.
set -euo pipefail

# The release the containment suite last passed on (docs/lanes/lane2/containment.md). Change it
# only together with a fresh containment run.
RELEASE="${GVISOR_RELEASE:-20261109.0}"
ARCH="$(uname -m)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "Downloading gVisor release ${RELEASE}..."
# Release directories are named either 20261109.0 or 20261109.
for dir in "${RELEASE}" "${RELEASE%.0}"; do
  URL="https://storage.googleapis.com/gvisor/releases/release/${dir}/${ARCH}"
  curl -fsSLO "${URL}/gvisor.tar.zstd" && curl -fsSLO "${URL}/gvisor.tar.zstd.sha512" && break
done
test -f gvisor.tar.zstd.sha512 || { echo "ERROR: release ${RELEASE} not found"; exit 1; }
sha512sum -c gvisor.tar.zstd.sha512

mkdir extracted
tar --zstd -xf gvisor.tar.zstd -C extracted --no-same-owner
test -x extracted/runsc || { echo "ERROR: the tarball has no runsc"; exit 1; }

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
