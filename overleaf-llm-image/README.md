# overleaf-lab/sharelatex-llm — Overleaf image with the LLM AI Assistant

Custom image that layers the **Local-LLM AI Assistant** module
(PR [#171](https://github.com/yu-i-i/overleaf-cep/pull/171), commit `f908a9698b`)
onto `overleafcep/sharelatex:6.2.0-ext-v5.0` and rebuilds the web frontend so the
module UI is bundled in.

**Adds:** a left-rail **AI Assistant** chat, **"Ask AI"** on selected text,
**"Ask AI about this error"** on compile-log entries, **inline completion**, a
**document compliance review** (checks the whole project against admin-defined
rubrics), a **super-admin** settings page (`/admin/llm/settings`), and optional
**per-user** settings (`/user/llm-settings`). The backend proxies to any
OpenAI-compatible server (`POST {LLM_API_URL}/chat/completions`).

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
| `LLM_REVIEW_MAX_TOKENS` | review answer budget (max_tokens + reserved room); empty = 12000 |
| `LLM_REVIEW_CHARS_PER_TOKEN` | chars/token for the pre-flight size estimate; LaTeX-tuned (default 2.5) |
| `LLM_REVIEW_PREFILL_TPS` | prefill tokens/sec, only for the review progress estimate (default 80) |
| `LLM_REVIEW_GEN_TPS` | generation tokens/sec, only for the review progress estimate (default 4) |
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

**Disabling shared completion.** In the admin settings the shared inline-completion
model can be set to **Disabled**. Inline completion then runs only for users who
configured their own API key (personal settings); everyone else gets no suggestion.
This spares a self-hosted CPU backend from the high-frequency autocomplete load while
chat and the review keep using it.

**Admin page is super-admin-only.** `/admin/llm/settings` and its JSON/check/models
routes require the `super_admin` role (consistent with
`scripts/patch-super-admin.js`); a normal admin is redirected to `/restricted`.

**Feature toggles (governance).** The admin page opens with a **Features** section of
three switches: **chat**, **inline completion**, and **compliance review** (all on by
default). A disabled feature is **refused by the backend for everyone**, including
users with their own API key, not merely hidden in the UI. The editor hides the
matching UI (a disabled chat hides the chat tab and the "Ask AI" toolbar; a disabled
review hides the Review tab; with chat off and review on the Review panel stays
visible). If both chat and completion are off, the per-user AI Settings page is
hidden. Flags live in the admin-settings JSON and are read fresh per request
(`GET /project/:id/llm/features` feeds the frontend).

## Document compliance review (overleaf-lab)

A lab-specific feature (not in PR #171). It sends the **whole project** (all `.tex`
files, assembled server-side via `getAllDocs`, main file first, LaTeX comments
stripped) to the review model and checks it against an admin-defined **rubric** of
writing guidelines (thesis / internship indications), returning a per-requirement
report.

- **Admin setup** (super-admin, `/admin/llm/settings`, "Compliance Review" section):
  add one or more named **rubrics** (name + guidelines text), pick the **review
  model** (defaults to the shared chat model; point it at a large-context model), and
  set **Max context tokens** to the review model's context window (no auto-detection,
  it is only a setting).
- **Users** open the AI Assistant rail, switch to the **Review** tab, choose a rubric
  and run. Each item shows a status (ok / partial / missing / n.a.), the evidence, and
  a suggestion, with a **Download report** button (Markdown) so the result survives
  the non-persisted chat.
- **Queue.** A review is long, so the backend runs **one at a time per web process**;
  extra requests queue and the UI shows the position. A queued or running review can
  be **cancelled**, and is cancelled automatically on page refresh/close. Switching
  the Chat/Review tab does **not** cancel it (both panes stay mounted).
- **Progress.** While running, the pane shows a phase label ("Reading the document"
  then "Writing the report") and an estimated progress bar with elapsed time. The
  review is one blocking call with no exact percentage, so the bar is an estimate
  from the backend throughput (`LLM_REVIEW_PREFILL_TPS` / `LLM_REVIEW_GEN_TPS`);
  elapsed time is exact. A wrong estimate only skews the bar, never the result.
- **Guards.** The whole prompt (document + rubric + system + output room) is budgeted
  against Max context tokens; an over-long project is refused (`too_long`) instead of
  silently truncated. The size check is an ESTIMATE (`LLM_REVIEW_CHARS_PER_TOKEN`,
  default 2.5, tuned for LaTeX which tokenizes much denser than prose), so it can still
  let a borderline document through: in that case the backend's own context rejection
  is parsed and reported as `too_long` with the REAL prompt and context token counts,
  which is the number to act on. The output room reserved (and the model's
  `max_tokens`) is `LLM_REVIEW_MAX_TOKENS` (default 12000). Any other backend refusal
  surfaces as `backend_error` with the backend's own message instead of a misleading
  timeout. If a specific review model is configured,
  its presence is verified against the backend `/models` before running
  (`model_unavailable` otherwise). One-shot only for now; section chunking for very
  long theses is a possible v2.
- **Structured output.** The request pins `response_format` to a JSON schema, so a
  backend that supports it (llama.cpp, OpenAI) is constrained to emit exactly the
  per-requirement shape. That guarantees parseable output and, since prose is
  forbidden, keeps a reasoning model from spending the whole budget on internal
  thinking. For a local reasoning model, also turn thinking off at the router
  (`CHAT_TEMPLATE_KWARGS={"enable_thinking":false}`) since the two can otherwise
  conflict in the chat template; validate once against your model after building.
- **Routes** (all project-scoped, login required): `GET .../llm/compliance/rubrics`,
  `POST .../llm/compliance/start`, `GET .../llm/compliance/status/:jobId`,
  `POST .../llm/compliance/cancel/:jobId`. Rubrics + review model + max context live
  in the admin-settings JSON.

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
- The selection toolbar / **"Ask AI" follows the model selected in the chat**
  (persisted client-side), falling back to the user's personal model or the shared
  backend (upstream sends no model, so it only used the shared backend).
- **Document compliance review** against admin rubrics: whole-project, queued,
  cancellable, downloadable report (see the section above). Not in PR #171.
- Admin can **disable shared inline completion** (it then runs only for users with
  their own API key), to keep autocomplete off a loaded self-hosted backend.
- **Per-feature super-admin toggles** (chat / inline completion / compliance review),
  backend-enforced even against personal keys (a disabled feature is refused, not just
  hidden), with the editor and user-settings UI hidden to match.
- **All AI prompts editable by super-admins** from `/admin/llm/settings`: the chat
  system prompt, the Ask AI behavior prompt, the error-help prompt, the review system
  prompt, and the 10 Ask AI action templates (paraphrase, academic, concise, punchy,
  split, join, summarize, title, abstract, explain; each uses a `{{selection}}`
  placeholder). Defaults are the shipped values; an empty field falls back to the
  default. Frontend prompts are served via `GET /project/:id/llm/prompts`.
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
