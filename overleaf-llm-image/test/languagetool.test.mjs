// The LanguageTool proof-reader: what it sends, what it hides, and where it says a
// mistake is.
//
// This module is the only part of the review that answers a requirement from a THIRD
// PARTY. That makes three things worth pinning, and they are the three ways it can be
// wrong without anybody noticing:
//
//   - THE OFFSETS. Everything rests on the transform producing text of exactly the same
//     length as the source, so that an offset the server answers with is an offset into
//     the student's file. A line number that is off by a paragraph still looks like a
//     line number, and a report full of them is worse than no report: the student opens
//     the file, sees nothing wrong on that line, and stops trusting the whole document.
//   - THE FALSE POSITIVES. A spell checker pointed at raw LaTeX reports every label,
//     every citation key, every package name and every author's surname. A report whose
//     first ten items are the thesis's own vocabulary is a report nobody finishes.
//   - THE DISABLED PATH. With no LanguageTool configured, nothing may change, no socket
//     may be opened, and the requirement must go back to the model exactly as before.
//
// Unlike its neighbours this suite imports the module directly: LLMLanguageTool.mjs
// pulls in no Overleaf internals, so there is nothing to slice out of it. Every HTTP
// call is a stub, and a case that reaches the network is a failing case.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MODULE = process.env.LANGUAGETOOL || path.resolve(HERE, '../vendor/llm/app/src/LLMLanguageTool.mjs')
const LT = await import(pathToFileURL(MODULE).href)

// The environment must not decide what this suite measures: an instance that really has
// a LanguageTool container would otherwise silently enable the disabled-mode cases.
delete process.env.LLM_LANGUAGETOOL_URL
delete process.env.LLM_LANGUAGETOOL_DICT

const URL_UNDER_TEST = 'http://languagetool:8010'

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---- the stub server ----
// It records every request and answers whatever the case asks it to. Nothing here ever
// touches a socket; a case that forgets to pass the stub fails on `fetch is not defined`
// rather than quietly calling out.
function stubFetch(handler) {
    const calls = []
    const impl = async (url, options) => {
        const body = new URLSearchParams(options.body)
        const request = {
            url,
            text: body.get('text'),
            language: body.get('language'),
            disabledCategories: body.get('disabledCategories') || '',
            disabledRules: body.get('disabledRules') || '',
        }
        calls.push(request)
        const matches = (await handler(request, calls.length - 1)) || []
        return {
            ok: true,
            status: 200,
            async json() {
                return { matches }
            },
            async text() {
                return ''
            },
        }
    }
    impl.calls = calls
    return impl
}

const TYPO = {
    ruleId: 'MORFOLOGIK_RULE_EN_US',
    category: 'TYPOS',
    message: 'Possible spelling mistake found.',
    replacements: ['fixed'],
}

function matchAt(offset, length, opts = {}) {
    const spec = { ...TYPO, ...opts }
    return {
        offset,
        length,
        message: spec.message,
        replacements: (spec.replacements || []).map(value => ({ value })),
        rule: { id: spec.ruleId, category: { id: spec.category, name: spec.category } },
    }
}

// A match on a phrase, located in the text the server was actually sent. Anchoring on
// the text rather than on a number is what makes the chunk cases meaningful: the stub
// answers in CHUNK coordinates, and the module has to put the chunk back where it came
// from.
function matchOn(text, needle, opts = {}) {
    const offset = text.indexOf(needle)
    if (offset === -1) return null
    return matchAt(offset, needle.length, opts)
}

const lineOf = (text, needle) => text.slice(0, text.indexOf(needle)).split('\n').length

// ---------------------------------------------------------------------------
// Disabled: no URL, no requests, no change
// ---------------------------------------------------------------------------
{
    const stub = stubFetch(() => [])
    const report = await LT.checkDocuments([{ path: '/main.tex', text: 'Some text with a errors.' }], {
        language: 'en',
        fetchImpl: stub,
    })
    check('with no URL the module reports itself disabled', report.enabled === false, JSON.stringify(report.totals))
    check('and it is not an error, so the caller can hand the requirement back to the model', report.ok === true)
    check('and nothing is sent anywhere', stub.calls.length === 0, `${stub.calls.length} requests`)
    check('and it still answers a JSON-able shape', Array.isArray(report.matches) && report.totals.matches === 0)
    check('isLanguageToolEnabled agrees', LT.isLanguageToolEnabled({}) === false)
    check('and an explicit URL enables it without an environment', LT.isLanguageToolEnabled({ url: URL_UNDER_TEST }))
}

// ---------------------------------------------------------------------------
// The language, from the rubric's own mechanism
// ---------------------------------------------------------------------------
{
    check('it becomes it-IT', LT.languageToolCode('it') === 'it-IT', LT.languageToolCode('it'))
    check('en becomes en-US', LT.languageToolCode('en') === 'en-US', LT.languageToolCode('en'))
    // The rubric language is detected as 'it' or 'en' and nothing else, so anything else
    // is a caller mistake and must not become `auto`: a detector makes the answer depend
    // on which chapter went first, which is the run-to-run variation this replaces.
    check('an unknown language falls back to English, never to auto', LT.languageToolCode('de') === 'en-US')
    check('and so does a missing one', LT.languageToolCode(undefined) === 'en-US')
    check('a full locale is passed through', LT.languageToolCode('en-GB') === 'en-GB', LT.languageToolCode('en-GB'))
    check('and normalised', LT.languageToolCode('pt-br') === 'pt-BR', LT.languageToolCode('pt-br'))

    const stub = stubFetch(() => [])
    const report = await LT.checkDocuments([{ path: '/main.tex', text: 'Il testo della tesi.' }], {
        language: 'it',
        url: URL_UNDER_TEST,
        fetchImpl: stub,
    })
    check('the request carries the rubric language', stub.calls[0].language === 'it-IT', stub.calls[0].language)
    check('and the report says which language it used', report.language === 'it-IT')
    check('the endpoint is the v2 check API', stub.calls[0].url === 'http://languagetool:8010/v2/check', stub.calls[0].url)
}

// A base URL an administrator pasted from the LanguageTool documentation still works.
{
    for (const base of ['http://languagetool:8010/', 'http://languagetool:8010/v2', 'http://languagetool:8010/v2/check']) {
        const stub = stubFetch(() => [])
        await LT.checkDocuments([{ path: '/a.tex', text: 'Text.' }], { url: base, fetchImpl: stub })
        check(`"${base}" reaches /v2/check`, stub.calls[0].url === 'http://languagetool:8010/v2/check', stub.calls[0].url)
    }
}

// ---------------------------------------------------------------------------
// LaTeX -> prose, at constant offsets
// ---------------------------------------------------------------------------
const DOCUMENT = [
    '\\documentclass[12pt,twoside]{report}',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage{amsmath,graphicx,biblatex}',
    '\\addbibresource{thesis.bib}',
    '\\begin{document}',
    '',
    '\\chapter{Attitude control}',
    '\\label{ch:attitude}',
    '',
    '% a note to self: rewrite this paragraph',
    'The controller keeps the \\textbf{pointing error} bounded, as shown by Kalman \\cite{kalman1960}.',
    'The gain is \\(k_p\\) and the residual is $e_{\\mathrm{rms}}$.',
    '',
    '\\begin{equation}',
    '    \\ddot{\\theta} + 2 \\zeta \\omega \\dot{\\theta} = u(t)',
    '    \\label{eq:plant}',
    '\\end{equation}',
    '',
    'After the equation the results is reported in Figure~\\ref{fig:plant}.',
    '',
    '\\begin{figure}[htbp]',
    '    \\centering',
    '    \\includegraphics[width=0.8\\textwidth]{images/plant-response-final.pdf}',
    '    \\caption{Step response of the closed loop.}',
    '    \\label{fig:plant}',
    '\\end{figure}',
    '',
    '\\begin{lstlisting}[language=Python,label=lst:one]',
    'def controlr(x): return x  # a typo nobody wrote in prose',
    '\\end{lstlisting}',
    '',
    'The dataset is published online \\href{https://example.org/data.zip}{on the lab page}.',
    '',
    '\\end{document}',
].join('\n')

{
    const prose = LT.toProse(DOCUMENT)
    check('the prose has exactly the length of the source', prose.length === DOCUMENT.length, `${prose.length} vs ${DOCUMENT.length}`)
    check(
        'and exactly its lines',
        prose.split('\n').length === DOCUMENT.split('\n').length,
        `${prose.split('\n').length} vs ${DOCUMENT.split('\n').length}`
    )
    // Every offset is therefore the source's own offset: this is the property every
    // reported line number rests on.
    const at = DOCUMENT.indexOf('pointing error')
    check('and an offset in one is the same offset in the other', prose.slice(at, at + 14) === 'pointing error')

    const gone = needle => !prose.includes(needle)
    check('the preamble is gone', gone('inputenc') && gone('biblatex') && gone('twoside'))
    check('the package file names are gone', gone('thesis.bib'))
    check('line comments are gone', gone('rewrite this paragraph'))
    check('shown code is gone', gone('controlr'), 'a listing is code, and its typos are not the prose')
    check('display maths is gone', gone('zeta') && gone('ddot'))
    check('inline maths is gone', gone('k_p') && gone('mathrm'))
    check('label and reference names are gone', gone('eq:plant') && gone('fig:plant') && gone('ch:attitude'))
    check('citation keys are gone', gone('kalman1960'))
    check('image paths are gone', gone('plant-response-final'))
    check('float placement options are gone', gone('htbp'))
    check('listing options are gone', gone('lst:one') && gone('Python'))
    check('the URL of a link is gone', gone('example.org'))
    check('and command names are gone', gone('textbf') && gone('includegraphics') && gone('centering'))

    const kept = needle => prose.includes(needle)
    check('the prose inside a formatting command survives', kept('pointing error'))
    check('the visible text of a link survives', kept('on the lab page'))
    check('a caption survives', kept('Step response of the closed loop'))
    check('a heading survives', kept('Attitude control'))
    check('and the running text survives', kept('After the equation the results is reported in Figure'))
    // The braces are not prose, and leaving them in glues a word to its neighbour.
    check('the braces are not left behind', !/[{}]/.test(prose))
}

// ---------------------------------------------------------------------------
// Scaffolding measured leaking on a real template (2026-08-03)
// ---------------------------------------------------------------------------
// LanguageTool got "toc" and "chapter" from \addcontentsline (suggested "Hoc"
// and "charter") and a \lstdefinestyle body (suggested "brevilinea" for
// breaklines): 772 findings on a project whose prose was fine. The arguments
// are identifiers and must never reach the proof-reader; the printed title of
// \addcontentsline is prose and must.
{
    const scaffold = LT.toProse(
        '\\tableofcontents\n\\addcontentsline{toc}{chapter}{Indice}\n\\listoffigures\n' +
            '\\lstdefinestyle{Matlabstyle}{ language=Matlab, keywordstyle=\\color{keyBlue}, breaklines=true }\n' +
            '\\titleformat{\\chapter}[hang]{\\normalfont\\huge\\bfseries}{\\chaptername}{1em}{}\n'
    )
    check('the toc arguments of addcontentsline are gone', !scaffold.includes('toc') && !/\bchapter\b/.test(scaffold), scaffold)
    check('but its printed title survives', scaffold.includes('Indice'))
    check('a lstdefinestyle body is gone', !scaffold.includes('breaklines') && !scaffold.includes('keyBlue'))
    check('a titleformat body is gone', !scaffold.includes('hang') && !scaffold.includes('1em'))

    // A configuration file with no \begin{document} (a setup.tex input from the
    // preamble) is skipped whole: what little the blanking leaves is option
    // keys, and every one of them came back as a typo in a file the student
    // must not edit. A SHORT PROSE file stays in: its few words are most of it.
    const config = Array.from({ length: 40 }, (_, i) => `\\definecolor{color${i}}{RGB}{10,20,30}\n\\setcounter{c${i}}{4}`).join('\n')
    const stub = stubFetch(request => [matchOn(request.text, 'colorx', { ruleId: 'TYPO', category: 'TYPOS' })].filter(Boolean))
    const skipped = await LT.checkDocuments(
        [{ path: '/setup_do_not_edit/setup.tex', text: config }],
        { url: 'http://languagetool:8010', fetchImpl: stub, language: 'it' }
    )
    check('a pure configuration file is skipped whole', skipped.totals.chunks === 0, JSON.stringify(skipped.totals))
    const shortAbstract = await LT.checkDocuments(
        [
            {
                path: '/Frontmatter/abstract.tex',
                text:
                    '\\chapter*{Sommario}\nQuesto lavoro presenta un banco prova per il controllo di assetto di un piccolo satellite. ' +
                    'Il documento descrive la progettazione del sistema, le prove sperimentali condotte in laboratorio e i risultati ottenuti, ' +
                    'con particolare attenzione alla ripetibilita delle misure e ai limiti del banco.\n',
            },
        ],
        { url: 'http://languagetool:8010', fetchImpl: stub, language: 'it' }
    )
    check('a short prose file is still read', shortAbstract.totals.chunks > 0, JSON.stringify(shortAbstract.totals))
}

// ---------------------------------------------------------------------------
// The title page, foreign terms and the document's own vocabulary (2026-08-03)
// ---------------------------------------------------------------------------
// Measured on a real thesis: the proof-reader corrected the supervisor's
// surname on the frontespizio, offered "Dee p" for \textit{Deep Learning}, and
// buried two real typos under dozens of hits on "plenottica" and "dataset".
{
    check('a newgeometry argument is not prose', !LT.toProse('\\newgeometry{top=12.5mm,bottom=12.5mm,left=30mm}').includes('bottom'))
    const italics = LT.toProse(
        'Modelli di \\textit{Deep Learning} per la stima. ' +
            '\\emph{ground truth} nominali. ' +
            '\\textit{Questa frase intera resta prosa perche contiene una frase, non un termine.}'
    )
    check('a short italic group is a foreign term, not prose', !italics.includes('Deep') && !italics.includes('ground'))
    check('a long italic clause stays checked', italics.includes('resta prosa'))

    const stub = stubFetch(request =>
        ['plenottica', 'refuso'].flatMap(word =>
            [matchOn(request.text, word, { ruleId: 'MORFOLOGIK_RULE_IT_IT', category: 'TYPOS' })].filter(Boolean)
        )
    )
    const body =
        'La camera plenottica acquisisce il campo di luce. La tecnologia plenottica supera i sensori. ' +
        'Una camera plenottica misura le direzioni. Il sistema plenottica finale contiene un refuso vero.\n'
    const report = await LT.checkDocuments(
        [{ path: '/chapters/uno.tex', text: `${body}${'Altre parole comuni della prosa del capitolo che servono da riempimento per il gate. '.repeat(4)}` }],
        { url: 'http://languagetool:8010', fetchImpl: stub, language: 'it' }
    )
    check(
        'a word the author uses four times is vocabulary, not a typo',
        report.totals.droppedAsVocabulary === 1,
        JSON.stringify(report.totals)
    )
    check('a one-off unknown word is still a finding', report.totals.kept === 1, JSON.stringify(report.totals))

    const title = await LT.checkDocuments(
        [{ path: '/Frontmatter/frontespizio.tex', text: 'Relatore Prof. Dario Modenini, presentata da Nicolo Pierpaoli, correlatore Dott. Alessandro Lotti. '.repeat(6) }],
        { url: 'http://languagetool:8010', fetchImpl: stub, language: 'it' }
    )
    check('the title page is never proof-read', title.totals.chunks === 0, JSON.stringify(title.totals))
}

// ---------------------------------------------------------------------------
// A mistake after a blanked equation lands on the right line
// ---------------------------------------------------------------------------
{
    const NEEDLE = 'the results is reported'
    const stub = stubFetch(request => [matchOn(request.text, NEEDLE, { ruleId: 'AGREEMENT', category: 'GRAMMAR' })].filter(Boolean))
    const report = await LT.checkDocuments([{ path: '/chapters/attitude.tex', text: DOCUMENT }], {
        language: 'en',
        url: URL_UNDER_TEST,
        fetchImpl: stub,
    })
    const expected = lineOf(DOCUMENT, NEEDLE)
    check('the finding is kept', report.matches.length === 1, JSON.stringify(report.totals))
    check(
        'and it points at the line the student will open',
        report.matches[0] && report.matches[0].line === expected,
        `reported ${report.matches[0] && report.matches[0].line}, real line ${expected}`
    )
    check('with the file it is in', report.matches[0] && report.matches[0].file === '/chapters/attitude.tex')
    check('the rule travels with it', report.matches[0] && report.matches[0].ruleId === 'AGREEMENT')
    check(
        'and the excerpt quotes the real source, not the blanked text',
        report.matches[0] && report.matches[0].excerpt.includes('the results is reported'),
        report.matches[0] && report.matches[0].excerpt
    )
    check(
        'the suggestion is the replacement the server offered',
        report.matches[0] && report.matches[0].suggestion === 'fixed',
        report.matches[0] && report.matches[0].suggestion
    )
    check('and the totals add up', report.totals.matches === 1 && report.totals.kept === 1 && report.totals.shown === 1)
}

// ---------------------------------------------------------------------------
// Chunking: the offset base of each request
// ---------------------------------------------------------------------------
// A file over the request limit is cut at a paragraph boundary, and every chunk carries
// the offset it starts at. Get that base wrong and the line numbers of everything after
// the first chunk are wrong, plausibly, silently and everywhere.
{
    const NEEDLE = 'the antenna were aligned'
    const filler = Array.from(
        { length: 260 },
        (_, i) => `Paragraph ${i} describes the ground segment and the link budget of the mission.`
    ).join('\n\n')
    const long = `${filler}\n\nAt the end of the file the antenna were aligned with the ground station.\n`
    check('the fixture really is longer than one request', long.length > LT.MAX_CHUNK_CHARS, `${long.length} chars`)

    const stub = stubFetch(request => [matchOn(request.text, NEEDLE, { ruleId: 'AGREEMENT', category: 'GRAMMAR' })].filter(Boolean))
    const report = await LT.checkDocuments([{ path: '/main.tex', text: long }], {
        language: 'en',
        url: URL_UNDER_TEST,
        fetchImpl: stub,
    })
    check('it is sent in more than one request', stub.calls.length > 1, `${stub.calls.length} requests`)
    check('every request is under the limit', stub.calls.every(c => c.text.length <= LT.MAX_CHUNK_CHARS))
    check('the phrase is only in the last one', stub.calls.filter(c => c.text.includes(NEEDLE)).length === 1)
    // The chunks tile the file: chunk n+1 starts exactly where chunk n ended.
    const prose = LT.toProse(long)
    let base = 0
    let tiled = true
    for (const call of stub.calls) {
        if (prose.slice(base, base + call.text.length) !== call.text) tiled = false
        base += call.text.length
    }
    check('and they tile the file with no gap and no overlap', tiled)
    check('the chunks are cut at paragraph boundaries', stub.calls.slice(0, -1).every(c => /\n$/.test(c.text)))

    const expected = lineOf(long, NEEDLE)
    check(
        'a mistake in the second chunk still lands on its real line',
        report.matches.length === 1 && report.matches[0].line === expected,
        `reported ${report.matches[0] && report.matches[0].line}, real line ${expected}`
    )
    check(
        'and the excerpt is taken from the right place in the file',
        report.matches[0] && report.matches[0].excerpt.includes(NEEDLE),
        report.matches[0] && report.matches[0].excerpt
    )
}

// A file whose transform leaves nothing but blanks costs no request at all.
{
    const stub = stubFetch(() => [])
    await LT.checkDocuments(
        [{ path: '/preamble.tex', text: '\\usepackage{graphicx}\n\\usepackage{amsmath}\n% only setup here\n' }],
        { url: URL_UNDER_TEST, fetchImpl: stub }
    )
    check('a file with no prose is not sent', stub.calls.length === 0, `${stub.calls.length} requests`)
}

// ---------------------------------------------------------------------------
// The false-positive filters (CheckMyTex)
// ---------------------------------------------------------------------------
// Each one is exercised by an answer that WOULD reach the report if the filter were
// removed: the stub is told to flag exactly the span the filter is supposed to catch.
{
    const source = 'As shown by Rossi \\cite{rossi2019} the \\textbf{result} holds, see \\ref{fig:one} and \\label{sec:two}.'
    const doc = [{ path: '/a.tex', text: source }]

    const flag = (needle, opts) => {
        const offset = source.indexOf(needle)
        if (offset === -1) throw new Error(`the fixture does not contain ${JSON.stringify(needle)}`)
        return { offset, length: needle.length, opts }
    }

    const run = async spans => {
        const stub = stubFetch(() => spans.map(s => matchAt(s.offset, s.length, s.opts)))
        // crossCheck off: these stubs pin offsets into THIS fixture, and the
        // batched foreign-word request would read them as nonsense slices.
        return LT.checkDocuments(doc, { language: 'en', url: URL_UNDER_TEST, fetchImpl: stub, crossCheck: false })
    }

    // 1. Entirely inside a command token. The transform already blanks it, so this is
    // the second line of defence and it must hold on its own.
    let report = await run([flag('textbf')])
    check('a match inside a command name is dropped', report.matches.length === 0 && report.totals.filtered === 1, JSON.stringify(report.totals))

    // 2. Inside the braces of a \cite, a \ref or a \label: those are names, not words.
    report = await run([flag('rossi2019'), flag('fig:one'), flag('sec:two')])
    check('a match inside a citation key, a reference or a label is dropped', report.matches.length === 0 && report.totals.filtered === 3, JSON.stringify(report.totals))

    // 3. A capitalised word immediately before a citation is an author's surname, and no
    // dictionary contains it.
    report = await run([flag('Rossi')])
    check('an author name in front of a \\cite is dropped', report.matches.length === 0 && report.totals.filtered === 1, JSON.stringify(report.totals))

    // 4. Anything carrying a backslash is markup the transform did not catch, never a
    // word the student can correct.
    report = await run([flag('\\textbf{result}')])
    check('a span carrying a backslash is dropped', report.matches.length === 0 && report.totals.filtered === 1, JSON.stringify(report.totals))

    // And the control: an ordinary word in the same fixture is reported.
    report = await run([flag('result')])
    check('while a real word in the same sentence is kept', report.matches.length === 1 && report.totals.filtered === 0, JSON.stringify(report.totals))

    // DELIBERATE CHANGE (2026-08-03): a capitalised unknown word in MID-sentence
    // is a proper noun (Space Economy, Sputnik, Cycles on a real thesis), not a
    // typo. At a sentence START nothing can be told, so there it still reports.
    const plain = [{ path: '/b.tex', text: 'The Rossi model is used in this chapter.' }]
    const stub = stubFetch(request => [matchOn(request.text, 'Rossi')])
    report = await LT.checkDocuments(plain, { language: 'en', url: URL_UNDER_TEST, fetchImpl: stub, crossCheck: false })
    check(
        'a capitalised word in mid-sentence is a proper noun, not a typo',
        report.matches.length === 0 && report.totals.filtered === 1,
        JSON.stringify(report.totals)
    )
    const opening = [{ path: '/c.tex', text: 'Rossi model is used in this chapter.' }]
    const openingStub = stubFetch(request => [matchOn(request.text, 'Rossi')])
    report = await LT.checkDocuments(opening, { language: 'en', url: URL_UNDER_TEST, fetchImpl: openingStub, crossCheck: false })
    check('a capitalised word at a sentence start is still reported', report.matches.length === 1, JSON.stringify(report.totals))

    // An offset the file cannot carry points at a line that does not exist.
    const outOfRange = stubFetch(() => [matchAt(999999, 5)])
    report = await LT.checkDocuments(plain, { url: URL_UNDER_TEST, fetchImpl: outOfRange })
    check('an impossible offset is dropped instead of inventing a line', report.matches.length === 0 && report.totals.filtered === 1)
}

// ---------------------------------------------------------------------------
// The domain dictionary
// ---------------------------------------------------------------------------
{
    // Lowercase on purpose: a capitalised "Overleaf" in mid-sentence is now
    // filtered as a proper noun before the dictionary ever sees it.
    const source = 'The overleaf instance runs biblatex, and the quaternion is normalised.'
    const doc = [{ path: '/a.tex', text: source }]
    const all = request =>
        ['overleaf', 'biblatex', 'quaternion'].map(w => matchOn(request.text, w)).filter(Boolean)

    let report = await LT.checkDocuments(doc, { url: URL_UNDER_TEST, fetchImpl: stubFetch(all) })
    check('with no dictionary every term is a finding', report.matches.length === 3, JSON.stringify(report.totals))

    report = await LT.checkDocuments(doc, {
        url: URL_UNDER_TEST,
        dictionary: 'Overleaf, biblatex',
        fetchImpl: stubFetch(all),
    })
    check('a whitelisted term is dropped', report.matches.length === 1 && report.matches[0].excerpt.includes('quaternion'))
    check(
        'and the count says how many the whitelist removed',
        report.totals.droppedByWhitelist === 2 && report.totals.filtered === 0,
        JSON.stringify(report.totals)
    )
    check('the true total still counts them', report.totals.matches === 3 && report.totals.kept === 1)

    // Case does not matter, and the term is the WHOLE word: a two-letter entry must not
    // silence every word that contains it.
    report = await LT.checkDocuments(doc, {
        url: URL_UNDER_TEST,
        dictionary: ['OVERLEAF', 'la'],
        fetchImpl: stubFetch(all),
    })
    check('the dictionary ignores case', report.totals.droppedByWhitelist === 1, JSON.stringify(report.totals))
    check('and never matches a substring', report.matches.some(m => m.excerpt.includes('biblatex')))

    // The environment is the administrator's channel; the option adds to it.
    process.env.LLM_LANGUAGETOOL_DICT = 'quaternion'
    report = await LT.checkDocuments(doc, {
        url: URL_UNDER_TEST,
        dictionary: 'Overleaf',
        fetchImpl: stubFetch(all),
    })
    check('LLM_LANGUAGETOOL_DICT and the call are both read', report.totals.droppedByWhitelist === 2, JSON.stringify(report.totals))
    delete process.env.LLM_LANGUAGETOOL_DICT
}

// ---------------------------------------------------------------------------
// Which categories are reported at all
// ---------------------------------------------------------------------------
{
    const source = 'The result is very good and the datas are consistent.'
    const doc = [{ path: '/a.tex', text: source }]
    const stub = stubFetch(request =>
        [
            matchOn(request.text, 'datas', { ruleId: 'MORFOLOGIK_RULE_EN_US', category: 'TYPOS' }),
            matchOn(request.text, 'very good', { ruleId: 'EN_WEAK_ADJECTIVE', category: 'STYLE' }),
            matchOn(request.text, 'is', { ruleId: 'UPPERCASE_SENTENCE_START', category: 'CASING' }),
        ].filter(Boolean)
    )
    const report = await LT.checkDocuments(doc, { url: URL_UNDER_TEST, fetchImpl: stub })
    check('a spelling mistake is reported', report.matches.length === 1 && report.matches[0].category === 'TYPOS', JSON.stringify(report.matches))
    check('a style note is not', report.totals.filtered === 2, JSON.stringify(report.totals))
    check('and the true total still counts what was thrown away', report.totals.matches === 3 && report.totals.kept === 1)

    // The server is ASKED to leave them out as well, so a healthy container does not
    // compute them at all. Both halves matter: a build that ignores the parameter is
    // still filtered here, and a build that honours it costs less.
    check('the request declares the excluded categories', stub.calls[0].disabledCategories.includes('STYLE') && stub.calls[0].disabledCategories.includes('TYPOGRAPHY'), stub.calls[0].disabledCategories)
    check('and the excluded rules', stub.calls[0].disabledRules.includes('WHITESPACE_RULE'), stub.calls[0].disabledRules)
    check('typography is excluded because this module manufactures whitespace', LT.EXCLUDED_CATEGORIES.includes('TYPOGRAPHY'))
    check('grammar and spelling are not excluded', !LT.EXCLUDED_CATEGORIES.includes('GRAMMAR') && !LT.EXCLUDED_CATEGORIES.includes('TYPOS'))

    // The list is a documented constant, and a rubric that wants another trade-off
    // overrides it at the call rather than editing this file.
    const kept = await LT.checkDocuments(doc, { url: URL_UNDER_TEST, excludedCategories: [], excludedRules: [], fetchImpl: stubFetch(request => [matchOn(request.text, 'very good', { category: 'STYLE' })].filter(Boolean)) })
    check('an empty exclusion list reports everything', kept.matches.length === 1 && kept.matches[0].category === 'STYLE')
}

// ---------------------------------------------------------------------------
// The cap, and the totals that must survive it
// ---------------------------------------------------------------------------
// A first draft with one systematic habit produces hundreds of hits of the same shape.
// The list is capped so the report stays readable; the COUNT is not, because "60 of 412"
// and "60" are different pieces of news.
{
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`)
    const source = words.join(' ')
    const stub = stubFetch(request => words.map(w => matchOn(request.text, w)).filter(Boolean))
    const report = await LT.checkDocuments([{ path: '/a.tex', text: source }], { url: URL_UNDER_TEST, fetchImpl: stub })
    check('the stored list is capped', report.matches.length === LT.MAX_STORED_MATCHES, `${report.matches.length} stored`)
    check('the cap is the one the module documents', LT.MAX_STORED_MATCHES === 60)
    check('shown says how many are in the list', report.totals.shown === LT.MAX_STORED_MATCHES, JSON.stringify(report.totals))
    check('and the true total is not capped with it', report.totals.matches === 200 && report.totals.kept === 200, JSON.stringify(report.totals))
    check('the ones kept are the first ones, in file order', report.matches[0].excerpt.startsWith('«word0»'), report.matches[0].excerpt)
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
// The whole reason for taking this requirement away from the model: the same document
// must produce the same report, byte for byte.
{
    const docs = [
        { path: '/a.tex', text: DOCUMENT },
        { path: '/b.tex', text: 'A second file with a errors in it and another sentance.' },
    ]
    const answer = request =>
        ['the results is reported', 'a errors', 'sentance'].map(w => matchOn(request.text, w)).filter(Boolean)
    const first = await LT.checkDocuments(docs, { language: 'en', url: URL_UNDER_TEST, fetchImpl: stubFetch(answer) })
    const second = await LT.checkDocuments(docs, { language: 'en', url: URL_UNDER_TEST, fetchImpl: stubFetch(answer) })
    check('the same input gives the same output', JSON.stringify(first) === JSON.stringify(second))
    check('and the whole report is JSON-able', JSON.parse(JSON.stringify(first)).totals.matches === first.totals.matches)
    check('files counts what was inspected', first.files === 2, `${first.files}`)
    check('findings from both files are reported', new Set(first.matches.map(m => m.file)).size === 2, JSON.stringify(first.matches.map(m => m.file)))
}

// A .bib is data. Read as prose it is a few hundred author names, every one a finding.
{
    const stub = stubFetch(() => [])
    const report = await LT.checkDocuments(
        [
            { path: '/main.tex', text: 'The text of the thesis.' },
            { path: '/refs.bib', text: '@article{kalman1960, author = {Kalman, R. E.}, title = {A New Approach}}' },
        ],
        { url: URL_UNDER_TEST, fetchImpl: stub }
    )
    check('a .bib is never proof-read', report.files === 1 && stub.calls.length === 1, `${report.files} files, ${stub.calls.length} requests`)
    check('and it is the .tex that was sent', stub.calls[0].text.includes('The text of the thesis'))
}

// ---------------------------------------------------------------------------
// A LanguageTool that is not there
// ---------------------------------------------------------------------------
// It must not take the review down, and it must not come back as "no mistakes found":
// an outage that reads like a pass is the worst answer available here.
{
    const dead = async () => {
        throw new Error('connect ECONNREFUSED 172.18.0.9:8010')
    }
    const report = await LT.checkDocuments([{ path: '/a.tex', text: 'Some prose in a file.' }], {
        url: URL_UNDER_TEST,
        fetchImpl: dead,
    })
    check('an unreachable container is an error, not a pass', report.ok === false && report.enabled === true, JSON.stringify(report))
    check('the reason is carried', /ECONNREFUSED/.test(report.error || ''), report.error)
    check('and no finding is invented', report.matches.length === 0 && report.totals.matches === 0)

    const refusing = async () => ({
        ok: false,
        status: 413,
        async json() {
            return {}
        },
        async text() {
            return 'text exceeds the limit'
        },
    })
    const rejected = await LT.checkDocuments([{ path: '/a.tex', text: 'Some prose in a file.' }], {
        url: URL_UNDER_TEST,
        fetchImpl: refusing,
    })
    check('a refused request is an error too', rejected.ok === false && /413/.test(rejected.error || ''), rejected.error)
}

// ---------------------------------------------------------------------------
// Quoted student text cannot become an engine marker
// ---------------------------------------------------------------------------
// `[warning: ...]` at the end of an evidence string is the engine's reliability badge,
// and both readers strip it with a tail regex. This module quotes raw LaTeX into the
// excerpt, so a student who writes that sequence would otherwise have it rendered as the
// badge, on a verdict the report tells the reader to trust because a parser made it.
{
    const source = 'The plan [warning: nothing here is real] was written by the student.'
    const stub = stubFetch(request => [matchOn(request.text, 'plan')].filter(Boolean))
    const report = await LT.checkDocuments([{ path: '/a.tex', text: source }], { url: URL_UNDER_TEST, fetchImpl: stub })
    check('the marker is neutralised in the excerpt', !/\[\s*warning\s*:/i.test(report.matches[0].excerpt), report.matches[0].excerpt)
    check('and the words the student wrote survive', /nothing here is real/.test(report.matches[0].excerpt))
}

// ---------------------------------------------------------------------------
// Performance tripwires
// ---------------------------------------------------------------------------
// Every construct here is one this module has to pair up or scan past: an environment
// that never closes, a brace that never closes, an odd number of maths delimiters, a
// file that is one line. Each of them has been a quadratic in this codebase at some
// point, at a cost of seconds to minutes of frozen event loop on Node's single thread,
// from one student clicking Run once. The ceiling is deliberately loose: it is not a
// benchmark, it is a tripwire, and a return to quadratic blows through it by minutes.
{
    const adversarial = {
        'unclosed verbatim': '\\begin{verbatim}\nsome code here\n'.repeat(20000),
        'unclosed braces': '\\chapter{'.repeat(40000),
        'unpaired dollars': 'text $ more text '.repeat(60000),
        'unclosed display maths': '\\[ x = 1 '.repeat(30000),
        'a command on every word': '\\textbf{word} \\ref{fig:a} \\cite{key} ordinary prose here. '.repeat(50000),
        'a 2 MB single line': 'word '.repeat(400000),
        'unclosed inline verb': '\\verb|code '.repeat(30000),
    }
    for (const [name, text] of Object.entries(adversarial)) {
        const started = Date.now()
        const prose = LT.toProse(text)
        const elapsed = Date.now() - started
        check(
            `${name}: transformed in linear time`,
            elapsed < 5000,
            `${elapsed} ms on ${(text.length / 1e6).toFixed(2)} MB`
        )
        // And the invariant still holds on every one of them: a document that breaks the
        // offsets quietly is worse than one that takes a second longer.
        check(`${name}: and the offsets survive it`, prose.length === text.length)
    }
}

// ---------------------------------------------------------------------------
// ReDoS tripwire: the identifier-argument span on a runaway command name
// ---------------------------------------------------------------------------
// IDENTIFIER_ARGUMENT_SPAN blanks the braces of \label/\ref/\cite so LanguageTool never
// reads a citation key as a misspelling. Its braces were already bounded, but the
// command-name repetitions `[a-zA-Z]*cite[a-zA-Z]*` were not, and a source that is one
// backslash followed by 200 KB of "cite" - no braces, so the span can never complete -
// backtracked quadratically, measured at 27 s on 160 KB. checkDocuments computes these
// spans once per document before it chunks, so the payload reaches the real regex; the
// stub keeps it offline. This ceiling is separate from toProse's above because the span
// lives in checkDocuments, not in the transform. Revert the {0,32} name bound and it
// blows through by tens of seconds.
{
    const REDOS_CEILING_MS = 2000
    const payload = '\\' + 'cite'.repeat(50000)
    const stub = stubFetch(() => [])
    const started = Date.now()
    const report = await LT.checkDocuments([{ path: '/evil.tex', text: payload }], {
        url: URL_UNDER_TEST,
        fetchImpl: stub,
    })
    const elapsed = Date.now() - started
    check(
        'a runaway \\cite command name does not make the identifier scan quadratic',
        elapsed < REDOS_CEILING_MS && report.ok === true,
        `${elapsed} ms on ${(payload.length / 1024).toFixed(0)} KB (ceiling ${REDOS_CEILING_MS} ms)`
    )
    // And the bound has not broken ordinary proof-reading: a \cref key is blanked and left
    // unreported, while a real typo in the prose beside it is still flagged.
    const kept = stubFetch(request => {
        const i = request.text.indexOf('teh')
        return i >= 0 ? [matchAt(i, 3)] : []
    })
    const real = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'As shown in \\cref{fig:schema-blocchi} teh result holds.' }],
        { url: URL_UNDER_TEST, fetchImpl: kept }
    )
    check(
        'the bounded identifier span leaves ordinary proof-reading intact',
        real.matches.length === 1 && /teh/.test(real.matches[0].excerpt || ''),
        JSON.stringify(real.matches)
    )
}

// ---------------------------------------------------------------------------
// Tenth wave, measured on the course guide itself: titles and initials before
// surnames, abbreviation tails, placeholders, quoted punctuation, X a X, and
// the derived-word check that asks the engines about the PARTS of a word.
// ---------------------------------------------------------------------------
{
    // "prof. Modenini": the full stop of a title ends no sentence, so the
    // surname is a mid-sentence proper noun and goes.
    const it = { language: 'it', url: URL_UNDER_TEST, crossCheck: false }
    let stub = stubFetch(request => [matchOn(request.text, 'Modenini')].filter(Boolean))
    let report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'Il relatore prof. Modenini approva il lavoro.' }],
        { ...it, fetchImpl: stub }
    )
    check('a surname after "prof." is a proper noun, not a typo', report.matches.length === 0 && report.totals.filtered === 1, JSON.stringify(report.totals))

    // "via B. Carnaccini": a dotted initial is not a sentence end either.
    stub = stubFetch(request => [matchOn(request.text, 'Carnaccini')].filter(Boolean))
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'La sede resta in via B. Carnaccini 12 a Forlì.' }],
        { ...it, fetchImpl: stub }
    )
    check('a surname after a dotted initial is a proper noun', report.matches.length === 0, JSON.stringify(report.matches))

    // A REAL sentence boundary still keeps the capitalised unknown: there
    // nothing can be told, and absolution belongs to the cross-check.
    stub = stubFetch(request => [matchOn(request.text, 'Modenini')].filter(Boolean))
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'La frase precedente finisce qui. Modenini approva il lavoro.' }],
        { ...it, fetchImpl: stub }
    )
    check('a capitalised word at a true sentence start is still a finding', report.matches.length === 1, JSON.stringify(report.totals))

    // "dott.ssa": the tail after the dot is the abbreviation's own.
    stub = stubFetch(request => [matchOn(request.text, 'ssa')].filter(Boolean))
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'Scrivere alla dott.ssa responsabile della sicurezza.' }],
        { ...it, fetchImpl: stub }
    )
    check('the tail of a dotted abbreviation is not a word', report.matches.length === 0, JSON.stringify(report.matches))

    // gg/mm/aaaa: repeated-letter placeholders.
    stub = stubFetch(request => [matchOn(request.text, 'gg'), matchOn(request.text, 'aaaa')].filter(Boolean))
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'Indicare la data nel formato gg/mm/aaaa sul modulo.' }],
        { ...it, fetchImpl: stub }
    )
    check('date placeholders made of one repeated letter are not typos', report.matches.length === 0 && report.totals.filtered === 2, JSON.stringify(report.totals))

    // ``??'' quoted as an example is the text talking about punctuation; the
    // same finding outside quotes is real.
    const doubles = request => [matchOn(request.text, '??', { ruleId: 'UNPAIRED_QUESTION', category: 'GRAMMAR' })].filter(Boolean)
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: "un riferimento rotto stampa ``??'' nel PDF finale" }],
        { ...it, fetchImpl: stubFetch(doubles) }
    )
    check('punctuation quoted as an example is filtered', report.matches.length === 0, JSON.stringify(report.matches))
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'ma che cosa significa tutto questo ?? davvero' }],
        { ...it, fetchImpl: stubFetch(doubles) }
    )
    check('the same punctuation outside quotes stays a finding', report.matches.length === 1, JSON.stringify(report.matches))

    // "punto a punto" is a fixed expression; "Luca a fatto" is the real
    // mistake the a/ha rule exists for.
    const aha = needle => request => [matchOn(request.text, needle, { ruleId: 'ER_01_001', category: 'GRAMMAR' })].filter(Boolean)
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'una rappresentazione punto a punto della scena osservata' }],
        { ...it, fetchImpl: stubFetch(aha('a punto')) }
    )
    check('the X a X fixed expression does not trip the a/ha rule', report.matches.length === 0, JSON.stringify(report.matches))
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'alla fine Luca a fatto tutti i compiti richiesti' }],
        { ...it, fetchImpl: stubFetch(aha('a fatto')) }
    )
    check('a real a/ha mistake still comes through', report.matches.length === 1, JSON.stringify(report.matches))

    // \texttt carries identifiers: blanked, offsets preserved.
    stub = stubFetch(() => [])
    await LT.checkDocuments(
        [{ path: '/a.tex', text: 'si usa l\'ambiente \\texttt{lstlisting} in appendice' }],
        { ...it, fetchImpl: stub }
    )
    check(
        'the argument of \\texttt never reaches the proof-reader',
        stub.calls.length === 1 && !stub.calls[0].text.includes('lstlisting') && stub.calls[0].text.length === 'si usa l\'ambiente \\texttt{lstlisting} in appendice'.length,
        stub.calls[0] && stub.calls[0].text
    )

    // The excerpt marks the flagged span, so the reader sees WHICH word.
    stub = stubFetch(request => [matchOn(request.text, 'esperimeto')].filter(Boolean))
    report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'il primo esperimeto condotto in laboratorio riesce' }],
        { ...it, fetchImpl: stub }
    )
    check('the excerpt wraps the flagged span in « »', report.matches.length === 1 && /«esperimeto»/.test(report.matches[0].excerpt || ''), report.matches[0] && report.matches[0].excerpt)
}

{
    // A two-letter word now reaches the cross-check: "of" in a quoted English
    // title is absolved by the other dictionary, not reported.
    const stub = stubFetch((request, index) => {
        if (index === 0) return [matchOn(request.text, 'of')].filter(Boolean)
        return []
    })
    const report = await LT.checkDocuments(
        [{ path: '/a.tex', text: 'entrare con ``Login with University of Bologna\'\' e le credenziali' }],
        { language: 'it', url: URL_UNDER_TEST, fetchImpl: stub }
    )
    check(
        'a two-letter English word is absolved by the cross-check',
        report.matches.length === 0 && report.totals.droppedAsForeign >= 1,
        JSON.stringify(report.totals)
    )
}

{
    // The derived-word check, full flow: four words the Italian speller
    // rejects, of which one prefixed derivation, one hyphenated compound, one
    // fused English pair, and one REAL missing-space typo that must survive.
    const flagAll = (text, except) => {
        const out = []
        let offset = 0
        for (const line of text.split('\n')) {
            if (line && !except.has(line)) out.push(matchAt(offset, line.length))
            offset += line.length + 1
        }
        return out
    }
    const stub = stubFetch((request, index) => {
        if (index === 0) {
            return ['ricampionamento', 'keyframe', 'dellamassa', 'micro-camere']
                .map(w => matchOn(request.text, w))
                .filter(Boolean)
        }
        if (index === 1) return flagAll(request.text, new Set())
        if (index === 2) return flagAll(request.text, new Set(['campionamento', 'micro', 'camere', 'della', 'massa']))
        return flagAll(request.text, new Set(['key', 'frame']))
    })
    const text =
        'Il ricampionamento dei dati e il keyframe della scena mostrano la dellamassa e le micro-camere insieme.'
    const report = await LT.checkDocuments([{ path: '/a.tex', text }], {
        language: 'it',
        url: URL_UNDER_TEST,
        fetchImpl: stub,
    })
    check(
        'prefixed, hyphenated and fused-foreign words are absolved by their parts',
        report.totals.droppedAsCompound === 3,
        JSON.stringify(report.totals)
    )
    check(
        'a fused ITALIAN pair, the missing-space typo, survives the derived-word check',
        report.matches.length === 1 && /«dellamassa»/.test(report.matches[0].excerpt || ''),
        JSON.stringify(report.matches.map(m => m.excerpt))
    )
    check('the derived-word check costs exactly two extra calls', stub.calls.length === 4, `calls ${stub.calls.length}`)
}

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
