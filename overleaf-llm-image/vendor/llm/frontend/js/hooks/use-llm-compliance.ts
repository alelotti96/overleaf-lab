import { useCallback, useEffect, useRef, useState } from 'react'
import getMeta from '@/utils/meta'

// overleaf-lab: shapes for the document compliance review feature. The backend is
// now a job queue: start enqueues a review and returns a jobId, the client polls
// a status endpoint, and can cancel. Every endpoint always returns HTTP 200 and
// the body carries either a success payload (ok:true) or a logical error.

export interface ComplianceRubric {
    id: string
    name: string
}

export type ComplianceStatus = 'ok' | 'partial' | 'missing' | 'na'

export interface ComplianceItem {
    requirement: string
    status: ComplianceStatus
    evidence: string
    suggestion: string
}

export interface ComplianceResult {
    ok: true
    rubric: ComplianceRubric
    model: string
    documentTokensEstimate: number
    maxContextTokens: number
    summary: string
    items: ComplianceItem[]
}

export type ComplianceErrorCode =
    | 'disabled'
    | 'busy'
    | 'no_rubric'
    | 'not_configured'
    | 'empty_document'
    | 'too_long'
    | 'model_unavailable'
    | 'not_found'
    | 'failed'

// overleaf-lab: kept for callers that still reference the raw error shape.
export interface ComplianceError {
    ok: false
    error: ComplianceErrorCode
    message: string
    documentTokensEstimate?: number
    maxContextTokens?: number
}

// overleaf-lab: the phase drives the whole pane UI.
export type CompliancePhase = 'idle' | 'queued' | 'running' | 'done' | 'error'

// overleaf-lab: normalized error info the pane renders. The code lives in
// `errorCode` (from either the start body's `error` or the status body's
// `errorCode`), so the pane reads a single field.
export interface ComplianceErrorInfo {
    errorCode: ComplianceErrorCode | string
    message?: string
    documentTokensEstimate?: number
    maxContextTokens?: number
}

interface RubricsResponse {
    rubrics?: ComplianceRubric[]
}

// overleaf-lab: build a plain, readable Markdown report from a finished result.
function buildReportMarkdown(result: ComplianceResult): string {
    const counts: Record<ComplianceStatus, number> = {
        ok: 0,
        partial: 0,
        missing: 0,
        na: 0,
    }
    for (const item of result.items) {
        counts[item.status] = (counts[item.status] || 0) + 1
    }

    const statusLabel: Record<ComplianceStatus, string> = {
        ok: 'OK',
        partial: 'Partial',
        missing: 'Missing',
        na: 'N/A',
    }

    const lines: string[] = []
    lines.push(`# Compliance review - ${result.rubric.name}`)
    lines.push('')
    lines.push(`Model: ${result.model}`)
    lines.push(
        `Estimated document tokens: ~${result.documentTokensEstimate} / ${result.maxContextTokens}`
    )
    lines.push('')
    lines.push('## Summary')
    lines.push('')
    lines.push(result.summary || '')
    lines.push('')
    lines.push(
        `Counts: OK ${counts.ok || 0}, Partial ${counts.partial || 0}, Missing ${
            counts.missing || 0
        }, N/A ${counts.na || 0}`
    )
    lines.push('')
    lines.push('## Requirements')
    lines.push('')
    result.items.forEach((item, idx) => {
        lines.push(
            `### ${idx + 1}. [${statusLabel[item.status] || 'N/A'}] ${item.requirement}`
        )
        lines.push('')
        if (item.evidence) {
            lines.push(`- Evidence: ${item.evidence}`)
        }
        if (item.suggestion) {
            lines.push(`- Suggestion: ${item.suggestion}`)
        }
        lines.push('')
    })

    return lines.join('\n')
}

export const useLLMCompliance = () => {
    const projectId = getMeta('ol-project_id')

    const [rubrics, setRubrics] = useState<ComplianceRubric[]>([])
    const [rubricsLoaded, setRubricsLoaded] = useState(false)
    const [selectedRubricId, setSelectedRubricId] = useState('')
    const [phase, setPhase] = useState<CompliancePhase>('idle')
    const [position, setPosition] = useState(0)
    const [result, setResult] = useState<ComplianceResult | null>(null)
    const [errorInfo, setErrorInfo] = useState<ComplianceErrorInfo | null>(null)

    // overleaf-lab: refs so async callbacks and the unload handler always see the
    // current values without re-subscribing.
    const jobIdRef = useRef<string | null>(null)
    const phaseRef = useRef<CompliancePhase>('idle')
    const pollRef = useRef<number | null>(null)
    const mountedRef = useRef(true)

    // overleaf-lab: keep the phase ref in sync for the beforeunload handler.
    useEffect(() => {
        phaseRef.current = phase
    }, [phase])

    const stopPolling = useCallback(() => {
        if (pollRef.current != null) {
            clearInterval(pollRef.current)
            pollRef.current = null
        }
    }, [])

    // overleaf-lab: mount/unmount bookkeeping. On unmount we only stop polling; we
    // do NOT cancel the job, since the pane may just be hidden by a tab switch.
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            stopPolling()
        }
    }, [stopPolling])

    // overleaf-lab: load the admin-defined rubrics once on mount. On any failure
    // we still mark the list as loaded (with an empty array) so the pane can show
    // the "no rubrics configured" message instead of spinning forever.
    useEffect(() => {
        let cancelled = false

        async function fetchRubrics() {
            if (!projectId) {
                setRubrics([])
                setRubricsLoaded(true)
                return
            }
            try {
                const response = await fetch(
                    `/project/${projectId}/llm/compliance/rubrics`,
                    { credentials: 'same-origin' }
                )
                if (!response.ok) {
                    throw new Error(
                        `[LLMCompliance] Rubrics endpoint returned ${response.status}`
                    )
                }
                const data: RubricsResponse = await response.json()
                if (cancelled) return

                const loadedRubrics = data.rubrics || []
                setRubrics(loadedRubrics)
                setSelectedRubricId(loadedRubrics[0]?.id || '')
                setRubricsLoaded(true)
            } catch (err) {
                console.error('[LLMCompliance] Failed to fetch rubrics:', err)
                if (cancelled) return
                setRubrics([])
                setRubricsLoaded(true)
            }
        }

        fetchRubrics()

        return () => {
            cancelled = true
        }
    }, [projectId])

    // overleaf-lab: one poll tick. Updates phase/position/result/errorInfo and
    // stops polling on any terminal state (done/error/cancelled/not_found).
    const pollOnce = useCallback(
        async (jobId: string) => {
            try {
                const response = await fetch(
                    `/project/${projectId}/llm/compliance/status/${jobId}`,
                    { credentials: 'same-origin' }
                )
                const json = await response.json()
                if (!mountedRef.current) return

                if (!json.ok) {
                    // Missing, foreign, or expired job.
                    stopPolling()
                    jobIdRef.current = null
                    setErrorInfo({
                        errorCode: 'not_found',
                        message: json.message || 'Review not found or expired',
                    })
                    setPhase('error')
                    return
                }

                switch (json.status) {
                    case 'queued':
                        setPhase('queued')
                        setPosition(typeof json.position === 'number' ? json.position : 0)
                        break
                    case 'running':
                        setPhase('running')
                        break
                    case 'done':
                        stopPolling()
                        jobIdRef.current = null
                        setResult(json.result as ComplianceResult)
                        setErrorInfo(null)
                        setPhase('done')
                        break
                    case 'error':
                        stopPolling()
                        jobIdRef.current = null
                        setErrorInfo({
                            errorCode: json.errorCode,
                            message: json.message,
                            documentTokensEstimate: json.documentTokensEstimate,
                            maxContextTokens: json.maxContextTokens,
                        })
                        setPhase('error')
                        break
                    case 'cancelled':
                        stopPolling()
                        jobIdRef.current = null
                        setPhase('idle')
                        break
                    default:
                        break
                }
            } catch (err) {
                // overleaf-lab: a transient network error should not kill the poll;
                // keep the interval and try again on the next tick.
                console.error('[LLMCompliance] Status poll failed:', err)
            }
        },
        [projectId, stopPolling]
    )

    const startPolling = useCallback(
        (jobId: string) => {
            stopPolling()
            pollRef.current = window.setInterval(() => {
                pollOnce(jobId)
            }, 2000)
        },
        [pollOnce, stopPolling]
    )

    const runReview = useCallback(async () => {
        if (!selectedRubricId) return

        setResult(null)
        setErrorInfo(null)
        setPosition(0)

        try {
            const csrfToken = getMeta('ol-csrfToken')
            const response = await fetch(
                `/project/${projectId}/llm/compliance/start`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken,
                    },
                    credentials: 'same-origin',
                    body: JSON.stringify({ rubricId: selectedRubricId }),
                }
            )

            const json = await response.json()
            if (!mountedRef.current) return

            if (json.ok) {
                jobIdRef.current = json.jobId
                const startPhase: CompliancePhase =
                    json.status === 'running' ? 'running' : 'queued'
                setPhase(startPhase)
                setPosition(typeof json.position === 'number' ? json.position : 0)
                startPolling(json.jobId)
            } else {
                setErrorInfo({ errorCode: json.error, message: json.message })
                setPhase('error')
            }
        } catch (err) {
            console.error('[LLMCompliance] Start review request failed:', err)
            if (!mountedRef.current) return
            setErrorInfo({ errorCode: 'failed', message: 'Request failed' })
            setPhase('error')
        }
    }, [projectId, selectedRubricId, startPolling])

    const cancelReview = useCallback(async () => {
        const jobId = jobIdRef.current
        stopPolling()
        setPhase('idle')
        setPosition(0)
        jobIdRef.current = null
        if (!jobId) return

        try {
            const csrfToken = getMeta('ol-csrfToken')
            await fetch(`/project/${projectId}/llm/compliance/cancel/${jobId}`, {
                method: 'POST',
                headers: { 'X-CSRF-Token': csrfToken },
                credentials: 'same-origin',
            })
        } catch (err) {
            console.error('[LLMCompliance] Cancel request failed:', err)
        }
    }, [projectId, stopPolling])

    // overleaf-lab: best-effort cancel on page refresh/close. keepalive lets the
    // request survive the unload. Only fire when a job is actually active. We do
    // NOT cancel on a normal unmount (a tab switch just hides the pane).
    useEffect(() => {
        const handler = () => {
            const jobId = jobIdRef.current
            const currentPhase = phaseRef.current
            if (
                jobId &&
                (currentPhase === 'queued' || currentPhase === 'running')
            ) {
                const csrfToken = getMeta('ol-csrfToken')
                fetch(`/project/${projectId}/llm/compliance/cancel/${jobId}`, {
                    method: 'POST',
                    keepalive: true,
                    credentials: 'same-origin',
                    headers: { 'X-CSRF-Token': csrfToken },
                })
            }
        }

        window.addEventListener('beforeunload', handler)
        return () => {
            window.removeEventListener('beforeunload', handler)
        }
    }, [projectId])

    // overleaf-lab: build a Markdown report and trigger a client-side download.
    const downloadReport = useCallback(() => {
        if (!result) return

        const markdown = buildReportMarkdown(result)
        const safeRubricName =
            (result.rubric?.name || 'review')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'review'

        const now = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
            now.getDate()
        )}-${pad(now.getHours())}${pad(now.getMinutes())}`
        const filename = `review-${safeRubricName}-${stamp}.md`

        const blob = new Blob([markdown], {
            type: 'text/markdown;charset=utf-8',
        })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        URL.revokeObjectURL(url)
    }, [result])

    return {
        rubrics,
        rubricsLoaded,
        hasRubrics: rubrics.length > 0,
        selectedRubricId,
        setSelectedRubricId,
        phase,
        position,
        result,
        errorInfo,
        runReview,
        cancelReview,
        downloadReport,
    }
}
