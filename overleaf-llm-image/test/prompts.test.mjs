// The prompt-override contract: EMPTY means "follow the built-in default", and the
// admin page must never be able to freeze a copy of a default by just being saved.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../vendor/llm/app/src'
)
const prompts = await import(pathToFileURL(path.join(SRC, 'LLMPrompts.mjs')).href)

// overleaf-lab: the report is read by the AUTHOR of the document, who never sees the
// guidelines, the passes, or the internal finding a verification pass was handed. Both
// prompts must say so, because every time one of them did not, the evidence field
// filled up with process talk ("the original finding did not hold up", "I reformulate
// the evidence to be precise") that means nothing to the person holding the report.
let ok = true
const check = (name, cond, detail) => {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---- mergeActionPrompts ----
const defaults = prompts.DEFAULT_ASK_AI_ACTION_PROMPTS
let merged = prompts.mergeActionPrompts({})
check('no overrides -> all defaults', merged.paraphrase === defaults.paraphrase)

merged = prompts.mergeActionPrompts({ paraphrase: 'custom text' })
check('override applied', merged.paraphrase === 'custom text')
check('other keys untouched', merged.academic === defaults.academic)

merged = prompts.mergeActionPrompts({ paraphrase: '' })
check('empty string falls back to default', merged.paraphrase === defaults.paraphrase)
merged = prompts.mergeActionPrompts({ paraphrase: '   ' })
check('whitespace-only falls back too', merged.paraphrase === defaults.paraphrase)
merged = prompts.mergeActionPrompts(null)
check('null stored is safe', merged.summarize === defaults.summarize)
merged = prompts.mergeActionPrompts(['nope'])
check('array stored is ignored', merged.summarize === defaults.summarize)

// ---- the review prompt must carry the new contracts ----
const review = prompts.DEFAULT_REVIEW_SYSTEM_PROMPT
check('prompt states the FACTS/CANDIDATES split', /FACTS/.test(review) && /CANDIDATES/.test(review))
check('prompt covers captionless floats and orphan labels', /without a \\caption/.test(review) && /never referenced/.test(review))
check('prompt states the thin space is a separator', review.includes('thin space'))
check('prompt distinguishes a bare comma', /bare ","/.test(review))
check('prompt explains acronym macros', review.includes('\\acl{X}') && review.includes('\\acs{X}'))
// The LaTeX block must state FACTS and stop there. Saying that every acronym macro
// "is a definition" is both false (\acs prints the short form only) and a verdict,
// and it was observed flipping a real "acronym not defined at first use" to "ok".
check('prompt does not rule on what counts as defining an acronym', !/all three are definitions/.test(review))
check('prompt hands the acronym verdict to the guidelines', /for the guidelines to decide/.test(review))
check('prompt explains starred equation numbering', review.includes('equation*'))
check('prompt still forbids line/equation numbers', /NEVER mention line numbers/.test(review))

// ---- the admin display must not prefill defaults ----
const admin = fs.readFileSync(path.join(SRC, 'LLMAdminController.mjs'), 'utf8')
check(
    'display settings send the stored override only',
    /reviewSystemPrompt: settings\.reviewSystemPrompt \|\| ''/.test(admin) &&
        /askAiSystemPrompt: settings\.askAiSystemPrompt \|\| ''/.test(admin) &&
        /errorPrompt: settings\.errorPrompt \|\| ''/.test(admin)
)
check(
    'defaults are still sent separately for the placeholder',
    /promptDefaults: \{[\s\S]*reviewSystemPrompt: DEFAULT_REVIEW_SYSTEM_PROMPT/.test(admin)
)
check(
    'effective value still falls back to the default at use time',
    /reviewSystemPrompt: s\.reviewSystemPrompt \|\| DEFAULT_REVIEW_SYSTEM_PROMPT/.test(admin)
)

const page = fs.readFileSync(
    path.resolve(SRC, '../../frontend/js/components/llm-admin-settings-page.tsx'),
    'utf8'
)
check('the default is rendered as a placeholder', /placeholder=\{field\.def\}/.test(page))
check('reset clears instead of copying the default', /onClick=\{\(\) => field\.set\(''\)\}/.test(page))
check('no button copies the default text into the field', !/field\.set\(field\.def/.test(page))
check(
    'action templates use the placeholder contract too',
    /placeholder=\{promptDefaults\.askAiActionPrompts\?\.\[key\] \|\| ''\}/.test(page)
)

// ---- both prompts must name the reader ----
{
    const fs2 = await import('node:fs')
    const promptsSrc = fs2.readFileSync(
        process.env.CTRL.replace('LLMComplianceController.mjs', 'LLMPrompts.mjs'),
        'utf8'
    )
    const controllerSrc = fs2.readFileSync(process.env.CTRL, 'utf8')
    check('the review prompt names who reads the evidence', /WHO READS THIS/.test(promptsSrc))
    check('and sends the reasoning to the analysis field', /reasoning belongs in "analysis"/.test(promptsSrc))
    check('the verification prompt names the reader too', /WHO READS THE EVIDENCE/.test(controllerSrc))
    check(
        'and forbids narrating the finding it was given',
        /Never write "the finding"/.test(controllerSrc)
    )
    check(
        'and no longer invites the rejection story into the evidence',
        !/why the finding was rejected/.test(controllerSrc)
    )
}

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
