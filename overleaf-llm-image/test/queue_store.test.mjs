// The jobs collection is the QUEUE, persisted: what the process still owed when it
// died. Two defects lived here. It had no expiry, so an 'abandoned' job - and the
// orphan a fire-and-forget delete racing a fire-and-forget upsert leaves behind -
// stayed in Mongo for ever. And claiming an interrupted job was a find followed by an
// unconditional write, so two web processes booting together would each have claimed
// every job and each run it: the unique index would have deduped the reports while
// nothing deduped the GPU time or the emails.
//
// The store imports Overleaf's mongodb.mjs, which does not exist outside the
// container, so the queue half is sliced out and run against a fake collection that
// behaves the way the driver does for the four operators this code uses.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.STORE, 'utf8')
const start = src.indexOf("const JOBS_COLLECTION = 'llmComplianceJobs'")
const end = src.indexOf('export async function rememberJobQuietly')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the queue half of the store')
    process.exit(1)
}

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// --- a collection that behaves like the driver for what this code asks of it ---
function fakeCollection(documents = [], { failIndex = null } = {}) {
    const indexes = []
    const matches = (doc, filter) =>
        Object.entries(filter).every(([field, want]) => {
            const has = doc[field]
            if (want && typeof want === 'object' && Array.isArray(want.$in)) {
                return want.$in.includes(has)
            }
            // Mongo: a filter of null matches both null and a missing field.
            if (want === null) return has === null || has === undefined
            return has === want
        })
    const apply = (doc, update) => {
        for (const [field, value] of Object.entries(update.$set || {})) doc[field] = value
        for (const [field, value] of Object.entries(update.$inc || {})) doc[field] = (doc[field] || 0) + value
        return doc
    }
    return {
        indexes,
        documents,
        async createIndex(keys, options) {
            if (failIndex && failIndex(keys)) throw new Error('IndexOptionsConflict')
            indexes.push({ keys, options })
        },
        find(filter) {
            let rows = documents.filter(d => matches(d, filter))
            const cursor = {
                sort() {
                    return cursor
                },
                project(fields) {
                    rows = rows.map(row => {
                        const out = {}
                        for (const field of Object.keys(fields)) {
                            if (row[field] !== undefined) out[field] = row[field]
                        }
                        return out
                    })
                    return cursor
                },
                async toArray() {
                    return rows
                },
            }
            return cursor
        },
        async findOneAndUpdate(filter, update, options) {
            const doc = documents.find(d => matches(d, filter))
            if (!doc) return null
            apply(doc, update)
            return options && options.returnDocument === 'after' ? { ...doc } : null
        },
        async updateOne(filter, update) {
            const doc = documents.find(d => matches(d, filter))
            if (doc) apply(doc, update)
        },
        async deleteOne(filter) {
            const at = documents.findIndex(d => matches(d, filter))
            if (at !== -1) documents.splice(at, 1)
        },
    }
}

function load(collection) {
    const warned = []
    // eslint-disable-next-line no-new-func
    const store = new Function(
        'logger',
        'waitForDb',
        'getCollectionInternal',
        `${src.slice(start, end).replace(/export /g, '')}
         return { claimInterruptedJobs, markJobStatus, forgetJob, rememberJob, MAX_ATTEMPTS, JOB_RETENTION_SECONDS }`
    )(
        { warn: (obj, msg) => warned.push(msg), info() {}, debug() {} },
        async () => {},
        async () => collection
    )
    return { store, warned }
}

// ---------------------------------------------------------------------------
// the collection expires
// ---------------------------------------------------------------------------
{
    const collection = fakeCollection([])
    const { store } = load(collection)
    await store.claimInterruptedJobs()
    const ttl = collection.indexes.find(i => i.options && i.options.expireAfterSeconds !== undefined)
    check('the jobs collection has a TTL index', Boolean(ttl), JSON.stringify(collection.indexes))
    check(
        'on a field every write in this file stamps',
        ttl && Object.keys(ttl.keys)[0] === 'updatedAt',
        ttl && JSON.stringify(ttl.keys)
    )
    // Long enough that no queue wait can reach it, short enough to be a cleanup.
    check(
        'with a retention that cannot expire a live job',
        store.JOB_RETENTION_SECONDS >= 7 * 24 * 3600 && store.JOB_RETENTION_SECONDS <= 400 * 24 * 3600,
        `${store.JOB_RETENTION_SECONDS}s`
    )
    check('and the lookup index is still built', collection.indexes.some(i => i.keys.status === 1))
}
{
    // An index that cannot be built must cost the index, never the persistence: an
    // unguarded build rejects the shared promise on EVERY later call, and then a
    // review interrupted by the nightly restart is simply gone.
    const collection = fakeCollection([], { failIndex: keys => keys.updatedAt !== undefined })
    const { store, warned } = load(collection)
    let threw = null
    try {
        await store.claimInterruptedJobs()
    } catch (err) {
        threw = err
    }
    check('a failed index build does not take the queue down', threw === null, String(threw))
    check('and it says so', warned.some(m => /could not build a job index/.test(m)), warned.join(' | '))
}

// ---------------------------------------------------------------------------
// claiming is atomic
// ---------------------------------------------------------------------------
const job = (jobId, extra = {}) => ({
    jobId,
    projectId: 'p1',
    userId: 'u1',
    rubricId: 'r1',
    confirmed: true,
    status: 'queued',
    attempts: 0,
    createdAt: new Date(0),
    ...extra,
})

{
    const collection = fakeCollection([job('a'), job('b', { status: 'running' })])
    const { store } = load(collection)
    const claimed = await store.claimInterruptedJobs()
    check('an interrupted job is claimed', claimed.length === 2, claimed.map(d => d.jobId).join(','))
    check('the claim counts the attempt', claimed.every(d => d.attempts === 1), JSON.stringify(claimed.map(d => d.attempts)))
    check('and it comes back queued', claimed.every(d => d.status === 'queued'))
    check(
        'with everything performReview needs to run it again',
        claimed.every(d => d.projectId && d.userId && d.rubricId && d.confirmed === true),
        JSON.stringify(claimed[0])
    )
}
{
    // The race the fix is for: two processes read the same candidates and both try to
    // claim. The attempt count is the version number, so the second one matches
    // nothing.
    const collection = fakeCollection([job('a'), job('b')])
    const first = load(collection).store
    const second = load(collection).store
    const [one, two] = await Promise.all([first.claimInterruptedJobs(), second.claimInterruptedJobs()])
    const total = one.length + two.length
    check('two processes claim each job once, not twice', total === 2, `${one.length} + ${two.length}`)
    check(
        'and the attempt was counted once',
        collection.documents.every(d => d.attempts === 1),
        JSON.stringify(collection.documents.map(d => d.attempts))
    )
}
{
    // A job that keeps killing the process is abandoned rather than retried for ever,
    // and the TTL above is what eventually removes it.
    const collection = fakeCollection([job('a', { attempts: 3 })])
    const { store, warned } = load(collection)
    const claimed = await store.claimInterruptedJobs()
    check('a job past MAX_ATTEMPTS is not resumed', claimed.length === 0)
    check('it is marked abandoned', collection.documents[0].status === 'abandoned', collection.documents[0].status)
    check('and it says so', warned.some(m => /giving up/.test(m)), warned.join(' | '))
}
{
    // A document written before the attempt counter existed carries no `attempts`
    // field. It must still be claimable: a filter of null matches a missing field.
    const collection = fakeCollection([{ jobId: 'old', projectId: 'p', status: 'queued', createdAt: new Date(0) }])
    const { store } = load(collection)
    const claimed = await store.claimInterruptedJobs()
    check('a job with no attempt count is still claimed', claimed.length === 1, JSON.stringify(claimed))
    check('and gains one', collection.documents[0].attempts === 1, String(collection.documents[0].attempts))
}
{
    // Terminal jobs are nobody's work. They must not be resurrected by a claim.
    const collection = fakeCollection([job('done', { status: 'done' }), job('err', { status: 'error' })])
    const { store } = load(collection)
    check('a finished job is never claimed', (await store.claimInterruptedJobs()).length === 0)
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
