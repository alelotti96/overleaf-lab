# syntax=docker/dockerfile:1.6
# =============================================================================
# overleaf-lab/sharelatex-llm:6.2.0-ext-v5.0
#
# Layers the vendored "llm" module (PR #171, yu-i-i/overleaf-cep) onto the exact
# released CEP image and REBUILDS THE FRONTEND, which is mandatory: webpack
# discovers modules at build time by globbing modules/*/frontend/js/pages/** , so
# the module's React UI only exists after a webpack:production pass.
#
# The released base image still ships the full services/web source + build driver
# (genScript.js); only dev-dependencies were pruned. We restore them with
# `yarn install`, rebuild, then re-prune in the SAME RUN so dev deps never land in
# a layer. See overleaf-llm-image/README.md for prerequisites and rollback.
# =============================================================================

ARG BASE_IMAGE=overleafcep/sharelatex:6.2.0-ext-v5.0
FROM ${BASE_IMAGE}

# -----------------------------------------------------------------------------
# 1) Drop in the vendored module (backend + frontend + scss). Purely additive.
#    Maps overleaf-llm-image/vendor/llm/ -> services/web/modules/llm/.
# -----------------------------------------------------------------------------
COPY vendor/llm/ /overleaf/services/web/modules/llm/

# -----------------------------------------------------------------------------
# 2) Apply ONLY the functional core edits of PR #171 (the 11 modified core files;
#    cosmetic prettier reformatting is intentionally dropped). The engine is
#    idempotent and FAILS THE BUILD (non-zero exit) if any anchor is missing,
#    so a drifted base image can never yield a half-patched image.
#    NOTE: the LLM commit has NO package.json change, so the yarn install below
#    stays --immutable (the lockfile is untouched).
# -----------------------------------------------------------------------------
COPY apply-core-patches.sh /tmp/llm-patch/apply-core-patches.sh
COPY patches/ /tmp/llm-patch/patches/
RUN bash /tmp/llm-patch/apply-core-patches.sh /overleaf/services/web

# -----------------------------------------------------------------------------
# 3) Rebuild the frontend (web workspace only, for speed) in ONE RUN:
#      yarn install --immutable   -> restore dev toolchain (webpack/babel/...)
#      assert node-fetch + abort-controller resolve (module backend needs them)
#      yarn run precompile-pug     -> recompile pug incl. patched navbar + views
#      yarn run webpack:production  -> rebuild the client bundle (picks up module)
#      yarn workspaces focus --all --production  -> re-prune dev deps (same layer)
#
#    Equivalent faithful fallback (recompiles all services, only web does work):
#      cd /overleaf && node genScript compile | bash
#
#    NODE_OPTIONS is scoped to this RUN so the heap bump does not leak into the
#    runtime image. BuildKit cache mounts speed up repeat builds and are NOT
#    persisted into layers. enableGlobalCache is false in this repo, so the yarn
#    cache lives at /overleaf/.yarn/cache.
# -----------------------------------------------------------------------------
RUN --mount=type=cache,target=/overleaf/.yarn/cache \
    --mount=type=cache,target=/overleaf/services/web/node_modules/.cache \
    set -eu; \
    cd /overleaf/services/web; \
    export NODE_OPTIONS=--max-old-space-size=4096; \
    echo ">> yarn install (immutable, restores dev deps)"; \
    yarn install --immutable; \
    echo ">> asserting module backend deps resolve"; \
    node -e "require.resolve('node-fetch'); require.resolve('abort-controller')" \
      || { echo "FATAL: node-fetch / abort-controller not resolvable in services/web. The LLM module backend requires both; aborting before webpack." >&2; exit 1; }; \
    echo ">> precompile-pug"; \
    yarn run precompile-pug; \
    echo ">> webpack:production (rebuild client bundle with llm module)"; \
    yarn run webpack:production; \
    echo ">> re-pruning dev dependencies (production-only)"; \
    yarn workspaces focus --all --production; \
    rm -rf /tmp/llm-patch

# Runtime (entrypoint, runit, nginx, ports) is inherited unchanged from the base
# image. Enable the feature at RUN time with LLM_ENABLED=true (+ LLM_API_URL etc).
