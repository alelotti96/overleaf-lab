// overleaf-lab: the admin page of the compliance check. These settings used to be
// section 5 of the LLM page, below the chat's API keys and models: the LLM page is
// about chat and inline completion, and a reviewer looking for the rubrics had to
// scroll past settings that have nothing to do with the review.
//
// Same super_admin gate and same settings document as the LLM page, so this page
// posts to /admin/llm/settings too. It sends ONLY the review fields; every other
// field keeps its stored value server-side (see saveAdminSettings, which merges
// field by field against what is on disk).
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
import MaterialIcon from '@/shared/components/material-icon'
import {
    sectionStyle,
    sectionHeaderStyle,
    sectionDescStyle,
    stepNumberStyle,
    ToggleSwitch,
} from './llm-admin-ui'

type Rubric = {
    id: string
    name: string
    guidelines: string
    scanPatterns?: string
}

// overleaf-lab: one model backend a review may run on. Leave the list empty and the
// instance keeps its single backend and its one-review-at-a-time queue, which is what
// every install had before this existed. Add entries and the queue runs one review per
// entry: three GPUs, three models, no queue until all three are busy.
type ReviewEndpoint = {
    id: string
    label: string
    url: string
    model: string
    modelBackup: string
}

export default function LLMComplianceSettingsPage() {
    const { t } = useTranslation()
    const { isLoading, isSuccess, isError, runAsync } = useAsync()

    const rubricsFromMeta = getMeta('ol-complianceRubrics') as Rubric[]
    const initialRubrics: Rubric[] = Array.isArray(rubricsFromMeta)
        ? rubricsFromMeta
        : []

    const [reviewEnabled, setReviewEnabled] = useState<boolean>(
        getMeta('ol-reviewEnabled') !== false
    )
    const [complianceRubrics, setComplianceRubrics] =
        useState<Rubric[]>(initialRubrics)
    const [reviewModel, setReviewModel] = useState<string>(
        (getMeta('ol-reviewModel') as string) || ''
    )
    const [reviewModelBackup, setReviewModelBackup] = useState<string>(
        (getMeta('ol-reviewModelBackup') as string) || ''
    )
    const [maxContextTokens, setMaxContextTokens] = useState<number>(
        parseInt((getMeta('ol-maxContextTokens') as string) || '32000', 10) || 32000
    )
    const [reviewMaxTokens, setReviewMaxTokens] = useState<number>(
        parseInt((getMeta('ol-reviewMaxTokens') as string) || '12000', 10) || 12000
    )
    const [reviewSystemPrompt, setReviewSystemPrompt] = useState<string>(
        (getMeta('ol-reviewSystemPrompt') as string) || ''
    )
    const endpointsFromMeta = getMeta('ol-reviewEndpoints') as ReviewEndpoint[]
    const [reviewEndpoints, setReviewEndpoints] = useState<ReviewEndpoint[]>(
        Array.isArray(endpointsFromMeta) ? endpointsFromMeta : []
    )

    const promptDefaults = (getMeta('ol-promptDefaults') as any) || {}

    // The review model is picked from the models the LLM page allows, so the
    // two pages stay consistent about which models exist at all.
    const allowedModels = ((getMeta('ol-allowedModels') as string) || '')
        .split(',')
        .map(m => m.trim())
        .filter(Boolean)

    const [saved, setSaved] = useState(false)
    useEffect(() => {
        if (!isSuccess) return
        setSaved(true)
        const timer = setTimeout(() => setSaved(false), 4000)
        return () => clearTimeout(timer)
    }, [isSuccess])

    const addRubric = () => {
        const id = `rubric-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        setComplianceRubrics(prev => [
            ...prev,
            { id, name: '', guidelines: '', scanPatterns: '' },
        ])
    }

    const updateRubric = (id: string, field: keyof Rubric, value: string) => {
        setComplianceRubrics(prev =>
            prev.map(r => (r.id === id ? { ...r, [field]: value } : r))
        )
    }

    const removeRubric = (id: string) => {
        setComplianceRubrics(prev => prev.filter(r => r.id !== id))
    }

    // overleaf-lab: the id is generated once, here, and travels with the entry from
    // then on. It keys the running-slot table and the "which machine served this
    // review" field of every archived report, so deriving it from the position in the
    // list would silently re-label every past report the first time somebody reorders
    // the rows. Same reason, and same shape, as the rubric ids above.
    const addEndpoint = () => {
        const id = `endpoint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        setReviewEndpoints(prev => [
            ...prev,
            { id, label: '', url: '', model: '', modelBackup: '' },
        ])
    }

    const updateEndpoint = (id: string, field: keyof ReviewEndpoint, value: string) => {
        setReviewEndpoints(prev =>
            prev.map(e => (e.id === id ? { ...e, [field]: value } : e))
        )
    }

    const removeEndpoint = (id: string) => {
        setReviewEndpoints(prev => prev.filter(e => e.id !== id))
    }

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault()
        runAsync(
            postJSON('/admin/llm/settings', {
                body: {
                    reviewEnabled,
                    complianceRubrics,
                    reviewModel,
                    reviewModelBackup,
                    reviewEndpoints,
                    maxContextTokens,
                    reviewMaxTokens,
                    reviewSystemPrompt,
                },
            })
        ).catch(() => { })
    }

    return (
        <div className="container" style={{ maxWidth: '800px', margin: '0 auto' }}>
            <OLRow>
                <OLCol>
                    <div style={{ padding: '2rem 0' }}>
                        <div style={{ marginBottom: '2rem' }}>
                            <h1
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem',
                                    marginBottom: '0.5rem',
                                }}
                            >
                                <MaterialIcon type="fact_check" />
                                {t('compliance_check', 'Compliance check')}
                            </h1>
                            <p style={{ color: 'var(--content-secondary, #6c757d)', margin: 0 }}>
                                {t(
                                    'compliance_admin_description',
                                    'Configure the whole-document compliance check: the guideline rubrics users can check against, the model that runs the check, and the prompt behind it. The chat and inline completion settings are on the LLM Settings page.'
                                )}
                            </p>
                        </div>

                        <form onSubmit={handleSave}>
                            {/* ── Section 1: Availability ── */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>1</span>
                                    <MaterialIcon type="toggle_on" />
                                    {t('availability', 'Availability')}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'compliance_availability_desc',
                                        'When disabled, the compliance check disappears from the editor for everyone and the backend refuses to start a review.'
                                    )}
                                </p>

                                <div
                                    style={{
                                        border: '1px solid var(--border-color-01, #dee2e6)',
                                        borderRadius: '6px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: '1rem',
                                        padding: '0.75rem 1rem',
                                    }}
                                >
                                    <div>
                                        <span style={{ fontWeight: 500 }}>
                                            {t('feature_review', 'Compliance check')}
                                        </span>
                                        <OLFormText style={{ margin: 0 }}>
                                            {t(
                                                'feature_review_help',
                                                'The whole-document review.'
                                            )}
                                        </OLFormText>
                                    </div>
                                    <ToggleSwitch
                                        checked={reviewEnabled}
                                        onChange={setReviewEnabled}
                                        label={t('feature_review', 'Compliance check')}
                                    />
                                </div>
                            </div>

                            {/* ── Section 2: Rubrics ── */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>2</span>
                                    <MaterialIcon type="rule" />
                                    {t('compliance_rubrics', 'Rubrics')}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'compliance_rubrics_desc',
                                        'The guideline sets users can check a document against. Each rubric is one entry in the menu they pick from.'
                                    )}
                                </p>

                                {complianceRubrics.length === 0 && (
                                    <p
                                        style={{
                                            color: 'var(--content-secondary, #6c757d)',
                                            fontSize: '0.875rem',
                                            marginBottom: '1rem',
                                        }}
                                    >
                                        {t(
                                            'no_rubrics_yet',
                                            'No rubrics yet. Add one to enable the compliance review for users.'
                                        )}
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
                                            <OLFormLabel>{t('rubric_name', 'Rubric name')}</OLFormLabel>
                                            <OLFormControl
                                                type="text"
                                                value={rubric.name}
                                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                                    updateRubric(rubric.id, 'name', e.target.value)
                                                }
                                                placeholder={t(
                                                    'rubric_name_placeholder',
                                                    'e.g. Thesis writing guidelines'
                                                )}
                                            />
                                        </OLFormGroup>
                                        <OLFormGroup
                                            controlId={`rubric-guidelines-${rubric.id}`}
                                            style={{ marginBottom: '0.5rem' }}
                                        >
                                            <OLFormLabel>{t('rubric_guidelines', 'Guidelines')}</OLFormLabel>
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
                                        {/* overleaf-lab: per-rubric mechanical scans; policy
                                            patterns live next to the guidelines they verify */}
                                        <OLFormGroup
                                            controlId={`rubric-scans-${rubric.id}`}
                                            style={{ marginBottom: '0.5rem' }}
                                        >
                                            <OLFormLabel>
                                                {t(
                                                    'rubric_scan_patterns',
                                                    'Scan patterns (optional, one per line)'
                                                )}
                                            </OLFormLabel>
                                            <OLFormControl
                                                as="textarea"
                                                rows={3}
                                                value={rubric.scanPatterns || ''}
                                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                                    updateRubric(rubric.id, 'scanPatterns', e.target.value)
                                                }
                                                placeholder={
                                                    'First person :: (?<![\\w.@/])(io|noi|ho)\\b\nWikipedia :: wikipedia'
                                                }
                                                style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}
                                            />
                                            <OLFormText>
                                                {t(
                                                    'rubric_scan_patterns_help',
                                                    '"Label :: regex" (case-insensitive; a plain word works too). The whole source is scanned in code, exhaustively, and the matches are handed to the model as candidates to judge in context. Use it for the pattern-like requirements of THIS rubric (words to avoid, forbidden constructs), in the language of your guidelines.'
                                                )}
                                            </OLFormText>
                                        </OLFormGroup>
                                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                            <OLButton
                                                variant="danger"
                                                size="sm"
                                                type="button"
                                                onClick={() => removeRubric(rubric.id)}
                                            >
                                                <MaterialIcon
                                                    type="delete"
                                                    className="me-1"
                                                    style={{ fontSize: '1rem' }}
                                                />
                                                {t('remove', 'Remove')}
                                            </OLButton>
                                        </div>
                                    </div>
                                ))}
                                <div style={{ marginBottom: '0.5rem' }}>
                                    <OLButton variant="secondary" size="sm" type="button" onClick={addRubric}>
                                        <MaterialIcon
                                            type="add"
                                            className="me-1"
                                            style={{ fontSize: '1rem' }}
                                        />
                                        {t('add_rubric', 'Add rubric')}
                                    </OLButton>
                                </div>
                                <OLFormText>
                                    {t(
                                        'compliance_rubrics_help',
                                        'Paste your thesis or internship writing guidelines. The AI checks the whole document against each rubric and returns a report.'
                                    )}
                                </OLFormText>
                            </div>

                            {/* ── Section 3: Model and budgets ── */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>3</span>
                                    <MaterialIcon type="memory" />
                                    {t('compliance_model', 'Model and budgets')}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'compliance_model_desc',
                                        'Which model runs the check, what to fall back to when it fails, and how much room the document and the answer get.'
                                    )}
                                </p>

                                <OLFormGroup controlId="llm-review-model">
                                    <OLFormLabel>{t('review_model', 'Review model')}</OLFormLabel>
                                    <select
                                        id="llm-review-model"
                                        className="form-select"
                                        value={reviewModel}
                                        onChange={e => setReviewModel(e.target.value)}
                                    >
                                        <option value="">
                                            {t('review_model_shared_default', 'Shared chat model (default)')}
                                        </option>
                                        {allowedModels.map(model => (
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

                                <OLFormGroup controlId="llm-review-model-backup" style={{ marginTop: '1.25rem' }}>
                                    <OLFormLabel>
                                        {t('review_model_backup', 'Backup review model')}
                                    </OLFormLabel>
                                    <select
                                        id="llm-review-model-backup"
                                        className="form-select"
                                        value={reviewModelBackup}
                                        onChange={e => setReviewModelBackup(e.target.value)}
                                    >
                                        <option value="">
                                            {t('review_model_backup_none', 'None (fail without switching)')}
                                        </option>
                                        {allowedModels.map(model => (
                                            <option key={model} value={model}>
                                                {model}
                                            </option>
                                        ))}
                                    </select>
                                    <OLFormText>
                                        {t(
                                            'review_model_backup_help',
                                            'If the review model fails twice in a row mid-review, the review switches to this model for the rest of the run.'
                                        )}
                                    </OLFormText>
                                </OLFormGroup>

                                {/* overleaf-lab: the review backend pool. Deliberately
                                    plain: it is a list of machines, and the only thing
                                    an administrator has to understand is that adding a
                                    row adds a review that can run at the same time. */}
                                <OLFormGroup style={{ marginTop: '1.5rem' }}>
                                    <OLFormLabel>
                                        {t('review_endpoints', 'Review backends')}
                                    </OLFormLabel>
                                    <OLFormText style={{ marginTop: 0, marginBottom: '0.75rem' }}>
                                        {t(
                                            'review_endpoints_help',
                                            'Leave this empty to run every review on the single backend configured on the LLM page. Add one row per model server and reviews run one per row, in parallel: a review takes the first free backend and stays on it from start to finish. A queue only forms once they are all busy.'
                                        )}
                                    </OLFormText>
                                    {reviewEndpoints.length > 0 && (
                                        <div
                                            style={{
                                                fontSize: '0.8125rem',
                                                color: 'var(--content-secondary, #6c757d)',
                                                marginBottom: '0.75rem',
                                            }}
                                        >
                                            {t(
                                                'review_endpoints_parallelism',
                                                `${reviewEndpoints.length} backend(s) configured: up to ${reviewEndpoints.length} reviews run at the same time.`
                                            )}
                                        </div>
                                    )}
                                    {reviewEndpoints.map(endpoint => (
                                        <div
                                            key={endpoint.id}
                                            style={{
                                                border: '1px solid var(--border-color-01, #dee2e6)',
                                                borderRadius: '6px',
                                                padding: '0.75rem',
                                                marginBottom: '0.75rem',
                                            }}
                                        >
                                            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                                <OLFormControl
                                                    type="text"
                                                    placeholder={t('review_endpoint_label', 'Name (shown in the report)')}
                                                    value={endpoint.label}
                                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                                        updateEndpoint(endpoint.id, 'label', e.target.value)
                                                    }
                                                />
                                                <OLButton
                                                    variant="danger"
                                                    size="sm"
                                                    type="button"
                                                    onClick={() => removeEndpoint(endpoint.id)}
                                                >
                                                    {t('remove', 'Remove')}
                                                </OLButton>
                                            </div>
                                            <OLFormControl
                                                type="text"
                                                placeholder="http://gpu-1:8080/v1"
                                                value={endpoint.url}
                                                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                                    updateEndpoint(endpoint.id, 'url', e.target.value)
                                                }
                                                style={{ marginBottom: '0.5rem' }}
                                            />
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                <OLFormControl
                                                    type="text"
                                                    placeholder={t('review_endpoint_model', 'Model on this backend')}
                                                    value={endpoint.model}
                                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                                        updateEndpoint(endpoint.id, 'model', e.target.value)
                                                    }
                                                />
                                                <OLFormControl
                                                    type="text"
                                                    placeholder={t('review_endpoint_model_backup', 'Backup model on this backend')}
                                                    value={endpoint.modelBackup}
                                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                                        updateEndpoint(endpoint.id, 'modelBackup', e.target.value)
                                                    }
                                                />
                                            </div>
                                        </div>
                                    ))}
                                    <OLButton
                                        variant="secondary"
                                        size="sm"
                                        type="button"
                                        onClick={addEndpoint}
                                    >
                                        <MaterialIcon type="add" className="me-1" style={{ fontSize: '1rem' }} />
                                        {t('add_review_endpoint', 'Add a review backend')}
                                    </OLButton>
                                </OLFormGroup>

                                <OLFormGroup controlId="llm-max-context-tokens" style={{ marginTop: '1rem' }}>
                                    <OLFormLabel>{t('max_context_tokens', 'Max context tokens')}</OLFormLabel>
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

                                <OLFormGroup
                                    controlId="llm-review-max-tokens"
                                    style={{ marginTop: '1rem', marginBottom: 0 }}
                                >
                                    <OLFormLabel>
                                        {t('review_max_tokens', 'Review answer budget (tokens)')}
                                    </OLFormLabel>
                                    <OLFormControl
                                        type="number"
                                        value={reviewMaxTokens}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                            const parsed = parseInt(e.target.value, 10)
                                            if (!isNaN(parsed)) {
                                                setReviewMaxTokens(parsed)
                                            }
                                        }}
                                    />
                                    <OLFormText>
                                        {t(
                                            'review_max_tokens_help',
                                            'Upper limit for the answer of each review pass. The actual room adapts to what the document leaves free inside Max context tokens, so a large value here never blocks a long document; it only allows more thorough per-requirement analyses when there is room.'
                                        )}
                                    </OLFormText>
                                </OLFormGroup>
                            </div>

                            {/* ── Section 4: Prompt ── */}
                            <div style={sectionStyle}>
                                <div style={sectionHeaderStyle}>
                                    <span style={stepNumberStyle}>4</span>
                                    <MaterialIcon type="edit_note" />
                                    {t('review_system_prompt', 'Review system prompt')}
                                </div>
                                <p style={sectionDescStyle}>
                                    {t(
                                        'review_system_prompt_help',
                                        'System prompt for the whole-document compliance review.'
                                    )}
                                </p>

                                <OLFormGroup
                                    controlId="llm-reviewSystemPrompt"
                                    style={{ marginBottom: '0.25rem' }}
                                >
                                    {/* overleaf-lab: the default is a PLACEHOLDER, never a value.
                                        Prefilling it would turn every save of this page into a
                                        verbatim override frozen at that day's default, which then
                                        stops receiving module updates without any sign of it. */}
                                    <OLFormControl
                                        as="textarea"
                                        rows={8}
                                        value={reviewSystemPrompt}
                                        placeholder={promptDefaults.reviewSystemPrompt}
                                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                                            setReviewSystemPrompt(e.target.value)
                                        }
                                        style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}
                                    />
                                </OLFormGroup>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                    }}
                                >
                                    <OLFormText style={{ margin: 0 }}>
                                        {reviewSystemPrompt
                                            ? t(
                                                  'prompt_override_active',
                                                  'Currently overridden: this text is used as is and will not follow future updates of the built-in prompt.'
                                              )
                                            : t(
                                                  'prompt_using_default',
                                                  'Empty: the built-in prompt shown in grey is used, and stays up to date with the module.'
                                              )}
                                    </OLFormText>
                                    <OLButton
                                        variant="link"
                                        size="sm"
                                        type="button"
                                        disabled={!reviewSystemPrompt}
                                        onClick={() => setReviewSystemPrompt('')}
                                        style={{ padding: 0, fontSize: '0.8125rem' }}
                                    >
                                        <MaterialIcon
                                            type="restart_alt"
                                            className="me-1"
                                            style={{ fontSize: '1rem' }}
                                        />
                                        {t('use_default_prompt', 'Use the default')}
                                    </OLButton>
                                </div>
                            </div>

                            {isError && (
                                <OLNotification
                                    type="error"
                                    content={t(
                                        'generic_something_went_wrong',
                                        'Something went wrong'
                                    )}
                                />
                            )}
                            {saved && (
                                <OLNotification
                                    type="success"
                                    content={t('saved', 'Saved')}
                                />
                            )}

                            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                <OLButton variant="primary" type="submit" disabled={isLoading}>
                                    {isLoading ? t('saving', 'Saving') : t('save', 'Save')}
                                </OLButton>
                                <OLButton variant="link" href="/admin/llm/settings">
                                    {t('llm_settings', 'LLM Settings')}
                                </OLButton>
                            </div>
                        </form>
                    </div>
                </OLCol>
            </OLRow>
        </div>
    )
}
