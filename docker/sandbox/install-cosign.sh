#!/usr/bin/env bash
# Installs cosign on a Lane 2 host (the signer's host, and any machine that verifies verdicts),
# verifying the binary against a SHA-256 pinned in this file.
# Run with: bash docker/sandbox/install-cosign.sh [install dir, default ~/.local/bin]
# The signer only ever runs cosign offline (apps/signer: empty signing config, nothing uploaded
# to Sigstore), so no Sigstore account, OIDC identity or trust root is needed.
set -euo pipefail

VERSION="v3.1.4"
DEST="${1:-${HOME}/.local/bin}"

# SHA-256 of cosign-linux-<arch> for VERSION. Recorded on 2026-11-18 from three sources that
# agreed: cosign_checksums.txt of the GitHub release, the digest GitHub computes for the release
# asset, and sha256sum of the downloaded binary.
case "$(uname -m)" in
  x86_64)
    ASSET="cosign-linux-amd64"
    EXPECTED_SHA256="424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa"
    ;;
  aarch64)
    ASSET="cosign-linux-arm64"
    EXPECTED_SHA256="ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2"
    ;;
  *)
    echo "ERROR: no pinned cosign checksum for architecture $(uname -m)" >&2
    exit 1
    ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fsSL -o "${WORK}/${ASSET}" \
  "https://github.com/sigstore/cosign/releases/download/${VERSION}/${ASSET}"
echo "${EXPECTED_SHA256}  ${WORK}/${ASSET}" | sha256sum -c --strict -

mkdir -p "${DEST}"
install -m 0755 "${WORK}/${ASSET}" "${DEST}/cosign"
"${DEST}/cosign" version | grep -q "GitVersion: *${VERSION}" || {
  echo "ERROR: installed cosign does not report ${VERSION}" >&2
  exit 1
}
echo "cosign ${VERSION} installed in ${DEST}"
