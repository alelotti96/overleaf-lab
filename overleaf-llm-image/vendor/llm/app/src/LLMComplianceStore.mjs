// overleaf-lab: persistence for compliance review reports.
//
// The job queue in LLMComplianceController keeps jobs in a Map for the four hours
// after they finish, which covers a page reload but nothing else: a container
// restart, and every report ever produced is gone. Since we rebuild the image
// regularly, that was the common case rather than the rare one.
//
// Reports are small (a few KB of JSON) and are worth keeping, so they go to Mongo.
// Only the FINAL result is stored: a running job stays in memory, because progress,
// cancellation and the queue slot are meaningful only inside the live process.
//
// The collection is ours and is not declared in Overleaf's mongodb.mjs, so it is
// reached through getCollectionInternal, which is the documented way to open a
// collection the core does not know about.
import { getCollectionInternal, waitForDb } from '../../../../app/src/infrastructure/mongodb.mjs'
import logger from '@overleaf/logger'
import crypto from 'node:crypto'
// overleaf-lab: the SAME renderer the editor's download button uses, so the HTML
// archived here is the identical document the student saw. One renderer, two
// callers: see shared/compliance-report-html.mjs.
import { buildReportHtml } from '../../shared/compliance-report-html.mjs'

const COLLECTION = 'llmComplianceReports'

// overleaf-lab: reports outlive the project they describe unless something removes
// them. Hooking into Overleaf's project deletion would mean putting our code in the
// middle of a destructive core flow, which is exactly where a mistake is expensive,
// so instead every document carries an expiry and Mongo drops it on its own. A year
// is longer than an academic year, so no student loses a report they may still need.
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000

let collectionPromise = null

async function reports() {
    if (!collectionPromise) {
        collectionPromise = (async () => {
            await waitForDb()
            const collection = await getCollectionInternal(COLLECTION)
            // overleaf-lab: EVERY index build is best effort, not just the unique one.
            // None of them is required for correctness (they buy lookup speed and
            // automatic expiry), but an unguarded build that fails deterministically,
            // an IndexOptionsConflict with an index left behind by an older build
            // being the realistic case, rejects this shared promise on every call and
            // takes down the archive, the queue persistence and the deduplication all
            // at once. A slow query is a far better outcome than no persistence.
            const index = async (keys, options) => {
                try {
                    await collection.createIndex(keys, options)
                } catch (err) {
                    logger.warn(
                        { keys, err },
                        '[LLM] compliance: could not build a report index, continuing without it'
                    )
                }
            }
            // Lookups are always "the newest report of this project for this user".
            await index({ projectId: 1, userId: 1, createdAt: -1 })
            // TTL index: Mongo deletes a document once expiresAt is in the past.
            await index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
            // overleaf-lab: ONE report per job, enforced by the database.
            //
            // A job is supposed to be processed once, but nothing above this line
            // guaranteed it: a resumed job that got claimed twice produced two runs
            // and two identical reports, and the listing counted the review twice.
            // The guards in the controller close the paths we know about; this index
            // closes the ones we do not, including a second copy of the module with
            // its own in-memory queue, which no amount of local bookkeeping can see.
            //
            // Partial, because reports written before this existed carry no jobId and
            // would all collide on null. In a try/catch, because a unique index that
            // cannot be built must cost the deduplication and not the persistence:
            // failing here would reject the shared promise and archive nothing at all.
            // If this one fails with 11000 there are already duplicate reports in the
            // collection from before the index existed: the warning names the fix,
            // because otherwise deduplication stays off for the life of the process
            // with nothing but one line at boot to say so.
            try {
                await collection.createIndex(
                    { jobId: 1 },
                    {
                        unique: true,
                        partialFilterExpression: { jobId: { $exists: true } },
                    }
                )
            } catch (err) {
                logger.warn(
                    { err },
                    '[LLM] compliance: could not build the unique jobId index, duplicate reports are possible. If this is a duplicate-key error, remove the duplicate documents in llmComplianceReports and restart'
                )
            }
            return collection
        })().catch(err => {
            // Do not memoise a failure: a transient error at boot would otherwise
            // disable persistence for the whole life of the process.
            collectionPromise = null
            throw err
        })
    }
    return collectionPromise
}

// overleaf-lab: two reports can only be compared if they were judged against the
// same text. The rubric NAME is not enough, because editing a requirement in the
// admin page leaves the name untouched while changing what the verdict means, so
// the fingerprint is taken over the guidelines themselves.
export function rubricFingerprint(guidelines) {
    return crypto
        .createHash('sha256')
        .update(String(guidelines || ''))
        .digest('hex')
        .slice(0, 16)
}

// overleaf-lab: ONE REQUIREMENT, ONE VERDICT, even when the run emitted several rows
// for it. A per-chapter requirement that came back ok in one chapter and missing in
// another is merged into one item by the controller, but nothing guarantees it: the
// merge can emit one row per status, and a Map keyed on the requirement text then
// keeps whichever row happened to be written last. Two runs that both produced the
// pair (ok, missing) for the same requirement then diffed as a REGRESSION on a
// document nobody touched.
//
// Worst status wins, in the order the report itself sorts by, so the delta compares
// the verdict the reader was actually shown rather than an accident of ordering.
const WORST_FIRST = { missing: 0, partial: 1, na: 2, ok: 3 }

function worstByRequirement(items) {
    const worst = new Map()
    for (const item of items || []) {
        if (!item || typeof item.requirement !== 'string') {
            continue
        }
        // An unrecognised status is ranked with `na`: it is not a verdict this code
        // can reason about, and ranking it as `ok` would let it hide a real one.
        const rank = WORST_FIRST[item.status] ?? WORST_FIRST.na
        const seen = worst.get(item.requirement)
        if (!seen || rank < seen.rank) {
            worst.set(item.requirement, {
                rank,
                status: item.status,
                modelFailure: Boolean(item.modelFailure),
            })
        } else if (rank === seen.rank && item.modelFailure) {
            // Same verdict twice, one of them from a pass that failed: the failure is
            // the more informative half and must not be lost to arrival order.
            seen.modelFailure = true
        }
    }
    return worst
}

// overleaf-lab: which review produced this record, as the delta needs to read it.
//
// Two places carry it - the top-level field written by saveReport, and the result the
// controller built - because a record can reach here from either the archive or a job
// that has just finished. Anything with NEITHER is a report written before fast
// reviews existed, and every one of those was a full review, so 'full' is not a
// default here so much as a fact about the data.
function reviewMode(record) {
    return (record && (record.mode || (record.result && record.result.mode))) || 'full'
}

// overleaf-lab: what changed between two reports, at the level where the answer is
// exact. Every requirement carries one verdict, so comparing verdicts needs no
// heuristics at all; comparing individual findings would, and that is a separate
// step (their identity has to come from the grounded quote, never from file:line,
// which moves as soon as a paragraph is inserted above).
//
// Returns comparable:false rather than a misleading diff when the rubric or the
// model changed: on a different rubric the same requirement number can mean a
// different thing, and a diff that does not say so is worse than no diff.
export function buildDelta(current, previous) {
    if (!previous) {
        return { comparable: false, reason: 'no_previous' }
    }
    if (current.rubricFingerprint !== previous.rubricFingerprint) {
        return { comparable: false, reason: 'rubric_changed', previousAt: previous.createdAt }
    }
    // overleaf-lab: A FAST REVIEW AND A FULL ONE ARE NOT COMPARABLE, and this is the
    // same rule as the `na` one below, applied one level up.
    //
    // A fast review does not look at the model-side requirements at all; it records
    // them as n.a. with the reason. Compared against a full run, every requirement the
    // full one had found MISSING would now read as "no longer open" for the single
    // reason that nobody looked - which is the manufactured progress this function
    // exists to prevent, at the worst possible scale: not one requirement, all of
    // them. The rule holds in the other direction too (a full review after a fast one
    // would announce a page of new findings that were never absent), so the modes are
    // simply never crossed. Two fast reviews compare perfectly, which is what makes
    // the mode a working loop instead of a one-off.
    //
    // Ahead of the model check on purpose: a fast review carries no model at all, so
    // the crossing would otherwise be reported as "that one ran on a different model",
    // which is true, useless, and hides the reason that matters.
    if (reviewMode(current) !== reviewMode(previous)) {
        return { comparable: false, reason: 'mode_changed', previousAt: previous.createdAt }
    }
    if (current.model !== previous.model) {
        return { comparable: false, reason: 'model_changed', previousAt: previous.createdAt }
    }

    const before = worstByRequirement(previous.result?.items)
    const now = worstByRequirement(current.result?.items)

    const resolved = []
    const regressed = []
    const stillOpen = []
    const notRechecked = []
    for (const [requirement, item] of now) {
        const seen = before.get(requirement)
        if (!seen) {
            continue
        }
        const was = seen.status
        // NOT RE-CHECKED IS NOT PROGRESS, and this is the line the whole function is
        // about. `na` today says nothing about what the document does: the check
        // refused, the model answered twice with something unusable, the backend was
        // down (`modelFailure`), or the requirement genuinely stopped applying. Counting
        // it as "no longer open" announced "fixed:" for the very findings a partial
        // outage had just stopped measuring, which manufactures progress on exactly the
        // requirements the student most needs to keep seeing. Neither fixed nor
        // regressed, and said out loud instead: the reader is told the comparison is
        // incomplete rather than shown a comparison that is wrong.
        //
        // A requirement that was n.a. before and still is says nothing new, so it is
        // silent unless the run itself failed on it.
        if (item.status === 'na') {
            if (item.modelFailure || was !== 'na') {
                notRechecked.push({
                    requirement,
                    from: was,
                    modelFailure: item.modelFailure,
                })
            }
            continue
        }
        const wasOpen = was === 'missing' || was === 'partial'
        const isOpen = item.status === 'missing' || item.status === 'partial'
        if (wasOpen && !isOpen) {
            resolved.push({ requirement, from: was, to: item.status })
        } else if (!wasOpen && isOpen) {
            regressed.push({ requirement, from: was, to: item.status })
        } else if (isOpen) {
            stillOpen.push({ requirement, status: item.status })
        }
    }

    return {
        comparable: true,
        previousAt: previous.createdAt,
        resolved,
        regressed,
        stillOpenCount: stillOpen.length,
        // Both the count and the list: the report prints the count, and a caller that
        // wants to name them (a tooltip, the dashboard) must not have to recompute it.
        notRecheckedCount: notRechecked.length,
        notRechecked,
    }
}

// overleaf-lab: store one finished report, with the delta against the previous one
// computed once and frozen into the document. Computing it at read time would mean
// a second query on every poll and a delta that silently changes as older reports
// expire.
export async function saveReport(job) {
    const collection = await reports()
    const now = Date.now()
    const doc = {
        // overleaf-lab: which job produced this report. It is what makes the write
        // idempotent (see the unique index above), and it was also the field whose
        // absence made the first duplicate impossible to diagnose from the data: two
        // identical documents with no way to tell one job run twice from two jobs.
        jobId: job.id,
        projectId: job.projectId,
        userId: job.userId,
        rubricId: job.rubricId,
        rubricName: job.rubricName,
        rubricFingerprint: job.rubricFingerprint || null,
        model: job.result?.model || null,
        // overleaf-lab: 'full' or 'fast', at the TOP LEVEL and not only inside the
        // result. Two readers need it without pulling the report body: the delta,
        // which refuses to compare across modes, and findLatest, which has to be able
        // to find the previous review of the SAME mode to compare against.
        mode: job.mode === 'fast' ? 'fast' : 'full',
        createdAt: new Date(job.createdAt),
        finishedAt: new Date(job.finishedAt || now),
        expiresAt: new Date(now + RETENTION_MS),
        // overleaf-lab: verdict tally kept at the top level so a dashboard can list
        // hundreds of reviews without pulling hundreds of full reports out of Mongo.
        counts: (job.result?.items || []).reduce(
            (acc, item) => {
                acc[item.status] = (acc[item.status] || 0) + 1
                return acc
            },
            { ok: 0, partial: 0, missing: 0, na: 0 }
        ),
        durationMs: job.result?.durationMs || null,
        result: job.result,
    }
    // The previous report OF THIS RUBRIC AND THIS MODE, not simply the previous
    // report: see findLatest. A project reviewed against two rubrics in turn otherwise
    // compared every run against the other rubric and answered "rubric changed" for
    // ever, and the same is true of somebody alternating a fast check with a full one.
    const previous = await findLatest(
        job.projectId,
        job.userId,
        job.rubricFingerprint || null,
        doc.mode
    )
    doc.delta = buildDelta(doc, previous)
    // overleaf-lab: the standalone HTML report, rendered once at completion and
    // archived with the data, so the dashboard can hand a staff member the very
    // document the student downloaded. Rendered AFTER the delta so the archived
    // page carries the same "since the previous review" line the student saw.
    // A rendering failure must never cost the report itself: the HTML is a copy,
    // the data is the record.
    if (job.result) {
        try {
            doc.html = buildReportHtml({ ...job.result, delta: doc.delta })
            doc.htmlBytes = Buffer.byteLength(doc.html, 'utf8')
        } catch (err) {
            logger.warn(
                { err, jobId: job.id },
                '[LLM] compliance: could not render the archived HTML report'
            )
        }
    }
    try {
        await collection.insertOne(doc)
    } catch (err) {
        // 11000 is the unique index refusing a second report for this job. That is
        // the index doing its job, so it is not an error to propagate: the report is
        // already archived and the caller wants the delta that went with it. Two runs
        // racing would otherwise both compute a delta against the same previous
        // report and the second would overwrite the first with an identical one.
        if (err && err.code === 11000) {
            logger.warn(
                { jobId: job.id, projectId: job.projectId },
                '[LLM] compliance: this job was already archived, keeping the first report'
            )
            const stored = await collection.findOne(
                { jobId: job.id },
                { projection: { delta: 1 } }
            )
            return stored?.delta || null
        }
        throw err
    }
    return doc.delta
}

// overleaf-lab: a review that ENDED BADLY, recorded so that "the last thing that
// happened to this project" is answerable after a restart.
//
// It goes in the reports collection rather than in one of its own for three reasons
// that all matter: /latest already reads that collection, so the newest record is one
// query and not two that then have to be compared; the unique jobId index makes the
// write idempotent exactly as it does for a report; and the TTL index expires it
// without any new bookkeeping. The price of sharing the collection is that a failure
// must be unmistakable to everything that reads it, which is what `failed: true`, the
// `errorCode`, and the deliberate absence of `counts` and `result` are for.
export async function saveFailure(job) {
    const collection = await reports()
    const now = Date.now()
    try {
        await collection.insertOne({
            jobId: job.id,
            projectId: job.projectId,
            userId: job.userId,
            rubricId: job.rubricId,
            rubricName: job.rubricName,
            rubricFingerprint: job.rubricFingerprint || null,
            model: null,
            mode: job.mode === 'fast' ? 'fast' : 'full',
            createdAt: new Date(job.createdAt),
            finishedAt: new Date(job.finishedAt || now),
            expiresAt: new Date(now + RETENTION_MS),
            failed: true,
            errorCode: job.errorCode || 'failed',
            message: job.message || null,
            // NO `counts` FIELD, deliberately, and this is the important line in the
            // function. The obvious thing is to write a zeroed tally so that a listing
            // never has to know this shape exists - but `ok: 0, partial: 0, missing: 0`
            // renders as a review that found nothing wrong, which is the single most
            // dangerous row a compliance dashboard can show: it is indistinguishable
            // from a flawless thesis and it is the one an administrator would skip
            // past. A review that did not run has no verdicts, and the honest
            // representation of "no verdicts" is an absent tally plus `failed: true`,
            // never a tally of zeros. Every consumer must branch on `failed` BEFORE it
            // reads counts; see listReports.
            durationMs: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null,
        })
    } catch (err) {
        // 11000 is the unique index refusing a second record for this job, which is the
        // index doing its work, not a failure to report.
        if (!err || err.code !== 11000) {
            throw err
        }
    }
}

export async function saveFailureQuietly(job) {
    try {
        await saveFailure(job)
    } catch (err) {
        logger.warn(
            { projectId: job.projectId, jobId: job.id, err },
            '[LLM] compliance: could not persist the failed review'
        )
    }
}

// overleaf-lab: the QUEUE, persisted. Reports above are the finished product; this
// is the work still owed. The reason it exists: the nightly backup runs
// scripts/stop.sh, which is `docker stop` followed by `docker rm`, so a review that
// was queued or halfway through simply vanished with the container and the user
// found nothing in the morning.
//
// Persistence happens when a job is ENQUEUED, not on shutdown. A SIGTERM handler
// would be a race: stop.sh stops sharelatex and mongo in the same breath, so the
// database may already be going down while we try to write to it.
const JOBS_COLLECTION = 'llmComplianceJobs'

// A job resumes from the beginning, because the per-requirement work is not
// checkpointed. What it must not do is resume forever: a review that kills the
// process would otherwise be picked up at every boot, kill it again, and leave the
// service in a loop it cannot get out of. Three attempts is enough for the backup
// window and short enough to break that cycle.
const MAX_ATTEMPTS = 3

// overleaf-lab: this collection is a WORK LIST, not an archive, so nothing here is
// worth keeping once it is neither owed nor running - and until this index existed,
// nothing ever deleted some of it. Two paths leave documents behind for good: a job
// past MAX_ATTEMPTS is set to 'abandoned' and then simply sits there, and a job that
// fails fast can have its fire-and-forget delete overtake its fire-and-forget upsert,
// which recreates the document after forgetJob has already run.
//
// The TTL is on updatedAt rather than on a per-document expiresAt (which is what the
// reports collection uses, because a report's retention is a property of the report).
// Every write in this file already sets updatedAt, so a live job cannot age out: a
// queued job is re-stamped when it starts, a running one on every requirement, and a
// finished one is deleted outright. Thirty days is far longer than any queue wait and
// short enough that an operator looking at the collection sees the present, not a
// year of debris.
const JOB_RETENTION_SECONDS = 30 * 24 * 60 * 60

let jobsCollectionPromise = null

async function pendingJobs() {
    if (!jobsCollectionPromise) {
        jobsCollectionPromise = (async () => {
            await waitForDb()
            const collection = await getCollectionInternal(JOBS_COLLECTION)
            // overleaf-lab: best effort, for the same reason the report indexes are.
            // Neither index is required for correctness, and an unguarded build that
            // fails deterministically - an IndexOptionsConflict with an index left by
            // an older build being the realistic case - would reject this shared
            // promise on every call and take the whole queue persistence down with
            // it. A slow query, or debris that outlives its welcome, is a far better
            // outcome than a review that vanishes with the nightly restart.
            const index = async (keys, options) => {
                try {
                    await collection.createIndex(keys, options)
                } catch (err) {
                    logger.warn(
                        { keys, err },
                        '[LLM] compliance: could not build a job index, continuing without it'
                    )
                }
            }
            await index({ status: 1, createdAt: 1 })
            await index({ updatedAt: 1 }, { expireAfterSeconds: JOB_RETENTION_SECONDS })
            return collection
        })().catch(err => {
            jobsCollectionPromise = null
            throw err
        })
    }
    return jobsCollectionPromise
}

// Everything performReview needs to run the job again from scratch.
export async function rememberJob(job) {
    const collection = await pendingJobs()
    await collection.updateOne(
        { jobId: job.id },
        {
            $set: {
                jobId: job.id,
                projectId: job.projectId,
                userId: job.userId,
                rubricId: job.rubricId,
                rubricName: job.rubricName,
                rubricFingerprint: job.rubricFingerprint || null,
                // overleaf-lab: the user already answered "yes, this is the right
                // rubric for this document". A job resumed after a restart must not
                // ask again: nobody is at the keyboard to answer at three in the
                // morning, and the review would simply never run.
                confirmed: Boolean(job.confirmed),
                status: job.status,
                createdAt: new Date(job.createdAt),
                updatedAt: new Date(),
            },
            $setOnInsert: { attempts: 0 },
        },
        { upsert: true }
    )
}

// overleaf-lab: mirror the progress of a running job, so an operator can see from
// the dashboard how far a review has got without opening the project. One small
// update per requirement, which is a few dozen writes over several minutes.
export async function updateJobProgress(jobId, progress) {
    const collection = await pendingJobs()
    await collection.updateOne(
        { jobId },
        {
            $set: {
                passesDone: progress.passesDone || 0,
                passesTotal: progress.passesTotal || null,
                currentRequirement: progress.currentRequirement || '',
                updatedAt: new Date(),
            },
        }
    )
}

export async function updateJobProgressQuietly(jobId, progress) {
    try {
        await updateJobProgress(jobId, progress)
    } catch (err) {
        logger.debug({ jobId, err }, '[LLM] compliance: could not mirror job progress')
    }
}

export async function markJobStatus(jobId, status) {
    const collection = await pendingJobs()
    await collection.updateOne(
        { jobId },
        { $set: { status, updatedAt: new Date() } }
    )
}

// A finished job (done, failed, cancelled) is no longer owed to anyone: the report,
// if there is one, lives in the reports collection.
export async function forgetJob(jobId) {
    const collection = await pendingJobs()
    await collection.deleteOne({ jobId })
}

// overleaf-lab: what was still owed when the process died. Anything left as queued
// or running is by definition interrupted, because a live job only exists inside the
// process that runs it. Each one gets its attempt counted here, so a job that keeps
// taking the process down with it stops being retried.
// overleaf-lab: claiming a job is a COMPARE-AND-SET, not a read followed by a hopeful
// write. The find below only produces candidates; each claim is one atomic operation
// whose filter carries both the status and the attempt count the find just read, and
// the same operation increments that count. Two web processes booting together read
// the same candidates, both try to claim, and the first one to land moves `attempts`
// so the second one matches nothing and takes no job.
//
// The attempt count is the version number ON PURPOSE, rather than a claimedBy owner
// with a lease: a lease has to be long enough to mean anything and every length is
// wrong for something. Too short and it does not exclude; too long and a job whose
// process died a minute ago is unclaimable until the lease runs out, which turns a
// crash into a review that silently never resumes. The counter already exists, it
// already means "how many times has this been picked up", and nothing has to expire.
//
// The old shape was find-then-updateOne with no condition at all. Inside one process
// it was covered by the `jobs.has(doc.jobId)` guard in resumeInterruptedJobs, and the
// deployment runs a single web process, so nothing was broken; across two, both would
// have claimed every job and run it, and the unique index on the reports collection
// would have deduped the REPORTS while nothing deduped the GPU time or the emails.
// The store's own comment above already anticipates that case ("a second copy of the
// module with its own in-memory queue, which no amount of local bookkeeping can
// see"), which is why this is worth closing before it is needed and not on the day
// the deployment changes with nothing to say so.
function claimedDocument(res) {
    // The driver returns { value, ok } before v6 and the document itself from v6 on.
    // A job document has no `value` field of its own, so this is unambiguous.
    if (res && typeof res === 'object' && 'value' in res && !('jobId' in res)) return res.value
    return res
}

export async function claimInterruptedJobs() {
    const collection = await pendingJobs()
    const interrupted = await collection
        .find({ status: { $in: ['queued', 'running'] } })
        .sort({ createdAt: 1 })
        .project({ jobId: 1, attempts: 1 })
        .toArray()

    const resumable = []
    for (const candidate of interrupted) {
        // `attempts: null` is deliberate for a document that carries no count: in a
        // Mongo filter that matches both null and a missing field, which is what a
        // job persisted before the counter existed looks like.
        const doc = claimedDocument(
            await collection.findOneAndUpdate(
                {
                    jobId: candidate.jobId,
                    status: { $in: ['queued', 'running'] },
                    attempts: candidate.attempts == null ? null : candidate.attempts,
                },
                { $set: { status: 'queued', updatedAt: new Date() }, $inc: { attempts: 1 } },
                { returnDocument: 'after' }
            )
        )
        if (!doc) {
            // Somebody else claimed it, or it finished while we were reading.
            continue
        }
        const attempts = doc.attempts || 1
        if (attempts > MAX_ATTEMPTS) {
            await collection.updateOne(
                { jobId: doc.jobId },
                { $set: { status: 'abandoned', updatedAt: new Date() } }
            )
            logger.warn(
                { jobId: doc.jobId, projectId: doc.projectId, attempts },
                '[LLM] compliance: giving up on a job that never completed'
            )
            continue
        }
        resumable.push(doc)
    }
    return resumable
}

export async function rememberJobQuietly(job) {
    try {
        await rememberJob(job)
    } catch (err) {
        logger.warn({ jobId: job.id, err }, '[LLM] compliance: could not persist the queued job')
    }
}

export async function markJobStatusQuietly(jobId, status) {
    try {
        await markJobStatus(jobId, status)
    } catch (err) {
        logger.warn({ jobId, err }, '[LLM] compliance: could not update the queued job')
    }
}

export async function forgetJobQuietly(jobId) {
    try {
        await forgetJob(jobId)
    } catch (err) {
        logger.warn({ jobId, err }, '[LLM] compliance: could not clear the queued job')
    }
}

// overleaf-lab: the newest REPORT, that is the newest record that actually carries a
// result. Failure records (saveFailure below) live in the same collection and must not
// be offered as one: buildDelta would compare against a document with no items, and the
// panel would render an empty report.
//
// With a fingerprint in hand, the newest report OF THAT RUBRIC comes first. The delta
// refuses to compare across a rubric edit (see buildDelta), so handing it the newest
// report of ANY rubric meant that a project reviewed alternately against two rubrics -
// a thesis measured against the department rubric and the supervisor's own, which is
// the normal way these are used - answered "the rubric changed, not compared" on every
// single run, while a perfectly comparable same-rubric report sat one row further down.
// The fallback is deliberate: with no same-rubric predecessor the newest report of
// another rubric is still the right answer, because it is what lets the delta say
// "rubric changed" WITH the date instead of "first stored review of this project".
// overleaf-lab: and the same argument again for the MODE. A student alternating a fast
// check with a full one would otherwise have every fast report compared against the
// full one before it and be told "not compared" every single time, while a comparable
// fast report sat one row further down. `$in: [mode, null]` for the full case matches
// the reports written before modes existed, which were all full reviews.
//
// The fallback chain is deliberate and ordered: same rubric and same mode, then same
// rubric, then anything. Each step down loses a comparison but keeps a DATE, which is
// what lets the delta say "the rubric changed" or "that one was a fast review" with a
// when, instead of the much less useful "first stored review of this project".
export async function findLatest(projectId, userId, rubricFingerprint = null, mode = null) {
    const collection = await reports()
    // The archived HTML copy stays out: every consumer of this function wants the
    // DATA (the delta, the recovery payload), and the copy weighs tens of KB.
    const query = { projectId, userId, failed: { $ne: true } }
    const options = { sort: { createdAt: -1 }, projection: { html: 0 } }
    if (rubricFingerprint && mode) {
        const sameRun = await collection.findOne(
            {
                ...query,
                rubricFingerprint,
                mode: mode === 'fast' ? 'fast' : { $in: ['full', null] },
            },
            options
        )
        if (sameRun) {
            return sameRun
        }
    }
    if (rubricFingerprint) {
        const sameRubric = await collection.findOne({ ...query, rubricFingerprint }, options)
        if (sameRubric) {
            return sameRubric
        }
    }
    return collection.findOne(query, options)
}

// overleaf-lab: the newest RECORD of any kind, report or failure.
//
// What /latest has to answer is "what is the current state of this project's review",
// and until this existed a failed review left no trace anywhere durable: the in-memory
// job was the only record, the TTL sweep or the nightly restart removed it, and the
// endpoint then fell through to the archive and served the PREVIOUS report as
// `status: 'done'`. A student whose review failed at 02:00 opened the panel and was
// shown a month-old report as the state of the document they had just changed. On a
// tool used to mark work that is the worst outcome available, and it needed no rare
// timing at all: any container restart did it, and restarts are nightly.
// PROJECT-scoped, not (project, user)-scoped. The review is a statement about the
// DOCUMENT, and every route that reaches this passes ensureUserCanReadProject first:
// a collaborator the owner shared the thesis with opened the panel and was told
// there was no review, while the owner was looking at one. Who ran it is still on
// the record (userId travels in the document); it just no longer decides who sees it.
export async function findLatestRecord(projectId) {
    const collection = await reports()
    return collection.findOne(
        { projectId },
        { sort: { createdAt: -1 }, projection: { html: 0 } }
    )
}

// overleaf-lab: every stored record of a project, newest first, without the report
// bodies. Feeds a history list; the body is fetched only when one is opened.
//
// FAILURES ARE INCLUDED, and every row therefore carries `failed` and `errorCode`
// explicitly rather than relying on an exclusion projection to let them through. A
// review that did not finish is worth seeing in a history - it is often the only trace
// that somebody tried - but it must never be able to read as a clean one, so a caller
// that renders verdicts has to branch on `failed` first. A failed record has no
// `counts` field at all (see saveFailure): there is nothing to tally, and a tally of
// zeros would look exactly like a thesis with no findings against it.
export async function listReports(projectId, userId, limit = 20) {
    const collection = await reports()
    const rows = await collection
        .find(
            { projectId, userId },
            {
                sort: { createdAt: -1 },
                limit,
                projection: { result: 0, html: 0 },
            }
        )
        .toArray()
    // Normalised on the way out so the distinction cannot go missing by omission:
    // records written before saveFailure existed carry neither field.
    return rows.map(row => ({
        ...row,
        failed: Boolean(row.failed),
        errorCode: row.failed ? row.errorCode || 'failed' : null,
        counts: row.failed ? null : row.counts || null,
        // Normalised here for the same reason as the fields above: a row with no mode
        // is a report from before fast reviews existed, and a listing that renders a
        // fast run's tally next to a full one's without saying which is which is
        // comparing three requirements against thirty.
        mode: row.mode === 'fast' ? 'fast' : 'full',
    }))
}

// overleaf-lab: how many reviews of this project actually PRODUCED a report, for any
// caller that wants a denominator. Failures are excluded rather than counted as zeros:
// averaging findings over runs that never ran would drag every average towards zero and
// make a project look better the more often its reviews broke.
export async function countReports(projectId, userId) {
    const collection = await reports()
    return collection.countDocuments({ projectId, userId, failed: { $ne: true } })
}

// overleaf-lab: persistence must never take a review down with it. Every call from
// the controller goes through here, so a Mongo outage costs the archive and nothing
// else: the report is still returned to the user from memory.
export async function saveReportQuietly(job) {
    try {
        return await saveReport(job)
    } catch (err) {
        logger.warn(
            { projectId: job.projectId, jobId: job.id, err },
            '[LLM] compliance: could not persist the report'
        )
        return null
    }
}

export async function findLatestQuietly(projectId, userId, rubricFingerprint = null) {
    try {
        return await findLatest(projectId, userId, rubricFingerprint)
    } catch (err) {
        logger.warn({ projectId, err }, '[LLM] compliance: could not read the stored report')
        return null
    }
}

export async function findLatestRecordQuietly(projectId) {
    try {
        return await findLatestRecord(projectId)
    } catch (err) {
        logger.warn({ projectId, err }, '[LLM] compliance: could not read the stored review')
        return null
    }
}

export default {
    rubricFingerprint,
    buildDelta,
    saveReport,
    saveReportQuietly,
    saveFailure,
    saveFailureQuietly,
    findLatest,
    findLatestQuietly,
    findLatestRecord,
    findLatestRecordQuietly,
    listReports,
    countReports,
    rememberJob,
    rememberJobQuietly,
    markJobStatus,
    markJobStatusQuietly,
    updateJobProgress,
    updateJobProgressQuietly,
    forgetJob,
    forgetJobQuietly,
    claimInterruptedJobs,
}
