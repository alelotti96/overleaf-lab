// overleaf-lab: the acronyms and symbols lists, end to end against the REAL
// controller source and the REAL master lists that ship with the module.
//
// Usage, from anywhere:
//   node overleaf-lists-module/test/lists.test.mjs
// or, with every suite of this module at once:
//   node overleaf-lists-module/test/run.mjs
//
// WHY THIS LOOKS UNUSUAL. The controller imports Overleaf internals
// (SessionManager, ProjectEntityHandler, the document updater, the editor
// controller) that only exist inside the container, so it cannot be imported here.
// The suite instead slices the controller's PURE CORE out of the real file and
// evaluates it, which means it exercises the code that actually ships and not a
// copy of it. The cost is that a failing slice is a failing suite: when the anchors
// move the fix is to update them, never to delete the test.
//
// The fixtures are the real shapes this module was written against: the two
// longtable layouts of a real doctoral thesis (\textbf{SHORT}&& Long\\ for
// acronyms, a four column table with the symbol in maths mode for symbols), the
// plain two column tabular and the description list that university templates
// ship, and an internship report that carries no list of symbols at all.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTROLLER =
    process.env.LISTS || fileURLToPath(new URL('../app/src/ListsController.mjs', import.meta.url))
const BUTTON =
    process.env.BUTTON ||
    fileURLToPath(new URL('../frontend/js/components/lists-button.tsx', import.meta.url))
const DATA_DIR = path.dirname(
    process.env.ACRONYMS_MASTER || fileURLToPath(new URL('../data/acronyms-master.txt', import.meta.url))
)

const src = fs.readFileSync(CONTROLLER, 'utf8')

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// Loading the real pure core
// ---------------------------------------------------------------------------

const START = 'const MASTER_FIELD_SEPARATOR ='
const END = '// END OF THE PURE CORE.'
const start = src.indexOf(START)
const end = src.indexOf(END)
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the pure core in ListsController.mjs')
    process.exit(1)
}

const core = eval(
    `${src.slice(start, end)}
;({
    GENERATED_NOTICE,
    parseMasterList, masterDefinition, proseOf, stripComments, unwrapTextFormatting,
    findEnvironments, findMainDoc, resolveIncludePath, orderByInclusion,
    listLanguage, findListRegion, findContainer, parseRows, locateList, prepare,
    regionsByPath, scanProject, symbolToken, acronymKey, entryKeys,
    isAcronymCandidate, singularOf, countAcronymTokens, collectDeclaredAcronyms,
    collectSymbolUse, planAcronyms, planSymbols, applyAdditions, looksAlphabetical,
    compareKeys, chooseTemplate, buildRow, templateForEmptyContainer, summarise,
    detectDocumentLanguage, sectioningLevel, newListFileName, chooseFolder,
    buildNewListFile, planMainInsertion, planPackageInsertion, includeTarget,
    applyLineInsertions, documentText, blankEnvironments, occupiedPaths,
    MAX_NEW_ENTRIES, MAX_DOC_CHARS, cellShell, findUnescapedPercent, prepareDocs,
    renderUnit,
})`
)

const ACRONYM_MASTER = core.parseMasterList(
    fs.readFileSync(path.join(DATA_DIR, 'acronyms-master.txt'), 'utf8')
)
const SYMBOL_MASTER = core.parseMasterList(
    fs.readFileSync(path.join(DATA_DIR, 'symbols-master.txt'), 'utf8')
)

// The whole pipeline, minus the HTTP layer and minus the two Overleaf writes: this
// is what the update handler does between reading the docs and calling
// setDocument, so a test that drives this is testing the shipped behaviour.
function runMerge(rawDocs, kind) {
    const docs = core.orderByInclusion(rawDocs)
    const scan = core.scanProject(docs)
    const found = scan.located[kind]
    if (!found || !found.container) return { found, plan: null, applied: null, scan }
    const plan =
        kind === 'symbols'
            ? core.planSymbols({
                  rows: found.rows,
                  use: scan.symbolUse,
                  master: SYMBOL_MASTER,
                  language: found.language,
              })
            : core.planAcronyms({
                  rows: found.rows,
                  tokenCounts: scan.tokenCounts,
                  declared: scan.declared,
                  master: ACRONYM_MASTER,
                  language: found.language,
              })
    const applied = core.applyAdditions(found.doc.text, found.container, found.rows, plan.additions, kind)
    return { found, plan, applied, scan }
}

function withText(docs, docPath, text) {
    return docs.map(doc => (doc.path === docPath ? { ...doc, text } : doc))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PHD_ACRONYMS = `\\chapter*{List of Acronyms}

\\begin{longtable}[t]{ m{4em} m{3em} m{25em}}
    \\textbf{ADCS}&& Attitude Determination and Control System\\\\
    \\textbf{GNC}&& Guidance Navigation and Control\\\\
    \\textbf{IMU} && Inertial Measurement Unit \\\\
    \\textbf{XML} && Extensible Markup Language \\\\
\\end{longtable}
`

const PHD_SYMBOLS = `\\chapter*{List of Symbols} \\label{chap:Notation}

\\begin{center}
\t\\begin{longtable}[t]{ m{1em} m{7em} m{1cm} m{10cm}  }

% Mathematical Sets and Spaces
& $ \\mathbb{R} $ &  & set of real numbers \\\\[.1mm]
& $ \\mathbf{q} $ &  & unit quaternion \\\\[.1mm]
& $ q_x, q_y, q_z $ &  & quaternion vector components \\\\[.1mm]

\t\\end{longtable}
\\end{center}
`

const PHD_CHAPTER = `\\chapter{Attitude control}

The ADCS uses an IMU. The RAAN of the orbit drifts and the mission flies in
LEO/MEO depending on the phase; the LEO/MEO trade is revisited in the appendix.
The DoF of the platform are six and the DoF budget is tight. The CPOs of the
mission are described in Section~\\ref{sec:cpo}, and the CPOs plan is approved.
The TT\\&C link is sized for the worst case. The \\texttt{ROS} stack publishes at
30 fps and the TF2 tree carries the frames. A 6DOF simulator is used, and the
6DOF results match. An L2 norm closes the loop, and a second L2 term is added.
The TFLite build runs on the OBC.

\\begin{figure}
    \\caption{The \\emph{IoU} of the SDN detector, measured with the CiA profile.}
\\end{figure}

Something else entirely.\\footnote{The ReLU6 activation is used, and ReLU6 again.}

\\section{The \\textbf{VBN} pipeline}

\\begin{equation}
    \\dot{\\mathbf{q}} = \\frac{1}{2}\\, \\boldsymbol{\\omega} \\otimes \\mathbf{q}
\\end{equation}

\\begin{equation}
    \\mathbf{J}\\dot{\\boldsymbol{\\omega}} = \\boldsymbol{\\tau}
\\end{equation}

\\begin{equation}
    a = \\frac{\\mu}{n^2}, \\qquad \\Delta v = 2 v \\sin(\\theta / 2)
\\end{equation}

The gain $w$ is tuned once, and $w$ is tuned again. A one-off $o$ is not a symbol
of the document.
`

const PHD_MAIN = `\\documentclass[12pt]{book}
\\usepackage[english]{babel}
\\usepackage{longtable}
\\begin{document}
\\input{frontmatter/abstract}
\\input{frontmatter/acronyms}
\\input{frontmatter/symbols}
\\mainmatter
\\input{chapters/chapter1}
\\end{document}
`

function phdProject() {
    return [
        { path: '/main.tex', id: 'd1', text: PHD_MAIN },
        { path: '/frontmatter/abstract.tex', id: 'd2', text: '\\chapter*{Abstract}\nA thesis.\n' },
        { path: '/frontmatter/acronyms.tex', id: 'd3', text: PHD_ACRONYMS },
        { path: '/frontmatter/symbols.tex', id: 'd4', text: PHD_SYMBOLS },
        { path: '/chapters/chapter1.tex', id: 'd5', text: PHD_CHAPTER },
    ]
}

// An internship report: it has a list of acronyms and it has NO list of symbols.
// Nothing in it names a template, which is the point: the gate is per file.
function internshipProject() {
    return [
        {
            path: '/relazione.tex',
            id: 'i1',
            text: `\\documentclass{report}
\\usepackage[italian]{babel}
\\begin{document}
\\input{acronimi}
\\chapter{Attivita svolta}
Il sistema ADCS e stato provato. Il modulo GNC e stato integrato.
\\end{document}
`,
        },
        {
            path: '/acronimi.tex',
            id: 'i2',
            text: `\\chapter*{Elenco degli acronimi}
\\begin{tabular}{ll}
ADCS & Attitude Determination and Control System \\\\
GNC & Guidance Navigation and Control \\\\
\\end{tabular}
`,
        },
    ]
}

// ---------------------------------------------------------------------------
// 1. The shipped master lists
// ---------------------------------------------------------------------------

for (const [name, file, minimum, arity] of [
    ['acronyms', 'acronyms-master.txt', 120, 3],
    ['symbols', 'symbols-master.txt', 60, 3],
]) {
    const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8')
    const lines = raw.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'))
    const parsed = core.parseMasterList(raw)
    check(`master/${name}/every line parses`, parsed.size === lines.length, `${parsed.size} of ${lines.length}`)
    check(`master/${name}/enough entries`, parsed.size >= minimum, `${parsed.size} entries`)
    const keys = lines.map(line => line.split('::')[0].trim())
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
    check(`master/${name}/no duplicate keys`, duplicates.length === 0, duplicates.join(', '))
    check(
        `master/${name}/every entry has a definition`,
        lines.every(line => line.split('::').length >= arity && line.split('::')[1].trim().length > 0)
    )
    check(`master/${name}/no empty key`, keys.every(key => key.length > 0))
    // The repo bans the em-dash, and an en-dash inside a definition would be copied
    // verbatim into somebody's thesis.
    check(`master/${name}/no long dashes`, !/[\u2013\u2014]/.test(raw))
}

check(
    'master/acronyms/canonical expansions, not the ones the sources had',
    ACRONYM_MASTER.get('ADCS').en === 'Attitude Determination and Control System' &&
        ACRONYM_MASTER.get('SoC').en === 'System on Chip' &&
        ACRONYM_MASTER.get('COTS').en === 'Commercial Off-The-Shelf' &&
        ACRONYM_MASTER.get('SLAM').en === 'Simultaneous Localization and Mapping'
)
check(
    'master/italian column is a fallback, not a requirement',
    core.masterDefinition(ACRONYM_MASTER.get('ADCS'), 'it') ===
        "Sistema di determinazione e controllo d'assetto" &&
        core.masterDefinition(ACRONYM_MASTER.get('JAXA'), 'it') === 'Japan Aerospace Exploration Agency'
)
check(
    'master/symbols/italian is a real translation',
    core.masterDefinition(SYMBOL_MASTER.get('\\Omega'), 'it') === 'ascensione retta del nodo ascendente' &&
        core.masterDefinition(SYMBOL_MASTER.get('a'), 'it') === 'semiasse maggiore'
)
check('master/parser/comments and blanks are dropped', core.parseMasterList('# c\n\nA :: B :: C\n').size === 1)
check('master/parser/a line with no separator is not an entry', core.parseMasterList('nonsense\n').size === 0)

// ---------------------------------------------------------------------------
// 2. Detection and language, per file and never per template
// ---------------------------------------------------------------------------

{
    const docs = core.orderByInclusion(phdProject())
    const acronyms = core.locateList(docs, 'acronyms')
    const symbols = core.locateList(docs, 'symbols')
    check('detect/phd/acronyms file found', acronyms && acronyms.doc.path === '/frontmatter/acronyms.tex')
    check('detect/phd/symbols file found', symbols && symbols.doc.path === '/frontmatter/symbols.tex')
    check('detect/phd/language from the english heading', acronyms.language === 'en' && symbols.language === 'en')
    check('detect/phd/rows read', acronyms.rows.length === 4, `${acronyms.rows.length} rows`)
    check('detect/phd/symbol rows read', symbols.rows.length === 3, `${symbols.rows.length} rows`)
    check('detect/phd/container is the longtable', acronyms.container.name === 'longtable')
    check('detect/phd/column count read', symbols.container.columns === 4, `${symbols.container.columns}`)
}

{
    const docs = core.orderByInclusion(internshipProject())
    check('detect/internship/acronyms found', core.locateList(docs, 'acronyms') !== null)
    check('detect/internship/NO symbols file', core.locateList(docs, 'symbols') === null)
    check('detect/internship/italian heading', core.locateList(docs, 'acronyms').language === 'it')
}

check(
    'detect/language/heading wins over the file name',
    core.listLanguage('symbols', 'Elenco dei simboli', '/symbols.tex') === 'it' &&
        core.listLanguage('symbols', '', '/simboli.tex') === 'it' &&
        core.listLanguage('acronyms', 'List of Acronyms', '/acronimi.tex') === 'en'
)
check(
    'detect/file name alone is enough',
    core.locateList(
        [{ path: '/simboli.tex', id: 'x', text: '\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}\n' }],
        'symbols'
    ) !== null
)

// ---------------------------------------------------------------------------
// 3. Recall: the forms the scan has to catch
// ---------------------------------------------------------------------------

{
    const docs = core.orderByInclusion(phdProject())
    const scan = core.scanProject(docs)
    const plan = core.planAcronyms({
        rows: scan.located.acronyms.rows,
        tokenCounts: scan.tokenCounts,
        declared: scan.declared,
        master: ACRONYM_MASTER,
        language: 'en',
    })
    const keys = plan.additions.map(entry => entry.key)
    for (const [label, key] of [
        ['mixed case in prose', 'DoF'],
        ['mixed case in a caption', 'CiA'],
        ['mixed case in a footnote', 'ReLU6'],
        ['inside \\emph', 'IoU'],
        ['inside \\texttt', 'ROS'],
        ['lowercase short form from the master', 'fps'],
        ['short form with a digit', 'TF2'],
        ['short form starting with a digit', '6DOF'],
        ['one capital plus a digit', 'L2'],
        ['ampersand inside', 'TT&C'],
        ['plural folded onto its singular', 'CPO'],
        ['piece of a slash compound', 'LEO'],
        ['other piece of a slash compound', 'MEO'],
        ['in a section title', 'VBN'],
        ['plain master hit', 'RAAN'],
    ]) {
        check(`recall/acronyms/${label} (${key})`, keys.includes(key), keys.join(', '))
    }
    check('recall/acronyms/the plural itself is not an entry', !keys.includes('CPOs'))
    check('recall/acronyms/the slash compound itself is not an entry', !keys.includes('LEO/MEO'))
    check('recall/acronyms/already listed entries are not proposed', !keys.includes('ADCS') && !keys.includes('IMU'))
    const filled = new Map(plan.additions.map(entry => [entry.key, entry.definition]))
    check(
        'recall/acronyms/definition comes from the master',
        filled.get('RAAN') === 'Right Ascension of the Ascending Node' &&
            filled.get('CPO') === 'Close Proximity Operations'
    )
    check('recall/acronyms/unknown token arrives blank', filled.get('6DOF') === '' && filled.get('L2') === '')

    const symbolPlan = core.planSymbols({
        rows: scan.located.symbols.rows,
        use: scan.symbolUse,
        master: SYMBOL_MASTER,
        language: 'en',
    })
    const symbolKeys = symbolPlan.additions.map(entry => entry.key)
    for (const [label, key] of [
        ['greek command', '\\omega'],
        ['greek command in a second equation', '\\tau'],
        ['letter wrapped in \\mathbf', 'J'],
        ['lone latin letter', 'a'],
        ['greek mu', '\\mu'],
        ['dummy letter that stands alone', 'n'],
        ['operator', '\\otimes'],
        ['the delta idiom as one symbol', '\\Delta v'],
        ['symbol seen only in inline maths', 'w'],
        ['rotation angle', '\\theta'],
    ]) {
        check(`recall/symbols/${label} (${key})`, symbolKeys.includes(key), symbolKeys.join(', '))
    }
    check(
        'recall/symbols/a lone lowercase letter used once is not a symbol of the document',
        !symbolKeys.includes('o'),
        symbolKeys.join(', ')
    )
    check(
        'recall/symbols/the base symbol is already listed through its decorated form',
        !symbolKeys.includes('q')
    )
    const symbolFilled = new Map(symbolPlan.additions.map(entry => [entry.key, entry.definition]))
    check(
        'recall/symbols/definitions come from the master',
        symbolFilled.get('\\mu') === 'standard gravitational parameter' &&
            symbolFilled.get('J') === 'inertia tensor' &&
            symbolFilled.get('\\Delta v') === 'velocity increment, delta-v'
    )
    check('recall/symbols/unknown symbol arrives blank', symbolFilled.get('w') === '')
    check(
        'recall/symbols/a listed symbol the maths never uses is reported, not removed',
        symbolPlan.unusedKept.includes('R'),
        symbolPlan.unusedKept.join(', ')
    )
}

check('recall/filter/a real word in capitals is not a short form', !core.isAcronymCandidate('NOTA') && !core.isAcronymCandidate('CHAPTER'))
check('recall/filter/a long all-capitals word is not a short form', !core.isAcronymCandidate('SPACECRAFT'))
check('recall/filter/a repeated letter is not a short form', !core.isAcronymCandidate('AAA'))
check('recall/filter/a unit is not a short form', !core.isAcronymCandidate('MHz'))
check('recall/filter/a hyphenated word is not a short form', !core.isAcronymCandidate('Off-The-Shelf'))
check(
    'recall/filter/the shapes that are',
    core.isAcronymCandidate('DoF') &&
        core.isAcronymCandidate('CONOPS') &&
        core.isAcronymCandidate('TF2') &&
        core.isAcronymCandidate('L2')
)
check(
    'recall/plural/GPS is never filed as GP',
    core.singularOf('GPS', ACRONYM_MASTER, new Map()) === null &&
        core.singularOf('CPOs', ACRONYM_MASTER, new Map()) === 'CPO'
)

// ---------------------------------------------------------------------------
// 4. The merge: never destructive, idempotent, in the shape the file already uses
// ---------------------------------------------------------------------------

{
    const docs = phdProject()
    const first = runMerge(docs, 'acronyms')
    check('merge/acronyms/something was added', first.applied.inserted > 0, `${first.applied.inserted}`)

    // Every original line still exists, byte for byte. This is promise number one.
    const before = first.found.doc.text.split('\n')
    const after = first.applied.text.split('\n')
    check(
        'merge/acronyms/every existing line survives byte for byte',
        before.every(line => after.includes(line)),
        before.filter(line => !after.includes(line)).join(' | ')
    )
    check(
        'merge/acronyms/the hand written definition survives',
        first.applied.text.includes('\\textbf{IMU} && Inertial Measurement Unit \\\\')
    )

    // The shape is copied from the last complete row: `\textbf{X} && Long \\`.
    check(
        'merge/acronyms/the row shape is imitated',
        /\n {4}\\textbf\{RAAN\} && Right Ascension of the Ascending Node \\\\/.test(first.applied.text),
        first.applied.text
    )
    check(
        'merge/acronyms/an unknown entry gets an empty cell',
        /\n {4}\\textbf\{L2\} &&  \\\\/.test(first.applied.text),
        'no empty-cell row for L2'
    )
    // The list is alphabetical, so a new row goes at its letter and not at the end.
    const lines = first.applied.text.split('\n')
    const at = key => lines.findIndex(line => line.includes(`\\textbf{${key}}`))
    check(
        'merge/acronyms/alphabetical list keeps its order',
        at('CPO') > at('ADCS') && at('CPO') < at('GNC') && at('VBN') < at('XML'),
        `ADCS ${at('ADCS')} CPO ${at('CPO')} GNC ${at('GNC')} VBN ${at('VBN')} XML ${at('XML')}`
    )
    check('merge/acronyms/the notice is written once', first.applied.text.split(core.GENERATED_NOTICE).length === 2)

    // Idempotence: the same button pressed twice changes nothing the second time.
    const merged = withText(docs, '/frontmatter/acronyms.tex', first.applied.text)
    const second = runMerge(merged, 'acronyms')
    check('merge/acronyms/second run adds nothing', second.applied.inserted === 0, `${second.applied.inserted}`)
    check(
        'merge/acronyms/second run is byte identical',
        second.applied.text === first.applied.text,
        'the file changed on the second press'
    )

    // The realistic sequence: press the button today, write another chapter, press
    // it again. Rows are added a second time and the notice must NOT be, or a
    // thesis that grows over a term collects one warning comment per press.
    const later = withText(
        merged,
        '/chapters/chapter1.tex',
        `${PHD_CHAPTER}\nThe SSO orbit was chosen for the revisit time.\n`
    )
    const third = runMerge(later, 'acronyms')
    check('merge/acronyms/a later run adds the new entry', third.applied.inserted === 1, `${third.applied.inserted}`)
    check(
        'merge/acronyms/a later run does not write a second notice',
        third.applied.text.split(core.GENERATED_NOTICE).length === 2,
        `${third.applied.text.split(core.GENERATED_NOTICE).length - 1} notices`
    )
    check('merge/acronyms/a later run adds SSO', /\\textbf\{SSO\} && Sun-Synchronous Orbit \\\\/.test(third.applied.text))
}

{
    const docs = phdProject()
    const first = runMerge(docs, 'symbols')
    check('merge/symbols/something was added', first.applied.inserted > 0, `${first.applied.inserted}`)
    check(
        'merge/symbols/the four column shape is imitated',
        /\n& \$ \\mu \$ &  & standard gravitational parameter \\\\\[\.1mm\]/.test(first.applied.text),
        first.applied.text
    )
    check(
        'merge/symbols/an unknown symbol gets an empty cell',
        /\n& \$ w \$ &  &  \\\\\[\.1mm\]/.test(first.applied.text),
        'no empty-cell row for w'
    )
    const before = first.found.doc.text.split('\n')
    const after = first.applied.text.split('\n')
    check(
        'merge/symbols/every existing line survives byte for byte',
        before.every(line => after.includes(line))
    )
    // This list is grouped by theme, not sorted, so new rows go at the end where
    // they cannot break the grouping.
    check(
        'merge/symbols/an unsorted list is appended to, not interleaved',
        first.applied.text.indexOf('$ \\mathbb{R} $') < first.applied.text.indexOf('$ \\mu $')
    )
    const merged = withText(docs, '/frontmatter/symbols.tex', first.applied.text)
    const second = runMerge(merged, 'symbols')
    check('merge/symbols/second run adds nothing', second.applied.inserted === 0, `${second.applied.inserted}`)
    check('merge/symbols/second run is byte identical', second.applied.text === first.applied.text)
}

// The two OTHER shapes a university template ships: a plain two column tabular,
// and a description list.
{
    const docs = [
        {
            path: '/main.tex',
            id: 'm',
            text: `\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n`,
        },
        {
            path: '/acronyms.tex',
            id: 'a',
            text: `\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & Attitude Determination and Control System \\\\\n  GNC & Guidance Navigation and Control \\\\\n\\end{tabular}\n`,
        },
        {
            path: '/ch1.tex',
            id: 'c',
            text: `\\chapter{One}\nThe RAAN drifts and the EKF converges.\n`,
        },
    ]
    const merged = runMerge(docs, 'acronyms')
    check(
        'merge/tabular/the two column shape is imitated',
        /\n {2}RAAN & Right Ascension of the Ascending Node \\\\/.test(merged.applied.text),
        merged.applied.text
    )
    check(
        'merge/tabular/existing rows survive',
        merged.applied.text.includes('  ADCS & Attitude Determination and Control System \\\\')
    )
}

{
    const docs = [
        {
            path: '/main.tex',
            id: 'm',
            text: `\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n`,
        },
        {
            path: '/acronyms.tex',
            id: 'a',
            text: `\\chapter*{List of Acronyms}\n\\begin{description}\n  \\item[ADCS] Attitude Determination and Control System\n  \\item[GNC] Guidance Navigation and Control\n\\end{description}\n`,
        },
        { path: '/ch1.tex', id: 'c', text: `\\chapter{One}\nThe RAAN drifts and the EKF converges.\n` },
    ]
    const merged = runMerge(docs, 'acronyms')
    check(
        'merge/description/the item shape is imitated',
        /\n {2}\\item\[RAAN\] Right Ascension of the Ascending Node/.test(merged.applied.text),
        merged.applied.text
    )
    check(
        'merge/description/existing items survive',
        merged.applied.text.includes('  \\item[ADCS] Attitude Determination and Control System')
    )
}

// A list that exists but is EMPTY: there is no row to imitate, so the layout comes
// from the column count and from nowhere else.
{
    const docs = [
        {
            path: '/main.tex',
            id: 'm',
            text: `\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n`,
        },
        {
            path: '/acronyms.tex',
            id: 'a',
            text: `\\chapter*{List of Acronyms}\n\\begin{longtable}{ m{4em} m{3em} m{25em} }\n\\end{longtable}\n`,
        },
        { path: '/ch1.tex', id: 'c', text: `\\chapter{One}\nThe RAAN drifts and the EKF converges.\n` },
    ]
    const merged = runMerge(docs, 'acronyms')
    check(
        'merge/empty container/three columns get the gutter shape',
        /\n {4}\\textbf\{RAAN\}&& Right Ascension of the Ascending Node \\\\/.test(merged.applied.text),
        merged.applied.text
    )
}

// ---------------------------------------------------------------------------
// 5. Creating a list that does not exist
// ---------------------------------------------------------------------------

check(
    'create/file names come from the code, never from a request',
    core.newListFileName('symbols', 'it') === 'simboli.tex' &&
        core.newListFileName('symbols', 'en') === 'symbols.tex' &&
        core.newListFileName('acronyms', 'it') === 'acronimi.tex' &&
        core.newListFileName('acronyms', 'en') === 'acronyms.tex' &&
        core.newListFileName('anything-else', 'en') === null
)

check(
    'create/document language from babel, last option wins',
    core.detectDocumentLanguage([
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\usepackage[english,italian]{babel}\n\\begin{document}\n\\end{document}\n' },
    ]) === 'it'
)
check(
    'create/document language from polyglossia',
    core.detectDocumentLanguage([
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\setdefaultlanguage{italian}\n\\begin{document}\n\\end{document}\n' },
    ]) === 'it'
)
check(
    'create/document language falls back to the words on the page',
    core.detectDocumentLanguage([
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\nIl sistema di controllo della sonda che non riesce a puntare la stella per la manovra.\n\\end{document}\n' },
    ]) === 'it'
)
check('create/document language of the phd fixture is english', core.detectDocumentLanguage(phdProject()) === 'en')

// The generated file, in both languages, populated by the same scan the merge uses.
{
    const docs = core.orderByInclusion(internshipProject())
    const scan = core.scanProject(docs)
    const plan = core.planAcronyms({
        rows: [],
        tokenCounts: scan.tokenCounts,
        declared: scan.declared,
        master: ACRONYM_MASTER,
        language: 'it',
    })
    const italian = core.buildNewListFile({
        kind: 'acronyms',
        language: 'it',
        entries: plan.additions.slice().sort((a, b) => core.compareKeys(a.key, b.key)),
        sectioning: core.sectioningLevel(docs),
    })
    check('create/italian heading', italian.includes('\\chapter*{Elenco degli acronimi}'))
    check('create/italian table of contents entry', italian.includes('\\addcontentsline{toc}{chapter}{Elenco degli acronimi}'))
    check(
        'create/italian definitions come from the italian column',
        italian.includes("\\textbf{ADCS} && Sistema di determinazione e controllo d'assetto \\\\"),
        italian
    )
    check('create/the reference longtable shape is used', italian.includes('\\begin{longtable}[t]{ m{4em} m{3em} m{25em} }'))
    check('create/the notice is at the head of the entries', italian.includes(core.GENERATED_NOTICE))

    const english = core.buildNewListFile({
        kind: 'acronyms',
        language: 'en',
        entries: [
            { key: 'ADCS', definition: 'Attitude Determination and Control System', count: 2 },
            { key: 'ZZZ', definition: '', count: 2 },
        ],
        sectioning: 'chapter',
    })
    check('create/english heading', english.includes('\\chapter*{List of Acronyms}'))
    check('create/an entry with no definition leaves the cell empty', english.includes('\\textbf{ZZZ} &&  \\\\'), english)

    const symbols = core.buildNewListFile({
        kind: 'symbols',
        language: 'it',
        entries: [
            { key: '\\mu', definition: 'parametro gravitazionale standard', unit: 'm^3/s^2', count: 3 },
            { key: 'e', definition: 'eccentricità', unit: '', count: 2 },
        ],
        sectioning: 'chapter',
    })
    check('create/symbols heading in italian', symbols.includes('\\chapter*{Elenco dei simboli}'))
    check(
        'create/symbols use the four column reference shape',
        symbols.includes('\\begin{longtable}[t]{ m{1em} m{7em} m{4em} m{10cm} }'),
        symbols
    )
    // The master carries a unit for most of its symbols and nothing was printing
    // them, which made the data file's own header untrue. A list this module
    // CREATES prints them, because this module chose the columns.
    // Wrapped in maths mode, because a superscript in a plain cell is a LaTeX
    // error: eight of the twenty-four units the shipped list carries have one, and
    // a generated file that does not compile is a worse answer than no unit.
    check(
        'create/the unit is printed in the column this module designed',
        symbols.includes('& $ \\mu $ & $m^3/s^2$ & parametro gravitazionale standard \\\\[.1mm]'),
        symbols
    )
    check(
        'create/a unit that needs no maths mode is left alone',
        core
            .buildNewListFile({
                kind: 'symbols',
                language: 'en',
                entries: [{ key: 'a', definition: 'semi-major axis', unit: 'm', count: 2 }],
                sectioning: 'chapter',
            })
            .includes('& $ a $ & m & semi-major axis \\\\[.1mm]')
    )
    check(
        'create/every shipped unit that needs maths mode gets it',
        [...SYMBOL_MASTER.values()]
            .map(entry => entry.unit)
            .filter(Boolean)
            .every(unit => !/[\\^_]/.test(unit) || core.renderUnit(unit).startsWith('$'))
    )
    check(
        'create/a symbol with no unit leaves the cell empty',
        symbols.includes('& $ e $ &  & eccentricità \\\\[.1mm]'),
        symbols
    )
    check('create/an article class gets \\section, not \\chapter', core.sectioningLevel([
        { path: '/main.tex', id: 'm', text: '\\documentclass[11pt]{article}\n\\begin{document}\n\\end{document}\n' },
    ]) === 'section')
}

// After creation the project HAS the list, so the next press is a merge and the
// create path refuses. This is the same guard that catches the race.
{
    const docs = internshipProject()
    const created = core.buildNewListFile({
        kind: 'symbols',
        language: 'it',
        entries: [{ key: '\\mu', definition: 'parametro gravitazionale standard', count: 2 }],
        sectioning: 'chapter',
    })
    const after = core.orderByInclusion([...docs, { path: '/simboli.tex', id: 'new', text: created }])
    check('create/after creation the list is found', core.locateList(after, 'symbols') !== null)
    check(
        'create/a second create would be refused',
        core.locateList(after, 'symbols') !== null,
        'locateList must be non-null, which is what makes the handler answer list_already_exists'
    )
    // A file sitting at the target path is caught even before that, by the path
    // comparison in the handler: the two guards are independent on purpose.
    check(
        'create/the target path is compared against the project docs',
        after.some(doc => doc.path === '/simboli.tex')
    )
}

// ---------------------------------------------------------------------------
// 6. Hooking the new file into the document
// ---------------------------------------------------------------------------

// (a) The other list is already included: the new one goes next to it.
{
    const docs = core.orderByInclusion(phdProject())
    const main = core.findMainDoc(docs)
    const plan = core.planMainInsertion({
        docs,
        mainDoc: main,
        inputLine: '\\input{frontmatter/nomenclature}',
        otherListPath: '/frontmatter/acronyms.tex',
    })
    check('hookup/adjacent/mode', plan.mode === 'adjacent', plan.mode)
    check('hookup/adjacent/in the main file', plan.path === '/main.tex')
    const written = core.applyLineInsertions(main.text, [plan])
    check(
        'hookup/adjacent/lands right after the other list',
        /\\input\{frontmatter\/acronyms\}\n\\input\{frontmatter\/nomenclature\}\n/.test(written),
        written
    )
}

// (b) No other list, but the document has a \mainmatter.
{
    const docs = core.orderByInclusion([
        {
            path: '/main.tex',
            id: 'm',
            text: `\\documentclass{book}\n\\begin{document}\n\\tableofcontents\n\\mainmatter\n\\input{chapters/one}\n\\end{document}\n`,
        },
        { path: '/chapters/one.tex', id: 'c', text: '\\chapter{One}\nText.\n' },
    ])
    const main = core.findMainDoc(docs)
    const plan = core.planMainInsertion({ docs, mainDoc: main, inputLine: '\\input{symbols}', otherListPath: null })
    check('hookup/before-main/mode', plan.mode === 'before-main', plan.mode)
    const written = core.applyLineInsertions(main.text, [plan])
    check(
        'hookup/before-main/lands before \\mainmatter and after the contents',
        /\\tableofcontents\n\\input\{symbols\}\n\\mainmatter\n/.test(written),
        written
    )
}

// (b bis) No \mainmatter, but a recognisable first chapter include.
{
    const docs = core.orderByInclusion([
        {
            path: '/main.tex',
            id: 'm',
            text: `\\documentclass{book}\n\\begin{document}\n\\input{abstract}\n\\input{chapters/chapter1}\n\\end{document}\n`,
        },
        { path: '/abstract.tex', id: 'a', text: '\\chapter*{Abstract}\nText.\n' },
        { path: '/chapters/chapter1.tex', id: 'c', text: '\\chapter{One}\nText.\n' },
    ])
    const main = core.findMainDoc(docs)
    const plan = core.planMainInsertion({ docs, mainDoc: main, inputLine: '\\input{symbols}', otherListPath: null })
    check('hookup/first chapter/mode', plan.mode === 'before-main', plan.mode)
    check(
        'hookup/first chapter/lands before the chapter',
        /\\input\{abstract\}\n\\input\{symbols\}\n\\input\{chapters\/chapter1\}/.test(
            core.applyLineInsertions(main.text, [plan])
        )
    )
}

// (c) Nothing unambiguous: the main file is NOT touched and the line is handed
// back instead. This is the case the guard exists for.
{
    const main = {
        path: '/main.tex',
        id: 'm',
        text: `\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nText about a system.\n\\end{document}\n`,
    }
    const docs = core.orderByInclusion([main])
    const plan = core.planMainInsertion({
        docs,
        mainDoc: core.findMainDoc(docs),
        inputLine: '\\input{symbols}',
        otherListPath: null,
    })
    check('hookup/manual/mode', plan.mode === 'manual', plan.mode)
    check('hookup/manual/no insertion point is offered', plan.at === undefined && plan.path === undefined)
    check('hookup/manual/the line is handed back', plan.line === '\\input{symbols}')
    // Nothing may reach the main file on this path. The mutation that deletes the
    // guard is expected to make exactly this assertion red.
    check(
        'hookup/manual/the main file is untouched',
        core.applyLineInsertions(main.text, plan.mode === 'manual' ? [] : [plan]) === main.text
    )
}

check(
    'hookup/the longtable package is added only when it is missing',
    core.planPackageInsertion({ path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\usepackage{longtable}\n\\begin{document}\n\\end{document}\n' }) === null &&
        core.planPackageInsertion({ path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\end{document}\n' }).line ===
            '\\usepackage{longtable}'
)
check(
    'hookup/the include target is relative to the main file',
    core.includeTarget({ path: '/main.tex' }, '/frontmatter/simboli.tex') === 'frontmatter/simboli' &&
        core.includeTarget({ path: '/src/main.tex' }, '/src/simboli.tex') === 'simboli'
)
check(
    'hookup/an include that climbs out of the project is refused',
    core.resolveIncludePath('', '../../etc/passwd') === null &&
        core.resolveIncludePath('', 'chapters/one') === '/chapters/one.tex'
)
check(
    'create/the new file goes beside the other front matter',
    core.chooseFolder(core.orderByInclusion(phdProject()), '/frontmatter/acronyms.tex') === '/frontmatter'
)

// ---------------------------------------------------------------------------
// 7. What the panel is told
// ---------------------------------------------------------------------------

{
    const docs = core.orderByInclusion(phdProject())
    const scan = core.scanProject(docs)
    const plan = core.planAcronyms({
        rows: scan.located.acronyms.rows,
        tokenCounts: scan.tokenCounts,
        declared: scan.declared,
        master: ACRONYM_MASTER,
        language: 'en',
    })
    const summary = core.summarise(plan)
    check('payload/entries are named, not only counted', summary.added.length === plan.additions.length)
    check(
        'payload/the names are split into filled and blank',
        summary.addedWithDefinition.includes('RAAN') &&
            summary.addedWithoutDefinition.includes('L2') &&
            !summary.addedWithDefinition.includes('L2')
    )
    check(
        'payload/the two halves account for everything',
        summary.addedWithDefinition.length + summary.addedWithoutDefinition.length === summary.added.length
    )
    check('payload/nothing is truncated in the payload', summary.added.every(entry => typeof entry.key === 'string'))
    check('payload/each entry carries its recurrence', summary.added.every(entry => entry.count >= 1))
    // The report is ordered by recurrence, which is what makes the first names the
    // panel shows the ones worth looking at.
    const counts = plan.additions.map(entry => entry.count)
    check(
        'payload/ordered by recurrence',
        counts.every((count, index) => index === 0 || counts[index - 1] >= count),
        counts.join(',')
    )
}

// ---------------------------------------------------------------------------
// 8. The generated text must not look like unfinished work
// ---------------------------------------------------------------------------

// overleaf-lab: this is a CROSS-MODULE contract with overleaf-llm-image, pinned
// here because the two modules ship separately and this suite cannot import the
// other one. The pattern below is copied verbatim from CHECKS['work-markers'] in
// LLMStructuralChecks.mjs; the placeholder vocabulary beside it is the wider set a
// human reviewer would object to. If the check there ever grows a word, this list
// has to grow with it, and this comment is the reminder.
const WORK_MARKERS =
    /\\(todo|missingfigure|listoftodos)\b|(?<![\p{L}\d])(TODO|FIXME|XXX|HACK|TBD|TBU)(?![\p{L}\d])|(?<![\p{L}\d])TBC(?=\s*:)|(?<=[([{])\s*TBC\s*(?=[)\]}])|(?<![\p{L}\d])[Tt][Oo][ \t]+[Dd][Oo]\s*:|(?<![\p{L}\d])[Dd][Aa][ \t]+[Ff][Aa][Rr][Ee]\s*:/gu
const PLACEHOLDER_WORDS =
    /lorem ipsum|placeholder|segnaposto|da completare|da rivedere|to be (?:completed|defined|done)|work in progress|\?\?\?/i

{
    const createdEnglish = core.buildNewListFile({
        kind: 'acronyms',
        language: 'en',
        entries: [
            { key: 'ADCS', definition: 'Attitude Determination and Control System', count: 3 },
            { key: 'ZZZ', definition: '', count: 2 },
        ],
        sectioning: 'chapter',
    })
    const createdItalian = core.buildNewListFile({
        kind: 'symbols',
        language: 'it',
        entries: [{ key: '\\mu', definition: 'parametro gravitazionale standard', count: 4 }],
        sectioning: 'chapter',
    })
    const merged = runMerge(phdProject(), 'acronyms').applied.text
    const mergedSymbols = runMerge(phdProject(), 'symbols').applied.text
    for (const [label, text] of [
        ['the notice itself', core.GENERATED_NOTICE],
        ['a created english file', createdEnglish],
        ['a created italian file', createdItalian],
        ['a merged acronyms list', merged],
        ['a merged symbols list', mergedSymbols],
    ]) {
        WORK_MARKERS.lastIndex = 0
        const markers = text.match(WORK_MARKERS) || []
        check(`generated/${label} trips no work marker`, markers.length === 0, markers.join(', '))
        check(`generated/${label} trips no placeholder word`, !PLACEHOLDER_WORDS.test(text))
    }
    check('generated/the notice is a LaTeX comment', core.GENERATED_NOTICE.startsWith('%'))
    check(
        'generated/the notice tells the author to review the definitions',
        /review/i.test(core.GENERATED_NOTICE)
    )
    check('generated/no long dashes reach the document', !/[\u2013\u2014]/.test(createdEnglish + merged))
}

// ---------------------------------------------------------------------------
// 9. The panel says the three things it has to say, in English
// ---------------------------------------------------------------------------

{
    const button = fs.readFileSync(BUTTON, 'utf8')
    check(
        'panel/tells the author to review the filled definitions',
        /Review them: your\s*\n?\s*thesis may use a different meaning/.test(button.replace(/\s+/g, ' ')) ||
            /Review them/.test(button)
    )
    check('panel/carries the completeness disclaimer', /heuristic and may have missed entries/.test(button))
    check('panel/names the entries it added', /addedWithDefinition/.test(button) && /addedWithoutDefinition/.test(button))
    check('panel/truncates the display and says so', /and \$\{keys\.length - MAX_SHOWN\} more/.test(button))
    check('panel/says which road the main file took', /The main file was not touched/.test(button))
    check('panel/asks before it writes', /dryRun/.test(button))
    check('panel/no long dashes', !/[\u2013\u2014]/.test(button))
    // Every visible string is English. A handful of Italian words that would only
    // appear in a user-facing string are enough to catch a regression here; the
    // generated LaTeX headings live in the controller, not in this file.
    check(
        'panel/no italian in the user interface',
        !/\b(?:Elenco|simboli|acronimi|Aggiorna|Verifica|italiano|elenco|nessun|questo)\b/.test(button)
    )
}

// ---------------------------------------------------------------------------
// 10. Small parts, pinned
// ---------------------------------------------------------------------------

check(
    'parts/symbolToken folds decoration and subscripts onto the base symbol',
    core.symbolToken('$ \\mathbf{R}_{ij} $') === 'R' &&
        core.symbolToken('\\dot{q}') === 'q' &&
        core.symbolToken('q_w') === 'q' &&
        core.symbolToken('\\boldsymbol{\\omega}') === '\\omega' &&
        core.symbolToken('$\\Delta v$') === '\\Delta v' &&
        core.symbolToken('\\mathrm{M}') === 'M' &&
        core.symbolToken('\\text{est}') === '\\text{est}' &&
        core.symbolToken('\\|\\cdot\\|') === '\\cdot'
)
check(
    'parts/acronymKey strips the typesetting',
    core.acronymKey('\\textbf{ADCS}') === 'ADCS' &&
        core.acronymKey(' TT\\&C ') === 'TT&C' &&
        core.acronymKey('$GNC$') === 'GNC'
)
check(
    'parts/a cell with several entries registers all of them',
    core.entryKeys('symbols', '$ q_x, q_y, q_z $').includes('q') &&
        core.entryKeys('acronyms', 'LEO/MEO').includes('LEO') &&
        core.entryKeys('acronyms', 'LEO/MEO').includes('MEO')
)
// The first list is the doctoral thesis's own, slips included: CiA filed before
// CCT, fps before FOV. Ten of twelve pairs in order is a list somebody meant to
// sort. The second is its list of SYMBOLS, which is grouped by theme instead.
check(
    'parts/a nearly sorted list still counts as sorted',
    core.looksAlphabetical([
        'ADCS', 'ADR', 'AI', 'API', 'ARM', 'ASIC', 'CAD', 'CAN', 'CiA', 'CCT', 'CMOS', 'CNN', 'CPU',
    ]) && !core.looksAlphabetical(['R', 'R', 'N', 'SO', 'SE', 'T', 'K', 'I'])
)
check(
    'parts/sorting is locale independent',
    core.compareKeys('a', 'B') === -1 && core.compareKeys('Z', 'a') === 1
)
check(
    'parts/an unsupported column count refuses to invent a layout',
    core.templateForEmptyContainer('acronyms', { columns: 7, isDescription: false }, '') === null
)

// ---------------------------------------------------------------------------
// 11. Quoted LaTeX is not the document
// ---------------------------------------------------------------------------

// overleaf-lab: a thesis that SHOWS LaTeX in an appendix contains the characters
// `\chapter*{List of Acronyms}` without containing a list of acronyms, and this
// module WRITES. Before the guard existed it found the heading inside the code
// listing, read the fake table under it as the project's list, and spliced its
// generated rows into the middle of the appendix, where they typeset as code.
const APPENDIX_WITH_A_LISTING = `\\chapter{How this thesis was typeset}

\\begin{lstlisting}[language=TeX]
\\chapter*{List of Acronyms}
\\begin{tabular}{ll}
ADCS & Attitude Determination and Control System \\\\
\\end{tabular}
\\end{lstlisting}
`

function listingProject() {
    return [
        {
            path: '/main.tex',
            id: 'm',
            text: '\\documentclass{book}\n\\begin{document}\n\\input{appendix}\n\\input{ch1}\n\\end{document}\n',
        },
        { path: '/appendix.tex', id: 'x', text: APPENDIX_WITH_A_LISTING },
        {
            path: '/ch1.tex',
            id: 'c',
            text: '\\chapter{One}\nThe RAAN drifts and the EKF converges. RAAN and EKF again.\n',
        },
    ]
}

{
    const docs = core.orderByInclusion(listingProject())
    check(
        'quoted/a heading inside lstlisting is not a list',
        core.locateList(docs, 'acronyms') === null,
        JSON.stringify(core.locateList(docs, 'acronyms')?.doc?.path)
    )
    const merged = runMerge(listingProject(), 'acronyms')
    check(
        'quoted/nothing is ever written into a code listing',
        merged.applied === null || merged.applied.text === APPENDIX_WITH_A_LISTING,
        merged.applied ? merged.applied.text : 'no container'
    )
}

{
    // The same rule for verbatim, and for a heading that a COMMENT carries.
    const inVerbatim = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/ch1.tex',
            id: 'c',
            text: '\\chapter{One}\n\\begin{verbatim}\n\\section*{Nomenclature}\n\\begin{tabular}{ll}\na & b \\\\\n\\end{tabular}\n\\end{verbatim}\nText.\n',
        },
    ]
    check('quoted/a heading inside verbatim is not a list', core.locateList(core.orderByInclusion(inVerbatim), 'symbols') === null)

    const inComment = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/ch1.tex',
            id: 'c',
            text: '\\chapter{One}\n% \\chapter*{List of Acronyms}\n% \\begin{tabular}{ll}\n% ADCS & A \\\\\n% \\end{tabular}\nText about the RAAN.\n',
        },
    ]
    check('quoted/a heading inside a comment is not a list', core.locateList(core.orderByInclusion(inComment), 'acronyms') === null)
}

{
    // An \input shown in a listing is not an include either: believing it put the
    // new list's \input line inside the appendix.
    const docs = core.orderByInclusion([
        {
            path: '/main.tex',
            id: 'm',
            text: '\\documentclass{book}\n\\begin{document}\n\\input{appendix}\n\\input{acronyms}\n\\mainmatter\n\\input{ch1}\n\\end{document}\n',
        },
        {
            path: '/appendix.tex',
            id: 'x',
            text: '\\chapter{Typesetting}\n\\begin{verbatim}\n\\input{frontmatter/acronyms}\n\\end{verbatim}\n',
        },
        { path: '/acronyms.tex', id: 'a', text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & A \\\\\n\\end{tabular}\n' },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{One}\nText.\n' },
    ])
    const plan = core.planMainInsertion({
        docs,
        mainDoc: core.findMainDoc(docs),
        inputLine: '\\input{symbols}',
        otherListPath: '/frontmatter/acronyms.tex',
    })
    check(
        'quoted/an \\input shown in a listing is not an include',
        plan.path !== '/appendix.tex',
        `${plan.mode} in ${plan.path}`
    )
}

check(
    'quoted/documentText keeps every offset where it was',
    (() => {
        const text = '\\chapter{One}\n\\begin{verbatim}\n\\chapter*{List of Symbols}\n\\end{verbatim}\n% a comment\nEnd.\n'
        const blanked = core.documentText(text)
        return blanked.length === text.length && blanked.split('\n').length === text.split('\n').length
    })()
)

// ---------------------------------------------------------------------------
// 12. The files the scan may read
// ---------------------------------------------------------------------------

// overleaf-lab: a .bib is DATA and a .sty is the template's own machinery. The
// compliance module already pays for the first half of this rule (`isBib` and
// `sources()` in LLMStructuralChecks.mjs, written after a check told a student to
// spell out "IEEE" at /refs.bib:4); this module has to pay for MORE of it,
// because that module only reports and this one writes into the project.
const ENGLISH_BIBLIOGRAPHY = Array.from(
    { length: 40 },
    (unused, index) =>
        `@article{k${index},\n  author = {Smith, J.},\n  title = {A study of the control of the system for the analysis of the data},\n  journal = {IEEE Transactions on Aerospace and Electronic Systems},\n  publisher = {IEEE},\n  organization = {AIAA},\n}\n`
).join('')

{
    const docs = [
        {
            path: '/main.tex',
            id: 'm',
            text: '\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\bibliography{refs}\n\\end{document}\n',
        },
        { path: '/acronyms.tex', id: 'a', text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & A \\\\\n\\end{tabular}\n' },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{Uno}\nIl sistema di controllo della sonda che non riesce a puntare la stella per la manovra della camera.\n' },
        { path: '/refs.bib', id: 'b', text: ENGLISH_BIBLIOGRAPHY },
    ]
    const merged = runMerge(docs, 'acronyms')
    const keys = merged.plan.additions.map(entry => entry.key)
    check(
        'files/a publisher in a bibliography is not an acronym of the thesis',
        !keys.includes('IEEE') && !keys.includes('AIAA'),
        keys.join(', ')
    )
    // The README claims a bibliography full of English titles cannot fake the
    // language of an Italian thesis. It could, and this is the fixture that says so.
    check(
        'files/an english bibliography does not make an italian thesis english',
        core.detectDocumentLanguage(core.orderByInclusion(docs)) === 'it',
        core.detectDocumentLanguage(core.orderByInclusion(docs))
    )
}

{
    // A style file that builds the heading inside a \newcommand. Writing rows into
    // the middle of a template's macro is the worst outcome this module has.
    const docs = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\usepackage{tesi}\n\\begin{document}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/tesi.sty',
            id: 's',
            text: '\\ProvidesPackage{tesi}\n\\newcommand{\\elencosimboli}{%\n  \\chapter*{Elenco dei simboli}\n  \\begin{longtable}{ll}\n  \\end{longtable}\n}\n',
        },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{Uno}\n\\begin{equation}\\mu = \\omega r\\end{equation}\n' },
    ]
    check(
        'files/a heading a style file defines is not the author\'s list',
        core.locateList(core.orderByInclusion(docs), 'symbols') === null,
        JSON.stringify(core.locateList(core.orderByInclusion(docs), 'symbols')?.doc?.path)
    )
}

check(
    'files/the reading order drops what is not prose',
    core
        .orderByInclusion([
            { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\end{document}\n' },
            { path: '/refs.bib', id: 'b', text: '@article{x}\n' },
            { path: '/tesi.cls', id: 'c', text: '\\ProvidesClass{tesi}\n' },
            { path: '/tesi.sty', id: 's', text: '\\ProvidesPackage{tesi}\n' },
            { path: '/ch1.tex', id: 'k', text: '\\chapter{One}\n' },
        ])
        .map(doc => doc.path)
        .join(' ') === '/main.tex /ch1.tex'
)

// ---------------------------------------------------------------------------
// 13. The file as the author's editor actually saved it
// ---------------------------------------------------------------------------

function crlfProject() {
    const crlf = text => text.replace(/\n/g, '\r\n')
    return [
        { path: '/main.tex', id: 'm', text: crlf('\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n') },
        {
            path: '/acronyms.tex',
            id: 'a',
            text: crlf('\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & Attitude Determination and Control System \\\\\n  GNC & Guidance Navigation and Control \\\\\n\\end{tabular}\n'),
        },
        { path: '/ch1.tex', id: 'c', text: crlf('\\chapter{One}\nThe RAAN drifts and the EKF converges. RAAN and EKF again.\n') },
    ]
}

{
    const docs = crlfProject()
    const first = runMerge(docs, 'acronyms')
    const before = first.found.doc.text.split('\n')
    const after = first.applied.text.split('\n')
    check('crlf/every existing line survives byte for byte', before.every(line => after.includes(line)))
    check('crlf/something was added', first.applied.inserted === 2, `${first.applied.inserted}`)
    // Every line the module writes has to carry the file's own terminator, the
    // notice included. It did not, and one LF line landed in a CRLF file.
    check(
        'crlf/every written line keeps the carriage return the file uses',
        first.applied.text.split('\n').slice(0, -1).every(line => line.endsWith('\r')),
        JSON.stringify(first.applied.text.split('\n').filter(line => line && !line.endsWith('\r')))
    )
    const second = runMerge(withText(docs, '/acronyms.tex', first.applied.text), 'acronyms')
    check('crlf/second run is byte identical', second.applied.text === first.applied.text)

    const main = core.findMainDoc(core.orderByInclusion(docs))
    const hookup = core.planMainInsertion({
        docs: core.orderByInclusion(docs),
        mainDoc: main,
        inputLine: '\\input{symbols}',
        otherListPath: '/acronyms.tex',
    })
    const written = core.applyLineInsertions(main.text, [hookup])
    check(
        'crlf/the hooked up \\input keeps the carriage return too',
        written.split('\n').slice(0, -1).every(line => line.endsWith('\r')),
        JSON.stringify(written.split('\n').filter(line => line && !line.endsWith('\r')))
    )
}

{
    // Accented definitions have to come back byte for byte: a normalisation applied
    // by accident anywhere in the pipeline would rewrite somebody's Italian.
    const docs = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\usepackage[english,italian]{babel}\n\\begin{document}\n\\input{acronimi}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/acronimi.tex',
            id: 'a',
            text: '\\chapter*{Elenco degli acronimi}\n\\begin{tabular}{ll}\n  ADCS & Sistema di determinazione e controllo d\'assetto \\\\\n  GNC & Guida, navigazione e controllo, perch\u00e9 cos\u00ec \u00e8 \\\\\n  UNI & Universit\u00e0 degli studi, citt\u00e0 di Bologna \\\\\n\\end{tabular}\n',
        },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{Uno}\nIl RAAN \u00e8 importante. Il RAAN di nuovo, con EKF ed EKF.\n' },
    ]
    const merged = runMerge(docs, 'acronyms')
    check(
        'accents/every accented line survives byte for byte',
        merged.found.doc.text.split('\n').every(line => merged.applied.text.split('\n').includes(line))
    )
    check('accents/the italian heading picks the italian column', merged.found.language === 'it')
    check(
        'accents/the italian definitions are written with their accents',
        merged.applied.text.includes('Ascensione retta del nodo ascendente'),
        merged.applied.text
    )
}

{
    // Keys made of characters a regex would read as syntax. Nothing here builds a
    // regex out of a key, and this fixture is what says so.
    const docs = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/acronyms.tex',
            id: 'a',
            text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  C++ & The programming language \\\\\n  A* & The search algorithm \\\\\n  $\\mu$C & Microcontroller \\\\\n\\end{tabular}\n',
        },
        {
            path: '/ch1.tex',
            id: 'c',
            text: '\\chapter{One}\nWritten in C++ and C++ again, planned with A* and A*, on a $\\mu$C and a $\\mu$C. The RAAN drifts, RAAN again.\n',
        },
    ]
    const first = runMerge(docs, 'acronyms')
    check(
        'regex keys/a key made of operators is read, not matched',
        first.found.rows.length === 3 && first.found.rows[0].keys[0] === 'C++' && first.found.rows[1].keys[0] === 'A*',
        JSON.stringify(first.found.rows.map(row => row.keys))
    )
    check(
        'regex keys/no operator key is proposed a second time',
        !first.plan.additions.some(entry => /[+*]/.test(entry.key)),
        first.plan.additions.map(entry => entry.key).join(', ')
    )
    const second = runMerge(withText(docs, '/acronyms.tex', first.applied.text), 'acronyms')
    check('regex keys/the second press is byte identical', second.applied.text === first.applied.text)
    check(
        'regex keys/a master key made of operators is proposed literally',
        core.buildRow(
            'acronyms',
            { cells: ['KEY ', ' VALUE '], keyCell: 0, valueCell: 1, raw: ' \\\\', item: null },
            'TT&C',
            'Telemetry, Tracking and Command'
        ) === 'TT\\&C & Telemetry, Tracking and Command \\\\'
    )
}

// ---------------------------------------------------------------------------
// 14. A list the parser cannot read is not an empty list
// ---------------------------------------------------------------------------

{
    // `\item ADCS, the attitude system` has a key and a definition in it and this
    // parser can see neither. Reading the container as EMPTY and inventing
    // `\item[ADCS] ...` under it adds a SECOND entry for one that is plainly there,
    // which is the one thing the module promises never to do.
    const docs = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/acronyms.tex',
            id: 'a',
            text: '\\chapter*{List of Acronyms}\n\\begin{itemize}\n  \\item ADCS, the attitude system\n  \\item GNC, the guidance system\n\\end{itemize}\n',
        },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{One}\nThe ADCS is tuned and the ADCS is tested. The RAAN drifts, RAAN again.\n' },
    ]
    const merged = runMerge(docs, 'acronyms')
    check(
        'unreadable/an item list with no labels is refused, not invented into',
        merged.applied.inserted === 0 && merged.applied.unsupported === true,
        JSON.stringify(merged.applied)
    )
    check('unreadable/the file is left exactly as it was', merged.applied.text === merged.found.doc.text)

    // One labelled row is all it takes: from then on every press copies its shape.
    const labelled = withText(
        docs,
        '/acronyms.tex',
        '\\chapter*{List of Acronyms}\n\\begin{description}\n  \\item[ADCS] the attitude system\n\\end{description}\n'
    )
    const after = runMerge(labelled, 'acronyms')
    check(
        'unreadable/one labelled row by hand unblocks it',
        after.applied.inserted > 0 && !after.applied.unsupported,
        JSON.stringify(after.applied.inserted)
    )
    check('unreadable/and the entry already listed is not added again', !after.applied.text.includes('\\item[ADCS] Attitude'))
}

// ---------------------------------------------------------------------------
// 15. Bounded work on a document that is trying to be expensive
// ---------------------------------------------------------------------------

// overleaf-lab: every one of these ran for SECONDS before the splice loops were
// made linear, on one document a student can produce by accident. The web process
// is single threaded and these handlers sit on it, so a scan that takes a minute
// is not slow, it is an outage. The budgets below are deliberately loose (a slow
// CI box is not a regression); what they catch is a return to quadratic.
{
    const budget = (label, limitMs, run) => {
        const started = process.hrtime.bigint()
        run()
        const ms = Number(process.hrtime.bigint() - started) / 1e6
        check(`bounded/${label}`, ms < limitMs, `${ms.toFixed(0)} ms, budget ${limitMs} ms`)
    }

    const equations = '\\begin{equation}\n a = b \\\\\n\\end{equation}\n'
    const mathsBomb = equations.repeat(Math.ceil(600000 / equations.length)).slice(0, 600000)
    budget('600 KB of short equations', 1500, () => core.proseOf(mathsBomb))

    const verbatim = '\\begin{verbatim}\nsome code here\n\\end{verbatim}\n'
    const verbatimBomb = verbatim.repeat(Math.ceil(600000 / verbatim.length)).slice(0, 600000)
    budget('600 KB of verbatim blocks', 1500, () => core.documentText(verbatimBomb))

    // A table of lines that carry an ampersand and no row terminator: asking "is
    // there anything after this line" by joining the rest of the table on every
    // line is quadratic in the size of the table.
    const junk = 'a & b\n'.repeat(9800)
    const wideTable = `\\chapter*{List of Acronyms}\n\\begin{longtable}{ll}\n${junk}  ADCS & A \\\\\n\\end{longtable}\n`
    const region = core.findListRegion(wideTable, 'acronyms')
    const container = core.findContainer(wideTable, region)
    budget('a 60 KB table of unterminated rows', 500, () => core.parseRows(wideTable, container, 'acronyms'))

    const oneLine = 'The ADCS uses an IMU and the RAAN drifts while the EKF converges in LEO. '
    const monolith = oneLine.repeat(Math.ceil(600000 / oneLine.length)).slice(0, 600000)
    budget('600 KB on a single line', 1500, () =>
        runMerge(
            [
                { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n' },
                { path: '/acronyms.tex', id: 'a', text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & A \\\\\n\\end{tabular}\n' },
                { path: '/ch1.tex', id: 'c', text: `\\chapter{One}\n${monolith}\n` },
            ],
            'acronyms'
        )
    )

    // 2 MB of nested includes, and an include cycle, neither of which may be walked
    // twice or walked for ever.
    const nested = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{c0}\n\\end{document}\n' },
        { path: '/acronyms.tex', id: 'a', text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & A \\\\\n\\end{tabular}\n' },
    ]
    const body = 'The RAAN drifts and the EKF converges in LEO with the IMU. '.repeat(120)
    for (let i = 0; i < 120; i += 1) {
        nested.push({ path: `/c${i}.tex`, id: `c${i}`, text: `\\section{S${i}}\n${body}\n\\input{c${i + 1}}\n` })
    }
    budget('2 MB of nested includes', 2000, () => runMerge(nested, 'acronyms'))

    const cycle = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{a}\n\\end{document}\n' },
        { path: '/a.tex', id: 'a', text: '\\input{b}\nThe RAAN drifts.\n' },
        { path: '/b.tex', id: 'b', text: '\\input{a}\nThe EKF converges.\n' },
    ]
    check('bounded/an include cycle is walked once', core.orderByInclusion(cycle).length === 3)
}

// ---------------------------------------------------------------------------
// 16. The project as the user actually has it
// ---------------------------------------------------------------------------

{
    // A list file the main document never includes is still updated: a use inside a
    // parked draft is still a use, and refusing would leave the author with a
    // button that does nothing and says nothing. The panel names the path, which is
    // how the author sees WHICH file was written. An included list always wins.
    const orphanOnly = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{ch1}\n\\end{document}\n' },
        { path: '/attic/acronimi.tex', id: 'o', text: '\\chapter*{Elenco degli acronimi}\n\\begin{tabular}{ll}\n  ADCS & Sistema \\\\\n\\end{tabular}\n' },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{One}\nThe RAAN drifts and the EKF converges. RAAN and EKF again.\n' },
    ]
    check('project/an orphaned list file is still the list', runMerge(orphanOnly, 'acronyms').found.doc.path === '/attic/acronimi.tex')

    const both = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{front/acronyms}\n\\input{ch1}\n\\end{document}\n' },
        { path: '/attic/acronyms.tex', id: 'o', text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  OLD & An abandoned draft \\\\\n\\end{tabular}\n' },
        { path: '/front/acronyms.tex', id: 'f', text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & A \\\\\n\\end{tabular}\n' },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{One}\nThe RAAN drifts. RAAN again.\n' },
    ]
    check('project/the included list wins over the orphan', runMerge(both, 'acronyms').found.doc.path === '/front/acronyms.tex')
}

{
    // No \documentclass anywhere: every decision that hangs off the main file has to
    // degrade to "say so", never to a guess and never to a crash.
    const docs = [
        { path: '/notes.tex', id: 'n', text: 'Notes about the RAAN and the EKF. RAAN and EKF again.\n' },
        { path: '/simboli.tex', id: 's', text: '\\begin{tabular}{ll}\n  $a$ & semiasse \\\\\n\\end{tabular}\n' },
    ]
    check('project/no main file, no crash', core.findMainDoc(docs) === null)
    check('project/no main file, the folder falls back to the root', core.chooseFolder(docs, null) === '')
    check('project/no main file, the include target is still relative', core.includeTarget(null, '/simboli.tex') === 'simboli')
    check('project/no main file, the hook up refuses to guess', core.planMainInsertion({ docs, mainDoc: null, inputLine: '\\input{x}', otherListPath: null }).mode === 'manual')
    check('project/no main file, no package line is invented', core.planPackageInsertion(null) === null)
    check('project/no main file, the list is still found by name', core.locateList(core.orderByInclusion(docs), 'symbols') !== null)
}

{
    // An empty project, and a project that is nothing but a bibliography. Both used
    // to reach the panel as a status with no entry for either list, which the panel
    // renders as NOTHING AT ALL: no lists, no buttons, no explanation.
    const empty = core.scanProject([])
    check('project/an empty project scans without throwing', empty.located.acronyms === null && empty.located.symbols === null)
    check('project/an empty project has a language anyway', core.detectDocumentLanguage([]) === 'en')
    check(
        'project/a project that is only a .bib has nothing to scan',
        core.orderByInclusion([{ path: '/refs.bib', id: 'b', text: '@article{x, publisher={IEEE}}\n' }]).length === 0
    )
}

{
    // The guard that decides whether a name is free has to be answered from every
    // path the PROJECT has, not from the docs the scan happened to read: an empty
    // file is dropped before the scan, and so is everything past the project caps.
    // Answering it from the scanned docs is how a file the scan never reached would
    // be overwritten by a create.
    const docsByPath = {
        '/main.tex': { _id: '1', lines: ['\\documentclass{book}'] },
        '/simboli.tex': { _id: '2', lines: [] },
        '/whitespace.tex': { _id: '3', lines: ['', '   ', ''] },
        '/frontmatter/acronimi.tex': { _id: '4', lines: ['\\chapter*{Elenco}'] },
        '/broken.tex': null,
    }
    const taken = core.occupiedPaths(docsByPath)
    check(
        'project/a file with something in it occupies its name',
        taken.has('/main.tex') && taken.has('/frontmatter/acronimi.tex'),
        [...taken].join(', ')
    )
    check(
        'project/an empty file does not block the list that would fill it',
        !taken.has('/simboli.tex') && !taken.has('/whitespace.tex'),
        [...taken].join(', ')
    )
}

// ---------------------------------------------------------------------------
// 17. The master list as an operator will actually edit it
// ---------------------------------------------------------------------------

{
    const raw = [
        '# a comment',
        'ADCS :: Attitude Determination and Control System :: Sistema di assetto',
        'this line is broken and has no separator at all',
        '   ',
        ':: an entry with no key',
        'GNC :: Guidance Navigation and Control ::',
        'NODEF ::',
        'ADCS :: A second opinion :: Un secondo parere',
    ].join('\n')
    const parsed = core.parseMasterList(raw)
    check('master/one broken line does not stop the file loading', parsed.has('ADCS') && parsed.has('GNC'), [...parsed.keys()].join(', '))
    check('master/a line with a key and no definition at all is not an entry', !parsed.has('NODEF'), [...parsed.keys()].join(', '))
    check('master/the lines that were skipped are counted', parsed.skipped === 3, `${parsed.skipped}`)
    check('master/a duplicate key is the last one, which is what makes an override', parsed.get('ADCS').en === 'A second opinion')
    check('master/an italian only entry is still an entry', core.parseMasterList('X :: :: solo italiano\n').get('X').it === 'solo italiano')
}

// ---------------------------------------------------------------------------
// 18. What the panel is told when the answer is not a happy one
// ---------------------------------------------------------------------------

{
    // A press adds at most MAX_NEW_ENTRIES rows. Saying nothing about the rest is
    // how an author ends up believing the list is complete when it is not, and how
    // "twice in a row changes nothing" quietly stops being true.
    const words = []
    for (let index = 0; index < 900; index += 1) words.push(`XQ${index}A XQ${index}A`)
    const docs = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n' },
        { path: '/acronyms.tex', id: 'a', text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & A \\\\\n\\end{tabular}\n' },
        { path: '/ch1.tex', id: 'c', text: `\\chapter{One}\n${words.join(' ')}\n` },
    ]
    const merged = runMerge(docs, 'acronyms')
    const summary = core.summarise(merged.plan)
    check('payload/a press adds at most the cap', merged.applied.inserted === core.MAX_NEW_ENTRIES, `${merged.applied.inserted}`)
    check('payload/the payload says the plan was cut short', summary.truncated === true)
    check('payload/and says how many are left', summary.remaining > 0, `${summary.remaining}`)
    check(
        'payload/a run that adds everything says so',
        core.summarise(runMerge(phdProject(), 'acronyms').plan).truncated === false &&
            core.summarise(runMerge(phdProject(), 'acronyms').plan).remaining === 0
    )
}

{
    // A list with the same short form on three rows: the merge must not add a
    // fourth, must not tidy the three, and must not name the entry three times in
    // the report either.
    const docs = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/acronyms.tex',
            id: 'a',
            text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & Attitude Determination and Control System \\\\\n  ADCS & Attitude Determination and Control System \\\\\n  \\textbf{ADCS} & Attitude determination and control \\\\\n\\end{tabular}\n',
        },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{One}\nThe RAAN drifts. RAAN again.\n' },
    ]
    const merged = runMerge(docs, 'acronyms')
    check(
        'payload/a duplicated row is neither duplicated again nor repaired',
        (merged.applied.text.match(/ADCS/g) || []).length === 3,
        merged.applied.text
    )
    check(
        'payload/the same short form in two shapes is one entry',
        !merged.plan.additions.some(entry => entry.key === 'ADCS')
    )
    check('payload/a name is reported once, however many rows carry it', merged.plan.unusedKept.join(',') === 'ADCS', merged.plan.unusedKept.join(','))
}

check(
    'payload/an unknown kind never reaches a file name',
    core.newListFileName('constructor', 'en') === null && core.newListFileName('__proto__', 'it') === null
)

// ---------------------------------------------------------------------------
// 19. The panel has something to say in every state
// ---------------------------------------------------------------------------

{
    const button = fs.readFileSync(BUTTON, 'utf8')
    check('panel/says something when the project has nothing to scan', /empty_project/.test(button))
    check('panel/says when only part of the entries were added', /truncated/.test(button) && /remaining/.test(button))
    check(
        'panel/the unsupported layout message does not claim the list is empty',
        /unsupported_layout/.test(button) && !/The list is empty and its table layout/.test(button)
    )
    check('panel/an error the panel does not know still says something in english', /data\?\.message/.test(button))
}

// ---------------------------------------------------------------------------
// 20. ReDoS: every whitespace run in every pattern is capped
// ---------------------------------------------------------------------------

// overleaf-lab: `\s*\*?\s*\{` reads like "the command, an optional star, the
// brace" and is a catastrophic backtracker. On a run of whitespace not followed by
// a brace the engine tries every way of splitting the run between the two `\s*`,
// which is quadratic in the run at every starting position, and NON_PROSE_ARGUMENT
// managed cubic. JavaScript has no regex timeout and a backtracking match cannot be
// interrupted, so this is not a slow request, it is the whole web process gone.
//
// It was reachable from GET /project/:id/lists with READ access only, which a
// link-sharing viewer has: the status route calls locateList twice and
// detectDocumentLanguage once. Four kilobytes of whitespace cost 31 SECONDS, and
// stripComments manufactures that input out of any commented-out block.
//
// TWO GUARDS, because the timing one alone would not survive a new pattern being
// added next year: the structural one says no pattern in the shipped file may
// carry an uncapped whitespace run at all.
{
    const codeOnly = src
        .split('\n')
        .filter(line => !/^\s*\/\//.test(line))
        .join('\n')
    const uncapped = codeOnly.match(/\\s\*/g) || []
    check(
        'redos/no pattern carries an uncapped whitespace run',
        uncapped.length === 2,
        `${uncapped.length} found; only the two anchored runs in cellShell are allowed`
    )
    // The two that survive are single anchored runs with nothing to split against,
    // and they are what reads a cell's indentation back out to copy it.
    const anchored = codeOnly.match(/\/\^\\s\*\/|\/\\s\*\$\//g) || []
    check('redos/the two survivors are the anchored indentation reads', anchored.length === 2, anchored.join(' '))
    // Capping alone is not enough: `\s{0,40}\*?\s{0,40}` still backtracks over the
    // run, just with a ceiling on the damage. The shape has to be unrolled so the
    // second run is reachable only through a literal, and the tell-tale of the
    // unrolled form is that no optional quantifier is ever immediately followed by
    // a whitespace run.
    check(
        'redos/no optional atom separates two whitespace runs',
        !codeOnly.includes(String.raw`?\s{0,`),
        'found the `X?\\s{0,N}` shape, which backtracks exactly like `\\s*X?\\s*`'
    )
}

{
    const budget = (label, limitMs, run) => {
        const started = process.hrtime.bigint()
        run()
        const ms = Number(process.hrtime.bigint() - started) / 1e6
        check(`redos/${label}`, ms < limitMs, `${ms.toFixed(0)} ms, budget ${limitMs} ms`)
    }

    // The exact shape: a command, a long run of whitespace, then a character that
    // makes the match fail. 64 KB is sixteen times the payload that used to cost
    // half a minute.
    const gap = ' \n'.repeat(32000)
    const hostile = `\\documentclass{book}\n\\chapter${gap}!\n\\input${gap}!\n\\usepackage${gap}!\n\\acro${gap}!\n`
    const docs = [{ path: '/main.tex', id: 'm', text: hostile }]

    budget('64 KB of whitespace through the status route scan', 1000, () => {
        core.locateList(docs, 'acronyms')
        core.locateList(docs, 'symbols')
        core.detectDocumentLanguage(docs)
    })
    budget('64 KB of whitespace through the declaration scan', 1000, () => core.collectDeclaredAcronyms(docs))
    budget('64 KB of whitespace through sectioningLevel', 1000, () => core.sectioningLevel(docs))
    budget('64 KB of whitespace through planPackageInsertion', 1000, () => core.planPackageInsertion(docs[0]))
    budget('64 KB of whitespace through the prose pass', 1000, () => core.proseOf(hostile))

    // stripComments is where the whitespace comes from: a commented-out block
    // becomes a solid run of spaces before any other pattern sees it.
    const commented = `\\input%${'x'.repeat(64000)}\n!\n`
    budget('a 64 KB comment blanked and then scanned', 1000, () => core.proseOf(commented))

    // cellShell runs twice per added row, up to 300 rows, on cells the author
    // wrote. A single pathological cell used to be paid for six hundred times.
    const wideCell = `  \\textbf{${'a'.repeat(4000)}`
    budget('a 4 KB unterminated cell, six hundred times', 1000, () => {
        for (let i = 0; i < 600; i += 1) core.cellShell(wideCell)
    })
}

// ---------------------------------------------------------------------------
// 21. A document read in part is never written back whole
// ---------------------------------------------------------------------------

// overleaf-lab: the merge rewrites the WHOLE document through setDocument. A
// document longer than MAX_DOC_CHARS is read only as far as the cap, so writing
// the merged text back deleted everything past 600 000 characters, silently, on a
// press whose entire promise is that it only ever ADDS rows. The flag is set where
// the reading happens and the handlers refuse on it.
{
    const long = `\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & A \\\\\n\\end{tabular}\n${'x '.repeat(
        core.MAX_DOC_CHARS
    )}\n`
    const { docs } = core.prepareDocs({
        '/main.tex': { _id: '1', lines: ['\\documentclass{book}', '\\begin{document}', '\\input{acronyms}', '\\end{document}'] },
        '/acronyms.tex': { _id: '2', lines: long.split('\n') },
        '/small.tex': { _id: '3', lines: ['\\chapter{One}', 'The RAAN drifts.'] },
    })
    const big = docs.find(doc => doc.path === '/acronyms.tex')
    const small = docs.find(doc => doc.path === '/small.tex')
    check('truncation/an oversized document is flagged', big.truncated === true)
    check('truncation/and is cut at the cap', big.text.length === core.MAX_DOC_CHARS, `${big.text.length}`)
    check('truncation/an ordinary document is not flagged', small.truncated === false)
    // Sliced per HANDLER, not searched over the whole file: `found.doc.truncated`
    // appears in the status route too, so a whole-file search was satisfied by the
    // wrong copy and a mutation that deleted the refusal from the merge survived.
    const handler = name => {
        const from = src.indexOf(`async function ${name}(req, res)`)
        const to = src.indexOf('\n}\n', from)
        if (from === -1 || to === -1) {
            console.error(`FAIL: could not slice the ${name} handler`)
            process.exit(1)
        }
        return src.slice(from, to)
    }
    check(
        'truncation/the merge itself refuses before it writes',
        /truncated/.test(handler('update')) && /document_too_large/.test(handler('update')),
        'the update handler does not refuse a truncated document'
    )
    check(
        'truncation/and the refusal comes before any write',
        handler('update').indexOf('document_too_large') < handler('update').indexOf('writeDoc'),
        'the refusal is after the write'
    )
    check('truncation/the status route says so up front', /truncated/.test(handler('status')))
    check(
        'truncation/the create path refuses to hook up into a truncated document',
        /hookTarget && hookTarget\.truncated/.test(src)
    )
    check('truncation/the refusal carries an english sentence', /too large for this module to read in full/.test(src))
}

{
    // The project caps still apply, and a doc dropped by one of them still occupies
    // its name. Uploaded FILES occupy a name too: only docs were consulted, so a
    // create could have written a doc over the path of an uploaded file.
    const many = {}
    for (let index = 0; index < 500; index += 1) {
        many[`/doc${index}.tex`] = { _id: String(index), lines: ['text'] }
    }
    const { docs, taken } = core.prepareDocs(many, { '/figure.png': { _id: 'f' }, '/refs.bib': { _id: 'g' } })
    check('truncation/the document cap still holds', docs.length <= 400, `${docs.length}`)
    check('truncation/a document past the cap still occupies its name', taken.has('/doc499.tex'))
    check('truncation/an uploaded file occupies its name too', taken.has('/figure.png') && taken.has('/refs.bib'))
}

// ---------------------------------------------------------------------------
// 22. An environment the scan cannot close
// ---------------------------------------------------------------------------

{
    // A listing longer than the old distance cap was reported as UNTERMINATED and
    // therefore never blanked, so the module read the heading inside it and wrote
    // its rows into a 208 KB code listing: the exact regression the verbatim guard
    // exists to prevent, reintroduced by a bound that bought nothing.
    const huge = `\\chapter{Typesetting}\n\\begin{lstlisting}[language=TeX]\n\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\nADCS & A \\\\\n\\end{tabular}\n${'% padding\n'.repeat(
        26000
    )}\\end{lstlisting}\n`
    check('unclosed/the listing really is over 200 KB', huge.length > 208000, `${huge.length}`)
    const docs = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{appendix}\n\\input{ch1}\n\\end{document}\n' },
        { path: '/appendix.tex', id: 'x', text: huge },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{One}\nThe RAAN drifts and the EKF converges. RAAN and EKF again.\n' },
    ]
    check(
        'unclosed/a listing bigger than any distance cap is still a listing',
        core.locateList(core.orderByInclusion(docs), 'acronyms') === null,
        JSON.stringify(core.locateList(core.orderByInclusion(docs), 'acronyms')?.doc?.path)
    )

    // The discriminating half. Blanking an oversized listing to the END OF THE
    // DOCUMENT would also hide the real list that follows it, so "call it
    // unterminated and blank everything after" is NOT a fix for the distance cap:
    // it trades writing into a listing for never finding the list at all. A closer
    // that exists has to be honoured wherever it is.
    const afterTheListing = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{appendix}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/appendix.tex',
            id: 'x',
            text: `${huge}\n\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & Attitude Determination and Control System \\\\\n\\end{tabular}\n`,
        },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{One}\nThe RAAN drifts and the EKF converges. RAAN and EKF again.\n' },
    ]
    const real = core.locateList(core.orderByInclusion(afterTheListing), 'acronyms')
    check(
        'unclosed/the real list AFTER a huge listing is still found',
        real !== null && real.rows.length === 1,
        real ? `${real.rows.length} rows` : 'not found'
    )

    // A \begin that genuinely never closes fails the OTHER way for verbatim, and
    // that direction is deliberate: everything after it might be inside a listing,
    // so nothing after it may be written to.
    const unclosed = '\\chapter{One}\n\\begin{lstlisting}\n\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\nADCS & A \\\\\n\\end{tabular}\n'
    check(
        'unclosed/an unterminated listing hides what follows it rather than exposing it',
        !core.documentText(unclosed).includes('List of Acronyms'),
        core.documentText(unclosed)
    )
    // Maths fails the opposite way on purpose: an unterminated \begin{equation}
    // must not turn the rest of the prose into one enormous formula.
    const unclosedMaths = '\\chapter{One}\n\\begin{equation}\nx = y\nThe RAAN drifts and the EKF converges. RAAN, EKF.\n'
    check(
        'unclosed/an unterminated equation does not swallow the prose after it',
        core.proseOf(unclosedMaths).includes('RAAN'),
        core.proseOf(unclosedMaths)
    )
}

// ---------------------------------------------------------------------------
// 23. A comment runs to the end of its line, however long
// ---------------------------------------------------------------------------

{
    // The old bound stopped stripping at 4000 characters, so anything parked past
    // it in a commented-out block was read as document. A list heading there was
    // accepted as a real heading.
    const padded = `% ${'x'.repeat(4100)} \\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & A \\\\\n\\end{tabular}\n`
    check(
        'comments/a heading past the old 4000 char bound is still commented out',
        !core.stripComments(padded).includes('\\chapter*'),
        'the heading survived stripComments'
    )
    const docs = [{ path: '/main.tex', id: 'm', text: `\\documentclass{book}\n${padded}` }]
    check('comments/and is not a list', core.locateList(core.orderByInclusion(docs), 'acronyms') === null)
    check('comments/blanking a comment preserves every offset', core.stripComments(padded).length === padded.length)
    check(
        'comments/an escaped percent does not start a comment',
        core.stripComments('50\\% of the ADCS budget\n').includes('ADCS'),
        core.stripComments('50\\% of the ADCS budget\n')
    )
    check(
        'comments/but a comment after an escaped backslash does',
        !core.stripComments('a \\\\% hidden ADCS\n').includes('ADCS'),
        core.stripComments('a \\\\% hidden ADCS\n')
    )
}

// ---------------------------------------------------------------------------
// 24. The routes are rate limited and the reading is flushed
// ---------------------------------------------------------------------------

{
    const router = fs.readFileSync(process.env.ROUTER || fileURLToPath(new URL('../app/src/ListsRouter.mjs', import.meta.url)), 'utf8')
    check('routes/a limiter exists', /makeRateLimiter/.test(router))
    check('routes/the status route is limited', /limit\(allowStatus, 'status'\)/.test(router))
    check(
        'routes/both writing routes are limited more tightly',
        /limit\(allowWrite, 'update'\)/.test(router) && /limit\(allowWrite, 'create'\)/.test(router) &&
            /allowWrite = makeRateLimiter\(10,/.test(router)
    )
    check('routes/the limit is keyed on the user, not the address', /getLoggedInUserId/.test(router))
    check('routes/being limited is a JSON answer with an english sentence', /rate_limited/.test(router) && /Too many list requests/.test(router))
    // Reading the docstore without flushing can hand back a copy older than what
    // is on the author's screen, and this module then writes the whole document.
    check('routes/the project is flushed before it is read', /flushProjectToMongo/.test(src))
    check('routes/and the flush never takes the feature down with it', /typeof flush !== 'function'/.test(src))
}

// ---------------------------------------------------------------------------
// 25. The shipped data says what it does and does what it says
// ---------------------------------------------------------------------------

{
    // The symbols header names the letters it leaves out ON PURPOSE, and four of
    // them were in the file anyway. A header that lies about its own contents is
    // worse than no header: it is the thing an operator reads before editing.
    const raw = fs.readFileSync(path.join(DATA_DIR, 'symbols-master.txt'), 'utf8')
    const claimed = /k, s, w, C, N, S, V/.exec(raw)
    check('data/the symbols header still names the letters it leaves out', claimed !== null)
    for (const key of ['k', 's', 'w', 'C', 'N', 'S', 'V']) {
        check(`data/symbols/${key} is absent, as the header says`, !SYMBOL_MASTER.has(key))
    }
    check('data/pi is absent and never proposed', !SYMBOL_MASTER.has('\\pi'))
    // In an attitude document this is the quaternion product, which is the whole
    // reason a thesis writes it; Kronecker is the second meaning and gets a comment.
    check(
        'data/otimes is the quaternion product, with the alternative recorded',
        SYMBOL_MASTER.get('\\otimes').en === 'quaternion product' && /Also the Kronecker product/.test(raw)
    )
}

{
    const raw = fs.readFileSync(path.join(DATA_DIR, 'acronyms-master.txt'), 'utf8')
    // A unit is not a short form, and an entry in the master used to walk straight
    // past the rule that says so because the master is consulted first.
    check('data/AU is not carried as an acronym', !ACRONYM_MASTER.has('AU'))
    check(
        'data/a unit is never proposed even if somebody adds it to the master',
        !core
            .planAcronyms({
                rows: [],
                tokenCounts: new Map([['AU', 5], ['MHz', 4]]),
                declared: new Map(),
                master: new Map([['AU', { en: 'Astronomical Unit', it: '', unit: '' }]]),
                language: 'en',
            })
            .additions.some(entry => entry.key === 'AU' || entry.key === 'MHz')
    )
    // The corrections: a name that was not an acronym, expansions that were wrong,
    // and glosses that were not the settled Italian.
    check('data/CubeSat was a definition, not an expansion', !ACRONYM_MASTER.has('CubeSat'))
    check('data/HQ is not an acronym worth listing', !ACRONYM_MASTER.has('HQ'))
    check(
        'data/three unrelated meanings means the cell stays a question',
        !ACRONYM_MASTER.has('SDN') && !ACRONYM_MASTER.has('PPM')
    )
    check('data/SA in a space document is the solar array', ACRONYM_MASTER.get('SA').en === 'Solar Array')
    check('data/and the vision model is SAM', ACRONYM_MASTER.get('SAM').en === 'Segment Anything Model')
    check('data/TM in a space document is telemetry', ACRONYM_MASTER.get('TM').en === 'Telemetry')
    check('data/HMI is the interface, not the lamp', ACRONYM_MASTER.get('HMI').en === 'Human-Machine Interface')
    check('data/SPEC is a Challenge', /Challenge/.test(ACRONYM_MASTER.get('SPEC').en))
    check('data/SVGP is singular', ACRONYM_MASTER.get('SVGP').en === 'Sparse Variational Gaussian Process')
    check('data/SSD is the MultiBox detector', /MultiBox/.test(ACRONYM_MASTER.get('SSD').en))
    check('data/the italian for IMU is the settled one', ACRONYM_MASTER.get('IMU').it === 'Unità di misura inerziale')
    check('data/TF2 is consistent with TF', ACRONYM_MASTER.get('TF2').en === 'TensorFlow 2')
    // The convention for an ambiguous key is a comment above it, and these are the
    // ones that carry a well known second meaning.
    for (const marker of ['Initial Orbit Determination', 'Lunar Module', 'Solid State Drive', 'Template Matching']) {
        check(`data/the alternative meaning is recorded: ${marker}`, raw.includes(marker))
    }
}

// ---------------------------------------------------------------------------
// 26. Small things that were quietly wrong
// ---------------------------------------------------------------------------

{
    check('small/skipped is a number even when the file could not be read', core.parseMasterList('').skipped === 0)
    // A list whose every row is still a bare key waiting for its definition gives
    // the merge nowhere to put one. The row is still worth adding; dropping the
    // text while the panel reported "filled from the default list: RAAN" was the
    // defect.
    const docs = [
        { path: '/main.tex', id: 'm', text: '\\documentclass{book}\n\\begin{document}\n\\input{acronyms}\n\\input{ch1}\n\\end{document}\n' },
        {
            path: '/acronyms.tex',
            id: 'a',
            text: '\\chapter*{List of Acronyms}\n\\begin{tabular}{ll}\n  ADCS & \\\\\n  GNC & \\\\\n\\end{tabular}\n',
        },
        { path: '/ch1.tex', id: 'c', text: '\\chapter{One}\nThe RAAN drifts. RAAN again.\n' },
    ]
    const merged = runMerge(docs, 'acronyms')
    check(
        'small/a list of bare keys still gets its new keys',
        merged.applied.text.includes('RAAN'),
        merged.applied.text
    )
    check(
        'small/and the payload says the definitions had nowhere to go',
        core.summarise(merged.plan, merged.applied).definitionsDropped === true,
        JSON.stringify(core.summarise(merged.plan, merged.applied))
    )
    check(
        'small/an ordinary two column merge drops nothing',
        core.summarise(runMerge(phdProject(), 'acronyms').plan, runMerge(phdProject(), 'acronyms').applied)
            .definitionsDropped === false
    )
}

// ---------------------------------------------------------------------------
// 27. The acronym environment of the acronym package
// ---------------------------------------------------------------------------
// The third container shape: rows are \acro{SHORT}{Long form} commands. The
// fixture is the exact layout of a real thesis frontmatter (column alignment by
// runs of spaces, one row aligned with a TAB, the [WYSIWYM] width sample).

{
    const acroFile = [
        '\\addcontentsline{toc}{chapter}{Elenco degli acronimi}',
        '\\pagestyle{plain}',
        '\\chapter*{Elenco degli acronimi}',
        '\\begin{acronym}[WYSIWYM]',
        '    \\acro{IOS}          {In-Orbit Servicing}',
        '    \\acro{MLA} \t        {Micro Lens Array}',
        '    \\acro{FOV}          {Field Of View}',
        '\\end{acronym}',
        '',
    ].join('\n')
    const docs = [
        {
            path: '/main.tex',
            id: 'm',
            text: '\\documentclass{book}\n\\begin{document}\n\\input{Frontmatter/acronimi}\n\\input{ch1}\n\\end{document}\n',
        },
        { path: '/Frontmatter/acronimi.tex', id: 'a', text: acroFile },
        {
            path: '/ch1.tex',
            id: 'c',
            text: '\\chapter{Uno}\nIl GNSS guida il rendezvous. Il GNSS di nuovo. La IOS resta, FOV e MLA sono noti.\n',
        },
    ]
    const merged = runMerge(docs, 'acronyms')
    check('acroenv/the environment is a container', Boolean(merged.found && merged.found.container))
    check('acroenv/and it knows which kind it is', merged.found.container.isAcroEnv === true)
    check('acroenv/all three rows are read, the tab-aligned one too', merged.found.rows.length === 3,
        `rows=${merged.found.rows.length}`)
    check('acroenv/the keys are the short forms', merged.found.rows[1].keys.includes('MLA'))
    check('acroenv/a used undeclared acronym is added as an \\acro row',
        /\\acro\{GNSS\}/.test(merged.applied.text), merged.applied.text)
    check('acroenv/the new row copies the column spacing of the template',
        /\\acro\{GNSS\}\s{2,}\{/.test(merged.applied.text))
    check('acroenv/existing rows survive byte for byte',
        merged.applied.text.includes('    \\acro{MLA} \t        {Micro Lens Array}'))
    check('acroenv/nothing already listed is added again',
        (merged.applied.text.match(/\\acro\{IOS\}/g) || []).length === 1)
    check('acroenv/the width sample stays on the begin line',
        merged.applied.text.includes('\\begin{acronym}[WYSIWYM]'))
    // Idempotence: a second press on the merged text adds nothing.
    const again = runMerge(withText(docs, '/Frontmatter/acronimi.tex', merged.applied.text), 'acronyms')
    check('acroenv/a second press is a no-op', again.applied.inserted === 0,
        `inserted=${again.applied.inserted}`)

    // An EMPTY environment: the invented row is plain \acro{KEY}{VALUE}, spliced
    // after the width sample and before \end, with the default indent.
    const empty = withText(
        docs,
        '/Frontmatter/acronimi.tex',
        '\\chapter*{Elenco degli acronimi}\n\\begin{acronym}[WYSIWYM]\n\\end{acronym}\n'
    )
    const filled = runMerge(empty, 'acronyms')
    check('acroenv/an empty environment gets a plain invented row',
        /\n    \\acro\{GNSS\}\{[^{}]+\}\n/.test(filled.applied.text), filled.applied.text)
    check('acroenv/and the invented row is inside the environment',
        filled.applied.text.indexOf('\\acro{GNSS}') < filled.applied.text.indexOf('\\end{acronym}'))

    // A template row with a [custom short] argument: the new row must not
    // inherit somebody else's custom form.
    const custom = withText(
        docs,
        '/Frontmatter/acronimi.tex',
        '\\chapter*{Elenco degli acronimi}\n\\begin{acronym}\n    \\acro{FOV}[f.o.v.]{Field Of View}\n\\end{acronym}\n'
    )
    const customMerged = runMerge(custom, 'acronyms')
    check('acroenv/a custom short argument is read as a row', customMerged.found.rows.length === 1)
    check('acroenv/but never copied onto a new row',
        /\\acro\{GNSS\}\{/.test(customMerged.applied.text) &&
            !/\\acro\{GNSS\}\[/.test(customMerged.applied.text),
        customMerged.applied.text)

    // \acrodef declares exactly like \acro: a list written with it is read, not
    // re-populated under the other spelling.
    const acrodef = withText(
        docs,
        '/Frontmatter/acronimi.tex',
        '\\chapter*{Elenco degli acronimi}\n\\begin{acronym}\n    \\acrodef{GNSS}{Global Navigation Satellite System}\n\\end{acronym}\n'
    )
    const defMerged = runMerge(acrodef, 'acronyms')
    check('acroenv/an \\acrodef row is a row',
        (defMerged.applied.text.match(/GNSS/g) || []).length ===
            (acrodef.find(d => d.path === '/Frontmatter/acronimi.tex').text.match(/GNSS/g) || []).length)

    // A row this parser cannot read (a nested brace in the long form) is an entry
    // that exists: the merge refuses rather than risk writing next to it.
    const nested = withText(
        docs,
        '/Frontmatter/acronimi.tex',
        '\\chapter*{Elenco degli acronimi}\n\\begin{acronym}\n    \\acro{ERR}{Effective {Resolution} Ratio}\n    \\acro{FOV}{Field Of View}\n\\end{acronym}\n'
    )
    const refused = runMerge(nested, 'acronyms')
    check('acroenv/an unreadable row makes the merge refuse', refused.applied.unsupported === true,
        JSON.stringify({ inserted: refused.applied.inserted }))
}

console.log(ok ? '\nALL PASS' : '\nSOME FAILED')
process.exit(ok ? 0 : 1)
