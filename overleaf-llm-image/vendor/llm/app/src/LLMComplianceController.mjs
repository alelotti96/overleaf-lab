import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import { getAdminLLMSettings, getComplianceRubrics } from './LLMAdminController.mjs'

// overleaf-lab: single-flight guard. A compliance review sends the whole project
// to the LLM and can run for minutes, so we allow only one at a time per process.
let activeReviews = 0
const MAX_CONCURRENT_REVIEWS = 1

// overleaf-lab: system prompt for the compliance reviewer. Kept as a constant so
// the exact instructions (JSON-only output, reply in the guidelines language) are
// easy to audit and tune.
const COMPLIANCE_SYSTEM_PROMPT = `You are a meticulous reviewer that checks whether a LaTeX document complies with a set of writing guidelines for academic theses and internship reports.

You will receive:
1. GUIDELINES: the requirements the document must satisfy.
2. DOCUMENT: the full LaTeX source of the project (possibly multiple files, each marked with a FILE header).

For each distinct requirement you can identify in the GUIDELINES, judge whether the DOCUMENT satisfies it. Base your judgement only on the DOCUMENT content.

Reply in the same language as the GUIDELINES (for example, in Italian if the guidelines are in Italian).

Return ONLY a JSON object, with no preamble, no explanation, and no code fences, in exactly this shape:
{
  "summary": "a short overall assessment (2 to 4 sentences)",
  "items": [
    { "requirement": "the guideline requirement, restated concisely", "status": "ok", "evidence": "a short quote or the section/file where it is satisfied, or why it is missing", "suggestion": "a concrete suggestion to satisfy it (empty string when status is ok)" }
  ]
}
Use "ok" when clearly satisfied, "partial" when partially satisfied, "missing" when not satisfied, "na" when not applicable or impossible to verify from the source.`

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

async function getRubrics(req, res) {
    const rubrics = await getComplianceRubrics()
    // overleaf-lab: expose names only, never the guidelines text, to the project UI.
    res.json({ rubrics: rubrics.map(r => ({ id: r.id, name: r.name })) })
}

async function runCompliance(req, res) {
    // 1. Service disabled globally.
    if (Settings.llm && !Settings.llm.enabled) {
        return res.json({ ok: false, error: 'disabled', message: 'LLM service is disabled' })
    }

    // 2. Single-flight: refuse if a review is already running.
    if (activeReviews >= MAX_CONCURRENT_REVIEWS) {
        return res.json({
            ok: false,
            error: 'busy',
            message: 'A review is already running. Please try again in a moment.',
        })
    }

    // 3. Request context.
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    const { rubricId } = req.body || {}

    logger.debug({ projectId, userId, rubricId }, '[LLM] compliance: request received')

    // 4. Resolve the requested rubric.
    const rubrics = await getComplianceRubrics()
    const rubric = rubrics.find(r => r.id === rubricId)
    if (!rubric) {
        return res.json({ ok: false, error: 'no_rubric', message: 'Unknown or missing rubric' })
    }

    // 5. Effective backend configuration.
    const admin = await getAdminLLMSettings()
    const llmApiUrl = admin.llmApiUrl
    const llmApiKey = admin.llmApiKey
    if (!llmApiUrl) {
        return res.json({ ok: false, error: 'not_configured', message: 'LLM backend is not configured' })
    }
    const maxContextTokens = admin.maxContextTokens || 32000
    // overleaf-lab: prefer the admin-chosen review model, then the first allowed
    // model, then the env-derived default (mirrors the chat model fallback).
    const reviewModel =
        (admin.reviewModel && admin.reviewModel.trim()) ||
        (admin.allowedModels && admin.allowedModels[0]) ||
        ((process.env.LLM_MODEL_NAME || process.env.LLM_AVAILABLE_MODELS || 'default').split(',')[0].trim())

    // overleaf-lab: take the single-flight slot BEFORE the long work and always
    // release it in the finally, so any early return, error, or timeout still frees
    // it. The disabled/busy/no_rubric/not_configured returns above run before the
    // increment, so they do not need to release.
    activeReviews++
    try {
        // 6. Assemble the whole project into one LaTeX blob.
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
            return res.json({ ok: false, error: 'empty_document', message: 'The project has no text to review' })
        }

        // 7. Context-window guard. Budget the WHOLE prompt against the configured
        // context window: document + rubric guidelines + system prompt + room for
        // the JSON answer. The rubric can be large, so it must count too, otherwise
        // the document could pass here and the full prompt still overflow.
        const documentTokensEstimate = estimateTokens(assembled)
        const OUTPUT_RESERVE = 4000 // overleaf-lab: max_tokens for the review answer
        const promptTokensEstimate =
            documentTokensEstimate +
            estimateTokens(rubric.guidelines) +
            estimateTokens(COMPLIANCE_SYSTEM_PROMPT)
        if (promptTokensEstimate + OUTPUT_RESERVE > maxContextTokens) {
            return res.json({
                ok: false,
                error: 'too_long',
                documentTokensEstimate,
                maxContextTokens,
                message: 'Document is too long for a single-pass review with the configured context window',
            })
        }

        // 8. Reachability check: only when an explicit review model is configured.
        // overleaf-lab: verify the configured model is actually served by the
        // backend. If the /models call itself fails, log and continue; the chat call
        // below will surface any real error.
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
                        return res.json({
                            ok: false,
                            error: 'model_unavailable',
                            message: 'The configured review model is not available on the backend',
                        })
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

        // 9. Build and send the review request.
        const userContent = `GUIDELINES:\n${rubric.guidelines}\n\nDOCUMENT:\n${assembled}`
        const requestBody = {
            model: reviewModel,
            messages: [
                { role: 'system', content: COMPLIANCE_SYSTEM_PROMPT },
                { role: 'user', content: userContent },
            ],
            max_tokens: 4000,
            temperature: 0.2,
        }

        // overleaf-lab: 570s timeout, just under the nginx 600s limit.
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 570000)

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
                signal: controller.signal,
            })

            clearTimeout(timeout)

            // 10. Handle the response.
            if (!response.ok) {
                const errorText = await response.text()
                logger.error(
                    { projectId, userId, status: response.status, error: errorText },
                    '[LLM] compliance: LLM API error'
                )
                return res.json({ ok: false, error: 'failed', message: 'The review request failed or timed out' })
            }

            const data = await response.json()
            const content = stripThinkTags(data?.choices?.[0]?.message?.content || '')

            let parsed
            try {
                parsed = extractJson(content)
            } catch (err) {
                logger.warn({ projectId, err }, '[LLM] compliance: could not parse review JSON')
                return res.json({ ok: false, error: 'failed', message: 'Could not parse the review result' })
            }

            const items = Array.isArray(parsed.items)
                ? parsed.items.map(it => ({
                      requirement: String(it.requirement || ''),
                      status: ['ok', 'partial', 'missing', 'na'].includes(it.status) ? it.status : 'na',
                      evidence: String(it.evidence || ''),
                      suggestion: String(it.suggestion || ''),
                  }))
                : []

            return res.json({
                ok: true,
                rubric: { id: rubric.id, name: rubric.name },
                model: reviewModel,
                documentTokensEstimate,
                maxContextTokens,
                summary: String(parsed.summary || ''),
                items,
            })
        } catch (err) {
            clearTimeout(timeout)
            logger.error({ projectId, userId, err }, '[LLM] compliance: review request failed')
            return res.json({ ok: false, error: 'failed', message: 'The review request failed or timed out' })
        }
    } finally {
        // overleaf-lab: always release the single-flight slot.
        activeReviews--
    }
}

export default {
    getRubrics: expressify(getRubrics),
    runCompliance: expressify(runCompliance),
}
