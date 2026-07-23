import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import { getAdminLLMSettings, getComplianceRubrics, getLLMFeatureFlags, getLLMPrompts } from './LLMAdminController.mjs'

// overleaf-lab: in-memory job queue for compliance reviews. A review sends the
// whole project to the LLM and can run for minutes, so we run one at a time per
// web process and let the client poll a job for progress, cancel, and result.
const jobs = new Map() // jobId -> job
const queue = [] // array of jobId, FIFO
let running = false // one review at a time
// overleaf-lab: keep finished jobs for 30 min so a re-poll after a tab switch still
// returns the result instead of a not_found. A large review can finish long after the
// user last looked at the panel, so the retention must be generous.
const JOB_TTL_MS = 30 * 60 * 1000

// overleaf-lab: FALLBACK token budget for the review's JSON answer, used when the
// admin has not set one in the LLM settings page (which is the normal way to change
// it). The effective value is BOTH the hard max_tokens sent to the model AND the room
// the context-window guard reserves for the answer, so raising it slightly lowers the
// largest single-pass document and lengthens the worst-case review.
const REVIEW_MAX_TOKENS =
    Number.parseInt(process.env.LLM_REVIEW_MAX_TOKENS, 10) > 0
        ? Number.parseInt(process.env.LLM_REVIEW_MAX_TOKENS, 10)
        : 12000

// overleaf-lab: rough backend throughput, used ONLY to show a progress estimate in
// the UI (the review is one long blocking call, there is no exact percentage). The
// two phases are prefill (the model reads the whole document, the long output-less
// part) and generation (it writes the report). Defaults are measured on the reference
// CPU backend; override with LLM_REVIEW_PREFILL_TPS / LLM_REVIEW_GEN_TPS if yours
// differs (a wrong estimate only skews the bar, never the result).
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
const REVIEW_EST_OUTPUT_TOKENS = 1500 // typical size of a structured JSON report

// overleaf-lab: throughput measured from the backend, so the progress bar calibrates
// itself instead of asking an admin to guess tokens/sec. llama.cpp reports
// timings.prompt_per_second / predicted_per_second on every response, so a real review
// gives the exact numbers for free; a small probe seeds them before the FIRST review.
// Process-local on purpose: it is a display estimate, not state worth persisting, and
// one review (or one probe) re-learns it after a restart.
let measuredPrefillTps = null
let measuredGenTps = null
let ratesProbed = false

// overleaf-lab: sample-size gates for trusting a timings measurement. llama.cpp
// reports prompt_per_second over the tokens it ACTUALLY evaluated (prompt_n): on a
// prompt-cache hit that can be a single token, and the resulting "rate" is pure
// per-request overhead (~76 tok/s observed where the true prefill was ~5400), so
// accepting it would poison a good calibration. Two tiers: a STRONG sample (a real
// review) always updates; a smaller one is accepted only as the FIRST seed (that is
// how the probe gets in, its ~660/8-token samples sit below the strong bars) and
// never below the MIN floor, so a cache-hit rerun can never become the calibration.
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

// overleaf-lab: one cheap request whose only purpose is to read `timings`, so even the
// first review shows a sensible bar. Deliberately lazy (right before the first review)
// rather than at boot: at boot the backend may not be up yet, and a probe would add a
// network call plus retries to Overleaf startup for no gain. Best-effort: any failure
// leaves the fallbacks in place, and the first real review corrects them anyway.
// The prompt is padded so prompt_per_second is measured on a non-trivial prefill; the
// probe's samples are still small, so recordTimings only accepts them as a first seed
// and the first real review replaces them with a full-size measurement.
async function probeBackendRates(llmApiUrl, llmApiKey, model) {
    ratesProbed = true
    try {
        const headers = { 'Content-Type': 'application/json' }
        if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
            headers.Authorization = `Bearer ${llmApiKey}`
        }
        const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(60)
        const response = await fetch(`${llmApiUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: `${filler}\n\nReply with: ok` }],
                max_tokens: 8,
                temperature: 0,
            }),
        })
        if (!response.ok) {
            return
        }
        const data = await response.json()
        recordTimings(data && data.timings)
        if (measuredPrefillTps || measuredGenTps) {
            logger.debug(
                { prefillTps: measuredPrefillTps, genTps: measuredGenTps },
                '[LLM] compliance: measured backend throughput for the progress estimate'
            )
        }
    } catch (err) {
        logger.debug({ err }, '[LLM] compliance: throughput probe failed, using fallbacks')
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
async function countPromptTokens(llmApiUrl, llmApiKey, text) {
    try {
        const headers = { 'Content-Type': 'application/json' }
        if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
            headers.Authorization = `Bearer ${llmApiKey}`
        }
        const response = await fetch(`${llmApiUrl}/tokenize`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ content: text }),
        })
        if (!response.ok) {
            return null
        }
        const data = await response.json()
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

// overleaf-lab: JSON Schema for the review answer, enforced by the backend via
// response_format so the model is CONSTRAINED to emit exactly this shape (llama.cpp
// and OpenAI both support json_schema). This removes the "No JSON object found"
// failure class by construction and, because prose is forbidden, also stops a
// reasoning model from spending the whole answer budget on internal thinking.
// extractJson below is kept only as a defensive fallback for a backend that ignores
// the field. The fields mirror what the parser reads (see performReview).
const REVIEW_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        summary: { type: 'string' },
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    requirement: { type: 'string' },
                    status: { type: 'string', enum: ['ok', 'partial', 'missing', 'na'] },
                    evidence: { type: 'string' },
                    suggestion: { type: 'string' },
                },
                required: ['requirement', 'status', 'evidence', 'suggestion'],
            },
        },
    },
    required: ['summary', 'items'],
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
                if (ch === '%' && (i === 0 || line[i - 1] !== '\\')) {
                    break
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

// overleaf-lab: how many reviews are ahead of this job: the running one (if any)
// plus the queued jobs before it. A job that is not in the queue (running, about
// to run, or finished) has nothing ahead, so return 0.
function jobsAhead(jobId) {
    const idx = queue.indexOf(jobId)
    if (idx === -1) {
        return 0
    }
    return idx + (running ? 1 : 0)
}

// overleaf-lab: run the actual review work for one job. Returns a discriminated
// outcome: { type: 'done', result } on success, or { type: 'error', errorCode,
// message, ... } for a logical failure (too_long / model_unavailable /
// empty_document). Throws on an HTTP/parse failure or an abort (cancel or the
// review timeout); processQueue maps those to the 'cancelled' or 'failed' state.
async function performReview(job) {
    const { projectId, userId } = job

    // overleaf-lab: resolve the rubric fresh at run time (the job only stores id and
    // name) so the guidelines text is current when the job finally runs.
    const rubrics = await getComplianceRubrics()
    const rubric = rubrics.find(r => r.id === job.rubricId)
    if (!rubric) {
        throw new Error('Rubric is no longer available')
    }

    // Effective backend configuration.
    const admin = await getAdminLLMSettings()
    const llmApiUrl = admin.llmApiUrl
    const llmApiKey = admin.llmApiKey
    if (!llmApiUrl) {
        throw new Error('LLM backend is not configured')
    }
    const maxContextTokens = admin.maxContextTokens || 32000
    // overleaf-lab: the admin-set answer budget wins; fall back to the env default.
    const reviewMaxTokens = admin.reviewMaxTokens || REVIEW_MAX_TOKENS
    // overleaf-lab: prefer the admin-chosen review model, then the first allowed
    // model, then the env-derived default (mirrors the chat model fallback).
    const reviewModel =
        (admin.reviewModel && admin.reviewModel.trim()) ||
        (admin.allowedModels && admin.allowedModels[0]) ||
        ((process.env.LLM_MODEL_NAME || process.env.LLM_AVAILABLE_MODELS || 'default').split(',')[0].trim())

    // overleaf-lab: resolve the effective editable prompts (admin override or the
    // shipped default) so the review uses the admin-tuned system prompt.
    const prompts = await getLLMPrompts()

    // Assemble the whole project into one LaTeX blob.
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

    // overleaf-lab: put the main file (the one containing \documentclass) first,
    // then the remaining docs sorted by path for a stable order.
    docs.sort((a, b) => {
        const aMain = a.text.includes('\\documentclass')
        const bMain = b.text.includes('\\documentclass')
        if (aMain && !bMain) {
            return -1
        }
        if (!aMain && bMain) {
            return 1
        }
        return a.path.localeCompare(b.path)
    })

    // overleaf-lab: strip LaTeX comments per source doc BEFORE prefixing the FILE
    // header, so the header lines (which themselves start with `%`) survive.
    const parts = docs.map(
        d => `% ===== FILE: ${d.path} =====\n${stripLatexComments(d.text)}`
    )
    const assembled = parts.join('\n\n')

    if (!assembled.trim()) {
        return {
            type: 'error',
            errorCode: 'empty_document',
            message: 'The project has no text to review',
        }
    }

    // Context-window guard. Budget the WHOLE prompt against the configured context
    // window: document + rubric guidelines + system prompt + room for the JSON
    // answer. The rubric can be large, so it must count too, otherwise the document
    // could pass here and the full prompt still overflow.
    // overleaf-lab: prefer the backend's exact count; fall back to the heuristic when
    // it has no /tokenize (see countPromptTokens).
    const heuristicPromptTokens =
        estimateTokens(assembled) +
        estimateTokens(rubric.guidelines) +
        estimateTokens(prompts.reviewSystemPrompt)
    const exactPromptTokens = await countPromptTokens(
        llmApiUrl,
        llmApiKey,
        `${prompts.reviewSystemPrompt}\n${rubric.guidelines}\n${assembled}`
    )
    const promptTokens = exactPromptTokens || heuristicPromptTokens
    logger.debug(
        { projectId, promptTokens, exact: exactPromptTokens != null, heuristicPromptTokens },
        '[LLM] compliance: prompt size'
    )
    // overleaf-lab: expose the size so the status endpoint can estimate progress.
    job.documentTokensEstimate = promptTokens
    if (promptTokens + reviewMaxTokens > maxContextTokens) {
        // overleaf-lab: report the answer budget too. Without it the UI could only show
        // "prompt / limit", which looks like it fits (65158 / 66000) while the refusal
        // is really caused by the reserved answer room pushing the total over.
        return {
            type: 'error',
            errorCode: 'too_long',
            message:
                'Document is too long for a single-pass review with the configured context window',
            documentTokensEstimate: promptTokens,
            maxContextTokens,
            reviewMaxTokens,
        }
    }

    // Reachability check: only when an explicit review model is configured.
    // overleaf-lab: verify the configured model is actually served by the backend.
    // If the /models call itself fails, log and continue; the chat call below will
    // surface any real error.
    if (typeof admin.reviewModel === 'string' && admin.reviewModel.trim().length > 0) {
        try {
            const modelsHeaders = {}
            if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
                modelsHeaders.Authorization = `Bearer ${llmApiKey}`
            }
            const modelsResponse = await fetch(`${llmApiUrl}/models`, {
                method: 'GET',
                headers: modelsHeaders,
            })
            if (modelsResponse.ok) {
                const modelsData = await modelsResponse.json()
                const ids = Array.isArray(modelsData?.data)
                    ? modelsData.data.map(entry => String(entry.id))
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
                    { projectId, status: modelsResponse.status },
                    '[LLM] compliance: /models check returned non-ok, continuing'
                )
            }
        } catch (err) {
            logger.warn({ projectId, err }, '[LLM] compliance: /models check failed, continuing')
        }
    }

    // Build and send the review request.
    const userContent = `GUIDELINES:\n${rubric.guidelines}\n\nDOCUMENT:\n${assembled}`
    const requestBody = {
        model: reviewModel,
        messages: [
            { role: 'system', content: prompts.reviewSystemPrompt },
            { role: 'user', content: userContent },
        ],
        max_tokens: reviewMaxTokens,
        temperature: 0.2,
        // overleaf-lab: constrain the answer to the review JSON shape (see
        // REVIEW_JSON_SCHEMA). Guarantees parseable output and, because prose is
        // forbidden, prevents a reasoning model from burning the budget on thinking.
        // enable_thinking:false for a local reasoning model is handled at the router
        // (llama-only), not here, so this stays portable to cloud backends.
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'compliance_review',
                strict: true,
                schema: REVIEW_JSON_SCHEMA,
            },
        },
    }

    // overleaf-lab: the review is async (the client polls the job status), so this
    // web->LLM fetch does NOT pass through nginx and is not bound by its 600s proxy
    // limit. It aborts the job's own AbortController, the same signal the cancel
    // endpoint uses, so both a timeout and a user cancel abort the in-flight fetch.
    //
    // The timeout is SIZED FROM THE WORK instead of being a fixed hour: prefill of the
    // whole document plus a full-budget generation is the worst case. With a large
    // answer budget on a slow CPU backend that worst case exceeds an hour, and a fixed
    // 60 min would kill a review that was still legitimately writing. The old fixed
    // value stays as the floor, so short reviews are unaffected.
    // overleaf-lab: before the first review, spend one cheap request learning the
    // backend's real speed, so the bar is not off by orders of magnitude on hardware
    // that differs from the fallbacks. Skipped when an operator pinned the rates.
    if (!ratesProbed && !(ENV_PREFILL_TPS && ENV_GEN_TPS)) {
        await probeBackendRates(llmApiUrl, llmApiKey, reviewModel)
    }
    const rates = effectiveRates()
    const estimatedPrefillMs = Math.round(
        (promptTokens / rates.prefillTps) * 1000
    )
    const worstCaseMs =
        estimatedPrefillMs + Math.round((reviewMaxTokens / rates.genTps) * 1000)
    const reviewTimeoutMs = Math.max(
        REVIEW_MIN_TIMEOUT_MS,
        Math.round(worstCaseMs * 1.5)
    )
    const timeout = setTimeout(() => {
        if (job.controller) {
            job.controller.abort()
        }
    }, reviewTimeoutMs)

    try {
        // overleaf-lab: send Authorization only when a non-empty key exists, so a
        // keyless local server is not sent a malformed empty Bearer header.
        const chatHeaders = { 'Content-Type': 'application/json' }
        if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
            chatHeaders.Authorization = `Bearer ${llmApiKey}`
        }

        // overleaf-lab: the model call starts now. Seed the progress estimate the
        // status endpoint reports: prefill (reading the whole prompt) is the long,
        // output-less phase, then generation writes the report.
        job.progressStartedAt = Date.now()
        job.estimatedPrefillMs = estimatedPrefillMs
        // The bar uses the TYPICAL report size, not the full budget: the budget is a
        // cap the model rarely fills, so using it here would make the bar crawl.
        job.estimatedTotalMs =
            estimatedPrefillMs +
            Math.round((REVIEW_EST_OUTPUT_TOKENS / rates.genTps) * 1000)

        const response = await fetch(`${llmApiUrl}/chat/completions`, {
            method: 'POST',
            headers: chatHeaders,
            body: JSON.stringify(requestBody),
            // overleaf-lab: pass the job signal so cancel (and the review timeout) abort it.
            signal: job.controller.signal,
        })

        clearTimeout(timeout)

        if (!response.ok) {
            const errorText = await response.text()
            logger.error(
                { projectId, userId, status: response.status, error: errorText },
                '[LLM] compliance: LLM API error'
            )
            const backendError = parseBackendError(errorText)

            // overleaf-lab: a context overflow is reported by the backend with the
            // real numbers, which beat our own estimate. Surface it as 'too_long' (the
            // UI already renders that with the token counts) instead of letting it
            // become the generic "failed or timed out", which named the wrong cause.
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
                    reviewMaxTokens,
                }
            }

            // Any other backend refusal: show the status and the backend's own text
            // (trimmed), so the user sees the real reason rather than a timeout.
            const detail = backendError.message.slice(0, 300)
            return {
                type: 'error',
                errorCode: 'backend_error',
                message: `The review model rejected the request (HTTP ${response.status})${
                    detail ? `: ${detail}` : ''
                }`,
            }
        }

        const data = await response.json()
        // overleaf-lab: the real review is the most representative measurement there
        // is (a full-size prefill), so let it refine the rates for the next one.
        recordTimings(data && data.timings)
        const content = stripThinkTags(data?.choices?.[0]?.message?.content || '')

        let parsed
        try {
            parsed = extractJson(content)
        } catch (err) {
            logger.warn({ projectId, err }, '[LLM] compliance: could not parse review JSON')
            throw new Error('Could not parse the review result')
        }

        const items = Array.isArray(parsed.items)
            ? parsed.items.map(it => ({
                  requirement: String(it.requirement || ''),
                  status: ['ok', 'partial', 'missing', 'na'].includes(it.status) ? it.status : 'na',
                  evidence: String(it.evidence || ''),
                  suggestion: String(it.suggestion || ''),
              }))
            : []

        return {
            type: 'done',
            result: {
                rubric: { id: rubric.id, name: rubric.name },
                model: reviewModel,
                documentTokensEstimate: promptTokens,
                maxContextTokens,
                summary: String(parsed.summary || ''),
                items,
            },
        }
    } catch (err) {
        clearTimeout(timeout)
        // overleaf-lab: rethrow so processQueue can tell a cancel (job already
        // 'cancelled') from the review timeout or a real failure.
        throw err
    }
}

// overleaf-lab: run the next queued job, one at a time. Recurse to skip missing or
// already-cancelled jobs, and always try the next job in a finally so a single job
// failure never stalls the queue.
async function processQueue() {
    if (running || queue.length === 0) {
        return
    }

    const jobId = queue.shift()
    const job = jobs.get(jobId)
    if (!job || job.status === 'cancelled') {
        // overleaf-lab: skip a job that vanished or was cancelled while queued.
        return processQueue()
    }

    running = true
    job.status = 'running'
    job.startedAt = Date.now()
    job.controller = new AbortController()

    try {
        const outcome = await performReview(job)
        // overleaf-lab: a cancel may have landed mid-run; if so, keep 'cancelled'.
        if (job.status !== 'cancelled') {
            if (outcome.type === 'done') {
                job.status = 'done'
                job.result = outcome.result
            } else {
                job.status = 'error'
                job.errorCode = outcome.errorCode
                job.message = outcome.message
                if (outcome.errorCode === 'too_long') {
                    job.documentTokensEstimate = outcome.documentTokensEstimate
                    job.reviewMaxTokens = outcome.reviewMaxTokens
                    job.maxContextTokens = outcome.maxContextTokens
                }
            }
        }
    } catch (err) {
        // overleaf-lab: cancel aborts the controller after setting status
        // 'cancelled', so keep that; any other throw (the review timeout abort or an
        // HTTP/parse failure) becomes a generic 'failed'.
        if (job.status !== 'cancelled') {
            job.status = 'error'
            job.errorCode = 'failed'
            job.message = 'The review request failed or timed out'
            logger.error(
                { projectId: job.projectId, userId: job.userId, err },
                '[LLM] compliance: review job failed'
            )
        }
    } finally {
        job.finishedAt = Date.now()
        running = false
        job.controller = null
        // overleaf-lab: never let one job's failure stall the queue.
        try {
            processQueue()
        } catch (err) {
            logger.error({ err }, '[LLM] compliance: failed to continue the queue')
        }
    }
}

async function getRubrics(req, res) {
    // overleaf-lab: review feature disabled by admin -> no rubrics to offer.
    const flags = await getLLMFeatureFlags()
    if (!flags.reviewEnabled) {
        return res.json({ rubrics: [] })
    }
    const rubrics = await getComplianceRubrics()
    // overleaf-lab: expose names only, never the guidelines text, to the project UI.
    res.json({ rubrics: rubrics.map(r => ({ id: r.id, name: r.name })) })
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
    const { rubricId } = req.body || {}

    logger.debug({ projectId, userId, rubricId }, '[LLM] compliance: start requested')

    // 3. Resolve the requested rubric (capture its name for the job).
    const rubrics = await getComplianceRubrics()
    const rubric = rubrics.find(r => r.id === rubricId)
    if (!rubric) {
        return res.json({ ok: false, error: 'no_rubric', message: 'Unknown or missing rubric' })
    }

    // 4. Effective backend configuration must at least have a URL.
    const admin = await getAdminLLMSettings()
    if (!admin.llmApiUrl) {
        return res.json({ ok: false, error: 'not_configured', message: 'LLM backend is not configured' })
    }

    // 5. Create and enqueue the job.
    sweepOldJobs()
    const job = {
        id: newJobId(),
        projectId,
        userId,
        rubricId,
        rubricName: rubric.name,
        status: 'queued',
        result: null,
        errorCode: null,
        message: null,
        documentTokensEstimate: null,
        maxContextTokens: null,
        reviewMaxTokens: null,
        controller: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        // overleaf-lab: progress estimate, filled in when the model call starts.
        progressStartedAt: null,
        estimatedPrefillMs: null,
        estimatedTotalMs: null,
    }
    jobs.set(job.id, job)
    queue.push(job.id)
    // overleaf-lab: kick the queue; it runs to its first await, so if nothing else
    // is running this job may already be 'running' by the time we respond.
    processQueue()

    return res.json({
        ok: true,
        jobId: job.id,
        status: job.status,
        position: jobsAhead(job.id),
    })
}

// overleaf-lab: report a job's state. Always HTTP 200; a missing/foreign/expired
// job is reported as ok:false error:'not_found'.
async function statusReview(req, res) {
    const job = jobs.get(req.params.jobId)
    const userId = SessionManager.getLoggedInUserId(req.session)
    if (!job || job.userId !== userId) {
        return res.json({ ok: false, error: 'not_found', message: 'Review not found or expired' })
    }

    switch (job.status) {
        case 'queued':
            return res.json({ ok: true, status: 'queued', position: jobsAhead(job.id) })
        case 'running': {
            // overleaf-lab: report an estimated progress so the UI can show a bar
            // instead of an open-ended spinner. Before the model call starts we are
            // still assembling the document (no estimate yet): report 'preparing'.
            if (!job.progressStartedAt || !job.estimatedTotalMs) {
                return res.json({ ok: true, status: 'running', phase: 'preparing' })
            }
            const elapsedMs = Date.now() - job.progressStartedAt
            const phase = elapsedMs < job.estimatedPrefillMs ? 'reading' : 'writing'
            const progress = Math.max(
                0,
                Math.min(0.95, elapsedMs / job.estimatedTotalMs)
            )
            return res.json({
                ok: true,
                status: 'running',
                phase,
                elapsedMs,
                estimatedTotalMs: job.estimatedTotalMs,
                progress,
            })
        }
        case 'done':
            return res.json({ ok: true, status: 'done', result: job.result })
        case 'error':
            return res.json({
                ok: true,
                status: 'error',
                errorCode: job.errorCode,
                message: job.message,
                documentTokensEstimate: job.documentTokensEstimate,
                maxContextTokens: job.maxContextTokens,
                reviewMaxTokens: job.reviewMaxTokens,
            })
        case 'cancelled':
            return res.json({ ok: true, status: 'cancelled' })
        default:
            return res.json({ ok: false, error: 'not_found', message: 'Review not found or expired' })
    }
}

// overleaf-lab: cancel a job. Idempotent and never errors, so a keepalive/beacon
// call on page unload stays simple. Only the owner can cancel.
async function cancelReview(req, res) {
    const job = jobs.get(req.params.jobId)
    const userId = SessionManager.getLoggedInUserId(req.session)
    if (job && job.userId === userId) {
        if (job.status === 'queued') {
            // overleaf-lab: pull it out of the queue so it never runs.
            const idx = queue.indexOf(job.id)
            if (idx !== -1) {
                queue.splice(idx, 1)
            }
            job.status = 'cancelled'
            job.finishedAt = Date.now()
        } else if (job.status === 'running') {
            // overleaf-lab: mark cancelled first, then abort so processQueue keeps
            // 'cancelled' instead of turning the abort into 'failed'. The finally in
            // processQueue sets finishedAt.
            job.status = 'cancelled'
            if (job.controller) {
                job.controller.abort()
            }
        }
        // done/error/cancelled: no-op.
    }
    return res.json({ ok: true })
}

export default {
    getRubrics: expressify(getRubrics),
    startReview: expressify(startReview),
    statusReview: expressify(statusReview),
    cancelReview: expressify(cancelReview),
}
