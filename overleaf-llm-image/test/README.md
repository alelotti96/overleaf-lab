# Tests for the LLM module

```bash
node overleaf-llm-image/test/run.mjs
```

No dependencies, no framework, no build. Exits non-zero if anything fails, so it
works as a pre-commit or CI gate.

## What they cover

| Suite | What it protects |
|---|---|
| `grounding` | quote grounding (real, fabricated, ellipsis-compressed, typographic quotes, over-escaped LaTeX), the JSON-escape repair, exact `file:line` derivation, deterministic quoting and its offset table, the per-file merge rules, and how many double-checks a run plans |
| `hints` | the decidable structural facts (caption-less floats, unreferenced labels classified by kind, broken references, sentence length and where it points, acronym and citation bookkeeping), rubric scan patterns, the `Document type` pattern, and that **no language-specific pattern is hardcoded** |
| `checks` | the 30 structural checks, as a matrix: for each one a document that violates it, one that satisfies it, one where it does not apply, then the LaTeX variants a real thesis contains |
| `chapters` | segmentation, reading order, the acknowledgements exclusion, per-candidate collection, the pass plan and what each scope costs |
| `language` | which language the rubric is in, that the report language is only ever written inside a running review, that two reviews running side by side each keep their own, and that the checks module's language is re-asserted immediately before every call to it |
| `queue` | the endpoint pool: three backends running three reviews at once with the fourth waiting, total affinity (a review never moves, not even when the settings change under it), a backend that is down at pickup being routed around and taken out of the rotation, every backend down still failing honestly rather than parking the job, cancel of a queued and of a running review, that a single-backend install still turns the job running in the same turn and never probes anything, what the finished result records about the backend that served it, and the admin page marking a selected model the backend no longer serves |
| `split` | how a rubric becomes one pass per requirement (numbered lines, bullets, continuations, preamble, the `[per-file]` marker) |
| `rates` | throughput measured from llama.cpp `timings`, including the sample-size gates that stop a cache hit from poisoning the estimate |
| `backend_error` | recognising a context-window overflow from both llama.cpp and OpenAI-shaped errors, the outage breaker, and the order of the guards on the enqueue path |
| `cancel` | what Cancel actually stops, including a pre-pass load that never answers |
| `store` | what survives a restart: archived reports, archived failures, and what `/latest` may present as current |
| `admin_scan` | the admin model probe: where it fetches, what it sends, and what it never sends |
| `report` | the exported HTML report: layout, the delta, and that nothing from the model, the student's LaTeX or the rubric can escape into markup |
| `prompts` | the prompt-override contract: empty means "follow the built-in default", and the admin page never prefills a default |
| `evidence_check` | what happens to a finding whose quotes are in neither the text the pass was shown nor the raw project (dropped, and said so), what must survive that rule, that a dropped finding is never handed back to a model, that a verdict may not contradict its own verification, and that "nothing applied" and "nothing answered" are told apart |
| `aggregation` | the rubric markers and their order ([whole-document] over any other scope, examples stripped before every end-anchored marker), where the contrastive examples are injected, the two rules that stop a stray ok and a silent n.a. from deciding a per-chapter requirement, and the file accounting of the acknowledgements exclusion |
| `ai_signals` | the AI writing signals block: every shipped pattern compiles and matches a specimen, the hand-computed statistics, the median/MAD flagging with its 4-chapter floor, the 3-distinct-markers cluster rule, artifacts reported without any baseline, and the caps that keep the block bounded with truthful totals |
| `bib_verify` | online bibliography verification: that no address means no request at all, that a DOI held by another registry is never called missing, resolve-**and**-match on LaTeX-braced and accented titles, the uncertain band, the author gate on the preprint suggestion, and that the rate limit, the request budget and every network failure are accounted for honestly |
| `languagetool` | the opt-in proof-reader: that the LaTeX-to-prose transform preserves every offset and every line (so a mistake after a blanked equation lands on its real line), the chunk offset bases, every false-positive filter (command tokens, `\cite`/`\ref`/`\label` braces, author names in front of a citation, anything carrying a backslash), the domain whitelist and its count, the excluded categories, the cap with its true totals, and that an unset `LLM_LANGUAGETOOL_URL` opens no socket at all |
| `image_metrics` | the measured resolution of raster figures: every image header the module reads, each one valid, truncated and corrupt (including a JPEG whose comment payload contains frame-header bytes, which is what a naive reader reports as the image size), every shape of `\includegraphics` width spec, the hand-computed DPI cases, that an estimated DPI always carries the `\textwidth` it assumed while an absolute width does not move when that assumption does, the caps with their true totals, and that nothing in the block states a threshold |
| `model_calls` | the seams between a model call and the item it becomes: the answer count a batched call is grammar-bound to return, which question each answer belongs to (by the index the model emits, position only as the fallback), which calls are allowed to be nondeterministic, the gate a double-check has to pass before it may close a violation, and the sentences the code writes around what came back (the split-vote marker in both languages, the LanguageTool findings the reader is owed, the refusals that speak the rubric's language) |
| `bounded_reads` | the two readers that fetch bytes from elsewhere: a project file is refused on its declared size and the transfer is cancelled as soon as the count crosses the cap, and a bibliographic registry's answer is read up to a bound and no further |

### Where an audit finding lands

| Audit area | Suite |
|---|---|
| structural-check semantics (false ok / false violation on real LaTeX) | `checks` |
| the facts the model is shown | `hints` |
| segmentation, chapter passes, candidate passages | `chapters` |
| evidence, quoting, locations | `grounding` |
| fabricated evidence, contradicted verdicts, model failures | `evidence_check` |
| requirement scope, rubric markers, per-chapter aggregation | `aggregation` |
| what a call asks for and what the answer is allowed to change | `model_calls` |
| size caps on anything read from another service | `bounded_reads` |
| queue, cancel, persistence, restart | `backend_error`, `cancel`, `store` |
| admin endpoints and what they send outward | `admin_scan` |
| the document the student reads | `report` |
| report language | `language` |
| AI writing signals, false-accusation guards | `ai_signals` |
| spelling and grammar, LanguageTool offsets and false positives | `languagetool` |
| figure resolution: image headers, printed width, the assumed `\textwidth` | `image_metrics` |
| citations that do not resolve, outbound traffic, network failures that must not accuse | `bib_verify` |
| duplicate bibliography entries, symbol lists, maths notation, appendices, the heading tree, tables pasted in as pictures | `checks` |
| the typographic rules borrowed from ChkTeX through the CheckMyTex project (MIT): `~` before a reference, straight quotes, `...` typed as full stops | `checks` |
| the rubric language a check may read (babel or polyglossia declared, the table-like caption words) | `checks`, `language` |

### Performance tripwires

Several cases assert a wall-clock ceiling on an adversarial-but-plausible document: a
2 MB paste of unclosed environments, 4000 unclosed floats, a megabyte of
`\chapter{Ringraziamenti}`, a chapter of nothing but pattern hits, a rubric pattern that
matches the empty string. Every one of them was quadratic at some point and cost between
3 s and 13 minutes of frozen event loop, on Node's single thread, from one student
clicking Run once. The ceilings are deliberately loose: they are not benchmarks, they
are tripwires, and a return to quadratic blows through them by minutes.

Several cases are regressions for defects found in a code audit: Greek final sigma and
astral-plane characters (which used to make the location index and the grounding check
disagree), `\nocite{*}`, a quoted span longer than the extractor's ceiling, the
`\crefrange`/`\cpageref` family, `glossaries` declarations, the `.bib` read as prose, and
an acknowledgements exclusion that deleted the student's bibliography.

**The convention: a defect found in the wild gets a case here before it gets a fix.**
The case is what makes the fix checkable and what stops the defect coming back; a fix
with no case is a fix nobody can tell has been reverted.

## Why they look unusual

`LLMComplianceController.mjs` imports Overleaf internals that only exist inside the
container, so it cannot be imported from a plain node process. Each suite instead
slices the helper functions out of the real source and evaluates them, which means the
tests exercise the code that actually ships rather than a copy of it.

The cost is that a suite breaks when the text it anchors on moves. When that happens
the fix is to update the anchor, not to delete the test, and a failing anchor is
reported as a failure on purpose: a test that silently skips because it can no longer
find what it tests is worse than no test at all.

## Inspecting a real document

```bash
node overleaf-llm-image/test/inspect-document.mjs path/to/project
```

Prints the scan hints a review would compute for that project (counts, caption-less
floats, unreferenced labels, broken references, acronyms, citations) without calling a
model. Useful to check a rubric against a real document, and to tell whether something
in a report was a mechanical fact or the model's own judgement.

For measuring review quality end to end, see `scripts/review-metaeval.mjs`.
