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
// overleaf-lab: keep finished jobs for 15 min so a re-poll after a tab switch
// still returns the result instead of a not_found.
const JOB_TTL_MS = 15 * 60 * 1000

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

// overleaf-lab: rough token estimate (about 4 characters per token) used only to
// keep a single-pass review within the configured context window.
function estimateTokens(text) {
    return Math.ceil(text.length / 4)
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
// 570s timeout); processQueue maps those to the 'cancelled' or 'failed' state.
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
    const documentTokensEstimate = estimateTokens(assembled)
    const OUTPUT_RESERVE = 4000 // overleaf-lab: max_tokens for the review answer
    const promptTokensEstimate =
        documentTokensEstimate +
        estimateTokens(rubric.guidelines) +
        estimateTokens(prompts.reviewSystemPrompt)
    if (promptTokensEstimate + OUTPUT_RESERVE > maxContextTokens) {
        return {
            type: 'error',
            errorCode: 'too_long',
            message:
                'Document is too long for a single-pass review with the configured context window',
            documentTokensEstimate,
            maxContextTokens,
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
        max_tokens: 4000,
        temperature: 0.2,
    }

    // overleaf-lab: 570s timeout, just under the nginx 600s limit. It aborts the
    // job's own AbortController, the same signal the cancel endpoint uses, so both
    // a timeout and a user cancel abort the in-flight fetch.
    const timeout = setTimeout(() => {
        if (job.controller) {
            job.controller.abort()
        }
    }, 570000)

    try {
        // overleaf-lab: send Authorization only when a non-empty key exists, so a
        // keyless local server is not sent a malformed empty Bearer header.
        const chatHeaders = { 'Content-Type': 'application/json' }
        if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
            chatHeaders.Authorization = `Bearer ${llmApiKey}`
        }

        const response = await fetch(`${llmApiUrl}/chat/completions`, {
            method: 'POST',
            headers: chatHeaders,
            body: JSON.stringify(requestBody),
            // overleaf-lab: pass the job signal so cancel (and the 570s timeout) abort it.
            signal: job.controller.signal,
        })

        clearTimeout(timeout)

        if (!response.ok) {
            const errorText = await response.text()
            logger.error(
                { projectId, userId, status: response.status, error: errorText },
                '[LLM] compliance: LLM API error'
            )
            throw new Error(`LLM API error: ${response.status}`)
        }

        const data = await response.json()
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
                documentTokensEstimate,
                maxContextTokens,
                summary: String(parsed.summary || ''),
                items,
            },
        }
    } catch (err) {
        clearTimeout(timeout)
        // overleaf-lab: rethrow so processQueue can tell a cancel (job already
        // 'cancelled') from the 570s timeout or a real failure.
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
                    job.maxContextTokens = outcome.maxContextTokens
                }
            }
        }
    } catch (err) {
        // overleaf-lab: cancel aborts the controller after setting status
        // 'cancelled', so keep that; any other throw (the 570s timeout abort or an
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
        controller: null,
        createdAt: Date.now(),
        finishedAt: null,
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
        case 'running':
            return res.json({ ok: true, status: 'running' })
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
