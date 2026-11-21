# The fixed image for the patch workbench's jailed apply step (L2-07): git on the same pinned
# Alpine base as the witness runner and the containment probes. The Judge builds it locally
# (`buildPatchApplyImage`) and runs it by image ID, as nobody, with no network.
# The git package is pinned; when Alpine drops this version the build fails, and the pin is bumped
# deliberately.
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
RUN apk add --no-cache git=2.54.1-r0
USER 65534:65534
LABEL org.affidavit.role="patch-apply"
