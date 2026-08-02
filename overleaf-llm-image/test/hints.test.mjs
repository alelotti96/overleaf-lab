// Extract the REAL buildScanHints/parseScanPatterns from the controller and test:
// built-ins are language-neutral counts ONLY; all content patterns come from the
// rubric's own scan patterns.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.CTRL, 'utf8')
const start = src.indexOf('const FLOAT_ENVIRONMENTS')
const end = src.indexOf('// overleaf-lab: split the rubric guidelines')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate buildScanHints')
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const helpers = new Function(
    'logger',
    `${src.slice(start, end)}; return { buildScanHints, parseScanPatterns, buildStructuralFacts, collectLabels, collectReferencedLabels, findCaptionlessFloats, collectListingLabels, findIncompleteBibEntries, collectDuplicateLabels, documentTypePattern, documentTypeMatches, excludeUnreviewedSegments }`
)({ debug() {} })
const buildScanHints = helpers.buildScanHints
const parseScanPatterns = helpers.parseScanPatterns

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---- structural facts (decidable, language-neutral) ----
const structDocs = [
    {
        path: '/a.tex',
        text: [
            '\\begin{figure}[H]\\includegraphics{x}\\caption{With caption}\\label{fig:ok}\\end{figure}',
            '\\begin{figure}\\includegraphics{y}\\label{fig:nocap}\\end{figure}',
            '\\begin{longtable}{cc} 1 & 2 \\end{longtable}',
            '\\begin{lstlisting}[title={Codice}]\ncode\n\\end{lstlisting}',
            'Come mostra la Figura \\ref{fig:ok} e \\autoref{fig:nocap}, e vedi \\ref{ghost}.',
            '\\hyperref[sec:intro]{introduction}',
            '\\section{Intro}\\label{sec:intro}',
            '\\label{mai:citata}',
        ].join('\n'),
    },
]
const facts = helpers.buildStructuralFacts(structDocs).join('\n')
// 2026-08-01: the longtable is no longer expected here. A captionless longtable is how
// a multi-page list is typeset (the symbols list of three real projects), so the fact
// stops reporting it exactly as the float-caption check stopped requiring it - see the
// regression block "a captionless longtable is not a defect" in checks.test.mjs.
check('captionless float found with env and path', /Floats without a \\caption \(1\)/.test(facts) && /\/a\.tex:\d+ \(figure\)/.test(facts), facts.split('\n')[0])
check('a captionless longtable is not reported as a missing caption', !facts.includes('(longtable)'), facts.split('\n')[0])
check('lstlisting is NOT treated as a float', !facts.includes('lstlisting'))
check('orphan label detected', /\(1 of 4 labels/.test(facts) && facts.includes('mai:citata'), facts.split('\n')[1])

// Classification: the code must not blur "a figure is never cited" (usually a
// defect) with "an equation label is never cited" (usually fine). Which of them
// matters is the rubric's call, so the fact has to keep them apart.
const kindDocs = [
    {
        path: '/k.tex',
        text: [
            '\\begin{figure}\\caption{f}\\label{orphanFigure}\\end{figure}',
            '\\begin{table}\\caption{t}\\label{orphanTable}\\end{table}',
            '\\begin{equation} E=mc^2 \\label{orphanEquation}\\end{equation}',
            '\\chapter{Titolo}\\label{orphanChapter}',
            'Plain text with no environment. \\label{orphanLoose}',
        ].join('\n'),
    },
]
const kindFacts = helpers.buildStructuralFacts(kindDocs).join('\n')
// The kind must travel WITH each entry, because the entry is what ends up quoted in
// the report: a heading left behind turns "a figure is never cited" into "a label is
// never referenced", which the author cannot act on.
check('figure label classified inline', /orphanFigure \(figure, \/k\.tex:\d+\)/.test(kindFacts), kindFacts.split('\n')[1])
check('table label classified inline', /orphanTable \(table, \/k\.tex:\d+\)/.test(kindFacts))
check('equation label classified inline', /orphanEquation \(equation, \/k\.tex:\d+\)/.test(kindFacts))
check('section label classified inline', /orphanChapter \(section, \/k\.tex:\d+\)/.test(kindFacts))
check('breakdown counts every kind', /1 figure, 1 table, 1 equation, 2 section/.test(kindFacts))
check('floats listed before sectioning', kindFacts.indexOf('orphanFigure') < kindFacts.indexOf('orphanChapter'))

// ---- an \href is a link, not a cross-reference ----
// REGRESSION: "href" ends in the letters "ref", so any ref pattern written as
// `[a-zA-Z]*ref` swallows \href{url}{text} and reads the URL as a label name. That is
// what happened in the checks module, where 9 links of a real report came back as
// references to labels that do not exist. The exclusion is explicit here so the fact
// side cannot drift into the same bug, and \hyperref[label] must keep counting.
{
    const linkDocs = [
        {
            path: '/h.tex',
            text: [
                '\\href{https://example.org/page}{il sito} e \\href{https://x.org}{un altro}',
                '\\section{Intro}\\label{ok}',
                '\\hyperref[ok]{torna all\'introduzione}',
                'Vedi \\ref{ghost}.',
            ].join('\n'),
        },
    ]
    const referenced = helpers.collectReferencedLabels(linkDocs)
    check('an \\href URL is not a referenced label', !referenced.has('https://example.org/page'), [...referenced].join(', '))
    check('\\hyperref[ok] still references its label', referenced.has('ok'))
    check('a real \\ref is still collected', referenced.has('ghost'))
    const linkFacts = helpers.buildStructuralFacts(linkDocs).join('\n')
    const undefinedLine = linkFacts.split('\n').find(l => l.includes('undefined labels')) || ''
    check('no URL is reported as an undefined label', !undefinedLine.includes('example.org'), undefinedLine)
    check('the real dangling reference is still reported', /undefined labels \(1\)/.test(undefinedLine), undefinedLine)
}

// ---- a listing labels itself in its option list, not with \label ----
// The listings package takes `label={lst:x}` among the environment options, and a
// \label written after \end{lstlisting} attaches to whatever counter was stepped
// last. Reading \label{} alone reported every correctly labelled listing as a
// reference to an undefined label.
{
    const listingDocs = [
        {
            path: '/l.tex',
            text: [
                '\\begin{lstlisting}[style=Matlabstyle, caption={Codice [MATLAB], con virgola}, label={lst:code}]',
                'x = 1;',
                '\\end{lstlisting}',
                'Vedi il Listato \\ref{lst:code} e il Listato \\ref{lst:file}.',
                '\\lstinputlisting[language=Python, label=lst:file]{script.py}',
                '\\begin{lstlisting}[label={lst:maiCitato}]',
                'y = 2;',
                '\\end{lstlisting}',
            ].join('\n'),
        },
    ]
    const listingFacts = helpers.buildStructuralFacts(listingDocs).join('\n')
    const labels = helpers.collectLabels(listingDocs)
    check('label survives a caption containing brackets and a comma', labels.has('lst:code'))
    check('label without braces is read', labels.has('lst:file'))
    check('listing label is not reported as undefined', !/References to undefined labels \(/.test(listingFacts), (listingFacts.split('\n').find(l => l.includes('undefined labels')) || '').slice(0, 120))
    check('unreferenced listing keeps its kind', /lst:maiCitato \(listing, \/l\.tex:\d+\)/.test(listingFacts), (listingFacts.split('\n').find(l => l.includes('never referenced')) || '').slice(0, 140))
}

// ---- labels defined more than once ----
// LaTeX's "multiply defined labels": every \ref to the key resolves to the LAST
// definition, so the reader is sent to the wrong equation with nothing visible in
// the PDF. Real defect: a master thesis defined \label{eq: transfer} four times.
{
    const dupDocs = [
        {
            path: '/one.tex',
            text: [
                '\\begin{equation} a \\label{eq: transfer}\\end{equation}',
                '\\begin{equation} b \\label{eq: transfer}\\end{equation}',
                '\\begin{figure}\\caption{f}\\label{fig:unica}\\end{figure}',
            ].join('\n'),
        },
        { path: '/two.tex', text: '\\begin{equation} c \\label{eq: transfer}\\end{equation}' },
    ]
    const dupFacts = helpers.buildStructuralFacts(dupDocs).join('\n')
    const line = dupFacts.split('\n').find(l => l.includes('defined more than once')) || ''
    check('duplicate label reported once, with its count', /Labels defined more than once \(1/.test(dupFacts), line.slice(0, 160))
    check('every definition is located', /\/one\.tex:1/.test(line) && /\/one\.tex:2/.test(line) && /\/two\.tex:1/.test(line), line.slice(0, 160))
    check('a label defined once is not listed', !line.includes('fig:unica'), line.slice(0, 160))
    // The neighbouring facts say "none" out loud rather than going silent, so this
    // one does too: a missing line is not an answer.
    const cleanFacts = helpers.buildStructuralFacts([
        { path: '/clean.tex', text: '\\begin{figure}\\caption{f}\\label{fig:a}\\end{figure}\nVedi \\ref{fig:a}.' },
    ]).join('\n')
    check('no duplicates says so', cleanFacts.includes('- Labels defined more than once: none.'), cleanFacts)
    // A fact, never a verdict: no check verdict changes because of it.
    check('the duplicate fact is not a check', !/\[check:/.test(line))
}

// ---- citation integrity (only when a .bib is part of the document) ----
const citeDocs = [
    {
        path: '/references.bib',
        text: '@article{usata,\n title={A},\n}\n\n@misc{maiCitata,\n title={B},\n}\n',
    },
    {
        path: '/body.tex',
        text: 'Come mostra \\cite{usata} e \\citep[p. 3]{fantasma}, oltre a \\cite{usata,altroFantasma}.',
    },
]
const citeFacts = helpers.buildStructuralFacts(citeDocs).join('\n')
check('undefined citation keys reported with where they are cited', /undefined bibliography keys \(2/.test(citeFacts) && citeFacts.includes('fantasma') && citeFacts.includes('altroFantasma'), (citeFacts.split('\n').find(l => l.includes('undefined bibliography')) || '').slice(0, 130))
check('cited key is not reported as undefined', !/\busata \(cited/.test(citeFacts))
check('uncited bib entry reported', /never cited \(1 of 2\)/.test(citeFacts) && citeFacts.includes('maiCitata'))
// Without a .bib every key would look undefined: that would report our own blind
// spot as a defect of the document.
const noBib = helpers.buildStructuralFacts([
    { path: '/body.tex', text: 'Testo con \\cite{qualcosa}.' },
]).join('\n')
check('no citation lines when the bibliography is absent', !noBib.includes('bibliography keys'))

// A hand-written thebibliography IS the bibliography of many internship reports, and
// reading only .bib files made every \cite in them look undefined and every entry
// look uncited. Real defect, found on a real report.
{
    const inlineBib = helpers.buildStructuralFacts([
        {
            path: '/biblio.tex',
            text:
                '\\begin{thebibliography}{9}\n' +
                '\\bibitem{usata} A. Autore, Titolo, 2020.\n' +
                '\\bibitem[MC21]{maiCitata} B. Autore, Altro, 2021.\n' +
                '\\end{thebibliography}\n',
        },
        { path: '/body.tex', text: 'Come mostra \\cite{usata} e \\cite{fantasma}.' },
    ]).join('\n')
    check('bibitem keys are known keys', /undefined bibliography keys \(1/.test(inlineBib) && inlineBib.includes('fantasma'), (inlineBib.split('\n').find(l => l.includes('undefined bibliography')) || '').slice(0, 130))
    check('a cited bibitem is not undefined', !/\busata \(cited/.test(inlineBib))
    check('an uncited bibitem is reported', /never cited \(1 of 2\)/.test(inlineBib) && inlineBib.includes('maiCitata'))
    // Completeness stays a .bib fact: "none missing" over entries no parser can read
    // would be a pass nobody verified.
    check('no completeness claim without a .bib', !inlineBib.includes('missing author, title, year'), (inlineBib.split('\n').find(l => l.includes('missing')) || '').slice(0, 130))
}

// ---- regressions found by the code audit ----
// \nocite{*} is "print everything", not a citation key.
{
    const facts = helpers.buildStructuralFacts([
        { path: '/r.bib', text: '@article{alpha,\n title={A},\n}\n@book{beta,\n title={B},\n}\n' },
        { path: '/b.tex', text: 'Testo \\cite{alpha}.\n\\nocite{*}\n' },
    ]).join('\n')
    check('nocite star is not an undefined key', !/undefined bibliography keys \(/.test(facts), (facts.split('\n').find(l => l.includes('undefined bibliography')) || '').slice(0, 100))
    check('nocite star makes every entry cited', !facts.includes('never cited ('))
}
// Bibliography completeness: BibTeX's own required fields, plus author/title/year
// whatever the type. A @misc with no year must be reported (that is where a bare
// link ends up) but NOT called a BibTeX violation, since @misc requires nothing.
{
    const f = helpers.buildStructuralFacts([
        {
            path: '/r.bib',
            text: [
                '@article{completo,\n author={A},\n title={T},\n journal={J},\n year={2020},\n}',
                '@article{senzaAnno,\n author={A},\n title={T},\n journal={J},\n}',
                '@misc{soloLink,\n title={Pagina {Web} {Annidata}},\n url={http://x},\n}',
                '@book{ok,\n author={B},\n title={Libro},\n publisher={P},\n year={1999},\n}',
            ].join('\n\n'),
        },
        { path: '/b.tex', text: '\\cite{completo}\\cite{senzaAnno}\\cite{soloLink}\\cite{ok}' },
    ]).join('\n')
    const line = f.split('\n').find(l => l.includes('missing fields')) || ''
    check('article without year reported as a BibTeX requirement', /senzaAnno \(@article, no year, required by BibTeX/.test(line), line.slice(0, 160))
    check('misc missing author and year reported without claiming BibTeX requires them', /soloLink \(@misc, no author\/year, \//.test(line), line.slice(0, 200))
    check('complete entries are not reported', !line.includes('completo') && !line.includes('(@book'))
    check('nested braces in a title do not end the entry early', !/soloLink[^|]*no title/.test(line))
}

// cleveref and varioref forms count as references.
{
    const refs = helpers.collectReferencedLabels([
        { path: '/a.tex', text: '\\crefrange{eq:a}{eq:b} \\cpageref{fig:c} \\labelcref{tab:d} \\subref{sub:e}' },
    ])
    check('crefrange names both endpoints', refs.has('eq:a') && refs.has('eq:b'))
    check('cpageref/labelcref/subref count', refs.has('fig:c') && refs.has('tab:d') && refs.has('sub:e'))
}
// A label after a closed wrapfigure is not a figure label.
{
    const f = helpers.buildStructuralFacts([
        { path: '/w.tex', text: '\\begin{wrapfigure}{r}{3cm}\\caption{x}\\end{wrapfigure}\nProsa. \\label{dopoWrap}' },
    ]).join('\n')
    check('label after a closed wrapfigure is not called a figure', !/dopoWrap \(figure/.test(f), (f.split('\n')[1] || '').slice(0, 120))
}
// glossaries declarations and optional arguments.
{
    const f = helpers.buildStructuralFacts([
        { path: '/g.tex', text: '\\newglossaryentry{latency}{name=latency}\n\\newacronym{gpu}{GPU}{Graphics Unit}\nTesto \\gls{latency} e \\gls[hyper=false]{gpu}.' },
    ]).join('\n')
    check('newglossaryentry counts as declared', !f.includes('latency'), (f.split('\n').find(l => l.includes('never declared')) || 'nessuna riga'))
    check('optional argument does not hide a use', !/never used \(1/.test(f))
}
// Counts must cover the forms a real document uses.
{
    const hints2 = buildScanHints([
        { path: '/c.tex', text: 'Vedi \\citep{x}, \\citet{y} e \\cref{z}, \\autoref{w}.' },
    ])
    const counts = hints2.split('\n')[1]
    check('counts include citep/citet and cref/autoref', /2 \\ref/.test(counts) && /2 \\cite/.test(counts), counts)
}

// ---- acronym bookkeeping ----
const acroDocs = [
    {
        path: '/acronyms.tex',
        text: [
            '\\begin{acronym}',
            '\\acro{USED}{Used Acronym}',
            '\\acro{NEVER}{Never Used Acronym}',
            '\\end{acronym}',
            '\\newacronym{GLOSSED}{GL}{Glossaries Entry}',
        ].join('\n'),
    },
    {
        path: '/body.tex',
        text: 'Come mostra \\acs{USED} e \\acl{USED}, mentre \\gls{GLOSSED} e \\ac{PHANTOM} compaiono qui.',
    },
]
const acroFacts = helpers.buildStructuralFacts(acroDocs).join('\n')
check('unused acronym reported', /declared but never used \(1 of 3\)/.test(acroFacts) && acroFacts.includes('NEVER'), (acroFacts.split('\n').find(l => l.includes('never used')) || '').slice(0, 120))
check('acronym used via \\acs counts as used', !/USED \(/.test(acroFacts))
check('glossaries entry used via \\gls counts as used', !acroFacts.includes('GLOSSED ('))
check('acronym used but never declared reported', /used but never declared \(1\)/.test(acroFacts) && acroFacts.includes('PHANTOM'))

// REGRESSION: writing the letters in the prose is a use. Counting only the package
// macros reported all nine acronyms of a real internship report as "declared and never
// used", and handed that to the model as a mechanical fact on the same page where the
// first-use requirement was listing those same acronyms as used.
{
    const bare = helpers
        .buildStructuralFacts([
            {
                path: '/acronyms.tex',
                text: '\\begin{acronym}[GNSS]\n\\acro{GNSS}{Global Navigation Satellite System}\n\\acro{NEVER}{Never Used}\n\\end{acronym}',
            },
            { path: '/body.tex', text: 'Il ricevitore GNSS fornisce la posizione.' },
        ])
        .join('\n')
    check(
        'the bare letters in the prose count as a use',
        /declared but never used \(1 of 2\)/.test(bare) && bare.includes('NEVER') && !/GNSS \(/.test(bare),
        (bare.split('\n').find(l => l.includes('never used')) || '').slice(0, 120)
    )
    // and the width key of the list is not prose
    check('the acronym list itself is not a use', !/declared but never used \(0/.test(bare))
}

const acroClean = helpers.buildStructuralFacts([
    { path: '/a.tex', text: '\\acro{OK}{Fine}\nTesto con \\ac{OK}.' },
]).join('\n')
check('all-used phrasing is explicit', acroClean.includes('Acronyms declared but never used: none'))
check('no undeclared line when there are none', !acroClean.includes('used but never declared'))
// A document with no acronym machinery must not get acronym lines at all.
const noAcro = helpers.buildStructuralFacts([{ path: '/n.tex', text: 'Solo testo.' }]).join('\n')
check('no acronym lines without declarations', !noAcro.includes('Acronyms'))
check('kind policy is left to the guidelines', kindFacts.includes('for the guidelines to say'))
// A label after a CLOSED environment belongs to no float.
const closedFacts = helpers.buildStructuralFacts([
    { path: '/c2.tex', text: '\\begin{figure}\\caption{x}\\end{figure}\nSome prose. \\label{afterFloat}' },
]).join('\n')
check('label after a closed float is not called a figure', !/figure 1: afterFloat/.test(closedFacts), closedFacts.split('\n')[1])
check('autoref counts as a reference', !facts.split('\n')[1].includes('fig:nocap'))
check('hyperref[..] counts as a reference', !facts.split('\n')[1].includes('sec:intro'))
check('broken ref detected', /undefined labels \(1\)/.test(facts) && facts.includes('ghost'), facts.split('\n')[2])

const cleanFacts = helpers.buildStructuralFacts([
    { path: '/b.tex', text: '\\begin{figure}\\caption{c}\\label{l}\\end{figure}\nvedi \\ref{l}' },
]).join('\n')
check('all-clean phrasing is explicit', cleanFacts.includes('Floats without a \\caption: none') && cleanFacts.includes('Labels never referenced: none') && cleanFacts.includes('undefined labels: none'), cleanFacts)

check('cref list splits on commas', helpers.collectReferencedLabels([{ path: '/c.tex', text: '\\cref{a,b}' }]).size === 2)
check('starred ref form', helpers.collectReferencedLabels([{ path: '/c.tex', text: '\\ref*{z}' }]).has('z'))
check('caption with optional arg counts', helpers.findCaptionlessFloats([{ path: '/d.tex', text: '\\begin{table}\\caption[short]{long}\\end{table}' }]).length === 0)

// 1) built-ins: neutral LaTeX counts, nothing else
const docA = {
    path: '/Mainmatter/1_intro.tex',
    text: [
        '\\begin{figure}[H]',
        '\\caption{Prima figura \\cite{esa}}',
        '\\end{figure}',
        '\\begin{figure}',
        '\\caption{Seconda figura}',
        '\\end{figure}',
        'Come mostra la Figura \\ref{fig1}, i detriti \\cite{esoc} aumentano.',
        '\\begin{equation} E = mc^2 \\end{equation}',
    ].join('\n'),
}
let hints = buildScanHints([docA])
check('counts line', hints.includes('2 figure environments') && hints.includes('2 \\caption') && hints.includes('1 equation environments') && hints.includes('1 \\ref') && hints.includes('2 \\cite'), hints.split('\n')[1])
check('NO hardcoded language scans', !/First-person|wikipedia|Relative/i.test(hints), hints)
// header + counts + the structural facts, and nothing else when the rubric has no
// patterns. The number is asserted so that adding a fact stays a deliberate act: every
// line of this block is put in front of the model on every single pass.
// 9 as of 2026-07-31: the sentence-length fact joined (the "split long sentences"
// requirement the rubrics now carry needed its candidate list).
// 10 as of 2026-07-31: labels defined more than once joined, after a master thesis
// shipped with four \label{eq: transfer} competing for the same key.
check('built-in block is header + counts + facts only', hints.split('\n').length === 10, `${hints.split('\n').length} lines`)

// 2) rubric-defined patterns drive everything content-related
const patterns = parseScanPatterns(
    'Prima persona :: (?<![\\w.@/])(io|noi|ho)\\b|\\b[a-zA-Zà-ù]{2,}iamo\\b\nWikipedia :: wikipedia\nRimandi relativi :: \\b(figura|tabella)\\s+(seguente|sottostante)'
)
check('3 rubric patterns parsed', patterns.length === 3)

hints = buildScanHints(
    [{ path: '/Mainmatter/3_metodo.tex', text: 'In questo capitolo descriviamo il metodo.\nHo scelto questo approccio.' }],
    patterns
)
const fpLine = hints.split('\n').find(l => l.includes('Prima persona'))
check('rubric pattern detects -iamo', !!fpLine && fpLine.includes('descriviamo'), (fpLine || '').slice(0, 90))
check('rubric pattern detects Ho', !!fpLine && fpLine.includes('Ho scelto'))
check('path carried', !!fpLine && fpLine.includes('/Mainmatter/3_metodo.tex'))

// 3) the .io lookbehind (now a documented example, still must WORK when a rubric uses it)
hints = buildScanHints(
    [{ path: '/references.bib', text: 'note = {Documentation at https://autognc-starfish.readthedocs.io/},' }],
    patterns
)
check('.io TLD not flagged by lookbehind pattern', (hints.split('\n').find(l => l.includes('Prima persona')) || '').includes('none found'))
hints = buildScanHints([{ path: '/a.tex', text: 'Io ritengo che il metodo funzioni.' }], patterns)
check('sentence-initial Io still flagged', (hints.split('\n').find(l => l.includes('Prima persona')) || '').includes('Io ritengo'))

// 4) none-found phrasing for rubric patterns
hints = buildScanHints([{ path: '/b.tex', text: 'Testo impersonale senza pattern.' }], patterns)
check('none found per rubric pattern', (hints.split('\n').find(l => l.includes('Wikipedia')) || '').includes('none found'))

// 4b) a candidate is a MATCH, not a matching line. The block calls itself exhaustive,
// and a line that trips the pattern three times is three things for the reader to
// judge: counting it once under-reports the very scan being described.
{
    const many = buildScanHints(
        [{ path: '/a.tex', text: 'Come citato da Wikipedia, e ancora Wikipedia, e infine Wikipedia.' }],
        parseScanPatterns('Wikipedia :: wikipedia')
    )
    const line = many.split('\n').find(l => l.includes('Wikipedia')) || ''
    check('three hits on one line are three candidates', /\(3 candidates/.test(line), line)
    check(
        'and the line is still shown once',
        (line.match(/\/a\.tex: "/g) || []).length === 1,
        'the excerpt exists to show the reader where to look, not to be counted'
    )
    check(
        'a count that fits its excerpts says nothing about lines',
        !/matching lines/.test(line),
        line
    )
}
{
    // Over the cap the sentence has to say what it is showing, in lines, next to a
    // total counted in matches: two different questions, two different numbers.
    const docs = Array.from({ length: 20 }, (_, i) => ({
        path: `/c${i}.tex`,
        text: 'Wikipedia e ancora Wikipedia.',
    }))
    const line =
        buildScanHints(docs, parseScanPatterns('Wikipedia :: wikipedia'))
            .split('\n')
            .find(l => l.includes('Wikipedia')) || ''
    check(
        'the total counts every hit',
        /\(40 candidates/.test(line),
        line.slice(0, 120)
    )
    check(
        'and the excerpt cap is expressed in the lines it shows',
        /showing the first 15 of 20 matching lines/.test(line),
        line.slice(0, 160)
    )
}

// 5) parseScanPatterns robustness (unchanged contract)
const parsed = parseScanPatterns('Anglicismi :: \\b(performance|feedback)\\b\nperformance\n\nBroken :: [invalid(\n :: \n')
check('valid labelled line', parsed.some(p => p.label === 'Anglicismi'))
check('bare word becomes label+pattern', parsed.some(p => p.label === 'performance'))
check('invalid regex skipped', !parsed.some(p => p.label === 'Broken'))
check('empty-body line skipped', parsed.length === 2)

// 5b) a fact a parser already answers is NOT put in front of the model. Which ones are
// dropped follows the rubric: it is the set of [check: ...] markers the rubric uses.
{
    const withCheck = buildScanHints([docA], [], new Set(['float-caption', 'crossrefs-resolve']))
    check('a fact answered by a check is dropped', !/Floats without a/.test(withCheck), withCheck)
    check('and so is the one for the other check', !/References to undefined labels/.test(withCheck))
    check('the facts nobody checks stay', /Captions of four words or fewer/.test(withCheck))
    const without = buildScanHints([docA], [], new Set())
    check('with no checks the block is unchanged', /Floats without a/.test(without))
    // The unit fact was the one the model re-derived and mis-transcribed on a real
    // thesis (correct thin spaces retyped as commas), so when the rubric hands units
    // to the parser the fact must vanish entirely, "none" line included.
    const unitDoc = { path: '/a.tex', text: 'La lunghezza focale vale 12.5mm circa.' }
    const unitAnswered = buildScanHints([unitDoc], [], new Set(['unit-spacing']))
    check('the unit fact is dropped when unit-spacing runs', !/before the unit/.test(unitAnswered), unitAnswered)
    const unitKept = buildScanHints([unitDoc], [], new Set())
    check('and kept when no check answers it', /before the unit/.test(unitKept))
}

// 5c) a number written after "=" is a layout setting, not a measurement. Reporting
// \geometry{left=30mm} as a badly formatted quantity sent the author of a real
// internship report chasing the margins of their own title page.
{
    const layout = buildScanHints([
        { path: '/frontespizio.tex', text: '\\geometry{left=30mm, top=12.5mm}\n\\includegraphics[width=40mm]{logo}' },
    ])
    check('a value after = is not a measurement', /no space before the unit[^\n]*none/i.test(layout) || !/30mm/.test(layout), layout.split('\n').find(l => /space before the unit/.test(l)))
    const prose = buildScanHints([{ path: '/a.tex', text: 'La lunghezza focale vale 12.5mm circa.' }])
    check('a value in prose is still reported', /12\.5mm/.test(prose), prose.split('\n').find(l => /space before the unit/.test(l)))
}

// 6) empty rubric patterns -> counts only (10 lines: see the note on the block count)
hints = buildScanHints([docA], [])
check('no patterns -> built-ins only', hints.split('\n').length === 10)

// 6b) the sentence-length fact: candidates for the "split long sentences" requirement.
{
    const long = 'parola '.repeat(45) + 'fine.\n'
    const h1 = buildScanHints([{ path: '/a.tex', text: long }])
    check(
        'a long sentence is listed with its word count',
        /Sentences of 40 words or more[^\n]*46 words/.test(h1),
        h1.split('\n').find(l => /Sentences/.test(l))
    )
    // A bulleted list is not a sentence, however long it runs: the exact special
    // case the requirement carves out must be carved out here too.
    const listy =
        '\\begin{itemize}\n\\item ' + 'parola '.repeat(50) + '\n\\end{itemize}\nBreve frase.\n'
    const h2 = buildScanHints([{ path: '/a.tex', text: listy }])
    check(
        'a list is not a sentence',
        /Sentences of 40 words or more[^\n]*none/.test(h2),
        h2.split('\n').find(l => /Sentences/.test(l))
    )
    // REGRESSION (real report, user-caught): ".\\" is a sentence boundary. Three
    // 20-word sentences glued by LaTeX line breaks were counted as one 60-word
    // period and quoted to the student as "(87 words)" on a 27-word sentence.
    const glued =
        'parola '.repeat(19) + 'fine.\\\\ ' + 'parola '.repeat(19) + 'fine.\\\\ ' + 'parola '.repeat(19) + 'fine.\n'
    const h3 = buildScanHints([{ path: '/a.tex', text: glued }])
    check(
        'sentences split at .\\\\ line breaks',
        /Sentences of 40 words or more[^\n]*none/.test(h3),
        h3.split('\n').find(l => /Sentences/.test(l))
    )
    // A float is not prose: its options and caption must not pour words into the
    // paragraph that follows it (there is rarely a period before \begin{figure}).
    const floaty =
        '\\begin{figure}[h!]\n\\centering\n\\includegraphics[width=0.7\\textwidth]{img.png}\n\\caption{' +
        'parola '.repeat(30) +
        '}\n\\label{fig:x}\n\\end{figure}\n' +
        'parola '.repeat(20) +
        'fine.\n'
    const h4 = buildScanHints([{ path: '/a.tex', text: floaty }])
    check(
        'a float does not inflate the next sentence',
        /Sentences of 40 words or more[^\n]*none/.test(h4),
        h4.split('\n').find(l => /Sentences/.test(l))
    )
    // A heading has no period, so its words used to join the next sentence.
    const headed =
        '\\subsection*{5.2 Distanza interoculare e altri paragrafi di prova}\n\\addcontentsline{toc}{subsection}{5.2 Distanza}\n' +
        'parola '.repeat(30) +
        'fine.\n'
    const h5 = buildScanHints([{ path: '/a.tex', text: headed }])
    check(
        'a heading does not inflate the next sentence',
        /Sentences of 40 words or more[^\n]*none/.test(h5),
        h5.split('\n').find(l => /Sentences/.test(l))
    )
    // REGRESSION. A sentence is closed by a terminator FOLLOWED by whitespace, a LaTeX
    // line break or a brace. Project text is built as `lines.join('\n')`, which never
    // ends in a newline, so the final full stop of every file in every project closed
    // nothing: the last sentence was missing from the candidate list AND from the "of N
    // sentences" denominator that tells the reader the scale of the measurement.
    const lastLong = 'Frase breve. ' + 'parola '.repeat(45) + 'fine.'
    const h6 = buildScanHints([{ path: '/a.tex', text: lastLong }])
    check(
        'the last sentence of a file is measured',
        /Sentences of 40 words or more[^\n]*46 words/.test(h6),
        h6.split('\n').find(l => /Sentences/.test(l))
    )
    const h7 = buildScanHints([{ path: '/a.tex', text: 'Prima frase. Seconda frase senza newline finale.' }])
    check(
        'and counted in the denominator',
        /none \(of 2 sentences\)/.test(h7),
        h7.split('\n').find(l => /Sentences/.test(l))
    )
    // The fact quotes a file:line the student is expected to open. The line comes from
    // the ORIGINAL text while the sentence offsets come from the blanked copy, so every
    // blanking step has to be length-preserving or the reader is sent to the wrong
    // place - the failure that is most expensive here, because a location that is wrong
    // by a few lines still looks plausible and is only found by hand. One case per kind
    // of blanked block, since each is blanked by a different rule.
    const R = String.raw
    const sentence = 'parola '.repeat(50).trim() + '.'
    const at = (label, lines, want) => {
        const facts = helpers.buildStructuralFacts([{ path: '/a.tex', text: lines.join('\n') }]).join('\n')
        const m = /\/a\.tex:(\d+) \((\d+) words\)/.exec(facts)
        check(
            label,
            !!m && Number(m[1]) === want,
            m ? `line ${m[1]} (${m[2]} words), wanted ${want}` : `not reported :: ${facts.split('\n').find(l => /Sentences/.test(l))}`
        )
    }
    at('a long sentence after a float is located at its own line', ['Frase breve.', R`\begin{figure}`, R`\includegraphics{x}`, R`\caption{Did}`, R`\end{figure}`, sentence, ''], 6)
    at('after a heading', [R`\section{Titolo}`, sentence, ''], 2)
    at('after a display equation', ['Frase breve.', R`\begin{equation}`, 'x = y', R`\end{equation}`, sentence, ''], 5)
    at('after an itemize', ['Frase breve.', R`\begin{itemize}`, R`\item uno`, R`\end{itemize}`, sentence, ''], 5)
    at('after a code listing', ['Frase breve.', R`\begin{lstlisting}`, 'int x = 0;', R`\end{lstlisting}`, sentence, ''], 5)
    at('and at the end of a file with no closing newline', ['Frase breve.', sentence], 2)
}

// 6c) labels defined twice. \label{eq:a} and \label{ eq:a } are two DIFFERENT labels to
// LaTeX - the space goes into the .aux and a \ref against the second resolves to
// nothing - so trimming the key invented a "multiply defined labels" warning LaTeX never
// issues and told the author to delete one of two definitions that are not in conflict.
// The fact is stated to the model as a certainty, so it is believed as printed.
{
    const dup = helpers.collectDuplicateLabels([
        { path: '/a.tex', text: '\\label{eq:a}\n\\label{ eq:a }\n' },
    ])
    check('labels that differ only by spacing are not one duplicate', dup.length === 0, JSON.stringify(dup))
    const real = helpers.collectDuplicateLabels([
        { path: '/a.tex', text: '\\label{eq:a}\ntesto\n\\label{eq:a}\n' },
    ])
    check('a genuine duplicate is still reported with both places', real.length === 1 && real[0].where.length === 2, JSON.stringify(real))
}

// 7b) the float scan is bounded. It used to compile one lazy `\begin{X}[\s\S]*?\end{X}`
// per float environment, so a document full of unclosed floats was rescanned to the end
// of the file once per open float AND once per name: 512 KB measured 6206 ms of
// synchronous CPU, inside the request, on Node's single thread.
{
    const floats = helpers.findCaptionlessFloats([
        {
            path: '/a.tex',
            text:
                '\\begin{figure}\\includegraphics{x}\\end{figure}\n' +
                '\\begin{figure}\\caption{ok}\\end{figure}\n' +
                '\\begin{longtable}{cc}1 & 2\\end{longtable}\n',
        },
    ])
    check('a captionless figure is still found', floats.length === 1 && floats[0].env === 'figure', JSON.stringify(floats))
    check('a captionless longtable is still exempt', !floats.some(f => f.env === 'longtable'), JSON.stringify(floats))
    const unclosed = ('\\begin{figure}\n\\includegraphics{x}\n').repeat(20000)
    const t0 = Date.now()
    helpers.findCaptionlessFloats([{ path: '/a.tex', text: unclosed }])
    const floatMs = Date.now() - t0
    check(`${(unclosed.length / 1024) | 0} KB of unclosed floats scans in under a second`, floatMs < 1000, `${floatMs} ms`)
    const t1 = Date.now()
    buildScanHints([{ path: '/a.tex', text: unclosed }])
    const factMs = Date.now() - t1
    check(`and the whole fact block does too (was 3616 ms at 546 KB)`, factMs < 1000, `${factMs} ms`)
}

// 7) the two scans that used to run to the end of the file when their terminator was
// missing. Linear per occurrence means quadratic over a file full of them: measured at
// 15930 ms for 4000 malformed listings and 2631 ms for 4000 unterminated bib entries,
// synchronous, inside the request, on Node's single thread, so the whole instance
// stopped answering everybody. The bounds below are loose tripwires, not benchmarks.
{
    const listings = ('\\begin{lstlisting}[caption=x\n' + 'code line here\n'.repeat(4)).repeat(4000)
    let t0 = Date.now()
    const found = helpers.collectListingLabels(listings)
    let ms = Date.now() - t0
    check('4000 malformed listings stay linear', ms < 1000, `${ms} ms`)
    check('and a listing with no closing bracket declares no label', found.length === 0)

    const entries = '@article{keyXXXX,\n  title = {T},\n  author = {A},\n'.repeat(4000)
    t0 = Date.now()
    helpers.findIncompleteBibEntries([{ path: '/r.bib', text: entries }])
    ms = Date.now() - t0
    check('4000 unterminated bib entries stay linear', ms < 1000, `${ms} ms`)
}

// 8) and the bounds must not cost the real answers
{
    const good =
        '\\begin{lstlisting}[language=Matlab, caption={Un titolo, con virgola}, label=lst:uno]\ncode\n\\end{lstlisting}\n' +
        '\\begin{lstlisting}[label={lst:due}]\ncode\n\\end{lstlisting}'
    const names = helpers.collectListingLabels(good).map(l => l.name)
    check('a braced caption with a comma is one option', names.join(',') === 'lst:uno,lst:due', JSON.stringify(names))

    const bib =
        '@article{ok,\n  title = {T},\n  author = {A},\n  year = {2020},\n  journal = {J},\n}\n' +
        '@misc{bare,\n  url = {http://x},\n}\n'
    const keys = helpers.findIncompleteBibEntries([{ path: '/r.bib', text: bib }]).map(e => e.key)
    check('a complete entry passes and a bare link does not', keys.join(',') === 'bare', JSON.stringify(keys))
}

// 9) the "Document type" pattern: a directive to the engine, never a hint. It is how
// a rubric recognises its own kind of document mechanically (the title page says
// what a document is), so the pre-review type check runs in code and the pattern
// must NOT reach the model's scan hints.
{
    const withType = parseScanPatterns(
        'Wikipedia :: wikipedia\nDocument type :: Tesi di Laurea in\nAnglicismi :: \\bperformance\\b'
    )
    const tp = helpers.documentTypePattern(withType)
    check('the reserved label is recognised', !!tp && tp.regex.test('Tesi di Laurea in Ingegneria'))
    check('casing and spacing variants count', !!helpers.documentTypePattern(parseScanPatterns('DOCUMENT  TYPE :: x')))
    check('absent pattern gives null', helpers.documentTypePattern(parseScanPatterns('Wikipedia :: wikipedia')) === null)

    const thesis = [{ path: '/Frontmatter/frontespizio.tex', text: 'Tesi di Laurea in\\\\Meccanica Orbitale' }]
    const internship = [{ path: '/frontespizio.tex', text: 'Relazione di tirocinio curriculare in Satelliti' }]
    check('the right document matches', helpers.documentTypeMatches(tp, thesis))
    check('the wrong document does not', !helpers.documentTypeMatches(tp, internship))

    const h = buildScanHints(thesis, withType)
    check('the pattern is kept out of the hints', !h.includes('Document type'), h.split('\n').find(l => l.includes('Document')) || '')
    check('the other rubric patterns still reach the hints', h.includes('Wikipedia') && h.includes('Anglicismi'))

    // The title page is exactly the kind of chapterless file that used to be swallowed
    // by the acknowledgements exclusion when it came after ringraziamenti.tex in \input
    // order. Losing it flipped this test to "nothing in this project matches", and the
    // user was told type_mismatch AFTER waiting out the queue on a job the enqueue check
    // had already accepted. Same pattern, same project, two different answers.
    const withThanks = [
        {
            path: '/main.tex',
            text: '\\begin{document}\n\\input{cap1}\n\\input{ringraziamenti}\n\\input{frontespizio}\n\\end{document}\n',
        },
        { path: '/cap1.tex', text: '\\chapter{Introduzione}\nIl lavoro riguarda X.\n' },
        { path: '/ringraziamenti.tex', text: '\\chapter*{Ringraziamenti}\nGrazie a tutti.\n' },
        { path: '/frontespizio.tex', text: 'Tesi di Laurea in\\\\Ingegneria Aerospaziale\n' },
    ]
    check('the type pattern matches the project as it was read', helpers.documentTypeMatches(tp, withThanks))
    const kept = helpers.excludeUnreviewedSegments(withThanks)
    check(
        'and still matches after the acknowledgements are excluded',
        helpers.documentTypeMatches(tp, kept.docs),
        `kept=${JSON.stringify(kept.docs.map(d => d.path))} skipped=${JSON.stringify(kept.files)}`
    )
}

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
