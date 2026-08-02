// What the archive says about a review that DID NOT FINISH.
//
// Failed reviews live in the same collection as reports, because /latest has to be able
// to answer "what is the current state of this project" with one query and because the
// unique jobId index and the TTL index then apply to them for free. That decision only
// stays safe as long as a failure can never be mistaken for a clean review by anything
// that reads the collection: a tally of zeros renders as "0 ok, 0 partial, 0 missing",
// which on a compliance dashboard is exactly what a flawless thesis looks like and is
// the one row an administrator would skip past. These tests pin the representation.
//
// The store imports Overleaf's mongodb.mjs, which only exists inside the container, so
// the functions are sliced out of the real source and given a fake collection - the same
// technique the other suites use, so what runs is the code that ships.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.STORE, 'utf8')

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

function slice(from, to) {
    const start = src.indexOf(from)
    const end = to ? src.indexOf(to) : src.length
    if (start === -1 || end === -1 || end <= start) {
        console.error(`FAIL: could not locate ${from} in the store`)
        process.exit(1)
    }
    return src.slice(start, end)
}

// ---- a failed review is archived without a tally ----
{
    const inserted = []
    const collection = {
        insertOne: async doc => {
            inserted.push(doc)
        },
    }
    // eslint-disable-next-line no-new-func
    const saveFailure = new Function(
        'reports',
        'RETENTION_MS',
        'logger',
        `${slice('export async function saveFailure(', 'export async function saveFailureQuietly(')
            .replace('export ', '')}; return saveFailure`
    )(async () => collection, 1000, { warn() {} })

    await saveFailure({
        id: 'job-1',
        projectId: 'p1',
        userId: 'u1',
        rubricId: 'r1',
        rubricName: 'Tesi',
        errorCode: 'backend_error',
        message: 'the backend did not answer',
        createdAt: Date.now(),
        startedAt: Date.now(),
        finishedAt: Date.now(),
    })

    const doc = inserted[0]
    check('a failed review is archived', !!doc && doc.jobId === 'job-1')
    check('marked as failed', doc.failed === true)
    check('with the error code that caused it', doc.errorCode === 'backend_error', doc.errorCode)
    // THE assertion this file exists for.
    check(
        'and with NO counts field, not a tally of zeros',
        !('counts' in doc),
        JSON.stringify(doc.counts)
    )
    check('and no result body', !('result' in doc))
    check('it expires like a report', doc.expiresAt instanceof Date)

    // The unique jobId index refusing a second record is the index working, not an
    // error to propagate: a resumed job must not be able to double-archive its failure.
    let threw = null
    const dup = { insertOne: async () => { throw Object.assign(new Error('dup'), { code: 11000 }) } }
    // eslint-disable-next-line no-new-func
    const saveFailureDup = new Function(
        'reports',
        'RETENTION_MS',
        'logger',
        `${slice('export async function saveFailure(', 'export async function saveFailureQuietly(')
            .replace('export ', '')}; return saveFailure`
    )(async () => dup, 1000, { warn() {} })
    await saveFailureDup({ id: 'job-1', createdAt: Date.now() }).catch(err => {
        threw = err
    })
    check('a duplicate failure record is swallowed', threw === null, threw && threw.message)

    let realError = null
    const broken = { insertOne: async () => { throw new Error('mongo is down') } }
    // eslint-disable-next-line no-new-func
    const saveFailureBroken = new Function(
        'reports',
        'RETENTION_MS',
        'logger',
        `${slice('export async function saveFailure(', 'export async function saveFailureQuietly(')
            .replace('export ', '')}; return saveFailure`
    )(async () => broken, 1000, { warn() {} })
    await saveFailureBroken({ id: 'job-2', createdAt: Date.now() }).catch(err => {
        realError = err
    })
    check('a real write failure is still raised', realError && realError.message === 'mongo is down')
}

// ---- the listing carries the distinction to every caller ----
{
    const rows = [
        { jobId: 'a', failed: true, errorCode: 'backend_error' },
        { jobId: 'b', counts: { ok: 12, partial: 1, missing: 2, na: 0 } },
        // Written before saveFailure existed: neither field is present.
        { jobId: 'c', counts: { ok: 3, partial: 0, missing: 0, na: 1 } },
        // A failure that somehow carries a stale tally must not be able to show it.
        { jobId: 'd', failed: true, counts: { ok: 0, partial: 0, missing: 0, na: 0 } },
    ]
    const collection = {
        find: () => ({ toArray: async () => rows }),
    }
    // eslint-disable-next-line no-new-func
    const listReports = new Function(
        'reports',
        `${slice('export async function listReports(', 'export async function countReports(')
            .replace('export ', '')}; return listReports`
    )(async () => collection)

    const listed = await listReports('p1', 'u1')
    const byId = Object.fromEntries(listed.map(r => [r.jobId, r]))
    check('a failed row is flagged', byId.a.failed === true && byId.a.errorCode === 'backend_error')
    check('and carries no counts a caller could render', byId.a.counts === null, JSON.stringify(byId.a.counts))
    check('a completed row keeps its tally', byId.b.failed === false && byId.b.counts.ok === 12)
    check('an old row with no flag is not a failure', byId.c.failed === false && byId.c.errorCode === null)
    check('a stale zero tally on a failure is stripped', byId.d.counts === null, JSON.stringify(byId.d.counts))
    check(
        'every row answers "did this finish" without the caller having to guess',
        listed.every(r => typeof r.failed === 'boolean'),
        JSON.stringify(listed.map(r => r.failed))
    )
}

// ---- aggregates and the delta never see a failure ----
{
    const queries = []
    const collection = {
        countDocuments: async q => {
            queries.push(q)
            return 7
        },
        findOne: async q => {
            queries.push(q)
            return null
        },
    }
    // eslint-disable-next-line no-new-func
    const countReports = new Function(
        'reports',
        `${slice('export async function countReports(', 'export async function saveReportQuietly(')
            .replace('export ', '')}; return countReports`
    )(async () => collection)
    await countReports('p1', 'u1')
    check(
        'a count of reviews excludes the ones that never ran',
        JSON.stringify(queries[0].failed) === JSON.stringify({ $ne: true }),
        JSON.stringify(queries[0])
    )

    queries.length = 0
    // eslint-disable-next-line no-new-func
    const findLatest = new Function(
        'reports',
        `${slice('export async function findLatest(', '// overleaf-lab: the newest RECORD')
            .replace('export ', '')}; return findLatest`
    )(async () => collection)
    await findLatest('p1', 'u1')
    // The delta is computed against "the previous report": comparing against a failure
    // would diff a report against a document that has no items at all.
    check(
        'the previous-report lookup skips failures',
        JSON.stringify(queries[0].failed) === JSON.stringify({ $ne: true }),
        JSON.stringify(queries[0])
    )

    queries.length = 0
    // eslint-disable-next-line no-new-func
    const findLatestRecord = new Function(
        'reports',
        `${slice('export async function findLatestRecord(', '// overleaf-lab: every stored record of a project')
            .replace('export ', '')}; return findLatestRecord`
    )(async () => collection)
    await findLatestRecord('p1', 'u1')
    // ...but /latest must see them, or an older report gets served as the current state.
    check(
        'the latest-record lookup does NOT skip them',
        queries[0].failed === undefined,
        JSON.stringify(queries[0])
    )
}

// ---- the archived HTML copy travels with the report ----
// The store renders the SAME standalone page the download button builds and
// archives it with the data, so the dashboard can serve the very document the
// student saw. Pinned here: rendered after the delta (the page must carry the
// "since the previous review" line), sized for cheap listings, and NEVER able
// to cost the report itself if the renderer crashes.
{
    const makeSaveReport = (collection, renderer) =>
        // eslint-disable-next-line no-new-func
        new Function(
            'reports',
            'RETENTION_MS',
            'logger',
            'findLatest',
            'buildDelta',
            'buildReportHtml',
            'Buffer',
            `${slice('export async function saveReport(', 'export async function saveFailure(')
                .replace('export ', '')}; return saveReport`
        )(async () => collection, 1000, { warn() {} }, async () => null, () => ({ comparable: false }), renderer, Buffer)

    const job = {
        id: 'job-2',
        projectId: 'p1',
        userId: 'u1',
        rubricId: 'r1',
        rubricName: 'Tesi',
        createdAt: Date.now(),
        finishedAt: Date.now(),
        result: { model: 'm', items: [], rubric: { id: 'r1', name: 'Tesi' } },
    }

    const inserted = []
    await makeSaveReport(
        { insertOne: async doc => inserted.push(doc) },
        result => `<!doctype html>${result.rubric.name}:${result.delta ? 'with-delta' : 'no-delta'}`
    )(job)
    const doc = inserted[0]
    check('the html copy is stored with the report', typeof doc.html === 'string' && doc.html.startsWith('<!doctype'))
    check('rendered AFTER the delta, so the page carries it', doc.html.includes('with-delta'), doc.html)
    check('with its byte size for cheap listings', doc.htmlBytes === Buffer.byteLength(doc.html, 'utf8'))

    const survived = []
    await makeSaveReport(
        { insertOne: async doc => survived.push(doc) },
        () => {
            throw new Error('render boom')
        }
    )(job)
    check(
        'a renderer crash never costs the report itself',
        survived.length === 1 && !('html' in survived[0]),
        JSON.stringify(Object.keys(survived[0] || {}))
    )
}

// ---------------------------------------------------------------------------
// the delta may not manufacture progress
// ---------------------------------------------------------------------------
// delta.test.mjs pins what the comparison MEANS; these pin the three ways it used to
// lie about a document nobody changed. The functions are sliced out of the real store
// exactly as they are there, so what runs is the code that ships.
const deltaSlice = slice('// overleaf-lab: ONE REQUIREMENT, ONE VERDICT', '// overleaf-lab: store one finished report')
// eslint-disable-next-line no-new-func
const buildDelta = new Function(`${deltaSlice.replace(/export /g, '')}; return buildDelta`)()

const report = (fingerprint, model, items) => ({
    rubricFingerprint: fingerprint,
    model,
    createdAt: new Date('2026-01-01'),
    result: { items },
})

{
    // THE HEADLINE CASE. Yesterday the requirement was missing; today the pass refused
    // or the backend went down and the item came back n.a. with modelFailure. Counting
    // that as "no longer open" announced "fixed:" for the finding a partial outage had
    // just stopped measuring, which is progress manufactured out of a failure of ours,
    // on exactly the findings the student most needs to keep seeing.
    const delta = buildDelta(
        report('abc', 'qwen', [
            { requirement: 'R1', status: 'na', modelFailure: true },
            { requirement: 'R2', status: 'ok' },
        ]),
        report('abc', 'qwen', [
            { requirement: 'R1', status: 'missing' },
            { requirement: 'R2', status: 'ok' },
        ])
    )
    check('an outage-induced n.a. is NOT reported as fixed', delta.resolved.length === 0, JSON.stringify(delta.resolved))
    check('and is not reported as a regression either', delta.regressed.length === 0, JSON.stringify(delta.regressed))
    check('and it is not silently dropped: the reader is told', delta.notRecheckedCount === 1, JSON.stringify(delta))
    check('the requirement that could not be re-checked is named', delta.notRechecked[0].requirement === 'R1' && delta.notRechecked[0].from === 'missing')
}
{
    // Same rule without the flag: a verdict that became n.a. says nothing about the
    // document either way, so it is not comparable whatever produced it.
    const delta = buildDelta(
        report('abc', 'qwen', [{ requirement: 'R1', status: 'na' }, { requirement: 'R2', status: 'na' }]),
        report('abc', 'qwen', [{ requirement: 'R1', status: 'partial' }, { requirement: 'R2', status: 'ok' }])
    )
    check('a partial that became n.a. is not resolved', delta.resolved.length === 0, JSON.stringify(delta.resolved))
    check('an ok that became n.a. is not a regression', delta.regressed.length === 0, JSON.stringify(delta.regressed))
    check('both are counted as not re-checked', delta.notRecheckedCount === 2, JSON.stringify(delta.notRechecked))
}
{
    // A requirement that is n.a. every run (it does not apply to this kind of document)
    // must not produce a "could not be re-checked" line for ever: that would be noise
    // on every report, and noise is how a real one stops being read.
    const delta = buildDelta(
        report('abc', 'qwen', [{ requirement: 'R1', status: 'na' }]),
        report('abc', 'qwen', [{ requirement: 'R1', status: 'na' }])
    )
    check('a requirement that was n.a. and still is says nothing', delta.notRecheckedCount === 0, JSON.stringify(delta))
    const failed = buildDelta(
        report('abc', 'qwen', [{ requirement: 'R1', status: 'na', modelFailure: true }]),
        report('abc', 'qwen', [{ requirement: 'R1', status: 'na' }])
    )
    check('unless this run failed on it', failed.notRecheckedCount === 1, JSON.stringify(failed))
}
{
    // The passes can emit one item per status for a single requirement. The old Map
    // kept whichever row happened to be written last, so the SAME pair of rows on both
    // sides diffed as a regression on a document nobody touched (audit3 repro 5).
    const rows = [
        { requirement: 'R7', status: 'ok' },
        { requirement: 'R7', status: 'missing' },
    ]
    const delta = buildDelta(report('abc', 'qwen', [...rows]), report('abc', 'qwen', [...rows]))
    check(
        'duplicate rows for one requirement do not invent a change',
        delta.resolved.length === 0 && delta.regressed.length === 0,
        JSON.stringify(delta)
    )
    check('the merged verdict is the worst one, so it is still counted as open', delta.stillOpenCount === 1, JSON.stringify(delta))
    // And the aggregation is not order-dependent: the same two rows the other way round.
    const flipped = buildDelta(
        report('abc', 'qwen', [rows[1], rows[0]]),
        report('abc', 'qwen', [rows[0], rows[1]])
    )
    check('and the order the rows arrive in changes nothing', flipped.resolved.length === 0 && flipped.regressed.length === 0, JSON.stringify(flipped))
    // A real fix is still a fix once the duplicates are merged.
    const fixed = buildDelta(
        report('abc', 'qwen', [{ requirement: 'R7', status: 'ok' }, { requirement: 'R7', status: 'ok' }]),
        report('abc', 'qwen', [...rows])
    )
    check('a requirement whose worst row went from missing to ok is still resolved', fixed.resolved.length === 1 && fixed.resolved[0].from === 'missing', JSON.stringify(fixed.resolved))
    // A duplicate n.a. next to a real verdict must not make the requirement
    // incomparable: the real verdict is the worse one and wins.
    const mixed = buildDelta(
        report('abc', 'qwen', [{ requirement: 'R7', status: 'na', modelFailure: true }, { requirement: 'R7', status: 'missing' }]),
        report('abc', 'qwen', [{ requirement: 'R7', status: 'ok' }])
    )
    check('a real verdict beats a failed one on the same requirement', mixed.regressed.length === 1 && mixed.notRecheckedCount === 0, JSON.stringify(mixed))
}

// ---------------------------------------------------------------------------
// the previous report is the previous report OF THIS RUBRIC
// ---------------------------------------------------------------------------
// buildDelta refuses to compare across a rubric edit, so handing it the newest report
// of ANY rubric meant that a project reviewed alternately against two rubrics answered
// "the rubric changed, not compared" on every single run while a perfectly comparable
// same-rubric report sat one row further down.
{
    const queries = []
    const rows = [
        null,
        { jobId: 'older-same-rubric', rubricFingerprint: 'abc' },
    ]
    const collection = {
        findOne: async q => {
            queries.push(q)
            return rows.shift()
        },
    }
    // eslint-disable-next-line no-new-func
    const findLatest = new Function(
        'reports',
        `${slice('export async function findLatest(', '// overleaf-lab: the newest RECORD')
            .replace('export ', '')}; return findLatest`
    )(async () => collection)

    queries.length = 0
    rows.length = 0
    rows.push({ jobId: 'same-rubric', rubricFingerprint: 'abc' })
    const same = await findLatest('p1', 'u1', 'abc')
    check('the fingerprint is part of the lookup', queries[0].rubricFingerprint === 'abc', JSON.stringify(queries[0]))
    check('and failures are still excluded', JSON.stringify(queries[0].failed) === JSON.stringify({ $ne: true }))
    check('the same-rubric report is the one returned', same.jobId === 'same-rubric')
    check('and no second query is made when it exists', queries.length === 1, JSON.stringify(queries))

    queries.length = 0
    rows.length = 0
    rows.push(null, { jobId: 'other-rubric' })
    const fallback = await findLatest('p1', 'u1', 'abc')
    // The fallback is deliberate: with no same-rubric predecessor, the newest report of
    // another rubric is what lets the delta say "the rubric changed" WITH a date,
    // instead of claiming this is the first review of the project.
    check('with no same-rubric report, the newest of any rubric is used', fallback.jobId === 'other-rubric')
    check('and that second query carries no fingerprint', queries[1] && queries[1].rubricFingerprint === undefined, JSON.stringify(queries[1]))

    queries.length = 0
    rows.length = 0
    rows.push({ jobId: 'any' })
    await findLatest('p1', 'u1')
    check('a caller with no fingerprint asks once, as before', queries.length === 1 && queries[0].rubricFingerprint === undefined, JSON.stringify(queries))
}
{
    // And the save path passes it: the fingerprint is on the job, so nothing else has
    // to look it up.
    const asked = []
    const inserted = []
    // eslint-disable-next-line no-new-func
    const saveReport = new Function(
        'reports',
        'RETENTION_MS',
        'logger',
        'findLatest',
        'buildDelta',
        'buildReportHtml',
        'Buffer',
        `${slice('export async function saveReport(', 'export async function saveFailure(')
            .replace('export ', '')}; return saveReport`
    )(
        async () => ({ insertOne: async doc => inserted.push(doc) }),
        1000,
        { warn() {} },
        async (projectId, userId, fingerprint) => {
            asked.push({ projectId, userId, fingerprint })
            return null
        },
        () => ({ comparable: false }),
        () => '<!doctype html>',
        Buffer
    )
    await saveReport({
        id: 'job-3',
        projectId: 'p1',
        userId: 'u1',
        rubricId: 'r1',
        rubricFingerprint: 'fp-1',
        createdAt: Date.now(),
        finishedAt: Date.now(),
        result: { model: 'm', items: [], rubric: { id: 'r1', name: 'T' } },
    })
    check('saveReport looks for the previous report of the SAME rubric', asked[0] && asked[0].fingerprint === 'fp-1', JSON.stringify(asked[0]))
    check('and still archives the report', inserted.length === 1 && inserted[0].jobId === 'job-3')
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
