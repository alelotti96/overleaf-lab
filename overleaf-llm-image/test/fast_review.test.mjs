// THE FAST REVIEW: the same review engine with the model taken out of it.
//
// A second button next to the first is a cheap thing to draw and an expensive thing to
// get wrong, because the two produce reports that LOOK the same. The failures this
// suite exists to catch are all of that shape:
//
//   - a fast plan that quietly contains a model step, so "no language model involved"
//     is false and the answer takes minutes anyway,
//   - a requirement nobody looked at coming back as a verdict, or vanishing from the
//     report altogether, which reads as a document with fewer requirements against it,
//   - the delta comparing a fast run against a full one and announcing every unchecked
//     requirement as one the student fixed - the manufactured progress the store's own
//     tests already forbid one level down,
//   - a fast report naming a model that never ran, in the field the archive and the
//     delta are keyed on,
//   - the whole thing refusing to start on an instance with no backend, which is the
//     one install where it is the only review available.
//
// Everything is sliced out of the shipped sources and evaluated, so what is tested is
// what runs. NOTHING here reaches a model server or a database.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const src = fs.readFileSync(process.env.CTRL, 'utf8').replace(/\r\n/g, '\n')
const storeSrc = fs.readFileSync(process.env.STORE, 'utf8').replace(/\r\n/g, '\n')
const SHARED = path.join(
    path.dirname(process.env.HOOK),
    '..', '..', '..', 'shared', 'compliance-report-html.mjs'
)
const { buildReportHtml } = await import(pathToFileURL(SHARED).href)

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

function region(text, label, from, to) {
    const start = text.indexOf(from)
    const end = text.indexOf(to, start + 1)
    if (start === -1 || end === -1 || end <= start) {
        console.error(`FAIL: could not locate ${label}`)
        process.exit(1)
    }
    return text.slice(start, end)
}

// A mutation must actually mutate: a regex that stops matching after an edit would
// otherwise leave a test that passes because it changed nothing at all.
function mutate(text, pattern, replacement, label) {
    const mutated = text.replace(pattern, replacement)
    if (mutated === text) {
        console.error(`FAIL: the mutation for ${label} matched nothing, so it proves nothing`)
        process.exit(1)
    }
    return mutated
}

// ---------------------------------------------------------------------------
// 1. THE PLAN: a fast review plans nothing that would reach a model
// ---------------------------------------------------------------------------
const PLAN_SOURCE = region(
    src,
    'the planner helpers',
    'function foldForMatch(',
    '// overleaf-lab: split the rubric guidelines'
)
const loadPlanner = text =>
    // eslint-disable-next-line no-new-func
    new Function(
        'VERIFY_MAX_FINDINGS',
        `${text}; return { buildPassPlan, countPlannedPasses, countCheckedRequirements, notCheckedInFastMode, normalizeReviewMode, setReportLanguage, requirementScope }`
    )(40)
const h = loadPlanner(PLAN_SOURCE)

// One rubric, every scope in it, in an order that interleaves them the way a real one
// does. Two of them are handed to a parser; the other five need a model.
const RUBRIC = [
    '1. Every float has a caption. [check: float-caption]',
    '2. The writing is consistent throughout. [per-file]',
    '3. Captions are self-explanatory. [per-chapter]',
    '4. An abstract is present. [structure]',
    '5. No qualitative claim without data. [per-candidate: Vague]',
    '6. The decimal separator is consistent.',
    '7. Every label is unique. [check: duplicate-label]',
]
const CODE_INDEXES = [0, 6]

{
    const fastPlan = h.buildPassPlan(RUBRIC, { fileCount: 4, segmentCount: 9, mode: 'fast' })
    const fullPlan = h.buildPassPlan(RUBRIC, { fileCount: 4, segmentCount: 9 })

    check(
        'a fast plan contains only code steps and honest skips',
        fastPlan.every(step => step.scope === 'code' || step.scope === 'model-only'),
        JSON.stringify(fastPlan.map(s => s.scope))
    )
    check(
        'and plans zero passes, so nothing is sent anywhere',
        h.countPlannedPasses(fastPlan) === 0,
        `${h.countPlannedPasses(fastPlan)}`
    )
    check(
        'the steps decided by code are exactly the [check:] requirements',
        JSON.stringify(fastPlan.flatMap(s => (s.scope === 'code' ? s.indexes : []))) ===
            JSON.stringify(CODE_INDEXES),
        JSON.stringify(fastPlan.flatMap(s => (s.scope === 'code' ? s.indexes : [])))
    )
    // Grouping is a way to share ONE model call between several chapter requirements.
    // With no call to share it would only merge rows the reader needs one by one.
    check(
        'every requirement keeps a step of its own, in rubric order',
        fastPlan.length === RUBRIC.length &&
            fastPlan.every((step, i) => step.indexes.length === 1 && step.indexes[0] === i),
        JSON.stringify(fastPlan.map(s => s.indexes))
    )
    check(
        'how many requirements a fast run actually decides is counted from the plan',
        h.countCheckedRequirements(fastPlan) === CODE_INDEXES.length,
        `${h.countCheckedRequirements(fastPlan)}`
    )

    // The differential half: the same rubric in full mode is untouched by any of this.
    check(
        'the full plan still costs model passes',
        h.countPlannedPasses(fullPlan) > 0,
        `${h.countPlannedPasses(fullPlan)}`
    )
    check(
        'and still groups the chapter requirements into a chapter step',
        fullPlan.some(step => step.scope === 'chapter' && step.passes === 9),
        JSON.stringify(fullPlan.map(s => `${s.scope}:${s.passes}`))
    )
    check(
        'and still hands the checks to the parser for free',
        fullPlan.filter(s => s.scope === 'code').every(s => s.passes === 0)
    )
    check(
        'an unknown mode is the full review, never a silently reduced one',
        h.countPlannedPasses(h.buildPassPlan(RUBRIC, { fileCount: 4, segmentCount: 9, mode: 'quick' })) ===
            h.countPlannedPasses(fullPlan)
    )
}

// ---- MUTATION: take the fast filter out of the planner ----
// Without it every model-side requirement comes back as a real step with real passes,
// which is the failure that would make the button a lie while every report still
// rendered perfectly.
{
    const broken = loadPlanner(
        mutate(
            PLAN_SOURCE,
            /if \(normalizeReviewMode\(mode\) === 'fast'\) \{[\s\S]*?\n    \}\n/,
            '',
            'the fast filter'
        )
    )
    const plan = broken.buildPassPlan(RUBRIC, { fileCount: 4, segmentCount: 9, mode: 'fast' })
    check(
        'without the filter, a model step enters the fast plan',
        plan.some(step => step.passes > 0) ||
            plan.some(step => step.scope !== 'code' && step.scope !== 'model-only'),
        JSON.stringify(plan.map(s => `${s.scope}:${s.passes}`))
    )
    // ...and the assertions above are what would have gone red, on the pristine text
    // this suite still holds.
    const restored = loadPlanner(PLAN_SOURCE)
    check(
        'and the real planner is unaffected',
        h.countPlannedPasses(
            restored.buildPassPlan(RUBRIC, { fileCount: 4, segmentCount: 9, mode: 'fast' })
        ) === 0
    )
}

// ---------------------------------------------------------------------------
// 2. THE HONEST N.A.: what a fast review says about what it did not look at
// ---------------------------------------------------------------------------
{
    h.setReportLanguage('en')
    const en = h.notCheckedInFastMode('6. The decimal separator is consistent.')
    check('an unchecked requirement is n.a., never a verdict', en.status === 'na', en.status)
    check('it keeps its own text', en.requirement === '6. The decimal separator is consistent.')
    check(
        'and says in English that a full review is what checks it',
        /not checked in fast mode/i.test(en.evidence) && /full review/i.test(en.evidence),
        en.evidence
    )
    check('with nothing invented in the suggestion', en.suggestion === '')

    h.setReportLanguage('it')
    const it = h.notCheckedInFastMode('6. Il separatore decimale è coerente.')
    check(
        'and in Italian for an Italian rubric',
        /modalit/i.test(it.evidence) && /rapida/i.test(it.evidence) && /completa/i.test(it.evidence),
        it.evidence
    )
    check('the two languages really are different sentences', it.evidence !== en.evidence)
    // Back to the default, so nothing below inherits a language from this block.
    h.setReportLanguage('en')
}

// ---------------------------------------------------------------------------
// 3. NO BACKEND CONFIGURED: the full review is refused, the fast one runs
// ---------------------------------------------------------------------------
// This is the instance every clone of this repository starts as, and the whole point
// of point three of the feature: the deterministic half of a rubric is worth having
// without a GPU. The real handler is sliced out and driven with a settings object that
// declares no backend at all.
const START_SOURCE = `${region(
    src,
    'normalizeReviewMode',
    'function normalizeReviewMode(',
    '\n}\n'
)}\n}\n${region(src, 'startReview', 'async function startReview(', '\n}\n')}\n}\n`

function startHarness({ backend = null } = {}) {
    const jobs = new Map()
    const queue = []
    const fastQueue = []
    const dispatched = []
    const remembered = []
    // eslint-disable-next-line no-new-func
    const startReview = new Function(
        'Settings',
        'SessionManager',
        'logger',
        'jobs',
        'queue',
        'fastQueue',
        'ComplianceStore',
        'getLLMFeatureFlags',
        'getComplianceRubrics',
        'getAdminLLMSettings',
        'refreshReviewEndpoints',
        'reviewEndpoints',
        'detectRubricLanguage',
        'inLanguage',
        'sweepOldJobs',
        'jobsAhead',
        'documentTypePattern',
        'documentTypeMatches',
        'typeCheckSources',
        'parseScanPatterns',
        'readProjectSources',
        'splitRubric',
        'newJobId',
        'processQueue',
        'processFastQueue',
        'MAX_LIVE_JOBS_PER_USER',
        'REVIEW_CHARS_PER_TOKEN',
        'TYPE_MISMATCH_MESSAGE_EN',
        'TYPE_MISMATCH_MESSAGE_IT',
        `${START_SOURCE}; return startReview`
    )(
        { llm: { enabled: true } },
        { getLoggedInUserId: () => 'u1' },
        { debug() {}, info() {}, warn() {}, error() {} },
        jobs,
        queue,
        fastQueue,
        { rubricFingerprint: () => 'fp', rememberJobQuietly: job => remembered.push(job.id) },
        async () => ({ reviewEnabled: true }),
        async () => [{ id: 'r1', name: 'Thesis', guidelines: '1. One.\n2. Two.', scanPatterns: '' }],
        async () => ({ llmApiUrl: backend, reviewEndpoints: [] }),
        () => {},
        [{ id: 'default', url: null }],
        () => 'en',
        (lang, en) => en,
        () => {},
        () => 0,
        () => null,
        () => true,
        docs => docs,
        () => [],
        async () => ({ docs: [] }),
        () => ({ preamble: '', requirements: ['1. One.', '2. Two.'] }),
        () => `job-${jobs.size + 1}`,
        () => dispatched.push('full'),
        () => dispatched.push('fast'),
        3,
        3,
        'wrong kind',
        'tipo sbagliato'
    )
    return {
        jobs,
        queue,
        fastQueue,
        dispatched,
        remembered,
        start: async mode => {
            let answered = null
            await startReview(
                { params: { Project_id: 'p1' }, session: {}, body: { rubricId: 'r1', mode } },
                { json: value => (answered = value) }
            )
            return answered
        },
    }
}

{
    const h1 = startHarness({ backend: null })
    const refused = await h1.start('full')
    check(
        'with no backend, a full review is refused with the reason',
        refused && refused.ok === false && refused.error === 'not_configured',
        JSON.stringify(refused)
    )

    const h2 = startHarness({ backend: null })
    const accepted = await h2.start('fast')
    check(
        'with no backend, a fast review still starts',
        accepted && accepted.ok === true && Boolean(accepted.jobId),
        JSON.stringify(accepted)
    )
    check('and the job carries its mode', h2.jobs.get(accepted.jobId).mode === 'fast')
    check(
        'it goes into the fast lane and never onto the GPU queue',
        h2.fastQueue.length === 1 && h2.queue.length === 0,
        `fast=${h2.fastQueue.length} queue=${h2.queue.length}`
    )
    check(
        'and the dispatcher it kicks is the fast one',
        JSON.stringify(h2.dispatched) === '["fast"]',
        JSON.stringify(h2.dispatched)
    )
    // A fast review is one click and five seconds. Persisting it would have it resumed
    // after a restart by a path that waits for a model backend and then queues what it
    // claimed on the GPU: the exact review the user chose not to run.
    check('a fast review is not written to the work list', h2.remembered.length === 0)

    const h3 = startHarness({ backend: 'http://gpu:8080/v1' })
    const full = await h3.start('full')
    check(
        'with a backend, a full review queues as it always did',
        full.ok === true && h3.queue.length === 1 && h3.fastQueue.length === 0,
        JSON.stringify({ queue: h3.queue.length, fast: h3.fastQueue.length })
    )
    check('and is persisted so a restart resumes it', h3.remembered.length === 1)
    check('and its mode is full', h3.jobs.get(full.jobId).mode === 'full')

    const h4 = startHarness({ backend: 'http://gpu:8080/v1' })
    const typo = await h4.start('FAST-ish')
    check(
        'an unrecognised mode falls back to the review this endpoint always ran',
        h4.jobs.get(typo.jobId).mode === 'full' && h4.queue.length === 1,
        h4.jobs.get(typo.jobId).mode
    )
}

// ---------------------------------------------------------------------------
// 3b. EVERY OUTBOUND MODEL CALL IS GUARDED
// ---------------------------------------------------------------------------
// The planner keeps the PASSES away from the model, but a review makes half a dozen
// other calls around them - the token count, the model probe, the schema probe, the
// document-type question, the double-checks, the closing summary - and each one is
// its own way to make "no language model involved" false while every report still
// renders perfectly. They cannot be driven from here (runReviewPasses is two thousand
// lines with the whole container behind it), so each guard is pinned by its text: an
// edit that removes one names itself in this list instead of going out silently.
{
    const REVIEW = region(
        src,
        'the review body',
        'async function runReviewPasses(job) {',
        '// THE ENDPOINT POOL'
    )
    const guards = [
        ['the exact token count', 'const exactPromptTokens = fast'],
        ['the model reachability probe', 'if (!fast && declaredModel.length > 0) {'],
        ['the JSON schema probe', 'const probeResponse = fast ? null :'],
        ['the document-type question', '} else if (!fast && !job.confirmed && expectedDocument) {'],
        ['the adversarial double-checks', 'const consider = predicate => {'],
        ['the closing summary', 'const response = fast'],
        ['the bibliography check', 'if (fast && isBibVerifyEnabled()) {'],
    ]
    for (const [what, text] of guards) {
        check(`${what} is guarded on the mode`, REVIEW.includes(text), text)
    }
    // The double-check guard is the one that would still "work" if it were deleted,
    // because nothing a fast review produces is selectable anyway. That makes it the
    // one most likely to be tidied away, so it is pinned on its body and not only on
    // the line above it.
    const consider = region(REVIEW, 'the verification selector', 'const consider = predicate => {', '\n    }\n')
    check(
        'and the double-check selector returns before it looks at anything',
        /if \(fast\) \{\s*\n\s*return/.test(consider),
        consider.slice(0, 400)
    )
}

// ---------------------------------------------------------------------------
// 4. THE DELTA: the two modes are never compared
// ---------------------------------------------------------------------------
const DELTA_SOURCE = region(
    storeSrc,
    'buildDelta',
    'export function rubricFingerprint',
    '// overleaf-lab: store one finished report'
)
const loadDelta = text =>
    // eslint-disable-next-line no-new-func
    new Function(
        'crypto',
        `${text.replace(/export /g, '')}; return { buildDelta, reviewMode }`
    )(crypto)
const { buildDelta } = loadDelta(DELTA_SOURCE)

const report = (mode, model, items) => ({
    rubricFingerprint: 'abc',
    model,
    mode,
    createdAt: new Date('2026-08-01'),
    result: { items },
})
const FIXED = [{ requirement: 'R1', status: 'ok' }]
const OPEN = [{ requirement: 'R1', status: 'missing' }]
const UNCHECKED = [{ requirement: 'R1', status: 'na' }]

{
    const fastAfterFull = buildDelta(report('fast', null, UNCHECKED), report('full', 'qwen', OPEN))
    check(
        'a fast review is not compared with a full one',
        fastAfterFull.comparable === false && fastAfterFull.reason === 'mode_changed',
        JSON.stringify(fastAfterFull)
    )
    check(
        'and the date of the previous one still travels with the refusal',
        Boolean(fastAfterFull.previousAt)
    )
    const fullAfterFast = buildDelta(report('full', 'qwen', OPEN), report('fast', null, UNCHECKED))
    check(
        'and neither is a full one with a fast predecessor',
        fullAfterFast.comparable === false && fullAfterFast.reason === 'mode_changed',
        JSON.stringify(fullAfterFast)
    )
    // The mode check has to come BEFORE the model one, or the crossing is reported as
    // "that one ran on a different model": true, useless, and hiding the real reason.
    check(
        'the reason names the mode, not the model',
        buildDelta(report('fast', null, FIXED), report('full', 'qwen', OPEN)).reason === 'mode_changed'
    )

    // ...and two fast reviews compare perfectly, which is what makes the mode a
    // working fix-and-check loop rather than a one-off.
    const twoFast = buildDelta(report('fast', null, FIXED), report('fast', null, OPEN))
    check(
        'two fast reviews are comparable',
        twoFast.comparable === true && twoFast.resolved.length === 1,
        JSON.stringify(twoFast)
    )

    // The differential: reports written before any of this existed carry no mode at
    // all, and they were all full reviews. Nothing about them may change.
    const legacy = buildDelta(
        { rubricFingerprint: 'abc', model: 'qwen', createdAt: new Date(), result: { items: FIXED } },
        { rubricFingerprint: 'abc', model: 'qwen', createdAt: new Date(), result: { items: OPEN } }
    )
    check(
        'two reports with no mode at all still compare as the full reviews they were',
        legacy.comparable === true && legacy.resolved.length === 1,
        JSON.stringify(legacy)
    )
    check(
        'a stored report carrying the mode only inside its result is read too',
        buildDelta(
            { rubricFingerprint: 'abc', model: null, createdAt: new Date(), result: { mode: 'fast', items: FIXED } },
            report('full', 'qwen', OPEN)
        ).reason === 'mode_changed'
    )
}

// ---- MUTATION: take the mode guard out of the delta ----
// This is the manufactured progress the store's own comment forbids, at the worst
// possible scale: not one requirement wrongly called fixed, all of them.
{
    const broken = loadDelta(
        mutate(
            DELTA_SOURCE,
            /if \(reviewMode\(current\) !== reviewMode\(previous\)\) \{[\s\S]*?\n    \}\n/,
            '',
            'the mode guard'
        )
    )
    const delta = broken.buildDelta(report('fast', null, FIXED), report('full', null, OPEN))
    check(
        'without the guard, a fast run reports a requirement it never checked as fixed',
        delta.comparable === true && delta.resolved.length === 1,
        JSON.stringify(delta)
    )
    check(
        'and the real delta still refuses',
        buildDelta(report('fast', null, FIXED), report('full', null, OPEN)).comparable === false
    )
}

// ---------------------------------------------------------------------------
// 5. THE ARCHIVE: the mode travels to Mongo and into the stored HTML
// ---------------------------------------------------------------------------
// The reports half of the store, run against a collection that behaves the way the
// driver does for the handful of things this code asks of it.
function fakeReports() {
    const documents = []
    const matches = (doc, filter) =>
        Object.entries(filter).every(([field, want]) => {
            const has = doc[field]
            if (want && typeof want === 'object') {
                if (Array.isArray(want.$in)) {
                    return want.$in.some(v => (v === null ? has == null : has === v))
                }
                if ('$ne' in want) return has !== want.$ne
                if ('$exists' in want) return (has !== undefined) === want.$exists
            }
            if (want === null) return has === null || has === undefined
            return has === want
        })
    return {
        documents,
        async createIndex() {},
        async insertOne(doc) {
            documents.push(doc)
        },
        async findOne(filter, options = {}) {
            const rows = documents
                .filter(d => matches(d, filter))
                .sort((a, b) => b.createdAt - a.createdAt)
            const row = rows[0]
            if (!row) return null
            if (options.projection && options.projection.html === 0) {
                const { html, ...rest } = row
                return rest
            }
            return row
        },
    }
}

{
    const collection = fakeReports()
    // eslint-disable-next-line no-new-func
    const store = new Function(
        'logger',
        'waitForDb',
        'getCollectionInternal',
        'crypto',
        'buildReportHtml',
        `${region(
            storeSrc,
            'the reports half of the store',
            "const COLLECTION = 'llmComplianceReports'",
            '// overleaf-lab: a review that ENDED BADLY'
        ).replace(/export /g, '')}
         ${region(
             storeSrc,
             'findLatest',
             'export async function findLatest(',
             '// overleaf-lab: the newest RECORD of any kind'
         ).replace(/export /g, '')}
         return { saveReport }`
    )(
        { warn() {}, info() {}, debug() {} },
        async () => {},
        async () => collection,
        crypto,
        buildReportHtml
    )

    const job = (id, mode, items, at) => ({
        id,
        projectId: 'p1',
        userId: 'u1',
        rubricId: 'r1',
        rubricName: 'Thesis',
        rubricFingerprint: 'fp1',
        mode,
        createdAt: at,
        finishedAt: at + 1000,
        result: {
            mode,
            model: mode === 'fast' ? null : 'qwen',
            rubric: { id: 'r1', name: 'Thesis' },
            modeCoverage: mode === 'fast' ? { checked: 2, total: 7 } : null,
            items,
            summary: '',
            documentFiles: ['main.tex'],
        },
    })

    const t0 = Date.parse('2026-08-01T09:00:00Z')
    await store.saveReport(job('j1', 'full', OPEN, t0))
    const fastDelta = await store.saveReport(job('j2', 'fast', UNCHECKED, t0 + 60000))
    const stored = collection.documents.find(d => d.jobId === 'j2')

    check('the archived record carries the mode at the top level', stored.mode === 'fast', stored.mode)
    check('and no model, because none ran', stored.model === null, String(stored.model))
    check(
        'a fast review archived after a full one refuses the comparison',
        fastDelta.comparable === false && fastDelta.reason === 'mode_changed',
        JSON.stringify(fastDelta)
    )
    check(
        'and the archived HTML carries the fast banner the student saw',
        stored.html.includes('Fast review') && stored.html.includes('2 of 7'),
        stored.html.includes('Fast review') ? '' : 'no banner in the archived page'
    )

    // The second fast review must find the FIRST one to compare against, and not the
    // full report sitting between them: without that, alternating the two modes would
    // answer "not compared" for ever.
    const secondFast = await store.saveReport(job('j3', 'fast', FIXED, t0 + 120000))
    check(
        'a second fast review compares against the previous FAST one',
        secondFast.comparable === true,
        JSON.stringify(secondFast)
    )
    check(
        'and reports what actually moved between the two of them',
        secondFast.resolved.length === 0 && secondFast.notRecheckedCount === 0,
        JSON.stringify(secondFast)
    )
    // A full review after all that still finds its own kind.
    const secondFull = await store.saveReport(job('j4', 'full', FIXED, t0 + 180000))
    check(
        'and a full review compares against the previous FULL one',
        secondFull.comparable === true && secondFull.resolved.length === 1,
        JSON.stringify(secondFull)
    )
}

// ---------------------------------------------------------------------------
// 6. THE REPORT: the banner, in both languages, and no model that never ran
// ---------------------------------------------------------------------------
{
    // The renderer's own <style> names the banner's class, so "is the banner there"
    // is asked of the document without the chrome, exactly as report.test.mjs does.
    const CHROME = /<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g
    const bodyOf = html => html.replace(CHROME, '')
    const base = {
        rubric: { id: 'r', name: 'Rubric' },
        items: [
            { requirement: 'R1', status: 'ok', evidence: 'e', suggestion: '' },
            { requirement: 'R2', status: 'na', evidence: 'Not checked in fast mode.', suggestion: '' },
        ],
        summary: '',
        documentFiles: ['main.tex'],
    }

    const fast = buildReportHtml({
        ...base,
        model: null,
        mode: 'fast',
        modeCoverage: { checked: 2, total: 7 },
    })
    check('a fast report says so at the top', bodyOf(fast).includes('Fast review'), '')
    check('with the two numbers the reader needs', fast.includes('2 of 7'), '')
    check(
        'and the banner sits above the findings',
        bodyOf(fast).indexOf('fastbar') < bodyOf(fast).indexOf('<h2>'),
        `${bodyOf(fast).indexOf('fastbar')} / ${bodyOf(fast).indexOf('<h2>')}`
    )
    check('a report with no model names none', !/Model:/.test(fast))
    check('and never renders the word null', !bodyOf(fast).includes('null'))

    const italian = buildReportHtml({
        ...base,
        model: null,
        mode: 'fast',
        language: 'it',
        modeCoverage: { checked: 2, total: 7 },
    })
    check('an Italian fast report says it in Italian', italian.includes('Review rapida'), '')
    check('with the numbers in Italian word order', italian.includes('2 requisiti su 7'), '')

    // Without the counts (a caller that has none) the banner is still drawn, because
    // the fact it states is the one the reader needs; only the fraction is missing.
    const plain = buildReportHtml({ ...base, model: null, mode: 'fast' })
    check('a fast report with no coverage numbers still carries the banner', bodyOf(plain).includes('Fast review'))
    check('and does not print an empty fraction', !/\bof\s+undefined\b/.test(plain))

    const full = buildReportHtml({ ...base, model: 'qwen', mode: 'full' })
    check('a full report carries no banner', !bodyOf(full).includes('fastbar'))
    check('and still names its model', full.includes('qwen'))

    const crossed = buildReportHtml({
        ...base,
        model: null,
        mode: 'fast',
        delta: { comparable: false, reason: 'mode_changed' },
    })
    check(
        'a refused cross-mode comparison is explained in the report',
        /not run in the same mode/i.test(crossed),
        ''
    )
    const crossedIt = buildReportHtml({
        ...base,
        model: null,
        mode: 'fast',
        language: 'it',
        delta: { comparable: false, reason: 'mode_changed' },
    })
    check('and in Italian too', /stessa modalit/i.test(crossedIt), '')
}

// ---------------------------------------------------------------------------
// 7. THE MAIL: a fast review does not send one
// ---------------------------------------------------------------------------
// Pinned on the shipped settle path rather than on the source text, because this is
// the one line where "nothing happens" is the correct behaviour and an accidental
// deletion of the condition would look like a tidy-up.
{
    const SETTLE = region(
        src,
        'settleFinishedJob',
        'async function settleFinishedJob(job) {',
        '\n}\n'
    )
    const mailed = []
    // eslint-disable-next-line no-new-func
    const settle = new Function(
        'ComplianceStore',
        'ComplianceMailer',
        `${SETTLE}\n}\n; return settleFinishedJob`
    )(
        { saveFailureQuietly: async () => {}, forgetJobQuietly: async () => {} },
        { notifyReviewFinishedQuietly: job => mailed.push(job.id) }
    )
    await settle({ id: 'j-fast', mode: 'fast', status: 'done' })
    check('a finished fast review sends no email', mailed.length === 0, JSON.stringify(mailed))
    await settle({ id: 'j-full', mode: 'full', status: 'done' })
    check('a finished full review still does', JSON.stringify(mailed) === '["j-full"]', JSON.stringify(mailed))
    await settle({ id: 'j-old', status: 'error' })
    check(
        'and a job from before modes existed is treated as full',
        mailed.includes('j-old'),
        JSON.stringify(mailed)
    )
}

process.exit(ok ? 0 : 1)
