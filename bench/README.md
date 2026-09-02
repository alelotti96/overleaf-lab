# Review bench

Runs the REAL compliance review outside the Overleaf container, against a project
on disk and a model backend of your choosing, so a change can be measured before
it is deployed.

It is a bench, not a test suite: the suites in `overleaf-llm-image/test/` slice
helper functions out of the controller and check them one by one, while this runs
`performReview` itself, end to end, over a whole thesis.

## Run it

Prove the harness works, offline, no model and no network:

```powershell
node bench/smoke.test.mjs
```

Check a command line without spending GPU (every model call is answered from its
own JSON schema):

```powershell
node bench/run.mjs --project "tesi-esempio/extracted/<project>" --rubric templates/<rubric>.txt --endpoint http://<llm-host>:<port>/v1 --model <alias> --dry-run
```

The real thing:

```powershell
node bench/run.mjs --project "tesi-esempio/extracted/<project>" --rubric templates/<rubric>.txt --endpoint http://<llm-host>:<port>/v1 --model <alias>
```

The deterministic half only, which calls nothing at all and takes half a second:

```powershell
node bench/run.mjs --project "tesi-esempio/extracted/<project>" --rubric templates/<rubric>.txt --mode fast
```

`node bench/run.mjs --help` lists every argument. The full result JSON goes to
`bench/out/<project>-<model>-<timestamp>.json` unless `--out` says otherwise.

## The files

| file                  | what it is                                                                |
| --------------------- | ------------------------------------------------------------------------- |
| `load.mjs`            | the loader: the shipped controller, with the container-only imports stubbed |
| `project.mjs`         | a LaTeX directory read into the docs/files shape Overleaf hands the review |
| `run.mjs`             | the CLI                                                                    |
| `smoke.test.mjs`      | offline proof that the bench measures the shipped review                   |
| `scripted-backend.mjs`| a backend that answers from the JSON schema it was sent (smoke, `--dry-run`) |

## The rule: never rewrite the loop

`load.mjs` reads `LLMComplianceController.mjs` as text, comments out ONLY the
import lines that need the container, declares those names in an injected
prelude, rewrites the safe sibling imports to absolute file URLs so they load for
real, appends an export of `performReview`, and imports the result. Every other
byte is untouched.

That is the whole point. A bench that reimplements the review loop measures a
different program than the one that ships. This exact technique once caught a TDZ
bug (`activeChecks` reading `requirements` before its declaration) that
`node --check` and thirty suites all missed, because nobody else called
`performReview`.

Stubbed (they need the container):

- `@overleaf/logger`, `@overleaf/settings`, `@overleaf/promise-utils`
- `SessionManager`, `ProjectEntityHandler`
- `LLMAdminController` (rubrics, settings, prompts), `LLMComplianceStore` (Mongo),
  `LLMComplianceMailer`

The store and the mailer are inert recorders: every call is kept and none of it
happens. The prompts come from the real `LLMPrompts.mjs`, so the bench runs the
shipped system prompt.

Loaded FOR REAL, from their own directory:

- `LLMStructuralChecks`, `LLMAISignals`, `LLMBibVerify`, `LLMLanguageTool`,
  `LLMImageMetrics` (and `LLMPrompts`, which the loader imports directly)

If the controller grows an import the loader has no stub for, `loadController`
throws and names it. A bench that silently skipped it would report verdicts from
a review that half ran.

## The enable_thinking trap

READ THIS BEFORE BLAMING A MODEL FOR A REPORT FULL OF n.a.

The controller deliberately does NOT send `chat_template_kwargs`. On the lab
install a router sits in front of the backends and injects
`enable_thinking:false` there, which keeps the module portable to cloud backends
that have no such field (see the comment on the `compliance_review` request
body).

Pointed straight at a llama.cpp server there is no router. The model then reasons
aloud, llama.cpp ignores the JSON grammar (upstream issue 20345), the content
comes back as prose or empty, and the review degrades pass by pass. Measured on
this bench before the fix: 14 of 20 requirements lost to n.a.

So the loader puts the field back AT THE FETCH LAYER, exactly where the router
would have, and nowhere near the review loop. Every `/chat/completions` body gets
`chat_template_kwargs: {enable_thinking: false}` merged in unless it already
carries one. The smoke test asserts it on every single call, and the run header
says which of the two is happening:

```
chat_template_kwargs: added by the bench fetch wrapper (enable_thinking:false)
```

The day the controller starts sending the field itself, the loader detects it in
the source and stops adding it (and the smoke test fails, on purpose, so somebody
reads this paragraph).

The controller has its own guard for the same failure: a tiny JSON-schema probe
before the first pass, which fails the review with `json_mode_broken` rather than
producing a page of n.a. If you see that error code, thinking is on at the
backend and the bench did not manage to turn it off.

## /tokenize is absent, and that is fine

The review asks the backend for the exact token count of the prompt, because a
character heuristic that errs high refuses a document that would have fitted. The
lab router maps `<base>/v1/tokenize` onto the llama.cpp server root; a bare
llama.cpp endpoint has no such route and answers 404.

The controller falls back to `estimateTokens` and carries on. Expected, not a
failure, and the run prints it that way:

```
/tokenize (exact prompt count)    1 calls  1 ms   absent, the token estimate was used
```

The only consequence is that the context-window guard works off an estimate, so
if a document is refused as `too_long` near the boundary, check the estimate in
the output JSON before believing it.

## If a single pass takes more than five minutes

Node's built-in fetch (undici) gives up after 300 s waiting for the response
HEADERS, and a non-streaming llama.cpp answers with headers only once the whole
generation is done. A pass that generates for longer than that therefore fails as
a network error, and three of those in a row trip the controller's outage breaker
and stop the whole review with `backend_error`.

There is no supported way to raise that limit without the `undici` package, and
the bench does not try: the container runs on the same defaults, so raising it
here would hide a failure that production would have. If a run dies about five
minutes into a pass, this is why, and the answer is a smaller `--max-tokens` or a
faster backend, not a longer timeout.

## Scan patterns, or five requirements go missing

A `[per-candidate: Label]` requirement is judged by a closed-question pass over
the passages a SCAN PATTERN found. The patterns are not in this repository: they
live in the instance's admin settings, next to the guidelines they serve
(`/var/lib/overleaf/data/llm-admin-settings.json` in the container).

The rubric text files under `templates/` therefore carry the markers but not the
patterns, and without them those requirements come back n.a. with that reason.
`run.mjs` says so in its header rather than letting it be discovered in the
report.

Two ways to fix it:

- `--scan-patterns <file>`, one per line, `Label :: regex` (case-insensitive; a
  line with no `::` is used as both label and pattern). The label must match the
  one in the `[per-candidate: ...]` marker.
- `--settings <file>` with a copy of `llm-admin-settings.json`, which carries
  guidelines and patterns together. This is the faithful option: it runs the
  rubric the instance runs, patterns included.

## What else differs from a review inside the container

Small, deliberate, and worth knowing when reading a bench report:

- **Figures** are read from disk through a synthetic file store, so the image
  metrics are real. The history blob store fallback is not available (it needs
  `ProjectGetter`), which nothing here reaches.
- **LanguageTool is OFF** unless `--language-tool <url>` is given. With it off,
  the `[check: languagetool]` requirement goes back to the model instead of being
  answered by the parser, exactly as on an instance with no LanguageTool.
- **The Crossref bibliography check is OFF** unless `--bib-mailto <email>` is
  given. It leaves the machine, so it is opt in.
- **The document-type gate is confirmed by default**, because there is nobody to
  answer the dialog the panel shows. `--typecheck` runs it for real.
- **No delta, no email, no archive.** The store is inert, so a bench run cannot
  compare itself with a previous review the way the instance does.
- One extra `/models` call at startup: the controller probes the backend on boot
  before resuming interrupted jobs, and finds nothing to resume.

## Reading the output

Per requirement: the verdict, the requirement, and the first line of the evidence.
Then the timings, split by phase, which come from the bench's own fetch log
(every model call is tagged with the JSON schema it was constrained by, which is
exactly the phase it belongs to):

```
total      41m 12s
  /models (model availability)          2 calls  34 ms
  JSON schema probe                     1 calls  0.6 s
  document type check                   1 calls  4.1 s
  review passes                        21 calls  33m 04s   (mean 1m 34s)
  per-candidate passes                  5 calls  4m 20s
  double-check passes                   3 calls  2m 51s
  closing summary                       1 calls  40 s
  everything not the backend               6 s
```

`everything not the backend` is the parsers, the assembly and the report: if it is
not a rounding error next to the passes, something in the deterministic half got
expensive.

The full JSON in `bench/out/` carries the whole result object (items, summary,
AI signals, bibliography check, image metrics, excerpts) plus the call log with
per-call timings, so two runs can be compared field by field.
