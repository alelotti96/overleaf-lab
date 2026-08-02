import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import getMeta from '@/utils/meta'
// overleaf-lab: THE EDITOR'S OWN "GO TO CODE" MACHINERY, borrowed rather than rebuilt.
//
// Double-clicking the PDF jumps to the matching source line; the review's findings carry
// a file and a line too, so they should land in the same place by the same route. That
// route is, verbatim from `use-synctex.ts` in the base image (v6.2.0-ext-v5.0):
//
//     const doc = findEntityByPath(file)?.entity
//     if (doc) openDocWithId(doc._id, { gotoLine: line, selectText })
//
// The RAW contexts are imported, not the `useEditorManagerContext()` / `useFileTreePathContext()`
// hooks that wrap them. Those two throw when their provider is missing, and this panel
// must never be the thing that takes the editor down: outside a provider `useContext`
// simply answers undefined, the hook below returns null, and every location in the pane
// stays the plain monospace chip it has always been. A dead button is a bug; text is not.
import { EditorManagerContext } from '@/features/ide-react/context/editor-manager-context'
import { FileTreePathContext } from '@/features/file-tree/contexts/file-tree-path'

// overleaf-lab: shapes for the document compliance review feature. The backend is
// now a job queue: start enqueues a review and returns a jobId, the client polls
// a status endpoint, and can cancel. Every endpoint always returns HTTP 200 and
// the body carries either a success payload (ok:true) or a logical error.

export interface ComplianceRubric {
    id: string
    name: string
}

export type ComplianceStatus = 'ok' | 'partial' | 'missing' | 'na'

// overleaf-lab: the two reviews this panel can start.
//
//   full  every requirement, the model-judged ones included. Queued on a backend,
//         minutes, one email at the end.
//   fast  only the requirements a program decides on its own. No queue, no model,
//         seconds. The rest come back n.a. with the reason, never as a verdict.
//
// It travels with the request, with the running job and with the finished report,
// because every one of those is somewhere a reader could otherwise mistake one for
// the other.
export type ReviewMode = 'full' | 'fast'

// overleaf-lab: the source lines behind a location, attached by the controller at
// completion from the documents the review already had in memory. Raw text: whoever
// renders it escapes it, and a string escaped twice is a string with `&amp;lt;` in it.
export interface SourceExcerpt {
    // Source line number of `lines[0]`.
    start: number
    // Index into `lines` of the line the finding is actually about.
    mark: number
    lines: string[]
    // True when a line was too long for the excerpt's character budget and was cut.
    clipped?: boolean
}

export interface ComplianceLocation {
    path: string
    line: number
    excerpt?: SourceExcerpt
}

export interface ComplianceItem {
    requirement: string
    status: ComplianceStatus
    evidence: string
    suggestion: string
    // overleaf-lab: exact file:line positions, DERIVED in code by searching the
    // item's quoted passages in the source, never written by the model (which
    // receives no line numbers and would have to invent them). A quote that cannot
    // be placed simply has no entry: the list is correct, not complete.
    locations?: ComplianceLocation[]
    // overleaf-lab: the files a scoped check actually read to reach this verdict.
    // Coarser than `locations` (no line), but available whenever the finding came
    // from a [per-file] or [per-chapter] pass even if no quote could be matched, so
    // the by-file view can place findings that grounding alone would have left loose.
    sourceFiles?: string[]
}

export interface ComplianceResult {
    ok: true
    rubric: ComplianceRubric
    // Null on a fast review: no model was involved, and naming one would be the
    // plainest untruth the report could carry.
    model: string | null
    // overleaf-lab: which review produced this, and how much of the rubric it covered.
    // Absent on every report archived before the two modes existed, which were all
    // full reviews: readers treat a missing mode as 'full'.
    mode?: ReviewMode
    modeCoverage?: { checked: number; total: number } | null
    // Null on a fast review for the same reason as `model`: no prompt was built, so
    // there is no prompt size to state.
    documentTokensEstimate: number | null
    maxContextTokens: number | null
    summary: string
    items: ComplianceItem[]
    // When the review finished, and how long it took. Kept in the report itself so a
    // printed or forwarded copy still says which run it is.
    completedAt?: string
    durationMs?: number
    // overleaf-lab: the files the review actually assembled and read. Shown in the
    // report so a run that saw less of the project than expected is visible instead
    // of being discovered later by comparing token counts.
    documentFiles?: string[]
    // Text-like project files that exist but could not be read (an externally linked
    // bibliography whose file store is unreachable, for example). Naming them keeps
    // a partial review from reading as a complete one, and the reason is carried
    // with them so diagnosing the gap does not require container logs.
    documentFilesSkipped?: { path: string; reason?: string }[]
    // overleaf-lab: files the project holds that nothing in the document includes.
    // Left out of the review on purpose, and named so that the narrower scope is
    // visible rather than looking like a gap.
    documentFilesNotIncluded?: string[]
    // overleaf-lab: what changed since the previous review of this project. Only
    // verdicts are compared, which needs no heuristics; comparable is false when the
    // rubric or the model changed in between, because the same requirement number
    // can then mean something else and the comparison would be misleading.
    delta?: ComplianceDelta | null
}

export interface ComplianceDelta {
    comparable: boolean
    // 'mode_changed': the previous review was not run in the same mode, so the two do
    // not cover the same requirements and comparing them would report every unchecked
    // requirement as one that got fixed.
    reason?: 'no_previous' | 'rubric_changed' | 'model_changed' | 'mode_changed'
    previousAt?: string
    resolved?: { requirement: string; from: string; to: string }[]
    regressed?: { requirement: string; from: string; to: string }[]
    stillOpenCount?: number
}

export type ComplianceErrorCode =
    | 'disabled'
    | 'busy'
    | 'no_rubric'
    | 'not_configured'
    | 'empty_document'
    | 'too_long'
    | 'type_mismatch'
    | 'model_unavailable'
    | 'not_found'
    | 'backend_error'
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

// overleaf-lab: live progress of a running review. The review is multi-pass (one
// model call per rubric requirement), so progress is REAL: passes completed over
// total, plus the requirement currently being checked. 'preparing' is the document
// assembly before the first pass, 'summarizing' the final small synthesis call.
export interface ReviewProgress {
    phase: 'preparing' | 'checking' | 'summarizing'
    passesDone: number
    passesTotal: number
    currentRequirement: string
    elapsedMs: number
}

// overleaf-lab: normalized error info the pane renders. The code lives in
// `errorCode` (from either the start body's `error` or the status body's
// `errorCode`), so the pane reads a single field.
export interface ComplianceErrorInfo {
    errorCode: ComplianceErrorCode | string
    message?: string
    documentTokensEstimate?: number
    maxContextTokens?: number
    // overleaf-lab: the room reserved for the answer. It is part of the sum that
    // caused a too_long refusal, so the UI must show it or the numbers look wrong.
    reviewMaxTokens?: number
    // overleaf-lab: type_mismatch only. What the rubric declares it is meant for, and
    // whether the model was sure it is the wrong kind of document or merely could not
    // tell: "this looks like something else" and "I cannot tell" deserve different
    // wording, or the user learns to click through both without reading.
    expectedDocument?: string
    certain?: boolean
}

interface RubricsResponse {
    rubrics?: ComplianceRubric[]
    // overleaf-lab: true when the instance has a mail transport configured, so the
    // panel can promise a notification only where one will really be sent.
    notifyByEmail?: boolean
    // overleaf-lab: false when no model backend is configured on this instance. The
    // full review then cannot run at all and the panel says so on the button instead
    // of letting it be clicked into an error; the fast one is unaffected, which is the
    // whole reason it exists for installs with no GPU.
    fullReviewAvailable?: boolean
}

// overleaf-lab: the standalone report renderer lives in shared/, because the
// store archives the same HTML at completion for the dashboard to serve: one
// renderer, two callers, no drift between what the student downloads and what
// the staff downloads a year later.
// @ts-ignore - plain ESM module shared with the backend, no type declarations
import { buildReportHtml, GOTO_PARAM, parseGotoParam } from '../../../shared/compliance-report-html.mjs'

// overleaf-lab: open a project file in the editor at a line, or say it cannot.
//
// Returns NULL, not a no-op function, when the editor is not reachable from wherever
// this is rendered. The difference is the whole point: a caller that gets null renders
// text, a caller that gets a function renders a control. Nothing in this module is ever
// allowed to draw a button that does nothing when clicked.
export type GotoSource = (path: string, line?: number) => boolean

// How long after a deep link lands we keep trying to place it. The file tree arrives
// over the websocket a moment after the page does, so the first attempt usually finds
// nothing; without a window this would either give up too early or retry for ever.
const GOTO_RETRY_WINDOW_MS = 20000

export function useGotoSource(): GotoSource | null {
    const editorManager = useContext(EditorManagerContext)
    const filePaths = useContext(FileTreePathContext)

    return useMemo(() => {
        const openDocWithId = editorManager?.openDocWithId
        const findEntityByPath = filePaths?.findEntityByPath
        if (!openDocWithId || !findEntityByPath) {
            return null
        }
        return (path: string, line?: number) => {
            // Never race the boot. While the editor is still opening its initial
            // document, a second openDocWithId and the boot's own open abort each
            // other (the manager guards opens with an epoch, and the loser surfaces
            // "something went wrong opening this document"). Saying "not yet" makes
            // the deep-link path below retry once loading settles, and makes a
            // manual click during boot a no-op, both of which are what a reader
            // arriving from a report link actually wants.
            if (editorManager.isLoading) {
                return false
            }
            // The review writes project paths with a leading slash; the file tree does
            // not carry one. Both spellings are tried, because an archived result may
            // have been written by an older run with a different convention.
            const raw = String(path || '')
            const clean = raw.replace(/^\/+/, '').replace(/^\.\//, '')
            if (!clean) {
                return false
            }
            const found = findEntityByPath(clean) || findEntityByPath(raw)
            // THE SECOND GATE. A path only opens something if the project actually has a
            // document at it; a folder is not something the editor can show, and a path
            // that is in no project at all resolves to nothing.
            if (!found || !found.entity?._id) {
                return false
            }
            // A fileRef is openable too, just not at a line: the file view has no
            // cursor. The case that makes this worth having is not an image, it is
            // the bibliography: a .bib kept fresh by an external tool arrives as an
            // uploaded FILE, the bibliography check quotes it with a line number,
            // and a chip that silently did nothing on exactly those findings broke
            // this module's promise that every drawn control does something.
            if (found.type !== 'doc') {
                const openFileWithId = editorManager?.openFileWithId
                if (found.type === 'fileRef' && openFileWithId) {
                    openFileWithId(found.entity._id)
                    return true
                }
                return false
            }
            const jump =
                typeof line === 'number' && Number.isInteger(line) && line > 0
                    ? { gotoLine: line }
                    : {}
            openDocWithId(found.entity._id, jump)
            return true
        }
    }, [editorManager, filePaths])
}

export const useLLMCompliance = () => {
    const projectId = getMeta('ol-project_id')

    const [rubrics, setRubrics] = useState<ComplianceRubric[]>([])
    const [rubricsLoaded, setRubricsLoaded] = useState(false)
    // overleaf-lab: default false, so a failed or old response never promises a mail.
    const [notifyByEmail, setNotifyByEmail] = useState(false)
    // overleaf-lab: default TRUE, unlike the flag above, and for the mirrored reason.
    // The failure this one guards is disabling a working button on a response that did
    // not arrive; the backend says `false` explicitly when there is no model backend,
    // and a missing field means an older backend that only ever had the full review.
    const [fullReviewAvailable, setFullReviewAvailable] = useState(true)
    // The mode of the run currently on screen (or the last one asked for), so the
    // panel can tell the reader which of the two it is watching.
    const [runningMode, setRunningMode] = useState<ReviewMode>('full')
    const [selectedRubricId, setSelectedRubricId] = useState('')
    const [phase, setPhase] = useState<CompliancePhase>('idle')
    const [position, setPosition] = useState(0)
    const [result, setResult] = useState<ComplianceResult | null>(null)
    const [errorInfo, setErrorInfo] = useState<ComplianceErrorInfo | null>(null)
    const [progress, setProgress] = useState<ReviewProgress | null>(null)
    // overleaf-lab: whether what is on screen came out of the archive rather than out
    // of a review that just ran, and when it was produced. The backend has always sent
    // storedAt and nothing read it, so a report recovered after a restart was
    // indistinguishable from one finished a second ago - which is how a student whose
    // review had FAILED could be shown a month-old report as the state of their
    // document. `stale` is set by the /latest archive fallback only.
    const [storedAt, setStoredAt] = useState<string | null>(null)
    const [resultIsStale, setResultIsStale] = useState(false)

    // overleaf-lab: refs so async callbacks and the unload handler always see the
    // current values without re-subscribing.
    const jobIdRef = useRef<string | null>(null)
    const phaseRef = useRef<CompliancePhase>('idle')
    const pollRef = useRef<number | null>(null)
    const mountedRef = useRef(true)
    // overleaf-lab: the rubric this project was last reviewed against, and the list
    // as loaded. Both in refs because the request that reports the first and the one
    // that loads the second race on mount, and whichever answers second has to be
    // able to see what the other already knew.
    const lastUsedRubricRef = useRef<string | null>(null)
    const rubricsRef = useRef<ComplianceRubric[]>([])
    const userChoseRubricRef = useRef(false)
    // The mode of the last run this page asked for. In a ref because "Run it anyway"
    // has to re-send it after a type-mismatch answer, and that callback must not
    // change identity every time a mode is picked.
    const lastModeRef = useRef<ReviewMode>('full')

    // overleaf-lab: keep the phase ref in sync for the beforeunload handler.
    useEffect(() => {
        phaseRef.current = phase
    }, [phase])

    // overleaf-lab: THE DEEP LINK ARRIVING. A location in the downloaded report links
    // back to `<project>?llmGoto=<path>:<line>`, which is what makes the report and the
    // editor one workflow instead of two windows and a scroll bar.
    //
    // The parameter is validated by the same file that wrote it (parseGotoParam: a
    // project-relative path and a positive integer, nothing else), then handed to the
    // file tree, which is what decides whether such a document exists. Nothing derived
    // from it is ever evaluated, fetched or written into markup.
    const gotoSource = useGotoSource()
    const [pendingGoto, setPendingGoto] = useState<{
        path: string
        line: number
    } | null>(null)
    const gotoDeadlineRef = useRef(0)

    useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const target = parseGotoParam(window.location.search)
        // The parameter comes out of the address bar WHATEVER it said, valid or not: a
        // reload must not jump again, a copied URL must not carry somebody else's
        // position, and a rejected value must not sit in the bar looking like it did
        // something. replaceState leaves no history entry to go back to.
        if (window.location.search.includes(`${GOTO_PARAM}=`)) {
            try {
                const url = new URL(window.location.href)
                url.searchParams.delete(GOTO_PARAM)
                window.history.replaceState(
                    window.history.state,
                    '',
                    `${url.pathname}${url.search}${url.hash}`
                )
            } catch (err) {
                console.error('[LLMCompliance] Could not clean the goto parameter:', err)
            }
        }
        if (!target) return undefined
        gotoDeadlineRef.current = Date.now() + GOTO_RETRY_WINDOW_MS
        setPendingGoto(target)
        // And a link to a file this project does not have stops being pending instead
        // of waiting for a file tree that will never contain it.
        const giveUp = window.setTimeout(
            () => setPendingGoto(null),
            GOTO_RETRY_WINDOW_MS
        )
        return () => window.clearTimeout(giveUp)
    }, [])

    // The file tree arrives after the page, so the first attempt usually finds nothing.
    // `gotoSource` changes identity when the tree does, which is what re-runs this.
    useEffect(() => {
        if (!pendingGoto) return
        if (Date.now() > gotoDeadlineRef.current) {
            setPendingGoto(null)
            return
        }
        if (gotoSource && gotoSource(pendingGoto.path, pendingGoto.line)) {
            setPendingGoto(null)
        }
    }, [pendingGoto, gotoSource])

    // overleaf-lab: tick the elapsed clock locally between the 2s status polls so it
    // moves smoothly; each poll re-syncs it from the server (authoritative). The bar
    // itself only moves on real pass completions reported by the server.
    useEffect(() => {
        if (phase !== 'running') return undefined
        const id = window.setInterval(() => {
            setProgress(prev =>
                prev ? { ...prev, elapsedMs: prev.elapsedMs + 1000 } : prev
            )
        }, 1000)
        return () => window.clearInterval(id)
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
                rubricsRef.current = loadedRubrics
                // The rubric this project was last reviewed against wins over the
                // first of the list, when it is still there. See the reattach effect:
                // the two requests race, and this is the branch where this one lands
                // second.
                const remembered = loadedRubrics.some(r => r.id === lastUsedRubricRef.current)
                    ? lastUsedRubricRef.current
                    : ''
                setSelectedRubricId(remembered || loadedRubrics[0]?.id || '')
                setNotifyByEmail(Boolean(data.notifyByEmail))
                setFullReviewAvailable(data.fullReviewAvailable !== false)
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

                // overleaf-lab: which review this poll is watching, taken from the
                // server rather than from what this page last clicked. They can
                // differ: a reload re-attaches to whatever was already running, and
                // that may have been started from another tab in the other mode.
                setRunningMode(
                    json.mode === 'fast' || json.result?.mode === 'fast' ? 'fast' : 'full'
                )

                switch (json.status) {
                    case 'queued':
                        setPhase('queued')
                        setPosition(typeof json.position === 'number' ? json.position : 0)
                        setProgress(null)
                        break
                    case 'running':
                        setPhase('running')
                        if (
                            typeof json.passesTotal === 'number' &&
                            json.passesTotal > 0
                        ) {
                            setProgress({
                                phase:
                                    json.phase === 'summarizing'
                                        ? 'summarizing'
                                        : 'checking',
                                passesDone:
                                    typeof json.passesDone === 'number'
                                        ? json.passesDone
                                        : 0,
                                passesTotal: json.passesTotal,
                                currentRequirement:
                                    typeof json.currentRequirement === 'string'
                                        ? json.currentRequirement
                                        : '',
                                elapsedMs:
                                    typeof json.elapsedMs === 'number' ? json.elapsedMs : 0,
                            })
                        } else {
                            // Still assembling the document: the rubric is not split yet.
                            setProgress({
                                phase: 'preparing',
                                passesDone: 0,
                                passesTotal: 0,
                                currentRequirement: '',
                                elapsedMs: 0,
                            })
                        }
                        break
                    case 'done':
                        stopPolling()
                        jobIdRef.current = null
                        setResult(json.result as ComplianceResult)
                        setErrorInfo(null)
                        setProgress(null)
                        // A report this poll watched being produced is current by
                        // construction: clear whatever the archive fallback had set.
                        setStoredAt(null)
                        setResultIsStale(false)
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
                            reviewMaxTokens: json.reviewMaxTokens,
                            expectedDocument: json.expectedDocument,
                            certain: json.certain,
                        })
                        setProgress(null)
                        setPhase('error')
                        break
                    case 'cancelled':
                        stopPolling()
                        jobIdRef.current = null
                        setProgress(null)
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

    // overleaf-lab: `confirmed` is passed only when the user has answered the
    // "is this really the right rubric for this document?" question. It is never
    // remembered across runs: the next review asks again, because the mistake it
    // guards against is precisely the one you make without thinking about it.
    //
    // `mode` IS remembered, and only for the length of that question. "Run it anyway"
    // is the same review the user asked for a moment ago, and defaulting it to full
    // there would answer a fast click with twenty minutes of GPU - which is the one
    // outcome somebody pressing the fast button is explicitly avoiding.
    const runReview = useCallback(async (confirmed = false, requestedMode?: ReviewMode) => {
        if (!selectedRubricId) return
        const mode: ReviewMode = requestedMode || lastModeRef.current
        lastModeRef.current = mode
        setRunningMode(mode)

        setResult(null)
        setErrorInfo(null)
        setPosition(0)
        setProgress(null)
        setStoredAt(null)
        setResultIsStale(false)

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
                    body: JSON.stringify({ rubricId: selectedRubricId, confirmed, mode }),
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
                // overleaf-lab: the enqueue-time type check answers with the same
                // fields as the in-job one; without them the "wrong kind of
                // document" dialog would lose its explanation and its certainty.
                setErrorInfo({
                    errorCode: json.error,
                    message: json.message,
                    expectedDocument: json.expectedDocument,
                    certain: json.certain,
                })
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
        setProgress(null)
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

    // overleaf-lab: re-attach on mount. Browsers reload discarded background tabs
    // (Chrome does it after ~30 min of inactivity), and a reloaded page has lost
    // its jobId, so a long review used to vanish; worse, an old beforeunload
    // handler CANCELLED the running job on the way out, so the reload killed the
    // work outright. That handler is gone (cancelling is now only the explicit
    // button; abandoned jobs finish server-side and expire with the TTL), and on
    // mount we adopt the project's latest job instead: resume polling if it is
    // still queued/running, show the report if it finished while we were away,
    // surface the error if it failed.
    useEffect(() => {
        if (!projectId) return undefined
        let cancelled = false

        async function reattach() {
            try {
                const response = await fetch(
                    `/project/${projectId}/llm/compliance/latest`,
                    { credentials: 'same-origin' }
                )
                const json = await response.json()
                if (cancelled || !mountedRef.current) return
                if (!json.ok) return
                // overleaf-lab: a record read back from the archive has no jobId,
                // because the review that produced it ended long ago and there is
                // nothing left to poll. That is true of a stored FAILURE as well as of
                // a stored report, and the failure is the one that must not be dropped
                // here: it is what stops an older report from being adopted in its
                // place. Everything else still requires a jobId.
                if (!json.jobId && json.status !== 'done' && !json.stale) return
                // overleaf-lab: reopen on the rubric this project was last reviewed
                // against. Recorded in a ref as well as in state because this request
                // and the one that loads the rubric list race on mount: whichever
                // lands second must not overwrite the choice with the first entry of
                // the list. Applied only if that rubric still exists, since an admin
                // can delete one between two visits.
                if (json.rubricId && !userChoseRubricRef.current) {
                    lastUsedRubricRef.current = json.rubricId
                    setSelectedRubricId(current => {
                        if (!rubricsRef.current.length) return current
                        return rubricsRef.current.some(r => r.id === json.rubricId)
                            ? json.rubricId
                            : current
                    })
                }
                // A review started by THIS mount takes precedence over adoption.
                if (phaseRef.current !== 'idle') return

                // Adopted with its mode, so the wait note and the badge describe the
                // review that is actually running and not the one this page defaults
                // to. Also seeds `lastModeRef`: after a reload, "Run it anyway" on an
                // adopted type-mismatch has to re-send the mode that hit it.
                const adoptedMode: ReviewMode =
                    json.mode === 'fast' || json.result?.mode === 'fast' ? 'fast' : 'full'
                lastModeRef.current = adoptedMode
                setRunningMode(adoptedMode)

                switch (json.status) {
                    case 'queued':
                    case 'running':
                        jobIdRef.current = json.jobId
                        setPhase(json.status === 'running' ? 'running' : 'queued')
                        startPolling(json.jobId)
                        pollOnce(json.jobId)
                        break
                    case 'done':
                        setResult(json.result as ComplianceResult)
                        setErrorInfo(null)
                        // overleaf-lab: adopted from the archive, so say when it was
                        // produced instead of presenting it as the current state.
                        setStoredAt(json.storedAt || null)
                        setResultIsStale(Boolean(json.stale))
                        setPhase('done')
                        break
                    case 'error':
                        setErrorInfo({
                            errorCode: json.errorCode,
                            message: json.message,
                            documentTokensEstimate: json.documentTokensEstimate,
                            maxContextTokens: json.maxContextTokens,
                            reviewMaxTokens: json.reviewMaxTokens,
                            expectedDocument: json.expectedDocument,
                            certain: json.certain,
                        })
                        // A failure recovered from the archive replaces whatever report
                        // was on screen: the last thing that happened to this project
                        // is that its review did not finish, and leaving the previous
                        // report visible is exactly the lie this field exists to stop.
                        setResult(null)
                        setStoredAt(json.storedAt || null)
                        setResultIsStale(Boolean(json.stale))
                        setPhase('error')
                        break
                    default:
                        // 'cancelled' or 'none': nothing to adopt.
                        break
                }
            } catch (err) {
                console.error('[LLMCompliance] Latest-job lookup failed:', err)
            }
        }

        reattach()
        return () => {
            cancelled = true
        }
    }, [projectId, pollOnce, startPolling])

    // overleaf-lab: build a self-contained HTML report and trigger a client-side
    // download. Open it in a browser and Print to PDF for a PDF copy.
    const downloadReport = useCallback(() => {
        if (!result) return

        const html = buildReportHtml(result)
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
        // overleaf-lab: the mode is in the FILE NAME of a fast report. Two reports of
        // the same rubric minutes apart end up in the same Downloads folder, and the
        // one that covered three requirements out of thirty must not be openable a
        // week later without that being the first thing its name says.
        const modeTag = result.mode === 'fast' ? 'fast-' : ''
        const filename = `review-${modeTag}${safeRubricName}-${stamp}.html`

        const blob = new Blob([html], {
            type: 'text/html;charset=utf-8',
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

    // overleaf-lab: choosing a different rubric retracts a pending "are you sure this
    // is the right kind of document?" answer. The question was asked ABOUT one rubric;
    // leaving the "Run it anyway" button on screen while the selection changes let a
    // user send confirmed:true for a rubric whose type check never ran, which is
    // precisely the mistake the check exists to catch.
    const chooseRubric = useCallback(
        (id: string) => {
            // An explicit choice outranks the remembered one. Without this, picking a
            // rubric in the first moments after opening the project was silently undone
            // when the "what did we last review this with" answer arrived.
            userChoseRubricRef.current = true
            lastUsedRubricRef.current = id
            setSelectedRubricId(id)
            if (errorInfo?.errorCode === 'type_mismatch') {
                setErrorInfo(null)
                setPhase('idle')
            }
        },
        [errorInfo]
    )

    return {
        rubrics,
        rubricsLoaded,
        hasRubrics: rubrics.length > 0,
        notifyByEmail,
        // overleaf-lab: false only when this instance has no model backend at all.
        // The panel disables the full button and says why; the fast one still runs.
        fullReviewAvailable,
        // Which of the two reviews is running, or produced what is on screen.
        runningMode,
        selectedRubricId,
        setSelectedRubricId: chooseRubric,
        phase,
        position,
        progress,
        result,
        // overleaf-lab: true when `result` was read back from the archive rather than
        // produced by a review this page watched run, with the time it was produced.
        // The panel needs both to be able to say "report of 3 July" instead of
        // presenting an old report as the current state of the document.
        resultIsStale,
        storedAt,
        errorInfo,
        runReview,
        cancelReview,
        downloadReport,
        // overleaf-lab: null wherever the editor is not reachable, so the pane can tell
        // "clickable" from "text" without guessing.
        gotoSource,
    }
}
