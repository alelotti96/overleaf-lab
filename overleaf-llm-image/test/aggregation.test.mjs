// How a requirement is SCOPED and how per-chapter votes are aggregated: the rubric
// markers, the contrastive examples, the two rules that stop an n.a. and a stray ok
// from deciding a requirement between them, and the file accounting of the policy
// exclusion.
//
// Every case here is a verdict that was measured wrong on a real project, or the honest
// verdict next to it that the fix must not break.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.CTRL, 'utf8')
const start = src.indexOf('function foldForMatch(')
const end = src.indexOf('// overleaf-lab: split the rubric guidelines')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the helpers')
    process.exit(1)
}
// The scope of a [check:] requirement depends on whether the deployment has that
// check switched on, and LanguageTool is the one that can be: the flag is injected so
// both deployments can be tested in one process.
let languageToolOn = false
// eslint-disable-next-line no-new-func
const h = new Function(
    'VERIFY_MAX_FINDINGS',
    'isLanguageToolEnabled',
    `${src.slice(start, end)}; return {
        requirementScope, stripScopeMarker, stripCheckMarker, requirementCheck,
        requirementCandidateLabel, isWholeDocumentRequirement, requirementExamples,
        stripExampleLines, exampleBlock, requirementWithExamples, requirementMaterial,
        countMaterial, applyVacuousRequirement, mergeFileItems, buildPassPlan,
        excludeUnreviewedSegments, extendToHeadingBookkeeping, segmentChapters,
        setReportLanguage
    }`
)(8, () => languageToolOn)

const R = String.raw
let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

h.setReportLanguage('en')

// ===========================================================================
// [example-violation:] / [example-compliant:], and the markers underneath them
// ===========================================================================
// splitRubric folds the lines under a requirement into it, so by the time any marker is
// read the requirement text ENDS with its examples. Every end-anchored marker would be
// lost if the examples were not taken out first, which would silently turn a
// per-chapter requirement into a whole-document pass.
const WITH_EXAMPLES = [
    '1. The report is written in the third person. [per-chapter]',
    '[example-violation: "Definiamo la grandezza": first person plural.]',
    '[example-compliant: "Si definisce la grandezza".]',
].join('\n')

check('the scope survives the examples', h.requirementScope(WITH_EXAMPLES) === 'chapter')
check(
    'the check marker survives the examples',
    h.requirementCheck('6. Every figure has a caption. [check: float-caption]\n[example-violation: a figure with no \\caption.]') ===
        'float-caption'
)
check(
    'the candidate marker survives the examples',
    h.requirementCandidateLabel(
        '24. No qualitative claim without data. [per-candidate: Qualitative expressions]\n[example-violation: "molto buono" with no number.]'
    ) === 'Qualitative expressions'
)
{
    const examples = h.requirementExamples(WITH_EXAMPLES)
    check(
        'both kinds are parsed',
        examples.violation.length === 1 && examples.compliant.length === 1,
        JSON.stringify(examples)
    )
    check('the violation keeps its text', /first person plural/.test(examples.violation[0]))
}
{
    const many = [
        '1. R.',
        '[example-violation: one]',
        '[example-violation: two]',
        '[example-violation: three]',
    ].join('\n')
    check('at most two of each kind ride along', h.requirementExamples(many).violation.length === 2)
}
check(
    'the examples never reach the requirement text',
    h.stripScopeMarker(WITH_EXAMPLES) === '1. The report is written in the third person.',
    h.stripScopeMarker(WITH_EXAMPLES)
)
{
    const stripped = h.stripScopeMarker(WITH_EXAMPLES)
    const prompt = h.requirementWithExamples(WITH_EXAMPLES, stripped)
    check('the requirement comes first', prompt.startsWith(stripped))
    check('the examples come after it', /EXAMPLES for this requirement only:/.test(prompt))
    check('the violation is labelled as one', /this violates the requirement: /.test(prompt))
    check('the compliant one too', /this complies: /.test(prompt))
    check(
        'a requirement without examples is passed through byte for byte',
        h.requirementWithExamples('4. No spelling errors. [per-chapter]', '4. No spelling errors.') ===
            '4. No spelling errors.',
        'anything added here would move the guidelines, never the cached document block'
    )
}

// ===========================================================================
// [whole-document]
// ===========================================================================
// Measured: a requirement about how the report is organised overall, marked
// [per-chapter], was answered chapter by chapter and the worst chapter decided it.
check('the marker is recognised', h.isWholeDocumentRequirement('32. The activities are described in detail. [whole-document]'))
check(
    'it wins over the scope the rubric already carried',
    h.requirementScope('32. The activities are described in detail. [per-chapter] [whole-document]') ===
        'document'
)
check(
    'it wins over [structure] too',
    h.requirementScope('30. The report opens with the three parts. [structure] [whole-document]') ===
        'document'
)
check(
    'the overridden marker does not come back',
    h.stripScopeMarker('32. The activities are described in detail. [per-chapter] [whole-document]') ===
        '32. The activities are described in detail.',
    h.stripScopeMarker('32. The activities are described in detail. [per-chapter] [whole-document]')
)
check(
    'a parser check still wins: it never reaches a model',
    h.requirementScope('34. There is a bibliography. [check: has-bibliography] [whole-document]') === 'code'
)

// ===========================================================================
// [check: languagetool] where the deployment has no LanguageTool
// ===========================================================================
// A check the deployment switched off is not a check: the requirement goes back to the
// model under the scope it declares underneath. Reading that scope means looking past
// the check marker, and the marker is anchored to the END of the requirement - which is
// not where it sits as soon as example lines follow it. The version that stripped it
// from the end of the whole text stripped nothing and re-entered itself with the same
// string: RangeError, inside the pass planner, so EVERY review against that rubric died
// with a generic "the review request failed". The rubric line below is the shipped
// shape of requirement 4 in all five rubrics.
{
    const REQ_WITH_EXAMPLES = [
        '4. No evident spelling or grammar errors. [per-chapter] [check: languagetool]',
        '[example-violation: "the results is shown": wrong agreement.]',
        '[example-compliant: "the results are shown".]',
    ].join('\n')
    languageToolOn = false
    let scope = null
    let threw = null
    try {
        scope = h.requirementScope(REQ_WITH_EXAMPLES)
    } catch (err) {
        threw = err
    }
    check(
        'a disabled check under example lines does not recurse',
        threw === null,
        threw && `${threw.constructor.name}: ${threw.message}`
    )
    check('and falls back to the scope underneath it', scope === 'chapter', String(scope))
    languageToolOn = true
    check(
        'the same line with LanguageTool on is decided by code',
        h.requirementScope(REQ_WITH_EXAMPLES) === 'code'
    )
    languageToolOn = false
    check(
        'the check is still read through the example lines',
        h.requirementCheck(REQ_WITH_EXAMPLES) === 'languagetool'
    )
    check(
        'and the marker is stripped from the line it sits on',
        h.stripCheckMarker(REQ_WITH_EXAMPLES).split('\n')[0] ===
            '4. No evident spelling or grammar errors. [per-chapter]',
        h.stripCheckMarker(REQ_WITH_EXAMPLES).split('\n')[0]
    )
    check(
        'the same requirement without examples is unchanged',
        h.requirementScope('4. No evident spelling errors. [per-chapter] [check: languagetool]') ===
            'chapter'
    )
    check(
        'a disabled check over a [per-file] fallback still says file',
        h.requirementScope(
            '4. No spelling errors. [per-file] [check: languagetool]\n[example-violation: a typo.]'
        ) === 'file'
    )
    check(
        'a disabled check with no scope underneath is a whole-document pass',
        h.requirementScope('4. No spelling errors. [check: languagetool]\n[example-violation: a typo.]') ===
            'document'
    )
    check(
        'and [per-candidate] under a disabled check is still per-candidate',
        h.requirementScope(
            '4. Colloquialisms. [per-candidate: Colloquialisms] [check: languagetool]\n[example-violation: "un sacco di".]'
        ) === 'candidates'
    )
    check(
        'the pass plan counts it as a chapter requirement, not as a free check',
        h.buildPassPlan([REQ_WITH_EXAMPLES], { fileCount: 3, segmentCount: 4 })[0].passes === 4
    )
}
check(
    'and it survives its own examples',
    h.requirementScope('32. Activities. [per-chapter] [whole-document]\n[example-violation: a bare list.]') ===
        'document'
)
{
    const plan = h.buildPassPlan(
        [
            '1. Third person. [per-chapter]',
            '32. The activities are described in detail. [per-chapter] [whole-document]',
        ],
        { fileCount: 4, segmentCount: 11 }
    )
    const whole = plan.find(step => step.indexes[0] === 1)
    check(
        'it costs one pass over the document, not one per chapter',
        whole && whole.scope === 'document' && whole.passes === 1,
        JSON.stringify(plan)
    )
}

// ===========================================================================
// which material a requirement is about
// ===========================================================================
// The association is the LaTeX vocabulary the rubric and the sources share, so it works
// in either language and knows nothing about any rubric.
check(
    'a requirement naming lstlisting is about listings',
    h
        .requirementMaterial('35. Il codice è inserito come testo (lstlisting/verbatim), e mai come immagine. [per-chapter]')
        .map(m => m.kind)
        .includes('listings')
)
check(
    'a requirement naming \\includegraphics is about figures',
    h
        .requirementMaterial('11. I grafici sono leggibili: segnala un \\includegraphics ridotto con scale. [per-chapter]')
        .map(m => m.kind)
        .includes('figures')
)
check(
    'a requirement naming an equation is about equations',
    h
        .requirementMaterial('16. Every term appearing in an equation is defined in the text. [per-chapter]')
        .map(m => m.kind)
        .includes('equations')
)
check(
    'a requirement naming no LaTeX has no material',
    h.requirementMaterial('5. Very long sentences are split into shorter ones. [per-chapter]').length === 0,
    'and both rules below are then inert, which is the safe default'
)
check(
    'the count is exhaustive over the text',
    h.countMaterial(h.requirementMaterial('35. Code as text (lstlisting/verbatim).'), R`\begin{lstlisting}
    x = 1
    \end{lstlisting}`) === 1
)
check(
    'a project with no listings counts zero',
    h.countMaterial(
        h.requirementMaterial('35. Code as text (lstlisting/verbatim).'),
        'The chapter mentions Python and TensorFlow but shows no code.'
    ) === 0
)

// ===========================================================================
// a requirement about material the project does not contain
// ===========================================================================
// Measured on the same project with two different models: zero code listings anywhere,
// every chapter n.a. except one stray "ok" with nothing behind it, and the aggregate
// came back ok on one run and na on the next.
const VACUOUS = '35. Il codice è inserito come testo (lstlisting/verbatim).'
const noQuotes = () => false
{
    const results = [
        { path: 'Front matter', status: 'na', evidence: 'no code here' },
        { path: 'Acronimi', status: 'na', evidence: 'no code here' },
        { path: 'Conclusioni', status: 'ok', evidence: 'nessun blocco di codice trovato' },
    ]
    const merged = h.mergeFileItems(VACUOUS, results, 'chapters')
    check('the stray ok wins the merge as it always did', merged.status === 'ok')
    const applied = h.applyVacuousRequirement(merged, results, h.requirementMaterial(VACUOUS), 0, noQuotes)
    check('and is then recomputed to na', applied && merged.status === 'na', merged.status)
    check('with the reason in the evidence', /not applicable: the project contains none/.test(merged.evidence))
}
{
    // The same shape, but the chapter that voted ok can point at the document: that is a
    // vote about something, and it stands.
    const results = [
        { path: 'Chapter 1', status: 'na', evidence: 'nothing here' },
        { path: 'Chapter 2', status: 'ok', evidence: '/c2.tex: "the listing is set as text"' },
    ]
    const merged = h.mergeFileItems(VACUOUS, results, 'chapters')
    h.applyVacuousRequirement(merged, results, h.requirementMaterial(VACUOUS), 0, r =>
        /"/.test(r.evidence)
    )
    check('a chapter that quotes the sources keeps its ok', merged.status === 'ok')
}
{
    const results = [{ path: 'Chapter 1', status: 'ok', evidence: 'all listings are text' }]
    const merged = h.mergeFileItems(VACUOUS, results, 'chapters')
    h.applyVacuousRequirement(merged, results, h.requirementMaterial(VACUOUS), 3, noQuotes)
    check('material in the project keeps the ok', merged.status === 'ok')
}
{
    const results = [{ path: 'Chapter 1', status: 'missing', evidence: 'a screenshot of code' }]
    const merged = h.mergeFileItems(VACUOUS, results, 'chapters')
    h.applyVacuousRequirement(merged, results, h.requirementMaterial(VACUOUS), 0, noQuotes)
    check('a violation is never turned into na', merged.status === 'missing')
}
{
    const req = '5. Very long sentences are split into shorter ones.'
    const results = [{ path: 'Chapter 1', status: 'ok', evidence: 'sentences are short' }]
    const merged = h.mergeFileItems(req, results, 'chapters')
    h.applyVacuousRequirement(merged, results, h.requirementMaterial(req), 0, noQuotes)
    check('a requirement about prose is untouched', merged.status === 'ok')
}

// ===========================================================================
// an n.a. from the chapter that holds the material
// ===========================================================================
// Measured: the chapter that CONTAINED the defect answered n.a., the merge ignores n.a.
// by design, and the requirement came out ok.
{
    const results = [
        { path: 'Introduction', status: 'ok', evidence: 'every term is defined' },
        { path: 'Projection Operator', status: 'na', evidence: 'not applicable here', unassessed: 7 },
    ]
    const merged = h.mergeFileItems('16. Every term in an equation is defined.', results, 'chapters')
    check('the merge still ignores the na', merged.status === 'ok')
    check(
        'but the report names the chapter nobody judged',
        /Not assessed in 1 chapter that does contain the material/.test(merged.evidence),
        merged.evidence
    )
    check('and says which one', /Projection Operator/.test(merged.evidence))
}
{
    // The same sentence with more than one chapter: the singular above is a fix, not a
    // rewrite, and "1 chapters" is what it replaced.
    const results = [
        { path: 'Introduction', status: 'ok', evidence: 'every term is defined' },
        { path: 'Chapter 2', status: 'na', evidence: 'not applicable here', unassessed: 3 },
        { path: 'Chapter 3', status: 'na', evidence: 'not applicable here', unassessed: 5 },
    ]
    const merged = h.mergeFileItems('16. Every term in an equation is defined.', results, 'chapters')
    check(
        'two chapters keep the plural',
        /Not assessed in 2 chapters that do contain the material/.test(merged.evidence),
        merged.evidence
    )
}
{
    // Italian is where the bug was read: "Non valutato in 1 capitoli che contengono".
    h.setReportLanguage('it')
    const one = h.mergeFileItems(
        '16. Ogni termine di una equazione è definito.',
        [
            { path: 'Introduzione', status: 'ok', evidence: 'tutti i termini sono definiti' },
            { path: 'Operatore di proiezione', status: 'na', evidence: 'non applicabile', unassessed: 7 },
        ],
        'chapters'
    )
    check(
        'the Italian singular agrees',
        /Non valutato in 1 capitolo che contiene il materiale/.test(one.evidence),
        one.evidence
    )
    const two = h.mergeFileItems(
        '16. Ogni termine di una equazione è definito.',
        [
            { path: 'Introduzione', status: 'ok', evidence: 'tutti i termini sono definiti' },
            { path: 'Capitolo 2', status: 'na', evidence: 'non applicabile', unassessed: 3 },
            { path: 'Capitolo 3', status: 'na', evidence: 'non applicabile', unassessed: 5 },
        ],
        'chapters'
    )
    check(
        'and the Italian plural is unchanged',
        /Non valutato in 2 capitoli che contengono il materiale/.test(two.evidence),
        two.evidence
    )
    const dissent = h.mergeFileItems(
        '16. Ogni termine di una equazione è definito.',
        [
            { path: '/uno.tex', status: 'missing', evidence: 'manca la definizione di $f_0$' },
            { path: '/due.tex', status: 'ok', evidence: 'tutto definito' },
        ],
        'files'
    )
    check(
        'one dissenting unit is not "1 file su 2" in the plural sense either',
        /^1 file su 2:/.test(dissent.evidence),
        dissent.evidence
    )
    h.setReportLanguage('en')
}

// ===========================================================================
// a chapter whose evidence was thrown away is NOT part of the n.a. tally
// ===========================================================================
// Measured shape: a requirement came back "ok, 7/12 chapters ok, 5 n.a." after the one
// chapter that carried its material had its answer discarded for fabricated evidence.
// The demotion is invisible in that sentence, so the reader cannot tell a clean
// requirement from one whose only finding was thrown away.
{
    const results = [
        { path: 'Chapter 1', status: 'ok', evidence: 'every term is defined' },
        { path: 'Chapter 2', status: 'na', evidence: 'no equations in this chapter' },
        {
            path: 'Chapter 3',
            status: 'na',
            evidence: 'the text says $f_0$ is undefined [finding dropped: ...]',
            fabricated: true,
            unassessed: 9,
        },
    ]
    const merged = h.mergeFileItems('16. Every term in an equation is defined.', results, 'chapters')
    check('the merged verdict is still ok', merged.status === 'ok', merged.status)
    check(
        'the discarded chapter is named as such',
        /1 not assessed \(evidence discarded: Chapter 3\)/.test(merged.evidence),
        merged.evidence
    )
    check(
        'and it is not counted among the n.a.',
        /1 n\.a\. \(Chapter 2\)/.test(merged.evidence),
        merged.evidence
    )
    h.setReportLanguage('it')
    const italian = h.mergeFileItems(
        '16. Ogni termine di una equazione è definito.',
        results,
        'chapters'
    )
    check(
        'the Italian sentence agrees with its own count',
        /1 non valutato \(prove scartate: Chapter 3\)/.test(italian.evidence),
        italian.evidence
    )
    h.setReportLanguage('en')
}
{
    const results = [
        { path: 'Introduction', status: 'ok', evidence: 'every term is defined' },
        { path: 'Conclusions', status: 'na', evidence: 'no equations in this chapter' },
    ]
    const merged = h.mergeFileItems('16. Every term in an equation is defined.', results, 'chapters')
    check(
        'a chapter with nothing to judge is not reported',
        !/Not assessed/.test(merged.evidence),
        merged.evidence
    )
}

// ===========================================================================
// the file accounting of the acknowledgements exclusion
// ===========================================================================
// Measured: the same policy exclusion produced two different reports. One project's
// acknowledgements file was named as not reviewed; the other opened with
// \addcontentsline on the line above \chapter*, and that one surviving line kept the
// file in the list of files the review says it read.
const ACK_AFTER = R`\addcontentsline{toc}{chapter}{Ringraziamenti}
\chapter*{Ringraziamenti}
Grazie a tutti quelli che mi hanno sopportato in questi anni.`
const ACK_FIRST = R`\chapter*{Ringraziamenti}
\addcontentsline{toc}{chapter}{Ringraziamenti}
Grazie a tutti quelli che mi hanno sopportato in questi anni.`
const BODY = { path: '/main.tex', text: R`\chapter{Introduzione}
Questo lavoro descrive il progetto svolto.` }

for (const [name, text] of [['bookkeeping first', ACK_AFTER], ['heading first', ACK_FIRST]]) {
    const out = h.excludeUnreviewedSegments([BODY, { path: '/ringraziamenti.tex', text }])
    check(
        `${name}: the file is named as not reviewed`,
        out.files.includes('/ringraziamenti.tex'),
        JSON.stringify(out.files)
    )
    check(
        `${name}: and is not among the files read`,
        !out.docs.some(d => d.path === '/ringraziamenti.tex')
    )
    const kept = new Set(out.docs.map(d => d.path))
    check(
        `${name}: no file is both read and skipped`,
        out.files.every(p => !kept.has(p))
    )
}
{
    // The line above the heading is only taken when it is bookkeeping. A bibliography
    // sitting there is part of the document and stays in the review, or the skeleton
    // would report a bibliography that is right there as missing.
    const text = R`\bibliography{riferimenti}
\chapter*{Ringraziamenti}
Grazie a tutti.`
    const out = h.excludeUnreviewedSegments([BODY, { path: '/coda.tex', text }])
    const coda = out.docs.find(d => d.path === '/coda.tex')
    check('a real command above the heading is kept', Boolean(coda) && /\\bibliography\{riferimenti\}/.test(coda.text))
    check('and the file is not reported as skipped', !out.files.includes('/coda.tex'))
    check('while the acknowledgements themselves are gone', Boolean(coda) && !/Grazie a tutti/.test(coda.text))
}
{
    // Blanked, never cut: the line numbers of everything after the exclusion have to
    // stay the line numbers of the real file.
    const text = R`\addcontentsline{toc}{chapter}{Ringraziamenti}
\chapter*{Ringraziamenti}
Grazie a tutti.
\chapter{Conclusioni}
Il lavoro si chiude qui.`
    const out = h.excludeUnreviewedSegments([{ path: '/coda.tex', text }])
    const coda = out.docs.find(d => d.path === '/coda.tex')
    check('the file keeps its length', Boolean(coda) && coda.text.length === text.length)
    check('and the chapter after it survives', Boolean(coda) && /Il lavoro si chiude qui/.test(coda.text))
}
{
    const text = 'Some prose. \\chapter*{Ringraziamenti} Grazie.'
    check(
        'a heading sharing its line with prose takes nothing with it',
        h.extendToHeadingBookkeeping(text, text.indexOf('\\chapter*')) === text.indexOf('\\chapter*')
    )
}

console.log(ok ? '\naggregation: all good' : '\naggregation: FAILURES')
process.exit(ok ? 0 : 1)
