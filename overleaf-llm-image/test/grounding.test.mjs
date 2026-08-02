// Extract the REAL grounding/per-file helpers from the controller and test them.
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
    `${src.slice(start, end)}; return { normalizeForMatch, extractQuotedSegments, countUngroundedQuotes, splitOnEllipses, repairJsonEscapeArtifacts, isPerFileRequirement, stripPerFileMarker, mergeFileItems, mergePassItems, countPlannedVerifications, evidenceMentionsPath, evidenceClaimsAFile, byEvidenceWeight, buildSearchIndex, locateSegment, locateEvidence, lineAt, restoreQuote, restoreQuotedEvidence, INVENTED_LINE_CLAIM, quotedPieces, probativePieces }`
)(8)

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---- grounding ----
const source = h.normalizeForMatch(
    `La Space Economy rappresenta un settore in rapida espansione, con un valore
     stimato di centinaia di miliardi di dollari \\cite{esa_report_2026}.
     L'imaging plenottico consente la stima della posa.`
)

// 1) a real quote grounds, even with different whitespace and typographic quotes
let g = h.countUngroundedQuotes(
    '/Mainmatter/1_intro.tex: "La Space Economy rappresenta un settore in rapida espansione"',
    source
)
check('real quote grounds', g.checked === 1 && g.missing === 0, JSON.stringify(g))

g = h.countUngroundedQuotes(
    '/a.tex: “L’imaging plenottico consente la stima della posa”',
    source
)
check('typographic quotes normalize', g.checked === 1 && g.missing === 0, JSON.stringify(g))

// 2) a fabricated quote is caught
g = h.countUngroundedQuotes(
    '/a.tex: "la stima della posa raggiunge un errore medio di 2.3 cm"',
    source
)
check('fabricated quote flagged', g.checked === 1 && g.missing === 1, JSON.stringify(g))

// 3) multiple chunks separated by | ; single-quoted chunk-final span with apostrophes
g = h.countUngroundedQuotes(
    `/a.tex: "La Space Economy rappresenta un settore in rapida espansione" | /b.tex: 'L'imaging plenottico consente la stima della posa'`,
    source
)
check('mixed quoting styles', g.checked === 2 && g.missing === 0, JSON.stringify(g))

// 4) scan-description evidence (no quotes) -> nothing checked, no warning
g = h.countUngroundedQuotes('scanned all 31 entries in references.bib, none points to Wikipedia', source)
check('no quotes -> unchecked', g.checked === 0 && g.missing === 0)

// 5) short quotes ignored (nothing provable)
g = h.countUngroundedQuotes('/a.tex: "posa"', source)
check('short quote ignored', g.checked === 0)

// ---- per-file marker ----
check('marker detected', h.isPerFileRequirement('22. No obvious spelling errors. [per-file]'))
check('marker with space', h.isPerFileRequirement('3. Verb tenses are consistent. [per file]'))
check('no marker', !h.isPerFileRequirement('4. Every figure has a caption.'))
check('marker stripped', h.stripPerFileMarker('22. Spelling. [per-file]') === '22. Spelling.')

// ---- merge ----
const files = (statuses) => statuses.map((s, i) => ({ path: `/f${i}.tex`, status: s, evidence: `ev${i}`, suggestion: s === 'ok' ? '' : `fix${i}` }))
let m = h.mergeFileItems('Spelling', files(['ok', 'missing', 'ok']))
check('missing wins', m.status === 'missing' && m.evidence.includes('/f1.tex: ev1') && m.suggestion === 'fix1', JSON.stringify(m))
m = h.mergeFileItems('Spelling', files(['ok', 'partial', 'na']))
check('partial beats ok/na', m.status === 'partial')
m = h.mergeFileItems('Spelling', files(['ok', 'na', 'ok']))
check('na does not drag down', m.status === 'ok' && m.evidence.includes('2/3 files ok') && m.evidence.includes('1 n.a.'), m.evidence)
m = h.mergeFileItems('Spelling', files(['na', 'na']))
check('all na -> na', m.status === 'na')

// ---- ellipsis-aware grounding ----
// The unit counted is the PIECE, the same one the demotion and the file:line
// derivation count: a quote compressed with an ellipsis is two passages to find, and
// counting the segment instead is what let one unfindable piece badge a whole line.
// Both real fragments, compressed with "...": grounded, no warning.
g = h.countUngroundedQuotes(
    '/a.tex: "La Space Economy rappresenta un settore... consente la stima della posa"',
    source
)
check('ellipsis quote with real pieces grounds', g.checked === 2 && g.missing === 0, JSON.stringify(g))

// One real + one fabricated fragment: still flagged.
g = h.countUngroundedQuotes(
    '/a.tex: "La Space Economy rappresenta un settore... errore medio di 2.3 centimetri"',
    source
)
check('ellipsis quote with fabricated piece flagged', g.checked === 2 && g.missing === 1, JSON.stringify(g))

// Unicode ellipsis and bracketed ellipsis behave the same.
g = h.countUngroundedQuotes(
    '/a.tex: "La Space Economy rappresenta un settore… stima della posa" | /b.tex: "un settore in rapida espansione [...] consente la stima"',
    source
)
check('unicode and bracketed ellipses', g.checked === 4 && g.missing === 0, JSON.stringify(g))

// ---- single quotes: an apostrophe is not a delimiter ----
// The pairing used to run from the first quote of a chunk to the last, so three quoted
// titles came back as one span containing the words between them, which no document
// contains. Every consumer of quoted evidence then drew its own wrong conclusion.
{
    const outline = h.normalizeForMatch(
        `\\section*{1. Descrizione Struttura Ospitante}
         \\section*{2. Motivazione e Contesto}
         \\section*{3. Finalità del Tirocinio e Attività Svolte}`
    )
    const evidence =
        "Outline: '1. Descrizione Struttura Ospitante' ... '2. Motivazione e Contesto' ... '3. Finalità del Tirocinio e Attività Svolte'"
    const segments = h.extractQuotedSegments(evidence)
    check('three quoted titles are three spans', segments.length === 3, JSON.stringify(segments))
    const counted = h.countUngroundedQuotes(evidence, outline)
    check(
        'and honest evidence gets no warning',
        counted.checked === 3 && counted.missing === 0,
        JSON.stringify(counted)
    )
}
{
    // The apostrophe cases the narrow rule has to survive: a word's own apostrophe
    // never opens or closes anything.
    const src = h.normalizeForMatch(
        "L'obbiettivo del presente lavoro è fornirne una caratterizzazione completa."
    )
    const evidence =
        "/capitolo1.tex: apertura 'La navigazione dei veicoli...'; /capitolo2.tex: 'L'obbiettivo del presente lavoro è fornirne una caratterizzazione...'"
    const segments = h.extractQuotedSegments(evidence)
    check(
        'a quote whose text contains an apostrophe is one span',
        segments.length === 2 &&
            segments[1] ===
                "L'obbiettivo del presente lavoro è fornirne una caratterizzazione...",
        JSON.stringify(segments)
    )
    check(
        'the piece with the apostrophe grounds',
        h.countUngroundedQuotes(evidence, src).missing === 1,
        'only the first quote is absent from this source, and exactly one warning is owed'
    )
    check(
        'an unpaired quote is not a span',
        h.extractQuotedSegments("negli anni '80 l'autore scriveva a mano").length === 0,
        'missing a quote costs a check nobody was owed; inventing one costs a false warning'
    )
}
{
    // One view of quoted evidence, three consumers: whatever a piece is, it is the same
    // piece for the warning, for the location and for the demotion.
    const evidence = "Outline: '1. Descrizione Struttura Ospitante' ... '2. Motivazione e Contesto'"
    check(
        'the warning and the demotion see the same pieces',
        JSON.stringify(h.quotedPieces(evidence)) ===
            JSON.stringify(h.probativePieces(evidence).filter(p => !p.startsWith('\\'))),
        JSON.stringify(h.quotedPieces(evidence))
    )
    check(
        'and no piece carries the pairing quote characters',
        h.quotedPieces(evidence).every(p => !/^['"]|['"]$/.test(p)),
        JSON.stringify(h.quotedPieces(evidence))
    )
    // A span can still arrive with quote characters on its ends: a quote written inside
    // backticks, or a title quoted inside a longer quotation. Searching for those
    // characters is searching for punctuation the source never had.
    const quoted = 'the caption reads `"Risultati della simulazione numerica"` here'
    check(
        'a quote inside backticks is trimmed to its text',
        h.probativePieces(quoted).every(p => !/^["']|["']$/.test(p)),
        JSON.stringify(h.probativePieces(quoted))
    )
}
{
    // ...and the location derivation needs the same trim: without it a title quoted
    // inside a longer quotation matches nothing and the finding loses its file:line.
    const indexes = [
        h.buildSearchIndex(
            '/capitolo1.tex',
            `\\chapter{Introduzione}\n\\section{Obiettivo del lavoro presente}\n`
        ),
    ]
    const found = h.locateEvidence(
        `/capitolo1.tex: "una frase che nel file non c'è ... 'Obiettivo del lavoro presente'"`,
        indexes
    )
    check(
        'a quoted title inside a quotation is located',
        found.length === 1 && found[0].line === 2,
        JSON.stringify(found)
    )
}

// ---- which haystacks may keep a finding alive ----
// The scan hints and the skeleton are part of what a pass was SHOWN, so quoting one
// back is attribution and must not raise the warning. Keeping a finding alive on them
// is a different matter: a verdict about a file has to be grounded in that file.
{
    const docs = [{ path: '/Mainmatter/capitolo1.tex' }, { path: '/references.bib' }]
    check(
        'evidence that names a file claims to have read it',
        h.evidenceClaimsAFile('/Mainmatter/capitolo1.tex: "una frase"', docs)
    )
    check(
        'the file name alone is enough',
        h.evidenceClaimsAFile('in capitolo1.tex la frase manca', docs)
    )
    check(
        'a chapter answering from the hints claims no file',
        !h.evidenceClaimsAFile('the scan hints report no code listings in the project', docs)
    )
    check(
        'and neither does a bare count',
        !h.evidenceClaimsAFile('scanned all 31 entries, none is a bare URL', docs)
    )
}

// ---- line numbers written by a model are the model's own ----
// The text a pass receives carries no line numbers and the prompt forbids inventing
// them, so a number next to the word "line" was made up. The prose is not rewritten
// (that is guesswork on the one field the reader is asked to trust); the reader is told
// which of the two numbers came from the file.
check('a claimed line range is recognised', h.INVENTED_LINE_CLAIM.test('/main.tex, lines 30-100'))
check('the singular too', h.INVENTED_LINE_CLAIM.test('at line 42 the caption is empty'))
check('and the Italian forms', h.INVENTED_LINE_CLAIM.test('alle righe 30-100 del file'))
check(
    'evidence that quotes instead of counting lines is left alone',
    !h.INVENTED_LINE_CLAIM.test('/main.tex: "una frase che il documento contiene"')
)
check(
    'and so is a sentence that merely says how many lines something takes',
    !h.INVENTED_LINE_CLAIM.test('the caption runs over 3 lines'),
    'the number has to follow the word, or every table row would match'
)

{
    // The location derivation reads the same pieces: a title glued to a stray quote
    // matches nothing, and the finding used to lose its file:line for that alone.
    const indexes = [
        h.buildSearchIndex(
            '/contenuti.tex',
            `\\section*{Premessa}\n\\section*{2. Motivazione e Contesto}\n`
        ),
    ]
    const found = h.locateEvidence(
        "Outline: '1. Descrizione Struttura Ospitante' ... '2. Motivazione e Contesto'",
        indexes
    )
    check(
        'a lumped quote still resolves to a file and a line',
        found.length === 1 && found[0].path === '/contenuti.tex' && found[0].line === 2,
        JSON.stringify(found)
    )
}

// A long-enough segment whose ellipsis pieces are all too short proves nothing.
g = h.countUngroundedQuotes('/a.tex: "aaa bbb ... ccc ddd"', source)
check('all-short pieces -> unchecked', g.checked === 0 && g.missing === 0, JSON.stringify(g))

// ---- JSON escape artifact repair ----
let r = h.repairJsonEscapeArtifacts('labeled \ref{chap:Notation} inside \begin{figure}')
check('CR->\\ref and BS->\\begin restored', r === 'labeled \\ref{chap:Notation} inside \\begin{figure}', JSON.stringify(r))
r = h.repairJsonEscapeArtifacts('the term \frac{p}{q} and \vec{x}')
check('FF->\\frac and VT->\\vec restored', r === 'the term \\frac{p}{q} and \\vec{x}', JSON.stringify(r))
r = h.repairJsonEscapeArtifacts('uses \textit{emphasis} and \newcommand{foo}')
check('TAB/LF stems restored', r.includes('\\textit{emphasis}') && r.includes('\\newcommand{'), JSON.stringify(r))
r = h.repairJsonEscapeArtifacts('line one\nand line two\tstill tabbed\r\nnext')
check('legit whitespace untouched', r === 'line one\nand line two\tstill tabbed\r\nnext', JSON.stringify(r))

// Repaired quotes ground against real LaTeX source (repair runs before grounding).
const latexSource = h.normalizeForMatch('Come mostra la Figura \\ref{fig:posa}, la stima risulta accurata.')
check(
    'repair enables grounding of \\ref quotes',
    h.countUngroundedQuotes(
        `/a.tex: "${h.repairJsonEscapeArtifacts('Come mostra la Figura \ref{fig:posa}, la stima risulta accurata')}"`,
        latexSource
    ).missing === 0
)

// ---- planned verifications (drives the progress total during the run) ----
const item = (status, evidence = '') => ({ status, evidence })
const G = n => ({ checked: n, missing: n })
let planned = h.countPlannedVerifications(
    [item('ok'), item('ok'), item('ok')],
    [G(0), G(0), G(0)]
)
check('a clean run plans no double-checks', planned === 0)

planned = h.countPlannedVerifications(
    [item('ok'), item('missing'), item('partial'), item('na')],
    [G(0), G(0), G(0), G(0)]
)
check('negatives are planned', planned === 2)

planned = h.countPlannedVerifications([item('ok'), item('ok')], [G(0), G(1)])
check('an ok with ungrounded quotes is planned', planned === 1)

planned = h.countPlannedVerifications([item('missing')], [G(2)])
check('a negative with ungrounded quotes counts once', planned === 1)

planned = h.countPlannedVerifications(
    Array.from({ length: 12 }, () => item('missing')),
    Array.from({ length: 12 }, () => G(0))
)
check('the cap holds', planned === 8)

// The announced total must never walk backwards as items accumulate.
const items = []
const grounds = []
let previous = 0
let monotonic = true
for (const status of ['ok', 'missing', 'ok', 'partial', 'ok', 'missing']) {
    items.push(item(status))
    grounds.push(G(0))
    const now = h.countPlannedVerifications(items, grounds)
    if (now < previous) monotonic = false
    previous = now
}
check('the planned count never decreases while passes run', monotonic && previous === 3)

// ---- file:line location (derived, never asked of the model) ----
// THE invariant: the index must normalize exactly like the grounding check, or a
// quote could ground while refusing to be located, or worse be located wrongly.
const samples = [
    'Riga uno\nRiga   due con   spazi\n\nRiga quattro',
    'Con “virgolette” tipografiche e l’apostrofo\nseconda riga',
    '   spazi in testa e in coda   \n\n',
    '\\begin{figure}[H]\n\\caption{A caption}\n\\end{figure}',
    '',
]
let invariant = true
for (const s of samples) {
    if (h.buildSearchIndex('/x.tex', s).normalized !== h.normalizeForMatch(s)) {
        invariant = false
        console.log('   mismatch on:', JSON.stringify(s))
    }
}
check('index normalizes exactly like the grounding check', invariant)

const doc = [
    '% ===== comment =====',
    'La Space Economy rappresenta un settore in rapida espansione,',
    'con un valore stimato di centinaia di miliardi.',
    '',
    "L'imaging plenottico consente la stima della posa del target.",
].join('\n')
const idx = [h.buildSearchIndex('/Mainmatter/1_intro.tex', doc)]

check('index length matches normalized length', idx[0].lineOf.length === idx[0].normalized.length)

let loc = h.locateSegment('La Space Economy rappresenta un settore', idx)
check('quote on line 2 located', loc && loc.line === 2 && loc.path === '/Mainmatter/1_intro.tex', JSON.stringify(loc))

loc = h.locateSegment("L'imaging plenottico consente la stima della posa", idx)
check('quote on line 5 located', loc && loc.line === 5, JSON.stringify(loc))

// A quote spanning a line break must resolve to the line it STARTS on.
loc = h.locateSegment('rapida espansione, con un valore stimato', idx)
check('multi-line quote resolves to its first line', loc && loc.line === 2, JSON.stringify(loc))

// Typographic quotes in the evidence still locate.
loc = h.locateSegment('L’imaging plenottico consente la stima', idx)
check('typographic apostrophe still locates', loc && loc.line === 5, JSON.stringify(loc))

// An ellipsis-compressed quote locates by its first probative piece.
loc = h.locateSegment('La Space Economy rappresenta ... della posa del target', idx)
check('ellipsis quote locates on its first piece', loc && loc.line === 2, JSON.stringify(loc))

check('a fabricated quote has no location', h.locateSegment('un errore medio di 2.3 centimetri', idx) === null)

const found = h.locateEvidence(
    '/Mainmatter/1_intro.tex: "La Space Economy rappresenta un settore in rapida espansione" | "un errore medio di 2.3 centimetri" | "L\'imaging plenottico consente la stima della posa"',
    idx
)
check('locateEvidence returns only what it can place', found.length === 2 && found[0].line === 2 && found[1].line === 5, JSON.stringify(found))

check('lineAt counts newlines', h.lineAt('a\nb\nc', 4) === 3)

// ---- over-escaped LaTeX in quotes ----
// A model writing LaTeX inside JSON often doubles the backslashes. The quote is
// real; only its escaping is wrong, and a fabrication warning on it would be a lie.
const latexSrc = h.normalizeForMatch(
    'The \\textit{\\acl{ADR}}, \\acs{ADR}) and its \\cite{esa} are described here.'
)
g = h.countUngroundedQuotes('/a.tex: "\\\\textit{\\\\acl{ADR}}, \\\\acs{ADR}"', latexSrc)
check('over-escaped quote still grounds', g.checked === 1 && g.missing === 0, JSON.stringify(g))

g = h.countUngroundedQuotes('/a.tex: "\\textit{\\acl{ADR}}, \\acs{ADR}"', latexSrc)
check('correctly escaped quote grounds', g.checked === 1 && g.missing === 0, JSON.stringify(g))

// The relaxation must not turn a fabrication into a match.
g = h.countUngroundedQuotes('/a.tex: "\\\\textit{\\\\acl{XYZ}}, \\\\acs{XYZ}"', latexSrc)
check('over-escaping does not excuse a fabricated quote', g.checked === 1 && g.missing === 1, JSON.stringify(g))

const latexIdx = [
    h.buildSearchIndex(
        '/a.tex',
        'first line\nThe \\textit{\\acl{ADR}}, \\acs{ADR}) and more text here.'
    ),
]
const overLoc = h.locateSegment('\\\\textit{\\\\acl{ADR}}, \\\\acs{ADR}', latexIdx)
check('over-escaped quote is still located', overLoc && overLoc.line === 2, JSON.stringify(overLoc))

// ---- regressions found by the code audit ----
// THE invariant, now by construction: the location index and the grounding check
// must fold text identically, or a quote can ground while refusing to be located.
// These inputs used to diverge: whole-string toLowerCase is context sensitive (Greek
// final sigma) and code-unit iteration mangles astral-plane letters.
{
    const samples = [
        'Ο ΛΟΓΟΣ ΤΟΥ ΑΝΘΡΩΠΟΥ',
        '\u{10404} testo astrale',
        'İstanbul e la I con punto',
        'Riga uno\nRiga   due\n\n',
        '   ',
        '',
    ]
    let same = true
    for (const s of samples) {
        const idx = h.buildSearchIndex('/x.tex', s)
        if (idx.normalized !== h.normalizeForMatch(s)) {
            same = false
            console.log('   diverged on', JSON.stringify(s))
        }
        if (idx.lineOf.length !== idx.normalized.length) {
            same = false
            console.log('   lineOf disallineato su', JSON.stringify(s))
        }
    }
    check('index and grounding fold text identically', same)
}

// A quoted span longer than the extractor's ceiling must not shift the pairing onto
// the prose BETWEEN two quotes, which would flag honest evidence as fabricated.
{
    const long = 'z'.repeat(320)
    const src2 = h.normalizeForMatch('The document contains a short but valid quotation in here.')
    const ev = `It says "${long}" and this prose in between is long enough to pair up badly "a short but valid quotation in" end.`
    const segs = h.extractQuotedSegments(ev)
    check(
        'an over-long quote does not capture the prose between quotes',
        segs.some(s => s.includes('a short but valid quotation in')) &&
            !segs.some(s => s.includes('prosa in mezzo')),
        JSON.stringify(segs.map(s => s.slice(0, 50)))
    )
    check(
        'and the real quote still grounds',
        h.countUngroundedQuotes(ev, src2).missing === 0
    )
}

// The same trap on the other side of the range: a quote SHORTER than the floor left
// its closing quote free to open the next pairing, so the prose between two short
// quotes was extracted and reported as fabricated. Observed on a real report, on a
// structural check whose evidence lists one acronym per line: four false fabrication
// warnings on the one verdict in the document that was computed rather than judged.
{
    const ev =
        '5 of 20 acronyms are not spelled out at first use: /a.tex:46 "API" is used ' +
        'before being spelled out | /b.tex:17 "CSV" is used before being spelled out | ' +
        '/c.tex:97 "JSON" is used before being spelled out'
    const segs = h.extractQuotedSegments(ev)
    check('a short quote does not capture the prose between quotes', segs.length === 0, JSON.stringify(segs))
    check('and no fabrication warning is raised', h.countUngroundedQuotes(ev, source).missing === 0)
}

// A real quote still has to be checked when short ones sit beside it.
{
    const src3 = h.normalizeForMatch('the geometry of the environment is assumed known')
    const ev = 'says "AB" then "the geometry of the environment" and "CD" after it'
    const g3 = h.countUngroundedQuotes(ev, src3)
    check('a real quote among short ones is still grounded', g3.checked === 1 && g3.missing === 0, JSON.stringify(g3))
}

// ---- which files a verification pass has to show ----
// A finding refuted because the verifier was never given the file it accuses is not a
// refutation, it is a silent "not checked" reported as "ok". These pin the widening.
{
    const ev =
        'Il finding cita /Mainmatter/1_introduzione.tex e Mainmatter/2_fondamenti.tex, ' +
        'oltre a simboli.tex, ma non /Appendici/appendice.tex.'
    check('an absolute path is recognised', h.evidenceMentionsPath(ev, '/Mainmatter/1_introduzione.tex'))
    check('a path without its leading slash is recognised', h.evidenceMentionsPath(ev, '/Mainmatter/2_fondamenti.tex'))
    check('a bare file name is recognised', h.evidenceMentionsPath(ev, '/Frontmatter/simboli.tex'))
    check('an unmentioned file is not', !h.evidenceMentionsPath(ev, '/Appendici/altro.tex'))
    check('empty evidence mentions nothing', !h.evidenceMentionsPath('', '/a.tex'))
}

// A verdict a parser decided never reaches the model, so counting a verification for
// it would announce a pass that never runs and leave the bar short of its own total.
{
    const planned = h.countPlannedVerifications(
        [item('missing'), { status: 'missing', evidence: '', decidedByCode: true }],
        [G(0), G(0)]
    )
    check('a code-decided finding earns no double-check', planned === 1)
}

// ---- where a multi-file finding is filed ----
// The report opens a finding under the head of its source list. Ordering that list by
// how much text each file contributed to the chapter sent the reader to the wrong
// file: observed on a real report, where a spelling finding whose examples were mostly
// in the introduction and in chapter 4 was filed under chapter 2.
{
    const evidence =
        "/Mainmatter/1_introduzione.tex: 'frase troncata' | " +
        "/Mainmatter/4_generazione.tex: 'concordanza errata' | " +
        "/Mainmatter/4_generazione.tex: 'formula sospesa' | " +
        "/Mainmatter/2_fondamenti.tex: 'manca l articolo'"
    const ordered = h.byEvidenceWeight(
        ['/Mainmatter/2_fondamenti.tex', '/Mainmatter/1_introduzione.tex', '/Mainmatter/4_generazione.tex'],
        evidence
    )
    check('the file the evidence talks about most comes first', ordered[0] === '/Mainmatter/4_generazione.tex', ordered.join(','))
    check('and every file is still there', ordered.length === 3)
}
{
    // A path written without its leading slash still counts.
    const ordered = h.byEvidenceWeight(['/a.tex', '/b.tex'], 'b.tex has two: b.tex again')
    check('a path without its leading slash is counted', ordered[0] === '/b.tex', ordered.join(','))
}
{
    // No path named at all: the order that came in is kept, not shuffled.
    const ordered = h.byEvidenceWeight(['/a.tex', '/b.tex'], 'no path in here')
    check('an evidence naming nothing leaves the order alone', ordered.join(',') === '/a.tex,/b.tex')
}

// ---- deterministic quoting: the report shows the file's bytes, not the model's ----
{
    const R = String.raw
    const indexes = [
        h.buildSearchIndex(
            '/a.tex',
            R`Il valore di picco è $5.5\,\mu m$ come da datasheet del sensore adottato.`
        ),
    ]
    // Case drifted while quoting: restored with the source's own capital.
    let ev = h.restoreQuotedEvidence('/a.tex: "il valore di picco è $5.5\\,\\mu m$"', indexes)
    check(
        'a grounded quote is rewritten from the source',
        ev.includes('"Il valore di picco è $5.5\\,\\mu m$"'),
        ev
    )
    // Over-escaped backslashes (the JSON habit): grounds via the collapsed form and
    // comes back with the source's single backslashes.
    ev = h.restoreQuotedEvidence(R`/a.tex: "Il valore di picco è $5.5\\,\\mu m$"`, indexes)
    check('over-escaped LaTeX is restored to the real bytes', !ev.includes(R`\\,`), ev)
    // A quote the source cannot supply is left exactly as it was: restoration must
    // never invent, the ungrounded warning handles it.
    const fabricated = '/a.tex: "il valore medio è di 3.2 mm"'
    check('a fabricated quote is left alone', h.restoreQuotedEvidence(fabricated, indexes) === fabricated)
    // An ellipsis-compressed quote spans a gap: out of scope by design.
    const compressed = '/a.tex: "Il valore di picco ... sensore adottato."'
    check('an ellipsis quote is left alone', h.restoreQuotedEvidence(compressed, indexes) === compressed)

    // The match is found in the FOLDED text and read back out of the source through
    // offsetOf, so a character earlier in the file whose folded form is a different
    // length would shift every offset after it and the report would quote the source
    // one or two characters off - plausible-looking, wrong, and only findable by hand.
    // Two shapes produce that: a letter whose lowercase is two code units, and an
    // astral-plane character, which is two code units to begin with. Both occur in real
    // theses (a Turkish surname in the bibliography, a mathematical script capital).
    {
        const want = 'IL Valore Misurato e 12,5\\,mm sul campione'
        const quoted = 'Il testo dice "il valore misurato e 12,5\\,mm sul campione" qui.'
        const shifted = (label, prefix) => {
            const idx = [h.buildSearchIndex('/a.tex', `${prefix}${want} di prova.`)]
            const out = h.restoreQuotedEvidence(quoted, idx)
            check(label, out.includes(`"${want}"`), `${out}   [wanted "${want}"]`)
        }
        shifted('a letter whose lowercase is two code units does not shift the restored span', 'Istanbul, İzmir: ')
        shifted('nor does an astral-plane character', 'Nota \u{1D4D0} : ')
        shifted('control: the same quote with a plain ASCII prefix', 'Nota: ')
    }

    // KNOWN LIMITATION, pinned as it behaves today rather than as we would like it.
    // Restoration only fires on a quote the folded search can FIND. Folding removes
    // case and collapses whitespace, and nothing else: a model that retypes
    // `12,5\,mm` as `12,5 mm` has dropped LaTeX markup, so the quote no longer matches
    // the source, is left exactly as the model wrote it, and keeps its ungrounded
    // warning. That is the safe direction - restoration must never invent text that is
    // not in the file - but it means "the report shows the file's bytes" holds for
    // quotes the model copied, not for quotes it paraphrased.
    {
        const idx = [h.buildSearchIndex('/a.tex', 'Il valore misurato e 12,5\\,mm sul campione di prova, come in tabella.')]
        const dropped = 'Nel testo si legge "Il valore misurato e 12,5 mm sul campione di prova".'
        check(
            'a quote whose LaTeX markup the model dropped is left as the model wrote it',
            h.restoreQuotedEvidence(dropped, idx) === dropped,
            h.restoreQuotedEvidence(dropped, idx)
        )
        check(
            'and it is still reported as ungrounded, so the reader is warned',
            h.countUngroundedQuotes(dropped, idx[0].normalized).missing === 1,
            JSON.stringify(h.countUngroundedQuotes(dropped, idx[0].normalized))
        )
        // Same limitation, the accent form: the model dropped the diacritics, so there
        // is no match to anchor and the span is not touched.
        const accented = [h.buildSearchIndex('/b.tex', 'La percentuàle è del 48,43% sul test set, un risultato alto.')]
        const flattened = 'Il testo dice "La percentuale e del 48,43% sul test set" e non altro.'
        check(
            'a quote the model stripped of its accents is left alone too',
            h.restoreQuotedEvidence(flattened, accented) === flattened,
            h.restoreQuotedEvidence(flattened, accented)
        )
    }
}

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
