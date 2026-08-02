// The Cancel button, pinned. A cancel is the one control a user reaches for when a
// review is going wrong, and it fails silently by construction: the endpoint answers
// {ok:true} whatever happens, the panel believes it, and nothing in the UI can tell
// "stopped" from "still burning a GPU for twenty minutes". It HAS been broken in this
// repo: an edit absorbed the running branch into the queued one, so cancelling a
// running review became a no-op that reported success. These tests exercise the real
// handler sliced out of the controller, so that cannot happen again unnoticed.
import fs from 'node:fs'

// The vendored sources are checked out with CRLF endings on Windows, so the closing
// brace is anchored on a normalized copy rather than on the raw bytes.
const src = fs.readFileSync(process.env.CTRL, 'utf8').replace(/\r\n/g, '\n')
const start = src.indexOf('async function cancelReview(')
const end = src.indexOf('\n}\n', start)
if (start === -1 || end === -1) {
    console.error('FAIL: could not locate cancelReview in the controller')
    process.exit(1)
}
const source = src.slice(start, end + 2)

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// A job as the controller holds it, plus a controller that records its abort.
function makeJob(id, status, userId = 'u1') {
    let aborted = false
    return {
        id,
        status,
        userId,
        projectId: 'p1',
        controller: {
            abort() {
                aborted = true
            },
        },
        wasAborted: () => aborted,
    }
}

function harness(job, { loggedInAs = 'u1', viaProject = 'p1' } = {}) {
    const jobs = new Map([[job.id, job]])
    const queue = job.status === 'queued' ? ['other-1', job.id, 'other-2'] : []
    const forgotten = []
    // eslint-disable-next-line no-new-func
    const cancelReview = new Function(
        'jobs',
        'queue',
        'SessionManager',
        'ComplianceStore',
        `${source}; return cancelReview`
    )(
        jobs,
        queue,
        { getLoggedInUserId: () => loggedInAs },
        { forgetJobQuietly: id => forgotten.push(id) }
    )
    let answered = null
    const res = {
        json(value) {
            answered = value
            return value
        },
    }
    return {
        queue,
        forgotten,
        call: async () =>
            cancelReview({ params: { jobId: job.id, Project_id: viaProject }, session: {} }, res).then(() => answered),
    }
}

// ---- a RUNNING review: the case that regressed ----
{
    const job = makeJob('j-run', 'running')
    const h = harness(job)
    const answer = await h.call()
    check('a running review is marked cancelled', job.status === 'cancelled', job.status)
    check('and the in-flight model call is aborted', job.wasAborted())
    check('and the endpoint answers ok', answer && answer.ok === true)
}

// ---- a QUEUED review: never starts, and is not left owed in the store ----
{
    const job = makeJob('j-queue', 'queued')
    const h = harness(job)
    await h.call()
    check('a queued review is marked cancelled', job.status === 'cancelled', job.status)
    check('and is pulled out of the queue', !h.queue.includes('j-queue'), JSON.stringify(h.queue))
    check('without disturbing the jobs around it', h.queue.length === 2)
    check('and is forgotten in the store', h.forgotten.includes('j-queue'), JSON.stringify(h.forgotten))
    check('a queued review carries a finish time', typeof job.finishedAt === 'number')
}

// ---- somebody else's review is untouchable ----
{
    const job = makeJob('j-theirs', 'running', 'u2')
    const h = harness(job, { loggedInAs: 'u1' })
    const answer = await h.call()
    check("another user's review keeps running", job.status === 'running')
    check('and is not aborted', !job.wasAborted())
    // Answering ok either way is deliberate: the reply must not tell one user whether
    // another user's job exists.
    check('and the answer gives nothing away', answer && answer.ok === true)
}

// ---- a review reached through the WRONG project is untouchable too ----
// The route middleware authorises the caller for the :Project_id in the URL and for
// nothing else. Without the binding, a jobId minted on project B answered under
// project A's URL on the strength of an authorisation checked against A: for cancel
// that is a nuisance, for status it hands over the report body of a project the
// caller may no longer read.
{
    const job = makeJob('j-cross', 'running')
    const h = harness(job, { viaProject: 'p-other' })
    const answer = await h.call()
    check('a cancel through another project is a no-op', job.status === 'running' && !job.wasAborted())
    check('and the answer still gives nothing away', answer && answer.ok === true)
}
{
    const sStart = src.indexOf('async function statusReview(')
    const sEnd = src.indexOf('\n}\n', sStart)
    if (sStart === -1 || sEnd === -1) {
        console.error('FAIL: could not locate statusReview in the controller')
        process.exit(1)
    }
    const statusFor = viaProject => {
        const job = makeJob('j-status', 'done')
        job.result = { summary: 'the report body' }
        // eslint-disable-next-line no-new-func
        const statusReview = new Function(
            'jobs',
            'SessionManager',
            'jobStatusBody',
            `${src.slice(sStart, sEnd + 2)}; return statusReview`
        )(
            new Map([[job.id, job]]),
            { getLoggedInUserId: () => 'u1' },
            j => ({ ok: true, status: j.status, result: j.result })
        )
        let answered = null
        return statusReview(
            { params: { jobId: job.id, Project_id: viaProject }, session: {} },
            { json: value => (answered = value) }
        ).then(() => answered)
    }
    const own = await statusFor('p1')
    check('status through the right project answers the report', own && own.ok === true && own.result, JSON.stringify(own))
    const cross = await statusFor('p-other')
    check('status through another project is not_found', cross && cross.ok === false && cross.error === 'not_found', JSON.stringify(cross))
    check('and carries no report body', !cross.result)
}

// ---- a finished review is a no-op, not an error ----
for (const status of ['done', 'error', 'cancelled']) {
    const job = makeJob(`j-${status}`, status)
    const h = harness(job)
    const answer = await h.call()
    check(`cancelling a ${status} review changes nothing`, job.status === status && !job.wasAborted())
    check(`and still answers ok for ${status}`, answer && answer.ok === true)
}

// ---- and the loads a cancel could not reach ----
// A cancel only affects awaits that are listening for it. The four loads at the top of
// a review (rubrics, admin settings, prompts, project docs) took no timeout and were
// given no abort signal, and they sit INSIDE the single-flight slot: a hung docstore or
// Mongo read there held the queue for the whole instance for ever, while this endpoint
// answered {ok:true} and the panel said "cancelled". A cancel that reports success
// without cancelling is the defect this file exists for, so the guard is pinned here.
{
    const gStart = src.indexOf('const PREPASS_TIMEOUT_MS')
    const gEnd = src.indexOf('// overleaf-lab: run the actual review work for one job')
    if (gStart === -1 || gEnd === -1 || gEnd <= gStart) {
        console.error('FAIL: could not locate the pre-pass guard in the controller')
        process.exit(1)
    }
    // eslint-disable-next-line no-new-func
    const withPrePassGuard = new Function(
        `${src.slice(gStart, gEnd)}; return withPrePassGuard`
    )()

    const never = () => new Promise(() => {})
    const settled = async promise => {
        try {
            return { ok: true, value: await promise }
        } catch (err) {
            return { ok: false, name: err.name, message: err.message }
        }
    }

    check('a load that answers is passed straight through', (await settled(withPrePassGuard(Promise.resolve(42), 'the rubrics'))).value === 42)
    const failed = await settled(withPrePassGuard(Promise.reject(new Error('mongo said no')), 'the rubrics'))
    check('and a load that fails still fails', !failed.ok && failed.message === 'mongo said no', JSON.stringify(failed))

    const timedOut = await settled(withPrePassGuard(never(), 'the project text', undefined, 20))
    check('a load that never answers gives the queue slot back', !timedOut.ok, JSON.stringify(timedOut))
    check('and says which load it was', /project text/.test(timedOut.message), timedOut.message)

    // THE case: Cancel is pressed while a pre-pass load is hanging. The read itself
    // cannot be cancelled, but the slot can be given back, which is the part that
    // decides whether anybody else's review ever runs.
    const controller = new AbortController()
    const pending = settled(withPrePassGuard(never(), 'the rubrics', controller.signal, 60000))
    controller.abort()
    const cancelled = await pending
    check('a cancel unblocks a hanging pre-pass load', !cancelled.ok, JSON.stringify(cancelled))
    check('as an abort, so the job keeps its cancelled status', cancelled.name === 'AbortError', cancelled.name)

    const already = new AbortController()
    already.abort()
    const immediate = await settled(withPrePassGuard(never(), 'the prompts', already.signal, 60000))
    check('a job cancelled before the load starts never waits', !immediate.ok && immediate.name === 'AbortError', JSON.stringify(immediate))
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
