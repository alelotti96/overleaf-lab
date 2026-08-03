// The structural checks answer requirements that a parser can decide, so these tests
// ARE the evidence for those verdicts: where the model needs a gold set and a
// measured error rate, a parser needs a case that pins its answer. Every check gets
// a document that violates it, one that satisfies it, and one where the check does
// not apply, because "na" and "ok" mean different things and confusing them is the
// most damaging thing a compliance report can do.
//
// The suite is written as a MATRIX, not as a list of cases that happened to come to
// mind: for each check, the three statuses, then the LaTeX variants that decide
// whether the check reads a real document correctly, then a regression case for
// every defect that has actually shipped. A gap here is a verdict nobody verified.
import { pathToFileURL } from 'node:url'

const { CHECKS, runCheck, setChecksLanguage, openingHeadingsFact } = await import(pathToFileURL(process.env.CHECKS).href)
const R = String.raw

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}
const doc = text => [{ path: '/thesis.tex', text }]
const run = (name, text) => runCheck(name, doc(text))
const status = (name, text) => run(name, text).status

// ===========================================================================
// an unknown name must be loud
// ===========================================================================
// A typo must be loud: answering "ok" would report a requirement nothing looked at.
check('unknown check is na, not ok', run('float-captionx', 'x').status === 'na')
check('unknown check names the catalogue', /Available:/.test(run('float-captionx', 'x').evidence))

// ===========================================================================
// float-caption
// ===========================================================================
check('a float without caption is missing', status('float-caption', R`\begin{figure}\includegraphics{a}\end{figure}`) === 'missing')
check(
    'a float with caption is ok',
    status('float-caption', R`\begin{figure}\includegraphics{a}\caption{A caption}\end{figure}`) === 'ok'
)
check('no floats at all is na, not ok', status('float-caption', 'plain text only') === 'na')
{
    // A float nested inside another must not close its parent early.
    const r = run(
        'float-caption',
        R`\begin{figure}\begin{figure}\caption{inner}\end{figure}\caption{outer}\end{figure}`
    )
    check('nested floats are counted separately', r.status === 'ok', r.evidence)
}
check(
    'a starred float is seen',
    status('float-caption', R`\begin{figure*}\includegraphics{a}\end{figure*}`) === 'missing'
)
check(
    // Typing \end{figure} under \begin{figure*} is a compile error the student fixes in
    // seconds, but the review reads the source, not the PDF, and the source is in that
    // state for as long as they are editing. Refusing to pair the two would leave the
    // float open, swallow the rest of the file into it, and report a caption that is
    // right there as missing.
    'a starred float closed without its star is still one float',
    status('float-caption', R`\begin{figure*}\includegraphics{a}\caption{C}\end{figure}`) === 'ok',
    run('float-caption', R`\begin{figure*}\includegraphics{a}\caption{C}\end{figure}`).evidence
)
check(
    'a caption with an optional short form counts',
    status('float-caption', R`\begin{figure}\includegraphics{a}\caption[short]{the long form}\end{figure}`) === 'ok'
)
check(
    // longtable is deliberately absent: a longtable with no caption is exempt, see the
    // regression block below.
    'every float kind that must carry a caption is covered',
    ['figure', 'table', 'sidewaysfigure', 'sidewaystable'].every(
        env => status('float-caption', `\\begin{${env}}x\\end{${env}}`) === 'missing'
    )
)
{
    // REGRESSION: a longtable is how a multi-page list is typeset. On three real
    // projects the list of symbols in the front matter was a longtable under a chapter
    // heading, with no caption because the heading already names it, and the check
    // reported "table with no \caption" - a correction that would make the document
    // worse.
    const lt = R`\begin{longtable}{ll}$g$ & gravity \\ $m$ & mass \\ \end{longtable}`
    const r = run('float-caption', lt)
    check('a captionless longtable is not a defect', r.status === 'na', r.evidence)
    // and it is not counted either, or "All N floats carry a \caption" would count an
    // environment the check never asked anything of
    const withFigure = run('float-caption', lt + R`\begin{figure}\includegraphics{a}\caption{C}\end{figure}`)
    check('and it is left out of the total', /All 1 float/.test(withFigure.evidence), withFigure.evidence)
    // a captionless FIGURE beside it is still reported
    const withBadFigure = run('float-caption', lt + R`\begin{figure}\includegraphics{a}\end{figure}`)
    check('a captionless figure beside it is still reported', withBadFigure.status === 'missing', withBadFigure.evidence)
    check('and the longtable is not in the count', /1 of 1 /.test(withBadFigure.evidence), withBadFigure.evidence)
    // a longtable that DOES carry a caption is an ordinary captioned float
    const captioned = run(
        'float-caption',
        R`\begin{longtable}{ll}\caption{Simboli}\\ $g$ & gravity \\ \end{longtable}`
    )
    check('a captioned longtable is counted like any float', /All 1 float/.test(captioned.evidence), captioned.evidence)
    // an unclosed longtable is a broken document, not a front-matter list
    const unclosed = run('float-caption', R`\begin{longtable}{ll}$g$ & gravity \\`)
    check('an unclosed longtable is still reported', unclosed.status === 'missing', unclosed.evidence)
}
{
    // REGRESSION: an environment with no \end used to be stretched to the end of the
    // file, so it inherited the \caption of a later float and answered "ok" for a
    // float that has none. Two fabricated passes out of two.
    const r = run(
        'float-caption',
        R`\begin{figure}\includegraphics{a}` + '\n\ntext\n\n' + R`\begin{table}\caption{T}\end{table}`
    )
    check('an unclosed float is reported, not absorbed', r.status === 'missing', r.evidence)
    check('and it is named as unclosed', /never closed/.test(r.evidence), r.evidence)
}
{
    // REGRESSION: a caption does not have to be written \caption{}. \caption*{} is the
    // unnumbered form (a departmental logo, a decorative plate) and \captionof{figure}{}
    // is what the caption package asks for; both were reported as "figure with no
    // \caption" on documents that carry one under the reader's eyes.
    const starred = run('float-caption', R`\begin{figure}\includegraphics{a}\caption*{Logo del dipartimento}\end{figure}`)
    check('an unnumbered \\caption* is a caption', starred.status === 'ok', starred.evidence)
    const ofFigure = run('float-caption', R`\begin{figure}\includegraphics{a}\captionof{figure}{Vista laterale}\end{figure}`)
    check('\\captionof counts as a caption', ofFigure.status === 'ok', ofFigure.evidence)
    const ofTable = run(
        'float-caption',
        R`\begin{table}\captionof{table}{Masse}\begin{tabular}{c}a\end{tabular}\end{table}`
    )
    check('and so does \\captionof{table}', ofTable.status === 'ok', ofTable.evidence)
}
{
    // REGRESSION: the captions of two subfigures satisfied the figure AROUND them, so a
    // float with no caption of its own came back "All 1 float environments carry a
    // \caption" - a pass built on somebody else's caption.
    const subs =
        R`\begin{figure}\centering` +
        R`\begin{subfigure}{0.45\textwidth}\includegraphics{a}\caption{Vista frontale}\end{subfigure}` +
        R`\begin{subfigure}{0.45\textwidth}\includegraphics{b}\caption{Vista laterale}\end{subfigure}` +
        R`\end{figure}`
    const r = run('float-caption', subs)
    check('subcaptions do not caption the float around them', r.status === 'missing', r.evidence)
    // and the ordinary shape - subfigures plus a caption of the float - is still ok
    const withOwn = run('float-caption', subs.replace(R`\end{figure}`, R`\caption{Il modello}\end{figure}`))
    check('a float that does carry its own caption is ok', withOwn.status === 'ok', withOwn.evidence)
}
{
    // REGRESSION: \begin{comment} and \iffalse are how a LaTeX writer parks a draft
    // without deleting it. Neither is typeset, so neither is in the PDF the reader
    // marks, and reading them as live text reported a captionless figure the reader
    // never sees. Line comments were already stripped upstream; these are the same
    // thing written a different way.
    const commented =
        R`\begin{comment}` + '\n' + R`\begin{figure}\includegraphics{a}\end{figure}` + '\n' + R`\end{comment}` +
        '\n' + R`\begin{figure}\includegraphics{b}\caption{Una vera}\end{figure}`
    const r = run('float-caption', commented)
    check('a figure inside a comment environment is not judged', r.status === 'ok', r.evidence)
    check('and the real one beside it still is', /All 1 float/.test(r.evidence), r.evidence)
    const disabled =
        R`\iffalse` + '\n' + R`\begin{figure}\includegraphics{a}\end{figure}` + '\n' + R`\fi` +
        '\n' + R`\begin{figure}\includegraphics{b}\caption{Una vera}\end{figure}`
    const d = run('float-caption', disabled)
    check('a figure disabled with \\iffalse is not judged', d.status === 'ok', d.evidence)
    // an \else switches the text back ON: what follows it is typeset and must be read
    const withElse =
        R`\iffalse` + '\n' + R`\begin{figure}\includegraphics{a}\end{figure}` + '\n' + R`\else` + '\n' +
        R`\begin{figure}\includegraphics{b}\end{figure}` + '\n' + R`\fi`
    check('but the \\else branch is live text', run('float-caption', withElse).status === 'missing')
    // an \iffalse nobody closes blanks nothing: hiding the rest of the file from every
    // check is the wrong side to err on
    const unclosed = R`\iffalse` + '\n' + R`\begin{figure}\includegraphics{a}\end{figure}`
    check('an unclosed \\iffalse hides nothing', run('float-caption', unclosed).status === 'missing')
}

{
    // REGRESSION: TeX allows whitespace between \begin and its argument, and between
    // a command and its brace. `\begin {figure}` is legal, compiles, and was invisible
    // to every environment scan: the float was not seen at all, so a missing caption
    // came back "na - no figure environments" instead of missing.
    const spaced = run('float-caption', R`\begin {figure}\includegraphics{a}\end {figure}`)
    check('a space after \\begin does not hide the float', spaced.status === 'missing', spaced.evidence)
    const good = run('float-caption', R`\begin {figure}\includegraphics{a}\caption{C}\end {figure}`)
    check('and the captioned twin still passes', good.status === 'ok', good.evidence)
}

// ===========================================================================
// caption-position
// ===========================================================================
check(
    'a figure caption above the graphic is missing',
    status('caption-position', R`\begin{figure}\caption{C}\includegraphics{a}\end{figure}`) === 'missing'
)
check(
    'a figure caption below the graphic is ok',
    status('caption-position', R`\begin{figure}\includegraphics{a}\caption{C}\end{figure}`) === 'ok'
)
check(
    'a table caption above the content is ok',
    status('caption-position', R`\begin{table}\caption{C}\begin{tabular}{c}a\end{tabular}\end{table}`) === 'ok'
)
check(
    'a table caption below the content is missing',
    status('caption-position', R`\begin{table}\begin{tabular}{c}a\end{tabular}\caption{C}\end{table}`) === 'missing'
)
check(
    'a tikz picture counts as the graphic',
    status('caption-position', R`\begin{figure}\caption{C}\begin{tikzpicture}\end{tikzpicture}\end{figure}`) === 'missing'
)
check('a float with no caption at all is na here', status('caption-position', R`\begin{figure}\includegraphics{a}\end{figure}`) === 'na')
{
    // REGRESSION: the longtable package REQUIRES the caption right after
    // \begin{longtable}, and that \begin is the only content anchor a table check has,
    // so a caption written exactly where the package demands read as "below the
    // content" every time. Caught on a symbols list that was correct.
    const lt =
        R`\begin{longtable}{ll}\caption{Correct by the package's rules}\\` +
        '\n' +
        R`\toprule a & b \\ \end{longtable}`
    check('a longtable caption is not judged', status('caption-position', lt) === 'na', run('caption-position', lt).evidence)
    // and a real table beside it is still judged
    const both = lt + R`\begin{table}\begin{tabular}{c}a\end{tabular}\caption{C}\end{table}`
    check('a real table beside it is still judged', status('caption-position', both) === 'missing')
    // The float-caption exemption (a captionless longtable is layout, not a defect)
    // stops at float-caption: a captioned longtable still arrives here and is declined
    // for the package reason above, and a well-placed table beside one is still ok.
    const good = lt + R`\begin{table}\caption{C}\begin{tabular}{c}a\end{tabular}\end{table}`
    check('a captioned longtable does not disturb the table beside it', status('caption-position', good) === 'ok')
    const captionless = R`\begin{longtable}{ll}$g$ & gravity \\ \end{longtable}`
    check('a captionless longtable is na here too', status('caption-position', captionless) === 'na')
}
{
    // REGRESSION: a float whose content the check cannot find was skipped but still
    // counted, so the answer read "All 1 captions are on the expected side" after
    // inspecting exactly zero of them.
    const r = run('caption-position', R`\begin{figure}\caption{C}\input{plot.pgf}\end{figure}`)
    check('a float with no recognisable content is na, not ok', r.status === 'na', r.evidence)

    const mixed = run(
        'caption-position',
        R`\begin{figure}\includegraphics{a}\caption{C}\end{figure}` +
            R`\begin{figure}\caption{D}\input{p.pgf}\end{figure}`
    )
    check('a mixed document counts only what it inspected', /All 1 captions/.test(mixed.evidence), mixed.evidence)
    check('and says what it could not place', /could not be placed/.test(mixed.evidence), mixed.evidence)
}

// ===========================================================================
// float-referenced
// ===========================================================================
check(
    'a labelled float never referenced is missing',
    status('float-referenced', R`\begin{figure}\caption{C}\label{fig:a}\end{figure}`) === 'missing'
)
check(
    'a referenced float is ok',
    status('float-referenced', R`\begin{figure}\caption{C}\label{fig:a}\end{figure} see Figure \ref{fig:a}`) === 'ok'
)
check(
    'cleveref counts as a reference',
    status('float-referenced', R`\begin{figure}\caption{C}\label{fig:a}\end{figure} \cref{fig:a}`) === 'ok'
)
check(
    'autoref and eqref count too',
    status('float-referenced', R`\begin{table}\caption{C}\label{t:a}\end{table} \autoref{t:a}`) === 'ok' &&
        status('float-referenced', R`\begin{figure}\caption{C}\label{f:b}\end{figure} \eqref{f:b}`) === 'ok'
)
check(
    'a multiple reference counts for each label',
    status(
        'float-referenced',
        R`\begin{figure}\caption{C}\label{fig:a}\end{figure}\begin{figure}\caption{D}\label{fig:b}\end{figure} \ref{fig:a,fig:b}`
    ) === 'ok'
)
check(
    'a starred reference counts',
    status('float-referenced', R`\begin{figure}\caption{C}\label{f:a}\end{figure} \cref*{f:a}`) === 'ok'
)
check(
    'refstepcounter is not a reference',
    status('float-referenced', R`\begin{figure}\caption{C}\label{f:a}\end{figure} \refstepcounter{f:a}`) === 'missing'
)
check('no labels at all is na', status('float-referenced', R`\begin{figure}\caption{C}\end{figure}`) === 'na')
{
    // REGRESSION: `\ref {fig:a}` with a space before the brace is legal TeX and was
    // not read as a reference, so a float the text does call out was reported as
    // never referenced - a correction on a document that is right.
    const spaced = run('float-referenced', R`\begin{figure}\caption{C}\label{fig:a}\end{figure} vedi \ref {fig:a}`)
    check('a spaced \\ref still references the float', spaced.status === 'ok', spaced.evidence)
}
{
    // REGRESSION: a thesis that wraps its references in a macro of its own -
    // `\newcommand{\vedifig}[1]{Figura~\ref{#1}}` - references floats through a
    // command no `[a-zA-Z]*ref` pattern will ever see. Every float called out that
    // way was reported as never referenced. The wrapper is LEARNED from its
    // definition: a one-argument \newcommand whose body passes #1 to a \ref.
    const wrapped = [
        { path: '/setup.tex', text: R`\newcommand{\vedifig}[1]{Figura~\ref{#1}}` },
        { path: '/c1.tex', text: R`\begin{figure}\caption{C}\label{fig:a}\end{figure} Come da \vedifig{fig:a}.` },
    ]
    check('a float referenced through a wrapper macro is referenced', runCheck('float-referenced', wrapped).status === 'ok', runCheck('float-referenced', wrapped).evidence)
    // a wrapper that prepends a prefix inside the \ref names the label with it
    const prefixed = [
        { path: '/setup.tex', text: R`\newcommand{\figref}[1]{Figura~\ref{fig:#1}}` },
        { path: '/c1.tex', text: R`\begin{figure}\caption{C}\label{fig:orbit}\end{figure} Come da \figref{orbit}.` },
    ]
    check('a prefixing wrapper resolves against the full label', runCheck('float-referenced', prefixed).status === 'ok', runCheck('float-referenced', prefixed).evidence)
    // and crossrefs-resolve sees through the same wrapper, in both directions
    const dangling = [
        { path: '/setup.tex', text: R`\newcommand{\vedifig}[1]{Figura~\ref{#1}}` },
        { path: '/c1.tex', text: R`\begin{figure}\caption{C}\label{fig:a}\end{figure} Come da \vedifig{fig:ghost}.` },
    ]
    check('a wrapper pointing nowhere is a dangling reference', runCheck('crossrefs-resolve', dangling).status === 'missing', runCheck('crossrefs-resolve', dangling).evidence)
    // a macro that does not pass its argument to a \ref teaches nothing
    const unrelated = [
        { path: '/setup.tex', text: R`\newcommand{\vedifig}[1]{la figura #1 della serie}` },
        { path: '/c1.tex', text: R`\begin{figure}\caption{C}\label{fig:a}\end{figure} Come da \vedifig{3}.` },
    ]
    check('an ordinary macro is not learned as a reference', runCheck('float-referenced', unrelated).status === 'missing', runCheck('float-referenced', unrelated).evidence)
}
{
    // Coverage has to be stated: a float with no \label cannot be referenced by any
    // means, so it is outside what this check decides and the reader must be told.
    const r = run(
        'float-referenced',
        R`\begin{figure}\caption{A}\label{f:a}\end{figure}\ref{f:a}` + R`\begin{figure}\caption{B}\end{figure}`
    )
    check('an ok says how many floats it could not judge', r.status === 'ok' && /carries no \\label/.test(r.evidence), r.evidence)
}

// ===========================================================================
// numbered-equations
// ===========================================================================
check('equation* is missing', status('numbered-equations', R`\begin{equation*}x\end{equation*}`) === 'missing')
check('equation is ok', status('numbered-equations', R`\begin{equation}x\end{equation}`) === 'ok')
check('display brackets are missing', status('numbered-equations', R`text \[ x = 1 \] text`) === 'missing')
check(
    'every starred maths environment is caught',
    ['equation', 'align', 'gather', 'multline', 'flalign', 'eqnarray'].every(
        env => status('numbered-equations', `\\begin{${env}*}x\\end{${env}*}`) === 'missing'
    )
)
{
    // \\[ is a line break with extra spacing inside a table, not display maths.
    const r = run('numbered-equations', R`row one \\[2mm] row two ` + R`\begin{equation}x\end{equation}`)
    check('a line break with spacing is not display maths', r.status === 'ok', r.evidence)
}
check('no equations is na', status('numbered-equations', 'plain text only') === 'na')
{
    // REGRESSION: plain-TeX display maths was invisible, so a thesis that writes every
    // formula as $$...$$ came back "na, no display equations": the check announced
    // that there was nothing to look at for a document where nothing is numbered.
    const r = run('numbered-equations', 'text $$ x = 1 $$ text')
    check('$$ display maths is missing, not na', r.status === 'missing', r.evidence)
    check('displaymath is missing, not na', status('numbered-equations', R`\begin{displaymath}x\end{displaymath}`) === 'missing')
    check('two $$ blocks count as two', /2 of 2/.test(run('numbered-equations', 'a $$x$$ b $$y$$ c').evidence))
    check('inline maths is not display maths', status('numbered-equations', 'il valore $x = 1$ e noto') === 'na')
    check(
        'an escaped dollar is not display maths',
        status('numbered-equations', R`costa 5\$\$ in tutto`) === 'na'
    )
}
{
    // REGRESSION: same root cause as the commented-out figure. An equation* parked
    // inside \begin{comment} is not typeset and cannot be numbered or unnumbered.
    const r = run(
        'numbered-equations',
        R`\begin{comment}\begin{equation*}x\end{equation*}\end{comment}` +
            R`\begin{equation}y\end{equation}`
    )
    check('an equation inside a comment environment is not judged', r.status === 'ok', r.evidence)
    check('and the live one beside it is', /All 1 display/.test(r.evidence), r.evidence)
}

// ===========================================================================
// acronym-first-use
// ===========================================================================
const DECL = R`\acro{ADCS}{Attitude Determination and Control System}\acro{LEO}{Low Earth Orbit}`
{
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: 'The ADCS handles attitude control.' },
    ]
    const r = runCheck('acronym-first-use', docs)
    check('a bare short form before its expansion is missing', r.status === 'missing', r.evidence)
    check('the finding points at the file that uses it', r.locations[0]?.path === '/chapter1.tex')
}
{
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: 'Attitude Determination and Control System (ADCS) handles attitude control.' },
    ]
    check('the expansion just before the short form is ok', runCheck('acronym-first-use', docs).status === 'ok')
}
{
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: R`The \acf{ADCS} runs the loop, then \acs{ADCS} again.` },
    ]
    // \acf expands by itself, so the package already guarantees the first use.
    check('a self-expanding macro is ok', runCheck('acronym-first-use', docs).status === 'ok')
}
check('no declared acronyms is na', status('acronym-first-use', 'text') === 'na')
{
    const docs = [{ path: '/acronyms.tex', text: DECL }]
    check('declared but never used is na, not ok', runCheck('acronym-first-use', docs).status === 'na')
}
{
    // The glossaries package declares the same thing with another command.
    const docs = [
        { path: '/acronyms.tex', text: R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}` },
        { path: '/chapter1.tex', text: 'The ADCS handles attitude control.' },
    ]
    check('glossaries declarations are read too', runCheck('acronym-first-use', docs).status === 'missing')
}
{
    // REGRESSION: the short form was compiled straight into a RegExp, so a single
    // acronym containing a metacharacter threw and the WHOLE requirement degraded to
    // n.a. - an exact check silently stopped answering because of one list entry.
    const docs = [
        { path: '/acronyms.tex', text: R`\acro{C++}{C Plus Plus}` + DECL },
        { path: '/chapter1.tex', text: 'The ADCS handles attitude control.' },
    ]
    const r = runCheck('acronym-first-use', docs)
    check('an acronym with regex metacharacters does not kill the check', r.status === 'missing', r.evidence)
    check('and the check does not report a crash', !/failed/.test(r.evidence), r.evidence)
}
{
    // REGRESSION: skipping the declaring FILE dropped every chapter that declares an
    // acronym where it first appears, which the glossaries manual itself shows.
    const docs = [
        {
            path: '/chapter1.tex',
            text: R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}` + '\nThe ADCS handles attitude control.',
        },
    ]
    const r = runCheck('acronym-first-use', docs)
    check('a chapter that declares inline is still scanned', r.status === 'missing', r.evidence)
    check('and the line is the line of the real source', r.locations[0]?.line === 2, JSON.stringify(r.locations))
}
{
    // REGRESSION: the width key of the acronym environment is, by the package's own
    // convention, the LONGEST acronym in the list, so it is usually a real declared
    // acronym. Blanking only the \acro lines left `\begin{acronym}[ADCS]` standing as
    // the earliest "use" of ADCS, and every correctly written thesis using that idiom
    // was told its acronym was used before being spelled out, at line 1 of the list.
    const list =
        R`\begin{acronym}[ADCS]` +
        '\n' +
        R`\acro{ADCS}{Attitude Determination and Control System}` +
        '\n' +
        R`\end{acronym}`
    const docs = [
        { path: '/acronyms.tex', text: list },
        { path: '/chapter1.tex', text: 'Attitude Determination and Control System (ADCS) handles attitude control.' },
    ]
    const r = runCheck('acronym-first-use', docs)
    check('the list width key is not a use of the acronym', r.status === 'ok', r.evidence)

    // and the check still works when that key is the package's placeholder
    const docs2 = [
        { path: '/acronyms.tex', text: list.replace('[ADCS]', '[WYSIWYM]') },
        { path: '/chapter1.tex', text: 'The ADCS handles attitude control.' },
    ]
    check('a real violation is still caught inside a list', runCheck('acronym-first-use', docs2).status === 'missing')
}
{
    // REGRESSION: the letters of an acronym inside maths are a symbol name, not a use
    // of the acronym in the text. A symbols list naming $x_{RMS}$ and $\mathbf{A}_{ECI}$
    // was reported as using both before spelling them out, which the author cannot fix:
    // the subscript has to say RMS.
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/symbols.tex', text: R`$x_{ADCS}$ is a symbol and $\mathbf{v}_{LEO}$ another one.` },
    ]
    check('a subscript is not a use of the acronym', runCheck('acronym-first-use', docs).status === 'na', runCheck('acronym-first-use', docs).evidence)
    const display = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/c1.tex', text: R`\begin{equation}J_{ADCS} = 1\end{equation}` },
    ]
    check('and neither is a display equation', runCheck('acronym-first-use', display).status === 'na')
    // but the same acronym in prose beside the maths is still a use
    const mixed = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/c1.tex', text: R`The ADCS uses $x_{ADCS}$ as its state.` },
    ]
    check('prose beside maths is still judged', runCheck('acronym-first-use', mixed).status === 'missing')
}
{
    // The expansion has to be NEAR the first use, not anywhere in the file.
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: 'Attitude Determination and Control System. ' + 'x'.repeat(500) + ' Poi ADCS.' },
    ]
    check('an expansion far away does not count', runCheck('acronym-first-use', docs).status === 'missing')
}
{
    // REGRESSION: the check started from the DECLARED list, so a thesis that declares
    // two acronyms and then writes JAXA, GPU and FPS bare through five chapters was
    // told all its acronyms were fine. The defect was invisible because the author had
    // written it down nowhere, which is the harder case for a reader, not the easier.
    const docs = [
        { path: '/chapter1.tex', text: 'The launch is run by JAXA.' },
        { path: '/chapter2.tex', text: 'JAXA provided the bus.\nLater JAXA confirmed the schedule.' },
    ]
    const r = runCheck('acronym-first-use', docs)
    check('an undeclared acronym used three times is reported', r.status === 'missing', r.evidence)
    check('and it is named', /JAXA/.test(r.evidence), r.evidence)
    check('at the file and line of its FIRST use', r.locations[0]?.path === '/chapter1.tex' && r.locations[0]?.line === 1, JSON.stringify(r.locations))

    // used twice only: a passing mention, not a short form the text leans on
    const twice = [{ path: '/c.tex', text: 'The JAXA launch.\nJAXA again.' }]
    check('an undeclared token used twice is not reported', runCheck('acronym-first-use', twice).status === 'na', runCheck('acronym-first-use', twice).evidence)

    // spelled out at its first use, in the prose, with no acronym list at all
    const expanded = [
        {
            path: '/c.tex',
            text: 'The Japan Aerospace Exploration Agency (JAXA) runs it.\nJAXA provided the bus.\nJAXA confirmed.',
        },
    ]
    check('a parenthetical expansion at first use is enough', runCheck('acronym-first-use', expanded).status === 'na', runCheck('acronym-first-use', expanded).evidence)
    const other = [
        {
            path: '/c.tex',
            text: 'The JAXA (Japan Aerospace Exploration Agency) runs it.\nJAXA provided the bus.\nJAXA confirmed.',
        },
    ]
    check('and so is the expansion written after it', runCheck('acronym-first-use', other).status === 'na')

    // ADJUDICATED LESSON (122 hand-judged findings): an acronym the author DOES spell
    // out, only later than its first use, is a different and milder defect than one
    // never expanded anywhere, and "never spelled out" is false for the former. The
    // scan reads every use, so the evidence must say which of the two cases it found.
    check('the never-expanded case says so', /never spelled out and never declared/.test(r.evidence), r.evidence)
    const late = [
        { path: '/c1.tex', text: 'The FGS acquires the target.\nThe FGS locks on the star.' },
        { path: '/c2.tex', text: 'The Fine Guidance Sensor (FGS) is described here.\nThe FGS output feeds the loop.' },
    ]
    const lateRun = runCheck('acronym-first-use', late)
    check('a late expansion is still a finding', lateRun.status === 'missing', lateRun.evidence)
    check(
        'worded as spelled out only later, with where',
        /spelled out only later \(\/c2\.tex, line 1\)/.test(lateRun.evidence),
        lateRun.evidence
    )
    check('and never as "never spelled out"', !/never spelled out/.test(lateRun.evidence), lateRun.evidence)
    check(
        'still located at the first use',
        lateRun.locations[0]?.path === '/c1.tex' && lateRun.locations[0]?.line === 1,
        JSON.stringify(lateRun.locations)
    )
    // The list-membership check is about the LIST: a late expansion in the prose does
    // not put the token in the list, so it must stay reported there, and its wording
    // ("not in the list") makes no "never expanded" claim to soften.
    const lateListed = [
        { path: '/acronyms.tex', text: R`\acro{ADCS}{Attitude Determination and Control System}` },
        ...late,
    ]
    const listRun = runCheck('acronyms-missing-from-list', lateListed)
    check(
        'a late-expanded token is still missing from the list',
        listRun.status === 'missing' && /FGS/.test(listRun.evidence),
        listRun.evidence
    )

    // a DECLARED and expanded acronym is not reported twice over
    const declaredToo = [
        { path: '/acronyms.tex', text: R`\acro{NASA}{National Aeronautics and Space Administration}` },
        {
            path: '/c.tex',
            text: 'The National Aeronautics and Space Administration (NASA) leads.\nNASA built it.\nNASA flew it.',
        },
    ]
    check('a declared and expanded acronym is still ok', runCheck('acronym-first-use', declaredToo).status === 'ok', runCheck('acronym-first-use', declaredToo).evidence)

    // Roman numerals are not short forms of anything
    const roman = [{ path: '/c.tex', text: 'La Guerra Mondiale II.\nDopo la II guerra.\nNella Parte II del testo.' }]
    check('a Roman numeral is not an acronym', runCheck('acronym-first-use', roman).status === 'na', runCheck('acronym-first-use', roman).evidence)

    // identifiers are not prose: a citation key or a file name is never read aloud
    const keys = [
        {
            path: '/c.tex',
            text: R`Vedi \cite{ESA2020} e \cite{ESA2020} e \cite{ESA2020} in \includegraphics{IMG}{IMG}{IMG}`,
        },
    ]
    check('a citation key is not an acronym', runCheck('acronym-first-use', keys).status === 'na', runCheck('acronym-first-use', keys).evidence)

    // the count is honest: two undeclared acronyms, two findings
    const two = [
        { path: '/c.tex', text: 'GPU load and FPS rate.\nThe GPU is idle while FPS drops.\nGPU and FPS again.' },
    ]
    const r2 = runCheck('acronym-first-use', two)
    check('two undeclared acronyms give two findings', /2 of 2 /.test(r2.evidence), r2.evidence)

    // A unit symbol is not a short form: "16 GB of memory" is a measurement, and
    // asking the author to spell GB out is the false correction the unit lexicon
    // exists to prevent. The acronym beside it is still reported.
    const units = [
        {
            path: '/c.tex',
            text: [
                'Il modello occupa 16 GB di memoria e la GPU satura.',
                'Con 8 GB il batch cala e la GPU resta ferma.',
                'Servono almeno 4 GB liberi mentre la GPU lavora.',
            ].join('\n'),
        },
    ]
    const r3 = runCheck('acronym-first-use', units)
    check('a unit symbol is not reported as an acronym', !/GB/.test(r3.evidence), r3.evidence)
    check('and the real acronym beside it still is', /GPU/.test(r3.evidence) && /1 of 1 /.test(r3.evidence), r3.evidence)
}
{
    // REGRESSION: a .bib is DATA. This check built its scan from every doc instead of
    // from sources(), so the undeclared scan walked the bibliography database and told
    // the student, at /refs.bib:1, to spell out "BOOK" - the entry type of an
    // IEEE-Xplore export - and "IEEE", the journal name. Three @BOOK entries were
    // enough, and a [check:] verdict is never re-judged by a model.
    const withBib = [
        { path: '/c1.tex', text: "Il controllo d'assetto segue l'approccio classico." },
        {
            path: '/refs.bib',
            text: [
                '@BOOK{a, author={A}, title={T}, publisher={P}, year={2019}}',
                '@BOOK{b, author={B}, title={T}, publisher={P}, year={2020}}',
                '@article{c, author={C}, title={T}, journal={IEEE Transactions on Aerospace}, year={2021}}',
                '@article{d, author={D}, title={T}, journal={IEEE Transactions on Control}, year={2022}}',
                '@inproceedings{e, author={E}, title={T}, booktitle={IEEE Aerospace Conference}, year={2023}}',
            ].join('\n'),
        },
    ]
    const r = runCheck('acronym-first-use', withBib)
    check('the .bib is not read as prose', r.status === 'na', r.evidence)
    check('and no bibliography line is ever named', !/refs\.bib/.test(r.evidence), r.evidence)
}
{
    // REGRESSION: shapes that are not short forms, all from real thesis layout. Each
    // one was reported as an acronym the author had failed to spell out, which hands
    // them a correction that would make the text wrong.
    const capsRows = [
        {
            path: '/tabelle.tex',
            text: [
                R`\begin{table}\begin{tabular}{lll}`, R`NOME & TIPO & UNITA \\`, R`\end{tabular}\end{table}`,
                R`\begin{table}\begin{tabular}{lll}`, R`NOME & TIPO & UNITA \\`, R`\end{tabular}\end{table}`,
                R`\begin{table}\begin{tabular}{lll}`, R`NOME & TIPO & UNITA \\`, R`\end{tabular}\end{table}`,
            ].join('\n'),
        },
    ]
    check('a repeated all-caps header row is not an acronym', runCheck('acronym-first-use', capsRows).status === 'na', runCheck('acronym-first-use', capsRows).evidence)
    const titlePage = [
        {
            path: '/frontespizio.tex',
            text: [
                R`\begin{titlepage}`,
                'UNIVERSITA DEGLI STUDI DI BOLOGNA',
                'SCUOLA DI INGEGNERIA E ARCHITETTURA',
                'CORSO DI LAUREA MAGISTRALE IN INGEGNERIA AEROSPAZIALE',
                'TESI DI LAUREA IN MECCANICA DEL VOLO',
                R`\end{titlepage}`,
                'Il lavoro descrive il progetto preliminare di un velivolo.',
            ].join('\n'),
        },
    ]
    check('an all-caps title page is not a list of acronyms', runCheck('acronym-first-use', titlePage).status === 'na', runCheck('acronym-first-use', titlePage).evidence)
    const shouted = [{ path: '/c.tex', text: 'Il valore NON deve superare la soglia. NON e ammesso. Qui NON si applica.' }]
    check('a word shouted in capitals is not an acronym', runCheck('acronym-first-use', shouted).status === 'na', runCheck('acronym-first-use', shouted).evidence)
    const chemistry = [
        {
            path: '/c.tex',
            text:
                'La combustione produce CO2 e H2O.\nLa frazione di CO2 cresce con il rapporto di miscela.\n' +
                'Il modello considera CO2 e H2O come specie principali.',
        },
    ]
    check('a chemical formula is not an acronym', runCheck('acronym-first-use', chemistry).status === 'na', runCheck('acronym-first-use', chemistry).evidence)
    const tools = [
        {
            path: '/c.tex',
            text:
                'Le simulazioni sono svolte in MATLAB e in ANSYS.\nLo script MATLAB genera la mesh che ANSYS importa.\n' +
                'I risultati MATLAB e ANSYS coincidono. La scheda monta un STM32.\nIl firmware STM32 gira a 168 MHz.\nIl bus del STM32 e I2C.',
        },
    ]
    check('a product name or a part number is not an acronym', runCheck('acronym-first-use', tools).status === 'na', runCheck('acronym-first-use', tools).evidence)
    const compound = [
        {
            path: '/c.tex',
            text:
                'La telemetria usa il Transmission Control Protocol/Internet Protocol (TCP/IP).\n' +
                'Il TCP/IP e incapsulato nel frame.\nIl collegamento TCP/IP resta attivo.',
        },
    ]
    check('half of a slashed compound is not a token of its own', runCheck('acronym-first-use', compound).status === 'na', runCheck('acronym-first-use', compound).evidence)
    // the expansion is there, but the author put the short form in bold
    const bold = [
        {
            path: '/c.tex',
            text:
                R`La Japan Aerospace Exploration Agency (\textbf{JAXA}) ha lanciato la missione.` + '\n' +
                'La JAXA ha ripetuto la misura.\nIl contributo della JAXA e stato decisivo.',
        },
    ]
    check('an expansion in front of a bold short form counts', runCheck('acronym-first-use', bold).status === 'na', runCheck('acronym-first-use', bold).evidence)
    // and the control still holds: a bare short form used three times in prose
    const control = [{ path: '/c.tex', text: 'La sonda comunica con la stazione DSN.\nIl DSN riceve la telemetria.\nOgni passaggio DSN dura venti minuti.' }]
    check('a real undeclared acronym is still reported', runCheck('acronym-first-use', control).status === 'missing', runCheck('acronym-first-use', control).evidence)
}
{
    // REGRESSION: the window and the declared long form were compared as RAW text, so
    // an ordinary editor line wrap between "Attitude Determination and" and "Control
    // System (ADCS)" meant the expansion was never found. A five-word long form wraps
    // constantly, and the author was told to spell out what they had just spelled out.
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        {
            path: '/chapter1.tex',
            text:
                "Il sottosistema di controllo e l'Attitude Determination and\n" +
                'Control System (ADCS), che gestisce l\'assetto.\nIl ADCS usa tre ruote di reazione.',
        },
    ]
    const r = runCheck('acronym-first-use', docs)
    check('an expansion broken by a line wrap still counts', r.status === 'ok', r.evidence)
}
{
    // REGRESSION: glossaries declares \newacronym{adcs}{ADCS}{...} and the text writes
    // \gls{adcs} - the KEY, lowercase, nowhere near the letters ADCS. The check saw no
    // use at all and answered "1 acronyms are declared but none is used in the text",
    // which leaves the requirement UNANSWERED rather than answered wrongly. \gls of an
    // acronym entry prints the long form the first time, so the correct answer is ok.
    const docs = [
        { path: '/acronyms.tex', text: R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}` },
        { path: '/c1.tex', text: R`Il \gls{adcs} controlla l'assetto. Il \gls{adcs} usa tre ruote di reazione.` },
    ]
    const r = runCheck('acronym-first-use', docs)
    check('a glossaries key is a use of the acronym', r.status === 'ok', r.evidence)
    check('and the requirement is answered, not skipped', !/none is used/.test(r.evidence), r.evidence)
    // \acrshort prints the SHORT form, so it must still be preceded by the long one
    const short = [
        { path: '/acronyms.tex', text: R`\newacronym{leo}{LEO}{Low Earth Orbit}` },
        { path: '/c1.tex', text: R`Il satellite opera in \acrshort{leo} per tutta la missione.` },
    ]
    check('but \\acrshort does not spell it out by itself', runCheck('acronym-first-use', short).status === 'missing', runCheck('acronym-first-use', short).evidence)
}

{
    // REGRESSION: the first-use window compared the prose against the declared long
    // form LETTER BY LETTER, so an author who expanded with slightly different words
    // ("...Control System" where the list says "...Control Subsystem"), or with the
    // Italian convention "(Long Form, SIGLA)", was accused of not expanding. Measured
    // on two clean synthetic theses: 10 acronyms flagged, all expanded in the prose.
    const subsystem = [
        { path: '/acronyms.tex', text: R`\acro{ADCS}{Attitude Determination and Control Subsystem}` },
        {
            path: '/c1.tex',
            text: "Il sistema di assetto (Attitude Determination and Control System, ADCS) governa la missione.",
        },
    ]
    const r = runCheck('acronym-first-use', subsystem)
    check('the Italian convention "(Long Form, SIGLA)" counts as an expansion', r.status === 'ok', r.evidence)
    // the classic "Long Form (SHORT)" with wording that differs from the list
    const classic = [
        { path: '/acronyms.tex', text: R`\acro{GPU}{Graphical Processing Unit}` },
        { path: '/c1.tex', text: 'La Graphics Processing Unit (GPU) elabora le immagini.' },
    ]
    check('the classic "Long Form (SHORT)" counts by initials too', runCheck('acronym-first-use', classic).status === 'ok', runCheck('acronym-first-use', classic).evidence)
    // minor words (of, and, to, di, e) may contribute their letter or not: both FOV
    // ("of" gives the O) and SNR ("to" gives nothing) must pass
    const minor = [
        { path: '/acronyms.tex', text: R`\acro{FOV}{Field of Vision}\acro{SNR}{Signal to Noise Ratio, rapporto segnale-rumore}` },
        {
            path: '/c1.tex',
            text: 'Il campo di vista (Field of View, FOV) e il rapporto (Signal-to-Noise Ratio, SNR) sono noti.',
        },
    ]
    check('minor words may lend their initial or stay silent', runCheck('acronym-first-use', minor).status === 'ok', runCheck('acronym-first-use', minor).evidence)
    // a bilingual list entry ("English Form, traduzione italiana") is matched by
    // SEGMENT: the prose may expand in either language
    const bilingual = [
        { path: '/acronyms.tex', text: R`\acro{ESA}{European Space Agency, Agenzia Spaziale Europea}` },
        { path: '/c1.tex', text: "L'Agenzia Spaziale Europea (ESA) finanzia lo studio." },
    ]
    check('a bilingual list entry matches on either segment', runCheck('acronym-first-use', bilingual).status === 'ok', runCheck('acronym-first-use', bilingual).evidence)
    // the guard holds: a parenthesis whose words do not spell the acronym is not an
    // expansion, and neither is an all-lowercase phrase that happens to align
    const wrong = [
        { path: '/acronyms.tex', text: R`\acro{ADCS}{Attitude Determination and Control Subsystem}` },
        { path: '/c1.tex', text: 'Il modulo (sistema di controllo remoto, ADCS) governa la missione.' },
    ]
    check('a parenthesis that does not spell the acronym is no expansion', runCheck('acronym-first-use', wrong).status === 'missing', runCheck('acronym-first-use', wrong).evidence)
    const lowercase = [
        { path: '/acronyms.tex', text: R`\acro{ADCS}{Attitude Determination and Control Subsystem}` },
        { path: '/c1.tex', text: 'Il modulo (alta determinazione con sensori, ADCS) governa la missione.' },
    ]
    check('an all-lowercase accidental alignment is no expansion either', runCheck('acronym-first-use', lowercase).status === 'missing', runCheck('acronym-first-use', lowercase).evidence)
}
{
    // REGRESSION: "first use" was decided by the order the files happened to arrive
    // in, which is alphabetical - so the APPENDIX was read before the chapters, and a
    // thesis that expands GPU in chapter 4 and then uses it in appendix A was told the
    // appendix use came first. The reader meets the chapter first: the scan now walks
    // the files in include order from the main file.
    const docs = [
        { path: '/Appendices/appendix.tex', text: 'La GPU esegue il codice riportato sotto.' },
        { path: '/acronyms.tex', text: R`\acro{GPU}{Graphics Processing Unit}` },
        {
            path: '/main.tex',
            text: R`\documentclass{book}\begin{document}\input{chapter1}\input{Appendices/appendix}\end{document}`,
        },
        { path: '/chapter1.tex', text: 'La Graphics Processing Unit (GPU) elabora le immagini. La GPU satura.' },
    ]
    const r = runCheck('acronym-first-use', docs)
    check('first use follows the include order, not the file order', r.status === 'ok', r.evidence)
}
{
    // REGRESSION: a chapter title is DISPLAY, not running prose. A thesis that titles
    // chapter 4 "PMP Formulation" and expands "Pontryagin Minimum Principle (PMP)" in
    // its first paragraph is standard practice, and it was accused twice for one
    // title: "PMP is used before being spelled out" here AND "PMP appears in the
    // chapter title" from acronyms-in-headings, which is the check that owns titles.
    const titled = [
        { path: '/acronyms.tex', text: R`\acro{PMP}{Pontryagin Minimum Principle}` },
        {
            path: '/c4.tex',
            text: R`\chapter{PMP Formulation of the Optimal Control Problem}` +
                '\nThe Pontryagin Minimum Principle (PMP) governs the solution. The PMP gives the control law.',
        },
    ]
    check('a title occurrence expanded in the first paragraph is not a first-use defect', runCheck('acronym-first-use', titled).status === 'ok', runCheck('acronym-first-use', titled).evidence)
    check('while the title itself stays a headings finding', runCheck('acronyms-in-headings', titled).status === 'missing', runCheck('acronyms-in-headings', titled).evidence)
    // the guard holds: a body that never expands is still accused, at the body use
    const bare = [
        { path: '/acronyms.tex', text: R`\acro{GTO}{Geostationary Transfer Orbit}` },
        { path: '/c1.tex', text: R`\chapter{GTO Injection}` + '\nThe GTO is reached after launch.' },
    ]
    const g = runCheck('acronym-first-use', bare)
    check('a title use does not shield a body that never expands', g.status === 'missing', g.evidence)
    check('and the finding points at the body line', g.locations[0]?.line === 2, JSON.stringify(g.locations))
}
{
    // REGRESSION: an undeclared acronym expanded at its first prose use is the author
    // doing right by first-use, but the TITLE that carries it is still a title with
    // an acronym in it. The headings check dropped it together with the first-use
    // scan, so "KKT problem creation" stopped being reported the moment the prose
    // expanded KKT - the two requirements are different questions.
    const docs = [
        {
            path: '/c1.tex',
            text: [
                R`\section{KKT problem}`,
                'The Karush-Kuhn-Tucker (KKT) conditions define the system.',
                'The KKT matrix is sparse. Solving KKT systems is the bottleneck.',
            ].join('\n'),
        },
    ]
    check('an expanded undeclared acronym still counts for headings', runCheck('acronyms-in-headings', docs).status === 'missing', runCheck('acronyms-in-headings', docs).evidence)
    check('while first-use honours the expansion', runCheck('acronym-first-use', docs).status === 'na', runCheck('acronym-first-use', docs).evidence)
}

// ===========================================================================
// acronyms-in-headings
// ===========================================================================
{
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: R`\chapter{The ADCS subsystem}` + '\ntext' },
    ]
    check('an acronym in a chapter title is missing', runCheck('acronyms-in-headings', docs).status === 'missing')
}
{
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: R`\chapter{The attitude control subsystem}` + '\ntext' },
    ]
    check('a clean title is ok', runCheck('acronyms-in-headings', docs).status === 'ok')
}
{
    // A word that merely contains the letters is not the acronym.
    const docs = [
        { path: '/acronyms.tex', text: R`\acro{OD}{Orbit Determination}` },
        { path: '/chapter1.tex', text: R`\chapter{Methods of ODious analysis}` + '\ntext' },
    ]
    check('a substring is not an acronym', runCheck('acronyms-in-headings', docs).status === 'ok')
}
{
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: R`\section[short]{Analysis in LEO}` + '\ntext' },
    ]
    check('an optional short title does not hide the heading', runCheck('acronyms-in-headings', docs).status === 'missing')
}
{
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: R`\subsection*{The LEO regime}` + '\ntext' },
    ]
    check('a starred heading is a heading', runCheck('acronyms-in-headings', docs).status === 'missing')
}
{
    // REGRESSION: same metacharacter crash as above, on the other check.
    const docs = [
        { path: '/acronyms.tex', text: R`\acro{C++}{C Plus Plus}` + DECL },
        { path: '/chapter1.tex', text: R`\chapter{The ADCS subsystem}` },
    ]
    const r = runCheck('acronyms-in-headings', docs)
    check('headings survive a metacharacter acronym', r.status === 'missing', r.evidence)
}
// The check now scans titles directly (see the fragment-corpus block below), so a
// document with headings and no acronym anywhere is a clean ANSWER, not a "cannot
// answer": ok, no longer na.
check('headings with no acronym anywhere are ok', status('acronyms-in-headings', R`\chapter{A title}`) === 'ok')
{
    // REGRESSION (fragment corpus): the most common shape of the defect was
    // invisible - a heading that carries a short form NOBODY ever declared and the
    // prose never uses three times ("Design del PCS" with PCS defined nowhere).
    // Measured: 0 of 20 labelled fragments caught. The title itself is now scanned
    // with the same candidate rules the prose scan uses.
    const bare = run(
        'acronyms-in-headings',
        R`\section{Design del PCS}` + '\nIl sottosistema di potenza alimenta il carico utile del satellite.'
    )
    check('an undeclared, unused acronym in a heading is caught', bare.status === 'missing' && /PCS/.test(bare.evidence), bare.evidence)
    // the guards of the prose scan hold here too
    check('a roman numeral in a title is not an acronym', status('acronyms-in-headings', R`\chapter{Parte II}` + '\nIl testo prosegue qui sotto.') === 'ok')
    check('a unit symbol in a title is not an acronym', status('acronyms-in-headings', R`\section{Memoria disponibile in GB}` + '\nIl testo prosegue.') === 'ok')
    check(
        'an all-caps styled title is not scanned for acronyms',
        status('acronyms-in-headings', R`\section{ANALISI DEI MODI DI VIBRAZIONE}` + '\nIl testo prosegue.') === 'ok',
        run('acronyms-in-headings', R`\section{ANALISI DEI MODI DI VIBRAZIONE}` + '\nIl testo prosegue.').evidence
    )
    check('a shouted function word is not an acronym', status('acronyms-in-headings', R`\section{Il valore NON ammesso}` + '\nIl testo prosegue.') === 'ok')
}

// ===========================================================================
// float-centered
// ===========================================================================
check(
    'a float with no \\centering is missing',
    status('float-centered', R`\begin{figure}\includegraphics{a}\caption{C}\end{figure}`) === 'missing'
)
check(
    'a centred float is ok',
    status('float-centered', R`\begin{figure}\centering\includegraphics{a}\caption{C}\end{figure}`) === 'ok'
)
check(
    'the center environment counts as centring',
    status('float-centered', R`\begin{figure}\begin{center}\includegraphics{a}\end{center}\caption{C}\end{figure}`) === 'ok'
)
check('wrapfigure is always a violation', status('float-centered', R`\begin{wrapfigure}{r}{4cm}x\end{wrapfigure}`) === 'missing')
{
    // REGRESSION: a longtable is not a float. It breaks across pages and centres
    // itself, so demanding \centering inside it reported a violation on a correct
    // document - caught on a real university template.
    const r = run('float-centered', R`\begin{longtable}{cc}a & b\end{longtable}`)
    check('a longtable is not asked for \\centering', r.status === 'na', r.evidence)
}

// ===========================================================================
// manual-numbering
// ===========================================================================
{
    // The check learns the document's own word for a numbered object by looking at
    // what precedes a \ref, so it works in any language without being told which.
    const italian =
        R`Figura \ref{a} e Figura \ref{b} e Figura \ref{c}. Come mostra la Figura 4, il valore cresce.`
    check('a hand-written number after a learned word is missing', status('manual-numbering', italian) === 'missing')
    const german = R`Abbildung \ref{a}, Abbildung \ref{b}. Siehe Abbildung 7 dazu.`
    check('the same works in another language', status('manual-numbering', german) === 'missing')
    check(
        'the same document written properly is ok',
        status('manual-numbering', R`Figura \ref{a} e Figura \ref{b} e poi Figura \ref{c}.`) === 'ok'
    )
    // One occurrence is not a convention, so nothing is LEARNED from it. The word
    // must sit outside the static vocabulary to prove that: "Tabella" is now always
    // checked (it names an object LaTeX numbers), so the learner is probed with a
    // word the static list does not carry.
    check(
        'a word used only once teaches nothing',
        status('manual-numbering', R`Grafico \ref{a}. Poi Grafico 3 qui.`) === 'ok',
        run('manual-numbering', R`Grafico \ref{a}. Poi Grafico 3 qui.`).evidence
    )
    // The static vocabulary works with NO \ref in the document at all: a thesis
    // written with \autoref never puts a word before a \ref, learned nothing, and
    // its "Il capitolo 2 descrive" sailed through. Caught on a real thesis.
    check(
        'a sectioning word is checked without any \\ref to learn from',
        status('manual-numbering', 'Il capitolo 2 descrive il metodo. Il capitolo 3 i risultati.') === 'missing'
    )
    check(
        'the hand-written number is quoted as written, tail included',
        /capitolo 2/.test(run('manual-numbering', 'Il capitolo 2.1 descrive il metodo.').evidence.replace('2.1', '2.1')) &&
            /"[Ii]l capitolo 2\.1"|"capitolo 2\.1"/.test(run('manual-numbering', 'Il capitolo 2.1 descrive il metodo.').evidence)
    )
    check('a document with no \\ref and no hand-written number is ok', status('manual-numbering', 'plain text with a 5 in it') === 'ok')
    // Both defects seen on real theses in one document: the learner picked up the
    // preposition "nel" from "nel \ref{...}", and a year matched as a hand-written
    // number. Either one alone was enough to report `"Nel 1974" is a number written
    // by hand, not a \ref` on correct prose.
    {
        const years = R`Come detto nel \ref{a} e nel \ref{b}, si veda il Capitolo~\ref{c} e il Capitolo~\ref{d}. Nel 1974 la macchina entrò in funzione.`
        const r = run('manual-numbering', years)
        check('a year after a learned word is not a hand-written reference', r.status === 'ok', r.evidence)
        check('a preposition is not learned as a reference word', !/\bnel\b/i.test(r.evidence), r.evidence)
    }
    check(
        'a hand-written figure number is still caught next to a year',
        status(
            'manual-numbering',
            R`Figura \ref{a} e Figura \ref{b}. Nel 1974, come mostra la Figura 3, il valore cresce.`
        ) === 'missing'
    )
    {
        // "nel 3" is prose: the stopword filter drops "nel" from the vocabulary, so
        // nothing is learned from a document that only ever writes it before a \ref,
        // and the static vocabulary does not carry prepositions either.
        const r = run('manual-numbering', R`Come detto nel \ref{a} e nel \ref{b}. Poi nel 3 si vede.`)
        check('a number after a stopword is not flagged', r.status === 'ok', r.evidence)
    }
    {
        // REGRESSION: a main file made of \input{capitolo1} lines was reported as 48
        // hand-written cross-references on a clean thesis. Two guards fell out of it:
        // machine arguments are blanked before the scan, and the word and the number
        // must be SEPARATED ("capitolo 1" is a reference, "capitolo1" is a file name).
        const main = [
            R`\input{capitolo1}`, R`\input{capitolo2}`, R`\input{capitolo3}`,
            R`\include{appendice1}`,
        ].join('\n')
        const r = run('manual-numbering', main)
        check('an \\input of a numbered file name is not a hand-written reference', r.status === 'ok', r.evidence)
        // the same file name QUOTED in prose is glued too, so it stays prose
        const quoted = run('manual-numbering', 'Il sorgente si trova in capitolo1.tex nel progetto.')
        check('a file name quoted in prose is not flagged either', quoted.status === 'ok', quoted.evidence)
        // but a tie is a separator the author typed between word and number: still caught
        const tied = run('manual-numbering', R`Figura \ref{a} e Figura \ref{b}. Vedi la Figura~4 qui.`)
        check('a hand-written number after a tie is still caught', tied.status === 'missing', tied.evidence)
        // and a LABEL whose name happens to contain "tabella 3" is machine text, not
        // a hand-written reference: this is what the blanking pays for even with the
        // separator rule in place (real labels do carry spaces, see the corpus)
        const inLabel = run(
            'manual-numbering',
            R`Tabella \ref{tab:tabella 3} e Tabella \ref{tab:b} e Tabella \ref{tab:c} mostrano i dati.`
        )
        check('a label containing a word and a number is not prose', inLabel.status === 'ok', inLabel.evidence)
    }
}

// ===========================================================================
// decimal-separator
// ===========================================================================
check('one separator throughout is ok', status('decimal-separator', 'valori 1.5 e 2.75 e 3.1') === 'ok')
check('both separators is missing', status('decimal-separator', 'valori 1.5 e 2,75') === 'missing')
check('no decimal number is na', status('decimal-separator', 'testo senza numeri decimali') === 'na')
{
    // REGRESSION-SHAPED: a group of exactly three digits is a thousands separator in
    // one convention and a decimal in the other, so it decides nothing. The model that
    // used to answer this requirement reported "15.000" as an inconsistency.
    const r = run('decimal-separator', 'la quota di 15.000 metri e il valore 1,5')
    check('a thousands group is not counted as a decimal', r.status === 'ok', r.evidence)
    check('and the evidence says so', /thousands separator/.test(r.evidence))
}
{
    // REGRESSION, from the public-thesis corpus: "equazioni 33,34" is a hand-written
    // reference list, and the sectioning vocabulary only carried the singular, so a
    // point-convention document was flipped to "both separators in use" by its own
    // equation references.
    const r = run('decimal-separator', 'come mostrano le equazioni 33,34 il valore vale 1.5 e poi 2.75')
    check('a plural sectioning word shields its reference list', r.status === 'ok', r.evidence)
    // And "alle 19,34" is a time of day, in any convention. The guard is shape-gated:
    // the same digits with a unit after a normal word keep counting.
    const time = run('decimal-separator', "l'osservazione e iniziata alle 19,34 e il valore misurato vale 1.5 e 2.75")
    check('a time of day after an hour word is not a decimal', time.status === 'ok', time.evidence)
    const mass = run('decimal-separator', 'una massa di 19,34 kg contro un valore di 1.5 e 2.75')
    check('the same digits as a measurement still count', mass.status === 'missing', mass.evidence)
    // REGRESSION (measured on a real published thesis): "Tray 3,4 and 6" is an
    // enumeration of tray numbers, and its "3,4" was reported as the document's
    // one comma-decimal. The guard is shape-gated on the BARE trailing integer:
    // "tra 2,5 e 3 mm" carries a unit after the pair and keeps counting.
    const trays = run('decimal-separator', 'it is applied for Tray 3,4 and 6 while the gap is 1.5 and then 2.75')
    check('an enumeration before a bare integer is not a decimal', trays.status === 'ok', trays.evidence)
    const range = run('decimal-separator', 'uno spessore tra 2,5 e 3 mm contro un valore di 1.5 e 2.75')
    check('a range whose trailing number carries a unit still counts', range.status === 'missing', range.evidence)
}
{
    // REGRESSION: the comma of a mathematical interval is not a decimal comma. Four of
    // five real projects were told the "0,1" of a sigmoid range [0,1] or the "-1,1" of
    // a tanh range was a decimal comma inconsistent with the rest of the document, on
    // documents that never write a decimal comma at all.
    const intervals = R`la sigmoide mappa in $[0,1]$, la tangente in (-1,1) e la soglia in (0,1]`
    const r = run('decimal-separator', intervals + ' con valori 0.5 e 0.25 e 3.75')
    check('an interval comma is not a decimal comma', r.status === 'ok', r.evidence)
    check('and the document reads as all points', /use the point/.test(r.evidence), r.evidence)
    check('a spaced interval is not counted either', run('decimal-separator', 'in [0, 1] e 0.5 e 1.5').status === 'ok')
    {
        // and a real decimal comma in prose is still a decimal comma
        const prose = run('decimal-separator', 'un rendimento di 0,75 con una quota di 1.5 metri')
        check('a decimal comma in prose is still counted', prose.status === 'missing', prose.evidence)
        check('and it is the one named', /0,75/.test(prose.evidence), prose.evidence)
    }
}
{
    // REGRESSION: the trailing guard refused any decimal followed by a point or a
    // comma, which is EVERY decimal that ends a sentence. A document whose numbers all
    // end sentences answered "na - the document contains no decimal numbers", and an
    // English thesis whose one stray comma was "3,4 kN" answered "ok - all 1 decimal
    // numbers use the comma", stating the inverse of its own convention over a sample
    // of one.
    const endings = run('decimal-separator', 'Il rendimento vale 0.85. Il rapporto e 5.4. Il carico alare e 3.2.')
    check('a sentence-final decimal is visible', endings.status === 'ok', endings.evidence)
    check('and all three are counted', /All 3 decimal/.test(endings.evidence), endings.evidence)
    const inverted = run(
        'decimal-separator',
        'The lift coefficient is 1.25. The drag coefficient is 0.031. The aspect ratio is 8.5.\n' +
            'The wing loading is 3,4 kN/m^2 as reported.'
    )
    // Partial, not missing, since the leading-zero fix: "0.031" now counts as a
    // decimal (it can never be a thousands group), so the document has FOUR point
    // decimals and the lone comma is the single-exception shape the partial rule
    // exists for. The stray comma is still caught and still named.
    check('a stray comma among sentence-final points is caught', inverted.status === 'partial', inverted.evidence)
    check('and the minority is the comma', /3,4/.test(inverted.evidence), inverted.evidence)
    // a version or a section number is still not two decimals
    check('a third digit group is still not a decimal', run('decimal-separator', 'la versione 1.2.3 e la 4.5.6').status === 'na')
    // and a mixed thousands-plus-decimal number is not two numbers
    check('10.000,50 is not counted twice', run('decimal-separator', 'un costo di 10.000,50 euro').status === 'ok')
    // REGRESSION: "Sect. 3.2" and "Chap. 4.1" are how an English thesis abbreviates
    // its section references, and neither abbreviation was in the vocabulary: the
    // 3.2 counted as a decimal point, and one of them in a comma-decimal document
    // handed the document's own correct commas over as the numbers to check.
    check('Sect. is a section reference, not a decimal', run('decimal-separator', 'valori 1,5 e 2,75 e 3,15 come in Sect. 3.2 del testo').status === 'ok')
    check('Chap. is one too', run('decimal-separator', 'valori 1,5 e 2,75 e 3,15 come in Chap. 4.1 del testo').status === 'ok')
}
{
    // REGRESSION: there was no lead guard here, unlike unit-spacing, so every graphics
    // option counted as a decimal written with a point. An Italian thesis with three
    // figures and two correct decimal commas was told BOTH separators were in use, and
    // handed its own correct "0,85" and "3,2" as the defect to fix.
    const figures = run(
        'decimal-separator',
        R`\includegraphics[width=0.8\textwidth]{a}` + '\n' +
            R`\includegraphics[width=0.45\linewidth]{b}` + '\n' +
            R`\scalebox{0.5}{\includegraphics[width=0.9\linewidth]{c}}` + '\n' +
            'Il rendimento e 0,85 e il rapporto 3,2 come misurato.'
    )
    check('a graphics width is not a decimal number', figures.status === 'ok', figures.evidence)
    check('and the document reads as all commas', /use the comma/.test(figures.evidence), figures.evidence)
    // but siunitx puts a real measurement inside braces, and that one does count
    const siunitx = run('decimal-separator', R`la massa e \num{12,4} kg e il rapporto e 0.5 in tutto`)
    check('a siunitx value is a decimal number', siunitx.status === 'missing', siunitx.evidence)
}
{
    // REGRESSION: the interval exemption accepted round brackets on both sides, so an
    // ordinary parenthesised value swallowed the only decimal comma of the document and
    // a `missing` came back as `ok`. A round pair is how technical prose quotes a
    // number; an interval always shows at least one square side.
    // A LONE minority against an established convention answers `partial` naming
    // the stray, not `missing`: one "3.9" must not invert a document's convention.
    // What the original regression guarded stays guarded: the parenthesised comma
    // is COUNTED and NAMED, never swallowed as an interval.
    const parens = run(
        'decimal-separator',
        'La media vale 12.5 e la deviazione 0.30 su 4.75 campioni.\nLa precisione sul test set (0,82) resta la migliore.'
    )
    check('a decimal comma between parentheses is counted', parens.status === 'partial', parens.evidence)
    check('and it is the one named', /0,82/.test(parens.evidence), parens.evidence)
    // With TWO strays the verdict is the full missing again: two are a pattern.
    const two = run(
        'decimal-separator',
        'Valori 12.5 e 0.30 e 4.75 nel testo. Poi (0,82) e ancora 3,14 scritti con la virgola.'
    )
    check('two minority numbers are still missing', two.status === 'missing', two.evidence)
    // a half-open interval keeps the exemption: its square side identifies it
    check('a half-open interval is still an interval', run('decimal-separator', 'la soglia in (0,1] e i valori 0.5 e 1.5').status === 'ok')
}

// ===========================================================================
// unit-spacing
// ===========================================================================
check('a comma between value and unit is missing', status('unit-spacing', R`una focale di $101.1,mm$ misurata`) === 'missing')
check('a thin space is ok', status('unit-spacing', R`una focale di $12.5\,mm$ e una lunghezza d'onda di $587.6\,nm$`) === 'ok')
check('a plain space is ok', status('unit-spacing', 'una focale di 12.5 mm circa') === 'ok')
check('no units at all is na, not ok', status('unit-spacing', 'un testo senza alcuna misura') === 'na')
{
    // REGRESSION-SHAPED: the exact defect measured on a real thesis, where the model
    // had the right verdict but padded the evidence list by retyping correct thin
    // spaces as commas. The parser must flag the four real commas and nothing else.
    const r = run(
        'unit-spacing',
        R`il pitch è $5.5,\mu m$, la focale nominale $12.5\,mm$, quella effettiva di circa $15.93,mm$, e la focale finale $f_L = 12.5,mm$ con $\lambda = 587.6\,nm$`
    )
    check('real commas are flagged, thin spaces are not', r.status === 'missing', r.evidence)
    check('exactly the three commas are counted', /^3 of 5 /.test(r.evidence), r.evidence)
    check('a mu unit written in LaTeX is recognised', /5\.5,\\mu m/.test(r.evidence), r.evidence)
}
check('a spaced thin space is ok', status('unit-spacing', R`pari a $23 \cdot 0.0055 \, mm$ in tutto`) === 'ok')
{
    // REGRESSION: a thesis that writes EVERY value with siunitx never shows the
    // lexicon a bare unit, so the check answered "na - no recognisable unit" on the
    // document that handles its units best. \SI and \qty typeset value and unit with
    // the correct thin space BY CONSTRUCTION, so each use is a well-written value.
    const all = run(
        'unit-spacing',
        R`Il sensore misura \SI{0.5}{\milli\metre\per\second} di deriva e la massa vale \qty{12}{\kilo\gram}.`
    )
    check('an all-siunitx document is ok, not na', all.status === 'ok', all.evidence)
    check('and both values are counted', /All 2 /.test(all.evidence), all.evidence)
    // a glued bare value beside them still loses: the ratio is now honest
    const mixed = run(
        'unit-spacing',
        R`una distanza di 30mm dal sensore e una deriva di \SI{0.5}{\milli\metre} misurata`
    )
    check('a glued value beside siunitx values is still reported', mixed.status === 'missing', mixed.evidence)
    check('with the siunitx value in the denominator', /1 of 2 /.test(mixed.evidence), mixed.evidence)
    // \si and \unit typeset the unit alone: next to a number they are the author
    // writing the pair correctly too
    const bare = run('unit-spacing', R`un passo di 2.5~\si{\milli\metre} nominale`)
    check('a number tied to \\si counts as a good value', bare.status === 'ok', bare.evidence)
}
{
    // REGRESSION (fragment corpus): "12, kg" was invisible because the comma rule
    // demanded a decimal number. A MULTI-letter lexicon token after the comma is
    // evidence enough: no clause ever opens with a bare "kg". The single capital
    // stays out on both sides ("0.5, N e' il numero di campioni" was the measured
    // false positive that guard paid for), and that exclusion is policy now.
    check('a comma before a multi-letter unit fires without a decimal', status('unit-spacing', 'ogni ruota possiede una massa di 12, kg in tutto') === 'missing')
    check('a comma before a single capital still needs more than a capital', status('unit-spacing', 'una spinta di 8.5, N nel vuoto') === 'na')
    check('a year before a comma-unit shape is prose', status('unit-spacing', 'nel 2020, km di fibra sono stati posati') === 'na')
    // REGRESSION (measured on a real published thesis): "Figura 2.4, l'uso del
    // VIMS" is a figure reference followed by an elided article, and its "l" was
    // reported as a comma-separated litre. No unit is ever followed by an
    // apostrophe; a real litre with the same digits keeps firing.
    check(
        'an elided article after a figure reference is not a litre',
        status('unit-spacing', "Come mostrato in Figura 2.4, l'uso del VIMS consente analisi accurate") === 'na'
    )
    check(
        'the same digits before a real litre still fire',
        status('unit-spacing', 'un serbatoio contiene fino a 2.4, l di propellente') === 'missing'
    )
    check('a table reference before a comma is prose too', status('unit-spacing', 'vedi la Tabella 5, in cui i dati sono raccolti') === 'na')
    // lexicon additions, each measured on the fragment corpus: deg (the lens-name
    // collision that kept it out is not in any corpus), the written-out Watt and
    // percent, RPM, and the compound momentum and dipole units
    check('a glued deg is caught', status('unit-spacing', "un'inclinazione di 45deg rispetto al piano") === 'missing')
    const words = run('unit-spacing', 'un limite di 120, Watt e una resa di 78, percent del totale')
    check('Watt and percent written out are units', words.status === 'missing' && /2 of 2/.test(words.evidence), words.evidence)
    check('N m s and A m2 compounds are units', run('unit-spacing', 'un momento di 150Nms e un dipolo di 200Am2 misurati').status === 'missing')
    check('RPM is a unit', status('unit-spacing', 'il motore ruota a 6000, RPM in regime') === 'missing')
}
check('a glued multi-letter unit is missing', status('unit-spacing', 'una distanza di 30mm dal sensore') === 'missing')
check('a glued single letter needs a decimal to count', status('unit-spacing', 'un peso di 2.5g misurato') === 'missing')
{
    // A single letter glued to an integer is more often a name than a unit.
    const r = run('unit-spacing', 'negli anni 1990s il video in 4K era raro')
    check('decades and 4K are not units', r.status === 'na', r.evidence)
}
{
    // A comma between an integer and a short word is ordinary prose, never a unit.
    const r = run('unit-spacing', 'come mostrato in Tabella 5, in cui la massa è 3, min sono i valori')
    check('prose after a comma is not a unit', r.status === 'na', r.evidence)
}
check('a setting after = is not a measurement', status('unit-spacing', R`\includegraphics[width=12.5mm]{x}`) === 'na')
check('a length inside braces is not a measurement', status('unit-spacing', R`\vspace{2mm} nel testo`) === 'na')
check('a signed symbol in a formula is not a unit', status('unit-spacing', R`si ottiene $a = -3B$ dal modello`) === 'na')
check('an italian decimal with a spaced unit is ok', status('unit-spacing', 'una distanza di 2,5 mm circa') === 'ok')
check('a compound unit is one unit', status('unit-spacing', 'una velocità di 3.2 m/s costante') === 'ok')
check(
    'a compound unit with a comma is missing',
    status('unit-spacing', R`una potenza di $1367.0,W/m^2$ incidente`) === 'missing'
)
{
    // Units inside a code listing are shown, not typeset.
    const r = run('unit-spacing', R`\begin{lstlisting}
d = 12.5,mm
\end{lstlisting} testo`)
    check('a listing body is not scanned for units', r.status === 'na', r.evidence)
}

// ===========================================================================
// urls-in-text
// ===========================================================================
check('a bare link in the prose is missing', status('urls-in-text', 'vedi https://example.org/page per i dettagli') === 'missing')
check('a link inside \\url is ok', status('urls-in-text', R`vedi \url{https://example.org/page} qui`) === 'ok')
check('a link inside \\href is ok', status('urls-in-text', R`vedi \href{https://example.org}{il sito} qui`) === 'ok')
{
    // REGRESSION: a thebibliography environment IS the bibliography, so the DOI of
    // every entry was reported as a hand-typed link. Caught on a real template.
    const bib =
        R`\begin{thebibliography}{99}` +
        '\n' +
        R`\bibitem{a} Autore, Titolo, 2015, https://doi.org/10.1109/X` +
        '\n' +
        R`\end{thebibliography}`
    check('a link inside thebibliography is not a violation', status('urls-in-text', bib) === 'ok', run('urls-in-text', bib).evidence)
}
{
    // REGRESSION: a link parked in a % comment is not typeset, so the reader never
    // sees it. The controller strips line comments upstream, but the check must not
    // depend on that: run standalone (as the corpus bench does) it reported a link
    // that is not in the PDF. Same defense-in-depth the other prose checks carry.
    const commented = run('urls-in-text', 'testo % https://example.org/parked\naltro testo')
    check('a commented-out link is not typed into the text', commented.status === 'ok', commented.evidence)
    const both = run('urls-in-text', 'testo % https://example.org/parked\nvedi https://example.org/real qui')
    check('a real bare link beside it is still reported', both.status === 'missing' && /real/.test(both.evidence), both.evidence)
    check('an escaped percent does not hide the rest of the line', status('urls-in-text', 'il 50\\% dei casi: https://example.org/real') === 'missing')
}

// ===========================================================================
// work-markers
// ===========================================================================
check('a TODO is missing', status('work-markers', 'testo TODO rivedere') === 'missing')
check('a \\todo macro is missing', status('work-markers', R`testo \todo{rivedere} altro`) === 'missing')
check('clean text is ok', status('work-markers', 'testo pulito senza marcatori') === 'ok')
check('a word merely containing the letters is not a marker', status('work-markers', 'il TODOS non esiste') === 'ok')
{
    // REGRESSION: TBU ("to be updated") and TBC ("to be confirmed") are the markers
    // that survive into a document that LOOKS finished. A real thesis carried its
    // headline result as "48.43% (TBU)" and nothing flagged it, so a number the author
    // had already marked as provisional went out as the result of the work.
    const tbu = runCheck('work-markers', [{ path: '/results.tex', text: 'testo\nl\'accuratezza e 48.43% (TBU) sul test set' }])
    check('a TBU is a work marker', tbu.status === 'missing', tbu.evidence)
    check('and it carries file and line', tbu.locations[0]?.path === '/results.tex' && tbu.locations[0]?.line === 2, JSON.stringify(tbu.locations))
    const tbc = runCheck('work-markers', [{ path: '/results.tex', text: 'TBC: mancano le prove di volo' }])
    check('a TBC is a work marker', tbc.status === 'missing', tbc.evidence)
    check('and it carries file and line', tbc.locations[0]?.path === '/results.tex' && tbc.locations[0]?.line === 1, JSON.stringify(tbc.locations))
    // the letters inside an ordinary word are not a marker
    check('a word containing the letters is not a TBU', status('work-markers', 'il valore obtained non e un marcatore') === 'ok')
    check('nor is a longer token', status('work-markers', 'la sigla TBUS non esiste') === 'ok')
}
{
    // REGRESSION: TBC is also Thermal Barrier Coating, the subject of any turbine or
    // materials thesis. "Il rivestimento TBC riduce la temperatura del metallo" came
    // back as three editing markers left in a finished chapter. So TBC now only counts
    // in the shape a note to self is written in - followed by a colon, or standing
    // alone inside brackets - which is never how a coating is named.
    const coating = runCheck('work-markers', [
        {
            path: '/c4.tex',
            text:
                'Il rivestimento TBC riduce la temperatura del metallo.\n' +
                'Lo spessore del TBC vale 300 micrometri.\n' +
                'Il TBC e depositato per APS.',
        },
    ])
    check('TBC as an acronym in prose is not a marker', coating.status === 'ok', coating.evidence)
    check('but TBC before a colon still is', status('work-markers', 'TBC: mancano le prove di volo') === 'missing')
    check('and TBC alone in brackets still is', status('work-markers', "l'accuratezza e 48.43% (TBC)") === 'missing')
    check('TBU keeps the plain form: nobody declares it', status('work-markers', 'il valore TBU resta provvisorio') === 'missing')
    // a thesis must not be accused by its own acronym list, nor by its citation keys
    const declaresIt = runCheck('work-markers', [
        { path: '/acronimi.tex', text: R`\acro{TBC}{Thermal Barrier Coating}` },
        { path: '/c1.tex', text: R`\newacronym{tbc}{TBC}{Thermal Barrier Coating}` },
    ])
    check('a declared acronym named TBC is not a marker', declaresIt.status === 'ok', declaresIt.evidence)
    check(
        'nor is a citation key or a label that contains one',
        status('work-markers', R`vedi \cite{TBC2019} e la \ref{fig:TBC1}`) === 'ok',
        run('work-markers', R`vedi \cite{TBC2019} e la \ref{fig:TBC1}`).evidence
    )
    // REGRESSION: a TODO parked inside \begin{comment} is not left in the text.
    const parked = run('work-markers', R`\begin{comment}TODO rivedere questa parte\end{comment}` + '\ntesto pulito')
    check('a TODO inside a comment environment is not left in the text', parked.status === 'ok', parked.evidence)
}

// ===========================================================================
// crossrefs-resolve
// ===========================================================================
check('a dangling \\ref is missing', status('crossrefs-resolve', R`vedi \ref{fig:none}`) === 'missing')
{
    // REGRESSION: TeX allows a space between the command and its brace. `\ref {x}`
    // was no reference at all (a dangling one went unreported) and `\label {x}`
    // defined nothing (a resolvable reference was reported as pointing nowhere).
    check('a spaced \\ref is still a reference', status('crossrefs-resolve', R`vedi \ref {fig:none} qui`) === 'missing')
    check('a spaced \\label still defines', status('crossrefs-resolve', R`\label {fig:a} e \ref{fig:a}`) === 'ok')
}
check(
    'a resolved \\ref is ok',
    status('crossrefs-resolve', R`\label{fig:a} vedi \ref{fig:a}`) === 'ok'
)
check('a document with no reference is na', status('crossrefs-resolve', R`\label{fig:a} solo testo`) === 'na')
{
    // REGRESSION: a listing declares its label as an OPTION, not with \label. Missing
    // that turned every reference to a code listing into a dangling one.
    const r = run('crossrefs-resolve', R`\begin{lstlisting}[label=lst:one]x\end{lstlisting} vedi \ref{lst:one}`)
    check('a listing option label counts as a label', r.status === 'ok', r.evidence)
    const braced = run('crossrefs-resolve', R`\begin{lstlisting}[label={lst:two}]x\end{lstlisting} \ref{lst:two}`)
    check('a braced listing option label counts too', braced.status === 'ok', braced.evidence)
}
{
    // REGRESSION: "href" ends in the letters "ref", so \href{url}{text} matched the
    // cross-reference pattern and its URL was read as a label name. On a real report
    // that turned all 9 links of the document into references to labels that do not
    // exist, a finding the author cannot act on because nothing is wrong.
    const links = R`vedi \href{https://example.org/page}{il sito} e \href{https://x.org}{un altro}`
    const r = run('crossrefs-resolve', links)
    check('an \\href is not a cross-reference', r.status === 'na', r.evidence)
    check('and no URL is named as a missing label', !/example\.org/.test(r.evidence), r.evidence)
    // a real dangling \ref beside it is still reported
    const both = run('crossrefs-resolve', links + R` e \ref{ghost}`)
    check('a dangling \\ref beside a link is still missing', both.status === 'missing', both.evidence)
    check('and exactly one reference was counted', /1 of 1 /.test(both.evidence), both.evidence)
    // \hyperref names its label in BRACKETS, so its brace-less form is not a \ref
    const hyper = run('crossrefs-resolve', R`\label{ok} vedi \hyperref[ok]{il testo} e \ref{ok}`)
    check('a \\hyperref does not become a dangling reference', hyper.status === 'ok', hyper.evidence)
}
{
    // The same pattern feeds float-referenced, where the private copy of it had the
    // same defect: the first argument of an \href was collected as a label name. An
    // author who writes \href where they meant \hyperref produces a link that goes
    // nowhere, and the float it points at is still never referenced - which is the
    // finding this check exists for, and which the copy silently swallowed.
    const r = run(
        'float-referenced',
        R`\begin{figure}\caption{C}\label{fig:one}\end{figure}` + R` vedi \href{fig:one}{Figura 1}`
    )
    check('an \\href argument is not a reference to a float', r.status === 'missing', r.evidence)
    const real = run(
        'float-referenced',
        R`\begin{figure}\caption{C}\label{fig:one}\end{figure}` + R` vedi \autoref{fig:one}`
    )
    check('and a real cross-reference still counts', real.status === 'ok', real.evidence)
}

// ===========================================================================
// citations-resolve
// ===========================================================================
{
    const bib = { path: '/refs.bib', text: '@article{ok,\n title={T},\n author={A},\n year={2020},\n}\n' }
    check(
        'a cite with an entry is ok',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`vedi \cite{ok}` }]).status === 'ok'
    )
    check(
        'a cite with no entry is missing',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`vedi \cite{ghost}` }]).status === 'missing'
    )
    check(
        'a multiple cite is split',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`\citep{ok,ghost}` }]).status === 'missing'
    )
    check(
        'no bib file at all is na',
        runCheck('citations-resolve', [{ path: '/a.tex', text: R`\cite{ok}` }]).status === 'na'
    )
    // A bibliography written by hand in a .tex is still a bibliography. A real
    // internship report carried one and no .bib at all, and the check answered "the
    // project carries no .bib file": every citation went unverified.
    {
        const inline = {
            path: '/biblio.tex',
            text: R`\begin{thebibliography}{9}
\bibitem{knuth} D. Knuth, The TeXbook, 1984.
\bibitem[Lam94]{lamport} L. Lamport, LaTeX, 1994.
\end{thebibliography}`,
        }
        check(
            'a cite resolved by a bibitem is ok',
            runCheck('citations-resolve', [inline, { path: '/a.tex', text: R`see \cite{knuth}` }]).status === 'ok'
        )
        check(
            'a bibitem with a label still defines its key',
            runCheck('citations-resolve', [inline, { path: '/a.tex', text: R`see \cite{lamport}` }]).status === 'ok'
        )
        const r = runCheck('citations-resolve', [inline, { path: '/a.tex', text: R`see \cite{ghost}` }])
        check('an unresolved cite is still reported against a thebibliography', r.status === 'missing', r.evidence)
        // Both bibliographies at once: the known keys are the union of the two.
        check(
            'bib entries and bibitems are one set of known keys',
            runCheck('citations-resolve', [bib, inline, { path: '/a.tex', text: R`\cite{ok,knuth}` }]).status === 'ok'
        )
    }
    // A biblatex thesis never writes \cite. Not recognising its citation commands
    // would answer na on a document full of citations, or - worse, once a .bib is
    // present - report every entry as never cited. The lab's own Zotero export drops
    // students straight into this family.
    check(
        'biblatex citation commands are citations',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`Come in \textcite{ok} e \parencite{ok}.` }]).status === 'ok'
    )
    check(
        'and so are \\footcite and \\autocite',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`Testo\footcite{ok} e altro \autocite{ok}.` }]).status === 'ok'
    )
    // The page option is the normal way to cite a page of a book, and natbib takes two
    // of them. Reading the option as the key would report a dangling citation on every
    // one of them.
    check(
        'a page option is not the citation key',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`Vedi \cite[p.~45]{ok} e \citep[cfr.][cap. 2]{ok}.` }]).status === 'ok'
    )
    // REGRESSION: TeX allows whitespace between the option and the key group, and
    // `\cite[p.~3] {k}` was read as no citation at all: the requirement went
    // unanswered on a resolvable citation and stayed silent on a dangling one.
    check(
        'a space between option and key group still cites',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`Vedi \cite[p.~3] {ok}.` }]).status === 'ok',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`Vedi \cite[p.~3] {ok}.` }]).evidence
    )
    check(
        'and a dangling key behind the space is still caught',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`Vedi \cite[p.~3] {ghost}.` }]).status === 'missing'
    )
    // the adjacency rule for EXTRA groups survives: `\cite{ok} {\bfseries x}` is one
    // citation followed by a brace group, not a citation of "\bfseries x"
    check(
        'a spaced brace group after the key is not a second citation',
        runCheck('citations-resolve', [bib, { path: '/a.tex', text: R`Vedi \cite{ok} {\bfseries testo} qui.` }]).status === 'ok'
    )
    // JabRef and Zotero write housekeeping entries at the top of the file. They are not
    // references, so counting them as entries would leave a bibliography that is
    // "complete" by an inflated total and could make a ghost key resolve.
    {
        const withHeaders = {
            path: '/r.bib',
            text:
                '@comment{jabref-meta: databaseType:bibtex;}\n' +
                '@string{aiaa = {AIAA Journal}}\n' +
                '@article{ok, author={A}, title={T}, journal=aiaa, year={2019}}\n',
        }
        check(
            'a @comment and a @string are not bibliography entries',
            runCheck('citations-resolve', [withHeaders, { path: '/a.tex', text: R`Vedi \cite{ok}.` }]).status === 'ok'
        )
        const r = runCheck('citations-resolve', [withHeaders, { path: '/a.tex', text: R`Vedi \cite{jabref-meta}.` }])
        check('and neither can be cited', r.status === 'missing', r.evidence)
    }
}

// ===========================================================================
// bib-entries-complete
// ===========================================================================
{
    const full = '@article{ok,\n title={T},\n author={A},\n year={2020},\n journal={J},\n}\n'
    const bare = '@misc{bare,\n url={http://x},\n}\n'
    check('a complete entry is ok', runCheck('bib-entries-complete', [{ path: '/r.bib', text: full }]).status === 'ok')
    // The venue has a different field name for every entry type, so it cannot be one
    // name: asking a book for a journal would report every book as incomplete.
    const book = '@book{b,\n title={T},\n author={A},\n year={2020},\n publisher={P},\n}\n'
    check('a book is asked for a publisher, not a journal', runCheck('bib-entries-complete', [{ path: '/r.bib', text: book }]).status === 'ok')
    const noVenue = '@article{v,\n title={T},\n author={A},\n year={2020},\n}\n'
    const rv = runCheck('bib-entries-complete', [{ path: '/r.bib', text: noVenue }])
    check('an article with no journal is incomplete', rv.status === 'missing' && /journal/.test(rv.evidence), rv.evidence)
    const misc = '@misc{m,\n title={T},\n author={A},\n year={2020},\n}\n'
    check('a misc is not asked for a venue it cannot have', runCheck('bib-entries-complete', [{ path: '/r.bib', text: misc }]).status === 'ok')
    // @online is what Zotero writes for a web page, and it has no venue either. A
    // thesis that cites agency pages carries a dozen of them, and asking each one for a
    // journal would bury the real gaps.
    const online =
        '@online{esa2021,\n author = {{European Space Agency}},\n title = {Sentinel-2 mission},\n year = {2021},\n url = {https://www.esa.int},\n}\n'
    check('an @online entry is complete without a venue', runCheck('bib-entries-complete', [{ path: '/r.bib', text: online }]).status === 'ok')
    const r = runCheck('bib-entries-complete', [{ path: '/r.bib', text: full + bare }])
    check('an entry reduced to a link is missing', r.status === 'missing', r.evidence)
    check('and it is named', /bare/.test(r.evidence), r.evidence)
    check(
        'no bib file is na',
        runCheck('bib-entries-complete', [{ path: '/a.tex', text: 'testo' }]).status === 'na'
    )
    // A hand-written thebibliography has entries, but they are free text: author,
    // title and year are a convention there, not fields, so completeness is not
    // decidable. The answer stays na and now SAYS WHY, instead of claiming the
    // project has no bibliography at all.
    {
        const r = runCheck('bib-entries-complete', [
            {
                path: '/biblio.tex',
                text: R`\begin{thebibliography}{9}
\bibitem{knuth} D. Knuth, The TeXbook, 1984.
\end{thebibliography}`,
            },
        ])
        check('a thebibliography is na for completeness', r.status === 'na', r.evidence)
        check('and the na says it is hand-written, not that no bibliography exists', /hand-written/.test(r.evidence), r.evidence)
    }
}

// ===========================================================================
// no-wikipedia
// ===========================================================================
check('a wikipedia source is missing', runCheck('no-wikipedia', [{ path: '/r.bib', text: '@misc{w, url={https://it.wikipedia.org/x}}' }]).status === 'missing')
check('a document without it is ok', status('no-wikipedia', 'testo con fonti serie') === 'ok')

// ===========================================================================
// acronyms-declared-unused
// ===========================================================================
{
    const docs = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: 'The ADCS and the LEO regime are discussed.' },
    ]
    check('every declared acronym used is ok', runCheck('acronyms-declared-unused', docs).status === 'ok')
    const half = [
        { path: '/acronyms.tex', text: DECL },
        { path: '/chapter1.tex', text: 'Only the ADCS is discussed.' },
    ]
    const r = runCheck('acronyms-declared-unused', half)
    check('one declared and never used is missing', r.status === 'missing', r.evidence)
    check('and it is named', /LEO/.test(r.evidence), r.evidence)
    check('no acronyms declared is na', status('acronyms-declared-unused', 'plain text') === 'na')
}
{
    // REGRESSION: the same glossaries blindness, seen from the other side. A project
    // that writes \gls{adcs} everywhere was told "1 of 1 declared acronyms never appear
    // in the text: ADCS" - a mechanical fact, stated as a certainty, about a document
    // that uses it on every page.
    const gls = [
        { path: '/acronyms.tex', text: R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}` },
        { path: '/c1.tex', text: R`Il \gls{adcs} controlla l'assetto e il \gls{adcs} usa tre ruote.` },
    ]
    check('a \\gls of the key is a use', runCheck('acronyms-declared-unused', gls).status === 'ok', runCheck('acronyms-declared-unused', gls).evidence)
    const acrshort = [
        { path: '/acronyms.tex', text: R`\newacronym{leo}{LEO}{Low Earth Orbit}` },
        { path: '/c1.tex', text: R`Il satellite opera in \acrshort{leo} per tutta la missione.` },
    ]
    check('and so is an \\acrshort of it', runCheck('acronyms-declared-unused', acrshort).status === 'ok', runCheck('acronyms-declared-unused', acrshort).evidence)
    // a key that is genuinely never written is still a finding
    const never = [
        { path: '/acronyms.tex', text: R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}` },
        { path: '/c1.tex', text: 'Il satellite controlla il proprio assetto con tre ruote di reazione.' },
    ]
    check('an acronym nobody writes is still reported', runCheck('acronyms-declared-unused', never).status === 'missing', runCheck('acronyms-declared-unused', never).evidence)
}
{
    // REGRESSION: the acronym list most university templates actually ship uses no
    // package at all - a starred heading plus a two-column table of `SHORT & Long
    // form \\` rows. A collector that only knew the package forms told a document
    // with a full hand-written list that its acronyms were "never declared", and
    // then counted the list's own rows as uses of every acronym in it.
    const HAND_LIST = [
        R`\section*{Elenco degli acronimi}`,
        R`\begin{tabular}{ll}`,
        R`ADCS & Attitude Determination and Control System \\`,
        R`LEO & Low Earth Orbit \\`,
        R`\end{tabular}`,
    ].join('\n')
    // declared-and-unused reads the rows as declarations, and the rows themselves
    // are not uses: an entry only the list ever writes is a finding
    const half = [
        { path: '/acronimi.tex', text: HAND_LIST },
        { path: '/c1.tex', text: "L'ADCS controlla l'assetto del satellite." },
    ]
    const r = runCheck('acronyms-declared-unused', half)
    check('a hand-written list row is a declaration', r.status === 'missing', r.evidence)
    check('and the unused entry is named, not kept alive by its own row', /LEO/.test(r.evidence), r.evidence)
    // first-use treats the rows as declarations too: a bare use in prose is the
    // declared-acronym defect, reported at the prose, not at the list
    const firstUse = runCheck('acronym-first-use', half)
    check('a hand-declared acronym used bare is missing', firstUse.status === 'missing', firstUse.evidence)
    check('and the finding points at the prose, not at the list', firstUse.locations[0]?.path === '/c1.tex', JSON.stringify(firstUse.locations))
    // an author who does expand at first use passes
    const expanded = [
        { path: '/acronimi.tex', text: HAND_LIST },
        { path: '/c1.tex', text: "L'Attitude Determination and Control System (ADCS) controlla l'assetto. La Low Earth Orbit (LEO) è l'orbita." },
    ]
    check('a hand-declared acronym expanded at first use is ok', runCheck('acronym-first-use', expanded).status === 'ok', runCheck('acronym-first-use', expanded).evidence)
    // the hand list is a list for the membership check as well
    const membership = [
        { path: '/acronimi.tex', text: HAND_LIST },
        {
            path: '/c1.tex',
            text: "L'ADCS satura la GPU di bordo.\nLa GPU elabora le immagini.\nLa GPU consuma 8 W. L'orbita LEO è bassa.",
        },
    ]
    const m = runCheck('acronyms-missing-from-list', membership)
    check('a short form missing from the hand list is reported', m.status === 'missing' && /GPU/.test(m.evidence), m.evidence)
    // The bold dissertation shape: `\textbf{ADCS}&& Attitude...\\` with the middle
    // column left empty, straight from a real PhD template. The plain-row pattern
    // cannot see these (the line starts with a backslash), so they carry their own
    // pattern, whose \textbf anchor also vouches for LaTeX in the long cell. The
    // list deliberately MIXES a plain row between the bold ones: the shapes come
    // from separate scans, and an unsorted span list made blankRanges drop the
    // early bold rows, so an unused entry was kept alive by its own unblanked row.
    const BOLD_LIST = [
        R`\chapter*{List of Acronyms} \label{chap:Acronyms}`,
        R`\begin{longtable}[t]{ m{4em} m{3em} m{25em}}`,
        R`    \textbf{GNC}&& Guidance Navigation and Control\\`,
        R`    LEO & Low Earth Orbit \\`,
        R`    \textbf{ADCS}&& Attitude Determination and Control System\\`,
        R`    \textbf{CAD} && Computer Aided Design \\`,
        R`    \textbf{TF2}&& \texttt{tf2} transform library (ROS~2)\\`,
        R`    \textbf{RMSE}&& 0.31\\`,
        R`\end{longtable}`,
    ].join('\n')
    const boldDocs = [
        { path: '/acronyms.tex', text: BOLD_LIST },
        {
            path: '/c1.tex',
            text: 'The ADCS keeps the spacecraft pointed and its CAD model is used by TF2 in LEO conditions.',
        },
    ]
    const bold = runCheck('acronyms-declared-unused', boldDocs)
    check('a bold table row is a declaration and its unused entry is caught', bold.status === 'missing' && /GNC/.test(bold.evidence), bold.evidence)
    check('a bold row whose long cell is a number declares nothing', !/RMSE/.test(bold.evidence), bold.evidence)

    // BOTH gates hold: rows under an ordinary heading are a results table, not a list
    const results = [
        {
            path: '/c1.tex',
            text: [
                R`\section{Risultati}`,
                R`\begin{tabular}{ll}`,
                R`ADCS & Assetto stimato correttamente \\`,
                R`LEO & Orbita raggiunta \\`,
                R`\end{tabular}`,
            ].join('\n'),
        },
    ]
    check('a results table under an ordinary heading declares nothing', runCheck('acronyms-declared-unused', results).status === 'na', runCheck('acronyms-declared-unused', results).evidence)
    // and one row under the right heading is not a list either
    const single = [
        {
            path: '/acronimi.tex',
            text: [
                R`\section*{Acronimi}`,
                R`\begin{tabular}{ll}`,
                R`ADCS & Attitude Determination and Control System \\`,
                R`\end{tabular}`,
            ].join('\n'),
        },
    ]
    check('a single row under the heading is not a list', runCheck('acronyms-declared-unused', single).status === 'na', runCheck('acronyms-declared-unused', single).evidence)
    // package declarations win over a hand row for the same short form: the key the
    // use commands name comes from the package, not from the table
    const both = [
        { path: '/acronimi.tex', text: R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}` + '\n' + HAND_LIST },
        { path: '/c1.tex', text: R`Il \gls{adcs} controlla l'assetto. La Low Earth Orbit (LEO) è bassa.` },
    ]
    check('package forms win over the hand row for the same short form', runCheck('acronyms-declared-unused', both).status === 'ok', runCheck('acronyms-declared-unused', both).evidence)
    // REGRESSION: the LAST row of a hand-written tabular routinely drops its \\ -
    // nothing follows it - and that row's acronym was not read as declared.
    const lastRow = [
        {
            path: '/acronimi.tex',
            text: [
                R`\section*{Acronimi}`,
                R`\begin{tabular}{ll}`,
                R`ADCS & Attitude Determination and Control System \\`,
                R`LEO & Low Earth Orbit`,
                R`\end{tabular}`,
            ].join('\n'),
        },
        { path: '/c1.tex', text: "Solo l'ADCS è usato nel testo." },
    ]
    const lr = runCheck('acronyms-declared-unused', lastRow)
    check('the last row without \\\\ is still a declaration', lr.status === 'missing' && /LEO/.test(lr.evidence), lr.evidence)
    // REGRESSION: the OTHER hand-written shape, a description list -
    // `\item[ADCS] Attitude Determination and Control System` - under the same
    // heading. Same defect as the tabular form: acronyms "never declared" and the
    // list's own lines counted as uses.
    const description = [
        {
            path: '/acronimi.tex',
            text: [
                R`\section*{Elenco degli acronimi}`,
                R`\begin{description}`,
                R`\item[ADCS] Attitude Determination and Control System`,
                R`\item[LEO] Low Earth Orbit`,
                R`\end{description}`,
            ].join('\n'),
        },
        { path: '/c1.tex', text: "L'ADCS controlla l'assetto del satellite." },
    ]
    const de = runCheck('acronyms-declared-unused', description)
    check('a description-list acronym list declares its entries', de.status === 'missing' && /LEO/.test(de.evidence), de.evidence)
    const df = runCheck('acronym-first-use', description)
    check('and its rows are not uses of their own acronym', df.status === 'missing' && df.locations[0]?.path === '/c1.tex', df.evidence)
    // items under an ordinary heading stay prose
    const ordinary = [
        {
            path: '/c1.tex',
            text: [
                R`\section{Requisiti}`,
                R`\begin{description}`,
                R`\item[ADCS] deve mantenere il puntamento entro un grado.`,
                R`\item[LEO] deve essere raggiunta entro dieci giorni.`,
                R`\end{description}`,
            ].join('\n'),
        },
    ]
    check('description items under an ordinary heading declare nothing', runCheck('acronyms-declared-unused', ordinary).status === 'na', runCheck('acronyms-declared-unused', ordinary).evidence)
}

// ===========================================================================
// has-abstract and has-bibliography
// ===========================================================================
const ABSTRACT_TEXT =
    'This work studies the attitude determination and control of a small satellite, ' +
    'and reports the results obtained in simulation over three orbits of flight.'
check('an abstract environment is found', status('has-abstract', R`\begin{abstract}` + ABSTRACT_TEXT + R`\end{abstract}`) === 'ok')
{
    // REGRESSION: an abstract file holding the template header and not one word of
    // text answered "ok" because the heading was there. Reporting a requirement as met
    // on the strength of a heading nobody wrote anything under is the same failure as
    // any other verdict on something that was never read.
    const r = run('has-abstract', R`\cleardoublepage\phantomsection\addcontentsline{toc}{chapter}{Abstract}` + '\n')
    check('an empty abstract is missing, not ok', r.status === 'missing', r.evidence)
    check('and the answer says it is empty', /declared but empty/.test(r.evidence), r.evidence)
}
{
    // REGRESSION: real templates introduce the abstract with a table-of-contents
    // entry, not with the environment. Looking only for \begin{abstract} answered
    // "missing" on five university templates that all have one.
    const r = run(
        'has-abstract',
        R`\cleardoublepage\phantomsection\addcontentsline{toc}{chapter}{Abstract}` + '\n' + ABSTRACT_TEXT
    )
    check('a table-of-contents entry counts as an abstract', r.status === 'ok', r.evidence)
    const it = run('has-abstract', R`\chapter*{Sommario}` + '\n' + ABSTRACT_TEXT)
    check('and the heading is recognised in another language', it.status === 'ok', it.evidence)
    // REGRESSION: a heading whose first token is a formatting command -
    // `\chapter*{\centering Abstract}`, which title-page templates write - hid the
    // name from the scan and a document with an abstract answered "missing".
    const centred = run('has-abstract', R`\chapter*{\centering Abstract}` + '\n' + ABSTRACT_TEXT + '\n' + R`\chapter{Intro}`)
    check('a formatting command before the name does not hide the abstract', centred.status === 'ok', centred.evidence)
}
check('a document with no abstract is missing', status('has-abstract', R`\chapter{Introduzione}Testo.`) === 'missing')
check(
    'the missing answer says what it looked for',
    /Looked for/.test(run('has-abstract', R`\chapter{Introduzione}Testo.`).evidence)
)
check('a \\bibliography command is found', status('has-bibliography', R`\bibliography{refs}`) === 'ok')
check('biblatex is found too', status('has-bibliography', R`\printbibliography`) === 'ok')
check('thebibliography is found too', status('has-bibliography', R`\begin{thebibliography}{9}\end{thebibliography}`) === 'ok')
{
    const r = runCheck('has-bibliography', [
        { path: '/refs.bib', text: '@article{a,title={T}}' },
        { path: '/main.tex', text: R`\chapter{Uno}Testo.` },
    ])
    check('a .bib nobody pulls in is still missing', r.status === 'missing', r.evidence)
    check('and the answer explains the difference', /ever pulls it into/.test(r.evidence), r.evidence)
}

// ===========================================================================
// LaTeX shown as an example is not LaTeX that runs
// ===========================================================================
// A thesis that documents LaTeX in an appendix contains \begin{figure} and
// \begin{equation*} as listing CONTENT. Counting them reports violations that exist
// only inside a code block, which is a false positive the author cannot act on.
{
    const listed = R`\begin{lstlisting}` + '\n' + R`\begin{figure}\includegraphics{a}\end{figure}` + '\n' + R`\end{lstlisting}`
    check('a float inside a listing is not a float', status('float-caption', listed) === 'na', run('float-caption', listed).evidence)
    const verb = R`\begin{verbatim}` + '\n' + R`\begin{equation*}x\end{equation*}` + '\n' + R`\end{verbatim}`
    check('an equation inside verbatim is not an equation', status('numbered-equations', verb) === 'na')
    const minted = R`\begin{minted}{latex}` + '\n' + R`$$ x $$` + '\n' + R`\end{minted}`
    check('minted content is ignored too', status('numbered-equations', minted) === 'na')
    // and a real float sitting next to a listing is still seen
    const both = listed + '\n' + R`\begin{figure}\includegraphics{b}\caption{a real one}\end{figure}`
    check('a real float beside a listing is still counted', /All 1 float/.test(run('float-caption', both).evidence), run('float-caption', both).evidence)
}

// ===========================================================================
// cost: a student can paste anything, and this runs inside the request
// ===========================================================================
// REGRESSION: searching for the matching \end from each \begin was quadratic as soon
// as the \end was absent. Measured on the old scan: 500 unclosed figures 34 ms, 4000
// figures 2372 ms, per check, times six checks, on Node's single thread - one upload
// froze the instance for everybody. The bound below is deliberately loose: it is not
// a benchmark, it is a tripwire for the return of quadratic behaviour.
{
    const unclosed = (R`\begin{figure}\includegraphics{a}` + '\n' + 'filler '.repeat(20) + '\n').repeat(4000)
    const started = Date.now()
    const r = run('float-caption', unclosed)
    const elapsed = Date.now() - started
    check('4000 unclosed floats stay linear', elapsed < 1000, `${elapsed} ms`)
    check('and they are all reported as unclosed', r.status === 'missing', r.evidence.slice(0, 80))

    const nested = R`\begin{figure}`.repeat(3000) + R`\end{figure}`.repeat(3000)
    const t2 = Date.now()
    runCheck('float-referenced', doc(nested))
    check('3000 nested floats stay linear', Date.now() - t2 < 1000, `${Date.now() - t2} ms`)
    // float-caption looks inside each float for a subcaption, so it must not pay
    // O(size x depth) on a document that nests floats and carries no caption at all.
    const t3 = Date.now()
    runCheck('float-caption', doc(nested))
    check('and so does the caption scan over them', Date.now() - t3 < 1000, `${Date.now() - t3} ms`)
}
{
    // REGRESSION: the same defect written as a regex. `\begin{X}[\s\S]*?\end{X}` is
    // quadratic the moment the \end is missing - the lazy body scans to the end of the
    // file, fails, and the engine retries from the next \begin. The verbatim one sat at
    // the ENTRY POINT of runCheck, so a 2 MB document cost 41.7 s per check and the
    // review runs 19 of them: thirteen minutes of frozen event loop, on Node's single
    // thread, from one student clicking Run once. Measured after the fix, the same
    // 2 MB inputs cost 40 to 630 ms; the ceiling below is a loose tripwire, not a
    // benchmark, and a return to quadratic would blow through it by minutes.
    const TWO_MEGABYTE_BUDGET_MS = 3000
    const twoMegabytes = unit => unit.repeat(Math.round((2 * 1024 * 1024) / unit.length))
    const budget = (name, checkName, unit) => {
        const text = twoMegabytes(unit)
        const started = Date.now()
        runCheck(checkName, [{ path: '/t.tex', text }])
        const elapsed = Date.now() - started
        check(`2 MB of ${name} stays well under the budget`, elapsed < TWO_MEGABYTE_BUDGET_MS, `${elapsed} ms`)
    }
    budget('unclosed verbatim', 'has-bibliography', R`\begin{verbatim}`)
    budget('unclosed maths environments', 'acronym-first-use', R`\begin{equation}`)
    budget('unclosed display brackets', 'acronym-first-use', R`\[ x `)
    budget('unclosed thebibliography', 'urls-in-text', R`\begin{thebibliography}{9}`)
    budget('unclosed thebibliography with bibitems', 'citations-resolve', R`\begin{thebibliography}{9}\bibitem{k}x`)
    budget('unclosed comment environments', 'float-caption', R`\begin{comment}`)
    budget('unclosed conditionals', 'float-caption', R`\iffalse `)
    // one very long line: the caps-line test must not walk back to the previous
    // newline at every candidate, or a generated table becomes quadratic on its own
    budget('one line of dense capitals', 'acronym-first-use', 'ABC DEF GHI JKL ')
}

// ===========================================================================
// REGRESSIONS from the adversarial semantics audit
// ===========================================================================
// Each block below is a fixture that was RUN against the shipped checks and came
// back with the wrong verdict. They are grouped by check, and every one of them
// carries the control case beside it: a fix that turns a false violation into a
// false pass is not a fix.

// --- bib-entries-complete: biblatex is what Zotero exports -----------------
{
    const bib = body => [
        { path: '/thesis.tex', text: R`\cite{k}\bibliography{refs}` },
        { path: '/refs.bib', text: body },
    ]
    // BC1: a complete Zotero entry. It writes journaltitle and date where BibTeX
    // writes journal and year, and was reported as "has no year, no journal" - the
    // author is told to add fields their reference manager already wrote. The lab
    // ships a Zotero integration, so this is the highest-traffic false violation
    // the bibliography check had.
    const zotero = runCheck(
        'bib-entries-complete',
        bib('@article{k, author = {Rossi, Mario}, title = {Un titolo}, journaltitle = {Acta Astronautica}, date = {2019-05}}')
    )
    check('a biblatex entry is complete', zotero.status === 'ok', zotero.evidence)
    // ...but `date` counts as a year only when a year can be read out of it.
    const nodate = runCheck(
        'bib-entries-complete',
        bib('@article{k, author = {A}, title = {T}, journaltitle = {J}, date = {n.d.}}')
    )
    check('a date with no year in it is still no year', nodate.status === 'missing', nodate.evidence)
    check('and it says which field is missing', /no year/.test(nodate.evidence), nodate.evidence)
    // biblatex names a thesis's university `institution`, never `school`.
    const thesis = runCheck(
        'bib-entries-complete',
        bib('@phdthesis{k, author = {A}, title = {T}, date = {2019}, institution = {Universita di Bologna}}')
    )
    check('a biblatex thesis is complete', thesis.status === 'ok', thesis.evidence)
    // BC5-50: the field cap. A Zotero entry carries a long abstract and puts it
    // BEFORE the author, so the 4000-character walk that bounds a malformed .bib
    // fell inside the abstract and the entry read as "no author, no year".
    const long = runCheck(
        'bib-entries-complete',
        bib(`@article{k,\n  abstract = {${'parola '.repeat(700)}},\n  author = {Bianchi, Anna},\n  title = {T},\n  journal = {Acta},\n  year = {2020}\n}`)
    )
    check('a 5 KB abstract does not hide the author', long.status === 'ok', long.evidence)
    // and the cap is still doing its job: the walk is bounded, so this stays fast
    const many = Array.from({ length: 400 }, (_, i) => `@article{k${i},\n  abstract = {${'x'.repeat(4000)}},\n  author = {A},\n  title = {T},\n  journal = {J},\n  year = {2020}\n}`).join('\n')
    const t0 = Date.now()
    const bulk = runCheck('bib-entries-complete', bib(many))
    check('400 fat entries stay cheap', Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
    check('and all of them read as complete', bulk.status === 'ok', bulk.evidence)
}

// --- float-referenced / crossrefs-resolve: the whole reference vocabulary ---
{
    // FR2/FR3: \hyperref names its label in BRACKETS and \crefrange does not end in
    // the letters "ref", so neither was ever counted as a reference. The floats they
    // point at came back "never referenced": the author is sent to fix LaTeX that
    // is correct.
    const hyper = run(
        'float-referenced',
        R`\begin{figure}\caption{c}\label{fig:a}\end{figure} Come mostra \hyperref[fig:a]{la figura}.`
    )
    check('a \\hyperref[] reference counts', hyper.status === 'ok', hyper.evidence)
    const range = run(
        'float-referenced',
        R`\begin{figure}\caption{c}\label{fig:a}\end{figure}\begin{figure}\caption{d}\label{fig:b}\end{figure} \crefrange{fig:a}{fig:b}`
    )
    check('a \\crefrange reference counts for both ends', range.status === 'ok', range.evidence)
    // control: a float nothing points at is still reported
    const orphan = run(
        'float-referenced',
        R`\begin{figure}\caption{c}\label{fig:a}\end{figure}\begin{figure}\caption{d}\label{fig:orfana}\end{figure} \hyperref[fig:a]{la figura}`
    )
    check('and an unreferenced float is still found', orphan.status === 'missing', orphan.evidence)
    check('named by its own label', /fig:orfana/.test(orphan.evidence), orphan.evidence)

    // CR6: the same blindness answered "the document contains no cross-references"
    // on a document whose only reference was a \crefrange. "na" on a requirement the
    // document does answer is a requirement nobody checked.
    const cr = run('crossrefs-resolve', R`\label{fig:a}\label{fig:b}\crefrange{fig:a}{fig:b}`)
    check('a \\crefrange is a cross-reference', cr.status === 'ok', cr.evidence)
    const dangling = run('crossrefs-resolve', R`\label{sec:x}\ref{sec:x} \hyperref[sec:fantasma]{qui}`)
    check('a dangling \\hyperref is still dangling', dangling.status === 'missing', dangling.evidence)
    check(
        'and it is quoted the way it is written',
        /\\hyperref\[sec:fantasma\]/.test(dangling.evidence),
        dangling.evidence
    )
    // CR1: LastPage comes from the lastpage package, not from the document. "Pagina
    // X di \pageref{LastPage}" was reported as a reference to a label that does not
    // exist, and there is nothing the author can do about it.
    const lastpage = run('crossrefs-resolve', R`Pagina \thepage{} di \pageref{LastPage}. \label{x}\ref{x}`)
    check('\\pageref{LastPage} is not dangling', lastpage.status === 'ok', lastpage.evidence)
    check(
        'but the exception is exactly that one label',
        run('crossrefs-resolve', R`\pageref{LastPag}`).status === 'missing'
    )
}

// --- acronyms-in-headings: a title is a braced argument, not "up to the first }"
{
    // AH1/AH3: the title regex stopped at the first `}`, so a heading with any group
    // in it hid everything after the group. The same title without the \emph failed.
    const emph = run(
        'acronyms-in-headings',
        R`\acro{ADCS}{Attitude Determination and Control System}` + '\n' + R`\chapter{Il \emph{nuovo} ADCS del satellite}`
    )
    check('a nested group does not truncate the title', emph.status === 'missing', emph.evidence)
    const bold = run(
        'acronyms-in-headings',
        R`\acro{CFD}{Computational Fluid Dynamics}` + '\n' + R`\section{Analisi \textbf{numerica} CFD del profilo}`
    )
    check('and the same holds for \\textbf', bold.status === 'missing', bold.evidence)
    const clean = run(
        'acronyms-in-headings',
        R`\acro{CFD}{Computational Fluid Dynamics}` + '\n' + R`\section{Analisi \textbf{numerica} del profilo}`
    )
    check('a heading with no acronym still passes', clean.status === 'ok', clean.evidence)
}

// --- has-abstract: measure the abstract, not the rest of the file ----------
{
    // HA1: an EMPTY abstract environment in a file that then carries the thesis read
    // as "ok, 207 characters of text", because the length was measured to the end of
    // the file. The check exists to catch exactly that document.
    const thesis =
        'Questo capitolo introduce il lavoro svolto durante il tirocinio presso l azienda ospitante, ' +
        'con un testo abbastanza lungo da superare la soglia minima di caratteri del controllo.'
    const empty = run('has-abstract', R`\begin{abstract}\end{abstract}` + '\n' + thesis)
    check('an empty abstract environment is empty', empty.status === 'missing', empty.evidence)
    check('and the count is the abstract, not the file', /only 0 characters/.test(empty.evidence), empty.evidence)
    const real = run(
        'has-abstract',
        R`\begin{abstract}` + '\n' + thesis + '\n' + R`\end{abstract}` + '\n' + thesis
    )
    check('a real abstract is still found', real.status === 'ok', real.evidence)
    check('and its length is its own', /1[0-9][0-9] characters|[0-9][0-9] characters/.test(real.evidence), real.evidence)

    // HA2: the SAME defect through the spelling the real templates use. None of them
    // writes \begin{abstract}: they write a starred heading, or a table-of-contents
    // entry, and neither has a closing mark - so an empty one in a single-file thesis
    // still read "ok, 178 characters of text" after the environment was bounded. A
    // heading closes where the next sectioning command opens.
    const heading = run('has-abstract', R`\chapter*{Sommario}` + '\n' + R`\chapter{Introduzione}` + '\n' + thesis)
    check('an empty abstract heading is empty', heading.status === 'missing', heading.evidence)
    check('and it does not count the chapter under it', /only 0 characters/.test(heading.evidence), heading.evidence)
    const toc = run(
        'has-abstract',
        R`\addcontentsline{toc}{chapter}{Abstract}` + '\n' + R`\chapter{Introduzione}` + '\n' + thesis
    )
    check('and the same for a table-of-contents entry', toc.status === 'missing', toc.evidence)
    // ...and the control, twice: an abstract under a heading is still an abstract,
    // whether or not the thesis follows it in the same file.
    const alone = run('has-abstract', R`\chapter*{Sommario}` + '\n' + thesis)
    check('a real abstract alone in its file still passes', alone.status === 'ok', alone.evidence)
    const followed = run(
        'has-abstract',
        R`\chapter*{Sommario}` + '\n' + thesis + '\n' + R`\chapter{Introduzione}` + '\n' + thesis
    )
    check('and so does one the thesis follows', followed.status === 'ok', followed.evidence)
    // The strongest form of "measured on itself": the same abstract must be reported
    // with the same length whether or not the thesis follows it.
    check(
        'measured on itself, not on the chapters after it',
        followed.evidence === alone.evidence,
        `${followed.evidence} vs ${alone.evidence}`
    )
    // A template that writes the toc entry ABOVE the heading names the abstract
    // twice. The second name is not the start of the next chapter, and reading it as
    // one would report every such template as empty.
    const twice = run(
        'has-abstract',
        R`\addcontentsline{toc}{chapter}{Sommario}` +
            '\n' +
            R`\chapter*{Sommario}` +
            '\n' +
            thesis +
            '\n' +
            R`\chapter{Introduzione}`
    )
    check('an abstract named twice is found once', twice.status === 'ok', twice.evidence)
    // The command form closes at its own brace.
    const command = run('has-abstract', R`\abstract{}` + '\n' + thesis)
    check('an empty \\abstract{} is empty', command.status === 'missing', command.evidence)
    check(
        'and a full one is not',
        run('has-abstract', R`\abstract{` + thesis + R`}` + '\n' + R`\chapter{Introduzione}`).status === 'ok'
    )
}

// --- float-centered: a subfigure centres itself, not its parent -----------
{
    // FCN1: \centering inside the subfigures satisfied the outer float, which came
    // back "all 1 floats are centred" on a figure that is not centred.
    const sub = run(
        'float-centered',
        R`\begin{figure}\begin{subfigure}{0.4\textwidth}\centering\includegraphics{a}\end{subfigure}\caption{c}\end{figure}`
    )
    check('a subfigure does not centre its parent', sub.status === 'missing', sub.evidence)
    const both = run(
        'float-centered',
        R`\begin{figure}\centering\begin{subfigure}{0.4\textwidth}\centering\includegraphics{a}\end{subfigure}\caption{c}\end{figure}`
    )
    check('and a float that IS centred still passes', both.status === 'ok', both.evidence)
    // FCN2: a lone wrapfigure was counted in the problems and not in the total, so
    // the evidence read "1 problems on 0 floats".
    const wrap = run('float-centered', R`\begin{wrapfigure}{r}{0.4\textwidth}\includegraphics{a}\end{wrapfigure}`)
    check('a lone wrapfigure is a violation', wrap.status === 'missing', wrap.evidence)
    check('and the arithmetic makes sense', /1 of 1 floats/.test(wrap.evidence), wrap.evidence)
}

// --- citations-resolve: a multicite is one command and several keys -------
{
    const bib = { path: '/refs.bib', text: '@article{a, author={A}, title={T}, journal={J}, year={2020}}' }
    // CT2: only the first group was read, so a ghost key in the second one resolved
    // as "all 1 citations resolve".
    const multi = runCheck('citations-resolve', [{ path: '/thesis.tex', text: R`\cites{a}{fantasma}` }, bib])
    check('every group of a multicite is read', multi.status === 'missing', multi.evidence)
    check('and the ghost key is named', /fantasma/.test(multi.evidence), multi.evidence)
    // control: the ordinary forms must not gain phantom keys. A brace group that
    // follows after a SPACE is prose, not a citation.
    const ordinary = runCheck(
        'citations-resolve',
        [{ path: '/thesis.tex', text: R`\cite[p.~45]{a} e \textcite{a} {\bfseries testo in grassetto}` }, bib]
    )
    check('a group after a space is not a key', ordinary.status === 'ok', ordinary.evidence)
    check('and the count is right', /All 2 citations/.test(ordinary.evidence), ordinary.evidence)
}

// --- unit-spacing: a single capital letter in maths is a variable ---------
{
    // US1/US5: $0.5V$ is half of a volume, $0.25A$ a quarter of an area, $p = 1.5T$
    // a non-dimensional temperature. All three were reported as a value glued to its
    // unit, on a check nothing re-judges: the author is told to correct a formula
    // that is right.
    check('a single capital in maths is not a unit', status('unit-spacing', R`Il volume vale $0.5V$ e l area $0.25A$.`) === 'na')
    check('even in an equation', status('unit-spacing', R`\begin{equation}p = 1.5T\end{equation}`) === 'na')
    check('and in \\[ ... \\]', status('unit-spacing', R`\[ V = 0.5V \]`) === 'na')
    // US4: "con una tolleranza di 0.5, N è il numero di campioni" - N opens the next
    // clause, it is not a newton written with a comma.
    check(
        'a capital that opens the next clause is not a unit',
        status('unit-spacing', R`Con una tolleranza di 0.5, N è il numero di campioni.`) === 'na'
    )
    // control: the real findings this check exists for are untouched
    const glued = run('unit-spacing', R`La massa è 3.5kg e la lunghezza 2 m.`)
    check('a glued multi-letter unit is still found', glued.status === 'missing', glued.evidence)
    const volt = run('unit-spacing', R`La tensione è 12.5V mentre la corrente è 2 A.`)
    check('and a glued unit in PROSE is still found', volt.status === 'missing', volt.evidence)
    const comma = run('unit-spacing', R`La massa è 12.4,kg e la lunghezza 2 m.`)
    check('a comma before a real unit is still found', comma.status === 'missing', comma.evidence)
}

// --- decimal-separator: a section number is not a decimal ----------------
{
    // DS11: "nel paragrafo 3.2" counted as a point-decimal, which in a document that
    // writes every real decimal with a comma flipped the verdict to "both separators
    // are in use" and named the CORRECT commas as the less frequent ones.
    const section = run('decimal-separator', R`Nel paragrafo 3.2 il rendimento è 0,85 e la massa 12,4 kg.`)
    check('a hand-written section number is not a decimal', section.status === 'ok', section.evidence)
    check('and the convention read is the comma', /use the comma/.test(section.evidence), section.evidence)
    // the same, through the vocabulary the document teaches rather than the fixed one
    const learned = run(
        'decimal-separator',
        R`Come in Riquadro~\ref{r:a} e Riquadro~\ref{r:b}, nel Riquadro 4.2 il valore è 0,85 e la massa 12,4 kg.`
    )
    check('a learned reference word counts too', learned.status === 'ok', learned.evidence)
    // control: a real point-decimal in a comma document is still the finding
    const mixed = run('decimal-separator', R`Il rendimento è 0,85 e la massa 12,4 kg, con un rapporto di 3.2 punti.`)
    check('a real mixed convention is still reported', mixed.status === 'missing', mixed.evidence)
    check('naming the minority', /3\.2/.test(mixed.evidence), mixed.evidence)
}

// --- float-caption: what a macro produces is not inspected, and it says so -
{
    // FC5/FC11: a \newcommand or \newenvironment that wraps a float has ONE figure
    // environment in the source - its own definition - and the real floats are
    // wherever the macro is used. The check counted the definition and claimed "all
    // 1 float environments carry a \caption", which is a coverage claim it does not
    // have. Expanding TeX is out of scope; saying so is not.
    const wrapper = run(
        'float-caption',
        R`\newcommand{\figura}[3]{\begin{figure}\centering\includegraphics{#1}\caption{#2}\label{#3}\end{figure}}` +
            '\n' +
            R`\figura{a}{A}{fig:a}\figura{b}{B}{fig:b}\figura{c}{C}{fig:c}`
    )
    check('a macro-defined float is not judged as a float', wrapper.status === 'na', wrapper.evidence)
    check('and the evidence says why', /newcommand/.test(wrapper.evidence), wrapper.evidence)
    const env = run(
        'float-caption',
        R`\newenvironment{figura}[1]{\begin{figure}\centering}{\caption{#1}\end{figure}}` +
            '\n' +
            R`\begin{figura}{A}\includegraphics{a}\end{figura}`
    )
    check('the same for \\newenvironment', env.status === 'na', env.evidence)
    // A real float BESIDE a wrapper: the real one is judged, the claim is qualified.
    const mixed = run(
        'float-caption',
        R`\newcommand{\figura}[2]{\begin{figure}\includegraphics{#1}\caption{#2}\end{figure}}` +
            '\n' +
            R`\begin{figure}\includegraphics{b}\caption{B}\end{figure}`
    )
    check('a real float beside a wrapper is still judged', mixed.status === 'ok', mixed.evidence)
    check('and the claim is qualified', /not inspected/.test(mixed.evidence), mixed.evidence)
    const badMixed = run(
        'float-caption',
        R`\newcommand{\figura}[2]{\begin{figure}\includegraphics{#1}\caption{#2}\end{figure}}` +
            '\n' +
            R`\begin{figure}\includegraphics{b}\end{figure}`
    )
    check('and a captionless real float is still a defect', badMixed.status === 'missing', badMixed.evidence)
    // control: an ordinary document must gain no caveat at all
    check(
        'a document with no macros says nothing about macros',
        !/not inspected/.test(run('float-caption', R`\begin{figure}\includegraphics{a}\caption{A}\end{figure}`).evidence)
    )
}

// --- TRIPWIRES for the scans these fixes added ---------------------------
// Generous ceilings on purpose: the claim is "still linear", not "still N ms". Every
// one of these runs inside the request, on a single-threaded process, over LaTeX any
// student can upload.
{
    const paragraph = 'Il rendimento vale 0,85 e la massa 12,4 kg in condizioni nominali. '
    const big = paragraph.repeat(4000) // ~260 KB
    for (const name of ['decimal-separator', 'unit-spacing', 'float-caption', 'float-centered', 'crossrefs-resolve']) {
        const t = Date.now()
        runCheck(name, doc(big))
        check(`${name} on 260 KB of prose`, Date.now() - t < 4000, `${Date.now() - t} ms`)
    }
    // maths spans, macro regions and nested-float blanking on their worst shapes
    const maths = R`Il valore $0.5V$ e la massa $1.2kg$ in condizioni nominali. `.repeat(3000)
    let t = Date.now()
    runCheck('unit-spacing', doc(maths))
    check('unit-spacing on 3000 maths spans', Date.now() - t < 4000, `${Date.now() - t} ms`)
    const macros = R`\newcommand{\figura}[2]{\begin{figure}\includegraphics{#1}\caption{#2}\end{figure}}` + '\n'
    t = Date.now()
    runCheck('float-caption', doc(macros.repeat(2000)))
    check('float-caption on 2000 macro definitions', Date.now() - t < 4000, `${Date.now() - t} ms`)
    // an unterminated \newcommand{ must not walk to the end of the file
    t = Date.now()
    runCheck('float-caption', doc(R`\newcommand{`.repeat(3000) + 'x'.repeat(200000)))
    check('3000 unterminated \\newcommand stay bounded', Date.now() - t < 4000, `${Date.now() - t} ms`)
    const subs = R`\begin{figure}\centering\begin{subfigure}{a}\centering x\end{subfigure}\caption{c}\end{figure}` + '\n'
    t = Date.now()
    runCheck('float-centered', doc(subs.repeat(2000)))
    check('float-centered on 2000 subfigures', Date.now() - t < 4000, `${Date.now() - t} ms`)
    // a .bib of many entries: the field scan reads every entry to the next one, so
    // the whole file is read once and not once per entry
    const entries = Array.from(
        { length: 4000 },
        (_, i) => `@article{k${i}, author = {A}, title = {T}, journaltitle = {J}, date = {2020-01}}`
    ).join('\n')
    t = Date.now()
    runCheck('bib-entries-complete', [{ path: '/thesis.tex', text: R`\cite{k0}` }, { path: '/refs.bib', text: entries }])
    check('bib-entries-complete on 4000 entries', Date.now() - t < 4000, `${Date.now() - t} ms`)
}

// ===========================================================================
// language-support: the quiet branch, and why it is tested HERE
// ===========================================================================
// This block must stay ABOVE every setChecksLanguage call in this file. The checks
// carry a module-global language, and language-support is the one check that asks a
// question ABOUT it: with no language declared for the run it must stay `na` rather
// than judge the document against the English default nobody chose. Once any suite
// sets a language the flag is on for the rest of the process, so the unset case can
// only be pinned before that happens.
{
    const accented = R`\documentclass{book}\usepackage{graphicx}
La perturbazione è già più che sufficiente per la citt`.concat('à.')
    const r = run('language-support', accented)
    check('with no rubric language set the check is quiet', r.status === 'na', r.evidence)
    check('and says why', /No rubric language is set/.test(r.evidence), r.evidence)
}

// ===========================================================================
// bib-duplicates
// ===========================================================================
{
    const project = body => [
        { path: '/thesis.tex', text: R`\cite{a}\bibliography{refs}` },
        { path: '/refs.bib', text: body },
    ]
    const entry = (key, fields) => `@article{${key},\n${fields}\n  journal = {Acta},\n  year = {2019}\n}`
    // VIOLATES: one paper exported twice, once from the DOI and once from a PDF import.
    const sameTitle = runCheck(
        'bib-duplicates',
        project(
            entry('rossi2019', '  author = {Rossi, M.},\n  title = {A survey of attitude determination methods}') +
                '\n' +
                entry('rossi19a', '  author = {Rossi, Mario},\n  title = {A Survey of Attitude Determination Methods}')
        )
    )
    check('the same title under two keys is missing', sameTitle.status === 'missing', sameTitle.evidence)
    check('and both keys are named', /rossi19a and rossi2019/.test(sameTitle.evidence), sameTitle.evidence)
    check('and it points at the second entry', sameTitle.locations[0].path === '/refs.bib', JSON.stringify(sameTitle.locations))
    // SATISFIES: two different works that share the opening words of their titles.
    const distinct = runCheck(
        'bib-duplicates',
        project(
            entry('a', '  author = {A},\n  title = {A comparison of guidance laws for reentry}') +
                '\n' +
                entry('b', '  author = {B},\n  title = {A comparison of guidance systems for reentry}')
        )
    )
    check('two different works are ok', distinct.status === 'ok', distinct.evidence)
    check('and the count of what was compared is stated', /compared by title/.test(distinct.evidence), distinct.evidence)
    // DOES NOT APPLY: nothing to compare an entry with.
    const alone = runCheck('bib-duplicates', project(entry('a', '  author = {A},\n  title = {A single lonely work}')))
    check('a bibliography of one entry is na', alone.status === 'na', alone.evidence)
    check('no .bib at all is na', status('bib-duplicates', 'plain prose') === 'na')
    const byHand = run(
        'bib-duplicates',
        R`\begin{thebibliography}{9}\bibitem{a}Rossi, M. \bibitem{b}Rossi, M. \end{thebibliography}`
    )
    check('a hand-written bibliography is na', byHand.status === 'na', byHand.evidence)
    check('and says the entries carry no fields', /no fields/.test(byHand.evidence), byHand.evidence)
    // The LaTeX a real .bib contains: braces around a protected word, an accent typed
    // the LaTeX way, and a DOI written as a URL in one entry and bare in the other.
    const markup = runCheck(
        'bib-duplicates',
        project(
            entry('one', '  author = {A},\n  title = {{The} Rise of Modern Aerodynamics}') +
                '\n' +
                entry('two', '  author = {B},\n  title = {The rise of modern aerodynamics}')
        )
    )
    check('braces and case do not hide a duplicate', markup.status === 'missing', markup.evidence)
    const accents = runCheck(
        'bib-duplicates',
        project(
            entry('one', '  author = {A},\n  title = {Universit\\`a e ricerca applicata al volo}') +
                '\n' +
                entry('two', '  author = {B},\n  title = {Università e ricerca applicata al volo}')
        )
    )
    check('an accent typed two ways does not hide a duplicate', accents.status === 'missing', accents.evidence)
    const doi = runCheck(
        'bib-duplicates',
        project(
            entry('one', '  author = {A},\n  title = {One title},\n  doi = {10.1000/xyz123}') +
                '\n' +
                entry('two', '  author = {B},\n  title = {A completely different title},\n  doi = {https://doi.org/10.1000/XYZ123}')
        )
    )
    check('the same DOI under two keys is missing', doi.status === 'missing', doi.evidence)
    check('and the DOI is quoted', /10\.1000\/xyz123/.test(doi.evidence), doi.evidence)
    // The containment case, which is what a field value truncated at a comma produces.
    const contained = runCheck(
        'bib-duplicates',
        project(
            entry('one', '  author = {A},\n  title = {A comparison of guidance laws for atmospheric reentry}') +
                '\n' +
                entry('two', '  author = {B},\n  title = {A comparison of guidance laws for atmospheric reentry vehicles}')
        )
    )
    check('one title contained in the other is reported', contained.status === 'missing', contained.evidence)
    check('and the fact is stated as containment', /beginning of the title/.test(contained.evidence), contained.evidence)
    // ...and a SHORT title is not evidence of anything: two "Report" entries are two
    // different reports far more often than one report entered twice.
    const shortTitles = runCheck(
        'bib-duplicates',
        project(entry('one', '  author = {A},\n  title = {Report}') + '\n' + entry('two', '  author = {B},\n  title = {Report}'))
    )
    check('two short identical titles are not a finding', shortTitles.status === 'na', shortTitles.evidence)
    // While reading the entry types for the duplicate scan: the venue table was thin
    // for biblatex. It writes ONE thesis type (@thesis, with `type` saying which), and
    // an online source as @online, so neither was asked for a venue at all and a thesis
    // with no university read as complete.
    const thesis = runCheck(
        'bib-duplicates',
        project('@thesis{k, author = {A}, title = {A long enough title here}, date = {2019}}')
    )
    check('a biblatex @thesis is still an entry', thesis.status === 'na', thesis.evidence)
    const noSchool = runCheck(
        'bib-entries-complete',
        project('@thesis{k, author = {A}, title = {T}, date = {2019}}')
    )
    check('a biblatex thesis with no university is incomplete', noSchool.status === 'missing', noSchool.evidence)
    const withSchool = runCheck(
        'bib-entries-complete',
        project('@thesis{k, author = {A}, title = {T}, date = {2019}, institution = {Universita di Bologna}}')
    )
    check('and one that names it is complete', withSchool.status === 'ok', withSchool.evidence)
    const online = runCheck(
        'bib-entries-complete',
        project('@online{k, author = {A}, title = {T}, date = {2019}}')
    )
    check('an online source with no address is incomplete', online.status === 'missing', online.evidence)
    const withUrl = runCheck(
        'bib-entries-complete',
        project('@online{k, author = {A}, title = {T}, date = {2019}, url = {https://example.com}}')
    )
    check('and one with a url is complete', withUrl.status === 'ok', withUrl.evidence)
    const howPublished = runCheck(
        'bib-entries-complete',
        project('@online{k, author = {A}, title = {T}, date = {2019}, howpublished = {https://example.com}}')
    )
    check('howpublished is where BibTeX users put it', howPublished.status === 'ok', howPublished.evidence)
    // @misc stays exempt: demanding a venue of it would report a false violation on
    // every dataset, standard and piece of software a thesis cites.
    const misc = runCheck('bib-entries-complete', project('@misc{k, author = {A}, title = {T}, date = {2019}}'))
    check('a @misc is still asked for no venue', misc.status === 'ok', misc.evidence)
}

// ===========================================================================
// symbol-list
// ===========================================================================
{
    const declared = R`\nomenclature{$\alpha$}{angle of attack}`
    // VIOLATES: a symbol in the list that no formula ever writes.
    const unused = run(
        'symbol-list',
        declared + '\n' + R`\nomenclature{$\beta$}{sideslip}` + '\n' + R`\begin{equation}\alpha = 1\end{equation}`
    )
    check('a declared symbol no formula uses is missing', unused.status === 'missing', unused.evidence)
    check('and the unused one is named', /\\beta never appears/.test(unused.evidence), unused.evidence)
    // SATISFIES.
    const clean = run('symbol-list', declared + '\n' + R`\begin{equation}\alpha = \alpha\end{equation}`)
    check('a list that matches the maths is ok', clean.status === 'ok', clean.evidence)
    // DOES NOT APPLY: no declaration a parser can read.
    const none = run('symbol-list', R`\begin{equation}\alpha = \beta\end{equation}`)
    check('no declared symbols at all is na', none.status === 'na', none.evidence)
    check('and the na says a hand-made table is not read', /typeset by hand as a table/.test(none.evidence), none.evidence)
    // The other direction, reported as CANDIDATES and never as an exact violation.
    const missingFromList = run('symbol-list', declared + '\n' + R`\begin{equation}\alpha = \beta\end{equation}`)
    check('a symbol used but not declared is partial', missingFromList.status === 'partial', missingFromList.evidence)
    check('and it is labelled as a candidate', /candidates/.test(missingFromList.evidence), missingFromList.evidence)
    // REGRESSION: the declaration writes its own symbol in maths mode. Reading it as a
    // use would make every declared symbol "used" and the check could never fire.
    const declarationOnly = run('symbol-list', declared + '\n' + R`\begin{equation}x = 1\end{equation}`)
    check('a declaration is not a use of its own symbol', /\\alpha never appears/.test(declarationOnly.evidence), declarationOnly.evidence)
    // The dummies: an index that only ever appears as a subscript is not a quantity.
    const dummies = run('symbol-list', declared + '\n' + R`\begin{equation}\alpha_{i} = \sum_{j=1}^{n} \alpha_{k}\end{equation}`)
    check('index letters used only as subscripts are damped', dummies.status === 'ok', dummies.evidence)
    // ...but the same letter standing alone is a quantity and stays a candidate.
    const standalone = run('symbol-list', declared + '\n' + R`\begin{equation}n = \alpha + 1\end{equation}`)
    check('the same letter standing alone is not damped', standalone.status === 'partial', standalone.evidence)
    // The variants a real thesis declares its symbols with.
    const braced = run('symbol-list', R`\nomenclature{$\vec{v}$}{velocity}` + '\n' + R`\begin{equation}\vec{v} = 0\end{equation}`)
    check('a braced symbol is read past its inner group', braced.status === 'ok', braced.evidence)
    const glossaries = run(
        'symbol-list',
        R`\newglossaryentry{alpha}{name={alpha},symbol={\alpha},description={angle}}` +
            '\n' +
            R`\begin{equation}x = 1\end{equation}`
    )
    check('a glossaries symbol entry declares a symbol', glossaries.status === 'missing', glossaries.evidence)
    const glsxtr = run(
        'symbol-list',
        R`\glsxtrnewsymbol[angle of attack]{alpha}{\alpha}` + '\n' + R`\begin{equation}x = 1\end{equation}`
    )
    check('\\glsxtrnewsymbol declares a symbol', glsxtr.status === 'missing', glsxtr.evidence)
    // An inline formula counts as maths for the "declared and never used" direction:
    // a symbol used in $...$ is used, wherever the author put it.
    const inline = run('symbol-list', declared + '\n' + R`Il valore di $\alpha$ resta piccolo.`)
    check('a symbol used inline is used', /All 1 declared symbols/.test(inline.evidence), inline.evidence)
    // A word set in maths is not a symbol: \mathrm{d} must not mint a candidate "d".
    const mathsWord = run('symbol-list', declared + '\n' + R`\begin{equation}\alpha = \mathrm{d}\end{equation}`)
    check('a word set in maths is not a symbol', mathsWord.status === 'ok', mathsWord.evidence)
}

// ===========================================================================
// math-notation
// ===========================================================================
check('a bare operator name in maths is missing', status('math-notation', R`The value $y = sin(x)$ holds.`) === 'missing')
check('the same name with a backslash is ok', status('math-notation', R`The value $y = \sin(x)$ holds.`) === 'ok')
check('no maths at all is na, not ok', status('math-notation', 'prose with no formula in it') === 'na')
{
    // The document that writes it BOTH ways is the strongest case, and the evidence
    // has to say so: this is an inconsistency, not just a habit.
    const both = run('math-notation', R`First $y = \sin(x)$ and later $z = sin(t)$.`)
    check('a bare name beside its backslash form is named as such', /also writes \\sin/.test(both.evidence), both.evidence)
    // x_{min} is a subscript that reads like an operator: writing \min there would
    // produce a formula that is wrong.
    check('a subscript that reads like an operator is not one', status('math-notation', R`The value $x_{min} + y_{max}$ is small.`) === 'ok')
    // \mathrm{max} and \operatorname{sgn} are how an operator is written correctly.
    check('an operator set upright is not a bare name', status('math-notation', R`The value $x = \mathrm{max}(a,b)$ holds.`) === 'ok')
}
{
    // The same symbol in two vector styles.
    const mixed = run('math-notation', R`We write $\vec{v}$ here and $\mathbf{v}$ there.`)
    check('one symbol in two vector styles is missing', mixed.status === 'missing', mixed.evidence)
    check('and both spellings are quoted', /\\vec.*\\mathbf|\\mathbf.*\\vec/.test(mixed.evidence), mixed.evidence)
    check('and the global counts are given', /arrow uses and .* bold uses/.test(mixed.evidence), mixed.evidence)
    // Bold matrices beside arrow vectors is a convention, not a defect.
    const convention = run('math-notation', R`The matrix $\mathbf{A}$ acts on $\vec{v}$ and on $\vec{w}$.`)
    check('two symbols in two styles is a convention, not a defect', convention.status === 'ok', convention.evidence)
    // \bm and \boldsymbol are the same style as \mathbf.
    const bm = run('math-notation', R`We write $\vec{v}$ here and $\bm{v}$ there.`)
    check('\\bm is bold like \\mathbf', bm.status === 'missing', bm.evidence)
}
{
    // Both differentials in one document. Which one is right is the rubric's business.
    const mixed = run('math-notation', R`\begin{equation}\int_0^T f(t)\,\mathrm{d}t\end{equation} and $\int g(x) dx$`)
    check('two differential styles is missing', mixed.status === 'missing', mixed.evidence)
    check('and the fact is stated as a mixture, not as a rule', /Both differentials are in use/.test(mixed.evidence), mixed.evidence)
    check('and it refuses to say which is right', /not decided here/.test(mixed.evidence), mixed.evidence)
    const onlyUpright = run('math-notation', R`\begin{equation}\int_0^T f(t)\,\mathrm{d}t\end{equation}`)
    check('one style throughout is ok', onlyUpright.status === 'ok', onlyUpright.evidence)
    const onlyPlain = run('math-notation', R`\begin{equation}\int_0^T f(t) dt\end{equation}`)
    check('and so is the other one', onlyPlain.status === 'ok', onlyPlain.evidence)
    // A bare "d" outside an integral or a derivative is a variable: reporting it would
    // hand the author a correction on a formula that is right.
    const notADifferential = run('math-notation', R`\begin{equation}a = b \cdot d h\end{equation} and $\mathrm{d}x$ elsewhere`)
    check('a d with no integral around it is not a differential', notADifferential.status === 'ok', notADifferential.evidence)
}

// ===========================================================================
// tables-as-images
// ===========================================================================
check(
    'a graphic inside a tabular is missing',
    status('tables-as-images', R`\begin{table}\caption{Results}\begin{tabular}{c}\includegraphics{shot.png}\end{tabular}\end{table}`) ===
        'missing'
)
check(
    'a real tabular is ok',
    status('tables-as-images', R`\begin{table}\caption{Results}\begin{tabular}{cc}a & b\end{tabular}\end{table}`) === 'ok'
)
check('no table and no captioned figure is na', status('tables-as-images', 'prose only, nothing floating') === 'na')
{
    // A tabular is also how two graphics are put side by side INSIDE a figure. That is
    // a layout, and reporting it would fire on one of the most ordinary constructions
    // a thesis contains.
    const sideBySide = run(
        'tables-as-images',
        R`\begin{figure}\centering\begin{tabular}{cc}\includegraphics{a} & \includegraphics{b}\end{tabular}\caption{Two views}\end{figure}`
    )
    check('two graphics side by side in a figure are a layout', sideBySide.status === 'ok', sideBySide.evidence)
    // A graphic inside a table nested in a tabular is reported ONCE, against the
    // innermost environment, or the same picture is counted twice.
    const nested = run(
        'tables-as-images',
        R`\begin{table}\caption{C}\begin{tabular}{c}\includegraphics{shot.png}\end{tabular}\end{table}`
    )
    check('a nested graphic is reported once', nested.locations.length === 1, JSON.stringify(nested.locations))
    check('and against the innermost environment', /inside a tabular/.test(nested.evidence), nested.evidence)
}
{
    // The second shape: a figure that calls itself a table. The word is the rubric's
    // language, and nothing else in the check knows a word of any language.
    const english = run('tables-as-images', R`\begin{figure}\includegraphics{a}\caption{Table of the measured masses}\end{figure}`)
    check('a figure captioned "Table" is missing', english.status === 'missing', english.evidence)
    const italian = R`\begin{figure}\includegraphics{a}\caption{Tabella delle masse misurate}\end{figure}`
    check('and an Italian caption is not, for an English rubric', status('tables-as-images', italian) === 'ok')
    setChecksLanguage('it')
    check('but it is for an Italian one', status('tables-as-images', italian) === 'missing', run('tables-as-images', italian).evidence)
    check(
        'and the evidence is in Italian too',
        /didascalia comincia con/.test(run('tables-as-images', italian).evidence),
        run('tables-as-images', italian).evidence
    )
    setChecksLanguage('en')
    // The caption may open with markup: the first WORD is what counts.
    const bold = run('tables-as-images', R`\begin{figure}\includegraphics{a}\caption{\textbf{Table} of the masses}\end{figure}`)
    check('markup before the word does not hide it', bold.status === 'missing', bold.evidence)
    // ...and a figure whose caption merely mentions a table further on is not one.
    const mentions = run(
        'tables-as-images',
        R`\begin{figure}\includegraphics{a}\caption{The masses reported in the table above}\end{figure}`
    )
    check('a caption that mentions a table later is not a finding', mentions.status === 'ok', mentions.evidence)
}

// ===========================================================================
// heading-sequence
// ===========================================================================
{
    // VIOLATES: a chapter title with the first section straight under it.
    const stacked = '\\chapter{Introduction}\n\\section{Context}\nSome real text here.\n\\section{Aims}\nMore text.'
    const r = run('heading-sequence', stacked)
    check('a heading followed straight by another is missing', r.status === 'missing', r.evidence)
    check('and both titles are quoted', /Introduction.*Context/.test(r.evidence), r.evidence)
    // A label belongs to the heading above it and is not body text.
    const labelled = '\\chapter{Introduction}\n\\label{cap:intro}\n\\clearpage\n\\section{Context}\nText.\n\\section{Aims}\nText.'
    check('a label between two headings is not body text', status('heading-sequence', labelled) === 'missing', run('heading-sequence', labelled).evidence)
    // SATISFIES.
    const withText = '\\chapter{Introduction}\nA paragraph of introduction.\n\\section{Context}\nText.\n\\section{Aims}\nText.'
    check('a heading followed by text is ok', status('heading-sequence', withText) === 'ok', run('heading-sequence', withText).evidence)
    // DOES NOT APPLY.
    check('fewer than two headings is na', status('heading-sequence', '\\chapter{Only one}\nText.') === 'na')
    // A float or an environment between the two IS body: the check must not read an
    // environment as markup.
    const withFigure =
        '\\chapter{Introduction}\n\\begin{figure}\\includegraphics{a}\\caption{C}\\end{figure}\n\\section{Context}\nText.\n\\section{Aims}\nText.'
    check('a float between two headings is body', status('heading-sequence', withFigure) === 'ok', run('heading-sequence', withFigure).evidence)
}
{
    // The second fact: numbering nobody needs.
    const lonely = '\\chapter{One}\nText here.\n\\section{Only}\nText there.\n\\chapter{Two}\nText.\n\\section{A}\nx\n\\section{B}\ny'
    const r = run('heading-sequence', lonely)
    check('a division with exactly one subdivision is missing', r.status === 'missing', r.evidence)
    check('and it names the pair', /contains exactly one section/.test(r.evidence), r.evidence)
    const two = '\\chapter{One}\nText.\n\\section{A}\nx\n\\section{B}\ny'
    check('two subdivisions are fine', status('heading-sequence', two) === 'ok', run('heading-sequence', two).evidence)
    // An unnumbered heading has no numbering to be pointless about.
    const starred = '\\chapter*{Acknowledgements}\nText.\n\\section*{Thanks}\nMore text.\n\\chapter{One}\nx\n\\section{A}\ny\n\\section{B}\nz'
    check('an unnumbered pair is not counted', status('heading-sequence', starred) === 'ok', run('heading-sequence', starred).evidence)
    // A \subsection under a \section counts the same way.
    const subs = '\\section{One}\nText.\n\\subsection{Only}\nText.\n\\section{Two}\nText.\n\\subsection{A}\nx\n\\subsection{B}\ny'
    check('a section with one subsection is caught too', status('heading-sequence', subs) === 'missing', run('heading-sequence', subs).evidence)
}
{
    // A heading written inside a macro definition is a template: its title is a macro
    // parameter, and judging it judges a document that does not exist.
    const macro = R`\newcommand{\mychapter}[1]{\chapter{#1}\label{cap:#1}}
\mychapter{Introduction}
Some text of the real document.`
    check('a heading inside a macro definition is not a heading', status('heading-sequence', macro) === 'na', run('heading-sequence', macro).evidence)
}

// ===========================================================================
// appendix-referenced
// ===========================================================================
{
    const project = R`\chapter{Introduction}
See \ref{app:code} for the listing.
\appendix
\chapter{The code}
\label{app:code}
Text.
\chapter{The data}
\label{app:data}
More text.`
    const r = run('appendix-referenced', project)
    check('an appendix nobody references is missing', r.status === 'missing', r.evidence)
    check('and the referenced one is not reported', !/app:code/.test(r.evidence), r.evidence)
    const both = project.replace('See \\ref{app:code} for the listing.', 'See \\ref{app:code} and \\ref{app:data}.')
    check('every appendix referenced is ok', status('appendix-referenced', both) === 'ok', run('appendix-referenced', both).evidence)
    check('no appendix at all is na', status('appendix-referenced', '\\chapter{Introduction}\nText only.') === 'na')
    // The environment form, which is what the appendix package asks for.
    const environment = R`\chapter{Introduction}
Text with no reference.
\begin{appendices}
\chapter{The code}
\label{app:code}
Listing.
\end{appendices}`
    check('the appendices environment is read too', status('appendix-referenced', environment) === 'missing', run('appendix-referenced', environment).evidence)
    // An appendix with no \label cannot be referenced by any means: counted, declared,
    // not judged. Same rule float-referenced already carries.
    const unlabelled = R`\chapter{Introduction}
See \ref{app:code}.
\appendix
\chapter{The code}
\label{app:code}
Text.
\chapter{The data}
More text.`
    const u = run('appendix-referenced', unlabelled)
    check('an unlabelled appendix is not judged', u.status === 'ok', u.evidence)
    check('but it is declared', /no \\label/.test(u.evidence), u.evidence)
    // A reference from INSIDE the appendices is not the text sending the reader there.
    const selfReferenced = R`\chapter{Introduction}
Text with no reference at all.
\appendix
\chapter{The code}
\label{app:code}
See \ref{app:data} for the numbers.
\chapter{The data}
\label{app:data}
Numbers.`
    const s = run('appendix-referenced', selfReferenced)
    check('a reference from inside the appendices is told apart', /only referenced from inside/.test(s.evidence), s.evidence)
    // The sections INSIDE an appendix are not appendices: only the shallowest headings
    // after the switch are, or every section of an appendix would need a reference.
    const withSections = R`\chapter{Introduction}
See \ref{app:code}.
\appendix
\chapter{The code}
\label{app:code}
\section{The parser}
\label{sec:parser}
Text.`
    check('a section inside an appendix is not an appendix', status('appendix-referenced', withSections) === 'ok', run('appendix-referenced', withSections).evidence)
}

// ===========================================================================
// reference-style-mixing
// ===========================================================================
{
    // VIOLATES: the same class of object introduced by two different words.
    const mixed = 'Vedi la Figura~\\ref{fig:a} e poi la Fig.~\\ref{fig:b} e ancora la Figura~\\ref{fig:c}.'
    const r = run('reference-style-mixing', mixed)
    check('two words for one kind of object is missing', r.status === 'missing', r.evidence)
    check('and both words are quoted with their counts', /"figura" x2/.test(r.evidence) && /"fig\." x1/.test(r.evidence), r.evidence)
    // SATISFIES: one word per class, two classes.
    const clean = 'Vedi la Figura~\\ref{fig:a} e la Figura~\\ref{fig:b} e la Tabella~\\ref{tab:x}.'
    check('one word per kind is ok', status('reference-style-mixing', clean) === 'ok', run('reference-style-mixing', clean).evidence)
    // DOES NOT APPLY: no reference is introduced by a word at all.
    check('no naming word anywhere is na', status('reference-style-mixing', 'Plain prose with no references.') === 'na')
    const bare = 'Come mostrato in \\autoref{fig:a} e in \\autoref{fig:b}.'
    check('a package that prints the word itself is na', status('reference-style-mixing', bare) === 'na', run('reference-style-mixing', bare).evidence)
    // A plural is the same word inflected, not a second style: reporting it would
    // accuse every document that ever writes "le Figure 3 e 4".
    const plural = 'Vedi la Figura~\\ref{fig:a} e le Figure~\\ref{fig:b} e ancora la Figura~\\ref{fig:c}.'
    check('a plural is not a second style', status('reference-style-mixing', plural) === 'ok', run('reference-style-mixing', plural).evidence)
    // An article or a preposition is not the name of anything: the same stopset
    // manual-numbering already needs.
    const stopwords = 'Come si vede nel~\\ref{cap:uno} e nella~\\ref{cap:due} e nel~\\ref{cap:tre}.'
    check('articles and prepositions are not names', status('reference-style-mixing', stopwords) === 'na', run('reference-style-mixing', stopwords).evidence)
    // A number typed by hand joins the class of the references written properly.
    const handWritten = 'Come mostra la Fig.~\\ref{fig:uno}, il modello regge. La Figura 3 mostra il dettaglio.'
    const h = run('reference-style-mixing', handWritten)
    check('a hand-written number is a style of its own class', h.status === 'missing', h.evidence)
    check('and a year is not a hand-written reference', status('reference-style-mixing', 'La Fig.~\\ref{fig:uno} del 1974 e la Fig.~\\ref{fig:due}.') === 'ok')
}

// ===========================================================================
// italic-coherence
// ===========================================================================
{
    const mixed = R`The term \textit{payload} matters. The payload is small, and the payload is heavy.`
    const r = run('italic-coherence', mixed)
    check('a word emphasised once and plain elsewhere is missing', r.status === 'missing', r.evidence)
    check('and both counts are given', /emphasised 1 time and set in roman 2 times/.test(r.evidence), r.evidence)
    check('a word emphasised and never repeated is ok', status('italic-coherence', R`The term \textit{payload} appears once.`) === 'ok')
    check('no emphasis at all is na', status('italic-coherence', 'No emphasis anywhere in this text.') === 'na')
    // \emph is the same thing written the semantic way.
    const emph = R`The term \emph{payload} matters. The payload is small.`
    check('\\emph counts as emphasis', status('italic-coherence', emph) === 'missing', run('italic-coherence', emph).evidence)
    // A command name is not a word the reader sees.
    const commands = R`Text \textit{centering} here. \centering \centering \centering`
    check('a command name is not a word', status('italic-coherence', commands) === 'ok', run('italic-coherence', commands).evidence)
    // Short words are not evidence of anything: "the" italicised once says nothing, so
    // there is nothing left to compare and the honest answer is na, not ok.
    const short = R`Text \textit{the} here. The word the appears again and again.`
    const s = run('italic-coherence', short)
    check('words shorter than four letters are ignored', s.status === 'na', s.evidence)
    check('and the na says what was left out', /four letters or more/.test(s.evidence), s.evidence)
    // A symbol name inside maths is not prose.
    const maths = R`The term \textit{alpha} matters, and $\alpha = 1$ and $alpha$ hold.`
    check('maths is not prose', status('italic-coherence', maths) === 'ok', run('italic-coherence', maths).evidence)
    // A label or a file name is an identifier, not prose.
    const identifiers = R`The term \textit{payload} matters. \label{sec:payload}\includegraphics{payload.png}`
    check('an identifier is not prose', status('italic-coherence', identifiers) === 'ok', run('italic-coherence', identifiers).evidence)
}

// ===========================================================================
// tie-before-ref
// ===========================================================================
// The rule is ChkTeX's, reached through the CheckMyTex project (MIT).
{
    const loose = 'As shown in Figure \\ref{fig:a} and in Figure~\\ref{fig:b}.'
    const r = run('tie-before-ref', loose)
    check('an ordinary space before a reference is missing', r.status === 'missing', r.evidence)
    check('and the counts are given', /1 of 2 /.test(r.evidence), r.evidence)
    check('every reference tied is ok', status('tie-before-ref', 'As in Figure~\\ref{fig:a} and Table~\\ref{tab:b}.') === 'ok')
    check('no reference at all is na', status('tie-before-ref', 'Plain prose with nothing to point at.') === 'na')
    // A reference glued to the word before it is the other half of the same defect.
    const glued = run('tie-before-ref', 'As shown in Figure\\ref{fig:a} and Figure~\\ref{fig:b}.')
    check('a reference with no space is reported too', glued.status === 'missing', glued.evidence)
    check('and told apart from the loose one', /no space at all/.test(glued.evidence), glued.evidence)
    // A bracket, a full stop or the start of a line is not a word the reference has to
    // stay with, so it is not counted at all. The newline case matters: a reference that
    // opens a line after a full stop is the source wrapping, not a break a reader sees.
    const neutral = run('tie-before-ref', 'The result is proved (\\ref{eq:one}) and holds; [\\ref{eq:two}] too.\n\\ref{eq:three} opens a line.')
    check('a reference after a bracket or a full stop is not counted', neutral.status === 'na', neutral.evidence)
    // A thin space is as unbreakable as a tie.
    check('a thin space counts as tied', status('tie-before-ref', 'As in Figure\\,\\ref{fig:a} and Table~\\ref{tab:b}.') === 'ok')
    // A citation is the same rule, and \cite comes in a dozen spellings.
    const cites = run('tie-before-ref', 'As Rossi \\citep{rossi} and Bianchi~\\cite{bianchi} write.')
    check('a citation counts as well', cites.status === 'missing', cites.evidence)
    // \href ends in the letters "ref" and is not a reference: the same trap the
    // reference collector at the top of the module already carries.
    check('a \\href is not a reference', status('tie-before-ref', 'See \\href{http://example.com}{the site} for more.') === 'na')
    // A line break before the reference is exactly what the tie prevents.
    const wrapped = run('tie-before-ref', 'As shown in Figure\n\\ref{fig:a} and Figure~\\ref{fig:b}.')
    check('a line break before a reference is breakable', wrapped.status === 'missing', wrapped.evidence)
}

// ===========================================================================
// typographic-input
// ===========================================================================
// Both rules are ChkTeX's, reached through the CheckMyTex project (MIT).
{
    const r = run('typographic-input', 'He said "hello" and then paused... for a while.')
    check('straight quotes and literal dots are missing', r.status === 'missing', r.evidence)
    check('and both are counted', /2 straight double quotes and 1 ellipses/.test(r.evidence), r.evidence)
    const good = "He said ``hello'' and then paused\\dots for a while."
    check('the LaTeX spellings are ok', status('typographic-input', good) === 'ok', run('typographic-input', good).evidence)
    check('and they are counted as well written', /written the right way/.test(run('typographic-input', good).evidence))
    // DOES NOT APPLY: a file with no prose outside listings and maths.
    const listing = R`\begin{lstlisting}` + '\nprint("hi...")\n' + R`\end{lstlisting}`
    const l = run('typographic-input', listing)
    check('a document with no prose is na', l.status === 'na', l.evidence)
    // ...and the same listing beside real prose is still not read.
    const beside = listing + '\nThe program prints a greeting.'
    check('a quote shown in a listing is not typed in the prose', status('typographic-input', beside) === 'ok', run('typographic-input', beside).evidence)
    // A URL is an address: its dots and quotes are part of it.
    const url = 'See https://example.com/a...b for the data set of the experiment.'
    check('a bare link is not an ellipsis', status('typographic-input', url) === 'ok', run('typographic-input', url).evidence)
    const braced = R`See \url{https://example.com/a...b} for the data.`
    check('and neither is one inside \\url', status('typographic-input', braced) === 'ok', run('typographic-input', braced).evidence)
    // Maths is not prose: \dots inside a formula is already right, and a straight quote
    // there is a prime.
    check('maths is not prose here either', status('typographic-input', R`The series $x_1, \dots, x_n$ converges to zero.`) === 'ok')
    // \enquote is the babel-friendly way to quote and counts as well written.
    check('\\enquote counts as a quotation', status('typographic-input', R`He said \enquote{hello} and left the room.`) === 'ok')

    // REGRESSION: an accent is not a quotation mark. `\"o` is how an umlaut is written on
    // a keyboard that has none, and this check read Schr\"odinger and M\"uller as three
    // straight double quotes - three corrections that would break the names, handed to
    // the author by a check that presents itself as exact.
    const umlauts = R`The Schr\"odinger equation, following M\"uller and G\"odel, is solved numerically.`
    const u = run('typographic-input', umlauts)
    check('a LaTeX accent is not a straight quote', u.status === 'ok', u.evidence)
    // The braced spelling of the same accent, and the other commands that take a quote
    // as their argument.
    check(
        'and neither is the braced spelling',
        status('typographic-input', R`The G\"{o}del sentence and the \"{U}bung are discussed here.`) === 'ok',
        run('typographic-input', R`The G\"{o}del sentence and the \"{U}bung are discussed here.`).evidence
    )
    // It is the RUN of backslashes that decides, not the character in front: `\\` is a
    // line break and the quote after it is a real one. An even run leaves the quote as
    // text, an odd one makes it part of a command.
    const afterBreak = run('typographic-input', R`The line ends here \\"quoted" and the text goes on.`)
    check('a quote after a line break is still a quote', afterBreak.status === 'missing', afterBreak.evidence)
    check('and both halves of it are counted', /2 straight double quotes/.test(afterBreak.evidence), afterBreak.evidence)

    // REGRESSION: under babel's german option `"` is markup. `W"orter` is an umlaut, and
    // reporting it tells the author to fix something the package is doing for them.
    const germanText = 'Die W"orter sind hier mit der Kurzform geschrieben, ohne echte Anf"uhrungszeichen.'
    const withBabel = extra => [
        { path: '/main.tex', text: R`\documentclass{book}` + '\n' + extra },
        { path: '/ch2.tex', text: germanText },
    ]
    const shorthand = runCheck('typographic-input', withBabel(R`\usepackage[german]{babel}`))
    check('a german babel shorthand is not a straight quote', shorthand.status === 'ok', shorthand.evidence)
    check(
        'and the old ngerman package declares the same shorthands',
        runCheck('typographic-input', withBabel(R`\usepackage{ngerman}`)).status === 'ok',
        runCheck('typographic-input', withBabel(R`\usepackage{ngerman}`)).evidence
    )
    // The guard is DOCUMENT-scoped: the same glued quote in a project that never loads
    // babel is still a straight quote, because there is no shorthand to explain it.
    const noBabel = runCheck('typographic-input', [
        { path: '/main.tex', text: R`\documentclass{book}\usepackage[english]{babel}` },
        { path: '/ch2.tex', text: germanText },
    ])
    check('the same text without babel is still reported', noBabel.status === 'missing', noBabel.evidence)
    // ...and the shorthand only ever explains a quote glued to letters on BOTH sides. A
    // real quotation around a word has a space on one side of each mark, so a german
    // document that types straight quotes is told about them like any other.
    const quotedUnderBabel = runCheck('typographic-input', [
        { path: '/main.tex', text: R`\documentclass{book}` + '\n' + R`\usepackage[german]{babel}` },
        { path: '/ch2.tex', text: 'Er nannte es "Wort" und ging fort aus dem Zimmer.' },
    ])
    check('real straight quotes are found under babel too', quotedUnderBabel.status === 'missing', quotedUnderBabel.evidence)
    check('and both marks are counted', /2 straight double quotes/.test(quotedUnderBabel.evidence), quotedUnderBabel.evidence)
}

// ===========================================================================
// language-support
// ===========================================================================
// The `na` with no language set is pinned at the TOP of this file, because the flag it
// reads is on for the rest of the process once any suite sets a language.
{
    const document = preamble =>
        `\\documentclass{book}\n${preamble}\n\\begin{document}\nLa perturbazione è già più che sufficiente.\n\\end{document}`
    setChecksLanguage('it')
    check('babel with the rubric language is ok', status('language-support', document('\\usepackage[italian]{babel}')) === 'ok')
    const wrong = run('language-support', document('\\usepackage[english]{babel}'))
    check('babel for another language is missing', wrong.status === 'missing', wrong.evidence)
    check('and it says the mechanism is there', /loads a language mechanism|carica un meccanismo/.test(wrong.evidence), wrong.evidence)
    const none = run('language-support', document('\\usepackage{graphicx}'))
    check('no babel at all is missing', none.status === 'missing', none.evidence)
    check('and the accented prose is pointed at', /thesis\.tex:4/.test(none.evidence), none.evidence)
    // DOES NOT APPLY: no accented prose, so nothing shows which language the text is in.
    check('a document with no accents is na', status('language-support', 'Plain ascii prose with no accents.') === 'na')
    // babel reads the CLASS options: refusing to see them reports a defect on a
    // template that is correct.
    const classOption = '\\documentclass[italian]{book}\n\\usepackage{babel}\nLa perturbazione è già sufficiente.'
    check('a class option declares the language too', status('language-support', classOption) === 'ok', run('language-support', classOption).evidence)
    // polyglossia says it another way.
    const poly = document('\\usepackage{polyglossia}\\setmainlanguage{italian}')
    check('polyglossia declares it as well', status('language-support', poly) === 'ok', run('language-support', poly).evidence)
    // An accent typed the LaTeX way is accented prose: a keyboard without accents is
    // not a document written in English.
    const escaped = '\\documentclass{book}\nLa citt\\`a e la perturbazione restano.'
    check('a LaTeX accent counts as accented prose', status('language-support', escaped) === 'missing', run('language-support', escaped).evidence)
    // The option list is read token by token, so main=italian is a declaration.
    const keyValue = document('\\usepackage[main=italian,english]{babel}')
    check('a key=value option is read', status('language-support', keyValue) === 'ok', run('language-support', keyValue).evidence)
    setChecksLanguage('en')
    check(
        'and an English rubric asks for English',
        run('language-support', document('\\usepackage[italian]{babel}')).status === 'missing',
        run('language-support', document('\\usepackage[italian]{babel}')).evidence
    )
}

// ===========================================================================
// cost: the same tripwires, for the checks added last
// ===========================================================================
// Every check below sweeps the whole document once. The bounds are loose on purpose:
// they are not benchmarks, they are tripwires, and a return to quadratic blows through
// them by seconds. Two of them were measured BEFORE the fix that made them linear:
// 2 MB of unclosed `\[` cost the maths-span scan 9.5 s (it kept a lazy regex where
// blankDisplayMaths already had a token pass), and 2 MB of `\chapter{` cost the heading
// scan 12.5 s (the general brace reader walks 4000 characters before giving up).
{
    const BUDGET_MS = 3000
    const twoMegabytes = unit => unit.repeat(Math.round((2 * 1024 * 1024) / unit.length))
    const budget = (name, checkName, unit) => {
        const text = twoMegabytes(unit)
        const started = Date.now()
        runCheck(checkName, [{ path: '/t.tex', text }])
        const elapsed = Date.now() - started
        check(`2 MB of ${name} stays under the budget for ${checkName}`, elapsed < BUDGET_MS, `${elapsed} ms`)
    }
    budget('unclosed display brackets', 'math-notation', R`\[ x `)
    budget('unclosed display brackets', 'symbol-list', R`\[ x `)
    budget('unclosed dollar maths', 'math-notation', '$$ x ')
    budget('unclosed headings', 'heading-sequence', R`\chapter{`)
    budget('unclosed headings', 'appendix-referenced', R`\chapter{`)
    budget('references', 'reference-style-mixing', R`\ref{a} `)
    budget('references', 'tie-before-ref', R`\ref{a} `)
    budget('emphasised words', 'italic-coherence', R`\textit{parola} `)
    budget('prose', 'typographic-input', 'una parola qualunque ')
    budget('unclosed tabulars', 'tables-as-images', R`\begin{tabular}{ll}\includegraphics{a}`)
    // The 3000-float and 3000-equation shapes the rest of the suite already uses, run
    // against the checks that walk maths and headings.
    const equations = (R`\begin{equation}\alpha = \beta_{i} + \gamma x \end{equation}` + '\n').repeat(3000)
    const declared = R`\nomenclature{$\alpha$}{angle}` + '\n'
    const t0 = Date.now()
    runCheck('symbol-list', [{ path: '/t.tex', text: declared + equations }])
    check('3000 equations stay linear for symbol-list', Date.now() - t0 < 1000, `${Date.now() - t0} ms`)
    const t1 = Date.now()
    runCheck('math-notation', [{ path: '/t.tex', text: equations }])
    check('and for math-notation', Date.now() - t1 < 1000, `${Date.now() - t1} ms`)
    // A .bib whose entries all carry the SAME title is the worst case for the duplicate
    // buckets: without the cap on a bucket it is one comparison per entry seen so far.
    const same = Array.from(
        { length: 4000 },
        (_, i) => `@article{k${i},\n  author = {A},\n  title = {A study of the very same words repeated},\n  journal = {J},\n  year = {2020}\n}`
    ).join('\n')
    const t2 = Date.now()
    const bulk = runCheck('bib-duplicates', [
        { path: '/t.tex', text: R`\bibliography{r}` },
        { path: '/r.bib', text: same },
    ])
    check('4000 entries with one title stay linear', Date.now() - t2 < 2000, `${Date.now() - t2} ms`)
    check('and they are reported as duplicates', bulk.status === 'missing', bulk.evidence.slice(0, 80))
}

// ===========================================================================
// invariants that hold for EVERY check
// ===========================================================================
for (const [name, c] of Object.entries(CHECKS)) {
    check(`${name} describes itself`, typeof c.describe === 'string' && c.describe.length > 10)
    // An empty project is the case a queue retry can produce. It must never be "ok".
    check(`${name} answers na on an empty project`, runCheck(name, []).status === 'na')
    check(`${name} answers na on an empty file`, runCheck(name, [{ path: '/a.tex', text: '' }]).status === 'na')
    const input = doc(R`\begin{figure}\caption{C}\label{f}\end{figure} \ref{f}`)
    const r = runCheck(name, input)
    check(
        `${name} returns the contract shape`,
        ['ok', 'partial', 'missing', 'na'].includes(r.status) &&
            typeof r.evidence === 'string' &&
            Array.isArray(r.locations)
    )
    // A location must name a file that was actually given to the check. A finding
    // about an ABSENCE ("no abstract anywhere") legitimately has nothing to point at,
    // so the rule is that what it does report must be real, not that it must report.
    const known = new Set(input.map(d => d.path))
    check(
        `${name} never invents a file path`,
        r.locations.every(l => !l.path || known.has(l.path)),
        JSON.stringify(r.locations)
    )
    check(`${name} says something`, r.evidence.length > 20, r.evidence)
}

// ===========================================================================
// the evidence speaks the rubric's language
// ===========================================================================
// A student reading an Italian report should not have to parse English fragments
// wedged between Italian sentences. English stays the default, so every assertion
// above still describes what ships for an English rubric.
{
    setChecksLanguage('it')
    const r = run('float-caption', R`\begin{figure}\includegraphics{a}\end{figure}`)
    check('the verdict is unchanged by the language', r.status === 'missing', r.evidence)
    check('the evidence is in Italian', r.evidence.includes('senza \\caption'), r.evidence)
    check('and carries no English fragment', !r.evidence.includes('with no'), r.evidence)
    // The LaTeX is data, not prose: translating it would name a command nobody can type.
    check('the technical tokens are untouched', r.evidence.includes('figure'), r.evidence)
    setChecksLanguage('en')
    check(
        'and English is restored',
        run('float-caption', R`\begin{figure}\includegraphics{a}\end{figure}`).evidence.includes(
            'with no \\caption'
        )
    )
}

// ===========================================================================
// fifth wave: the merit audit's repros, promoted. Each block is one confirmed
// defect from the three-lens audit of 2026-08-01; the comment names the failure
// it pins so a future red here reads as a regression of that exact defect.
// ===========================================================================
{
    // \verb shows a command instead of using it, and was sanitised nowhere.
    const shown = R`Si scrive \verb|\begin{figure}| e si chiude con \verb|\end{figure}|.
\begin{table}\caption{Una tabella}\begin{tabular}{ll}a & b\end{tabular}\end{table}`
    check('a float shown inside \\verb is not a float', status('float-caption', shown) === 'ok', run('float-caption', shown).evidence)
    const shownRef = R`Il comando \verb|\ref{fig:esempio}| produce il numero.
\begin{figure}\includegraphics{a}\caption{C}\label{fig:vera}\end{figure} Vedi \ref{fig:vera}.`
    check('a \\ref shown inside \\verb is not a reference', status('crossrefs-resolve', shownRef) === 'ok')
    check('a TODO shown inside \\verb is not a work marker', status('work-markers', R`Il marcatore \verb+TODO+ va rimosso.`) === 'ok')
}
{
    // A \newcommand-wrapped float is a template: four checks judged the document
    // that does not exist, and crossrefs-resolve inverted on a correct project.
    const wrapped = R`\newcommand{\figura}[3]{\begin{figure}[htbp]\centering\includegraphics{#1}\caption{#2}\label{fig:#3}\end{figure}}
\figura{img/a.png}{La prima}{prima}
Come si vede nella Figura~\ref{fig:prima}, regge.`
    check('a macro-defined float is not "never referenced"', status('float-referenced', wrapped) === 'na', run('float-referenced', wrapped).evidence)
    check('a \\ref resolved by a macro-defined \\label is not dangling', status('crossrefs-resolve', wrapped) === 'na', run('crossrefs-resolve', wrapped).evidence)
    check('float-centered does not judge the definition', status('float-centered', wrapped) === 'na', run('float-centered', wrapped).evidence)
}
{
    // \renewcommand{\arraystretch}{1.3} + {\small ...} is the standard compact
    // table recipe: the unbounded region walk annexed the brace group after it.
    const recipe = R`\renewcommand{\arraystretch}{1.3}
{\small
\begin{table}\centering\caption{Risultati}\begin{tabular}{ll}a & b\end{tabular}\end{table}
}`
    check('a brace group after \\renewcommand is not part of it', status('float-caption', recipe) === 'ok', run('float-caption', recipe).evidence)
    const recipeBad = recipe.replace(R`\caption{Risultati}`, '')
    check('and a real missing caption there is still caught', status('float-caption', recipeBad) === 'missing')
}
{
    // A float nested in a float had its label counted by parent AND child.
    const nested = R`\begin{figure}
\begin{figure}\includegraphics{a}\caption{Interna}\label{fig:in}\end{figure}
\caption{Esterna}\label{fig:out}\end{figure}
Vedi \ref{fig:in} e \ref{fig:out}.`
    const r = run('float-referenced', nested)
    check('a nested float label is counted once', /All 2 labelled/.test(r.evidence), r.evidence)
    // Both floats carry their own label: any "carries no \label" caveat here means
    // a label was attributed to the wrong float.
    check('and each label goes to its own float', !/no \\label|senza \\label|non ha una/.test(r.evidence), r.evidence)
}
{
    // \textbf{0,85} in a results table: the "{" guard hid every bolded value and
    // the verdict INVERTED the document's convention.
    const bold = 'rendimento \\textbf{0,85} e massa \\textbf{12,4} e resa \\textbf{0,91} e quota \\textbf{3,7} nel testo. Il fattore vale 0.5.'
    const r = run('decimal-separator', bold)
    check('bolded decimals are read', r.status === 'partial', r.evidence)
    check('and the stray point is the one named', /0\.5/.test(r.evidence), r.evidence)
}
{
    // $6.27\pm0,07$: the letter guard hid the one real decimal comma of a thesis.
    const pm = 'Raggio $6.27\\pm0,07$ e massa $11.08\\pm0.04$ e ancora 12.5 e 4.75 nel testo.'
    const r = run('decimal-separator', pm)
    check('a decimal straight after \\pm is read', /0,07/.test(r.evidence), r.evidence)
    check('and answers partial naming it', r.status === 'partial', r.evidence)
}
{
    // TikZ coordinates are not prose: (2.75,10) is not a decimal comma and
    // "ellipse (1.75cm and 0.75cm)" is not six glued units.
    const tikz = R`\begin{tikzpicture}
\draw [->] (2.75,10) -- (4,11.25);
\draw [line width=1pt] (5.5,11.75) ellipse (1.75cm and 0.75cm);
\end{tikzpicture}
Nel testo i valori 0.85 e 12.4 e la massa di 12.5 kg.`
    check('tikz coordinates are not decimals', status('decimal-separator', tikz) === 'ok', run('decimal-separator', tikz).evidence)
    check('tikz shape sizes are not glued units', status('unit-spacing', tikz) === 'ok', run('unit-spacing', tikz).evidence)
}
{
    // $[-10^4,10^4]$ is an interval even with exponents in the endpoints.
    const exp = 'Il range $[-10^4,10^4]$ e i valori 0.5 e 1.5 e 2.5 nel testo.'
    check('an interval with exponents is an interval', status('decimal-separator', exp) === 'ok', run('decimal-separator', exp).evidence)
}
{
    // \SIrange{1,5}{2,5}{\km}: only the first braced group was read.
    const range = R`La quota varia in \SIrange{1,5}{2,5}{\km} mentre il fattore vale 0.5.`
    const r = run('decimal-separator', range)
    check('every \\SIrange endpoint is read', /1 numbers with a point and 2 with a comma/.test(r.evidence), r.evidence)
}
{
    // "step 0.5 mm" carries a unit: a measurement, whatever the word before it.
    const step = 'La mesh ha uno step 0.5 mm. Il rendimento vale 0,85 e la massa 12,4 kg.'
    check('a measurement after a sectioning word is read', status('decimal-separator', step) === 'missing', run('decimal-separator', step).evidence)
    // ...and the numbers genuinely set aside are declared in the evidence.
    const setAside = run('decimal-separator', 'Nel paragrafo 3.2 si vede. I valori 0,85 e 12,4 e 3,7 restano.')
    check('the set-aside count is declared', /set aside|esclusi/.test(setAside.evidence), setAside.evidence)
}
{
    // $D_{\min}=1.5\,\mathrm{m}$ is the textbook unit notation: it must COUNT.
    const mathrm = R`Il vincolo импone $D_{\min}=1.5\,\mathrm{m}$ e $B_{\max}=0.417\,\mathrm{m}$ nel progetto.`
        .replace('импone', 'impone')
    const r = run('unit-spacing', mathrm)
    check('\\mathrm units are recognised as well written', r.status === 'ok', r.evidence)
}
{
    // \DeclareAcronym and \newglossaryentry declare; the collector only knew two
    // of the four forms, and told the student the declaring file never declared.
    const acro = R`\DeclareAcronym{adcs}{short = ADCS, long = Attitude Determination and Control System}
\chapter{Il progetto del \ac{adcs}}
Il satellite monta un \ac{adcs} a tre assi.`
    check('\\DeclareAcronym is a declaration', status('acronyms-in-headings', acro) === 'missing', run('acronyms-in-headings', acro).evidence)
    const twoLine = '\\newacronym{adcs}{ADCS}\n    {Attitude Determination and Control System}\n\\chapter{Il progetto ADCS}\nUso ADCS e ancora ADCS e ADCS.'
    check('a declaration split over two lines still declares', status('acronyms-in-headings', twoLine) === 'missing', run('acronyms-in-headings', twoLine).evidence)
}
{
    // img/ADCS.png is a file name, not a use of the acronym.
    const file = R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}
\begin{figure}\centering\includegraphics{img/ADCS.png}\caption{Schema}\end{figure}
Il satellite monta un Attitude Determination and Control System (ADCS) a tre assi.`
    check('a file name is not a first use', status('acronym-first-use', file) === 'ok', run('acronym-first-use', file).evidence)
    const fileOnly = R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}
\begin{figure}\includegraphics{img/ADCS.png}\caption{Schema}\end{figure}
Testo senza mai la sigla.`
    check('a file name does not keep an unused acronym alive', status('acronyms-declared-unused', fileOnly) === 'missing', run('acronyms-declared-unused', fileOnly).evidence)
}
{
    // PIÙ is a word with an accent, not a use of an acronym called "PI".
    const caps = 'La configurazione PIÙ leggera pesa meno. La versione PIÙ corta è migliore. La soluzione PIÙ semplice funziona.'
    check('an accented caps word does not mint an acronym', status('acronym-first-use', caps) === 'na', run('acronym-first-use', caps).evidence)
}
{
    // \definecolor{x}{RGB}{...} minted "RGB" as an undeclared acronym on five
    // real projects, from the template's own do-not-edit file.
    const colours = R`\definecolor{keyBlue}{RGB}{14,0,255}
\definecolor{mygreen}{RGB}{2,128,9}
\definecolor{mylilas}{RGB}{170,4,249}
Testo normale della tesi, senza acronimi.`
    check('a colour model is not an acronym', status('acronym-first-use', colours) === 'na', run('acronym-first-use', colours).evidence)
}
{
    // The \label inside a heading is not part of the printed title.
    const labelled = R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}
\section{Il sottosistema di controllo\label{sec:ADCS}}
Il testo usa Attitude Determination and Control System (ADCS).`
    const r = run('acronyms-in-headings', labelled)
    check('a \\label in a heading is not the heading', r.status === 'ok', r.evidence)
    // \part and \subparagraph are sectioning commands like the other five.
    const part = R`\newacronym{adcs}{ADCS}{Attitude Determination and Control System}
\part{Il progetto dell'ADCS}
Testo con Attitude Determination and Control System (ADCS).`
    check('\\part is a heading', status('acronyms-in-headings', part) === 'missing', run('acronyms-in-headings', part).evidence)
}
{
    // An UNDECLARED acronym in a heading counts too: the same report used to name
    // KKT as used-but-undeclared while this check said the headings were clean.
    const undeclared = R`\chapter{KKT problem creation}
Il metodo KKT si basa su KKT e ancora KKT e KKT nel testo, mai spiegato.`
    const r = run('acronyms-in-headings', undeclared)
    check('an undeclared acronym in a heading is caught', r.status === 'missing', r.evidence)
}
{
    // \[ ... \] was reported one line above itself (the guard ate the newline).
    const eq = 'riga 1\n\\[a=b\\]\nriga 3'
    const r = run('numbered-equations', eq)
    check('\\[ is reported on its own line', /thesis\.tex:2\b/.test(r.evidence), r.evidence)
}
{
    // bibFields resumed INSIDE a long value, so "year = 2019" written in an
    // abstract satisfied the completeness check of an entry with no year field.
    const bib = [{ path: '/refs.bib', text: '@article{rossi2019,\n  author = {Rossi, M.},\n  title = {A comparison},\n  abstract = {We compare laws on a benchmark and we show that the year = 2019 baseline is outperformed by both alternatives over many pages of text},\n  journal = {Journal of Guidance}\n}' }]
    const r = runCheck('bib-entries-complete', bib)
    check('a phrase inside a value is not a field', r.status === 'missing', r.evidence)
}

// ===========================================================================
// work-markers: "to do:" written as two words
// ===========================================================================
// A real thesis marked its missing pieces `\textcolor{red}{to do: ...}` and the
// one-word TODO scan reported a clean document. The colon is the marker: prose that
// merely contains "to do" must stay silent.
check(
    'a "to do:" note is a marker',
    status('work-markers', R`\textcolor{red}{to do: antenna pattern radiation lobes}`) === 'missing',
    run('work-markers', R`\textcolor{red}{to do: antenna pattern radiation lobes}`).evidence
)
check('so is a capitalised "To Do:"', status('work-markers', 'To Do: rerun the wind tunnel case') === 'missing')
check('"the work to do involves" is prose, not a marker', status('work-markers', 'the work to do involves three steps') === 'ok')
check('a to-do written with a hyphen is prose too', status('work-markers', 'items on the to-do list were closed') === 'ok')
check('the Italian "da fare:" is a marker', status('work-markers', 'da fare: taratura del banco prova') === 'missing')
check('"resta molto da fare" is prose', status('work-markers', 'resta molto da fare in questo campo') === 'ok')
{
    // REGRESSION (fragment corpus): 23 of 51 planted markers were template
    // SENTENCES, not TODO tokens - "Scrivere qui i dati", "Lorem ipsum dolor",
    // "The abstract of the thesis goes here" - and the vocabulary had no entry for
    // any of them. Each phrase added is one no real thesis prose ever writes.
    check('Lorem ipsum is a leftover placeholder', status('work-markers', 'Il magnetotorquer genera coppie. Lorem ipsum dolor sit amet, consectetur.') === 'missing')
    check('"Scrivere qui" is scaffold', status('work-markers', 'Scrivere qui i dati sperimentali della campagna.') === 'missing')
    check('"Aggiungere qui" and "Inserire qui" are scaffold', status('work-markers', 'Aggiungere qui i dettagli del progetto.') === 'missing' && status('work-markers', 'Inserire qui il bilancio di collegamento.') === 'missing')
    check('"Completare questa sezione" is scaffold', status('work-markers', 'Completare questa sezione con i dati dei pannelli.') === 'missing')
    check('"goes here" is scaffold', status('work-markers', 'The abstract of the thesis goes here regarding wheel dynamics.') === 'missing')
    check('"goes in this section" is scaffold', status('work-markers', 'Background information about the test goes in this section.') === 'missing')
    check('"should be added here" is scaffold', status('work-markers', 'The description of the algorithm should be added in detail here.') === 'missing')
    check('"Here insert" is scaffold', status('work-markers', 'Here insert star tracker performance summary.') === 'missing')
    check('"Write your" is scaffold', status('work-markers', 'Write your introduction paragraph here describing the context.') === 'missing')
    check('a sentence-initial "Fill in the" is scaffold', status('work-markers', 'Fill in the methodology details for the implementation.') === 'missing')
    check('"Complete the results section" is scaffold', status('work-markers', 'Complete the results section with experimental data.') === 'missing')
    // and the prose that shares words with the scaffold stays prose
    check('"to fill in the gaps" is prose', status('work-markers', 'Interpolation is used to fill in the gaps of the record.') === 'ok')
    check('"completare il lavoro" is prose', status('work-markers', 'Resta da completare il lavoro sperimentale nei prossimi mesi.') === 'ok')
    check('"si scrive qui sotto" is prose', status('work-markers', "L'equazione che si scrive qui sotto deriva dal bilancio.") === 'ok')
}

// ===========================================================================
// citation-setup-authoryear / -numeric / -consistent
// ===========================================================================
// The style is decided by the preamble, not by reading the text: natbib options
// first (they rewrite the \cite commands whatever the .bst prints), then biblatex,
// then the classic .bst names.
{
    // The real master-thesis shape that was never judged (the model refused it for
    // context): numeric natbib plus TWO different .bst declarations.
    const numericMaster = [
        { path: '/setup.tex', text: R`\documentclass{book}\usepackage[square,numbers]{natbib}\bibliographystyle{plain}` },
        { path: '/main.tex', text: R`\bibliographystyle{apalike} Testo \cite{rossi} e \cite{bianchi}.` },
    ]
    const ay = runCheck('citation-setup-authoryear', numericMaster)
    check('contradictory setups are missing before any style question', ay.status === 'missing', ay.evidence)
    check('the contradiction names both declarations', /plain/.test(ay.evidence) && /apalike/.test(ay.evidence), ay.evidence)
    const cons = runCheck('citation-setup-consistent', numericMaster)
    check('the consistency name reports the same contradiction', cons.status === 'missing', cons.evidence)
}
{
    const coherentAY = R`\documentclass{book}\usepackage[round,authoryear]{natbib}\bibliographystyle{apalike} Testo \citep{rossi2019}.`
    check('author-year natbib satisfies -authoryear', status('citation-setup-authoryear', coherentAY) === 'ok')
    check('but not -numeric', status('citation-setup-numeric', coherentAY) === 'missing')
    check('one coherent setup satisfies -consistent', status('citation-setup-consistent', coherentAY) === 'ok')
}
{
    const coherentNum = R`\documentclass{book}\usepackage[numbers,sort&compress]{natbib}\bibliographystyle{ieeetr} Testo \cite{a} e \cite{b}.`
    check('numeric natbib satisfies -numeric', status('citation-setup-numeric', coherentNum) === 'ok')
    const r = run('citation-setup-authoryear', coherentNum)
    check('and is missing under -authoryear, naming the declaration', r.status === 'missing' && /numbers/.test(r.evidence), r.evidence)
}
{
    // natbib WITHOUT a mode option decides nothing by itself (it reverts to
    // numerical when the bibliography has no author-year labels); paired with a
    // *nat style the pair's default is author-year, and that pair must not read as
    // a contradiction.
    const defaultNatbib = R`\usepackage{natbib}\bibliographystyle{plainnat} Testo \citep{a}.`
    check('modeless natbib with plainnat is author-year (the pair default)', status('citation-setup-authoryear', defaultNatbib) === 'ok')
    check('plainnat follows natbib, no contradiction', status('citation-setup-consistent', defaultNatbib) === 'ok')
}
{
    // The real internship-template shape: modeless natbib over a numeric .bst and a
    // hand-written thebibliography renders NUMBERS (natbib reverts), so it is one
    // coherent numeric setup, not an author-year contradiction.
    const template = [
        { path: '/setup.tex', text: R`\documentclass{article}\usepackage[sort&compress]{natbib}` },
        { path: '/bibliografia.tex', text: R`\bibliographystyle{plain}\begin{thebibliography}{99}\bibitem{a} Autore, Titolo.\end{thebibliography}` },
        { path: '/main.tex', text: R`\begin{document} Testo \cite{a}. \end{document}` },
    ]
    check('modeless natbib over a numeric .bst is numeric', runCheck('citation-setup-numeric', template).status === 'ok', runCheck('citation-setup-numeric', template).evidence)
    check('and one coherent setup, not a contradiction', runCheck('citation-setup-consistent', template).status === 'ok')
}
{
    // A template that ships its alternative setup commented out must not read as a
    // contradiction: comments are dead code (a real course template carries
    // `%\usepackage[style=authoryear]{biblatex}` under a live numeric natbib).
    const commented = R`\usepackage[numbers]{natbib}
\bibliographystyle{unsrturl}
%\usepackage[style=authoryear]{biblatex}
Testo \cite{a}.`
    check('a commented-out setup is dead code', status('citation-setup-consistent', commented) === 'ok', run('citation-setup-consistent', commented).evidence)
}
{
    // "unsrturl" is a patched unsrt: the url suffix must not hide the name.
    const patched = R`\usepackage[numbers]{natbib}\bibliographystyle{unsrturl} Testo \cite{a}.`
    check('a -url patched .bst keeps its class', status('citation-setup-numeric', patched) === 'ok')
}
check(
    'no citations at all is na, not a verdict',
    status('citation-setup-consistent', R`\usepackage[numbers]{natbib} testo senza citazioni`) === 'na'
)
{
    const bare = R`Testo con \cite{a} e \cite{b} e nessun preambolo.`
    const r = run('citation-setup-authoryear', bare)
    check('citations with no recognisable setup are na', r.status === 'na', r.evidence)
    check('and the na says what was looked for', /natbib/.test(r.evidence), r.evidence)
}

// ===========================================================================
// long-sentences
// ===========================================================================
{
    const LONG =
        'This sentence deliberately carries a very large number of ordinary running words so that the counter of ' +
        'the check can pass the threshold of forty words without any table or list markup being present in the ' +
        'span at all, which makes it a genuine finding.'
    const SHORT = 'Short sentence one is written here. Another short sentence follows it immediately.'
    const r = run('long-sentences', LONG)
    check('a 40+ word sentence is missing', r.status === 'missing', r.evidence)
    check('the finding states the word count', /\d\d words:/.test(r.evidence), r.evidence)
    check('short sentences are ok', status('long-sentences', SHORT) === 'ok')
    check('no prose at all is na', status('long-sentences', R`\begin{equation} a = b \end{equation}`) === 'na')
    // The naive rule read table rows as 140-word sentences: rows must stay silent
    // whether the environment is known (blanked) or leaks cell markup into a span.
    const table =
        R`\begin{tabular}{ll}` + '\n' +
        (LONG.replace(/ /g, ' & ') + R` \\`) + '\n' +
        R`\end{tabular}` + '\n' + SHORT
    check('table rows are not sentences', status('long-sentences', table) === 'ok', run('long-sentences', table).evidence)
    // The requirement excludes lists.
    const list = R`\begin{itemize}\item ` + LONG + R`\end{itemize}` + '\n' + SHORT
    check('a long \\item is excluded by the requirement', status('long-sentences', list) === 'ok')
    // A paragraph that never ends with sentence punctuation is float debris, not a
    // sentence.
    const tail = LONG.replace(/\.$/, '') + '\n\n' + SHORT
    check('an unterminated span is not a sentence', status('long-sentences', tail) === 'ok', run('long-sentences', tail).evidence)
    // Inline maths tokens are symbols, not words.
    const mathy = 'The bound holds ' + R`\(a\) \(b\) \(c\) \(d\) \(e\) \(f\) \(g\) \(h\) \(i\) \(j\) \(k\) \(l\) \(m\) \(n\) \(o\) \(p\) \(q\) \(r\) \(s\) \(t\) \(u\) \(v\) \(w\) \(x\) \(y\) \(z\) \(aa\) \(bb\) \(cc\) \(dd\) \(ee\) \(ff\) \(gg\) \(hh\) \(ii\) \(jj\)` + ' for the whole family of cases described above.'
    check('inline maths does not count as words', status('long-sentences', mathy) === 'ok', run('long-sentences', mathy).evidence)
    // Two sentences of 25 words each must not be read as one of 50.
    const two = LONG.slice(0, 130).replace(/,?\s*$/, '. ') + 'The rest of the words continue in a second sentence that stays well under the limit on its own.'
    check('a sentence boundary splits the count', status('long-sentences', two) === 'ok', run('long-sentences', two).evidence)
    // Regression: the environments must be blanked BEFORE proseOnly erases their
    // \begin markers - a thebibliography read as prose produced a 150-word
    // "sentence" out of \bibitem entries on a real thesis.
    const bibl = R`\begin{thebibliography}{9}` + '\n' + R`\bibitem{a} ` + LONG + '\n' + R`\end{thebibliography}` + '\n' + SHORT
    check('a reference list is not prose', status('long-sentences', bibl) === 'ok', run('long-sentences', bibl).evidence)
}

// ===========================================================================
// acronyms-missing-from-list
// ===========================================================================
// The mirror of acronyms-declared-unused, on the requirement the model answered
// "ok" twice on real theses that use FSM/GSE dozens of times with lists that never
// declare them.
{
    const listOnly = R`\acro{RLV}{Reusable Launch Vehicle}`
    const santinato = listOnly + '\nThe FSM starts. Then the FSM waits. Finally the FSM stops. The RLV flies.'
    const r = run('acronyms-missing-from-list', santinato)
    check('a short form used 3 times off-list is missing', r.status === 'missing', r.evidence)
    check('the finding carries the token and its count', /FSM \(3 uses/.test(r.evidence), r.evidence)
    check('a covered text is ok', status('acronyms-missing-from-list', listOnly + '\nThe RLV flies. The RLV lands. The RLV again.') === 'ok')
    check('no acronym list at all is na, not a verdict', status('acronyms-missing-from-list', 'The FSM starts. The FSM waits. The FSM stops.') === 'na')
    // Caps function words in truth tables are prose, not short forms.
    const gates = listOnly + '\nPorts use \\texttt{OR} logic. The OR gate opens. An OR port closes. RLV here.'
    check('a caps function word is not a short form', status('acronyms-missing-from-list', gates) === 'ok', run('acronyms-missing-from-list', gates).evidence)
    // "Mission Profile ID" is caps-written prose (measured on a real thesis).
    const id = listOnly + '\nThe Mission Profile ID is set. The ID changes. The ID resets. RLV.'
    check('ID is not reported as a missing short form', status('acronyms-missing-from-list', id) === 'ok')
    // An inline expansion at first use is the author doing right by the reader:
    // inherited conservatism, pinned so a change here is a decision, not a drift.
    const expanded = listOnly + '\nBoundary Value Analysis (BVA) applies. Then BVA again. And BVA once more.'
    check('an inline-expanded short form stays out', status('acronyms-missing-from-list', expanded) === 'ok')
    // Below three uses is a passing mention.
    const rare = listOnly + '\nThe SNR is high. The SNR is stable. RLV flies on.'
    check('two uses are a passing mention, not a finding', status('acronyms-missing-from-list', rare) === 'ok')
    // A reference list is bibliographic data, not running prose: an ISSN repeated
    // across \bibitem entries must not be told to join the acronym list (measured
    // on a real thesis whose thebibliography lives in main.tex).
    const bibl =
        listOnly +
        '\nThe RLV flies over land.\n' +
        R`\begin{thebibliography}{9}` +
        '\n' +
        R`\bibitem{a} Journal A, ISSN 1111-2222.` +
        '\n' +
        R`\bibitem{b} Journal B, ISSN 3333-4444.` +
        '\n' +
        R`\bibitem{c} Journal C, ISSN 5555-6666.` +
        '\n' +
        R`\end{thebibliography}`
    check('an ISSN inside the reference list is not a short form', status('acronyms-missing-from-list', bibl) === 'ok', run('acronyms-missing-from-list', bibl).evidence)
}

// ===========================================================================
// decimal-separator: English thousands grouping against the document's convention
// ===========================================================================
// "25,000 orbite" in an Italian point-decimal thesis is the rubric's own worked
// example of the defect; the plain decimal scan deliberately skips comma groups,
// so the grouping is judged here against the document's own dominant separator,
// and only when the rubric declares Italian.
{
    setChecksLanguage('it')
    const itPointDoc = 'i valori 1.5 e 2.75 e 3.25 e 4.5 e la sonda ha compiuto 25,000 orbite'
    const r = run('decimal-separator', itPointDoc)
    check('a comma group in an Italian point document is missing', r.status === 'missing', r.evidence)
    check('the grouping finding names the number', /25,000/.test(r.evidence), r.evidence)
    const commaDoc = 'i valori 1,5 e 2,75 e 3,25 e 4,5 e la sonda ha compiuto 25,000 orbite'
    check('in a comma-decimal document the same token is silent', status('decimal-separator', commaDoc) === 'ok', run('decimal-separator', commaDoc).evidence)
    check('an interval endpoint is not a grouped number', status('decimal-separator', 'nell’intervallo [0,250] i valori 0.5 e 1.5 e 2.5 e 3.5') === 'ok')
    check(
        'a colour triple never reaches the grouping report',
        status('decimal-separator', R`\definecolor{mygreen}{RGB}{2,128,9} valori 0.5 e 1.5 e 2.5 e 3.5`) === 'ok'
    )
    {
        // The tail of "2,128,9" backtracks into an ordinary comma-decimal match
        // ("2,12"), which the plain separator scan has always reported on its own
        // terms; what the GROUPING report must never do is read the chain as an
        // English thousands group.
        const chained = run('decimal-separator', 'coordinate 2,128,9 e valori 0.5 e 1.5 e 2.5 e 3.5')
        check('a chained group is never a thousands finding', !/migliaia all'inglese|Inoltre/.test(chained.evidence), chained.evidence)
    }
    setChecksLanguage('en')
    check('in an English document comma grouping is simply correct', status('decimal-separator', 'values 1.5 and 2.75 and 3.25 and 4.5 over 25,000 orbits') === 'ok')
}
{
    // REGRESSION (fragment corpus): a group of three digits after a LEADING ZERO can
    // never be a thousands separator, yet "0.018" was skipped as one, so a document
    // mixing "0.018" and "1,5" answered "all 1 decimal numbers use the comma".
    const zero = run('decimal-separator', 'the error stays below 0.018 degrees but rises to 1,5 degrees at eclipse')
    check('a zero-led three-digit group is a decimal, not thousands', zero.status === 'missing', zero.evidence)
    check('and both separators are in the count', /1 numbers with a point and 1 with a comma/.test(zero.evidence), zero.evidence)
    // "3.142" without other signals stays ambiguous and ignored, as before
    check('a nonzero-led group alone stays ambiguous', status('decimal-separator', 'la costante vale 3.142 nel modello') === 'na')
}
{
    // REGRESSION (fragment corpus): thousands written two ways. The airtight,
    // language-independent shape is the SAME digit string grouped and ungrouped in
    // one document ("1.200 RPM" beside "1200 RPM").
    const same = run('decimal-separator', 'operates at 1.200 RPM in tracking mode and at 1200 RPM sustained')
    check('the same number grouped and ungrouped is inconsistent', same.status === 'missing', same.evidence)
    check('and the finding names the pair', /1\.200/.test(same.evidence) && /1200/.test(same.evidence), same.evidence)
    // the year twin never fires: "1.984 m" beside the year 1984 is a coincidence
    check('a year is not the ungrouped twin', status('decimal-separator', 'un dislivello di 1.984 m misurato nel 1984 dai rilievi') === 'na')
    setChecksLanguage('it')
    // In declared Italian the point-group IS the thousands convention: leaving a
    // five-digit number ungrouped beside it is the inconsistency the rubric asks
    // about, and a comma-group of the X,000 shape beside a point-group mixes the
    // two conventions outright.
    const ungrouped = run('decimal-separator', 'si prevedono 1.200 cicli termici e in tutto 12000 accensioni complete')
    check('an IT point-group beside a five-digit bare integer is inconsistent', ungrouped.status === 'missing', ungrouped.evidence)
    const mixed = run('decimal-separator', 'il file pesa 5,000 megabyte e il disco 3.200 gigabyte in tutto')
    check('mixed comma and point groups are inconsistent', mixed.status === 'missing' && /5,000/.test(mixed.evidence), mixed.evidence)
    // the pi guard: a comma-group that does not end in 000 reads as an ordinary
    // Italian decimal beside a point-thousands, which is CORRECT Italian
    check('a comma-decimal beside a point-group is correct Italian', status('decimal-separator', 'la costante vale 3,142 e la distanza 1.500 km') === 'na')
    // four-digit bare integers stay out: leaving 8500 bare beside a grouped 12.000
    // is accepted typography, and an interval endpoint is maths
    check('a four-digit bare integer is not the inconsistency', status('decimal-separator', 'sono stati svolti 12.000 cicli e 8500 prove') === 'na')
    check('an interval endpoint is not an ungrouped thousand', status('decimal-separator', "nell'intervallo [0, 45000] i cicli sono 1.200 in tutto") === 'na')
    setChecksLanguage('en')
    // in declared English "1.200" is a legal three-place decimal: without the
    // same-value twin or a comma-group beside it, it stays untouched
    check('an EN point-group beside a different bare integer stays silent', status('decimal-separator', 'reached 1.200 RPM while logging 15000 samples') === 'na')
}

// ===========================================================================
// tie-before-ref: a preposition is not the word the tie rule protects
// ===========================================================================
{
    // REGRESSION (fragment corpus): "Come descritto in \autoref{sec:x}" was
    // reported as a breakable reference. The tie rule protects the NAME of the
    // object from its number ("Figura~3"); a break after a bare preposition or
    // article is ordinary typesetting, and \autoref prints its own name anyway.
    // The stopword list is the one manual-numbering already trusts.
    const prep = run('tie-before-ref', R`Come descritto in \autoref{sec:aocs}, ogni sensore contribuisce alla stima.`)
    check('a reference after a preposition needs no tie', prep.status === 'na', prep.evidence)
    const mixedTie = run('tie-before-ref', R`La Figura \ref{fig:a} mostra il banco, come descritto in \autoref{sec:b}.`)
    check('while a naming word before the reference still does', mixedTie.status === 'missing' && /1 of 1/.test(mixedTie.evidence), mixedTie.evidence)
}

// ===========================================================================
// unique-labels
// ===========================================================================
{
    const project = (files, orphanLabel = null) => {
        const docs = [
            { path: '/main.tex', text: R`\documentclass{book}\input{a}\input{b}` },
            ...files,
        ]
        if (orphanLabel) docs.push({ path: '/orphan.tex', text: orphanLabel })
        return docs
    }
    const dup = project([
        { path: '/a.tex', text: R`\begin{equation}x\label{eq:one}\end{equation} vedi \ref{eq:one}` },
        { path: '/b.tex', text: R`\begin{equation}y\label{eq:one}\end{equation}` },
    ])
    const r = runCheck('unique-labels', dup)
    check('a label defined in two reachable files is missing', r.status === 'missing', r.evidence)
    check('the finding lists every definition site', /a\.tex:1/.test(r.evidence) && /b\.tex:1/.test(r.evidence), r.evidence)
    check('and says the references bind to only one', /referenced 1/.test(r.evidence), r.evidence)
    const unique = project([
        { path: '/a.tex', text: R`\label{eq:one}` },
        { path: '/b.tex', text: R`\label{eq:two}` },
    ])
    check('unique labels are ok', runCheck('unique-labels', unique).status === 'ok')
    check('no labels at all is na', runCheck('unique-labels', project([{ path: '/a.tex', text: 'solo testo' }])).status === 'na')
    // The measured false-positive shape: a deprecated chapter kept in the project
    // but never \input. LaTeX never sees its labels, so neither does the check.
    const orphan = project(
        [{ path: '/a.tex', text: R`\label{eq:one}` }],
        R`\label{eq:one}`
    )
    check('a duplicate only in an orphan file is not a duplicate', runCheck('unique-labels', orphan).status === 'ok', runCheck('unique-labels', orphan).evidence)
    // Without a recognisable root the scan fails OPEN: every file is read.
    const rootless = [
        { path: '/a.tex', text: R`\label{eq:one}` },
        { path: '/b.tex', text: R`\label{eq:one}` },
    ]
    check('with no main file every file is scanned', runCheck('unique-labels', rootless).status === 'missing')
    // A \label inside a listing is shown code; one inside a macro definition is a
    // template, and both guards already exist elsewhere in the file.
    const verb = R`\documentclass{book}\label{eq:one}` + '\n' + R`\begin{lstlisting}` + '\n' + R`\label{eq:one}` + '\n' + R`\end{lstlisting}`
    check('a label inside verbatim is not a definition', runCheck('unique-labels', [{ path: '/main.tex', text: verb }]).status === 'ok')
    const macro = R`\documentclass{book}\newcommand{\fig}[1]{\label{tpl}} \label{tpl}`
    check('a label inside a macro definition is not a definition', runCheck('unique-labels', [{ path: '/main.tex', text: macro }]).status === 'ok')
    // The course-template shape: \documentclass lives in a setup file that inputs
    // nothing, \begin{document} and the \input lines live in main.tex. Rooting on
    // the class marker would end the walk inside setup.tex with the thesis unread.
    const templateShaped = [
        { path: '/setup_do_not_edit/setup.tex', text: R`\documentclass{book}\usepackage{graphicx}` },
        { path: '/main.tex', text: R`\input{setup_do_not_edit/setup.tex}\begin{document}\input{a}\input{b}\end{document}` },
        { path: '/a.tex', text: R`\label{eq:one}` },
        { path: '/b.tex', text: R`\label{eq:one}` },
    ]
    const rooted = runCheck('unique-labels', templateShaped)
    check('the root is the file with the document body', rooted.status === 'missing', rooted.evidence)
    // REGRESSION: an \input path that climbs with ../ resolved to nothing, so the
    // file it names dropped out of the reachable set and a real duplicate across it
    // was invisible - a false pass from a path spelling LaTeX accepts.
    const climbing = [
        { path: '/tesi/main.tex', text: R`\documentclass{book}\begin{document}\input{../shared/intro}\label{a}\end{document}` },
        { path: '/shared/intro.tex', text: R`\label{a}` },
    ]
    const c = runCheck('unique-labels', climbing)
    check('an \\input path with ../ still reaches its file', c.status === 'missing', c.evidence)
    check('and the scope counts both files', /2 files/.test(c.evidence), c.evidence)
}

// ===========================================================================
// openingHeadingsFact: a fact line, never a verdict
// ===========================================================================
{
    const tirocinio = [
        { path: '/main.tex', text: R`\documentclass{article}\input{contenuti}` },
        {
            path: '/contenuti.tex',
            text: R`\section*{1. Descrizione Struttura Ospitante} a \section*{2. Motivazione e Contesto} b \section*{3. Finalit\`a del Tirocinio} c`,
        },
    ]
    const fact = openingHeadingsFact(tirocinio)
    check('the fact lists the opening headings', /Opening headings/.test(fact), fact)
    check('and tags the three internship parts in order', /hosting institution -> #1.*motivation\/context -> #2.*aims\/activities -> #3/.test(fact), fact)
    check('a fact line carries no verdict word', !/missing|violat|\bok\b/i.test(fact), fact)
    // Include order, not file order: main inputs z before a, so z's heading is #1
    // although "a" sorts first.
    const ordered = [
        { path: '/a.tex', text: R`\chapter{Alpha}` },
        { path: '/main.tex', text: R`\documentclass{book}\input{z}\input{a}` },
        { path: '/z.tex', text: R`\chapter{Zeta}` },
    ]
    const orderedFact = openingHeadingsFact(ordered)
    check('headings follow the include order', /1 "Zeta".*2 "Alpha"/.test(orderedFact), orderedFact)
    // Titles that fulfil the parts by CONTENT match no keyword: the fact must say
    // so instead of hinting at a violation.
    const unnamed = [
        { path: '/main.tex', text: R`\documentclass{book}\chapter{Novaspazio S.r.l.}` },
    ]
    check('no keyword match is stated, not judged', /no heading title matches/.test(openingHeadingsFact(unnamed)), openingHeadingsFact(unnamed))
    check('no headings at all returns null', openingHeadingsFact([{ path: '/main.tex', text: 'plain' }]) === null)
}

// ===========================================================================
// ReDoS tripwires: adversarial LaTeX a student can put in one source file
// ===========================================================================
// Roughly forty regexes in this file put an unbounded negated class after a cheap command
// anchor - `\label{[^}]+}`, `\cite{[^}]*}`, `\includegraphics[[^\]]*]`, the shared
// NON_PROSE_ARGUMENT and SECTION_COMMAND. On a file that opens the anchor and never closes
// the brace, each of those scanned to the end of the file at every anchor, which is
// quadratic on Node's single thread: 1 MB of `\includegraphics[` measured at 67 s of
// frozen event loop, from one student clicking Run. Every negated class is now bounded, so
// each anchor is constant work. The payloads are sized so a reverted `*`/`+` overshoots
// this 2 s ceiling by tens of seconds; the ceiling is a tripwire, not a benchmark.
{
    const REDOS_CEILING_MS = 2000
    const payloads = {
        'unclosed \\label braces': R`\label{`.repeat(60000),
        'unclosed \\cite braces': R`\cite{`.repeat(60000),
        'unclosed \\includegraphics option': R`\includegraphics[`.repeat(40000),
        'unclosed \\section braces': R`\section{`.repeat(60000),
        'runaway \\cite command name': '\\' + 'cite'.repeat(60000),
        'unclosed \\newglossaryentry body': R`\newglossaryentry{k}{`.repeat(40000),
    }
    for (const [label, text] of Object.entries(payloads)) {
        const docs = doc(text)
        const started = Date.now()
        let threw = null
        try {
            for (const name of Object.keys(CHECKS)) runCheck(name, docs)
        } catch (e) {
            threw = e
        }
        const elapsed = Date.now() - started
        check(
            `every check survives ${label} in linear time`,
            elapsed < REDOS_CEILING_MS && threw === null,
            `${elapsed} ms on ${(text.length / 1024).toFixed(0)} KB${threw ? ` THREW ${threw.message}` : ` (ceiling ${REDOS_CEILING_MS} ms)`}`
        )
    }
}

// ===========================================================================
// the acronym scan cap: partial is said, unbounded is refused
// ===========================================================================
// The two per-acronym scans cost one pass over the whole project per declared
// acronym. A pasted mega-list times a large document used to be an event-loop
// freeze reachable from the fast review; the cap bounds the product and the
// evidence must SAY the scan was partial, or a capped "all used" reads as a
// verdict over entries nobody looked at.
{
    const declarations = Array.from({ length: 600 }, (_, i) => R`\acro{A${i}X}{Long form ${i}}`).join('\n')
    const r = runCheck('acronyms-declared-unused', doc(`${declarations}\nProse that uses none of them.`))
    check('a 600-entry list is scanned up to the cap, not in full', /500/.test(r.evidence), r.evidence.slice(0, 160))
    check(
        'and the evidence admits the scan was partial',
        /first 500 of 600|primi 500 acronimi dichiarati su 600/.test(r.evidence),
        r.evidence.slice(-160)
    )
    // Under the cap nothing changes: no note, full count.
    const small = runCheck('acronyms-declared-unused', doc(R`\acro{ADCS}{Attitude Determination and Control System}` + '\nProse without it.'))
    check('under the cap the note stays away', !/first \d+ of|primi \d+/.test(small.evidence), small.evidence)
}

// ---------------------------------------------------------------------------
// every check carries its own "what to do"
// ---------------------------------------------------------------------------
// A verdict decided by code reached the report with no suggestion at all: the two
// requirements a reader asked about ("cite every figure", "number the equations")
// had a Riscontro and nothing telling them what to change. The fix is declared per
// check, evaluated inside runCheck so it speaks the review language, and attached
// only to verdicts the reader has to act on.
{
    const failed = run('work-markers', 'testo TODO rivedere')
    check(
        'a failed check carries a fix',
        failed.status === 'missing' && typeof failed.fix === 'string' && failed.fix.length > 10,
        failed.fix
    )
    const clean = run('work-markers', 'testo pulito senza marcatori')
    check('a met check carries no fix', clean.status === 'ok' && clean.fix === undefined)
    setChecksLanguage('it')
    const italian = run('work-markers', 'testo TODO rivedere')
    check('the fix speaks the review language', /lavorazione/.test(italian.fix || ''), italian.fix)
    setChecksLanguage('en')
    // The guard for the NEXT check somebody adds: a catalogue entry without a fix is
    // a finding with no advice, which is exactly what this wave removed.
    const missingFix = Object.entries(CHECKS)
        .filter(([, c]) => typeof c.fix !== 'function')
        .map(([name]) => name)
    check('every check in the catalogue declares a fix', missingFix.length === 0, missingFix.join(', '))
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
