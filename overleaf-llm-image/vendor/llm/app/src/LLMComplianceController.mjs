import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { AsyncLocalStorage } from 'node:async_hooks'
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import { getAdminLLMSettings, getComplianceRubrics, getLLMFeatureFlags, getLLMPrompts } from './LLMAdminController.mjs'
import ComplianceStore from './LLMComplianceStore.mjs'
import ComplianceMailer from './LLMComplianceMailer.mjs'
import StructuralChecks, { setChecksLanguage } from './LLMStructuralChecks.mjs'
import { analyzeAiWritingSignals } from './LLMAISignals.mjs'
import { verifyBibliography, formatBibVerifyFacts, isBibVerifyEnabled } from './LLMBibVerify.mjs'
import { checkDocuments as languageToolCheck, isLanguageToolEnabled } from './LLMLanguageTool.mjs'
// Single line on purpose: the bench harness rewrites container-only imports line by
// line, and a wrapped import silently escapes it.
import { findIncludeGraphics, imageDimensions, analyzeFigures, imageMetricsFactLines, classifyGraphicsPath, MAX_IMAGE_BYTES, DEFAULT_TEXT_WIDTH_MM } from './LLMImageMetrics.mjs'

// overleaf-lab: in-memory job queue for compliance reviews. A review sends the
// whole project to the LLM and can run for minutes, so the client polls a job for
// progress, cancel, and result rather than holding a request open.
const jobs = new Map() // jobId -> job
const queue = [] // array of jobId, FIFO
// overleaf-lab: (userId:projectId) -> promise held while a POST /start is between
// its first admission check and jobs.set. That stretch contains an await (the
// enqueue-time type check reads the whole project), so without this gate K
// simultaneous POSTs from one user all passed the meter and all paid the full
// project read before the first of them registered a job for the others to join.
const startsInFlight = new Map()
// overleaf-lab: THE FAST LANE, which is deliberately not the queue above.
//
// A fast review calls no model, so the resource the queue exists to share - a GPU
// with one review on it at a time - is not one it uses. Putting it in that queue
// would make a five-second answer wait behind an hour of somebody else's full
// reviews, and worse, it would occupy a backend slot to run code that needs no
// backend. It gets a list of its own and a small concurrency cap, so the work it
// does spend (reading the project, running the parsers) still cannot be started
// fifty times at once by one impatient page.
const fastQueue = [] // array of jobId, FIFO
let fastRunning = 0
// overleaf-lab: THE SLOTS. This used to be `let running = false`, one review at a
// time for the whole web process, because there was one model backend to run them
// on. With a pool of backends (three GPUs, three models) that flag was the only
// thing keeping two idle machines idle: the slot is now per ENDPOINT, and a job
// occupies exactly one of them from pickup to finish.
//
// A Map and not a counter on purpose: the VALUE is what enforces the affinity rule.
// A review lives and dies on the endpoint it was handed (see processQueue), so the
// pairing has to be readable from both ends - which job holds this machine, and
// which machine is this job on - without walking the job table.
//
// With a single endpoint configured the map holds at most one entry and every
// decision below collapses to the old boolean, which is what makes the
// single-backend install behave exactly as it did.
const busyEndpoints = new Map() // endpointId -> jobId
// overleaf-lab: keep finished jobs for 4 hours so a re-poll or a /latest re-attach
// after a reload still returns the result instead of a not_found. A review often
// finishes long after the user last looked at the panel (discarded tab, lunch
// break), so the retention must be generous; it is one small report object per job.
const JOB_TTL_MS = 4 * 60 * 60 * 1000

// overleaf-lab: FALLBACK token budget for the review's JSON answer, used when the
// admin has not set one in the LLM settings page (which is the normal way to change
// it). The effective value is BOTH the hard max_tokens sent to the model AND the room
// the context-window guard reserves for the answer, so raising it slightly lowers the
// largest single-pass document and lengthens the worst-case review.
const REVIEW_MAX_TOKENS =
    Number.parseInt(process.env.LLM_REVIEW_MAX_TOKENS, 10) > 0
        ? Number.parseInt(process.env.LLM_REVIEW_MAX_TOKENS, 10)
        : 12000

// overleaf-lab: rough backend throughput, now used only to SIZE THE PER-PASS TIMEOUT
// (progress is pass-based and needs no time estimate, so a wrong rate can only make
// the safety timeout more generous, never mislead the user).
// An explicit env value always wins (an operator pinning a number), otherwise we use
// what we MEASURED from the backend, otherwise these last-resort fallbacks. The
// fallbacks are CPU-era numbers and are wrong by ~2 orders of magnitude on a GPU, so
// they must never be the normal path: see measuredPrefillTps below.
const ENV_PREFILL_TPS =
    Number.parseFloat(process.env.LLM_REVIEW_PREFILL_TPS) > 0
        ? Number.parseFloat(process.env.LLM_REVIEW_PREFILL_TPS)
        : null
const ENV_GEN_TPS =
    Number.parseFloat(process.env.LLM_REVIEW_GEN_TPS) > 0
        ? Number.parseFloat(process.env.LLM_REVIEW_GEN_TPS)
        : null
const FALLBACK_PREFILL_TPS = 80
const FALLBACK_GEN_TPS = 4

// overleaf-lab: throughput measured from the backend. llama.cpp reports
// timings.prompt_per_second / predicted_per_second on every response, so each real
// review calibrates the next one for free. Process-local on purpose: after a restart
// the first review just runs on the fallbacks (only the timeout cap depends on this).
let measuredPrefillTps = null
let measuredGenTps = null

// overleaf-lab: sample-size gates for trusting a timings measurement. llama.cpp
// reports prompt_per_second over the tokens it ACTUALLY evaluated (prompt_n): on a
// prompt-cache hit that can be a single token, and the resulting "rate" is pure
// per-request overhead (~76 tok/s observed where the true prefill was ~5400), so
// accepting it would poison a good calibration. Two tiers: a STRONG sample (a real
// review) always updates; a smaller one is accepted only as the FIRST seed of an
// empty calibration and never below the MIN floor, so a cache-hit rerun (prompt_n=1)
// can never become the calibration.
const STRONG_PREFILL_N = 2048
const STRONG_GEN_N = 256
const MIN_PREFILL_N = 64
const MIN_GEN_N = 8

function effectiveRates() {
    return {
        prefillTps: ENV_PREFILL_TPS || measuredPrefillTps || FALLBACK_PREFILL_TPS,
        genTps: ENV_GEN_TPS || measuredGenTps || FALLBACK_GEN_TPS,
    }
}

// overleaf-lab: learn the rates from a llama.cpp `timings` block. Ignored silently for
// backends that do not report it (OpenAI and friends), which keep env/fallback. A
// missing prompt_n/predicted_n rejects the sample too (NaN fails every >=), since a
// rate without its sample size cannot be judged.
function recordTimings(timings) {
    if (!timings || typeof timings !== 'object') {
        return
    }
    const prefill = Number(timings.prompt_per_second)
    const prefillN = Number(timings.prompt_n)
    const gen = Number(timings.predicted_per_second)
    const genN = Number(timings.predicted_n)
    if (
        Number.isFinite(prefill) &&
        prefill > 0 &&
        (prefillN >= STRONG_PREFILL_N ||
            (measuredPrefillTps === null && prefillN >= MIN_PREFILL_N))
    ) {
        measuredPrefillTps = prefill
    }
    if (
        Number.isFinite(gen) &&
        gen > 0 &&
        (genN >= STRONG_GEN_N || (measuredGenTps === null && genN >= MIN_GEN_N))
    ) {
        measuredGenTps = gen
    }
}

// overleaf-lab: a fetch that cannot hang forever and honours a job cancel.
//
// The per-pass model calls have always had both; the small auxiliary calls
// (/tokenize, /models, the summary, the file store) had neither, on the assumption
// that "small" means "fast". A backend that accepts the connection and never answers
// makes that assumption fatal: the review holds its slot for ever, and every later
// review queues behind it until the process is restarted. A cancel did not help
// either, because a fetch with no signal ignores it.
//
// A pool of backends makes this MORE important, not less: the wedged job takes one
// machine out of the rotation permanently and nothing ever puts it back, so the
// instance quietly loses a third of its capacity with no failure anywhere to see.
const AUX_FETCH_TIMEOUT_MS = 60 * 1000

// `consume` runs INSIDE the armed window and receives the response; whatever it
// returns is what the call returns. It exists because the timer and the cancel
// listener used to be dropped the moment the HEADERS arrived, and the callers'
// `await response.json()` then read the body with nobody able to abort it: a
// backend that sent headers and stalled (dead upstream behind a keep-alive
// proxy) left the job 'running' for ever, its endpoint out of the rotation, the
// breaker never tripped and cancel answering ok while stopping nothing. Exactly
// the wedge the paragraph above says this function exists to prevent.
async function fetchWithLimit(url, options, timeoutMs, jobSignal, consume) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (jobSignal) {
        if (jobSignal.aborted) {
            controller.abort()
        } else {
            jobSignal.addEventListener('abort', abort, { once: true })
        }
    }
    const timer = setTimeout(abort, timeoutMs)
    try {
        const response = await fetch(url, { ...options, signal: controller.signal })
        return consume ? await consume(response) : response
    } finally {
        clearTimeout(timer)
        if (jobSignal) {
            jobSignal.removeEventListener('abort', abort)
        }
    }
}

// overleaf-lab: ask the backend for the EXACT token count of the prompt. llama.cpp
// exposes /tokenize, and the router maps <base>/v1/tokenize onto the server root where
// it actually lives, so the module only needs the one OpenAI-style base URL.
//
// Why this matters more than it looks: a character-per-token heuristic can only ever be
// roughly right for LaTeX, whose density varies a lot between prose and math. When it
// errs low the backend rejects the request and tells us the truth, which is recoverable.
// When it errs HIGH we refuse a document that would actually have fit, and nothing
// downstream can correct that: the user is simply blocked. The exact count removes both.
// Returns null for any backend without /tokenize, so the caller falls back.
//
// `model` matters when several backends sit behind a router: the router dispatches
// on the request's "model" field, so a tokenize call that omits it is answered by
// whichever backend comes first, and a count produced by a DIFFERENT model's
// tokenizer is not the count that will be enforced. llama-server ignores the field.
async function countPromptTokens(llmApiUrl, llmApiKey, text, model, jobSignal) {
    try {
        const headers = { 'Content-Type': 'application/json' }
        if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
            headers.Authorization = `Bearer ${llmApiKey}`
        }
        const body = { content: text }
        if (model) {
            body.model = model
        }
        const data = await fetchWithLimit(
            `${llmApiUrl}/tokenize`,
            { method: 'POST', headers, body: JSON.stringify(body) },
            AUX_FETCH_TIMEOUT_MS,
            jobSignal,
            response => (response.ok ? response.json() : null)
        )
        if (Array.isArray(data && data.tokens)) {
            return data.tokens.length
        }
        return null
    } catch (err) {
        logger.debug({ err }, '[LLM] compliance: /tokenize unavailable, using the estimate')
        return null
    }
}
// overleaf-lab: floor for the review timeout (the value it used to be fixed at).
const REVIEW_MIN_TIMEOUT_MS = 60 * 60 * 1000

// overleaf-lab: minimum useful answer room per pass. Below this even a brief verdict
// risks truncation, so the document is refused (too_long) instead of reviewed badly.
const MIN_ANSWER_TOKENS = 2000

// overleaf-lab: how many reviews one user may have queued or running at once, across
// ALL their projects. Three is enough for the real use (start a few theses in the
// morning, collect the reports later) and small enough that nobody can take the
// shared queue hostage.
//
// Deliberately NOT scaled with the number of endpoints. The cap is about one person's
// share of a shared resource, and adding machines does not make it fairer to let one
// user occupy all of them: three backends and a cap of three would let a single
// student hold the whole instance, which is the exact failure this constant exists
// to prevent.
const MAX_LIVE_JOBS_PER_USER = 3
// overleaf-lab: margin subtracted from the context headroom to cover what our token
// count cannot see (chat-template role markers, JSON grammar scaffolding).
const CONTEXT_SAFETY_MARGIN = 256

// overleaf-lab: JSON Schema for ONE review pass, enforced by the backend via
// response_format so the model is CONSTRAINED to emit exactly this shape (llama.cpp
// and OpenAI both support json_schema). This removes the "No JSON object found"
// failure class by construction and, because prose is forbidden, also stops a
// reasoning model from spending the whole answer budget on internal thinking.
// "analysis" is deliberately the FIRST property: the grammar enforces field order,
// so the model must write down what it scanned and found BEFORE it commits to a
// verdict (structured look-before-you-judge, with no chat-template thinking needed).
// It is consumed at generation time and dropped from the stored result.
// extractJson below is kept only as a defensive fallback for a backend that ignores
// the field. The other fields mirror what the parser reads (see performReview).
const REVIEW_ITEMS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                // overleaf-lab: property ORDER is part of the contract. llama.cpp turns
                // this schema into a grammar that emits the keys in this exact order, so
                // putting "evidence" before "status" makes the model decode its quotes
                // BEFORE committing to a verdict. Constrained decoding taxes reasoning
                // most when the constrained token comes first; evidence-then-verdict is
                // the documented mitigation, and it is also just how judging works.
                properties: {
                    analysis: { type: 'string' },
                    requirement: { type: 'string' },
                    evidence: { type: 'string' },
                    status: { type: 'string', enum: ['ok', 'partial', 'missing', 'na'] },
                    suggestion: { type: 'string' },
                },
                required: ['analysis', 'requirement', 'evidence', 'status', 'suggestion'],
            },
        },
    },
    required: ['items'],
}

// overleaf-lab: the verification pass answers ONE more question than a review pass,
// and the code, not the model, draws the consequence.
//
// Measured: a verify pass whose evidence spelled out that the claimed defects are not
// there ("the text recites ... the sentence is not truncated") returned status
// "missing" anyway, and the report kept the violation. Asking a model to hold a verdict
// consistent with prose it has just written is exactly the step it is worst at, so the
// question is split: "refuted" says HOW MUCH OF THE FINDING SURVIVED, which is a closed
// question about what was just re-read, and a finding whose every claim is refuted may
// not come back as a violation whatever the status field says (see the caller).
//
// "refuted" sits immediately before "status" because the grammar emits the keys in
// order: the model commits to how much survived, and only then to the verdict.
const VERIFY_ITEMS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    analysis: { type: 'string' },
                    requirement: { type: 'string' },
                    evidence: { type: 'string' },
                    refuted: { type: 'string', enum: ['none', 'some', 'all'] },
                    status: { type: 'string', enum: ['ok', 'partial', 'missing', 'na'] },
                    suggestion: { type: 'string' },
                },
                required: [
                    'analysis',
                    'requirement',
                    'evidence',
                    'refuted',
                    'status',
                    'suggestion',
                ],
            },
        },
    },
    required: ['items'],
}

// overleaf-lab: the [per-candidate] closed-question pass (see CANDIDATE_MARKER).
// Internal mechanism like the verifier, not review policy, so not admin-editable.
// The model never searches and never quotes: the code found the passages and will
// quote them from the source bytes itself; the model only judges each one.
const CANDIDATES_SYSTEM_PROMPT = `You are checking ONE requirement of a writing guideline against numbered candidate passages extracted from a LaTeX document. The passages were selected mechanically; many will be perfectly fine. For EACH candidate, judge only whether the passage VIOLATES the requirement, using the passage and the context around it: support that satisfies the requirement (a \\cite, concrete numbers, a definition) often sits in the sentence before or after the highlighted expression, and if it is there the candidate does not violate. Judge what is in front of you, completely: "cannot verify" is not an answer. Write "reason" in the same language as the requirement, one short sentence. Return ONLY a JSON object shaped {"items": [{"index": 1, "reason": "...", "violates": "yes"}]}, one item per candidate, in order.`

const CANDIDATE_ITEMS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                // reason BEFORE violates: the grammar makes the model justify
                // before it commits (see REVIEW_ITEMS_SCHEMA).
                properties: {
                    index: { type: 'integer' },
                    reason: { type: 'string' },
                    violates: { type: 'string', enum: ['yes', 'no'] },
                },
                required: ['index', 'reason', 'violates'],
            },
        },
    },
    required: ['items'],
}

const CANDIDATES_PER_CALL = 15
const MAX_CANDIDATE_PASSAGES = 40

// overleaf-lab: the same schema with the number of answers PINNED to the number of
// questions. llama.cpp compiles minItems/maxItems into the grammar, so a batch of N
// questions that comes back with N-1 answers is a generation the backend refuses
// rather than a silent misalignment: without it the code has to map answers onto
// questions by position and hope, and one skipped candidate moves every later verdict
// onto the wrong passage, which reads as a false accusation about a sentence nobody
// judged. Copies the schema instead of mutating it, since the constants above are
// shared by every call of the run.
function schemaForBatch(schema, count) {
    return {
        ...schema,
        properties: {
            ...schema.properties,
            items: { ...schema.properties.items, minItems: count, maxItems: count },
        },
    }
}

// overleaf-lab: which question each answer of a batch belongs to.
//
// The candidate schema REQUIRES the model to emit an "index", and the code used to
// ignore it and map by position. A model that skips one candidate then shifts every
// later verdict onto the wrong passage, so the sentence quoted in the report and the
// reason attached to it come from two different candidates: a false accusation with
// the engine's own signature on it.
//
// So the model's own word is honoured first, and position is only the fallback:
//   - an index inside 1..count claims that question, first claimer wins (a repeated
//     index is a broken answer, and the second one is not evidence about anything),
//   - anything else keeps the position it arrived at,
//   - a question claimed by an explicit index is never overwritten by a positional
//     answer, and a question nobody claimed stays unanswered rather than guessed.
// Returns a Map from zero-based question to answer.
function reconcileAnswers(answers, count) {
    const claimed = new Map()
    const byPosition = new Map()
    for (const [position, answer] of answers.entries()) {
        const index = Number(answer && answer.index)
        if (Number.isInteger(index) && index >= 1 && index <= count && !claimed.has(index - 1)) {
            claimed.set(index - 1, answer)
        } else {
            byPosition.set(position, answer)
        }
    }
    const resolved = new Map()
    for (let k = 0; k < count; k++) {
        const answer = claimed.get(k) || byPosition.get(k)
        if (answer) {
            resolved.set(k, answer)
        }
    }
    return resolved
}

// overleaf-lab: schema for the final summary synthesis call (items in, 2-4 sentences out).
const REVIEW_SUMMARY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { summary: { type: 'string' } },
    required: ['summary'],
}

// overleaf-lab: the smallest possible schema, for the startup probe that checks the
// backend enforces schemas at all (see the probe in runReviewPasses). The answer budget
// is deliberately tiny: under a working grammar the whole answer is a dozen tokens, and
// a backend that ignores the grammar runs into the cap and returns something that
// cannot parse, which is exactly the signal the probe is looking for.
const JSON_PROBE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'string', enum: ['yes'] } },
    required: ['ok'],
}
const JSON_PROBE_MAX_TOKENS = 64
const JSON_PROBE_TIMEOUT_MS = 20 * 1000

// overleaf-lab: cap on how many negative findings get an adversarial verification
// pass (each costs one cached-prefill model call; negatives are normally few).
// overleaf-lab: how many findings get the adversarial second look.
//
// This used to be 8, and the cap was the wrong economy. A rubric has 35 requirements,
// so a document in poor shape produces more negatives than that, and WHICH eight got
// verified depended on how many findings there were and in what order they arrived.
// Two runs over an unchanged document could then disagree: one report had requirement
// 8 verified and overturned to "ok", the next had it left as "missing", and the delta
// duly announced a regression that never happened. A compliance report that is not
// reproducible is not evidence of anything, and the greedy decoding everywhere else
// exists precisely to make it reproducible.
//
// Set above the largest rubric we have, so in practice it never binds and every
// negative finding is double-checked. It stays a number rather than becoming
// unlimited because it is the only backstop against a pathological document where
// every requirement fails, and when it does bind the report says so rather than
// quietly presenting unverified findings as verified.
const VERIFY_MAX_FINDINGS = 40

// overleaf-lab: system prompt for the verification pass. Not admin-editable on
// purpose: it is an internal safeguard, not review policy. The reviewer's job is to
// find violations; the verifier's job is to REFUTE them, because a false "missing"
// sends the author hunting for problems that do not exist (observed in practice: a
// quantity flagged as uncited that had its \cite right next to it).
const VERIFY_SYSTEM_PROMPT = `You are adversarially double-checking ONE finding produced by a compliance review of a LaTeX document. The finding either claims a guideline requirement is violated (status "missing" or "partial"), or claims compliance ("ok") but with evidence that a mechanical search flagged as suspect. Your job is to test whether the finding HOLDS UP: a false violation wastes the author's time, and a verdict propped up by fabricated evidence must not survive either.

You receive the DOCUMENT (files marked by "% ===== FILE: <path> =====" headers) and the FINDING as JSON, possibly followed by a NOTE listing how many of its quotes a mechanical search could not find.

For EVERY piece of quoted evidence in the finding, check in the DOCUMENT:
1. Does the quoted text actually appear (verbatim or nearly)?
2. Does it actually support the verdict in context? For a missing-citation claim, read the full sentence and its neighbours: a \\cite nearby refutes it. For an unsupported-qualitative-claim finding, numbers or a citation in the surrounding text refute it. For an "ok" finding, replace unfounded evidence with REAL evidence from the document, or downgrade the status if you cannot find any.

Then return ONE corrected item: keep only the claims that survive your check and drop the refuted ones from the evidence. If nothing of a violation survives, set status "ok". If only part survives, choose "partial" or "missing" accordingly. Be complete: keep every occurrence that survives rather than a sample of them.

"refuted" says how much of the finding you disproved, and it must agree with what you wrote: "all" when every claim it makes is contradicted by the document, "some" when part of it is, "none" when nothing is. Answer "all" only for claims you were able to READ (see the paragraph below): a claim about a file you were not given is not refuted, it is unchecked, and that is "none".

WHO READS THE EVIDENCE. The author of the document, who has never seen the finding you were given and does not know this second pass exists. So "evidence" must describe THE DOCUMENT, never this exchange: what you looked at and what is there. Never write "the finding", "the original claim", "the accusation", "as reported above", "I reformulate", or any account of what you rejected and why. When the status is "ok", say what you checked and what you found, with the file paths and the quotes that show it ("checked the 12 captions in chapters 2 and 3: each one carries a \\cite"). Put your reasoning, and anything about the finding you were given, in "analysis": that field exists for it and the author never sees it.

NOT BEING ABLE TO SEE SOMETHING IS NOT A REFUTATION. If the DOCUMENT above does not contain a file, a passage or a figure the finding cites, you have not disproved that claim: you were simply not given it. Keep that claim and the original status, and say in the evidence that it could not be re-checked here. Reporting "ok" for something you were unable to look at tells the author a requirement is met when nobody ever checked it, and that is the single worst answer you can give. Only lower a status on the strength of what you HAVE read.

LANGUAGE: write every field in the same language as the finding's "requirement" text, which comes from the guidelines. This prompt is in English whatever that language is, so do not let it pull your answer into English; if the requirement is in Italian, answer in Italian. Quotes from the DOCUMENT stay verbatim, and LaTeX commands are never translated.

Return ONLY a JSON object, with no preamble and no code fences, in exactly this shape:
{"items":[{"analysis":"what you re-checked, what held up and what did not","requirement":"the requirement, unchanged","evidence":"what is in the document: file paths and verbatim quotes for the violations that survive, or for what you verified when nothing does","refuted":"all","status":"ok","suggestion":"a concrete suggestion (empty string when status is ok)"}]}`

// overleaf-lab: deterministic scan hints, computed mechanically from the stripped
// source and appended to the document in every pass. An LLM attends over the whole
// prompt, but a single forward pass cannot be TRUSTED to have checked every line for
// an absence claim: in practice it asserts the absence and quotes a few well-behaved
// examples. Greppable patterns are therefore scanned in code (exhaustive by
// construction) and the model receives ground truth: counts it can rely on, and
// candidate violations it must judge in context.
//
// The BUILT-INS are only language- and policy-neutral LaTeX structure counts. All
// content patterns (words to avoid, first-person forms, forbidden sources...) are
// policy, and policy belongs to the RUBRIC being checked, not to this file: they
// come in via the rubric's own "scan patterns" field (see parseScanPatterns). Those
// patterns may over-capture freely; context judgement is the model's half of the
// bargain, exhaustiveness is ours.
// overleaf-lab: float environments that are expected to carry a \caption. Code
// listings are deliberately absent: lstlisting takes its own `title=` option and is
// not a float, so demanding a \caption there would state a falsehood as a fact.
const FLOAT_ENVIRONMENTS = [
    'figure',
    'table',
    'longtable',
    'wrapfigure',
    'wraptable',
    'sidewaysfigure',
    'sidewaystable',
]

// overleaf-lab: floats that may legitimately carry no \caption, the same exemption the
// float-caption check makes and for the same reason. A longtable is how a multi-page
// list is typeset, and on three real projects the list of symbols or of acronyms in
// the front matter was exactly that: a longtable under a chapter heading, with no
// caption because the heading already names it. Handed to the model as a FACT, "this
// table has no \caption" is worse than a verdict, because the model is told to rely on
// it: the author gets asked to add a caption to a list that must not have one. The
// check side carries the same set and the same reasoning; when one moves, both move.
// Only the terminated environments reach this scan (the pattern below needs the
// \end), so no broken document can hide inside the exemption.
const CAPTION_OPTIONAL_FLOATS = new Set(['longtable', 'longtabu'])

// overleaf-lab: DECIDABLE structural facts, as opposed to the pattern scans below.
// A pattern scan surfaces candidates for the model to judge; these are answers: a
// float either contains a \caption or it does not, a label is either referenced
// somewhere or it is not. The failure that motivates them: on one longtable, three
// different models produced three different verdicts (one even asserted a \caption
// that does not exist), a question ten lines of code settle for good.
//
// Language- and policy-neutral by construction: pure LaTeX structure, no vocabulary.
// Whether an unreferenced label or a caption-less table VIOLATES anything is policy
// and stays in the rubric; the code only reports what is there.
// overleaf-lab: what a label is attached to. Reporting "labels never referenced" as
// one undifferentiated list would imply a norm that does not exist: a figure or a
// table is usually expected to be called out in the text, an equation or a section
// often is not. The code must not decide which of those matters, but it must not
// blur them either, so each label is classified by the environment that contains it
// and the rubric applies whatever policy it wants to each kind.
const LABEL_ENVIRONMENTS = [
    ['figure', /\\begin\{(?:figure|subfigure|wrapfigure|sidewaysfigure)\*?\}/],
    ['table', /\\begin\{(?:table|longtable|tabular|wraptable|sidewaystable)\*?\}/],
    ['equation', /\\begin\{(?:equation|align|gather|multline|eqnarray|flalign)\*?\}/],
    ['listing', /\\begin\{(?:lstlisting|verbatim|minted|algorithm)\*?\}/],
]
const SECTIONING = /\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[[{]/

function classifyLabel(text, index) {
    // Walk backwards to the nearest environment opening or sectioning command: the
    // last one before the label is what the label names.
    const before = text.slice(Math.max(0, index - 4000), index)
    let best = { kind: 'other', at: -1 }
    for (const [kind, opener] of LABEL_ENVIRONMENTS) {
        const re = new RegExp(opener.source, 'g')
        let match
        let last = -1
        while ((match = re.exec(before)) !== null) {
            last = match.index
        }
        if (last > best.at) {
            best = { kind, at: last }
        }
    }
    const sectioning = new RegExp(SECTIONING.source, 'g')
    let match
    let lastSection = -1
    while ((match = sectioning.exec(before)) !== null) {
        lastSection = match.index
    }
    if (lastSection > best.at) {
        best = { kind: 'section', at: lastSection }
    }
    // An environment that has already been closed does not contain the label.
    if (best.kind !== 'other' && best.kind !== 'section') {
        const afterOpen = before.slice(best.at)
        // Every environment that can OPEN a classification must be able to close it,
        // or a label sitting after \end{wrapfigure} keeps being called a figure.
        if (
            /\\end\{(?:figure|subfigure|wrapfigure|sidewaysfigure|table|longtable|tabular|wraptable|sidewaystable|equation|align|gather|multline|eqnarray|flalign|lstlisting|verbatim|minted|algorithm)\*?\}/.test(
                afterOpen
            )
        ) {
            return lastSection >= 0 ? 'section' : 'other'
        }
    }
    return best.kind
}

// overleaf-lab: a code listing cannot be labelled with \label{}. The listings
// package wants the label among the environment options, `label={lst:x}`, and a
// \label written after \end{lstlisting} attaches itself to whatever counter was
// stepped last, which is how listing numbers silently go wrong. Reading \label{}
// alone therefore reported every CORRECTLY labelled listing as a reference to an
// undefined label: observed on a template whose appendix compiled without a
// single LaTeX warning.
const LISTING_WITH_OPTIONS = /\\(?:begin\{lstlisting\}|lstinputlisting)\s*\[/g

// The option list ends at the first ] that is not nested inside braces, so a
// caption containing brackets cannot cut it short.
// overleaf-lab: how far a forward scan may look for its terminator. Both scans below
// used to run to the END OF THE FILE when the terminator was absent, which is linear
// per occurrence and therefore QUADRATIC over a file full of them. Measured on the
// previous version: 500 malformed listings 321 ms, 1000 1264 ms, 2000 4290 ms, 4000
// 15930 ms. That is sixteen seconds of synchronous CPU on Node's single thread, inside
// the request, so the whole instance stops answering everybody, not just the author of
// the file. Any student can upload it. A real option list is tens of characters and a
// real bibliography entry a few hundred, so these ceilings never bind on a document
// and only bound what a malformed one can cost.
const MAX_OPTION_CHARS = 2000
const MAX_BIB_ENTRY_CHARS = 4000

// Returns the index of the unnested closer, or -1 if it is not there within `limit`
// characters. -1 means "malformed", and the caller must treat it as such instead of
// falling back to the rest of the document.
function findUnnested(text, from, closer, limit = MAX_OPTION_CHARS) {
    let depth = 0
    const stop = Math.min(text.length, from + limit)
    for (let i = from; i < stop; i += 1) {
        const ch = text[i]
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
        else if (ch === closer && depth === 0) return i
    }
    return -1
}

function collectListingLabels(text) {
    const found = []
    for (const match of text.matchAll(LISTING_WITH_OPTIONS)) {
        const from = match.index + match[0].length
        const closer = findUnnested(text, from, ']')
        // No closing bracket within a plausible option list: the listing is malformed,
        // so it declares no label. Taking the rest of the file as "the options" was
        // both wrong and the quadratic case.
        if (closer === -1) continue
        const options = text.slice(from, closer)
        // Split on top-level commas only, for the same reason: `caption={a, b}`
        // is one option, not two.
        let depth = 0
        let start = 0
        for (let i = 0; i <= options.length; i += 1) {
            const ch = options[i]
            if (ch === '{') depth += 1
            else if (ch === '}') depth -= 1
            if (i < options.length && !(ch === ',' && depth === 0)) continue
            const part = options.slice(start, i)
            const at = start
            start = i + 1
            const label = /^\s*label\s*=\s*(?:\{([\s\S]*)\}|(\S.*?))\s*$/.exec(part)
            if (!label) continue
            const name = (label[1] === undefined ? label[2] : label[1]).trim()
            if (name) found.push({ name, index: from + at })
        }
    }
    return found
}

// overleaf-lab: every negated class in the collectors below is BOUNDED, exactly
// as in the checks module. `[^}]+` after a literal anchor is quadratic on a file
// of unclosed braces (each anchor scans to EOF and fails), these collectors run
// BEFORE the too_long guard, and scanPatternIsTooSlow does not cover them
// because they are ours, not the rubric's. 400 is the same generous bound the
// checks module settled on: no real key, label or path reaches it.
function collectLabels(docs) {
    const labels = new Map()
    for (const doc of docs) {
        const lineOf = makeLineLookup(doc.text)
        for (const match of doc.text.matchAll(/\\label\{([^}]{1,400})\}/g)) {
            if (!labels.has(match[1])) {
                labels.set(match[1], {
                    path: doc.path,
                    kind: classifyLabel(doc.text, match.index),
                    line: lineOf(match.index),
                })
            }
        }
        // Here the kind comes from the syntax itself and is not inferred: the
        // label was found inside a listing's own option list.
        for (const listing of collectListingLabels(doc.text)) {
            if (!labels.has(listing.name)) {
                labels.set(listing.name, {
                    path: doc.path,
                    kind: 'listing',
                    line: lineOf(listing.index),
                })
            }
        }
    }
    return labels
}

// overleaf-lab: labels DEFINED more than once - LaTeX's "multiply defined labels".
// The dangling-reference fact catches a \ref pointing nowhere; this catches the
// opposite and quieter defect, several definitions competing for one key. LaTeX
// resolves every \ref to the LAST of them, so the document sends the reader to the
// wrong equation with nothing in the PDF to show for it. Real defect: a master
// thesis defined \label{eq: transfer} four times and \label{eq: SRP} twice.
// Every definition is kept, unlike collectLabels which keeps the first, because the
// point of the fact is precisely WHERE the competing definitions are.
function collectDuplicateLabels(docs) {
    const places = new Map()
    for (const doc of docs) {
        const lineOf = makeLineLookup(doc.text)
        const add = (name, index) => {
            // NOT trimmed. `\label{eq:a}` and `\label{ eq:a }` are two different labels
            // to LaTeX - the space goes into the .aux and a \ref{eq:a} against the
            // second resolves to nothing - so trimming invented a "multiply defined
            // label" that LaTeX never warns about, and told the author to go and delete
            // one of two definitions that are not in conflict. collectLabels does not
            // trim either; the two must agree on what a key is.
            const key = String(name)
            if (!places.has(key)) {
                places.set(key, [])
            }
            places.get(key).push(`${doc.path}:${lineOf(index)}`)
        }
        for (const match of doc.text.matchAll(/\\label\{([^}]{1,400})\}/g)) {
            add(match[1], match.index)
        }
        for (const listing of collectListingLabels(doc.text)) {
            add(listing.name, listing.index)
        }
    }
    return [...places.entries()]
        .filter(([, where]) => where.length > 1)
        .map(([name, where]) => ({ name, where }))
}

function collectReferencedLabels(docs) {
    const referenced = new Set()
    for (const doc of docs) {
        // \ref, \autoref, \eqref, \cref, \Cref, \pageref, \nameref, \vref, starred
        // forms, and \cref{a,b} lists.
        // \href and \hyperref are excluded EXPLICITLY, not left to the whitelist above
        // to exclude by accident. "href" ends in the letters "ref", so any ref pattern
        // written as `[a-zA-Z]*ref` swallows \href{url}{text} and reads the URL as a
        // label name: that is exactly what happened to the checks module, where 9 links
        // of a real report came back as references to labels that do not exist. The
        // \hyperref[label]{text} form is a genuine label use and is collected below,
        // from the BRACKETS, which is where hyperref puts the label.
        for (const match of doc.text.matchAll(
            /\\(?!href\b|hyperref\b)(?:auto|eq|cpage|Cpage|page|name|labelc|label|sub|c|C|v|V)?ref\*?\{([^}]{1,400})\}/g
        )) {
            for (const part of match[1].split(',')) {
                referenced.add(part.trim())
            }
        }
        // \hyperref[label]{text} addresses the label in brackets.
        for (const match of doc.text.matchAll(/\\hyperref\[([^\]]{1,400})\]/g)) {
            referenced.add(match[1].trim())
        }
        // \crefrange{first}{last} names two labels, one per argument.
        for (const match of doc.text.matchAll(
            /\\[cC]refrange\*?\{([^}]{1,400})\}\{([^}]{1,400})\}/g
        )) {
            referenced.add(match[1].trim())
            referenced.add(match[2].trim())
        }
    }
    return referenced
}

// overleaf-lab: acronym bookkeeping, the same fact/policy split as the labels. Both
// the `acronym` package (\acro{KEY}{long form}, usually inside an \begin{acronym}
// list) and `glossaries` (\newacronym{KEY}{short}{long}) declare entries that the
// text then uses through \ac, \acs, \acl, \acf, \acp, \gls and friends. An entry
// declared and never used is a leftover; a key used but never declared prints a
// LaTeX error. Both are decidable, neither is a verdict.
function collectAcronyms(docs) {
    const declared = new Map()
    const used = new Set()
    for (const doc of docs) {
        for (const match of doc.text.matchAll(/\\acro\{([^}]{1,400})\}/g)) {
            if (!declared.has(match[1])) {
                declared.set(match[1], doc.path)
            }
        }
        // glossaries also declares with \newglossaryentry, and the acro package with
        // \DeclareAcronym: a \gls of one of those is a legitimate use, not the LaTeX
        // error that "used but never declared" claims it is.
        for (const match of doc.text.matchAll(
            /\\(?:newacronym|newglossaryentry|DeclareAcronym)(?:\[[^\]]{0,400}\])?\{([^}]{1,400})\}/g
        )) {
            if (!declared.has(match[1])) {
                declared.set(match[1], doc.path)
            }
        }
        // Usage commands. \acs, \acl, \acf, \acp, \acsp, \aclp, \Ac..., \gls, \Gls,
        // \glspl, \acrshort, \acrlong, \acrfull, with or without a star.
        for (const match of doc.text.matchAll(
            /\\(?:[Aa]c(?:s|l|f|p|sp|lp|fp)?|[Gg]ls(?:pl)?|acr(?:short|long|full)(?:pl)?)\*?(?:\[[^\]]{0,400}\])?\{([^}]{1,400})\}/g
        )) {
            used.add(match[1].trim())
        }
    }
    // overleaf-lab: writing the letters in the prose is a use too. Counting only the
    // package macros made every acronym of a document that spells them out by hand
    // come back "declared and never used" - all nine of them on a real internship
    // report, handed to the model as a mechanical fact while the report's own
    // requirement 20 was, on the same page, listing those same acronyms as used. A
    // hint the model is told to rely on has to be right or it is worse than absent.
    const blanked = docs
        .map(doc =>
            doc.text
                // The environment bound (20k) matches the checks module's region cap;
                // the row pattern uses the safe `\s{0,40}(?:X\s{0,40})?` spelling, not
                // `\s*X?\s*`, which backtracks quadratically on whitespace runs.
                .replace(/\\begin\{acronyms?\*?\}[\s\S]{0,20000}?\\end\{acronyms?\*?\}/g, m =>
                    m.replace(/[^\n]/g, ' ')
                )
                .replace(
                    /\\acro\{[^}]{0,400}\}\s{0,40}(?:\[[^\]]{0,400}\]\s{0,40})?\{[^}]{0,400}\}/g,
                    m => m.replace(/[^\n]/g, ' ')
                )
                .replace(
                    /\\(?:newacronym|newglossaryentry|DeclareAcronym)\s{0,40}(?:\[[^\]]{0,400}\]\s{0,40})?\{[^}]{0,400}\}(?:\{[^}]{0,400}\})*/g,
                    m => m.replace(/[^\n]/g, ' ')
                )
        )
        .join('\n')
    for (const short of declared.keys()) {
        if (used.has(short)) {
            continue
        }
        const safe = String(short).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(?<![\\w\\\\])${safe}(?![\\w])`).test(blanked)) {
            used.add(short)
        }
    }
    return { declared, used }
}

// overleaf-lab: citation bookkeeping, the label check applied to the bibliography.
// A \cite whose key is in no .bib entry renders as "[?]" in the PDF and is a defect
// no amount of reading catches reliably; an entry no one cites is dead weight. Both
// are decidable once the .bib is part of the assembled document, and neither is a
// verdict: whether they matter is for the guidelines to say.
// overleaf-lab: fields BibTeX itself requires for each entry type. This is the
// format's own table, not a house style: an @article without `year` makes bibtex
// warn, whatever bibliography style is in use. @misc is deliberately absent because
// the standard requires nothing of it, so reporting a missing field there would be
// us inventing a rule; a rubric that wants more (say, a year on every entry) says so
// in its own words and the model judges the entries, which it now receives.
const BIBTEX_REQUIRED_FIELDS = {
    article: ['author', 'title', 'journal', 'year'],
    book: ['title', 'publisher', 'year'],
    booklet: ['title'],
    inbook: ['title', 'publisher', 'year'],
    incollection: ['author', 'title', 'booktitle', 'publisher', 'year'],
    inproceedings: ['author', 'title', 'booktitle', 'year'],
    conference: ['author', 'title', 'booktitle', 'year'],
    manual: ['title'],
    mastersthesis: ['author', 'title', 'school', 'year'],
    phdthesis: ['author', 'title', 'school', 'year'],
    proceedings: ['title', 'year'],
    techreport: ['author', 'title', 'institution', 'year'],
    unpublished: ['author', 'title', 'note'],
}

// overleaf-lab: entries whose type-required fields are missing. Brace counting keeps
// a nested title like {Light {Field} {Photography}} from ending the entry early.
function findIncompleteBibEntries(docs) {
    const incomplete = []
    for (const doc of docs) {
        if (!/\.bib$/i.test(doc.path)) {
            continue
        }
        const lineOf = makeLineLookup(doc.text)
        for (const match of doc.text.matchAll(/@(\w+)\s*\{\s*([^,\s}]+)\s*,/g)) {
            const type = match[1].toLowerCase()
            // No early exit for types BibTeX asks nothing of (@misc): they still get
            // the author/title/year report below, which is the case that matters in
            // practice since that is where a bare link usually ends up.
            const required = BIBTEX_REQUIRED_FIELDS[type] || []
            let depth = 1
            let i = match.index + match[0].length
            // Bounded, for the same reason as findUnnested above: an entry whose
            // closing brace is missing used to be scanned to the end of the file, so a
            // .bib full of them cost quadratic time inside the request.
            const stop = Math.min(doc.text.length, match.index + MAX_BIB_ENTRY_CHARS)
            while (i < stop && depth > 0) {
                if (doc.text[i] === '{') depth += 1
                else if (doc.text[i] === '}') depth -= 1
                i += 1
            }
            const body = doc.text.slice(match.index, i)
            const lacks = field => !new RegExp(`[,{\\s]${field}\\s*=`, 'i').test(body)
            const missing = required.filter(lacks)
            // Separately, which of author/title/year an entry lacks, whatever its
            // type. Still a fact and not a verdict: BibTeX asks nothing of @misc, so
            // this cannot be reported as a violation, but a rubric that wants every
            // reference to carry them (most do) has no other way to check, and the
            // alternative is a model reading 31 structured entries and missing one.
            const missingCore = ['author', 'title', 'year'].filter(lacks)
            if (missing.length > 0 || missingCore.length > 0) {
                incomplete.push({
                    key: match[2],
                    type,
                    missing,
                    missingCore,
                    where: `${doc.path}:${lineOf(match.index)}`,
                })
            }
        }
    }
    return incomplete
}

// overleaf-lab: a \bibitem inside a thebibliography environment. A bibliography does
// not have to be a .bib: a hand-written thebibliography in a .tex is the whole
// bibliography of many internship reports, and reading only .bib files made every
// \cite in such a document look undefined and every entry look uncited.
const BIBITEM_KEY = /\\bibitem\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{([^}]{1,400})\}/g

function collectCitations(docs) {
    const defined = new Map()
    const cited = new Map()
    let citeAll = false
    for (const doc of docs) {
        const lineOf = makeLineLookup(doc.text)
        if (/\.bib$/i.test(doc.path)) {
            for (const match of doc.text.matchAll(/@\w+\s*\{\s*([^,\s}]+)\s*,/g)) {
                if (!defined.has(match[1])) {
                    defined.set(match[1], `${doc.path}:${lineOf(match.index)}`)
                }
            }
        } else if (/\\begin\{thebibliography\}/.test(doc.text)) {
            for (const match of doc.text.matchAll(BIBITEM_KEY)) {
                const key = match[1].trim()
                if (key && !defined.has(key)) {
                    defined.set(key, `${doc.path}:${lineOf(match.index)}`)
                }
            }
        }
        // \cite, \citep, \citet, \nocite, starred and optional-argument forms.
        for (const match of doc.text.matchAll(
            /\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]{0,400}\]){0,2}\{([^}]{1,400})\}/g
        )) {
            for (const key of match[1].split(',')) {
                const trimmed = key.trim()
                // A "*" key comes from \nocite{*}, which means "print every entry".
                // It is not a citation key: reporting it as an undefined key that
                // renders as [?] would be a fabricated fact, and it also makes every
                // entry in the bibliography legitimately cited.
                if (trimmed === '*') {
                    citeAll = true
                    continue
                }
                if (trimmed && !cited.has(trimmed)) {
                    cited.set(trimmed, `${doc.path}:${lineOf(match.index)}`)
                }
            }
        }
    }
    return { defined, cited, citeAll }
}

function findCaptionlessFloats(docs) {
    // A captionless longtable is layout, not a missing caption: see
    // CAPTION_OPTIONAL_FLOATS above.
    const wanted = FLOAT_ENVIRONMENTS.filter(env => !CAPTION_OPTIONAL_FLOATS.has(env))
    const found = []
    for (const doc of docs) {
        let lineOf = null
        // One bounded pass for every float environment at once. The previous form ran
        // an unbounded lazy `\begin{X}[\s\S]*?\end{X}` PER environment name, so a
        // document with unclosed floats was rescanned to EOF once per open float and
        // once per name: 512 KB measured 6206 ms. Only terminated blocks are returned,
        // which is what the lazy regex reported too.
        for (const block of findEnvironmentBlocks(doc.text, wanted)) {
            if (/\\caption\s*[[{]/.test(doc.text.slice(block.start, block.end))) continue
            lineOf = lineOf || makeLineLookup(doc.text)
            found.push({ env: block.name, path: doc.path, line: lineOf(block.start) })
        }
    }
    return found
}

// overleaf-lab: render the structural facts as hint lines. `cap` bounds each list so
// a document with many findings cannot blow up the prompt; the COUNT is always exact
// even when the list is cut, and the cut is stated instead of being silent.
// overleaf-lab: a fact the model does not need, because a parser already answers the
// requirement it serves. When a rubric marks a requirement [check: float-caption], the
// verdict on captions never reaches a model at all, so restating the same scan in
// every prompt spends attention on a question nobody is being asked. Worse, the two
// computations can disagree: the acronym fact and the acronym check contradicted each
// other on a real report, and the fact was the one that was wrong. Which facts are
// dropped therefore follows the RUBRIC, exactly as everything else here does.
const FACT_ANSWERED_BY_CHECK = {
    captionless: 'float-caption',
    orphanLabels: 'float-referenced',
    brokenRefs: 'crossrefs-resolve',
    brokenCites: 'citations-resolve',
    incompleteBib: 'bib-entries-complete',
    gluedUnits: 'unit-spacing',
}

// overleaf-lab: the .bib entries, in the shape LLMBibVerify wants. ONLY the split
// happens here - the field values are read by that module out of `body` - so this stays
// a scan for "@type{key," and the two files share no parser.
//
// The region of an entry ends where the NEXT one begins, exactly as the structural
// checks do it: an entry whose braces never close then costs one region instead of a
// walk to the end of the file, and a Zotero abstract of several thousand characters
// cannot push the title out of the region the way a fixed cap does.
const BIB_ENTRY_START = /@(\w+)\s*\{\s*([^,\s}]+)\s*,/g
const MAX_VERIFIABLE_BIB_ENTRIES = 2000

function bibEntriesForVerification(strippedDocs) {
    const entries = []
    for (const doc of strippedDocs) {
        if (!/\.bib$/i.test(doc.path)) continue
        const at = makeLineLookup(doc.text)
        const starts = [...doc.text.matchAll(BIB_ENTRY_START)]
        for (let n = 0; n < starts.length && entries.length < MAX_VERIFIABLE_BIB_ENTRIES; n++) {
            const match = starts[n]
            const end = n + 1 < starts.length ? starts[n + 1].index : doc.text.length
            entries.push({
                key: match[2].trim(),
                type: match[1].toLowerCase(),
                file: doc.path,
                line: at(match.index),
                body: doc.text.slice(match.index, end),
            })
        }
    }
    return entries
}

// overleaf-lab: the one requirement answered by a tool that is not a parser over the
// sources. LanguageTool reads the prose of the project and reports spelling and grammar
// mistakes with an exact file:line, in Italian and English, offline and identically on
// every run. It lives here rather than in the CHECKS catalogue because it is
// ASYNCHRONOUS and because it can be switched off at deployment: runCheck is synchronous
// and knows only about the sources, and that is worth keeping true.
//
// The three outcomes are told apart on purpose. Clean is "ok". Mistakes are "missing",
// with the list. A container that did not answer is "na" WITH THE REASON: reporting an
// outage as "no spelling errors found" is the one answer nobody could act on.
const LANGUAGETOOL_LOCATIONS = 20

async function runLanguageToolItem(requirement, strippedDocs, reportLanguage, signal, projectId) {
    const report = await languageToolCheck(strippedDocs, { language: reportLanguage, signal })
    logger.debug(
        { projectId, check: 'languagetool', ok: report.ok, totals: report.totals },
        '[LLM] compliance: languagetool'
    )
    const base = { requirement, suggestion: '', decidedByCode: true }
    if (!report.ok) {
        return {
            ...base,
            status: 'na',
            evidence: L(
                `Not checked: the LanguageTool service did not answer (${report.error}). ` +
                    'Spelling and grammar were not inspected for this review.',
                `Non verificato: il servizio LanguageTool non ha risposto (${report.error}). ` +
                    "L'ortografia e la grammatica non sono state ispezionate in questa revisione."
            ),
            locations: [],
            sourceFiles: [],
        }
    }
    const { kept, droppedByWhitelist, chunksSkipped } = report.totals
    const dictionary = droppedByWhitelist
        ? L(
              ` ${droppedByWhitelist} further matches were dropped by the institution dictionary.`,
              ` Altre ${droppedByWhitelist} segnalazioni sono state scartate dal dizionario di istituto.`
          )
        : ''
    const partial = chunksSkipped
        ? L(
              ' The project is larger than one review may send, so part of it was not read.',
              ' Il progetto è più grande di quanto una revisione possa inviare, quindi una parte non è stata letta.'
          )
        : ''
    if (kept === 0) {
        return {
            ...base,
            status: 'ok',
            evidence: L(
                `LanguageTool (${report.language}) found no spelling or grammar mistakes in the ` +
                    `${report.files} source files it read.${dictionary}${partial}`,
                `LanguageTool (${report.language}) non ha trovato errori di ortografia o grammatica nei ` +
                    `${report.files} file sorgente che ha letto.${dictionary}${partial}`
            ),
            locations: [],
            sourceFiles: [],
        }
    }
    const shown = report.matches.slice(0, LANGUAGETOOL_LOCATIONS)
    const locations = shown.map(m => ({
        path: m.file,
        line: m.line,
        what: m.suggestion ? `${m.message} "${m.excerpt}" -> ${m.suggestion}` : `${m.message} "${m.excerpt}"`,
    }))
    const more =
        kept > shown.length
            ? L(
                  ` The first ${shown.length} are listed; ${kept - shown.length} more are not.`,
                  ` Sono elencate le prime ${shown.length}; altre ${kept - shown.length} no.`
              )
            : ''
    // overleaf-lab: the mistakes THEMSELVES, in the evidence, the way every structural
    // check lists its own findings. They were stored in `locations[].what` and both
    // readers print a location as a bare `path:line`, so a student was told they have
    // 45 spelling mistakes with no way to learn a single one of them, under a sentence
    // claiming the first twenty were listed. The list belongs where the reader already
    // looks; `locations` stays populated for the group-by-file view.
    const listed = locations.map(l => `${l.path}:${l.line} - ${l.what}`).join(' | ')
    return {
        ...base,
        status: 'missing',
        evidence: clip(
            L(
                `LanguageTool (${report.language}) reports ${kept} spelling or grammar mistakes across ` +
                    `${report.files} source files.${more}${dictionary}${partial} ${listed}`,
                `LanguageTool (${report.language}) segnala ${kept} errori di ortografia o grammatica in ` +
                    `${report.files} file sorgente.${more}${dictionary}${partial} ${listed}`
            ),
            EVIDENCE_MAX_CHARS
        ),
        locations,
        sourceFiles: [...new Set(shown.map(m => m.file))],
    }
}

function buildStructuralFacts(strippedDocs, cap = 10, activeChecks = new Set()) {
    const lines = []
    const listed = (items, render) => {
        const shown = items.slice(0, cap).map(render).join(' | ')
        return items.length > cap ? `${shown} | ...and ${items.length - cap} more` : shown
    }
    const answered = name => activeChecks.has(FACT_ANSWERED_BY_CHECK[name])

    if (!answered('captionless')) {
        const captionless = findCaptionlessFloats(strippedDocs)
        lines.push(
            captionless.length === 0
                ? '- Floats without a \\caption: none (every figure/table environment contains a \\caption).'
                : `- Floats without a \\caption (${captionless.length}): ${listed(
                      captionless,
                      f => `${f.path}:${f.line} (${f.env})`
                  )}`
        )
    }

    // overleaf-lab: three facts about CAPTIONS and UNITS, for the requirements a
    // parser cannot decide but can hand a complete candidate list to. Every rubric here
    // asks whether a caption is self-explanatory, whether borrowed images credit their
    // source, and whether a value is properly separated from its unit; none of those is
    // decidable, but all three are questions the model was answering from whatever it
    // happened to notice while reading. A count it can rely on is the difference
    // between "some captions look short" and a list of the ones that are.
    //
    // All three are structural and carry no language: which words make a caption
    // self-explanatory, and which units a field accepts, stay in the rubric.
    const captions = []
    for (const doc of strippedDocs) {
        const at = makeLineLookup(doc.text)
        for (const m of doc.text.matchAll(/\\caption\s{0,40}(?:\[[^\]]{0,400}\]\s{0,40})?\{/g)) {
            const braced = readBracedArgument(doc.text, m.index + m[0].length - 1)
            if (!braced || typeof braced.value !== 'string') continue
            captions.push({ path: doc.path, line: at(m.index), text: braced.value })
        }
    }
    if (captions.length > 0) {
        const uncredited = captions.filter(c => !/\\cite|\\citep|\\citet|\\footnote/.test(c.text))
        lines.push(
            uncredited.length === 0
                ? `- Captions with no source credit: none (all ${captions.length} captions carry a \\cite or a \\footnote).`
                : `- Captions with no \\cite or \\footnote in them (${uncredited.length} of ${captions.length}; ` +
                  `an image the author made needs no credit, so which of these matter is for the guidelines ` +
                  `to say): ${listed(uncredited, c => `${c.path}:${c.line}`)}`
        )
        // Word count, not a judgement: a three-word caption may be perfect for a
        // simple plot. The model still decides; it just no longer has to find them.
        const terse = captions.filter(c => c.text.replace(/\\[a-zA-Z]+|[{}$]/g, ' ').trim().split(/\s+/).length <= 4)
        lines.push(
            terse.length === 0
                ? `- Captions of four words or fewer: none (of ${captions.length} captions).`
                : `- Captions of four words or fewer (${terse.length} of ${captions.length}, candidates for ` +
                  `"not self-explanatory", to be judged in context): ${listed(
                      terse,
                      c => `${c.path}:${c.line} "${c.text.slice(0, 40)}"`
                  )}`
        )
    }
    // Sentence length, a measurement and not a verdict: how long is too long is for
    // the guidelines to say, and 40 words is only where this list starts so it stays
    // a list of candidates rather than a census. Language-neutral by construction
    // (words are letter runs, in any Latin-script language). Lists are excluded on
    // purpose: an itemized enumeration is not a sentence however long it runs; so are
    // maths, whose "words" are symbols, and verbatim bodies, which are shown code.
    {
        const LONG_SENTENCE_WORDS = 40
        // Everything here is "not a sentence": a list, shown code, maths whose words
        // are symbols, and a float, which is layout. tabularx/subfigure/longtable are
        // in the list because the BODY of a table is not prose either.
        const SENTENCE_NON_PROSE_ENVIRONMENTS = [
            'itemize',
            'enumerate',
            'description',
            'acronym',
            'lstlisting',
            'verbatim',
            'minted',
            'alltt',
            'equation',
            'align',
            'gather',
            'multline',
            'eqnarray',
            'flalign',
            'array',
            'figure',
            'subfigure',
            'wrapfigure',
            'wraptable',
            'longtable',
            'tabularx',
            'tabular',
            'table',
        ]
        const blank = span => span.replace(/[^\n]/g, ' ')
        const long = []
        let totalSentences = 0
        for (const doc of strippedDocs) {
            if (/\.bib$/i.test(doc.path)) continue
            const at = makeLineLookup(doc.text)
            // Lists, shown code, maths, and floats - whose options, \includegraphics
            // arguments and captions glued onto the next paragraph inflated a 27-word
            // sentence to 87 on a real report (there is rarely a period before
            // \begin). One bounded pass over the begin/end tokens for all of them: the
            // four lazy regexes this replaces were quadratic on unclosed environments,
            // see blankEnvironments.
            const prose = blankEnvironments(doc.text, SENTENCE_NON_PROSE_ENVIRONMENTS)
                // Headings carry no final period, so their words joined whatever
                // sentence came next; same for their \addcontentsline companion.
                .replace(/\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s{0,40}(?:\[[^\]]{0,400}\]\s{0,40})?\{[^}\n]{0,400}\}/g, blank)
                .replace(/\\addcontentsline\s{0,40}\{[^}]{0,400}\}\s{0,40}\{[^}]{0,400}\}\s{0,40}\{[^}\n]{0,400}\}/g, blank)
                .replace(/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, blank)
                .replace(/(?<!\\)\$[^$\n]{0,400}?(?<!\\)\$/g, blank)
            // Sentences end at ./!/? before whitespace, before a LaTeX line break
            // (the ".\\" that glued three sentences into one 87-word "period" on a
            // real report), before a closing brace, or at a blank line. A false
            // break (an abbreviation) only SHORTENS what it splits, so it can hide a
            // long sentence but never invent one: the safe direction for a fact.
            const measure = (sentence, end) => {
                const words = (
                    sentence
                        .replace(/\\[a-zA-Z]+\*?/g, ' ')
                        .replace(/[{}[\]()$~]/g, ' ')
                        .match(/[A-Za-zÀ-ÖØ-öø-ÿ]+/g) || []
                ).length
                if (words === 0) return
                totalSentences += 1
                if (words >= LONG_SENTENCE_WORDS) {
                    const firstText = sentence.search(/\S/)
                    long.push({
                        path: doc.path,
                        line: at(end - sentence.length + (firstText === -1 ? 0 : firstText)),
                        words,
                        head: sentence.trim().replace(/\s+/g, ' ').slice(0, 60),
                    })
                }
            }
            let start = 0
            for (const m of prose.matchAll(/[.!?](?=\s|\\\\|\})|\n[ \t]*\n/g)) {
                const end = m.index + m[0].length
                measure(prose.slice(start, end), end)
                start = end
            }
            // The LAST sentence of a file, which no boundary can close: the terminator
            // has to be FOLLOWED by whitespace, a line break or a brace to count, and
            // the project text is built as `lines.join('\n')`, which never ends in a
            // newline. So the closing sentence of every file in every project went
            // unmeasured - missing both from the candidate list and from the "of N
            // sentences" denominator that is supposed to give the reader the scale.
            measure(prose.slice(start), prose.length)
        }
        if (totalSentences > 0) {
            long.sort((a, b) => b.words - a.words)
            lines.push(
                long.length === 0
                    ? `- Sentences of ${LONG_SENTENCE_WORDS} words or more, lists and maths excluded: none (of ${totalSentences} sentences).`
                    : `- Sentences of ${LONG_SENTENCE_WORDS} words or more, lists and maths excluded (${long.length} of ${totalSentences}; ` +
                      `how long is too long is for the guidelines to say): ${listed(
                          long,
                          s => `${s.path}:${s.line} (${s.words} words) "${s.head}..."`
                      )}`
            )
        }
    }

    // A number stuck to a letter unit, or separated from it by a comma. Both are
    // formatting facts; whether the unit itself is admissible is not. When the rubric
    // activates the unit-spacing check, a parser answers this exactly and the fact
    // would only invite the model to re-derive (and mis-transcribe) the same list.
    const glued = []
    if (!answered('gluedUnits')) for (const doc of strippedDocs) {
        const at = makeLineLookup(doc.text)
        // A number written straight after "=" is a SETTING, not a measurement:
        // \geometry{left=30mm}, [width=12.5mm], \setlength. Counting those reported
        // the page margins of a title page as badly formatted quantities, and the
        // model dutifully passed that on to the author. Observed on a real report.
        for (const m of doc.text.matchAll(/(?<![\w.=])(\d+(?:[.,]\d+)?)(,\s*|)\\?([a-zA-Z\\]{1,12})(?![\w])/g)) {
            if (!m[2] && !/^(?:mm|cm|km|kg|ms|ns|mA|mV|kW|MW|GHz|MHz|kHz|Hz|nm|um|dB|rad|deg|px|bit|GB|MB|kB|TB|s|m|g|A|V|W|K|N|J|C|T|F)$/.test(m[3])) {
                continue
            }
            glued.push({ path: doc.path, line: at(m.index), what: `${m[1]}${m[2]}${m[3]}` })
            if (glued.length >= 60) break
        }
        if (glued.length >= 60) break
    }
    if (!answered('gluedUnits')) lines.push(
        glued.length === 0
            ? '- Values written against their unit with no space, or separated from it by a comma: none.'
            : `- Values with no space before the unit, or a comma instead of a space (${glued.length}; ` +
              `which separators a document accepts is for the guidelines to say): ${listed(
                  glued,
                  g => `${g.path}:${g.line} "${g.what}"`
              )}`
    )

    const labels = collectLabels(strippedDocs)
    const referenced = collectReferencedLabels(strippedDocs)
    const orphans = answered('orphanLabels') ? [] : [...labels.keys()].filter(l => !referenced.has(l))
    if (answered('orphanLabels')) {
        // nothing: a parser answers this requirement
    } else if (orphans.length === 0) {
        lines.push(
            `- Labels never referenced: none (all ${labels.size} \\label targets are referenced at least once).`
        )
    } else {
        // Grouped and ordered by kind, floats first: those are the ones a rubric
        // usually cares about, and the cap must not spend its slots on section
        // labels. Every kind reports its exact count even when its list is cut.
        const ORDER = ['figure', 'table', 'equation', 'listing', 'section', 'other']
        const groups = new Map()
        for (const label of orphans) {
            const { kind, path: labelPath, line: labelLine } = labels.get(label)
            if (!groups.has(kind)) {
                groups.set(kind, [])
            }
            // The kind is repeated on EVERY entry, not just in a group heading: an
            // entry is what gets copied into the report's evidence, and a heading
            // left behind turns "a figure is never cited" into the vaguer "a label
            // is never referenced", which is the part a reader cannot act on.
            groups.get(kind).push(`${label} (${kind}, ${labelPath}:${labelLine})`)
        }
        const kinds = ORDER.filter(kind => groups.has(kind))
        const rendered = kinds.flatMap(kind => {
            const entries = groups.get(kind)
            return entries.length > cap
                ? [...entries.slice(0, cap), `...and ${entries.length - cap} more ${kind}`]
                : entries
        })
        const breakdown = kinds.map(kind => `${groups.get(kind).length} ${kind}`).join(', ')
        lines.push(
            `- Labels defined but never referenced (${orphans.length} of ${labels.size} labels: ${breakdown}; whether a kind must be referenced is for the guidelines to say): ${rendered.join(
                ' | '
            )}`
        )
    }

    // Definitions competing for one key, stated like its neighbours: the count is
    // exact, every place is named, and "none" is said out loud rather than left to be
    // inferred from a missing line. No check answers this one, so it is always built;
    // it changes no verdict, it is a fact for the model to weigh.
    const duplicateLabels = collectDuplicateLabels(strippedDocs)
    lines.push(
        duplicateLabels.length === 0
            ? '- Labels defined more than once: none.'
            : `- Labels defined more than once (${duplicateLabels.length}; LaTeX warns "multiply ` +
              `defined labels" and every \\ref to them resolves to the last definition): ${listed(
                  duplicateLabels,
                  d =>
                      `${d.name} (${d.where.slice(0, cap).join(', ')}${
                          d.where.length > cap ? `, ...and ${d.where.length - cap} more` : ''
                      })`
              )}`
    )

    if (!answered('brokenRefs')) {
        const broken = [...referenced].filter(r => !labels.has(r))
        lines.push(
            broken.length === 0
                ? '- References to undefined labels: none.'
                : `- References to undefined labels (${broken.length}): ${listed(broken, r => r)}`
        )
    }

    // Citation integrity, but only when a bibliography is actually part of the
    // assembled document: without the .bib every key would look undefined, which
    // would be a false alarm about our own reading rather than about the document.
    const { defined: bibKeys, cited, citeAll } = collectCitations(strippedDocs)
    if (bibKeys.size > 0) {
        if (!answered('brokenCites')) {
            const undefinedKeys = [...cited.keys()].filter(k => !bibKeys.has(k))
            lines.push(
                undefinedKeys.length === 0
                    ? `- Citations to undefined bibliography keys: none (all ${cited.size} cited keys exist among the ${bibKeys.size} entries).`
                    : `- Citations to undefined bibliography keys (${
                          undefinedKeys.length
                      }, these render as "[?]"): ${listed(
                          undefinedKeys,
                          k => `${k} (cited at ${cited.get(k)})`
                      )}`
            )
        }
        // Completeness is a .bib fact only. A hand-written thebibliography carries
        // free text, where author/title/year are a typographic convention and not
        // fields, so the entry scan finds nothing in it - and "none missing" over
        // entries nobody could read would be a pass we never verified.
        const hasBibFile = strippedDocs.some(doc => /\.bib$/i.test(doc.path))
        const incomplete =
            answered('incompleteBib') || !hasBibFile ? null : findIncompleteBibEntries(strippedDocs)
        if (incomplete) lines.push(
            incomplete.length === 0
                ? '- Bibliography entries missing author, title, year or a field BibTeX requires for their type: none.'
                : `- Bibliography entries with missing fields (${
                      incomplete.length
                  }; "required" is BibTeX's own rule for that entry type, @misc requires none): ${listed(
                      incomplete,
                      e =>
                          `${e.key} (@${e.type}, no ${[
                              ...new Set([...e.missing, ...e.missingCore]),
                          ].join('/')}${
                              e.missing.length ? ', required by BibTeX' : ''
                          }, ${e.where})`
                  )}`
        )

        // \nocite{*} prints the whole bibliography, so nothing in it is uncited.
        const uncited = citeAll ? [] : [...bibKeys.keys()].filter(k => !cited.has(k))
        if (uncited.length > 0) {
            lines.push(
                `- Bibliography entries never cited (${uncited.length} of ${
                    bibKeys.size
                }): ${listed(uncited, k => `${k} (${bibKeys.get(k)})`)}`
            )
        }
    }

    const { declared, used } = collectAcronyms(strippedDocs)
    if (declared.size > 0) {
        const unused = [...declared.keys()].filter(key => !used.has(key))
        lines.push(
            unused.length === 0
                ? `- Acronyms declared but never used: none (all ${declared.size} declared acronyms are used at least once).`
                : `- Acronyms declared but never used (${unused.length} of ${
                      declared.size
                  }): ${listed(unused, key => `${key} (${declared.get(key)})`)}`
        )
        const undeclared = [...used].filter(key => !declared.has(key))
        if (undeclared.length > 0) {
            lines.push(
                `- Acronyms used but never declared (${undeclared.length}): ${listed(
                    undeclared,
                    key => key
                )}`
            )
        }
    }

    return lines
}

// overleaf-lab: a scan pattern labelled "Document type" is not a hint for the
// model: it is the rubric declaring how to RECOGNISE the kind of document it
// applies to. A title page SAYS what a document is ("Tesi di Laurea in...",
// "First Cycle Degree in..."): no judgement needed, so when a rubric carries
// this pattern the pre-review type check is decided in code, instantly and
// deterministically, and the model is never asked. The pattern stays out of
// the scan hints for the same reason: it instructs the engine, not the reader.
const DOCUMENT_TYPE_LABEL = /^document\s*type$/i
function documentTypePattern(patterns) {
    return patterns.find(p => DOCUMENT_TYPE_LABEL.test(p.label)) || null
}
function documentTypeMatches(pattern, strippedDocs) {
    return strippedDocs.some(d => pattern.regex.test(d.text))
}

// One refusal, one wording. The enqueue-time and the run-time checks are meant to be
// interchangeable from the user's point of view, and they were not even in language:
// both messages were hardcoded English while the rest of the run had learned to speak
// the rubric's language, so an Italian rubric produced an Italian report with an English
// explanation on the click.
const TYPE_MISMATCH_MESSAGE_EN =
    'The rubric declares how to recognise its kind of document, and nothing in this project matches.'
const TYPE_MISMATCH_MESSAGE_IT =
    'La griglia dichiara come riconoscere il tipo di documento a cui si applica, e in questo progetto non corrisponde niente.'

function buildScanHints(strippedDocs, customPatterns = [], activeChecks = new Set(), imageMetrics = null) {
    const count = re =>
        strippedDocs.reduce((n, d) => n + (d.text.match(re) || []).length, 0)
    // Returns { hits, total }: the cap bounds the PROMPT, not the truth. Returning
    // only the capped list made the caller print "(15 candidates)" for a pattern with
    // forty matches, under a header that calls itself exhaustive.
    //
    // `total` counts MATCHES, not matching lines. A line that trips the pattern three
    // times is three things for the reader to judge, and counting it once made the
    // header under-report the very scan it calls exhaustive; the excerpt stays one per
    // line, because the line is what shows the reader where to look.
    const collect = (re, cap) => {
        const hits = []
        let total = 0
        let lines = 0
        const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
        for (const d of strippedDocs) {
            for (const line of d.text.split('\n')) {
                all.lastIndex = 0
                const found = (line.match(all) || []).length
                if (found > 0) {
                    total += found
                    lines += 1
                    if (hits.length < cap) {
                        hits.push(`${d.path}: "${line.trim().slice(0, 120)}"`)
                    }
                }
            }
        }
        return { hits, total, lines }
    }

    // These counts are presented to the model as exhaustive, so they must cover the
    // forms a real document uses: a natbib/cleveref thesis writes \citep and \cref,
    // and counting only \cite{ and \ref{ reported a confident "0 \cite" next to a
    // citation-integrity fact listing dozens of them.
    const figures = count(/\\begin\{figure/g)
    const tables = count(/\\begin\{(?:table|longtable)/g)
    const captions = count(/\\caption\s*[[{]/g)
    const equations = count(/\\begin\{(?:equation|align|gather|multline|flalign)/g)
    const refs = count(/\\(?:auto|eq|cpage|Cpage|page|name|labelc|label|sub|c|C|v|V)?ref\*?\{/g)
    const cites = count(/\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]{0,400}\]){0,2}\{/g)
    const listings = count(/\\begin\{(?:lstlisting|verbatim|minted)/g)

    // The count and the excerpts answer two different questions, so the sentence says
    // which is which: how many candidates there are, and how much of the source the
    // block is showing.
    const fmt = (label, { hits, total, lines }) =>
        total === 0
            ? `- ${label}: none found (mechanically verified over the whole source)`
            : `- ${label} (${total} candidate${total === 1 ? '' : 's'}${
                  lines > hits.length
                      ? `, showing the first ${hits.length} of ${lines} matching lines`
                      : ''
              }, judge each in context): ${hits.join(' | ')}`

    const lines = [
        'SCAN HINTS (computed mechanically from the LaTeX source; exhaustive for the listed patterns):',
        `- Counts: ${figures} figure environments, ${tables} table environments, ${captions} \\caption, ${equations} equation environments, ${refs} \\ref, ${cites} \\cite, ${listings} code listing environments.`,
        ...buildStructuralFacts(strippedDocs, 10, activeChecks),
        // overleaf-lab: the measured resolution of the raster figures, computed BEFORE
        // this function because fetching bytes is async and this function is not.
        // Empty (or absent) measurements add no lines at all.
        ...(imageMetrics ? imageMetricsFactLines(imageMetrics) : []),
    ]
    // overleaf-lab: rubric-defined scans (see parseScanPatterns): exhaustive scan by
    // code, context judgement by the model. The "Document type" pattern is a
    // directive to the engine (see documentTypePattern), not a scan for the reader.
    for (const { label, regex } of customPatterns) {
        if (DOCUMENT_TYPE_LABEL.test(label)) {
            continue
        }
        lines.push(fmt(label, collect(regex, 15)))
    }
    return lines.join('\n')
}

// overleaf-lab: a scan pattern that COMPILES can still take the instance down.
//
// The pattern is admin-written, the text it runs on is student-written, and
// documentTypeMatches runs it SYNCHRONOUSLY inside the HTTP request. JavaScript has
// no regex timeout and a backtracking match cannot be aborted, cancelled or raced by
// anything short of killing the process, so there is exactly one place to stop this:
// before the pattern is ever used. Measured on the shipped code, the plausible admin
// typo `(\w+\s*)+ in Ingegneria` - meant as "a run of words, then the degree name" -
// took 4.3 s on 36 bytes of student LaTeX, 67 s on 44 bytes, and past that longer
// than anyone will wait. Bounding the INPUT is no defence: the blow-up is exponential
// in the shape of the pattern, not in the size of the text.
//
// The probe is a ladder of short pathological strings (a run of one letter, of
// digits, of spaces, of word-and-space, of the punctuation a LaTeX pattern is written
// around, each with and without a suffix that forces the match to fail), tried from
// the shortest up with a wall-clock budget over the whole ladder. A pattern that
// backtracks exponentially crosses the budget while the probes are still tiny, so the
// cost of finding out stays in the hundreds of milliseconds and is paid once; an
// honest pattern finishes the whole ladder in about a millisecond.
//
// The punctuation units are there because the ladder only proves what it tries: a
// pattern whose blow-up is keyed on brackets or backslashes (an attempt at matching
// nested macro arguments) passed a ladder of letters, digits and spaces and then
// detonated on student LaTeX, which is made of exactly those characters.
const SCAN_PATTERN_PROBE_BUDGET_MS = 40
const SCAN_PATTERN_PROBE_UNITS = ['a', '0', ' ', 'a ', '(', '\\', '[', '{', '\\a{']
const SCAN_PATTERN_PROBE_LENGTHS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]

function scanPatternIsTooSlow(regex) {
    const started = Date.now()
    // Length OUTSIDE, probe shape inside: the shortest probe of every shape runs
    // before any longer one, so the first shape that explodes is caught while the
    // string is still short. Shape-major order would pay one whole ladder of the
    // worst case before trying the next shape.
    for (const length of SCAN_PATTERN_PROBE_LENGTHS) {
        for (const unit of SCAN_PATTERN_PROBE_UNITS) {
            const run = unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
            for (const probe of [run, `${run}!`]) {
                try {
                    regex.lastIndex = 0
                    regex.test(probe)
                } catch (err) {
                    // A pattern that throws while MATCHING (not while compiling) is
                    // not usable either, and the caller wants one answer, not two.
                    return true
                }
                if (Date.now() - started > SCAN_PATTERN_PROBE_BUDGET_MS) {
                    return true
                }
            }
        }
    }
    return false
}

// overleaf-lab: parse a RUBRIC's scan patterns (each rubric carries its own, edited
// next to its guidelines in the settings page, so the patterns live and die with the
// policy that motivates them). One per line, "Label :: regex" (case-insensitive); a
// line without "::" is used as both label and pattern, so a plain word works as-is.
// The save endpoint already refuses invalid regexes, but settings written by other
// means must not break a review, so invalid lines are skipped here too. Capped to
// keep the hint block small.
function parseScanPatterns(text) {
    const patterns = []
    for (const rawLine of String(text || '').split('\n')) {
        if (patterns.length >= 20) {
            break
        }
        const line = rawLine.trim()
        if (!line) {
            continue
        }
        const sep = line.indexOf('::')
        const label = (sep === -1 ? line : line.slice(0, sep)).trim()
        const body = (sep === -1 ? line : line.slice(sep + 2)).trim()
        if (!body) {
            continue
        }
        try {
            const regex = new RegExp(body, 'i')
            // The save endpoint refuses a pattern that blows up (see the probe
            // above), but a settings file written by hand, restored from a backup or
            // edited before that check existed must not be able to reintroduce one:
            // this is the last point where the pattern is still inert. Skipped and
            // logged rather than thrown, because one bad line in a rubric must cost
            // that line's hints, not the whole review.
            if (scanPatternIsTooSlow(regex)) {
                logger.warn(
                    { line },
                    '[LLM] compliance: skipping a scan pattern that backtracks catastrophically'
                )
                continue
            }
            patterns.push({ label: label || body, regex })
        } catch (err) {
            logger.debug({ line }, '[LLM] compliance: skipping invalid scan pattern')
        }
    }
    return patterns
}

// overleaf-lab: `[warning: ...]` at the end of an evidence string is the ENGINE's
// reliability marker and nothing else may write it. Both readers strip it with a tail
// regex and render its contents as the amber badge, so a `[warning:` that arrives
// from the document - quoted by a structural check, or repeated by the model out of a
// student's LaTeX - would be rendered as the engine's own judgement and would hide
// the tail of the real evidence behind it. The words are kept, the brackets that make
// them a marker are not. The same function, for the same reason, guards the evidence
// the structural checks build (LLMStructuralChecks, in `result`).
function neutraliseWarningMarker(text) {
    return String(text ?? '')
        .replace(/\[\s{0,40}warning\s{0,40}:([^\]]{0,400})\]/gi, '(warning:$1)')
        .replace(/\[\s*warning\s*:/gi, '(warning:')
}

// overleaf-lab: quote grounding. The judge itself can hallucinate evidence (observed:
// invented line numbers, quotes attributed to the wrong file), which is the failure
// mode that costs a report its credibility. Quotes are mechanically checkable: every
// quoted passage in an item's evidence is searched (whitespace/typography-normalized)
// in the assembled source. Ungrounded quotes flag the item for adversarial
// verification and, if they survive, a visible warning is appended to the evidence.
//
// ONE implementation, used by both the grounding check and the file:line index.
// They used to be two: a whole-string version here and a per-character one in
// buildSearchIndex, kept "identical" by a comment. They were not. JS toLowerCase is
// context-sensitive (a word-final Greek Sigma lowercases to the final form only when
// the whole string is folded at once) and code-unit iteration mangles astral-plane
// letters, so the two disagreed on real text: a quote could ground while refusing to
// be located, silently losing its position in the report. A single fold cannot drift.
function foldForMatch(text) {
    const source = String(text || '')
    let normalized = ''
    const lineOf = []
    // Source offset each normalized character came from, symmetric to lineOf. This
    // is what lets a matched quote be read back OUT of the source (deterministic
    // quoting): the match gives normalized coordinates, offsetOf turns them into a
    // slice of the real file.
    const offsetOf = []
    let offset = 0
    let line = 1
    let lastWasSpace = false
    for (const ch of source) {
        if (/\s/.test(ch)) {
            if (!lastWasSpace) {
                normalized += ' '
                lineOf.push(line)
                offsetOf.push(offset)
                lastWasSpace = true
            }
            if (ch === '\n') {
                line += 1
            }
            offset += ch.length
            continue
        }
        lastWasSpace = false
        let mapped = ch
        if (mapped === '‘' || mapped === '’' || mapped === '‚') {
            mapped = "'"
        } else if (
            mapped === '“' ||
            mapped === '”' ||
            mapped === '„' ||
            mapped === '«' ||
            mapped === '»'
        ) {
            mapped = '"'
        } else if (mapped === 'ς') {
            // Greek final sigma: whole-string lowercasing produces it from a
            // word-final Sigma, character-wise lowercasing produces the medial form.
            // Folding both to the medial form makes the two agree by construction.
            mapped = 'σ'
        }
        const lower = mapped.toLowerCase()
        normalized += lower
        for (let k = 0; k < lower.length; k++) {
            lineOf.push(line)
            offsetOf.push(offset)
        }
        offset += ch.length
    }
    let start = 0
    let end = normalized.length
    while (start < end && normalized[start] === ' ') start += 1
    while (end > start && normalized[end - 1] === ' ') end -= 1
    return {
        normalized: normalized.slice(start, end),
        lineOf: lineOf.slice(start, end),
        offsetOf: offsetOf.slice(start, end),
    }
}

// overleaf-lab: the report speaks the rubric's language. The model-written parts
// already do (the prompts tell it to answer in the language of the requirement); the
// parts this file BUILDS were English whatever the rubric said, so an Italian thesis
// came back with English fragments wedged between Italian sentences.
//
// This used to be a bare module-level variable, and the comment here said it was safe
// because one review ran at a time per process. That premise is GONE: the queue now
// dispatches one job per endpoint, so an Italian thesis and an English one can be in
// flight together, and a module global would hand the report chrome of one to the
// other at every await. The failure would be silent and unreproducible - the wrong
// language in half the fixed strings of whichever report lost the race - which is the
// worst shape a bug can have in a document somebody is marked on.
//
// So the language is per REVIEW, carried by an AsyncLocalStorage: every job runs its
// whole body inside one scope (see performReview), and L() reads that scope. The
// module variable stays as the fallback for the code paths that run outside any
// review, which is what it always was for them.
//
// The `typeof` guard is not defensive programming, it is the test contract: the suites
// slice this region out of the source and evaluate it with `new Function`, where the
// module's imports do not exist. There the scope is null and L() falls back to the
// module variable, exactly as it behaved before this existed, so the slices keep
// testing what they were written to test.
//
// It lives HERE, next to the helpers, rather than at the top of the file: the test
// suites slice this region out of the source and evaluate it on its own, so anything
// the merge helpers below reference has to be defined inside the slice.
let REPORT_LANG = 'en'
const REPORT_LANG_SCOPE =
    typeof AsyncLocalStorage === 'function' ? new AsyncLocalStorage() : null

function currentReportLanguage() {
    const scoped = REPORT_LANG_SCOPE ? REPORT_LANG_SCOPE.getStore() : null
    return scoped ? scoped.lang : REPORT_LANG
}

function setReportLanguage(lang) {
    const next = lang === 'it' ? 'it' : 'en'
    // Inside a review, ONLY the review's own scope moves. Writing the module variable
    // too would put the last review to start in charge of every string the others
    // build after it, which is the exact cross-talk the scope exists to stop.
    const scoped = REPORT_LANG_SCOPE ? REPORT_LANG_SCOPE.getStore() : null
    if (scoped) {
        scoped.lang = next
    } else {
        REPORT_LANG = next
    }
    return next
}

// overleaf-lab: the same choice with the language passed in, for the handful of strings
// built OUTSIDE a running review. L reads the module global, which belongs to whatever
// review is running: an HTTP handler that used it would answer in another user's
// language, and setting the global from a handler would change the language of a review
// already in flight. Both are avoided by naming the language at the call site.
const inLanguage = (lang, en, it) => (lang === 'it' && it != null ? it : en)

const L = (en, it) => inLanguage(currentReportLanguage(), en, it)

// overleaf-lab: which language the rubric is written in. Detection is a stopword
// count over the guidelines, not a declaration: rubrics are plain text written by an
// admin and already carry their language on every line.
function detectRubricLanguage(guidelines) {
    const text = ` ${String(guidelines || '').toLowerCase()} `
    const hits = res => res.reduce((n, re) => n + (text.match(re) || []).length, 0)
    const it = hits([/ il /g, / la /g, / di /g, / ogni /g, / non /g, / sono /g, / della /g, / nessun/g])
    const en = hits([/ the /g, / of /g, / is /g, / every /g, / not /g, / are /g, / no /g, / any /g])
    return it > en ? 'it' : 'en'
}

function normalizeForMatch(text) {
    return foldForMatch(text).normalized
}

// overleaf-lab: shortest quote worth checking. A very short span proves nothing and
// matches by accident, so it is skipped; but the floor must stay low enough to cover
// the quotes a units or formatting requirement actually makes. Observed at 15: an
// item listed eighteen "violations" of the value-unit spacing rule of which five were
// real, because the model had dropped the backslash from `0.1265\,mm` when quoting.
// Every one of those quotes was under fifteen characters, so none was ever checked
// and the false ones shipped unmarked.
const MIN_QUOTE_CHARS = 10

// The other end of the same scale: a span longer than this is a paragraph the model
// pasted, not a quotation, and it also bounds the pairing scan below.
const MAX_QUOTE_CHARS = 300

// overleaf-lab: a character that can carry a word, so an apostrophe standing between
// two of them belongs to the word and not to the quotation.
const QUOTE_INNER_CHAR = /[\p{L}\p{N}]/u

// overleaf-lab: the single-quoted spans of an evidence string, paired by what an
// apostrophe is NOT.
//
// In Italian the apostrophe is part of the word ("L'obbiettivo", "un'attività", "po'
// di"), which is why the old rule paired single quotes only at the END of a chunk,
// and greedily: from the first quote of the chunk to the last. Three quoted titles
// with prose between them therefore came back as ONE span containing that prose, and
// the three consumers of quoted evidence each drew their own wrong conclusion from a
// span nobody ever wrote: a fabrication warning on honest evidence, a finding left
// with no file:line, and a note telling the double-check that the quotes were suspect.
//
// The rule here is narrower and needs no chunking: a quote character with a word
// character on BOTH sides is an apostrophe, anything else can delimit. An opener also
// has to be followed by something other than a space, and a closer to be followed by
// a non-word character, so the ordinary Italian apostrophe cannot open or close a
// span. A quote that cannot be paired inside MAX_QUOTE_CHARS is skipped rather than
// stretched: missing a quote costs a check that was never owed, while inventing one
// costs the reader a false warning.
function singleQuotedSpans(text) {
    const spans = []
    let i = 0
    while (i < text.length) {
        if (text[i] !== "'") {
            i += 1
            continue
        }
        const opens =
            (i === 0 || !QUOTE_INNER_CHAR.test(text[i - 1])) &&
            i + 1 < text.length &&
            !/\s/.test(text[i + 1])
        if (!opens) {
            i += 1
            continue
        }
        const limit = Math.min(text.length, i + 2 + MAX_QUOTE_CHARS)
        let close = -1
        for (let j = i + 1; j < limit; j++) {
            if (text[j] === "'" && (j + 1 >= text.length || !QUOTE_INNER_CHAR.test(text[j + 1]))) {
                close = j
                break
            }
        }
        if (close === -1) {
            i += 1
            continue
        }
        const body = text.slice(i + 1, close)
        if (body.length >= MIN_QUOTE_CHARS && body.length <= MAX_QUOTE_CHARS) {
            spans.push(body)
        }
        // Past the closer either way: an out-of-range span must be CONSUMED, or the
        // next pairing starts inside it and returns the prose between two quotes.
        i = close + 1
    }
    return spans
}

// overleaf-lab: pull the quoted passages out of an evidence string. Handles double
// quotes and guillemets anywhere, and single-quoted spans by the apostrophe rule
// above. Short spans are ignored: grounding a 5-char quote proves nothing. Missing a
// quote here is harmless (it just goes unchecked); a false extraction could produce a
// false warning, so the rules stay conservative.
function extractQuotedSegments(evidence) {
    const segments = []
    // Typographic quotes/guillemets fold onto their straight forms FIRST, so the
    // extraction rules below see one quoting style regardless of what the model used.
    const text = String(evidence || '')
        .replace(/[“”„«»]/g, '"')
        .replace(/[‘’‚]/g, "'")
    // The second and third alternatives consume an out-of-range quoted span WITHOUT
    // capturing it. Without them the scan resumes at that span's CLOSING quote, so the
    // next pairing is the prose BETWEEN two quotes, which is then reported as an
    // unfound quote: a fabrication warning on evidence whose every real quote is in
    // the document. The too-SHORT case was the one still missing, and it fires on the
    // most reliable evidence there is: a structural check that lists `"API" is used
    // before being spelled out | ... | "CSV" is used before ...` had the prose between
    // its acronyms extracted four times over, so the one verdict in the report that
    // cannot be wrong was the one flagged to the reader as suspect.
    for (const match of text.matchAll(/"([^"]{10,300})"|"[^"]{301,}"|"[^"]{0,9}"/g)) {
        if (match[1] !== undefined) {
            segments.push(match[1])
        }
    }
    for (const span of singleQuotedSpans(text)) {
        segments.push(span)
    }
    return segments
}

// overleaf-lab: line number of a character offset inside a text. Fine for a one-off
// lookup; use makeLineLookup when resolving many offsets in the same document, or
// the cost becomes quadratic (see below).
function lineAt(text, index) {
    let line = 1
    for (let i = 0; i < index && i < text.length; i++) {
        if (text[i] === '\n') {
            line += 1
        }
    }
    return line
}

// overleaf-lab: offset -> line for MANY lookups in one document. The structural
// scans resolve one offset per match, and calling lineAt each time rescans the file
// from the start every time: on a large bibliography (a synced group library
// reaching thousands of entries) that is tens of seconds of synchronous CPU inside
// the request, which blocks the whole Node process for every user of the instance,
// not just the one running a review. One pass to index the newlines plus a binary
// search per lookup keeps it linear.
function makeLineLookup(text) {
    const offsets = [0]
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            offsets.push(i + 1)
        }
    }
    return index => {
        let low = 0
        let high = offsets.length - 1
        while (low < high) {
            const mid = (low + high + 1) >> 1
            if (offsets[mid] <= index) {
                low = mid
            } else {
                high = mid - 1
            }
        }
        return low + 1
    }
}

// overleaf-lab: a searchable index of one file: the same normalized text the quote
// grounding matches against, plus the source line each normalized character came
// from. This is what makes "file and line" possible WITHOUT asking the model for it.
// The model must never write a line number (the source it receives has none, so any
// number it produced would be invented, and the prompt forbids it); but the code
// already searches every quoted passage in the source to ground it, so it knows
// exactly where each one is. The location is therefore derived, not reported: it is
// correct by construction or absent.
//
// INVARIANT by construction: the normalized text is produced by foldForMatch, the
// very same function normalizeForMatch uses, so grounding and location can never
// disagree about what matches.
function buildSearchIndex(path, text) {
    const { normalized, lineOf, offsetOf } = foldForMatch(text)
    return { path, normalized, lineOf, offsetOf, text }
}

// overleaf-lab: where a quoted passage lives, or null when it is not in the source.
// Ellipsis-compressed quotes are located by their first probative piece, over the
// same segmentation the warning and the demotion use: a piece the pairing left with a
// quote character glued to its end matches nothing, and the finding then loses the
// file:line it had earned and falls under "everywhere and nowhere" in the report.
function locateSegment(segment, indexes) {
    for (const piece of evidencePieces(segment).concat([segment])) {
        const needle = normalizeForMatch(piece)
        if (needle.length < MIN_QUOTE_CHARS) {
            continue
        }
        const collapsed = collapseBackslashRuns(needle)
        for (const index of indexes) {
            for (const form of collapsed === needle ? [needle] : [needle, collapsed]) {
                const at = index.normalized.indexOf(form)
                if (at !== -1) {
                    return { path: index.path, line: index.lineOf[at] }
                }
            }
        }
    }
    return null
}

// overleaf-lab: a line number claimed in evidence PROSE. The text a pass receives has
// no line numbers in it, so a number written next to the word "line" was invented,
// whatever it points at. Deliberately narrow: the word, then the number, in the two
// languages a report is written in. "riga 3 della tabella" is about a table row and
// would match, which is why the note this feeds is a comparison and not a correction.
const INVENTED_LINE_CLAIM = /\b(?:lines?|righ[ea])\s*\.?\s*\d+/i

// overleaf-lab: every distinct file:line an item's evidence can be pinned to.
function locateEvidence(evidence, indexes) {
    const seen = new Set()
    const locations = []
    for (const segment of extractQuotedSegments(evidence)) {
        const found = locateSegment(segment, indexes)
        if (!found) {
            continue
        }
        const key = `${found.path}:${found.line}`
        if (!seen.has(key)) {
            seen.add(key)
            locations.push(found)
        }
    }
    return locations
}

// overleaf-lab: THE SOURCE EXCERPT. A location is a coordinate, and a coordinate is not
// something a student can act on: they still have to open the file, count to the line
// and work out which of the things on it the review meant. The excerpt puts the line
// itself in the report, with enough around it to recognise the spot, which is the whole
// difference between "go and look" and "look".
//
// FOUR BOUNDS, ALL OF THEM HERE, because this text is stored THREE TIMES: in the result
// document the store keeps, in the HTML the store archives next to it, and in the copy
// the student downloads. Unbounded excerpts are not a layout problem, they are a Mongo
// problem, and the archive is the thing that has to survive the nightly backup.
//
// The per-line caps are chosen so the per-excerpt cap holds BY CONSTRUCTION rather than
// by a check that somebody has to remember to keep:
//   HIT + 2 * CONTEXT * CONTEXT_LINE = 160 + 4 * 40 = 320 = EXCERPT_MAX_CHARS
// so the arithmetic below cannot drift away from the number this file advertises.
//
// The text goes in RAW. Escaping belongs to whoever renders it, and a string escaped
// twice is a string with `&amp;lt;` in it.
const EXCERPT_CONTEXT_LINES = 2
const EXCERPT_HIT_LINE_MAX = 160
const EXCERPT_CONTEXT_LINE_MAX = 40
const EXCERPT_MAX_CHARS =
    EXCERPT_HIT_LINE_MAX + 2 * EXCERPT_CONTEXT_LINES * EXCERPT_CONTEXT_LINE_MAX
const EXCERPT_MAX_LOCATIONS = 12
const EXCERPT_BUDGET_CHARS = 120 * 1024

// overleaf-lab: one line, cut to fit, saying so. The ellipsis is inside the allowance,
// so a clipped line is never longer than an unclipped one is allowed to be.
function clipExcerptLine(text, cap) {
    const flat = String(text == null ? '' : text).replace(/\r/g, '')
    if (flat.length <= cap) {
        return { text: flat, cut: false }
    }
    return { text: `${flat.slice(0, Math.max(0, cap - 3))}...`, cut: true }
}

// overleaf-lab: the lines around `line`, or null when the line is not in this file.
// Null rather than an empty block on purpose: a location that cannot be excerpted is a
// location the report shows as it always did, never an empty box that reads as "there
// is nothing there".
function excerptAt(sourceLines, line) {
    if (!Array.isArray(sourceLines)) {
        return null
    }
    if (!Number.isInteger(line) || line < 1 || line > sourceLines.length) {
        return null
    }
    const start = Math.max(1, line - EXCERPT_CONTEXT_LINES)
    const end = Math.min(sourceLines.length, line + EXCERPT_CONTEXT_LINES)
    const mark = line - start
    let clipped = false
    const lines = []
    for (let n = start; n <= end; n += 1) {
        const cut = clipExcerptLine(
            sourceLines[n - 1],
            n === line ? EXCERPT_HIT_LINE_MAX : EXCERPT_CONTEXT_LINE_MAX
        )
        clipped = clipped || cut.cut
        lines.push(cut.text)
    }
    // Whitespace only, above and below an empty line: there is nothing to look at, and
    // an empty code block under a finding is worse than no code block.
    if (!lines.some(text => text.trim())) {
        return null
    }
    return { start, mark, lines, clipped }
}

// overleaf-lab: attach an excerpt to every location the budget can afford, and report
// what it could not afford. The tally is not decoration: a reader who sees excerpts
// under the first findings and none under the last has to be told that this was a cap
// and not a failure to place them, or the report has quietly lied about its own reach.
function attachSourceExcerpts(items, strippedDocs) {
    const byPath = new Map()
    for (const doc of Array.isArray(strippedDocs) ? strippedDocs : []) {
        if (doc && typeof doc.path === 'string' && typeof doc.text === 'string') {
            byPath.set(doc.path, doc.text.split('\n'))
        }
    }
    const tally = {
        chars: 0,
        budgetChars: EXCERPT_BUDGET_CHARS,
        maxChars: EXCERPT_MAX_CHARS,
        maxPerItem: EXCERPT_MAX_LOCATIONS,
        attached: 0,
        // How many locations COULD have carried an excerpt and did not, because of one
        // of the caps above. This is the number the report's honesty note is about.
        capped: 0,
    }
    for (const item of Array.isArray(items) ? items : []) {
        const locations = Array.isArray(item.locations) ? item.locations : []
        let taken = 0
        for (const location of locations) {
            if (!location || !byPath.has(location.path)) {
                continue
            }
            const excerpt = excerptAt(byPath.get(location.path), location.line)
            if (!excerpt) {
                continue
            }
            const cost = excerpt.lines.reduce((n, text) => n + text.length, 0)
            if (
                taken >= EXCERPT_MAX_LOCATIONS ||
                tally.chars + cost > EXCERPT_BUDGET_CHARS
            ) {
                tally.capped += 1
                continue
            }
            location.excerpt = excerpt
            taken += 1
            tally.attached += 1
            tally.chars += cost
        }
    }
    return { ...tally, clipped: tally.capped > 0 }
}

// overleaf-lab: where this project lives on this instance, for the deep links the
// downloaded report carries back into the editor. It has to be computed HERE and stored
// WITH the result, because the report is read outside the browser that produced it: a
// file on a laptop, an attachment, a copy the dashboard serves a year later, none of
// which know what host the instance answers on.
//
// An instance that never declared a siteUrl gets no links at all rather than relative
// ones: a relative href in a downloaded file points at the filesystem. The shape test
// is deliberately narrow, since the value ends up in an href and comes from a config
// file an administrator edits by hand.
function projectDeepLinkBase(projectId) {
    const base = String(Settings.siteUrl || '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s/?#]+$/i.test(base)) {
        return ''
    }
    const id = String(projectId || '')
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
        return ''
    }
    return `${base}/project/${id}`
}

// overleaf-lab: deterministic quoting. Verbatim transcription is a fragile model
// capability BY CONSTRUCTION (measured here: correct thin spaces retyped as commas,
// \\cite over-escaped, case drifting), so a quote that the mechanical search CAN
// find is not left as the model transcribed it: it is read back out of the source
// and the report shows the file's own characters. The model chooses WHAT to quote;
// the file supplies the bytes. A quote the search cannot find is left alone and
// handled by the ungrounded-quote warning instead: restoration must never invent.
function restoreQuote(segment, indexes) {
    // An ellipsis-compressed quote spans a gap; there is no single source slice to
    // read it from, so it is out of scope by design.
    if (/\.{3,}|…/.test(segment)) {
        return null
    }
    const needle = normalizeForMatch(segment)
    if (needle.length < MIN_QUOTE_CHARS) {
        return null
    }
    const collapsed = collapseBackslashRuns(needle)
    for (const index of indexes) {
        if (!index.offsetOf || typeof index.text !== 'string') continue
        for (const form of collapsed === needle ? [needle] : [needle, collapsed]) {
            const at = index.normalized.indexOf(form)
            if (at === -1) continue
            const from = index.offsetOf[at]
            const to =
                at + form.length < index.offsetOf.length
                    ? index.offsetOf[at + form.length]
                    : index.text.length
            const original = index.text.slice(from, to).replace(/\s+/g, ' ').trim()
            // A pathological mapping (or a source span dominated by collapsed
            // whitespace) must not replace a plausible quote with garbage.
            if (original.length < MIN_QUOTE_CHARS || original.length > 400) continue
            return original
        }
    }
    return null
}

// overleaf-lab: rewrite every double-quoted passage of an evidence string with the
// source's own characters, where the source has them. The guard alternatives mirror
// extractQuotedSegments: without them the scan pairs a closing quote with the next
// opening one and "restores" the prose in between.
function restoreQuotedEvidence(evidence, indexes) {
    const text = String(evidence || '')
    let out = ''
    let last = 0
    for (const m of text.matchAll(/["“]([^"“”\n]{10,300})["”]|["“][^"“”\n]{301,}["”]|["“][^"“”\n]{0,9}["”]/g)) {
        if (m[1] === undefined) continue
        const restored = restoreQuote(m[1], indexes)
        if (!restored || restored === m[1]) continue
        out += text.slice(last, m.index) + '"' + restored + '"'
        last = m.index + m[0].length
    }
    return out + text.slice(last)
}

// overleaf-lab: models legitimately compress long quotes with internal ellipses
// ("first words ... last words"). The literal segment then never matches the source,
// which used to fire the ungrounded-quote warning on honest evidence. Each segment is
// split on its ellipses and every piece long enough to be probative is searched on
// its own; pieces too short to prove anything are dropped.
function splitOnEllipses(segment) {
    return String(segment)
        .split(/\[\s*\.{3,}\s*\]|\.{3,}|…/)
        .map(p => p.trim())
        .filter(p => p.length >= MIN_QUOTE_CHARS)
}

// overleaf-lab: quote characters the pairing above may have left glued to the ends of
// a piece. Only the ENDS are trimmed, never the inside, because a quote character
// inside a piece is part of the language ("L'obbiettivo") and cutting there would
// shred a real quote.
const QUOTE_EDGE = /^[\s'"`«»‘’“”]+|[\s'"`«»‘’“”]+$/g

// overleaf-lab: THE PIECES OF A QUOTED SPAN, and the one view of them.
//
// Three things are computed from the same quoted evidence: the ungrounded-quote
// warning, the file:line a finding is filed under, and the fabrication demotion. They
// used to segment it three different ways, so the same honest evidence could be told
// "not found verbatim" by one, left without a location by the second and kept by the
// third. One function, three callers: whatever a piece is, it is the same piece
// everywhere.
function evidencePieces(span) {
    const pieces = []
    for (const piece of splitOnEllipses(span)) {
        const trimmed = piece.replace(QUOTE_EDGE, '')
        if (trimmed.length >= MIN_QUOTE_CHARS) {
            pieces.push(trimmed)
        }
    }
    return pieces
}

// The pieces of every QUOTED passage of an evidence string (see extractVerbatimSpans
// for the wider set the demotion needs, which adds backticks and bare LaTeX).
function quotedPieces(evidence) {
    const pieces = []
    for (const segment of extractQuotedSegments(evidence)) {
        pieces.push(...evidencePieces(segment))
    }
    return pieces
}

// overleaf-lab: a model writing LaTeX inside a JSON string often over-escapes, so a
// correctly copied "\cite" comes back as "\\cite". The quote is real, only its
// escaping is wrong, and treating that as an unfound quote would put a fabrication
// warning on honest evidence (observed: six warnings on one item whose every quote
// was in the document). Matching therefore falls back to a form with runs of
// backslashes collapsed. It costs a little precision (a quote with "\\" now matches
// a source with "\") for a large gain in what the warning MEANS: text that is not
// in the document, rather than text that is punctuated differently.
function collapseBackslashRuns(text) {
    return String(text).replace(/\\{2,}/g, '\\')
}

function containsQuote(normalizedSource, piece) {
    const needle = normalizeForMatch(piece)
    if (normalizedSource.includes(needle)) {
        return true
    }
    const collapsed = collapseBackslashRuns(needle)
    return collapsed !== needle && normalizedSource.includes(collapsed)
}

// overleaf-lab: how many quoted passages of this evidence do NOT appear in the
// normalized source. {checked: n, missing: m}; checked=0 means the evidence carries
// no groundable quotes (e.g. a scan description), which is fine.
//
// Counted PIECE by piece, over the same segmentation the demotion and the location
// derivation use (see evidencePieces). Counting whole segments instead put the
// warning on evidence quoting three real titles in one breath, because one segment
// held all three plus the words between them and no source contains that.
function countUngroundedQuotes(evidence, normalizedSource) {
    let checked = 0
    let missing = 0
    for (const piece of quotedPieces(evidence)) {
        checked += 1
        if (!containsQuote(normalizedSource, piece)) {
            missing += 1
        }
    }
    return { checked, missing }
}

// overleaf-lab: EVIDENCE THAT QUOTES WHAT THE DOCUMENT DOES NOT CONTAIN.
//
// The warning above marks such a quote for the reader and leaves the verdict standing.
// That is not enough: a verdict whose only support is text nobody can find is not a
// verdict. Measured twice on real runs, both times as a false "ok": one item read
// "Checked <file>: it contains \acro{ADR}{Active Debris Removal}, ..." for a file that
// declares none of them, another justified a figure by describing it as drawn in TikZ
// while the source imports a PNG. So a finding supported by nothing that exists is
// DROPPED before the verdict is computed, and the drop is written into the report.
//
// Three conservative rules, because a wrong drop deletes a real defect:
//   - a span must be at least DEMOTION_MIN_QUOTE_CHARS long. Short spans match by
//     accident, and an ABSENCE claim ("no \todo marker remains") legitimately names
//     something the document does not contain; those namings are short.
//   - EVERY span of the evidence has to be missing. A finding listing five passages of
//     which one was mistyped is a partly wrong finding, not an invented one, and the
//     ungrounded-quote warning plus the verification pass already cover it.
//   - a span counts as missing only when NEITHER the text the pass was shown NOR the
//     raw project text contains it. Verbatim bodies and comments are blanked before a
//     pass sees them, so a quote can be real and invisible to the pass; that is the
//     sanitiser's doing and must not cost the author a finding.
//
// KNOWN RESIDUAL CASE, left in on purpose: a finding whose ONLY span names something it
// says is ABSENT and names it at length ("there is no \label{fig:schema-impianto} for
// this figure") reads as fabricated here, because the span really is not in the
// document. The length floor covers the ordinary phrasing of an absence claim, which
// names a bare command; this one is dropped instead of demoted quietly, so it costs a
// verdict and not the evidence: the caller keeps the text and says what it did.
const DEMOTION_MIN_QUOTE_CHARS = 15

// The spans of an evidence string that CLAIM to be copied out of the document. Quoted
// passages (the same extraction the grounding warning uses), spans in backticks, and
// bare LaTeX with braced arguments: the fabricated evidence measured carried its
// invention as raw LaTeX outside any quotation mark, so quotes alone would miss it.
const BACKTICK_SPAN = /`([^`\n]+)`/g
const LATEX_SPAN = /\\[a-zA-Z@]+\*?(?:\s*(?:\{[^{}\n]*\}|\[[^\][\n]*\]))+/g

function extractVerbatimSpans(evidence) {
    const text = String(evidence || '')
    const spans = [...extractQuotedSegments(text)]
    for (const match of text.matchAll(BACKTICK_SPAN)) {
        spans.push(match[1])
    }
    for (const match of text.matchAll(LATEX_SPAN)) {
        spans.push(match[0])
    }
    // A quote cut short by the model is a PREFIX of the real text, so its trailing
    // ellipsis must not be searched for. Internal ellipses are handled piece by piece
    // below, exactly as the grounding warning handles them.
    return spans
        .map(span => String(span).replace(/\s*(?:\.{3,}|…)\s*$/, '').trim())
        .filter(span => span.length >= DEMOTION_MIN_QUOTE_CHARS)
}

// overleaf-lab: the PIECES a span is really made of, which is the unit the demotion
// counts, and the reason is a measured false n.a.
//
// A span can hold several passages: a model compresses a long quote with an internal
// ellipsis, and a quoted list can arrive as one span with joining prose inside it.
// Requiring EVERY piece of such a span to be present turned three real quotes into one
// missing span, and the finding was dropped although the document contains all three
// (measured on two projects of batch8: the outline titles of an internship report, and
// a chapter opening that IS in the file). So each piece is searched on its own, in the
// same segmentation the warning and the location derivation use.
function probativePieces(evidence) {
    const pieces = []
    for (const span of extractVerbatimSpans(evidence)) {
        pieces.push(...evidencePieces(span))
    }
    return pieces
}

// {checked, missing} over those pieces. `sources` is a list of normalized haystacks,
// each either a string or a function returning one: the text the pass was shown comes
// first and the raw project text second, so the expensive one is only built when the
// cheap one has already failed.
function countFabricatedSpans(evidence, sources) {
    let checked = 0
    let missing = 0
    const haystacks = Array.isArray(sources) ? sources : [sources]
    for (const piece of probativePieces(evidence)) {
        checked += 1
        const present = haystacks.some(source =>
            containsQuote(typeof source === 'function' ? source() : source || '', piece)
        )
        if (!present) {
            missing += 1
        }
    }
    return { checked, missing }
}

// Is this finding supported by nothing the document contains? "No quotes at all" is
// NOT fabrication: a count, a scan description or a structural statement carries no
// quote and is judged elsewhere.
//
// THE INVARIANT: one piece of quoted text that the document really contains is enough
// to keep the finding. Whatever else the evidence says, the check did look at the
// document, so the verdict is a judgement to argue with (the ungrounded-quote warning
// and the verification pass are there for that) and not an invention to drop.
function evidenceIsFabricated(evidence, sources) {
    const { checked, missing } = countFabricatedSpans(evidence, sources)
    return checked > 0 && missing === checked
}

// The note that marks a dropped finding, in the bracketed style the report already uses
// for a split chapter vote ("[verdict agreed by 2 of 3 readings]").
function fabricatedEvidenceNote() {
    return L(
        ' [finding dropped: the quoted text is not in the document]',
        ' [rilievo scartato: il testo citato non è presente nel documento]'
    )
}

// ...and the note for the opposite case: a double-check that wanted to overturn a
// finding without showing where in the document it read that. The finding stands, and
// the reader is told the disagreement happened rather than being shown a verdict
// nobody can trace (see resolveVerifiedStatus).
function unprovenVerificationNote() {
    return L(
        ' [double-check disagreed but could not show its evidence in the document, so the finding stands]',
        ' [la doppia verifica non concorda ma non ha saputo mostrare le sue prove nel documento, quindi il rilievo resta]'
    )
}

// overleaf-lab: turn a fabricated sub-result into "not assessed" for its own unit. The
// evidence is KEPT and marked rather than deleted: a reader who is told a chapter was
// not assessed can weigh it, a reader shown nothing cannot, and an auditor needs to see
// what the check actually said. The verdict is recomputed from what is left by the
// ordinary merge, which is the same path a unit that answered n.a. takes.
// `maxChars` is the field budget of whatever the result belongs to: a unit of a
// per-file or per-chapter merge keeps the small per-unit budget (several of them share
// one item's evidence), a whole item gets the item budget. Passing the wrong one does
// not lose the verdict, only most of the evidence the reader was meant to weigh.
function demoteFabricatedResult(result, sources, maxChars = PER_FILE_FIELD_MAX_CHARS) {
    if (!result || result.status === 'na') {
        return false
    }
    if (!evidenceIsFabricated(result.evidence, sources)) {
        return false
    }
    const note = fabricatedEvidenceNote()
    result.status = 'na'
    result.evidence = `${clip(
        result.evidence,
        Math.max(MIN_QUOTE_CHARS, maxChars - note.length)
    )}${note}`
    result.fabricated = true
    return true
}

// overleaf-lab: the same rule for the items of ONE pass over the whole document, where
// a finding is a whole item rather than one unit's verdict. Returns the items that
// survive; an empty result means the pass produced nothing usable and the caller has to
// say so instead of reporting a verdict.
//
// `sourcesFor` is asked per item rather than fixed for the pass: one pass emits several
// findings and they do not all claim the same thing, so which haystacks may keep one
// alive is a property of that finding's evidence (see quoteSourcesFor).
function dropFabricatedItems(items, sourcesFor) {
    return items.filter(item => !evidenceIsFabricated(item.evidence, sourcesFor(item.evidence)))
}

// overleaf-lab: THE VERDICT A VERIFICATION PASS LEAVES BEHIND.
//
// A verifier that refutes every claim of a finding and then returns "missing" anyway
// has contradicted itself, and the report used to keep the violation: measured on a
// real run, the evidence read that the passage is quoted correctly and the sentence is
// not truncated, under a status of "missing". Holding a verdict consistent with prose
// it has just written is the step a model is worst at, so the model answers the closed
// question ("refuted": none / some / all, see VERIFY_ITEMS_SCHEMA) and the CODE draws
// the consequence: nothing survived, so nothing is being violated.
//
// The flip is only allowed when the verifier's own evidence is grounded in the
// document. "I cannot see it" is not a refutation, and turning an unreadable finding
// into "ok" would tell the author a requirement is met when nobody ever checked it,
// which is the worst answer a compliance report can give.
//
// THE SAME GATE ON THE OTHER DOOR. The rule above only guarded the recompute, so a
// verifier that simply ANSWERED "ok" closed a reported violation on its bare word, and
// that is the documented failure mode this whole pass exists for: audit2 measured it
// three times, the verifier's own stated reason being that the cited files were not in
// front of it. Every answer that erases a violation now goes through one door: the
// verifier must show, in text a mechanical search finds in the document, what it read.
// Otherwise the finding stands with a note saying the disagreement happened. Returning
// a null status means exactly that, "keep what you had", which is what the caller does
// with an unusable answer anyway.
//
// `findingStatus` is what the item said BEFORE the double-check. It defaults to the
// case the gate exists for: a caller that does not say is treated as defending a
// reported violation, which is the safe default rather than the permissive one.
function resolveVerifiedStatus(verified, verifierEvidenceIsGrounded, findingStatus = 'missing') {
    const status = ['ok', 'partial', 'missing', 'na'].includes(verified && verified.status)
        ? verified.status
        : null
    const wasNegative = findingStatus === 'missing' || findingStatus === 'partial'
    // "na" closes a finding as effectively as "ok" does: the reader is told nothing is
    // wrong here either way, so it is gated the same.
    if (wasNegative && (status === 'ok' || status === 'na') && !verifierEvidenceIsGrounded) {
        return { status: null, note: unprovenVerificationNote() }
    }
    if (status !== 'missing' && status !== 'partial') {
        return { status, note: '' }
    }
    if (String((verified && verified.refuted) || '').toLowerCase() !== 'all') {
        return { status, note: '' }
    }
    if (!verifierEvidenceIsGrounded) {
        return { status, note: '' }
    }
    return {
        status: 'ok',
        note: L(
            ' [verdict recomputed: the double-check found none of the reported problems in the document]',
            ' [verdetto ricalcolato: la doppia verifica non ha trovato nel documento nessuno dei problemi segnalati]'
        ),
    }
}

// overleaf-lab: repair LaTeX commands mangled by JSON string escapes. The JSON
// grammar cannot admit invalid escapes, so a model writing \ref unescaped ends up
// emitting the legal escape "\r" plus "ef", which parses to a control character and
// renders as "ef{...}" in the report (observed with two different models). CR, BS,
// FF and VT directly before a letter can only be that artifact and are always
// restored; LF and TAB can be legitimate whitespace, so they are restored only in
// front of common LaTeX command stems.
function repairJsonEscapeArtifacts(text) {
    return String(text || '')
        .replace(/\r(?=[A-Za-z])/g, '\\r')
        .replace(/[\b](?=[A-Za-z])/g, '\\b')
        .replace(/\f(?=[A-Za-z])/g, '\\f')
        .replace(/\v(?=[A-Za-z])/g, '\\v')
        .replace(/\n(?=ewcommand|ewline|ewpage|abla|onumber)/g, '\\n')
        .replace(/\t(?=ext|imes|heta|itle|oday)/g, '\\t')
}

// overleaf-lab: room for a report field. These are BACKSTOPS against a model that
// pastes whole environments, not a length target: the prompt asks for every place
// that violates a requirement, and a report that silently drops the sixth of eight
// findings is worse than a long one, because the author fixes what the report names.
// Sized for the prompt's own rule (list every occurrence, up to about fifteen).
// overleaf-lab: raised from 2500 after a real report cut a finding mid-list. The
// requirement was "plots should be vector", the model had listed twenty figures and
// marked which ones were legitimate raster exceptions, and the cut landed in the
// middle of that list: good judgement, truncated to uselessness. A report the reader
// cannot act on costs the same GPU time as one they can.
const EVIDENCE_MAX_CHARS = 4000
const SUGGESTION_MAX_CHARS = 1200
// Per-file sub-results are merged into ONE item, so several of them share the
// evidence budget above; each stays smaller.
const PER_FILE_FIELD_MAX_CHARS = 500
const PER_FILE_EXAMPLES = 10

// overleaf-lab: hard cap for a report field, cut at a word boundary and marked.
// Cutting mid-word ("Multi-Focused Plenoptic Came") reads as a bug, while a marked
// ellipsis reads as a decision.
function clip(text, max) {
    const value = String(text || '')
    if (value.length <= max) {
        return value
    }
    const cut = value.slice(0, max)
    const lastSpace = cut.lastIndexOf(' ')
    return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`
}

// overleaf-lab: fold the items of ONE pass (all about the same requirement) into at
// most one item per distinct status, joining their evidence. Order of first
// appearance is preserved so the report keeps the model's own ordering.
function mergePassItems(items) {
    if (items.length <= 1) {
        return items
    }
    const byStatus = new Map()
    // overleaf-lab: how many pieces of evidence did not fit. The merge used to clip the
    // concatenation and say nothing, so on a thirteen-chapter thesis a requirement
    // broken in chapters 1, 4, 7, 9 and 12 could reach the report showing the first
    // three and looking complete. The author fixes what is listed, re-runs, and the
    // same requirement comes back with occurrences they thought they had handled. A
    // count is cheap; a report that hides how much it is not showing is not.
    const dropped = new Map()
    for (const item of items) {
        const existing = byStatus.get(item.status)
        if (!existing) {
            byStatus.set(item.status, { ...item })
            dropped.set(item.status, 0)
            continue
        }
        if (item.evidence && !existing.evidence.includes(item.evidence)) {
            const combined = `${existing.evidence} | ${item.evidence}`
            if (combined.length > EVIDENCE_MAX_CHARS) {
                dropped.set(item.status, dropped.get(item.status) + 1)
            } else {
                existing.evidence = combined
            }
        }
        if (!existing.suggestion && item.suggestion) {
            existing.suggestion = item.suggestion
        }
    }
    for (const [status, entry] of byStatus) {
        const missed = dropped.get(status) || 0
        if (missed > 0) {
            entry.evidence = `${entry.evidence} | ${L(
                `and ${missed} further passage${
                    missed === 1 ? '' : 's'
                } reporting the same problem, not shown here for length.`,
                missed === 1
                    ? 'e un altro passaggio che segnala lo stesso problema, non riportato qui per ragioni di spazio.'
                    : `e altri ${missed} passaggi che segnalano lo stesso problema, non riportati qui per ragioni di spazio.`
            )}`
        }
    }
    return [...byStatus.values()]
}

// overleaf-lab: does this evidence talk about this file? A model cites a path in
// whatever shape it read it in ("/Mainmatter/1_intro.tex", "Mainmatter/1_intro.tex",
// or the bare name), so all three count. Over-matching costs a longer verification
// prompt; under-matching costs a finding refuted because the verifier was never shown
// the file it was about, so the bias here is deliberately towards including.
function evidenceMentionsPath(evidence, path) {
    const text = String(evidence || '')
    if (!text || !path) {
        return false
    }
    const relative = path.replace(/^\//, '')
    const base = relative.slice(relative.lastIndexOf('/') + 1)
    return (
        text.includes(path) || text.includes(relative) || (base.length > 4 && text.includes(base))
    )
}

// overleaf-lab: does this evidence claim to have READ one of the project's files? A
// finding that names a file is answering about that file, so what may ground it is the
// file, not the lines this code wrote into the prompt (see quoteSourcesFor).
function evidenceClaimsAFile(evidence, docs) {
    return docs.some(doc => evidenceMentionsPath(evidence, doc.path))
}

// overleaf-lab: order the files a merged finding came from by how much of its EVIDENCE
// is about each one. The report files a finding under the head of this list, and the
// previous order was "how much text that file contributed to the chapter", which
// answers a different question: a spelling finding whose six examples sat in three
// other files was filed under the chapter's biggest file, so the reader opened it and
// found nothing. Files the evidence never names keep their old relative order at the
// end, since something put them there.
function byEvidenceWeight(paths, evidence) {
    const text = String(evidence || '')
    const weight = new Map()
    for (const path of paths) {
        const relative = path.replace(/^\//, '')
        let count = 0
        let from = 0
        for (;;) {
            const at = text.indexOf(relative, from)
            if (at === -1) break
            count += 1
            from = at + relative.length
        }
        weight.set(path, count)
    }
    // Stable: equal weights keep the order they came in with.
    return paths
        .map((path, index) => ({ path, index }))
        .sort((a, b) => weight.get(b.path) - weight.get(a.path) || a.index - b.index)
        .map(entry => entry.path)
}

// overleaf-lab: how many adversarial verifications a set of findings has earned.
// Same selection rule as the verification loop (negatives, plus any item whose
// quotes failed the mechanical grounding check, capped), kept in one place so the
// progress total announced during the run and the work actually done cannot drift.
// Monotonic in practice: items are only ever appended, so the announced total grows
// and never walks backwards.
function countPlannedVerifications(items, groundings) {
    let planned = 0
    for (const [k, item] of items.entries()) {
        // Same exclusion as the verification loop: a code-decided verdict is never
        // sent to the model, so counting one here would announce a pass that never
        // runs and leave the progress bar short of its own total.
        if (item.decidedByCode) {
            continue
        }
        const negative = item.status === 'missing' || item.status === 'partial'
        // Same exclusion as the verification loop: an item that already says "not
        // assessed" has no verdict to defend. Sending one back to a model can only
        // manufacture a verdict out of the very quotes that got the finding dropped,
        // which is how a dropped fabrication came back as a violation.
        const ungrounded =
            item.status !== 'na' && groundings[k] && groundings[k].missing > 0
        if (negative || ungrounded) {
            planned += 1
        }
    }
    return Math.min(planned, VERIFY_MAX_FINDINGS)
}

// overleaf-lab: the "[per-file]" rubric marker. A requirement about diffuse text
// quality (spelling, tense coherence) checked in ONE pass over a whole thesis falls
// into the documented lost-in-the-middle failure: the model under-attends the middle
// of a long context and an "ok" under-covers the central chapters. Ending a rubric
// line with [per-file] makes that requirement run as one sub-pass per source file
// (each file alone in context, fully attended), merged into a single report item.
// Like the scan patterns, the marker lives in the rubric: policy, not code.
// overleaf-lab: [per-file] was the first marker; [per-chapter] and [structure]
// generalise the same idea, which is that a requirement declares HOW MUCH of the
// document it needs to be judged, and the rubric is where that belongs.
//
//   [per-file]     one sub-pass per source file          (unchanged)
//   [per-chapter]  one sub-pass per chapter of the text  (files are not chapters:
//                  a thesis written in a single main.tex has one file and twelve
//                  chapters, and per-file degenerates to one pass over everything)
//   [structure]    one pass over the SKELETON, not the text: headings, parts and
//                  the code-computed facts, a couple of thousand tokens instead of
//                  the whole document
//   no marker      one pass over the whole document      (unchanged)
//
// Which one a requirement wants follows from what makes it FAIL, and the three are
// not interchangeable:
//   - "every caption is self-explanatory" is universal, so a chapter that has no
//     figures answers n.a. and the merge ignores it: [per-chapter].
//   - "there is an abstract" cannot be judged per chapter at all, because a missing
//     abstract makes EVERY chapter answer n.a. and the merge would report n.a.
//     instead of missing. Absence is only visible from the outline: [structure].
//   - "the decimal separator is consistent throughout" is irreducibly global: every
//     chapter can be internally consistent while the document is not. No marker.
const SCOPE_MARKER = /\s*\[\s*(per[- ]file|per[- ]chapter|structure)\s*\]\s*$/i

// overleaf-lab: "[whole-document]" says the requirement is about the document AS A
// WHOLE and may not be decided on a part of it. Measured: a requirement about how the
// report is organised overall ("the activities are described in the chapters after the
// opening, not merely listed there") was marked [per-chapter], so every chapter was
// asked whether IT described the activities in detail, and the worst chapter decided a
// question about the whole. The answer to that question does not exist inside one
// chapter.
//
// Unlike the markers above it is NOT anchored to the end of the line: it overrides a
// scope a rubric already carries, so it has to be addable to an existing line without
// its author having to re-order the markers already there. It wins over every other
// scope marker, and the marker it overrides must not come back once it is stripped,
// which is why stripping goes through stripScopeMarker and never through SCOPE_MARKER
// on its own.
const WHOLE_DOCUMENT_MARKER = /\s*\[\s*whole[- ]document\s*\]\s*/i

// overleaf-lab: "[example-violation: ...]" and "[example-compliant: ...]", on their own
// lines under a requirement, are contrastive examples for that requirement only.
//
// They are lines of their own because splitRubric folds continuation lines into the
// requirement above, which is what makes them travel with the right requirement without
// any numbering to keep in step. That same folding is why they MUST be pulled out
// before any other marker is read: SCOPE_MARKER, CANDIDATE_MARKER and CHECK_MARKER are
// anchored to the end of the joined text, so a requirement with examples under it would
// silently lose its scope and become a whole-document pass.
const EXAMPLE_LINE = /^[ \t]*\[[ \t]*example-(violation|compliant)[ \t]*:[ \t]*([\s\S]*)\][ \t]*$/i

// Two of each is the cap: the examples ride in every pass of that requirement, and a
// long list of them costs context on every call while adding nothing a pair of
// contrasting cases does not already show.
const MAX_EXAMPLES_PER_KIND = 2

function requirementExamples(requirement) {
    const violation = []
    const compliant = []
    for (const line of String(requirement || '').split('\n')) {
        const match = EXAMPLE_LINE.exec(line)
        if (!match) {
            continue
        }
        const bucket = match[1].toLowerCase() === 'violation' ? violation : compliant
        const text = match[2].trim()
        if (text && bucket.length < MAX_EXAMPLES_PER_KIND) {
            bucket.push(text)
        }
    }
    return { violation, compliant }
}

function stripExampleLines(requirement) {
    return String(requirement || '')
        .split('\n')
        .filter(line => !EXAMPLE_LINE.test(line))
        .join('\n')
        .trim()
}

// overleaf-lab: the examples as they reach the model. Appended AFTER the requirement
// text and nowhere else: the document block is byte-identical across every pass of a
// review so the backend's prompt cache can reuse its prefill, and anything inserted
// before or inside it would throw that away and re-read the whole project once per
// requirement.
function exampleBlock(requirement) {
    const { violation, compliant } = requirementExamples(requirement)
    if (violation.length === 0 && compliant.length === 0) {
        return ''
    }
    const lines = ['', 'EXAMPLES for this requirement only:']
    for (const text of violation) {
        lines.push(`- this violates the requirement: ${text}`)
    }
    for (const text of compliant) {
        lines.push(`- this complies: ${text}`)
    }
    return lines.join('\n')
}

// The requirement as a pass sends it: the text with every marker removed, then its own
// examples. One helper for all four pass shapes, so an example can never end up in one
// of them and be missing from another.
function requirementWithExamples(rawRequirement, strippedText) {
    return `${strippedText}${exampleBlock(rawRequirement)}`
}

// overleaf-lab: [per-candidate: Label] turns an open search into closed questions.
// For a requirement like "no qualitative claim without supporting data", asking a
// model to FIND the claims in a chapter is where recall dies (measured: real
// violations found by one run and missed by the identical next one). With this
// marker the rubric names one of its own scan patterns as the candidate generator:
// the CODE extracts every passage that pattern hits, and the model only answers
// yes/no per passage, with its context in front of it. Questions get smaller, the
// evidence is built by code from the source bytes, and a candidate can never be
// silently skipped. The pattern stays in the rubric, so what counts as a candidate
// remains policy, editable next to the requirement it serves.
const CANDIDATE_MARKER = /\s*\[\s*per[- ]candidate\s*:\s*([^\]]+?)\s*\]\s*$/i

// overleaf-lab: what the end-anchored markers are read against. The examples are whole
// lines under the requirement and [whole-document] can sit anywhere on it, so both have
// to be out of the way before a marker anchored to the end of the text can be found:
// otherwise adding either of them to a rubric line silently disables the marker that
// was already there, which turns a parser check into a model pass or a per-chapter
// requirement into a whole-document one without a word in any report.
function markerScanText(requirement) {
    return stripExampleLines(requirement).replace(WHOLE_DOCUMENT_MARKER, ' ').trimEnd()
}

function requirementCandidateLabel(requirement) {
    const match = CANDIDATE_MARKER.exec(markerScanText(requirement))
    return match ? match[1].trim() : null
}

// overleaf-lab: "[check: name]" hands a requirement to a parser instead of a model.
// The marker lives here with the other rubric syntax; the catalogue of what the names
// mean lives in LLMStructuralChecks.mjs, which knows about LaTeX and nothing about
// rubrics. Run `listChecks()` there for the available names.
const CHECK_MARKER = /\s*\[\s*check\s*:\s*([a-z0-9-]+)\s*\]\s*$/i

function requirementCheck(requirement) {
    const match = CHECK_MARKER.exec(markerScanText(requirement))
    return match ? match[1].toLowerCase() : null
}

// overleaf-lab: removed from the LINE it sits on, not from the end of the text.
// requirementCheck reads the marker through markerScanText, where the example lines
// are already out of the way; on the raw text the marker is followed by them, so an
// end-anchored replace here silently did nothing and any caller that strips before
// re-reading saw the marker forever (see requirementScope, which used to recurse on
// exactly that).
function stripCheckMarker(requirement) {
    return String(requirement || '')
        .split('\n')
        .map(line => (EXAMPLE_LINE.test(line) ? line : line.replace(CHECK_MARKER, '')))
        .join('\n')
        .trim()
}

function isWholeDocumentRequirement(requirement) {
    return WHOLE_DOCUMENT_MARKER.test(stripExampleLines(requirement))
}

function requirementScope(requirement) {
    // A requirement a parser can answer has no scope at all, because it never reaches
    // a model: whether the document fits a context window does not apply to it.
    const check = requirementCheck(requirement)
    // overleaf-lab: a check the deployment has switched OFF is not a check. The
    // requirement goes back to the model under whatever scope it declares underneath
    // ([per-file] for the spelling one), exactly as it behaved before the check
    // existed. Decided here, at plan time, so the pass count and the progress bar are
    // right: deciding it while running would promise N passes and run N+1.
    if (check && (check !== 'languagetool' || isLanguageToolEnabled())) {
        return 'code'
    }
    // The scan view of the requirement, minus a check marker that is not going to run:
    // every marker below is anchored to the end of that view, and a disabled check
    // marker sits between them and it. Computed here rather than by re-entering this
    // function with the marker stripped, because the strip has to happen on the SCAN
    // view: on the raw text the marker is not at the end whenever example lines follow
    // it, so the recursion never terminated and a rubric with examples under a
    // [check: languagetool] line took down every review on a deployment without
    // LanguageTool.
    const scanText = check
        ? markerScanText(requirement).replace(CHECK_MARKER, '').trimEnd()
        : markerScanText(requirement)
    if (CANDIDATE_MARKER.test(scanText)) {
        // [per-candidate] is not a context scope: the code extracts the passages and
        // the document is never sent, so the requirement is already decided over the
        // whole project and a [whole-document] marker on it changes nothing.
        return 'candidates'
    }
    // Before SCOPE_MARKER, and returning immediately, so the marker it overrides cannot
    // re-scope the requirement once it has been stripped.
    if (isWholeDocumentRequirement(requirement)) {
        return 'document'
    }
    const match = SCOPE_MARKER.exec(scanText)
    if (!match) {
        return 'document'
    }
    const name = match[1].toLowerCase().replace(/\s/g, '-')
    if (name === 'per-file') {
        return 'file'
    }
    if (name === 'per-chapter') {
        return 'chapter'
    }
    return 'structure'
}

// overleaf-lab: the requirement as the report and the model must see it: every marker
// gone, in the one order that works. The examples go first (they are whole lines, and
// the markers below are anchored to the end of the text), then [whole-document]
// wherever it sits, and only then the end-anchored markers, which the removal above may
// just have brought to the end of the line.
function stripScopeMarker(requirement) {
    return stripExampleLines(requirement)
        .replace(WHOLE_DOCUMENT_MARKER, ' ')
        .replace(SCOPE_MARKER, '')
        .replace(CANDIDATE_MARKER, '')
        .trim()
}

// overleaf-lab: WHICH MATERIAL A REQUIREMENT IS ABOUT, read from the requirement's own
// words. A rubric names the LaTeX construct its requirement is about ("(\caption)",
// "(lstlisting/verbatim)", "\includegraphics", "equation/align"), and those names are
// the same in every language because they are LaTeX and not prose. Matching them lets
// the code answer two questions it could not answer before, both measured as wrong
// verdicts:
//   - the project contains NONE of that material, so a lone "ok" from one chapter is a
//     vote about nothing (measured on a requirement about code listings, on a project
//     with zero listings: the aggregate came back ok on one run and na on the next),
//   - one chapter answered n.a. while it is full of that material, which is how the
//     chapter that CONTAINED the defect removed itself from the verdict.
// It carries no knowledge of any rubric, requirement number or template: the
// association is the LaTeX vocabulary the rubric and the source already share. A
// requirement that names no LaTeX construct simply has no material, and both rules
// above are then inert, which is the safe default.
const REQUIREMENT_MATERIAL = [
    {
        kind: 'figures',
        names: /\b(?:figure|figures|includegraphics|wrapfigure|graphicx)\b/i,
        occurs: /\\begin\{figure|\\includegraphics\b/g,
    },
    {
        kind: 'tables',
        names: /\b(?:table|tables|tabular|longtable|wraptable)\b/i,
        occurs: /\\begin\{(?:table|longtable|tabular)/g,
    },
    {
        kind: 'captions',
        names: /\b(?:caption|captions)\b/i,
        occurs: /\\caption\s*[[{]/g,
    },
    {
        kind: 'equations',
        names: /\b(?:equation|equations|align|gather|multline|displaymath)\b/i,
        occurs: /\\begin\{(?:equation|align|gather|multline|flalign)|\\\[/g,
    },
    {
        kind: 'listings',
        names: /\b(?:lstlisting|lstinputlisting|verbatim|minted|listing|listings)\b/i,
        occurs: /\\begin\{(?:lstlisting|verbatim|minted|alltt)|\\lstinputlisting\b/g,
    },
    {
        kind: 'citations',
        names: /\b(?:cite|citep|citet|bibitem|bibliography|printbibliography)\b/i,
        occurs: /\\(?:no)?cite[a-zA-Z]*\*?(?:\[[^\]]{0,400}\]){0,2}\{|\\bibitem\b/g,
    },
    {
        kind: 'crossrefs',
        names: /\b(?:ref|autoref|cref|eqref|hyperref)\b/i,
        occurs: /\\(?:auto|eq|c|C|v|V|name|page|Cpage|cpage)?ref\*?\s*\{/g,
    },
    {
        kind: 'acronyms',
        names: /\b(?:acro|acronym|acronyms|newacronym|acrshort|acrlong|gls)\b/i,
        occurs: /\\(?:acro|newacronym|acrshort|acrlong|gls|acs|acf)\b/g,
    },
]

function requirementMaterial(requirement) {
    const text = stripScopeMarker(requirement)
    return REQUIREMENT_MATERIAL.filter(entry => entry.names.test(text))
}

// How many pieces of that material a stretch of LaTeX holds. Exhaustive by
// construction, like every other code-computed fact here.
function countMaterial(material, text) {
    const source = String(text || '')
    return material.reduce((n, entry) => n + (source.match(entry.occurs) || []).length, 0)
}

// overleaf-lab: a requirement whose material is nowhere in the project cannot be
// "met": there was nothing to meet it with. The stray "ok" that decides it comes from
// a chapter that had nothing to look at, which is why the verdict was observed
// flipping between ok and na across runs of two different models on an unchanged
// project. n.a. is the answer that survives a re-run.
//
// Three conditions, all necessary: the merged verdict is a plain "ok" (a real
// violation anywhere keeps its verdict), the requirement names material the project
// does not contain at all, and no chapter that voted ok could point at anything in the
// sources. That last one is what keeps a genuine "one chapter has figures and they are
// all fine" from being turned into n.a.
function applyVacuousRequirement(merged, results, material, materialCount, hasPositiveEvidence) {
    if (!merged || merged.status !== 'ok') {
        return false
    }
    if (material.length === 0 || materialCount > 0) {
        return false
    }
    if (results.some(r => r.status === 'ok' && hasPositiveEvidence(r))) {
        return false
    }
    merged.status = 'na'
    merged.evidence = clip(
        `${merged.evidence}${L(
            ' [not applicable: the project contains none of the material this requirement is about, and no chapter quoted any]',
            ' [non applicabile: nel progetto non c\'è nulla del materiale di cui parla il requisito, e nessun capitolo ne ha citato]'
        )}`,
        EVIDENCE_MAX_CHARS
    )
    return true
}

// overleaf-lab: find \begin{X}...\end{X} blocks in ONE pass over the begin/end tokens.
//
// The obvious way to write this is a lazy regex, `\begin{X}[\s\S]*?\end{X}`, and this
// file had four of them plus one per float environment. Every `\begin` with no matching
// `\end` makes that scan run to the end of the file and fail, and the engine then
// retries from the next `\begin`: N unclosed environments cost N x length. Measured on
// the previous version of the sentence-length fact: 500 open `\begin{figure}` took
// 10 ms, 4000 took 253 ms, 16000 (546 KB, a paste any student can make) took 3616 ms of
// synchronous CPU. Node is single-threaded and this runs inside the review, so that is
// the whole instance answering nobody - the exact failure LLMStructuralChecks.mjs was
// hardened against, re-introduced here in a different notation. A stray `\end{figure}`
// at the top of the file defeats V8's required-literal prefilter, so "it never matches
// anyway" is not a defence: the timings above are the same with one.
//
// Same one-pass stack scan as LLMStructuralChecks.findEnvironments, and the same
// decision about the broken case: an environment whose \end is missing yields NO block,
// which is what the lazy regex did too. Stretching it to the end of the file would
// delete the rest of the document from the review.
const MAX_SCANNED_ENVIRONMENTS = 20000

function findEnvironmentBlocks(text, names) {
    if (!text || !names || names.length === 0) {
        return []
    }
    const token = new RegExp(`\\\\(begin|end)\\{(${names.join('|')})\\*?\\}`, 'g')
    const open = new Map()
    const blocks = []
    let match
    while ((match = token.exec(text)) !== null && blocks.length < MAX_SCANNED_ENVIRONMENTS) {
        const name = match[2]
        let stack = open.get(name)
        if (!stack) {
            stack = []
            open.set(name, stack)
        }
        if (match[1] === 'begin') {
            stack.push(match.index)
        } else if (stack.length > 0) {
            // Innermost first, so an environment nested inside another of the same
            // name does not close its parent early.
            blocks.push({ name, start: stack.pop(), end: match.index + match[0].length })
        }
        // An \end with no \begin is a broken document, not an environment: ignored.
    }
    return blocks.sort((a, b) => a.start - b.start)
}

// overleaf-lab: blank a set of spans in ONE rebuild.
//
// Written span by span (`text.slice(0, s) + blanked + text.slice(e)`) this copies the
// whole file once per span, which is quadratic in the number of spans however cheap
// finding them was. Spans may overlap or nest, so they are merged as they are walked.
//
// BLANKED, never cut: every character that is not a newline becomes a space, so every
// offset and every line number in the rest of the file is still the offset and the line
// of the real source.
function blankSpans(text, spans) {
    if (!spans || spans.length === 0) {
        return text
    }
    const sorted = [...spans].sort((a, b) => a[0] - b[0])
    const pieces = []
    let cursor = 0
    for (const [start, end] of sorted) {
        if (end <= cursor) continue
        const from = Math.max(start, cursor)
        if (from > cursor) {
            pieces.push(text.slice(cursor, from))
        }
        pieces.push(text.slice(from, end).replace(/[^\n]/g, ' '))
        cursor = end
    }
    pieces.push(text.slice(cursor))
    return pieces.join('')
}

function blankEnvironments(text, names) {
    const blocks = findEnvironmentBlocks(text, names)
    if (blocks.length === 0) {
        return text
    }
    return blankSpans(
        text,
        blocks.map(block => [block.start, block.end])
    )
}

// overleaf-lab: every passage a scan pattern hits, each with the sentence around it
// and one sentence of tail, because "is this claim supported?" is answered by the
// words NEXT to the claim. Verbatim bodies are blanked (shown code is not prose);
// the .bib is skipped for the same reason. {candidates, total}: the cap bounds the
// judging work, the total keeps the report honest about what was left out.
// overleaf-lab: where one passage ends and the next begins.
//
// A full stop is not the only thing that ends a claim. A LaTeX list item, a table row
// and a heading carry no final punctuation at all, and that is exactly where a rubric's
// "no qualitative claim without data" pattern hits: ten `\item` claims used to collapse
// into ONE candidate, because with no terminator between them every window degenerated
// to "350 characters back, 500 forward" and each hit overlapped the last by more than
// half. The report then said "each of the 1 passages was judged" and read as a clean
// pass over nine claims nobody looked at.
//
// A bare newline is deliberately NOT a boundary: in LaTeX a single line break is just a
// space, and thesis sources are routinely hard-wrapped mid-sentence, so treating one as
// a boundary would cut ordinary prose in half and throw away the context the window
// exists to carry. A BLANK line is a paragraph break and does end a passage.
const PASSAGE_BREAK =
    /[.!?](?=\s|$)|\n[ \t]*\n|\\\\|\\item\b|\\(?:chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\b/g

function collectCandidatePassages(strippedDocs, regex, cap = 40) {
    const candidates = []
    // overleaf-lab: one PASSAGE, not one match. A sentence that trips the pattern
    // twice ("molto buoni" and "estremamente accurato" in the same sentence, seen on
    // the gold set) used to become two candidates carrying the identical window, so
    // the model judged the same text twice and the evidence quoted it twice. The
    // window is what is judged, so the window is what has to be unique.
    const seen = new Set()
    let total = 0
    let hits = 0
    for (const doc of strippedDocs) {
        if (/\.bib$/i.test(doc.path)) continue
        // Per-candidate only: the chapter passes still read these files (language
        // consistency legitimately covers acknowledgements), but a first-person
        // "grazie alla mia famiglia" is not a candidate anything should judge.
        if (UNREVIEWED_PATH.test(doc.path)) continue
        const at = makeLineLookup(doc.text)
        const prose = blankEnvironments(doc.text, ['lstlisting', 'verbatim', 'minted', 'alltt'])
        const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
        // Matches arrive in increasing position, so a window that overlaps an earlier
        // one overlaps the most recently KEPT one: comparing against that alone keeps
        // the pass linear instead of quadratic in the number of hits.
        let lastKept = null
        for (const m of prose.matchAll(re)) {
            // Back to the start of the hit's own passage (bounded), forward to the end
            // of the passage AFTER it: the window a nearby citation lives in.
            let lead = prose.slice(Math.max(0, m.index - 350), m.index)
            PASSAGE_BREAK.lastIndex = 0
            let leadCut = 0
            for (const b of lead.matchAll(PASSAGE_BREAK)) {
                leadCut = b.index + b[0].length
            }
            lead = lead.slice(leadCut)
            let tail = prose.slice(m.index, Math.min(prose.length, m.index + m[0].length + 500))
            const ends = [...tail.matchAll(PASSAGE_BREAK)].filter(e => e.index >= m[0].length)
            if (ends.length >= 2) tail = tail.slice(0, ends[1].index + ends[1][0].length)
            const text = (lead + tail).replace(/\s+/g, ' ').trim().slice(0, 700)
            if (text.length === 0) continue
            // Counted before any deduplication: a hit that turns out to sit in a
            // passage already collected must not disappear from the arithmetic, or
            // the note under the verdict cannot say that it happened.
            hits += 1
            // Same file, same words: the same passage, whatever hit it.
            const key = `${doc.path}\0${text.toLowerCase()}`
            if (seen.has(key)) continue
            // Or the same stretch of the file. The span compared is the hit's OWN
            // passage, not the whole window: the window deliberately carries the
            // NEXT passage too (that is where a supporting citation lives), so two
            // hits one sentence apart share most of their WINDOWS, and comparing
            // those would throw away a second, genuinely different passage. Two hits
            // in the same passage share the passage itself, which is the defect.
            const start = m.index - lead.length
            const end =
                m.index + (ends.length > 0 ? ends[0].index + ends[0][0].length : tail.length)
            if (lastKept) {
                const overlap = Math.min(end, lastKept.end) - Math.max(start, lastKept.start)
                const shorter = Math.min(end - start, lastKept.end - lastKept.start)
                if (shorter > 0 && overlap > shorter / 2) continue
            }
            seen.add(key)
            lastKept = { start, end }
            // Counted only once it is a passage of its own, so `total` stays the
            // honest answer to "how many passages were there", cap or no cap.
            total += 1
            if (candidates.length >= cap) continue
            candidates.push({ path: doc.path, line: at(m.index), text })
        }
    }
    // Three numbers, because they answer three different questions and merging them
    // is how the loss above stayed invisible: `hits` is how many times the pattern
    // fired, `total` how many DISTINCT passages those hits fall in (the denominator
    // the cap applies to), `candidates` how many were handed to the model.
    return { candidates, total, hits }
}

function isPerFileRequirement(requirement) {
    return requirementScope(requirement) === 'file'
}

function stripPerFileMarker(requirement) {
    return stripScopeMarker(requirement)
}

// overleaf-lab: fold the per-file sub-results into ONE report item. Any missing wins,
// else any partial, else ok; "na" files (a spelling check on a .bib is legitimately
// n.a.) do not drag the verdict down unless nothing was checkable at all.
//
// "Any missing wins" is deliberate but it MULTIPLIES the per-file false-positive
// rate: over N files, one hallucinated violation decides the whole requirement (at a
// 5% per-file rate and 14 files, that is a coin flip). A blanket threshold ("at least
// two files") is the wrong cure, because for an existential requirement ("no spelling
// errors") a single real typo in a single file IS a violation, so a threshold would
// trade a false positive for a false negative on exactly the requirements where one
// instance counts. The cures are instead: state HOW MANY files dissented (here, so a
// reader can weigh "1 of 14" against "9 of 14"), and send a lone dissenter to
// adversarial verification against its own file (see the caller).
function mergeFileItems(requirement, fileResults, unit = 'files') {
    const statuses = fileResults.map(r => r.status)
    let status = 'na'
    if (statuses.includes('missing')) {
        status = 'missing'
    } else if (statuses.includes('partial')) {
        status = 'partial'
    } else if (statuses.includes('ok')) {
        status = 'ok'
    }
    // "n.a." is the same abbreviation in both languages (not applicable / non
    // applicabile), so only the words around it change.
    const unitWord = L(unit, unit === 'chapters' ? 'capitoli' : 'file')
    // One unit is not "1 capitoli". The count is written by code and read by the
    // author of the document, and a report that cannot say "1 chapter" reads as one
    // nobody proof-read.
    const unitsFor = n =>
        n === 1
            ? L(unit === 'chapters' ? 'chapter' : 'file', unit === 'chapters' ? 'capitolo' : 'file')
            : unitWord
    let evidence
    if (status === 'ok') {
        const okCount = statuses.filter(s => s === 'ok').length
        // A unit whose answer was thrown away for fabricated evidence is not "nothing
        // applied here": it is a unit nobody assessed, and blending it into the n.a.
        // tally is how a discarded finding left no trace at all under a merged "ok".
        const discarded = fileResults.filter(r => r.status === 'na' && r.fabricated).map(r => r.path)
        const naFiles = fileResults
            .filter(r => r.status === 'na' && !r.fabricated)
            .map(r => r.path)
        const naTail =
            (naFiles.length > 0
                ? `, ${naFiles.length} n.a. (${naFiles.slice(0, 5).join(', ')}${
                      naFiles.length > 5 ? ', ...' : ''
                  })`
                : '') +
            (discarded.length > 0
                ? L(
                      `, ${discarded.length} not assessed (evidence discarded: ${discarded
                          .slice(0, 5)
                          .join(', ')}${discarded.length > 5 ? ', ...' : ''})`,
                      `, ${discarded.length} non valutat${
                          discarded.length === 1 ? 'o' : 'i'
                      } (prove scartate: ${discarded.slice(0, 5).join(', ')}${
                          discarded.length > 5 ? ', ...' : ''
                      })`
                  )
                : '')
        evidence = L(
            `Checked ${
                unit === 'chapters' ? 'chapter by chapter' : 'file by file'
            }: ${okCount}/${fileResults.length} ${unit} ok${naTail}`,
            `Controllato ${
                unit === 'chapters' ? 'capitolo per capitolo' : 'file per file'
            }: ${okCount}/${fileResults.length} ${unitWord} ok${naTail}`
        )
    } else {
        const dissenting = fileResults.filter(r => r.status === status)
        const shown = dissenting
            .slice(0, PER_FILE_EXAMPLES)
            // The sub-pass often opens its evidence with the file path already,
            // and prefixing it again produced "/a.tex: /a.tex: ..." in reports.
            .map(r =>
                r.evidence.trimStart().startsWith(r.path)
                    ? r.evidence.trimStart()
                    : `${r.path}: ${r.evidence}`
            )
            .join(' | ')
        const rest = dissenting.length - PER_FILE_EXAMPLES
        const restTail =
            rest > 0
                ? L(
                      ` | and ${rest} more ${unitsFor(rest)}, not shown here for length.`,
                      ` | e altri ${rest} ${unitsFor(rest)}, non riportati qui per ragioni di spazio.`
                  )
                : ''
        evidence = clip(
            L(
                `${dissenting.length} of ${fileResults.length} ${unit}: ${shown}${restTail}`,
                `${dissenting.length} ${unitsFor(dissenting.length)} su ${
                    fileResults.length
                }: ${shown}${restTail}`
            ),
            EVIDENCE_MAX_CHARS
        )
    }
    // overleaf-lab: an n.a. from a unit that HOLDS the material the requirement is
    // about is not "nothing to check here", it is "nobody checked here". Measured: the
    // one chapter carrying the defect answered n.a. and the merge, which ignores n.a.
    // by design, turned that into an "ok" for the whole requirement. The merge still
    // ignores it (a retry per unit would multiply the passes), but the report says it
    // happened, so the reader can tell a clean requirement from a partly unread one.
    const unassessed = fileResults.filter(r => r.unassessed > 0)
    if (unassessed.length > 0) {
        const names = unassessed.slice(0, 5).map(r => r.path).join(', ')
        evidence += L(
            ` | Not assessed in ${unassessed.length} ${unitsFor(unassessed.length)} that ${
                unassessed.length === 1 ? 'does' : 'do'
            } contain the material this requirement is about (${names}${
                unassessed.length > 5 ? ', ...' : ''
            }).`,
            ` | Non valutato in ${unassessed.length} ${unitsFor(unassessed.length)} che ${
                unassessed.length === 1 ? 'contiene' : 'contengono'
            } il materiale di cui parla il requisito (${names}${
                unassessed.length > 5 ? ', ...' : ''
            }).`
        )
    }
    const suggestion =
        (fileResults.find(r => r.status === status && r.suggestion) || {}).suggestion || ''
    // overleaf-lab: "n.a." because nothing applied and "n.a." because nothing answered
    // are the same word and opposite facts. The flag says which, without touching any
    // tally: a requirement nobody could answer must be findable in the history.
    const modelFailure =
        status === 'na' && fileResults.length > 0 && fileResults.every(r => r.modelFailure)
    return {
        requirement,
        status,
        evidence: clip(evidence, EVIDENCE_MAX_CHARS),
        suggestion: clip(suggestion, SUGGESTION_MAX_CHARS),
        ...(modelFailure ? { modelFailure: true } : {}),
    }
}

// overleaf-lab: read a braced LaTeX argument starting at the opening brace, counting
// nesting so a title containing a group ("Il modello \textbf{ridotto}") is not cut at
// the first inner closing brace.
// A brace that never closes must not cost a walk to the end of the document. Without
// this cap the function is O(n) per call and O(n^2) over a file, and a student can
// write `\chapter{` a few thousand times in their own project and freeze the whole
// Node process, editor and compiles included, for every user of the instance.
// Measured before the cap: 200 KB of that took 48 seconds. No real sectioning
// argument comes anywhere near this length.
const MAX_BRACED_ARGUMENT = 4000

function readBracedArgument(text, openIndex) {
    let depth = 0
    const limit = Math.min(text.length, openIndex + MAX_BRACED_ARGUMENT)
    for (let i = openIndex; i < limit; i++) {
        const c = text[i]
        if (c === '\\') {
            i += 1
            continue
        }
        if (c === '{') {
            depth += 1
        } else if (c === '}') {
            depth -= 1
            if (depth === 0) {
                return { value: text.slice(openIndex + 1, i), end: i }
            }
        }
    }
    return { value: text.slice(openIndex + 1, limit), end: limit }
}

// overleaf-lab: a heading as a human would read it, with the markup taken out.
function plainTitle(latex) {
    return String(latex || '')
        .replace(/\\[a-zA-Z]+\s*/g, ' ')
        .replace(/[{}$\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

// overleaf-lab: put the files in READING order, which alphabetical order is not.
// `capitolo10.tex` sorts before `capitolo2.tex`, so the assembled document, the file
// numbering in the report and above all the chapter segmentation would all disagree
// with the thesis. The main file says the real order in its \input/\include list, so
// follow it depth first (an included chapter that inputs its own sections is read
// where it is included), then append whatever the main file never mentions, which is
// the honest place for an orphan file: present, and last.
// overleaf-lab: walk the inclusion graph once and report everything it tells us: the
// files the document actually pulls in, in reading order; the ones nothing pulls in;
// and whether any \input named something we could not find. That last flag is what
// makes it safe to DROP the orphans: a project left over from an older template
// carries chapters nobody compiles, and reviewing them wastes passes and reports
// defects the author cannot see in the PDF. But dropping a file that IS compiled and
// that we merely failed to resolve would mean reviewing half a thesis and calling it
// compliant, which is far worse than reviewing a dead file. So the graph is trusted
// only when every include resolved.
function partitionByInclusion(docs) {
    const byPath = new Map(docs.map(d => [d.path, d]))
    // The root is the file that holds \begin{document}, NOT the one that holds
    // \documentclass. They are usually the same file, but a template that keeps the
    // preamble in its own setup.tex breaks that assumption, and following the wrong
    // root yields no includes at all: the whole project then falls back to
    // alphabetical order, which on a real thesis put the introduction last and the
    // conclusions before it. \documentclass stays as the fallback.
    const main =
        docs.find(d => d.text.includes('\\begin{document}')) ||
        docs.find(d => d.text.includes('\\documentclass'))
    if (!main) {
        return { ordered: docs.slice(), orphans: [], complete: false }
    }
    const resolve = name => {
        const clean = String(name).trim().replace(/^\.\//, '')
        if (!clean) {
            return null
        }
        for (const candidate of [clean, `${clean}.tex`, `/${clean}`, `/${clean}.tex`]) {
            if (byPath.has(candidate)) {
                return candidate
            }
        }
        // Include paths are relative to the main file, so match on the tail.
        for (const path of byPath.keys()) {
            if (path.endsWith(`/${clean}`) || path.endsWith(`/${clean}.tex`)) {
                return path
            }
        }
        return null
    }
    const ordered = []
    const seen = new Set()
    let unresolved = 0
    const walk = path => {
        if (!path || seen.has(path) || !byPath.has(path)) {
            return
        }
        seen.add(path)
        const doc = byPath.get(path)
        ordered.push(doc)
        const include = /\\(?:input|include|subfile)\s{0,40}\{([^}]{0,400})\}/g
        let match
        while ((match = include.exec(doc.text)) !== null) {
            const target = resolve(match[1])
            if (!target) {
                // An include naming a file the project does not carry. Common and
                // harmless on its own (a commented-out chapter, a graphics path), but
                // it means the graph is incomplete, so nothing may be dropped on its
                // word.
                unresolved += 1
                continue
            }
            walk(target)
        }
    }
    walk(main.path)
    const orphans = docs
        .filter(d => !seen.has(d.path))
        .sort((a, b) => a.path.localeCompare(b.path))
    return { ordered, orphans, complete: unresolved === 0 }
}

// Reading order for the whole project, orphans last. Kept as the plain-array view
// that the segmentation and the tests use.
function orderDocsByInclusion(docs) {
    const { ordered, orphans } = partitionByInclusion(docs)
    return [...ordered, ...orphans]
}

// overleaf-lab: the front matter has no \chapter of its own, but it is text that has
// to be checked like any other, so it becomes a segment instead of being dropped.
const FRONT_MATTER_TITLE = 'Front matter (before the first chapter)'

// overleaf-lab: cut the document into chapters. A FILE IS NOT A CHAPTER: a chapter
// can span several files, several chapters can share one file, and a whole thesis is
// often a single main.tex. So the split follows \chapter, wherever it falls, and a
// chapter runs to the next one across file boundaries.
//
// INVARIANT: every character of every document ends up in exactly one segment. A
// segmentation that silently dropped the text between two chapters would turn a
// per-chapter "ok" into a claim about text nobody looked at, which is worse than no
// check at all. The test suite asserts the total length is conserved.
//
// Non-source files (a .bib above all) become segments of their own: they belong to no
// chapter, and folding them into the nearest one would ask a chapter-scoped check to
// judge a bibliography database as if it were prose.
function segmentChapters(docs) {
    const CHAPTER = /\\chapter\s{0,40}(?:\*\s{0,40})?(?:\[[^\]]{0,400}\]\s{0,40})?\{/g
    const segments = []
    let current = null
    const open = title => {
        current = { title, docs: [] }
        segments.push(current)
        return current
    }
    for (const doc of docs) {
        if (!/\.tex$/i.test(doc.path)) {
            segments.push({ title: doc.path, docs: [doc], standalone: true })
            continue
        }
        const marks = []
        CHAPTER.lastIndex = 0
        let match
        while ((match = CHAPTER.exec(doc.text)) !== null) {
            const brace = doc.text.indexOf('{', match.index)
            marks.push({
                start: match.index,
                title: plainTitle(readBracedArgument(doc.text, brace).value),
            })
        }
        if (marks.length === 0) {
            if (!current) {
                open(FRONT_MATTER_TITLE)
            }
            current.docs.push(doc)
            continue
        }
        if (marks[0].start > 0) {
            if (!current) {
                open(FRONT_MATTER_TITLE)
            }
            current.docs.push({ path: doc.path, text: doc.text.slice(0, marks[0].start) })
        }
        for (let i = 0; i < marks.length; i++) {
            const end = i + 1 < marks.length ? marks[i + 1].start : doc.text.length
            open(marks[i].title || 'Untitled chapter')
            current.docs.push({
                path: doc.path,
                text: doc.text.slice(marks[i].start, end),
            })
        }
    }
    return segments.filter(segment => segment.docs.some(d => d.text.trim()))
}

function segmentText(segment) {
    return segment.docs
        .map(d => `% ===== FILE: ${d.path} =====\n${d.text}`)
        .join('\n\n')
}

// overleaf-lab: text that is not reviewed at all.
//
// A policy, not a judgement call: acknowledgements are personal writing, not work
// being marked. Tonight a review quoted "non frega niente" and a page of
// first-person sentences out of a ringraziamenti section back at the student as
// violations of the guidelines. Reviewing them leniently is not the answer; they are
// removed from the review.
//
// GENERIC BY CONSTRUCTION, like the rest of this module: no project file name is
// hardcoded anywhere, recognition is by the SEGMENT TITLE, and the match is EXACT up
// to case and surrounding space. A chapter called "Ringraziamenti e dediche" is a
// chapter somebody wrote and stays in the review: guessing at intent here would
// silently drop text the student is being marked on, which is the worse mistake.
const UNREVIEWED_TITLE = /^\s*(ringraziamenti|acknowledge?ments?)\s*$/i
// overleaf-lab: the same courtesy prose, recognised by file name instead of by
// heading, for the one collector that must not read it (see collectCandidatePassages).
// The title exclusion above blanks acknowledgements that announce themselves with a
// \chapter*; a plain ringraziamenti.tex pulled in by \input never announces itself,
// and its first-person prose is not the document's voice: 43 of 44 benign
// first-person candidate hits measured on the corpus sat in files named like this.
const UNREVIEWED_PATH = /(?:^|\/)(?:ringraziamenti|acknowledge?ments?|dedication|dedica)[^/]*\.tex$/i

// overleaf-lab: the bookkeeping a heading carries, on the lines immediately above it.
//
// It travels with the heading when the heading is excluded, and the reason is an
// accounting one. A file whose acknowledgements open with \addcontentsline on the line
// ABOVE the \chapter* keeps that one line after the exclusion, and a file with one
// surviving line is a file the review read: the same policy exclusion then produced two
// different reports on two projects, one naming the file as not reviewed and the other
// listing it among the files scanned, with nothing in it that anybody had looked at.
//
// Only these commands, and only while they are contiguous with the heading: they are
// table-of-contents and page bookkeeping, they carry no text anyone is being marked on,
// and they mean nothing once the heading they announce is gone. Anything else above the
// heading (a \bibliography, an \input, a sentence) belongs to the document and stays,
// which is what keeps this from deleting a part of the project on the way past.
const HEADING_BOOKKEEPING_LINE =
    /^\s*\\(?:addcontentsline|phantomsection|markboth|markright|thispagestyle|pagestyle|cleardoublepage|clearpage|newpage|pagenumbering)\b[^\n]*$/

function extendToHeadingBookkeeping(text, start) {
    let from = start
    // Back to the start of the heading's own line. If the heading shares its line with
    // anything else, there is no bookkeeping line to take and the span is left alone.
    while (from > 0 && text[from - 1] !== '\n') {
        if (!/\s/.test(text[from - 1])) {
            return start
        }
        from -= 1
    }
    let cursor = from
    let extended = from
    while (cursor > 0) {
        const lineEnd = cursor - 1
        let lineStart = lineEnd
        while (lineStart > 0 && text[lineStart - 1] !== '\n') {
            lineStart -= 1
        }
        const line = text.slice(lineStart, lineEnd)
        if (HEADING_BOOKKEEPING_LINE.test(line)) {
            extended = lineStart
            cursor = lineStart
            continue
        }
        // A blank line between two bookkeeping lines is walked over, but on its own it
        // never extends the span: the excluded text must not grow past the last line
        // that actually belongs to the heading.
        if (line.trim() === '') {
            cursor = lineStart
            continue
        }
        break
    }
    return extended
}

function excludeUnreviewedSegments(docs) {
    const segments = segmentChapters(docs)
    const dropped = new Set(segments.filter(s => UNREVIEWED_TITLE.test(String(s.title || ''))))
    if (dropped.size === 0) {
        return { docs, segments, files: [] }
    }
    // Where each dropped segment sits inside its own file. Segments carry SLICES and
    // not offsets, so each piece is located by walking its file forward with a
    // cursor: the pieces of one file appear in reading order, so every piece is found
    // once and an identical passage earlier in the file is never mistaken for it.
    const byPath = new Map(docs.map(doc => [doc.path, doc]))
    const cursors = new Map()
    const ranges = new Map()
    for (const segment of segments) {
        for (const piece of segment.docs) {
            const doc = byPath.get(piece.path)
            if (!doc) continue
            const at = doc.text.indexOf(piece.text, cursors.get(piece.path) || 0)
            if (at === -1) continue
            cursors.set(piece.path, at + piece.text.length)
            if (!dropped.has(segment)) continue
            // ONLY the piece the heading is in. A segment is not a file: segment
            // Chapters appends every FOLLOWING chapterless .tex to whatever segment is
            // open, so a bibliografia.tex or a simboli.tex that comes after
            // ringraziamenti.tex in \input order was part of the "Ringraziamenti"
            // segment - and this exclusion blanked it, dropped it from the review and
            // told the student "acknowledgements are not reviewed" about their own
            // bibliography. It then flipped has-bibliography to missing (add a
            // \bibliography that is already there, in a file the review had deleted)
            // and could stop the rubric's Document type pattern from matching at all.
            //
            // docs[0] is always the slice that starts at the \chapter{Ringraziamenti}
            // mark, and segmentChapters already cuts it at the next heading or at the
            // end of that file. Bounding the excluded span to it is therefore exactly
            // "the text that belongs to this heading", and never text a different file
            // contributed.
            if (piece !== segment.docs[0]) continue
            if (!ranges.has(piece.path)) {
                ranges.set(piece.path, [])
            }
            // With the heading's own bookkeeping, so what is left of the file is what
            // the review really reads (see HEADING_BOOKKEEPING_LINE). The cursor above
            // is deliberately NOT moved back: it tracks where the next piece of this
            // file starts, and the bookkeeping was already walked past.
            ranges.get(piece.path).push([
                extendToHeadingBookkeeping(doc.text, at),
                at + piece.text.length,
            ])
        }
    }
    // BLANKED, never cut: every character that is not a newline becomes a space, so
    // every offset and every line number in the REST of the file is still the offset
    // and the line of the real source, and the segmentation invariant (every
    // character belongs to exactly one segment) is preserved by construction.
    const files = []
    const kept = []
    for (const doc of docs) {
        const spans = ranges.get(doc.path)
        if (!spans) {
            kept.push(doc)
            continue
        }
        // ONE rebuild for all the spans of a file, not one per span. The per-span form
        // copies the whole file every time, so the cost is quadratic in the number of
        // excluded chapters - and the student decides that number by writing
        // \chapter{Ringraziamenti} as many times as they like: 1 MB measured 19 s of
        // synchronous CPU, which on Node's single thread is the whole instance.
        const text = blankSpans(doc.text, spans)
        // A file that was nothing BUT acknowledgements was not "read and found
        // empty": it is a file the review did not look at, and the report has to name
        // it as such instead of listing it among the files it read.
        if (text.trim().length === 0) {
            files.push(doc.path)
            continue
        }
        kept.push({ path: doc.path, text })
    }
    // Re-segmented on the blanked text, so the excluded chapter is not in the pass
    // plan at all and the planned pass count still matches what actually runs.
    return { docs: kept, segments: segmentChapters(kept), files }
}

// How much of each chapter's opening travels with the outline. Enough that "the
// introduction states the aims and the structure" and "the report opens by describing
// the hosting institution" are answerable, which a bare list of titles cannot do.
// overleaf-lab: raised from 800. A [structure] requirement sees only the skeleton, and
// several of them ask about the CONTENT of one part: whether the introduction states
// the aims, whether the conclusions carry limitations, whether the opening names the
// hosting institution and describes its work. Eight hundred characters is a paragraph,
// often the throat-clearing one, so those requirements were answered on too little:
// one came back n.a. saying in as many words that the text had not been provided, and
// the others were answered from the headings. Two thousand is still bounded and still
// the same size whatever the document's length, which is the property that makes a
// 200-page thesis reviewable for these requirements at all.
const SKELETON_HEAD_CHARS = 2000
const SKELETON_MAX_CHARS = 24000

// overleaf-lab: the document seen from above. Headings, which parts exist, how big
// each chapter is and how each one opens, for the requirements that ask whether the
// document is ORGANISED correctly rather than written correctly.
//
// This is what makes a 200-page thesis reviewable at all for those requirements: the
// skeleton of a long thesis is about the same size as the skeleton of a short one,
// while the text is not. The opening lines of each chapter are included because
// "the introduction states the objectives" is a question about how a chapter starts,
// and a bare list of titles cannot answer it.
function buildSkeleton(docs, segments) {
    const all = docs.map(d => d.text).join('\n')
    const has = re => (re.test(all) ? 'yes' : 'no')
    const lines = []
    lines.push('DOCUMENT SKELETON. This is the structure of the project, not its full')
    lines.push('text: headings, which parts exist, the size of each chapter and how each')
    lines.push('one opens. Judge only what is visible here, and answer "na" for anything')
    lines.push('that would need the body text.')
    lines.push('')
    lines.push('PARTS PRESENT:')
    lines.push(`- abstract: ${has(/\\begin\{abstract\}|\\abstract\b|\\chapter\*?\s*\{\s*(?:abstract|sommario)/i)}`)
    lines.push(`- table of contents: ${has(/\\tableofcontents/)}`)
    lines.push(`- list of figures: ${has(/\\listoffigures/)}`)
    lines.push(`- list of tables: ${has(/\\listoftables/)}`)
    lines.push(`- appendix: ${has(/\\appendix\b/)}`)
    lines.push(`- bibliography: ${has(/\\bibliography\b|\\printbibliography|\\begin\{thebibliography\}|\\addbibresource/)}`)
    lines.push(`- glossary or acronym list: ${has(/\\printglossar|\\printacronyms|\\begin\{acronym\}|\\newacronym/)}`)
    lines.push(`- index: ${has(/\\printindex/)}`)
    lines.push('')
    lines.push(`OUTLINE (${segments.length} segments, in reading order):`)

    for (const [index, segment] of segments.entries()) {
        const text = segment.docs.map(d => d.text).join('\n')
        const words = (text.match(/\S+/g) || []).length
        const countOf = re => (text.match(re) || []).length
        const paths = [...new Set(segment.docs.map(d => d.path))].join(', ')
        lines.push('')
        lines.push(
            `## ${index + 1}. ${segment.title}  [${paths}]  ${words} words, ` +
                `${countOf(/\\begin\{figure/g)} figures, ${countOf(/\\begin\{(?:table|longtable)/g)} tables, ` +
                `${countOf(/\\begin\{(?:equation|align|gather|multline|flalign)/g)} equations, ` +
                `${countOf(/\\cite[a-zA-Z]*\s*[[{]/g)} citations`
        )
        const heading = /\\(section|subsection|subsubsection)\s{0,40}(?:\*\s{0,40})?(?:\[[^\]]{0,400}\]\s{0,40})?\{/g
        let match
        while ((match = heading.exec(text)) !== null) {
            const brace = text.indexOf('{', match.index)
            const title = plainTitle(readBracedArgument(text, brace).value)
            const indent = match[1] === 'section' ? '   - ' : match[1] === 'subsection' ? '     - ' : '       - '
            lines.push(`${indent}${title}`)
        }
        // The opening of the chapter, with the heading command itself removed so the
        // sample is prose rather than markup.
        const body = text
            .replace(/\\chapter\s{0,40}(?:\*\s{0,40})?(?:\[[^\]]{0,400}\]\s{0,40})?\{[^}]{0,400}\}/, '')
            .replace(/\s+/g, ' ')
            .trim()
        if (body) {
            lines.push(`   opens with: "${body.slice(0, SKELETON_HEAD_CHARS)}${body.length > SKELETON_HEAD_CHARS ? '...' : ''}"`)
        }
    }
    const outline = lines.join('\n')
    if (outline.length <= SKELETON_MAX_CHARS) {
        return outline
    }
    // overleaf-lab: a clipped outline still carries a header promising N segments, and
    // clip() ends it with a bare "...". A reader (model or human) then answers about
    // parts of the document that are simply not on the page as though they were absent.
    // The cut is said out loud, and where it fell.
    const kept = clip(outline, SKELETON_MAX_CHARS)
    const shown = (kept.match(/^## \d+\./gm) || []).length
    return `${kept}\n[outline truncated after segment ${shown} of ${segments.length}: the rest is not shown here, so it cannot be judged from this outline]`
}

// overleaf-lab: how many requirements share one chapter pass.
//
// Without grouping the arithmetic does not work: 20 chapter-scoped requirements over
// 10 segments is 200 model calls, three times today's whole review, and the feature
// would cost more than it saves. Grouped five at a time it is 40, and since the pass
// prompts of one chapter share their prefix in the backend cache, the total prefill
// stays about one read of the project, exactly as it is today.
//
// Consecutive requirements are grouped, never reordered, because a rubric is already
// written in thematic order (all the figure rules together, then the units, then the
// language): following that order gives coherent bundles for free, and a bundle the
// author can predict by reading their own rubric top to bottom.
const PER_CHAPTER_GROUP_SIZE = 5

// overleaf-lab: self-consistency for the model-judged chapter passes. Verdicts at the
// boundary flip between identical runs (measured: 12% of model-judged requirements,
// matching the published base rate for LLM judges), and temperature 0 does not buy
// determinism on a batching backend; the Qwen3 model cards even forbid greedy
// decoding in non-thinking mode. So each per-chapter call is sampled twice at the
// sampling the model card prescribes; if any requirement in the group disagrees, one
// third sample breaks the tie per requirement, majority wins. Published measurements
// put 3-sample consensus at ~90% of the 50-sample truth, against 86.6% for one shot.
// Costs roughly one extra model call per chapter group; set to 1 to switch it off
// (calls then go back to temperature 0).
const CHAPTER_VOTE_SAMPLES = 2
const VOTE_TEMPERATURE = 0.7
const VOTE_TOP_P = 0.8

// overleaf-lab: the share of a chapter a file must carry to be named as its home.
// A chapter ends at the next \chapter, which is usually a few characters into the
// next file, and those few characters must not make that file look responsible for
// the chapter's findings.
const CHAPTER_FILE_SHARE = 0.15

// overleaf-lab: THE TWO MODES A REVIEW RUNS IN.
//
// 'full' is what this file has always done: every requirement, the model-judged ones
// included, minutes of GPU per thesis. 'fast' runs ONLY what this process can decide
// on its own - the [check: ...] requirements, which are parsers - and answers in
// seconds without touching a model backend at all.
//
// The point of the second one is not speed for its own sake. A student fixing
// captions wants to know whether the captions are fixed, and today that question
// costs a queue slot, a GPU and twenty minutes; and an instance with no model backend
// configured (which is every clone of this repository) could not run a review at all.
// A mode string on the job is what buys both, without a second engine to keep in step
// with this one: the planner filters, everything downstream is unchanged.
//
// Unknown values collapse to 'full' on purpose. The mode arrives in a request body,
// and the failure mode of a typo must be "you got the review you always got", never
// "your requirements were silently not checked".
function normalizeReviewMode(mode) {
    return mode === 'fast' ? 'fast' : 'full'
}

// overleaf-lab: turn the requirement list into the passes the review will actually
// run, before running any of them. Two reasons it is computed up front and as a pure
// function: the progress bar can announce an honest total from the first second, and
// the arithmetic that decides whether this review is affordable can be unit tested
// without a model behind it.
function buildPassPlan(requirements, { fileCount = 1, segmentCount = 1, mode = 'full' } = {}) {
    const scopes = requirements.map(requirementScope)

    // overleaf-lab: THE FAST-MODE FILTER, and it is the whole of fast mode. A step
    // that would reach a model is not planned; it is planned as 'model-only', which
    // the run turns into an honest n.a. row instead of dropping it.
    //
    // Three things it deliberately does NOT do. It does not group the chapter
    // requirements: a group is one shared model call over several requirements, and
    // with no call to share, grouping would merge rows the reader needs one by one. It
    // does not plan a single pass (every step costs 0), because nothing here is sent
    // anywhere and a progress bar counting model calls must not count these. And it
    // does not reorder anything: the report still reads in rubric order, so the two
    // modes produce the same list of requirements in the same sequence, with the
    // model-side ones marked as not looked at.
    if (normalizeReviewMode(mode) === 'fast') {
        return requirements.map((_, i) => ({
            scope: scopes[i] === 'code' ? 'code' : 'model-only',
            indexes: [i],
            passes: 0,
        }))
    }

    // Chapter requirements are grouped in rubric order but ACROSS the requirements of
    // other scopes that sit between them. Grouping only strictly consecutive ones
    // looks tidier and costs a fortune: on a real rubric the chapter requirements are
    // interrupted here and there by a global or a structural one, and every
    // interruption starts a new group. Twenty-three chapter requirements over twelve
    // chapters came to eight groups and ninety-six passes that way, against five
    // groups and sixty when the interruptions are stepped over.
    const chapterIndexes =
        segmentCount > 1 ? requirements.map((_, i) => i).filter(i => scopes[i] === 'chapter') : []
    const groupHead = new Map()
    const grouped = new Set(chapterIndexes)
    for (let g = 0; g < chapterIndexes.length; g += PER_CHAPTER_GROUP_SIZE) {
        const indexes = chapterIndexes.slice(g, g + PER_CHAPTER_GROUP_SIZE)
        groupHead.set(indexes[0], indexes)
    }

    const steps = []
    for (let i = 0; i < requirements.length; i++) {
        // A group is emitted where its FIRST requirement sits, so the report still
        // reads roughly in rubric order.
        if (groupHead.has(i)) {
            steps.push({ scope: 'chapter', indexes: groupHead.get(i), passes: segmentCount })
            continue
        }
        if (grouped.has(i)) {
            continue
        }
        // A single segment means the split has nothing to split: fall back to the
        // whole-document pass rather than dressing it up as a chapter pass.
        // Costs zero passes: it is a regex sweep, not a model call.
        if (scopes[i] === 'code') {
            steps.push({ scope: 'code', indexes: [i], passes: 0 })
        } else if (scopes[i] === 'candidates') {
            // One announced pass however many batched calls the candidates need:
            // the count is unknown until the pattern has run over the sources.
            steps.push({ scope: 'candidates', indexes: [i], passes: 1 })
        } else if (scopes[i] === 'file' && fileCount > 1) {
            steps.push({ scope: 'file', indexes: [i], passes: fileCount })
        } else if (scopes[i] === 'structure') {
            steps.push({ scope: 'structure', indexes: [i], passes: 1 })
        } else {
            steps.push({ scope: 'document', indexes: [i], passes: 1 })
        }
    }
    return steps
}

function countPlannedPasses(plan) {
    return plan.reduce((n, step) => n + step.passes, 0)
}

// overleaf-lab: how many requirements a fast plan actually decides, and how many it
// was handed. The banner in the report is built from these two numbers, so they are
// counted from the PLAN rather than from the items: counting the items would count
// what came back, and "3 of 30 checked" has to be true even when a check crashes.
function countCheckedRequirements(plan) {
    return plan.reduce((n, step) => n + (step.scope === 'code' ? step.indexes.length : 0), 0)
}

// overleaf-lab: what a fast review says about a requirement it did not look at.
//
// THE ONE RULE OF THIS FUNCTION: it is an n.a. and it says why. A fast review is
// offered next to a full one, so the temptation is to let the untouched requirements
// disappear from the report and show a short clean list - which reads exactly like a
// document with fewer requirements against it, and would make "no findings" mean two
// different things depending on a button the reader never saw pressed. Every
// requirement therefore keeps its row, marked n.a. with the reason in the student's
// language, and the delta refuses to compare a fast run with a full one (see the
// store) so this n.a. can never be reported as a requirement that got fixed.
function notCheckedInFastMode(requirement) {
    return {
        requirement,
        status: 'na',
        evidence: L(
            'Not checked in fast mode: run a full review for this requirement.',
            'Non controllato in modalità rapida: per questo requisito serve una review completa.'
        ),
        suggestion: '',
    }
}

// overleaf-lab: split the rubric guidelines into individually checkable requirements,
// one model pass each. Rule (documented in the admin UI): one requirement per numbered
// line ("1.", "2)", ...); continuation lines belong to the requirement above; text
// before the first numbered line is a preamble repeated in every pass as context.
// Bulleted lines ("-", "*", "•") split too, but only when there are no numbered lines,
// so sub-bullets inside numbered requirements do not fragment them. A rubric with no
// recognizable structure degrades gracefully to today's single pass over the whole
// text, never to an arbitrary split.
function splitRubric(text) {
    const raw = String(text || '')
    const NUMBERED = /^\s*\d{1,3}[.)]\s+/
    const BULLET = /^\s*[-*•]\s+/
    const lines = raw.split('\n')
    const numberedCount = lines.filter(l => NUMBERED.test(l)).length
    // One numbered line is still a numbered rubric. Requiring two demoted that lone
    // requirement into the preamble and split the bullets under it instead, so the
    // only thing the author actually numbered never got a verdict.
    const marker = numberedCount >= 1 ? NUMBERED : BULLET
    const requirements = []
    const preambleLines = []
    let current = null
    for (const line of lines) {
        if (marker.test(line)) {
            if (current) {
                requirements.push(current.join('\n').trim())
            }
            current = [line.trim()]
        } else if (current) {
            current.push(line)
        } else {
            preambleLines.push(line)
        }
    }
    if (current) {
        requirements.push(current.join('\n').trim())
    }
    if (requirements.length < 2) {
        return { preamble: '', requirements: [raw.trim()] }
    }
    return { preamble: preambleLines.join('\n').trim(), requirements }
}

// overleaf-lab: the compliance reviewer system prompt now lives in LLMPrompts.mjs as
// DEFAULT_REVIEW_SYSTEM_PROMPT and is resolved per review via getLLMPrompts() so a
// super-admin override takes effect. See performReview below.

// overleaf-lab: remove <think>...</think> blocks (case-insensitive, dot-all), same
// approach as LLMChatController, for models like DeepSeek/Qwen that emit reasoning.
function stripThinkTags(text) {
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    cleaned = cleaned.replace(/<think>[\s\S]*/gi, '')
    return cleaned.trim()
}

// overleaf-lab: strip LaTeX line comments to save tokens. For each line, cut from
// the first unescaped `%` (a `%` not preceded by a backslash) to end of line, while
// keeping escaped `\%`. This is simple and conservative: it can over-strip inside
// verbatim environments, which is acceptable for a compliance review that only
// needs the prose/content, not byte-exact source.
function stripLatexComments(text) {
    return text
        .split('\n')
        .map(line => {
            let result = ''
            for (let i = 0; i < line.length; i++) {
                const ch = line[i]
                if (ch === '%') {
                    // An escaped "%" is one preceded by an ODD number of backslashes.
                    // Testing only the previous character treats "\\%" (a LaTeX line
                    // break followed by a real comment) as escaped, leaving comment
                    // text in the prompt and letting the scans "find" candidates
                    // inside it.
                    let backslashes = 0
                    for (let k = i - 1; k >= 0 && line[k] === '\\'; k--) {
                        backslashes += 1
                    }
                    if (backslashes % 2 === 0) {
                        break
                    }
                }
                result += ch
            }
            return result
        })
        .join('\n')
}

// overleaf-lab: characters per token for the FALLBACK size estimate, used only when the
// backend has no /tokenize (countPromptTokens is the normal path and is exact). The
// usual "4 chars per token" rule is calibrated on English prose; measured on a real
// LaTeX thesis the ratio was about 3.4, so 4 is optimistic. We use a slightly
// conservative 3.0: close enough not to refuse documents that would fit, low enough to
// still catch a gross overflow. An earlier 2.5 was too pessimistic and blocked a
// document that actually fitted, which is the worse failure since nothing downstream
// can correct a false refusal.
const REVIEW_CHARS_PER_TOKEN =
    Number.parseFloat(process.env.LLM_REVIEW_CHARS_PER_TOKEN) > 0
        ? Number.parseFloat(process.env.LLM_REVIEW_CHARS_PER_TOKEN)
        : 3.0

// overleaf-lab: rough token estimate used only to keep a single-pass review within
// the configured context window (and to size the progress estimate).
function estimateTokens(text) {
    return Math.ceil(String(text || '').length / REVIEW_CHARS_PER_TOKEN)
}

// overleaf-lab: text-like project FILES worth reviewing. Overleaf splits a project
// into "docs" (the editable text ones) and "files" (everything uploaded or linked,
// stored in the file store). A .bib is normally a doc, but it becomes a FILE as soon
// as it is uploaded, imported from a zip, or kept in sync by an external source such
// as a Zotero link, and then getAllDocs cannot see it.
//
// That gap is silent and expensive: a review whose bibliography is missing still
// gets asked "does the bibliography have complete entries" and "is Wikipedia cited",
// and a model asked about text it cannot see tends to answer about text it imagines
// (observed: an item claiming "scanned all entries in references.bib" for a file
// that was never in the prompt).
const TEXTUAL_FILE_EXTENSION = /\.(bib|tex|cls|sty|bst|txt|md)$/i
// A linked text file is small; anything large is not what we are looking for and
// must not be pulled into memory or into the prompt.
const MAX_LINKED_FILE_BYTES = 2 * 1024 * 1024
// overleaf-lab: and the reader as a whole is budgeted the way the figure measurer
// is. The per-file cap bounds one file; nothing bounded how many files, how many
// bytes in total, or for how long a project full of 2 MB .txt uploads could keep a
// review thread fetching. The numbers mirror the image budgets, scaled to text.
const TEXT_FETCH_MAX_FILES = 100
const TEXT_FETCH_MAX_TOTAL_BYTES = 20 * 1024 * 1024
const TEXT_FETCH_TIME_BUDGET_MS = 60 * 1000

// overleaf-lab: failure reasons cross into the report, the archive and the prompt,
// and a fetch error names the URL it failed against, which for these readers is an
// internal service address (filestore, history, docstore). Those addresses are a map
// of the deployment and belong in the server log, where the operator who needs them
// reads them, and nowhere a student or a prompt can see. The log keeps the unscrubbed
// string; everything stored gets this.
const scrubUrls = text =>
    String(text || '').replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"')\]]+/gi, '[internal url]')

// overleaf-lab: read a file's bytes with a hard size cap. Shared by the text reader
// below and the figure measurer: one reader, so the failure strings and the cap
// behaviour cannot drift apart between the two callers.
//
// The cap is enforced BEFORE the bytes are in memory, not after. Reading the whole
// body and measuring it afterwards makes the cap a statement about what we keep rather
// than about what we spend: a single stored file larger than the limit was buffered in
// full, inside the review process, whatever the limit said. Content-Length is trusted
// only to refuse early (a wrong one costs nothing, since the reader below counts the
// bytes it actually receives), and the transfer is cancelled the moment the count
// crosses the cap.
const readProjectFileBytes = async (url, headers, maxBytes, jobSignal) =>
    // The whole read runs as the consume step, INSIDE fetchWithLimit's armed
    // window: the byte-counting loop below is exactly the kind of body read
    // that used to run with the timer already cancelled. The jobSignal makes a
    // user cancel stop an in-flight image download instead of only being
    // noticed after it.
    fetchWithLimit(url, { headers }, AUX_FETCH_TIMEOUT_MS, jobSignal, async response => {
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
        }
        const declared = Number.parseInt(response.headers && response.headers.get('content-length'), 10)
        if (Number.isFinite(declared) && declared > maxBytes) {
            throw new Error('file too large')
        }
        const body = response.body
        if (!body || typeof body.getReader !== 'function') {
            // No stream (a mocked or already-buffered response): the cap is still a cap.
            const buffer = Buffer.from(await response.arrayBuffer())
            if (buffer.length > maxBytes) {
                throw new Error('file too large')
            }
            return buffer
        }
        const reader = body.getReader()
        const chunks = []
        let read = 0
        let tooLarge = false
        try {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) {
                    break
                }
                read += value.byteLength || value.length || 0
                if (read > maxBytes) {
                    tooLarge = true
                    break
                }
                chunks.push(Buffer.from(value))
            }
        } finally {
            try {
                await reader.cancel()
            } catch (err) {
                // The body may already be closed; nothing to do about it.
            }
        }
        if (tooLarge) {
            throw new Error('file too large')
        }
        return Buffer.concat(chunks)
    })

// overleaf-lab: the ladder of ways to read a project file's content. Overleaf stores
// file content in the filestore service on older releases and in the history blob
// store on newer ones (on CE 6.2 the filestore answers 404 and the blob store has
// it), so both are tried IN ORDER for each file and a 404 from one falls through to
// the next. When every attempt fails the caller names each one WITH THE URL it
// tried: tracing a bare "HTTP 404" back to a doubled path segment cost several
// deploy cycles, and the fix for that is to make the report say where it looked.
//
// Deliberately NOT tried: FileStoreHandler's own read functions. On CE 6.2 that
// module exposes uploads only, and on the releases where it does read, the
// filestore HTTP path below works anyway; keeping a third, never-exercised code
// path in a vendored module is cost without coverage.
// Returns { strategies, filestoreUrl, historyUrl }; strategies read Buffers.
async function buildFileReadStrategies(projectId, maxBytes, jobSignal) {
    const strategies = []

    const filestoreUrl =
        Settings.apis && Settings.apis.filestore && Settings.apis.filestore.url
    if (filestoreUrl) {
        const fileUrl = ref =>
            `${filestoreUrl.replace(/\/+$/, '')}/project/${projectId}/file/${ref._id}`
        strategies.push({
            name: 'filestore service',
            url: fileUrl,
            read: ref => readProjectFileBytes(fileUrl(ref), undefined, maxBytes, jobSignal),
        })
    }

    // Only v1_history serves blobs. project_history is a different service (it tracks
    // history operations) and answering it with a blob request yields a 404 that looks
    // exactly like "the file is not here", so it must not be used as a fallback.
    const historyApi = (Settings.apis && Settings.apis.v1_history) || null
    if (historyApi && historyApi.url) {
        let historyId = null
        try {
            const imported = await import(
                '../../../../app/src/Features/Project/ProjectGetter.mjs'
            )
            const ProjectGetter = imported.default || imported
            const project = await ProjectGetter.promises.getProject(projectId, {
                overleaf: 1,
            })
            historyId = project?.overleaf?.history?.id
        } catch (err) {
            logger.debug({ projectId, err }, '[LLM] compliance: no project history id')
        }
        if (historyId) {
            const headers = {}
            if (historyApi.user) {
                headers.Authorization = `Basic ${Buffer.from(
                    `${historyApi.user}:${historyApi.pass || ''}`
                ).toString('base64')}`
            }
            // The configured URL may or may not already end in /api (on CE 6.2 it
            // does: http://sharelatex:3100/api). Appending it unconditionally asked
            // for /api/api/... and got a 404 that read exactly like "no such file".
            const base = historyApi.url.replace(/\/+$/, '')
            const apiBase = /\/api$/.test(base) ? base : `${base}/api`
            const blobUrl = ref =>
                `${apiBase}/projects/${historyId}/blobs/${ref.hash}`
            strategies.push({
                name: 'history blob store',
                url: blobUrl,
                read: ref => {
                    if (!ref.hash) {
                        throw new Error('file has no history hash')
                    }
                    return readProjectFileBytes(blobUrl(ref), headers, maxBytes, jobSignal)
                },
            })
        }
    }

    return { strategies, filestoreUrl, historyUrl: historyApi && historyApi.url }
}

// overleaf-lab: read the text-like files of a project. Fully defensive: the file
// store API is Overleaf's, not ours, so every step degrades to "skipped" instead of
// failing the review.
//
// Each skipped file carries the REASON it was skipped, and the reason travels into
// the report next to the file name. Sending an admin to the container logs to find
// out why a file is missing assumes those logs are readable and kept, which is not
// something a review can rely on; the failure belongs where the symptom is.
// Returns { files: [{path, text}], skipped: [{path, reason}] }.
async function readTextualProjectFiles(projectId) {
    const result = { files: [], skipped: [] }
    let filesByPath
    try {
        filesByPath = await ProjectEntityHandler.promises.getAllFiles(projectId)
    } catch (err) {
        logger.warn({ projectId, err }, '[LLM] compliance: cannot list project files')
        return result
    }

    const candidates = Object.entries(filesByPath || {}).filter(([filePath, ref]) => {
        if (!ref || !ref._id || !TEXTUAL_FILE_EXTENSION.test(filePath)) {
            return false
        }
        return !(typeof ref.size === 'number' && ref.size > MAX_LINKED_FILE_BYTES)
    })
    if (candidates.length === 0) {
        return result
    }

    // overleaf-lab: the strategy ladder is shared with the figure measurer; only the
    // byte cap and what happens to the bytes differ between the two callers.
    const { strategies, filestoreUrl, historyUrl } = await buildFileReadStrategies(
        projectId,
        MAX_LINKED_FILE_BYTES
    )

    if (strategies.length === 0) {
        // The report says what happened; the log says where. The URLs are internal
        // addresses and stay out of everything that is stored or prompted.
        logger.warn(
            { projectId, filestoreUrl: filestoreUrl || 'not configured', historyUrl: historyUrl || 'not configured' },
            '[LLM] compliance: no file read strategy'
        )
        const reason = `no way to read project files (filestore ${
            filestoreUrl ? 'configured' : 'not configured'
        }; history ${historyUrl ? 'configured' : 'not configured'})`
        result.skipped = candidates.map(([filePath]) => ({ path: filePath, reason }))
        return result
    }

    const started = Date.now()
    let fetched = 0
    let totalBytes = 0
    for (const [filePath, ref] of candidates) {
        if (fetched >= TEXT_FETCH_MAX_FILES) {
            result.skipped.push({
                path: filePath,
                reason: `more than ${TEXT_FETCH_MAX_FILES} linked text files; the rest were not read`,
            })
            continue
        }
        if (totalBytes >= TEXT_FETCH_MAX_TOTAL_BYTES) {
            result.skipped.push({ path: filePath, reason: 'the review text byte budget was spent' })
            continue
        }
        if (Date.now() - started > TEXT_FETCH_TIME_BUDGET_MS) {
            result.skipped.push({ path: filePath, reason: 'the review text time budget was spent' })
            continue
        }
        const failures = []
        let text = null
        for (const strategy of strategies) {
            try {
                const bytes = await strategy.read(ref)
                fetched += 1
                totalBytes += bytes.length
                text = bytes.toString('utf8')
                break
            } catch (err) {
                // Name the URL that failed, not just the error: a bare "HTTP 404"
                // cost several deploy cycles to trace back to a doubled path
                // segment in the base URL. The URL goes to the LOG below; the
                // stored reason is scrubbed, because it travels into the report,
                // the archive and the prompt, none of which may learn the
                // addresses of internal services.
                const where = strategy.url ? ` at ${strategy.url(ref)}` : ''
                failures.push(`${strategy.name}${where}: ${err.message}`)
            }
        }
        if (text && text.trim()) {
            result.files.push({ path: filePath, text })
            continue
        }
        const reason = text
            ? 'file is empty'
            : `${failures.join('; ')}${ref.hash ? '' : '; file has no hash'}`
        logger.warn({ projectId, filePath, reason }, '[LLM] compliance: file unreadable')
        result.skipped.push({ path: filePath, reason: scrubUrls(reason) })
    }
    return result
}

// overleaf-lab: measure the effective resolution of the raster figures. Async
// because the bytes live in the file store, so it runs BEFORE buildScanHints and
// its result is passed in. Every failure inside is a row with a reason or a null
// block, never a thrown error: the figures are one fact among twenty, and losing a
// review over a corrupt GIF is not a trade anyone would make. The bytes never enter
// the prompt and no buffer survives its own measurement.
const IMAGE_FETCH_MAX_IMAGES = 200
const IMAGE_FETCH_MAX_TOTAL_BYTES = 60 * 1024 * 1024
const IMAGE_FETCH_TIME_BUDGET_MS = 60 * 1000
// The order graphicx tries extensions under pdflatex when the LaTeX path has none.
const GRAPHICS_EXTENSION_ORDER = ['.pdf', '.png', '.jpg', '.jpeg', '.eps']

function graphicsPathPrefixes(strippedDocs) {
    const prefixes = []
    for (const doc of strippedDocs) {
        for (const m of doc.text.matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}/g)) {
            for (const inner of m[1].matchAll(/\{([^{}]*)\}/g)) {
                const prefix = inner[1].trim()
                if (prefix) {
                    prefixes.push(prefix)
                }
            }
        }
    }
    return prefixes
}

// Case-insensitive on purpose: Overleaf paths are case sensitive but students are
// not, and "not found" for a figure that compiles is the failure that gets filed
// as a bug against the review.
const normalizeGraphicsPath = p =>
    String(p || '')
        .replace(/^\.\//, '')
        .replace(/\/{2,}/g, '/')
        .replace(/^\/+/, '')
        .toLowerCase()

async function measureProjectFigures(projectId, strippedDocs, jobSignal) {
    try {
        const { figures } = findIncludeGraphics(strippedDocs)
        if (!figures.length) {
            return null
        }
        let filesByPath
        try {
            filesByPath = await ProjectEntityHandler.promises.getAllFiles(projectId)
        } catch (err) {
            logger.warn({ projectId, err }, '[LLM] compliance: cannot list files for figures')
            return null
        }
        const byNormalized = new Map()
        const byBasename = new Map()
        for (const [filePath, ref] of Object.entries(filesByPath || {})) {
            if (!ref || !ref._id) continue
            const norm = normalizeGraphicsPath(filePath)
            byNormalized.set(norm, { path: filePath, ref })
            const base = norm.slice(norm.lastIndexOf('/') + 1)
            if (!byBasename.has(base)) byBasename.set(base, [])
            byBasename.get(base).push({ path: filePath, ref })
        }
        const prefixes = graphicsPathPrefixes(strippedDocs)
        const resolveGraphics = latexPath => {
            const raw = normalizeGraphicsPath(latexPath)
            const hasExtension = /\.[a-z0-9]+$/.test(raw)
            const variants = hasExtension
                ? [raw]
                : [raw, ...GRAPHICS_EXTENSION_ORDER.map(ext => raw + ext)]
            for (const variant of variants) {
                const direct = byNormalized.get(variant)
                if (direct) return { hit: direct }
                for (const prefix of prefixes) {
                    const prefixed = byNormalized.get(normalizeGraphicsPath(prefix + variant))
                    if (prefixed) return { hit: prefixed }
                }
            }
            // Last resort: basename alone. Two files with that name is an honest
            // refusal, never a guess.
            const base = raw.slice(raw.lastIndexOf('/') + 1)
            const names = hasExtension
                ? [base]
                : [base, ...GRAPHICS_EXTENSION_ORDER.map(ext => base + ext)]
            for (const name of names) {
                const hits = byBasename.get(name) || []
                if (hits.length === 1) return { hit: hits[0] }
                if (hits.length > 1) return { ambiguous: hits.length }
            }
            return {}
        }

        const entries = []
        const wanted = new Map()
        for (const fig of figures) {
            const resolved = resolveGraphics(fig.path)
            if (resolved.ambiguous) {
                entries.push({
                    ...fig,
                    unknown: true,
                    reason: `${resolved.ambiguous} files in the project share this name; none was picked`,
                })
                continue
            }
            if (!resolved.hit) {
                entries.push({ ...fig, unknown: true, reason: 'no file in the project matches this path' })
                continue
            }
            const kind = classifyGraphicsPath(resolved.hit.path)
            if (kind === 'vector') {
                entries.push({ ...fig, vector: true })
                continue
            }
            if (kind !== 'raster') {
                entries.push({ ...fig, unknown: true, reason: 'the file extension is not one this module reads' })
                continue
            }
            entries.push({ ...fig, resolved: resolved.hit.path })
            if (!wanted.has(resolved.hit.path)) {
                wanted.set(resolved.hit.path, resolved.hit.ref)
            }
        }

        const measured = new Map()
        if (wanted.size > 0) {
            const { strategies } = await buildFileReadStrategies(projectId, MAX_IMAGE_BYTES, jobSignal)
            const started = Date.now()
            let fetched = 0
            let totalBytes = 0
            for (const [resolvedPath, ref] of wanted) {
                if (strategies.length === 0) {
                    measured.set(resolvedPath, { unknown: true, reason: 'no way to read project files' })
                    continue
                }
                if (fetched >= IMAGE_FETCH_MAX_IMAGES) {
                    measured.set(resolvedPath, {
                        unknown: true,
                        reason: `more than ${IMAGE_FETCH_MAX_IMAGES} figures; the rest were not fetched`,
                    })
                    continue
                }
                if (totalBytes >= IMAGE_FETCH_MAX_TOTAL_BYTES) {
                    measured.set(resolvedPath, { unknown: true, reason: 'the review image byte budget was spent' })
                    continue
                }
                if (Date.now() - started > IMAGE_FETCH_TIME_BUDGET_MS) {
                    measured.set(resolvedPath, { unknown: true, reason: 'the review image time budget was spent' })
                    continue
                }
                if (typeof ref.size === 'number' && ref.size > MAX_IMAGE_BYTES) {
                    measured.set(resolvedPath, { unknown: true, reason: 'the file is larger than 10 MB' })
                    continue
                }
                let dims = null
                const failures = []
                for (const strategy of strategies) {
                    try {
                        const bytes = await strategy.read(ref)
                        fetched += 1
                        totalBytes += bytes.length
                        dims = imageDimensions(bytes, resolvedPath)
                        break
                    } catch (err) {
                        // URL in the log, scrubbed reason in the stored row: same
                        // split as the text reader above, same motive.
                        const where = strategy.url ? ` at ${strategy.url(ref)}` : ''
                        failures.push(`${strategy.name}${where}: ${err.message}`)
                    }
                }
                if (!dims && failures.length > 0) {
                    logger.warn(
                        { projectId, resolvedPath, reason: failures.join('; ') },
                        '[LLM] compliance: figure unreadable'
                    )
                }
                measured.set(resolvedPath, dims || { unknown: true, reason: scrubUrls(failures.join('; ')) })
            }
        }

        const withImages = entries.map(entry =>
            entry.resolved && measured.has(entry.resolved)
                ? { ...entry, image: measured.get(entry.resolved) }
                : entry
        )
        return analyzeFigures(withImages, { textWidthMm: DEFAULT_TEXT_WIDTH_MM })
    } catch (err) {
        logger.warn({ projectId, err }, '[LLM] compliance: figure measuring failed')
        return null
    }
}

// overleaf-lab: first regex that matches wins; returns null when none does.
function firstNumber(text, patterns) {
    for (const pattern of patterns) {
        const match = pattern.exec(text)
        if (match) {
            const value = Number.parseInt(match[1], 10)
            if (Number.isFinite(value) && value > 0) {
                return value
            }
        }
    }
    return null
}

// overleaf-lab: turn a backend error body into something we can show the user. A
// context overflow is the common, actionable case: both llama.cpp and OpenAI report
// the prompt size and the context limit in the message, which is exactly what the user
// needs to decide between shortening the document and raising the context window.
// Returns { message, isContext, promptTokens, contextTokens }.
function parseBackendError(errorText) {
    let message = String(errorText || '').trim()
    let kind = ''
    try {
        const body = JSON.parse(errorText)
        const err = body && body.error
        if (err) {
            message = String(err.message || message)
            // Both fields matter: OpenAI puts 'invalid_request_error' in `type` and
            // the useful 'context_length_exceeded' in `code`, so picking only one
            // would miss the overflow.
            kind = `${err.type || ''} ${err.code || ''}`.trim()
        }
    } catch (e) {
        // Not JSON: keep the raw text as the message.
    }

    const haystack = `${kind} ${message}`.toLowerCase()
    const isContext =
        haystack.includes('exceed_context_size') ||
        haystack.includes('context_length_exceeded') ||
        haystack.includes('maximum context') ||
        haystack.includes('context window') ||
        (haystack.includes('context') &&
            (haystack.includes('exceed') ||
                haystack.includes('too long') ||
                haystack.includes('larger than')))

    const promptTokens = firstNumber(message, [
        /n_prompt_tokens\s*=\s*(\d+)/i,
        /you requested\s+(\d+)\s+tokens/i,
        /requested\s+(\d+)\s+tokens/i,
    ])
    const contextTokens = firstNumber(message, [
        /n_ctx\s*=\s*(\d+)/i,
        /maximum context length is\s+(\d+)/i,
        /context (?:size|length)[^0-9]{0,24}(\d+)/i,
    ])

    return { message, isContext, promptTokens, contextTokens }
}

// overleaf-lab: extract a JSON object from a model reply that may include code
// fences or surrounding prose. Strip fences, then take the substring from the first
// `{` to the last `}` and parse it. Throws when no valid JSON is found.
function extractJson(text) {
    let cleaned = String(text || '').trim()
    cleaned = cleaned
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first === -1 || last === -1 || last < first) {
        throw new Error('No JSON object found in model output')
    }
    return JSON.parse(cleaned.slice(first, last + 1))
}

// overleaf-lab: unique id for a review job. Date.now/Math.random are fine here,
// this is normal Node code (not a security token).
function newJobId() {
    return `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// overleaf-lab: drop finished jobs (done/error/cancelled) that are older than the
// TTL, so the map does not grow unbounded across a long-lived process.
function sweepOldJobs() {
    const now = Date.now()
    for (const [id, job] of jobs) {
        const finished =
            job.status === 'done' ||
            job.status === 'error' ||
            job.status === 'cancelled'
        if (finished && job.finishedAt != null && now - job.finishedAt > JOB_TTL_MS) {
            jobs.delete(id)
        }
    }
}

// overleaf-lab: how many reviews are ahead of this job: the running ones plus the
// queued jobs before it. A job that is not in the queue (running, about to run, or
// finished) has nothing ahead, so return 0.
//
// `busyEndpoints.size` where this used to read `running ? 1 : 0`, which is the same
// number whenever one endpoint is configured. It deliberately stays a COUNT OF
// REVIEWS and not an estimate of the wait: with three endpoints a job at position 3
// starts after roughly one review's time, not three, but "3 reviews ahead of you" is
// a fact the panel can state and a divided estimate is a promise about machines that
// may not be equally fast.
function jobsAhead(jobId) {
    // The fast lane first, and counted against ITS OWN cap: a fast review waits for
    // the two or three fast ones in front of it and for nothing on the GPU, so adding
    // the busy endpoints here would tell somebody five seconds from their report that
    // three reviews are ahead of them.
    const fastIdx = fastQueue.indexOf(jobId)
    if (fastIdx !== -1) {
        return fastIdx + fastRunning
    }
    const idx = queue.indexOf(jobId)
    if (idx === -1) {
        return 0
    }
    return idx + busyEndpoints.size
}

// overleaf-lab: circuit breaker on a backend that is GONE.
//
// Degrading one requirement to "n.a." is the honest answer to an OCCASIONAL failure:
// one pass out of fifty could not run, the report says so, the other forty-nine are
// worth reading. It is the wrong answer to an outage. Real incident: the GPU server
// was down for a window, a review of 57 passes finished in TWO SECONDS with every
// model call throwing 'fetch failed' instantly, and the student got a report with 21
// items marked n.a. and no way to tell it from a review that actually ran. When
// nothing answers, the review must fail loudly instead of producing that.
//
// What counts is deliberately narrow. Only a fetch that THROWS counts: an HTTP error
// response comes from a backend that is alive and answering, and a single 400 on one
// oversized prompt must not kill the other passes. An AbortError does not count
// either, because it is our own pass timeout or the user's cancel, both of which
// already have their own path.
//
// The count is kept ACROSS models on purpose. The backup-model failover switches
// after 2 consecutive failures, so the backup gets its chance well before the limit
// here, and its first successful call resets the count; a backend where BOTH models
// are unreachable reaches the limit either way.
const BACKEND_OUTAGE_LIMIT = 8

class BackendOutageError extends Error {
    constructor(failures) {
        super(`the model backend failed ${failures} calls in a row`)
        this.name = 'BackendOutageError'
        this.failures = failures
    }
}

// An abort is the review's own timeout or the user's cancel, never the backend's
// fault. Everything else a fetch throws is the network: 'fetch failed' (a TypeError
// wrapping ECONNREFUSED / ENOTFOUND / EAI_AGAIN) and its kind.
const isAbortError = err => !!err && (err.name === 'AbortError' || err.name === 'TimeoutError')
const isNetworkFailure = err => !!err && !isAbortError(err) && !(err instanceof BackendOutageError)

// overleaf-lab: the errors a per-item catch must NEVER convert into an "n.a." item.
// The per-chapter, per-file and per-pass loops each catch their own failures and
// carry on, which is exactly right for a bad answer and exactly wrong for a cancel
// or a dead backend: those two have to pierce every loop and stop the run.
const stopsTheReview = err => isAbortError(err) || err instanceof BackendOutageError

// overleaf-lab: every per-pass model call goes through this one wrapper, so the
// failure counting has a single home instead of being repeated at each call site.
// `noteOutcome` is the backup-model failover's own bookkeeping, kept independent:
// the failover decides WHICH model to ask, the breaker decides whether there is
// anything to ask at all.
function makeReviewFetch(noteOutcome, doFetch = fetch, limit = BACKEND_OUTAGE_LIMIT) {
    let consecutiveNetworkFailures = 0
    return async (url, options) => {
        try {
            const response = await doFetch(url, options)
            noteOutcome(response.ok)
            // Any answer at all, including an HTTP error, proves the backend is
            // reachable, which is the only thing this counter is about.
            consecutiveNetworkFailures = 0
            return response
        } catch (err) {
            if (!isAbortError(err)) {
                noteOutcome(false)
            }
            if (isNetworkFailure(err)) {
                consecutiveNetworkFailures += 1
                if (consecutiveNetworkFailures >= limit) {
                    throw new BackendOutageError(consecutiveNetworkFailures)
                }
            }
            throw err
        }
    }
}

// overleaf-lab: everything the review reads out of a project, in one place.
//
// It exists so that the ENQUEUE-time document-type check and the RUN-time one look at
// the SAME sources. They did not: the enqueue check tested the pattern against
// getAllDocs alone, the run-time one against the pruned, acknowledgement-stripped
// documents, so the two disagreed about projects that had not changed at all. A user
// was told the job was queued, waited out an hour of queue, and was then refused with
// type_mismatch; and in the other direction a type marker sitting in an UPLOADED .tex
// (a file, not a doc) was invisible at enqueue and refused the click for a project the
// review would have accepted.
async function readProjectSources(projectId) {
    const docsByPath = await ProjectEntityHandler.promises.getAllDocs(projectId)
    const docs = []
    for (const [docPath, value] of Object.entries(docsByPath || {})) {
        // overleaf-lab: getAllDocs is keyed by doc path; each value has a `lines`
        // array of strings. Be defensive: a value may be null.
        if (!value) {
            continue
        }
        const text = (value.lines || []).join('\n')
        if (!text.trim()) {
            continue
        }
        docs.push({ path: docPath, text })
    }
    // overleaf-lab: plus the text-like files that are not docs (an uploaded or
    // externally synced .bib is the common one). Paths that could not be read are
    // carried out with them so the report can name them instead of leaving the reader
    // to assume the whole project was seen.
    const linked = await readTextualProjectFiles(projectId)
    const knownPaths = new Set(docs.map(d => d.path))
    for (const file of linked.files) {
        if (!knownPaths.has(file.path)) {
            docs.push(file)
        }
    }
    return { docs, skipped: linked.skipped }
}

// overleaf-lab: the sources the DOCUMENT TYPE question is answered from - every file
// read, comment-stripped, before any pruning. A title page identifies the document
// whether or not the main file still \inputs the file it sits in, so the type check
// deliberately does NOT use the narrowed set the review is run over.
function typeCheckSources(docs) {
    return docs.map(d => ({ path: d.path, text: stripLatexComments(d.text) }))
}

// overleaf-lab: a wall-clock bound, and the job's cancel, on an await that has neither.
//
// The four loads at the top of a review (rubrics, admin settings, prompts, the project
// docs) took no timeout and were given no abort signal, and they sit INSIDE THE SLOT
// the job holds on its backend: a hung docstore or Mongo read there held that slot for
// ever, so the queue stopped for every user, while the Cancel button - the only lever a
// user can reach - answered {ok:true} and changed nothing. The underlying read cannot
// be cancelled, but the slot can be given back, which is the part that matters.
const PREPASS_TIMEOUT_MS = 120000

function withPrePassGuard(promise, what, signal, timeoutMs = PREPASS_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let settled = false
        const finish = (fn, value) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (signal) {
                signal.removeEventListener('abort', onAbort)
            }
            fn(value)
        }
        const onAbort = () =>
            finish(reject, Object.assign(new Error(`aborted while loading ${what}`), { name: 'AbortError' }))
        const timer = setTimeout(
            () => finish(reject, new Error(`timed out after ${timeoutMs} ms while loading ${what}`)),
            timeoutMs
        )
        if (signal) {
            if (signal.aborted) {
                onAbort()
                return
            }
            signal.addEventListener('abort', onAbort, { once: true })
        }
        promise.then(
            value => finish(resolve, value),
            err => finish(reject, err)
        )
    })
}

// overleaf-lab: run the actual review work for one job. Returns a discriminated
// outcome: { type: 'done', result } on success, or { type: 'error', errorCode,
// message, ... } for a logical failure (too_long / model_unavailable /
// empty_document / backend_error). Throws on an HTTP/parse failure or an abort
// (cancel or the review timeout); processQueue maps those to 'cancelled'/'failed'.
//
// THE SCOPE IS THE POINT of this outer function. Everything a review builds in the
// student's language - the parser verdicts, the refusals, the notes in the report -
// goes through L(), and L() now reads a per-review scope instead of a module
// variable. Opening it here, around the whole run, is what makes an Italian review
// and an English one able to share a process: the two await each other constantly
// once the queue dispatches to more than one endpoint, and the previous arrangement
// had them overwriting each other's language with no way to notice.
//
// 'en' is the value the review starts with and setReportLanguage replaces once the
// rubric is in hand, which is the same order as before.
async function performReview(job) {
    if (!REPORT_LANG_SCOPE) {
        return performReviewInLanguageScope(job)
    }
    return REPORT_LANG_SCOPE.run({ lang: 'en' }, () => performReviewInLanguageScope(job))
}

async function performReviewInLanguageScope(job) {
    try {
        return await runReviewPasses(job)
    } catch (err) {
        // The one failure the review cannot degrade item by item: the backend is
        // gone, so no remaining pass could run either. Fail the whole review with a
        // message that says what happened, instead of a report full of n.a.
        if (!(err instanceof BackendOutageError)) {
            throw err
        }
        logger.error(
            { projectId: job.projectId, userId: job.userId, failures: err.failures },
            '[LLM] compliance: backend unreachable, stopping the review'
        )
        return {
            type: 'error',
            errorCode: 'backend_error',
            message: L(
                `The review stopped: the model backend did not answer ${err.failures} calls in a row.`,
                `La review si è fermata: il backend del modello non ha risposto a ${err.failures} chiamate consecutive.`
            ),
        }
    }
}

// The review itself. Split from performReview only so the outage breaker has one
// place to stop it from, whichever of the dozens of model calls below tripped it.
async function runReviewPasses(job) {
    const { projectId, userId } = job
    // Every load below is bounded and cancellable: see withPrePassGuard. They run
    // while the job holds its backend's slot, so one that never settles takes that
    // machine out of the rotation until the process is restarted.
    const signal = job.controller ? job.controller.signal : undefined
    const guarded = (promise, what) => withPrePassGuard(promise, what, signal)

    // overleaf-lab: resolve the rubric fresh at run time (the job only stores id and
    // name) so the guidelines text is current when the job finally runs.
    const rubrics = await guarded(getComplianceRubrics(), 'the rubrics')
    const rubric = rubrics.find(r => r.id === job.rubricId)
    if (!rubric) {
        throw new Error('Rubric is no longer available')
    }

    // overleaf-lab: BEFORE any check runs and any evidence is built, so every string
    // this run produces - the parser verdicts included - comes out in the language the
    // student is being marked in.
    const reportLanguage = detectRubricLanguage(rubric.guidelines)
    setReportLanguage(reportLanguage)
    setChecksLanguage(reportLanguage)
    logger.debug({ projectId, reportLanguage }, '[LLM] compliance: report language')

    // overleaf-lab: FULL OR FAST, decided by the job and read here once. Everything
    // below that would reach a model backend is guarded on it - the token count, the
    // model probe, the schema probe, the document-type question, the passes themselves
    // and the closing summary - because "fast" is not a smaller review, it is a review
    // that does not call anything. Read from the job rather than passed down: the same
    // value has to reach the archived result, and one source for it is what keeps the
    // report's badge and the work actually done from ever disagreeing.
    const mode = normalizeReviewMode(job.mode)
    const fast = mode === 'fast'

    // overleaf-lab: and the checks module's language, re-asserted at every call.
    //
    // LLMStructuralChecks keeps a module-level language of its own, set from the line
    // above, which was safe while one review ran at a time and is not any more: with
    // the queue dispatching to several endpoints, an Italian review setting it here
    // and reading it forty awaits later can find the English one another job set in
    // between. That module belongs to someone else and is not edited from here, so
    // the fix is on this side and it is the one JavaScript makes free: runCheck and
    // openingHeadingsFact are SYNCHRONOUS, so setting the language on the line
    // immediately before a call cannot be interleaved by anything at all.
    const withChecksLanguage = compute => {
        setChecksLanguage(reportLanguage)
        return compute()
    }

    // Effective backend configuration.
    const admin = await guarded(getAdminLLMSettings(), 'the backend settings')
    // overleaf-lab: THE ENDPOINT THIS JOB WAS HANDED AT PICKUP, and never another
    // one. A job that somehow arrives without one (a hand-made job in a test, a code
    // path that forgets to set it) falls back to the legacy entry, whose null fields
    // mean "resolve from the settings", which is the pre-pool behaviour to the letter.
    const endpoint = job.endpoint || reviewEndpoints[0]
    const llmApiUrl = endpoint.url || admin.llmApiUrl
    const llmApiKey = admin.llmApiKey
    // overleaf-lab: a fast review has no backend to be missing. This throw is what
    // made "no model configured" mean "no review at all", and it is exactly the
    // instance - a fresh clone of this repository, a department with no GPU - where the
    // deterministic half of the rubric is the only review available and is worth
    // having. The full mode still refuses here, loudly, as it always did.
    if (!llmApiUrl && !fast) {
        throw new Error('LLM backend is not configured')
    }
    const maxContextTokens = admin.maxContextTokens || 32000
    // overleaf-lab: the admin-set answer budget wins; fall back to the env default.
    const reviewMaxTokens = admin.reviewMaxTokens || REVIEW_MAX_TOKENS
    // overleaf-lab: the endpoint's own model when it declares one - the whole point
    // of a pool is that the three machines serve three different models - then the
    // admin-chosen review model, then the first allowed model, then the env-derived
    // default (mirrors the chat model fallback).
    const reviewModel =
        endpoint.model ||
        (admin.reviewModel && admin.reviewModel.trim()) ||
        (admin.allowedModels && admin.allowedModels[0]) ||
        ((process.env.LLM_MODEL_NAME || process.env.LLM_AVAILABLE_MODELS || 'default').split(',')[0].trim())

    // overleaf-lab: optional backup review model. When the active model refuses or
    // errors twice in a row, the review switches to the backup for the REST of the
    // run: a model dying mid-review (backend crash, out of VRAM) should cost the
    // passes it already failed, not degrade every remaining one to "check failed".
    // The switch is one-way and logged; single hiccups never trigger it (a lone
    // failure resets on the next success). Aborts are the review's own timeouts and
    // cancellations, so they do not count against the model.
    //
    // PER-ENDPOINT, falling back to the instance-wide one. The failover changes the
    // MODEL and never the address - it re-sends to the same backend with a different
    // `model` field - so a backup that is not loaded on THIS machine is not a backup
    // at all, it is a second way to fail. Each endpoint may therefore name its own;
    // when it does not, the instance-wide setting is used, which is what a
    // single-backend install has always had. This also keeps the affinity rule true
    // by construction: nothing in the failover can move the review.
    const backupReviewModel =
        (endpoint.modelBackup && endpoint.modelBackup.trim()) ||
        (admin.reviewModelBackup && admin.reviewModelBackup.trim()) ||
        ''
    let activeReviewModel = reviewModel
    let reviewModelFailures = 0
    const reviewModelNow = () => activeReviewModel
    const noteReviewModelOutcome = ok => {
        if (ok) {
            reviewModelFailures = 0
            return
        }
        reviewModelFailures += 1
        if (
            backupReviewModel &&
            backupReviewModel !== activeReviewModel &&
            reviewModelFailures >= 2
        ) {
            logger.warn(
                { projectId, from: activeReviewModel, to: backupReviewModel },
                '[LLM] compliance: review model failing, switching to the backup model'
            )
            activeReviewModel = backupReviewModel
            reviewModelFailures = 0
        }
    }
    // overleaf-lab: the failover's bookkeeping plus the outage breaker, in one place.
    const reviewFetch = makeReviewFetch(noteReviewModelOutcome)

    // overleaf-lab: resolve the effective editable prompts (admin override or the
    // shipped default) so the review uses the admin-tuned system prompt.
    const prompts = await guarded(getLLMPrompts(), 'the prompts')

    // Assemble the whole project into one LaTeX blob.
    const linked = await guarded(readProjectSources(projectId), 'the project text')
    const docs = linked.docs
    // Comment-stripped, and taken BEFORE any pruning: this is what the document-type
    // check reads, and it is the same set the enqueue-time check reads. Reusing these
    // objects below also means stripLatexComments runs once per file, not twice.
    const allReadDocs = typeCheckSources(docs)
    const readByPath = new Map(allReadDocs.map(d => [d.path, d]))
    // overleaf-lab: the project EXACTLY as it is on disk, comments and all, kept for
    // one purpose: telling a quote the model invented from a quote our own sanitising
    // hid. Verbatim bodies are blanked, comments are stripped and excluded chapters are
    // removed before a pass sees the text, so a finding can quote something real that
    // is not in what was sent. Built lazily, since a review whose evidence all grounds
    // never needs it, and normalising the project twice is not free.
    // The snapshot is taken now because `docs` is re-ordered and pruned below and the
    // files it drops are exactly the ones a quote may legitimately come from.
    const rawDocs = docs.slice()
    let normalizedRawSource = null
    const rawSource = () => {
        if (normalizedRawSource === null) {
            normalizedRawSource = normalizeForMatch(rawDocs.map(d => d.text).join('\n'))
        }
        return normalizedRawSource
    }

    // overleaf-lab: reading order, taken from the \input/\include list of the main
    // file. It used to be "main file first, then alphabetical", which put
    // capitolo10.tex before capitolo2.tex: harmless while the whole project went into
    // one prompt, wrong the moment the document is cut into chapters. With no main
    // file to follow, the old stable order is kept.
    //
    // overleaf-lab: and only the files the document actually compiles. A project that
    // grew out of an older template keeps chapters nothing pulls in any more; they do
    // not reach the PDF, so reviewing them spends passes on dead text and reports
    // defects the author cannot find. Dropped only when the graph is COMPLETE, that
    // is when every \input resolved to a file we hold: an unresolvable include means
    // we cannot tell a dead file from one we simply failed to follow, and reviewing
    // half a thesis while announcing it compliant is a far worse failure than
    // reviewing a file nobody compiles. A .bib is never \input, it is pulled in by
    // \bibliography or \addbibresource, so it is always kept.
    const inclusion = partitionByInclusion(docs)
    const droppable = inclusion.complete
        ? inclusion.orphans.filter(d => !/\.bib$/i.test(d.path))
        : []
    const skippedFiles = droppable.map(d => d.path)
    const keptOrphans = inclusion.orphans.filter(d => !droppable.includes(d))
    docs.splice(0, docs.length, ...inclusion.ordered, ...keptOrphans)
    if (skippedFiles.length > 0) {
        logger.debug(
            { projectId, skipped: skippedFiles },
            '[LLM] compliance: files not included by the main document, skipped'
        )
    }

    // overleaf-lab: strip LaTeX comments per source doc BEFORE prefixing the FILE
    // header, so the header lines (which themselves start with `%`) survive. Keep the
    // stripped per-file texts: the deterministic scan hints are computed on exactly
    // what the model will see.
    const readDocs = docs.map(d => readByPath.get(d.path) || { path: d.path, text: stripLatexComments(d.text) })

    // overleaf-lab: acknowledgements are dropped HERE, before anything reads the
    // documents: the assembled text, the scan hints, the structural facts, the
    // parser checks and the per-chapter plan all consume `strippedDocs`, so cutting
    // them at the single point where that value is produced is what makes "never
    // reviewed" true instead of true in most places. The exclusion is then SHOWN in
    // the report (documentFilesSkipped below), because a narrower scope that goes
    // unsaid reads as "everything was checked".
    const unreviewed = excludeUnreviewedSegments(readDocs)
    const strippedDocs = unreviewed.docs
    const parts = strippedDocs.map(d => `% ===== FILE: ${d.path} =====\n${d.text}`)
    const assembled = parts.join('\n\n')
    // The checks this rubric hands to a parser. A fact that answers one of them is not
    // put in front of the model: nobody is asking it that question any more. Split here
    // rather than reading the `requirements` declared further down: that one is a const
    // in the same scope, so reaching it from here threw "cannot access before
    // initialization" on every single review.
    const activeChecks = new Set(
        splitRubric(rubric.guidelines).requirements.map(requirementCheck).filter(Boolean)
    )
    const rubricPatterns = parseScanPatterns(rubric.scanPatterns)

    // overleaf-lab: the one part of a review that leaves the machine. Off unless an
    // administrator set a contact address, in which case the bibliography's DOIs are
    // resolved against Crossref and compared with what comes back. It is bounded
    // (60 requests, one per second) and cancellable, and NOTHING it can fail at is
    // allowed to lose a finished review or to become a fact about the student: a
    // failure degrades to the disabled marker, which the hints then print as NOT RUN.
    let bibVerify = null
    // overleaf-lab: and the one part a FAST review will not pay for. It is bounded at
    // one request per second against a third-party API, so a bibliography of sixty
    // entries is a minute on its own - which is the whole budget of a mode whose
    // promise is an answer in seconds. Marked not-run rather than left absent: an
    // absent block renders nothing, and a bibliography section that silently
    // disappears reads as a bibliography with nothing wrong with it.
    if (fast && isBibVerifyEnabled()) {
        bibVerify = {
            enabled: false,
            reason: L(
                'not part of a fast review',
                'non fa parte della review rapida'
            ),
        }
    } else if (isBibVerifyEnabled()) {
        try {
            bibVerify = await guarded(
                verifyBibliography(bibEntriesForVerification(strippedDocs), { signal }),
                'the bibliography check'
            )
        } catch (err) {
            if (job.status === 'cancelled' || stopsTheReview(err)) {
                throw err
            }
            logger.warn({ projectId, err }, '[LLM] compliance: bibliography verification failed')
            bibVerify = { enabled: false, reason: 'the check was enabled but did not run' }
        }
    }
    // overleaf-lab: the raster figures, measured. Async (the bytes live in the file
    // store), bounded by its own budgets, and never fatal: a null block adds no lines.
    const imageMetrics = await measureProjectFigures(
        projectId,
        strippedDocs,
        job.controller ? job.controller.signal : undefined
    )
    // overleaf-lab: the scan hints are PROMPT MATERIAL and nothing else - they are the
    // facts a pass is shown so it does not have to count things itself, and no line of
    // them reaches the report. With no pass to show them to they are pure cost (a
    // sweep of the project per pattern, including the admin-written regexes), so a
    // fast review does not build them. The code-computed blocks that DO reach the
    // report - the figure measurements above, the writing signals below - are built in
    // both modes, which is the line between what a fast review keeps and what it drops.
    const scanHints = fast ? '' : [
        buildScanHints(strippedDocs, rubricPatterns, activeChecks, imageMetrics),
        // overleaf-lab: the opening headings in include order, tagged by the keyword
        // sets of the compulsory-parts requirements. A FACT, never a verdict: presence
        // is detectable, absence is not (a section can fulfil a part by content under
        // any title), and the line says so itself. Computed here, not inside
        // buildScanHints: that function is sliced and evaluated standalone by its
        // suite, where this module-scope import does not exist.
        ...[withChecksLanguage(() => StructuralChecks.openingHeadingsFact(strippedDocs))].filter(Boolean),
        ...formatBibVerifyFacts(bibVerify),
    ].join('\n')

    // overleaf-lab: the document cut into chapters, and the outline of the whole
    // thing. Both are computed for every review even when no requirement asks for
    // them: they cost a regex sweep over text already in memory, and having them
    // always available is what lets the budget guard below offer a degraded review
    // instead of a refusal.
    const segments = unreviewed.segments
    const skeleton = buildSkeleton(strippedDocs, segments)

    if (!assembled.trim()) {
        return {
            type: 'error',
            errorCode: 'empty_document',
            message: 'The project has no text to review',
        }
    }

    // overleaf-lab: split the rubric into one requirement per pass (numbered/bulleted
    // lines; prose degrades to a single pass over the whole text). Resolved fresh per
    // job, so editing the rubric in the admin UI changes the NEXT review's pass count.
    const { preamble, requirements } = splitRubric(rubric.guidelines)

    // overleaf-lab: the prompt of a pass carries the preamble and ONE requirement,
    // never the whole rubric (see guidelinesFor below). Counting every requirement
    // here used to be a harmless upper bound, but the answer budget is whatever the
    // context leaves free after the prompt, so on a long rubric it silently took
    // more than a thousand tokens away from every answer, and the model started
    // getting truncated and retried. The worst case is the longest single
    // requirement, which is still an upper bound and costs nothing that is not sent.
    const worstCaseGuidelines = `${preamble}\n${requirements.reduce(
        (longest, requirement) =>
            requirement.length > longest.length ? requirement : longest,
        ''
    )}`

    // Context-window guard. Budget the WHOLE prompt against the configured context
    // window: document + rubric guidelines + system prompt + room for the JSON
    // answer. The rubric can be large, so it must count too, otherwise the document
    // could pass here and the full prompt still overflow. Counting ALL the guidelines
    // is a safe upper bound: each pass actually sends only one requirement.
    // overleaf-lab: prefer the backend's exact count; fall back to the heuristic when
    // it has no /tokenize (see countPromptTokens).
    const heuristicPromptTokens =
        estimateTokens(assembled) +
        estimateTokens(scanHints) +
        estimateTokens(worstCaseGuidelines) +
        estimateTokens(prompts.reviewSystemPrompt)
    // A call to the backend, so a fast review does not make it: there is no prompt to
    // measure and the heuristic below is only ever used to size things nothing sends.
    const exactPromptTokens = fast
        ? null
        : await countPromptTokens(
              llmApiUrl,
              llmApiKey,
              `${prompts.reviewSystemPrompt}\n${worstCaseGuidelines}\n${assembled}\n${scanHints}`,
              reviewModel,
              job.controller ? job.controller.signal : undefined
          )
    const promptTokens = exactPromptTokens || heuristicPromptTokens
    logger.debug(
        { projectId, promptTokens, exact: exactPromptTokens != null, heuristicPromptTokens },
        '[LLM] compliance: prompt size'
    )
    // overleaf-lab: expose the size for the result metadata and error reports.
    job.documentTokensEstimate = promptTokens

    // overleaf-lab: ADAPTIVE per-pass answer budget. max_tokens is a CAP, not a
    // target: a short answer costs the same under any cap, so the only real cost of a
    // generous budget is the context room it reserves. Give each pass ALL the room the
    // document leaves free (up to the admin budget) instead of a fixed slice: a
    // thorough pass may legitimately enumerate dozens of figures in its analysis, and
    // writing that enumeration out IS how the model verifies (starving it pushes the
    // work back into attention, which is what multi-pass exists to avoid).
    const headroom = maxContextTokens - promptTokens - CONTEXT_SAFETY_MARGIN
    const perPassBudget = Math.min(reviewMaxTokens, headroom)

    // overleaf-lab: the same arithmetic for a pass that reads ONE chapter, or the
    // skeleton, instead of the whole project. The fixed costs (hints, system prompt,
    // the longest requirement) are the same; only the text changes.
    const fixedPromptTokens =
        estimateTokens(scanHints) +
        estimateTokens(worstCaseGuidelines) +
        estimateTokens(prompts.reviewSystemPrompt)
    const budgetFor = text =>
        Math.min(
            reviewMaxTokens,
            maxContextTokens - estimateTokens(text) - fixedPromptTokens - CONTEXT_SAFETY_MARGIN
        )
    const largestSegmentText = segments.reduce((longest, segment) => {
        const text = segmentText(segment)
        return text.length > longest.length ? text : longest
    }, '')
    const localPassBudget = Math.min(budgetFor(largestSegmentText), budgetFor(skeleton))
    // overleaf-lab: the budget for any pass that does NOT send the whole document.
    // Two bugs live here if it is not centralised: when the document does not fit,
    // perPassBudget is by definition negative, and a negative max_tokens is a 400 on
    // an OpenAI-shaped backend while llama-server reads it as "unlimited", so the
    // same code silently works on one backend and fails on the other. And the value
    // must never go below the answer floor whatever the arithmetic says.
    const scopedPassBudget = Math.max(
        MIN_ANSWER_TOKENS,
        perPassBudget >= MIN_ANSWER_TOKENS ? perPassBudget : localPassBudget
    )

    // overleaf-lab: a document that does not fit no longer sinks the whole review.
    //
    // It used to: one guard, one refusal, nothing checked. But "the project does not
    // fit in one prompt" only disqualifies the requirements that genuinely need to
    // see it all at once. Everything scoped to a chapter, a file or the skeleton is
    // still perfectly checkable, and on a long thesis those are the majority. So the
    // review runs what it can and says plainly, requirement by requirement, what it
    // could not check and why: a report covering thirty requirements out of
    // thirty-five is worth incomparably more than an error message.
    //
    // The review is only refused when even a single chapter will not fit, because at
    // that point there is no unit small enough to look at.
    const documentFits = perPassBudget >= MIN_ANSWER_TOKENS
    // overleaf-lab: degrading is only worth offering when something is left to run.
    // A rubric with no scope markers is ALL whole-document steps, so on an oversized
    // project every single one would take the "not checked" branch and the user would
    // get a report of thirty-five n.a. verdicts, marked `done`, instead of the
    // actionable "raise the context window" refusal they used to get. A fake report is
    // worse than an error message.
    const hasScopedWork = buildPassPlan(requirements, {
        fileCount: strippedDocs.length,
        segmentCount: segments.length,
    }).some(step => step.scope !== 'document')
    // overleaf-lab: `!fast` because a context window is not a constraint a fast review
    // has. Nothing is ever put in a prompt, so a thesis ten times too long for the
    // model is checked by the parsers exactly as a short one is, and refusing it here
    // with "too long for a single-pass review" would be a refusal about a pass that
    // was never going to run.
    if (!fast && !documentFits && (!hasScopedWork || localPassBudget < MIN_ANSWER_TOKENS)) {
        // overleaf-lab: report the minimum reserve too. Without it the UI could only
        // show "prompt / limit", which can look like it fits while the refusal is
        // really caused by the answer room pushing the total over.
        return {
            type: 'error',
            errorCode: 'too_long',
            message:
                'Document is too long for a single-pass review with the configured context window',
            documentTokensEstimate: promptTokens,
            maxContextTokens,
            reviewMaxTokens: MIN_ANSWER_TOKENS,
        }
    }
    if (!documentFits) {
        logger.warn(
            { projectId, promptTokens, maxContextTokens, segments: segments.length },
            '[LLM] compliance: document too long for whole-document passes, running the scoped ones'
        )
    }

    // Reachability check: only when an explicit review model is configured.
    // overleaf-lab: verify the configured model is actually served by the backend.
    // If the /models call itself fails, log and continue; the chat call below will
    // surface any real error.
    //
    // PER-ENDPOINT, and it has to be: with a pool the whole question changes meaning.
    // "The review model is not available" used to be a statement about the instance;
    // it is now a statement about ONE machine, and the three of them deliberately
    // serve three different models. Both halves of the question therefore come from
    // this job's endpoint - the address it asks, and the model id it looks for - and
    // the answer marks that endpoint alone (see processQueue), so a machine whose
    // model failed to load stops taking work without saying anything about the other
    // two.
    //
    // A fast review skips it: "is the model there" is not a question about a run that
    // will not ask the model anything, and answering model_unavailable would fail a
    // review that was perfectly able to finish.
    const declaredModel =
        (endpoint.model && endpoint.model.trim()) ||
        (typeof admin.reviewModel === 'string' ? admin.reviewModel.trim() : '')
    if (!fast && declaredModel.length > 0) {
        try {
            const modelsHeaders = {}
            if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
                modelsHeaders.Authorization = `Bearer ${llmApiKey}`
            }
            const modelsOutcome = await fetchWithLimit(
                `${llmApiUrl}/models`,
                { method: 'GET', headers: modelsHeaders },
                AUX_FETCH_TIMEOUT_MS,
                job.controller ? job.controller.signal : undefined,
                async response =>
                    response.ok
                        ? { ok: true, data: await response.json() }
                        : { ok: false, status: response.status }
            )
            if (modelsOutcome.ok) {
                const ids = Array.isArray(modelsOutcome.data?.data)
                    ? modelsOutcome.data.data.map(entry => String(entry.id))
                    : []
                if (!ids.includes(reviewModel)) {
                    return {
                        type: 'error',
                        errorCode: 'model_unavailable',
                        message: 'The configured review model is not available on the backend',
                    }
                }
            } else {
                logger.warn(
                    { projectId, status: modelsOutcome.status },
                    '[LLM] compliance: /models check returned non-ok, continuing'
                )
            }
        } catch (err) {
            logger.warn({ projectId, err }, '[LLM] compliance: /models check failed, continuing')
        }
    }

    // Build the per-pass request pieces. The document comes FIRST in the user message
    // so the llama.cpp prompt cache can reuse its prefill across passes: with the
    // requirement appended AFTER the document, passes 2..N only pay for their own few
    // hundred tokens instead of re-reading the whole project. The scan hints are
    // constant per job, so they live in the shared cached prefix too.
    const documentBlock = `DOCUMENT:\n${assembled}\n\n${scanHints}\n\n`
    // overleaf-lab: the language reminder is repeated as the LAST thing the model
    // reads, not only in the system prompt. The scan hints and the structural facts
    // are in English whatever the rubric's language is, and they sit right before
    // this point: items that leaned on them kept coming back in English inside an
    // otherwise Italian report even with the rule stated up front.
    const ANSWER_LANGUAGE_NOTE =
        '\n\nWrite every field of your answer in the SAME LANGUAGE as the guidelines above, even when restating a scan hint or a structural fact (those are always in English). Quotes from the document stay verbatim.'
    // overleaf-lab: mirror the counter to the store. Called from EVERY place the
    // counter moves, not just the outer loop: a [per-file] requirement advances once
    // per source file, and mirroring only the outer loop left the admin dashboard
    // ten passes behind the editor panel for minutes at a time.
    // A fast job is not in the work list at all (see startReview: it is re-runnable in
    // seconds and must never be resumed as GPU work), so there is no document for
    // these updates to land in and they are simply not made.
    const mirrorProgress = () =>
        fast
            ? undefined
            : ComplianceStore.updateJobProgressQuietly(job.id, {
                  passesDone: job.passesDone,
                  passesTotal: job.passesTotal,
                  currentRequirement: job.currentRequirement,
              })

    // overleaf-lab: the requirement, then its own contrastive examples, then the
    // language note. Everything the examples add sits AFTER the document block, which
    // is what keeps that block byte-identical across every pass and the backend's
    // prefill cached (see documentBlock above).
    const guidelinesFor = requirement =>
        `GUIDELINES (check ONLY these):\n${
            preamble ? `${preamble}\n` : ''
        }${requirement}${ANSWER_LANGUAGE_NOTE}`

    // overleaf-lab: send Authorization only when a non-empty key exists, so a
    // keyless local server is not sent a malformed empty Bearer header.
    const chatHeaders = { 'Content-Type': 'application/json' }
    if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
        chatHeaders.Authorization = `Bearer ${llmApiKey}`
    }

    // overleaf-lab: DOES THIS BACKEND ACTUALLY HONOUR THE JSON SCHEMA?
    //
    // Every verdict in the report comes back through response_format json_schema. There
    // is a known llama.cpp failure (issue 20345) where a server with thinking ENABLED
    // silently ignores the grammar: the call succeeds, the content is prose, and every
    // pass of the review then falls through to the defensive JSON extraction or to
    // "unusable answer twice". The visible symptom is a whole report of n.a. verdicts,
    // hours after the misconfiguration was made and with nothing pointing at it. One
    // tiny call up front turns that into a sentence.
    //
    // The probe sends the SAME SHAPE a review pass sends, same model and same
    // response_format, because the path that has to be tested is the path the review
    // uses: the enable_thinking:false injection lives in the router in front of the
    // backend, so mirroring the request is what mirrors the injection.
    //
    // Only a SUCCESSFUL answer that breaks the schema is fatal. A timeout, a refusal or
    // an unreachable backend says nothing about the grammar, and the review itself
    // surfaces a backend that is down; a probe that could fail a job over connectivity
    // would be a new way to lose reviews, not a safeguard.
    //
    // A fast review does not probe: no verdict below comes back through a schema, so
    // there is nothing a broken one could poison. `null` and not a skipped block, so
    // the failure handling around it stays one shape.
    try {
        const probeResponse = fast ? null : await fetchWithLimit(
            `${llmApiUrl}/chat/completions`,
            {
                method: 'POST',
                headers: chatHeaders,
                body: JSON.stringify({
                    model: reviewModelNow(),
                    messages: [
                        { role: 'system', content: 'You answer with JSON only.' },
                        { role: 'user', content: 'Answer with {"ok":"yes"} and nothing else.' },
                    ],
                    max_tokens: JSON_PROBE_MAX_TOKENS,
                    temperature: 0,
                    response_format: {
                        type: 'json_schema',
                        json_schema: {
                            name: 'json_mode_probe',
                            strict: true,
                            schema: JSON_PROBE_SCHEMA,
                        },
                    },
                }),
            },
            JSON_PROBE_TIMEOUT_MS,
            job.controller ? job.controller.signal : undefined,
            async response =>
                response.ok
                    ? { ok: true, data: await response.json() }
                    : { ok: false, status: response.status }
        )
        if (probeResponse && probeResponse.ok) {
            const probeData = probeResponse.data
            const probeContent = stripThinkTags(probeData?.choices?.[0]?.message?.content || '')
            let probed = null
            try {
                probed = extractJson(probeContent)
            } catch (err) {
                probed = null
            }
            if (!probed || probed.ok !== 'yes') {
                logger.error(
                    { projectId, model: reviewModelNow(), answer: probeContent.slice(0, 200) },
                    '[LLM] compliance: backend ignored the JSON schema, refusing to run'
                )
                return {
                    type: 'error',
                    errorCode: 'json_mode_broken',
                    message: L(
                        'The model backend answered a JSON-schema request with something that is not that JSON, ' +
                            'so no verdict of this review could be trusted. The usual cause is thinking left ENABLED ' +
                            'on the backend: llama.cpp then ignores the schema silently. Disable thinking for the ' +
                            'review model (enable_thinking:false) and run the review again.',
                        'Il backend del modello ha risposto a una richiesta con schema JSON con qualcosa che quel JSON non è, ' +
                            'quindi nessun verdetto di questa review sarebbe affidabile. La causa tipica è il thinking lasciato ' +
                            'ATTIVO sul backend: llama.cpp in quel caso ignora lo schema senza dirlo. Disattivare il thinking per ' +
                            'il modello di revisione (enable_thinking:false) e rilanciare la review.'
                    ),
                }
            }
        } else if (probeResponse) {
            logger.warn(
                { projectId, status: probeResponse.status },
                '[LLM] compliance: JSON schema probe returned non-ok, continuing'
            )
        }
    } catch (err) {
        if (job.status === 'cancelled' || stopsTheReview(err)) {
            throw err
        }
        logger.warn({ projectId, err }, '[LLM] compliance: JSON schema probe failed, continuing')
    }

    // overleaf-lab: per-pass safety timeout, SIZED FROM THE WORK with the old fixed
    // hour as the floor. The worst case per pass is a full document prefill (the
    // prompt cache makes later passes much cheaper, but a cap must not rely on that)
    // plus a full-budget generation. These fetches do not pass through nginx (the
    // client polls the job), so no proxy limit applies. Recomputed every pass, since
    // timings from completed passes refine the measured rates.
    const passTimeoutMs = () => {
        const rates = effectiveRates()
        const worstCaseMs =
            Math.round((promptTokens / rates.prefillTps) * 1000) +
            Math.round((perPassBudget / rates.genTps) * 1000)
        return Math.max(REVIEW_MIN_TIMEOUT_MS, Math.round(worstCaseMs * 1.5))
    }

    // overleaf-lab: is this rubric even about this kind of document?
    //
    // Picking the wrong entry from the dropdown is a one-click mistake that costs
    // twenty minutes of GPU and produces a report full of confident nonsense: an
    // internship rubric run on a thesis reports the missing description of the
    // hosting institution as a real defect. It has already happened.
    //
    // The check cannot look at the project title, which anyone can rename, nor at
    // file names, same reason. It also must not carry any knowledge of OUR templates:
    // this code is public and other people's documents look nothing like ours. What
    // it uses instead is data the rubric already carries: the preamble, the text
    // before the first numbered requirement, which is where every rubric says in
    // plain language what kind of document it is for. Policy in the rubric, as with
    // the scan patterns and the scope markers.
    //
    // One pass over the SKELETON, which is why it costs seconds rather than a full
    // read, and only a positive mismatch or a genuine "cannot tell" stops the run,
    // never to be overridden silently: the user gets the reason and a way to proceed.
    const expectedDocument = (preamble || rubric.name || '').trim()
    // overleaf-lab: the preamble alone was not enough to tell two academic documents
    // apart. Running the internship rubric on a thesis went through without a question:
    // both are "a LaTeX document with chapters", the prompt asks for POSITIVE evidence
    // of a different kind before objecting, and a one-line description gives the model
    // nothing positive to weigh.
    //
    // What does distinguish them is already written in the rubric: its [structure]
    // requirements say what this kind of document must contain and in what order (an
    // internship report opens with the hosting institution, the context and the aims; a
    // thesis carries an abstract, an introduction and conclusions). Handing those to the
    // check gives it a signature to compare the outline against, in the rubric's own
    // words and therefore in the rubric's own language, with no knowledge of anybody's
    // templates in this file.
    const structureRequirements = requirements
        .filter(r => requirementScope(r) === 'structure')
        .map(r => stripCheckMarker(stripScopeMarker(r)))
        .slice(0, 12)
    const expectedShape = structureRequirements.length
        ? `\n\nA document of that kind is expected to satisfy these structural requirements:\n` +
          structureRequirements.map(r => `- ${r}`).join('\n')
        : ''
    // overleaf-lab: when the rubric declares a "Document type" pattern, the
    // recognition is mechanical and the model is never asked. The same test already
    // ran at enqueue time for instant feedback; it runs again here because the
    // sources can change while the job waits in the queue.
    //
    // Over `allReadDocs`, which is every file read, and NOT over `strippedDocs`, which
    // is what is left after the orphan pruning and the acknowledgements exclusion. That
    // difference is what made the two runs of the same test disagree on sources that
    // had not changed: a title page in a file the main document no longer \inputs
    // passed at enqueue and was refused here, after the user had waited out the queue.
    //
    // The MECHANICAL branch runs in both modes: it is a regex over sources already in
    // memory, and picking the wrong rubric from the dropdown is just as wrong in a
    // fast review as in a full one. Only the model fallback under it is skipped in
    // fast mode, because asking a model what kind of document this is would be the one
    // model call in a mode whose whole promise is that there are none.
    const typePattern = documentTypePattern(rubricPatterns)
    if (!job.confirmed && typePattern) {
        if (!documentTypeMatches(typePattern, allReadDocs)) {
            logger.info(
                { projectId, rubric: rubric.name },
                '[LLM] compliance: document type pattern matches nowhere, asking the user'
            )
            return {
                type: 'error',
                errorCode: 'type_mismatch',
                message: L(TYPE_MISMATCH_MESSAGE_EN, TYPE_MISMATCH_MESSAGE_IT),
                expectedDocument,
                certain: true,
            }
        }
    } else if (!fast && !job.confirmed && expectedDocument) {
        let verdict = null
        try {
            const data = await fetchWithLimit(
                `${llmApiUrl}/chat/completions`,
                {
                    method: 'POST',
                    headers: chatHeaders,
                    body: JSON.stringify({
                        model: reviewModelNow(),
                        messages: [
                            {
                                role: 'system',
                                content:
                                    'You identify what KIND of document a LaTeX project is, from its structure. Answer in JSON only.',
                            },
                            {
                                role: 'user',
                                content:
                                    `${skeleton}\n\n` +
                                    `The review about to run expects this kind of document:\n"${expectedDocument}"${expectedShape}\n\n` +
                                    'Judge the KIND of document, its parts and how it is organised, never its ' +
                                    'quality or how finished it is: an empty template of the right kind is ' +
                                    'still the right kind, and a missing section is a defect for the review to ' +
                                    'report, not evidence of a different kind of document.\n' +
                                    'Work in two steps. First name, in one short phrase, what kind of document ' +
                                    'the outline above actually looks like, judging only from its parts and ' +
                                    'their order. Then compare that with what is expected.\n' +
                                    'Answer "no" when the outline is organised around a DIFFERENT purpose than ' +
                                    'the expected one, which is the case whenever the structural requirements ' +
                                    'above describe an opening or a set of parts that the outline plainly does ' +
                                    'not follow. Answer "unsure" if the outline carries too little to tell. ' +
                                    'Answer "yes" only when the outline is consistent with the expected kind.\n' +
                                    'Give the reason in one short sentence, naming what the outline looks like ' +
                                    'and what was expected, in the language of the expected-document ' +
                                    'description above.',
                            },
                        ],
                        max_tokens: 300,
                        temperature: 0,
                        response_format: {
                            type: 'json_schema',
                            json_schema: {
                                name: 'document_type',
                                strict: true,
                                schema: {
                                    type: 'object',
                                    additionalProperties: false,
                                    // Reason BEFORE verdict: the grammar emits keys in
                                    // this order, so the model justifies before it
                                    // commits (see REVIEW_ITEMS_SCHEMA).
                                    required: ['reason', 'verdict'],
                                    properties: {
                                        reason: { type: 'string' },
                                        verdict: { type: 'string', enum: ['yes', 'no', 'unsure'] },
                                    },
                                },
                            },
                        },
                    }),
                },
                AUX_FETCH_TIMEOUT_MS,
                job.controller ? job.controller.signal : undefined,
                response => (response.ok ? response.json() : null)
            )
            if (data) {
                verdict = extractJson(stripThinkTags(data?.choices?.[0]?.message?.content || ''))
            }
        } catch (err) {
            if (job.status === 'cancelled' || stopsTheReview(err)) {
                throw err
            }
            // A failed check must never block a review: it is a guard rail, not a
            // gate. Unreachable backend, malformed answer, timeout: carry on.
            logger.warn({ projectId, err }, '[LLM] compliance: document type check failed')
        }
        if (verdict && (verdict.verdict === 'no' || verdict.verdict === 'unsure')) {
            logger.info(
                { projectId, rubric: rubric.name, verdict: verdict.verdict },
                '[LLM] compliance: document type not confirmed, asking the user'
            )
            return {
                type: 'error',
                errorCode: 'type_mismatch',
                message: verdict.reason || '',
                expectedDocument,
                certain: verdict.verdict === 'no',
            }
        }
    }

    // overleaf-lab: pass-based progress, read by the status endpoint. The plan knows
    // what every requirement costs: one pass, one per file, or one per chapter.
    const plan = buildPassPlan(requirements, {
        fileCount: strippedDocs.length,
        segmentCount: segments.length,
        mode,
    })
    const mainPassCount = countPlannedPasses(plan)
    logger.debug(
        {
            projectId,
            mode,
            requirements: requirements.length,
            segments: segments.length,
            passes: mainPassCount,
            documentFits,
        },
        '[LLM] compliance: pass plan'
    )
    job.passesTotal = mainPassCount
    job.passesDone = 0
    let completedPasses = 0

    // overleaf-lab: normalized haystack for the mechanical quote-grounding check. The
    // scan hints are part of it on purpose: they are input the model was given, so an
    // evidence line that quotes a hint back (a count, a "none found" statement) is
    // attribution, not fabrication, and must not raise the ungrounded-quote warning.
    // The SKELETON belongs there for the same reason: a [structure] requirement is
    // shown the outline instead of the text, so its evidence quotes the outline, and
    // searching only the sources could never find it. That is how a correct answer
    // about the opening chapters of a report ("Outline: 1. Hosting institution -> 2.
    // Context -> ...") came back flagged as containing a fabricated quote.
    const normalizedSource = normalizeForMatch(`${assembled}\n${scanHints}\n${skeleton}`)
    // overleaf-lab: per-file search indexes, used to turn a grounded quote into an
    // exact file:line. Built from the same stripped text the model receives, so a
    // located line is the line the model actually read.
    const searchIndexes = strippedDocs.map(d => buildSearchIndex(d.path, d.text))

    const allItems = []
    // overleaf-lab: quote-grounding result per item, filled as items arrive rather
    // than recomputed at the end, so the planned verification count below is known
    // as early as the finding that causes it.
    const groundingByItem = []
    // overleaf-lab: how many double-checks the review already knows it owes. The
    // total CANNOT be known upfront (it depends on what the passes find: a clean
    // document needs none, a bad one needs the cap), and reserving the maximum from
    // the start would show a total the run never reaches. It IS knowable
    // progressively though: the moment a pass returns a negative verdict, that
    // verdict has earned a re-check. Keeping the total in step with what is known
    // turns one confusing jump at the end into a bar that grows as problems are
    // found, which is also the honest reading of "there is more work now".
    const refreshTotal = () => {
        while (groundingByItem.length < allItems.length) {
            groundingByItem.push(
                countUngroundedQuotes(allItems[groundingByItem.length].evidence, normalizedSource)
            )
        }
        job.passesTotal = mainPassCount + countPlannedVerifications(allItems, groundingByItem)
    }

    // overleaf-lab: the two haystacks a claimed quote is searched in, in this order:
    // what the pass was actually shown, then the raw project. See DEMOTION_MIN_QUOTE_CHARS.
    const quoteSources = [normalizedSource, rawSource]
    // overleaf-lab: the same haystacks WITHOUT the lines this code wrote.
    //
    // The scan hints and the skeleton are part of normalizedSource on purpose: a pass
    // was shown them, so quoting one back is attribution and must not raise the
    // warning. Keeping a FINDING alive on them is a different matter: with them in the
    // haystack a verdict whose every quote exists only in a hint sentence or in a
    // bibliographic record we printed counts as grounded in "the document", and the
    // demotion is the one mechanism standing between an invented quotation and the
    // report. So evidence that names a source file is grounded against the files, or
    // it is not grounded at all. Built from the per-file indexes that already exist,
    // because normalising the project a third time is not free.
    const documentQuoteSources = [...searchIndexes.map(index => index.normalized), rawSource]
    // Which haystacks may keep THIS evidence alive: a finding that names a file claims
    // to have read that file (pointsAtTheSources draws the same line for the vacuous
    // rule), while a chapter answering "the hints say there are no listings" claims
    // nothing about any file and keeps the wider haystack.
    const quoteSourcesFor = evidence =>
        evidenceClaimsAFile(evidence, strippedDocs) ? documentQuoteSources : quoteSources
    // A finding "points at something" when one of its quotes can be placed in a real
    // source file. Deliberately NOT the scan hints or the skeleton: those are things the
    // code told the model, and a chapter repeating a hint back has shown nothing about
    // the text it was asked to read.
    const pointsAtTheSources = result => locateEvidence(result.evidence, searchIndexes).length > 0

    // overleaf-lab: item index -> the file paths that produced a [per-file] verdict.
    // Verification uses it to re-check the finding against THOSE files only: a
    // per-file finding verified against the whole project would be re-judged in the
    // very lost-in-the-middle conditions the per-file split exists to avoid.
    const perFileOrigin = new Map()
    for (const step of plan) {
        // A cancel can land BETWEEN passes; stop before spending another model call
        // (an in-flight fetch is aborted by the shared controller signal instead).
        if (job.status === 'cancelled') {
            throw new Error('review cancelled between passes')
        }
        const i = step.indexes[0]
        const perFile = step.scope === 'file'
        // overleaf-lab: scope first (it removes the example lines, which is what brings
        // the check marker to the end of the text), then the check marker, then the scope
        // marker that the check marker was hiding behind. A rubric that stacks
        // "[per-file] [check: ...]" - which is how a requirement declares what it falls
        // back to when the check is switched off - otherwise printed "[per-file]" to the
        // student and showed it to the model.
        const requirement = stripScopeMarker(stripCheckMarker(stripScopeMarker(requirements[i])))

        // overleaf-lab: a requirement a fast review is not equipped to answer. The row
        // exists, it is n.a., and it says which button to press: see
        // notCheckedInFastMode for why it is never simply left out of the report.
        if (step.scope === 'model-only') {
            allItems.push(notCheckedInFastMode(requirement))
            refreshTotal()
            continue
        }

        // overleaf-lab: decided by code, no model call. The verdict is exact, it
        // cannot vary between runs, and it carries file:line straight from the parser
        // instead of hoping a quote can be matched back to the source afterwards.
        if (step.scope === 'code') {
            const name = requirementCheck(requirements[i])
            // overleaf-lab: not a parser over the sources but a call to a local
            // proof-reader, so it is awaited and it can fail. Everything else about it is
            // the same contract as a structural check: exact, deterministic, file:line.
            if (name === 'languagetool') {
                allItems.push(
                    await runLanguageToolItem(requirement, strippedDocs, reportLanguage, signal, projectId)
                )
                refreshTotal()
                continue
            }
            const outcome = withChecksLanguage(() => StructuralChecks.runCheck(name, strippedDocs))
            logger.debug(
                { projectId, check: name, status: outcome.status },
                '[LLM] compliance: structural check'
            )
            allItems.push({
                requirement,
                status: outcome.status,
                evidence: clip(outcome.evidence, EVIDENCE_MAX_CHARS),
                suggestion: '',
                locations: outcome.locations,
                sourceFiles: [...new Set(outcome.locations.map(l => l.path))],
                decidedByCode: true,
            })
            refreshTotal()
            continue
        }
        job.passesDone = completedPasses
        job.currentRequirement = requirement.replace(/\s+/g, ' ').slice(0, 160)
        mirrorProgress()

        // overleaf-lab: a whole-document requirement on a project that does not fit.
        // Recorded as n.a. with the reason spelled out, never quietly dropped: the
        // reader must be able to tell "checked and fine" from "not looked at".
        if (step.scope === 'document' && !documentFits) {
            allItems.push({
                requirement,
                status: 'na',
                evidence: L(
                    `Not checked: this requirement has to be judged on the whole document at once, ` +
                        `and the project (about ${promptTokens} tokens) does not fit in the ` +
                        `${maxContextTokens}-token context window. The requirements scoped to a chapter, ` +
                        `a file or the structure were checked normally.`,
                    `Non controllato: questo requisito va giudicato sull'intero documento in una volta sola, ` +
                        `e il progetto (circa ${promptTokens} token) non entra nella finestra di contesto ` +
                        `da ${maxContextTokens} token. I requisiti con ambito capitolo, file o struttura ` +
                        `sono stati controllati normalmente.`
                ),
                suggestion: L(
                    'Raise the context window of the review model, or mark this requirement ' +
                        '[per-chapter] or [structure] in the rubric if it can be judged locally.',
                    'Aumentare la finestra di contesto del modello di revisione, oppure marcare questo ' +
                        'requisito [per-chapter] o [structure] nella rubrica se è giudicabile localmente.'
                ),
            })
            completedPasses += 1
            job.passesDone = completedPasses
            mirrorProgress()
            refreshTotal()
            continue
        }

        // overleaf-lab: [per-candidate] branch. The code extracts the passages the
        // rubric's named pattern hits, the model answers yes/no per passage, and the
        // CODE assembles verdict and evidence from the source bytes. No search, no
        // transcription, no document in the prompt: the calls are tiny and work on
        // projects far beyond the context window.
        if (step.scope === 'candidates') {
            const label = requirementCandidateLabel(requirements[step.indexes[0]])
            job.currentRequirement = requirement.replace(/\s+/g, ' ').slice(0, 160)
            // The dashboard reads the mirrored copy, not the job object, so a label set
            // without this stays one requirement behind until the pass ends.
            mirrorProgress()
            const pattern = rubricPatterns.find(
                p => p.label.toLowerCase() === String(label || '').toLowerCase()
            )
            if (!pattern) {
                allItems.push({
                    requirement,
                    status: 'na',
                    evidence: L(
                        `The rubric marks this requirement [per-candidate: ${label}], but it ` +
                            `declares no scan pattern with that label. Add the pattern line ` +
                            `("${label} :: <regex>") next to the guidelines.`,
                        `La rubrica marca questo requisito [per-candidate: ${label}], ma non dichiara ` +
                            `nessun pattern di scansione con quell'etichetta. Aggiungere la riga del pattern ` +
                            `("${label} :: <regex>") accanto alle linee guida.`
                    ),
                    suggestion: '',
                })
            } else {
                // A passage inside an acronym declaration is not the author's prose:
                // \acro{DRY}{Don't Repeat Yourself} was judged a colloquialism by the
                // model itself (measured on the corpus). Every declaration form is
                // blanked before the scan, the hand-written list included, with the
                // checks module's own patterns so the two views can never disagree.
                // Offset-preserving: candidate line numbers stay the source's.
                const candidateDocs = strippedDocs.map(doc => ({
                    ...doc,
                    text: StructuralChecks.blankHandAcronymLists(
                        doc.text.replace(StructuralChecks.ACRONYM_DECLARATION, span =>
                            span.replace(/[^\n]/g, ' ')
                        )
                    ),
                }))
                const { candidates, total, hits } = collectCandidatePassages(
                    candidateDocs,
                    pattern.regex,
                    MAX_CANDIDATE_PASSAGES
                )
                if (candidates.length === 0) {
                    allItems.push({
                        requirement,
                        status: 'na',
                        evidence: L(
                            `No passage matches the "${pattern.label}" pattern, so nothing falls under this requirement.`,
                            `Nessun passaggio corrisponde al pattern "${pattern.label}", quindi niente ricade sotto questo requisito.`
                        ),
                        suggestion: '',
                    })
                } else {
                    const violating = []
                    let judged = 0
                    for (let b = 0; b < candidates.length; b += CANDIDATES_PER_CALL) {
                        if (job.status === 'cancelled') {
                            throw new Error('review cancelled between passes')
                        }
                        const batch = candidates.slice(b, b + CANDIDATES_PER_CALL)
                        const listText = batch
                            .map((c, k) => `${k + 1}. (${c.path}) "${c.text}"`)
                            .join('\n')
                        const body = {
                            model: reviewModelNow(),
                            messages: [
                                { role: 'system', content: CANDIDATES_SYSTEM_PROMPT },
                                {
                                    role: 'user',
                                    content:
                                        `REQUIREMENT:\n${preamble ? `${preamble}\n` : ''}${requirementWithExamples(
                                            requirements[step.indexes[0]],
                                            requirement
                                        )}\n\n` +
                                        `CANDIDATE PASSAGES (each with its surrounding context):\n${listText}\n\n` +
                                        `Answer with exactly ${batch.length} items, in this order.`,
                                },
                            ],
                            max_tokens: scopedPassBudget,
                            // overleaf-lab: deterministic, unlike the chapter passes.
                            // The sampling next door exists to feed a 2+1 vote; a
                            // single sample at that temperature is the vote's noise
                            // with none of its consensus, on the requirements measured
                            // as the noisiest. These are CLOSED questions with the
                            // passage in front of the model, which is the case where
                            // greedy decoding is the right default, and it costs
                            // nothing: the alternative was three times the calls to
                            // vote on a yes/no.
                            temperature: 0,
                            response_format: {
                                type: 'json_schema',
                                json_schema: {
                                    name: 'candidate_check',
                                    strict: true,
                                    schema: schemaForBatch(CANDIDATE_ITEMS_SCHEMA, batch.length),
                                },
                            },
                        }
                        const timeout = setTimeout(() => {
                            if (job.controller) {
                                job.controller.abort()
                            }
                        }, passTimeoutMs())
                        try {
                            const response = await reviewFetch(`${llmApiUrl}/chat/completions`, {
                                method: 'POST',
                                headers: chatHeaders,
                                body: JSON.stringify(body),
                                signal: job.controller ? job.controller.signal : undefined,
                            })
                            if (!response.ok) {
                                logger.warn(
                                    { projectId, status: response.status },
                                    '[LLM] compliance: candidate batch refused'
                                )
                                continue
                            }
                            const data = await response.json()
                            recordTimings(data && data.timings)
                            const parsed = extractJson(
                                stripThinkTags(data?.choices?.[0]?.message?.content || '')
                            )
                            const answers = Array.isArray(parsed.items) ? parsed.items : []
                            // By the index the model was made to emit, position only as
                            // the fallback (see reconcileAnswers).
                            const resolved = reconcileAnswers(answers, batch.length)
                            for (const [k, candidate] of batch.entries()) {
                                // An unanswered candidate is unanswered, never guessed.
                                const answer = resolved.get(k)
                                if (!answer) continue
                                judged += 1
                                if (answer.violates === 'yes') {
                                    violating.push({
                                        ...candidate,
                                        reason: clip(
                                            repairJsonEscapeArtifacts(answer.reason || ''),
                                            200
                                        ),
                                    })
                                }
                            }
                        } catch (err) {
                            if (job.status === 'cancelled' || stopsTheReview(err)) {
                                throw err
                            }
                            logger.warn(
                                { projectId, err },
                                '[LLM] compliance: candidate batch failed'
                            )
                        } finally {
                            clearTimeout(timeout)
                        }
                    }
                    // What was left out, and why. `total` is how many distinct passages
                    // the pattern found, `hits` how many times it fired inside them,
                    // `judged` how many the model actually answered about. Every gap
                    // between those is said out loud: an unanswered batch used to leave
                    // its passages unjudged while the verdict below still read "each of
                    // the N passages was judged", which is a pass over text nobody
                    // looked at.
                    const capNote =
                        (total > candidates.length
                            ? L(
                                  ` The pattern finds ${total} passages; the first ${candidates.length} were judged.`,
                                  ` Il pattern trova ${total} passaggi; sono stati giudicati i primi ${candidates.length}.`
                              )
                            : hits > total
                              ? L(
                                    ` The pattern fires ${hits} times inside ${total} passages, each judged once.`,
                                    ` Il pattern scatta ${hits} volte dentro ${total} passaggi, giudicati una volta ciascuno.`
                                )
                              : '') +
                        (judged < candidates.length
                            ? L(
                                  ` ${candidates.length - judged} of the ${candidates.length} passages sent for judging got no answer back and were NOT checked.`,
                                  ` ${candidates.length - judged} dei ${candidates.length} passaggi inviati non hanno ricevuto risposta e NON sono stati controllati.`
                              )
                            : '')
                    if (judged === 0) {
                        allItems.push({
                            requirement,
                            status: 'na',
                            evidence: L(
                                `The ${candidates.length} candidate passages could not be checked (backend error).`,
                                `Non è stato possibile controllare i ${candidates.length} passaggi candidati (errore del backend).`
                            ),
                            suggestion: '',
                            // Not "nothing applied here": nothing answered. See below.
                            modelFailure: true,
                        })
                    } else if (violating.length === 0) {
                        allItems.push({
                            requirement,
                            sourceFiles: [...new Set(candidates.map(c => c.path))].slice(0, 8),
                            status: 'ok',
                            // "Each of the N" is only true when every candidate came
                            // back answered. When some did not, the sentence has to say
                            // how many WERE judged instead of quietly narrowing what
                            // "each" means: with 40 candidates and 5 answers the old
                            // wording shipped an `ok` over 35 passages nobody looked at.
                            evidence:
                                (judged < candidates.length
                                    ? L(
                                          `${judged} of the ${candidates.length} passages flagged by the "${pattern.label}" pattern ` +
                                              `were judged individually with their surrounding context; none of those violates the requirement.`,
                                          `${judged} dei ${candidates.length} passaggi segnalati dal pattern "${pattern.label}" ` +
                                              `sono stati giudicati singolarmente insieme al contesto che li circonda; nessuno di questi viola il requisito.`
                                      )
                                    : L(
                                          `Each of the ${judged} passages flagged by the "${pattern.label}" pattern ` +
                                              `was judged individually with its surrounding context; none violates the requirement.`,
                                          `Ognuno dei ${judged} passaggi segnalati dal pattern "${pattern.label}" ` +
                                              `è stato giudicato singolarmente insieme al contesto che lo circonda; nessuno viola il requisito.`
                                      )) + capNote,
                            suggestion: '',
                        })
                    } else {
                        const shown = violating.slice(0, 12)
                        const list = shown
                            .map(v => `${v.path}: "${v.text.slice(0, 180)}" (${v.reason})`)
                            .join(' | ')
                        const more =
                            violating.length > shown.length
                                ? L(
                                      ` | ...and ${violating.length - shown.length} more`,
                                      ` | ...e altri ${violating.length - shown.length}`
                                  )
                                : ''
                        allItems.push({
                            requirement,
                            sourceFiles: [...new Set(violating.map(c => c.path))].slice(0, 8),
                            status: 'missing',
                            evidence: clip(
                                L(
                                    `${violating.length} of ${judged} candidate passages violate it: `,
                                    `${violating.length} passaggi candidati su ${judged} lo violano: `
                                ) +
                                    list +
                                    more +
                                    capNote,
                                EVIDENCE_MAX_CHARS
                            ),
                            suggestion: '',
                        })
                    }
                }
            }
            completedPasses += 1
            job.passesDone = completedPasses
            mirrorProgress()
            refreshTotal()
            continue
        }

        // overleaf-lab: [per-chapter] branch. Same shape as [per-file] below, with
        // chapters as the unit and SEVERAL requirements bundled into one call, which
        // is what keeps the pass count near today's instead of multiplying it by the
        // number of chapters (see PER_CHAPTER_GROUP_SIZE).
        if (step.scope === 'chapter') {
            const groupRequirements = step.indexes.map(k => stripScopeMarker(requirements[k]))
            const perRequirementResults = step.indexes.map(() => [])
            // The LaTeX material each requirement of the group is about, read from the
            // requirement itself (see REQUIREMENT_MATERIAL). Computed once per group:
            // it is used per chapter below and again on the merged verdict.
            const groupMaterial = step.indexes.map(k => requirementMaterial(requirements[k]))
            for (let s = 0; s < segments.length; s++) {
                if (job.status === 'cancelled') {
                    throw new Error('review cancelled between passes')
                }
                const segment = segments[s]
                const segmentSource = segmentText(segment)
                job.currentRequirement =
                    `${groupRequirements[0]} (chapter ${s + 1}/${segments.length}: ${segment.title})`
                        .replace(/\s+/g, ' ')
                        .slice(0, 160)
                // Each requirement carries its own examples, right under its own number:
                // a shared block at the end of the list would leave the model to guess
                // which requirement each example belongs to.
                const numbered = groupRequirements
                    .map(
                        (text, n) =>
                            `${n + 1}. ${requirementWithExamples(
                                requirements[step.indexes[n]],
                                text
                            )}`
                    )
                    .join('\n')
                const subBody = {
                    model: reviewModelNow(),
                    messages: [
                        { role: 'system', content: prompts.reviewSystemPrompt },
                        {
                            role: 'user',
                            content:
                                `DOCUMENT (one chapter of a larger project: "${segment.title}"):\n` +
                                `${segmentSource}\n\n` +
                                // The hints are computed by code over the WHOLE project and
                                // are true of it: cross-references and citation keys are
                                // global by nature, and recomputing them per chapter would
                                // invent broken references out of a label defined elsewhere.
                                `${scanHints}\n\n` +
                                `GUIDELINES (check ONLY these, in THIS chapter only):\n` +
                                `${preamble ? `${preamble}\n` : ''}${numbered}\n\n` +
                                `Answer with exactly ${groupRequirements.length} items, in this order, ` +
                                `one per numbered guideline. Use "na" for a guideline that does not ` +
                                `apply to this chapter (for instance a rule about figures in a ` +
                                `chapter that has none): "na" is the correct answer there, not "ok".` +
                                ANSWER_LANGUAGE_NOTE,
                        },
                    ],
                    max_tokens: scopedPassBudget,
                    // Voting needs sample diversity; a single shot keeps the old
                    // deterministic setting.
                    temperature: CHAPTER_VOTE_SAMPLES > 1 ? VOTE_TEMPERATURE : 0,
                    ...(CHAPTER_VOTE_SAMPLES > 1 ? { top_p: VOTE_TOP_P } : {}),
                    response_format: {
                        type: 'json_schema',
                        json_schema: {
                            name: 'compliance_review',
                            strict: true,
                            // One answer per numbered guideline, enforced by the
                            // grammar: the mapping below is positional and nothing else
                            // constrained the length, so a short answer moved every
                            // later verdict onto the wrong requirement.
                            schema: schemaForBatch(REVIEW_ITEMS_SCHEMA, groupRequirements.length),
                        },
                    },
                }
                const fallback = reason => {
                    for (const results of perRequirementResults) {
                        results.push({
                            path: segment.title,
                            status: 'na',
                            evidence: reason,
                            suggestion: '',
                            // The chapter has no verdict because nothing answered, not
                            // because nothing applied: see mergeFileItems.
                            modelFailure: true,
                        })
                    }
                }
                // One sample: send the SAME body once and return the items array, or
                // null with the refusal recorded. Cancellation and aborts still
                // propagate as throws, exactly as the single-shot version did.
                let lastFailure = L('no answer for this chapter', 'nessuna risposta per questo capitolo')
                const askOnce = async () => {
                    const subTimeout = setTimeout(() => {
                        if (job.controller) {
                            job.controller.abort()
                        }
                    }, passTimeoutMs())
                    try {
                        const response = await reviewFetch(`${llmApiUrl}/chat/completions`, {
                            method: 'POST',
                            headers: chatHeaders,
                            body: JSON.stringify(subBody),
                            signal: job.controller ? job.controller.signal : undefined,
                        })
                        if (!response.ok) {
                            logger.warn(
                                { projectId, chapter: segment.title, status: response.status },
                                '[LLM] compliance: per-chapter sub-pass refused'
                            )
                            lastFailure = L(
                                `check refused (HTTP ${response.status})`,
                                `controllo rifiutato (HTTP ${response.status})`
                            )
                            return null
                        }
                        const data = await response.json()
                        recordTimings(data && data.timings)
                        const content = stripThinkTags(
                            data?.choices?.[0]?.message?.content || ''
                        )
                        try {
                            const parsed = extractJson(content)
                            return Array.isArray(parsed.items) ? parsed.items : []
                        } catch (err) {
                            lastFailure = L(
                                'unparseable answer for this chapter',
                                'risposta non interpretabile per questo capitolo'
                            )
                            return null
                        }
                    } catch (err) {
                        if (job.status === 'cancelled' || stopsTheReview(err)) {
                            throw err
                        }
                        logger.warn(
                            { projectId, chapter: segment.title, err },
                            '[LLM] compliance: per-chapter sub-pass failed'
                        )
                        lastFailure = L(
                            `check failed (${err.message})`,
                            `controllo non riuscito (${err.message})`
                        )
                        return null
                    } finally {
                        clearTimeout(subTimeout)
                    }
                }
                // Positional mapping, and a missing position becomes n.a. rather than
                // borrowing the neighbour's verdict: a short answer must cost
                // coverage, never correctness.
                const normalize = item => ({
                    status:
                        item && ['ok', 'partial', 'missing', 'na'].includes(item.status)
                            ? item.status
                            : 'na',
                    evidence:
                        (item && item.evidence) ||
                        L(
                            'no answer for this guideline in this chapter',
                            'nessuna risposta per questa linea guida in questo capitolo'
                        ),
                    suggestion: (item && item.suggestion) || '',
                })
                const samples = []
                for (let v = 0; v < CHAPTER_VOTE_SAMPLES; v++) {
                    if (job.status === 'cancelled') {
                        throw new Error('review cancelled between passes')
                    }
                    const items = await askOnce()
                    if (items) samples.push(items)
                }
                // A third opinion only when the first two disagree somewhere in the
                // group; it costs one call and settles every requirement of the group.
                if (
                    samples.length >= 2 &&
                    groupRequirements.some(
                        (_, n) => normalize(samples[0][n]).status !== normalize(samples[1][n]).status
                    )
                ) {
                    // Logged so the split rate is measurable from a run's logs: a
                    // rate near zero would mean the two samples nearly always agree
                    // and the second one is not buying much.
                    logger.info(
                        { projectId, chapter: segment.title },
                        '[LLM] compliance: chapter vote split, taking a third reading'
                    )
                    const extra = await askOnce()
                    if (extra) samples.push(extra)
                }
                if (samples.length === 0) {
                    fallback(lastFailure)
                } else {
                    for (const [n, results] of perRequirementResults.entries()) {
                        const votes = samples.map(items => normalize(items[n]))
                        // Majority status, first-seen order breaking ties; then the
                        // richest evidence among the samples that voted for it, so a
                        // verdict never ships with another verdict's justification.
                        const count = new Map()
                        for (const vote of votes) {
                            count.set(vote.status, (count.get(vote.status) || 0) + 1)
                        }
                        let chosen = votes[0]
                        for (const vote of votes) {
                            if (count.get(vote.status) > count.get(chosen.status)) chosen = vote
                        }
                        for (const vote of votes) {
                            if (
                                vote.status === chosen.status &&
                                String(vote.evidence).length > String(chosen.evidence).length
                            ) {
                                chosen = vote
                            }
                        }
                        // A split vote is exactly the borderline judgement the
                        // reader deserves to know about: the report says so instead
                        // of presenting a 2-1 as a certainty.
                        const agreeing = count.get(chosen.status)
                        // The two readers match this marker by regex, so both spellings
                        // are part of the contract: keep the shape, translate the words.
                        const contested =
                            samples.length > 1 && agreeing < samples.length
                                ? L(
                                      ` [verdict agreed by ${agreeing} of ${samples.length} readings]`,
                                      ` [verdetto concorde in ${agreeing} letture su ${samples.length}]`
                                  )
                                : ''
                        const result = {
                            path: segment.title,
                            status: chosen.status,
                            evidence: clip(
                                repairJsonEscapeArtifacts(chosen.evidence) + contested,
                                PER_FILE_FIELD_MAX_CHARS
                            ),
                            suggestion: clip(
                                repairJsonEscapeArtifacts(chosen.suggestion),
                                PER_FILE_FIELD_MAX_CHARS
                            ),
                        }
                        // A chapter verdict whose every quote is absent from the project
                        // is dropped here, before it can decide the merged verdict.
                        demoteFabricatedResult(result, quoteSourcesFor(result.evidence))
                        // And an n.a. from a chapter that HOLDS the material the
                        // requirement is about is recorded, so the merge cannot pass it
                        // off as "nothing to check here". A chapter demoted just above
                        // counts here too: its evidence was thrown away, so that chapter
                        // is exactly a chapter nobody assessed, and exempting it let a
                        // requirement come back "ok" with no trace that the chapter
                        // carrying its material had its answer discarded.
                        if (result.status === 'na') {
                            const candidates = countMaterial(groupMaterial[n], segmentSource)
                            if (candidates > 0) {
                                result.unassessed = candidates
                            }
                        }
                        results.push(result)
                    }
                }
                completedPasses += 1
                job.passesDone = completedPasses
                mirrorProgress()
            }
            for (const [n, results] of perRequirementResults.entries()) {
                const merged = mergeFileItems(groupRequirements[n], results, 'chapters')
                // A requirement about material the project does not contain cannot be
                // "met" by a chapter that had nothing to look at (see
                // applyVacuousRequirement). Counted over the assembled document, which
                // is what "in the whole project" means here.
                applyVacuousRequirement(
                    merged,
                    results,
                    groupMaterial[n],
                    countMaterial(groupMaterial[n], assembled),
                    pointsAtTheSources
                )
                if (merged.status === 'missing' || merged.status === 'partial') {
                    // Origin as FILE PATHS, because verification re-reads files: a
                    // chapter maps back to the files its text came from.
                    // overleaf-lab: which files a dissenting chapter really lives in.
                    //
                    // NOT simply every path the segment touches. A chapter runs from
                    // its \chapter to the next one, so its last fragment is the handful
                    // of characters at the top of the FOLLOWING file, before that
                    // file's own \chapter. Counting those slivers put findings about
                    // chapters 2 and 3 under /Frontmatter/abstract.tex, because the
                    // report files each finding under one path and abstract.tex sorts
                    // first. A file earns the attribution only if it carries a real
                    // share of the chapter.
                    const contribution = new Map()
                    for (const [s, segment] of segments.entries()) {
                        if (!results[s] || results[s].status !== merged.status) {
                            continue
                        }
                        const total = segment.docs.reduce((n, d) => n + d.text.length, 0) || 1
                        for (const d of segment.docs) {
                            if (d.text.length / total < CHAPTER_FILE_SHARE) {
                                continue
                            }
                            contribution.set(
                                d.path,
                                (contribution.get(d.path) || 0) + d.text.length
                            )
                        }
                    }
                    // Biggest contributor first: the report takes the head of this
                    // list as the finding's home, so the order is the answer to
                    // "which file should the reader open first".
                    const dissenting = [...contribution.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .map(([path]) => path)
                    perFileOrigin.set(allItems.length, dissenting)
                    // overleaf-lab: the files this finding came from, carried in the
                    // item itself. Quote grounding places a finding only when its
                    // quote can be matched in the source, which on the last report was
                    // three findings out of ten; a chapter-scoped finding always knows
                    // which files it was read from, even when the quote cannot be
                    // matched, and that is enough to file it under the right document.
                    merged.sourceFiles = byEvidenceWeight(dissenting, merged.evidence)
                }
                allItems.push(merged)
            }
            refreshTotal()
            continue
        }

        // overleaf-lab: [per-file] branch. One sub-pass per source file, each with
        // ONLY that file in context (fully attended, no lost-in-the-middle), merged
        // into a single report item. This deliberately gives up the shared document
        // cache prefix: the sub-pass prompts are small, so the total prefill is about
        // one extra read of the project. Lean by design: no retry (small prompts do
        // not truncate), a failed file becomes "n.a." for that file only.
        if (perFile) {
            const fileResults = []
            for (let f = 0; f < strippedDocs.length; f++) {
                if (job.status === 'cancelled') {
                    throw new Error('review cancelled between passes')
                }
                const doc = strippedDocs[f]
                job.currentRequirement = `${requirement} (file ${f + 1}/${strippedDocs.length}: ${doc.path})`
                    .replace(/\s+/g, ' ')
                    .slice(0, 160)
                const subBody = {
                    model: reviewModelNow(),
                    messages: [
                        { role: 'system', content: prompts.reviewSystemPrompt },
                        {
                            role: 'user',
                            content:
                                `DOCUMENT (one file of a larger project):\n% ===== FILE: ${doc.path} =====\n${doc.text}\n\n` +
                                `GUIDELINES (check ONLY these, in THIS file only):\n${
                                    preamble ? `${preamble}\n` : ''
                                }${requirementWithExamples(
                                    requirements[i],
                                    requirement
                                )}${ANSWER_LANGUAGE_NOTE}`,
                        },
                    ],
                    max_tokens: scopedPassBudget,
                    temperature: 0,
                    response_format: {
                        type: 'json_schema',
                        json_schema: {
                            name: 'compliance_review',
                            strict: true,
                            schema: REVIEW_ITEMS_SCHEMA,
                        },
                    },
                }
                const subTimeout = setTimeout(() => {
                    if (job.controller) {
                        job.controller.abort()
                    }
                }, passTimeoutMs())
                try {
                    const response = await reviewFetch(`${llmApiUrl}/chat/completions`, {
                        method: 'POST',
                        headers: chatHeaders,
                        body: JSON.stringify(subBody),
                        signal: job.controller ? job.controller.signal : undefined,
                    })
                    if (!response.ok) {
                        const errorText = await response.text()
                        logger.warn(
                            { projectId, pass: i, file: doc.path, status: response.status },
                            '[LLM] compliance: per-file sub-pass refused'
                        )
                        fileResults.push({
                            path: doc.path,
                            status: 'na',
                            evidence: L(
                                `check refused (HTTP ${response.status})`,
                                `controllo rifiutato (HTTP ${response.status})`
                            ),
                            suggestion: '',
                            modelFailure: true,
                        })
                    } else {
                        const data = await response.json()
                        recordTimings(data && data.timings)
                        const content = stripThinkTags(
                            data?.choices?.[0]?.message?.content || ''
                        )
                        try {
                            const parsed = extractJson(content)
                            const first = Array.isArray(parsed.items) ? parsed.items[0] : null
                            const result = {
                                path: doc.path,
                                status:
                                    first &&
                                    ['ok', 'partial', 'missing', 'na'].includes(first.status)
                                        ? first.status
                                        : 'na',
                                evidence: clip(
                                    repairJsonEscapeArtifacts((first && first.evidence) || ''),
                                    PER_FILE_FIELD_MAX_CHARS
                                ),
                                suggestion: clip(
                                    repairJsonEscapeArtifacts((first && first.suggestion) || ''),
                                    PER_FILE_FIELD_MAX_CHARS
                                ),
                            }
                            // Same rule as the chapter branch: a file verdict supported
                            // only by text the project does not contain is dropped
                            // before it can set the merged verdict.
                            demoteFabricatedResult(result, quoteSourcesFor(result.evidence))
                            fileResults.push(result)
                        } catch (err) {
                            fileResults.push({
                                path: doc.path,
                                status: 'na',
                                evidence: L(
                                    'unparseable answer for this file',
                                    'risposta non interpretabile per questo file'
                                ),
                                suggestion: '',
                                modelFailure: true,
                            })
                        }
                    }
                } catch (err) {
                    if (job.status === 'cancelled' || stopsTheReview(err)) {
                        throw err
                    }
                    logger.warn(
                        { projectId, pass: i, file: doc.path, err },
                        '[LLM] compliance: per-file sub-pass failed'
                    )
                    fileResults.push({
                        path: doc.path,
                        status: 'na',
                        evidence: L(
                            `check failed (${err.message})`,
                            `controllo non riuscito (${err.message})`
                        ),
                        suggestion: '',
                        modelFailure: true,
                    })
                } finally {
                    clearTimeout(subTimeout)
                }
                completedPasses += 1
                job.passesDone = completedPasses
                mirrorProgress()
            }
            const merged = mergeFileItems(requirement, fileResults)
            if (merged.status === 'missing' || merged.status === 'partial') {
                const dissenting = fileResults
                    .filter(r => r.status === merged.status)
                    .map(r => r.path)
                perFileOrigin.set(allItems.length, dissenting)
                // Same reason as in the chapter branch: a finding that knows which
                // file it came from can be filed under it without a matched quote.
                merged.sourceFiles = byEvidenceWeight(dissenting, merged.evidence)
            }
            allItems.push(merged)
            // The per-file branch leaves the loop before the shared finally below,
            // so it refreshes the announced total itself.
            refreshTotal()
            continue
        }

        // overleaf-lab: a [structure] requirement reads the skeleton instead of the
        // document. Everything after this point (retry, parsing, grounding,
        // verification) is deliberately shared with the whole-document pass: the two
        // differ in WHAT THEY READ and in nothing else.
        // The scan hints come along: several structural requirements (do the
        // cross-references resolve, is the acronym list aligned with the text, are the
        // bibliography entries complete) are answered ENTIRELY by facts the code
        // computed over the whole project, and a skeleton without them would ask the
        // model to guess at exactly the questions that already have an exact answer.
        const readBlock =
            step.scope === 'structure'
                ? `DOCUMENT:\n${skeleton}\n\n${scanHints}\n\n`
                : documentBlock
        const requestBody = {
            model: reviewModelNow(),
            messages: [
                { role: 'system', content: prompts.reviewSystemPrompt },
                {
                    role: 'user',
                    content:
                        readBlock +
                        guidelinesFor(requirementWithExamples(requirements[i], requirement)),
                },
            ],
            max_tokens: step.scope === 'structure' ? scopedPassBudget : perPassBudget,
            // overleaf-lab: greedy decoding, so re-running the review on an unchanged
            // document yields stable verdicts. A compliance report that flips between
            // runs (observed at 0.2: the same requirement went missing -> ok with no
            // document change) reads as a lottery to the person fixing the document.
            temperature: 0,
            // overleaf-lab: constrain the answer to the per-pass JSON shape (see
            // REVIEW_ITEMS_SCHEMA). Guarantees parseable output and, because prose is
            // forbidden, prevents a reasoning model from burning the budget on
            // thinking. enable_thinking:false for a local reasoning model is handled
            // at the router (llama-only), not here, staying portable to cloud backends.
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'compliance_review',
                    strict: true,
                    schema: REVIEW_ITEMS_SCHEMA,
                },
            },
        }

        // Re-armable, because the brevity retry below is a SECOND attempt under what
        // was budgeted as one. The retry only happens when the first answer used the
        // whole token budget, i.e. when most of this timer is already spent, so a
        // single arming would abort mid-retry and kill the entire review (every
        // completed pass discarded) exactly in the slow case the timer exists for.
        let timeout = setTimeout(() => {
            if (job.controller) {
                job.controller.abort()
            }
        }, passTimeoutMs())
        const rearmPassTimeout = () => {
            clearTimeout(timeout)
            timeout = setTimeout(() => {
                if (job.controller) {
                    job.controller.abort()
                }
            }, passTimeoutMs())
        }
        try {
            const response = await reviewFetch(`${llmApiUrl}/chat/completions`, {
                method: 'POST',
                headers: chatHeaders,
                body: JSON.stringify(requestBody),
                // overleaf-lab: job signal, so cancel (and the pass timeout) abort it.
                signal: job.controller ? job.controller.signal : undefined,
            })

            if (!response.ok) {
                const errorText = await response.text()
                logger.error(
                    { projectId, userId, status: response.status, pass: i, error: errorText },
                    '[LLM] compliance: LLM API error'
                )
                const backendError = parseBackendError(errorText)

                // overleaf-lab: a context overflow means the DOCUMENT does not fit, so
                // every other pass would fail identically: fail the whole job, with the
                // backend's real numbers (they beat our own estimate).
                if (backendError.isContext) {
                    return {
                        type: 'error',
                        errorCode: 'too_long',
                        message:
                            'The document is too long for the review model context window',
                        documentTokensEstimate:
                            backendError.promptTokens || promptTokens,
                        maxContextTokens:
                            backendError.contextTokens || maxContextTokens,
                        reviewMaxTokens: perPassBudget,
                    }
                }

                // Any other refusal: record THIS requirement as unverifiable and move
                // on, so one bad pass no longer kills the other N-1.
                // `requirement`, the full text, NOT job.currentRequirement: that one
                // is display-truncated to 160 chars, and an item keyed by it never
                // matches the same requirement's full-text key in the store, so the
                // delta silently dropped the requirement from the comparison and
                // reported "no verdict changed" over a run that measured one less.
                allItems.push({
                    requirement,
                    status: 'na',
                    evidence: L(
                        `The check could not run (HTTP ${response.status}${
                            backendError.message
                                ? `: ${backendError.message.slice(0, 200)}`
                                : ''
                        })`,
                        `Non è stato possibile eseguire il controllo (HTTP ${response.status}${
                            backendError.message
                                ? `: ${backendError.message.slice(0, 200)}`
                                : ''
                        })`
                    ),
                    suggestion: '',
                    modelFailure: true,
                })
                continue
            }

            let data = await response.json()
            // overleaf-lab: a full-size prefill is the best throughput measurement
            // there is; cache-hit passes are rejected by the sample-size gate.
            recordTimings(data && data.timings)
            let content = stripThinkTags(data?.choices?.[0]?.message?.content || '')

            // overleaf-lab: parse, with ONE retry on an unusable answer. The typical
            // cause is a broad requirement (e.g. "check every citation") whose analysis
            // enumeration blows the per-pass budget: the grammar-constrained JSON gets
            // cut mid-way (finish_reason 'length') and cannot be parsed. The retry adds
            // an explicit brevity instruction; thanks to the prompt cache it only pays
            // its own generation, not another document prefill.
            let parsed = null
            for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
                if (attempt === 1) {
                    logger.warn(
                        {
                            projectId,
                            pass: i,
                            truncated: data?.choices?.[0]?.finish_reason === 'length',
                        },
                        '[LLM] compliance: pass answer unusable, retrying with brevity note'
                    )
                    const retryBody = {
                        ...requestBody,
                        messages: [
                            {
                                role: 'system',
                                content: `${prompts.reviewSystemPrompt}\n\nIMPORTANT: your previous answer was unusable (likely cut off by the token budget). Be drastically more concise: keep "analysis" under 80 words, report counts instead of lists, and quote at most three short examples in "evidence".`,
                            },
                            requestBody.messages[1],
                        ],
                    }
                    rearmPassTimeout()
                    const retryResponse = await reviewFetch(`${llmApiUrl}/chat/completions`, {
                        method: 'POST',
                        headers: chatHeaders,
                        body: JSON.stringify(retryBody),
                        signal: job.controller ? job.controller.signal : undefined,
                    })
                    if (!retryResponse.ok) {
                        break
                    }
                    data = await retryResponse.json()
                    recordTimings(data && data.timings)
                    content = stripThinkTags(data?.choices?.[0]?.message?.content || '')
                }
                try {
                    parsed = extractJson(content)
                } catch (err) {
                    parsed = null
                }
            }
            if (parsed === null) {
                logger.warn(
                    { projectId, pass: i },
                    '[LLM] compliance: pass answer unusable twice, marking na'
                )
                allItems.push({
                    // Full text, not the truncated display string: see the refusal
                    // item above for what the truncation did to the delta.
                    requirement,
                    status: 'na',
                    evidence: L(
                        'The check produced an unusable answer twice (likely the analysis exceeded the per-pass token budget)',
                        'Il controllo ha prodotto due volte una risposta inutilizzabile (probabilmente l\'analisi ha superato il budget di token del passaggio)'
                    ),
                    suggestion: L(
                        'Consider splitting this requirement into narrower ones in the rubric',
                        'Valutare di spezzare questo requisito in requisiti più stretti nella rubrica'
                    ),
                    // overleaf-lab: "n.a." because nothing applied and "n.a." because
                    // the model never produced an answer are the same word and opposite
                    // facts, and only the second one is a reason to look at the run.
                    // The flag is what lets the history and the dashboards tell them
                    // apart; no tally counts it differently, the status is still n.a.
                    modelFailure: true,
                })
                continue
            }

            // overleaf-lab: "analysis" is dropped on purpose: its job was forcing the
            // model to look before judging, and that job ends at generation time.
            // Evidence/suggestion are HARD-capped in code: the prompt asks for
            // compact evidence but the model sometimes dumps whole environments
            // anyway, and a report is read by a human. Enumerations belong in
            // "analysis", which has already served its purpose.
            // overleaf-lab: the requirement label is the RUBRIC'S, not the model's.
            // A pass checks one known requirement, so letting the model restate it
            // buys nothing and costs real errors: models were observed labelling a
            // pass's item with a different requirement's text, which surfaced as the
            // same requirement repeated several times in one report while the
            // requirement actually checked went missing from it.
            const passItems = Array.isArray(parsed.items)
                ? parsed.items.map(it => ({
                      requirement,
                      status: ['ok', 'partial', 'missing', 'na'].includes(it.status)
                          ? it.status
                          : 'na',
                      evidence: clip(repairJsonEscapeArtifacts(it.evidence || ''), EVIDENCE_MAX_CHARS),
                      suggestion: clip(
                          repairJsonEscapeArtifacts(it.suggestion || ''),
                          SUGGESTION_MAX_CHARS
                      ),
                  }))
                : []
            // overleaf-lab: a finding whose every quote is absent from both the text
            // this pass was shown and the raw project is dropped BEFORE the verdict is
            // read off it (see dropFabricatedItems). What is left decides the
            // requirement, exactly as if the pass had never made the invented claim.
            const usableItems = dropFabricatedItems(passItems, quoteSourcesFor)
            if (passItems.length > 0 && usableItems.length === 0) {
                // Every finding of the pass was invented, so this pass produced nothing
                // usable and the requirement has no verdict. Said out loud, with what
                // the check claimed, because a reader who is told "not assessed" can go
                // and look while a reader shown a clean "ok" cannot.
                logger.warn(
                    { projectId, pass: i },
                    '[LLM] compliance: every finding of the pass quoted text absent from the project'
                )
                allItems.push({
                    requirement,
                    status: 'na',
                    evidence: clip(
                        L(
                            'Not assessed: the check reported findings whose quoted text is in neither the reviewed document nor the project sources, so they were dropped. What it reported: ',
                            'Non valutato: il controllo ha riportato rilievi il cui testo citato non è né nel documento in review né nei sorgenti del progetto, quindi sono stati scartati. Quanto riportava: '
                        ) + passItems.map(it => it.evidence).join(' | '),
                        EVIDENCE_MAX_CHARS
                    ),
                    suggestion: '',
                })
            } else {
                // A pass that emits several items for its one requirement (a compound
                // requirement split by the model) is folded back into one item per
                // status, so the report shows one line per requirement per verdict
                // instead of near-identical repeated blocks.
                allItems.push(...mergePassItems(usableItems))
            }
        } catch (err) {
            // An abort (user cancel or the pass timeout) must stop the whole review;
            // anything else downgrades to an unverifiable requirement.
            if (job.status === 'cancelled' || stopsTheReview(err)) {
                throw err
            }
            logger.warn({ projectId, pass: i, err }, '[LLM] compliance: pass failed')
            allItems.push({
                // Full text, not the truncated display string: see the refusal item
                // above for what the truncation did to the delta.
                requirement,
                status: 'na',
                evidence: L(
                    `The check failed (${err.message})`,
                    `Il controllo non è riuscito (${err.message})`
                ),
                suggestion: '',
                modelFailure: true,
            })
        } finally {
            clearTimeout(timeout)
            // In the finally so the `continue` paths (refusal, unparseable) count too.
            completedPasses += 1
            job.passesDone = completedPasses
            // Keep the announced total in step with the findings so far.
            refreshTotal()
            mirrorProgress()
        }
    }
    job.passesDone = completedPasses
    job.currentRequirement = ''
    refreshTotal()

    // overleaf-lab: adversarial verification. Reviewer verdicts on the hardest checks
    // (e.g. matching every number with a nearby \cite across a whole thesis) are
    // noisy, and a false "missing" is the most harmful outcome a review can produce.
    // Each selected item gets one dedicated pass (riding the same document
    // prompt-cache prefix) where the model must test whether the finding holds up;
    // refuted evidence is dropped, fully refuted findings flip to ok, and an "ok"
    // whose quotes fail the mechanical grounding check gets its evidence re-grounded
    // or its status downgraded. Best-effort: a failed verification keeps the original
    // finding. Clean OK items are not re-verified, since doubling the whole review's
    // cost to double-check its successes is not worth it.
    // overleaf-lab: mechanical quote grounding feeds the selection: an item whose
    // evidence quotes text the source does not contain is a judge hallucination
    // suspect REGARDLESS of its status, so an "ok" propped up by fabricated quotes
    // gets double-checked too. Negatives keep priority for the capped slots.
    const indicesToVerify = []
    const consider = predicate => {
        // overleaf-lab: a fast review selects nothing, because a verification IS a
        // model call. It would already select nothing by the two rules below - every
        // item it produces is either decided by code or n.a. - but "no model call can
        // happen here" is the promise on the button, and a promise that holds only as
        // a consequence of two other rules is one edit away from not holding.
        if (fast) {
            return
        }
        for (const [k, item] of allItems.entries()) {
            // overleaf-lab: never send a code-decided verdict to the model. The
            // verification pass exists because model verdicts are noisy; a parser's
            // count of uncaptioned floats is not, and letting a second model call
            // overturn it would trade an exact answer for an opinion. It would also
            // waste the slot on the one finding that cannot be wrong.
            if (item.decidedByCode) {
                continue
            }
            if (
                indicesToVerify.length < VERIFY_MAX_FINDINGS &&
                !indicesToVerify.includes(k) &&
                predicate(k, item)
            ) {
                indicesToVerify.push(k)
            }
        }
    }
    const isNegative = item => item.status === 'missing' || item.status === 'partial'
    // Priority order for the capped slots, most error-prone first:
    // 1. a [per-file] verdict decided by a SINGLE dissenting file (one file's
    //    hallucination is enough to set the whole requirement, so it is the finding
    //    most likely to be wrong and the cheapest to re-check),
    // 2. the remaining negatives,
    // 3. items of any status whose quotes failed the mechanical grounding check.
    consider((k, item) => isNegative(item) && (perFileOrigin.get(k) || []).length === 1)
    consider((k, item) => isNegative(item))
    // overleaf-lab: ...but never an item that already says "not assessed". It has no
    // verdict to defend, and the one thing a verification of it can produce is a
    // verdict built on the quotes that got the finding dropped in the first place:
    // measured on the stubbed end-to-end run, every finding demoted for fabricated
    // evidence came back as a violation through this door.
    consider((k, item) => item.status !== 'na' && groundingByItem[k].missing > 0)
    // overleaf-lab: if the cap ever binds, say so in the log. It cannot with the
    // rubrics in use (fewer requirements than the cap), but a silent truncation here
    // means some findings are presented exactly like the double-checked ones while
    // nobody looked at them twice, and that is the kind of thing that has to be
    // noisy the day it starts happening.
    if (indicesToVerify.length >= VERIFY_MAX_FINDINGS) {
        logger.warn(
            { projectId, cap: VERIFY_MAX_FINDINGS, items: allItems.length },
            '[LLM] compliance: verification cap reached, some findings were not double-checked'
        )
    }
    if (indicesToVerify.length > 0) {
        // Extend the pass count so the progress bar reports the extra work honestly.
        job.passesTotal = mainPassCount + indicesToVerify.length
        for (const idx of indicesToVerify) {
            if (job.status === 'cancelled') {
                throw new Error('review cancelled between passes')
            }
            const finding = allItems[idx]
            job.currentRequirement = `Double-check: ${finding.requirement}`
                .replace(/\s+/g, ' ')
                .slice(0, 160)

            // overleaf-lab: a [per-file] finding is re-checked against the FILES THAT
            // PRODUCED IT, not the whole project: verifying it against everything
            // would put the verifier back in the lost-in-the-middle conditions the
            // per-file split exists to avoid, handicapping the check exactly where
            // the finder was helped. Everything else keeps the shared cached prefix.
            const originPaths = perFileOrigin.get(idx)
            // overleaf-lab: the verifier must SEE everything the finding talks about.
            // The origin list holds the files whose verdict SET the merged status, but
            // the merged evidence cites every file that contributed a violation, so
            // showing only the origins hands the verifier a document in which part of
            // the evidence genuinely is not there. It then refutes it, correctly and
            // uselessly, and the item becomes "ok". Observed on a real thesis: three
            // requirements came back met with the verifier's own stated reason being
            // "the cited files are not present in the document provided", which turns
            // "I could not check this" into "this is fine". That is the one outcome a
            // compliance report must never produce, so the files named in the evidence
            // are added to the ones that produced it.
            const citedPaths = originPaths
                ? strippedDocs
                      .filter(d => evidenceMentionsPath(finding.evidence, d.path))
                      .map(d => d.path)
                : []
            const verifyPaths = originPaths
                ? [...new Set([...originPaths, ...citedPaths])]
                : null
            const verifyDocumentBlock = verifyPaths
                ? `DOCUMENT (the file(s) this finding is about):\n${strippedDocs
                      .filter(d => verifyPaths.includes(d.path))
                      .map(d => `% ===== FILE: ${d.path} =====\n${d.text}`)
                      .join('\n\n')}\n\n`
                : documentBlock

            const verifyBody = {
                model: reviewModelNow(),
                messages: [
                    { role: 'system', content: VERIFY_SYSTEM_PROMPT },
                    {
                        role: 'user',
                        content:
                            verifyDocumentBlock +
                            `FINDING (verify it against the DOCUMENT above):\n${JSON.stringify(
                                {
                                    requirement: finding.requirement,
                                    status: finding.status,
                                    evidence: finding.evidence,
                                    suggestion: finding.suggestion,
                                }
                            )}${
                                groundingByItem[idx].missing > 0
                                    ? `\n\nNOTE: a mechanical text search could NOT find ${groundingByItem[idx].missing} of the quoted passage(s) verbatim in the document. Treat those quotes as suspect.`
                                    : ''
                            }\n\nWrite every field of your answer in the SAME LANGUAGE as the finding's "requirement" above, not in the language of these instructions.`,
                    },
                ],
                max_tokens: scopedPassBudget,
                // Deterministic: the verifier re-reads facts, it does not create.
                temperature: 0,
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'compliance_verification',
                        strict: true,
                        schema: VERIFY_ITEMS_SCHEMA,
                    },
                },
            }

            const timeout = setTimeout(() => {
                if (job.controller) {
                    job.controller.abort()
                }
            }, passTimeoutMs())
            try {
                const response = await reviewFetch(`${llmApiUrl}/chat/completions`, {
                    method: 'POST',
                    headers: chatHeaders,
                    body: JSON.stringify(verifyBody),
                    signal: job.controller ? job.controller.signal : undefined,
                })
                if (!response.ok) {
                    // Say so. A silently skipped verification leaves the most
                    // suspect findings in the report looking double-checked.
                    logger.warn(
                        { projectId, status: response.status },
                        '[LLM] compliance: verification refused, keeping the finding'
                    )
                }
                if (response.ok) {
                    const data = await response.json()
                    recordTimings(data && data.timings)
                    const content = stripThinkTags(
                        data?.choices?.[0]?.message?.content || ''
                    )
                    try {
                        const parsed = extractJson(content)
                        const verified = Array.isArray(parsed.items)
                            ? parsed.items[0]
                            : null
                        const verifiedEvidence = repairJsonEscapeArtifacts(
                            (verified && verified.evidence) || finding.evidence
                        )
                        // A verdict that contradicts the verifier's own evidence is
                        // recomputed here, never left standing (see
                        // resolveVerifiedStatus). The grounding of the verifier's
                        // evidence is what tells "I read it and it is not there" from
                        // "I could not see it", and a verifier that SHOWS nothing has
                        // shown nothing: checked=0 is not a grounded refutation, it is
                        // prose, so closing a violation takes at least one quote the
                        // search can find.
                        const verifierGrounding = countUngroundedQuotes(
                            verifiedEvidence,
                            normalizedSource
                        )
                        const resolved = resolveVerifiedStatus(
                            verified,
                            verifierGrounding.checked > 0 && verifierGrounding.missing === 0,
                            finding.status
                        )
                        if (resolved.status) {
                            const replacement = {
                                // The requirement is not the verifier's to rewrite.
                                requirement: finding.requirement,
                                // overleaf-lab: nor are the files it came from. This
                                // rebuilt the item from scratch and dropped
                                // sourceFiles, and since verification is aimed at
                                // exactly the scoped findings that carry it, the
                                // report's group-by-file view lost precisely the
                                // findings the review had worked hardest on: they
                                // came out under "Whole document".
                                sourceFiles: finding.sourceFiles,
                                status: resolved.status,
                                evidence: clip(
                                    `${verifiedEvidence}${resolved.note}`,
                                    EVIDENCE_MAX_CHARS
                                ),
                                suggestion: clip(
                                    repairJsonEscapeArtifacts(verified.suggestion || ''),
                                    SUGGESTION_MAX_CHARS
                                ),
                            }
                            // The verifier's answer faces the same test every other
                            // finding does before it is allowed to replace one: a
                            // verdict supported by nothing that exists is not a
                            // verdict, whichever pass wrote it. A replacement that
                            // fails it is dropped rather than kept as "not assessed",
                            // because the finding it would have replaced still has its
                            // own evidence and that is the better of the two.
                            if (
                                demoteFabricatedResult(
                                    replacement,
                                    quoteSourcesFor(replacement.evidence),
                                    EVIDENCE_MAX_CHARS
                                )
                            ) {
                                if (resolved.status !== finding.status) {
                                    finding.evidence = clip(
                                        `${finding.evidence}${unprovenVerificationNote()}`,
                                        EVIDENCE_MAX_CHARS
                                    )
                                }
                            } else {
                                allItems[idx] = replacement
                            }
                        } else if (resolved.note) {
                            finding.evidence = clip(
                                `${finding.evidence}${resolved.note}`,
                                EVIDENCE_MAX_CHARS
                            )
                        }
                    } catch (err) {
                        logger.warn(
                            { projectId, err },
                            '[LLM] compliance: unparseable verification, keeping the finding'
                        )
                    }
                }
            } catch (err) {
                if (job.status === 'cancelled' || stopsTheReview(err)) {
                    throw err
                }
                logger.warn(
                    { projectId, err },
                    '[LLM] compliance: verification pass failed, keeping the finding'
                )
            } finally {
                clearTimeout(timeout)
            }
            job.passesDone += 1
            mirrorProgress()
        }
        job.currentRequirement = ''
    }

    // overleaf-lab: final grounding annotation on whatever evidence survived: a quote
    // the mechanical search cannot find in the source is flagged to the reader
    // instead of standing in the report as false authority.
    for (const item of allItems) {
        // overleaf-lab: a parser's evidence is not a quotation, it is a count with the
        // file and line it came from. Running the hallucination check over it can only
        // produce a false alarm, and an alarm on the one verdict that is exact tells
        // the reader to distrust precisely the finding they should trust most.
        if (item.decidedByCode) {
            continue
        }
        // Deterministic quoting FIRST: quotes the source can supply are replaced
        // with its own bytes, so the warning below only fires on what remains
        // genuinely unfindable.
        item.evidence = restoreQuotedEvidence(item.evidence, searchIndexes)
        // ...and only THEN neutralise a `[warning:` that came from the document.
        // The marker below is the engine's own and the two readers tell them apart
        // by nothing but the brackets, so a student who writes
        // `[warning: nothing here is real]` in their LaTeX would otherwise get their
        // sentence rendered as the reliability badge with the real evidence tail
        // hidden behind it. Deterministic quoting can put source bytes into the
        // evidence, which is why this runs after it and not before.
        item.evidence = neutraliseWarningMarker(item.evidence)
        const { missing } = countUngroundedQuotes(item.evidence, normalizedSource)
        if (missing > 0) {
            // The `[warning:` keyword is a MARKER, matched by regex in the pane and in
            // the exported report, which then show what follows it as a badge. So the
            // keyword stays put in both languages and only the sentence it introduces,
            // the part the reader actually reads, is translated.
            item.evidence = `${item.evidence} [warning: ${L(
                `${missing} quoted passage${
                    missing === 1 ? '' : 's'
                } not found verbatim in the source`,
                missing === 1
                    ? '1 passaggio citato non è stato trovato alla lettera nel sorgente'
                    : `${missing} passaggi citati non sono stati trovati alla lettera nel sorgente`
            )}]`
        }
        // overleaf-lab: exact locations, derived from the quotes rather than asked
        // of the model. A quote the search cannot place simply has no location: the
        // list is always correct, never complete-by-invention.
        const locations = locateEvidence(item.evidence, searchIndexes)
        if (locations.length > 0) {
            item.locations = locations.slice(0, 10)
            // overleaf-lab: models still write line numbers into their prose ("in
            // /main.tex, lines 30-100") although the source they are given carries none
            // and the prompt forbids it, so any such number is invented. The text is
            // NOT rewritten: a search-and-replace over prose in two languages would be
            // guesswork on the one field the reader is asked to trust. Instead the
            // reader is told which of the two numbers came from the file, and only when
            // both are in front of them, so the note never fires on an item with no
            // derived location to compare against.
            if (INVENTED_LINE_CLAIM.test(item.evidence)) {
                item.evidence += L(
                    ' [line numbers written in this text are the model\'s own; the located lines are the ones read from the file]',
                    ' [i numeri di riga scritti in questo testo sono del modello; le posizioni indicate sono quelle lette dal file]'
                )
            }
        }
    }

    // overleaf-lab: synthesize the overall summary from the ITEMS ONLY (no document,
    // so this call is small and cheap). Best-effort: a failure leaves the summary
    // empty instead of failing a review whose per-requirement work already succeeded.
    //
    // A fast review has none. It is a model call like any other, and a sentence
    // written by a model would be the only line of that report not produced by code,
    // in the mode whose whole claim is that no language model was involved.
    let summary = ''
    try {
        const summaryBody = {
            model: reviewModelNow(),
            messages: [
                {
                    role: 'system',
                    content:
                        'You summarize the outcome of a compliance review of a LaTeX document against writing guidelines. Given the review items, write a 2 to 4 sentence overall assessment IN THE SAME LANGUAGE as the items, mentioning the main problems found (or that none were found). Return ONLY a JSON object shaped {"summary": "..."}.',
                },
                {
                    role: 'user',
                    content: JSON.stringify({
                        rubric: rubric.name,
                        items: allItems.map(it => ({
                            requirement: it.requirement,
                            status: it.status,
                            evidence: it.evidence.slice(0, 200),
                        })),
                    }),
                },
            ],
            max_tokens: 500,
            // The one sentence of the report that is not a verdict still has no reason
            // to change between two runs of the same review.
            temperature: 0,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'compliance_summary',
                    strict: true,
                    schema: REVIEW_SUMMARY_SCHEMA,
                },
            },
        }
        // `null` in fast mode, which is the same shape the failure paths already
        // produce: the summary stays empty and the report draws no summary block.
        const data = fast
            ? null
            : await fetchWithLimit(
                  `${llmApiUrl}/chat/completions`,
                  {
                      method: 'POST',
                      headers: chatHeaders,
                      body: JSON.stringify(summaryBody),
                  },
                  passTimeoutMs(),
                  job.controller ? job.controller.signal : undefined,
                  response => (response.ok ? response.json() : null)
              )
        if (data) {
            const content = stripThinkTags(data?.choices?.[0]?.message?.content || '')
            summary = repairJsonEscapeArtifacts(extractJson(content).summary || '')
        }
    } catch (err) {
        if (job.status === 'cancelled' || stopsTheReview(err)) {
            throw err
        }
        logger.warn({ projectId, err }, '[LLM] compliance: summary synthesis failed')
    }

    // overleaf-lab: signals compatible with machine-generated text, counted in code.
    // Deterministic, no model call: it reads the chapters the review has already cut
    // and returns counts and quotations. It is never a verdict, so a failure here
    // must not be allowed to lose a finished review.
    let aiSignals = null
    try {
        aiSignals = analyzeAiWritingSignals(
            segments.map(segment => ({
                name: segment.title,
                docs: segment.docs,
                // A .bib is a segment of its own and is not prose. Passing the flag
                // through keeps it out of the baseline while leaving it in the
                // artifact scan.
                standalone: segment.standalone,
            }))
        )
    } catch (err) {
        logger.warn({ projectId, err }, '[LLM] compliance: AI writing signals failed')
    }

    // overleaf-lab: the source lines behind every location, from the documents this run
    // already has in memory. Deliberately the LAST thing done to the items: the checks
    // decided by code write their own locations and never pass through the annotation
    // loop above, so anything earlier than here would excerpt half the report.
    const excerpts = attachSourceExcerpts(allItems, strippedDocs)

    return {
        type: 'done',
        result: {
            rubric: { id: rubric.id, name: rubric.name },
            // overleaf-lab: WHICH REVIEW THIS IS. It travels with the report because
            // every reader of it - the panel, the archived HTML, the delta, a
            // supervisor opening a downloaded file a year later - has to be able to
            // tell a run that measured thirty requirements from one that measured
            // three, and no count in the document can be read as that on its own.
            mode,
            // The two numbers behind the fast banner. Null in full mode, where "all of
            // them" is the answer and a fraction would only invite the question.
            modeCoverage: fast
                ? { checked: countCheckedRequirements(plan), total: requirements.length }
                : null,
            // overleaf-lab: THE MODEL ID AND NOTHING ELSE. The delta between two
            // reviews refuses to compare runs whose `model` differs (see the store),
            // so folding the machine name in here would report "that one ran on a
            // different model" for two runs of the SAME model that happened to land
            // on different GPUs, and silently drop the comparison the student came
            // for. Which machine served the review is the field below.
            //
            // NULL in fast mode, and this is not a detail: naming a model in a report
            // no model produced would be the plainest possible untruth in the
            // document, it would print "Model: qwen..." at the top of a page that was
            // written by parsers, and the delta would then compare a fast run and a
            // full one as "same model" instead of refusing. Every reader already
            // handles an absent model (older archived reports have none).
            model: fast ? null : reviewModelNow(),
            // overleaf-lab: WHICH BACKEND ANSWERED. Without it a pool is unauditable:
            // three machines, three models, and a report that could have come from
            // any of them. It carries the label and the model, never the URL - this
            // document is downloaded and forwarded, and the address of an internal
            // machine has no reason to travel with it. Null when none did.
            endpoint: fast
                ? null
                : {
                      id: endpoint.id,
                      label: endpoint.label || '',
                      model: reviewModelNow(),
                  },
            // The same fact as a sentence the report can print, in the language the
            // student is being marked in. Null unless a pool is actually configured:
            // on a single-backend install there is nothing to disambiguate, and the
            // report must read exactly as it did before any of this existed.
            endpointNote:
                !fast && poolIsConfigured()
                    ? L(
                          `Reviewed on the ${endpointName(endpoint)} backend.`,
                          `Review eseguita sul backend ${endpointName(endpoint)}.`
                      )
                    : null,
            // overleaf-lab: when the review ran. The exported report used to carry
            // this only in its file name, so a printed or forwarded copy had no date
            // at all; with reports now archived, it is what tells two runs apart.
            completedAt: new Date().toISOString(),
            // overleaf-lab: the rubric's language, so the report chrome can localize.
            // The renderer falls back to English when absent (older stored reviews).
            language: reportLanguage,
            // Nothing was put in a prompt in fast mode, so there is no prompt to
            // measure: the report prints no token line rather than a number for a
            // request that was never made.
            documentTokensEstimate: fast ? null : promptTokens,
            maxContextTokens: fast ? null : maxContextTokens,
            // overleaf-lab: WHAT THE REVIEW ACTUALLY READ. Without this the report
            // cannot be audited: a run that silently saw one file fewer (a deleted
            // file, an empty doc skipped, a project still syncing) is
            // indistinguishable from a complete one, and every "scanned the whole
            // document" claim in it becomes unverifiable after the fact.
            documentFiles: strippedDocs.map(d => d.path),
            // Project files that exist but were not reviewed: the ones that could not
            // be read, plus the ones deliberately left out (acknowledgements). Naming
            // them is the difference between a report the reader can trust and one
            // that quietly covered less than the project, and a policy exclusion is
            // no more allowed to be silent than a failure to read a file.
            // overleaf-lab: and the two lists PARTITION the files. A path that is in the
            // assembled document was read, whatever else happened to it, so naming it
            // here as well would tell the reader both things at once; the filter makes
            // that impossible by construction rather than by everyone remembering it.
            // The acknowledgements exclusion is the case that made it necessary: it
            // takes a file out of the review only when nothing of it is left (see
            // excludeUnreviewedSegments).
            documentFilesSkipped: [
                ...linked.skipped,
                ...unreviewed.files.map(path => ({
                    path,
                    reason: L('acknowledgements are not reviewed', 'i ringraziamenti non passano in review'),
                })),
            ].filter(entry => !strippedDocs.some(d => d.path === entry.path)),
            // overleaf-lab: files the project holds but the document never pulls in.
            // Named for the same reason: a narrower scope that goes unsaid reads as
            // "everything was checked". Here it is also the answer to "why is my old
            // chapter not in the report".
            documentFilesNotIncluded: skippedFiles,
            summary,
            items: allItems,
            // overleaf-lab: how much source text this report carries and what the caps
            // kept out of it. Rendered as a sentence whenever something was left out,
            // because excerpts that stop halfway down the report look like locations
            // that could not be placed.
            excerpts,
            // overleaf-lab: the absolute URL of this project, when the instance declared
            // one. It is what lets a location in the DOWNLOADED report open the editor
            // on that file and line; absent, the report simply carries no links.
            projectUrl: projectDeepLinkBase(projectId),
            // overleaf-lab: reported in its own section of the report, never mixed
            // into `items`: these are not compliance findings and must not be counted
            // as any. Null when the pass failed, absent on older stored reviews, and
            // the renderer draws nothing in either case.
            aiSignals,
            // overleaf-lab: reported in its own section, never mixed into `items`:
            // these are facts from a third-party API, not compliance findings, and
            // `enabled: false` must render as "not run" rather than as nothing.
            bibVerify,
            // overleaf-lab: the measured figure resolutions, for the report and the
            // delta between two reviews. Null when nothing was measured.
            imageMetrics,
        },
    }
}

// ===========================================================================
// THE ENDPOINT POOL
// ===========================================================================
// overleaf-lab: several model backends, one review each, and a queue that only
// forms when they are all busy.
//
// The shape of the problem: a review is one indivisible unit of work that occupies
// a whole GPU for minutes. Splitting one review across machines would mean passes of
// the same document judged by different models, which is not a review of anything;
// so the parallelism is BETWEEN reviews, and the only thing the pool decides is
// which machine a job starts on. Everything after that is unchanged.
//
// AFFINITY IS TOTAL, and it is not a preference. A review re-reads the admin
// settings when it starts, sends fifty-odd calls that rely on the backend's prompt
// cache holding the same document, and calibrates the per-pass timeout from that
// backend's measured throughput. Moving it halfway would throw away the cache
// (minutes of prefill, per pass), mix two tokenizers' idea of the context window,
// and produce a report whose verdicts came from two different judges with nothing
// saying so. The endpoint is chosen once, at pickup, and is the job's for its life.
const DEFAULT_REVIEW_ENDPOINT_ID = 'default'

// overleaf-lab: how many backends an install may declare. Not a technical limit: it
// is what keeps a paste accident in the admin page from turning into a fan-out that
// starts thirty reviews at once.
const MAX_REVIEW_ENDPOINTS = 8

// overleaf-lab: how long an endpoint stays out of the rotation after it failed.
//
// Long enough that a machine which is down for a model reload is not asked again on
// every dispatch, short enough that a five minute blip does not cost an afternoon of
// GPU. It is a PREFERENCE, never a ban: see firstFreeEndpoint, where an endpoint in
// its cooldown is still handed work when it is the only one free. That is what keeps
// the single-backend install honest - there the cooldown must change nothing at all,
// because the alternative to running on the one backend we have is not running.
const ENDPOINT_OUTAGE_COOLDOWN_MS = 5 * 60 * 1000

// overleaf-lab: the pickup probe's deadline. Deliberately much shorter than
// AUX_FETCH_TIMEOUT_MS: this runs on the dispatch path with the queue held, so a
// machine that takes ten seconds to say what models it serves is, for the purpose of
// choosing where to send a review right now, not there. /models is a static list on
// every backend we support, so a slow answer is a sick machine and not a busy one.
const ENDPOINT_PROBE_TIMEOUT_MS = 10 * 1000

// overleaf-lab: the pool as the queue sees it. One entry with a null url and a null
// model is THE LEGACY INSTALL: null means "whatever the admin settings say", so the
// review resolves its address and its model exactly the way it always has, and the
// pool code cannot change the behaviour of an install that never configured one.
let reviewEndpoints = [
    { id: DEFAULT_REVIEW_ENDPOINT_ID, label: '', url: null, model: null, modelBackup: null },
]
// The address and key the health probe uses for the legacy entry, captured when the
// settings were last read. The REVIEW never reads these: it re-resolves from fresh
// settings (see runReviewPasses), which is what it did before the pool existed.
let reviewEndpointDefaults = { url: null, key: null }
const endpointOutages = new Map() // endpointId -> { until, reason }
// overleaf-lab: the dispatch lock. Choosing an endpoint can now await (the pickup
// probe), and two concurrent kicks that both read "endpoint 2 is free" would both
// hand it a job and one of the two reviews would be lost the moment the other
// claimed the slot. The lock covers the decision only; it is released before the
// claim, and the claim itself is synchronous.
let dispatching = false

// overleaf-lab: is more than one backend configured? Every behaviour that is NEW
// hangs off this, so that an install with one backend takes the same code path it
// took before the pool existed: no pickup probe, no extra queue kick, no endpoint
// line in the report. "Same behaviour" is much easier to keep true when it is one
// condition than when it is a promise repeated in six places.
function poolIsConfigured() {
    return reviewEndpoints.length > 1
}

// overleaf-lab: turn the admin settings into the pool. The ONLY place the two shapes
// meet, so the legacy fallback cannot drift: an install with no reviewEndpoints gets
// one entry whose url and model are null, and null is what tells the review to
// resolve them the old way.
// A tiny stable digest of an endpoint URL (djb2, hex). Not cryptographic and not
// meant to be: it only has to be deterministic across restarts and distinct for
// distinct URLs of one pool, which at most holds MAX_REVIEW_ENDPOINTS entries;
// the `seen` loop below still catches a collision.
function hashEndpointUrl(url) {
    let hash = 5381
    const text = String(url || '')
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
    }
    return hash.toString(16)
}

function resolveReviewEndpoints(admin) {
    const declared = Array.isArray(admin && admin.reviewEndpoints) ? admin.reviewEndpoints : []
    const usable = declared
        .filter(entry => entry && typeof entry.url === 'string' && entry.url.trim().length > 0)
        .slice(0, MAX_REVIEW_ENDPOINTS)
    if (usable.length === 0) {
        return [
            { id: DEFAULT_REVIEW_ENDPOINT_ID, label: '', url: null, model: null, modelBackup: null },
        ]
    }
    const seen = new Set()
    const resolved = []
    usable.forEach((entry, index) => {
        // The id keys the busy map, the outage map and the archived result, so it has
        // to exist and be unique even when the settings file was written by hand.
        // Derived from the URL, not from the index: a hand-written settings file
        // carries no ids, and positional ones change meaning when the entries are
        // reordered while a review runs, at which point the busy map can block the
        // wrong machine and the dispatcher can double-book the busy one. The URL is
        // what the id actually stands for, so reordering leaves every id alone.
        let id = String(entry.id || '').trim() || `endpoint-${hashEndpointUrl(entry.url)}`
        while (seen.has(id)) {
            id = `${id}-${index + 1}`
        }
        seen.add(id)
        resolved.push({
            id,
            label: String(entry.label || '').trim(),
            url: entry.url.trim(),
            model: String(entry.model || '').trim() || null,
            modelBackup: String(entry.modelBackup || '').trim() || null,
        })
    })
    return resolved
}

// overleaf-lab: refresh the snapshot from settings that have just been read.
//
// Synchronous, and fed from the reads the review path already does (startReview
// loads the settings before it enqueues; the boot probe loads them before it
// resumes). That is not an optimisation: processQueue has to reach its claim with no
// await in front of it, because startReview answers the POST with the job's status
// and a client that saw 'running' there must keep seeing it.
function refreshReviewEndpoints(admin) {
    reviewEndpoints = resolveReviewEndpoints(admin)
    reviewEndpointDefaults = {
        url: (admin && admin.llmApiUrl) || null,
        key: (admin && admin.llmApiKey) || null,
    }
    // A cooldown for an endpoint that no longer exists is a leak, so it goes. A
    // cooldown for one that is still declared STAYS: somebody saving the settings page
    // is not evidence that a machine came back, and clearing it would send the next
    // review straight back to the backend that is down.
    //
    // Busy slots are deliberately left alone, including a slot held on an endpoint
    // that has just been removed from the settings. The review on it is still running
    // and still talking to that address (see the affinity rule), and the id it holds
    // is simply no longer offered to anyone else; its release in processQueue's
    // finally deletes the entry by id and needs nothing from this list.
    const known = new Set(reviewEndpoints.map(e => e.id))
    for (const id of endpointOutages.keys()) {
        if (!known.has(id)) {
            endpointOutages.delete(id)
        }
    }
    return reviewEndpoints
}

// overleaf-lab: where this entry actually lives. Null url is the legacy entry, whose
// address is whatever the settings said when they were last read.
function endpointAddress(endpoint) {
    return (endpoint && endpoint.url) || reviewEndpointDefaults.url || null
}

// overleaf-lab: what to call this backend in a log line, in the archived result and
// in the report. The label when the admin wrote one, the id otherwise. Never the
// URL: the report is a document the student downloads and forwards, and the address
// of an internal machine has no business travelling with it.
function endpointName(endpoint) {
    if (!endpoint) {
        return DEFAULT_REVIEW_ENDPOINT_ID
    }
    return endpoint.label || endpoint.id
}

function endpointInOutage(endpoint, now) {
    const outage = endpointOutages.get(endpoint.id)
    return Boolean(outage && outage.until > now)
}

// overleaf-lab: take an endpoint out of the rotation for a while, and say why.
//
// The outage breaker used to be per REVIEW: a closure counting consecutive network
// failures, thrown away when the run ended, so the next review paid the same eight
// dead calls to learn the same thing. With a pool that is not just wasteful, it is
// wrong: every queued job would take its turn on the machine that is down instead of
// on the two that are up. The count stays per review (it decides when THIS review
// gives up); what it leaves behind is this mark, which decides where the NEXT one
// goes.
function noteEndpointOutage(endpoint, reason) {
    if (!endpoint) {
        return
    }
    endpointOutages.set(endpoint.id, { until: Date.now() + ENDPOINT_OUTAGE_COOLDOWN_MS, reason })
    logger.warn(
        { endpoint: endpoint.id, reason, cooldownMs: ENDPOINT_OUTAGE_COOLDOWN_MS },
        '[LLM] compliance: taking a review backend out of the rotation for a while'
    )
}

function clearEndpointOutage(endpoint) {
    if (endpoint) {
        endpointOutages.delete(endpoint.id)
    }
}

// overleaf-lab: the first endpoint nobody is using. Healthy ones first, in the order
// the admin declared them, so a deterministic pool fills deterministically and the
// first machine listed is the one a single review lands on.
//
// The last line is the one that matters: when every FREE endpoint is inside its
// cooldown, the first free one is handed the job anyway. Waiting instead would mean
// a review that sits in the queue with the whole instance idle, and it would break
// the single-backend install outright - there "the only endpoint is in cooldown" is
// the normal state after any failure, and the honest answer is to run and fail
// loudly, which is what this code did before the pool existed.
function firstFreeEndpoint() {
    const free = reviewEndpoints.filter(endpoint => !busyEndpoints.has(endpoint.id))
    if (free.length === 0) {
        return null
    }
    const now = Date.now()
    return free.find(endpoint => !endpointInOutage(endpoint, now)) || free[0]
}

// overleaf-lab: is this backend answering AT ALL? Same rule as the outage breaker
// and as the boot probe: an HTTP error comes from a machine that is up. Only a
// refused socket or a timeout means it is not there.
async function endpointAnswers(endpoint) {
    const url = endpointAddress(endpoint)
    if (!url) {
        return false
    }
    try {
        const headers = {}
        const key = reviewEndpointDefaults.key
        if (typeof key === 'string' && key.length > 0) {
            headers.Authorization = `Bearer ${key}`
        }
        const response = await fetchWithLimit(
            `${url}/models`,
            { method: 'GET', headers },
            ENDPOINT_PROBE_TIMEOUT_MS
        )
        return Boolean(response)
    } catch (err) {
        return false
    }
}

// overleaf-lab: the first FREE endpoint that answers right now, probed in declaration
// order. Pool only: with one backend there is nowhere else to send the job, so the
// probe would only add ten seconds to the front of a review that is about to fail
// with a message saying exactly the same thing.
//
// A machine that does not answer is marked and skipped, and the job goes to the next
// one - this is the "endpoint down at pickup" case, and it is the only moment a job
// may be moved, because it has not started yet. Once every free endpoint has been
// tried and none answered, the first free one is returned anyway: the review then
// runs, fails through the outage breaker, and the user gets the honest "the backend
// did not answer N calls in a row" instead of a job wedged in a queue for ever.
async function firstAnsweringEndpoint() {
    const now = Date.now()
    let fallback = null
    for (const endpoint of reviewEndpoints) {
        if (busyEndpoints.has(endpoint.id)) {
            continue
        }
        if (fallback === null) {
            fallback = endpoint
        }
        if (endpointInOutage(endpoint, now)) {
            continue
        }
        if (await endpointAnswers(endpoint)) {
            // It answered, so whatever it was marked for is over.
            clearEndpointOutage(endpoint)
            return endpoint
        }
        noteEndpointOutage(endpoint, 'no answer when a review was handed to it')
    }
    return fallback
}

// overleaf-lab: WHAT A FINISHED REVIEW LEAVES BEHIND, whatever lane it ran in.
//
// Extracted from processQueue when the fast lane arrived, and extracted rather than
// copied for one reason: this is where a review is archived, and two copies of an
// archiving path is how the same report gets written twice or, worse, how one lane
// quietly stops writing it at all. The endpoint bookkeeping stays in the caller,
// because only the queued lane holds an endpoint; the outage marking below is keyed
// off `job.endpoint` and is inert (see noteEndpointOutage) for a job that has none.
async function recordReviewOutcome(job, outcome) {
    // overleaf-lab: a cancel may have landed mid-run; if so, keep 'cancelled'.
    if (job.status === 'cancelled') {
        return
    }
    if (outcome.type === 'done') {
        job.status = 'done'
        job.result = outcome.result
        // overleaf-lab: archive the finished report and attach the delta against the
        // previous one. Persistence is best-effort by design: saveReportQuietly
        // swallows its own errors, so a Mongo problem costs the archive and never the
        // report the user is waiting for.
        job.finishedAt = Date.now()
        job.result.durationMs = job.finishedAt - (job.startedAt || job.createdAt)
        const delta = await ComplianceStore.saveReportQuietly(job)
        if (delta) {
            job.result.delta = delta
        }
        return
    }
    job.status = 'error'
    job.errorCode = outcome.errorCode
    job.message = outcome.message
    // overleaf-lab: the three failures that are ABOUT THE MACHINE and not about the
    // document. The backend never answered, it does not serve the model this endpoint
    // declares, or it ignores the JSON schema: every later review sent there would
    // fail the same way, so the endpoint steps out of the rotation instead of
    // consuming the queue one job at a time. A too_long or a type_mismatch marks
    // nothing - those are facts about the project, and the next one may be fine.
    if (
        outcome.errorCode === 'backend_error' ||
        outcome.errorCode === 'model_unavailable' ||
        outcome.errorCode === 'json_mode_broken'
    ) {
        noteEndpointOutage(job.endpoint, outcome.errorCode)
    }
    if (outcome.errorCode === 'too_long') {
        job.documentTokensEstimate = outcome.documentTokensEstimate
        job.reviewMaxTokens = outcome.reviewMaxTokens
        job.maxContextTokens = outcome.maxContextTokens
    }
    if (outcome.errorCode === 'type_mismatch') {
        job.expectedDocument = outcome.expectedDocument
        job.certain = outcome.certain
    }
}

// overleaf-lab: cancel aborts the controller after setting status 'cancelled', so
// keep that; any other throw (the review timeout abort or an HTTP/parse failure)
// becomes a generic 'failed'.
function recordReviewCrash(job, err) {
    if (job.status === 'cancelled') {
        return
    }
    job.status = 'error'
    job.errorCode = 'failed'
    job.message = 'The review request failed or timed out'
    logger.error(
        { projectId: job.projectId, userId: job.userId, err },
        '[LLM] compliance: review job failed'
    )
}

// overleaf-lab: the bookkeeping every finished job owes, in both lanes.
async function settleFinishedJob(job) {
    job.finishedAt = Date.now()
    job.controller = null
    // overleaf-lab: a review that ended badly is recorded too. Without this the
    // in-memory job was the only trace of the failure, and it is swept after
    // JOB_TTL_MS - so once it was gone /latest fell through to the archive and
    // answered with the PREVIOUS report as though it were current. Not awaited on
    // its own: the forget below is, and it is ordered after this by the await.
    if (job.status === 'error') {
        await ComplianceStore.saveFailureQuietly(job)
    }
    // The job is no longer owed: whatever came of it, the report (if any) is in
    // the reports collection and this entry would only be resumed for nothing.
    //
    // AWAITED, unlike the report write next to it, which was the asymmetry that
    // made a finished review come back from the dead. processQueue's promise used
    // to resolve with this delete still in flight, so the nightly `docker stop`
    // landing in that window left a job document at status 'running' whose report
    // was already archived: at the next boot claimInterruptedJobs correctly saw
    // work still owed, and the student got a full duplicate review on the GPU and
    // a second "Review finished" email. The unique jobId index refused the second
    // REPORT, which is why the duplication was invisible in the data. The cost of
    // ordering it properly is one round trip on a path that has just spent minutes
    // on a GPU. A fast job was never written to that collection, and deleting a
    // document that is not there is a no-op, so the two lanes share this line.
    await ComplianceStore.forgetJobQuietly(job.id)
    // overleaf-lab: tell the user it is over, so they do not have to sit in front
    // of the panel for the whole review. Deliberately NOT awaited: the quiet
    // wrapper never rejects, and an SMTP server that hangs must not keep the next
    // queued review waiting behind a notification about this one.
    //
    // NOT FOR A FAST REVIEW, on purpose. The email exists because a full review is a
    // delivery you walk away from: minutes on a queue, an hour of GPU, come back
    // later. A fast one finishes while the panel is still open, in the middle of a
    // fix-and-check loop somebody may run ten times in an afternoon, and ten emails
    // about ten five-second runs is how a useful notification becomes one people
    // filter away - including the ones about the reviews that took an hour.
    // Compared against the literal rather than through normalizeReviewMode: the mode
    // is normalised once, where the request lands (see startReview), and this line is
    // sliced out and evaluated on its own by the queue suites, where the helper that
    // lives four thousand lines up does not exist.
    if (job.mode !== 'fast') {
        ComplianceMailer.notifyReviewFinishedQuietly(job)
    }
}

// overleaf-lab: run the next queued job on the first free endpoint. Recurse to skip
// missing or already-cancelled jobs, and always try the next job in a finally so a
// single job failure never stalls the queue.
async function processQueue() {
    // The lock, not a re-entrancy bug: a kick that arrives while another one is
    // choosing an endpoint can return, because the one holding the lock kicks the
    // queue again as soon as it has claimed its slot.
    if (dispatching || queue.length === 0) {
        return
    }

    let endpoint = firstFreeEndpoint()
    if (!endpoint) {
        return
    }
    if (poolIsConfigured()) {
        dispatching = true
        try {
            endpoint = await firstAnsweringEndpoint()
        } finally {
            dispatching = false
        }
        // Everything can have changed across that await except the free slots, which
        // the lock held: a cancel may have emptied the queue.
        if (!endpoint || queue.length === 0) {
            return
        }
    }

    const jobId = queue.shift()
    const job = jobs.get(jobId)
    // overleaf-lab: skip a job that vanished, was cancelled while queued, or has
    // ALREADY FINISHED. The last case is not hypothetical: the same id sitting twice
    // in the queue used to be run twice, which burned a second review on the GPU and
    // archived the same result twice. A job is created as 'queued' and only ever
    // reaches 'done' or 'error' by being processed, so a terminal state here means
    // exactly one thing, that this id has had its turn.
    if (!job || job.status === 'cancelled' || job.status === 'done' || job.status === 'error') {
        return processQueue()
    }

    busyEndpoints.set(endpoint.id, job.id)
    job.endpoint = endpoint
    job.status = 'running'
    job.startedAt = Date.now()
    job.controller = new AbortController()
    ComplianceStore.markJobStatusQuietly(job.id, 'running')

    // overleaf-lab: fill the OTHER free endpoints too. This function dispatches ONE
    // job per call and used to rely on its own finally to start the next one, which
    // is right when there is a single slot and wrong the moment there are three: the
    // three jobs a restart resumes, or three students clicking together, would have
    // run one after the other on one machine with the other two idle. Guarded so the
    // single-backend install keeps exactly the old call graph.
    if (poolIsConfigured()) {
        processQueue().catch(err => {
            logger.error({ err }, '[LLM] compliance: failed to fill the other endpoints')
        })
    }

    try {
        await recordReviewOutcome(job, await performReview(job))
    } catch (err) {
        recordReviewCrash(job, err)
    } finally {
        job.finishedAt = Date.now()
        // overleaf-lab: give the machine back. Keyed by the endpoint the job was
        // handed and not by "whatever is busy", so a release can never free somebody
        // else's slot and let two reviews onto one GPU.
        busyEndpoints.delete(endpoint.id)
        // A review that ran to the end is the strongest evidence this backend is
        // healthy, and it outranks whatever an earlier failure marked it with.
        if (job.status === 'done') {
            clearEndpointOutage(endpoint)
        }
        await settleFinishedJob(job)
        // overleaf-lab: never let one job's failure stall the queue. processQueue is
        // async, so it can only ever REJECT and never throw synchronously: a try/catch
        // around it is unreachable, and the day something in it rejects the result
        // would be an unhandled rejection, which by default takes the process down.
        processQueue().catch(err => {
            logger.error({ err }, '[LLM] compliance: failed to continue the queue')
        })
    }
}

// overleaf-lab: how many fast reviews may run at once in this process.
//
// They cost no GPU, but they are not free: each one reads the whole project out of
// the docstore and file store and runs every parser over it, on the event loop that
// serves every other request of the instance. Three is enough that a class clicking
// together does not queue behind itself, and small enough that the web process is
// never spending its whole time slice on them.
const MAX_CONCURRENT_FAST_REVIEWS = 3

// overleaf-lab: start as many queued fast reviews as the cap allows.
//
// No endpoint is claimed and no lock is needed: the loop is synchronous up to the
// point where each job is marked running, and runFastReview never awaits before
// returning its promise unhandled to us. What it must not do is await the reviews
// themselves - they are independent, and awaiting one here would turn the cap into a
// FIFO of one.
function processFastQueue() {
    while (fastRunning < MAX_CONCURRENT_FAST_REVIEWS && fastQueue.length > 0) {
        const job = jobs.get(fastQueue.shift())
        // Same rule as the queued lane: a job that vanished, was cancelled while
        // waiting, or somehow already finished has had its turn.
        if (!job || job.status === 'cancelled' || job.status === 'done' || job.status === 'error') {
            continue
        }
        fastRunning += 1
        runFastReview(job).catch(err => {
            logger.error({ err }, '[LLM] compliance: a fast review ended badly')
        })
    }
}

// overleaf-lab: one fast review, from pickup to archive. The same performReview the
// queued lane runs (the mode on the job is what makes it fast), the same outcome
// recording and the same settling; what it does NOT do is take an endpoint, mark one
// as broken, or send an email.
async function runFastReview(job) {
    job.status = 'running'
    job.startedAt = Date.now()
    job.controller = new AbortController()
    try {
        await recordReviewOutcome(job, await performReview(job))
    } catch (err) {
        recordReviewCrash(job, err)
    } finally {
        fastRunning -= 1
        await settleFinishedJob(job)
        processFastQueue()
    }
}

async function getRubrics(req, res) {
    // overleaf-lab: review feature disabled by admin -> no rubrics to offer.
    const flags = await getLLMFeatureFlags()
    if (!flags.reviewEnabled) {
        return res.json({ rubrics: [], notifyByEmail: false })
    }
    const rubrics = await getComplianceRubrics()
    // overleaf-lab: CAN THE FULL REVIEW RUN AT ALL ON THIS INSTANCE?
    //
    // The panel offers two buttons and one of them needs a model backend, so it has to
    // know before it draws them: a button that is enabled, clicked, and answers
    // "not_configured" teaches people that the feature is broken, while a button
    // disabled WITH THE REASON next to a fast one that works teaches them what this
    // instance can do. The same two facts the start guard consults, read without
    // touching the pool snapshot: this is a GET on a read-only route, and moving the
    // pool under a review that is running is not something it may do.
    const admin = await getAdminLLMSettings()
    const declaredEndpoints = Array.isArray(admin.reviewEndpoints) ? admin.reviewEndpoints : []
    const fullReviewAvailable = Boolean(
        admin.llmApiUrl || declaredEndpoints.some(e => e && String(e.url || '').trim())
    )
    // overleaf-lab: expose names only, never the guidelines text, to the project UI.
    res.json({
        rubrics: rubrics.map(r => ({ id: r.id, name: r.name })),
        fullReviewAvailable,
        // overleaf-lab: whether this instance can mail the user when the review ends.
        // The panel tells them to walk away and come back, and it must only promise
        // the email when one will actually be sent: an install without SMTP would
        // otherwise leave someone waiting for a message that does not exist.
        notifyByEmail: ComplianceMailer.isEmailConfigured(),
    })
}

// overleaf-lab: enqueue a review and return its job id. Always answers HTTP 200;
// success vs a logical error is distinguished by the `ok` field.
async function startReview(req, res) {
    // 1. Service disabled globally.
    if (Settings.llm && !Settings.llm.enabled) {
        return res.json({ ok: false, error: 'disabled', message: 'LLM service is disabled' })
    }

    // overleaf-lab: review feature disabled by admin.
    const flags = await getLLMFeatureFlags()
    if (!flags.reviewEnabled) {
        return res.json({ ok: false, error: 'disabled', message: 'The review feature is disabled' })
    }

    // 2. Request context.
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    // overleaf-lab: `confirmed` is the user answering "yes, this rubric really is the
    // right one for this document" after a type_mismatch, and it skips the check on
    // the retry. It cannot be inferred, so it has to travel with the request.
    // overleaf-lab: WHICH OF THE TWO REVIEWS was asked for. Normalised here, once, so
    // everything downstream compares against a value that can only be 'full' or
    // 'fast': a typo in the body must fall back to the review this endpoint has always
    // run, never to a run that quietly checks a third of the rubric.
    const { rubricId, confirmed, mode: requestedMode } = req.body || {}
    const mode = normalizeReviewMode(requestedMode)
    const fast = mode === 'fast'

    logger.debug({ projectId, userId, rubricId, mode }, '[LLM] compliance: start requested')

    // 3. Resolve the requested rubric (capture its name for the job).
    const rubrics = await getComplianceRubrics()
    const rubric = rubrics.find(r => r.id === rubricId)
    if (!rubric) {
        return res.json({ ok: false, error: 'no_rubric', message: 'Unknown or missing rubric' })
    }

    // overleaf-lab: the language every refusal below speaks. The rubric is in hand from
    // here on, and the rest of the flow already answers in its language, so an Italian
    // rubric used to produce an Italian report with an English sentence on the click.
    // Named explicitly rather than through L(): this runs outside any review, so the
    // module-global report language belongs to somebody else's job and must neither be
    // read nor written here.
    const rubricLang = detectRubricLanguage(rubric.guidelines)

    // 4. Effective backend configuration must at least have a URL.
    const admin = await getAdminLLMSettings()
    // overleaf-lab: and the pool, refreshed from the settings we have just read.
    // Here rather than inside processQueue because the dispatch below has to stay
    // synchronous: this handler answers the POST with the job's own status, and an
    // await between the enqueue and the dispatch would turn the 'running' a client
    // sees today into a 'queued'. This is also the read every admin change rides in
    // on, so an endpoint added in the admin page is in the rotation from the next
    // click, with no restart.
    refreshReviewEndpoints(admin)
    // overleaf-lab: `!fast`, which is the whole of point 3 of this feature. An
    // instance with no model backend - a fresh clone of this repository, a department
    // that never bought a GPU - can still run every requirement its rubric hands to a
    // parser, and refusing that here would be refusing a review that needs nothing
    // this check is about.
    if (!fast && !admin.llmApiUrl && reviewEndpoints.every(endpoint => !endpoint.url)) {
        return res.json({
            ok: false,
            error: 'not_configured',
            message: inLanguage(
                rubricLang,
                'LLM backend is not configured',
                'Il backend LLM non è configurato'
            ),
        })
    }

    // 5. Create and enqueue the job.
    sweepOldJobs()

    // overleaf-lab: the two admission guards, in one place because they are now
    // consulted TWICE.
    //
    // The first consultation is a meter: it comes before the document-type scan below
    // so that an over-quota or duplicated request never pays for reading and scanning
    // the whole project. The second is the authoritative one and sits hard against
    // `jobs.set`, with no await in between, because that is what makes a double click
    // safe: two concurrent requests cannot both pass a check and then both register.
    // Re-running it costs one walk of a Map with at most a few dozen entries.
    const admissionCheck = () => {
        // One live review per project and user. A double click, or a reload whose
        // re-attach has not answered yet, used to enqueue a second identical review
        // behind the first: hours of duplicated work on a queue that runs one job at a
        // time, and a UI attached to the newer one while the older still held the slot.
        // Returning the existing job makes the second request join the first instead.
        //
        // PER (USER, PROJECT), and that is the whole exclusion rule - there is no
        // per-project lock, and adding one would be a change, not a fix. Two people
        // with access to the same project (an author and a supervisor) have always
        // been able to hold a live review of it each; what is new is that with a pool
        // the two can now genuinely run at the same time instead of queueing. That is
        // safe for the reasons it was safe before: a review only READS the project,
        // and each one archives its own report under its own jobId, which is the
        // field the unique index is on. What it is not is a way around the cap above,
        // which counts a user's live jobs whatever project they are on.
        let liveForUser = 0
        for (const existing of jobs.values()) {
            if (existing.status !== 'queued' && existing.status !== 'running') {
                continue
            }
            if (existing.userId !== userId) {
                continue
            }
            liveForUser += 1
            if (existing.projectId === projectId) {
                // Joining is only honest when the live job IS what was asked for.
                // Reusing across mode or rubric answered a "full review" click
                // with the jobId of a running fast one: ok:true, the full review
                // never ran, and nothing said so. A mismatch is told out loud
                // instead, with what to do about it.
                // Normalized as everywhere else: a resumed pre-mode job has no
                // mode field and has always meant 'full'.
                const liveMode = existing.mode === 'fast' ? 'fast' : 'full'
                const askedMode = mode === 'fast' ? 'fast' : 'full'
                if (liveMode !== askedMode || existing.rubricId !== rubricId) {
                    logger.info(
                        { projectId, jobId: existing.id, liveMode: existing.mode, asked: mode },
                        '[LLM] compliance: live review differs in mode or rubric, refusing to join'
                    )
                    return {
                        ok: false,
                        error: 'different_review_running',
                        message: inLanguage(
                            rubricLang,
                            'A review of this project with a different mode or rubric is already queued or running. Wait for it to finish, or cancel it, then start this one.',
                            'Una review di questo progetto con modalità o rubrica diversa è già in coda o in corso. Aspettare che finisca, o annullarla, e poi avviare questa.'
                        ),
                    }
                }
                logger.debug(
                    { projectId, jobId: existing.id },
                    '[LLM] compliance: review already in progress, reusing it'
                )
                return {
                    ok: true,
                    jobId: existing.id,
                    status: existing.status,
                    position: jobsAhead(existing.id),
                }
            }
        }
        // And a cap on how much of the shared queue one person can hold. The guard
        // above is per project, so it never stopped anyone from starting a review in
        // thirty different projects and pushing everybody else's work behind hours of
        // their own. The backends are a shared resource whether there is one of them
        // or three, so the queue needs a per-user share like any other.
        if (liveForUser >= MAX_LIVE_JOBS_PER_USER) {
            logger.info(
                { userId, liveForUser },
                '[LLM] compliance: user is holding their share of the queue'
            )
            return {
                ok: false,
                error: 'queue_full',
                message: inLanguage(
                    rubricLang,
                    `You already have ${liveForUser} reviews queued or running. Wait for one to finish, or cancel it, before starting another.`,
                    `Ci sono già ${liveForUser} revisioni tue in coda o in corso. Aspettare che una finisca, o annullarla, prima di avviarne un'altra.`
                ),
            }
        }
        return null
    }

    // One start at a time per (user, project): later arrivals wait for the one in
    // flight to register its job, then join it through the admission check like
    // any reload would. See startsInFlight for the amplification this closes.
    const startKey = `${userId}:${projectId}`
    while (startsInFlight.has(startKey)) {
        await startsInFlight.get(startKey).catch(() => {})
    }
    let releaseStart
    startsInFlight.set(startKey, new Promise(resolve => { releaseStart = resolve }))
    try {
    const metered = admissionCheck()
    if (metered) {
        return res.json(metered)
    }

    // overleaf-lab: mechanical document-type check AT ENQUEUE TIME. When the rubric
    // declares a "Document type" pattern, the wrong-rubric mistake is answerable in
    // milliseconds from the sources alone; deciding it here means the user learns
    // about it on the click, not when the job finally reaches the front of a queue
    // that can be an hour deep. The job re-runs the same test, over the same sources,
    // when it starts (they can change while it waits). A failure of the check itself
    // never blocks anything: guard rail, not a gate.
    //
    // AFTER the dedup guard and the per-user cap, not before them. It reads the whole
    // project text and runs an admin-written regex over it, all synchronously on the
    // request thread, and it used to be the FIRST thing startReview did: a user who
    // already held all three of their queue slots paid for it in full on every further
    // POST before being told queue_full, and so did every double-clicked button. There
    // is no rate limiter on this route, so the cheapest guard has to come first.
    if (!confirmed) {
        try {
            const typePattern = documentTypePattern(parseScanPatterns(rubric.scanPatterns))
            if (typePattern) {
                const sources = await readProjectSources(projectId)
                // And bounded by the same question the review asks itself: a project
                // that cannot fit in the context window is going to be refused as
                // too_long anyway, so scanning it here buys nothing and spends the
                // event loop of every other user of the instance to do it.
                //
                // Counted from the character totals rather than through estimateTokens,
                // which takes TEXT: joining the whole project into one string to
                // measure it would cost more than the scan being avoided.
                const chars = sources.docs.reduce((n, d) => n + d.text.length, 0)
                if (Math.ceil(chars / REVIEW_CHARS_PER_TOKEN) > (admin.maxContextTokens || 32000)) {
                    logger.info(
                        { projectId, chars },
                        '[LLM] compliance: project too large to type-check at enqueue, leaving it to the run'
                    )
                } else if (!documentTypeMatches(typePattern, typeCheckSources(sources.docs))) {
                    logger.info(
                        { projectId, rubric: rubric.name },
                        '[LLM] compliance: document type pattern matches nowhere, refusing at enqueue'
                    )
                    return res.json({
                        ok: false,
                        error: 'type_mismatch',
                        message: inLanguage(rubricLang, TYPE_MISMATCH_MESSAGE_EN, TYPE_MISMATCH_MESSAGE_IT),
                        expectedDocument: (splitRubric(rubric.guidelines).preamble || rubric.name || '').trim(),
                        certain: true,
                    })
                }
            }
        } catch (err) {
            logger.warn({ projectId, err }, '[LLM] compliance: enqueue-time type check failed, carrying on')
        }
    }

    // The authoritative admission check, immediately before the job is registered. The
    // scan above contains an await, which reopens the window a double click needs.
    const admitted = admissionCheck()
    if (admitted) {
        return res.json(admitted)
    }

    const job = {
        id: newJobId(),
        projectId,
        userId,
        rubricId,
        rubricName: rubric.name,
        // overleaf-lab: taken over the guidelines, not over the name: editing a
        // requirement leaves the name untouched while changing what its verdict
        // means, and comparing two reports across that edit would be a lie.
        rubricFingerprint: ComplianceStore.rubricFingerprint(rubric.guidelines),
        confirmed: Boolean(confirmed),
        // overleaf-lab: the mode travels ON THE JOB and is read from there by the
        // planner, the mailer and the archive. One field, one source: a report that
        // says "fast" and a run that called a model cannot come from this.
        mode,
        status: 'queued',
        result: null,
        errorCode: null,
        message: null,
        documentTokensEstimate: null,
        maxContextTokens: null,
        reviewMaxTokens: null,
        controller: null,
        // overleaf-lab: the backend this job runs on, decided at pickup and never
        // again. Null while queued: a job that has not started has not been promised
        // a machine, which is what lets the dispatcher route around one that is down
        // without anything to undo.
        endpoint: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        // overleaf-lab: pass-based progress (one model call per requirement),
        // filled in by performReview and read by the status endpoint.
        passesTotal: null,
        passesDone: 0,
        currentRequirement: '',
    }
    jobs.set(job.id, job)
    if (fast) {
        // overleaf-lab: the fast lane, and DELIBERATELY NOT PERSISTED.
        //
        // The work list exists so that a review interrupted by the nightly `docker
        // stop` is resumed instead of lost, which is worth doing for an hour of GPU.
        // A fast review is seconds and one click, and resuming one would be actively
        // wrong: the resume path waits for a model backend to answer before it starts
        // anything and then pushes what it claimed onto the GPU queue, so a review
        // that was chosen precisely because it needs no model would come back as
        // exactly the thing the user did not ask for.
        fastQueue.push(job.id)
        processFastQueue()
    } else {
        queue.push(job.id)
        // overleaf-lab: persist the job as soon as it is owed, so the nightly backup
        // (docker stop, then docker rm) no longer swallows a review that was queued or
        // halfway through. Best effort: losing the archive must never block a review.
        ComplianceStore.rememberJobQuietly(job)
        // overleaf-lab: kick the queue; it runs to its first await, so if nothing else
        // is running this job may already be 'running' by the time we respond.
        processQueue()
    }

    return res.json({
        ok: true,
        jobId: job.id,
        status: job.status,
        position: jobsAhead(job.id),
    })
    } finally {
        startsInFlight.delete(startKey)
        releaseStart()
    }
}

// overleaf-lab: the status payload for one job, shared by the by-id and the
// latest-for-project endpoints. It always carries the jobId so a client that
// re-attaches through /latest can resume polling by id.
function jobStatusBody(job) {
    // overleaf-lab: WHICH REVIEW IS RUNNING, on every live body. The panel offers two
    // buttons and re-attaches to whatever it finds after a reload, so without this it
    // would have to guess which of the two it is watching - and the honest wait note
    // for a fast review ("seconds") is the wrong thing to show over a full one.
    const mode = job.mode === 'fast' ? 'fast' : 'full'
    switch (job.status) {
        case 'queued': {
            const body = { ok: true, jobId: job.id, status: 'queued', mode, position: jobsAhead(job.id) }
            // overleaf-lab: what "position 2" MEANS when several reviews run at once.
            // On one backend the number is the wait; on three it is not, and a panel
            // that says "2 reviews ahead of you" with three machines running is
            // describing a queue nobody is in. These two say how many are in flight
            // and how many can be, so the wait can be read instead of guessed. Added
            // only when a pool exists, so the single-backend payload is unchanged.
            if (poolIsConfigured()) {
                body.runningCount = busyEndpoints.size
                body.endpointCount = reviewEndpoints.length
            }
            return body
        }
        case 'running': {
            // overleaf-lab: pass-based progress. Each requirement is checked by its
            // own model call, so the bar reports REAL progress (passes completed over
            // total) instead of a time estimate. Before the rubric is split we are
            // still assembling the document: report 'preparing'.
            if (!job.passesTotal) {
                return { ok: true, jobId: job.id, status: 'running', mode, phase: 'preparing' }
            }
            return {
                ok: true,
                jobId: job.id,
                status: 'running',
                mode,
                phase: job.passesDone >= job.passesTotal ? 'summarizing' : 'checking',
                passesDone: job.passesDone,
                passesTotal: job.passesTotal,
                currentRequirement: job.currentRequirement || '',
                elapsedMs: Date.now() - (job.startedAt || job.createdAt),
            }
        }
        case 'done':
            return { ok: true, jobId: job.id, status: 'done', result: job.result }
        case 'error':
            return {
                ok: true,
                jobId: job.id,
                status: 'error',
                errorCode: job.errorCode,
                message: job.message,
                documentTokensEstimate: job.documentTokensEstimate,
                maxContextTokens: job.maxContextTokens,
                reviewMaxTokens: job.reviewMaxTokens,
                // overleaf-lab: what the rubric says it is for, so the panel can name
                // it back to the user instead of a bare "wrong document".
                expectedDocument: job.expectedDocument,
                certain: job.certain,
            }
        case 'cancelled':
            return { ok: true, jobId: job.id, status: 'cancelled' }
        default:
            return { ok: false, error: 'not_found', message: 'Review not found or expired' }
    }
}

// overleaf-lab: report a job's state. Always HTTP 200; a missing/foreign/expired
// job is reported as ok:false error:'not_found'.
async function statusReview(req, res) {
    const job = jobs.get(req.params.jobId)
    const userId = SessionManager.getLoggedInUserId(req.session)
    // overleaf-lab: the job must belong to the project in the URL, not just to the
    // caller. The route middleware authorises the caller for :Project_id and for
    // nothing else; a jobId minted on another project would otherwise answer here,
    // report body included, on the strength of an authorisation that was checked
    // against a different project entirely.
    if (!job || job.userId !== userId || job.projectId !== req.params.Project_id) {
        return res.json({ ok: false, error: 'not_found', message: 'Review not found or expired' })
    }
    return res.json(jobStatusBody(job))
}

// overleaf-lab: the most recent job of this project for this user. Browsers
// reload discarded background tabs (Chrome after ~30 min of inactivity), and a
// reloaded page has lost its jobId: this endpoint lets it re-attach to a running
// review, or recover a report that finished while nobody was watching (finished
// jobs are kept for JOB_TTL_MS). status:'none' when there is nothing to adopt.
async function latestReview(req, res) {
    sweepOldJobs()
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    let latest = null
    for (const job of jobs.values()) {
        if (job.projectId !== projectId || job.userId !== userId) {
            continue
        }
        if (!latest || job.createdAt > latest.createdAt) {
            latest = job
        }
    }
    if (latest) {
        // overleaf-lab: which rubric this project was last reviewed against, so the
        // panel can reopen on it. Reopening on the first rubric in the list left the
        // author looking at a name they had not chosen, with no way to tell whether
        // the report on screen had been produced with that one or another: the exact
        // doubt that makes somebody re-run a review they did not need.
        return res.json({ ...jobStatusBody(latest), rubricId: latest.rubricId || null })
    }
    // overleaf-lab: nothing live and nothing recent in memory, so fall back to the
    // archive. This is what makes a report survive a container restart, which used
    // to wipe every report ever produced. There is no jobId to return: the review
    // is long over and there is nothing left to poll.
    //
    // The NEWEST record, not the newest completed one. Asking only for reports meant
    // that a review which failed after the last successful one was invisible here, and
    // the endpoint answered with the older report under `status: 'done'` as though it
    // were the current state of the document. `stale` says out loud that what follows
    // came out of the archive and not out of a review that just ran.
    const stored = await ComplianceStore.findLatestRecordQuietly(projectId, userId)
    if (stored && stored.failed) {
        return res.json({
            ok: true,
            jobId: null,
            status: 'error',
            errorCode: stored.errorCode || 'failed',
            message: stored.message || null,
            storedAt: stored.finishedAt,
            rubricId: stored.rubricId || null,
            stale: true,
        })
    }
    if (stored && stored.result) {
        return res.json({
            ok: true,
            jobId: null,
            status: 'done',
            // The delta is stored next to the report rather than inside it, so that
            // the history list can read it without pulling the whole body; the panel
            // wants it in the same place as a fresh result.
            result: { ...stored.result, delta: stored.delta || null },
            storedAt: stored.finishedAt,
            rubricId: stored.rubricId || null,
            stale: true,
        })
    }
    return res.json({ ok: true, status: 'none' })
}

// overleaf-lab: cancel a job. Idempotent and never errors. Only the owner can
// cancel, and only the explicit Cancel button calls this: page unloads do NOT
// (a browser-initiated reload of a discarded tab must not kill a long review).
async function cancelReview(req, res) {
    const job = jobs.get(req.params.jobId)
    const userId = SessionManager.getLoggedInUserId(req.session)
    // Same project binding as statusReview, same reason.
    if (job && job.userId === userId && job.projectId === req.params.Project_id) {
        if (job.status === 'queued') {
            // overleaf-lab: pull it out of the queue so it never runs. Both queues:
            // a fast job waiting for a fast slot is queued in the other list, and the
            // status alone would only stop it at dispatch, leaving a cancelled id
            // sitting in front of everybody else's position count.
            const idx = queue.indexOf(job.id)
            if (idx !== -1) {
                queue.splice(idx, 1)
            }
            const fastIdx = fastQueue.indexOf(job.id)
            if (fastIdx !== -1) {
                fastQueue.splice(fastIdx, 1)
            }
            job.status = 'cancelled'
            job.finishedAt = Date.now()
            // overleaf-lab: and forget it in the store, which the running branch gets
            // for free from processQueue's finally and this one did not. Without this
            // the queued job stayed owed in Mongo: the nightly restart resumed it, and
            // the user woke up to a full GPU review they had explicitly cancelled,
            // archived in their history and announced by email.
            ComplianceStore.forgetJobQuietly(job.id)
        } else if (job.status === 'running') {
            // overleaf-lab: mark cancelled first, then abort so processQueue keeps
            // 'cancelled' instead of turning the abort into 'failed'. The finally in
            // processQueue sets finishedAt, and forgets the job in the store.
            //
            // This branch was lost once, absorbed into the queued one by an edit that
            // added the line above, and nothing caught it: the endpoint still answered
            // {ok:true} and the panel still said "cancelled", while the model kept
            // running to the end and the report landed anyway. A cancel that reports
            // success without cancelling is worse than no cancel button at all, hence
            // the test that now pins this branch.
            job.status = 'cancelled'
            if (job.controller) {
                job.controller.abort()
            }
        }
        // done/error/cancelled: no-op.
    }
    return res.json({ ok: true })
}

// overleaf-lab: pick up whatever the previous process still owed. A job only lives
// inside the process running it, so anything left as queued or running in the store
// was interrupted: the container was stopped, which here happens every night for the
// backup. Resumed jobs restart from the beginning, because the per-requirement work
// is not checkpointed, and the store counts the attempts so a review that keeps
// killing the process is eventually abandoned instead of being retried forever.
//
// Deliberately not awaited at import time: a slow or unreachable Mongo must delay
// the module, not prevent the web process from serving anything at all.
// overleaf-lab: is the model backend answering yet?
//
// "Answering" and not "answering correctly", which is the same rule the outage breaker
// uses: a backend that returns an HTTP error is a backend that is up. Only a socket
// failure or a timeout means it is not there.
//
// ANY of them, with a pool. The interrupted reviews are resumed as a batch and spread
// over whatever is up; waiting for the slowest machine of three to finish loading its
// model would hold every one of them behind the one that is still cold, and an
// endpoint that never comes back would hold them for the entire probe schedule and
// then leave them for the next boot. One answering backend is enough work to start,
// and the pickup probe sorts out which one each job gets.
//
// It is also where the pool snapshot is first filled after a restart: this is the one
// settings read that happens before anything is dispatched.
async function backendAnswers() {
    try {
        const admin = await getAdminLLMSettings()
        refreshReviewEndpoints(admin)
        for (const endpoint of reviewEndpoints) {
            if (await endpointAnswers(endpoint)) {
                return true
            }
        }
        return false
    } catch (err) {
        return false
    }
}

// The reviews being resumed were interrupted by a container restart, and at that moment
// the GPU backend is very often still coming up - it has a model to load. A cold backend
// produces a BackendOutageError in about two seconds, and a terminal job is forgotten in
// the store, so the resumed review died instantly and attempts 2 and 3 were never used:
// MAX_ATTEMPTS exists for exactly this failure and could not be spent on it. Waiting is
// the whole fix, so the schedule is generous: about a quarter of an hour, which is a
// large model load, and the timers are unref'd so they can never hold the process up.
const RESUME_PROBE_SCHEDULE_MS = [0, 5000, 15000, 30000, ...Array(15).fill(60000)]

function sleepUnref(ms) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms)
        if (typeof timer.unref === 'function') {
            timer.unref()
        }
    })
}

async function waitForBackend() {
    for (const delay of RESUME_PROBE_SCHEDULE_MS) {
        if (delay > 0) {
            await sleepUnref(delay)
        }
        if (await backendAnswers()) {
            return true
        }
    }
    return false
}

async function resumeInterruptedJobs() {
    // BEFORE claimInterruptedJobs, which is what counts the attempt. A backend that was
    // never reachable must not cost a job one of its three chances: leaving the
    // documents untouched at 'queued'/'running' means the next boot finds them exactly
    // as this one did, which is the correct state - the work really is still owed.
    if (!(await waitForBackend())) {
        logger.warn(
            {},
            '[LLM] compliance: the model backend never answered, leaving interrupted reviews for the next start'
        )
        return
    }
    const pending = await ComplianceStore.claimInterruptedJobs()
    if (!pending.length) {
        return
    }
    let adopted = 0
    for (const doc of pending) {
        // overleaf-lab: never adopt an id this process already knows. claimInterrupted
        // Jobs selects everything left as queued or running and puts it back to
        // queued, so it re-claims what it queued a moment earlier: called twice, it
        // hands back the same job twice, and each copy would get its own turn in the
        // queue and its own full review.
        if (jobs.has(doc.jobId)) {
            logger.warn(
                { jobId: doc.jobId },
                '[LLM] compliance: refusing to resume a job this process already has'
            )
            continue
        }
        const job = {
            id: doc.jobId,
            projectId: doc.projectId,
            userId: doc.userId,
            rubricId: doc.rubricId,
            rubricName: doc.rubricName,
            rubricFingerprint: doc.rubricFingerprint || null,
            // A resumed job never re-asks the type question: see rememberJob. Jobs
            // stored before this field existed resume as unconfirmed, which at worst
            // asks once more.
            confirmed: Boolean(doc.confirmed),
            status: 'queued',
            result: null,
            errorCode: null,
            message: null,
            documentTokensEstimate: null,
            maxContextTokens: null,
            reviewMaxTokens: null,
            controller: null,
            // A resumed job is re-dispatched from scratch, so it takes whichever
            // endpoint is free now and not the one it died on: the machine it was on
            // is exactly the one most likely to still be coming back up.
            endpoint: null,
            createdAt: doc.createdAt ? new Date(doc.createdAt).getTime() : Date.now(),
            startedAt: null,
            finishedAt: null,
            passesTotal: null,
            passesDone: 0,
            currentRequirement: '',
        }
        jobs.set(job.id, job)
        queue.push(job.id)
        adopted += 1
    }
    if (!adopted) {
        return
    }
    logger.info(
        { count: adopted, claimed: pending.length },
        '[LLM] compliance: resuming reviews interrupted by a restart'
    )
    processQueue()
}

resumeInterruptedJobs().catch(err => {
    logger.warn({ err }, '[LLM] compliance: could not resume interrupted reviews')
})

export default {
    getRubrics: expressify(getRubrics),
    startReview: expressify(startReview),
    statusReview: expressify(statusReview),
    latestReview: expressify(latestReview),
    cancelReview: expressify(cancelReview),
}
