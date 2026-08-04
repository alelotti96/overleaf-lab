// Extract the REAL segmentation, ordering, skeleton and pass-plan helpers from the
// controller and test them. These decide what the model is shown for every
// [per-chapter] and [structure] requirement, so a mistake here is not a cosmetic one:
// text that falls out of every segment is text the review silently never reads, while
// still reporting "ok".
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const { runCheck } = await import(pathToFileURL(process.env.CHECKS).href)
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
    `${src.slice(start, end)}; return { requirementScope, stripScopeMarker, isPerFileRequirement, readBracedArgument, plainTitle, orderDocsByInclusion, partitionByInclusion, segmentChapters, segmentText, buildSkeleton, buildPassPlan, countPlannedPasses, PER_CHAPTER_GROUP_SIZE, mergeFileItems, requirementCandidateLabel, collectCandidatePassages, excludeUnreviewedSegments, blankEnvironments, blankSpans, findEnvironmentBlocks }`
)(8)

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---- scope markers ----
check('no marker is document scope', h.requirementScope('5. Every figure has a caption.') === 'document')
check('per-file still recognised', h.requirementScope('3. Spelling. [per-file]') === 'file')
check('per file with a space', h.requirementScope('3. Spelling. [per file]') === 'file')
check('per-chapter recognised', h.requirementScope('6. Captions are self-explanatory. [per-chapter]') === 'chapter')
check('structure recognised', h.requirementScope('28. An abstract is present. [structure]') === 'structure')

// ---- [per-candidate: Label]: closed questions over pattern hits ----
check(
    'per-candidate recognised',
    h.requirementScope('24. No qualitative claim without data. [per-candidate: Vague qualifiers]') === 'candidates'
)
check(
    'the label is extracted verbatim',
    h.requirementCandidateLabel('24. Testo. [per-candidate: Espressioni qualitative]') === 'Espressioni qualitative'
)
check(
    'the marker is stripped from the requirement text',
    h.stripScopeMarker('24. Testo. [per-candidate: Espressioni qualitative]') === '24. Testo.'
)
check(
    'a candidates step plans one pass',
    h.buildPassPlan(['1. X. [per-candidate: L]'], { fileCount: 3, segmentCount: 10 })[0].scope === 'candidates' &&
        h.countPlannedPasses(h.buildPassPlan(['1. X. [per-candidate: L]'], { fileCount: 3, segmentCount: 10 })) === 1
)
{
    const docs = [
        {
            path: '/a.tex',
            text:
                'Prima frase di contesto. Il metodo è molto buono nei test svolti \\cite{x}. Frase successiva di coda. Altro testo.\n' +
                '\\begin{lstlisting}\nrisultato molto buono\n\\end{lstlisting}\n',
        },
        { path: '/refs.bib', text: 'molto buono' },
    ]
    const { candidates, total } = h.collectCandidatePassages(docs, /\bmolto buono\b/, 40)
    check('one candidate per prose hit, none from listings or the .bib', candidates.length === 1 && total === 1, JSON.stringify(candidates))
    check(
        'the window carries the sentence and its tail',
        candidates[0].text.includes('molto buono') &&
            candidates[0].text.includes('\\cite{x}') &&
            candidates[0].text.includes('Frase successiva') &&
            !candidates[0].text.includes('Prima frase'),
        candidates[0].text
    )
    // Each sentence is different, so each hit is a passage of its own: the cap bounds
    // the list the model judges, the total still says how many there were.
    const many = {
        path: '/b.tex',
        text: Array.from({ length: 50 }, (_, i) => `La misura numero ${i} è molto buono nel test.`).join(' '),
    }
    const capped = h.collectCandidatePassages([many], /\bmolto buono\b/, 5)
    check('the cap bounds the list, the total stays exact', capped.candidates.length === 5 && capped.total === 50, `${capped.candidates.length}/${capped.total}`)

    // ---- one passage, not one match ----
    // Seen on the gold set: "molto buoni" and "estremamente accurato" in ONE sentence
    // became two candidates carrying the identical window, so the model judged the
    // same text twice and the report quoted it twice.
    const vague = /\b(molto buoni|estremamente accurato)\b/
    const oneSentence = h.collectCandidatePassages(
        [{ path: '/c.tex', text: 'Frase iniziale. I risultati sono molto buoni e il modello è estremamente accurato secondo i test. Coda finale.' }],
        vague,
        40
    )
    check('two hits in one sentence are one candidate', oneSentence.candidates.length === 1 && oneSentence.total === 1, JSON.stringify(oneSentence.candidates.map(c => c.text)))
    // The window deliberately carries the NEXT sentence, so the dedup must compare
    // sentences and not windows: two hits one sentence apart are two passages.
    const twoSentences = h.collectCandidatePassages(
        [{ path: '/d.tex', text: 'I risultati sono molto buoni nei test svolti. Il modello è estremamente accurato sui dati raccolti. Coda finale.' }],
        vague,
        40
    )
    check('hits in different sentences stay two candidates', twoSentences.candidates.length === 2 && twoSentences.total === 2, JSON.stringify(twoSentences.candidates.map(c => c.line)))
    // The same window reached from two files is two passages: the path is part of
    // what makes a passage the same passage.
    const twoFiles = h.collectCandidatePassages(
        [
            { path: '/e.tex', text: 'I risultati sono molto buoni.' },
            { path: '/f.tex', text: 'I risultati sono molto buoni.' },
        ],
        vague,
        40
    )
    check('the same sentence in two files is two candidates', twoFiles.total === 2, JSON.stringify(twoFiles.candidates.map(c => c.path)))

    // ---- a passage does not need a full stop ----
    // REGRESSION. The dedup compares the hit's own passage, and a passage used to be
    // bounded only by sentence punctuation. A LaTeX list, a table body and a run of
    // headings have none, so every window there degenerated to "350 back, 500 forward",
    // consecutive hits overlapped by far more than half, and each one was dropped: ten
    // \item claims became ONE candidate. The report then said "each of the 1 passages
    // was judged" and read as a clean pass over nine claims nobody had looked at.
    const claim = /\b(molto buono|molto buona|ottimi risultati)\b/
    const items = h.collectCandidatePassages(
        [
            {
                path: '/l.tex',
                text:
                    'Testo introduttivo del capitolo.\n\\begin{itemize}\n' +
                    '\\item il primo risultato e molto buono\n' +
                    '\\item la seconda misura e molto buona\n' +
                    '\\item la terza prova ha dato ottimi risultati\n' +
                    '\\end{itemize}\n',
            },
        ],
        claim,
        40
    )
    check('three claims in three list items are three passages', items.candidates.length === 3 && items.total === 3, `${items.candidates.length}/${items.total}`)
    const rows = h.collectCandidatePassages(
        [
            {
                path: '/t.tex',
                text: '\\begin{tabularx}{ll}\nMetodo A & molto buono \\\\\nMetodo B & ottimi risultati \\\\\n\\end{tabularx}\n',
            },
        ],
        claim,
        40
    )
    check('two claims in two table rows are two passages', rows.candidates.length === 2, `${rows.candidates.length}`)
    const heads = h.collectCandidatePassages(
        [{ path: '/h.tex', text: '\\section{Un risultato molto buono}\nTesto\n\\section{Sono ottimi risultati}\nTesto\n' }],
        claim,
        40
    )
    check('two claims in two headings are two passages', heads.candidates.length === 2, `${heads.candidates.length}`)
    // A bare newline is NOT a boundary: LaTeX reads it as a space, and thesis sources
    // are routinely hard-wrapped mid-sentence. Cutting there would throw away the
    // context the window exists to carry.
    const wrapped = h.collectCandidatePassages(
        [{ path: '/w.tex', text: 'Il metodo proposto e molto buono\nnei test svolti \\cite{x}. Coda finale.' }],
        claim,
        40
    )
    check(
        'a hard-wrapped sentence is still one passage, with its citation',
        wrapped.candidates.length === 1 && wrapped.candidates[0].text.includes('\\cite{x}'),
        JSON.stringify(wrapped.candidates.map(c => c.text))
    )
    // Nothing may go missing from the arithmetic. `hits` counts every time the pattern
    // fired, `total` how many distinct passages those fell in: when they differ the
    // report has to be able to say so, which it could not while the only number
    // survived the deduplication.
    const merged = h.collectCandidatePassages(
        [{ path: '/m.tex', text: 'Frase iniziale. Il metodo e molto buono e la misura e molto buona nei test. Coda.' }],
        claim,
        40
    )
    check('two hits in one passage: one candidate, two hits counted', merged.candidates.length === 1 && merged.total === 1 && merged.hits === 2, JSON.stringify(merged))
}

// ---- what collecting candidates costs ----
// A [per-candidate: Label] requirement runs an admin-written pattern over the whole
// project, synchronously, inside the queue worker. Per match the collector walks back
// 350 characters, scans that lead, slices a 500-character tail and folds ~700
// characters into a dedup key, so the cost is driven by the number of MATCHES and the
// student picks that by what they write: a chapter of nothing but hits measured 31 s
// per megabyte. The ceilings below are loose tripwires, not benchmarks.
{
    const dense = 'molto buono '.repeat(Math.round((500 * 1024) / 12))
    let t0 = Date.now()
    const found = h.collectCandidatePassages([{ path: '/dense.tex', text: dense }], /molto buono/i, 40)
    let ms = Date.now() - t0
    check('500 KB of nothing but pattern hits stays under the budget', ms < 3000, `${ms} ms`)
    // And the arithmetic survives the dedup storm: `hits` counts every time the pattern
    // fired, `total` the distinct passages they fall in. Counting hits after the dedup
    // is what let the report say "each of the 1 passages flagged by the pattern was
    // judged" over a chapter that had tripped it thousands of times.
    check(
        'and the hits are still counted, not lost to the dedup',
        found.hits > 1000 && found.total < found.hits,
        `hits=${found.hits} total=${found.total} candidates=${found.candidates.length}`
    )

    // A pattern that can match the EMPTY string is legal, compiles, and is accepted by
    // the admin save endpoint: `x*` on a document with no x advances one character at
    // a time, so every position in the file opens a candidate window. Measured at
    // 11966 ms on 125 KB before the collector bounded itself.
    const plain = 'a'.repeat(125 * 1024)
    t0 = Date.now()
    h.collectCandidatePassages([{ path: '/plain.tex', text: plain }], /x*/i, 40)
    ms = Date.now() - t0
    check('an empty-matching rubric pattern does not blow up (was 11966 ms at 125 KB)', ms < 3000, `${ms} ms`)
}

// ---- bounded environment scanning ----
// The lazy `\begin{X}[\s\S]*?\end{X}` form these helpers replace was quadratic: every
// unclosed \begin rescanned to the end of the file and failed, then the engine retried
// from the next one. 546 KB of open \begin{figure}, a paste any student can make, was
// 3616 ms of synchronous CPU on Node's single thread, which is the whole instance
// answering nobody. The bounds below are loose tripwires, not benchmarks.
{
    const blanked = h.blankEnvironments(
        'prima\n\\begin{figure}\n\\includegraphics{x}\n\\end{figure}\ndopo\n',
        ['figure']
    )
    check('a terminated environment is blanked', !blanked.includes('includegraphics'), JSON.stringify(blanked))
    check('and its text is kept', blanked.includes('prima') && blanked.includes('dopo'))
    check('blanking preserves the length', blanked.length === 'prima\n\\begin{figure}\n\\includegraphics{x}\n\\end{figure}\ndopo\n'.length)
    check('blanking preserves the line count', blanked.split('\n').length === 6)

    // An environment with no \end blanks NOTHING, exactly as the lazy regex matched
    // nothing. Stretching it to the end of the file would delete the rest of the
    // document from the review.
    const unclosed = h.blankEnvironments('\\begin{figure}\nresto del documento\n', ['figure'])
    check('an unterminated environment blanks nothing', unclosed.includes('resto del documento'), JSON.stringify(unclosed))

    // Nested floats of the same name: the inner \end must not close the outer \begin.
    const nested = h.findEnvironmentBlocks('\\begin{figure}A\\begin{figure}B\\end{figure}C\\end{figure}', ['figure'])
    check('nesting is paired innermost first', nested.length === 2 && nested[0].start === 0 && nested[0].end === 55, JSON.stringify(nested))

    // Overlapping spans are merged into one rebuild, not applied one at a time.
    const spans = h.blankSpans('0123456789', [[2, 5], [4, 8], [1, 3]])
    check('overlapping spans blank exactly their union', spans === '0       89', JSON.stringify(spans))

    const unit = '\\begin{figure}\n\\includegraphics{x}\n'
    const big = unit.repeat(30000)
    const t0 = Date.now()
    h.blankEnvironments(big, ['figure', 'table', 'tabular'])
    const blankMs = Date.now() - t0
    check(`${(big.length / 1024) | 0} KB of unclosed floats is blanked in under a second`, blankMs < 1000, `${blankMs} ms`)
}
check(
    'the marker is stripped whichever it is',
    h.stripScopeMarker('28. An abstract is present. [structure]') === '28. An abstract is present.'
)
// A marker in the middle of a sentence is prose, not a directive: only the end counts.
check(
    'a marker mid-sentence is not a scope',
    h.requirementScope('9. Use [per-chapter] as an example of a marker inside prose.') === 'document'
)

// ---- braced arguments ----
check(
    'nested braces in a title',
    h.readBracedArgument('\\chapter{The reduced \\textbf{model}}', 8).value ===
        'The reduced \\textbf{model}'
)
check('title without markup', h.plainTitle('The reduced \\textbf{model}') === 'The reduced model')
{
    // REGRESSION. A `\chapter{` whose closing brace is missing - a delete in the wrong
    // place, or a \chapter typed inside a listing - used to be walked to the end of the
    // file, once per heading, which is quadratic over a document full of them:
    // segmentChapters measured seconds per megabyte and buildSkeleton the same, both on
    // the queue thread. The cap is what keeps them linear, so it is pinned here rather
    // than left to a timing test that would have to be slow to be meaningful.
    const unclosed = '\\chapter{' + 'x'.repeat(1024 * 1024)
    const read = h.readBracedArgument(unclosed, 8)
    check('an unclosed brace is not read to the end of the file', read.value.length < 5000, `${read.value.length} chars`)
    check('and the walk stops where the value does', read.end - 8 === read.value.length + 1, `end=${read.end} value=${read.value.length}`)
}

// ---- reading order ----
{
    const docs = [
        { path: 'chapter10.tex', text: '\\chapter{Ten}' },
        { path: 'chapter2.tex', text: '\\chapter{Two}' },
        { path: 'main.tex', text: '\\documentclass{book}\n\\input{chapter2}\n\\input{chapter10}' },
    ]
    const order = h.orderDocsByInclusion(docs).map(d => d.path)
    // The whole point: alphabetically chapter10 comes first, in the document it does not.
    check('reading order follows \\input', order.join(',') === 'main.tex,chapter2.tex,chapter10.tex', order.join(','))
}
{
    // The preamble may live in its own file, so the root is the file holding
    // \begin{document}, not the one holding \documentclass. Getting this wrong found
    // no includes at all and fell back to alphabetical order on a real project.
    const docs = [
        { path: 'setup/preamble.tex', text: '\\documentclass{book}\n\\usepackage{amsmath}' },
        { path: 'main.tex', text: '\\input{setup/preamble}\n\\begin{document}\n\\input{two}\n\\input{one}\n\\end{document}' },
        { path: 'one.tex', text: '\\chapter{One}' },
        { path: 'two.tex', text: '\\chapter{Two}' },
    ]
    const order = h.orderDocsByInclusion(docs).map(d => d.path)
    check(
        'the root is the file with begin{document}',
        order.join(',') === 'main.tex,setup/preamble.tex,two.tex,one.tex',
        order.join(',')
    )
}
{
    // A file nobody includes must still be reviewed, and must not disappear.
    const docs = [
        { path: 'main.tex', text: '\\documentclass{book}\n\\input{one}' },
        { path: 'one.tex', text: '\\chapter{One}' },
        { path: 'orphan.tex', text: 'forgotten text' },
    ]
    const order = h.orderDocsByInclusion(docs).map(d => d.path)
    check('an unreferenced file is kept, last', order.join(',') === 'main.tex,one.tex,orphan.tex', order.join(','))
}
{
    const docs = [{ path: 'b.tex', text: 'x' }, { path: 'a.tex', text: 'y' }]
    check('no main file leaves the order alone', h.orderDocsByInclusion(docs).length === 2)
}

// ---- which files the document actually compiles ----
// A project grown out of an older template keeps chapters nothing pulls in. They
// reach no PDF, so reviewing them spends passes on dead text and reports defects the
// author cannot find. Dropping them is only safe when the graph is COMPLETE: an
// include we could not resolve means we cannot tell a dead file from one we failed to
// follow, and reviewing half a thesis while calling it compliant is the worse failure.
{
    const docs = [
        { path: 'main.tex', text: '\\begin{document}\\input{one}\\end{document}' },
        { path: 'one.tex', text: 'live chapter' },
        { path: 'old/two.tex', text: 'chapter from the previous template' },
    ]
    const p = h.partitionByInclusion(docs)
    check('the compiled files are found', p.ordered.map(d => d.path).join(',') === 'main.tex,one.tex')
    check('the orphan is separated', p.orphans.map(d => d.path).join(',') === 'old/two.tex')
    check('and the graph is complete, so it may be dropped', p.complete === true)
}
{
    // One include naming a file the project does not carry, and nothing may be dropped.
    const docs = [
        { path: 'main.tex', text: '\\begin{document}\\input{one}\\input{missing}\\end{document}' },
        { path: 'one.tex', text: 'live chapter' },
        { path: 'two.tex', text: 'is this dead, or the file we failed to resolve?' },
    ]
    const p = h.partitionByInclusion(docs)
    check('an unresolvable include marks the graph incomplete', p.complete === false)
    check('and the orphan is still listed for the caller to keep', p.orphans.length === 1)
}
{
    // With no main file there is no graph at all, so nothing may be dropped either.
    const p = h.partitionByInclusion([{ path: 'a.tex', text: 'no document environment' }])
    check('no main file means no graph to trust', p.complete === false && p.orphans.length === 0)
}
{
    // A chapter reached through two hops is compiled, not an orphan.
    const docs = [
        { path: 'main.tex', text: '\\begin{document}\\input{parts/all}\\end{document}' },
        { path: 'parts/all.tex', text: '\\include{parts/one}' },
        { path: 'parts/one.tex', text: 'deep chapter' },
    ]
    const p = h.partitionByInclusion(docs)
    check('inclusion is followed transitively', p.orphans.length === 0 && p.ordered.length === 3)
}

// ---- segmentation ----
const project = [
    {
        path: 'main.tex',
        text: '\\documentclass{book}\n\\begin{document}\n\\maketitle\n\\tableofcontents\n\\input{c1}\n\\input{c2}\n\\end{document}',
    },
    { path: 'c1.tex', text: '\\chapter{Introduction}\nAims of the work.' },
    {
        path: 'c2.tex',
        text: '\\chapter{Method}\nDescription.\n\\chapter{Conclusions}\nResults and limitations.',
    },
    { path: 'bibliography.bib', text: '@article{x, title={T}}' },
]
{
    const segments = h.segmentChapters(project)
    const titles = segments.map(s => s.title)
    check('two chapters in one file are split', titles.includes('Method') && titles.includes('Conclusions'))
    check('the front matter is a segment of its own', titles[0].startsWith('Front matter'))
    check('a .bib is its own segment', titles.includes('bibliography.bib'))
    check('segment count', segments.length === 5, titles.join(' | '))

    // THE INVARIANT. Every character of every document belongs to exactly one
    // segment: text that falls between the cracks would be text a [per-chapter]
    // requirement reports "ok" on without ever having read it.
    const inputChars = project.reduce((n, d) => n + d.text.length, 0)
    const segmentChars = segments.reduce(
        (n, s) => n + s.docs.reduce((m, d) => m + d.text.length, 0),
        0
    )
    check('no text is lost or duplicated', inputChars === segmentChars, `${inputChars} vs ${segmentChars}`)
}
{
    // The case per-file cannot help with: one file, many chapters.
    const single = [
        {
            path: 'thesis.tex',
            text: '\\documentclass{book}\n\\chapter{One}\na\n\\chapter{Two}\nb\n\\chapter{Three}\nc',
        },
    ]
    const segments = h.segmentChapters(single)
    check('a single-file thesis still splits into chapters', segments.length === 4, `${segments.length}`)
}
{
    const noChapters = [{ path: 'main.tex', text: '\\documentclass{article}\n\\section{One}\ntext' }]
    const segments = h.segmentChapters(noChapters)
    check('a document without chapters gives one segment', segments.length === 1)
}

// ---- acknowledgements are never reviewed ----
// Policy, not a heuristic: they are personal text. A review quoted "non frega
// niente" and first-person sentences out of a ringraziamenti file back at a student
// as violations. Recognition is by SECTION TITLE, so nothing here knows the name of
// anybody's project files.
{
    const withThanks = [
        {
            path: 'main.tex',
            text: '\\begin{document}\n\\input{Frontmatter/ringraziamenti}\n\\input{c1}\n\\end{document}',
        },
        {
            path: 'Frontmatter/ringraziamenti.tex',
            text: '\\chapter*{Ringraziamenti}\nNon me ne frega niente, ringrazio io tutti quanti.\n',
        },
        { path: 'c1.tex', text: '\\chapter{Introduction}\nAims of the work.' },
    ]
    const r = h.excludeUnreviewedSegments(withThanks)
    check('no chapter pass for the acknowledgements', !r.segments.some(s => /Ringraziamenti/i.test(s.title)), r.segments.map(s => s.title).join(' | '))
    check('the introduction is still a chapter', r.segments.some(s => s.title === 'Introduction'))
    const assembled = r.docs.map(d => d.text).join('\n')
    check('the acknowledgements text is gone from the document', !/frega niente/.test(assembled), assembled.slice(0, 120))
    check('and so is the file that held only them', !r.docs.some(d => d.path === 'Frontmatter/ringraziamenti.tex'), r.docs.map(d => d.path).join(', '))
    check('the file is reported as not reviewed', r.files.length === 1 && r.files[0] === 'Frontmatter/ringraziamenti.tex', JSON.stringify(r.files))

    // English projects say it differently, and both spellings exist.
    for (const title of ['Acknowledgements', 'Acknowledgments', 'ACKNOWLEDGEMENTS']) {
        const english = [
            { path: 'main.tex', text: '\\begin{document}\n\\input{acknowledgements}\n\\input{c1}\n\\end{document}' },
            { path: 'acknowledgements.tex', text: `\\chapter*{${title}}\nI thank my family and my cat.\n` },
            { path: 'c1.tex', text: '\\chapter{Introduction}\nAims of the work.' },
        ]
        const e = h.excludeUnreviewedSegments(english)
        check(`"${title}" is excluded too`, !e.docs.map(d => d.text).join('\n').includes('my cat') && e.files.length === 1, e.files.join(','))
    }

    // Conservative by design: a chapter the author wrote, whose title merely CONTAINS
    // the word, is text they are being marked on and stays in the review.
    const nearMiss = [
        { path: 'main.tex', text: '\\begin{document}\n\\input{c1}\n\\end{document}' },
        { path: 'c1.tex', text: '\\chapter{Ringraziamenti e dediche}\nQuesto capitolo è parte della tesi.' },
    ]
    const nm = h.excludeUnreviewedSegments(nearMiss)
    check('a title that only contains the word is NOT excluded', nm.files.length === 0 && nm.docs.map(d => d.text).join('\n').includes('parte della tesi'), nm.segments.map(s => s.title).join(' | '))

    // A file that also holds real chapters keeps them, and keeps its line numbers:
    // blanking preserves every offset, so a finding reported at line 7 is at line 7.
    const mixed = [
        {
            path: 'main.tex',
            text: '\\begin{document}\n\\chapter{Ringraziamenti}\nGrazie a tutti.\n\\chapter{Metodo}\nRiga di metodo.\n\\end{document}',
        },
    ]
    const mx = h.excludeUnreviewedSegments(mixed)
    const kept = mx.docs[0].text
    check('a mixed file survives with its chapters', mx.files.length === 0 && kept.includes('Riga di metodo'), kept)
    check('the acknowledgements chapter is blanked out of it', !kept.includes('Grazie a tutti') && !/Ringraziamenti/.test(kept), kept)
    check('blanking preserves the file length', kept.length === mixed[0].text.length, `${kept.length} vs ${mixed[0].text.length}`)
    check('blanking preserves the line numbers', kept.split('\n').length === mixed[0].text.split('\n').length)
    check('the surviving chapter is still one segment', mx.segments.some(s => s.title === 'Metodo'), mx.segments.map(s => s.title).join(' | '))

    // THE INVARIANT still holds on what is left: every character of every remaining
    // document belongs to exactly one segment.
    const chars = mx.docs.reduce((n, d) => n + d.text.length, 0)
    const segChars = mx.segments.reduce((n, s) => n + s.docs.reduce((m, d) => m + d.text.length, 0), 0)
    check('no text is lost or duplicated after the exclusion', chars === segChars, `${chars} vs ${segChars}`)

    // A project with nothing to exclude must come out exactly as it went in.
    const untouched = h.excludeUnreviewedSegments(project)
    check('a project with no acknowledgements is untouched', untouched.docs === project && untouched.files.length === 0)

    // REGRESSION, the worst defect this exclusion has had. A SEGMENT IS NOT A FILE:
    // segmentChapters appends every following chapterless .tex to whatever segment is
    // open, so a bibliografia.tex that comes after ringraziamenti.tex in \input order
    // belonged to the "Ringraziamenti" segment. The exclusion then blanked it, dropped
    // it from the review, and reported the student's own bibliography under "the
    // acknowledgements are not reviewed" - which also flipped has-bibliography to
    // missing (add a \bibliography that is already there, in a file the review had
    // deleted) and could stop the rubric's Document type pattern from matching at all.
    const following = [
        {
            path: '/main.tex',
            text: '\\begin{document}\n\\input{cap1}\n\\input{ringraziamenti}\n\\input{bibliografia}\n\\end{document}\n',
        },
        { path: '/cap1.tex', text: '\\chapter{Introduzione}\nIl lavoro riguarda X.\n' },
        { path: '/ringraziamenti.tex', text: '\\chapter*{Ringraziamenti}\nGrazie a tutti.\n' },
        { path: '/bibliografia.tex', text: '\\bibliographystyle{plain}\n\\bibliography{refs}\n' },
    ]
    const fw = h.excludeUnreviewedSegments(following)
    const bib = fw.docs.find(d => d.path === '/bibliografia.tex')
    check(
        'a chapterless file that FOLLOWS the acknowledgements survives',
        !!bib && bib.text.includes('\\bibliography{refs}'),
        bib ? JSON.stringify(bib.text) : `dropped; kept=${JSON.stringify(fw.docs.map(d => d.path))}`
    )
    check(
        'and is not reported as "acknowledgements are not reviewed"',
        fw.files.length === 1 && fw.files[0] === '/ringraziamenti.tex',
        JSON.stringify(fw.files)
    )
    check('the acknowledgements themselves are still gone', !fw.docs.map(d => d.text).join('\n').includes('Grazie a tutti'))

    // The same shape with an appendix written with \section only, which is how most of
    // them are written: it has no \chapter, so it too was swallowed.
    const appendix = [
        { path: '/cap1.tex', text: '\\chapter{Introduzione}\nTesto.\n' },
        { path: '/ringraziamenti.tex', text: '\\chapter*{Ringraziamenti}\nGrazie.\n' },
        { path: '/appendice.tex', text: '\\section{Codice sorgente}\nQuesto e il listato del controllore.\n' },
    ]
    const ap = h.excludeUnreviewedSegments(appendix)
    check(
        'an appendix that uses \\section only is not swallowed either',
        ap.docs.some(d => d.path === '/appendice.tex' && d.text.includes('listato del controllore')),
        `kept=${JSON.stringify(ap.docs.map(d => d.path))} skipped=${JSON.stringify(ap.files)}`
    )

    // The exclusion must still stop at the NEXT heading inside the file it starts in,
    // which is the case the bound above must not have widened.
    const twoChapters = [
        {
            path: '/one.tex',
            text: '\\chapter{Ringraziamenti}\nGrazie mille.\n\\chapter{Metodo}\nRiga di metodo.\n',
        },
        { path: '/due.tex', text: 'Coda senza capitolo, appartiene comunque alla review.\n' },
    ]
    const tc = h.excludeUnreviewedSegments(twoChapters)
    check(
        'the excluded span stops at the next heading',
        tc.docs[0].text.includes('Riga di metodo') && !tc.docs[0].text.includes('Grazie mille'),
        JSON.stringify(tc.docs[0].text)
    )
    check(
        'and never reaches a different file',
        tc.docs.some(d => d.path === '/due.tex' && d.text.includes('appartiene comunque')),
        JSON.stringify(tc.docs.map(d => d.path))
    )

    // The harm of swallowing that file was downstream, not in the exclusion itself:
    // has-bibliography went from ok to missing and told the student to add a
    // \bibliography that was already there, in a file the review had just deleted.
    // Asserted through the REAL check, because the two computations are only right
    // together.
    const before = runCheck('has-bibliography', following)
    const after = runCheck('has-bibliography', fw.docs)
    check(
        'the bibliography check still finds the bibliography after the exclusion',
        before.status === 'ok' && after.status === 'ok',
        `before=${before.status} after=${after.status}: ${after.evidence}`
    )
}

// ---- what the exclusion costs ----
// REGRESSION. The blanking used to rebuild the whole file once per excluded span
// (`text.slice(0, start) + blanked + text.slice(end)`, inside the loop), so the cost
// was quadratic in the number of dropped chapters - and the student picks that number
// by writing \chapter{Ringraziamenti} as many times as they like. 1 MB measured 19191
// ms of synchronous CPU, which on Node's single thread is the whole instance answering
// nobody: not the editor, not a compile, not a login. blankSpans does one rebuild for
// every span of a file. A loose tripwire, not a benchmark.
{
    const unit = '\\chapter{Ringraziamenti}\nGrazie a tutti quanti, davvero.\n'
    const many = [{ path: '/grazie.tex', text: unit.repeat(Math.round((1024 * 1024) / unit.length)) }]
    const t0 = Date.now()
    const out = h.excludeUnreviewedSegments(many)
    const ms = Date.now() - t0
    check('1 MB of acknowledgement chapters is excluded in one rebuild', ms < 2000, `${ms} ms`)
    check('and the text really is gone', !out.docs.some(d => d.text.includes('Grazie a tutti')), JSON.stringify(out.files))
}

// ---- skeleton ----
{
    const segments = h.segmentChapters(project)
    const skeleton = h.buildSkeleton(project, segments)
    check('the skeleton reports the table of contents', /table of contents: yes/.test(skeleton))
    check('the skeleton reports the missing abstract', /abstract: no/.test(skeleton))
    check('the skeleton lists every chapter', /Introduction/.test(skeleton) && /Conclusions/.test(skeleton))
    check('the skeleton shows how a chapter opens', /opens with/.test(skeleton))
    // It has to stay small: this is the whole reason [structure] exists.
    check('the skeleton is far smaller than the text', skeleton.length < 4000, `${skeleton.length} chars`)
    check('an outline that fits says nothing about truncation', !/truncated/.test(skeleton))
    // A chapter shown whole carries no "...": the header tells the model to read
    // that as "complete", so it can answer "missing" instead of hedging with n.a.
    check('a short chapter is quoted whole, no ellipsis', !/opens with: "[^"]*\.\.\."/.test(skeleton))
    check('and gets no closing quote of its own', !/closes with/.test(skeleton))
}
// ---- the tail of a clipped chapter travels with the outline ----
// REGRESSION. "The introduction states the aims and the structure" came back n.a. on
// a real thesis ("the full text of the chapter was not provided"): its outline
// paragraph sat in the LAST lines of the introduction, and the skeleton sampled only
// the head. The closing lines are also where conclusions keep their limitations.
{
    const filler = 'Context about space debris and the growing population in orbit. '
    const outlinePara =
        'This thesis is organised as follows: chapter 2 presents the fundamentals, ' +
        'chapter 3 describes the method, chapter 4 concludes with the results.'
    const long = [
        {
            path: 'thesis.tex',
            text: `\\chapter{Introduction}\n${filler.repeat(80)}\n${outlinePara}`,
        },
    ]
    const segments = h.segmentChapters(long)
    const skeleton = h.buildSkeleton(long, segments)
    check('a clipped chapter carries its closing lines', /closes with: "\.\.\./.test(skeleton))
    check(
        'and the structure paragraph at its end is on the page',
        skeleton.includes('organised as follows'),
        skeleton.slice(-300)
    )
    check('the clipped head ends with an ellipsis', /opens with: "[^"]*\.\.\."/.test(skeleton))
}
{
    // A clipped outline used to end with a bare "..." under a header still promising N
    // segments, so a reader (model or human) answered about parts that are simply not
    // on the page as though they were absent from the document.
    const big = Array.from({ length: 400 }, (_, i) => ({
        path: `/cap${i}.tex`,
        text: `\\chapter{Capitolo ${i}}\n${'Testo di riempimento in prosa normale. '.repeat(20)}\n`,
    }))
    const segments = h.segmentChapters(big)
    const skeleton = h.buildSkeleton(big, segments)
    // The cap moved from 24k to 40k when the closing quotes were added to the
    // skeleton: cutting whole segments off the end costs more than a longer prompt.
    check('a long outline is still capped', skeleton.length < 42000, `${skeleton.length} chars`)
    check(
        'and it says where the cut fell',
        /\[outline truncated after segment \d+ of 400/.test(skeleton),
        skeleton.slice(-200)
    )
    const shown = Number((/after segment (\d+) of/.exec(skeleton) || [])[1])
    check(
        'the number it names is the number it showed',
        shown > 0 && shown < 400 && (skeleton.match(/^## \d+\./gm) || []).length === shown,
        `${shown} named, ${(skeleton.match(/^## \d+\./gm) || []).length} shown`
    )
}

// ---- pass plan ----
{
    const requirements = [
        '1. One.',
        '2. Two. [per-chapter]',
        '3. Three. [per-chapter]',
        '4. Four. [per-chapter]',
        '5. Five. [per-chapter]',
        '6. Six. [per-chapter]',
        '7. Seven. [per-chapter]',
        '8. Eight. [structure]',
        '9. Nine. [per-file]',
    ]
    const plan = h.buildPassPlan(requirements, { fileCount: 4, segmentCount: 10 })
    const chapterSteps = plan.filter(s => s.scope === 'chapter')
    check('chapter requirements are grouped', chapterSteps.length === 2, `${chapterSteps.length} groups`)
    check('a group holds at most PER_CHAPTER_GROUP_SIZE', chapterSteps[0].indexes.length === h.PER_CHAPTER_GROUP_SIZE)
    check('the leftover forms its own group', chapterSteps[1].indexes.length === 1)
    check('structure costs one pass', plan.find(s => s.scope === 'structure').passes === 1)
    check('per-file costs one pass per file', plan.find(s => s.scope === 'file').passes === 4)
    // 1 document + 2 chapter groups x 10 + 1 structure + 4 files
    check('total passes', h.countPlannedPasses(plan) === 1 + 20 + 1 + 4, `${h.countPlannedPasses(plan)}`)

    // Every requirement is planned exactly once, in rubric order: a grouping that
    // dropped or reordered one would silently lose a verdict from the report.
    const covered = plan.flatMap(s => s.indexes)
    check('every requirement is planned once', covered.join(',') === requirements.map((_, k) => k).join(','), covered.join(','))
}
{
    // Nothing to split: a chapter marker on a one-segment document must degrade to a
    // normal whole-document pass, not to a "chapter" pass over the same text.
    const plan = h.buildPassPlan(['1. One. [per-chapter]'], { fileCount: 1, segmentCount: 1 })
    check('one segment degrades to document scope', plan[0].scope === 'document')
}
{
    // The progress bar is the only thing telling a student their review is alive, and
    // it is driven by two numbers written in different places: the cost this plan
    // declares, and the increment the run loop performs. They only agree if every
    // scope is priced the way the loop spends it. Two are easy to get wrong: a
    // [check: ...] requirement is a regex sweep and costs NOTHING, and a
    // [per-candidate: ...] one announces a single pass however many batched model
    // calls the candidates turn into. Price either the other way and the bar stops
    // short of the end for the whole run, on every review.
    const requirements = [
        '1. Every figure has a caption. [check: float-caption]',
        '2. No qualitative claim without data. [per-candidate: Vague qualifiers]',
        '3. An abstract is present. [structure]',
        '4. Spelling. [per-file]',
        '5. The work is described in the past tense.',
    ]
    const plan = h.buildPassPlan(requirements, { fileCount: 4, segmentCount: 1 })
    const cost = scope => (plan.find(s => s.scope === scope) || {}).passes
    check('a code-decided requirement costs zero passes', cost('code') === 0, `${cost('code')}`)
    check('and a per-candidate one costs exactly one, whatever it batches', cost('candidates') === 1, `${cost('candidates')}`)
    check('while the rest are priced as before', cost('structure') === 1 && cost('file') === 4 && cost('document') === 1, JSON.stringify(plan.map(s => [s.scope, s.passes])))
    check('total passes with a code-decided requirement', h.countPlannedPasses(plan) === 0 + 1 + 1 + 4 + 1, `${h.countPlannedPasses(plan)}`)
    check('and every requirement is still planned once', plan.flatMap(s => s.indexes).join(',') === '0,1,2,3,4', plan.flatMap(s => s.indexes).join(','))
}
{
    // The shape of a REAL rubric: chapter requirements interrupted by a global one
    // and a structural one. Grouping only strictly consecutive runs would make four
    // groups out of this and cost four times the passes.
    const requirements = [
        '1. A. [per-chapter]',
        '2. B. [per-chapter]',
        '3. C.',
        '4. D. [per-chapter]',
        '5. E. [structure]',
        '6. F. [per-chapter]',
        '7. G. [per-chapter]',
        '8. H. [per-chapter]',
    ]
    const plan = h.buildPassPlan(requirements, { fileCount: 3, segmentCount: 10 })
    const chapterSteps = plan.filter(s => s.scope === 'chapter')
    check(
        'grouping steps over the interruptions',
        chapterSteps.length === 2,
        `${chapterSteps.length} groups`
    )
    check(
        'the first group takes five chapter requirements wherever they sit',
        chapterSteps[0].indexes.join(',') === '0,1,3,5,6',
        chapterSteps[0].indexes.join(',')
    )
    check('the group is emitted at its first requirement', plan[0].scope === 'chapter')
    // 2 groups x 10 + 1 document + 1 structure
    check('total passes with interruptions', h.countPlannedPasses(plan) === 22, `${h.countPlannedPasses(plan)}`)
    const covered = plan.flatMap(s => s.indexes).sort((a, b) => a - b)
    check('still every requirement exactly once', covered.join(',') === '0,1,2,3,4,5,6,7', covered.join(','))
}

// ---- merge wording ----
{
    const results = ['ok', 'missing', 'ok'].map((status, k) => ({
        path: `Chapter ${k}`,
        status,
        evidence: 'e',
        suggestion: '',
    }))
    const merged = h.mergeFileItems('R', results, 'chapters')
    check('the merge says chapters when it merged chapters', /1 of 3 chapters/.test(merged.evidence), merged.evidence)
    const asFiles = h.mergeFileItems('R', results)
    check('the default wording is still files', /1 of 3 files/.test(asFiles.evidence))
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
