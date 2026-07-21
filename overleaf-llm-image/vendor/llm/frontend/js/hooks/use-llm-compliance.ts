import { useCallback, useEffect, useState } from 'react'
import getMeta from '@/utils/meta'

// overleaf-lab: shapes for the document compliance review feature. The backend
// contract is fixed: the review endpoint always returns HTTP 200 and the body
// is either a success payload (ok:true) or a logical error (ok:false).

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
    | 'failed'

export interface ComplianceError {
    ok: false
    error: ComplianceErrorCode
    message: string
    documentTokensEstimate?: number
    maxContextTokens?: number
}

interface RubricsResponse {
    rubrics?: ComplianceRubric[]
}

export const useLLMCompliance = () => {
    const projectId = getMeta('ol-project_id')

    const [rubrics, setRubrics] = useState<ComplianceRubric[]>([])
    const [rubricsLoaded, setRubricsLoaded] = useState(false)
    const [selectedRubricId, setSelectedRubricId] = useState('')
    const [isRunning, setIsRunning] = useState(false)
    const [result, setResult] = useState<ComplianceResult | null>(null)
    const [errorInfo, setErrorInfo] = useState<ComplianceError | null>(null)

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

    const runReview = useCallback(async () => {
        if (!selectedRubricId) return

        setIsRunning(true)
        setResult(null)
        setErrorInfo(null)

        try {
            const csrfToken = getMeta('ol-csrfToken')
            const response = await fetch(`/project/${projectId}/llm/compliance`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken,
                },
                credentials: 'same-origin',
                body: JSON.stringify({ rubricId: selectedRubricId }),
            })

            // overleaf-lab: the endpoint always answers 200; success vs logical
            // error is distinguished by the `ok` field in the JSON body.
            const json = await response.json()
            if (json.ok) {
                setResult(json as ComplianceResult)
            } else {
                setErrorInfo(json as ComplianceError)
            }
        } catch (err) {
            console.error('[LLMCompliance] Review request failed:', err)
            setErrorInfo({ ok: false, error: 'failed', message: 'Request failed' })
        } finally {
            setIsRunning(false)
        }
    }, [projectId, selectedRubricId])

    return {
        rubrics,
        rubricsLoaded,
        selectedRubricId,
        setSelectedRubricId,
        isRunning,
        result,
        errorInfo,
        runReview,
        hasRubrics: rubrics.length > 0,
    }
}
