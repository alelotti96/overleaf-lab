# overleaf-lab/sharelatex-llm: Overleaf image with the LLM AI Assistant

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
requires the buildx builder; install the `docker-buildx` plugin if missing,
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

- **OpenAI**: URL `https://api.openai.com/v1`, key `sk-...`, model e.g. `gpt-4o`.
- **Anthropic**: URL `https://api.anthropic.com/v1` (OpenAI-compatible), key
  `sk-ant-...`, model e.g. `claude-sonnet-4-6`.

**Key encryption.** User keys (`User.llmApiKey`) are **AES-256-GCM encrypted at
rest** via `LLM_KEY_SECRET`. Transparent and back-compatible (legacy plaintext is
still read; a missing secret degrades gracefully instead of crashing). **Rotating
or losing `LLM_KEY_SECRET` invalidates all stored keys**: users must re-enter them.

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
- **End a diffuse-quality requirement with `[per-file]`** (e.g. "Assenza di errori di
  ortografia. [per-file]"): it then runs as one sub-pass per source file, each file
  alone in context, merged into a single report item. One pass over a whole thesis
  under-attends the middle chapters (the documented lost-in-the-middle effect), so an
  "ok" on spelling or tense coherence from a single pass over-claims; per-file passes
  restore full attention at the cost of roughly one extra read of the project. Use it
  for the few requirements about text quality everywhere, not for structural checks.
- **End a requirement that names a global property with `[whole-document]`** (the
  order of the opening parts, coherence across chapters): it is then decided in ONE
  pass over the whole assembled document, never split per chapter, because no single
  chapter can establish a property of the document. It wins over any other scope
  marker on the same requirement. If the document does not fit the context window for
  that pass, the requirement is refused honestly (n.a. with the reason) instead of
  silently falling back to per-chapter votes.
- **End a requirement a parser can answer with `[check: name]`**: it is then decided
  entirely in code, with no model call and no vote: deterministic, instant, and
  identical on every run, with findings quoting file and line from the source bytes.
  Prefer it over a model pass wherever a check covers the requirement: a
  deterministic answer never flips between runs, and run-to-run flips are where most
  review noise measurably comes from. A `[check:]` requirement whose check is not
  available on the instance (for example `languagetool` without its container)
  degrades to an honest n.a., never to a silent model fallback. The shipped checks:

  `acronym-first-use`, `acronyms-declared-unused`, `acronyms-in-headings`,
  `acronyms-missing-from-list`, `appendix-referenced`, `bib-duplicates`,
  `bib-entries-complete`, `caption-position`, `citation-setup-authoryear`,
  `citation-setup-consistent`, `citation-setup-numeric`, `citations-resolve`,
  `crossrefs-resolve`, `decimal-separator`, `float-caption`, `float-centered`,
  `float-referenced`, `has-abstract`, `has-bibliography`, `heading-sequence`,
  `italic-coherence`, `language-support`, `long-sentences`, `manual-numbering`,
  `math-notation`, `no-wikipedia`, `numbered-equations`, `reference-style-mixing`,
  `symbol-list`, `tables-as-images`, `tie-before-ref`, `typographic-input`,
  `unique-labels`, `unit-spacing`, `urls-in-text`, `work-markers`, plus
  `languagetool` when its container is configured.

- **Scan patterns are lines of the form `Label :: regex`** (conventionally grouped
  at the end of the rubric). Every pattern runs over the whole project and its match
  count reaches the model as a stated fact; the labelled ones are also what
  `[per-candidate: Label]` builds its candidate passages from. Patterns are
  case-insensitive JavaScript regular expressions, and a pattern that backtracks
  pathologically is refused at save time (the admin page names it): keep negated
  classes bounded (`[^X]{0,200}`, never `[^X]*`).
- **Name one of the rubric's scan patterns with `[per-candidate: Label]`** to turn a
  diffuse judgement ("no qualitative claim without data") into closed questions: the
  code extracts every passage that pattern hits, the model answers yes/no per
  candidate in small batches, and the code builds the verdict quoting the source
  bytes. Open search over a chapter is where a judge misses cases; per-candidate asks
  it only the question it is good at. A pattern that hits nothing yields an honest
  n.a. ("no passage matches"), not an ok: a silent pattern is not evidence of
  compliance.
- **Attach contrastive examples to a requirement the model keeps flipping on**, with
  lines directly under it: `[example-violation: ...]` and `[example-compliant: ...]`
  (up to two each, kept short: every token is paid in that requirement's pass). They
  are injected only into their own requirement's pass, after the document block, so
  the prompt-cache prefix is untouched and no other requirement pays for them.
  Criterion-specific examples written by an expert are the best measured lever for
  stabilising a judgement call; write them for the requirements your reports show
  flipping, not for all of them.
- Editing a rubric applies to the **next** review (the pass count follows the text:
  add requirement 23 and the next run shows 23 passes); a running review keeps the
  rubric it started with.

No rubric ships with the module: what counts as compliant is your institution's
call, not this repo's. A generic starter to paste into a new rubric and adapt:

```
Master thesis / final report, written in English. You are reviewing LaTeX sources.
1. The document is written in the third person: no first-person pronouns in the prose. [per-candidate: First person]
2. Terminology and verb tenses are consistent across the document. [per-file]
3. No evident spelling or grammar errors. [per-file]
4. Every figure and every table has a caption. [check: float-caption]
5. Every figure and every table is referred to explicitly in the text. [check: float-referenced]
6. Figure captions are below the figure; table captions are above the table. [check: caption-position]
7. Cross-references are automatic (\ref and friends): no hand-written numbers such as "Figure 3". [check: manual-numbering]
8. No relative references such as "the figure below" or "the following section". [per-candidate: Positional references]
9. All display equations are numbered. [check: numbered-equations]
10. Every term appearing in an equation is defined in the text.
11. No purely qualitative claim without supporting data (for example "the accuracy is very good"). [per-candidate: Vague qualifiers]
12. Every acronym is expanded at its first use in the text. [check: acronym-first-use]
13. No acronym appears in a chapter or section title. [check: acronyms-in-headings]
14. Sentences longer than about 40 words are split. [check: long-sentences]
15. Units carry a space (or the \, thin space) between value and unit. [check: unit-spacing]
16. The decimal separator is consistent across the document. [check: decimal-separator]
17. Every quantitative or qualitative statement that is not established knowledge carries a citation.
18. The bibliography is managed through BibTeX entries with complete metadata. [check: bib-entries-complete]
19. Wikipedia is never cited. [check: no-wikipedia]
20. The in-text citation style is consistent and follows one of the formats your institution admits: state them here explicitly, otherwise this requirement cannot be checked.
21. Abstract, introduction stating aims and structure, and conclusions with results, limitations and future work are all present.
22. Code appears as text (lstlisting or verbatim), long listings in an appendix, never as an image. [check: tables-as-images]

First person :: (?<![\w.@/])(?:I\b(?!\.)|(?:we|our|ours|us|my|mine)\b)
Positional references :: \b(figure|table|section|paragraph|chapter)s?\s+(below|above|following|preceding)\b|\b(following|preceding|next)\s+(figure|table|section|chapter)s?\b
Vague qualifiers :: \b(very|extremely|remarkably|significantly|highly|exceptionally)\s+(good|high|low|accurate|precise|fast|effective|efficient|robust|reliable)\b|\b(excellent|outstanding|remarkable|impressive)\b
```

Requirement 20 is written the way it is on purpose: a requirement that names no
criterion cannot be verified by anyone, model or human, and the reviewer will fall
back to checking internal consistency instead of the rule you meant. Note how most
starter requirements carry a `[check:]` or a `[per-candidate:]` marker: that is the
recommended shape of a mature rubric, with the model kept for the judgements only a
reader can make.
- **Users** open the AI Assistant rail, switch to the **Review** tab, choose a rubric
  and run. Each item shows a status (ok / partial / missing / n.a.), the evidence, and
  a suggestion, with a **Download report** button (a self-contained HTML file, which
  any browser prints to PDF) so the result survives the non-persisted chat.
- **Queue.** A review is long. With a single review backend the web process runs
  **one at a time** and extra requests queue with their position shown. With a pool
  of review backends configured (admin page, "Review backends": one entry per
  GPU/server) up to one review per backend runs concurrently: a review takes the
  first free backend and never migrates mid-run, a backend that stops answering
  steps out of the rotation, and the archived report records which backend served
  it. A queued or running review can
  be **cancelled** from its button, and only from there: switching the Chat/Review
  tab does not cancel it, and neither does closing or reloading the page (see
  "Survives page reloads" below).
- **Progress.** The bar reports **real progress**: passes completed over total, with
  the requirement currently being checked shown under the label ("Checking requirement
  7/22"), then a final "Writing the summary" step. No time estimate is involved; the
  elapsed clock is exact. A `[per-file]` requirement contributes one pass per source
  file and the label names the file being checked.
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
- **Decidable structural facts.** Some questions do not need a judgement at all: a
  float either contains a `\caption` or it does not, a label is either referenced
  somewhere or it is not, a `\ref` either resolves or it does not. Those are computed
  in code and stated as facts in the hints, and the prompt tells the model to trust
  them over its own reading. What motivated them: on one caption-less `longtable`,
  three different models produced three different verdicts and one asserted a
  `\caption` that does not exist. Deciding it in code costs ten lines and ends the
  disagreement.

  The facts are language- and policy-neutral by construction: pure LaTeX structure,
  no vocabulary, and **no norm implied**. Two details make that real rather than
  claimed. Code listings are excluded from the caption check, because `lstlisting` is
  not a float and takes its own `title=`, so demanding a `\caption` there would state
  a falsehood as a fact. And unreferenced labels are reported **classified by what
  they label** (figure, table, equation, listing, section, other) instead of as one
  list: a figure that is never called out in the text is a finding under most
  guidelines, an equation or a section label that is never referenced usually is not,
  and code that lumped them together would be smuggling in a rule it has no business
  having. The hint says which kinds and how many; the rubric decides which kinds
  matter. The kind travels **on every entry** (`el_plot (figure, /path.tex)`), not
  just in a group heading, because the entry is what gets quoted into the report and
  a heading left behind turns "a figure is never cited" into the vaguer "a label is
  never referenced". Floats are listed first so the cap never spends its slots on
  section labels.

  Acronyms get the same treatment: entries declared with `\acro{...}` (the `acronym`
  package) or `\newacronym{...}` (`glossaries`) are matched against every use
  (`\ac`, `\acs`, `\acl`, `\acf`, plural forms, `\gls`, `\acrshort`, ...), so a
  declared-but-never-used entry and a used-but-never-declared key are both reported
  as counts with names. The lines only appear when the document declares acronyms
  at all. Citations likewise: `\cite` keys are matched against the `.bib` entries,
  so a citation that renders as `[?]` and an entry nobody cites are both stated as
  facts, with the file and line of each. Those lines appear only when a bibliography
  is part of the assembled document, since without one every key would look
  undefined and the review would report its own blind spot as a defect.
- **Deterministic scan hints.** An LLM attends over the whole prompt, but a single
  pass cannot be TRUSTED to have checked every line for an absence claim ("no first
  person anywhere"): in practice it asserts the absence and quotes a few well-behaved
  examples. Mechanical patterns are grepped in code instead, exhaustively, and the
  results ride the cached document prefix into every pass. The built-ins are only
  language-neutral LaTeX structure counts (figure/table environments, `\caption`,
  equations, `\ref`, `\cite`, listings) plus the structural facts above. Everything
  content-related is **policy, and policy lives with the rubric**: each rubric has
  its own **Scan patterns** field
  (one `Label :: regex` per line, case-insensitive, validated at save time), edited
  next to the guidelines it verifies. A "none found" in the hints is a real
  mechanical verification; listed candidates deliberately over-capture and the model
  judges each in context. Patterns for an English rubric:

  ```
  First person :: \b(I|we|our|ours|my|mine)\b
  Relative references :: \b(figure|table|image|chart)s?\s+(below|above|following|preceding)\b
  Hand-written numbering :: \b(figure|fig\.|table|tab\.|equation|eq\.)\s*~?\s*\d
  Wikipedia :: wikipedia
  ```

  The same rubric in another language just carries different patterns, which is the
  whole point of keeping them out of the code. For an Italian one (note the
  lookbehind, so the ".io" TLD in URLs does not match the pronoun "io", and the
  -iamo verb pattern that also catches nouns like "richiamo", judged benign by the
  model):

  ```
  Prima persona :: (?<![\w.@/])(io|noi|mio|mia|miei|mie|nostro|nostra|nostri|nostre|ho)\b|\b[a-zA-Zà-ù]{2,}iamo\b
  Rimandi relativi :: \b(figura|tabella|immagine|grafico)\s+(seguente|precedente|sottostante|soprastante|sopra|sotto)\b
  Wikipedia :: wikipedia
  ```
- **Quote grounding.** The judge itself can hallucinate evidence (observed: invented
  line numbers, quotes attributed to the wrong file). Quotes are mechanically
  checkable, so every quoted passage in an item's evidence is searched, whitespace-
  and typography-normalized, in the assembled source. Quotes the model compresses
  with internal ellipses ("first words ... last words") are split on the ellipses and
  each probative piece is searched on its own, so honest abbreviation does not trip
  the check. An item whose quotes are not found is flagged for adversarial
  verification regardless of its status (an "ok" propped up by fabricated quotes gets
  double-checked too), and any quote still unfound after verification appends a
  visible `[warning: N quoted passages not found verbatim in the source]` to the
  evidence instead of standing as false authority. The scan hints count as source
  for this check: quoting a hint line is attribution, not fabrication.
  Beyond the warning, a finding whose EVERY verbatim-looking span (quoted text,
  backticked spans, and bare LaTeX with braced arguments) exists neither in the text
  the pass was shown nor in the raw project sources is dropped before it can decide a
  verdict: a fabricated "the file contains \acro{...}" claim used to survive as
  evidence for a violation. The raw sources are the fallback haystack on purpose, so
  a quote the sanitiser blanked out of the prompt keeps its finding.
- **Adversarial verification.** A false "missing" is the most harmful thing a review
  can produce (it sends the author hunting for problems that do not exist, e.g. a
  quantity flagged as uncited whose `\cite` sits right next to it). Every requirement
  that comes out "missing" or "partial", plus any item with ungrounded quotes, gets
  one extra pass (capped at 8, riding the same document cache prefix, temperature 0)
  where the model must test whether the finding HOLDS UP against the document:
  refuted evidence is dropped, fully refuted findings flip back to "ok", ok-verdicts
  with fabricated evidence get re-grounded or downgraded. Best-effort: if
  verification fails, the original finding stands. The progress bar extends honestly
  ("Double-check: <requirement>", e.g. 22/24). The verifier prompt is internal, not
  admin-editable.
  The capped slots go first to a `[per-file]` verdict decided by a SINGLE dissenting
  file, then to the other negatives, then to ungrounded quotes. A per-file finding is
  also re-checked against **the file that produced it**, not the whole project:
  verifying it against everything would put the verifier back in the
  lost-in-the-middle conditions the per-file split exists to avoid, handicapping the
  check exactly where the finder was helped.
  The verifier states its conclusion in a dedicated `refuted` field (none / some /
  all) emitted before the status, and the code enforces the consequence: a verdict
  whose findings were ALL refuted with grounded counter-evidence cannot stay missing
  or partial (observed before this: a verify pass proving every claim wrong while
  the original status survived untouched).
- **Aggregation honesty on per-chapter votes.** A requirement whose material does not
  exist in the project at all (zero code listings for the code requirement, zero
  figures for a figure requirement) is n.a., and a stray chapter "ok" with no
  quotable source line cannot outvote that fact: measured across identical runs, that
  stray vote is exactly what made such verdicts flip between n.a. and ok. Conversely
  a chapter that answers n.a. while the scan hints show candidates for the
  requirement inside it is named as unassessed in the merged item instead of being
  silently absorbed.
- **The whole project, docs and files.** Overleaf splits a project into *docs* (the
  editable text ones) and *files* (anything uploaded, imported from a zip, or kept in
  sync by an external source such as a Zotero link). A `.bib` is normally a doc but
  becomes a file the moment it arrives one of those ways, and the review used to read
  docs only: the bibliography silently vanished from the prompt while requirements
  about it kept being asked, and a model asked about text it cannot see answers about
  text it imagines (observed: an item stating it had "scanned all entries in
  references.bib" for a file that was never sent). Text-like project files (`.bib`,
  `.tex`, `.cls`, `.sty`, `.bst`, `.txt`, `.md`, under 2 MB) are now read as well,
  from the filestore service or, on releases that have moved file content there, from
  the history blob store by the file's hash. Any failure degrades to a skipped file
  **named in the report along with every URL that was tried and what it answered**,
  rather than a failed review or, worse, a silent gap.
- **What the review actually read.** The result carries the list of assembled files
  and of any file it could not read, shown in the pane and in the downloadable report. Without it, a run that saw one
  file fewer than expected (a file deleted mid-session, an empty doc skipped, a
  project still syncing) is indistinguishable from a complete one, and every "scanned
  the whole document" claim in the report becomes unverifiable after the fact. For
  the same reason the token figure is labelled as **prompt** tokens, which is what it
  has always been (system prompt + guidelines + document + hints), and the exact
  count is requested from the review model's own backend: with several models behind
  the router, a tokenize call that does not name its model is answered by whichever
  backend comes first, and a count from a different tokenizer is not the count that
  will be enforced.
- **Deterministic and readable.** Finder and verifier passes run at temperature 0,
  so re-running the review on an unchanged document yields stable verdicts (at 0.2 a
  requirement was observed flipping missing to ok between runs with no document
  change). Both the pane and the downloadable report put the problems first, most
  severe first, and fold the met requirements into a collapsed block: a report is
  read to find what to fix, and in rubric order the few real findings sit buried
  among twenty "ok" lines. File paths inside evidence render as chips, several
  examples render as a list, and the grounding warning renders as a badge next to
  the verdict instead of trailing off the end of a paragraph. The prompt asks for
  **every** place that violates a requirement (up to about fifteen, then a total),
  not a sample: the author fixes what the report names, so an occurrence left out is
  one that stays in the document. The code caps (2500 chars of evidence, 1200 of
  suggestion, cut at a word boundary with an ellipsis) are backstops against a model
  that pastes whole environments, not a length target.
  Every field is written in the language of the **guidelines**, and both prompts say
  so explicitly, including the reason it used to drift: the scan hints and the
  prompts themselves are in English whatever the rubric's language is, and an item
  that leaned on a hint used to come back in English inside an otherwise Italian
  report. LaTeX commands mangled by JSON escaping are
  repaired before display: a model that writes `\ref` unescaped inside a JSON string
  can only emit `\r` + `ef` (the grammar admits no invalid escapes), which would
  otherwise render as `ef{...}` in the report; control characters in front of letters
  (and, for `\n`/`\t`, in front of common command stems) are restored to their LaTeX
  commands, which also lets such quotes pass grounding.
- **Prompt overrides are opt-in, and empty means "follow the default".** The admin
  page shows the built-in prompt as a **placeholder**, never as a value, and the
  button next to it clears the field instead of copying the default into it. This
  used to work the other way round: the server sent the effective value (override, or
  the default text when unset) and the page posted its fields back on every save, so
  saving an unrelated setting silently stored a verbatim copy of that day's default.
  From then on the review ran on a frozen prompt, missing every later improvement,
  with nothing in the UI to show it. The field now says which of the two states it is
  in. An empty (or whitespace-only) override falls back to the built-in prompt
  everywhere, including the per-action Ask AI templates.
- **Robustness of the surrounding machinery.** A review holds the single per-process
  queue slot for as long as it runs, which makes a few otherwise minor things severe,
  so: every backend call is bounded (the model passes by the adaptive pass timeout,
  the auxiliary ones (token count, model check, summary, file store) by a 60 s cap)
  and every one of them honours a cancel, or a backend that accepts a connection and
  never answers would park the queue until a restart. The brevity retry re-arms the
  pass timer, since it is a second attempt under a budget sized for one and fires
  precisely when most of that budget is gone. A second review of the same project by
  the same user joins the running one instead of queueing a duplicate behind it. And
  the structural scans resolve offsets through a per-file line index rather than
  rescanning from the start per match: on a synced group bibliography of ~10k entries
  that is the difference between 28 ms and several seconds of blocked event loop, for
  every user of the instance rather than just the one reviewing.
- **Tests (`test/run.mjs`).** `node overleaf-llm-image/test/run.mjs` runs the suites
  (23 at the time of writing) over the vendored sources: no dependencies, no
  framework, non-zero exit on failure.
  They cover quote grounding and `file:line` derivation, the decidable structural
  facts, rubric splitting, throughput measurement, backend error parsing and the
  prompt-override contract, and they carry regressions for the defects a code audit
  turned up. See `test/README.md` for what each one protects and why they slice the
  real source instead of importing it.
- **Measuring it (`scripts/review-metaeval.mjs`).** Reading reports cannot answer the
  questions that decide anything: does model A really find more than model B, did a
  prompt change help, how often does a clean document get flagged? The harness
  answers them by mutation testing: it takes a document you consider clean, injects
  one fault at a time from a mutation file you write, runs the review on each mutant
  and reports **detection rate per class** plus the number of findings on the clean
  run (the false-positive baseline). Since the reviewer runs at temperature 0 the
  numbers are reproducible, and the exit code (0 only when every mutation was caught)
  makes it usable as a gate before and after a change.

  ```bash
  # check the mutations apply to your document, without calling the model
  node scripts/review-metaeval.mjs --dry-run --gold ./thesis \
      --mutations scripts/review-mutations.example.json

  node scripts/review-metaeval.mjs --gold ./thesis \
      --mutations my-mutations.json --rubric my-rubric.txt \
      --api http://127.0.0.1:18090/v1 --model my-model
  ```

  Two things decide whether the numbers mean anything, both learned the hard way on
  a real run:

  - **The gold document must actually be clean.** Run it against a thesis that still
    has defects and the baseline count mixes real findings with false positives, so
    it measures nothing. Fix the known defects first, then every non-ok on the clean
    run is a false positive by definition.
  - **A mutation must be detectable in principle.** Rename a random `\label` and it
    may land on a listing, where "this figure is never cited" does not apply; use an
    invented token like `QZXT` as the undefined acronym and the model can reasonably
    fail to read it as an acronym at all. Both come back as misses that say nothing
    about the reviewer. Anchor mutations on the construct the requirement is about
    (see the `comment` fields in the example file) and use realistic material.

  Also note what the harness does NOT cover: it talks to the model directly, so
  there are no scan hints, no `[per-file]` sub-passes and no adversarial
  verification. It measures the **model and rubric** layer. A structural fault that
  the deterministic checks would have caught can therefore show up as a miss here
  while the real feature reports it, which is worth remembering before concluding
  that a model is blind to something.

  `only` on a mutation restricts its run to selected requirements (1-based indexes),
  which cuts a run by an order of magnitude and makes "tweak the rubric, measure
  again" practical. It also narrows what is measured: a targeted run cannot show
  that a *different* requirement caught the fault, which is exactly how bundled
  requirements get discovered. Target while iterating, run everything before
  concluding.

  Nothing in it is tied to a language, an institution or a document type: the
  mutations live in your file, the gold document stays on your disk. A mutation is
  `{id, class, description, find, replace, expect}` where `find` is a regex and
  `expect` lists the markers that must appear in a non-ok item for the fault to count
  as detected. Prefer mutations that INSERT a distinctive token (a ghost label name, a
  deliberate misspelling) and expect that token: detection then does not depend on the
  language your rubric is written in. By default one fault is injected in the first
  matching file, which is the realistic and hard case; `"all": true` injects it
  everywhere, and `"file": "/path.tex"` targets one file.
  `scripts/review-mutations.example.json` ships eleven generic LaTeX mutations
  (removed caption, broken reference, orphan label, unnumbered equation, dropped
  citation, Wikipedia source, first person, unsupported superlative, misspelling,
  hand-written figure number, missing unit spacing) to copy and adapt.
- **Per-pass failure containment.** A pass that fails (backend refusal, unparseable
  answer) marks only ITS requirement as "n.a." with the reason; the other passes
  still run. Such items also carry a machine-readable `modelFailure: true`, so stored
  history can tell "not applicable to this document" from "the model failed to answer
  here" without parsing the note text; the tallies count neither differently. An unusable answer (typically a broad requirement whose analysis blows
  the per-pass budget, cutting the grammar-constrained JSON mid-way) is retried once
  with an explicit brevity instruction before giving up; the retry rides the prompt
  cache, so it only pays its own generation. A context overflow fails the whole
  review (every pass would hit it), and a user cancel aborts between passes or kills
  the in-flight call.
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
  answer room per pass is **adaptive**: each pass gets all the context the document
  leaves free (minus a small safety margin), capped by the admin **Review answer
  budget** (fallback `LLM_REVIEW_MAX_TOKENS`, default 12000). `max_tokens` is a cap,
  not a target, so a generous budget costs nothing on short answers while letting a
  thorough pass enumerate dozens of figures in its analysis; the review is refused
  (`too_long`) only when less than a minimum useful reserve (2000 tokens) remains.
  Any other backend refusal surfaces on its own requirement instead of killing the
  review. If a specific review model is configured, its presence is verified against
  the backend `/models` before running (`model_unavailable` otherwise).
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
  The controller does not take that on faith: at review start, right after the model
  presence check, one tiny schema-pinned probe call verifies the backend actually
  honours JSON schemas. llama.cpp with thinking left enabled ignores the grammar
  SILENTLY (upstream #20345), which would corrupt every verdict of every review while
  looking perfectly healthy. A probe answer that violates its schema fails the review
  naming that cause; an unreachable probe does not (connectivity problems surface on
  their own terms).
- **Routes** (all project-scoped, login required): `GET .../llm/compliance/rubrics`,
  `POST .../llm/compliance/start`, `GET .../llm/compliance/status/:jobId`,
  `GET .../llm/compliance/latest`, `POST .../llm/compliance/cancel/:jobId`. Rubrics +
  review model + max context live in the admin-settings JSON.
- **Survives page reloads.** The review is a server-side job and finished results
  are kept for 4 hours, and the pane re-attaches on mount via the `latest`
  endpoint: a tab the browser discarded and reloaded (Chrome does this to
  background tabs after ~30 minutes) resumes the progress view of a running
  review, or shows the report that finished while nobody was watching. Only the
  explicit Cancel button cancels a job; page unloads never do.

### AI writing signals (separate report section)

The report can end with a section of signals compatible with machine-generated text.
It is computed entirely in code (no model call, deterministic, milliseconds), and it
is NEVER a verdict: no probability, no "detection", counts and quotations only, with
the caveat printed inside the section itself so a forwarded copy carries it. Two
signal families: lexical markers from dated, versioned pattern lists (English and
Italian ship as defaults; both lists always run, since a pattern in the wrong
language simply never matches and a thesis can mix languages) and language-neutral
statistics (sentence-length burstiness, em-dash density, paragraph uniformity,
sentence-initial connectives, recurring triplets). The aggregation is built against
false accusations, which published measurements put above 60% for non-native writers
under naive detectors: a chapter is flagged only against the thesis's OWN median
(robust deviation over at least 4 chapters, so no absolute threshold exists to be
wrong), single hits are never reported, and lexical markers only count in clusters of
3 or more distinct hits inside one paragraph. Tool artifacts (`oaicite`,
`contentReference`, `chatgpt.com` URL parameters, literal typographic quotes in the
source) are the one category reported unconditionally, as pasted-output traces.
Every list in the block is capped with its true total shown ("first N of M"), the
whole block stays bounded on pathological input, and a clean thesis renders no
section at all. One accepted limit, documented in the module: a thesis generated
uniformly from start to finish has a flat baseline and flags nothing; the design
prefers missing that case over accusing the innocent.

### Online bibliography verification (opt-in, off by default)

Set `LLM_BIB_VERIFY_MAILTO` to a contact email address and a review will check the
project's `.bib` entries against public metadata. Leave it unset and the module opens no
socket at all: this is the only part of the review that leaves the machine, so it does
not happen because the image was deployed, it happens because somebody set an address.
The address is what the [Crossref REST API](https://api.crossref.org) asks callers to
put in their `User-Agent` so it can reach whoever is generating the traffic.

The check is **resolve and match**, not resolve. A fabricated reference usually carries
a DOI in the right shape, and a guessed suffix inside a real journal's prefix often
lands on somebody else's paper, so a DOI that resolves proves nothing on its own. Every
entry with a DOI is fetched from Crossref and the record that comes back is compared
with the entry: title by normalised token overlap (LaTeX braces, `{D}eep {L}earning`,
accent commands and subtitles all normalise away), first-author family name, and year
within one. Three outcomes: the titles agree and nothing is reported; they clearly
disagree and that is reported with **both titles quoted**; or the comparison lands in
the middle, which is reported as "could not be confirmed either way" and is never a
violation. Entries that look like preprints (an `eprint` field, an arxiv.org link, an
arXiv DOI) are looked up by title instead, and a published version with the same title
**and** a shared author is offered as a suggestion, not as an error.

Nothing here is a verdict and nothing here says "fabricated". Every line is a fact about
what a public API answered, and the guards are the point of the design:

- **A 404 from Crossref is not a missing work.** Zenodo, figshare, datasets and arXiv's
  own DOIs are registered with DataCite, and Crossref answers 404 for all of them
  (measured, on two real and current DOIs). Every 404 is therefore confirmed against the
  registry-agnostic resolver at `https://doi.org/api/handles` before anything is said,
  and a DOI that exists elsewhere is reported as **not checked**, never as missing.
- **The author gate on preprints is not optional.** Measured against the live API, a
  search for "Attention Is All You Need" answers with "Is Attention All You Need?" by
  different authors, whose title tokens are identical. Title alone would suggest a
  stranger's paper as the published version of the student's citation.
- **Every failure degrades to "not checked", by name and by count.** A timeout, a 429, a
  500 that stays broken, a cancelled review, an entry with no DOI, an exhausted budget:
  all of them are counted and printed, never turned into a finding. Turning the network
  off makes this section smaller, never harsher.
- **A truncated or two-word title can confirm a match and can never produce one.**

Bounded on purpose, since one student clicking Run must not become a thousand requests
at somebody else's expense: at most **60 requests per review**, **one request per
second** sustained, two in flight, a 10 s timeout, one retry on 5xx only, and an in-run
cache so a `.bib` that cites the same DOI eight times costs one request. The report
always says **"checked N of M entries"**, so a partial check can never read as a whole
one. Suite: `bib_verify`, which runs entirely offline against a stubbed `fetch`.

### Spelling and grammar: LanguageTool (opt-in)

The rubric requirement "no evident spelling or grammar errors" is the one a language
model is worst at and a dedicated tool is best at. A model reading a chapter reports the
two mistakes it happens to notice, misses the agreement error in the sentence it quoted,
and answers differently on the next run, spending a whole pass per file to do it. A
self-hosted **LanguageTool** answers the same question from a rule base and a
morphological dictionary: locally, in Italian and English, for free, identically on every
run, and with an exact `file:line` for every finding.

Enable it by adding the container (see the compose snippet in the deploy notes) and
setting `LLM_LANGUAGETOOL_URL`, then marking the requirement in the rubric:

```
3. No evident spelling or grammar errors. [per-file] [check: languagetool]
```

With `LLM_LANGUAGETOOL_URL` unset nothing changes: the module reports itself disabled,
no socket is opened, and the requirement goes back to the model under the scope written
in front of the marker. The verdict is `ok` when nothing is found, `missing` with the
list of mistakes when something is, and `n.a. with the reason` when the container did
not answer, because an outage reported as "no spelling errors found" is the one answer
nobody could act on.

**LanguageTool is shown prose, not LaTeX.** The sources are transformed so that every
non-prose span (the preamble, comments, maths, `verbatim` and `lstlisting` bodies,
`\label`/`\ref`/`\cite` arguments, image paths, optional arguments and the command names
themselves) is replaced by spaces of the same length, while the prose arguments survive:
`\textbf{bold word}` contributes "bold word", captions and headings are proof-read, and a
`\href{url}{visible text}` keeps its visible text. Because the replacement preserves
every offset and every newline, each finding maps back to the exact file and line of the
student's source with no mapping table in between.

**False positives are what makes or breaks this.** A spell checker pointed at raw LaTeX
reports every label, every citation key, every package name and every author's surname,
and a report whose first ten items are the thesis's own vocabulary is a report nobody
finishes. Four filters are applied on top of the transform: a match entirely inside a
command token, inside the braces of a `\cite`/`\ref`/`\label`, on a capitalised word
immediately in front of a `\cite` (an author's name), or on anything carrying a
backslash, is dropped. On top of that, `LLM_LANGUAGETOOL_DICT` is a comma-separated list
of domain terms the institution's documents legitimately contain ("biblatex",
"CubeSat", the name of a laboratory); matches on them are dropped and **counted**, so a
whitelist can never silently swallow findings.

**What it does not report.** LanguageTool's style, typography, casing, redundancy and
repetition categories are excluded by default (the list is a documented constant in
the module). Typography is decided by the LaTeX class rather than by the author, casing
is unreliable once an equation has been blanked out of a sentence, and style is a matter
of taste the rubric already covers where it cares. What is kept is spelling, grammar,
agreement and real punctuation errors: the hits a student can act on. The list is capped
at 60 in the report and the true totals travel with it, so the evidence says "137
mistakes, the first 20 listed" rather than implying there were 20.

### Measured figure resolution

When the review runs, the raster figures of the project (`.png`, `.jpg`, and friends,
resolved through `\graphicspath` and graphicx's extension rules) are fetched from the
file store, their pixel dimensions read from the file headers, and the **effective DPI**
computed against the width the LaTeX asks for. The numbers ride the scan hints as facts:
a width given in `\textwidth` fractions yields an estimate that names its assumption
(160 mm of text width) on the same line, an absolute width yields an exact number, and a
figure that could not be fetched or parsed is listed as **unmeasured, never as low
resolution**. No threshold lives in the code: what DPI is acceptable is the rubric's
call. Vector figures are counted from their extension and never fetched; TikZ figures
have nothing to measure and are not mentioned. Bounded per review (10 MB per image, 200
images, 60 MB and 60 s in total, deduplicated), and a failure of any part degrades to
fewer facts, never to a failed review. Suite: `image_metrics`.

## Notes

- **Non-streaming chat.** Single blocking reply, server timeout **300 s**. The CEP
  nginx template already proxies `location /` with `proxy_read_timeout 10m` (600 s),
  which covers it, so `nginx-customizations.sh` adds **no** timeout override (adding
  one duplicates the directive and makes nginx abort at boot). Completion /
  connection checks use 30 s.
- **Admin keys** live in a plaintext JSON file at
  `/var/lib/overleaf/data/llm-admin-settings.json`: keep it on a writable
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

Several review checks borrow ideas from the academic LaTeX-checking ecosystem, with
thanks:

- The `~`-before-a-reference rule and the two typographic-input rules (straight double
  quotes, `...` instead of `\dots`) are **ChkTeX** rules, reached through the
  **[CheckMyTex](https://github.com/d-krupke/CheckMyTex)** project by Dominik Krupke
  (MIT). The idea taken is the rule, not the verdict: our checks report facts with
  counts and `file:line`, and the rubric decides.
- The idea of driving **LanguageTool** over LaTeX sources, and the false-positive
  filters the module keeps (a match inside a LaTeX command token, inside the braces of
  a `\cite`/`\ref`/`\label`, on the capitalised word in front of a `\cite`, or on any
  word carrying a backslash), also come from **CheckMyTex**. `LLMLanguageTool.mjs` is
  an independent JavaScript reimplementation against the same public LanguageTool HTTP
  API; no code was copied. **[LanguageTool](https://languagetool.org)** itself is by
  the LanguageTool community, LGPL-2.1, used as an unmodified self-hosted service over
  its HTTP API.
- Online bibliography verification queries the
  **[Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)**
  inside its polite pool, and confirms the existence of a DOI against the
  **Handle System** proxy at `https://doi.org/api/handles`. Both are public,
  unauthenticated and free; neither is affiliated with this project. No third-party
  code was borrowed: the checks, the similarity measure and the rate limiter are
  written here.
- Related projects worth knowing in this space, none of whose code is used here:
  **[TeXtidote](https://github.com/sylvainhalle/textidote)** (Sylvain Hallé, GPL-3.0),
  **[YaLafi](https://github.com/matze-dd/YaLafi)** (whose tex2text engine keeps
  position traceability through a real detex, a different approach from the
  offset-preserving blanking used here), and
  **[LaTeXBuddy](https://github.com/LaTeXBuddy/LaTeXBuddy)**.
