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
| `LLM_REVIEW_MAX_TOKENS` | fallback review answer budget when the admin page has none set (default 12000) |
| `LLM_REVIEW_CHARS_PER_TOKEN` | chars/token fallback when the backend has no `/tokenize` (default 3.0) |
| `LLM_REVIEW_PREFILL_TPS` | pin the prefill tokens/sec used by the progress bar (normally auto-measured) |
| `LLM_REVIEW_GEN_TPS` | pin the generation tokens/sec used by the progress bar (normally auto-measured) |
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
report. The review is **multi-pass**: the rubric is split into individual
requirements and each one gets its own dedicated model call over the full document,
so the model can actually enumerate figures, scan the bibliography, and so on for
that one requirement, instead of skimming 20+ requirements in a single pass (which
produced rubber-stamp "all ok" reports with unrelated evidence).

- **Admin setup** (super-admin, `/admin/llm/settings`, "Compliance Review" section):
  add one or more named **rubrics** (name + guidelines text), pick the **review
  model** (defaults to the shared chat model; point it at a large-context model), set
  **Max context tokens** to the review model's context window (no auto-detection, it is
  only a setting), and optionally raise the **Review answer budget** if reports come out
  truncated with a large rubric.

### How to write a rubric

The splitter turns the guidelines text into one check per requirement, so the way
the rubric is written directly controls the review quality:

- **One requirement per numbered line** (`1.`, `2.`, ... or `1)`, `2)`): each becomes
  its own model pass. This is the recommended format.
- **Continuation lines** (lines that do not start with a number) belong to the
  requirement above, so a requirement can span multiple lines.
- **Text before the first numbered line is a preamble**, repeated in every pass as
  context (e.g. "Requisiti per una tesi triennale del laboratorio X").
- **Bulleted lines** (`-`, `*`, `•`) also split, but only when the rubric has no
  numbered lines; inside a numbered requirement they are kept as sub-points.
- **Unstructured prose degrades gracefully** to the old single-pass review over the
  whole text: never split arbitrarily, but also much shallower. Number your rubric.
- **Keep each requirement atomic and verifiable from the LaTeX source.** "Every
  figure has a caption" is checkable; "the thesis is well written" is not. Phrasing a
  requirement as a scan helps the model ("check every bib entry", "list the figures
  lacking X"). Do not put in the rubric what cannot be seen in the source (PDF page
  count, image resolution, delivery process): those come back as "n.a." at best.
- Editing a rubric applies to the **next** review (the pass count follows the text:
  add requirement 23 and the next run shows 23 passes); a running review keeps the
  rubric it started with.
- **Users** open the AI Assistant rail, switch to the **Review** tab, choose a rubric
  and run. Each item shows a status (ok / partial / missing / n.a.), the evidence, and
  a suggestion, with a **Download report** button (Markdown) so the result survives
  the non-persisted chat.
- **Queue.** A review is long, so the backend runs **one at a time per web process**;
  extra requests queue and the UI shows the position. A queued or running review can
  be **cancelled**, and is cancelled automatically on page refresh/close. Switching
  the Chat/Review tab does **not** cancel it (both panes stay mounted).
- **Progress.** The bar reports **real progress**: passes completed over total, with
  the requirement currently being checked shown under the label ("Checking requirement
  7/22"), then a final "Writing the summary" step. No time estimate is involved; the
  elapsed clock is exact.
- **Prompt-cache friendliness.** Each pass sends the document FIRST and the
  requirement AFTER, so llama.cpp's prefix cache reuses the document prefill across
  passes: pass 1 pays the full document read, passes 2..N only pay their own few
  hundred tokens. On a backend with no prompt cache every pass re-reads the document,
  which on a slow CPU makes multi-pass expensive; there, prefer a shorter rubric.
- **Throughput measurement.** llama.cpp `timings` from completed passes size the
  per-pass safety timeout (floor: 60 min). Unrepresentative samples are rejected by
  size (`prompt_n` / `predicted_n`): on a prompt-cache hit llama.cpp evaluates as
  little as one token and the reported "rate" is pure request overhead; small samples
  only ever seed an empty calibration. `LLM_REVIEW_PREFILL_TPS` /
  `LLM_REVIEW_GEN_TPS`, when set, override the measurement.
- **Per-pass failure containment.** A pass that fails (backend refusal, unparseable
  answer) marks only ITS requirement as "n.a." with the reason; the other passes
  still run. A context overflow fails the whole review (every pass would hit it), and
  a user cancel aborts between passes or kills the in-flight call.
- **Guards.** The whole prompt (document + rubric + system + output room) is budgeted
  against Max context tokens; an over-long project is refused (`too_long`) instead of
  silently truncated. The prompt size is the backend's **exact** count: llama.cpp is
  asked via `/tokenize` (the router maps `<base>/v1/tokenize` onto the server root where
  it lives). Backends without it fall back to a character heuristic
  (`LLM_REVIEW_CHARS_PER_TOKEN`, default 3.0, measured on real LaTeX which tokenizes
  denser than prose). The refusal message shows the whole equation, prompt + reserved
  answer room against the limit, because the reserved room is part of what causes it and
  hiding it made correct refusals look wrong. If a document still slips through, the
  backend's own context rejection is parsed and reported with the real numbers. The
  output room reserved (and the model's `max_tokens`) is per pass: a single
  requirement needs few items, so multi-pass reviews cap it at 4000 regardless of the
  admin **Review answer budget** (which still applies in full to a single-pass rubric;
  fallback `LLM_REVIEW_MAX_TOKENS`, default 12000). The smaller per-pass reserve also
  means noticeably more room for the document. Any other backend refusal surfaces on
  its own requirement instead of killing the review. If a specific review model is
  configured, its presence is verified against the backend `/models` before running
  (`model_unavailable` otherwise).
- **Structured output.** Every pass pins `response_format` to a JSON schema, so a
  backend that supports it (llama.cpp, OpenAI) is constrained to emit exactly the
  per-requirement shape. That guarantees parseable output and, since prose is
  forbidden, keeps a reasoning model from spending the whole budget on internal
  thinking. The schema puts an `analysis` field FIRST in each item: the grammar
  enforces field order, so the model must write down what it scanned before it can
  emit a verdict (structured look-before-you-judge); the field is dropped from the
  stored result. For a local reasoning model, also turn thinking off at the router
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
