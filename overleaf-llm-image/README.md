# overleaf-lab/sharelatex-llm — Overleaf image with the LLM AI Assistant

Custom image that layers the **Local-LLM AI Assistant** module
(PR [#171](https://github.com/yu-i-i/overleaf-cep/pull/171), commit `f908a9698b`)
onto `overleafcep/sharelatex:6.2.0-ext-v5.0` and rebuilds the web frontend so the
module UI is bundled in.

**Adds:** a left-rail **AI Assistant** chat, **"Ask AI"** on selected text,
**"Ask AI about this error"** on compile-log entries, **inline completion**, a
**super-admin** settings page (`/admin/llm/settings`), and optional **per-user**
settings (`/user/llm-settings`). The backend proxies to any OpenAI-compatible
server (`POST {LLM_API_URL}/chat/completions`).

Output tag: **`overleaf-lab/sharelatex-llm:6.2.0-ext-v5.0`**.

## Build

A frontend rebuild is mandatory: webpack discovers modules at build time (glob
`modules/*/frontend/js/pages/**`) into one monolithic bundle, so the React UI
cannot be bind-mounted into a running container. The base image keeps the full
`services/web` source + build driver (only dev-deps were pruned; `yarn install`
restores them), so we **layer** rather than build from source.

**Needs:** Docker + **Buildx** (the Dockerfile uses `--mount=type=cache`, which
requires the buildx builder; install the `docker-buildx` plugin if missing —
`build.sh` sets `DOCKER_BUILDKIT=1`) · base image present/pullable · `vendor/llm/`
populated · build-time npm access · **≥ 8 GB RAM** · **~15-30 min** (TeX Live is
inherited from the base, not rebuilt).

```bash
./build.sh
# = docker build --build-arg BASE_IMAGE=overleafcep/sharelatex:6.2.0-ext-v5.0 \
#     -t overleaf-lab/sharelatex-llm:6.2.0-ext-v5.0 overleaf-llm-image
```

The build: COPY the module → `apply-core-patches.sh` (idempotent, anchor-based;
re-applies only PR #171's *functional* core changes, drops its prettier noise,
**fails the build on any anchor miss**) → one `RUN` of `yarn install --immutable`
+ `webpack:production` + re-prune. The commit ships no `package.json` change, so
the install stays immutable.

## Enable / rollback (one variable)

Driven by overleaf-lab's `ENABLE_LLM_MODULE` in `config.env`: when `true`,
`configure.sh` swaps `OVERLEAF_IMAGE`/`OVERLEAF_IMAGE_TAG` to this image and writes
the `LLM_*` env; when `false`, the stock image is used and nothing LLM-related is
written (identical to a build without the feature). **Rollback** = set it back to
`false` (or `git checkout master`), re-run configure, restart. The stock image is
never mutated.

Runtime env (written by `configure.sh` from `config.env`):

| Var | Meaning |
|---|---|
| `LLM_ENABLED` | `true` loads the module |
| `LLM_API_URL` | shared OpenAI-compatible endpoint, incl. `/v1` |
| `LLM_API_KEY` | bearer token (empty for a no-auth local server) |
| `LLM_MODEL_NAME` | comma-separated; first = default |
| `LLM_COMPLETION_MODEL` | optional model for shared inline completion |
| `LLM_ALLOW_USER_SETTINGS` | `true` = users may bring their own key (below) |
| `LLM_KEY_SECRET` | auto-generated/persisted by `configure.sh`; encrypts user keys |
| `LLM_ADMIN_SETTINGS_PATH` | admin-settings JSON path (persistent volume) |

Backend model fallbacks are env-configurable (no hardcoded model): set
`LLM_MODEL_NAME`, and the admin "Test connection" uses your first configured model.

## Bring-your-own keys (OpenAI / Anthropic)

With `LLM_ALLOW_USER_SETTINGS=true`, each user sets their own endpoint + key +
model in **AI Settings**; a **"🔒 Personal"** model then appears in the chat picker
and routes to *their* account, coexisting with the shared model. Any
OpenAI-compatible provider works:

- **OpenAI** — URL `https://api.openai.com/v1`, key `sk-...`, model e.g. `gpt-4o`.
- **Anthropic** — URL `https://api.anthropic.com/v1` (OpenAI-compatible), key
  `sk-ant-...`, model e.g. `claude-sonnet-4-6`.

**Key encryption.** User keys (`User.llmApiKey`) are **AES-256-GCM encrypted at
rest** via `LLM_KEY_SECRET`. Transparent and back-compatible (legacy plaintext is
still read; a missing secret degrades gracefully instead of crashing). **Rotating
or losing `LLM_KEY_SECRET` invalidates all stored keys** — users must re-enter them.

**Per-user completion model.** In AI Settings each user picks the inline-completion
model: **Local (shared, default, free)**, their provider's cheap model (OpenAI
`gpt-4.1-nano`/`gpt-4o-mini`, Anthropic `claude-haiku-4-5`), or a custom id. The
default keeps high-frequency completion on the shared/local model.

**Admin page is super-admin-only.** `/admin/llm/settings` and its JSON/check/models
routes require the `super_admin` role (consistent with
`scripts/patch-super-admin.js`); a normal admin is redirected to `/restricted`.

## Notes

- **Non-streaming chat.** Single blocking reply, server timeout **300 s**. The CEP
  nginx template already proxies `location /` with `proxy_read_timeout 10m` (600 s),
  which covers it — so `nginx-customizations.sh` adds **no** timeout override (adding
  one duplicates the directive and makes nginx abort at boot). Completion /
  connection checks use 30 s.
- **Admin keys** live in a plaintext JSON file at
  `/var/lib/overleaf/data/llm-admin-settings.json` — keep it on a writable
  persistent volume, or admin-set keys are lost on restart.
- **Unmerged upstream.** This pins the commit's functional changes onto the frozen
  `v6.2.0-ext-v5.0` source; re-vendor and re-validate anchors if you bump the base.
- **Chat is not persisted.** The backend is a stateless proxy; conversation history
  lives only in the browser session and is lost on reload / navigation.
- **Selection toolbar / "Ask AI".** Upstream these send no model and therefore only
  use the shared backend. This build routes them to the user's **personal** model
  when one is configured (falling back to the shared backend otherwise).

## Layout

```
overleaf-llm-image/
  Dockerfile                     # layered build + one-RUN frontend rebuild
  build.sh                       # docker build wrapper (needs vendor/llm present)
  apply-core-patches.sh          # entry point for the core-file patcher
  patches/apply-core-patches.mjs # idempotent, anchor-based, fail-loud engine
  vendor/llm/                    # the vendored module (fixed + super-admin-gated)
  README.md
```

## Local changes on top of PR #171

Everything under `vendor/llm/` is the upstream module with only these local
adjustments (plus host wiring in `config.env` / `scripts/`):

- Made the three hardcoded `qwen3-32b` model fallbacks env-configurable.
- **AES-256-GCM encryption** of per-user API keys at rest (`LLMCrypto.mjs` + `LLM_KEY_SECRET`).
- Bring-your-own keys work with **OpenAI and Anthropic** (OpenAI-compatible endpoint).
- Per-user **inline-completion model** choice (provider-aware).
- Admin settings restricted to **`super_admin`** (see `LLMRouter.mjs`).
- The selection toolbar / **"Ask AI" now uses the user's personal model** when
  configured (upstream sends no model, so it only used the shared backend).
- Opt-in packaging: layered build, anchor-based core patcher, one-variable enable/rollback.

## Credits

The LLM AI Assistant is the work of **David Rotermund**
([@davrot](https://github.com/davrot)), contributed as
**[PR #171](https://github.com/yu-i-i/overleaf-cep/pull/171)** ("llm", commit
`f908a9698b`) to [yu-i-i/overleaf-cep](https://github.com/yu-i-i/overleaf-cep), and
itself derived from [lcpu-club/overleaf](https://github.com/lcpu-club/overleaf).
Licensed **AGPL-3.0**. This directory only vendors that module into a buildable
custom image and adds the opt-in packaging + local changes listed above; all
AI-assistant functionality is upstream work.
