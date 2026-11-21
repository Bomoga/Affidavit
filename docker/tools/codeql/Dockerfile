# DISABLED. Do not build until the CodeQL licensing decision (P0-10) lands and an owner enables it
# in tools.json. The build refuses to run without an explicit bundle URL and checksum, so it cannot
# be built by accident or with an unpinned download.
#
#   docker build --build-arg CODEQL_BUNDLE_URL=<url> --build-arg CODEQL_BUNDLE_SHA256=<sha256> ...
FROM ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8

ARG CODEQL_BUNDLE_URL=""
ARG CODEQL_BUNDLE_SHA256=""

RUN test -n "$CODEQL_BUNDLE_URL" && test -n "$CODEQL_BUNDLE_SHA256" \
    || (echo "CodeQL is disabled: set CODEQL_BUNDLE_URL and CODEQL_BUNDLE_SHA256 after P0-10" >&2; exit 1)

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl zstd \
    && curl -fsSL "$CODEQL_BUNDLE_URL" -o /tmp/codeql.tar.zst \
    && echo "$CODEQL_BUNDLE_SHA256  /tmp/codeql.tar.zst" | sha256sum -c - \
    && mkdir /opt/codeql && tar --zstd -xf /tmp/codeql.tar.zst -C /opt/codeql --strip-components=1 \
    && rm -rf /tmp/codeql.tar.zst /var/lib/apt/lists/*

ENTRYPOINT ["/opt/codeql/codeql"]
