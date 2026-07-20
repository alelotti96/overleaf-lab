import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { postJSON } from '@/infrastructure/fetch-json'
import useAsync from '@/shared/hooks/use-async'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormText from '@/shared/components/ol/ol-form-text'
import OLNotification from '@/shared/components/ol/ol-notification'

type Props = {
    initialSettings?: {
        useOwnSettings?: boolean
        modelName?: string
        apiUrl?: string
        hasApiKey?: boolean
        completionModel?: string
    }
}

export default function LLMSettingsSection({ initialSettings }: Props) {
    const { t } = useTranslation()
    const [useOwnLLMSettings, setUseOwnLLMSettings] = useState(
        initialSettings?.useOwnSettings || false
    )
    const [llmApiKey, setLlmApiKey] = useState('')
    const [llmModelName, setLlmModelName] = useState(
        initialSettings?.modelName || ''
    )
    const [llmApiUrl, setLlmApiUrl] = useState(initialSettings?.apiUrl || '')
    const [llmHasApiKey, setLlmHasApiKey] = useState(
        initialSettings?.hasApiKey || false
    )
    // overleaf-lab: per-user inline-completion model ('' = local/shared model)
    const [llmCompletionModel, setLlmCompletionModel] = useState(
        initialSettings?.completionModel || ''
    )
    const [customCompletionSelected, setCustomCompletionSelected] = useState(false)
    const [isCheckingConnection, setIsCheckingConnection] = useState(false)
    const [connectionCheckResult, setConnectionCheckResult] = useState<{
        success: boolean
        message: string
    } | null>(null)
    const {
        isLoading: isLlmSaving,
        isSuccess: isLlmSuccess,
        isError: isLlmError,
        error: llmError,
        runAsync: runLlmAsync,
    } = useAsync()

    const [showSuccessNotif, setShowSuccessNotif] = useState(false)
    useEffect(() => {
        if (isLlmSuccess) {
            setShowSuccessNotif(true)
            const timer = setTimeout(() => setShowSuccessNotif(false), 4000)
            return () => clearTimeout(timer)
        }
    }, [isLlmSuccess])

    const handleCheckLLMConnection = async () => {
        setIsCheckingConnection(true)
        setConnectionCheckResult(null)
        try {
            const response = await postJSON('/user/llm-settings/check', {
                body: {
                    apiUrl: llmApiUrl,
                    apiKey: llmApiKey || undefined,
                    modelName: llmModelName,
                },
            })
            setConnectionCheckResult({
                success: true,
                message: response.message || 'Connection successful',
            })
        } catch (err: any) {
            setConnectionCheckResult({
                success: false,
                message: err.message || 'Connection failed',
            })
        } finally {
            setIsCheckingConnection(false)
        }
    }

    const handleSaveLLMSettings = () => {
        runLlmAsync(
            postJSON('/user/llm-settings', {
                body: {
                    useOwnLLMSettings,
                    llmApiKey: llmApiKey || undefined,
                    llmModelName,
                    llmApiUrl,
                    llmCompletionModel, // overleaf-lab: resolved completion model id ('' = local)
                },
            })
        )
            .then(() => {
                if (llmApiKey && llmApiKey.trim() !== '') {
                    setLlmHasApiKey(true)
                    setLlmApiKey('')
                }
            })
            .catch(() => { })
    }

    const handleToggleUseOwnLLMSettings = (checked: boolean) => {
        setUseOwnLLMSettings(checked)

        if (!checked) {
            setLlmApiKey('')
            setLlmModelName('')
            setLlmApiUrl('')
            setLlmCompletionModel('')
            setCustomCompletionSelected(false)
            setConnectionCheckResult(null)

            runLlmAsync(
                postJSON('/user/llm-settings', {
                    body: {
                        useOwnLLMSettings: false,
                        llmApiKey: undefined,
                        llmModelName: '',
                        llmApiUrl: '',
                        llmCompletionModel: '',
                    },
                })
            ).catch(() => { })
        }
    }

    // overleaf-lab: completion-model options are derived reactively from the
    // current API URL so they match the user's chosen provider.
    const completionOptions: { value: string; label: string }[] = [
        { value: '', label: t('local_shared_completion_model', 'Local / shared model (default)') },
    ]
    if (llmApiUrl.includes('openai.com')) {
        completionOptions.push({ value: 'gpt-4.1-nano', label: 'gpt-4.1-nano' })
        completionOptions.push({ value: 'gpt-4o-mini', label: 'gpt-4o-mini' })
    }
    if (llmApiUrl.includes('anthropic.com')) {
        completionOptions.push({ value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' })
    }
    completionOptions.push({
        value: '__custom__',
        label: t('other_enter_completion_model_id', 'Other (enter model id)…'),
    })

    // Real model ids offered as presets (includes '' for local; excludes the
    // synthetic '__custom__' sentinel). A stored value outside this set is custom.
    const completionPresetValues = completionOptions
        .map(o => o.value)
        .filter(v => v !== '__custom__')
    const showCustomCompletion =
        customCompletionSelected ||
        (llmCompletionModel !== '' && !completionPresetValues.includes(llmCompletionModel))
    const completionSelectValue = showCustomCompletion ? '__custom__' : llmCompletionModel

    const handleCompletionSelect = (value: string) => {
        if (value === '__custom__') {
            setCustomCompletionSelected(true)
        } else {
            setCustomCompletionSelected(false)
            setLlmCompletionModel(value)
        }
    }

    return (
        <>
            <OLFormGroup>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                    <input
                        type="checkbox"
                        id="use-own-llm-settings"
                        checked={useOwnLLMSettings}
                        onChange={e => handleToggleUseOwnLLMSettings(e.target.checked)}
                        style={{ marginRight: '0.5rem' }}
                    />
                    <OLFormLabel htmlFor="use-own-llm-settings">
                        {t('use_my_own_llm_settings', 'Use my own LLM settings')}
                    </OLFormLabel>
                </div>
            </OLFormGroup>

            {useOwnLLMSettings && (
                <form
                    onSubmit={e => {
                        e.preventDefault()
                        handleSaveLLMSettings()
                    }}
                >
                    <OLFormGroup controlId="llm-api-key-input">
                        <OLFormLabel>API Key</OLFormLabel>
                        <OLFormControl
                            type="password"
                            autoComplete="current-password"
                            value={llmApiKey}
                            onChange={e => setLlmApiKey(e.target.value)}
                            placeholder={llmHasApiKey ? '***' : 'Enter API Key'}
                        />
                        {llmHasApiKey && !llmApiKey && (
                            <OLFormText>
                                Existing API key is set. Enter a new one to update.
                            </OLFormText>
                        )}
                    </OLFormGroup>

                    <OLFormGroup controlId="llm-model-name-input">
                        <OLFormLabel>Model Name</OLFormLabel>
                        <OLFormControl
                            type="text"
                            value={llmModelName}
                            onChange={e => setLlmModelName(e.target.value)}
                            placeholder="e.g., gpt-4, claude-3"
                        />
                    </OLFormGroup>

                    <OLFormGroup controlId="llm-api-url-input">
                        <OLFormLabel>API URL</OLFormLabel>
                        <OLFormControl
                            type="text"
                            value={llmApiUrl}
                            onChange={e => setLlmApiUrl(e.target.value)}
                            placeholder="e.g., https://api.openai.com/v1"
                        />
                    </OLFormGroup>

                    <OLFormGroup controlId="llm-completion-model-input">
                        <OLFormLabel>
                            {t('inline_completion_model', 'Inline completion model')}
                        </OLFormLabel>
                        <select
                            id="llm-completion-model-input"
                            className="form-select"
                            value={completionSelectValue}
                            onChange={e => handleCompletionSelect(e.target.value)}
                        >
                            {completionOptions.map(opt => (
                                <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                </option>
                            ))}
                        </select>
                        {showCustomCompletion && (
                            <OLFormControl
                                type="text"
                                value={llmCompletionModel}
                                onChange={e => setLlmCompletionModel(e.target.value)}
                                placeholder="e.g., gpt-4o-mini"
                                style={{ marginTop: '0.5rem' }}
                            />
                        )}
                        <OLFormText>
                            {t(
                                'inline_completion_model_help',
                                'Local / shared model is free and low-latency. gpt-4.1-nano / gpt-4o-mini cost roughly a few cents per month; claude-haiku costs more (completion runs at high frequency).'
                            )}
                        </OLFormText>
                    </OLFormGroup>

                    {connectionCheckResult && (
                        <OLFormGroup>
                            <OLNotification
                                type={connectionCheckResult.success ? 'success' : 'error'}
                                content={connectionCheckResult.message}
                            />
                        </OLFormGroup>
                    )}

                    <OLFormGroup>
                        <OLButton
                            variant="secondary"
                            type="button"
                            onClick={handleCheckLLMConnection}
                            disabled={
                                isCheckingConnection ||
                                !llmApiUrl ||
                                (!llmApiKey && !llmHasApiKey) ||
                                !llmModelName
                            }
                            isLoading={isCheckingConnection}
                            loadingLabel="Checking..."
                            style={{ marginRight: '0.5rem' }}
                        >
                            Check Connection
                        </OLButton>
                        <OLButton
                            variant="primary"
                            type="submit"
                            disabled={isLlmSaving || !llmApiUrl || !llmModelName}
                            isLoading={isLlmSaving}
                            loadingLabel={t('saving') + '…'}
                        >
                            Save LLM Settings
                        </OLButton>
                    </OLFormGroup>

                    {showSuccessNotif && (
                        <OLFormGroup>
                            <OLNotification
                                type="success"
                                content="LLM settings saved successfully"
                            />
                        </OLFormGroup>
                    )}

                    {isLlmError && (
                        <OLFormGroup>
                            <OLNotification
                                type="error"
                                content={
                                    llmError?.message ?? 'Failed to save LLM settings'
                                }
                            />
                        </OLFormGroup>
                    )}
                </form>
            )}
        </>
    )
}
