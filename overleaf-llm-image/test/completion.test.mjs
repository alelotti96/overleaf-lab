// Extract the REAL completion-cleaning helpers from the chat controller and pin
// the two behaviors the user sees: a suggestion must never retype what is already
// on screen, and must never loop the same sentence over and over.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.CHAT, 'utf8')
const start = src.indexOf('function trimEchoedOverlap(')
const end = src.indexOf('async function completion(')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the completion helpers in the chat controller')
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const { trimEchoedOverlap: trim, cutDegenerateRepetition: cut } = new Function(
    `${src.slice(start, end)}; return { trimEchoedOverlap, cutDegenerateRepetition }`
)()

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// The observed case: the model echoes the whole sentence before continuing.
check(
    'a full-sentence echo is cut',
    trim(
        "Sono un genio incompreso. Eppure non ho un'idea di come potrei aiutarti.",
        'Testo precedente. Sono un genio incompreso. Eppure',
        ''
    ) === " non ho un'idea di come potrei aiutarti."
)
// Retyping a half-typed word is the same overlap, and cutting it is what makes
// the completion insert correctly at the cursor.
check('a half-typed word completes without doubling', trim('lavagna nuova', 'scrive sulla la', '') === 'vagna nuova')
check('no overlap passes through untouched', trim('continua da qui', 'testo prima. ', '') === 'continua da qui')
check('an all-echo suggestion becomes empty', trim('Eppure', 'Sono qui. Eppure', '') === '')
// The right side: the model completes into text that already follows the cursor.
check(
    'text already after the cursor is not retyped',
    trim('fine della frase. Il paragrafo continua', '', 'Il paragrafo continua come prima.') === 'fine della frase. '
)
check('short punctuation shared with the right side survives', trim('parole nuove. ', '', '. Altro testo') === 'parole nuove. ')
check('empty inputs are safe', trim('', '', '') === '' && trim('x', '', '') === 'x')

// The degenerate loop observed live with a 1.5B coder model: the ghost text
// repeats one sentence forever, a sentence the document already contains.
check(
    'a suggestion looping one sentence is cut at the second copy',
    cut('Vediamo un caso nuovo. Ecco alcuni esempi. Ecco alcuni esempi. Ecco alcuni esempi.', 'Testo del documento.') ===
        'Vediamo un caso nuovo. Ecco alcuni esempi.'
)
check(
    'a sentence already on screen is never suggested again',
    cut('Ecco alcuni esempi per iniziare. Ecco alcuni esempi per iniziare.',
        'Eppure non ho alcune idee. Ecco alcuni esempi per iniziare. Ecco alcuni esempi per iniziare.') === ''
)
check(
    'normalisation catches case and spacing variants',
    cut('ECCO  alcuni esempi per iniziare!', 'testo. ecco alcuni esempi per iniziare. altro') === ''
)
check('honest prose passes through untouched', cut('Frase nuova. Poi un pensiero diverso. Infine la chiusura.', 'Testo prima.') ===
    'Frase nuova. Poi un pensiero diverso. Infine la chiusura.')
check('short repeated fragments are legitimate prose', cut('No. No. Va bene cosi.', '') === 'No. No. Va bene cosi.')
check('empty input is safe for the loop cutter', cut('', '') === '')

// ===========================================================================
// personal settings stay behind allowUserSettings
// ===========================================================================
// The completion handler resolves a user's own endpoint and key twice: once as an
// override, once as a fallback when the shared backend is unavailable. Both used to
// read those fields without checking Settings.llm.allowUserSettings, unlike the chat
// and the model list. The flag is what gates the routes that WRITE those fields, so
// reading them outside it honours an endpoint stored while bring-your-own-key was
// open, on an instance where it has since been closed - a fetch target the instance
// no longer controls.
//
// The handler cannot be sliced out (it awaits Mongo, Settings and the admin
// controller), so the guard is asserted on its source. A structural check, not a
// behavioural one, and it says so.
const cStart = src.indexOf('async function completion(')
const cEnd = src.indexOf('async function getFeatures(')
if (cStart === -1 || cEnd === -1 || cEnd <= cStart) {
    console.error('FAIL: could not locate the completion handler in the chat controller')
    process.exit(1)
}
const completionSrc = src.slice(cStart, cEnd)

check(
    'the completion handler reads the allowUserSettings flag',
    /allowPersonalSettings\s*=\s*!!\(\s*Settings\.llm && Settings\.llm\.allowUserSettings\s*\)/.test(
        completionSrc
    )
)

// Every personal-settings read has to sit behind it. Two lookups today; the check
// is written so a third one added later fails until it is gated too.
const lookups = completionSrc.split('User.findById(').slice(1)
check('the handler still resolves personal settings twice', lookups.length === 2, `found ${lookups.length}`)
let gated = 0
let cursor = 0
for (let i = 0; i < lookups.length; i++) {
    const at = completionSrc.indexOf('User.findById(', cursor)
    cursor = at + 1
    // The condition that guards the lookup is right above it: the `if` opens at
    // most a few lines before, so a window is enough and stays readable.
    if (completionSrc.slice(Math.max(0, at - 400), at).includes('allowPersonalSettings')) {
        gated += 1
    }
}
check('both personal-settings lookups are gated on the flag', gated === lookups.length, `${gated}/${lookups.length}`)

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
