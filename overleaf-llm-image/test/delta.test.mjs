// Extract the REAL buildDelta/rubricFingerprint from the store and test what the
// delta between two reports is allowed to claim. The store imports Overleaf's
// mongodb.mjs, which does not exist outside the container, so the pure functions
// are sliced out and evaluated the same way the other suites do it.
import fs from 'node:fs'
import crypto from 'node:crypto'

const src = fs.readFileSync(process.env.STORE, 'utf8')
const start = src.indexOf('export function rubricFingerprint')
const end = src.indexOf('// overleaf-lab: store one finished report')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate buildDelta in the store')
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const helpers = new Function(
    'crypto',
    `${src.slice(start, end).replace(/export /g, '')}; return { rubricFingerprint, buildDelta }`
)(crypto)
const { rubricFingerprint, buildDelta } = helpers

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

const report = (fingerprint, model, items) => ({
    rubricFingerprint: fingerprint,
    model,
    createdAt: new Date('2026-01-01'),
    result: { items },
})

// ---- the fingerprint tracks the guidelines, not the name ----
check(
    'same guidelines give the same fingerprint',
    rubricFingerprint('1. Uno\n2. Due') === rubricFingerprint('1. Uno\n2. Due')
)
check(
    'an edited requirement changes the fingerprint',
    rubricFingerprint('1. Uno\n2. Due') !== rubricFingerprint('1. Uno\n2. Due modificato')
)

// ---- verdict-level delta ----
{
    const previous = report('abc', 'qwen', [
        { requirement: 'R1', status: 'missing' },
        { requirement: 'R2', status: 'ok' },
        { requirement: 'R3', status: 'partial' },
        { requirement: 'R4', status: 'ok' },
    ])
    const current = report('abc', 'qwen', [
        { requirement: 'R1', status: 'ok' },       // fixed
        { requirement: 'R2', status: 'missing' },  // broken
        { requirement: 'R3', status: 'partial' },  // still open
        { requirement: 'R4', status: 'ok' },       // untouched
    ])
    const delta = buildDelta(current, previous)
    check('comparable when rubric and model match', delta.comparable === true)
    check(
        'a requirement that went from missing to ok is resolved',
        delta.resolved.length === 1 && delta.resolved[0].requirement === 'R1',
        JSON.stringify(delta.resolved)
    )
    check(
        'a requirement that went from ok to missing is a regression',
        delta.regressed.length === 1 && delta.regressed[0].requirement === 'R2',
        JSON.stringify(delta.regressed)
    )
    check('what stayed open is counted, not listed as new', delta.stillOpenCount === 1)
    check(
        'a requirement that was fine and stayed fine is in neither list',
        !JSON.stringify(delta).includes('R4')
    )
}

// ---- partial counts as open, so partial -> ok is progress ----
{
    const delta = buildDelta(
        report('abc', 'qwen', [{ requirement: 'R1', status: 'ok' }]),
        report('abc', 'qwen', [{ requirement: 'R1', status: 'partial' }])
    )
    check('partial to ok counts as resolved', delta.resolved.length === 1)
}

// ---- the guards that keep the delta honest ----
// Comparing across a rubric edit or a model change would produce differences that
// say nothing about the document, which is worse than showing no delta at all.
{
    const current = report('abc', 'qwen', [{ requirement: 'R1', status: 'ok' }])
    check(
        'no delta against a different rubric',
        buildDelta(current, report('zzz', 'qwen', [{ requirement: 'R1', status: 'missing' }]))
            .comparable === false
    )
    check(
        'no delta against a different model',
        buildDelta(current, report('abc', 'gemma', [{ requirement: 'R1', status: 'missing' }]))
            .comparable === false
    )
    check('no delta when there is no previous report', buildDelta(current, null).comparable === false)
    check(
        'the reason why a delta is unavailable is reported',
        buildDelta(current, report('zzz', 'qwen', [])).reason === 'rubric_changed'
    )
}

// ---- a requirement that did not exist before is not a regression ----
// The rubric is unchanged here, so this only happens when a pass produced no item
// last time (a refused verification, a crashed pass): silence is not a verdict.
{
    const delta = buildDelta(
        report('abc', 'qwen', [
            { requirement: 'R1', status: 'ok' },
            { requirement: 'R2', status: 'missing' },
        ]),
        report('abc', 'qwen', [{ requirement: 'R1', status: 'ok' }])
    )
    check(
        'an item with no counterpart is left out of the delta',
        delta.resolved.length === 0 && delta.regressed.length === 0,
        JSON.stringify(delta)
    )
}

process.exit(ok ? 0 : 1)
