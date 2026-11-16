# The fixed witness runner image (L2-05): pinned Node, Vitest from package-lock.json, and the
# runner. Build with `pnpm --filter @affidavit/judge runner-image`; the Judge runs it by image ID.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS deps
WORKDIR /runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /runner
COPY --from=deps /runner/node_modules ./node_modules
COPY package.json run.mjs witness-api.mjs witness-api.d.mts ./
RUN mkdir /runner/witness
ENV NO_COLOR=1
USER 65534:65534
LABEL org.affidavit.role="witness-runner"
