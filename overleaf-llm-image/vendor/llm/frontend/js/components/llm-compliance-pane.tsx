import React from 'react'
import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import OLButton from '@/shared/components/ol/ol-button'
import { useLLMCompliance } from '../hooks/use-llm-compliance'
import type {
    ComplianceItem,
    ComplianceLocation,
    ComplianceStatus,
    GotoSource,
} from '../hooks/use-llm-compliance'

// overleaf-lab: visual mapping for each requirement status. Colours reuse the
// app's design tokens with hard-coded fallbacks so the pane still reads well if
// a token is missing.
const STATUS_STYLE: Record<
    ComplianceStatus,
    { icon: string; color: string }
> = {
    ok: { icon: 'check_circle', color: 'var(--green-60, #198754)' },
    partial: { icon: 'warning', color: 'var(--yellow-60, #f59e0b)' },
    missing: { icon: 'cancel', color: 'var(--red-60, #dc3545)' },
    na: { icon: 'remove', color: 'var(--content-secondary, #6c757d)' },
}

// overleaf-lab: a muted-but-readable text color that adapts to the theme. It is a
// slightly faded version of the ADAPTIVE primary token (--content-primary-themed,
// the one that actually flips on dark), so grey text stays legible on the dark
// theme. If color-mix is unsupported the value is ignored and the text falls back
// to the inherited (readable) color.
const MUTED =
    'color-mix(in srgb, var(--content-primary-themed) 72%, transparent)'

// overleaf-lab: THE MEASURED-FACT BLOCKS the review attaches to its result next to the
// findings: the bibliography check (LLMBibVerify), the figure resolutions
// (LLMImageMetrics) and the AI writing signals (LLMAISignals).
//
// They are declared here rather than in the hook because this is the only place that
// reads them and because they are not compliance verdicts: keeping them out of
// ComplianceItem is what stops anything from counting them as findings. Every field is
// optional and nothing is trusted: these blocks are written by three modules over
// several versions of their schema, and an archived result from an older run is handed
// to today's panel.
interface FactBlock {
    // `false` means the check was configured and did not run, with the reason. Absent
    // means the check does not exist on this deployment at all, which is the only case
    // that renders nothing: see the NOT RUN line below.
    enabled?: boolean
    reason?: string
}
interface BibVerifyBlock extends FactBlock {
    checked?: number
    total?: number
    findings?: unknown[]
    totals?: { findings?: { total?: number } }
}
interface ImageMetricsBlock extends FactBlock {
    totals?: {
        raster?: number
        vector?: number
        measured?: { total?: number }
        unchecked?: { total?: number }
    }
    dpiRange?: { min?: number; max?: number } | null
    measured?: unknown[]
    unchecked?: unknown[]
}
// overleaf-lab: a quoted passage of the signals block, with the address the signals
// module now derives for it. Every field is optional and BOTH shapes of an excerpt are
// accepted (a bare string before the module learned to place them, an object after),
// because an archived block written months ago is handed to today's panel.
type AiPassage = { text?: string; file?: string; line?: number }
interface AiSignalsBlock {
    artifacts?: {
        label?: string
        excerpt?: string
        file?: string
        line?: number
    }[]
    flaggedChapters?: {
        name?: string
        signals?: { label?: string; excerpts?: (string | AiPassage)[] }[]
    }[]
    clusters?: {
        chapter?: string
        paragraphExcerpt?: string
        file?: string
        line?: number
    }[]
}
interface ResultFacts {
    aiSignals?: AiSignalsBlock | null
    bibVerify?: BibVerifyBlock | null
    imageMetrics?: ImageMetricsBlock | null
    // The delta grew a count the hook's type does not carry yet: how many requirements
    // this run could not re-check (see buildDelta in LLMComplianceStore).
    delta?: { notRecheckedCount?: number } | null
}

// overleaf-lab: mm:ss for the progress readout.
function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.round(ms / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// overleaf-lab: the mechanical grounding warning is appended to the evidence text by
// the backend. Split it out so it can be shown as a badge: it is a statement about
// the evidence, not part of it, and buried at the end of a long line nobody sees it.
const GROUNDING_WARNING = /\s*\[warning:\s*([^\]]+)\]\s*$/i

// overleaf-lab: render a file path inside evidence as a monospace chip. Evidence is
// mostly "path: quote | path: quote", and making the paths scannable is most of what
// turns the block from a paragraph into something a reader can navigate.
// Two regexes on purpose: the global one splits (and keeps the paths, via the
// capture group), the anchored one tests a chunk. Calling .test() on the global one
// would advance its lastIndex between chunks and match every other path.
// The trailing `:line` is part of the match now: the structural checks write
// "path:line - what", and leaving the number outside the chip both looked wrong and
// threw away the one thing that makes the chip land on the right line.
const PATH_PATTERN = /(\/[\w./-]+\.(?:tex|bib|cls|sty)(?::\d+)?)/g
const IS_PATH = /^(\/[\w./-]+\.(?:tex|bib|cls|sty))(?::(\d+))?$/

// overleaf-lab: THE CHIP THAT IS ALSO A JUMP. Every file:line the review produces is a
// place in the student's own source, and reading one used to mean finding the file in
// the tree and counting to the line by hand. With the editor reachable it becomes a
// button that opens exactly that line, by the same route double-clicking the PDF takes.
//
// With the editor NOT reachable it stays the monospace text it always was. There is no
// third state: this never renders a control that does nothing, because a chip that looks
// clickable and is not teaches the reader to stop clicking. A <button> and not a styled
// <span>, so the keyboard reaches it for free.
const CHIP: React.CSSProperties = {
    fontFamily: 'var(--font-family-monospace, monospace)',
    fontSize: '0.95em',
    padding: '0 4px',
    borderRadius: 3,
    lineHeight: 'inherit',
}

function SourceChip({
    path,
    line,
    gotoSource,
    background,
}: {
    path: string
    line?: number
    gotoSource?: GotoSource | null
    background: string
}) {
    const { t } = useTranslation()
    const label = typeof line === 'number' && line > 0 ? `${path}:${line}` : path
    if (!gotoSource) {
        return <code style={{ ...CHIP, background }}>{label}</code>
    }
    return (
        <button
            type="button"
            onClick={() => gotoSource(path, line)}
            title={t('review_open_in_editor', 'Open this line in the editor')}
            style={{
                ...CHIP,
                background,
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                textDecoration: 'underline dotted',
                textUnderlineOffset: 2,
            }}
        >
            {label}
        </button>
    )
}

// overleaf-lab: the source excerpt, folded away. The full treatment belongs to the
// downloaded report, which is the document that gets read end to end; what a panel this
// narrow can afford is the lines themselves, one click away, for the reader who wants to
// see the spot without leaving the finding they are on.
function SourceExcerptList({
    locations,
    gotoSource,
}: {
    locations: ComplianceLocation[]
    gotoSource?: GotoSource | null
}) {
    const { t } = useTranslation()
    const withExcerpt = locations.filter(
        loc => loc.excerpt && loc.excerpt.lines && loc.excerpt.lines.length > 0
    )
    if (withExcerpt.length === 0) {
        return null
    }
    return (
        <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.8em', color: MUTED }}>
                {t('review_show_source', 'Show the source')}
            </summary>
            {withExcerpt.map((loc, i) => (
                <div key={i} style={{ marginTop: 4 }}>
                    <div style={{ fontSize: '0.8em', marginBottom: 2 }}>
                        <SourceChip
                            path={loc.path}
                            line={loc.line}
                            gotoSource={gotoSource}
                            background="rgba(99,102,241,0.16)"
                        />
                    </div>
                    <div
                        style={{
                            fontFamily: 'var(--font-family-monospace, monospace)',
                            fontSize: '0.78em',
                            lineHeight: 1.5,
                            background: 'rgba(125,125,125,0.12)',
                            borderRadius: 4,
                            padding: '3px 0',
                            overflowX: 'auto',
                        }}
                    >
                        {(loc.excerpt?.lines || []).map((source, j) => (
                            <div
                                key={j}
                                style={{
                                    display: 'flex',
                                    gap: 8,
                                    padding: '0 6px',
                                    background:
                                        j === loc.excerpt?.mark
                                            ? 'rgba(245,158,11,0.18)'
                                            : undefined,
                                    fontWeight:
                                        j === loc.excerpt?.mark ? 600 : undefined,
                                }}
                            >
                                <span
                                    style={{
                                        color: MUTED,
                                        textAlign: 'right',
                                        minWidth: '2.4em',
                                        flexShrink: 0,
                                        userSelect: 'none',
                                    }}
                                >
                                    {(loc.excerpt?.start || 0) + j}
                                </span>
                                <span style={{ whiteSpace: 'pre' }}>{source}</span>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </details>
    )
}

// overleaf-lab: the passages the AI-signals block quotes, each with the place it came
// from. The counts stay on the one line above; this is the folded list underneath, and
// it exists for one reason: the section asks the reader to go and judge the passages
// themselves, which is not something a reader can do with a sentence and no address.
//
// THE SECTION'S TONE RULES HOLD HERE TOO. No score, no verdict, no ordering that implies
// one: this adds an address to a quotation and nothing else. The caveat stays on the
// line above, where a reader who never opens this fold still reads it.
const AI_PASSAGE_ROWS = 12

function AiSignalPassages({
    signals,
    gotoSource,
}: {
    signals?: AiSignalsBlock | null
    gotoSource?: GotoSource | null
}) {
    const { t } = useTranslation()
    const rows: { label: string; text: string; file: string; line?: number }[] = []
    for (const artifact of signals?.artifacts || []) {
        if (artifact?.file) {
            rows.push({
                label: artifact.label || '',
                text: artifact.excerpt || '',
                file: artifact.file,
                line: artifact.line,
            })
        }
    }
    for (const cluster of signals?.clusters || []) {
        if (cluster?.file) {
            rows.push({
                label: cluster.chapter || '',
                text: cluster.paragraphExcerpt || '',
                file: cluster.file,
                line: cluster.line,
            })
        }
    }
    for (const chapter of signals?.flaggedChapters || []) {
        for (const signal of chapter?.signals || []) {
            for (const entry of signal?.excerpts || []) {
                // A string is the old shape and carries no address, so it has nothing to
                // contribute to a list that is entirely about addresses.
                const passage: AiPassage =
                    typeof entry === 'string' ? { text: entry } : entry || {}
                if (passage.file) {
                    rows.push({
                        label: signal.label || chapter.name || '',
                        text: passage.text || '',
                        file: passage.file,
                        line: passage.line,
                    })
                }
            }
        }
    }
    if (rows.length === 0) {
        return null
    }
    const shown = rows.slice(0, AI_PASSAGE_ROWS)
    return (
        <details style={{ marginTop: 4 }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.8em', color: MUTED }}>
                {t('review_ai_signals_passages', 'Show where these passages are')}
            </summary>
            {shown.map((row, i) => (
                <div key={i} style={{ marginTop: 4, fontSize: '0.8em' }}>
                    <SourceChip
                        path={row.file}
                        line={row.line}
                        gotoSource={gotoSource}
                        background="rgba(99,102,241,0.16)"
                    />
                    {row.label ? <span style={{ color: MUTED }}> {row.label}</span> : null}
                    {row.text ? (
                        <div style={{ color: MUTED, overflowWrap: 'anywhere' }}>
                            {row.text}
                        </div>
                    ) : null}
                </div>
            ))}
            {/* A list that was cut short says so, exactly as every list in the report
                does: a reader shown twelve of forty has been misled by the panel. */}
            {rows.length > shown.length && (
                <div style={{ marginTop: 4, fontSize: '0.8em', color: MUTED }}>
                    {t('review_ai_signals_more', 'Showing the first')} {shown.length}/
                    {rows.length}.{' '}
                    {t(
                        'review_facts_see_report',
                        'See the downloaded report for details.'
                    )}
                </div>
            )}
        </details>
    )
}

function EvidenceText({
    text,
    gotoSource,
}: {
    text: string
    gotoSource?: GotoSource | null
}) {
    const parts = text.split(/\s\|\s/).filter(Boolean)
    const renderPart = (part: string, key: number) => (
        <React.Fragment key={key}>
            {part.split(PATH_PATTERN).map((chunk, i) => {
                const hit = IS_PATH.exec(chunk)
                if (!hit) {
                    return <React.Fragment key={i}>{chunk}</React.Fragment>
                }
                return (
                    <SourceChip
                        key={i}
                        path={hit[1]}
                        line={hit[2] ? Number(hit[2]) : undefined}
                        gotoSource={gotoSource}
                        background="rgba(125,125,125,0.18)"
                    />
                )
            })}
        </React.Fragment>
    )

    // A single example reads better inline; several read better as a list.
    if (parts.length < 2) {
        return <>{parts.map(renderPart)}</>
    }
    return (
        <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
            {parts.map((part, i) => (
                <li key={i}>{renderPart(part, i)}</li>
            ))}
        </ul>
    )
}

// overleaf-lab: one line of the fact strip. Two tones only: a plain muted line for a
// check that ran, and the amber treatment of the "not reviewed" box for one that did
// not. A check that was configured and did not run must not look like a check that ran
// and found nothing, because in this panel the second one is invisible and the reader
// fills the silence with "everything is fine".
function FactLine({
    label,
    children,
    notRun,
}: {
    label: string
    children: React.ReactNode
    notRun?: boolean
}) {
    return (
        <div
            style={
                notRun
                    ? {
                          marginTop: 4,
                          padding: '4px 8px',
                          borderLeft: `3px solid ${STATUS_STYLE.partial.color}`,
                          background: 'rgba(245,158,11,0.12)',
                          fontSize: '0.85em',
                          overflowWrap: 'anywhere',
                      }
                    : {
                          marginTop: 4,
                          fontSize: '0.85em',
                          color: MUTED,
                          overflowWrap: 'anywhere',
                      }
            }
        >
            <strong>{label}</strong>: {children}
        </div>
    )
}

function ComplianceReportItem({
    item,
    gotoSource,
}: {
    item: ComplianceItem
    gotoSource?: GotoSource | null
}) {
    const { t } = useTranslation()
    const statusStyle = STATUS_STYLE[item.status] || STATUS_STYLE.na
    const warningMatch = GROUNDING_WARNING.exec(item.evidence || '')
    const evidence = (item.evidence || '').replace(GROUNDING_WARNING, '')

    return (
        <div
            style={{
                display: 'flex',
                gap: 8,
                padding: '8px 0',
                borderTop: '1px solid var(--border-divider, rgba(125,125,125,0.2))',
                minWidth: 0,
            }}
        >
            <MaterialIcon
                type={statusStyle.icon}
                style={{ color: statusStyle.color, flexShrink: 0, marginTop: 2 }}
            />
            <div style={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
                <div style={{ fontWeight: 'bold' }}>{item.requirement}</div>
                {warningMatch && (
                    <div
                        style={{
                            display: 'inline-block',
                            marginTop: 4,
                            padding: '1px 6px',
                            borderRadius: 4,
                            fontSize: '0.75em',
                            color: STATUS_STYLE.partial.color,
                            border: `1px solid ${STATUS_STYLE.partial.color}`,
                        }}
                        title={t(
                            'grounding_warning_hint',
                            'A mechanical search could not find these quotes in the source, so treat this evidence with care.'
                        )}
                    >
                        {warningMatch[1]}
                    </div>
                )}
                {evidence && (
                    <div style={{ color: MUTED, fontSize: '0.85em', marginTop: 2 }}>
                        {t('evidence', 'Evidence')}:{' '}
                        <EvidenceText text={evidence} gotoSource={gotoSource} />
                    </div>
                )}
                {/* overleaf-lab: positions computed from the quotes, not claimed by
                    the model. Shown apart from the evidence so it is clear they are
                    a different kind of statement: this one is always right. */}
                {item.locations && item.locations.length > 0 && (
                    <div style={{ fontSize: '0.85em', marginTop: 3 }}>
                        {t('found_at', 'Found at')}:{' '}
                        {item.locations.map((loc, i) => (
                            <React.Fragment key={i}>
                                <SourceChip
                                    path={loc.path}
                                    line={loc.line}
                                    gotoSource={gotoSource}
                                    background="rgba(99,102,241,0.16)"
                                />{' '}
                            </React.Fragment>
                        ))}
                    </div>
                )}
                {item.locations && item.locations.length > 0 && (
                    <SourceExcerptList
                        locations={item.locations}
                        gotoSource={gotoSource}
                    />
                )}
                {item.suggestion && (
                    <div style={{ fontStyle: 'italic', fontSize: '0.9em', marginTop: 2 }}>
                        {t('suggestion', 'Suggestion')}: {item.suggestion}
                    </div>
                )}
            </div>
        </div>
    )
}

function LLMCompliancePane() {
    const { t } = useTranslation()
    const {
        rubrics,
        rubricsLoaded,
        selectedRubricId,
        setSelectedRubricId,
        phase,
        position,
        progress,
        result,
        errorInfo,
        runReview,
        cancelReview,
        downloadReport,
        hasRubrics,
        notifyByEmail,
        // overleaf-lab: false when this instance has no model backend, which disables
        // the full button (with the reason) and leaves the fast one working.
        fullReviewAvailable,
        // Which of the two is running, so the notes below describe the right one.
        runningMode,
        // overleaf-lab: null when the editor is not reachable from where this pane is
        // mounted, which is what decides whether a location is a button or text.
        gotoSource,
    } = useLLMCompliance()

    // overleaf-lab: shown while a review is queued or running, because the single
    // most useful thing to know at that moment is that WAITING IS NOT REQUIRED. The
    // work happens server side and the finished report is archived, so the panel
    // picks it up again on the next visit even after the machine has been switched
    // off. The email line only appears where the instance can actually send one.
    const renderWaitNote = () => (
        <div style={{ marginTop: 8, fontSize: '0.85em', color: MUTED }}>
            {/* overleaf-lab: the note that says WAITING IS NOT REQUIRED belongs to the
                full review, which is minutes on a queue. A fast one is over before it
                could be read, and telling somebody they may shut their computer down
                for five seconds of work reads as a promise about the wrong thing. The
                email line follows the same rule and the same reason the mailer does:
                no mail is sent for a fast review at all. */}
            {runningMode === 'fast'
                ? t(
                      'review_fast_running',
                      'The fast review runs the code checks only, so it finishes in seconds.'
                  )
                : t(
                      'review_runs_on_server',
                      'The review runs on the server. You can close this panel, the browser, or even shut down your computer: the finished report will be here when you open the project again.'
                  )}
            {runningMode !== 'fast' && notifyByEmail && (
                <>
                    {' '}
                    {t(
                        'review_email_notice',
                        'You will also receive an email when it is done.'
                    )}
                </>
            )}
        </div>
    )

    if (!rubricsLoaded) {
        return (
            <div style={{ padding: 12, color: MUTED }}>
                {t('loading', 'Loading')}...
            </div>
        )
    }

    if (!hasRubrics) {
        return (
            <div style={{ padding: 12, color: MUTED }}>
                {t(
                    'compliance_no_rubrics',
                    'No review rubrics have been configured. Ask your administrator to add one in the LLM settings.'
                )}
            </div>
        )
    }

    // overleaf-lab: a job is active (in queue or running) while we poll it.
    const isActive = phase === 'queued' || phase === 'running'
    // overleaf-lab: the run button is only shown/enabled in the resting phases.
    const showRunButton = phase === 'idle' || phase === 'done' || phase === 'error'

    // overleaf-lab: map the fixed backend error codes to friendly copy. The code
    // now lives in errorInfo.errorCode.
    const renderError = (): React.ReactNode => {
        if (!errorInfo) return null

        // overleaf-lab: this one is a QUESTION, not a failure, so it gets its own
        // shape: what the rubric is for, what the check thought, and a button that
        // runs it anyway. Nothing was consumed at this point beyond a few seconds,
        // and the alternative to asking is twenty minutes spent measuring a document
        // against a rubric written for a different kind of document.
        if (errorInfo.errorCode === 'type_mismatch') {
            return (
                <div style={{ marginTop: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <MaterialIcon type="help" style={{ color: '#f59e0b', flexShrink: 0 }} />
                        <div>
                            <div style={{ fontWeight: 600 }}>
                                {errorInfo.certain
                                    ? t(
                                          'review_type_mismatch',
                                          'This does not look like the right kind of document. Are you sure?'
                                      )
                                    : t(
                                          'review_type_unsure',
                                          'The kind of this document could not be recognised. Are you sure this is the right review?'
                                      )}
                            </div>
                            {errorInfo.expectedDocument && (
                                <div style={{ marginTop: 6, fontSize: '0.85em', color: MUTED }}>
                                    {t('review_type_expected', 'This review is meant for:')}{' '}
                                    <em>{errorInfo.expectedDocument}</em>
                                </div>
                            )}
                            {errorInfo.message && (
                                <div style={{ marginTop: 6, fontSize: '0.85em', color: MUTED }}>
                                    {errorInfo.message}
                                </div>
                            )}
                            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                                <OLButton
                                    variant="primary"
                                    type="button"
                                    onClick={() => runReview(true)}
                                >
                                    <MaterialIcon type="fact_check" />{' '}
                                    {t('review_run_anyway', 'Run it anyway')}
                                </OLButton>
                            </div>
                            <div style={{ marginTop: 8, fontSize: '0.85em', color: MUTED }}>
                                {t(
                                    'review_type_pick_another',
                                    'Or pick a different review above and start again.'
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )
        }

        let message: string
        switch (errorInfo.errorCode) {
            case 'too_long':
                message = t(
                    'review_too_long',
                    'The document plus the room reserved for the answer does not fit the review model context window. Shorten the document, or ask your administrator to lower the review answer budget or raise the context window.'
                )
                break
            case 'busy':
                message = t(
                    'review_busy',
                    'A review is already running. Please try again in a moment.'
                )
                break
            case 'model_unavailable':
                message = t(
                    'review_model_unavailable',
                    'The review model is not available on the backend right now.'
                )
                break
            case 'not_configured':
                message = t(
                    'review_not_configured',
                    'The LLM backend is not configured. Contact your administrator.'
                )
                break
            case 'empty_document':
                message = t('review_empty', 'This project has no text to review.')
                break
            case 'disabled':
                message = t('review_disabled', 'The AI service is disabled.')
                break
            case 'not_found':
                message = t(
                    'review_not_found',
                    'The review was not found or has expired.'
                )
                break
            default:
                message =
                    errorInfo.message ||
                    t('review_failed', 'The review failed. Please try again.')
        }

        const showTokens =
            errorInfo.errorCode === 'too_long' &&
            errorInfo.documentTokensEstimate != null &&
            errorInfo.maxContextTokens != null

        // overleaf-lab: show the WHOLE equation. The refusal is caused by
        // prompt + reserved answer room exceeding the limit, so printing only
        // "prompt / limit" showed numbers that looked like they fitted.
        const promptTokens = errorInfo.documentTokensEstimate || 0
        const answerTokens = errorInfo.reviewMaxTokens || 0
        const totalTokens = promptTokens + answerTokens

        return (
            <div
                style={{
                    marginTop: 12,
                    padding: 10,
                    borderRadius: 6,
                    color: 'var(--red-60, #dc3545)',
                    border: '1px solid var(--red-60, #dc3545)',
                    background: 'rgba(220,53,69,0.08)',
                    overflowWrap: 'anywhere',
                }}
            >
                <div>{message}</div>
                {showTokens && (
                    <div style={{ color: MUTED, fontSize: '0.85em', marginTop: 4 }}>
                        {answerTokens > 0 ? (
                            <>
                                {t('review_tokens_document', 'Document')}:{' '}
                                {promptTokens.toLocaleString()} +{' '}
                                {t('review_tokens_answer', 'reserved for the answer')}:{' '}
                                {answerTokens.toLocaleString()} ={' '}
                                {totalTokens.toLocaleString()}, {t('review_tokens_limit', 'limit')}:{' '}
                                {(errorInfo.maxContextTokens || 0).toLocaleString()}{' '}
                                {t('tokens', 'tokens')}
                            </>
                        ) : (
                            <>
                                {promptTokens.toLocaleString()} /{' '}
                                {(errorInfo.maxContextTokens || 0).toLocaleString()}{' '}
                                {t('tokens', 'tokens')}
                            </>
                        )}
                    </div>
                )}
            </div>
        )
    }

    const renderResult = (): React.ReactNode => {
        if (!result) return null

        const counts = result.items.reduce(
            (acc, item) => {
                acc[item.status] = (acc[item.status] || 0) + 1
                return acc
            },
            {} as Record<ComplianceStatus, number>
        )

        // Most severe first inside the problems block, so the top of the list is
        // always the thing most worth reading.
        const SEVERITY: Record<ComplianceStatus, number> = {
            missing: 0,
            partial: 1,
            na: 2,
            ok: 3,
        }
        const problems = result.items
            .filter(item => item.status !== 'ok')
            .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status])
        const passed = result.items.filter(item => item.status === 'ok')

        // overleaf-lab: the measured-fact blocks, ONE LINE EACH. The full tables belong
        // to the downloaded report, which is the document that gets printed, forwarded
        // and kept; what belongs in a side panel is that they exist, their counts, and
        // above all a check that did NOT run saying so. Until this strip existed the
        // panel showed none of the three, so the strongest mechanical statement the
        // review can make about a bibliography reached nobody unless the report was
        // downloaded and read to the end.
        const facts = result as unknown as ResultFacts
        const bib = facts.bibVerify
        const figures = facts.imageMetrics
        const signals = facts.aiSignals
        const count = (rows?: unknown[]) => (Array.isArray(rows) ? rows.length : 0)
        const total = (tally?: { total?: number }, fallback = 0) =>
            typeof tally?.total === 'number' ? tally.total : fallback
        const factLines: React.ReactNode[] = []

        if (bib) {
            factLines.push(
                bib.enabled === false ? (
                    <FactLine
                        key="bib"
                        notRun
                        label={t('review_bib_check', 'Bibliography check')}
                    >
                        {t('review_not_run', 'NOT RUN')}
                        {bib.reason ? ` (${bib.reason})` : ''}.{' '}
                        {t(
                            'review_bib_not_run_note',
                            'No DOI was resolved, so nothing here says whether the references exist.'
                        )}
                    </FactLine>
                ) : (
                    <FactLine key="bib" label={t('review_bib_check', 'Bibliography check')}>
                        {t('review_bib_checked', 'entries checked')}:{' '}
                        {bib.checked || 0}/{bib.total || 0},{' '}
                        {t('review_bib_findings', 'findings')}:{' '}
                        {total(bib.totals?.findings, count(bib.findings))}
                    </FactLine>
                )
            )
        }

        if (figures && (figures.enabled === false || count(figures.measured) || count(figures.unchecked))) {
            const range = figures.dpiRange
            factLines.push(
                figures.enabled === false ? (
                    <FactLine key="fig" notRun label={t('review_figures', 'Figure resolution')}>
                        {t('review_not_run', 'NOT RUN')}
                        {figures.reason ? ` (${figures.reason})` : ''}.
                    </FactLine>
                ) : (
                    <FactLine key="fig" label={t('review_figures', 'Figure resolution')}>
                        {t('review_figures_measured', 'measured')}:{' '}
                        {total(figures.totals?.measured, count(figures.measured))}
                        {range && typeof range.min === 'number' && typeof range.max === 'number'
                            ? ` (${range.min}-${range.max} DPI)`
                            : ''}
                        {total(figures.totals?.unchecked, count(figures.unchecked)) > 0 && (
                            <>
                                {', '}
                                {t('review_figures_unmeasured', 'not measured')}:{' '}
                                {total(figures.totals?.unchecked, count(figures.unchecked))}
                            </>
                        )}
                    </FactLine>
                )
            )
        }

        // The signals block is silent when it found nothing, exactly as it is in the
        // report: naming the section over a clean thesis puts the question in the
        // reader's head with nothing to answer it with.
        const signalRows =
            count(signals?.artifacts) + count(signals?.flaggedChapters) + count(signals?.clusters)
        if (signalRows > 0) {
            factLines.push(
                <FactLine key="ai" label={t('review_ai_signals', 'AI writing signals')}>
                    {t('review_ai_signals_count', 'passages worth a look')}: {signalRows}.{' '}
                    {t(
                        'review_ai_signals_note',
                        'Not proof of anything, and false positives are common.'
                    )}
                    <AiSignalPassages signals={signals} gotoSource={gotoSource} />
                </FactLine>
            )
        }

        return (
            <div
                style={{
                    marginTop: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                    flex: 1,
                }}
            >
                {/* overleaf-lab: download the report as Markdown */}
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        marginBottom: 8,
                    }}
                >
                    <OLButton
                        variant="secondary"
                        type="button"
                        onClick={downloadReport}
                    >
                        <MaterialIcon type="download" />{' '}
                        {t('download_report', 'Download report')}
                    </OLButton>
                </div>

                {/* overleaf-lab: nudge users to keep the report; a new review is a
                    heavy, minutes-long operation for the server. */}
                <div
                    style={{
                        fontSize: '0.8em',
                        color: MUTED,
                        marginBottom: 8,
                        overflowWrap: 'anywhere',
                    }}
                >
                    {/* The second half of this is about the FULL review: it is the one
                        that costs the server minutes of model time. Telling somebody
                        not to repeat a five-second run of local checks would argue
                        against the one thing the fast mode is for. */}
                    {result.mode === 'fast'
                        ? t(
                              'review_download_hint_fast',
                              'Tip: download this report to keep it. This report is not stored in the project.'
                          )
                        : t(
                              'review_download_hint',
                              'Tip: download this report to keep it. Running a new review is a heavy operation for the server, so avoid repeating it unnecessarily.'
                          )}
                </div>

                {/* overleaf-lab: WHICH REVIEW THIS REPORT CAME FROM, above the tally
                    it qualifies. Six OK and twenty-four N/A is an excellent-looking
                    row of numbers and a fast review reads exactly like that, so the
                    sentence that explains the N/A column has to come before it rather
                    than be discovered requirement by requirement further down. */}
                {result.mode === 'fast' && (
                    <div style={{ fontSize: '0.85em', marginBottom: 8, color: MUTED }}>
                        <strong>{t('review_fast_badge', 'Fast review')}:</strong>{' '}
                        {result.modeCoverage
                            ? `${result.modeCoverage.checked}/${result.modeCoverage.total} `
                            : ''}
                        {t(
                            'review_fast_result_note',
                            'requirements checked by code. The others are marked N/A and need a full review.'
                        )}
                    </div>
                )}

                {/* overleaf-lab: compact counts summary */}
                <div
                    style={{
                        display: 'flex',
                        gap: 12,
                        flexWrap: 'wrap',
                        fontSize: '0.85em',
                        marginBottom: 8,
                    }}
                >
                    <span style={{ color: STATUS_STYLE.ok.color }}>
                        {t('status_ok', 'OK')}: {counts.ok || 0}
                    </span>
                    <span style={{ color: STATUS_STYLE.partial.color }}>
                        {t('status_partial', 'Partial')}: {counts.partial || 0}
                    </span>
                    <span style={{ color: STATUS_STYLE.missing.color }}>
                        {t('status_missing', 'Missing')}: {counts.missing || 0}
                    </span>
                    <span style={{ color: MUTED }}>
                        {t('status_na', 'N/A')}: {counts.na || 0}
                    </span>
                </div>

                {/* overleaf-lab: what changed since the previous review. Only shown
                    when the two runs used the same rubric and the same model: on a
                    different rubric the same requirement can mean something else, so
                    a diff would report edits to the rubric as changes to the thesis.
                    Requirements that were already met and still are stay out of the
                    way; only movement is worth the space. */}
                {/* overleaf-lab: when there is nothing to compare against, SAY SO.
                    Showing nothing at all made an absent comparison look identical to
                    a broken feature: a first review of a project, a review after the
                    rubric was edited and a review where genuinely nothing moved all
                    produced the same empty space. */}
                {result.delta && !result.delta.comparable && (
                    <div style={{ fontSize: '0.85em', marginBottom: 8, color: MUTED }}>
                        {result.delta.reason === 'rubric_changed'
                            ? t(
                                  'review_delta_rubric_changed',
                                  'No comparison with the previous review: the rubric has changed since then, so the same requirement may no longer mean the same thing.'
                              )
                            : result.delta.reason === 'mode_changed'
                              ? t(
                                    'review_delta_mode_changed',
                                    'No comparison with the previous review: the two were not run in the same mode, so they do not cover the same requirements.'
                                )
                              : result.delta.reason === 'model_changed'
                              ? t(
                                    'review_delta_model_changed',
                                    'No comparison with the previous review: it was run with a different model.'
                                )
                              : t(
                                    'review_delta_no_previous',
                                    'This is the first stored review of this project, so there is nothing to compare it with. The next one will show what changed.'
                                )}
                    </div>
                )}

                {result.delta?.comparable &&
                    (result.delta.resolved?.length || 0) === 0 &&
                    (result.delta.regressed?.length || 0) === 0 && (
                        <div style={{ fontSize: '0.85em', marginBottom: 8, color: MUTED }}>
                            {t(
                                'review_delta_unchanged',
                                'No verdict changed since the previous review.'
                            )}
                        </div>
                    )}

                {result.delta?.comparable &&
                    ((result.delta.resolved?.length || 0) > 0 ||
                        (result.delta.regressed?.length || 0) > 0) && (
                        <div
                            style={{
                                display: 'flex',
                                gap: 12,
                                flexWrap: 'wrap',
                                fontSize: '0.85em',
                                marginBottom: 8,
                            }}
                        >
                            <span style={{ color: MUTED }}>
                                {t('review_since_previous', 'Since the previous review:')}
                            </span>
                            {(result.delta.resolved?.length || 0) > 0 && (
                                <span
                                    style={{ color: STATUS_STYLE.ok.color }}
                                    title={result.delta.resolved
                                        ?.map(d => d.requirement)
                                        .join('\n')}
                                >
                                    {t('review_delta_resolved', 'resolved')}:{' '}
                                    {result.delta.resolved?.length}
                                </span>
                            )}
                            {(result.delta.regressed?.length || 0) > 0 && (
                                <span
                                    style={{ color: STATUS_STYLE.missing.color }}
                                    title={result.delta.regressed
                                        ?.map(d => d.requirement)
                                        .join('\n')}
                                >
                                    {t('review_delta_regressed', 'new problems')}:{' '}
                                    {result.delta.regressed?.length}
                                </span>
                            )}
                        </div>
                    )}

                {/* overleaf-lab: and the requirements this run could not compare at all.
                    A requirement that came back n.a. today is neither fixed nor new,
                    and leaving it out of the two counts above without a word turns a
                    partial failure of ours into apparent progress. */}
                {result.delta?.comparable &&
                    (facts.delta?.notRecheckedCount || 0) > 0 && (
                        <div style={{ fontSize: '0.85em', marginBottom: 8, color: MUTED }}>
                            {t(
                                'review_delta_not_rechecked',
                                'Requirements that could not be re-checked this run, counted as neither fixed nor new:'
                            )}{' '}
                            {facts.delta?.notRecheckedCount}
                        </div>
                    )}

                {/* Summary block (synthesized in a final pass; may be empty if that
                    best-effort call failed, in which case show nothing) */}
                {result.summary && (
                    <div
                        style={{
                            padding: 10,
                            borderRadius: 6,
                            // overleaf-lab: translucent grey (works on light and dark)
                            // instead of the fixed light --bg-light-secondary, which was
                            // a white box on the dark theme, and an adaptive text color.
                            background: 'rgba(125,125,125,0.14)',
                            color: 'var(--content-primary-themed)',
                            overflowWrap: 'anywhere',
                        }}
                    >
                        {result.summary}
                    </div>
                )}

                <div style={{ color: MUTED, fontSize: '0.85em', marginTop: 6 }}>
                    {/* overleaf-lab: the model and the prompt size are only there when
                        a prompt was built. A fast review records neither, and printing
                        "Model: null - ~null prompt tokens" under a page produced by
                        parsers would be both ugly and false. */}
                    {result.model && (
                        <>
                            {t('model_label', 'Model')}: {result.model} - ~
                            {result.documentTokensEstimate}{' '}
                            {t('prompt_tokens', 'prompt tokens')}
                        </>
                    )}
                    {!result.model && (
                        <>
                            {t('review_by_code', 'Checked by code, with no language model')}
                        </>
                    )}
                    {result.documentFiles && result.documentFiles.length > 0 && (
                        <>
                            {' - '}
                            <span
                                title={result.documentFiles.join('\n')}
                                style={{ textDecoration: 'underline dotted' }}
                            >
                                {result.documentFiles.length}{' '}
                                {t('files_read', 'files read')}
                            </span>
                        </>
                    )}
                </div>

                {/* overleaf-lab: a project file that exists but was not read makes
                    every requirement about its content unverified, so it is stated
                    up front rather than left for the reader to infer. */}
                {result.documentFilesSkipped &&
                    result.documentFilesSkipped.length > 0 && (
                        <div
                            style={{
                                marginTop: 6,
                                padding: '6px 8px',
                                borderLeft: `3px solid ${STATUS_STYLE.partial.color}`,
                                background: 'rgba(245,158,11,0.12)',
                                fontSize: '0.85em',
                                overflowWrap: 'anywhere',
                            }}
                        >
                            {t('review_files_skipped', 'Not reviewed')}:{' '}
                            {result.documentFilesSkipped
                                .map(f =>
                                    f.reason ? `${f.path} (${f.reason})` : f.path
                                )
                                .join(', ')}
                        </div>
                    )}

                {/* overleaf-lab: the measured-fact strip. One line per block, and one
                    pointer at the end: the panel says what was measured, the report
                    says what it measured. */}
                {factLines.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                        {factLines}
                        <div style={{ marginTop: 4, fontSize: '0.8em', color: MUTED }}>
                            {t(
                                'review_facts_see_report',
                                'See the downloaded report for details.'
                            )}
                        </div>
                    </div>
                )}

                {/* overleaf-lab: problems first, successes folded away. In rubric
                    order the few real findings are buried among twenty "ok" lines,
                    and the report is read to find what to fix. */}
                <div
                    style={{
                        marginTop: 8,
                        overflowY: 'auto',
                        overflowX: 'hidden',
                        minHeight: 0,
                        flex: 1,
                    }}
                >
                    {problems.map((item, idx) => (
                        <ComplianceReportItem
                            key={`p${idx}`}
                            item={item}
                            gotoSource={gotoSource}
                        />
                    ))}
                    {problems.length === 0 && (
                        <div style={{ color: MUTED, padding: '8px 0' }}>
                            {t(
                                'review_no_problems',
                                'No problems found: every requirement was met.'
                            )}
                        </div>
                    )}
                    {passed.length > 0 && (
                        <details style={{ marginTop: 8 }}>
                            <summary
                                style={{
                                    cursor: 'pointer',
                                    color: MUTED,
                                    fontSize: '0.9em',
                                    padding: '6px 0',
                                }}
                            >
                                {passed.length}{' '}
                                {t('requirements_met', 'requirements met')}
                            </summary>
                            {passed.map((item, idx) => (
                                <ComplianceReportItem
                                    key={`k${idx}`}
                                    item={item}
                                    gotoSource={gotoSource}
                                />
                            ))}
                        </details>
                    )}
                </div>
            </div>
        )
    }

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                flex: 1,
                padding: 12,
                overflow: 'hidden',
            }}
        >
            {/* Header row: rubric selector */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                    className="form-select"
                    value={selectedRubricId}
                    onChange={e => setSelectedRubricId(e.target.value)}
                    disabled={isActive}
                    aria-label={t('review_rubric', 'Review rubric')}
                    style={{ flex: 1, minWidth: 0 }}
                >
                    {rubrics.map(rubric => (
                        <option key={rubric.id} value={rubric.id}>
                            {rubric.name}
                        </option>
                    ))}
                </select>
            </div>

            {/* overleaf-lab: THE TWO REVIEWS, side by side, each with the one line
                that tells them apart.

                They are two buttons and not a dropdown next to one button because the
                choice is not a setting: it is which of two different pieces of work to
                ask for, and the cost of picking wrong is either twenty minutes of
                waiting or a report that quietly covered a third of the rubric. The
                explanations are permanent text rather than tooltips for the same
                reason - a tooltip is read once, by the person who was already
                wondering. */}
            {showRunButton && (
                <div style={{ marginTop: 8 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <OLButton
                            variant="primary"
                            type="button"
                            /* Wrapped, not passed by reference: React hands the click
                               event to the handler as its first argument, which would
                               arrive as `confirmed` and skip the document-type check on
                               every single run. */
                            onClick={() => runReview(false, 'full')}
                            disabled={!selectedRubricId || !fullReviewAvailable}
                        >
                            <MaterialIcon type="fact_check" />{' '}
                            {t('run_full_review', 'Full review')}
                        </OLButton>
                        <OLButton
                            variant="secondary"
                            type="button"
                            onClick={() => runReview(false, 'fast')}
                            disabled={!selectedRubricId}
                        >
                            <MaterialIcon type="code" />{' '}
                            {t('run_fast_review', 'Fast review')}
                        </OLButton>
                    </div>
                    <div style={{ marginTop: 6, fontSize: '0.8em', color: MUTED }}>
                        <div>
                            <strong>{t('run_full_review', 'Full review')}:</strong>{' '}
                            {t(
                                'review_full_explainer',
                                'Every requirement, including those that need the review model. Takes minutes.'
                            )}
                        </div>
                        <div style={{ marginTop: 2 }}>
                            <strong>{t('run_fast_review', 'Fast review')}:</strong>{' '}
                            {t(
                                'review_fast_explainer',
                                'Only the requirements verified by code, in seconds. No language model involved: the others come back as not checked.'
                            )}
                        </div>
                        {/* overleaf-lab: an instance with no model backend. Said HERE,
                            under the disabled button, and not as an error after the
                            click: a button that is enabled, pressed, and answers "not
                            configured" teaches people the feature is broken. */}
                        {!fullReviewAvailable && (
                            <div style={{ marginTop: 4 }}>
                                {t(
                                    'review_full_unavailable',
                                    'The full review is unavailable: this instance has no review model configured. The fast review does not need one.'
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* overleaf-lab: queued state - position note + cancel */}
            {phase === 'queued' && (
                <div style={{ marginTop: 12, color: MUTED }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <MaterialIcon type="schedule" />
                        <span>{t('review_queued', 'In queue')}</span>
                    </div>
                    {position > 0 && (
                        <div style={{ marginTop: 4, fontSize: '0.85em' }}>
                            {t('review_queue_position', 'Requests ahead of you:')}{' '}
                            {position}
                        </div>
                    )}
                    {renderWaitNote()}
                    <div style={{ marginTop: 8 }}>
                        <OLButton
                            variant="secondary"
                            type="button"
                            onClick={cancelReview}
                        >
                            <MaterialIcon type="close" /> {t('cancel', 'Cancel')}
                        </OLButton>
                    </div>
                </div>
            )}

            {/* overleaf-lab: running state - real pass-based progress + cancel.
                The review runs one model call per rubric requirement, so the bar
                moves on actual completions, not on a time estimate. */}
            {phase === 'running' && (
                <div style={{ marginTop: 12 }}>
                    <div
                        style={{
                            display: 'flex',
                            gap: 8,
                            alignItems: 'center',
                            color: MUTED,
                        }}
                    >
                        <MaterialIcon
                            type={
                                progress?.phase === 'summarizing'
                                    ? 'edit_note'
                                    : progress?.phase === 'checking'
                                      ? 'rule'
                                      : 'hourglass_empty'
                            }
                        />
                        <span>
                            {progress?.phase === 'summarizing'
                                ? t('review_summarizing', 'Writing the summary...')
                                : progress?.phase === 'checking'
                                  ? t('review_checking', 'Checking requirement') +
                                    ` ${Math.min(progress.passesDone + 1, progress.passesTotal)}/${progress.passesTotal}`
                                  : t(
                                        'review_preparing',
                                        'Preparing the document...'
                                    )}
                        </span>
                    </div>

                    {/* overleaf-lab: the requirement being checked right now */}
                    {progress?.phase === 'checking' && progress.currentRequirement && (
                        <div
                            style={{
                                marginTop: 4,
                                fontSize: '0.8em',
                                color: MUTED,
                                overflowWrap: 'anywhere',
                            }}
                            /* The label is cut to keep the pane compact; the full
                               text is one hover away. The MODEL always receives the
                               requirement whole: the cut is display only. */
                            title={progress.currentRequirement}
                        >
                            {progress.currentRequirement}
                        </div>
                    )}

                    {progress && progress.passesTotal > 0 && (
                        <>
                            <div
                                style={{
                                    marginTop: 8,
                                    height: 8,
                                    borderRadius: 4,
                                    background: 'rgba(125,125,125,0.2)',
                                    overflow: 'hidden',
                                }}
                            >
                                <div
                                    style={{
                                        height: '100%',
                                        width: `${Math.round(
                                            (progress.phase === 'summarizing'
                                                ? 0.97
                                                : progress.passesDone /
                                                  progress.passesTotal) * 100
                                        )}%`,
                                        background: 'var(--green-60, #198754)',
                                        transition: 'width 0.5s ease',
                                    }}
                                />
                            </div>
                            <div
                                style={{
                                    marginTop: 4,
                                    fontSize: '0.8em',
                                    color: MUTED,
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                }}
                            >
                                <span>{formatDuration(progress.elapsedMs)}</span>
                                {/* Same index as the "Checking requirement" label above:
                                    the pass being worked on, not the completed count,
                                    so the two numbers never disagree on screen. */}
                                <span>
                                    {Math.min(
                                        progress.passesDone + 1,
                                        progress.passesTotal
                                    )}
                                    /{progress.passesTotal}
                                </span>
                            </div>
                        </>
                    )}

                    {renderWaitNote()}

                    <div style={{ marginTop: 8 }}>
                        <OLButton
                            variant="secondary"
                            type="button"
                            onClick={cancelReview}
                        >
                            <MaterialIcon type="close" /> {t('cancel', 'Cancel')}
                        </OLButton>
                    </div>
                </div>
            )}

            {phase === 'error' && renderError()}
            {phase === 'done' && renderResult()}
        </div>
    )
}

export default LLMCompliancePane
