import logger from '@overleaf/logger'
import { promises as fs } from 'fs'
import path from 'path'
import { expressify } from '@overleaf/promise-utils'
import { encryptSecret, decryptSecret } from './LLMCrypto.mjs' // overleaf-lab: at-rest encryption of admin API key
import {
    DEFAULT_ASK_AI_SYSTEM_PROMPT,
    DEFAULT_ERROR_PROMPT,
    DEFAULT_REVIEW_SYSTEM_PROMPT,
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
        maxContextTokens: settings.maxContextTokens || 32000,
        reviewMaxTokens: settings.reviewMaxTokens || DEFAULT_REVIEW_MAX_TOKENS,
        scanPatterns: settings.scanPatterns || '',
        // overleaf-lab: per-feature enable flags; absent field defaults to true so
        // existing installs keep every feature on.
        chatEnabled: settings.chatEnabled !== false,
        completionEnabled: settings.completionEnabled !== false,
        reviewEnabled: settings.reviewEnabled !== false,
        // overleaf-lab: editable prompt overrides. Show the EFFECTIVE value (the
        // admin override when set, else the shipped default) plus the pristine
        // defaults so the admin page can offer a reset-to-default button.
        askAiSystemPrompt: settings.askAiSystemPrompt || DEFAULT_ASK_AI_SYSTEM_PROMPT,
        errorPrompt: settings.errorPrompt || DEFAULT_ERROR_PROMPT,
        reviewSystemPrompt: settings.reviewSystemPrompt || DEFAULT_REVIEW_SYSTEM_PROMPT,
        askAiActionPrompts: mergeActionPrompts(settings.askAiActionPrompts),
        promptDefaults: {
            askAiSystemPrompt: DEFAULT_ASK_AI_SYSTEM_PROMPT,
            errorPrompt: DEFAULT_ERROR_PROMPT,
            reviewSystemPrompt: DEFAULT_REVIEW_SYSTEM_PROMPT,
            askAiActionPrompts: DEFAULT_ASK_AI_ACTION_PROMPTS,
        },
    }
}

async function adminSettingsPage(req, res) {
    const pugPath = new URL('../../app/views/llm-admin-settings.pug', import.meta.url).pathname
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
        maxContextTokens,
        reviewMaxTokens,
        scanPatterns,
        chatEnabled,
        completionEnabled,
        reviewEnabled,
        // overleaf-lab: editable prompt overrides.
        askAiSystemPrompt,
        errorPrompt,
        reviewSystemPrompt,
        askAiActionPrompts,
    } = req.body

    if (typeof systemPrompt !== 'string') {
        return res.status(400).json({ error: 'systemPrompt must be a string' })
    }
    if (systemPrompt.length > 4000) {
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
            }))
            .filter(r => r.id && r.name)
            .slice(0, 50)
    } else {
        sanitizedRubrics = Array.isArray(existing.complianceRubrics) ? existing.complianceRubrics : []
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

    // overleaf-lab: validate the extra scan patterns ("Label :: regex" per line) so
    // the admin learns about a broken regex at save time, not from a silently
    // hint-less review. The reviewer side skips invalid lines anyway (defense in
    // depth for settings written by other means).
    if (scanPatterns !== undefined && typeof scanPatterns !== 'string') {
        return res.status(400).json({ error: 'scanPatterns must be a string' })
    }
    if (typeof scanPatterns === 'string') {
        if (scanPatterns.length > 4000) {
            return res.status(400).json({ error: 'scanPatterns must be 4000 characters or fewer' })
        }
        for (const rawLine of scanPatterns.split('\n')) {
            const line = rawLine.trim()
            if (!line) {
                continue
            }
            const sep = line.indexOf('::')
            const body = (sep === -1 ? line : line.slice(sep + 2)).trim()
            if (!body) {
                continue
            }
            try {
                // eslint-disable-next-line no-new
                new RegExp(body, 'i')
            } catch (err) {
                return res.status(400).json({ error: `Invalid scan pattern regex: ${body}` })
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
        systemPrompt,
        llmApiUrl: typeof llmApiUrl === 'string' ? llmApiUrl : (existing.llmApiUrl || ''),
        allowedModels: Array.isArray(allowedModels) ? allowedModels : existing.allowedModels || [],
        completionModel: typeof completionModel === 'string' ? completionModel : (existing.completionModel || ''),
        complianceRubrics: sanitizedRubrics,
        reviewModel: typeof reviewModel === 'string' ? reviewModel : (existing.reviewModel || ''),
        maxContextTokens: sanitizedMaxContextTokens,
        reviewMaxTokens: sanitizedReviewMaxTokens,
        scanPatterns: typeof scanPatterns === 'string' ? scanPatterns : (existing.scanPatterns || ''),
        // overleaf-lab: omitted flag keeps the existing value (default true).
        chatEnabled: typeof chatEnabled === 'boolean' ? chatEnabled : (existing.chatEnabled !== false),
        completionEnabled: typeof completionEnabled === 'boolean' ? completionEnabled : (existing.completionEnabled !== false),
        reviewEnabled: typeof reviewEnabled === 'boolean' ? reviewEnabled : (existing.reviewEnabled !== false),
        // overleaf-lab: editable prompt overrides. An empty string is stored as-is
        // and later falls back to the default via `|| DEFAULT`.
        askAiSystemPrompt: typeof askAiSystemPrompt === 'string' ? askAiSystemPrompt : (existing.askAiSystemPrompt || ''),
        errorPrompt: typeof errorPrompt === 'string' ? errorPrompt : (existing.errorPrompt || ''),
        reviewSystemPrompt: typeof reviewSystemPrompt === 'string' ? reviewSystemPrompt : (existing.reviewSystemPrompt || ''),
        askAiActionPrompts: sanitizedActionPrompts,
    }

    if (typeof llmApiKey === 'string' && llmApiKey.trim().length > 0) {
        updatedSettings.llmApiKey = encryptSecret(llmApiKey.trim()) // overleaf-lab: encrypt admin key at rest
    }

    await writeAdminSettings(updatedSettings)
    logger.info({
        length: systemPrompt.length,
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
        maxContextTokens: settings.maxContextTokens || 32000,
        reviewMaxTokens: settings.reviewMaxTokens || DEFAULT_REVIEW_MAX_TOKENS,
        scanPatterns: settings.scanPatterns || '',
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
        askAiActionPrompts: mergeActionPrompts(s.askAiActionPrompts),
    }
}

async function checkAdminLLMConnection(req, res) {
    const { apiUrl, apiKey } = req.body
    const adminSettings = await getAdminLLMSettings()
    const effectiveUrl = apiUrl || adminSettings.llmApiUrl
    const effectiveKey = apiKey || adminSettings.llmApiKey
    // overleaf-lab: use first configured/allowed model instead of hardcoded 'qwen3-32b'
    const testModel =
        adminSettings.allowedModels[0] ||
        (process.env.LLM_MODEL_NAME || 'default').split(',')[0].trim()

    // overleaf-lab: only the URL is required. A local llama.cpp server has no
    // auth, so an empty key is valid; send Authorization only when a key exists.
    if (!effectiveUrl) {
        return res.status(400).json({
            success: false,
            error: 'LLM API URL is required',
        })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

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

        clearTimeout(timeout)

        if (!response.ok) {
            const body = await response.text()
            return res.status(400).json({
                success: false,
                error: 'LLM connection failed',
                status: response.status,
                details: body,
            })
        }

        res.json({ success: true, message: 'Connection successful' })
    } catch (err) {
        clearTimeout(timeout)
        if (err.name === 'AbortError') {
            return res.status(504).json({
                success: false,
                error: 'Connection timeout',
            })
        }
        logger.error({ err }, '[LLM] Admin connection check failed')
        res.status(500).json({ success: false, error: 'Connection attempt failed' })
    }
}

async function scanAdminModels(req, res) {
    const { apiUrl, apiKey } = req.query
    const adminSettings = await getAdminLLMSettings()
    const llmApiUrl = apiUrl || adminSettings.llmApiUrl
    const llmApiKey = apiKey || adminSettings.llmApiKey

    // overleaf-lab: only the URL is required. A local llama.cpp server has no
    // auth, so an empty key is valid; send Authorization only when a key exists.
    if (!llmApiUrl) {
        return res.status(400).json({
            success: false,
            error: 'Admin LLM API URL must be configured first',
        })
    }

    try {
        const headers = {}
        if (typeof llmApiKey === 'string' && llmApiKey.length > 0) {
            headers.Authorization = `Bearer ${llmApiKey}`
        }
        const response = await fetch(`${llmApiUrl}/models`, {
            method: 'GET',
            headers,
        })

        if (!response.ok) {
            const body = await response.text()
            return res.status(400).json({
                success: false,
                error: 'Failed to fetch models',
                status: response.status,
                details: body,
            })
        }

        const data = await response.json()
        const ids = Array.isArray(data?.data)
            ? data.data.map(entry => String(entry.id))
            : []

        res.json({ success: true, models: ids })
    } catch (error) {
        logger.error({ err: error }, '[LLM] Admin model scan failed')
        res.status(500).json({ success: false, error: 'Model scan failed' })
    }
}

export default {
    adminSettingsPage: expressify(adminSettingsPage),
    getAdminSettings: expressify(getAdminSettings),
    saveAdminSettings: expressify(saveAdminSettings),
    checkAdminLLMConnection: expressify(checkAdminLLMConnection),
    scanAdminModels: expressify(scanAdminModels),
}
