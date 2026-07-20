import logger from '@overleaf/logger'
import fetch from 'node-fetch'
import { AbortController } from 'abort-controller'
import { fileURLToPath } from 'url'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { User } from '../../../../app/src/models/User.mjs'
import { expressify } from '@overleaf/promise-utils'
import { encryptSecret, decryptSecret } from './LLMCrypto.mjs' // overleaf-lab: at-rest encryption of user API keys

const llmSettingsPugPath = fileURLToPath(
    new URL('../../app/views/llm-settings.pug', import.meta.url)
)

async function llmSettingsPage(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)

    logger.debug({ userId, pugPath: llmSettingsPugPath }, '[LLM] llmSettingsPage: rendering')

    let user = {}
    try {
        user = await User.findById(
            userId,
            'useOwnLLMSettings llmModelName llmApiUrl llmApiKey llmCompletionModel'
        )
    } catch (err) {
        logger.warn({ userId, err }, '[LLM] Error loading user for settings page')
    }

    const llmSettings = {
        useOwnSettings: user?.useOwnLLMSettings || false,
        modelName: user?.llmModelName || '',
        apiUrl: user?.llmApiUrl || '',
        hasApiKey: !!(user?.llmApiKey),
        completionModel: user?.llmCompletionModel || '', // overleaf-lab: per-user inline-completion model
    }

    logger.debug(
        { userId, useOwnSettings: llmSettings.useOwnSettings, hasApiKey: llmSettings.hasApiKey },
        '[LLM] llmSettingsPage: user settings loaded'
    )

    res.render(llmSettingsPugPath, { user: { llmSettings } })
}

async function checkLLMConnection(req, res) {
    const { apiUrl, apiKey: providedApiKey, modelName } = req.body
    const userId = SessionManager.getLoggedInUserId(req.session)

    logger.debug(
        { userId, apiUrl, modelName, hasProvidedKey: !!providedApiKey },
        '[LLM] checkLLMConnection: request received'
    )

    // If no API key provided, fall back to stored key
    let apiKey = providedApiKey
    if (!apiKey) {
        try {
            const user = await User.findById(userId, 'llmApiKey')
            if (user && user.llmApiKey) {
                apiKey = decryptSecret(user.llmApiKey) // overleaf-lab: decrypt stored key at rest
                logger.debug({ userId }, '[LLM] checkLLMConnection: using stored API key')
            }
        } catch (err) {
            logger.warn({ err }, '[LLM] Could not fetch stored API key')
        }
    }

    // overleaf-lab: the key is optional (a local llama.cpp server has no auth);
    // only the URL and model name are required.
    if (!apiUrl || !modelName) {
        return res.status(400).json({ error: 'Missing required parameters' })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => {
        controller.abort()
    }, 30000)

    try {
        const llmApiUrl = `${apiUrl}/chat/completions`

        const requestBody = {
            model: modelName,
            messages: [{ role: 'user', content: 'Test connection' }],
            max_tokens: 10,
            temperature: 0.7,
        }

        const startTime = Date.now()

        const headers = { 'Content-Type': 'application/json' }
        if (typeof apiKey === 'string' && apiKey.length > 0) {
            headers.Authorization = `Bearer ${apiKey}`
        }

        const response = await fetch(llmApiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        })

        clearTimeout(timeout)
        const duration = Date.now() - startTime

        logger.debug(
            { userId, apiUrl, modelName, status: response.status, duration: `${duration}ms` },
            '[LLM] checkLLMConnection: LLM API responded'
        )

        if (!response.ok) {
            const errorText = await response.text()
            return res.status(400).json({
                success: false,
                error: 'LLM connection failed',
                details: errorText,
                status: response.status,
            })
        }

        res.json({
            success: true,
            message: 'LLM connection successful',
            duration: `${duration}ms`,
        })
    } catch (error) {
        clearTimeout(timeout)

        if (error.name === 'AbortError') {
            return res.status(504).json({
                success: false,
                error: 'Connection timeout',
                details: 'The LLM API did not respond within 30 seconds',
            })
        }

        res.status(500).json({
            success: false,
            error: 'Failed to test LLM connection',
            details: error.message,
        })
    }
}

// overleaf-lab: scan the user's own LLM provider for available model ids.
// Mirrors LLMAdminController.scanAdminModels but resolves credentials from the
// request body, falling back to the user's stored key/URL (like checkLLMConnection).
async function scanUserModels(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const { apiUrl: providedApiUrl, apiKey: providedApiKey } = req.body

    logger.debug(
        { userId, apiUrl: providedApiUrl, hasProvidedKey: !!providedApiKey },
        '[LLM] scanUserModels: request received'
    )

    let apiKey = providedApiKey
    let apiUrl = providedApiUrl
    // Fall back to stored key/URL when either is omitted
    if (!apiKey || !apiUrl) {
        try {
            const user = await User.findById(userId, 'llmApiKey llmApiUrl')
            if (user) {
                if (!apiKey && user.llmApiKey) {
                    apiKey = decryptSecret(user.llmApiKey) // overleaf-lab: decrypt stored key at rest
                }
                if (!apiUrl && user.llmApiUrl) {
                    apiUrl = user.llmApiUrl
                }
            }
        } catch (err) {
            logger.warn({ userId, err }, '[LLM] Could not fetch stored settings for model scan')
        }
    }

    // overleaf-lab: only the URL is required. A local llama.cpp server has no
    // auth, so an empty key is valid; send Authorization only when a key exists.
    if (!apiUrl) {
        return res.status(400).json({
            success: false,
            error: 'API URL is required',
        })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
        const headers = {}
        if (typeof apiKey === 'string' && apiKey.length > 0) {
            headers.Authorization = `Bearer ${apiKey}`
        }
        const response = await fetch(`${apiUrl}/models`, {
            method: 'GET',
            headers,
            signal: controller.signal,
        })

        clearTimeout(timeout)

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
            ? data.data.map(entry => String(entry.id)).sort()
            : []

        res.json({ success: true, models: ids })
    } catch (error) {
        clearTimeout(timeout)

        if (error.name === 'AbortError') {
            return res.status(504).json({
                success: false,
                error: 'Connection timeout',
                details: 'The LLM API did not respond within 30 seconds',
            })
        }

        logger.error({ userId, err: error }, '[LLM] User model scan failed')
        res.status(500).json({ success: false, error: 'Model scan failed' })
    }
}

async function saveLLMSettings(req, res) {
    const userId = SessionManager.getLoggedInUserId(req.session)
    const { useOwnLLMSettings, llmApiKey, llmModelName, llmApiUrl, llmCompletionModel } = req.body

    logger.debug(
        {
            userId,
            useOwnLLMSettings,
            llmModelName,
            llmApiUrl,
            hasApiKey: !!llmApiKey,
        },
        '[LLM] saveLLMSettings: request received'
    )

    try {
        if (useOwnLLMSettings) {
            const currentUser = await User.findById(userId, 'llmApiKey')
            const hasExistingApiKey = currentUser && currentUser.llmApiKey

            if (!llmApiUrl || !llmModelName) {
                return res.status(400).json({
                    success: false,
                    error:
                        'API URL and Model Name are required when enabling custom LLM settings',
                })
            }

            if (!hasExistingApiKey && (!llmApiKey || llmApiKey.trim() === '')) {
                return res.status(400).json({
                    success: false,
                    error:
                        'API Key is required when enabling custom LLM settings',
                })
            }
        }

        const updateData = {
            useOwnLLMSettings: Boolean(useOwnLLMSettings),
            llmModelName: llmModelName || '',
            llmApiUrl: llmApiUrl || '',
            // overleaf-lab: per-user inline-completion model; only meaningful with own settings
            llmCompletionModel: (useOwnLLMSettings && llmCompletionModel) ? llmCompletionModel : '',
        }

        // Only update API key if a new one is provided
        if (llmApiKey && llmApiKey.trim() !== '') {
            updateData.llmApiKey = encryptSecret(llmApiKey) // overleaf-lab: encrypt user key at rest
        }

        await User.updateOne({ _id: userId }, { $set: updateData })

        logger.debug({ userId, useOwnLLMSettings }, '[LLM] saveLLMSettings: saved successfully')

        res.json({
            success: true,
            message: 'LLM settings saved successfully',
        })
    } catch (error) {
        logger.error(
            { userId, err: error },
            '[LLM] Error saving settings'
        )

        res.status(500).json({
            success: false,
            error: 'Failed to save LLM settings',
        })
    }
}

export default {
    llmSettingsPage: expressify(llmSettingsPage),
    checkLLMConnection: expressify(checkLLMConnection),
    scanUserModels: expressify(scanUserModels),
    saveLLMSettings: expressify(saveLLMSettings),
}
