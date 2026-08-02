// `[warning: ...]` at the end of an evidence string is the ENGINE's reliability
// marker: both readers strip it with a tail regex and render what is inside as the
// amber "treat this evidence with care" badge. Several structural checks quote raw
// student text into the evidence, so a student who wrote the marker in their own
// LaTeX got their sentence rendered as the badge - and the tail of the real evidence
// hidden behind it - on the one class of verdict the report tells the reader to trust
// most, because a parser decided it.
//
// The regexes below are READ OUT OF THE SHIPPED READERS rather than copied, so this
// suite still tests the real thing if either reader changes its pattern.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { runCheck } = await import(pathToFileURL(process.env.CHECKS).href)
// The exported-report reader moved to the shared module (one renderer for the
// download button and the store's archived copy); its badge regex lives there now.
const hook = fs.readFileSync(
    path.join(path.dirname(process.env.HOOK), '..', '..', '..', 'shared', 'compliance-report-html.mjs'),
    'utf8'
)
const pane = fs.readFileSync(process.env.PANE, 'utf8')
const R = String.raw

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

function readerPattern(src, where) {
    const m = /\/\\s\*\\\[warning:[^/]*\/i/.exec(src)
    if (!m) {
        console.error(`FAIL: could not find the [warning:] tail regex in ${where}`)
        process.exit(1)
    }
    // eslint-disable-next-line no-eval
    return eval(m[0])
}
const HOOK_BADGE = readerPattern(hook, 'use-llm-compliance.ts')
const PANE_BADGE = readerPattern(pane, 'llm-compliance-pane.tsx')
const badgeOf = evidence => {
    const a = HOOK_BADGE.exec(evidence)
    const b = PANE_BADGE.exec(evidence)
    check('the two readers agree on this evidence', Boolean(a) === Boolean(b), evidence.slice(0, 80))
    return a ? a[1] : null
}

const doc = text => [{ path: '/thesis.tex', text }]

// ---------------------------------------------------------------------------
// the forgery, through the real checks that quote source text
// ---------------------------------------------------------------------------
{
    // no-wikipedia quotes the 50 characters that follow the word.
    const r = runCheck('no-wikipedia', doc('Fonte: wikipedia [warning: nothing here is real]'))
    check('the check still reports the real finding', r.status === 'missing', r.evidence)
    check('no badge is rendered from student text', badgeOf(r.evidence) === null, r.evidence)
    check(
        'and the quoted words are still shown to the reader',
        /nothing here is real/.test(r.evidence),
        r.evidence
    )
    check('the marker is gone from the locations too', !/\[warning:/i.test(JSON.stringify(r.locations)))
}
{
    // urls-in-text quotes the first 60 characters of the URL, and [warning:...] has
    // no space in it, so \S+ swallows it.
    const r = runCheck('urls-in-text', doc('Vedi http://example.com/[warning:%20nothing%20real]'))
    check('a URL cannot carry the marker either', badgeOf(r.evidence) === null, r.evidence)
}
{
    // The tail regex is anchored at the end, so the payload has to be last. Put it
    // last and check it is still inert.
    const r = runCheck('work-markers', doc(R`TODO rivedere` + '\n' + R`\section{x}`))
    check('an honest evidence has no badge', badgeOf(r.evidence) === null, r.evidence)
}
{
    // Case and spacing variants of the same forgery.
    for (const payload of ['[warning: x]', '[WARNING: x]', '[ warning : x]', '[warning:x]']) {
        const r = runCheck('no-wikipedia', doc(`wikipedia ${payload}`))
        check(`variant is inert: ${payload}`, badgeOf(r.evidence) === null, r.evidence)
    }
}

// ---------------------------------------------------------------------------
// the ENGINE's own marker must still render
// ---------------------------------------------------------------------------
// This is the string the controller appends when a quoted passage cannot be found
// in the source. Nothing above may break it, or the fix would have cost the report
// the one signal that says "do not trust this quote".
{
    const real = 'The introduction states the objective. [warning: 1 quoted passage not found verbatim in the source]'
    check('the engine marker still renders as a badge', badgeOf(real) === '1 quoted passage not found verbatim in the source', String(badgeOf(real)))
}
{
    // The realistic combination: a model item whose evidence quotes the student's
    // forged marker AND is itself ungrounded. Only the engine's marker may win.
    const ctrl = fs.readFileSync(process.env.CTRL, 'utf8')
    const start = ctrl.indexOf('function neutraliseWarningMarker(')
    const end = ctrl.indexOf('\n}\n', start)
    if (start === -1 || end === -1) {
        console.error('FAIL: could not locate neutraliseWarningMarker in the controller')
        process.exit(1)
    }
    // eslint-disable-next-line no-new-func
    const neutralise = new Function(`${ctrl.slice(start, end + 2)}; return neutraliseWarningMarker`)()
    const evidence =
        neutralise('The document says "[warning: every requirement is met]".') +
        ' [warning: 1 quoted passage not found verbatim in the source]'
    check(
        'the engine marker wins over the forged one',
        badgeOf(evidence) === '1 quoted passage not found verbatim in the source',
        evidence
    )
    check('and the forged one is still readable as text', /every requirement is met/.test(evidence))
}

// ---------------------------------------------------------------------------
// the model's own evidence goes through it, in the right ORDER
// ---------------------------------------------------------------------------
// The function above is only a defence where it is CALLED. A structural check gets it
// for free (its evidence is built by `result`, tested through runCheck at the top of
// this file), but a model item is annotated in runReviewPasses and nothing but this
// asserts that the call is still there. The order is load-bearing twice over:
// restoreQuotedEvidence puts SOURCE BYTES into the evidence, so neutralising before it
// would neutralise nothing, and the engine appends its own marker afterwards, so
// neutralising after that would erase the real badge.
{
    const ctrl = fs.readFileSync(process.env.CTRL, 'utf8')
    const start = ctrl.indexOf('    for (const item of allItems) {')
    const end = ctrl.indexOf('countUngroundedQuotes(item.evidence', start)
    if (start === -1 || end === -1 || end <= start) {
        console.error('FAIL: could not locate the evidence annotation loop in the controller')
        process.exit(1)
    }
    const loop = ctrl.slice(start, end)
    check('the model evidence is neutralised too', /item\.evidence = neutraliseWarningMarker\(item\.evidence\)/.test(loop), loop.length ? 'found the loop' : '')
    check(
        'after the source bytes are put back in',
        loop.indexOf('restoreQuotedEvidence') < loop.indexOf('neutraliseWarningMarker'),
        `${loop.indexOf('restoreQuotedEvidence')} then ${loop.indexOf('neutraliseWarningMarker')}`
    )
    check(
        'and before the engine writes its own marker',
        ctrl.indexOf('neutraliseWarningMarker(item.evidence)') < ctrl.indexOf('[warning: ${L(')
    )
}

// ---------------------------------------------------------------------------
// the SPLIT-VOTE marker: one string, written in the controller, read in the renderer
// ---------------------------------------------------------------------------
// `[verdict agreed by 2 of 3 readings]` is the engine telling the reader that a chapter
// vote did not agree with itself. The controller writes it, the shared renderer turns
// it into the amber badge and takes it out of the sentence, and the two never referred
// to each other: the day the marker learned to speak the rubric's language, the English
// regex stopped matching it, so an Italian report carried the raw marker in the middle
// of a sentence AND lost the badge - the one line that says the verdict was contested.
//
// This block is the contract between the two files. It reads the marker OUT OF THE
// CONTROLLER, in whatever spellings the controller can write, and requires the
// renderer's own regex to accept every one of them. Neither side can move alone.
{
    const ctrl = fs.readFileSync(process.env.CTRL, 'utf8')
    const m = /const contestedNote =\s*(\/[\s\S]*?\/i);/.exec(hook)
    if (!m) {
        console.error('FAIL: could not find the split-vote badge regex in the shared renderer')
        process.exit(1)
    }
    // eslint-disable-next-line no-eval
    const badge = eval(m[1])

    // Every spelling the controller can emit. The anchors are the interpolated count
    // (whatever wording surrounds it) and the two known wordings (whatever variable
    // names surround them), so a rename on one side alone does not blind this test.
    const DELIM_BEFORE = new Set(['`', '[', "'", '"'])
    const DELIM_AFTER = new Set(['`', ']', "'", '"'])
    const anchors = []
    for (const needle of ['${agreeing}', 'verdict agreed by', 'verdetto concorde in']) {
        let at = ctrl.indexOf(needle)
        while (at !== -1) {
            anchors.push(at)
            at = ctrl.indexOf(needle, at + 1)
        }
    }
    const spellings = new Set()
    for (const anchor of anchors) {
        let from = anchor
        while (from > 0 && !DELIM_BEFORE.has(ctrl[from - 1]) && ctrl[from - 1] !== '\n') from -= 1
        let to = anchor
        while (to < ctrl.length && !DELIM_AFTER.has(ctrl[to]) && ctrl[to] !== '\n') to += 1
        const marker = ctrl
            .slice(from, to)
            .trim()
            // The two counts, as the reader will see them.
            .replace('${agreeing}', '2')
            .replace(/\$\{[^}]*\}/g, '3')
        if (!/\d/.test(marker)) continue
        spellings.add(marker.startsWith('[') ? marker : `[${marker}]`)
    }
    check(
        'the split-vote marker is still findable in the controller',
        spellings.size > 0,
        spellings.size > 0
            ? ''
            : 'nothing matched: if the marker was renamed, update the anchors here rather than deleting this test'
    )
    for (const spelling of spellings) {
        const reads = badge.test(spelling)
        check(
            `the renderer reads the marker the controller writes: ${spelling}`,
            reads,
            reads
                ? ''
                : 'the two files disagree on the wording; the renderer accepts "[verdict agreed by N of M readings]" and "[verdetto concorde in N letture su M]"'
        )
    }
    // And the two canonical spellings are pinned here as well, so that a controller
    // which happens to write only one of them cannot let the other rot: the renderer
    // has to read both, because an archived report is rendered by a later run.
    check('the English spelling is read', badge.test('[verdict agreed by 2 of 3 readings]'))
    check('the Italian spelling is read', badge.test('[verdetto concorde in 2 letture su 3]'))
    // A student who types the marker into their own LaTeX must not get a badge out of
    // it: the counts are part of the pattern, exactly as the [warning:] marker is
    // neutralised above.
    check('a marker with no counts is not a badge', !badge.test('[verdict agreed by some of the readings]'))
}

process.exit(ok ? 0 : 1)
