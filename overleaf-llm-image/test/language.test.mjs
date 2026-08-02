// The report speaks the rubric's language. The model-written parts already did (the
// prompts ask for the language of the requirement); everything the engine BUILDS was
// English whatever the rubric said, so an Italian thesis came back with English
// fragments wedged between Italian sentences, and the parser verdicts - the ones the
// report tells the reader to trust most - were English throughout.
//
// The language used to be a MODULE GLOBAL on both sides (controller and checks), which
// was safe only because one review ran at a time per process. That premise is gone: the
// queue dispatches one review per backend, so an Italian thesis and an English one are
// in flight together and would overwrite each other's language at every await. What
// keeps them apart is pinned at the bottom of this file.
//
// Three things are worth pinning here: that detection is right on the rubrics that
// exist, that nothing outside a running review reads or writes the language (a handler
// that did would answer in somebody else's), and that two reviews running at once each
// keep their own.
import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { pathToFileURL } from 'node:url'

const { runCheck, setChecksLanguage } = await import(pathToFileURL(process.env.CHECKS).href)
const src = fs.readFileSync(process.env.CTRL, 'utf8')
const start = src.indexOf('const FLOAT_ENVIRONMENTS')
const end = src.indexOf('// overleaf-lab: split the rubric guidelines')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the language helpers')
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const h = new Function(
    'logger',
    `${src.slice(start, end)}; return { detectRubricLanguage, setReportLanguage, inLanguage, L, TYPE_MISMATCH_MESSAGE_EN, TYPE_MISMATCH_MESSAGE_IT }`
)({ debug() {}, warn() {}, info() {}, error() {} })

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---- detecting the rubric's language ----
// Detection is a stopword count, and the stopword patterns are written with LITERAL
// spaces on both sides, so a stopword that opens a line is invisible. Real rubrics are
// one requirement per line and most lines open with an article, which is exactly that
// shape: these are the rubrics the lab actually ships, not synthetic prose.
{
    const italian = [
        'Linee guida per la tesi di laurea triennale.',
        '',
        '1. Ogni figura ha una didascalia. [check: float-caption]',
        '2. Il testo non contiene marcatori di lavorazione. [check: work-markers]',
        '3. La bibliografia e completa. [structure]',
        '4. Non ci sono link nudi nel testo. [check: urls-in-text]',
        '5. Le equazioni fuori testo sono numerate. [check: numbered-equations]',
        '6. I capitoli sono coerenti fra loro. [per-chapter]',
    ].join('\n')
    check('a realistic Italian rubric is read as Italian', h.detectRubricLanguage(italian) === 'it', h.detectRubricLanguage(italian))

    const english = [
        'Writing guidelines for the bachelor thesis.',
        '',
        '1. Every figure carries a caption. [check: float-caption]',
        '2. No editing markers are left in the text. [check: work-markers]',
        '3. The bibliography is complete. [structure]',
    ].join('\n')
    check('an English rubric is read as English', h.detectRubricLanguage(english) === 'en', h.detectRubricLanguage(english))

    // The hard case: few lines, few stopwords, and the English markers ([check: ...],
    // [per-chapter]) present in both. A three-line rubric is a real thing an admin
    // saves while trying the feature out.
    const shortIt = '1. Ogni figura ha una didascalia.\n2. Le tabelle sono numerate.\n3. Nessun link nudo nel testo.'
    check('a three-line Italian rubric is still Italian', h.detectRubricLanguage(shortIt) === 'it', h.detectRubricLanguage(shortIt))

    // An Italian rubric that carries the English check markers must not be dragged over
    // to English by them: the markers are engine syntax, not prose.
    const marked = '1. Ogni figura ha una didascalia. [check: float-caption]\n2. Le equazioni sono numerate. [check: numbered-equations]'
    check('the English scope markers do not flip the language', h.detectRubricLanguage(marked) === 'it', h.detectRubricLanguage(marked))

    // Nothing to count is English, which is the safe default: an English report for an
    // Italian rubric is ugly, an Italian report for an English one is wrong.
    check('an empty rubric defaults to English', h.detectRubricLanguage('') === 'en')
    check('and so does a null one', h.detectRubricLanguage(null) === 'en')
}

// ---- choosing a string ----
{
    h.setReportLanguage('it')
    check('L follows the running review', h.L('English', 'Italiano') === 'Italiano')
    // A string that has no Italian form falls back to English rather than to undefined:
    // half the strings in the module were written before the language existed.
    check('a missing translation falls back, it does not blank the report', h.L('English only') === 'English only')
    h.setReportLanguage('en')
    check('and English is restored', h.L('English', 'Italiano') === 'English')
    check('an unknown language is English', h.setReportLanguage('de') === 'en')

    // inLanguage names the language at the CALL SITE. It exists for the strings built
    // outside a running review, where the module global belongs to somebody else's job:
    // reading it there would answer in another user's language, and writing it would
    // change the language of a review already in flight.
    check('inLanguage ignores the global', h.inLanguage('it', 'English', 'Italiano') === 'Italiano')
    check('and still falls back when there is nothing to fall forward to', h.inLanguage('it', 'English') === 'English')
}

// ---- the checks answer in the same language ----
// The structural checks carry their own module-global language, set from the
// controller at the start of every run. A run that left it in Italian would give the
// NEXT student an Italian report over an English rubric.
{
    setChecksLanguage('it')
    const it = runCheck('work-markers', [{ path: '/a.tex', text: 'testo pulito senza marcatori' }])
    setChecksLanguage('en')
    const en = runCheck('work-markers', [{ path: '/a.tex', text: 'clean text with no markers' }])
    check('a check answers in Italian when told to', /Nel testo/.test(it.evidence), it.evidence)
    check('and English is restored for the next run', /No TODO/.test(en.evidence), en.evidence)
}

// ---- the two type_mismatch refusals ----
// The rubric can declare how to recognise its kind of document, and the test runs
// twice: once on the click, once when the job reaches the front of the queue. The two
// are meant to be interchangeable from the user's point of view, and they were not
// even in language - both messages were hardcoded English while the rest of the run
// had learned to speak the rubric's. An Italian rubric produced an Italian report with
// an English explanation on the click.
{
    check(
        'the refusal has an Italian form',
        typeof h.TYPE_MISMATCH_MESSAGE_IT === 'string' && h.TYPE_MISMATCH_MESSAGE_IT.length > 20 && h.TYPE_MISMATCH_MESSAGE_IT !== h.TYPE_MISMATCH_MESSAGE_EN,
        h.TYPE_MISMATCH_MESSAGE_IT
    )
    check(
        'and an Italian rubric gets it',
        h.inLanguage('it', h.TYPE_MISMATCH_MESSAGE_EN, h.TYPE_MISMATCH_MESSAGE_IT) === h.TYPE_MISMATCH_MESSAGE_IT
    )
    // ONE wording for both refusals: two hardcoded strings drift, and a user who is
    // refused on the click and again after the queue must not read two different
    // explanations of the same decision.
    const uses = (src.match(/TYPE_MISMATCH_MESSAGE_EN/g) || []).length
    check('both refusals are built from the same constants', uses >= 3, `${uses} references`)
    // The enqueue-time refusal runs OUTSIDE any review, so it must name the language
    // rather than read the global.
    const enqueue = src.slice(src.indexOf('async function startReview('))
    check(
        'the enqueue refusal names the rubric language instead of reading the global',
        /inLanguage\(rubricLang, TYPE_MISMATCH_MESSAGE_EN, TYPE_MISMATCH_MESSAGE_IT\)/.test(enqueue),
        'call site changed'
    )
    check(
        'and never sets the module-global language from a request handler',
        !/setReportLanguage\(/.test(enqueue),
        'a handler now writes the language of whatever review is running'
    )
}

// ---- the global is only written inside a review ----
// It is set once, before any check runs and any evidence is built, and nowhere else.
{
    const calls = [...src.matchAll(/\bsetReportLanguage\(/g)].map(m => m.index)
    const inReview = src.indexOf('async function runReviewPasses(')
    const afterReview = src.indexOf('async function getRubrics(')
    const writes = calls.filter(at => src.slice(at - 9, at) !== 'function ')
    check('setReportLanguage has exactly one caller', writes.length === 1, `${writes.length} call sites`)
    check(
        'and it is inside the review run, before any check',
        writes.length === 1 && writes[0] > inReview && writes[0] < afterReview,
        `at ${writes[0]}, run starts at ${inReview}`
    )
    check(
        'the checks language is set in the same breath',
        /setReportLanguage\(reportLanguage\)\s*\n\s*setChecksLanguage\(reportLanguage\)/.test(src),
        'the two languages can now disagree within one review'
    )
}

// ---- two reviews at once, each in its own language ----
// THE failure this scope exists for. With the queue dispatching to several backends,
// an Italian review and an English one interleave at every await, and a single module
// variable meant whichever started last decided the language of every fixed string the
// other one built from then on: half an Italian report in English, unreproducible, in
// a document a student is marked on.
//
// The helpers above are evaluated WITHOUT AsyncLocalStorage, which is what the other
// suites get and what the fallback path has to keep doing. Here they are evaluated with
// it, so the shipped scoped path is the one under test.
{
    // eslint-disable-next-line no-new-func
    const scoped = new Function(
        'logger',
        'AsyncLocalStorage',
        `${src.slice(start, end)}; return { setReportLanguage, L, REPORT_LANG_SCOPE }`
    )({ debug() {}, warn() {}, info() {}, error() {} }, AsyncLocalStorage)

    check('the review language has a scope of its own', Boolean(scoped.REPORT_LANG_SCOPE))
    check(
        'and without one the module variable still answers',
        h.setReportLanguage('it') === 'it' && h.L('en', 'it') === 'it',
        h.L('en', 'it')
    )

    // Two reviews, started in one order and finishing in the other, each reading its
    // own language after the other one has set its.
    const review = (lang, steps) =>
        scoped.REPORT_LANG_SCOPE.run({ lang: 'en' }, async () => {
            scoped.setReportLanguage(lang)
            const seen = []
            for (let i = 0; i < 3; i++) {
                await new Promise(resolve => setTimeout(resolve, 0))
                seen.push(scoped.L('EN', 'IT'))
            }
            steps.push(...seen)
            return seen
        })

    const steps = []
    const [italian, english] = await Promise.all([review('it', steps), review('en', steps)])
    check('an Italian review stays Italian throughout', italian.join('') === 'ITITIT', italian.join(','))
    check('while an English one runs beside it', english.join('') === 'ENENEN', english.join(','))

    // And a review must not leak its language to anything running outside one.
    scoped.setReportLanguage('en')
    await scoped.REPORT_LANG_SCOPE.run({ lang: 'en' }, async () => {
        scoped.setReportLanguage('it')
        await new Promise(resolve => setTimeout(resolve, 0))
    })
    check('and leaves nothing behind for the code outside it', scoped.L('EN', 'IT') === 'EN', scoped.L('EN', 'IT'))
}

// ---- the checks language, which belongs to a module this one may not edit ----
// LLMStructuralChecks keeps its own module-level language and is not touched from here.
// Setting it once per run was enough while runs did not overlap; now the only thing
// that makes it safe is that it is re-asserted immediately before each call, with
// nothing awaitable in between - runCheck and openingHeadingsFact are synchronous, so
// a set on the line before them cannot be interleaved by another review.
{
    const calls = [...src.matchAll(/StructuralChecks\.(runCheck|openingHeadingsFact)\(/g)]
    check('the checks are called in two places', calls.length === 2, `${calls.length}`)
    for (const call of calls) {
        // The wrapper has to be the thing that CALLS it, on the same expression: a
        // setChecksLanguage somewhere further up the function is exactly the arrangement
        // that stopped being safe.
        check(
            `${call[1]} is called with the language re-asserted`,
            /withChecksLanguage\(\(\) => $/.test(src.slice(Math.max(0, call.index - 30), call.index)),
            src.slice(Math.max(0, call.index - 30), call.index)
        )
    }
    check(
        'and the helper sets it every time, not once',
        /const withChecksLanguage = compute => \{\s*\n\s*setChecksLanguage\(reportLanguage\)/.test(src),
        'the checks language is no longer re-asserted per call'
    )
}

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
