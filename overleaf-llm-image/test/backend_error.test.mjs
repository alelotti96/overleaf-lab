// Extract the REAL firstNumber/parseBackendError source from the controller and
// exercise it against realistic backend error payloads.
import fs from 'node:fs'

const file = process.env.CTRL
const src = fs.readFileSync(file, 'utf8')

const start = src.indexOf('// overleaf-lab: first regex that matches wins')
const end = src.indexOf('// overleaf-lab: extract a JSON object from a model reply')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the helper functions in the source')
    process.exit(1)
}
const snippet = src.slice(start, end)

// eslint-disable-next-line no-new-func
const parseBackendError = new Function(`${snippet}; return parseBackendError`)()

let ok = true
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected)
    if (!pass) ok = false
    console.log(`[${name}] ${pass ? 'PASS' : 'FAIL'}  got=${JSON.stringify(actual)}`)
    if (!pass) console.log(`         want=${JSON.stringify(expected)}`)
}

// 1) llama.cpp context overflow (the efesto case)
const llama = JSON.stringify({
    error: {
        code: 400,
        message:
            'the request exceeds the available context size. try increasing the context size or enable context shift: n_ctx = 32768, n_keep = 0, n_prompt_tokens = 47676',
        type: 'exceed_context_size_error',
    },
})
let r = parseBackendError(llama)
check('llama.cpp overflow', [r.isContext, r.promptTokens, r.contextTokens], [true, 47676, 32768])

// 2) OpenAI style context overflow
const openai = JSON.stringify({
    error: {
        message:
            "This model's maximum context length is 8192 tokens, however you requested 47676 tokens (47000 in the messages, 676 in the completion).",
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
    },
})
r = parseBackendError(openai)
check('openai overflow', [r.isContext, r.promptTokens, r.contextTokens], [true, 47676, 8192])

// 3) a non-context 400 must NOT be misreported as too_long
const other = JSON.stringify({
    error: { message: 'Unsupported parameter: response_format', type: 'invalid_request_error' },
})
r = parseBackendError(other)
check('non-context 400', [r.isContext, r.message], [false, 'Unsupported parameter: response_format'])

// 4) non-JSON body must degrade gracefully
r = parseBackendError('Internal Server Error')
check('non-JSON body', [r.isContext, r.message], [false, 'Internal Server Error'])

// 5) empty body must not throw
r = parseBackendError('')
check('empty body', [r.isContext, r.message], [false, ''])

// ===========================================================================
// the outage breaker
// ===========================================================================
// A backend that is DOWN used to produce a report, not an error: every model call
// threw 'fetch failed' instantly, each per-pass catch turned it into an n.a. item,
// and 57 passes "completed" in two seconds. The breaker has to stop that run, and
// must not stop a run that merely hits a bad pass now and then.
const bStart = src.indexOf('// overleaf-lab: circuit breaker on a backend that is GONE.')
const bEnd = src.indexOf('// overleaf-lab: run the actual review work for one job.')
if (bStart === -1 || bEnd === -1 || bEnd <= bStart) {
    console.error('FAIL: could not locate the outage breaker in the source')
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const breaker = new Function(
    `${src.slice(bStart, bEnd)}; return { makeReviewFetch, stopsTheReview, BackendOutageError, BACKEND_OUTAGE_LIMIT }`
)()

const netError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

// The per-pass loop of the real review, in miniature: one model call per pass, and a
// catch that degrades this requirement to n.a. and carries on - which is the exact
// behaviour the breaker has to pierce.
async function fakeReview(passes, respond) {
    let calls = 0
    const items = []
    const outcomes = []
    const reviewFetch = breaker.makeReviewFetch(o => outcomes.push(o), async () => {
        calls += 1
        return respond(calls)
    })
    try {
        for (let i = 0; i < passes; i++) {
            try {
                const response = await reviewFetch('http://backend/v1/chat/completions', {})
                items.push(response.ok ? 'ok' : 'na')
            } catch (err) {
                if (breaker.stopsTheReview(err)) throw err
                items.push('na')
            }
        }
    } catch (err) {
        if (!(err instanceof breaker.BackendOutageError)) throw err
        return { errorCode: 'backend_error', failures: err.failures, calls, items }
    }
    return { errorCode: null, calls, items }
}

const always = () => {
    throw netError()
}
let run = await fakeReview(57, always)
check(
    'a dead backend fails the review instead of filling it with n.a.',
    [run.errorCode, run.calls, run.failures, run.items.length],
    ['backend_error', 8, 8, 7]
)

// Scattered failures are what per-item degradation is FOR: the review completes and
// says which requirements could not be checked.
run = await fakeReview(20, n => {
    if (n % 2 === 1) throw netError()
    return { ok: true }
})
check(
    'scattered failures still complete the review',
    [run.errorCode, run.items.length, run.items.filter(s => s === 'na').length],
    [null, 20, 10]
)

// A backend that ANSWERS is alive, whatever it answers: an HTTP error is a bad pass,
// not an outage, and it already reports itself with its status code.
run = await fakeReview(20, () => ({ ok: false, status: 500 }))
check('HTTP errors never trip the breaker', [run.errorCode, run.items.length], [null, 20])

// An abort is our own pass timeout or the user's cancel; counting it would blame the
// backend for a review we stopped ourselves.
run = await fakeReview(20, () => {
    throw abortError()
}).catch(err => ({ errorCode: `threw:${err.name}` }))
check('aborts never trip the breaker', run.errorCode, 'threw:AbortError')

// The backup-model failover switches after 2 consecutive failures, so the backup has
// to be able to clear the count: its first successful call does.
run = await fakeReview(30, n => {
    if (n === 5) return { ok: true }
    throw netError()
})
check(
    'a working backup model resets the count',
    [run.errorCode, run.calls, run.failures],
    ['backend_error', 13, 8]
)
check('the limit is the documented one', breaker.BACKEND_OUTAGE_LIMIT, 8)

// ===========================================================================
// what SURVIVES a review: the job lifecycle across a restart
// ===========================================================================
// The queue lives in memory; the store is what carries a review across the nightly
// `docker stop`. Two asymmetries in processQueue's finally used to make that carrying
// wrong in both directions - a finished review coming back, and a failed one leaving no
// trace at all - and neither is visible from inside a single process run, which is why
// they are pinned here.
function truthy(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// The slice starts at the endpoint pool and not at processQueue: the single-flight
// `running` flag the harness used to declare for itself is gone, and the slot
// bookkeeping it was replaced by (which endpoint is busy, which one is in its outage
// cooldown, which one the next job gets) lives in the functions just above the queue.
// Taking both means the harness drives the shipped dispatch decision and not a
// reconstruction of it.
const qStart = src.indexOf('// THE ENDPOINT POOL')
const qEnd = src.indexOf('async function getRubrics(')
// The pool on its own, for the harnesses that want the endpoint bookkeeping without
// the queue and its dependencies.
const qEnd2 = src.indexOf('async function processQueue()')
if (qStart === -1 || qEnd === -1 || qEnd2 === -1 || qEnd <= qStart || qEnd2 <= qStart) {
    console.error('FAIL: could not locate the endpoint pool and processQueue in the source')
    process.exit(1)
}

// The real processQueue with its free variables injected. The endpoint pool comes with
// the slice, so the harness runs the shipped default: no configured pool, one legacy
// entry, one review at a time - the behaviour these assertions were written against.
function queueHarness({ outcome, throws = null }) {
    const events = []
    const jobs = new Map()
    const queue = []
    const job = {
        id: 'job-1',
        projectId: 'p1',
        userId: 'u1',
        status: 'queued',
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        result: null,
        controller: null,
    }
    jobs.set(job.id, job)
    queue.push(job.id)
    // Every store call resolves on a LATER turn, which is what a Mongo round trip is.
    // A call that is not awaited therefore shows up as an event that never happened
    // before processQueue's promise settled.
    const later = (label, value) =>
        new Promise(resolve =>
            setTimeout(() => {
                events.push(label)
                resolve(value)
            }, 0)
        )
    const ComplianceStore = {
        markJobStatusQuietly: () => later('markJobStatus'),
        saveReportQuietly: () => later('saveReport', null),
        saveFailureQuietly: j => later(`saveFailure:${j.errorCode}`),
        forgetJobQuietly: () => later('forgetJob'),
    }
    const ComplianceMailer = {
        notifyReviewFinishedQuietly: j => {
            events.push(`mail:${j.status}`)
        },
    }
    // eslint-disable-next-line no-new-func
    const processQueue = new Function(
        'jobs',
        'queue',
        'busyEndpoints',
        'ComplianceStore',
        'ComplianceMailer',
        'logger',
        'performReview',
        'fetchWithLimit',
        `${src.slice(qStart, qEnd)}; return processQueue`
    )(
        jobs,
        queue,
        new Map(),
        ComplianceStore,
        ComplianceMailer,
        { debug() {}, warn() {}, info() {}, error() {} },
        async () => {
            if (throws) throw throws
            return outcome
        },
        // Never called with one endpoint configured: the pickup probe is pool-only,
        // and a call here would mean the single-backend path has grown a round trip in
        // front of every review it never used to pay for.
        async () => {
            throw new Error('the single-endpoint dispatch must not probe the backend')
        }
    )
    return { processQueue, job, events }
}

{
    const h = queueHarness({ outcome: { type: 'done', result: {} } })
    await h.processQueue()
    // THE defect: forgetJobQuietly was fire-and-forget while saveReportQuietly was
    // awaited, so processQueue resolved with the "this job is no longer owed" delete
    // still in flight. A `docker stop` landing in that window left a job document at
    // status 'running' whose report was already archived, and the next boot re-ran the
    // whole review on the GPU and sent a second "Review finished" mail. The unique
    // jobId index refused the second REPORT, which is exactly why the duplication was
    // invisible in the data.
    truthy(
        'the job is forgotten in the store BEFORE the review is declared over',
        h.events.includes('forgetJob'),
        JSON.stringify(h.events)
    )
    truthy('the report is archived first', h.events.indexOf('saveReport') < h.events.indexOf('forgetJob'), JSON.stringify(h.events))
    truthy('a successful review archives no failure record', !h.events.some(e => e.startsWith('saveFailure')), JSON.stringify(h.events))
    truthy('and the user is told', h.events.includes('mail:done'), JSON.stringify(h.events))
}

{
    const h = queueHarness({ outcome: { type: 'error', errorCode: 'backend_error', message: 'gone' } })
    await h.processQueue()
    // A failed review used to be persisted NOWHERE: the error branch wrote errorCode
    // onto the in-memory job and the finally then deleted the job document. Once the
    // TTL sweep or a restart removed the job, /latest fell through to the archive and
    // answered with the PREVIOUS report under status 'done' - a student whose review
    // failed at 02:00 was shown a month-old report as the state of their document.
    truthy(
        'a failed review is archived with its error code',
        h.events.includes('saveFailure:backend_error'),
        JSON.stringify(h.events)
    )
    truthy(
        'and only then is the job forgotten',
        h.events.indexOf('saveFailure:backend_error') < h.events.indexOf('forgetJob'),
        JSON.stringify(h.events)
    )
    truthy('no report is archived for it', !h.events.includes('saveReport'), JSON.stringify(h.events))
    truthy('the failure mail is sent', h.events.includes('mail:error'), JSON.stringify(h.events))
}

{
    const h = queueHarness({ throws: new Error('docstore exploded') })
    await h.processQueue()
    truthy('a thrown review is archived too', h.events.includes('saveFailure:failed'), JSON.stringify(h.events))
    truthy('with the job marked error', h.job.status === 'error' && h.job.errorCode === 'failed', h.job.status)
}

{
    const h = queueHarness({ outcome: { type: 'done', result: {} } })
    h.job.status = 'cancelled'
    await h.processQueue()
    // A cancelled job is not a failure: archiving one would put a "your review did not
    // finish" record in front of a user who stopped it themselves.
    truthy('a cancelled review archives no failure', !h.events.some(e => e.startsWith('saveFailure')), JSON.stringify(h.events))
}

// ===========================================================================
// the resume at boot must not spend the retry budget on a cold backend
// ===========================================================================
// Reviews are resumed because a container restart interrupted them, and at that moment
// the GPU backend is very often still loading its model. A cold backend fails in about
// two seconds, and a terminal job is forgotten in the store, so the resumed review died
// instantly and attempts 2 and 3 were never used: MAX_ATTEMPTS exists for this exact
// failure and could not be spent on it.
{
    const bStart2 = src.indexOf('async function backendAnswers()')
    const rStart = src.indexOf('async function resumeInterruptedJobs()')
    const rEnd = src.indexOf('\nresumeInterruptedJobs().catch(')
    if (bStart2 === -1 || rStart === -1 || rEnd === -1) {
        console.error('FAIL: could not locate the resume path in the source')
        process.exit(1)
    }

    // backendAnswers on its own: "answering" means answering at all, which is the rule
    // the outage breaker uses. A 500 is a backend that is up.
    //
    // The pool slice is prepended because the boot probe now asks the ENDPOINTS rather
    // than one URL: with several backends the resumed reviews must start as soon as one
    // of them is up, or the slowest machine to load its model holds every interrupted
    // review behind it and, if it never comes back, leaves them for the next boot.
    const probe = (settings, fetchImpl) =>
        // eslint-disable-next-line no-new-func
        new Function(
            'getAdminLLMSettings',
            'fetchWithLimit',
            'logger',
            'busyEndpoints',
            `${src.slice(qStart, qEnd2)}
             ${src.slice(bStart2, src.indexOf('// The reviews being resumed'))}; return backendAnswers`
        )(async () => settings, fetchImpl, { debug() {}, warn() {}, info() {}, error() {} }, new Map())()

    truthy('a backend that answers 500 is up', (await probe({ llmApiUrl: 'http://b' }, async () => ({ ok: false, status: 500 }))) === true)
    truthy(
        'a backend that refuses the socket is down',
        (await probe({ llmApiUrl: 'http://b' }, async () => {
            throw netError()
        })) === false
    )
    truthy('no configured URL is down', (await probe({}, async () => ({ ok: true }))) === false)

    // resumeInterruptedJobs with the probe injected, so the real 16-minute schedule
    // does not have to run inside a test.
    const resumeHarness = reachable => {
        const claimed = []
        const jobs = new Map()
        const queue = []
        // eslint-disable-next-line no-new-func
        const resume = new Function(
            'jobs',
            'queue',
            'ComplianceStore',
            'logger',
            'processQueue',
            'waitForBackend',
            `${src.slice(rStart, rEnd)}; return resumeInterruptedJobs`
        )(
            jobs,
            queue,
            {
                claimInterruptedJobs: async () => {
                    claimed.push('claim')
                    return [{ jobId: 'j-1', projectId: 'p1', userId: 'u1', rubricId: 'r1' }]
                },
            },
            { debug() {}, warn() {}, info() {}, error() {} },
            () => {},
            async () => reachable
        )
        return { resume, claimed, jobs, queue }
    }

    const cold = resumeHarness(false)
    await cold.resume()
    truthy('a backend that never answers claims nothing', cold.claimed.length === 0, JSON.stringify(cold.claimed))
    truthy('so no attempt is consumed and nothing is queued', cold.queue.length === 0 && cold.jobs.size === 0)

    const warm = resumeHarness(true)
    await warm.resume()
    truthy('once the backend answers the interrupted review is claimed', warm.claimed.length === 1)
    truthy('and queued', warm.queue.length === 1 && warm.jobs.has('j-1'), JSON.stringify(warm.queue))
}

// ===========================================================================
// the enqueue-time and the run-time document-type checks read the SAME sources
// ===========================================================================
// They did not: enqueue tested the pattern against getAllDocs alone, the run against
// the pruned, acknowledgement-stripped documents. A title page in a file the main
// document no longer \inputs passed on the click and was refused an hour later, after
// the user had waited out the queue; and a marker in an UPLOADED .tex was invisible at
// enqueue and refused a project the review would have accepted.
{
    const sStart = src.indexOf('async function readProjectSources(')
    const sEnd = src.indexOf('// overleaf-lab: a wall-clock bound')
    if (sStart === -1 || sEnd === -1) {
        console.error('FAIL: could not locate readProjectSources in the source')
        process.exit(1)
    }
    // eslint-disable-next-line no-new-func
    const sources = new Function(
        'ProjectEntityHandler',
        'readTextualProjectFiles',
        'stripLatexComments',
        `${src.slice(sStart, sEnd)}; return { readProjectSources, typeCheckSources }`
    )(
        {
            promises: {
                getAllDocs: async () => ({
                    '/main.tex': { lines: ['\\begin{document}', '\\input{cap1}', '\\end{document}'] },
                    '/cap1.tex': { lines: ['\\chapter{Introduzione}', 'Testo.'] },
                    // left in the project, no longer pulled in by main.tex
                    '/frontespizio.tex': { lines: ['% commento', 'Tesi di Laurea Magistrale in Ingegneria'] },
                    '/vuoto.tex': { lines: ['   '] },
                }),
            },
        },
        async () => ({
            // an UPLOADED .tex is a file, not a doc: invisible to getAllDocs
            files: [{ path: '/allegato.tex', text: 'Corso di Laurea Magistrale' }],
            skipped: ['/binario.pdf'],
        }),
        text => text.replace(/^%.*$/gm, '')
    )

    const read = await sources.readProjectSources('p1')
    const paths = read.docs.map(d => d.path)
    truthy('the shared reader sees the docs', paths.includes('/main.tex') && paths.includes('/cap1.tex'), JSON.stringify(paths))
    truthy('and the orphaned title page', paths.includes('/frontespizio.tex'), JSON.stringify(paths))
    truthy('and the uploaded .tex that is a file and not a doc', paths.includes('/allegato.tex'), JSON.stringify(paths))
    truthy('an empty doc is skipped', !paths.includes('/vuoto.tex'), JSON.stringify(paths))
    truthy('unreadable paths are carried out for the report', read.skipped.includes('/binario.pdf'), JSON.stringify(read.skipped))

    const typed = sources.typeCheckSources(read.docs)
    truthy('the type-check set is comment-stripped', !typed.some(d => d.text.includes('% commento')))
    truthy('and holds every file that was read', typed.length === read.docs.length)

    // And both call sites are fed from it. The run-time one must NOT read strippedDocs,
    // which is the narrowed set the review is performed over.
    const runSite = src.slice(src.indexOf('const typePattern = documentTypePattern(rubricPatterns)'))
    truthy(
        'the run-time type check reads every file read, not the pruned set',
        /documentTypeMatches\(typePattern, allReadDocs\)/.test(runSite.slice(0, 1200)),
        runSite.slice(0, 200).replace(/\s+/g, ' ')
    )
    const enqueueSite = src.slice(src.indexOf('async function startReview('))
    truthy(
        'the enqueue check reads the same shared sources',
        /documentTypeMatches\(typePattern, typeCheckSources\(sources\.docs\)\)/.test(enqueueSite),
        'call site changed'
    )
    // Ordering: the scan reads and regexes the whole project on the request thread, so
    // an over-quota or double-clicked request must be refused before paying for it.
    truthy(
        'and runs AFTER the per-user cap and the duplicate guard',
        enqueueSite.indexOf('const metered = admissionCheck()') < enqueueSite.indexOf('documentTypePattern(parseScanPatterns'),
        'the expensive scan moved back in front of the guards'
    )
    // ...and it refuses to scan a project the review is going to turn away as too_long
    // anyway. The scan reads the whole project and runs an admin-written regex over it,
    // synchronously, on the request thread, with no rate limiter on the route: 16 MB
    // measured 1.6 s of blocked event loop per request, which is the whole instance
    // answering nobody for as long as somebody holds the button down.
    const scan = enqueueSite.slice(enqueueSite.indexOf('documentTypePattern(parseScanPatterns'))
    truthy(
        'a project too large to review is not scanned at enqueue',
        /maxContextTokens/.test(scan.slice(0, 1500)) && /REVIEW_CHARS_PER_TOKEN/.test(scan.slice(0, 1500)),
        scan.slice(0, 200).replace(/\s+/g, ' ')
    )
    truthy(
        'and the size is counted from the character totals, not by joining the project',
        /reduce\(\(n, d\) => n \+ d\.text\.length, 0\)/.test(scan.slice(0, 1500)),
        'the guard now costs more than the scan it avoids'
    )
    // A failure of the guard rail never blocks a review: it is a courtesy check, and a
    // rubric with a broken pattern must not make the button dead.
    truthy(
        'and a failure of the check itself carries on rather than refusing',
        /catch \(err\) \{[\s\S]{0,200}enqueue-time type check failed, carrying on/.test(scan.slice(0, 2500)),
        'the enqueue type check can now refuse a review by throwing'
    )
    // ...but the authoritative guard still sits hard against jobs.set, with no await
    // between them, or a double click enqueues two reviews again.
    const admit = enqueueSite.indexOf('const admitted = admissionCheck()')
    const between = enqueueSite.slice(admit, enqueueSite.indexOf('jobs.set(job.id, job)'))
    truthy('with no await between the final guard and jobs.set', !/\bawait\b/.test(between), between.replace(/\s+/g, ' ').slice(0, 120))
}

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
