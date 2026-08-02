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
import {
    sectionStyle,
    sectionHeaderStyle,
    sectionDescStyle,
    statusBadgeStyle,
    stepNumberStyle,
    ToggleSwitch,
} from './llm-admin-ui'

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

// overleaf-lab: the section styles and the toggle switch moved to llm-admin-ui so
// the compliance settings page can use the same ones instead of a second copy.

export type ModelChoice = {
    id: string
    selected: boolean
    missing: boolean
}

// overleaf-lab: A SELECTED MODEL THE BACKEND NO LONGER SERVES.
//
// The list shown here is the union of what the last scan found and what is currently
// selected, and it used to be exactly that: a union of strings with nothing telling
// the two apart. So a model that was renamed, unloaded or removed on the server stayed
// in the list, ticked, indistinguishable from a working one, for as long as nobody
// happened to untick it. The administrator's page said the review model was available;
// the review then failed with "the configured review model is not available on the
// backend", hours later and in somebody else's project.
//
// A scan is the only moment we have evidence about what exists, so the rule is stated
// against that evidence and nowhere else: `missing` is set ONLY when a scan has
// actually answered (hasScanned), because before one has, "not in the available list"
// means "we have not looked", and marking the whole saved selection as broken on page
// load would be a lie in the other direction.
//
// It never removes anything. An orphan is shown, marked, and left selected until an
// administrator decides: a page that silently drops a model from the allow-list is a
// page that silently changes who can use what, and the person it happens to has no way
// to find out that it did.
//
// The order is the one the list has always had - scan order first, then whatever else
// is selected - so a scan does not reshuffle the rows under the reader's cursor.
export function classifyModelChoices(
    allowed: string[],
    available: string[],
    hasScanned: boolean
): ModelChoice[] {
    const ids = Array.from(new Set([...available, ...allowed]))
    return ids.map(id => ({
        id,
        selected: allowed.includes(id),
        missing: hasScanned && allowed.includes(id) && !available.includes(id),
    }))
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
    // overleaf-lab: the URL as SAVED on the server (or inherited from the env).
    // The model scan has to tell "scan the backend this instance is configured
    // for" from "probe a URL I have just typed", because only the first one may
    // carry the stored API key. See scanModels below. Kept in state so a save
    // updates it without a page reload, otherwise a scan right after saving a new
    // URL would still be treated as a probe.
    const [savedApiUrl, setSavedApiUrl] = useState<string>(
        ((getMeta('ol-llmApiUrl') as string) || '').trim()
    )
    const [llmApiKey, setLlmApiKey] = useState<string>('')
    const [allowedModels, setAllowedModels] = useState<string[]>(
        ((getMeta('ol-allowedModels') as string) || '')
            .split(',')
            .map(m => m.trim())
            .filter(Boolean)
    )
    const [availableModels, setAvailableModels] = useState<string[]>([])
    // overleaf-lab: has a scan ANSWERED in this page's lifetime? Separate from
    // availableModels being non-empty, which cannot tell "not looked yet" from "looked
    // and the backend serves nothing": the first must mark no selection as broken, the
    // second must mark all of them. Separate from scanStatus too, which goes back to
    // 'scanning' and can end at 'error' while a previous good answer is still on
    // screen. See classifyModelChoices.
    const [hasScanned, setHasScanned] = useState<boolean>(false)
    // overleaf-lab: admin-chosen inline-completion model for the shared backend
    // ('' = auto, i.e. the first allowed model). Separate from the chat models.
    const [completionModel, setCompletionModel] = useState<string>(
        (getMeta('ol-completionModel') as string) || ''
    )
    // overleaf-lab: per-feature enable/disable toggles. The metas use data-type='json'
    // so getMeta returns the parsed boolean; default to true when missing/undefined.
    // The review toggle is not here: it lives on the compliance settings page with
    // the rest of the review configuration.
    const [chatEnabled, setChatEnabled] = useState<boolean>(getMeta('ol-chatEnabled') !== false)
    const [completionEnabled, setCompletionEnabled] = useState<boolean>(getMeta('ol-completionEnabled') !== false)
    // overleaf-lab: editable AI prompts. Empty field means the backend uses its
    // built-in default; promptDefaults feeds the per-field reset buttons.
    const promptDefaults = (getMeta('ol-promptDefaults') as any) || {}
    const [askAiSystemPrompt, setAskAiSystemPrompt] = useState<string>((getMeta('ol-askAiSystemPrompt') as string) || '')
    const [errorPrompt, setErrorPrompt] = useState<string>((getMeta('ol-errorPrompt') as string) || '')
    const [completionSystemPrompt, setCompletionSystemPrompt] = useState<string>((getMeta('ol-completionSystemPrompt') as string) || '')
    const initialActions = (getMeta('ol-askAiActionPrompts') as Record<string, string>) || {}
    const [askAiActionPrompts, setAskAiActionPrompts] = useState<Record<string, string>>(initialActions && typeof initialActions === 'object' ? initialActions : {})
    // overleaf-lab: keep the Ask AI action templates block collapsed by default
    const [showActions, setShowActions] = useState(false)
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
    // overleaf-lab: true when the URL in the field is not the saved one. Both the
    // connection test and the model scan then send it as a candidate address, and
    // the server refuses to attach the STORED key to an address it did not choose
    // itself. See testConnection and scanModels below.
    const apiUrlIsUnsaved = !!llmApiUrl.trim() && llmApiUrl.trim() !== savedApiUrl

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
                    chatEnabled,
                    completionEnabled,
                    askAiSystemPrompt,
                    errorPrompt,
                    completionSystemPrompt,
                    askAiActionPrompts,
                },
            })
        )
            .then(() => {
                // overleaf-lab: this URL is now the configured one, so the next
                // scan is a scan of our own backend (stored key attached) rather
                // than a credential-free probe of a candidate address.
                setSavedApiUrl(llmApiUrl.trim())
            })
            .catch(() => { })
    }

    const testConnection = async () => {
        setTestStatus('testing')
        try {
            // overleaf-lab: same rule as scanModels below. Send the URL only when it
            // is not the saved one, because the server attaches the STORED API key
            // exclusively to the address its own settings chose. A URL typed here is
            // tested with the key typed next to it (blank means no auth), which is
            // what lets an admin validate a new provider BEFORE saving it without
            // the instance's own key ever being aimed at an address that came from
            // this page.
            const typedUrl = llmApiUrl.trim()
            const body: { apiUrl?: string; apiKey?: string } = {}
            if (typedUrl && typedUrl !== savedApiUrl) {
                body.apiUrl = typedUrl
            }
            if (llmApiKey) {
                body.apiKey = llmApiKey
            }
            const resp = await postJSON('/admin/llm/settings/check', { body })
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
            // overleaf-lab: send the URL ONLY when it is not the one already saved.
            // The endpoint attaches the stored API key to the CONFIGURED address and
            // to nothing else: any address that arrives in the request is probed with
            // no Authorization header at all. That is what stops a crafted link
            // (this is a GET, so it carries no CSRF token, and the session cookie is
            // SameSite=Lax) from aiming the instance's key at a host of the
            // attacker's choosing. Practical consequence for the admin: scanning a
            // provider that requires a key means saving the settings first, which is
            // what the hint next to the button says.
            const typedUrl = llmApiUrl.trim()
            const params = new URLSearchParams()
            if (typedUrl && typedUrl !== savedApiUrl) {
                params.set('apiUrl', typedUrl)
            }
            const query = params.toString()
            const resp = await fetch(
                `/admin/llm/models${query ? `?${query}` : ''}`,
                {
                    method: 'GET',
                    credentials: 'same-origin',
                }
            )
            const json = await resp.json()
            if (json.success && Array.isArray(json.models)) {
                setAvailableModels(json.models)
                // overleaf-lab: this answer, and only an answer, is what licenses the
                // page to call a selection orphaned. Set here rather than next to the
                // fetch so a scan that fails or times out never turns the saved
                // selection red on the strength of a request that never arrived.
                setHasScanned(true)
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

    const modelChoices = classifyModelChoices(allowedModels, availableModels, hasScanned)
    const allModels = modelChoices.map(choice => choice.id)
    const missingModels = modelChoices.filter(choice => choice.missing).map(choice => choice.id)

    const dropMissingModels = () => {
        setAllowedModels(prev => prev.filter(m => !missingModels.includes(m)))
    }

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
                                        // overleaf-lab: the compliance check has its own admin
                                        // page and carries its own toggle there.
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

                                {/* overleaf-lab: say plainly which key a test of an
                                    unsaved URL uses. The stored key is never sent to
                                    an address that came from this page. */}
                                {apiUrlIsUnsaved && (
                                    <OLFormText style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                                        <MaterialIcon type="info" className="me-1" style={{ fontSize: '0.875rem' }} />
                                        {t(
                                            'test_unsaved_url_uses_typed_key',
                                            'This URL is not saved yet, so it is tested with the API key typed above (blank means no auth). The stored key is only ever sent to the saved URL.'
                                        )}
                                    </OLFormText>
                                )}
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

                                {/* overleaf-lab: say plainly what a scan of an unsaved URL
                                    can and cannot do. The stored key never leaves the
                                    server towards an address that came from this page. */}
                                {apiUrlIsUnsaved && (
                                    <OLFormText style={{ marginTop: 0, marginBottom: '1rem' }}>
                                        <MaterialIcon type="info" className="me-1" style={{ fontSize: '0.875rem' }} />
                                        {t(
                                            'scan_unsaved_url_no_key',
                                            'This URL is not saved yet, so it is probed without any API key. That is enough for a server with no auth; to scan a provider that requires a key, save the settings first and scan again.'
                                        )}
                                    </OLFormText>
                                )}

                                {/* overleaf-lab: say it once, at the top, and offer the
                                    removal as a BUTTON. Nothing here deselects on its
                                    own: an allow-list that shrinks by itself changes
                                    who can use which model without telling anybody. */}
                                {missingModels.length > 0 && (
                                    <div style={{ marginBottom: '1rem' }}>
                                        <OLNotification
                                            type="warning"
                                            content={t(
                                                'models_no_longer_available',
                                                `${missingModels.length} selected model(s) are no longer served by this backend. They are still selected and still saved: check the model names on the server, or remove them here.`
                                            )}
                                        />
                                        <OLButton
                                            variant="secondary"
                                            size="sm"
                                            type="button"
                                            onClick={dropMissingModels}
                                            style={{ marginTop: '0.5rem' }}
                                        >
                                            {t('remove_unavailable_models', 'Remove unavailable')}
                                        </OLButton>
                                    </div>
                                )}

                                {allModels.length > 0 && (
                                    <>
                                        <div style={{
                                            border: '1px solid var(--border-color-01, #dee2e6)',
                                            borderRadius: '6px',
                                            overflow: 'hidden',
                                        }}>
                                            {modelChoices.map((choice, idx) => (
                                                <label
                                                    key={choice.id}
                                                    style={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        gap: '0.75rem',
                                                        padding: '0.625rem 1rem',
                                                        borderBottom: idx < modelChoices.length - 1
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
                                                        checked={choice.selected}
                                                        onChange={() => toggleAllowedModel(choice.id)}
                                                        style={{ width: '1rem', height: '1rem', accentColor: 'var(--bg-accent-01, #0d6efd)' }}
                                                    />
                                                    <span
                                                        style={{
                                                            fontFamily: 'monospace',
                                                            fontSize: '0.875rem',
                                                            // The row itself has to read as broken. The
                                                            // badge alone is easy to miss in a list of
                                                            // thirty monospace ids that all look alike.
                                                            color: choice.missing
                                                                ? 'var(--content-danger, #b32d2e)'
                                                                : undefined,
                                                            textDecoration: choice.missing ? 'line-through' : undefined,
                                                        }}
                                                    >
                                                        {choice.id}
                                                    </span>
                                                    {choice.missing && (
                                                        <OLBadge bg="warning" style={{ marginLeft: 'auto' }}>
                                                            {t(
                                                                'model_not_available_on_backend',
                                                                'not available on the backend'
                                                            )}
                                                        </OLBadge>
                                                    )}
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

                            {/* overleaf-lab: the compliance review settings used to be
                                section 5 here. They live on their own admin page now,
                                /admin/compliance/settings, together with their toggle. */}
                            {/* ── Section 6: AI Prompts ── */}
                            {/* overleaf-lab: editable prompts behind each AI feature; empty means built-in default */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>6</span>
                                    <MaterialIcon type="edit_note" />
                                    {t('ai_prompts', 'AI Prompts')}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'ai_prompts_desc',
                                        'Customize the prompts behind each AI feature. Leave a field empty to use the built-in default.'
                                    )}
                                </p>

                                {/* overleaf-lab: (a) the three standalone prompts, each with a reset link */}
                                {[
                                    {
                                        key: 'askAiSystemPrompt',
                                        value: askAiSystemPrompt,
                                        set: setAskAiSystemPrompt,
                                        def: promptDefaults.askAiSystemPrompt,
                                        label: t('ask_ai_behavior_prompt', 'Ask AI behavior prompt'),
                                        help: t('ask_ai_behavior_prompt_help', 'System prompt for the selection toolbar (Ask AI / paraphrase / rewrite).'),
                                    },
                                    {
                                        key: 'errorPrompt',
                                        value: errorPrompt,
                                        set: setErrorPrompt,
                                        def: promptDefaults.errorPrompt,
                                        label: t('error_help_prompt', 'Error help prompt'),
                                        help: t('error_help_prompt_help', 'Instructions appended when a user clicks Ask AI about a compile error.'),
                                    },
                                    // overleaf-lab: the review system prompt moved to the
                                    // compliance settings page, with the rest of the review.
                                    {
                                        key: 'completionSystemPrompt',
                                        value: completionSystemPrompt,
                                        set: setCompletionSystemPrompt,
                                        def: promptDefaults.completionSystemPrompt,
                                        label: t('completion_system_prompt', 'Inline completion prompt'),
                                        help: t('completion_system_prompt_help', 'System prompt for the suggestion that appears while typing. Keep it short: it is sent on every completion, so length here costs latency.'),
                                    },
                                ].map(field => (
                                    <div key={field.key} style={{ marginBottom: '1.25rem' }}>
                                        <OLFormGroup controlId={`llm-${field.key}`} style={{ marginBottom: '0.25rem' }}>
                                            <OLFormLabel>
                                                {field.label}
                                            </OLFormLabel>
                                            {/* overleaf-lab: the default is a PLACEHOLDER, never a value.
                                                Prefilling it would turn every save of this page into a
                                                verbatim override frozen at that day's default, which then
                                                stops receiving module updates without any sign of it. */}
                                            <OLFormControl
                                                as="textarea"
                                                rows={6}
                                                value={field.value}
                                                placeholder={field.def}
                                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                                    field.set(e.target.value)
                                                }
                                                style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}
                                            />
                                        </OLFormGroup>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                            <OLFormText style={{ margin: 0 }}>
                                                {field.help}{' '}
                                                {field.value
                                                    ? t(
                                                          'prompt_override_active',
                                                          'Currently overridden: this text is used as is and will not follow future updates of the built-in prompt.'
                                                      )
                                                    : t(
                                                          'prompt_using_default',
                                                          'Empty: the built-in prompt shown in grey is used, and stays up to date with the module.'
                                                      )}
                                            </OLFormText>
                                            {/* Clearing the field IS the reset: empty means "follow the
                                                built-in default", which keeps improving. */}
                                            <OLButton
                                                variant="link"
                                                size="sm"
                                                type="button"
                                                disabled={!field.value}
                                                onClick={() => field.set('')}
                                                style={{ padding: 0, fontSize: '0.8125rem' }}
                                            >
                                                <MaterialIcon type="restart_alt" className="me-1" style={{ fontSize: '1rem' }} />
                                                {t('use_default_prompt', 'Use the default')}
                                            </OLButton>
                                        </div>
                                    </div>
                                ))}

                                {/* overleaf-lab: (b) collapsible Ask AI action templates, one textarea per action */}
                                <div style={{ marginTop: '0.5rem' }}>
                                    <OLButton
                                        variant="link"
                                        size="sm"
                                        type="button"
                                        onClick={() => setShowActions(v => !v)}
                                        style={{ padding: 0, fontSize: '0.875rem' }}
                                    >
                                        <MaterialIcon type={showActions ? 'expand_less' : 'expand_more'} className="me-1" style={{ fontSize: '1.125rem' }} />
                                        {t('ask_ai_action_templates', 'Ask AI action templates')}
                                    </OLButton>

                                    {showActions && (
                                        <div style={{ marginTop: '0.75rem' }}>
                                            <OLFormText style={{ marginTop: 0, marginBottom: '0.75rem' }}>
                                                {t(
                                                    'ask_ai_action_help',
                                                    'Each template runs on the selected text. Use {{selection}} where the selected text should be inserted; if omitted, it is appended.'
                                                )}
                                            </OLFormText>
                                            {['paraphrase', 'academic', 'concise', 'punchy', 'split', 'join', 'summarize', 'explain', 'title', 'abstract'].map(key => (
                                                <div key={key} style={{ marginBottom: '1rem' }}>
                                                    <OLFormGroup controlId={`llm-action-${key}`} style={{ marginBottom: '0.25rem' }}>
                                                        <OLFormLabel>
                                                            {t(`ask_ai_action_${key}`, key.charAt(0).toUpperCase() + key.slice(1))}
                                                        </OLFormLabel>
                                                        {/* Same contract as the prompts above: the
                                                            default is a placeholder, empty means follow it. */}
                                                        <OLFormControl
                                                            as="textarea"
                                                            rows={4}
                                                            value={askAiActionPrompts[key] || ''}
                                                            placeholder={promptDefaults.askAiActionPrompts?.[key] || ''}
                                                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                                                                const value = e.target.value
                                                                setAskAiActionPrompts(prev => ({ ...prev, [key]: value }))
                                                            }}
                                                            style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}
                                                        />
                                                    </OLFormGroup>
                                                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                                        <OLButton
                                                            variant="link"
                                                            size="sm"
                                                            type="button"
                                                            disabled={!askAiActionPrompts[key]}
                                                            onClick={() =>
                                                                setAskAiActionPrompts(prev => ({ ...prev, [key]: '' }))
                                                            }
                                                            style={{ padding: 0, fontSize: '0.8125rem' }}
                                                        >
                                                            <MaterialIcon type="restart_alt" className="me-1" style={{ fontSize: '1rem' }} />
                                                            {t('use_default_prompt', 'Use the default')}
                                                        </OLButton>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
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
                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
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
                                {/* overleaf-lab: the review settings are one page away, and an
                                    admin who came here looking for the rubrics needs to be told
                                    where they went. */}
                                <OLButton variant="link" href="/admin/compliance/settings">
                                    {t('compliance_check', 'Compliance check')}
                                </OLButton>
                            </div>
                        </form>
                    </div>
                </OLCol>
            </OLRow>
        </div>
    )
}
