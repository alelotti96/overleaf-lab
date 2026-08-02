// THE ENDPOINT POOL: several model backends, one review each.
//
// The queue used to be single-flight - one boolean for the whole web process - because
// there was one GPU to run reviews on. With three, that boolean was the only thing
// keeping two of them idle. What replaced it has to be right about four things at once,
// and each of them fails silently if it is not:
//
//   - a review must never move between backends mid-run. It relies on the prompt cache
//     of the machine it started on and on that machine's tokenizer for the context
//     budget, so a report assembled from two backends is a report from two judges with
//     nothing saying so.
//   - a backend that is down must cost ONE dispatch decision, not one review per queued
//     job. It used to cost eight dead calls per review, every review.
//   - an install with ONE backend must behave exactly as it did before any of this
//     existed, down to the moment the status turns 'running' - the POST that starts a
//     review answers with that status, and a client that saw it must keep seeing it.
//   - cancel must still work, in both the queued and the running case, now that
//     "running" means "holding one of several slots".
//
// The dispatch code is sliced out of the shipped controller and driven with fake
// backends and a fake review, so what is tested is what runs. Nothing here reaches a
// model server.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const src = fs.readFileSync(process.env.CTRL, 'utf8').replace(/\r\n/g, '\n')

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

const anchor = (label, needle, from = 0) => {
    const at = src.indexOf(needle, from)
    if (at === -1) {
        console.error(`FAIL: could not locate ${label} in the controller`)
        process.exit(1)
    }
    return at
}

const POOL_START = anchor('the endpoint pool', '// THE ENDPOINT POOL')
const QUEUE_START = anchor('processQueue', 'async function processQueue()')
const QUEUE_END = anchor('the end of the queue', 'async function getRubrics(')

// Let the microtasks and the timers of a dispatch settle. The pool path awaits a
// health probe before it claims, so "what happened" is only readable a few turns later.
const settle = async (turns = 8) => {
    for (let i = 0; i < turns; i++) {
        await new Promise(resolve => setTimeout(resolve, 0))
    }
}

// ---------------------------------------------------------------------------
// the harness: the real dispatch, fake backends, a review we can hold open
// ---------------------------------------------------------------------------
function harness({ endpoints = [], answers = () => true } = {}) {
    const jobs = new Map()
    const queue = []
    const busyEndpoints = new Map()
    const probed = []
    const started = []
    // One deferred per job, so a test decides exactly when a review ends and can look
    // at the pool while three of them are in flight.
    const pending = new Map()

    const performReview = job => {
        started.push({ jobId: job.id, endpointId: job.endpoint && job.endpoint.id })
        return new Promise((resolve, reject) => {
            pending.set(job.id, { resolve, reject })
        })
    }

    const fetchWithLimit = async url => {
        probed.push(url)
        const answer = answers(url)
        if (!answer) {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        }
        return { ok: true, status: 200 }
    }

    // eslint-disable-next-line no-new-func
    const api = new Function(
        'jobs',
        'queue',
        'busyEndpoints',
        'ComplianceStore',
        'ComplianceMailer',
        'logger',
        'performReview',
        'fetchWithLimit',
        `${src.slice(POOL_START, QUEUE_END)}
         return {
             processQueue,
             refreshReviewEndpoints,
             resolveReviewEndpoints,
             firstFreeEndpoint,
             poolIsConfigured,
             endpointName,
             endpointOutages,
             endpoints: () => reviewEndpoints,
         }`
    )(
        jobs,
        queue,
        busyEndpoints,
        {
            markJobStatusQuietly() {},
            saveReportQuietly: async () => null,
            saveFailureQuietly: async () => {},
            forgetJobQuietly: async () => {},
        },
        { notifyReviewFinishedQuietly() {} },
        { debug() {}, warn() {}, info() {}, error() {} },
        performReview,
        fetchWithLimit
    )

    api.refreshReviewEndpoints({ llmApiUrl: 'http://legacy:8080/v1', reviewEndpoints: endpoints })

    const enqueue = id => {
        const job = {
            id,
            projectId: `p-${id}`,
            userId: 'u1',
            status: 'queued',
            controller: null,
            endpoint: null,
            createdAt: Date.now(),
            startedAt: null,
            finishedAt: null,
            result: null,
        }
        jobs.set(id, job)
        queue.push(id)
        return job
    }

    return {
        api,
        jobs,
        queue,
        busyEndpoints,
        probed,
        started,
        enqueue,
        finish: (id, outcome = { type: 'done', result: {} }) => pending.get(id).resolve(outcome),
        blowUp: (id, err) => pending.get(id).reject(err),
        isPending: id => pending.has(id),
    }
}

const THREE = [
    { id: 'e1', label: 'gpu-one', url: 'http://one:8080/v1', model: 'model-a' },
    { id: 'e2', label: 'gpu-two', url: 'http://two:8080/v1', model: 'model-b' },
    { id: 'e3', label: 'gpu-three', url: 'http://three:8080/v1', model: 'model-c' },
]

// ---------------------------------------------------------------------------
// three backends, four reviews
// ---------------------------------------------------------------------------
{
    const h = harness({ endpoints: THREE })
    for (const id of ['j1', 'j2', 'j3', 'j4']) {
        h.enqueue(id)
    }
    h.api.processQueue()
    await settle()

    check('three backends run three reviews at once', h.busyEndpoints.size === 3, `${h.busyEndpoints.size}`)
    check('and the fourth waits', h.queue.length === 1 && h.queue[0] === 'j4', JSON.stringify(h.queue))
    check(
        'each review is on a backend of its own',
        new Set(h.started.map(s => s.endpointId)).size === 3,
        JSON.stringify(h.started)
    )
    check(
        'filled in the order the administrator declared them',
        h.started.map(s => s.endpointId).join(',') === 'e1,e2,e3',
        JSON.stringify(h.started)
    )
    check(
        'the three running reviews are the three queued first',
        h.started.map(s => s.jobId).join(',') === 'j1,j2,j3',
        JSON.stringify(h.started)
    )

    // The fourth starts on whichever machine frees up, and only then.
    h.finish('j2')
    await settle()
    check('the queued review starts as soon as a backend frees up', h.queue.length === 0, JSON.stringify(h.queue))
    check(
        'on the backend that freed up, not on a new one',
        h.jobs.get('j4').endpoint.id === 'e2',
        h.jobs.get('j4').endpoint && h.jobs.get('j4').endpoint.id
    )
    check('and the pool is full again', h.busyEndpoints.size === 3, `${h.busyEndpoints.size}`)
    check(
        'the finished review gave its slot back exactly once',
        h.busyEndpoints.get('e2') === 'j4',
        JSON.stringify([...h.busyEndpoints])
    )
}

// ---------------------------------------------------------------------------
// affinity: a review lives and dies on one backend
// ---------------------------------------------------------------------------
{
    const h = harness({ endpoints: THREE })
    h.enqueue('j1')
    h.api.processQueue()
    await settle()
    const chosen = h.jobs.get('j1').endpoint

    // The administrator saves a completely different pool while the review runs. The
    // job in flight must not notice: it is mid-way through a document that is cached on
    // the machine it started on.
    h.api.refreshReviewEndpoints({
        llmApiUrl: 'http://legacy:8080/v1',
        reviewEndpoints: [{ id: 'z9', url: 'http://elsewhere:8080/v1', model: 'model-z' }],
    })
    check('a settings change never moves a running review', h.jobs.get('j1').endpoint === chosen, chosen.id)
    check(
        'and it still holds the slot it took',
        h.busyEndpoints.get('e1') === 'j1',
        JSON.stringify([...h.busyEndpoints])
    )
    h.finish('j1')
    await settle()
    check('which it gives back on the endpoint it took it from', !h.busyEndpoints.has('e1'))
}

// ---------------------------------------------------------------------------
// a backend that is down AT PICKUP
// ---------------------------------------------------------------------------
{
    const h = harness({ endpoints: THREE, answers: url => !url.startsWith('http://one') })
    h.enqueue('j1')
    h.api.processQueue()
    await settle()

    check(
        'a review is not handed to a backend that does not answer',
        h.jobs.get('j1').endpoint.id === 'e2',
        h.jobs.get('j1').endpoint && h.jobs.get('j1').endpoint.id
    )
    check('and the dead backend steps out of the rotation', h.api.endpointOutages.has('e1'))
    check(
        'with a reason recorded, not a bare flag',
        typeof h.api.endpointOutages.get('e1').reason === 'string' &&
            h.api.endpointOutages.get('e1').reason.length > 0,
        JSON.stringify(h.api.endpointOutages.get('e1'))
    )

    // THE point of the circuit: the next review does not pay to rediscover it.
    const probesBefore = h.probed.length
    h.enqueue('j2')
    h.api.processQueue()
    await settle()
    check(
        'the next review skips it without probing it again',
        !h.probed.slice(probesBefore).some(url => url.startsWith('http://one')),
        JSON.stringify(h.probed.slice(probesBefore))
    )
    check('and lands on a healthy backend', h.jobs.get('j2').endpoint.id === 'e3', h.jobs.get('j2').endpoint.id)
}

// ---------------------------------------------------------------------------
// every backend down: the honest failure, unchanged
// ---------------------------------------------------------------------------
{
    const h = harness({ endpoints: THREE, answers: () => false })
    h.enqueue('j1')
    h.api.processQueue()
    await settle()

    // NOT left in the queue. A review that cannot run has to run and fail, because the
    // failure is what tells the user (and the archive) that the backend was down; a job
    // parked in a queue nobody drains says nothing to anybody, and this is exactly what
    // a single-backend install has always done.
    check('with nothing answering the review still starts', h.queue.length === 0, JSON.stringify(h.queue))
    check('on the first backend, so it can fail against it', h.jobs.get('j1').endpoint.id === 'e1')
    check('every backend is marked', ['e1', 'e2', 'e3'].every(id => h.api.endpointOutages.has(id)))

    h.finish('j1', { type: 'error', errorCode: 'backend_error', message: 'the backend did not answer' })
    await settle()
    check('and the review ends as a backend error', h.jobs.get('j1').status === 'error', h.jobs.get('j1').status)
    check('with the message the user gets today', h.jobs.get('j1').message === 'the backend did not answer')
}

// ---------------------------------------------------------------------------
// a failure that is about the MACHINE marks the machine
// ---------------------------------------------------------------------------
for (const errorCode of ['backend_error', 'model_unavailable', 'json_mode_broken']) {
    const h = harness({ endpoints: THREE })
    h.enqueue('j1')
    h.api.processQueue()
    await settle()
    h.finish('j1', { type: 'error', errorCode, message: 'x' })
    await settle()
    check(`${errorCode} takes that backend out of the rotation`, h.api.endpointOutages.has('e1'))
}
{
    // ...and one that is about the DOCUMENT does not. The next student's project may
    // be perfectly reviewable on the same machine.
    const h = harness({ endpoints: THREE })
    h.enqueue('j1')
    h.api.processQueue()
    await settle()
    h.finish('j1', { type: 'error', errorCode: 'too_long', message: 'x' })
    await settle()
    check('too_long says nothing about the backend', !h.api.endpointOutages.has('e1'))
}
{
    // A review that ran to the end clears whatever an earlier failure left behind.
    const h = harness({ endpoints: THREE })
    h.enqueue('j1')
    h.api.processQueue()
    await settle()
    h.finish('j1', { type: 'error', errorCode: 'backend_error', message: 'x' })
    await settle()
    h.enqueue('j2')
    h.api.processQueue()
    await settle()
    h.finish('j2')
    await settle()
    check(
        'a completed review clears the mark on its backend',
        !h.api.endpointOutages.has(h.jobs.get('j2').endpoint.id),
        JSON.stringify([...h.api.endpointOutages.keys()])
    )
}

// ---------------------------------------------------------------------------
// ONE backend: the differential test
// ---------------------------------------------------------------------------
// Everything above is new behaviour. This block is the promise that none of it
// reaches an install that never configured a pool, and it is asserted on the two
// things a client can actually observe: WHEN the status changes, and whether the
// dispatch talks to the backend before the review does.
{
    const pool = harness({ endpoints: THREE })
    const solo = harness({ endpoints: [] })

    check('no configured endpoints is not a pool', solo.api.poolIsConfigured() === false)
    check('and one entry is what the queue sees', solo.api.endpoints().length === 1)
    check(
        'whose url and model are deferred to the settings',
        solo.api.endpoints()[0].url === null && solo.api.endpoints()[0].model === null,
        JSON.stringify(solo.api.endpoints()[0])
    )
    check('three configured endpoints is a pool', pool.api.poolIsConfigured() === true)

    solo.enqueue('j1')
    pool.enqueue('j1')
    // Deliberately NOT awaited. startReview kicks the queue and then answers the POST
    // with job.status in the same turn: on a single backend that answer has always been
    // 'running', and a client that polls on it must not start seeing 'queued'.
    solo.api.processQueue()
    pool.api.processQueue()
    check(
        'a single backend still turns the job running in the same turn',
        solo.jobs.get('j1').status === 'running',
        solo.jobs.get('j1').status
    )
    check(
        'and takes its slot in the same turn',
        solo.busyEndpoints.size === 1,
        JSON.stringify([...solo.busyEndpoints])
    )
    check(
        'a pool takes a turn to choose, and says so',
        pool.jobs.get('j1').status === 'queued',
        pool.jobs.get('j1').status
    )
    await settle()
    check('after which the pooled job is running too', pool.jobs.get('j1').status === 'running')

    check(
        'a single backend is never probed before a review',
        solo.probed.length === 0,
        JSON.stringify(solo.probed)
    )
    check('a pool is', pool.probed.length > 0, JSON.stringify(pool.probed))

    // The whole state sequence of a single-backend review, start to finish.
    const transitions = []
    const soloTwo = harness({ endpoints: [] })
    const job = soloTwo.enqueue('only')
    transitions.push(job.status)
    soloTwo.api.processQueue()
    transitions.push(job.status)
    soloTwo.finish('only')
    await settle()
    transitions.push(job.status)
    check(
        'queued, running, done, with nothing in between',
        transitions.join(',') === 'queued,running,done',
        transitions.join(',')
    )
    check('and the slot is free again', soloTwo.busyEndpoints.size === 0)
}

// ---------------------------------------------------------------------------
// cancel, in a pool
// ---------------------------------------------------------------------------
{
    const h = harness({ endpoints: THREE })
    for (const id of ['j1', 'j2', 'j3', 'j4']) {
        h.enqueue(id)
    }
    h.api.processQueue()
    await settle()

    // A QUEUED review cancelled while three others run: the dispatcher must not pick it
    // up when a slot frees, and it must not consume the slot either.
    h.jobs.get('j4').status = 'cancelled'
    h.queue.splice(h.queue.indexOf('j4'), 1)
    h.finish('j1')
    await settle()
    check('a cancelled queued review never starts', !h.started.some(s => s.jobId === 'j4'), JSON.stringify(h.started))
    check('and its backend is left free for the next one', h.busyEndpoints.size === 2, `${h.busyEndpoints.size}`)

    // A RUNNING review cancelled: the status is set first and the abort follows, which
    // is what processQueue reads to keep 'cancelled' instead of turning it into a
    // failure. The slot has to come back all the same.
    const running = h.jobs.get('j2')
    running.status = 'cancelled'
    const heldBy = running.endpoint.id
    h.finish('j2')
    await settle()
    check('a cancelled running review stays cancelled', running.status === 'cancelled', running.status)
    check('and gives its backend back', !h.busyEndpoints.has(heldBy), JSON.stringify([...h.busyEndpoints]))

    // And a queue that empties leaves nothing claimed.
    h.finish('j3')
    await settle()
    check('an empty queue leaves every backend free', h.busyEndpoints.size === 0, JSON.stringify([...h.busyEndpoints]))
}

// ---------------------------------------------------------------------------
// a job that is already terminal is skipped without burning a backend
// ---------------------------------------------------------------------------
{
    const h = harness({ endpoints: THREE })
    const dead = h.enqueue('j-done')
    dead.status = 'done'
    h.enqueue('j-live')
    h.api.processQueue()
    await settle()
    check('a finished id in the queue is skipped', !h.started.some(s => s.jobId === 'j-done'))
    check('and the live one still runs', h.started.some(s => s.jobId === 'j-live'), JSON.stringify(h.started))
    check('using one backend, not two', h.busyEndpoints.size === 1, `${h.busyEndpoints.size}`)
}

// ---------------------------------------------------------------------------
// the pool itself: what the settings turn into
// ---------------------------------------------------------------------------
{
    const h = harness()
    const R = h.api.resolveReviewEndpoints

    check('no settings at all is the legacy single backend', R({}).length === 1)
    check('an empty list is too', R({ reviewEndpoints: [] }).length === 1)
    check('so is a list of entries with no url', R({ reviewEndpoints: [{ id: 'a' }, { model: 'm' }] }).length === 1)
    check(
        'and the legacy entry defers both url and model',
        R({}).every(e => e.url === null && e.model === null && e.modelBackup === null),
        JSON.stringify(R({}))
    )

    const three = R({ reviewEndpoints: THREE })
    check('three declared backends are three entries', three.length === 3)
    check('each keeping its own model', three.map(e => e.model).join(',') === 'model-a,model-b,model-c')

    // The id keys the busy table, the outage table and the archived report, so two
    // entries sharing one would let a second review onto a machine already running one.
    const clashing = R({
        reviewEndpoints: [
            { id: 'same', url: 'http://a/v1' },
            { id: 'same', url: 'http://b/v1' },
            { url: 'http://c/v1' },
        ],
    })
    check('duplicate ids are separated', new Set(clashing.map(e => e.id)).size === 3, JSON.stringify(clashing.map(e => e.id)))
    check('and a missing id is invented', clashing[2].id.length > 0, clashing[2].id)

    // A settings file can be written by hand; the reader must not depend on the writer.
    const many = R({ reviewEndpoints: Array.from({ length: 40 }, (_, i) => ({ url: `http://h${i}/v1` })) })
    check('the list is capped', many.length <= 8, `${many.length}`)

    // Both controllers cap it, and a copied constant is a constant that drifts. Same
    // reason the scan-pattern probe budget is pinned across the same two files.
    const capOf = (file, label) => {
        const at = fs.readFileSync(file, 'utf8').match(/const MAX_REVIEW_ENDPOINTS = (\d+)/)
        if (!at) {
            console.error(`FAIL: could not find MAX_REVIEW_ENDPOINTS in ${label}`)
            process.exit(1)
        }
        return Number(at[1])
    }
    const readerCap = capOf(process.env.CTRL, 'the compliance controller')
    const writerCap = capOf(process.env.ADMIN, 'the admin controller')
    check('the reader and the writer cap the pool at the same number', readerCap === writerCap, `${readerCap} vs ${writerCap}`)
    check('and it is the number this suite tested', many.length === readerCap, `${many.length}`)

    check('a labelled backend is named by its label', h.api.endpointName({ id: 'e1', label: 'gpu-one' }) === 'gpu-one')
    check('an unlabelled one by its id', h.api.endpointName({ id: 'e1', label: '' }) === 'e1')
}

// ---------------------------------------------------------------------------
// what the review resolves FROM its endpoint
// ---------------------------------------------------------------------------
// The affinity rule is only worth anything if the endpoint decides the address and the
// model. This is the real block out of runReviewPasses, evaluated on its own.
{
    const rStart = anchor('the endpoint resolution', 'const endpoint = job.endpoint || reviewEndpoints[0]')
    const rEnd = anchor('the end of the endpoint resolution', 'let activeReviewModel = reviewModel', rStart)
    const resolve = (job, admin, endpoints) =>
        // eslint-disable-next-line no-new-func
        new Function(
            'job',
            'admin',
            'reviewEndpoints',
            'REVIEW_MAX_TOKENS',
            'logger',
            `${src.slice(rStart, rEnd)}
             return { llmApiUrl, reviewModel, backupReviewModel, reviewMaxTokens }`
        )(job, admin, endpoints, 12000, { debug() {}, warn() {} })

    const legacyPool = [{ id: 'default', label: '', url: null, model: null, modelBackup: null }]
    const legacy = resolve(
        { endpoint: null },
        {
            llmApiUrl: 'http://legacy:8080/v1',
            reviewModel: 'the-model',
            reviewModelBackup: 'the-backup',
            allowedModels: ['ignored'],
        },
        legacyPool
    )
    check('with no pool the address is the configured one', legacy.llmApiUrl === 'http://legacy:8080/v1', legacy.llmApiUrl)
    check('the model is the configured one', legacy.reviewModel === 'the-model', legacy.reviewModel)
    check('and so is the backup', legacy.backupReviewModel === 'the-backup', legacy.backupReviewModel)

    const pooled = resolve(
        { endpoint: { id: 'e2', url: 'http://two:8080/v1', model: 'model-b', modelBackup: 'model-b-small' } },
        {
            llmApiUrl: 'http://legacy:8080/v1',
            reviewModel: 'the-model',
            reviewModelBackup: 'the-backup',
        },
        legacyPool
    )
    check('a pooled review talks to ITS backend', pooled.llmApiUrl === 'http://two:8080/v1', pooled.llmApiUrl)
    check('and asks for the model THAT backend serves', pooled.reviewModel === 'model-b', pooled.reviewModel)
    // The failover re-sends to the SAME address with a different model, so a backup
    // that is not loaded on this machine is not a backup, it is a second way to fail.
    check(
        'with a backup that exists on the same machine',
        pooled.backupReviewModel === 'model-b-small',
        pooled.backupReviewModel
    )

    const noBackup = resolve(
        { endpoint: { id: 'e2', url: 'http://two:8080/v1', model: 'model-b', modelBackup: null } },
        { llmApiUrl: 'http://legacy:8080/v1', reviewModelBackup: 'the-backup' },
        legacyPool
    )
    check(
        'an endpoint with no backup of its own falls back to the instance one',
        noBackup.backupReviewModel === 'the-backup',
        noBackup.backupReviewModel
    )

    // A job with no endpoint at all - a resumed job whose dispatch is still ahead of it,
    // or a caller that forgets - must not throw and must not invent an address.
    const orphan = resolve({ endpoint: null }, { llmApiUrl: 'http://legacy:8080/v1' }, legacyPool)
    check('a job with no endpoint still resolves', orphan.llmApiUrl === 'http://legacy:8080/v1', orphan.llmApiUrl)
}

// ---------------------------------------------------------------------------
// what the finished review records
// ---------------------------------------------------------------------------
{
    // `model` has to stay the bare model id. The delta between two reviews refuses to
    // compare runs whose model differs, so folding the machine name into it would report
    // "that one ran on a different model" for two runs of the SAME model on two GPUs -
    // and silently drop the comparison the student came back for.
    const dStart = anchor('the finished result', "rubric: { id: rubric.id, name: rubric.name },")
    const dEnd = anchor('the end of the meta block', 'completedAt: new Date().toISOString()', dStart)
    const block = src.slice(dStart, dEnd)
    check(
        'the result still carries the bare model id',
        /\n\s*model: fast \? null : reviewModelNow\(\),/.test(block),
        block.slice(0, 200)
    )
    check('and now names the backend that served it', /endpoint: fast[\s\S]{0,120}id: endpoint\.id/.test(block))
    check('by id and label, never by url', /id: endpoint\.id/.test(block) && !/url:/.test(block))
    check(
        'with a report line only when a pool is configured',
        /endpointNote:[\s\S]{0,40}poolIsConfigured\(\)/.test(block)
    )
    // overleaf-lab: and a review that ran no model names none. A fast review calls
    // nothing, so a model id and a backend label on its report would be an invention
    // in the two fields the delta and the audit trail are built on.
    check(
        'a fast review names neither a model nor a backend',
        /model: fast \? null/.test(block) && /endpoint: fast\s*\n?\s*\? null/.test(block),
        block.slice(0, 200)
    )
    check('written through L(), so it speaks the rubric language', /endpointNote:[\s\S]*?\bL\(/.test(block))
}

// ---------------------------------------------------------------------------
// and what the report does with it
// ---------------------------------------------------------------------------
{
    const SHARED = path.join(path.dirname(process.env.HOOK), '..', '..', '..', 'shared', 'compliance-report-html.mjs')
    const { buildReportHtml } = await import(pathToFileURL(SHARED).href)
    const base = {
        rubric: { id: 'r', name: 'Rubric' },
        model: 'model-b',
        items: [],
        summary: 'ok',
        documentFiles: ['main.tex'],
    }
    const withNote = buildReportHtml({ ...base, endpointNote: 'Review eseguita sul backend gpu-two.' })
    check('the report says which backend served the review', withNote.includes('gpu-two'))
    check('in the language it was written in', withNote.includes('Review eseguita sul backend'))

    const without = buildReportHtml(base)
    check('and a single-backend report says nothing about backends', !without.includes('gpu-two'))
    // Every report archived before the pool existed lacks the field entirely.
    check('an older stored review still renders', without.includes('model-b'))
}

// ---------------------------------------------------------------------------
// the admin page: a selected model the backend no longer serves
// ---------------------------------------------------------------------------
// A model that was renamed or unloaded on the server stayed in this list, ticked, and
// indistinguishable from a working one until somebody happened to untick it. The page
// said the review model was available; the review then failed with "not available on
// the backend", hours later, in somebody else's project.
//
// The classifier is the real one, lifted out of the shipped component. Only its
// signature line is re-declared, because the file is TypeScript and the body is not:
// if the signature ever stops matching this shape the anchor fails loudly, which is
// the point.
{
    const page = fs
        .readFileSync(
            path.join(path.dirname(process.env.PANE), 'llm-admin-settings-page.tsx'),
            'utf8'
        )
        .replace(/\r\n/g, '\n')
    const cStart = page.indexOf('export function classifyModelChoices(')
    const cEnd = page.indexOf('\n}\n', cStart)
    if (cStart === -1 || cEnd === -1) {
        console.error('FAIL: could not locate classifyModelChoices in the admin settings page')
        process.exit(1)
    }
    const typed = page.slice(cStart, cEnd + 2)
    const js = typed.replace(
        /^export function classifyModelChoices\([\s\S]*?\): ModelChoice\[\] \{/,
        'function classifyModelChoices(allowed, available, hasScanned) {'
    )
    if (js === typed) {
        console.error('FAIL: the classifyModelChoices signature no longer matches the one this suite strips')
        process.exit(1)
    }
    // eslint-disable-next-line no-new-func
    const classify = new Function(`${js}; return classifyModelChoices`)()
    const byId = rows => Object.fromEntries(rows.map(r => [r.id, r]))

    // Before any scan: nothing is known, so nothing is accused.
    const cold = byId(classify(['saved-a', 'saved-b'], [], false))
    check('before a scan no selection is called broken', !cold['saved-a'].missing && !cold['saved-b'].missing)
    check('and both are still selected', cold['saved-a'].selected && cold['saved-b'].selected)

    // THE case: a scan answered, and one of the saved selections was not in it.
    const scanned = classify(['saved-a', 'gone'], ['saved-a', 'new-one'], true)
    const rows = byId(scanned)
    check('a selection the backend no longer serves is marked', rows.gone.missing === true, JSON.stringify(rows.gone))
    check('and it is NOT quietly deselected', rows.gone.selected === true, JSON.stringify(rows.gone))
    check('a selection the backend still serves is not marked', rows['saved-a'].missing === false)
    check('a model that exists but is not selected is not marked either', rows['new-one'].missing === false)
    check('and it is listed', rows['new-one'].selected === false)
    check(
        'the list keeps the order it had: scanned first, then the rest',
        scanned.map(r => r.id).join(',') === 'saved-a,new-one,gone',
        scanned.map(r => r.id).join(',')
    )

    // A backend that answers with nothing is an answer: every selection is orphaned.
    const emptyBackend = byId(classify(['saved-a'], [], true))
    check('a backend that serves nothing orphans everything selected', emptyBackend['saved-a'].missing === true)
    check('without deselecting it', emptyBackend['saved-a'].selected === true)

    // And the page must actually draw it, and must not remove anything by itself.
    check(
        'the page marks the row, not just the data',
        /choice\.missing/.test(page) && /not available on the backend/.test(page),
        'the badge is gone from the component'
    )
    check(
        'removing an orphan is an explicit action',
        /dropMissingModels/.test(page) && /remove_unavailable_models/.test(page)
    )
    check(
        'and the classifier only accuses once a scan has answered',
        /hasScanned && allowed\.includes\(id\) && !available\.includes\(id\)/.test(page),
        'the hasScanned guard is gone'
    )
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
