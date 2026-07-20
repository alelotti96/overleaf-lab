import logger from '@overleaf/logger'
import { promises as fs } from 'fs'
import path from 'path'
import { expressify } from '@overleaf/promise-utils'
import { encryptSecret, decryptSecret } from './LLMCrypto.mjs' // overleaf-lab: at-rest encryption of admin API key

// Persist admin LLM settings in the same volume used by Overleaf data
const ADMIN_SETTINGS_PATH = process.env.LLM_ADMIN_SETTINGS_PATH ||
    '/var/lib/overleaf/data/llm-admin-settings.json'

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
    const { systemPrompt, llmApiUrl, llmApiKey, allowedModels, completionModel } = req.body

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

    const existing = await readAdminSettings()
    const updatedSettings = {
        ...existing,
        systemPrompt,
        llmApiUrl: typeof llmApiUrl === 'string' ? llmApiUrl : (existing.llmApiUrl || ''),
        allowedModels: Array.isArray(allowedModels) ? allowedModels : existing.allowedModels || [],
        completionModel: typeof completionModel === 'string' ? completionModel : (existing.completionModel || ''),
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
