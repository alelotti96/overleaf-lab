// The evidence checks: what happens to a finding whose quotes are not in the document,
// and what happens to a verdict that contradicts its own verification.
//
// Both are DESTRUCTIVE mechanisms (they drop findings and rewrite verdicts), so the
// cases here come in pairs: the fabrication that must be caught and the honest finding
// that must survive it. Every "must be caught" case below is a verdict that actually
// shipped in a measured run.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.CTRL, 'utf8')
const start = src.indexOf('function foldForMatch(')
const end = src.indexOf('// overleaf-lab: split the rubric guidelines')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the helpers')
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const h = new Function(
    'VERIFY_MAX_FINDINGS',
    `${src.slice(start, end)}; return {
        normalizeForMatch, extractVerbatimSpans, countFabricatedSpans, evidenceIsFabricated,
        demoteFabricatedResult, dropFabricatedItems, resolveVerifiedStatus, mergeFileItems,
        setReportLanguage, DEMOTION_MIN_QUOTE_CHARS, countPlannedVerifications,
        countUngroundedQuotes
    }`
)(8)

const R = String.raw
let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

h.setReportLanguage('en')

// The document a pass was shown, and the raw project it was cut out of.
const SENT = h.normalizeForMatch(
    R`% ===== FILE: /Frontmatter/acronyms.tex =====
    \begin{acronym}
    \acro{LEO}{Low Earth Orbit}
    \end{acronym}
    % ===== FILE: /Mainmatter/1_intro.tex =====
    The mission profile is described in the following chapters.
    \begin{lstlisting}
    \end{lstlisting}`
)
// The same project before comments were stripped and verbatim bodies blanked: the
// listing body and the comment only exist here.
const RAW = h.normalizeForMatch(
    R`% a comment nobody sends to the model, mentioning \caption{Figura di prova}
    \begin{acronym}
    \acro{LEO}{Low Earth Orbit}
    \end{acronym}
    The mission profile is described in the following chapters.
    \begin{lstlisting}
    for i in range(10): print(i)
    \end{lstlisting}`
)
const SOURCES = [SENT, () => RAW]

// ===========================================================================
// which spans of an evidence string claim to be copied out of the document
// ===========================================================================
check(
    'a long quoted span is checkable',
    h.extractVerbatimSpans('/a.tex: "The mission profile is described"').length === 1
)
check(
    'a short quoted span is not',
    h.extractVerbatimSpans('/a.tex: "too short"').length === 0,
    'short spans match by accident and absence claims are short'
)
check(
    'bare LaTeX is checkable',
    h
        .extractVerbatimSpans(R`Checked acronyms.tex: it contains \acro{ADR}{Active Debris Removal}.`)
        .includes(R`\acro{ADR}{Active Debris Removal}`),
    'the measured fabrication was raw LaTeX outside any quotation mark'
)
check(
    'a backticked span is checkable',
    h
        .extractVerbatimSpans('the caption reads `Risultati della simulazione` here')
        .includes('Risultati della simulazione')
)
check(
    'a trailing ellipsis is not searched for',
    h.extractVerbatimSpans('/a.tex: "The mission profile is described..."')[0] ===
        'The mission profile is described'
)
check('the floor is 15 characters', h.DEMOTION_MIN_QUOTE_CHARS === 15)

// ===========================================================================
// fabrication: the measured cases, and the honest findings next to them
// ===========================================================================
{
    // Measured (batch3, req 38): an "ok" justified by acronym declarations the file
    // does not contain.
    const invented = R`Checked /Frontmatter/acronyms.tex: it contains \acro{ADR}{Active Debris Removal} and \acro{OOS}{On-Orbit Servicing}.`
    check('invented LaTeX is fabrication', h.evidenceIsFabricated(invented, SOURCES))
    const real = R`Checked /Frontmatter/acronyms.tex: it contains \acro{LEO}{Low Earth Orbit}.`
    check('a real declaration is not', !h.evidenceIsFabricated(real, SOURCES))
}
check(
    'evidence with no quotes is never fabrication',
    !h.evidenceIsFabricated('scanned all 31 entries in the bibliography, none is a bare URL', SOURCES),
    'a count is not a quotation'
)
check(
    'one wrong quote among right ones is not fabrication',
    !h.evidenceIsFabricated(
        '/a.tex: "The mission profile is described" | /b.tex: "a sentence nobody ever wrote here"',
        SOURCES
    ),
    'a partly mistyped finding is handled by the warning, not by dropping it'
)
check(
    'a quote the sanitiser hid is kept',
    !h.evidenceIsFabricated('/a.tex: "for i in range(10): print(i)"', SOURCES),
    'the listing body is blanked before the pass sees it, and that is our doing'
)
check(
    'a quote only the comments carry is kept',
    !h.evidenceIsFabricated(R`/a.tex: "\caption{Figura di prova}"`, SOURCES),
    'comments are stripped before the pass sees them'
)
check(
    'the sent text alone is not enough to condemn',
    h.countFabricatedSpans('/a.tex: "for i in range(10): print(i)"', [SENT]).missing === 1,
    'which is exactly why the raw project is the second haystack'
)

// ===========================================================================
// ONE grounded quote is enough to keep a finding: the batch8 false n.a.
// ===========================================================================
// Both cases below are real evidence strings from a measured run, and both were dropped
// although the document contains what they quote. The cause was in the quote pairing:
// single quotes were paired only at the end of a chunk and greedily, so several quoted
// passages with no "|" between them came back as ONE segment running from the first
// apostrophe to the last, ellipses and joining prose included. The pairing now ends a
// span at the first quote character that is not a word's own apostrophe, and the three
// consumers of quoted evidence (this demotion, the grounding warning and the file:line
// derivation) count the same pieces.
const OUTLINE_SOURCE = h.normalizeForMatch(
    R`% ===== FILE: /contenuti.tex =====
    \section*{1. Descrizione Struttura Ospitante}
    L'attività di tirocinio è stata svolta in collaborazione con il Laboratorio.
    \section*{2. Motivazione e Contesto}
    \section*{3. Finalità del Tirocinio e Attività Svolte}`
)
{
    // Measured: batch8, internship rubric, the three compulsory opening parts.
    const evidence =
        "Outline, sezione 2: '1. Descrizione Struttura Ospitante' ... '2. Motivazione e Contesto' ... '3. Finalità del Tirocinio e Attività Svolte'"
    const counted = h.countFabricatedSpans(evidence, [OUTLINE_SOURCE])
    check(
        'three quotes lumped into one segment are counted one by one',
        counted.checked === 3 && counted.missing === 0,
        JSON.stringify(counted)
    )
    check('so the finding is not dropped', !h.evidenceIsFabricated(evidence, [OUTLINE_SOURCE]))
    check(
        'and the reader is not warned about honest evidence either',
        h.countUngroundedQuotes(evidence, OUTLINE_SOURCE).missing === 0,
        'the warning counts the same pieces the demotion does, or it badges honest work as suspect'
    )
}
{
    // Measured: batch8, a chapter opening that IS in the file, followed by a second
    // quote the greedy pairing swallowed together with the path between them. The
    // apostrophe of "L'obbiettivo" is what made the old rule give up: it is a letter of
    // the word, and only a quote character that is NOT one can close a span.
    const source = h.normalizeForMatch(
        R`% ===== FILE: /Mainmatter/capitolo1.tex =====
        La navigazione e il controllo dei veicoli spaziali richiedono una stima accurata.
        % ===== FILE: /Mainmatter/capitolo2.tex =====
        L'obbiettivo del presente lavoro è fornirne una completa caratterizzazione sperimentale.`
    )
    const evidence =
        "/Mainmatter/capitolo1.tex: apertura 'La navigazione e il controllo dei veicoli spaziali...'; /Mainmatter/capitolo2.tex: 'L'obbiettivo del presente lavoro è fornirne una completa caratterizzazione...'"
    const counted = h.countFabricatedSpans(evidence, [source])
    check(
        'two quoted openings in one line are two pieces, not one',
        counted.checked === 2 && counted.missing === 0,
        JSON.stringify(counted)
    )
    check('so the finding stands', !h.evidenceIsFabricated(evidence, [source]))
    check(
        'and the prose between the quotes is not searched for',
        h.countUngroundedQuotes(evidence, source).missing === 0,
        'the joining prose is in no document, and warning about it is the false badge'
    )
    // The second half of the same case: the quote whose text really is absent still
    // has to be reported. Only the second chapter's sentence is removed here.
    const half = h.normalizeForMatch(
        R`% ===== FILE: /Mainmatter/capitolo1.tex =====
        La navigazione e il controllo dei veicoli spaziali richiedono una stima accurata.`
    )
    check(
        'an absent quote next to a present one is still counted',
        h.countUngroundedQuotes(evidence, half).missing === 1,
        JSON.stringify(h.countUngroundedQuotes(evidence, half))
    )
    check('but one grounded piece keeps the finding', !h.evidenceIsFabricated(evidence, [half]))
}
{
    // The invariant, stated once on the paths that act on it.
    const source = h.normalizeForMatch('Il metodo proposto riduce l\'errore di stima del venti per cento.')
    const evidence = R`/a.tex: "Il metodo proposto riduce l'errore di stima" e inoltre \acro{XYZ}{Xeno Yield Zone} non esiste`
    const result = { path: 'Chapter 1', status: 'missing', evidence, suggestion: '' }
    check(
        'a chapter verdict with one grounded quote is never demoted',
        !h.demoteFabricatedResult(result, [source]) && result.status === 'missing'
    )
    check(
        'nor is a whole-document item',
        h.dropFabricatedItems([{ requirement: 'r', status: 'missing', evidence }], () => [source])
            .length === 1
    )
}

// ===========================================================================
// what a fabricated finding does to the verdict
// ===========================================================================
{
    const result = {
        path: 'Chapter 2',
        status: 'missing',
        evidence: R`/c2.tex: the text says \todo{riscrivere questa parte prima della consegna}`,
        suggestion: 'remove it',
    }
    const demoted = h.demoteFabricatedResult(result, SOURCES)
    check('a fabricated chapter verdict is demoted', demoted && result.status === 'na')
    check(
        'the demotion is written into the evidence',
        /\[finding dropped: the quoted text is not in the document\]/.test(result.evidence),
        result.evidence
    )
    check('the evidence itself is kept', /riscrivere questa parte/.test(result.evidence))
}
{
    const result = {
        path: 'Chapter 1',
        status: 'missing',
        evidence: '/1_intro.tex: "The mission profile is described in the following chapters."',
        suggestion: '',
    }
    check(
        'a grounded chapter verdict is left alone',
        !h.demoteFabricatedResult(result, SOURCES) && result.status === 'missing'
    )
}
{
    // The whole point: the demoted chapter must not decide the requirement any more.
    const results = [
        { path: 'Chapter 1', status: 'ok', evidence: 'no problem here', suggestion: '' },
        {
            path: 'Chapter 2',
            status: 'missing',
            evidence: R`\acro{ADR}{Active Debris Removal} is declared twice`,
            suggestion: 'fix it',
        },
        { path: 'Chapter 3', status: 'na', evidence: 'nothing of the kind here', suggestion: '' },
    ]
    for (const r of results) h.demoteFabricatedResult(r, SOURCES)
    const merged = h.mergeFileItems('7. Every caption is self-explanatory.', results, 'chapters')
    check('the requirement is recomputed without it', merged.status === 'ok', merged.status)
}
{
    // ...and when the fabrication was the ONLY finding, the requirement has no verdict
    // left rather than a verdict nobody can check.
    const results = [
        {
            path: 'Chapter 1',
            status: 'missing',
            evidence: R`\acro{ADR}{Active Debris Removal} is never expanded`,
            suggestion: '',
        },
        { path: 'Chapter 2', status: 'na', evidence: 'no acronyms here', suggestion: '' },
    ]
    for (const r of results) h.demoteFabricatedResult(r, SOURCES)
    const merged = h.mergeFileItems('22. Acronyms are expanded at first use.', results, 'chapters')
    check('nothing usable left means na, not missing', merged.status === 'na', merged.status)
}
{
    const items = [
        { requirement: 'r', status: 'missing', evidence: R`\acro{ADR}{Active Debris Removal}` },
        { requirement: 'r', status: 'ok', evidence: '"The mission profile is described"' },
    ]
    check(
        'a whole-document pass drops only the invented item',
        h.dropFabricatedItems(items, () => SOURCES).length === 1
    )
    check(
        'a pass with nothing but invented items is left empty',
        h.dropFabricatedItems([items[0]], () => SOURCES).length === 0,
        'the caller then has to say the requirement was not assessed'
    )
    check(
        'the haystacks are chosen per item, not once for the pass',
        h.dropFabricatedItems(items, evidence => (/acro/.test(evidence) ? [SENT] : SOURCES)).length === 1,
        'one pass emits several findings and they do not all claim the same thing'
    )
}

// ===========================================================================
// a verdict may not contradict its own verification
// ===========================================================================
// Measured (batch4, internship req 4): the verify pass wrote that the passage is quoted
// correctly and the sentence is not truncated, and returned "missing" anyway.
{
    const verified = {
        status: 'missing',
        refuted: 'all',
        evidence: '/1_intro.tex: "The mission profile is described in the following chapters."',
    }
    const resolved = h.resolveVerifiedStatus(verified, true)
    check('every claim refuted cannot stay missing', resolved.status === 'ok', resolved.status)
    check('and the report says why', /verdict recomputed/.test(resolved.note), resolved.note)
}
check(
    'a partly refuted finding keeps its verdict',
    h.resolveVerifiedStatus({ status: 'missing', refuted: 'some', evidence: 'x' }, true).status ===
        'missing'
)
check(
    'a refutation the verifier could not ground changes nothing',
    h.resolveVerifiedStatus({ status: 'partial', refuted: 'all', evidence: 'x' }, false).status ===
        'partial',
    'not being able to see something is not a refutation'
)
check(
    'an ok verdict is untouched',
    h.resolveVerifiedStatus({ status: 'ok', refuted: 'all', evidence: 'x' }, true).note === ''
)
check(
    'a missing refuted field changes nothing',
    h.resolveVerifiedStatus({ status: 'missing', evidence: 'x' }, true).status === 'missing'
)
check(
    'an unusable status is rejected, not guessed',
    h.resolveVerifiedStatus({ status: 'yes', refuted: 'all', evidence: 'x' }, true).status === null
)

// ===========================================================================
// ...and a violation may not be closed on the verifier's bare word
// ===========================================================================
// The gate above only guarded the recompute path. A verifier that simply ANSWERED "ok"
// replaced the finding with no gate at all - the documented failure mode this pass
// exists for, measured three times in audit2 with the verifier's own reason being that
// the files it was asked about were not in front of it. Every answer that erases a
// violation now goes through the same door: show it in the document, or the finding
// stands.
{
    const closed = h.resolveVerifiedStatus({ status: 'ok', refuted: 'none', evidence: 'looks fine' }, false)
    check('an ungrounded "ok" does not overturn a violation', closed.status === null, String(closed.status))
    check(
        'and the report says the double-check could not show its evidence',
        /double-check disagreed but could not show its evidence/.test(closed.note),
        closed.note
    )
}
check(
    'a grounded "ok" still closes it',
    h.resolveVerifiedStatus({ status: 'ok', refuted: 'none', evidence: 'x' }, true, 'missing').status ===
        'ok'
)
check(
    'an ungrounded "na" is an overturn too',
    h.resolveVerifiedStatus({ status: 'na', refuted: 'none', evidence: 'x' }, false, 'partial').status ===
        null
)
check(
    'a finding that was already ok is not being overturned',
    h.resolveVerifiedStatus({ status: 'ok', refuted: 'none', evidence: 'x' }, false, 'ok').status === 'ok',
    'the gate defends violations, and an ok item is verified for its quotes, not for its verdict'
)
check(
    'an ungrounded verifier that AGREES changes nothing about the gate',
    h.resolveVerifiedStatus({ status: 'missing', refuted: 'none', evidence: 'x' }, false, 'missing')
        .status === 'missing'
)
check(
    'the default is the case the gate exists for',
    h.resolveVerifiedStatus({ status: 'ok', refuted: 'none', evidence: 'x' }, false).status === null,
    'a caller that does not name the finding status gets the safe rule, not the permissive one'
)

// ===========================================================================
// a dropped finding must not be handed back to a model
// ===========================================================================
// Found on the stubbed end-to-end run: a demoted finding keeps the invented quotes in
// its evidence (marked), the mechanical grounding check flags them, and the item was
// then picked for adversarial verification BECAUSE of them. The verifier answered about
// the invented text and its answer became the verdict, so every finding dropped for
// fabricated evidence came back as a violation through that door.
{
    const invented = R`/a.tex: "the diagram is drawn with \begin{tikzpicture}[scale=2]" [finding dropped: the quoted text is not in the document]`
    const groundings = [h.countUngroundedQuotes(invented, SENT)]
    check('the dropped evidence does flag as ungrounded', groundings[0].missing > 0)
    check(
        'but a "not assessed" item earns no verification',
        h.countPlannedVerifications([{ status: 'na', evidence: invented }], groundings) === 0
    )
    check(
        'while a violation with the same evidence still does',
        h.countPlannedVerifications([{ status: 'missing', evidence: invented }], groundings) === 1
    )
}

// ===========================================================================
// "not applicable" and "nobody answered" are different facts
// ===========================================================================
{
    const failed = [
        { path: 'Chapter 1', status: 'na', evidence: 'check refused (HTTP 500)', modelFailure: true },
        { path: 'Chapter 2', status: 'na', evidence: 'check refused (HTTP 500)', modelFailure: true },
    ]
    const merged = h.mergeFileItems('4. No spelling errors.', failed, 'chapters')
    check('a requirement nobody answered is flagged', merged.status === 'na' && merged.modelFailure === true)
}
{
    const answered = [
        { path: 'Chapter 1', status: 'na', evidence: 'no figures in this chapter' },
        { path: 'Chapter 2', status: 'na', evidence: 'no figures in this chapter' },
    ]
    const merged = h.mergeFileItems('9. Every figure is referenced.', answered, 'chapters')
    check(
        'a genuinely inapplicable requirement is not',
        merged.status === 'na' && merged.modelFailure === undefined
    )
}
{
    const mixed = [
        { path: 'Chapter 1', status: 'na', evidence: 'check refused (HTTP 500)', modelFailure: true },
        { path: 'Chapter 2', status: 'ok', evidence: 'all fine here' },
    ]
    check(
        'a partly answered requirement is not a model failure',
        h.mergeFileItems('r', mixed, 'chapters').modelFailure === undefined
    )
}

console.log(ok ? '\nevidence_check: all good' : '\nevidence_check: FAILURES')
process.exit(ok ? 0 : 1)
