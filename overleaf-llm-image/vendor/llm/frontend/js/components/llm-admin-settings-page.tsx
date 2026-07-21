import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import { postJSON } from '@/infrastructure/fetch-json'
import useAsync from '@/shared/hooks/use-async'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormText from '@/shared/components/ol/ol-form-text'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLNotification from '@/shared/components/ol/ol-notification'
import OLRow from '@/shared/components/ol/ol-row'
import OLCol from '@/shared/components/ol/ol-col'
import OLBadge from '@/shared/components/ol/ol-badge'
import MaterialIcon from '@/shared/components/material-icon'

const DEFAULT_SYSTEM_PROMPT = `You are an expert LaTeX debugging assistant and compiler error specialist.

**Your Primary Role - Error Debugging:**
- Analyze LaTeX compilation errors and warnings
- Identify syntax mistakes, missing packages, and structural issues
- Explain errors in beginner-friendly language
- Provide working fixes with clear explanations

**When a user sends a compilation error:**

1. **Quick Summary** (1-2 sentences)
   - What's wrong in plain English

2. **The Problem**
   - Explain the error clearly
   - Point to the exact issue in their code

3. **The Fix**
   - Show corrected code in \`\`\`latex blocks
   - Highlight what changed

4. **Why This Happened**
   - Brief explanation of the root cause
   - How to prevent it in future

**Error Analysis Guidelines:**
- The line marked with → is where the error occurred
- Look at surrounding context for clues
- Common issues: typos in commands, missing packages, unmatched braces
- Check for: \\begin without \\end, missing $, wrong package names

**Also Helpful With:**
- General LaTeX syntax and commands
- Document structure and formatting
- Mathematical typesetting
- Bibliography and citations

**Response Style:**
- Be concise and practical
- Use code blocks for all LaTeX examples
- Assume the user is learning LaTeX
- Focus on solving the immediate problem first

Remember: The user is likely frustrated. Be encouraging and clear!`

const sectionStyle: React.CSSProperties = {
    padding: '1.5rem',
    borderRadius: '8px',
    border: '1px solid var(--border-color-01, #dee2e6)',
    backgroundColor: 'var(--bg-light-primary, #fff)',
    marginBottom: '1.25rem',
}

const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    marginBottom: '0.25rem',
    fontSize: '1.1rem',
    fontWeight: 600,
}

const sectionDescStyle: React.CSSProperties = {
    color: 'var(--content-secondary, #6c757d)',
    fontSize: '0.875rem',
    marginBottom: '1.25rem',
}

const statusBadgeStyle = (variant: 'success' | 'error'): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    fontSize: '0.8125rem',
    fontWeight: 500,
    color: variant === 'success'
        ? 'var(--green-60, #198754)'
        : 'var(--red-60, #dc3545)',
})

const stepNumberStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.5rem',
    height: '1.5rem',
    borderRadius: '50%',
    backgroundColor: 'var(--bg-accent-01, #0d6efd)',
    color: '#fff',
    fontSize: '0.75rem',
    fontWeight: 700,
    flexShrink: 0,
}

// overleaf-lab: a small accessible toggle switch (styled from a button) used for
// the per-feature enable/disable controls.
function ToggleSwitch({
    checked,
    onChange,
    label,
}: {
    checked: boolean
    onChange: (v: boolean) => void
    label?: string
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            style={{
                position: 'relative',
                width: 42,
                height: 24,
                flexShrink: 0,
                borderRadius: 999,
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                transition: 'background-color 0.15s',
                backgroundColor: checked
                    ? 'var(--bg-accent-01, #0d6efd)'
                    : 'var(--border-color-02, #adb5bd)',
            }}
        >
            <span
                style={{
                    position: 'absolute',
                    top: 3,
                    left: checked ? 21 : 3,
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    backgroundColor: '#fff',
                    transition: 'left 0.15s',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                }}
            />
        </button>
    )
}

export default function LLMAdminSettingsPage() {
    const { t } = useTranslation()
    const hasStoredKey = getMeta('ol-hasLlmApiKey') === 'true'
    // overleaf-lab: true when the shown URL is inherited from the LLM_API_URL env
    // var rather than saved in the admin settings file.
    const apiUrlFromEnv = getMeta('ol-llmApiUrlFromEnv') === 'true'

    const [systemPrompt, setSystemPrompt] = useState<string>(
        (getMeta('ol-systemPrompt') as string) || DEFAULT_SYSTEM_PROMPT
    )
    const [llmApiUrl, setLlmApiUrl] = useState<string>(
        (getMeta('ol-llmApiUrl') as string) || ''
    )
    const [llmApiKey, setLlmApiKey] = useState<string>('')
    const [allowedModels, setAllowedModels] = useState<string[]>(
        ((getMeta('ol-allowedModels') as string) || '')
            .split(',')
            .map(m => m.trim())
            .filter(Boolean)
    )
    const [availableModels, setAvailableModels] = useState<string[]>([])
    // overleaf-lab: admin-chosen inline-completion model for the shared backend
    // ('' = auto, i.e. the first allowed model). Separate from the chat models.
    const [completionModel, setCompletionModel] = useState<string>(
        (getMeta('ol-completionModel') as string) || ''
    )
    // overleaf-lab: compliance review settings. Rubrics come from a data-type='json'
    // meta tag, so getMeta returns the parsed value; guard in case it is not an array.
    const rubricsFromMeta = getMeta('ol-complianceRubrics') as Array<{ id: string; name: string; guidelines: string }>
    const initialRubrics = Array.isArray(rubricsFromMeta) ? rubricsFromMeta : []
    const [complianceRubrics, setComplianceRubrics] = useState<Array<{ id: string; name: string; guidelines: string }>>(initialRubrics)
    const [reviewModel, setReviewModel] = useState<string>((getMeta('ol-reviewModel') as string) || '')
    const [maxContextTokens, setMaxContextTokens] = useState<number>(parseInt((getMeta('ol-maxContextTokens') as string) || '32000', 10) || 32000)
    // overleaf-lab: per-feature enable/disable toggles. The metas use data-type='json'
    // so getMeta returns the parsed boolean; default to true when missing/undefined.
    const [chatEnabled, setChatEnabled] = useState<boolean>(getMeta('ol-chatEnabled') !== false)
    const [completionEnabled, setCompletionEnabled] = useState<boolean>(getMeta('ol-completionEnabled') !== false)
    const [reviewEnabled, setReviewEnabled] = useState<boolean>(getMeta('ol-reviewEnabled') !== false)
    const [scanStatus, setScanStatus] = useState<string | null>(null)
    const [testStatus, setTestStatus] = useState<string | null>(null)

    const {
        isLoading: isSaving,
        isSuccess,
        isError,
        error,
        runAsync,
    } = useAsync()

    const [showSuccess, setShowSuccess] = useState(false)
    useEffect(() => {
        if (isSuccess) {
            setShowSuccess(true)
            const timer = setTimeout(() => setShowSuccess(false), 4000)
            return () => clearTimeout(timer)
        }
    }, [isSuccess])

    // overleaf-lab: only the URL is required — a local llama.cpp server has no
    // auth, so scan/test must work with an empty key. The server returns 401 if
    // it actually needs one.
    const canConnect = !!llmApiUrl

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault()
        runAsync(
            postJSON('/admin/llm/settings', {
                body: {
                    systemPrompt,
                    llmApiUrl,
                    llmApiKey,
                    allowedModels,
                    completionModel,
                    complianceRubrics,
                    reviewModel,
                    maxContextTokens,
                    chatEnabled,
                    completionEnabled,
                    reviewEnabled,
                },
            })
        ).catch(() => { })
    }

    const testConnection = async () => {
        setTestStatus('testing')
        try {
            const resp = await postJSON('/admin/llm/settings/check', {
                body: { apiUrl: llmApiUrl, apiKey: llmApiKey },
            })
            if (resp.success) {
                setTestStatus('success')
            } else {
                setTestStatus('error')
            }
        } catch (e) {
            setTestStatus('error')
        }
    }

    const scanModels = async () => {
        setScanStatus('scanning')
        try {
            const params = new URLSearchParams()
            if (llmApiUrl) params.set('apiUrl', llmApiUrl)
            if (llmApiKey) params.set('apiKey', llmApiKey)
            const resp = await fetch(`/admin/llm/models?${params.toString()}`, {
                method: 'GET',
                credentials: 'same-origin',
            })
            const json = await resp.json()
            if (json.success && Array.isArray(json.models)) {
                setAvailableModels(json.models)
                setScanStatus('success')
                setAllowedModels(prev => {
                    const combined = new Set([...prev, ...json.models])
                    return Array.from(combined)
                })
            } else {
                setScanStatus('error')
            }
        } catch {
            setScanStatus('error')
        }
    }

    const toggleAllowedModel = (model: string) => {
        setAllowedModels(prev =>
            prev.includes(model)
                ? prev.filter(m => m !== model)
                : [...prev, model]
        )
    }

    // overleaf-lab: compliance rubric editing helpers. Each rubric keeps a stable
    // client-generated id so React keys and immutable updates stay correct.
    const addRubric = () => {
        const id = `rubric-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        setComplianceRubrics(prev => [...prev, { id, name: '', guidelines: '' }])
    }

    const updateRubric = (id: string, field: 'name' | 'guidelines', value: string) => {
        setComplianceRubrics(prev =>
            prev.map(r => (r.id === id ? { ...r, [field]: value } : r))
        )
    }

    const removeRubric = (id: string) => {
        setComplianceRubrics(prev => prev.filter(r => r.id !== id))
    }

    const allModels = Array.from(new Set([...availableModels, ...allowedModels]))

    return (
        <div className="container" style={{ maxWidth: '800px', margin: '0 auto' }}>
            <OLRow>
                <OLCol>
                    <div style={{ padding: '2rem 0' }}>
                        {/* Page header */}
                        <div style={{ marginBottom: '2rem' }}>
                            <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                <MaterialIcon type="smart_toy" />
                                {t('llm_configuration', 'LLM Configuration')}
                            </h1>
                            <p style={{ color: 'var(--content-secondary, #6c757d)', margin: 0 }}>
                                {t(
                                    'llm_admin_description',
                                    'Configure the AI assistant for your Overleaf instance. Set up the API connection, choose available models, and customize the system prompt.'
                                )}
                            </p>
                        </div>

                        <form onSubmit={handleSave}>
                            {/* ── Section 1: Features ── */}
                            {/* overleaf-lab: master on/off switches per AI feature */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>1</span>
                                    <MaterialIcon type="toggle_on" />
                                    {t('llm_features', 'Features')}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'llm_features_desc',
                                        'Enable or disable each AI feature for all users. A disabled feature cannot be used by anyone, even with their own API key.'
                                    )}
                                </p>

                                <div style={{
                                    border: '1px solid var(--border-color-01, #dee2e6)',
                                    borderRadius: '6px',
                                    overflow: 'hidden',
                                }}>
                                    {/* overleaf-lab: one toggle switch per feature */}
                                    {[
                                        { key: 'chat', on: chatEnabled, set: setChatEnabled, title: t('feature_chat', 'Chat'), help: t('feature_chat_help', 'The AI chat panel and Ask AI on selection.') },
                                        { key: 'completion', on: completionEnabled, set: setCompletionEnabled, title: t('feature_completion', 'Inline completion'), help: t('feature_completion_help', 'Autocomplete suggestions while typing.') },
                                        { key: 'review', on: reviewEnabled, set: setReviewEnabled, title: t('feature_review', 'Compliance review'), help: t('feature_review_help', 'The whole-document review.') },
                                    ].map((f, i, arr) => (
                                        <div
                                            key={f.key}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: '1rem',
                                                padding: '0.75rem 1rem',
                                                borderBottom: i < arr.length - 1 ? '1px solid var(--border-color-01, #dee2e6)' : undefined,
                                            }}
                                        >
                                            <div>
                                                <span style={{ fontWeight: 500 }}>{f.title}</span>
                                                <OLFormText style={{ margin: 0 }}>{f.help}</OLFormText>
                                            </div>
                                            <ToggleSwitch checked={f.on} onChange={f.set} label={f.title} />
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* ── Section 2: API Connection ── */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>2</span>
                                    <MaterialIcon type="link" />
                                    {t('api_connection', 'API Connection')}
                                    {testStatus === 'success' && (
                                        <OLBadge bg="success" style={{ marginLeft: 'auto', fontSize: '0.75rem' }}>
                                            {t('connected', 'Connected')}
                                        </OLBadge>
                                    )}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'api_connection_desc',
                                        'Enter the endpoint URL and API key for your OpenAI-compatible LLM provider.'
                                    )}
                                </p>

                                <OLFormGroup controlId="llm-api-url">
                                    <OLFormLabel>
                                        {t('llm_api_url', 'API Endpoint URL')}
                                    </OLFormLabel>
                                    <OLFormControl
                                        type="url"
                                        value={llmApiUrl}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                            setLlmApiUrl(e.target.value)
                                        }
                                        placeholder="https://api.example.com/v1"
                                    />
                                    {apiUrlFromEnv && (
                                        <OLFormText>
                                            <MaterialIcon type="info" className="me-1" style={{ fontSize: '0.875rem' }} />
                                            {t('llm_admin_from_env', 'Inherited from the LLM_API_URL environment variable. Saving here stores it in the admin settings file.')}
                                        </OLFormText>
                                    )}
                                </OLFormGroup>

                                <OLFormGroup controlId="llm-api-key" style={{ marginBottom: '1rem' }}>
                                    <OLFormLabel>
                                        {t('llm_api_key', 'API Key')}
                                    </OLFormLabel>
                                    <OLFormControl
                                        type="password"
                                        value={llmApiKey}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                            setLlmApiKey(e.target.value)
                                        }
                                        placeholder={
                                            hasStoredKey
                                                ? t('llm_api_key_placeholder_stored', '••••••••  (stored — leave blank to keep)')
                                                : t('llm_api_key_placeholder', 'Paste your API key here')
                                        }
                                    />
                                    {hasStoredKey && !llmApiKey && (
                                        <OLFormText>
                                            <MaterialIcon type="check_circle" className="me-1" style={{ fontSize: '0.875rem', color: 'var(--green-60, #198754)' }} />
                                            {t('llm_api_key_stored', 'An API key is already stored. Leave blank to keep it.')}
                                        </OLFormText>
                                    )}
                                    <OLFormText>
                                        <MaterialIcon type="info" className="me-1" style={{ fontSize: '0.875rem' }} />
                                        {t('llm_api_key_optional_local', 'Leave blank for a local server with no auth (e.g. a llama.cpp server).')}
                                    </OLFormText>
                                </OLFormGroup>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                    <OLButton
                                        variant="secondary"
                                        size="sm"
                                        type="button"
                                        onClick={testConnection}
                                        disabled={!canConnect}
                                        isLoading={testStatus === 'testing'}
                                    >
                                        <MaterialIcon type="cable" className="me-1" style={{ fontSize: '1rem' }} />
                                        {t('test_connection', 'Test Connection')}
                                    </OLButton>
                                    {testStatus === 'success' && (
                                        <span style={statusBadgeStyle('success')}>
                                            <MaterialIcon type="check_circle" style={{ fontSize: '1rem' }} />
                                            {t('connection_successful', 'Connection successful')}
                                        </span>
                                    )}
                                    {testStatus === 'error' && (
                                        <span style={statusBadgeStyle('error')}>
                                            <MaterialIcon type="error" style={{ fontSize: '1rem' }} />
                                            {t('connection_failed', 'Connection failed — check URL and key')}
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* ── Section 3: Model Selection ── */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>3</span>
                                    <MaterialIcon type="model_training" />
                                    {t('model_selection', 'Model Selection')}
                                    {allModels.length > 0 && (
                                        <span style={{ marginLeft: 'auto', fontSize: '0.8125rem', color: 'var(--content-secondary, #6c757d)' }}>
                                            {allowedModels.filter(m => allModels.includes(m)).length}/{allModels.length} {t('selected', 'selected')}
                                        </span>
                                    )}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'model_selection_desc',
                                        'Scan the API for available models, then choose which ones users can access.'
                                    )}
                                </p>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: allModels.length > 0 ? '1rem' : 0 }}>
                                    <OLButton
                                        variant="secondary"
                                        size="sm"
                                        type="button"
                                        onClick={scanModels}
                                        disabled={!canConnect}
                                        isLoading={scanStatus === 'scanning'}
                                    >
                                        <MaterialIcon type="radar" className="me-1" style={{ fontSize: '1rem' }} />
                                        {t('scan_for_models', 'Scan for Models')}
                                    </OLButton>
                                    {scanStatus === 'success' && (
                                        <span style={statusBadgeStyle('success')}>
                                            <MaterialIcon type="check_circle" style={{ fontSize: '1rem' }} />
                                            {t('scan_found_models', `Found ${availableModels.length} model(s)`)}
                                        </span>
                                    )}
                                    {scanStatus === 'error' && (
                                        <span style={statusBadgeStyle('error')}>
                                            <MaterialIcon type="error" style={{ fontSize: '1rem' }} />
                                            {t('scan_failed', 'Scan failed — check connection first')}
                                        </span>
                                    )}
                                    {!canConnect && scanStatus === null && (
                                        <span style={{ fontSize: '0.8125rem', color: 'var(--content-secondary, #6c757d)' }}>
                                            {t('configure_api_first', 'Configure the API connection above first')}
                                        </span>
                                    )}
                                </div>

                                {allModels.length > 0 && (
                                    <>
                                        <div style={{
                                            border: '1px solid var(--border-color-01, #dee2e6)',
                                            borderRadius: '6px',
                                            overflow: 'hidden',
                                        }}>
                                            {allModels.map((model, idx) => (
                                                <label
                                                    key={model}
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '0.75rem',
                                                        padding: '0.625rem 1rem',
                                                        borderBottom: idx < allModels.length - 1
                                                            ? '1px solid var(--border-color-01, #dee2e6)'
                                                            : undefined,
                                                        cursor: 'pointer',
                                                        margin: 0,
                                                        transition: 'background-color 0.15s',
                                                    }}
                                                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--bg-light-secondary, #f8f9fa)' }}
                                                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={allowedModels.includes(model)}
                                                        onChange={() => toggleAllowedModel(model)}
                                                        style={{ width: '1rem', height: '1rem', accentColor: 'var(--bg-accent-01, #0d6efd)' }}
                                                    />
                                                    <span style={{ fontFamily: 'monospace', fontSize: '0.875rem' }}>
                                                        {model}
                                                    </span>
                                                </label>
                                            ))}
                                        </div>
                                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                                            <OLButton
                                                variant="link"
                                                size="sm"
                                                type="button"
                                                onClick={() => setAllowedModels([...allModels])}
                                                style={{ padding: 0, fontSize: '0.8125rem' }}
                                            >
                                                {t('select_all', 'Select all')}
                                            </OLButton>
                                            <span style={{ color: 'var(--content-secondary, #6c757d)' }}>|</span>
                                            <OLButton
                                                variant="link"
                                                size="sm"
                                                type="button"
                                                onClick={() => setAllowedModels([])}
                                                style={{ padding: 0, fontSize: '0.8125rem' }}
                                            >
                                                {t('deselect_all', 'Deselect all')}
                                            </OLButton>
                                        </div>
                                    </>
                                )}

                                {/* overleaf-lab: admin picks the single shared inline-completion model */}
                                <OLFormGroup controlId="llm-completion-model" style={{ marginTop: allModels.length > 0 ? '1rem' : 0 }}>
                                    <OLFormLabel>
                                        {t('inline_completion_model', 'Inline completion model')}
                                    </OLFormLabel>
                                    <select
                                        id="llm-completion-model"
                                        className="form-select"
                                        value={completionModel}
                                        onChange={e => setCompletionModel(e.target.value)}
                                    >
                                        <option value="">
                                            {t('auto_first_allowed_model', 'Auto (first allowed model)')}
                                        </option>
                                        {/* overleaf-lab: turn off shared autocomplete; users can still use their own API key */}
                                        <option value="__disabled__">
                                            {t('completion_disabled_shared', 'Disabled (only users with their own API key)')}
                                        </option>
                                        {allModels.map(model => (
                                            <option key={model} value={model}>
                                                {model}
                                            </option>
                                        ))}
                                    </select>
                                    <OLFormText>
                                        {t(
                                            'inline_completion_model_admin_help',
                                            'Model used for inline autocomplete on the shared backend. Can differ from the chat models. Set to Disabled to turn off shared autocomplete (users with their own API key still get it).'
                                        )}
                                    </OLFormText>
                                </OLFormGroup>
                            </div>

                            {/* ── Section 4: System Prompt ── */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>4</span>
                                    <MaterialIcon type="description" />
                                    {t('system_prompt', 'System Prompt')}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'system_prompt_desc',
                                        'This prompt is prepended to every AI conversation. Use it to customize the assistant\'s behavior for your organization.'
                                    )}
                                </p>

                                <OLFormGroup controlId="llm-system-prompt" style={{ marginBottom: '0.5rem' }}>
                                    <OLFormControl
                                        as="textarea"
                                        rows={12}
                                        value={systemPrompt}
                                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                            setSystemPrompt(e.target.value)
                                        }
                                        placeholder={t(
                                            'llm_system_prompt_placeholder',
                                            'You are a helpful LaTeX assistant...'
                                        )}
                                        maxLength={4000}
                                        style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}
                                    />
                                </OLFormGroup>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                    <OLFormText style={{ margin: 0 }}>
                                        {systemPrompt.length}/4000 {t('characters', 'characters')}
                                    </OLFormText>
                                    <OLButton
                                        variant="link"
                                        size="sm"
                                        type="button"
                                        onClick={() => setSystemPrompt(DEFAULT_SYSTEM_PROMPT)}
                                        style={{ padding: 0, fontSize: '0.8125rem' }}
                                    >
                                        <MaterialIcon type="restart_alt" className="me-1" style={{ fontSize: '1rem' }} />
                                        {t('reset_to_default', 'Reset to default')}
                                    </OLButton>
                                </div>
                            </div>

                            {/* ── Section 5: Compliance Review ── */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>5</span>
                                    <MaterialIcon type="fact_check" />
                                    {t('compliance_review', 'Compliance Review')}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'compliance_review_desc',
                                        'Configure the document compliance review: the guideline rubrics users can check against, the model that runs the review, and the maximum context size.'
                                    )}
                                </p>

                                {/* overleaf-lab: (a) rubrics editor */}
                                {complianceRubrics.length === 0 && (
                                    <p style={{ color: 'var(--content-secondary, #6c757d)', fontSize: '0.875rem', marginBottom: '1rem' }}>
                                        {t('no_rubrics_yet', 'No rubrics yet. Add one to enable the compliance review for users.')}
                                    </p>
                                )}
                                {complianceRubrics.map(rubric => (
                                    <div
                                        key={rubric.id}
                                        style={{
                                            border: '1px solid var(--border-color-01, #dee2e6)',
                                            borderRadius: '6px',
                                            padding: '1rem',
                                            marginBottom: '0.75rem',
                                        }}
                                    >
                                        <OLFormGroup controlId={`rubric-name-${rubric.id}`}>
                                            <OLFormLabel>
                                                {t('rubric_name', 'Rubric name')}
                                            </OLFormLabel>
                                            <OLFormControl
                                                type="text"
                                                value={rubric.name}
                                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                                    updateRubric(rubric.id, 'name', e.target.value)
                                                }
                                                placeholder={t('rubric_name_placeholder', 'e.g. Thesis writing guidelines')}
                                            />
                                        </OLFormGroup>
                                        <OLFormGroup controlId={`rubric-guidelines-${rubric.id}`} style={{ marginBottom: '0.5rem' }}>
                                            <OLFormLabel>
                                                {t('rubric_guidelines', 'Guidelines')}
                                            </OLFormLabel>
                                            <OLFormControl
                                                as="textarea"
                                                rows={6}
                                                value={rubric.guidelines}
                                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                                    updateRubric(rubric.id, 'guidelines', e.target.value)
                                                }
                                                style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}
                                            />
                                        </OLFormGroup>
                                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                            <OLButton
                                                variant="danger"
                                                size="sm"
                                                type="button"
                                                onClick={() => removeRubric(rubric.id)}
                                            >
                                                <MaterialIcon type="delete" className="me-1" style={{ fontSize: '1rem' }} />
                                                {t('remove', 'Remove')}
                                            </OLButton>
                                        </div>
                                    </div>
                                ))}
                                <div style={{ marginBottom: '0.5rem' }}>
                                    <OLButton
                                        variant="secondary"
                                        size="sm"
                                        type="button"
                                        onClick={addRubric}
                                    >
                                        <MaterialIcon type="add" className="me-1" style={{ fontSize: '1rem' }} />
                                        {t('add_rubric', 'Add rubric')}
                                    </OLButton>
                                </div>
                                <OLFormText>
                                    {t(
                                        'compliance_rubrics_help',
                                        'Paste your thesis or internship writing guidelines. The AI checks the whole document against each rubric and returns a report.'
                                    )}
                                </OLFormText>

                                {/* overleaf-lab: (b) review model selector */}
                                <OLFormGroup controlId="llm-review-model" style={{ marginTop: '1.25rem' }}>
                                    <OLFormLabel>
                                        {t('review_model', 'Review model')}
                                    </OLFormLabel>
                                    <select
                                        id="llm-review-model"
                                        className="form-select"
                                        value={reviewModel}
                                        onChange={e => setReviewModel(e.target.value)}
                                    >
                                        <option value="">
                                            {t('review_model_shared_default', 'Shared chat model (default)')}
                                        </option>
                                        {allModels.map(model => (
                                            <option key={model} value={model}>
                                                {model}
                                            </option>
                                        ))}
                                    </select>
                                    <OLFormText>
                                        {t(
                                            'review_model_help',
                                            'Model used to run the compliance review. Pick a large-context model. Defaults to the shared chat model.'
                                        )}
                                    </OLFormText>
                                </OLFormGroup>

                                {/* overleaf-lab: (c) max context tokens */}
                                <OLFormGroup controlId="llm-max-context-tokens" style={{ marginTop: '1rem', marginBottom: 0 }}>
                                    <OLFormLabel>
                                        {t('max_context_tokens', 'Max context tokens')}
                                    </OLFormLabel>
                                    <OLFormControl
                                        type="number"
                                        value={maxContextTokens}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                            const parsed = parseInt(e.target.value, 10)
                                            if (!isNaN(parsed)) {
                                                setMaxContextTokens(parsed)
                                            }
                                        }}
                                    />
                                    <OLFormText>
                                        {t(
                                            'max_context_tokens_help',
                                            'The context window (in tokens) of the review model, as configured on your llama.cpp server (the -c value, divided by --parallel). The review refuses documents that would not fit. No auto-detection.'
                                        )}
                                    </OLFormText>
                                </OLFormGroup>
                            </div>

                            {/* ── Notifications ── */}
                            {showSuccess && (
                                <div style={{ marginBottom: '1rem' }}>
                                    <OLNotification
                                        type="success"
                                        content={t('llm_settings_saved', 'LLM settings saved successfully.')}
                                    />
                                </div>
                            )}
                            {isError && (
                                <div style={{ marginBottom: '1rem' }}>
                                    <OLNotification
                                        type="error"
                                        content={
                                            (error as any)?.message ??
                                            t('generic_something_went_wrong', 'Something went wrong')
                                        }
                                    />
                                </div>
                            )}

                            {/* ── Save Button ── */}
                            <OLButton
                                variant="primary"
                                type="submit"
                                disabled={isSaving}
                                isLoading={isSaving}
                                loadingLabel={t('saving') + '…'}
                                style={{ minWidth: '160px' }}
                            >
                                <MaterialIcon type="save" className="me-1" style={{ fontSize: '1.125rem' }} />
                                {t('save_settings', 'Save Settings')}
                            </OLButton>
                        </form>
                    </div>
                </OLCol>
            </OLRow>
        </div>
    )
}
