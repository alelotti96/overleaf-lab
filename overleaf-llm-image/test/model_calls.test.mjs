// What the code ASKS the model, and what it does with the answer that comes back.
//
// Everything here is a seam between one model call and the item it becomes: the number
// of answers a batched call is allowed to return, which question each answer belongs
// to, whether a call is reproducible, and the sentences the code writes around what it
// got. A mistake in any of them is invisible in the report - the verdict looks like
// every other verdict - which is why they are pinned by name.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.CTRL, 'utf8')

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

function slice(from, to, what) {
    const start = src.indexOf(from)
    const end = src.indexOf(to, start)
    if (start === -1 || end === -1 || end <= start) {
        console.error(`FAIL: could not locate ${what}`)
        process.exit(1)
    }
    return src.slice(start, end)
}

// ===========================================================================
// the schemas and the answer mapping
// ===========================================================================
// eslint-disable-next-line no-new-func
const s = new Function(
    `${slice('const REVIEW_ITEMS_SCHEMA', 'const REVIEW_SUMMARY_SCHEMA', 'the schemas')};
     return { REVIEW_ITEMS_SCHEMA, CANDIDATE_ITEMS_SCHEMA, schemaForBatch, reconcileAnswers, CANDIDATES_PER_CALL }`
)()

{
    const pinned = s.schemaForBatch(s.CANDIDATE_ITEMS_SCHEMA, 7)
    check(
        'a batched schema pins the answer count both ways',
        pinned.properties.items.minItems === 7 && pinned.properties.items.maxItems === 7,
        JSON.stringify(pinned.properties.items).slice(0, 120)
    )
    check(
        'the item shape is carried over untouched',
        pinned.properties.items.items === s.CANDIDATE_ITEMS_SCHEMA.properties.items.items
    )
    check(
        'and the shared constant is not mutated',
        s.CANDIDATE_ITEMS_SCHEMA.properties.items.minItems === undefined,
        'every call of a run reads these, so pinning one call must not pin the next'
    )
    check(
        'the review schema takes the same treatment',
        s.schemaForBatch(s.REVIEW_ITEMS_SCHEMA, 5).properties.items.maxItems === 5
    )
    check(
        'the model is still required to say which candidate it is answering about',
        s.CANDIDATE_ITEMS_SCHEMA.properties.items.items.required.includes('index')
    )
}

// A model that skips one candidate used to shift every later verdict onto the wrong
// passage: the quoted sentence and the reason attached to it came from two different
// candidates, which reads as an accusation about a sentence nobody judged.
{
    const answers = [
        { index: 1, violates: 'no', reason: 'a' },
        { index: 3, violates: 'yes', reason: 'c' },
    ]
    const resolved = s.reconcileAnswers(answers, 3)
    check('an answer goes to the candidate it names', resolved.get(2) === answers[1])
    check('and the skipped one stays unanswered', resolved.get(1) === undefined)
    check('rather than borrowing its neighbour', resolved.get(0) === answers[0])
}
{
    // The old behaviour is still the fallback: a model that emits no usable index is
    // answering in order, and that is a contract too.
    const answers = [{ violates: 'no' }, { violates: 'yes' }, { violates: 'no' }]
    const resolved = s.reconcileAnswers(answers, 3)
    check(
        'no index at all falls back to position',
        resolved.get(0) === answers[0] && resolved.get(1) === answers[1] && resolved.get(2) === answers[2]
    )
}
{
    const answers = [{ index: 99, violates: 'yes' }, { index: 0, violates: 'yes' }]
    const resolved = s.reconcileAnswers(answers, 2)
    check(
        'an index outside the batch is not trusted, it is positioned',
        resolved.get(0) === answers[0] && resolved.get(1) === answers[1],
        'the alternative is dropping an answer the model did give'
    )
}
{
    const answers = [{ index: 2, violates: 'yes' }, { index: 2, violates: 'no' }]
    const resolved = s.reconcileAnswers(answers, 3)
    check('a repeated index is claimed once', resolved.get(1) === answers[0])
    check(
        'and the duplicate does not overwrite an explicit claim',
        resolved.get(0) === undefined && resolved.get(2) === undefined,
        JSON.stringify([...resolved.keys()])
    )
}
{
    const answers = [{ violates: 'no' }, { index: 1, violates: 'yes' }]
    const resolved = s.reconcileAnswers(answers, 2)
    check(
        'an explicit index wins over the positional answer for the same slot',
        resolved.get(0) === answers[1],
        'the index is the model saying which question it answered; the position is our guess'
    )
}
check('a batch that answered nothing maps nothing', s.reconcileAnswers([], 4).size === 0)

// ===========================================================================
// which calls are allowed to be nondeterministic
// ===========================================================================
// Sampling exists in this file for ONE reason: to feed the 2+1 chapter vote. A single
// sample at the voting temperature is that vote's noise with none of its consensus.
{
    const candidates = slice(
        'if (step.scope === \'candidates\')',
        'if (step.scope === \'chapter\')',
        'the candidates branch'
    )
    check(
        'the per-candidate call is deterministic',
        /temperature: 0,/.test(candidates) && !/VOTE_TEMPERATURE/.test(candidates),
        'closed questions with the passage in front of the model, judged once'
    )
    check(
        'and it pins the answer count to the batch it sent',
        /schemaForBatch\(CANDIDATE_ITEMS_SCHEMA, batch\.length\)/.test(candidates)
    )
    check(
        'the progress label is mirrored when it changes',
        /job\.currentRequirement = requirement[\s\S]{0,400}?mirrorProgress\(\)/.test(candidates),
        'the dashboard reads the mirrored copy, not the job'
    )
    const chapter = slice(
        'if (step.scope === \'chapter\')',
        'overleaf-lab: [per-file] branch',
        'the chapter branch'
    )
    check(
        'the chapter vote still samples, because it votes',
        /temperature: CHAPTER_VOTE_SAMPLES > 1 \? VOTE_TEMPERATURE : 0,/.test(chapter)
    )
    check(
        'and its grouped call pins one answer per guideline',
        /schemaForBatch\(REVIEW_ITEMS_SCHEMA, groupRequirements\.length\)/.test(chapter)
    )
    check(
        'the summary sentence is reproducible too',
        /temperature: 0,/.test(slice('You summarize the outcome', 'compliance_summary', 'the summary body')),
        'prose glue, never a verdict, but there is no reason for it to move between runs'
    )
}

// ===========================================================================
// the split-vote marker reaches the reader in the report's own language
// ===========================================================================
// Both readers match this marker by regex, so the two spellings are a contract: the
// exact strings below are what the HTML report and the pane have to look for.
{
    const chapter = slice(
        'A split vote is exactly the borderline judgement',
        'const result = {',
        'the split-vote marker'
    )
    check(
        'the marker is written through L()',
        /L\(\s*` \[verdict agreed by \$\{agreeing\} of \$\{samples\.length\} readings\]`/.test(chapter),
        'an English marker in an Italian report is what the badge used to show'
    )
    check(
        'and the Italian spelling is exactly this one',
        /` \[verdetto concorde in \$\{agreeing\} letture su \$\{samples\.length\}\]`/.test(chapter),
        'changing it silently breaks the badge in both readers'
    )
}

// ===========================================================================
// a refusal on the click speaks the rubric's language
// ===========================================================================
{
    const start = slice('async function startReview', 'const job = {', 'startReview')
    check(
        'the language is taken from the rubric that was asked for',
        /const rubricLang = detectRubricLanguage\(rubric\.guidelines\)/.test(start)
    )
    check(
        'the queue refusal is localized',
        /error: 'queue_full',[\s\S]{0,120}inLanguage\(\s*rubricLang/.test(start),
        'the rest of the flow answers in the rubric language; this was the one English sentence left'
    )
    check(
        'so is the unconfigured-backend refusal',
        /error: 'not_configured',[\s\S]{0,120}inLanguage\(\s*rubricLang/.test(start)
    )
    check(
        'and the module-global report language is still not touched here',
        !/setReportLanguage\(/.test(start),
        'this runs outside any review: the global belongs to whatever job is running'
    )
}

// ===========================================================================
// the pass planner may not ask itself the same question twice
// ===========================================================================
// A [check:] the deployment switched off falls back to the scope declared under it.
// Reading that scope by RE-ENTERING requirementScope with the marker stripped is what
// made a rubric with example lines take the whole review down: the marker is anchored
// to the end of the text, the example lines are past it, the strip did nothing and the
// call recursed on its own argument. The fallback is computed here instead, once.
{
    const scope = slice('function requirementScope(', 'function stripScopeMarker(', 'requirementScope')
    check(
        'the fallback scope is computed, not recursed',
        !/requirementScope\(/.test(scope.slice(scope.indexOf('{'))),
        'the marker it would strip first is not at the end of a requirement that carries examples'
    )
}

// ===========================================================================
// the verification pass, as it is wired
// ===========================================================================
// resolveVerifiedStatus is unit-tested next door (evidence_check); what is pinned here
// is that the caller hands it the three things the gate needs and acts on all three
// answers, because each of them was a live hole: the finding's own status (without it
// the gate cannot tell an overturn from an agreement), a grounding that counts what the
// verifier SHOWED and not merely what it failed to get wrong, and the fabrication check
// applied to the replacement before it is allowed to replace anything.
{
    const verify = slice(
        'const verifiedEvidence = repairJsonEscapeArtifacts',
        'job.passesDone += 1',
        'the verification result handling'
    )
    check(
        'the gate is told what the finding said before the double-check',
        /resolveVerifiedStatus\(\s*verified,[\s\S]{0,200}?finding\.status\s*\)/.test(verify),
        'without it the gate cannot tell an overturn from an agreement'
    )
    check(
        'showing nothing is not grounding',
        /verifierGrounding\.checked > 0 && verifierGrounding\.missing === 0/.test(verify),
        'a verifier with no quotes at all was counted as grounded, which is how prose closed findings'
    )
    check(
        'the replacement faces the fabrication check first',
        /demoteFabricatedResult\(\s*replacement,/.test(verify)
    )
    check(
        'a fabricated replacement does not replace anything',
        /if \(\s*demoteFabricatedResult\(/.test(verify) && /allItems\[idx\] = replacement/.test(verify),
        'the finding it would have replaced still has its own evidence, and that is the better of the two'
    )
    check(
        'and only a disagreement is reported as one',
        /if \(resolved\.status !== finding\.status\)/.test(verify),
        'a verifier that agrees, badly, is not a verifier that disagreed'
    )
    check(
        'a refused overturn leaves its note on the finding',
        /else if \(resolved\.note\)/.test(verify) && /finding\.evidence = clip\(/.test(verify)
    )
}
{
    // M5: which haystacks may keep a finding alive is decided per finding, and the
    // hints and skeleton are not among them once the evidence names a file.
    const sources = slice(
        'const quoteSources = [normalizedSource, rawSource]',
        'const perFileOrigin',
        'the quote sources'
    )
    check(
        'the file-anchored haystacks exclude the hints and the skeleton',
        /const documentQuoteSources = \[\.\.\.searchIndexes\.map\(index => index\.normalized\), rawSource\]/.test(
            sources
        ),
        'they are built from the per-file indexes, so the project is not normalised a third time'
    )
    check(
        'and the picker is what every demotion uses',
        (src.match(/quoteSourcesFor\(/g) || []).length === 3 &&
            !/demoteFabricatedResult\(result, quoteSources\)/.test(src),
        `${(src.match(/quoteSourcesFor\(/g) || []).length} call sites: the two unit branches and the verifier`
    )
    check(
        'including the whole-document pass, which picks per item',
        /dropFabricatedItems\(passItems, quoteSourcesFor\)/.test(src)
    )
}
{
    // M4: a chapter whose evidence was thrown away is a chapter nobody assessed. The
    // exemption that kept it out of the tally is what let a requirement come back "ok"
    // with no trace that the chapter carrying its material had its answer discarded.
    const chapter = slice(
        'And an n.a. from a chapter that HOLDS the material',
        'results.push(result)',
        'the unassessed rule'
    )
    check(
        'a demoted chapter is counted as unassessed like any other n.a.',
        /if \(result\.status === 'na'\) \{/.test(chapter) && !/!result\.fabricated/.test(chapter),
        'a chapter whose evidence was thrown away is a chapter nobody assessed'
    )
}
{
    // m9: the invented line numbers are compared, never corrected, and only when the
    // reader has the derived location in front of them.
    const final = slice(
        'const locations = locateEvidence(item.evidence, searchIndexes)',
        '// overleaf-lab: synthesize the overall summary',
        'the final location loop'
    )
    check(
        'the note is only written when a real location exists',
        /if \(locations\.length > 0\) \{[\s\S]*?\n\s*if \(INVENTED_LINE_CLAIM\.test\(item\.evidence\)\) \{/.test(
            final
        ),
        'a note comparing two numbers needs both of them in front of the reader'
    )
    check(
        'and it really is written',
        /item\.evidence \+= L\(\s*' \[line numbers written in this text are the model/.test(final),
        'the reader is told which of the two numbers came from the file'
    )
    check(
        'and the prose itself is left as the model wrote it',
        !/replace\(INVENTED_LINE_CLAIM/.test(final),
        'a search-and-replace over prose in two languages is guesswork on the field the reader trusts'
    )
}

// ===========================================================================
// LanguageTool: the mistakes themselves, where a reader will find them
// ===========================================================================
// The findings were stored only in locations[].what, and both readers print a location
// as a bare path:line, so a student was told they had N spelling mistakes with no way
// to learn a single one of them - under a sentence claiming the first twenty were
// listed. They are folded into the evidence the way every structural check lists its
// own findings.
{
    const lt = slice('const LANGUAGETOOL_LOCATIONS', 'function buildStructuralFacts', 'the LanguageTool item')
    const helpers = slice(
        'function foldForMatch(',
        '// overleaf-lab: split the rubric guidelines',
        'the helpers'
    )
    // eslint-disable-next-line no-new-func
    const t = new Function(
        'languageToolCheck',
        'logger',
        'VERIFY_MAX_FINDINGS',
        `${helpers}\n${lt}\n; return { runLanguageToolItem, setReportLanguage, LANGUAGETOOL_LOCATIONS }`
    )
    const matches = n =>
        Array.from({ length: n }, (_, i) => ({
            file: `/cap${i + 1}.tex`,
            line: 10 + i,
            message: 'Possibile errore di battitura',
            excerpt: `paola${i + 1}`,
            suggestion: `parola${i + 1}`,
        }))
    const build = report =>
        t(async () => report, { debug() {}, info() {}, warn() {}, error() {} }, 8)

    {
        const h = build({
            ok: true,
            language: 'it',
            files: 3,
            totals: { kept: 2, droppedByWhitelist: 0, chunksSkipped: 0 },
            matches: matches(2),
        })
        h.setReportLanguage('it')
        const item = await h.runLanguageToolItem('4. Nessun errore.', [], 'it', undefined, 'p1')
        check('mistakes are reported as a violation', item.status === 'missing')
        check(
            'and each one is readable in the evidence',
            /\/cap1\.tex:10 - Possibile errore di battitura "paola1" -> parola1/.test(item.evidence),
            item.evidence
        )
        check('every shown mistake is listed', /\/cap2\.tex:11 - /.test(item.evidence), item.evidence)
        check(
            'the locations stay populated for the group-by-file view',
            item.locations.length === 2 && item.locations[0].what.includes('parola1')
        )
        check('the item is still decided by code', item.decidedByCode === true)
    }
    {
        // The cap: the sentence says how many are not shown, and what it shows is what
        // it says it shows.
        const h = build({
            ok: true,
            language: 'it',
            files: 9,
            totals: { kept: 45, droppedByWhitelist: 0, chunksSkipped: 0 },
            matches: matches(45),
        })
        h.setReportLanguage('en')
        const item = await h.runLanguageToolItem('4. No spelling errors.', [], 'it', undefined, 'p1')
        check(
            'the count and the list agree',
            /The first 20 are listed; 25 more are not\./.test(item.evidence),
            item.evidence.slice(0, 160)
        )
        check(
            'and the twentieth is really there',
            /\/cap20\.tex:29 - /.test(item.evidence) && !/\/cap21\.tex/.test(item.evidence)
        )
    }
    {
        const h = build({
            ok: true,
            language: 'it',
            files: 3,
            totals: { kept: 0, droppedByWhitelist: 0, chunksSkipped: 0 },
            matches: [],
        })
        h.setReportLanguage('en')
        const item = await h.runLanguageToolItem('4. No spelling errors.', [], 'it', undefined, 'p1')
        check('a clean document lists nothing', item.status === 'ok' && item.locations.length === 0)
    }
    {
        const h = build({ ok: false, error: 'connect ECONNREFUSED', totals: {} })
        h.setReportLanguage('en')
        const item = await h.runLanguageToolItem('4. No spelling errors.', [], 'it', undefined, 'p1')
        check(
            'an outage is still "not checked", never "nothing found"',
            item.status === 'na' && /did not answer/.test(item.evidence)
        )
    }
}

console.log(ok ? '\nmodel_calls: all good' : '\nmodel_calls: FAILURES')
process.exit(ok ? 0 : 1)
