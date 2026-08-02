// A rubric scan pattern is admin-written and runs, synchronously, over LaTeX any
// student can write. JavaScript has no regex timeout and a backtracking match cannot
// be aborted, so a pattern that backtracks exponentially is a permanent denial of
// service on the whole instance: measured on the shipped code, `(\w+\s*)+ in
// Ingegneria` took 67 seconds on 44 bytes of student text, and it grows about x4 per
// two extra characters. This suite pins the only defence available: refuse the
// pattern before it is ever used, at the door where the cost is paid once.
//
// The guard exists twice - the admin controller refuses at SAVE, the compliance
// controller skips at LOAD - because the two modules cannot import each other. The
// first test here is that the two copies are the same code.
import fs from 'node:fs'

const admin = fs.readFileSync(process.env.ADMIN, 'utf8')
const ctrl = fs.readFileSync(process.env.CTRL, 'utf8')

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// the two copies of the guard must not drift
// ---------------------------------------------------------------------------
function guardSource(src, where) {
    const start = src.indexOf('const SCAN_PATTERN_PROBE_BUDGET_MS')
    const end = src.indexOf('\n}\n', src.indexOf('function scanPatternIsTooSlow', start))
    if (start === -1 || end === -1 || end <= start) {
        console.error(`FAIL: could not locate scanPatternIsTooSlow in ${where}`)
        process.exit(1)
    }
    return src.slice(start, end + 2)
}
const adminGuard = guardSource(admin, 'the admin controller')
const ctrlGuard = guardSource(ctrl, 'the compliance controller')
// Comments differ (each copy names its own caller), code must not.
const stripComments = text =>
    text
        .split('\n')
        .filter(line => !/^\s*\/\//.test(line))
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim()
check(
    'the save-time and load-time guards are the same code',
    stripComments(adminGuard) === stripComments(ctrlGuard),
    `${stripComments(adminGuard).length} vs ${stripComments(ctrlGuard).length} chars`
)

// eslint-disable-next-line no-new-func
const scanPatternIsTooSlow = new Function(
    `${adminGuard}; return scanPatternIsTooSlow`
)()

// ---------------------------------------------------------------------------
// what must pass and what must not
// ---------------------------------------------------------------------------
// Real patterns out of the rubrics that ship, plus the shapes an admin writes to
// recognise a title page. Every one of these must survive: a guard that refuses
// honest patterns costs the reviewer its scan hints and the rubric its type check.
const BENIGN = [
    'wikipedia',
    String.raw`\b(performance|feedback)\b`,
    String.raw`Tesi di Laurea( Magistrale)? in`,
    String.raw`(?:First|Second) Cycle Degree`,
    String.raw`[A-Za-z]{3,}\s+\d+`,
    String.raw`\begin\{figure\}`,
    String.raw`(sviluppato|realizzato|implementato)`,
    String.raw`x*`,
    String.raw`\w+iamo\b`,
    String.raw`(\w+\s*)+`,
]
for (const body of BENIGN) {
    check(`benign pattern survives: ${body}`, !scanPatternIsTooSlow(new RegExp(body, 'i')))
}

// The audit's exact payload, and the classic shapes it belongs to.
const AUDIT_PAYLOAD = String.raw`(\w+\s*)+ in Ingegneria`
check('the audit payload is refused', scanPatternIsTooSlow(new RegExp(AUDIT_PAYLOAD, 'i')), AUDIT_PAYLOAD)
for (const body of [String.raw`(a+)+$`, String.raw`([a-zA-Z]+)*$`, String.raw`(\d+|\w+)*!`]) {
    check(`nested quantifier refused: ${body}`, scanPatternIsTooSlow(new RegExp(body, 'i')))
}

// ---------------------------------------------------------------------------
// the ladder only proves what it tries
// ---------------------------------------------------------------------------
// A pattern that explodes on letters, digits and spaces was caught. A pattern that
// explodes on the punctuation a LaTeX scan is written around - brackets, braces,
// backslashes - passed the whole ladder and then met student LaTeX, which is made of
// exactly those characters. These are the shapes an admin writes when trying to match
// nested macro arguments.
for (const body of [
    String.raw`(\(+\)*)+$`,
    String.raw`(\\+[a-z]*)+$`,
    String.raw`(\{+\}*)+!`,
    String.raw`(\[+a*)+$`,
]) {
    check(`punctuation-keyed blow-up refused: ${body}`, scanPatternIsTooSlow(new RegExp(body, 'i')))
}
// And the honest patterns made of the same characters must still pass, or the ladder
// has traded one broken review for another.
for (const body of [
    String.raw`\\includegraphics\s*(\[[^\]]*\])?\s*\{[^}]*\.(png|jpg)\}`,
    String.raw`\\cite\{[^}]+\}`,
    String.raw`\\begin\{(figure|table)\}`,
    String.raw`\((i{1,3}|iv|v)\)`,
]) {
    check(`honest LaTeX pattern survives: ${body}`, !scanPatternIsTooSlow(new RegExp(body, 'i')))
}

// ---------------------------------------------------------------------------
// a stored pathological pattern is skipped at LOAD, without killing the review
// ---------------------------------------------------------------------------
// Settings written by hand, restored from a backup or saved before the guard
// existed must not be able to reintroduce the freeze. parseScanPatterns is taken
// out of the real controller, exactly as the hints suite takes it.
const start = ctrl.indexOf('const FLOAT_ENVIRONMENTS')
const end = ctrl.indexOf('// overleaf-lab: split the rubric guidelines')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate parseScanPatterns in the controller')
    process.exit(1)
}
const warned = []
// eslint-disable-next-line no-new-func
const helpers = new Function(
    'logger',
    `${ctrl.slice(start, end)}; return { parseScanPatterns, documentTypePattern, documentTypeMatches }`
)({ debug() {}, warn: (obj, msg) => warned.push(msg) })

{
    const stored = `Document type :: ${AUDIT_PAYLOAD}\nAnglicismi :: \\b(performance)\\b\nWikipedia :: wikipedia`
    const t0 = Date.now()
    const patterns = helpers.parseScanPatterns(stored)
    const elapsed = Date.now() - t0
    check(
        'the pathological line is dropped, the honest ones are kept',
        patterns.length === 2 && patterns.every(p => !/Ingegneria/.test(p.regex.source)),
        patterns.map(p => p.label).join(', ')
    )
    check('and it is logged, not swallowed', warned.some(m => /backtrack/.test(m)), warned.join(' | '))
    check(
        'a rubric with no usable type pattern does not get one',
        helpers.documentTypePattern(patterns) === null
    )
    // TRIPWIRE, generous on purpose: the point is that dropping the pattern costs
    // hundreds of milliseconds ONCE, not that it costs any particular number. The
    // unguarded pattern on 44 bytes of student text took 67 SECONDS, per request.
    check('and finding out stays cheap', elapsed < 3000, `${elapsed}ms`)
}

{
    // The review still runs: the surviving patterns match what they should, and the
    // student text that used to be the payload is just text.
    const patterns = helpers.parseScanPatterns(`Document type :: ${AUDIT_PAYLOAD}\nWikipedia :: wikipedia`)
    const docs = [{ path: '/thesis.tex', text: `${'a'.repeat(44)}\nfonte: wikipedia` }]
    const t0 = Date.now()
    const hit = patterns.some(p => docs.some(d => p.regex.test(d.text)))
    const elapsed = Date.now() - t0
    check('the surviving pattern still matches the document', hit)
    check('and the payload text no longer freezes anything', elapsed < 200, `${elapsed}ms`)
}

// A benign rubric must not be slowed down by the guard at all: 20 patterns is the
// per-rubric cap, so this is the worst case a review ever pays.
{
    const text = BENIGN.concat(BENIGN).map((b, i) => `L${i} :: ${b}`).join('\n')
    const t0 = Date.now()
    const patterns = helpers.parseScanPatterns(text)
    const elapsed = Date.now() - t0
    check('a full rubric of honest patterns is kept', patterns.length === 20, `${patterns.length}`)
    check('and probing all of them is cheap', elapsed < 500, `${elapsed}ms`)
}

// ---------------------------------------------------------------------------
// the save endpoint refuses, in the shape the admin page renders
// ---------------------------------------------------------------------------
{
    const block = admin.slice(
        admin.indexOf("// overleaf-lab: validate each rubric's scan patterns"),
        admin.indexOf('// overleaf-lab: sanitize the action prompt overrides')
    )
    check('the save endpoint probes the pattern', /scanPatternIsTooSlow\(/.test(block))
    // Same shape as the refusal next to it (400 + a single `error` string), because
    // that is the only shape the admin page knows how to render.
    check(
        'and refuses it the way it refuses an uncompilable one',
        (block.match(/res\.status\(400\)\.json\(\{\s*error:/g) || []).length === 3,
        `${(block.match(/res\.status\(400\)\.json\(\{\s*error:/g) || []).length} refusals in the block`
    )
    check(
        'and the message names the problem',
        /nested quantifiers/.test(block) && /would freeze the review/.test(block)
    )
}

process.exit(ok ? 0 : 1)
