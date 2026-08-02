// overleaf-lab: requirements a PARSER can decide, so nobody asks a language model.
//
// A compliance rubric mixes two kinds of requirement. "Every caption is
// self-explanatory" is a judgement: it needs a reader. "Every figure has a caption"
// is a fact about the source: counting `\caption` inside float environments answers
// it exactly, in a millisecond, with no lost-in-the-middle failure, no token budget,
// and no run-to-run variation. Asking a model the second kind buys nothing and costs
// a pass, an occasional hallucination and, on a long thesis, an "unusable answer"
// that turns into a silent n.a.
//
// GENERIC BY CONSTRUCTION. This file knows about LaTeX, never about a particular
// rubric, university or template. Each check is a named, self-describing routine
// over the project sources; a rubric opts into one by ending a requirement with
// `[check: name]`, exactly as it already opts into `[per-file]` or declares its own
// scan patterns. A rubric that names no check behaves as it always has, and a rubric
// written by somebody else for a different kind of document can use the same
// catalogue or ignore it.
//
// CONTRACT of a check: given the stripped sources, return {status, evidence,
// locations}. `status` uses the same four values as the model ("ok", "partial",
// "missing", "na"), and "na" is the honest answer when the document carries nothing
// the check applies to (no floats at all, no declared acronyms), never "ok".

// overleaf-lab: the evidence these checks build is read by the student inside a
// report whose language is the rubric's. One review runs at a time per process
// (single-flight in the controller), so a module-level language is safe.
let LANG = 'en'

// overleaf-lab: whether a language was DECLARED, as opposed to defaulted. L() falls
// back to English for anything it does not know, which is the right answer for an
// evidence string. It is the wrong answer for a check that asks a question ABOUT the
// language ("is this document set up for the rubric's language"), because that check
// would then judge every project against a language nobody chose. Those checks read
// this flag and stay `na` until a run sets one.
let LANG_DECLARED = false

export function setChecksLanguage(lang) {
    LANG = lang === 'it' ? 'it' : 'en'
    LANG_DECLARED = lang === 'it' || lang === 'en'
}
export const L = (en, it) => (LANG === 'it' && it != null ? it : en)

const FLOAT_ENVIRONMENTS = ['figure', 'table', 'longtable', 'sidewaysfigure', 'sidewaystable']

// The environments that typeset maths on a line of its own. Their content is symbol
// names, not prose, which several checks have to know.
const DISPLAY_MATHS_ENVIRONMENTS = ['equation', 'align', 'gather', 'multline', 'flalign', 'eqnarray']

// overleaf-lab: floats that may legitimately carry no \caption. A longtable is how a
// multi-page list is typeset, and on three real projects the list of symbols or of
// acronyms in the front matter was exactly that: a longtable under a chapter heading,
// with no caption because the heading already names it. Reporting "table with no
// \caption" there asks the author to add a caption to a list that must not have one,
// which is a correction that makes the document worse. Only the DEMAND is dropped: a
// longtable that does carry a caption is an ordinary captioned float and is counted
// and judged as one. longtabu is the tabu package's spelling of the same environment,
// named here for the day it is matched.
const CAPTION_OPTIONAL_FLOATS = new Set(['longtable', 'longtabu'])

// overleaf-lab: the ways a float is captioned. \caption is the ordinary one;
// \caption*{...} is the unnumbered form the caption and KOMA classes provide, used for
// a departmental logo or a decorative plate; \captionof{figure}{...} is what the
// caption package asks for when the content is not inside a float of that kind. All
// three put a caption under the reader's eyes, so a check that demands "a caption"
// must accept all three: reading only \caption reported "figure with no \caption" on
// documents that carry one.
// overleaf-lab: the negated classes in every pattern below are BOUNDED, never `*` or
// `+`, so a student file with an unclosed brace or bracket cannot make a check quadratic
// on the event loop. The bound sizes come from the corpus (the nine extracted theses and
// the ten synthetic projects) with headroom, and they are the same three numbers
// throughout: a braced argument (label, key, path, url, key=value body) is capped at 400
// (the longest real one is a 255-character \href URL); a bracket option is capped at 200
// (the longest real one is 91); and a command-name repetition like `[a-zA-Z]*cite` is
// capped at 32 (the longest real cross-reference command is "autoref", 7). See
// NON_PROSE_ARGUMENT for the full reasoning; unbounded student text with a cheap anchor
// in front of an unbounded class is exactly the ReDoS this file has paid for before.
const CAPTION_COMMAND = /\\caption(?:of\s*\{[^}]{0,400}\})?\*?\s*[[{]/

// A caption inside a subfigure belongs to the subfigure, not to the float around it.
// A figure whose only captions are its two subcaptions has no caption of its own, and
// the check answered "All 1 float environments carry a \caption" for it - a pass built
// on somebody else's caption. Blanked before the float is asked the question.
const SUBFLOAT_ENVIRONMENTS = ['subfigure', 'subtable']

const MAX_EXAMPLES = 12

// overleaf-lab: a ceiling on how many environments one file may contribute. A real
// thesis carries a couple of hundred floats; this is two orders of magnitude above
// that, so it never binds on a document and only bounds the work a deliberately
// pathological upload can ask for. Deeply nested environments are the expensive case
// even with a linear scan, because each enclosing body is a slice of the text.
const MAX_ENVIRONMENTS = 5000

// overleaf-lab: blank a span while preserving every offset and newline, so a line
// number computed afterwards is still the line of the real source.
function blankSpan(span) {
    return span.replace(/[^\n]/g, ' ')
}

// overleaf-lab: blank a set of spans with ONE rebuild of the string.
//
// The obvious loop - `text = text.slice(0, a) + blank + text.slice(b)`, once per span -
// copies the whole document for every span, so N spans over n bytes cost O(N*n). N is
// whatever the student's file contains. The same shape, in the controller's
// acknowledgements exclusion, was measured at 19 s on a 1 MB document.
//
// Ranges must arrive sorted by start. A range that begins inside one already blanked is
// dropped rather than merged: an environment nested in another is covered by its
// parent, and the cursor may only move forward.
function blankRanges(text, ranges) {
    if (ranges.length === 0) return text
    const pieces = []
    let cursor = 0
    for (const [start, end] of ranges) {
        if (start < cursor || end <= start) continue
        pieces.push(text.slice(cursor, start), blankSpan(text.slice(start, end)))
        cursor = end
    }
    pieces.push(text.slice(cursor))
    return pieces.join('')
}

// overleaf-lab: blank whole named environments, in one pass and one rebuild.
//
// This replaces `\begin{X}[\s\S]*?\end{X}` everywhere it appeared. That regex is
// QUADRATIC as soon as an \end is missing: the lazy body scans to the end of the file,
// fails, and the engine retries from the next \begin, so M unclosed opens over n bytes
// cost O(M*n) and M grows with n. Measured on the shipped code, a 2 MB document of
// repeated `\begin{verbatim}` cost 41.7 s PER CHECK, and 19 checks ship - thirteen
// minutes of frozen event loop, on a single-threaded Node that answers nobody else in
// the meantime, from one student clicking Run once. findEnvironments was rewritten as a
// linear stack scan for exactly this reason; these call sites bypassed it.
//
// An unterminated environment blanks NOTHING by default, which is what the regex did
// too, and is the safe side: stretching it to the end of the file would hide the rest
// of the document from the check.
function blankEnvironments(text, names, { toEndIfUnterminated = false } = {}) {
    const ranges = []
    for (const block of findEnvironments(text, names)) {
        if (block.terminated) {
            ranges.push([block.start, block.end])
        } else if (toEndIfUnterminated) {
            ranges.push([block.start, text.length])
            break
        }
    }
    return blankRanges(text, ranges)
}

// overleaf-lab: environments whose content is shown, not typeset. A thesis that
// documents LaTeX in an appendix contains \begin{figure} and \begin{equation*} as
// EXAMPLES, and counting them reports violations that exist only in a code listing.
// Blanked once at the entry point so every check sees the same sanitised text.
// The CONTENT is blanked, never the opening line: a listing declares its caption and
// its label in that bracket (`\begin{lstlisting}[label=lst:one]`), so blanking the
// whole environment made every reference to a code listing look like a dangling one.
const VERBATIM_ENVIRONMENTS = ['verbatim', 'Verbatim', 'lstlisting', 'minted', 'alltt']

// The optional argument of a listing and the language argument of minted, kept out of
// the blanked body along with the \begin itself. Bounded exactly as the old pattern
// bounded them, and never read past the end of the environment.
const VERBATIM_HEAD_ARGUMENTS = /^(?:\[[^\]]{0,2000}\])?(?:\{[^}]{0,200}\})?/

function blankVerbatimBodies(text) {
    const ranges = []
    for (const block of findEnvironments(text, VERBATIM_ENVIRONMENTS)) {
        if (!block.terminated) continue
        // The slice is capped at what the head pattern can possibly match, so a single
        // very long listing is not copied in full just to read its options.
        const args = VERBATIM_HEAD_ARGUMENTS.exec(
            text.slice(block.headEnd, Math.min(block.end, block.headEnd + 2300))
        )
        const bodyStart = block.headEnd + (args ? args[0].length : 0)
        // Where the closing \end{...} starts, so it survives the blanking as the
        // opening does: a check that counts environments must still see both ends.
        // From the scanner itself, not from lastIndexOf('\\end{'): the scanner now
        // accepts `\end {verbatim}` and a string search for the unspaced form would
        // miss exactly the block the scanner just paired.
        ranges.push([bodyStart, block.tailStart])
    }
    return blankRanges(text, ranges)
}

// overleaf-lab: inline verbatim. `\verb|\begin{figure}|` is how a thesis SHOWS a
// command instead of using it, and it was blanked nowhere: a document explaining
// how to insert a figure was told that figure had no caption, a shown \ref counted
// as a broken cross-reference, a shown TODO as a work marker, and the delimiter
// ended up glued inside quoted evidence. The delimiter is whatever character
// follows the command (or a braced group for \lstinline), per the manual.
const INLINE_VERB_HEAD = /\\(verb\*?|lstinline)(\[[^\]\n]{0,200}\])?/g

function blankInlineVerb(text) {
    if (!text.includes('\\verb') && !text.includes('\\lstinline')) return text
    const head = new RegExp(INLINE_VERB_HEAD.source, 'g')
    const ranges = []
    let match
    while ((match = head.exec(text)) !== null) {
        const open = text[match.index + match[0].length]
        if (open === undefined || open === '\n') continue
        const close = open === '{' ? '}' : open
        // Bounded: an inline snippet lives on its line. An unterminated \verb
        // blanks nothing, like every other unterminated construct here.
        const from = match.index + match[0].length + 1
        const end = text.indexOf(close, from)
        const newline = text.indexOf('\n', from)
        if (end === -1 || (newline !== -1 && newline < end)) continue
        // Delimiters included: they are not prose either.
        ranges.push([match.index + match[0].length, end + 1])
        head.lastIndex = end + 1
    }
    return blankRanges(text, ranges)
}

// overleaf-lab: text the author has switched off. `\begin{comment} ... \end{comment}`
// (the comment package) and `\iffalse ... \fi` are how a LaTeX writer parks a draft
// paragraph, a figure they are not sure about or a note to self without deleting it:
// none of it is typeset, and none of it is in the PDF the reader marks. Reading it as
// live text reported a figure with no caption, an unnumbered equation and a leftover
// TODO on three documents where the reader sees none of the three. Line comments were
// already stripped upstream; these are the same thing written a different way, so they
// are blanked in the same place.
function blankCommentEnvironments(text) {
    return blankEnvironments(text, ['comment'])
}

// \iffalse needs its own scan, because TeX conditionals nest and are closed by \fi
// rather than by a matching \end. An \else at the top level of the block switches the
// text back on - `\iffalse draft \else final \fi` typesets "final" - so the blanking
// stops there. An \iffalse that is never closed blanks nothing, for the same reason an
// unterminated environment does.
const CONDITIONAL_TOKEN = /\\(iffalse|if[a-zA-Z@]*|else|fi)(?![a-zA-Z@])/g

function blankFalseConditionals(text) {
    if (!text.includes('\\iffalse')) return text
    const token = new RegExp(CONDITIONAL_TOKEN.source, 'g')
    const ranges = []
    let start = -1
    let depth = 0
    let match
    while ((match = token.exec(text)) !== null) {
        const name = match[1]
        if (depth === 0) {
            if (name === 'iffalse') {
                start = match.index
                depth = 1
            }
            continue
        }
        if (name === 'else' && depth === 1) {
            ranges.push([start, match.index + match[0].length])
            depth = 0
        } else if (name === 'fi') {
            depth -= 1
            if (depth === 0) ranges.push([start, match.index + match[0].length])
        } else if (name !== 'else') {
            depth += 1
        }
    }
    return blankRanges(text, ranges)
}

function lineLookup(text) {
    const offsets = [0]
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') offsets.push(i + 1)
    }
    return index => {
        let lo = 0
        let hi = offsets.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (offsets[mid] <= index) lo = mid
            else hi = mid - 1
        }
        return lo + 1
    }
}

// A short form is data, not a pattern. An acronym like "C++" or "R&D" compiled
// straight into a RegExp throws "nothing to repeat", the throw is caught upstream, and
// the WHOLE requirement degrades to n.a.: one exotic entry in the acronym list and a
// check that was supposed to be exact silently stops answering.
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// overleaf-lab: the guards that stand before a NUMBER, shared by every check that
// reads one. Not part of a longer number or word, not straight after "=" (a setting
// such as [width=12.5mm], not a measurement), not after "{" or "[" (a command argument
// such as \vspace{2mm} or \scalebox{0.5}), not after "\" or "-" (a macro, or a signed
// term in a formula whose "unit" is really a symbol: -3B). Written once and used by
// both unit-spacing and decimal-separator: the second one did not have it, so every
// graphics option in the document counted as a decimal number.
const NUMBER_LEAD_GUARD = '(?<![\\w.,=\\\\{\\[-])'

// overleaf-lab: LaTeX does not care where a source line ends, so neither may a
// comparison between what the author wrote and what a declaration says. Folded to lower
// case at the same time, because a heading capitalises a long form that the acronym
// list writes in running case.
function flattenSpaces(text) {
    return String(text).replace(/\s+/g, ' ').toLowerCase()
}

// Balanced scan for \begin{env}...\end{env}, so a float nested in another one does
// not close its parent early. An environment whose \end is missing is reported as
// UNTERMINATED with an empty body rather than being stretched to the end of the file:
// swallowing the tail made it inherit the \caption of some later float and answer
// "ok" for a float that has none, which is a fabricated pass.
function findEnvironments(text, names) {
    // ONE pass over the begin/end tokens, with a stack per environment name, so the
    // cost is linear in the document. The obvious implementation - restart a search
    // for the matching \end at each \begin - is quadratic the moment the \end is not
    // there: every unclosed float rescans to the end of the file. Measured on the
    // previous version: 500 unclosed figures took 34 ms, 4000 took 2372 ms, and six
    // checks run per review, so a student pasting a broken environment a few thousand
    // times froze the whole Node process for every user of the instance. Node is
    // single-threaded and this runs inside the request, so that is the entire server.
    // `\s{0,8}` between the command and its brace, because TeX itself allows the
    // whitespace: `\begin {figure}` compiles and was invisible to every environment
    // scan, so a missing caption in it came back "na, no figure environments".
    // Bounded, like every other class in this file.
    const token = new RegExp(`\\\\(begin|end)\\s{0,8}\\{(${names.join('|')})\\*?\\}`, 'g')
    const open = new Map()
    const blocks = []
    let match
    while ((match = token.exec(text)) !== null && blocks.length < MAX_ENVIRONMENTS) {
        const name = match[2]
        if (!open.has(name)) {
            open.set(name, [])
        }
        const stack = open.get(name)
        if (match[1] === 'begin') {
            stack.push({ start: match.index, headEnd: match.index + match[0].length })
        } else if (stack.length > 0) {
            // Innermost first, so a float nested in another does not close its parent.
            const start = stack.pop()
            const end = match.index + match[0].length
            // headEnd travels with the block: a caller that must keep the opening line
            // and blank only the body (a listing declares its label in the bracket that
            // follows) needs to know where \begin{name} stopped. tailStart is where the
            // closing \end token begins, for a caller that must preserve it.
            blocks.push({
                name,
                start: start.start,
                headEnd: start.headEnd,
                end,
                tailStart: match.index,
                terminated: true,
                body: text.slice(start.start, end),
            })
        }
        // An \end with no \begin is a broken document, not a float: ignored.
    }
    // Whatever is still open was never closed. It gets an EMPTY body rather than the
    // rest of the file: stretching it to EOF made it inherit the \caption of some
    // later float and answer "ok" for a float that has none.
    for (const [name, stack] of open) {
        for (const start of stack) {
            if (blocks.length >= MAX_ENVIRONMENTS) break
            blocks.push({
                name,
                start: start.start,
                end: start.headEnd,
                terminated: false,
                body: text.slice(start.start, start.headEnd),
            })
        }
    }
    return blocks.sort((a, b) => a.start - b.start)
}

// overleaf-lab: read one braced argument, counting nesting, so a title that carries a
// group is not cut at the first inner closing brace. `\chapter{Il \emph{nuovo} ADCS
// del satellite}` read with `\{([^}]*)\}` yields "Il \emph{nuovo", which is how a
// heading with an acronym in it passed a check whose whole job is to find acronyms in
// headings: the same title without the \emph failed. The controller has the same
// reader (readBracedArgument) for the same reason.
//
// A brace that never closes must not cost a walk to the end of the document: without
// the cap the function is O(n) per call and O(n^2) over a file, and `\chapter{`
// repeated a few thousand times in a project any student can upload freezes the whole
// Node process. No real sectioning argument comes anywhere near this length.
const MAX_BRACED_ARGUMENT = 4000

function readBracedArgument(text, openIndex, maxChars = MAX_BRACED_ARGUMENT) {
    let depth = 0
    const limit = Math.min(text.length, openIndex + maxChars)
    for (let i = openIndex; i < limit; i++) {
        const c = text[i]
        if (c === '\\') {
            i += 1
            continue
        }
        if (c === '{') {
            depth += 1
        } else if (c === '}') {
            depth -= 1
            if (depth === 0) {
                return { value: text.slice(openIndex + 1, i), end: i }
            }
        }
    }
    return { value: text.slice(openIndex + 1, limit), end: limit }
}

// A .bib is data, a .tex is prose. Several checks must not confuse the two: a URL is
// expected in a bibliography entry and suspect in a paragraph.
const isBib = doc => /\.bib$/i.test(doc.path)
const sources = docs => docs.filter(d => !isBib(d))
const bibliographies = docs => docs.filter(isBib)

// Every cross-reference command, whatever the package: \ref, \autoref, \cref, \Cref,
// \eqref, \nameref, \vref, \pageref. \refstepcounter is deliberately not one of them.
//
// \href and \hyperref are excluded EXPLICITLY, because "href" ends in the letters
// "ref" and therefore matched `[a-zA-Z]*ref` like any cross-reference: on a real
// report all 9 \href{url}{text} links came back as references to labels that do not
// exist, with the URL printed where the label name should be. There is nothing for
// the author to fix there, which is the worst kind of finding. \hyperref names its
// label in BRACKETS, \hyperref[sec:x]{text}, so its brace form is never a reference
// either; where a \hyperref[...] use has to be counted, the bracket form is matched
// separately (see collectReferencedLabels in the controller).
// `\s{0,8}` before the brace: `\ref {fig:a}` is legal TeX, and refusing the space
// meant a dangling reference went unreported and a referenced float was "never
// referenced". Bounded, as every class here is.
const REFERENCE_COMMAND = /\\((?!href\b|hyperref\b)[a-zA-Z]{0,32}ref)\*?\s{0,8}\{([^}]{1,400})\}/g

// overleaf-lab: the two reference forms the pattern above CANNOT express, and both
// are ordinary in a cleveref/hyperref thesis. \hyperref[fig:a]{la figura} names its
// label in the brackets, and \crefrange{fig:a}{fig:b} does not end in the letters
// "ref" at all, so no `[a-zA-Z]*ref` pattern will ever see it.
//
// Not seeing them was not a blind spot that answered honestly: float-referenced
// reported correctly referenced floats as "never referenced", which sends the author
// to fix something that is right, and crossrefs-resolve answered "the document
// contains no cross-references" on a document whose only reference was a \crefrange.
// The controller's collectReferencedLabels has always handled both; two computations
// of the same thing disagreeing is the failure mode this module's own comments name.
const HYPERREF_BRACKET = /\\hyperref\s*\[([^\]]+)\]/g
const CREFRANGE_COMMAND = /\\[cC]refrange\*?\s*\{([^}]{1,400})\}\s*\{([^}]{1,400})\}/g

// overleaf-lab: a reference wrapped in the document's own macro. A thesis that
// defines `\newcommand{\vedifig}[1]{Figura~\ref{#1}}` references its floats through
// a command no `[a-zA-Z]*ref` pattern will ever see, and every float called out
// that way was reported as never referenced - a correction on a document that is
// right. The wrapper is LEARNED from its definition, never guessed from its name: a
// one-argument \newcommand whose body passes #1 to a \ref is a reference command,
// and the text inside the \ref before the #1 (`\ref{fig:#1}`) is the prefix every
// use must be resolved with. A macro that does not hand its argument to a \ref
// teaches nothing. Capped, so a generated file of definitions stays bounded work.
const WRAPPER_DEFINITION = /\\(?:re)?newcommand\s{0,40}\*?\s{0,40}\{?\\([a-zA-Z]{2,32})\}?\s{0,40}(?:\[[0-9]{1,2}\]\s{0,40}){0,2}\{/g
const WRAPPED_REFERENCE = /\\(?!href\b|hyperref\b)[a-zA-Z]{0,32}ref\*?\s{0,8}\{([^{}#]{0,100})#1\s*\}/
const MAX_REFERENCE_WRAPPERS = 32

function referenceWrappers(docs) {
    const wrappers = new Map()
    for (const doc of docs) {
        for (const m of doc.text.matchAll(WRAPPER_DEFINITION)) {
            if (wrappers.size >= MAX_REFERENCE_WRAPPERS) return wrappers
            const body = readBracedArgument(doc.text, m.index + m[0].length - 1).value
            const inner = WRAPPED_REFERENCE.exec(body)
            if (inner) wrappers.set(m[1], inner[1].trim())
        }
    }
    return wrappers
}

// The uses those wrappers produce. The label is the wrapper's prefix plus the
// argument, which is what the \ref inside will expand to.
function wrapperReferenceUses(text, wrappers) {
    const uses = []
    for (const [name, prefix] of wrappers) {
        const pattern = new RegExp(`\\\\${name}(?![a-zA-Z])\\s{0,8}\\{([^}]{1,400})\\}`, 'g')
        for (const m of text.matchAll(pattern)) {
            const argument = m[1].trim()
            uses.push({ name: `${prefix}${argument}`, index: m.index, display: `\\${name}{${argument}}` })
        }
    }
    return uses
}

// Every use of a label in one document, whatever spelling addresses it. `display` is
// how the use is written back to the reader, so a \hyperref is quoted with its
// brackets and not turned into a \ref it never was. A known wrapper is skipped here
// even when its name happens to end in "ref": its RAW argument is not the label
// (the prefix is missing), and wrapperReferenceUses reports the resolved one.
function collectReferenceUses(text, wrappers) {
    const uses = []
    for (const m of text.matchAll(REFERENCE_COMMAND)) {
        if (wrappers && wrappers.has(m[1])) continue
        for (const name of m[2].split(',')) {
            uses.push({ name: name.trim(), index: m.index, display: `\\${m[1]}{${name.trim()}}` })
        }
    }
    for (const m of text.matchAll(HYPERREF_BRACKET)) {
        uses.push({ name: m[1].trim(), index: m.index, display: `\\hyperref[${m[1].trim()}]` })
    }
    for (const m of text.matchAll(CREFRANGE_COMMAND)) {
        for (const name of [m[1], m[2]]) {
            uses.push({ name: name.trim(), index: m.index, display: `\\crefrange{${name.trim()}}` })
        }
    }
    return uses
}

// overleaf-lab: labels no document defines because a PACKAGE defines them.
// \pageref{LastPage} is how "Pagina X di Y" is written, and the label comes from the
// lastpage package: demanding a \label for it reports a defect on LaTeX that is
// correct and that the author cannot fix without breaking the page numbering. Kept to
// exactly the one that ships in the templates, case-sensitively as the package
// spells it, so this stays an exception and does not become a way to silence the
// check.
const PACKAGE_PROVIDED_LABELS = new Set(['LastPage'])

// overleaf-lab: split a bibliography into entries WITHOUT scanning to the end of the
// file when a closing brace is missing. The unbounded version of this cost quadratic
// time on a malformed .bib, which is a file any user can upload.
const MAX_BIB_ENTRY_CHARS = 4000

// The field names an entry carries, with a rough value for each. The value is cut at
// the first comma or newline because the only thing anybody reads out of it is the
// year inside a biblatex `date`.
// Only assignments at BRACE DEPTH 1 are fields. The flat scan resumed INSIDE a
// value after the 80-character cap or after a comma in it, so any "name = value"
// phrase written in a long abstract registered as a top-level field and an entry
// with no year passed the completeness check. The cap on the value stays: the only
// value any verdict reads is a date, which is short.
function bibFields(region) {
    const fields = new Map()
    let depth = 0
    for (let i = 0; i < region.length; i++) {
        const ch = region[i]
        if (ch === '{') {
            depth += 1
            continue
        }
        if (ch === '}') {
            depth -= 1
            continue
        }
        // Depth 1 is inside the entry, outside every value: exactly where BibTeX
        // reads field names.
        if (depth !== 1 || !/[a-zA-Z]/.test(ch)) continue
        const m = /^([a-zA-Z]+)\s*=\s*([^,\n]{0,80})/.exec(region.slice(i, i + 120))
        if (m) {
            const name = m[1].toLowerCase()
            if (!fields.has(name)) fields.set(name, m[2])
            // Jump past the name and the "=": the VALUE is walked by the brace
            // counter above, so a "name = value" inside it stays invisible.
            i += m[1].length
            while (i < region.length && /[\s=]/.test(region[i])) i += 1
            i -= 1
        } else {
            // Skip the rest of the word so "author" is not re-tested at "uthor".
            while (i + 1 < region.length && /[a-zA-Z]/.test(region[i + 1])) i += 1
        }
    }
    return fields
}

function bibEntries(text) {
    const entries = []
    const starts = [...text.matchAll(/@(\w+)\s*\{\s*([^,\s}]{1,200})\s*,/g)]
    for (let n = 0; n < starts.length; n++) {
        const match = starts[n]
        let depth = 1
        let i = match.index + match[0].length
        const stop = Math.min(text.length, match.index + MAX_BIB_ENTRY_CHARS)
        while (i < stop && depth > 0) {
            if (text[i] === '{') depth += 1
            else if (text[i] === '}') depth -= 1
            i += 1
        }
        // overleaf-lab: the field NAMES are read over the whole entry, not over the
        // capped body. A Zotero entry carries an `abstract` of several thousand
        // characters and puts it before the author, so on a complete entry the cap
        // above fell inside the abstract and the completeness check reported "no
        // author, no year" - a false violation on a correct bibliography, and the
        // student cannot even see what is wrong. The region ends where the NEXT
        // @entry begins, so the regions partition the file and the total work stays
        // linear: the cap still does its job, which is to bound the brace walk on a
        // .bib whose braces never close.
        const regionEnd = n + 1 < starts.length ? starts[n + 1].index : text.length
        entries.push({
            type: match[1].toLowerCase(),
            key: match[2].trim(),
            start: match.index,
            body: text.slice(match.index, i),
            fields: bibFields(text.slice(match.index, regionEnd)),
        })
    }
    return entries
}

// overleaf-lab: the OTHER bibliography. A bibliography does not have to be a .bib:
// \begin{thebibliography} ... \bibitem{key} ... \end{thebibliography} written by
// hand inside a .tex is the whole bibliography of many internship reports. Reading
// only .bib files answered "The project carries no .bib file" on a document whose
// bibliography was right there, and lost every citation check with it. Real defect,
// found on a real internship report.
const BIBITEM_COMMAND = /\\bibitem\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{([^}]{1,400})\}/g

function bibitemEntries(docs) {
    const entries = []
    for (const doc of sources(docs)) {
        const at = lineLookup(doc.text)
        for (const env of findEnvironments(doc.text, ['thebibliography'])) {
            // An environment with no \end gets an EMPTY body by design (see
            // findEnvironments), which is the safe side to err on when counting
            // floats and the wrong one when collecting KEYS: dropping them would
            // report every \cite in the document as pointing nowhere. So a
            // bibliography whose \end is missing is read to the end of the file -
            // ONCE PER FILE. Doing it for every unterminated \begin{thebibliography}
            // was a slice to EOF each time, which is quadratic in a file any user can
            // upload: 512 KB of them cost 23 s of frozen event loop, measured. The
            // first tail read already covers every environment that opens after it, so
            // the rest have nothing left to contribute.
            const body = env.terminated ? env.body : doc.text.slice(env.start)
            for (const m of body.matchAll(BIBITEM_COMMAND)) {
                entries.push({ path: doc.path, line: at(env.start + m.index), key: m[1].trim() })
            }
            if (!env.terminated) break
        }
    }
    return entries
}

// overleaf-lab: every form that DECLARES an acronym, in one place, so a declaration is
// blanked identically wherever it must not be read as running text.
// The \newglossaryentry and \DeclareAcronym forms blank BOTH braced groups: the
// second one is the key=value list that carries "short = ADCS", and leaving it
// readable made the declaration count as a use of its own acronym.
// Exported (with blankHandAcronymLists below) for the controller's per-candidate
// pre-filter: a model candidate quoted from inside a declaration is the declaration
// itself, not prose, and the controller must not keep its own diverging copy of
// this pattern.
export const ACRONYM_DECLARATION =
    /\\acro\s*\{[^}]{0,400}\}\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{[^}]{0,400}\}|\\newacronym\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{[^}]{0,400}\}\s*\{[^}]{0,400}\}\s*\{[^}]{0,400}\}|\\(?:newglossaryentry|DeclareAcronym)\s*\{[^}]{0,400}\}\s*\{[^{}]{0,400}(?:\{[^{}]{0,400}\}[^{}]{0,400}){0,8}\}/g

// overleaf-lab: the acronym list most university templates actually ship: no
// package at all, a starred heading that names it and a two-column table of
// `SHORT & Long form \\` rows. Real theses and the synthetic corpus both write it
// this way, and a collector that only knew the package forms told a document with
// a full hand-written list that its acronyms were "never declared", then counted
// the list's own rows as uses of every acronym in it.
//
// Two gates, both required, so an ordinary results table never reads as a list of
// declarations: the rows must sit under a heading that says acronyms (or its
// Italian and glossary cousins), and each row must LOOK like a declaration (short
// form with at least two capitals, long form with at least one real word). Fewer
// than two such rows is not a list.
const ACRONYM_LIST_HEADING =
    /\\(?:chapter|section|subsection)\*?\s*\{[^{}]{0,200}?(?:acronym|abbreviat|acronimi|abbreviazioni|sigle|glossar|nomenclatur)[^{}]{0,200}\}/gi
// The row terminator is `\\` or the \end of the tabular itself: the LAST row of a
// hand-written table routinely drops its `\\` (nothing follows it), and that row's
// acronym was the one entry the list did not declare.
const ACRONYM_TABLE_ROW =
    /^[ \t]*([A-Za-z0-9][A-Za-z0-9./-]{1,11})[ \t]*&[ \t]*([^&\\\n]{2,300}?)[ \t]*(?:\\\\|(?=\n[ \t]*\\end))/gm
// The OTHER hand-written shape: a description list of `\item[SHORT] Long form`
// lines under the same heading. Same two gates as the tabular rows.
const ACRONYM_ITEM_ROW = /^[ \t]*\\item\s*\[([A-Za-z0-9][A-Za-z0-9./-]{1,11})\][ \t]*([^\n%]{2,300}?)[ \t]*$/gm
// The THIRD hand-written shape, measured on a real dissertation: the short form
// set in bold and the middle column left empty, `\textbf{ADCS}&& Attitude...\\`.
// Its own pattern rather than options bolted onto the plain row, so each shape
// stays strict where it can afford to be: here the \textbf{...}& anchor is strong
// enough to allow LaTeX in the long cell (`\texttt{tf2} transform library`),
// which the plain row must keep refusing, because its anchor is one bare word
// and a backslash after it means a table of commands, not a list of acronyms.
const ACRONYM_BOLD_ROW =
    /^[ \t]*\\textbf\s*\{([A-Za-z0-9][A-Za-z0-9./-]{1,11})\}[ \t]*&{1,2}[ \t]*([^&\n]{2,300}?)[ \t]*(?:\\\\|(?=\n[ \t]*\\end))/gm
const NEXT_SECTIONING = /\\(?:chapter|section|subsection)\*?\s*\{/

function handAcronymLists(text) {
    const found = { spans: [], entries: [] }
    ACRONYM_LIST_HEADING.lastIndex = 0
    for (const heading of text.matchAll(ACRONYM_LIST_HEADING)) {
        const from = heading.index + heading[0].length
        // The list sits right under its heading: the region ends at the next
        // sectioning command, and is capped so a missing one never turns this
        // into a scan of the whole file.
        const ahead = text.slice(from, from + 20000)
        const cut = ahead.search(NEXT_SECTIONING)
        const region = cut === -1 ? ahead : ahead.slice(0, cut)
        // Sorted by position before anything else: the shapes come from separate
        // scans, and blankRanges silently drops a range that arrives out of order,
        // so a list mixing shapes would otherwise lose part of its blanking.
        const rows = [
            ...region.matchAll(ACRONYM_TABLE_ROW),
            ...region.matchAll(ACRONYM_ITEM_ROW),
            ...region.matchAll(ACRONYM_BOLD_ROW),
        ]
            .sort((a, b) => a.index - b.index)
            .filter(row => (row[1].match(/[A-Z]/g) || []).length >= 2 && /[A-Za-z][a-z]{2,}/.test(row[2]))
        if (rows.length < 2) continue
        for (const row of rows) {
            found.entries.push({ short: row[1], long: row[2].trim(), index: from + row.index })
            found.spans.push([from + row.index, from + row.index + row[0].length])
        }
    }
    return found
}

// The rows are blanked wherever declarations are blanked, for the same reason the
// package declarations are: a declaration must not be read as a use of its own
// acronym. Offset-preserving, like every other blank in this module. Exported for
// the controller's per-candidate pre-filter, beside ACRONYM_DECLARATION above.
export function blankHandAcronymLists(text) {
    return blankRanges(text, handAcronymLists(text).spans)
}

// overleaf-lab: an acronym has a SHORT FORM and, with glossaries, a KEY that is not
// the same string. `\newacronym{adcs}{ADCS}{Attitude Determination and Control System}`
// is written in the text as `\gls{adcs}`: lowercase, and nowhere near the letters ADCS.
// Keeping only the short form made every glossaries project fail two checks at once -
// "1 of 1 declared acronyms never appear in the text: ADCS" on a document that uses it
// on every page, and a silent `na` from acronym-first-use, which leaves the requirement
// unanswered rather than answered wrongly. The controller's collectAcronyms already
// knew this vocabulary; the checks did not, and two computations of the same thing
// disagreeing is the failure mode this module's own comments call out.
function collectDeclaredAcronyms(docs) {
    const acronyms = new Map()
    for (const doc of docs) {
        // acronym package: \acro{SHORT}{Long form}. There the short form IS the key.
        // Whitespace is allowed between every argument: the glossaries manual itself
        // prints declarations split over two lines, and a collector stricter than
        // the blanker meant the declaration was blanked as one and then never
        // collected as one, so the check told the student an acronym was "never
        // declared" while pointing at the file that declares it.
        for (const m of doc.text.matchAll(/\\acro\s*\{([^}]{1,400})\}\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{([^}]{0,400})\}/g)) {
            const short = m[1].trim()
            acronyms.set(short, { long: m[2].trim(), key: short })
        }
        // glossaries: \newacronym{key}{SHORT}{Long form}.
        for (const m of doc.text.matchAll(/\\newacronym\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{([^}]{0,400})\}\s*\{([^}]{1,400})\}\s*\{([^}]{0,400})\}/g)) {
            acronyms.set(m[2].trim(), { long: m[3].trim(), key: m[1].trim() })
        }
        // acro package: \DeclareAcronym{key}{short = X, long = Y}. The value list is
        // read with a bounded scan; keys other than short/long are ignored.
        for (const m of doc.text.matchAll(/\\DeclareAcronym\s*\{([^}]{0,400})\}\s*\{([^{}]{0,400})\}/g)) {
            const short = /(?:^|,)\s*short\s*=\s*\{?([^,{}]+)/.exec(m[2])
            const long = /(?:^|,)\s*long\s*=\s*\{?([^,{}]+)/.exec(m[2])
            if (short) acronyms.set(short[1].trim(), { long: long ? long[1].trim() : '', key: m[1].trim() })
        }
        // glossaries: \newglossaryentry{key}{... name={X} ...}. Only entries that
        // look like acronyms (a name in capitals) are collected; ordinary glossary
        // words are not short forms.
        for (const m of doc.text.matchAll(/\\newglossaryentry\s*\{([^}]{0,400})\}\s*\{([^{}]{0,400}(?:\{[^{}]{0,400}\}[^{}]{0,400}){0,8})\}/g)) {
            const name = /name\s*=\s*\{?([^,{}]+)/.exec(m[2])
            if (!name) continue
            const short = name[1].trim()
            if (!/^[A-Z][A-Za-z]{1,7}$/.test(short) || short !== short.toUpperCase()) continue
            const long = /(?:long|description)\s*=\s*\{?([^,{}]+)/.exec(m[2])
            acronyms.set(short, { long: long ? long[1].trim() : '', key: m[1].trim() })
        }
        // Hand-written list: `SHORT & Long form \\` under an acronym heading. The
        // short form is its own key, as with \acro. Package declarations win when
        // both exist, since they carry the key the use commands actually name.
        for (const entry of handAcronymLists(doc.text).entries) {
            if (!acronyms.has(entry.short)) {
                acronyms.set(entry.short, { long: entry.long, key: entry.short })
            }
        }
    }
    return acronyms
}

// The commands that USE an acronym, whatever the package: \ac and its family (acronym),
// \gls and \glspl (glossaries), \acrshort, \acrlong, \acrfull (glossaries again). Each
// of them names the entry by SHORT FORM or by KEY depending on the package, so both
// spellings are accepted.
const ACRONYM_USE_COMMANDS = '(?:[Aa]c[a-z]{0,32}|[Gg]ls(?:pl)?|[Aa]cr(?:short|long|full)(?:pl)?)'

// COMPILE WITH THE u FLAG. The boundaries are unicode classes so that "UEÈ" is not
// read as a use of a declared "UE": without them a truncated caps prefix passed the
// tail guard whenever the next letter was accented.
function acronymUseSource(short, entry) {
    const safe = escapeRegExp(short)
    const key = entry && entry.key && entry.key !== short ? entry.key : null
    const named = key ? `${safe}|${escapeRegExp(key)}` : safe
    // The bare KEY in running prose is not a use: it is a lowercase word nobody reads
    // as an acronym. Only the letters of the short form count outside a command.
    return (
        `\\\\${ACRONYM_USE_COMMANDS}\\*?(?:\\[[^\\]]{0,200}\\])?\\{(?:${named})\\}` +
        `|(?<![\\p{L}\\p{N}_\\\\])\\{${safe}\\}` +
        `|(?<![\\p{L}\\p{N}_\\\\])${safe}(?![\\p{L}\\p{N}_])`
    )
}

// The uses that spell the long form out BY THEMSELVES, so the package already
// guarantees a correct first use: \ac, \acf, \acl, \acp of the acronym package, and
// \gls, \Gls, \glspl, \acrlong, \acrfull of glossaries (a \gls of an entry declared
// with \newacronym prints "Long form (SHORT)" the first time). \acs and \acrshort are
// deliberately not among them: those print the short form and nothing else.
const SELF_EXPANDING_USE = /\\(?:ac|acf|acl|acp|aclp|acfp|[Gg]ls(?:pl)?|[Aa]crlong(?:pl)?|[Aa]crfull(?:pl)?)\*?[[{]/

// overleaf-lab: acronyms nobody ever declared. acronym-first-use starts from the
// DECLARED list, so on a real thesis it inspected the 2 entries of the acronym list
// while the prose used JAXA, GPU, IoU and FPS bare, never expanded and never declared.
// The defect was invisible precisely because the author had written it down nowhere,
// and an undeclared short form is the HARDER case for a reader, not the easier one.
//
// Deliberately conservative, because a false "spell this out" hands the author a
// correction that makes the text wrong. A candidate is a short all-caps token used at
// least three times IN PROSE with no parenthetical expansion at its first use. Mixed
// case (IoU) stays out: telling that apart from a symbol name needs a reader, and this
// file only answers what a parser can decide.
//
// TWO NARROWINGS PAID FOR BY REAL FALSE POSITIVES, both trading recall for precision
// on purpose (this is a young check, and a wrong "never spelled out" is worse than a
// miss):
//   - NO DIGITS. "CO2" and "H2O" in a combustion chapter, "STM32" as the part number of
//     the board, "I2C" as the bus: a token carrying a digit is a formula or a model
//     name far more often than a short form, and all four were reported on real
//     material. The cost is an acronym like "GPT4", which nobody expands anyway.
//   - FIVE AND SIX LETTERS ARE OUT. MATLAB, ANSYS, LIDAR, RADAR, COVID: at that length
//     an all-caps token is overwhelmingly a product name or an acronym that has become
//     a word, and neither is something an author can "spell out". Two to four letters
//     is where GPU, FPS, JAXA, NASA, ADCS and DSN live, which is what the check is for.
// The boundary now also rejects "/" and "-", so the IP of "TCP/IP" and the COVID of
// "COVID-19" are read as parts of the compound the author wrote, not as tokens of
// their own: "TCP/IP" was reported as an unexpanded "IP" on a document that spells the
// pair out in full at its first use.
// Unicode-aware boundaries, because "\w" without the u flag says an accented letter
// is not a letter: "PIÙ" matched as a use of "PI", and any short caps word ending in
// an accented vowel (PERÒ, GIÀ, CITTÀ) minted an acronym the document never wrote.
const UNDECLARED_ACRONYM = /(?<![\p{L}\p{N}_\\/-])([A-Z]{2,4})(?![\p{L}\p{N}_/-])/gu
const MIN_UNDECLARED_USES = 3

// The stopset is kept as small as it can be ON PURPOSE. PDF, CSV, DNA and their kind
// are acronyms a thesis should spell out, so padding this set to quieten the check
// would be hiding real findings; if the check turns out too noisy the answer is to
// require more occurrences, not more exceptions. What is genuinely not a short form:
// the Roman numerals a document writes for a part, a war or a century.
const ROMAN_NUMERALS = new Set([
    'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX',
    'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX',
    'XX', 'XXI', 'XXII', 'XXIII', 'XXIV', 'XXV', 'XXX',
])

// A unit symbol is not a short form. "16 GB of memory" is a measurement, and telling
// the author to spell GB out at its first use is the same false correction the unit
// lexicon below already exists to prevent ("a word mistaken for a unit costs a false
// correction handed to the author"). Reusing that lexicon rather than growing the
// stopset keeps the exception principled: it names exactly what this file has already
// decided is a unit, case-sensitively as the lexicon is written, so PDF, CSV and DNA
// stay findings. Built on first use because UNIT_TOKENS is declared further down the
// file and reading it at module scope would touch a const still in its temporal dead
// zone, which takes the whole module down.
let unitLexicon = null

function isUnitSymbol(token) {
    if (!unitLexicon) unitLexicon = new Set(UNIT_TOKENS)
    return unitLexicon.has(token)
}

// overleaf-lab: words a document SHOUTS. Italian technical prose writes "il valore NON
// deve superare la soglia", and three of those told the author to spell NON out as an
// acronym. Function words and negations only: no acronym is ever made of them, so this
// set cannot hide a real finding the way padding the stopset with PDF, CSV or DNA
// would. Everything here is four letters or shorter, because longer tokens no longer
// reach this test. The other half of the same defect - a title page reading "CORSO DI
// LAUREA MAGISTRALE IN INGEGNERIA" - is answered by the caps-line rule below, which
// needs no vocabulary at all.
const CAPITALISED_PROSE_WORDS = new Set([
    'di', 'da', 'in', 'il', 'la', 'lo', 'le', 'gli', 'un', 'una', 'uno',
    'non', 'nel', 'nei', 'del', 'dei', 'dal', 'dai', 'sul', 'sui', 'col', 'al', 'ai',
    'per', 'con', 'tra', 'fra', 'che', 'chi', 'cui', 'piu', 'ma', 'se', 'si', 'ne',
    'not', 'and', 'or', 'the', 'for', 'but', 'nor', 'yet', 'all', 'any', 'its', 'our',
    'who', 'why', 'how', 'this', 'that', 'with', 'from', 'into', 'only', 'also',
    'each', 'when', 'then', 'than', 'they', 'them', 'such', 'more', 'most', 'both',
])

function isAcronymCandidate(token) {
    if (ROMAN_NUMERALS.has(token)) return false
    if (CAPITALISED_PROSE_WORDS.has(token.toLowerCase())) return false
    if (isUnitSymbol(token)) return false
    // One character repeated (AA, III, XXX): a placeholder or a numeral, never a
    // short form of anything.
    if (/^(.)\1*$/.test(token)) return false
    return true
}

// Identifiers the reader never sees. A label, a citation key, a file name, an
// environment name and a package option are written in capitals often enough that
// reading them as prose would report \cite keys and image file names as acronyms the
// author had failed to spell out. Only the FIRST braced argument goes, so the visible
// text of a \href survives as the prose it is.
// \definecolor carries THREE braced groups and the second one is a colour model
// written in capitals: `\definecolor{keyBlue}{RGB}{14,0,255}` in a template's own
// setup file minted "RGB" as an undeclared acronym on five real projects. It gets
// its own alternation because the shared tail blanks one group only.
// Every negated class here is BOUNDED, and this pattern is why the bound sizes matter:
// it is run by roughly eight checks over uncapped student sources, so an unbounded
// `\{[^{}]*\}` after the cheap `\label`/`\cite` anchor turned a 1 MB upload of
// `\includegraphics[` into a quadratic scan on the event loop. The braced argument is
// capped at 400 (the longest real one across the nineteen corpus projects is a
// 255-character \href URL, comfortably under it), the option bracket at 200 (longest
// real 91), and the `cite`/`ref` command-name repetitions at 32 (longest real "autoref",
// 7). A construct longer than the cap is not blanked rather than crashing the review,
// which is the safe direction for a defence-in-depth blanker.
// The whitespace runs around the optional bracket are capped as well: `\s*` on
// both sides of `(?:\[...\])?` is two adjacent runs split by an optional atom,
// which backtracks quadratically over a run of blank lines however bounded the
// classes inside are. The trailing run is attached INSIDE the optional atom.
const NON_PROSE_ARGUMENT =
    /\\definecolor\s*\{[^{}]{0,400}\}\s*\{[^{}]{0,400}\}\s*\{[^{}]{0,400}\}|\\(?:label|[a-zA-Z]{0,32}ref|[a-zA-Z]{0,32}cite[a-zA-Z]{0,32}|includegraphics|input|include|subfile|usepackage|documentclass|bibliography|bibliographystyle|addbibresource|graphicspath|lstinputlisting|begin|end|newcommand|renewcommand|newtheorem|setlength|hypersetup|url|nolinkurl|color|textcolor|colorbox)\*?\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{[^{}]{0,400}\}/g

// overleaf-lab: a line written entirely in capitals is a title page, a heading or a
// table header row, never running prose. `NOME & TIPO & UNITA \\` repeated across three
// tables was reported as three acronyms the author had failed to spell out, and so was
// the DI of `CORSO DI LAUREA MAGISTRALE IN INGEGNERIA AEROSPAZIALE` on the title page
// every university template ships. Neither is a use of a short form IN THE TEXT, which
// is what the requirement asks about, so occurrences here do not count towards the
// three uses a candidate needs - a token that lives only in caps lines is never
// reported at all. Backslash commands are dropped before the test, because \Large,
// \textbf and \begin are markup: their lowercase letters are not the author's prose.
// Decided ONCE per line, for the whole document, rather than by walking back to the
// previous newline at every occurrence: a file written as one very long line - which a
// generated table or an exported chapter often is - would make that walk quadratic, and
// this file has paid for that mistake before.
function capitalisedLines(text) {
    return text.split('\n').map(line => !/\p{Ll}/u.test(line.replace(/\\[a-zA-Z]+/g, ' ')))
}

// How far either side of a token the parenthesis of an expansion may sit. Two
// characters was too tight: `La Japan Aerospace Exploration Agency (\textbf{JAXA})`
// put `f{` before the token and `})` after it, so an author who HAD spelled the
// acronym out was told they had not. One level of text-formatting macro is unwrapped
// before this runs (see scannable), which leaves the blanks this window walks over.
const EXPANSION_PAREN_SPAN = 16

// overleaf-lab: how the prose expansion is compared with the declared long form.
// The letter-by-letter compare alone accused authors who had expanded: a bilingual
// list entry ("European Space Agency, Agenzia Spaziale Europea") can never appear in
// the prose as one string, so it is split on commas and any segment long enough to
// identify the work counts. The minimum keeps a stray ", etc" tail from matching.
const MIN_LONG_SEGMENT = 8

function longFormNearby(window, long) {
    const flat = flattenSpaces(window)
    if (flat.includes(flattenSpaces(long))) return true
    for (const segment of String(long).split(/[,;]/)) {
        const flatSegment = flattenSpaces(segment).trim()
        if (flatSegment.length >= MIN_LONG_SEGMENT && flat.includes(flatSegment)) return true
    }
    return false
}

// overleaf-lab: an expansion that does not repeat the list word for word. The prose
// writes "(Attitude Determination and Control System, ADCS)" where the list says
// "Subsystem", or expands an entry whose long form the list never carries at all,
// and the compare above cannot see it: measured on two clean synthetic theses, 10
// acronyms flagged, all expanded in the prose. What a parser CAN decide is whether
// the words adjacent to the token spell the acronym by their INITIALS, in the two
// shapes a thesis writes: "(Long Form, SHORT)" - the Italian convention - and
// "Long Form (SHORT)" / "SHORT (Long Form)" - the classic one.
//
// The rules are conservative on purpose, because a false pass here costs a missed
// finding while a false accusation hands the author a wrong correction:
//   - every capitalised word must lend its initial (a capitalised word that does
//     not match breaks the phrase), except a sentence-initial article ("La", "The");
//   - a lowercase word may lend its initial ("of" gives FOV its O) or stay silent
//     ("to" in "Signal-to-Noise Ratio" gives nothing);
//   - at least two initials must come from CAPITALISED words, so an all-lowercase
//     phrase that happens to align ("alta determinazione con sensori" next to ADCS)
//     never counts.
// Known limit, accepted: an expansion TRANSLATED with different initials ("Agenzia
// Spaziale Europea" for ESA) is not matched here - the list-segment compare above
// covers it when the list is bilingual - and an irregular acronym whose letters come
// from word interiors (JAXA) is matched only by the letter-for-letter compare.
const MINOR_EXPANSION_WORDS = new Set([
    'the', 'a', 'an', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from',
    'il', 'lo', 'la', 'le', 'gli', 'i', 'un', 'uno', 'una',
    'di', 'del', 'dello', 'della', 'dei', 'delle', 'degli', 'e', 'ed', 'o',
    'per', 'con', 'tra', 'fra', 'su', 'sul', 'sullo', 'sulla', 'sui', 'sulle',
    'da', 'dal', 'dallo', 'dalla', 'dai', 'dalle', 'al', 'allo', 'alla', 'ai', 'alle',
    'nel', 'nello', 'nella', 'nei', 'nelle',
])

// How far around the token the words of an expansion may stretch. A 2-8 word phrase
// with articles is comfortably inside this; anything longer is a clause, not a name.
const EXPANSION_PHRASE_SPAN = 160

function initialsMatch(phrase, short) {
    const words = phrase.match(/[\p{L}]{1,40}/gu) || []
    if (words.length < 2 || words.length > 10) return false
    const letters = short.toLowerCase()
    let next = 0
    let capitals = 0
    for (const word of words) {
        const initial = word[0]
        if (next < letters.length && initial.toLowerCase() === letters[next]) {
            next += 1
            if (initial !== initial.toLowerCase()) capitals += 1
            continue
        }
        // A lowercase word that lends nothing is skipped in silence; a capitalised
        // one breaks the phrase unless it is a sentence-initial article.
        if (initial === initial.toLowerCase()) continue
        if (MINOR_EXPANSION_WORDS.has(word.toLowerCase())) continue
        return false
    }
    return next === letters.length && capitals >= 2
}

function expandsByInitials(text, start, end, short) {
    // Letters only: "S/C", "I/O" and digit-carrying tokens have no initials to spell.
    if (!/^[A-Za-z]{2,8}$/.test(short)) return false
    const lead = text.slice(Math.max(0, start - EXPANSION_PHRASE_SPAN), start)
    const tail = text.slice(end, end + EXPANSION_PHRASE_SPAN)
    const closes = /^\s*\)/.test(tail)
    // "(Long Form, SHORT)": the words share the token's parenthesis, before its comma.
    // The classes are bounded and refuse a second comma or nesting: a parenthetical
    // with more clauses in it is prose, and the segment compare is the one that reads
    // prose. Same for the two classic shapes below.
    let words = /\(\s*([^(),;:]{2,150}?)\s*,\s*$/.exec(lead)
    if (words && closes && initialsMatch(words[1], short)) return true
    // "Long Form (SHORT)": the words stand just before the opening parenthesis.
    words = /([^(),;:]{2,150}?)[\s~]*\(\s*$/.exec(lead)
    if (words && closes && initialsMatch(words[1], short)) return true
    // "SHORT (Long Form)": the words fill the parenthesis right after the token.
    words = /^\s*\(\s*([^(),;:]{2,150}?)\s*[),]/.exec(tail)
    if (words && initialsMatch(words[1], short)) return true
    return false
}

// overleaf-lab: one level of text formatting, unwrapped IN PLACE. A short form the
// author put in bold at its first use - `la Japan Aerospace Exploration Agency
// (\textbf{JAXA})` - kept the parenthesis of its own expansion two macro characters
// away from the token, and the check reported an acronym that was spelled out right
// there. The wrapper is blanked and the words inside it are left exactly where they
// were, so every offset, every newline and therefore every reported line number
// survives. One level only: nesting past that is not what a thesis writes.
const TEXT_FORMATTING_MACRO =
    /\\(?:textbf|textit|textsc|texttt|textrm|textsf|textup|textmd|textnormal|emph|underline|uline|mbox)\s*\{([^{}]{0,200})\}/g

function unwrapTextFormatting(text) {
    return text.replace(
        TEXT_FORMATTING_MACRO,
        (whole, inner) => blankSpan(whole.slice(0, whole.length - inner.length - 1)) + inner + ' '
    )
}

// overleaf-lab: \[ ... \] is display maths, the same as an equation environment, and
// the letters inside it are symbol names. It was the one display form the acronym scan
// did not blank, so `\[ x_{RMS} = ... \]` and `\[ \mathbf{A}_{ECI} = ... \]` were read
// as the first USES of RMS and ECI, in a document that spells "Root Mean Square (RMS)"
// out in the very next sentence.
//
// Paired in ONE token pass, not with a lazy `\[[\s\S]*?\]`: that pattern rescans from
// every unclosed \[ to the end of the file, which is quadratic, and even a bounded
// version of it (4000 characters per occurrence) cost 6.5 s on a 2 MB document. An
// unclosed \[ leaves everything after it untouched, which is the safe side. The
// lookbehind is there because `\\[2mm]` is a line break with extra spacing inside a
// table, not display maths.
// The same token pass serves \( ... \) as well, so findMathsSpans below can stop
// paying the lazy-regex price for the bracket form: 2 MB of unclosed `\[` cost it
// 9.5 s, which is the very shape the paragraph above was written about.
const DISPLAY_MATHS_BRACKET = /(?<!\\)\\([[\]()])/g

function pairedMathsSpans(text, open, close) {
    if (!text.includes(`\\${open}`)) return []
    const token = new RegExp(DISPLAY_MATHS_BRACKET.source, 'g')
    const spans = []
    let start = -1
    let match
    while ((match = token.exec(text)) !== null) {
        if (match[1] === open) {
            if (start === -1) start = match.index
        } else if (match[1] === close && start !== -1) {
            spans.push([start, match.index + match[0].length])
            start = -1
        }
    }
    return spans
}

function blankDisplayMaths(text) {
    return blankRanges(text, pairedMathsSpans(text, '[', ']'))
}

// overleaf-lab: the order the READER meets the files in. "First use" decided by the
// order the files happen to arrive in is alphabetical - Appendices before Mainmatter -
// so a thesis that expands GPU in chapter 4 and then uses it in appendix A was told
// the appendix use came first and accused at the appendix line. The include walk from
// the main file is the order the document is actually read in; files nothing includes
// (a parked draft, an orphan chapter) keep their old place at the end rather than
// vanishing from the scan, because a use inside them is still a use.
function includeOrdered(docs) {
    const { docs: reached } = reachableSources(docs)
    const seen = new Set(reached)
    return [...reached, ...sources(docs).filter(doc => !seen.has(doc))]
}

// The prose the acronym scans read, shared so that the declared scan, the
// undeclared scan and the headings check can never disagree about what counts as
// prose: maths blanked, one level of formatting unwrapped, the acronym list and
// every declaration blanked, identifiers (labels, cite keys, file names) blanked.
// Walked in include order (see above), so "the first use" is the document's own.
function acronymScannable(docs) {
    return includeOrdered(docs).map(doc => ({
        path: doc.path,
        text: blankHandAcronymLists(
            blankEnvironments(
                unwrapTextFormatting(
                    blankDisplayMaths(
                        doc.text.replace(/\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]{0,400}?(?<!\\)\$/g, blankSpan)
                    )
                ),
                [...DISPLAY_MATHS_ENVIRONMENTS, 'acronyms', 'acronym']
            )
        ).replace(ACRONYM_DECLARATION, blankSpan).replace(NON_PROSE_ARGUMENT, blankSpan),
        at: lineLookup(doc.text),
    }))
}

// overleaf-lab: where the sectioning TITLES sit. A chapter title is display, not
// running prose: an acronym there is the business of acronyms-in-headings, and
// counting the title as "the first use in the text" accused a thesis that titles a
// chapter "PMP Formulation" and expands the acronym in the very first paragraph -
// standard practice, reported twice for one title. Computed on the scannable text,
// whose blanking is offset-preserving, so the spans are the spans of the source.
function headingTitleSpans(text) {
    return mergeSpans(collectHeadings(text).map(h => [h.index, h.bodyStart]))
}

// `keepExpanded` keeps the tokens whose first prose use carries a parenthetical
// expansion. acronyms-in-headings needs them: an author who expands KKT at its first
// use did right by first-use, but "KKT problem creation" is still a title with an
// acronym in it, and the two requirements are different questions.
function findUndeclaredAcronyms(scannable, declared, options = {}) {
    const uses = new Map()
    for (const doc of scannable) {
        // The maths, the acronym list and the declarations are already blanked by the
        // caller, for the same reasons they are blanked for a declared acronym.
        const prose = doc.text.replace(/(?<!\\)%[^\n]*/g, blankSpan).replace(NON_PROSE_ARGUMENT, blankSpan)
        const capsLine = capitalisedLines(prose)
        // Lazy: the heading walk costs a pass over every sectioning command, and a
        // file with no candidate tokens (most files) never needs it.
        let titles = null
        for (const m of prose.matchAll(UNDECLARED_ACRONYM)) {
            const token = m[1]
            if (declared.has(token) || !isAcronymCandidate(token)) continue
            // A title is not a prose use: it neither counts towards the three uses
            // a candidate needs nor becomes the "first use" the expansion test reads.
            if (!titles) titles = headingTitleSpans(prose)
            if (insideSpans(titles, m.index)) continue
            const line = doc.at(m.index)
            if (capsLine[line - 1]) continue
            if (!uses.has(token)) uses.set(token, { count: 0, first: null })
            const entry = uses.get(token)
            entry.count += 1
            if (!entry.first) entry.first = { path: doc.path, line, prose, index: m.index }
        }
    }
    const found = []
    for (const [token, entry] of uses) {
        // Used once or twice is a passing mention - a mission name in a caption, a
        // file format in a footnote - and demanding an expansion there is noise.
        if (entry.count < MIN_UNDECLARED_USES) continue
        // An expansion written into the prose is the author doing the right thing
        // without an acronym list: "Japan Aerospace Exploration Agency (JAXA)", or
        // "JAXA (Japan Aerospace Exploration Agency)".
        if (!options.keepExpanded) {
            const { prose, index } = entry.first
            const end = index + token.length
            if (/\(\s*$/.test(prose.slice(Math.max(0, index - EXPANSION_PAREN_SPAN), index))) continue
            if (/^\s*\(/.test(prose.slice(end, end + EXPANSION_PAREN_SPAN))) continue
        }
        found.push({ token, count: entry.count, path: entry.first.path, line: entry.first.line })
    }
    return found
}

// overleaf-lab: `[warning: ...]` at the END of an evidence string is the ENGINE's
// reliability marker, and only the engine may write it. Both readers - the React
// pane and the exported HTML report - strip it with a tail regex and render what is
// inside as the amber "treat this evidence with care" badge.
//
// Several checks quote raw student text into their evidence: the 50 characters
// around "wikipedia", the first 60 of a bare URL. So a student who writes
// `[warning: nothing here is real]` in their own LaTeX had that sentence rendered as
// the badge AND the tail of the real evidence removed from what the reader sees - on
// the one class of verdict the report tells the reader to trust most, because a
// parser decided it. Quoted text therefore loses the bracket that makes the sequence
// a marker; the words survive, so the reader still sees exactly what was written.
function neutraliseWarningMarker(text) {
    return String(text ?? '')
        .replace(/\[\s*warning\s*:([^\]]*)\]/gi, '(warning:$1)')
        .replace(/\[\s*warning\s*:/gi, '(warning:')
}

// Sorted, non-overlapping [start, end) spans, so membership is a binary search.
function mergeSpans(spans) {
    const sorted = spans.slice().sort((a, b) => a[0] - b[0])
    const merged = []
    for (const span of sorted) {
        const last = merged[merged.length - 1]
        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
        else merged.push([span[0], span[1]])
    }
    return merged
}

function insideSpans(spans, index) {
    let lo = 0
    let hi = spans.length - 1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (index < spans[mid][0]) hi = mid - 1
        else if (index >= spans[mid][1]) lo = mid + 1
        else return true
    }
    return false
}

// overleaf-lab: where a macro DEFINITION lives. A thesis that wraps its figures in
// `\newcommand{\figura}[3]{...\begin{figure}...\caption{#2}...}` has exactly ONE
// figure environment in its source - the one inside the definition - and three real
// floats a parser cannot see without expanding TeX. This file will never expand TeX,
// so the honest thing is to say so rather than to judge the template as if it were a
// float: that reported "all 1 float environments carry a \caption" on a document with
// three floats nobody looked at, and reported a \newenvironment whose \caption lives
// in its closing half as a float with no caption at all.
const MAX_MACRO_DEFINITION = 8000

function macroDefinitionRegions(text) {
    const regions = []
    for (const m of text.matchAll(/\\(?:re)?new(command|environment)\s*\*?\s*/g)) {
        let i = m.index + m[0].length
        const limit = Math.min(text.length, m.index + MAX_MACRO_DEFINITION)
        // \newcommand has ONE body; \newenvironment has begin and end, so two.
        const maxBodies = m[1] === 'environment' ? 2 : 1
        // The name: \figura, {\figura} or {figura}.
        if (text[i] === '\\') {
            i += 1
            while (i < limit && /[a-zA-Z]/.test(text[i])) i += 1
        } else if (text[i] === '{') {
            i = readBracedArgument(text, i).end + 1
        }
        let end = i
        // Then the argument count, the default value, and the one or two bodies.
        // BOUNDED to what a definition can actually have: two [..] options and two
        // braced bodies (\newenvironment carries begin and end). The unbounded walk
        // annexed EVERY brace group that followed, so the standard
        // `\renewcommand{\arraystretch}{1.3}` + `{\small ...table...}` recipe
        // swallowed a real float, and a real missing caption with it.
        let options = 0
        let bodies = 0
        while (i < limit && bodies < maxBodies) {
            while (i < limit && /\s/.test(text[i])) i += 1
            if (text[i] === '[' && options < 2 && bodies === 0) {
                const close = text.indexOf(']', i)
                if (close === -1 || close >= limit) break
                i = close + 1
                options += 1
                continue
            }
            if (text[i] === '{') {
                i = readBracedArgument(text, i).end + 1
                end = i
                bodies += 1
                continue
            }
            break
        }
        regions.push([m.index, end])
    }
    return mergeSpans(regions)
}

function result(status, evidence, locations = []) {
    return {
        status,
        evidence: neutraliseWarningMarker(evidence),
        // The locations carry quoted text too (`what` is the matched URL, the
        // acronym, the caption), and they are rendered next to the evidence.
        locations: locations.slice(0, MAX_EXAMPLES).map(location => ({
            ...location,
            what: location && location.what != null ? neutraliseWarningMarker(location.what) : location.what,
        })),
    }
}

function listing(items) {
    const shown = items.slice(0, MAX_EXAMPLES)
    return (
        shown.map(i => `${i.path}:${i.line} ${i.what}`).join(' | ') +
        (items.length > shown.length
            ? ` | ${L(`and ${items.length - shown.length} more`, `e altri ${items.length - shown.length}`)}`
            : '')
    )
}

export const CHECKS = {
    'float-caption': {
        describe: 'every figure and table environment contains a \\caption',
        run(docs) {
            const bad = []
            let total = 0
            // How many float environments were found inside a macro DEFINITION. They
            // are not floats: they are the template of one, and the floats they
            // really produce are wherever the macro is used, which nothing short of
            // expanding TeX can see. Counted so the evidence can say so.
            let inMacro = 0
            for (const doc of docs) {
                const at = lineLookup(doc.text)
                const macros = macroDefinitionRegions(doc.text)
                for (const block of findEnvironments(doc.text, FLOAT_ENVIRONMENTS)) {
                    if (insideSpans(macros, block.start)) {
                        inMacro += 1
                        continue
                    }
                    // An environment with no \end is a broken document whatever it is,
                    // so the exemption below does not cover it.
                    if (!block.terminated) {
                        total += 1
                        bad.push({
                            path: doc.path,
                            line: at(block.start),
                            what: `${block.name} ${L(
                                `is never closed, no \\end{${block.name}}`,
                                `mai chiusa, manca \\end{${block.name}}`
                            )}`,
                        })
                        continue
                    }
                    // The second test only runs on a float that HAS a caption and does
                    // contain subfloats: blanking the body of every float in a deeply
                    // nested document costs O(size x depth), which is the shape this
                    // file keeps paying for.
                    const captioned =
                        CAPTION_COMMAND.test(block.body) &&
                        (!/\\begin\s{0,8}\{sub/.test(block.body) ||
                            CAPTION_COMMAND.test(blankEnvironments(block.body, SUBFLOAT_ENVIRONMENTS)))
                    // A captionless longtable is layout, not a defect: skipped in
                    // silence AND left out of the total, so "All N float environments
                    // carry a \caption" counts only what the check actually required
                    // one of. Counting it and staying quiet would inflate N with an
                    // environment nobody looked at.
                    if (!captioned && CAPTION_OPTIONAL_FLOATS.has(block.name)) continue
                    total += 1
                    if (!captioned) {
                        bad.push({
                            path: doc.path,
                            line: at(block.start),
                            what: `${block.name} ${L('with no \\caption', 'senza \\caption')}`,
                        })
                    }
                }
            }
            // The claim "all N floats carry a caption" must never cover floats this
            // check did not look at. Said in every branch, including the ones that
            // pass, because that is exactly where an unstated gap does its damage.
            const caveat = inMacro
                ? L(
                      ` ${inMacro} more ${
                          inMacro === 1 ? 'is' : 'are'
                      } written inside a \\newcommand or \\newenvironment: the floats those macros produce where ` +
                          'they are USED were not inspected, only their definition.',
                      ` Altri ${inMacro} sono scritti dentro un \\newcommand o un \\newenvironment: i flottanti che quelle ` +
                          'macro producono dove vengono USATE non sono stati ispezionati, solo la loro definizione.'
                  )
                : ''
            if (total === 0)
                return result(
                    'na',
                    inMacro
                        ? L(
                              `The only float environments in the source are the ${inMacro} written inside a ` +
                                  '\\newcommand or a \\newenvironment: the floats those macros produce where they ' +
                                  'are used cannot be inspected without expanding them, which this check does not do.',
                              `Gli unici ambienti flottanti nel sorgente sono i ${inMacro} scritti dentro un ` +
                                  '\\newcommand o un \\newenvironment: i flottanti che quelle macro producono dove ' +
                                  'vengono usate non sono ispezionabili senza espanderle, cosa che questo controllo non fa.'
                          )
                        : L(
                              'The document contains no figure or table environments.',
                              'Il documento non contiene ambienti figure o table.'
                          )
                )
            if (bad.length === 0)
                return result(
                    'ok',
                    L(
                        `All ${total} float environments carry a \\caption.${caveat}`,
                        `Tutti i ${total} ambienti flottanti hanno una \\caption.${caveat}`
                    )
                )
            return result(
                'missing',
                L(
                    `${bad.length} of ${total} float environments have no \\caption or are never closed: ${listing(
                        bad
                    )}.${caveat}`,
                    `${bad.length} ambienti flottanti su ${total} non hanno la \\caption o non vengono mai chiusi: ${listing(
                        bad
                    )}.${caveat}`
                ),
                bad
            )
        },
    },

    'caption-position': {
        describe: 'a figure caption sits below the graphic, a table caption above the content',
        run(docs) {
            const bad = []
            // Two counters on purpose. `captioned` is how many captions exist,
            // `inspected` is how many this check could actually place, and only the
            // second one may appear in an "ok". Reporting "all 36 captions are on the
            // expected side" after skipping the ones with no recognisable content
            // anchor claims a coverage the check does not have, which is the same lie
            // as answering "ok" where the honest answer is "na".
            let captioned = 0
            let inspected = 0
            for (const doc of docs) {
                const at = lineLookup(doc.text)
                // Same guard as float-caption: a float inside a \newcommand is a
                // template, and judging its caption's position judges a document
                // that does not exist.
                const macros = macroDefinitionRegions(doc.text)
                for (const block of findEnvironments(doc.text, PLACEABLE_FLOATS)) {
                    if (!block.terminated) continue
                    if (insideSpans(macros, block.start)) continue
                    const caption = block.body.search(CAPTION_COMMAND)
                    if (caption === -1) continue
                    captioned += 1
                    const isTable = /table/.test(block.name)
                    // The content anchor: the graphic for a figure, the tabular for a
                    // table. A float built some other way (\input of a pgf plot, a
                    // minipage, a \resizebox) has no anchor to compare against, so it
                    // is left uninspected and SAID to be left uninspected.
                    const content = isTable
                        ? block.body.search(/\\begin\{(tabular|tabularx|longtable|array)/)
                        : block.body.search(/\\includegraphics|\\begin\{tikzpicture\}|\\subfloat/)
                    if (content === -1) continue
                    inspected += 1
                    const captionFirst = caption < content
                    if (isTable ? !captionFirst : captionFirst) {
                        bad.push({
                            path: doc.path,
                            line: at(block.start + caption),
                            what: isTable
                                ? L(
                                      'table caption is below the content',
                                      'la didascalia della tabella sta sotto al contenuto'
                                  )
                                : L(
                                      'figure caption is above the graphic',
                                      'la didascalia della figura sta sopra alla grafica'
                                  ),
                        })
                    }
                }
            }
            const skipped = captioned - inspected
            const caveat = skipped
                ? L(
                      ` ${skipped} more could not be placed: no \\includegraphics, tikzpicture or tabular inside them.`,
                      ` Altri ${skipped} non sono collocabili: al loro interno non c'è né \\includegraphics, né tikzpicture, né tabular.`
                  )
                : ''
            if (captioned === 0)
                return result(
                    'na',
                    L(
                        'No float in the document carries a \\caption.',
                        'Nessun flottante del documento ha una \\caption.'
                    )
                )
            if (inspected === 0)
                return result(
                    'na',
                    L(
                        `None of the ${captioned} captioned floats could be inspected: none contains a ` +
                            'graphic or a tabular to place the caption against.',
                        `Nessuno dei ${captioned} flottanti con didascalia è ispezionabile: nessuno contiene ` +
                            'una grafica o una tabular rispetto a cui collocare la didascalia.'
                    )
                )
            if (bad.length === 0)
                return result(
                    'ok',
                    L(
                        `All ${inspected} captions that could be placed are on the expected side.${caveat}`,
                        `Tutte le ${inspected} didascalie collocabili stanno dal lato giusto.${caveat}`
                    )
                )
            return result(
                'missing',
                L(
                    `${bad.length} of ${inspected} captions are on the wrong side: ${listing(bad)}${caveat}`,
                    `${bad.length} didascalie su ${inspected} stanno dal lato sbagliato: ${listing(bad)}${caveat}`
                ),
                bad
            )
        },
    },

    'float-referenced': {
        describe: 'every labelled figure or table is referred to at least once in the text',
        run(docs) {
            const labels = []
            const used = new Set()
            // A float with no \label cannot be referenced by any means, so it is
            // outside what this check can decide. It is counted anyway: saying "all 12
            // labelled floats are referenced" in a document with 30 floats would let
            // the reader believe 30 were checked.
            let unlabelled = 0
            // Floats written inside a \newcommand are templates, not floats: their
            // \label carries a macro parameter (fig:#3) that exists in no document,
            // and reporting it "never referenced" told the author to reference a
            // string nobody can write. Same guard float-caption already has.
            let inMacro = 0
            // The document's own reference wrappers, learned once for the project:
            // a float called out through \vedifig{fig:a} is referenced.
            const wrappers = referenceWrappers(sources(docs))
            for (const doc of docs) {
                const at = lineLookup(doc.text)
                const macros = macroDefinitionRegions(doc.text)
                // A float nested in a float shares its parent's body text, so the
                // parent scanned its child's \label as its own and the count claimed
                // three labelled floats where the document has two. Every label is
                // attributed to its INNERMOST terminated float, in one sweep over the
                // document: re-walking each block's body would be quadratic on
                // nested floats, which is the mistake this file's tripwires exist for.
                const blocks = findEnvironments(doc.text, FLOAT_ENVIRONMENTS)
                const terminated = blocks
                    .filter(block => block.terminated)
                    .sort((a, b) => a.start - b.start)
                const own = new Map()
                {
                    let next = 0
                    const stack = []
                    for (const lm of doc.text.matchAll(/\\label\s{0,8}\{([^}]{1,400})\}/g)) {
                        while (next < terminated.length && terminated[next].start <= lm.index) {
                            stack.push(terminated[next])
                            next += 1
                        }
                        while (stack.length && lm.index >= stack[stack.length - 1].end) stack.pop()
                        const innermost = stack[stack.length - 1]
                        if (!innermost) continue
                        if (!own.has(innermost)) own.set(innermost, [])
                        own.get(innermost).push(lm)
                    }
                }
                for (const block of blocks) {
                    if (insideSpans(macros, block.start)) {
                        inMacro += 1
                        continue
                    }
                    const mine = block.terminated ? own.get(block) || [] : []
                    if (mine.length === 0) {
                        unlabelled += 1
                        continue
                    }
                    for (const lm of mine) {
                        labels.push({ name: lm[1].trim(), path: doc.path, line: at(lm.index) })
                    }
                }
                // Any cross-reference command, whatever the package, INCLUDING the
                // bracket form of \hyperref and \crefrange. The shared collector, not
                // a private copy of it: the private copy also matched \href, so the
                // URL of a link could silently "reference" a label of the same name
                // and hide a float that is never called out.
                for (const use of collectReferenceUses(doc.text, wrappers)) used.add(use.name)
                for (const use of wrapperReferenceUses(doc.text, wrappers)) used.add(use.name)
            }
            const caveat = (unlabelled
                ? L(
                      ` ${unlabelled} float${unlabelled === 1 ? '' : 's'} carr${
                          unlabelled === 1 ? 'ies' : 'y'
                      } no \\label and therefore cannot be referenced at all: those were not judged here.`,
                      unlabelled === 1
                          ? ' 1 flottante non ha una \\label e quindi non è citabile in alcun modo: qui non è stato giudicato.'
                          : ` ${unlabelled} flottanti non hanno una \\label e quindi non sono citabili in alcun modo: qui non sono stati giudicati.`
                  )
                : '') + (inMacro
                ? L(
                      ` ${inMacro} float${inMacro === 1 ? ' is' : 's are'} written inside a macro definition and not judged: only expanding TeX could see the floats it produces.`,
                      inMacro === 1
                          ? ' 1 flottante è scritto dentro la definizione di una macro e non è stato giudicato: solo espandendo TeX si vedrebbero i flottanti che produce.'
                          : ` ${inMacro} flottanti sono scritti dentro definizioni di macro e non sono stati giudicati: solo espandendo TeX si vedrebbero i flottanti che producono.`
                  )
                : '')
            if (labels.length === 0)
                return result(
                    'na',
                    L(
                        `No figure or table carries a \\label.${caveat}`,
                        `Nessuna figura o tabella ha una \\label.${caveat}`
                    )
                )
            const orphans = labels
                .filter(l => !used.has(l.name))
                .map(l => ({
                    ...l,
                    what: `\\label{${l.name}} ${L('is never referenced', 'mai citata nel testo')}`,
                }))
            if (orphans.length === 0)
                return result(
                    'ok',
                    L(
                        `All ${labels.length} labelled floats are referenced in the text.${caveat}`,
                        `Tutti i ${labels.length} flottanti con label sono citati nel testo.${caveat}`
                    )
                )
            return result(
                'missing',
                L(
                    `${orphans.length} of ${labels.length} labelled floats are never referenced: ${listing(
                        orphans
                    )}${caveat}`,
                    `${orphans.length} flottanti con label su ${labels.length} non sono mai citati: ${listing(
                        orphans
                    )}${caveat}`
                ),
                orphans
            )
        },
    },

    'numbered-equations': {
        describe: 'display equations are numbered, so they can be referred to',
        run(docs) {
            const bad = []
            let total = 0
            for (const doc of docs) {
                const at = lineLookup(doc.text)
                for (const m of doc.text.matchAll(
                    /\\begin\s{0,8}\{(equation|align|gather|multline|flalign|eqnarray)(\*?)\}/g
                )) {
                    total += 1
                    if (m[2] === '*') {
                        bad.push({
                            path: doc.path,
                            line: at(m.index),
                            what: `${m[1]}* ${L('is unnumbered', 'non numerata')}`,
                        })
                    }
                }
                // displaymath has no numbered form at all: every occurrence violates.
                for (const m of doc.text.matchAll(/\\begin\s{0,8}\{displaymath\}/g)) {
                    total += 1
                    bad.push({
                        path: doc.path,
                        line: at(m.index),
                        what: `displaymath ${L('is unnumbered', 'non numerata')}`,
                    })
                }
                // \[ ... \] is display maths with no number. An escaped \\[ (a line
                // break with spacing) is not, hence the guard on the preceding char.
                // The line is read at the \[ itself, not at the guard character: the
                // guard is often the newline of the PREVIOUS line, and every \[ that
                // opened a line was reported one line too high.
                for (const m of doc.text.matchAll(/(^|[^\\])\\\[/g)) {
                    total += 1
                    bad.push({
                        path: doc.path,
                        line: at(m.index + m[1].length),
                        what: `\\[ ... \\] ${L('is unnumbered', 'non numerata')}`,
                    })
                }
                // $$ ... $$ is plain-TeX display maths: deprecated in LaTeX, still very
                // common in a first thesis, and never numbered. Missing it was not a
                // harmless gap: a document that uses $$ throughout came back "na, the
                // document contains no display equations", which reads as "nothing to
                // check here" for a document where nothing is numbered at all.
                for (const m of doc.text.matchAll(/(^|[^\\$])\$\$[\s\S]*?\$\$/g)) {
                    total += 1
                    bad.push({
                        path: doc.path,
                        line: at(m.index + m[1].length),
                        what: `$$ ... $$ ${L('is unnumbered', 'non numerata')}`,
                    })
                }
            }
            if (total === 0)
                return result(
                    'na',
                    L(
                        'The document contains no display equations.',
                        'Il documento non contiene equazioni fuori testo.'
                    )
                )
            if (bad.length === 0)
                return result(
                    'ok',
                    L(
                        `All ${total} display equations are numbered.`,
                        `Tutte le ${total} equazioni fuori testo sono numerate.`
                    )
                )
            return result(
                'missing',
                L(
                    `${bad.length} of ${total} display equations are unnumbered: ${listing(bad)}`,
                    `${bad.length} equazioni fuori testo su ${total} non sono numerate: ${listing(bad)}`
                ),
                bad
            )
        },
    },

    'acronym-first-use': {
        describe: 'the first appearance of an acronym in the text spells it out',
        run(docs) {
            const declared = collectDeclaredAcronyms(docs)
            const bad = []
            let checked = 0
            // A declaration is not a use, so the declarations are blanked out. Blanked,
            // not skipped: skipping the whole FILE meant that a project declaring an
            // acronym in the chapter where it first appears (perfectly legal, and what
            // the glossaries documentation itself shows) had that entire chapter
            // dropped from the scan, silently. Blanking preserves every offset and
            // newline, so the reported line stays the line of the real source.
            // The WHOLE list environment goes, not just the \acro lines inside it: its
            // optional argument is the column-width key, and the package's own
            // convention is to pass the LONGEST acronym there. Blanking only the
            // declarations left `\begin{acronym}[ADCS]` standing as the earliest
            // "use" of ADCS in the project, reported at line 1 of the acronym list.
            // No running prose lives inside that environment, so nothing is lost.
            // MATHS IS NOT PROSE. The letters of an acronym inside $...$ are a symbol
            // name: $x_{RMS}$ is a variable, $\mathbf{A}_{ECI}$ is a matrix, and
            // neither is "using the acronym in the text" in the sense this requirement
            // means. Scanning them reported an elenco dei simboli as using every
            // acronym it names as a subscript, before any of them had been spelled
            // out, which is a defect the author cannot act on: the subscript has to
            // say RMS. Only this check blanks maths; whether a symbol subscript keeps
            // a declared acronym in the list is a different question, answered by
            // acronyms-declared-unused, and there a subscript does count as a use.
            // A .bib IS NOT PROSE. Every other prose check goes through sources();
            // this one read `docs`, so the undeclared scan walked the bibliography
            // database and told the student to spell out "IEEE" at /refs.bib:4, where
            // IEEE is the journal name, and "BOOK" at line 1, where @BOOK is the entry
            // type of an IEEE-Xplore export. Three @BOOK entries were enough. Nobody
            // re-judges a [check:] verdict, so it shipped to the student as printed.
            // The shared scannable: a file called ADCS.png used to read as the
            // first use of ADCS here, because this scan did not blank identifiers
            // while the undeclared one did.
            const scannable = acronymScannable(docs)
            // The sectioning titles of each file, computed once: a title is display,
            // owned by acronyms-in-headings, so a match inside one is not "the first
            // use in the text" (see headingTitleSpans for the double accusation).
            const titleSpans = new Map()
            const titlesOf = doc => {
                if (!titleSpans.has(doc)) titleSpans.set(doc, headingTitleSpans(doc.text))
                return titleSpans.get(doc)
            }
            for (const [short, entry] of declared) {
                const long = entry.long
                let first = null
                // \ac and \acf expand on first use by themselves, so they are correct
                // by construction; a bare \acs or the literal letters are the ones
                // that have to be preceded by the long form. The glossaries spellings
                // (\gls of the KEY) are matched here too, or a project written that way
                // never reached this loop at all and the requirement went unanswered.
                const pattern = new RegExp(acronymUseSource(short, entry), 'gu')
                for (const doc of scannable) {
                    for (const m of doc.text.matchAll(pattern)) {
                        if (insideSpans(titlesOf(doc), m.index)) continue
                        first = {
                            path: doc.path,
                            line: doc.at(m.index),
                            index: m.index,
                            doc,
                            match: m[0],
                        }
                        break
                    }
                    if (first) break
                }
                if (!first) continue
                checked += 1
                const expandsItself = SELF_EXPANDING_USE.test(first.match)
                if (expandsItself) continue
                // Otherwise the long form must appear at or just before the first use.
                // COMPARED WITH THE WHITESPACE NORMALISED, on both sides. The window was
                // compared as raw text, so an ordinary editor line wrap between
                // "l'Attitude Determination and" and "Control System (ADCS)" - which a
                // five-word expansion suffers constantly - meant the long form was never
                // found and the author was told they had not spelled out what they had
                // just spelled out. Bilingual list entries match by SEGMENT and an
                // expansion worded differently from the list matches by INITIALS: both
                // shapes accused authors who had expanded (see longFormNearby and
                // expandsByInitials for the measured cases).
                const window = first.doc.text.slice(Math.max(0, first.index - 400), first.index + long.length + 40)
                if (long && longFormNearby(window, long)) continue
                if (expandsByInitials(first.doc.text, first.index, first.index + first.match.length, short)) continue
                bad.push({
                    path: first.path,
                    line: first.line,
                    what: `"${short}" ${L(
                        'is used before being spelled out',
                        'usato prima della definizione per esteso'
                    )}`,
                })
            }
            // Then the short forms that are in no list at all. Reported after the
            // declared ones because a declared acronym used too early is the defect the
            // requirement is written about; an undeclared one is the same defect with
            // the declaration missing as well.
            for (const found of findUndeclaredAcronyms(scannable, declared)) {
                checked += 1
                bad.push({
                    path: found.path,
                    line: found.line,
                    what: `"${found.token}" ${L(
                        `is used ${found.count} times, never spelled out and never declared`,
                        `usato ${found.count} volte, mai scritto per esteso e mai dichiarato`
                    )}`,
                })
            }
            if (declared.size === 0 && checked === 0)
                return result(
                    'na',
                    L(
                        'The document declares no acronyms, and no undeclared short form is used without being spelled out.',
                        'Il documento non dichiara acronimi e nessuna sigla non dichiarata è usata senza essere scritta per esteso.'
                    )
                )
            if (checked === 0)
                return result(
                    'na',
                    L(
                        `${declared.size} acronyms are declared but none is used in the text.`,
                        `Sono dichiarati ${declared.size} acronimi, ma nessuno viene usato nel testo.`
                    )
                )
            if (bad.length === 0)
                return result(
                    'ok',
                    L(
                        `All ${checked} acronyms used in the text are spelled out at first use.`,
                        `Tutti i ${checked} acronimi usati nel testo sono scritti per esteso alla prima occorrenza.`
                    )
                )
            return result(
                'missing',
                L(
                    `${bad.length} of ${checked} acronyms are not spelled out at first use: ${listing(bad)}`,
                    `${bad.length} acronimi su ${checked} non sono scritti per esteso alla prima occorrenza: ${listing(
                        bad
                    )}`
                ),
                bad
            )
        },
    },

    'acronyms-in-headings': {
        describe: 'chapter and section titles contain no acronym',
        run(docs) {
            const declared = collectDeclaredAcronyms(docs)
            // Undeclared short forms count too: a \chapter{KKT problem creation} is
            // exactly as much an acronym in a heading as a declared one, and the
            // same report used to name KKT as used-but-undeclared two requirements
            // further down while this check said "1 of 77 headings". The candidates
            // come from the same detector the other requirement uses, so the two can
            // no longer disagree about what is an acronym. keepExpanded, because an
            // acronym the prose expands correctly is still an acronym in a title.
            const undeclared = findUndeclaredAcronyms(acronymScannable(docs), declared, { keepExpanded: true }).map(
                f => f.token
            )
            const bad = []
            let total = 0
            for (const doc of docs) {
                const at = lineLookup(doc.text)
                // The opening brace only: the title is read with the brace-aware
                // reader, because `\chapter{Il \emph{nuovo} ADCS del satellite}` cut
                // at the first `}` is "Il \emph{nuovo" and the acronym after the
                // group was never part of what the check looked at.
                for (const m of doc.text.matchAll(
                    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\s{0,40}\*?\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{/g
                )) {
                    total += 1
                    // Merge of two fixes to the same lines: the brace-aware title
                    // reader (nested groups no longer cut the title short) and the
                    // package-aware matcher (\gls, \acrshort and the entry key count
                    // as uses, a lowercase word that happens to spell the key does not).
                    // The title is then cleared of identifiers before matching AND
                    // before quoting: a \label{sec:ADCS} inside the braces is not
                    // part of the printed title, and the evidence used to show the
                    // student a title that does not exist. Capped at what a printed
                    // heading can be: with the default 4000-character walk, half a
                    // million unclosed `\section{` cost 11.7 s now that the check
                    // reads titles even with nothing declared.
                    const raw = readBracedArgument(doc.text, m.index + m[0].length - 1, MAX_HEADING_TITLE).value
                    const title = raw.replace(NON_PROSE_ARGUMENT, blankSpan)
                    const shown = title.replace(/\s+/g, ' ').trim().slice(0, 60)
                    let hit = null
                    for (const [short, entry] of declared) {
                        const inTitle = new RegExp(acronymUseSource(short, entry), 'u')
                        if (inTitle.test(title)) {
                            hit = short
                            break
                        }
                    }
                    if (!hit) {
                        for (const token of undeclared) {
                            const inTitle = new RegExp(
                                `(?<![\\p{L}\\p{N}_\\\\])${escapeRegExp(token)}(?![\\p{L}\\p{N}_])`,
                                'u'
                            )
                            if (inTitle.test(title)) {
                                hit = token
                                break
                            }
                        }
                    }
                    // The most common shape of the defect: a short form the author
                    // put in a title and DEFINED NOWHERE - never declared, never
                    // used three times in prose. The candidate detector cannot see
                    // it, so the title itself is scanned with the same token rules
                    // (measured: 20 of 20 such fragments were invisible). A title
                    // styled entirely in capitals says nothing about acronyms and
                    // is skipped, exactly as the prose scan skips caps lines.
                    if (!hit && /\p{Ll}/u.test(title.replace(/\\[a-zA-Z]+/g, ' '))) {
                        for (const t of title.matchAll(UNDECLARED_ACRONYM)) {
                            if (declared.has(t[1]) || !isAcronymCandidate(t[1])) continue
                            hit = t[1]
                            break
                        }
                    }
                    if (hit) {
                        bad.push({
                            path: doc.path,
                            line: at(m.index),
                            what: L(
                                `"${hit}" appears in the ${m[1]} title "${shown}"`,
                                `"${hit}" compare nel titolo ${m[1]} "${shown}"`
                            ),
                        })
                    }
                }
            }
            if (total === 0)
                return result(
                    'na',
                    L(
                        'The document has no sectioning commands.',
                        'Il documento non contiene comandi di sezionamento.'
                    )
                )
            if (bad.length === 0)
                return result(
                    'ok',
                    L(
                        `None of the ${total} headings contains an acronym.`,
                        `Nessuno dei ${total} titoli contiene un acronimo.`
                    )
                )
            return result(
                'missing',
                L(
                    `${bad.length} of ${total} headings contain an acronym: ${listing(bad)}`,
                    `${bad.length} titoli su ${total} contengono un acronimo: ${listing(bad)}`
                ),
                bad
            )
        },
    },
}

// A longtable is not a float: it breaks across pages and centres itself through its
// own column specification, so asking it for \centering states a falsehood as a fact.
const CENTRABLE_FLOATS = FLOAT_ENVIRONMENTS.filter(name => name !== 'longtable')

// overleaf-lab: a float INSIDE a float has its own \centering, and it centres itself,
// not its parent. A figure whose two subfigures are each centred while the figure is
// not came back "all 1 floats are centred", which is the requirement answered from
// the wrong environment. Blanking the sub-environments before the test asks the
// question of the float that was actually asked about.
const NESTED_FLOAT_ENVIRONMENTS = ['subfigure', 'subtable']

// The blanking itself is blankEnvironments, defined at the top of the file: the
// two waves that needed it wrote the same linear scanner independently, and the
// top one survived the merge because it also handles unterminated environments.

// Same environment, second reason. The longtable package REQUIRES the caption to come
// immediately after \begin{longtable}, before the header rows, and that same \begin is
// the only content anchor a table check has. So a caption written exactly where the
// package demands read as "below the content" every single time: a defect reported on
// a document whose author had no choice in the matter.
const PLACEABLE_FLOATS = FLOAT_ENVIRONMENTS.filter(name => name !== 'longtable')

CHECKS['float-centered'] = {
    describe: 'floats are centred and none of them lets the text wrap around it',
    run(docs) {
        const bad = []
        let total = 0
        // Floats written inside a macro definition are templates: judging the
        // definition produced a verdict about a document that does not exist, with
        // a denominator float-caption disagreed with. Skipped and declared, exactly
        // as float-caption does.
        let inMacro = 0
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const macros = macroDefinitionRegions(doc.text)
            for (const m of doc.text.matchAll(/\\begin\s{0,8}\{(wrapfigure|wraptable)\*?\}/g)) {
                if (insideSpans(macros, m.index)) continue
                // Counted in the TOTAL as well as in the problems. It used to be
                // counted only as a problem, so a document whose single float was a
                // wrapfigure reported "1 problems on 0 floats": a denominator that
                // excludes what the numerator counts is arithmetic no reader can
                // make sense of.
                total += 1
                bad.push({
                    path: doc.path,
                    line: at(m.index),
                    what: `${m[1]} ${L(
                        'lets the text wrap around the float',
                        'lascia che il testo scorra attorno al flottante'
                    )}`,
                })
            }
            for (const block of findEnvironments(doc.text, CENTRABLE_FLOATS)) {
                if (!block.terminated) continue
                if (insideSpans(macros, block.start)) {
                    inMacro += 1
                    continue
                }
                total += 1
                if (!/\\centering|\\begin\{center\}|\\centerline/.test(blankEnvironments(block.body, NESTED_FLOAT_ENVIRONMENTS))) {
                    bad.push({
                        path: doc.path,
                        line: at(block.start),
                        what: `${block.name} ${L('has no \\centering', 'senza \\centering')}`,
                    })
                }
            }
        }
        const macroCaveat = inMacro
            ? L(
                  ` ${inMacro} float${inMacro === 1 ? ' is' : 's are'} written inside a macro definition and not judged here.`,
                  inMacro === 1
                      ? ' 1 flottante è scritto dentro la definizione di una macro e qui non è stato giudicato.'
                      : ` ${inMacro} flottanti sono scritti dentro definizioni di macro e qui non sono stati giudicati.`
              )
            : ''
        if (total === 0 && bad.length === 0)
            return result(
                'na',
                L('The document contains no floats.', 'Il documento non contiene flottanti.') + macroCaveat
            )
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `All ${total} floats are centred, and none wraps the text around it.`,
                    `Tutti i ${total} flottanti sono centrati e nessuno fa scorrere il testo attorno a sé.`
                ) + macroCaveat
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${total} floats have a problem: ${listing(bad)}`,
                `${bad.length} flottanti su ${total} hanno un problema: ${listing(bad)}`
            ) + macroCaveat,
            bad
        )
    },
}

// overleaf-lab: function words the learner must never mistake for the document's
// name of a numbered object. A thesis writes "nel \ref{cap:uno}" or "the \ref{fig}"
// often enough that a preposition or an article is learned as a reference word, and
// then every "nel 3" in running prose is reported as a hand-written cross-reference.
// Real defect: a thesis was told `"Nel 1974" is a number written by hand, not a
// \ref`, and another learned "della" the same way. Compared case-insensitively,
// because a sentence-initial "Nel" and a mid-sentence "nel" are the same word.
const looksLikeYear = digits => /^\d{4}$/.test(digits) && Number(digits) >= 1000 && Number(digits) <= 2999

const REFERENCE_STOPWORDS = new Set([
    'nel', 'nella', 'nei', 'nelle',
    'del', 'della', 'dei', 'delle',
    'al', 'alla', 'ai', 'alle',
    'dal', 'dalla', 'un', 'una',
    'il', 'la', 'lo', 'le',
    'in', 'a', 'e',
    'the', 'of', 'at', 'on', 'an', 'and', 'from', 'to', 'by',
])

// LANGUAGE-INDEPENDENT BY CONSTRUCTION. Nothing here knows the word for "Figure": it
// is LEARNED, by looking at what the document itself writes just before a reference.
// A word used twice or more that way is this document's own name for a numbered
// object. Two checks need it: manual-numbering, where such a word followed by a
// literal digit is a number the author typed instead of letting LaTeX produce it, and
// decimal-separator, where the same digits are a section number and not a decimal.
function learnReferenceWords(docs) {
    const before = new Map()
    for (const doc of sources(docs)) {
        for (const use of collectReferenceUses(doc.text)) {
            const lead = doc.text.slice(Math.max(0, use.index - 40), use.index)
            const word = /([\p{L}]{3,})[\s~]*$/u.exec(lead)
            if (!word) continue
            before.set(word[1], (before.get(word[1]) || 0) + 1)
        }
    }
    return [...before.entries()]
        .filter(([, n]) => n >= 2)
        .map(([w]) => w)
        .filter(w => !REFERENCE_STOPWORDS.has(w.toLowerCase()))
}

// The subset of sectioning words safe for manual-numbering: each of these names an
// object LaTeX numbers itself, so "capitolo 2" written by hand IS a hand-written
// cross-reference. It exists because the learned vocabulary alone goes blind on a
// thesis that uses \autoref: there the word is PRINTED BY the command, never typed
// before it, so nothing is learned and "Il capitolo 2 descrive..." sailed through.
// "punto", "step" and the dotted abbreviations stay out: "punto 2" is ordinary
// prose often enough that an authoritative check must not fire on it.
const NUMBERED_OBJECT_WORDS = [
    'capitolo', 'capitoli', 'paragrafo', 'paragrafi', 'sezione', 'sezioni',
    'sottosezione', 'appendice', 'tabella', 'figura', 'equazione', 'formula',
    'chapter', 'section', 'subsection', 'subsubsection', 'appendix',
    'table', 'figure', 'equation',
]

CHECKS['manual-numbering'] = {
    describe: 'no cross-reference is written by hand as a literal number',
    run(docs) {
        const words = [...new Set([...learnReferenceWords(docs), ...NUMBERED_OBJECT_WORDS])]
        // Digits may carry a subsection tail ("figura 3.2"), and the evidence quotes
        // the text as matched: a report that said "figura 3" about a document that
        // writes "figura 3.2" was quoting a string the source does not carry.
        //
        // The separator is REQUIRED and machine arguments are blanked first, both
        // paid for by the same measured false positive: a main.tex made of
        // `\input{capitolo1}` lines was reported as 48 hand-written cross-references.
        // A reference typed by hand always separates word and number ("capitolo 1",
        // "figura~3.2"); "capitolo1" with nothing between them is a file name, in an
        // \input argument or quoted in prose ("si veda capitolo1.tex").
        const pattern = new RegExp(`(?<![\\p{L}])(${words.map(escapeRegExp).join('|')})[\\s~]+(\\d+(?:\\.\\d+)*)`, 'giu')
        const bad = []
        let total = 0
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const prose = doc.text.replace(NON_PROSE_ARGUMENT, blankSpan)
            for (const m of prose.matchAll(pattern)) {
                // A year is not a cross-reference. A figure, a table or a chapter
                // never carries a four-digit number, so "nel 1974" and "the 2019
                // edition" are prose, not a number the author typed instead of a
                // \ref. Real defect: a thesis was told its year was a hand-written
                // cross-reference.
                if (looksLikeYear(m[2])) continue
                total += 1
                bad.push({
                    path: doc.path,
                    line: at(m.index),
                    what: L(
                        `"${m[0]}" is a number written by hand, not a \\ref`,
                        `"${m[0]}" è un numero scritto a mano, non un \\ref`
                    ),
                })
            }
        }
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `No hand-written number follows any of the ${words.length} words checked as names of ` +
                        `numbered objects (learned from this document's own \\ref usage, plus the standard sectioning words).`,
                    `Nessun numero scritto a mano segue una delle ${words.length} parole controllate come nomi di ` +
                        `oggetti numerati (imparate dall'uso dei \\ref del documento, più le parole di sezione standard).`
                )
            )
        return result(
            'missing',
            L(
                `${total} hand-written cross-references: ${listing(bad)}`,
                `${total} richiami scritti a mano: ${listing(bad)}`
            ),
            bad
        )
    },
}

// overleaf-lab: a mathematical interval is not a decimal comma. "[0,1]" is the range
// of a sigmoid, "(-1,1)" the range of a tanh, and the comma between the endpoints has
// nothing to do with how the document writes 0,75. Four of five real projects were
// told their "0,1" was a decimal comma inconsistent with the rest of the text, on
// documents that never wrote a decimal comma at all: the author is sent to change a
// formula that is correct. Recognised by the brackets around it, within a span far too
// short to be a sentence, so a comma in running prose is untouched.
//
// AT LEAST ONE OF THE TWO BRACKETS MUST BE SQUARE. Accepting "( ... )" on both sides
// swallowed an ordinary parenthesised value - "la precisione sul test set (0,82) resta
// la migliore" - and with it the only decimal comma of the document, so a `missing`
// came back as `ok`. A round-bracket pair is how technical prose quotes a number; a
// half-open interval always shows its square side, "[0,1)" or "(0,1]", and a closed
// interval "[0,1]" shows two.
// The endpoint classes accept an exponent: "$[-10^4,10^4]$" is as much an interval
// as "[0,1]", and refusing the caret handed five of those commas to a real project
// as decimal separators to fix.
const INTERVAL_OPENS = /([[(])\s*-?[\d.^{}eE+-]{0,8}$/
const INTERVAL_CLOSES = /^[\d.^{}eE+-]{0,8}\s*([\])])/
const INTERVAL_SPAN = 8

function insideInterval(text, start, end) {
    const open = INTERVAL_OPENS.exec(text.slice(Math.max(0, start - INTERVAL_SPAN), start))
    if (!open) return false
    const close = INTERVAL_CLOSES.exec(text.slice(end, end + INTERVAL_SPAN))
    if (!close) return false
    return open[1] === '[' || close[1] === ']'
}

// overleaf-lab: a number and its decimal separator.
//
// THE TRAILING GUARD USED TO BE `(?![\d.,])`, which refused any decimal followed by a
// point or a comma - that is, every decimal that ENDS A SENTENCE and every decimal in a
// comma-separated list. "Il rendimento vale 0.85. Il rapporto è 5.4. Il carico alare è
// 3.2." came back `na - the document contains no decimal numbers`, and an English
// thesis whose only stray comma was "3,4 kN/m^2" came back `ok - all 1 decimal numbers
// use the comma`, stating the inverse of its own convention over a sample of one. What
// the guard has to reject is a THIRD group of digits (a version or a section number,
// 1.2.3, and the mixed "10.000,50"), so it now rejects exactly that.
const DECIMAL_NUMBER_TAIL = '(\\d+)([.,])(\\d+)(?![.,]\\d)'

// The macros whose argument IS a number: siunitx writes \num{12,4} and \SI{12.5}{\mm}
// where the digits are a measurement, not a command option. They have to be read
// separately, because the lead guard below deliberately refuses anything after a "{".
// EVERY braced group is read, up to the three these macros can carry: \SIrange
// {1,5}{2,5}{\km} used to surrender its second endpoint to the "{" guard, so a
// correct comma from the majority convention was handed to the author as the defect.
const VALUE_MACRO_HEAD = /\\(?:num|numlist|numrange|numproduct|SI|SIrange|SIlist|qty|qtyrange|qtylist)\s*((?:\{[^{}]{0,80}\}\s*){1,3})/g
const BRACED_GROUP = /\{([^{}]{0,80})\}/g

// What the number scans read instead of the raw source. Three transforms, all
// offset-preserving: coordinate environments are blanked whole, because "(2.75,10)"
// in a tikzpicture and "ellipse (1.75cm and 0.75cm)" in a circuitikz produced two
// entirely false verdicts on a real project; one level of text formatting is
// unwrapped, because "\textbf{0,85}" in a results table is a number the document
// really writes and the "{" guard was hiding every bolded value; and the maths
// wrappers are unwrapped for the same reason, because "$1.5\,\mathrm{m}$" is the
// textbook way to write a unit and no scan could see through \mathrm.
const COORDINATE_ENVIRONMENTS = ['tikzpicture', 'circuitikz', 'pgfpicture']
const VALUE_MARKUP_MACRO = /\\(?:mathrm|mathbf|mathit|mathsf|text|si)\s*\{([^{}]{0,80})\}/g

function prepareValueText(text) {
    return blankEnvironments(unwrapTextFormatting(text), COORDINATE_ENVIRONMENTS).replace(
        VALUE_MARKUP_MACRO,
        (whole, inner) => blankSpan(whole.slice(0, whole.length - inner.length - 1)) + inner + ' '
    )
}

// Letters before a number are allowed exactly when they are the tail of a macro
// name: "$6.27\pm0,07$" is a real decimal after \pm, and the regex lookbehind that
// refused every letter hid the one genuine decimal comma of a real thesis behind
// the "m" of its own \pm. "width=0.8" stays a setting ("=" is still refused), and
// a word glued straight onto digits stays refused too.
const DECIMAL_LEAD_RELAXED = '(?<![\\d.,_=\\\\{\\[-])'

function numberAfterMacro(text, index) {
    let i = index - 1
    while (i >= 0 && /[A-Za-z]/.test(text[i])) i--
    return i < index - 1 && text[i] === '\\'
}

// overleaf-lab: "nel paragrafo 3.2" is a section number, not a decimal. The tail
// guard above only rejects a THIRD digit group, so "3.2" straight after a sectioning
// word still needs a vocabulary to be recognised for what it is; one hand-written
// section number in an Italian thesis that writes every real decimal with a comma
// was enough to flip the verdict to "both separators are in use" and to name the
// CORRECT commas as the defect.
//
// Two vocabularies, because neither covers the other: the words this document itself
// writes before a reference (learned, so it works in any language) and the sectioning
// words below, which are what a document that never writes a \ref still uses.
// Abbreviations are listed without their full stop; the reader below allows one.
const SECTIONING_WORDS = new Set([
    'capitolo', 'capitoli', 'paragrafo', 'paragrafi', 'sezione', 'sezioni',
    'sottosezione', 'appendice', 'allegato', 'punto', 'tabella', 'figura',
    'equazione', 'formula',
    'chapter', 'section', 'subsection', 'subsubsection', 'appendix', 'annex',
    'table', 'figure', 'equation', 'step',
    // The dotted abbreviations, without their stop (the reader below allows one).
    // 'sect' and 'chap' were missing, so the 3.2 of "Sect. 3.2" counted as a
    // decimal point and, in a comma-decimal document, handed the document's own
    // correct commas over as the numbers to fix.
    'cap', 'par', 'sez', 'sec', 'sect', 'chap', 'fig', 'tab', 'eq', 'eqn', 'app',
])

// overleaf-lab: the pieces the thousands-consistency rules read (see below, where
// the verdict is built). A bare integer of four digits or more is a number the
// author chose NOT to group; the bound keeps the class finite like every other.
// An integer straight before a closing bracket is an interval endpoint, and a
// four-digit year counts only when a unit follows it ("1200 RPM" is a speed,
// "nel 1984" is a date and must never become the ungrouped twin of "1.984 m").
const BARE_INTEGER = /(?<![\w.,=\\{\[-])(\d{4,8})(?![.,]?\d)/g
const INTERVAL_TAIL_AFTER = /^\s*[\])]/

CHECKS['decimal-separator'] = {
    describe: 'one decimal separator is used throughout, either the point or the comma',
    run(docs) {
        const seen = { '.': [], ',': [] }
        // The "=", "{" and "[" guards are shared with unit-spacing: a number after
        // them is a setting such as [width=0.8\textwidth], not a measurement.
        // Letters are relaxed here and re-checked in code (numberAfterMacro), so
        // \pm0,07 counts and "v2.5" still does not.
        const decimal = new RegExp(`${DECIMAL_LEAD_RELAXED}${DECIMAL_NUMBER_TAIL}`, 'g')
        const bare = new RegExp(DECIMAL_NUMBER_TAIL, 'g')
        const learned = new Set(learnReferenceWords(docs).map(w => w.toLowerCase()))
        let sectionRefs = 0
        // overleaf-lab: comma-grouped thousands in a document whose decimals use the
        // point. "25,000 orbite" in an Italian thesis is the English grouping
        // convention (or a stray comma decimal - the reader cannot tell, and neither
        // can this scan, so the report names both readings). Collected only when the
        // rubric DECLARES Italian, through the same language mechanism as
        // language-support: in an English document "100,000 samples" is simply
        // correct, and in a comma-decimal document the same token is a plain decimal
        // and stays out of reach. Measured on the corpus: 3 true findings, 0 benign
        // (the definecolor triples never reach here - a comma-chained group fails
        // either the lead guard or the comma-digit lookahead below).
        const grouped = []
        // Every three-digit group (either separator) and every bare integer, for
        // the thousands-consistency rules assembled after the scan.
        const groups = []
        const bares = []
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const text = prepareValueText(doc.text)
            const found = [...text.matchAll(decimal)]
            for (const value of text.matchAll(VALUE_MACRO_HEAD)) {
                const blobStart = value.index + value[0].length - value[1].length
                for (const group of value[1].matchAll(BRACED_GROUP)) {
                    const offset = blobStart + group.index + 1
                    for (const m of group[1].matchAll(bare)) {
                        found.push({ ...m, index: offset + m.index, fromValueMacro: true })
                    }
                }
            }
            for (const m of found) {
                // The letter rule the relaxed guard deferred to code. Not applied to
                // digits read out of a \num or \SI argument, which bypass the guards
                // by design. Applied BEFORE the grouping branch below, so a version
                // tail glued to a word ("v2,500") is a version there too.
                const prev = text[m.index - 1]
                if (!m.fromValueMacro && prev !== undefined && /[A-Za-z]/.test(prev) && !numberAfterMacro(text, m.index)) {
                    continue
                }
                // A group of exactly three digits can be a thousands separator in
                // either convention, so it says nothing about the DECIMAL separator
                // and counting it would invent a violation out of "15.000" - UNLESS
                // the integer part starts with a zero: "0.018" is a decimal and
                // nothing else, and skipping it as a possible thousands answered
                // "all 1 decimal numbers use the comma" on a document that mixes
                // "0.018" with "1,5". A COMMA group in an Italian document is still
                // remembered (see `grouped` above): whether it turns into a finding
                // is decided after the document's own convention is known. The
                // comma-digit lookahead refuses chained groups ("2,128,9" in a
                // colour triple), and the interval guard refuses "[0,250]".
                if (m[3].length === 3 && m[1][0] !== '0') {
                    if (
                        !/^\s*,\s*\d/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 4)) &&
                        !insideInterval(text, m.index, m.index + m[0].length)
                    ) {
                        groups.push({
                            separator: m[2],
                            digits: `${m[1]}${m[3]}`,
                            tail: m[3],
                            path: doc.path,
                            line: at(m.index),
                            what: `${m[1]}${m[2]}${m[3]}`,
                        })
                        if (m[2] === ',' && LANG === 'it' && LANG_DECLARED) {
                            grouped.push({ path: doc.path, line: at(m.index), what: `${m[1]},${m[3]}` })
                        }
                    }
                    continue
                }
                // A number introduced by a sectioning word is a cross-reference the
                // author wrote by hand. That IS a defect, and manual-numbering is the
                // check that reports it; here it would only pollute the count of how
                // this document writes its decimals. The exception is a number that
                // carries a unit: "step 0.5 mm" is a measurement, whatever word
                // stands before it.
                const lead = /([\p{L}]{2,})\.?[\s~]*$/u.exec(
                    text.slice(Math.max(0, m.index - 40), m.index)
                )
                if (
                    lead &&
                    (SECTIONING_WORDS.has(lead[1].toLowerCase()) || learned.has(lead[1].toLowerCase())) &&
                    !UNIT_AFTER_NUMBER.test(text.slice(m.index + m[0].length, m.index + m[0].length + 16))
                ) {
                    sectionRefs += 1
                    continue
                }
                // Only the comma can be mistaken for an interval: an interval needs
                // two endpoints, so "[0.1]" is a decimal point and nothing else.
                if (m[2] === ',' && insideInterval(text, m.index, m.index + m[0].length)) continue
                seen[m[2]].push({
                    path: doc.path,
                    line: at(m.index),
                    what: `${m[1]}${m[2]}${m[3]}`,
                })
            }
            for (const m of text.matchAll(BARE_INTEGER)) {
                const end = m.index + m[0].length
                if (INTERVAL_TAIL_AFTER.test(text.slice(end, end + 4))) continue
                if (looksLikeYear(m[1]) && !UNIT_AFTER_NUMBER.test(text.slice(end, end + 16))) continue
                bares.push({ digits: m[1], path: doc.path, line: at(m.index) })
            }
        }
        // overleaf-lab: the thousands written two ways. Three rules, each paid for
        // on the fragment corpus and each conservative on purpose, because a group
        // like "1.200" is a legal three-place decimal in English and a legal
        // thousands in Italian and the check must never guess:
        //   - the SAME digit string grouped and ungrouped in one document ("1.200
        //     RPM" beside "1200 RPM") is inconsistent whatever the digits mean, in
        //     any language;
        //   - in DECLARED Italian, where the point IS the grouping convention, a
        //     point-group beside a five-digit bare integer is grouping applied to
        //     one number and not the other (four-digit bare integers stay out:
        //     "12.000 cicli e 8500 prove" is accepted typography);
        //   - in declared Italian, a comma-group of the X,000 shape beside a
        //     point-group mixes the two conventions outright; the X,142 shape
        //     stays silent because "3,142" beside "1.500 km" reads as an ordinary
        //     comma decimal beside a point-thousands, which is correct Italian.
        const thousandsBad = []
        const bareByDigits = new Map(bares.map(b => [b.digits, b]))
        for (const g of groups) {
            const twin = bareByDigits.get(g.digits)
            if (!twin) continue
            thousandsBad.push({
                path: g.path,
                line: g.line,
                what: L(
                    `${g.what} and ${twin.digits} (${twin.path}:${twin.line}) are the same number written two ways`,
                    `${g.what} e ${twin.digits} (${twin.path}:${twin.line}) sono lo stesso numero scritto in due modi`
                ),
            })
        }
        if (LANG === 'it' && LANG_DECLARED) {
            const pointGroups = groups.filter(g => g.separator === '.')
            const big = bares.find(b => b.digits.length >= 5)
            if (pointGroups.length > 0 && big && seen['.'].length <= seen[','].length && thousandsBad.length === 0) {
                const g = pointGroups[0]
                thousandsBad.push({
                    path: g.path,
                    line: g.line,
                    what: L(
                        `${g.what} groups its thousands while ${big.digits} (${big.path}:${big.line}) is left ungrouped`,
                        `${g.what} raggruppa le migliaia mentre ${big.digits} (${big.path}:${big.line}) resta senza separatore`
                    ),
                })
            }
            for (const g of groups) {
                if (g.separator !== ',' || g.tail !== '000' || pointGroups.length === 0) continue
                thousandsBad.push({
                    path: g.path,
                    line: g.line,
                    what: L(
                        `${g.what} groups with a comma while ${pointGroups[0].what} groups with a point`,
                        `${g.what} raggruppa con la virgola mentre ${pointGroups[0].what} raggruppa con il punto`
                    ),
                })
            }
        }
        const thousandsNote = thousandsBad.length
            ? L(
                  ` Also, the thousands are written inconsistently: ${listing(thousandsBad)}`,
                  ` Inoltre, le migliaia sono scritte in modo incoerente: ${listing(thousandsBad)}`
              )
            : ''
        // The count the evidence states must be the count the scan measured, so the
        // numbers set aside as section references are declared instead of silently
        // shrinking "all N decimal numbers".
        const setAside = sectionRefs > 0
            ? L(
                  ` ${sectionRefs} numbers were set aside as hand-written section references.`,
                  ` ${sectionRefs} numeri sono stati esclusi come richiami di sezione scritti a mano.`
              )
            : ''
        const dots = seen['.'].length
        const commas = seen[','].length
        // The grouping finding exists only against the document's OWN convention: a
        // comma group where the decimals use the point. Without point dominance the
        // comma may simply be this document's decimal separator, and with no
        // decimals at all there is no convention to contradict - both stay silent.
        const groupingActive = grouped.length > 0 && dots > commas
        const groupingNote = groupingActive
            ? L(
                  ` Also, ${grouped.length} number${grouped.length === 1 ? ' uses' : 's use'} a comma the English way, ` +
                      `to group thousands (or as a stray comma decimal - either reading contradicts this document's ` +
                      `point convention): ${listing(grouped)}`,
                  ` Inoltre, ${grouped.length} numer${grouped.length === 1 ? 'o usa' : 'i usano'} la virgola all'inglese, ` +
                      `come separatore delle migliaia (o come virgola decimale isolata: entrambe le letture contraddicono ` +
                      `la convenzione del punto di questo documento): ${listing(grouped)}`
              )
            : ''
        if (dots + commas === 0) {
            // No ordinary decimals, but the thousands may still contradict each
            // other: the fragment corpus is full of documents whose only numbers
            // are grouped ("1.200") and ungrouped ("12000") integers.
            if (thousandsBad.length > 0)
                return result(
                    'missing',
                    L(
                        `The document's thousands are written inconsistently: ${listing(thousandsBad)}`,
                        `Le migliaia del documento sono scritte in modo incoerente: ${listing(thousandsBad)}`
                    ),
                    thousandsBad
                )
            return result(
                'na',
                L('The document contains no decimal numbers.', 'Il documento non contiene numeri decimali.')
            )
        }
        if (dots === 0 || commas === 0) {
            const base = L(
                `All ${dots + commas} decimal numbers use the ${dots ? 'point' : 'comma'}. ` +
                    'Groups of exactly three digits were ignored: they can be a thousands separator.',
                `Tutti i ${dots + commas} numeri decimali usano ${dots ? 'il punto' : 'la virgola'}. ` +
                    'I gruppi di esattamente tre cifre sono stati ignorati: possono essere un separatore delle migliaia.'
            ) + setAside
            if (groupingActive || thousandsBad.length > 0)
                return result('missing', base + groupingNote + thousandsNote, grouped.concat(thousandsBad))
            return result('ok', base)
        }
        const minority = dots < commas ? seen['.'] : seen[',']
        // ONE stray number against an established convention is more often a version
        // number, a page range or a single slip than a broken convention: naming it
        // as partial tells the author exactly what to look at, where a missing that
        // declares "both separators are in use" over a lone "3.9" inverts the
        // document's own convention and hands its correct numbers over as defects.
        if (minority.length === 1 && dots + commas >= 4 && !groupingActive && thousandsBad.length === 0)
            return result(
                'partial',
                L(
                    `${dots + commas - 1} of ${dots + commas} decimal numbers use the ${dots > commas ? 'point' : 'comma'}; ` +
                        `the one exception is ${listing(minority)}. If it is a decimal number, align it; ` +
                        'a version number or a page range can stay as it is.',
                    `${dots + commas - 1} numeri decimali su ${dots + commas} usano ${dots > commas ? 'il punto' : 'la virgola'}; ` +
                        `l'unica eccezione è ${listing(minority)}. Se è un numero decimale va uniformata; ` +
                        'un numero di versione o un intervallo di pagine può restare così.'
                ) + setAside,
                minority
            )
        return result(
            'missing',
            L(
                `Both separators are in use: ${dots} numbers with a point and ${commas} with a comma. ` +
                    `The less frequent ones are: ${listing(minority)}`,
                `Sono in uso entrambi i separatori: ${dots} numeri con il punto e ${commas} con la virgola. ` +
                    `I meno frequenti sono: ${listing(minority)}`
            ) + setAside + groupingNote + thousandsNote,
            minority.concat(grouped, thousandsBad)
        )
    },
}

// overleaf-lab: where the maths is. A single capital letter after a number means one
// thing in prose ("28 V") and another inside maths, where it is a symbol: $0.5V$ is
// half of a volume V, $0.25A$ a quarter of an area A, $p = 1.5T$ a non-dimensional
// temperature. The check is authoritative (nothing re-judges its findings), so it
// must not hand the author a "put a space here" correction on a formula that is
// right. The bounds are there for the same reason every other scan in this file has
// them: an unterminated $ must not cost a walk to the end of the file.
// The dollar forms only. \[ ... \] and \( ... \) are paired by the token pass above:
// as a lazy pattern, bounded at 4000 characters or not, they rescan from every unclosed
// delimiter and cost 9.5 s on 2 MB of `\[ x` - the same defect blankDisplayMaths was
// rewritten for, still being paid here because this scan kept its own copy.
const INLINE_MATHS = /\$\$[\s\S]{0,4000}?\$\$|(?<!\\)\$[^$\n]{0,400}?(?<!\\)\$/g
const MATHS_ENVIRONMENTS = ['equation', 'align', 'gather', 'multline', 'flalign', 'eqnarray', 'displaymath']

function findMathsSpans(text) {
    const spans = []
    for (const m of text.matchAll(INLINE_MATHS)) {
        spans.push([m.index, m.index + m[0].length])
    }
    spans.push(...pairedMathsSpans(text, '[', ']'), ...pairedMathsSpans(text, '(', ')'))
    for (const block of findEnvironments(text, MATHS_ENVIRONMENTS)) {
        if (block.terminated) spans.push([block.start, block.end])
    }
    // Merged, because a $...$ inside an equation environment produces two overlapping
    // spans and the binary search below assumes they are disjoint.
    return mergeSpans(spans)
}

// overleaf-lab: the unit tokens the unit-spacing check recognises. A lexicon, not a
// letter pattern: this check is authoritative (the model never re-judges it), so it
// must only ever fire on something that IS a unit. Tokens that collide with words or
// names stay out on purpose: "in" follows a number in ordinary prose, "deg" appears
// glued inside lens model names, "px" counts samples rather than measuring, "pc"
// and "AU" collide with initialisms. A missed unit costs one finding; a word
// mistaken for a unit costs a false correction handed to the author.
const UNIT_TOKENS = [
    'mu ?m', 'mu ?s', 'µm', 'um', 'µs', 'us',
    'kWh', 'Wh', 'GHz', 'MHz', 'kHz', 'Hz',
    'GPa', 'MPa', 'kPa', 'hPa', 'Pa', 'mbar', 'bar',
    'GeV', 'MeV', 'keV', 'eV', 'dBm', 'dB',
    'mrad', 'rad', 'sr', 'mol', 'cd', 'lm', 'lx',
    'µg', 'ug', 'mg', 'kg', 'ns', 'ps', 'ms',
    'mm', 'cm', 'km', 'nm', 'pm', 'fm', 'dm',
    // Nms (momentum storage) and Am2 (magnetic dipole) before their prefixes, so
    // the alternation reads the longer spelling first. Both measured on the
    // fragment corpus ("150Nms", "200Am2"), both spellings no prose ever uses.
    'kN', 'mN', 'Nms', 'Nm', 'Am2', 'kJ', 'MJ', 'kW', 'MW', 'GW', 'mW',
    'mV', 'kV', 'µV', 'uV', 'mA', 'µA', 'uA',
    'pF', 'nF', 'µF', 'uF', 'mH', 'mT',
    // deg was kept out for the lens-name collision; measured against the whole
    // corpus (19 projects + 1280 fragments) the collision never occurs, and the
    // glued "45deg" it was hiding does. RPM joins its lowercase twin, and the
    // written-out Watt and percent are units when a number stands right before
    // them ("120, Watt"): the adjacency the patterns demand keeps the bare words
    // in prose ("il Watt e' l'unita' di potenza") out of reach.
    'kOhm', 'MOhm', 'Ohm', 'rpm', 'RPM', 'ppm', 'min', 'deg', 'Watt', 'percent',
    'kB', 'MB', 'GB', 'TB', 'bit',
    'A', 'V', 'W', 'J', 'K', 'T', 'F', 'H', 'N', 'B', 'm', 'g', 's', 'h', 'L', 'l',
]
const UNIT_BODY = `(?:${UNIT_TOKENS.join('|')})`
// An optional exponent and an optional per-unit denominator, so m/s and W/m^2 are
// one unit rather than a unit and a stray letter.
const UNIT_TAIL = `(?:\\^\\{?-?\\d+\\}?)?(?:/\\\\?${UNIT_BODY}(?:\\^\\{?-?\\d+\\}?)?)?`
// The guards before the number, shared by both patterns and with decimal-separator:
// see NUMBER_LEAD_GUARD at the top of the file for what each one keeps out and why.
const UNIT_GUARD = NUMBER_LEAD_GUARD
const UNIT_COMMA_OR_GLUED = new RegExp(
    `${UNIT_GUARD}(\\d+(?:[.,]\\d+)?)([ \\t]*,[ \\t]*|)(\\\\?${UNIT_BODY}${UNIT_TAIL})(?![\\w{])`,
    'g'
)
// The GOOD pattern drops "=", "{" and "[" from its guard on purpose: an accusation
// after "=" would fire on [width=12.5mm], but "$D_{\min}=1.5\,\mathrm{m}$" is the
// textbook way to state a requirement value and it must COUNT as well written. A
// generous good-count adds a setting or two to the denominator; a strict one told a
// document with eight correct values that it quoted no units at all.
const UNIT_GOOD_GUARD = '(?<![\\w.,\\\\-])'
const UNIT_PROPERLY_SPACED = new RegExp(
    `${UNIT_GOOD_GUARD}\\d+(?:[.,]\\d+)?(?:[ \\t]*(?:\\\\,|~)[ \\t]*|[ \\t]+)\\\\?${UNIT_BODY}${UNIT_TAIL}(?![\\w{])`,
    'g'
)
// A unit straight after a number, for decimal-separator's sectioning-word skip:
// "step 0.5 mm" is a measurement whatever the word before it says.
const UNIT_AFTER_NUMBER = new RegExp(
    `^(?:[ \\t]*(?:\\\\,|~)[ \\t]*|[ \\t]+|)\\\\?${UNIT_BODY}(?![\\w{])`
)

// overleaf-lab: values the siunitx package typesets. \SI{0.5}{\milli\metre} and
// \qty{12}{\kilo\gram} put the thin space between value and unit BY CONSTRUCTION,
// so a thesis that writes every measurement this way is doing exactly what the
// requirement asks - and the lexicon above never sees a bare unit there, so the
// check answered "na, no recognisable unit" on the best-behaved documents. Each use
// counts as one well-written value. What is INSIDE the braces is siunitx's own
// grammar and is deliberately not validated here: a glued unit macro in the second
// argument is the package's business, and second-guessing it would judge markup
// this file cannot evaluate. \si and \unit typeset the unit alone; adjacent to a
// number they are the author writing the pair, and the separator they typed is not
// judged either, because TeX collapses source spacing inside maths and the source
// spacing is therefore unreliable evidence.
const SIUNITX_VALUE =
    /\\(?:SI|qty|SIrange|qtyrange|SIlist|qtylist)\s*(?:\[[^\]]{0,200}\])?\s*(?:\{[^{}]{0,200}\}\s*){2,4}/g
const SIUNITX_UNIT_AFTER_NUMBER =
    /\d(?:[ \t]*(?:\\,|~)[ \t]*|[ \t]*)\\(?:si|unit)\s*(?:\[[^\]]{0,200}\])?\s*\{[^{}]{0,200}\}/g

CHECKS['unit-spacing'] = {
    describe:
        'every value is separated from its unit by a space or a thin space (\\,), never by a comma or by nothing',
    run(docs) {
        const bad = []
        let good = 0
        let siunitx = 0
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            // Same prepared text as decimal-separator: tikz coordinates blanked
            // ("ellipse (1.75cm and 0.75cm)" is a shape, not six glued values),
            // formatting and \mathrm unwrapped so bolded and maths-set values are
            // read as the numbers they are. Offsets survive, so `at` stays valid.
            const text = prepareValueText(doc.text)
            const maths = findMathsSpans(text)
            for (const m of text.matchAll(UNIT_COMMA_OR_GLUED)) {
                // The riskier the pattern, the surer the number must look like a
                // measurement. A single letter glued to an integer is more often a
                // name than a unit (1990s, 4K, 5G); a decimal number leaves no such
                // doubt. The comma case fires on an integer too when the unit is a
                // MULTI-letter lexicon token ("12, kg"): no clause ever opens with a
                // bare "kg", while "Tabella 5, in cui" never reaches here because
                // "in" is not in the lexicon. A YEAR before the comma stays prose
                // ("nel 2020, km di fibra..."), and a single letter after the comma
                // keeps needing more than a capital, because "una tolleranza di
                // 0.5, N e' il numero di campioni" was a measured false positive.
                const decimal = /[.,]/.test(m[1])
                const bare = m[3].replace(/\\/g, '')
                if (m[2] === '' ? bare.length === 1 && !decimal : !decimal && bare.length === 1) continue
                if (m[2] !== '' && !decimal && looksLikeYear(m[1])) continue
                // "min" doubles as the abbreviation of "minimo": "max 5, min 3" is
                // prose (measured), so the integer-comma rule does not trust it.
                if (m[2] !== '' && !decimal && bare === 'min') continue
                // A SINGLE CAPITAL LETTER is the shakiest evidence of a unit there
                // is, and in a thesis it is far more often a variable. Inside maths
                // that is what it always is: $0.5V$ is half of a volume, $0.25A$ a
                // quarter of an area, $p = 1.5T$ a non-dimensional temperature, and
                // all three were reported as a value glued to its unit. After a
                // comma it is usually the word that opens the next clause ("con una
                // tolleranza di 0.5, N è il numero di campioni"). Precision over
                // recall, deliberately: the cost is missing a real "$12.5V$" or a
                // real "0.5, V", and the alternative is telling an author to correct
                // a formula that is already right.
                if (bare.length === 1 && /[A-Z]/.test(bare) && (m[2] !== '' || insideSpans(maths, m.index))) {
                    continue
                }
                bad.push({
                    path: doc.path,
                    line: at(m.index),
                    what: `"${m[1]}${m[2]}${m[3]}"${
                        m[2] === ''
                            ? L(' (no separator)', ' (attaccato)')
                            : L(' (comma)', ' (virgola)')
                    }`,
                })
            }
            good += Array.from(text.matchAll(UNIT_PROPERLY_SPACED)).length
            // On the RAW text, not the prepared one: prepareValueText unwraps \si
            // (it shares the \mathrm treatment), so the prepared text no longer
            // carries the very command this count looks for.
            siunitx +=
                Array.from(doc.text.matchAll(SIUNITX_VALUE)).length +
                Array.from(doc.text.matchAll(SIUNITX_UNIT_AFTER_NUMBER)).length
        }
        good += siunitx
        // Said whenever it contributed, so "All N values" never silently annexes
        // values the lexicon did not read: siunitx spaces those itself.
        const viaPackage = siunitx
            ? L(
                  ` ${siunitx} of them ${siunitx === 1 ? 'is' : 'are'} typeset by siunitx (\\SI, \\qty), which puts the thin space in by itself.`,
                  ` ${siunitx === 1 ? '1 di questi è composto' : `${siunitx} di questi sono composti`} da siunitx (\\SI, \\qty), che inserisce da sé lo spazio sottile.`
              )
            : ''
        if (bad.length + good === 0)
            return result(
                'na',
                L(
                    'The document quotes no values with a recognisable unit.',
                    'Il documento non riporta valori con un\'unità di misura riconoscibile.'
                )
            )
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `All ${good} values with a recognisable unit are separated from it by a space or a thin space (\\,).${viaPackage}`,
                    `Tutti i ${good} valori con un'unità riconoscibile sono separati da essa con uno spazio o uno spazio sottile (\\,).${viaPackage}`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${bad.length + good} values with a recognisable unit are ` +
                    `separated from it by a comma or glued to it: ${listing(bad)}${viaPackage}`,
                `${bad.length} valori su ${bad.length + good} con un'unità riconoscibile sono ` +
                    `separati da essa con una virgola oppure attaccati: ${listing(bad)}${viaPackage}`
            ),
            bad
        )
    },
}

CHECKS['urls-in-text'] = {
    describe: 'references live in the bibliography, not as bare links typed into the prose',
    run(docs) {
        const bad = []
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            // A thebibliography environment IS the bibliography, so the links inside
            // its entries are exactly where this requirement wants them. Scanning it
            // reported every DOI of a correctly written reference list as a violation.
            // A link parked in a % comment is not typeset either: the controller
            // strips line comments upstream, but the check must not depend on that
            // (run standalone it reported a link that is not in the PDF).
            const body = blankEnvironments(doc.text, ['thebibliography'], {
                toEndIfUnterminated: true,
            }).replace(/(?<!\\)%[^\n]*/g, blankSpan)
            for (const m of body.matchAll(/https?:\/\/\S+/g)) {
                // \url and \href are the legitimate way to typeset a link that belongs
                // in the text, so only a bare link is reported.
                const lead = body.slice(Math.max(0, m.index - 40), m.index)
                if (/\\(url|href|nolinkurl)\s*\{[^}]{0,400}$/.test(lead)) continue
                bad.push({ path: doc.path, line: at(m.index), what: m[0].slice(0, 60) })
            }
        }
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    'No bare link appears in the body of the document.',
                    'Nel corpo del documento non compare nessun link nudo.'
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} bare links typed into the text: ${listing(bad)}`,
                `${bad.length} link nudi scritti nel testo: ${listing(bad)}`
            ),
            bad
        )
    },
}

// overleaf-lab: the SENTENCES a template leaves behind, beside the TODO tokens. A
// thesis shipped "Scrivere qui i dati sperimentali" and "Lorem ipsum dolor sit
// amet" in running prose and nothing flagged either, because the marker vocabulary
// stopped at tokens (measured on the fragment corpus: 23 of 51 planted markers
// were template sentences). The check is authoritative, so every phrase here is
// one no real thesis prose ever writes: the canonical Lorem ipsum, the Italian
// template imperatives glued to "qui" or to "questa sezione", and the English
// scaffold idioms ("goes here", "Here insert", "Write your", a sentence-initial
// "Fill in the"). "The abstract of this section should describe..." stays OUT on
// purpose: "should describe" is ordinary prose, and a check nobody re-judges must
// not fire on it. Every class is bounded; the i flag is safe here because none of
// these phrases collides with a case-sensitive token above.
const SCAFFOLD_PHRASES =
    /lorem\s{1,4}ipsum|(?:scrivere|aggiungere|inserire)\s{1,4}qui(?![\p{L}])|completare\s{1,4}questa\s{1,4}sezione|complete\s{1,4}the\s{1,4}(?:results?|methodology|introduction|discussion|conclusions?|abstract)\s{1,4}section|goes\s{1,4}(?:here(?![\p{L}])|in\s{1,4}this\s{1,4}section)|should\s{1,4}be\s{1,4}added\s{1,4}(?:[a-z]{1,20}\s{1,4}){0,3}here(?![\p{L}])|here\s{1,4}insert(?![\p{L}])|write\s{1,4}your(?![\p{L}])|(?<=^|[.!?]\s{1,4}|\n)fill\s{1,4}in\s{1,4}(?:the|your)(?![\p{L}])/giu

CHECKS['work-markers'] = {
    describe: 'no editing marker is left in the text (TODO, FIXME, \\todo{})',
    run(docs) {
        // Only the markers that are universal in LaTeX and in code. Language-specific
        // phrases ("da rivedere", "to be completed") are policy and belong to the
        // rubric's own scan patterns, not to a check that ships for everybody.
        //
        // TBU ("to be updated") and TBC ("to be confirmed") sit beside TBD for a
        // reason: they are the markers that survive into a document that LOOKS
        // finished. A real thesis carried its headline result as "48.43% (TBU)" and
        // nothing flagged it, because the set stopped at TBD, so a number the author
        // had already marked as provisional went out as the result of the work.
        //
        // TBC IS ALSO THERMAL BARRIER COATING. In a turbomachinery or materials thesis
        // "il rivestimento TBC riduce la temperatura del metallo" is the subject of the
        // work, and the check reported three editing markers on a finished chapter. So
        // TBC only counts in a shape no acronym is ever written in: followed by a colon
        // ("TBC: mancano le prove di volo") or standing alone inside brackets
        // ("48.43% (TBC)"), which is how a note to self is written and never how a
        // coating is named. TBD and TBU keep the plain form: nobody declares those.
        const bad = []
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            // A document that DECLARES the acronym must not be accused by its own
            // acronym list: `\acro{TBC}{Thermal Barrier Coating}` was reported as two
            // markers left in the text. Citation keys and labels go the same way -
            // \cite{TBC2019} matched because the neighbouring character was a digit,
            // not a letter - which is what NON_PROSE_ARGUMENT already exists to blank.
            const prose = doc.text.replace(ACRONYM_DECLARATION, blankSpan).replace(NON_PROSE_ARGUMENT, blankSpan)
            // "to do:" WRITTEN AS TWO WORDS. A real thesis shipped a chapter whose
            // missing pieces were marked `\textcolor{red}{to do: antenna pattern
            // radiation lobes}` - the one-word TODO never appears, so nothing
            // reported it. The colon is what makes it a note to self: "the work to
            // do involves three steps" is prose and must stay silent, "to do:
            // antenna pattern" never is. Same shape, same reasoning, as the TBC
            // colon rule above; "da fare:" is the Italian twin. Character classes
            // rather than the i flag, so TODO/TBD/TBC keep their exact-case rule.
            for (const m of prose.matchAll(
                /\\(todo|missingfigure|listoftodos)\b|(?<![\p{L}\d])(TODO|FIXME|XXX|HACK|TBD|TBU)(?![\p{L}\d])|(?<![\p{L}\d])TBC(?=\s*:)|(?<=[([{])\s*TBC\s*(?=[)\]}])|(?<![\p{L}\d])[Tt][Oo][ \t]+[Dd][Oo]\s*:|(?<![\p{L}\d])[Dd][Aa][ \t]+[Ff][Aa][Rr][Ee]\s*:/gu
            )) {
                bad.push({ path: doc.path, line: at(m.index), what: m[0].trim() })
            }
            for (const m of prose.matchAll(SCAFFOLD_PHRASES)) {
                bad.push({
                    path: doc.path,
                    line: at(m.index),
                    what: L(`leftover template text "${m[0].trim()}"`, `testo segnaposto residuo "${m[0].trim()}"`),
                })
            }
        }
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    'No TODO, FIXME, XXX, HACK, TBD, TBU, TBC, "to do:" or \\todo marker and no leftover ' +
                        'template sentence ("Lorem ipsum", "Scrivere qui") is left in the text.',
                    'Nel testo non è rimasto nessun marcatore TODO, FIXME, XXX, HACK, TBD, TBU, TBC, "da fare:" o ' +
                        '\\todo, né una frase segnaposto del modello ("Lorem ipsum", "Scrivere qui").'
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} editing markers left in the text: ${listing(bad)}`,
                `${bad.length} marcatori di lavorazione rimasti nel testo: ${listing(bad)}`
            ),
            bad
        )
    },
}

CHECKS['crossrefs-resolve'] = {
    describe: 'every \\ref points at a label that exists',
    run(docs) {
        const defined = new Set()
        // \hypertarget/\hyperlink are the same contract as \label/\ref, written by
        // hand: a dangling \hyperlink prints a link that goes nowhere, and a real
        // report missed the one dangling link of a project (a typo between "Uzawa"
        // and "Uzama") because this check read \ref only.
        const targets = new Set()
        let labelsInMacros = 0
        for (const doc of sources(docs)) {
            const macros = macroDefinitionRegions(doc.text)
            for (const m of doc.text.matchAll(/\\label\s{0,8}\{([^}]{1,400})\}/g)) {
                // A \label inside a \newcommand body carries a macro parameter
                // (fig:#3): it defines nothing until TeX expands it, and counting it
                // as absent turned a perfectly correct document into "2 of 2
                // cross-references point nowhere".
                if (insideSpans(macros, m.index)) {
                    labelsInMacros += 1
                    continue
                }
                defined.add(m[1].trim())
            }
            for (const m of doc.text.matchAll(/\\hypertarget\s*\{([^}]{1,400})\}/g)) targets.add(m[1].trim())
            // A code listing does not declare its label with \label: it passes it as
            // an option, `label=lst:one` or `label={lst:one}`. Forgetting that turns
            // every reference to a listing into a dangling one, which is a false
            // positive on a document that is perfectly correct.
            for (const m of doc.text.matchAll(/\blabel\s*=\s*(?:\{([^}]{1,200})\}|([^,\]\s]{1,200}))/g)) {
                defined.add((m[1] === undefined ? m[2] : m[1]).trim())
            }
        }
        const bad = []
        let total = 0
        // The document's own reference wrappers: \vedifig{fig:ghost} is a reference
        // and must resolve like any other, with the wrapper's prefix applied.
        const wrappers = referenceWrappers(sources(docs))
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const macros = macroDefinitionRegions(doc.text)
            for (const use of [
                ...collectReferenceUses(doc.text, wrappers),
                ...wrapperReferenceUses(doc.text, wrappers),
            ]) {
                if (!use.name) continue
                if (insideSpans(macros, use.index)) continue
                total += 1
                if (defined.has(use.name) || PACKAGE_PROVIDED_LABELS.has(use.name)) continue
                bad.push({
                    path: doc.path,
                    line: at(use.index),
                    what: `${use.display} ${L('has no \\label', 'non ha una \\label')}`,
                })
            }
            for (const m of doc.text.matchAll(/\\hyperlink\s*\{([^}]{1,400})\}/g)) {
                if (insideSpans(macros, m.index)) continue
                total += 1
                if (targets.has(m[1].trim())) continue
                bad.push({
                    path: doc.path,
                    line: at(m.index),
                    what: `\\hyperlink{${m[1].trim().slice(0, 60)}} ${L('has no \\hypertarget', 'non ha un \\hypertarget')}`,
                })
            }
        }
        // Unresolved references in a document whose labels live inside macro
        // definitions may be resolved by the macro at every use: without expanding
        // TeX nobody can say, so the honest answer stops being "points nowhere".
        if (bad.length > 0 && labelsInMacros > 0)
            return result(
                'na',
                L(
                    `${bad.length} of ${total} cross-references have no matching \\label in the prose, but ${labelsInMacros} \\label${labelsInMacros === 1 ? ' is' : 's are'} written inside macro definitions and may define them at each use: resolving that needs TeX itself.`,
                    `${bad.length} richiami su ${total} non hanno una \\label corrispondente nella prosa, ma ${labelsInMacros === 1 ? '1 \\label è scritta' : `${labelsInMacros} \\label sono scritte`} dentro definizioni di macro e potrebbe definirli a ogni uso: per risolverlo serve TeX stesso.`
                )
            )
        if (total === 0)
            return result(
                'na',
                L('The document contains no cross-references.', 'Il documento non contiene richiami incrociati.')
            )
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `All ${total} cross-references resolve to one of the ${defined.size + targets.size} labels.`,
                    `Tutti i ${total} richiami incrociati puntano a una delle ${defined.size + targets.size} label.`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${total} cross-references point nowhere: ${listing(bad)}`,
                `${bad.length} richiami incrociati su ${total} non puntano a nulla: ${listing(bad)}`
            ),
            bad
        )
    },
}

// overleaf-lab: one citation command, every key it names. biblatex's multicite forms
// (\cites, \parencites, \textcites) take ONE GROUP PER SOURCE, so `\cites{a}{ghost}`
// is two citations; reading only the first group answered "all 1 citations resolve"
// on a document citing a key that is in no bibliography, which is the exact opposite
// of what this check is for.
//
// The groups after the first must be ADJACENT, with only an optional [pre]/[post]
// between them: allowing whitespace would read `\cite{a} {\bfseries testo}` as a
// second citation of a key called "\bfseries testo".
// The FIRST key group may sit after whitespace (`\cite[p.~3] {k}` is legal TeX and
// was read as no citation at all); the groups AFTER it keep the adjacency rule
// stated above.
const CITE_COMMAND =
    /\\[a-zA-Z]{0,32}cite[a-zA-Z]{0,32}\*?\s*((?:\[[^\]]{0,200}\]\s{0,8})*\{[^}]{0,400}\}(?:(?:\[[^\]]{0,200}\])*\{[^}]{0,400}\})*)/g

CHECKS['citations-resolve'] = {
    describe: 'every \\cite key exists in the bibliography',
    run(docs) {
        const bibs = bibliographies(docs)
        // The keys a \cite may point at come from BOTH kinds of bibliography: the
        // .bib entries and the \bibitem entries of a hand-written thebibliography.
        const inline = bibitemEntries(docs)
        if (bibs.length === 0 && inline.length === 0)
            return result(
                'na',
                L(
                    'The project carries no .bib file and no thebibliography to check the keys against.',
                    'Il progetto non contiene nessun file .bib né un thebibliography rispetto a cui verificare le chiavi.'
                )
            )
        const defined = new Set()
        for (const doc of bibs) {
            for (const entry of bibEntries(doc.text)) defined.add(entry.key)
        }
        for (const entry of inline) defined.add(entry.key)
        const bad = []
        let total = 0
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            for (const m of doc.text.matchAll(CITE_COMMAND)) {
                for (const group of m[1].matchAll(/\{([^}]{0,400})\}/g)) {
                    for (const name of group[1].split(',')) {
                        const key = name.trim()
                        if (!key || key === '*') continue
                        total += 1
                        if (!defined.has(key)) {
                            bad.push({
                                path: doc.path,
                                line: at(m.index),
                                what: `\\cite{${key}} ${L(
                                    'is not in the bibliography',
                                    'non è in bibliografia'
                                )}`,
                            })
                        }
                    }
                }
            }
        }
        if (total === 0)
            return result('na', L('The document cites nothing.', 'Il documento non cita nulla.'))
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `All ${total} citations resolve to one of the ${defined.size} entries.`,
                    `Tutte le ${total} citazioni corrispondono a una delle ${defined.size} voci.`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${total} citations have no entry: ${listing(bad)}`,
                `${bad.length} citazioni su ${total} non hanno una voce corrispondente: ${listing(bad)}`
            ),
            bad
        )
    },
}

// The fields a reader needs to find a source again. Deliberately not BibTeX's own
// required-field table: @misc requires nothing there, and a bare link recorded as
// @misc is exactly the case a rubric asks about.
const CORE_BIB_FIELDS = ['author', 'title', 'year']

// Where the work appeared. It has a different name for every kind of entry, which is
// why "publication venue" cannot be one field name: asking every entry for a journal
// would report every book as incomplete. An @misc has no venue by definition and is
// therefore not asked for one.
// overleaf-lab: the same field under the name biblatex gives it. Zotero exports
// biblatex, the lab ships a Zotero integration, and a complete entry exported from it
// was reported as "no year, no journal" because it writes `journaltitle` and `date`
// where BibTeX writes `journal` and `year`. That is the highest-traffic false
// violation the bibliography check had: the author is told to add fields their
// reference manager already wrote.
//
// A `date` counts as a year only when a year can actually be read out of it
// (`date = {2019-05}` carries one, `date = {n.d.}` does not), which is why this is a
// lookup with a rule and not a list of synonyms.
const BIB_FIELD_SPELLINGS = {
    year: ['year', 'date', 'origdate'],
    journal: ['journal', 'journaltitle'],
    booktitle: ['booktitle', 'eventtitle'],
    // biblatex has no `school`: a thesis names its university in `institution`.
    school: ['school', 'institution'],
    // Where an online source lives. `howpublished` is where BibTeX users put the
    // address of a page recorded as @misc, and biblatex's own field is `url`.
    url: ['url', 'howpublished'],
}
const BIB_YEAR_IN_DATE = /(?:1\d{3}|20\d{2})/

function entryHasField(fields, wanted) {
    for (const spelling of BIB_FIELD_SPELLINGS[wanted] || [wanted]) {
        if (!fields.has(spelling)) continue
        if (wanted === 'year' && spelling !== 'year' && !BIB_YEAR_IN_DATE.test(fields.get(spelling))) {
            continue
        }
        return true
    }
    return false
}

const BIB_VENUE_FIELD = {
    article: 'journal',
    inproceedings: 'booktitle',
    conference: 'booktitle',
    incollection: 'booktitle',
    inbook: 'booktitle',
    book: 'publisher',
    booklet: 'publisher',
    manual: 'organization',
    phdthesis: 'school',
    mastersthesis: 'school',
    techreport: 'institution',
    // overleaf-lab: the biblatex spellings of two types the BibTeX table above misses.
    // biblatex writes ONE thesis type and says which one it is in `type`, so a Zotero
    // export of a thesis arrives as @thesis and was asked for nothing beyond author,
    // title and year: a thesis with no university passed as complete. @online and its
    // two aliases are the entry a bare link becomes when the author does record it
    // properly, and a link with no address is the one thing an online source cannot be
    // missing. @misc stays exempt on purpose: it is the type with no defined venue, and
    // demanding one of it would report a false violation on every dataset and standard.
    thesis: 'school',
    online: 'url',
    electronic: 'url',
    www: 'url',
}

CHECKS['bib-entries-complete'] = {
    describe: 'every bibliography entry carries an author, a title, a year and its publication venue',
    run(docs) {
        const bibs = bibliographies(docs)
        if (bibs.length === 0) {
            // A hand-written thebibliography IS a bibliography, but its entries are
            // free text: "author, title, year" are typographic conventions there, not
            // fields, so completeness is not something a parser can decide. Say that,
            // instead of the misleading "the project carries no .bib file" a report
            // gave on a document that had its bibliography in a .tex.
            if (bibitemEntries(docs).length > 0)
                return result(
                    'na',
                    L(
                        'The bibliography is a hand-written thebibliography: entry completeness cannot be machine-checked.',
                        'La bibliografia è un thebibliography scritto a mano: la completezza delle voci non è verificabile meccanicamente.'
                    )
                )
            return result(
                'na',
                L('The project carries no .bib file.', 'Il progetto non contiene nessun file .bib.')
            )
        }
        const bad = []
        let total = 0
        for (const doc of bibs) {
            const at = lineLookup(doc.text)
            for (const entry of bibEntries(doc.text)) {
                total += 1
                const wanted = [...CORE_BIB_FIELDS]
                const venue = BIB_VENUE_FIELD[entry.type]
                if (venue) wanted.push(venue)
                const lacks = wanted.filter(field => !entryHasField(entry.fields, field))
                if (lacks.length > 0) {
                    bad.push({
                        path: doc.path,
                        line: at(entry.start),
                        what: L(
                            `${entry.key} has no ${lacks.join(', no ')}`,
                            `${entry.key} senza ${lacks.join(', senza ')}`
                        ),
                    })
                }
            }
        }
        if (total === 0)
            return result(
                'na',
                L('The bibliography contains no entries.', 'La bibliografia non contiene voci.')
            )
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `All ${total} entries carry an author, a title and a year.`,
                    `Tutte le ${total} voci hanno autore, titolo e anno.`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${total} entries are incomplete: ${listing(bad)}`,
                `${bad.length} voci su ${total} sono incomplete: ${listing(bad)}`
            ),
            bad
        )
    },
}

CHECKS['no-wikipedia'] = {
    describe: 'no source is Wikipedia',
    run(docs) {
        const bad = []
        for (const doc of docs) {
            const at = lineLookup(doc.text)
            for (const m of doc.text.matchAll(/wikipedia/gi)) {
                bad.push({ path: doc.path, line: at(m.index), what: doc.text.slice(m.index, m.index + 50).split('\n')[0] })
            }
        }
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    'Neither the text nor the bibliography mentions Wikipedia.',
                    'Né il testo né la bibliografia nominano Wikipedia.'
                )
            )
        return result(
            'missing',
            L(
                `Wikipedia appears ${bad.length} times: ${listing(bad)}`,
                `Wikipedia compare ${bad.length} volte: ${listing(bad)}`
            ),
            bad
        )
    },
}

CHECKS['acronyms-declared-unused'] = {
    describe: 'the acronym list carries no entry the text never uses',
    run(docs) {
        const declared = collectDeclaredAcronyms(docs)
        if (declared.size === 0)
            return result(
                'na',
                L('The document declares no acronyms.', 'Il documento non dichiara acronimi.')
            )
        // NON_PROSE_ARGUMENT blanked for symmetry with the other two acronym scans:
        // an image called ADCS.png kept a never-used acronym "in use".
        const body = docs
            .map(doc =>
                blankHandAcronymLists(blankEnvironments(doc.text, ['acronyms', 'acronym']))
                    .replace(ACRONYM_DECLARATION, blankSpan)
                    .replace(NON_PROSE_ARGUMENT, blankSpan)
            )
            .join('\n')
        const unused = []
        // A glossaries project writes \gls{adcs}, the KEY, and never the letters ADCS.
        // Looking only for \ac{ADCS} or the letters reported every one of its acronyms
        // as declared and never used, on a document that uses them on every page.
        for (const [short, entry] of declared) {
            const used = new RegExp(acronymUseSource(short, entry), 'u')
            if (!used.test(body)) unused.push({ path: '', line: 0, what: short })
        }
        if (unused.length === 0)
            return result(
                'ok',
                L(
                    `All ${declared.size} declared acronyms are used in the text.`,
                    `Tutti i ${declared.size} acronimi dichiarati sono usati nel testo.`
                )
            )
        return result(
            'missing',
            L(
                `${unused.length} of ${declared.size} declared acronyms never appear in the text: ` +
                    unused.map(u => u.what).join(', '),
                `${unused.length} acronimi dichiarati su ${declared.size} non compaiono mai nel testo: ` +
                    unused.map(u => u.what).join(', ')
            ),
            []
        )
    },
}

// The names an abstract goes by. A parser cannot recognise an abstract by reading it,
// so it recognises the LaTeX that introduces one: the environment, or the word used as
// a heading, a table-of-contents entry or a file name. Real templates do it the second
// way (`\addcontentsline{toc}{chapter}{Abstract}` above the text), which is why
// looking only for \begin{abstract} answered "missing" on documents that have one.
const ABSTRACT_NAMES = 'abstract|sommario|summary|riassunto|resumen|zusammenfassung|resum'

// How much running prose an abstract must carry to count as one. A heading with
// nothing under it is not an abstract, and answering "ok" because the heading is there
// is the same failure as any other verdict on something nobody read: caught on a real
// document whose abstract.tex held the template's header and not one word of text.
const MIN_ABSTRACT_CHARS = 120

// Commands, their braces and comments are markup, not prose. What is left is what a
// reader would actually read.
function proseLength(text) {
    return text
        .replace(/%[^\n]*/g, ' ')
        .replace(/\\[a-zA-Z]+\*?(\s*\[[^\]]*\])*/g, ' ')
        .replace(/[{}\\$&~^_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim().length
}

// overleaf-lab: where the abstract ENDS. None of the spellings above runs to the end
// of the file, and reading past the end measured the chapters that follow: an EMPTY
// `\chapter*{Abstract}` in a single-file thesis came back "ok, 178 characters of
// text", which is the failure this check exists to catch, reported as a pass. It only
// ever looked right because the fixtures put the abstract last in a file of its own.
//
// The environment closes at its \end and the command form at its closing brace. A
// heading or a table-of-contents entry has no closing mark at all, so it closes where
// the next sectioning command opens - unless that command names the abstract again,
// because a template that writes the toc entry above the heading names it twice and
// the second name is not the start of the next chapter. A file that holds nothing but
// the abstract has no boundary either way and is measured whole, which is right.
const ABSTRACT_BOUNDARY = new RegExp(
    `\\\\(?:part|chapter|(?:sub){0,2}section)\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{\\s*(?!(?:${ABSTRACT_NAMES})\\b)` +
        `|\\\\end\\s*\\{document\\}`,
    'i'
)

function abstractBody(marker, after) {
    if (/^\\begin\s*\{abstract\}/i.test(marker)) {
        const closing = /\\end\s*\{abstract\}/i.exec(after)
        if (closing) return after.slice(0, closing.index)
    } else if (/^\\abstract\b/i.test(marker)) {
        const open = /^\s*\{/.exec(after)
        if (open) return readBracedArgument(after, open[0].length - 1).value
    }
    // A \begin with no \end is a broken document and the declaration form has no
    // brace to close: both fall through to the heading rule rather than to the end of
    // the file, because that is the tighter of the two answers and neither shape says
    // the abstract is everything that follows it.
    const boundary = ABSTRACT_BOUNDARY.exec(after)
    return boundary ? after.slice(0, boundary.index) : after
}

CHECKS['has-abstract'] = {
    describe: 'the document carries an abstract',
    run(docs) {
        // Up to two formatting commands may stand before the name: templates write
        // `\chapter*{\centering Abstract}`, and refusing the \centering answered
        // "missing" on a document with an abstract. Bounded, like every class here.
        const dressed = `(?:\\\\[a-zA-Z]{1,20}\\s*){0,2}`
        const named = new RegExp(
            `\\\\begin\\s{0,8}\\{abstract\\}|\\\\abstract\\b|` +
                `\\\\(?:chapter|section|subsection)\\*?\\s*(?:\\[[^\\]]{0,200}\\])?\\s*\\{\\s*${dressed}(?:${ABSTRACT_NAMES})\\b|` +
                `\\\\addcontentsline\\s*\\{[^}]{0,400}\\}\\s*\\{[^}]{0,400}\\}\\s*\\{\\s*${dressed}(?:${ABSTRACT_NAMES})\\b`,
            'i'
        )
        const byName = new RegExp(`(^|/)(${ABSTRACT_NAMES})`, 'i')
        const empty = []
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const m = named.exec(doc.text)
            if (!m) continue
            // Measure the abstract, not the rest of the file (see abstractBody).
            const prose = proseLength(abstractBody(m[0], doc.text.slice(m.index + m[0].length)))
            if (prose < MIN_ABSTRACT_CHARS) {
                empty.push({
                    path: doc.path,
                    line: at(m.index),
                    what: L(
                        `the abstract is introduced but carries only ${prose} characters of text`,
                        `l'abstract è introdotto ma contiene solo ${prose} caratteri di testo`
                    ),
                })
                continue
            }
            return result(
                'ok',
                L(
                    `An abstract is present in ${doc.path}, ${prose} characters of text.`,
                    `L'abstract è presente in ${doc.path}, ${prose} caratteri di testo.`
                ),
                [{ path: doc.path, line: at(m.index), what: 'abstract' }]
            )
        }
        if (empty.length > 0) {
            return result(
                'missing',
                L(
                    `The abstract is declared but empty: ${listing(empty)}. A heading with nothing ` +
                        'under it is not an abstract.',
                    `L'abstract è dichiarato ma vuoto: ${listing(empty)}. Un titolo senza niente ` +
                        'sotto non è un abstract.'
                ),
                empty
            )
        }
        // Last resort: a non-trivial file that is named like an abstract and is pulled
        // into the document. A file nobody inputs is a leftover, not an abstract.
        const included = sources(docs)
            .map(d => d.text)
            .join('\n')
        for (const doc of sources(docs)) {
            const base = doc.path.replace(/\.tex$/i, '')
            const short = base.slice(base.lastIndexOf('/') + 1)
            if (!byName.test(short) || proseLength(doc.text) < MIN_ABSTRACT_CHARS) continue
            if (!new RegExp(`\\\\(?:input|include|subfile)\\s*\\{[^}]{0,400}${escapeRegExp(short)}`, 'i').test(included))
                continue
            return result(
                'ok',
                L(
                    `An abstract is present as ${doc.path}, pulled in by the main file.`,
                    `L'abstract è presente come ${doc.path}, richiamato dal file principale.`
                ),
                [{ path: doc.path, line: 1, what: 'abstract' }]
            )
        }
        return result(
            'missing',
            L(
                'No abstract was found. Looked for an abstract environment, a heading or a ' +
                    `table-of-contents entry named (${ABSTRACT_NAMES.replace(/\|/g, ', ')}), and a file of that name ` +
                    'pulled into the document.',
                "Non è stato trovato nessun abstract. Sono stati cercati un ambiente abstract, un titolo o una " +
                    `voce di indice con uno di questi nomi (${ABSTRACT_NAMES.replace(/\|/g, ', ')}), e un file con lo stesso ` +
                    'nome richiamato nel documento.'
            )
        )
    },
}

CHECKS['has-bibliography'] = {
    describe: 'the document carries a bibliography',
    run(docs) {
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const m = /\\bibliography\s*\{|\\addbibresource\s*\{|\\begin\s{0,8}\{thebibliography\}|\\printbibliography/.exec(
                doc.text
            )
            if (m) {
                return result(
                    'ok',
                    L(
                        `A bibliography is declared in ${doc.path}.`,
                        `La bibliografia è dichiarata in ${doc.path}.`
                    ),
                    [{ path: doc.path, line: at(m.index), what: m[0] }]
                )
            }
        }
        if (bibliographies(docs).length > 0)
            return result(
                'missing',
                L(
                    'The project carries a .bib file, but no \\bibliography, \\addbibresource or ' +
                        '\\printbibliography ever pulls it into the document.',
                    'Il progetto contiene un file .bib, ma nessun \\bibliography, \\addbibresource o ' +
                        '\\printbibliography lo richiama nel documento.'
                )
            )
        return result(
            'missing',
            L(
                'The project declares no bibliography and carries no .bib file.',
                'Il progetto non dichiara nessuna bibliografia e non contiene file .bib.'
            )
        )
    },
}

// overleaf-lab: the same work under two keys. A reference manager exports one paper
// twice - once from its DOI, once from a PDF import - and the two entries get two
// keys, so nothing downstream notices: both are complete, both are cited, both
// resolve, and the printed bibliography carries the work twice. The checks that ship
// above ask whether an ENTRY is complete (bib-entries-complete) and whether it is
// cited (the controller's citation bookkeeping); neither compares two entries with
// each other, which is the only way this defect is visible.
//
// Both facts are exact AS STATED: the same DOI under two keys, and the same title
// after normalisation. Normalisation is the whole check, because {The} Title, The
// Title and Th\'e title are one title typed three ways.
function normaliseBibTitle(value) {
    return String(value)
        .normalize('NFD')
        // The combining marks NFD has just split off, matched by their unicode class:
        // a literal combining accent written into this file would be invisible in every
        // editor and impossible to review.
        .replace(/\p{M}/gu, '')
        // Markup first, escapes second. A command has to go as a command (\emph), and
        // only then may `\'e` lose its backslash and keep its letter: the other order
        // reads the "e" of \emph as the letter of an accent escape.
        .replace(/\\[a-zA-Z]+/g, ' ')
        .replace(/\\./g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

// A DOI is a name, however it is written down: bare, as a URL, or with the doi: prefix
// a publisher's export puts in front of it.
function normaliseDoi(value) {
    return String(value)
        .toLowerCase()
        .replace(/[{}\s]/g, '')
        .replace(/^(?:https?:\/\/)?(?:dx\.)?(?:doi\.org\/)?(?:doi:)?/, '')
        .replace(/[.,;]+$/, '')
}

// A title short enough to collide by accident is not evidence of anything: "Report",
// "Manuale" and "Notes" are titles two different works can carry.
const MIN_COMPARABLE_TITLE = 12
const MIN_COMPARABLE_DOI = 6

// overleaf-lab: containment, not only equality. bibFields reads a field value up to
// the first comma or newline (it is a scanner, not a BibTeX parser), so the same title
// wrapped differently in two entries arrives truncated at two different points and the
// two normalised strings are then one a prefix of the other. The shorter of the pair
// must still be long enough to identify a work on its own, or "an introduction to" the
// would pair two unrelated books.
const MIN_CONTAINED_TITLE = 20

// Titles are compared inside a bucket keyed by their first characters, and the bucket
// is CAPPED: a .bib of ten thousand entries that all start with the same words would
// otherwise cost one comparison per entry seen so far, which is the quadratic shape
// this file keeps paying for. With the cap the work is bounded per entry, so a
// pathological upload stays linear.
const TITLE_BUCKET_CHARS = 20
const MAX_TITLE_BUCKET = 8

CHECKS['bib-duplicates'] = {
    describe: 'no two bibliography entries are the same work under two different keys',
    run(docs) {
        const entries = []
        for (const doc of bibliographies(docs)) {
            const at = lineLookup(doc.text)
            for (const entry of bibEntries(doc.text)) {
                entries.push({
                    key: entry.key,
                    path: doc.path,
                    line: at(entry.start),
                    doi: normaliseDoi(entry.fields.get('doi') || ''),
                    title: normaliseBibTitle(entry.fields.get('title') || ''),
                })
            }
        }
        if (entries.length === 0) {
            // A hand-written thebibliography IS a bibliography, but its entries are free
            // text: there is no title field to compare, so this is not something a
            // parser can decide. Said out loud, as bib-entries-complete says it.
            if (bibitemEntries(docs).length > 0)
                return result(
                    'na',
                    L(
                        'The bibliography is a hand-written thebibliography: its entries carry no fields, so two of them cannot be compared.',
                        'La bibliografia è un thebibliography scritto a mano: le voci non hanno campi, quindi non sono confrontabili tra loro.'
                    )
                )
            return result(
                'na',
                L('The project carries no .bib file.', 'Il progetto non contiene nessun file .bib.')
            )
        }
        const bad = []
        const pairs = new Set()
        const byDoi = new Map()
        const byTitle = new Map()
        let withDoi = 0
        let withTitle = 0
        const report = (first, second, what) => {
            const id = `${first.key}\u0000${second.key}`
            if (pairs.has(id)) return
            pairs.add(id)
            bad.push({ path: second.path, line: second.line, what })
        }
        for (const entry of entries) {
            if (entry.doi.length >= MIN_COMPARABLE_DOI) {
                withDoi += 1
                const first = byDoi.get(entry.doi)
                if (first) {
                    report(
                        first,
                        entry,
                        L(
                            `${entry.key} and ${first.key} (line ${first.line}) carry the same DOI ${entry.doi}`,
                            `${entry.key} e ${first.key} (riga ${first.line}) hanno lo stesso DOI ${entry.doi}`
                        )
                    )
                } else {
                    byDoi.set(entry.doi, entry)
                }
            }
            if (entry.title.length < MIN_COMPARABLE_TITLE) continue
            withTitle += 1
            const bucketKey = entry.title.slice(0, TITLE_BUCKET_CHARS)
            const bucket = byTitle.get(bucketKey) || []
            for (const first of bucket) {
                if (first.title === entry.title) {
                    report(
                        first,
                        entry,
                        L(
                            `${entry.key} and ${first.key} (line ${first.line}) carry the same title once braces, accents, case and punctuation are ignored`,
                            `${entry.key} e ${first.key} (riga ${first.line}) hanno lo stesso titolo, a meno di parentesi graffe, accenti, maiuscole e punteggiatura`
                        )
                    )
                    break
                }
                const short = first.title.length <= entry.title.length ? first : entry
                const long = short === first ? entry : first
                if (short.title.length >= MIN_CONTAINED_TITLE && long.title.startsWith(short.title)) {
                    report(
                        first,
                        entry,
                        L(
                            `the title of ${short.key} (line ${short.line}) is the beginning of the title of ${long.key} (line ${long.line})`,
                            `il titolo di ${short.key} (riga ${short.line}) è l'inizio del titolo di ${long.key} (riga ${long.line})`
                        )
                    )
                    break
                }
            }
            if (bucket.length < MAX_TITLE_BUCKET) bucket.push(entry)
            byTitle.set(bucketKey, bucket)
        }
        // The claim must never cover entries the check could not compare. An entry with
        // no title and no DOI was looked at and nothing could be said about it, which is
        // not the same as saying it is unique.
        if (withTitle < 2 && withDoi < 2)
            return result(
                'na',
                L(
                    `None of the ${entries.length} bibliography entries can be compared with another: ` +
                        'fewer than two carry a title long enough or a DOI.',
                    `Nessuna delle ${entries.length} voci di bibliografia è confrontabile con un'altra: ` +
                        'meno di due hanno un titolo abbastanza lungo o un DOI.'
                )
            )
        const compared = L(
            ` ${withTitle} entries were compared by title and ${withDoi} by DOI.`,
            ` ${withTitle} voci sono state confrontate per titolo e ${withDoi} per DOI.`
        )
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `No two of the ${entries.length} bibliography entries look like the same work.${compared}`,
                    `Nessuna delle ${entries.length} voci di bibliografia sembra lo stesso lavoro di un'altra.${compared}`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} pair${bad.length === 1 ? '' : 's'} of entries look like the same work under two keys: ${listing(
                    bad
                )}.${compared}`,
                `${bad.length} copp${bad.length === 1 ? 'ia' : 'ie'} di voci sembrano lo stesso lavoro sotto due chiavi: ${listing(
                    bad
                )}.${compared}`
            ),
            bad
        )
    },
}

// overleaf-lab: the acronym treatment, applied to symbols. A thesis that declares a
// list of symbols has the same two defects an acronym list has: an entry the maths
// never uses, and a symbol the maths uses that the list never declares.
//
// ONLY THE GENERIC PACKAGES ARE READ. \nomenclature (nomencl) and the symbol entries of
// glossaries declare a symbol in a form a parser can recognise. A list of symbols
// typeset BY HAND as a tabular is not one of them: reading arbitrary table cells means
// guessing which column is the symbol and which is the description, and a check that
// guesses is a check that hands the author a false correction. Those lists remain what
// they always were, matter for the rubric's own scan patterns, and the `na` below says
// so instead of pretending the document declares nothing.
const SYMBOL_WRAPPER_MACROS = new Set([
    'vec', 'mathbf', 'bm', 'boldsymbol', 'symbf', 'symbfup', 'hat', 'tilde', 'dot', 'ddot',
    'bar', 'overline', 'underline', 'mathrm', 'mathit', 'mathcal', 'mathbb', 'mathfrak',
    'text', 'textbf', 'textit', 'ensuremath', 'left', 'right', 'operatorname', 'mathsf',
])

const GREEK_COMMANDS = new Set([
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta',
    'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho',
    'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi',
    'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi',
    'Psi', 'Omega',
])

// The letters a formula uses as a counter rather than as a quantity. They are damped
// only when EVERY occurrence is a subscript: an "n" that stands alone on the left of an
// equation is the size of something and belongs in the list, while the i of x_i is the
// index of a sum and belongs nowhere.
const DUMMY_INDEX_LETTERS = new Set(['i', 'j', 'k', 'n', 'm'])

// A bound on how many distinct undeclared symbols are tracked. The list is reported
// with an honest total, so the cap shortens the evidence and never inflates it.
const MAX_SYMBOL_CANDIDATES = 300

// Every form that DECLARES a symbol, blanked wherever it must not be read as maths.
// A declaration writes its symbol in maths mode (`\nomenclature{$\alpha$}{...}`), so
// without this the declaration itself is the "use" that keeps every declared symbol
// alive and the check can never report an unused one.
const SYMBOL_DECLARATION =
    /\\nomenclature\s*(?:\[[^\]]{0,200}\])?\s*\{[^{}]{0,200}(?:\{[^{}]{0,400}\}[^{}]{0,200}){0,4}\}\s*\{[^{}]{0,400}(?:\{[^{}]{0,400}\}[^{}]{0,400}){0,4}\}|\\glsxtrnewsymbol\s*(?:\[[^\]]{0,200}\])?\s*\{[^{}]{0,400}\}\s*\{[^{}]{0,200}(?:\{[^{}]{0,400}\}[^{}]{0,200}){0,4}\}|\\newglossaryentry\s*\{[^{}]{0,400}\}\s*\{[^{}]{0,400}(?:\{[^{}]{0,400}\}[^{}]{0,400}){0,8}\}/g

// Every token a formula can spell a symbol with: a command, or a single letter.
const SYMBOL_TOKEN = /\\[a-zA-Z]+|[A-Za-z]/g

// The same, told apart: a command (only a greek one counts as a symbol name) and a
// letter that stands ALONE. Two adjacent letters are a word, not a symbol.
const EQUATION_SYMBOL = /\\([a-zA-Z]+)|(?<![\\A-Za-z])([A-Za-z])(?![A-Za-z])/g

// Words set in maths: \mathrm{d}, \text{se}, \operatorname{sgn}. Their letters are
// prose or an operator name, never a symbol the list should declare.
const MATHS_WORD_MACRO = /\\(?:text|textrm|mathrm|operatorname|mathop)\s*\{([^{}]{0,80})\}/g

// overleaf-lab: which token of a declaration IS the symbol. `\dot{q}` declares q,
// `\alpha_{max}` declares alpha, `m_{sat}` declares m. The wrappers are stepped over
// rather than matched, so a declaration that dresses its symbol up is compared against
// the same letter the formula writes.
function symbolToken(symbol) {
    const cleaned = String(symbol).replace(/[$\s]/g, '')
    for (const m of cleaned.matchAll(SYMBOL_TOKEN)) {
        if (m[0][0] === '\\') {
            if (SYMBOL_WRAPPER_MACROS.has(m[0].slice(1))) continue
            return m[0]
        }
        return m[0]
    }
    return null
}

function isSubscripted(text, index) {
    let i = index - 1
    while (i >= 0 && (text[i] === '{' || text[i] === ' ' || text[i] === '\t')) i -= 1
    return i >= 0 && (text[i] === '_' || text[i] === '^')
}

function collectDeclaredSymbols(docs) {
    const symbols = new Map()
    const add = (raw, path, line) => {
        const token = symbolToken(raw)
        if (!token) return
        if (!symbols.has(token)) {
            symbols.set(token, { display: String(raw).replace(/\s+/g, ' ').trim().slice(0, 40), path, line })
        }
    }
    for (const doc of sources(docs)) {
        const at = lineLookup(doc.text)
        // nomencl: \nomenclature[prefix]{symbol}{description}. The symbol is read with
        // the brace-aware reader, because \nomenclature{$\vec{v}$}{velocity} cut at the
        // first closing brace declares "$\vec{v".
        for (const m of doc.text.matchAll(/\\nomenclature\s*(?:\[[^\]]{0,200}\])?\s*\{/g)) {
            add(readBracedArgument(doc.text, m.index + m[0].length - 1).value, doc.path, at(m.index))
        }
        // glossaries-extra: \glsxtrnewsymbol[description]{label}{symbol}.
        for (const m of doc.text.matchAll(/\\glsxtrnewsymbol\s*(?:\[[^\]]{0,200}\])?\s*\{[^{}]{0,400}\}\s*\{/g)) {
            add(readBracedArgument(doc.text, m.index + m[0].length - 1).value, doc.path, at(m.index))
        }
        // glossaries: \newglossaryentry{key}{... symbol={\alpha} ...}. Only entries that
        // carry a symbol key are symbols; the others are glossary words, and
        // collectDeclaredAcronyms already reads the ones that are acronyms.
        for (const m of doc.text.matchAll(
            /\\newglossaryentry\s*\{[^{}]{0,400}\}\s*\{([^{}]{0,400}(?:\{[^{}]{0,400}\}[^{}]{0,400}){0,8})\}/g
        )) {
            const symbol = /(?:^|,)\s*symbol\s*=\s*\{?([^,{}]+)/.exec(m[1])
            if (symbol) add(symbol[1], doc.path, at(m.index))
        }
    }
    return symbols
}

CHECKS['symbol-list'] = {
    describe: 'the list of symbols matches the symbols the maths actually uses',
    run(docs) {
        const declared = collectDeclaredSymbols(docs)
        const used = new Set()
        const candidates = new Map()
        let equations = 0
        let capped = false
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const text = doc.text.replace(SYMBOL_DECLARATION, blankSpan)
            // ONE sweep over the maths of the file. The spans are merged and disjoint
            // (findMathsSpans), so slicing them copies the maths of the document once in
            // total rather than once per declared symbol: the obvious loop - test every
            // declared symbol against the whole text - is O(symbols x document), and the
            // number of declarations is whatever the student's file contains.
            for (const [start, end] of findMathsSpans(text)) {
                for (const m of text.slice(start, end).matchAll(SYMBOL_TOKEN)) used.add(m[0])
            }
            // The second direction only exists when there is a list to be absent from.
            if (declared.size === 0) continue
            for (const block of findEnvironments(text, DISPLAY_MATHS_ENVIRONMENTS)) {
                if (!block.terminated) continue
                equations += 1
                const body = block.body.replace(MATHS_WORD_MACRO, blankSpan)
                for (const m of body.matchAll(EQUATION_SYMBOL)) {
                    const token = m[1] ? `\\${m[1]}` : m[2]
                    if (m[1] && !GREEK_COMMANDS.has(m[1])) continue
                    if (declared.has(token)) continue
                    let entry = candidates.get(token)
                    if (!entry) {
                        if (candidates.size >= MAX_SYMBOL_CANDIDATES) {
                            capped = true
                            continue
                        }
                        entry = { count: 0, subscripts: 0, path: doc.path, line: at(block.start + m.index) }
                        candidates.set(token, entry)
                    }
                    entry.count += 1
                    if (isSubscripted(body, m.index)) entry.subscripts += 1
                }
            }
        }
        if (declared.size === 0)
            return result(
                'na',
                L(
                    'The document declares no symbol with \\nomenclature or a glossaries symbol entry. A list of ' +
                        'symbols typeset by hand as a table is not read here: which column is the symbol and which ' +
                        'the description cannot be decided without guessing.',
                    'Il documento non dichiara nessun simbolo con \\nomenclature né con una voce simbolo di ' +
                        'glossaries. Un elenco dei simboli composto a mano come tabella non viene letto qui: quale ' +
                        'colonna sia il simbolo e quale la descrizione non è decidibile senza tirare a indovinare.'
                )
            )
        const unused = []
        for (const [token, entry] of declared) {
            if (used.has(token)) continue
            unused.push({
                path: entry.path,
                line: entry.line,
                what: L(
                    `"${entry.display}" is declared but ${token} never appears in any maths`,
                    `"${entry.display}" è dichiarato ma ${token} non compare in nessuna formula`
                ),
            })
        }
        const missingFromList = []
        for (const [token, entry] of candidates) {
            // A counter is not a quantity. Damped only when EVERY occurrence is a
            // subscript: an n standing alone is the size of something and belongs in
            // the list.
            if (DUMMY_INDEX_LETTERS.has(token) && entry.subscripts === entry.count) continue
            missingFromList.push({
                path: entry.path,
                line: entry.line,
                what: L(
                    `${token} is used ${entry.count} time${entry.count === 1 ? '' : 's'} in an equation and is in no list`,
                    `${token} è usato ${entry.count} volt${entry.count === 1 ? 'a' : 'e'} in un'equazione e non è in nessun elenco`
                ),
            })
        }
        const candidateNote = missingFromList.length
            ? L(
                  ` ${missingFromList.length} symbol${
                      missingFromList.length === 1 ? '' : 's'
                  } used in the ${equations} display equations ${
                      missingFromList.length === 1 ? 'is' : 'are'
                  } in no list (candidates, single letters and greek letters only${
                      capped ? ', tracking capped' : ''
                  }): ${listing(missingFromList)}.`,
                  ` ${missingFromList.length} simbol${
                      missingFromList.length === 1 ? 'o' : 'i'
                  } usati nelle ${equations} equazioni fuori testo non sono in nessun elenco (candidati, solo ` +
                      `lettere singole e lettere greche${capped ? ', tracciamento limitato' : ''}): ${listing(
                          missingFromList
                      )}.`
              )
            : ''
        if (unused.length > 0)
            return result(
                'missing',
                L(
                    `${unused.length} of ${declared.size} declared symbols never appear in any maths: ${listing(
                        unused
                    )}.${candidateNote}`,
                    `${unused.length} simboli dichiarati su ${declared.size} non compaiono in nessuna formula: ${listing(
                        unused
                    )}.${candidateNote}`
                ),
                unused.concat(missingFromList)
            )
        if (missingFromList.length > 0)
            return result(
                'partial',
                L(
                    `All ${declared.size} declared symbols are used in the maths.${candidateNote}`,
                    `Tutti i ${declared.size} simboli dichiarati sono usati nelle formule.${candidateNote}`
                ),
                missingFromList
            )
        return result(
            'ok',
            L(
                `All ${declared.size} declared symbols are used in the maths, and every single-letter or greek ` +
                    `symbol of the ${equations} display equations is declared.`,
                `Tutti i ${declared.size} simboli dichiarati sono usati nelle formule e ogni simbolo a lettera ` +
                    `singola o greca delle ${equations} equazioni fuori testo è dichiarato.`
            )
        )
    },
}

// overleaf-lab: three facts about how the maths is written down. None of them is a
// norm: which differential a field prefers, whether a vector is an arrow or a bold
// letter, whether an operator name is spelled with a backslash - a rubric decides. What
// a parser can decide is whether the document does the SAME THING throughout, and where
// it does not.
const MATHS_OPERATORS = [
    'sin', 'cos', 'tan', 'log', 'ln', 'exp', 'min', 'max', 'lim', 'det', 'arg', 'sup', 'inf', 'mod',
]

// An operator name typed as three letters is typeset as three variables in italics:
// "sin" is s times i times n. Written from the array so the two spellings of the same
// list can never drift apart.
const BARE_OPERATOR = new RegExp(`(?<![\\\\A-Za-z])(${MATHS_OPERATORS.join('|')})(?![A-Za-z])`, 'g')
const BACKSLASH_OPERATOR = new RegExp(`\\\\(${MATHS_OPERATORS.join('|')})(?![A-Za-z])`, 'g')

// overleaf-lab: how a vector is dressed. The style is what matters, not the command:
// \mathbf, \bm and \boldsymbol are three spellings of "bold", and mixing bold with an
// arrow ON THE SAME SYMBOL is the fact this reports. Two different symbols in two
// different styles is a convention, not a defect: bold upright matrices beside arrow
// vectors is what half the textbooks do, and reporting it would hand the author a
// correction that makes the document worse.
const VECTOR_MARKUP = /\\(vec|mathbf|bm|boldsymbol|symbf)\s*(?:\{([^{}]{0,40})\}|([A-Za-z]))/g
const VECTOR_STYLES = { vec: 'arrow', mathbf: 'bold', bm: 'bold', boldsymbol: 'bold', symbf: 'bold' }

// The upright differential, in every spelling a package gives it, and the plain one.
// The plain form is only read inside a formula that HAS an integral or a d/d fraction:
// a bare "d" next to a letter is a product as often as a differential, and this file
// does not hand out corrections on a formula that is already right.
const UPRIGHT_DIFFERENTIAL = /\\(?:mathrm|text|operatorname)\s*\{\s*d\s*\}|\\dd(?![a-zA-Z])/g
const PLAIN_DIFFERENTIAL = /(?<![\\A-Za-z])d(?=\s?[A-Za-z\\])/g
const DIFFERENTIAL_CONTEXT = /\\i?int|\\oint|\\frac\s*\{\s*d/

// The differential AND what it differentiates, so the evidence quotes "dx" and not the
// dollar sign that happened to follow it.
const PLAIN_DIFFERENTIAL_QUOTE = /^d\s?(?:\\[a-zA-Z]+|[A-Za-z])/

function plainDifferential(text, index) {
    const quoted = PLAIN_DIFFERENTIAL_QUOTE.exec(text.slice(index, index + 16))
    return quoted ? quoted[0] : 'd'
}

CHECKS['math-notation'] = {
    describe: 'the maths is written one way throughout: operator names, vectors and differentials',
    run(docs) {
        const bare = []
        const withBackslash = new Set()
        const vectors = new Map()
        const styleTotals = { arrow: 0, bold: 0 }
        const differentials = { upright: 0, plain: 0, first: [] }
        let spans = 0
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            // ONE sweep per file over the maths, and the maths only: findMathsSpans
            // merges the inline and display spans, so the slices below copy the maths of
            // the document once in total and every offset still resolves to the real
            // source line.
            for (const [start, end] of findMathsSpans(doc.text)) {
                spans += 1
                const raw = doc.text.slice(start, end)
                // \mathrm{max} and \operatorname{sgn} are how an operator is written
                // CORRECTLY, and \text{se} is prose: their letters must not be read as a
                // bare operator name. Blanked, so the offsets survive.
                const body = raw.replace(MATHS_WORD_MACRO, blankSpan)
                for (const m of body.matchAll(BARE_OPERATOR)) {
                    // x_{min} is a subscript that happens to be spelled like an operator:
                    // the author means "the minimum x", and telling them to write \min
                    // there produces a formula that is wrong.
                    if (isSubscripted(body, m.index)) continue
                    bare.push({ name: m[1], path: doc.path, line: at(start + m.index) })
                }
                for (const m of raw.matchAll(BACKSLASH_OPERATOR)) withBackslash.add(m[1])
                for (const m of raw.matchAll(VECTOR_MARKUP)) {
                    const symbol = (m[2] === undefined ? m[3] : m[2]).trim()
                    if (!symbol) continue
                    const style = VECTOR_STYLES[m[1]]
                    styleTotals[style] += 1
                    if (!vectors.has(symbol)) vectors.set(symbol, new Map())
                    const styles = vectors.get(symbol)
                    if (!styles.has(style)) {
                        styles.set(style, {
                            command: `\\${m[1]}`,
                            count: 0,
                            path: doc.path,
                            line: at(start + m.index),
                        })
                    }
                    styles.get(style).count += 1
                }
                for (const m of raw.matchAll(UPRIGHT_DIFFERENTIAL)) {
                    differentials.upright += 1
                    if (differentials.upright === 1) {
                        differentials.first.push({
                            path: doc.path,
                            line: at(start + m.index),
                            what: L(`upright differential ${m[0]}`, `differenziale dritto ${m[0]}`),
                        })
                    }
                }
                if (!DIFFERENTIAL_CONTEXT.test(raw)) continue
                for (const m of raw.matchAll(PLAIN_DIFFERENTIAL)) {
                    differentials.plain += 1
                    if (differentials.plain === 1) {
                        differentials.first.push({
                            path: doc.path,
                            line: at(start + m.index),
                            what: L(
                                `plain differential "${plainDifferential(raw, m.index)}"`,
                                `differenziale in corsivo "${plainDifferential(raw, m.index)}"`
                            ),
                        })
                    }
                }
            }
        }
        if (spans === 0)
            return result(
                'na',
                L(
                    'The document contains no maths: neither an inline formula nor a display equation.',
                    'Il documento non contiene formule: né in linea né fuori testo.'
                )
            )
        const bad = []
        for (const item of bare) {
            bad.push({
                path: item.path,
                line: item.line,
                what: withBackslash.has(item.name)
                    ? L(
                          `"${item.name}" is written without a backslash, while the document also writes \\${item.name}`,
                          `"${item.name}" è scritto senza backslash, mentre il documento scrive anche \\${item.name}`
                      )
                    : L(
                          `"${item.name}" is written without a backslash, so it is typeset as a product of letters`,
                          `"${item.name}" è scritto senza backslash, quindi viene composto come un prodotto di lettere`
                      ),
            })
        }
        const mixedVectors = []
        for (const [symbol, styles] of vectors) {
            if (styles.size < 2) continue
            const spelled = [...styles.entries()]
                .map(([, s]) => `${s.command} x${s.count}`)
                .join(L(' and ', ' e '))
            const first = [...styles.values()].sort((a, b) => a.line - b.line)[0]
            mixedVectors.push({
                path: first.path,
                line: first.line,
                what: L(
                    `"${symbol}" is written in two styles: ${spelled}`,
                    `"${symbol}" è scritto in due stili: ${spelled}`
                ),
            })
        }
        bad.push(...mixedVectors)
        const bothDifferentials = differentials.upright > 0 && differentials.plain > 0
        if (bothDifferentials) bad.push(...differentials.first)
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `The ${spans} piece${spans === 1 ? '' : 's'} of maths in the document carr${
                        spans === 1 ? 'ies' : 'y'
                    } no bare operator name, no symbol written in two vector styles and no mixture of upright and ` +
                        'plain differentials.',
                    `${
                        spans === 1 ? "L'unica porzione di matematica non contiene" : `Le ${spans} porzioni di matematica non contengono`
                    } nomi di operatore senza backslash, né simboli scritti in due stili vettoriali, né una ` +
                        'mescolanza di differenziali dritti e in corsivo.'
                )
            )
        const parts = []
        if (bare.length > 0) {
            parts.push(
                L(
                    `${bare.length} operator name${bare.length === 1 ? '' : 's'} written without a backslash.`,
                    `${bare.length} nom${bare.length === 1 ? 'e' : 'i'} di operatore scritti senza backslash.`
                )
            )
        }
        if (mixedVectors.length > 0) {
            parts.push(
                L(
                    `${mixedVectors.length} symbol${
                        mixedVectors.length === 1 ? '' : 's'
                    } written in two vector styles (${styleTotals.arrow} arrow uses and ${styleTotals.bold} bold uses in all).`,
                    `${mixedVectors.length} simbol${
                        mixedVectors.length === 1 ? 'o scritto' : 'i scritti'
                    } in due stili vettoriali (${styleTotals.arrow} usi con freccia e ${styleTotals.bold} in grassetto in tutto).`
                )
            )
        }
        if (bothDifferentials) {
            parts.push(
                L(
                    `Both differentials are in use: ${differentials.upright} upright and ${differentials.plain} plain. ` +
                        'Which one is right is not decided here; that both appear is the fact.',
                    `Sono in uso entrambi i differenziali: ${differentials.upright} dritti e ${differentials.plain} in ` +
                        'corsivo. Quale sia quello giusto non si decide qui: il fatto è che compaiono entrambi.'
                )
            )
        }
        return result('missing', `${parts.join(' ')} ${listing(bad)}`, bad)
    },
}

// overleaf-lab: a table that is really a screenshot. The rows cannot be searched, the
// numbers cannot be copied, the font does not match the document and the caption
// numbering lies about what the object is. Two shapes, both exact: a graphic inside a
// table environment, and a FIGURE whose caption calls itself a table.
const TABLE_ENVIRONMENTS = ['table', 'tabular', 'tabularx', 'longtable', 'sidewaystable']
const FIGURE_ENVIRONMENTS = ['figure', 'sidewaysfigure', 'wrapfigure']

// The word a caption starts with, per language, kept as small as the rest of this
// file's language data and selected through the same mechanism every other check uses.
// A hand-written list is the only way to know what "table" is called, and a list of two
// words per language cannot grow into a policy.
const TABLE_CAPTION_WORDS = { en: ['table', 'tables'], it: ['tabella', 'tabelle'] }

const CAPTION_ARGUMENT = /\\caption(?:of\s*\{[^}]{0,400}\})?\*?\s*(?:\[[^\]]{0,200}\])?\s*\{/g

CHECKS['tables-as-images'] = {
    describe: 'a table is typeset as a table, not pasted in as a picture',
    run(docs) {
        const bad = []
        let total = 0
        const words = L(TABLE_CAPTION_WORDS.en, TABLE_CAPTION_WORDS.it)
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const blocks = findEnvironments(doc.text, TABLE_ENVIRONMENTS).filter(b => b.terminated)
            total += blocks.length
            // A tabular is also how two graphics are put SIDE BY SIDE inside a figure,
            // which is a layout and not a table pasted in as a picture. Those spans are
            // skipped rather than reported: the check would otherwise fire on one of the
            // most ordinary constructions in a thesis.
            const figures = mergeSpans(
                findEnvironments(doc.text, FIGURE_ENVIRONMENTS)
                    .filter(b => b.terminated)
                    .map(b => [b.start, b.end])
            )
            // Every graphic is attributed to its INNERMOST table, in ONE sweep: a
            // tabular inside a table shares the parent's body, so re-reading each body
            // would report the same graphic twice and cost O(size x depth).
            let next = 0
            const stack = []
            for (const m of doc.text.matchAll(/\\includegraphics\b/g)) {
                while (next < blocks.length && blocks[next].start <= m.index) {
                    stack.push(blocks[next])
                    next += 1
                }
                while (stack.length && m.index >= stack[stack.length - 1].end) stack.pop()
                const innermost = stack[stack.length - 1]
                if (!innermost) continue
                if (insideSpans(figures, m.index)) continue
                bad.push({
                    path: doc.path,
                    line: at(m.index),
                    what: L(
                        `\\includegraphics inside a ${innermost.name}`,
                        `\\includegraphics dentro un ambiente ${innermost.name}`
                    ),
                })
            }
            for (const block of findEnvironments(doc.text, FIGURE_ENVIRONMENTS)) {
                if (!block.terminated) continue
                for (const m of block.body.matchAll(CAPTION_ARGUMENT)) {
                    const title = readBracedArgument(block.body, m.index + m[0].length - 1).value
                    total += 1
                    // The first word of the caption, with the markup stripped: a caption
                    // that opens with \textbf{Tabella} says the same thing.
                    const first = /[\p{L}]{2,}/u.exec(title.replace(/\\[a-zA-Z]+/g, ' '))
                    if (!first || !words.includes(first[0].toLowerCase())) continue
                    bad.push({
                        path: doc.path,
                        line: at(block.start + m.index),
                        what: L(
                            `a ${block.name} whose caption begins with "${first[0]}"`,
                            `un ambiente ${block.name} la cui didascalia comincia con "${first[0]}"`
                        ),
                    })
                }
            }
        }
        if (total === 0)
            return result(
                'na',
                L(
                    'The document contains no table environment and no captioned figure.',
                    'Il documento non contiene ambienti tabella né figure con didascalia.'
                )
            )
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `None of the ${total} tables and captioned figures inspected is a picture of a table.`,
                    `Nessuna delle ${total} tabelle e figure con didascalia ispezionate è l'immagine di una tabella.`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${total} inspected tables and captioned figures look like a table pasted in as a picture: ${listing(
                    bad
                )}`,
                `${bad.length} su ${total} tra tabelle e figure con didascalia ispezionate sembrano una tabella incollata come immagine: ${listing(
                    bad
                )}`
            ),
            bad
        )
    },
}

// overleaf-lab: the shape of the table of contents. Two facts, one sweep over the
// sectioning commands.
const SECTION_LEVELS = {
    part: 0,
    chapter: 1,
    section: 2,
    subsection: 3,
    subsubsection: 4,
    paragraph: 5,
    subparagraph: 6,
}
const SECTION_COMMAND =
    /\\(part|chapter|subsubsection|subsection|section|subparagraph|paragraph)\s*(\*?)\s*(?:\[[^\]]{0,200}\])?\s*\{/g

// What is NOT body text between two headings. A \label belongs to the heading above it,
// and a page break, a vertical space or a table-of-contents line is layout: a chapter
// whose title is followed by nothing but those has no introduction, which is the fact.
const NON_BODY_MARKUP =
    /\\(?:label|index|glsadd|addcontentsline|markboth|markright|thispagestyle|pagestyle|clearpage|cleardoublepage|newpage|pagebreak|nopagebreak|noindent|par|centering|vspace|vfill|hfill|bigskip|medskip|smallskip|setcounter|refstepcounter|phantomsection|leavevmode|hspace)(?![a-zA-Z])\*?(?:\s*\{[^{}]{0,400}\})*(?:\s*\[[^\]]{0,200}\])?/g

// Only the levels a reader thinks of as a numbered division. A \paragraph is a run-in
// heading: having exactly one of them under a subsection is ordinary writing, not
// numbering nobody needs.
const MAX_LONELY_PARENT_LEVEL = 3

// How far a title may be read. The general brace reader walks 4000 characters before
// giving up on a brace that never closes, which is right for a macro body and far too
// generous for a heading: 2 MB of `\chapter{` is half a million titles, each of them
// walked to the cap, and that cost 12.5 s of frozen event loop. No printed heading comes
// anywhere near this length.
const MAX_HEADING_TITLE = 200

function collectHeadings(text) {
    const macros = macroDefinitionRegions(text)
    const headings = []
    for (const m of text.matchAll(SECTION_COMMAND)) {
        // A heading inside a \newcommand is a template whose title is a macro parameter:
        // the same guard float-caption and crossrefs-resolve already carry.
        if (insideSpans(macros, m.index)) continue
        const arg = readBracedArgument(text, m.index + m[0].length - 1, MAX_HEADING_TITLE)
        headings.push({
            name: m[1],
            level: SECTION_LEVELS[m[1]],
            starred: m[2] === '*',
            index: m.index,
            bodyStart: arg.end + 1,
            title: arg.value.replace(NON_PROSE_ARGUMENT, blankSpan).replace(/\s+/g, ' ').trim().slice(0, 40),
            children: 0,
            onlyChild: null,
        })
    }
    return headings
}

CHECKS['heading-sequence'] = {
    describe: 'no heading is immediately followed by another, and no division carries a single subdivision',
    run(docs) {
        const empty = []
        const lonely = []
        let total = 0
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const headings = collectHeadings(doc.text)
            total += headings.length
            for (let i = 0; i + 1 < headings.length; i++) {
                const between = doc.text
                    .slice(headings[i].bodyStart, headings[i + 1].index)
                    .replace(/(?<!\\)%[^\n]*/g, ' ')
                    .replace(NON_BODY_MARKUP, ' ')
                if (/\S/.test(between)) continue
                empty.push({
                    path: doc.path,
                    line: at(headings[i].index),
                    what: L(
                        `${headings[i].name} "${headings[i].title}" is followed straight by ${headings[i + 1].name} "${
                            headings[i + 1].title
                        }", with no text between them`,
                        `${headings[i].name} "${headings[i].title}" è seguito subito da ${headings[i + 1].name} "${
                            headings[i + 1].title
                        }", senza testo in mezzo`
                    ),
                })
            }
            // The same sweep, read as a tree. A division with exactly ONE subdivision
            // numbers a section 3.1 that has no 3.2: the number carries no information.
            const stack = []
            const close = node => {
                if (node.children !== 1 || node.level > MAX_LONELY_PARENT_LEVEL) return
                // An unnumbered heading has no numbering to be pointless about, on
                // either side of the pair.
                if (node.starred || node.onlyChild.starred) return
                lonely.push({
                    path: doc.path,
                    line: at(node.index),
                    what: L(
                        `${node.name} "${node.title}" contains exactly one ${node.onlyChild.name}: "${node.onlyChild.title}"`,
                        `${node.name} "${node.title}" contiene esattamente un ${node.onlyChild.name}: "${node.onlyChild.title}"`
                    ),
                })
            }
            for (const heading of headings) {
                while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) close(stack.pop())
                const parent = stack[stack.length - 1]
                if (parent) {
                    parent.children += 1
                    if (parent.children === 1) parent.onlyChild = heading
                }
                stack.push(heading)
            }
            while (stack.length > 0) close(stack.pop())
        }
        const bad = empty.concat(lonely)
        if (total < 2)
            return result(
                'na',
                L(
                    'The document carries fewer than two headings, so no sequence of headings can be read.',
                    'Il documento ha meno di due titoli, quindi non esiste una sequenza di titoli da leggere.'
                )
            )
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `Each of the ${total} headings is followed by text, and no division carries a single subdivision.`,
                    `Ognuno dei ${total} titoli è seguito da testo e nessuna divisione ha una sola sottodivisione.`
                )
            )
        const parts = []
        if (empty.length > 0) {
            parts.push(
                L(
                    `${empty.length} heading${empty.length === 1 ? ' is' : 's are'} followed straight by another heading.`,
                    `${empty.length} titol${empty.length === 1 ? 'o è seguito' : 'i sono seguiti'} subito da un altro titolo.`
                )
            )
        }
        if (lonely.length > 0) {
            parts.push(
                L(
                    `${lonely.length} division${lonely.length === 1 ? '' : 's'} carr${
                        lonely.length === 1 ? 'ies' : 'y'
                    } exactly one subdivision.`,
                    `${lonely.length} division${lonely.length === 1 ? 'e ha' : 'i hanno'} esattamente una sottodivisione.`
                )
            )
        }
        return result('missing', `${parts.join(' ')} ${listing(bad)}`, bad)
    },
}

// overleaf-lab: an appendix nobody sends the reader to. The material is bound into the
// document, numbered and listed in the table of contents, and no sentence of the thesis
// ever says to go and look at it. float-referenced asks the same question of a figure;
// the label infrastructure is the same, and so is the honesty rule: a heading with no
// \label cannot be referenced by any means, so it is counted and declared rather than
// judged.
const APPENDIX_COMMAND = /\\appendix(?![a-zA-Z])/
const APPENDIX_ENVIRONMENTS = ['appendices', 'appendix']

function appendixRegions(text) {
    const regions = []
    // \appendix is a SWITCH, not an environment: everything after it is appendix
    // material until the end of the file.
    const start = APPENDIX_COMMAND.exec(text)
    if (start) regions.push([start.index, text.length])
    for (const env of findEnvironments(text, APPENDIX_ENVIRONMENTS)) {
        regions.push([env.start, env.terminated ? env.end : text.length])
    }
    return mergeSpans(regions)
}

CHECKS['appendix-referenced'] = {
    describe: 'every appendix is referred to at least once from the text',
    run(docs) {
        const mainUses = new Set()
        const appendixUses = new Set()
        const found = []
        let declaredAppendices = false
        let unlabelled = 0
        const wrappers = referenceWrappers(sources(docs))
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const regions = appendixRegions(doc.text)
            // A reference written INSIDE the appendices is not the main text sending the
            // reader there: appendix B pointing at appendix C says nothing about whether
            // the thesis ever uses either. Both are collected, and the evidence tells the
            // two apart instead of silently accepting one for the other.
            for (const use of [
                ...collectReferenceUses(doc.text, wrappers),
                ...wrapperReferenceUses(doc.text, wrappers),
            ]) {
                if (insideSpans(regions, use.index)) appendixUses.add(use.name)
                else mainUses.add(use.name)
            }
            if (regions.length === 0) continue
            declaredAppendices = true
            const headings = collectHeadings(doc.text).filter(h => insideSpans(regions, h.index))
            if (headings.length === 0) continue
            // The appendices themselves are the SHALLOWEST headings after the switch.
            // Taking every chapter and section would demand a reference for each section
            // INSIDE an appendix, which is not what an appendix is.
            const top = Math.min(...headings.map(h => h.level))
            for (let i = 0; i < headings.length; i++) {
                if (headings[i].level !== top) continue
                const stop = i + 1 < headings.length ? headings[i + 1].index : doc.text.length
                const label = /\\label\s*\{([^}]{1,400})\}/.exec(doc.text.slice(headings[i].bodyStart, stop))
                if (!label) {
                    unlabelled += 1
                    continue
                }
                found.push({
                    name: label[1].trim(),
                    title: headings[i].title,
                    path: doc.path,
                    line: at(headings[i].index),
                })
            }
        }
        const caveat = unlabelled
            ? L(
                  ` ${unlabelled} appendix heading${
                      unlabelled === 1 ? ' carries' : 'es carry'
                  } no \\label and therefore cannot be referenced at all: those were not judged here.`,
                  unlabelled === 1
                      ? " 1 titolo di appendice non ha una \\label e quindi non è citabile in alcun modo: qui non è stato giudicato."
                      : ` ${unlabelled} titoli di appendice non hanno una \\label e quindi non sono citabili in alcun modo: qui non sono stati giudicati.`
              )
            : ''
        if (!declaredAppendices)
            return result(
                'na',
                L(
                    'The document declares no appendix: there is no \\appendix and no appendices environment.',
                    'Il documento non dichiara appendici: non c\'è nessun \\appendix né un ambiente appendices.'
                )
            )
        if (found.length === 0)
            return result(
                'na',
                L(
                    `No appendix carries a \\label to be referenced by.${caveat}`,
                    `Nessuna appendice ha una \\label con cui essere citata.${caveat}`
                )
            )
        const bad = found
            .filter(a => !mainUses.has(a.name))
            .map(a => ({
                path: a.path,
                line: a.line,
                what: appendixUses.has(a.name)
                    ? L(
                          `"${a.title}" (\\label{${a.name}}) is only referenced from inside the appendices`,
                          `"${a.title}" (\\label{${a.name}}) è citata solo da dentro le appendici`
                      )
                    : L(
                          `"${a.title}" (\\label{${a.name}}) is never referenced`,
                          `"${a.title}" (\\label{${a.name}}) non è mai citata`
                      ),
            }))
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `All ${found.length} labelled appendices are referenced from the text.${caveat}`,
                    `Tutte le ${found.length} appendici con label sono citate nel testo.${caveat}`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${found.length} labelled appendices are never referenced from the text: ${listing(
                    bad
                )}${caveat}`,
                `${bad.length} appendici con label su ${found.length} non sono mai citate nel testo: ${listing(
                    bad
                )}${caveat}`
            ),
            bad
        )
    },
}

// overleaf-lab: what the document CALLS the thing it is pointing at. "vedi la Figura 3"
// and "come mostra la Fig. 4" are the same object under two names, and a reader who
// meets both has to decide whether they mean the same kind of thing.
//
// LANGUAGE-INDEPENDENT BY CONSTRUCTION, like manual-numbering above it. Nothing here
// knows the word for "figure": the classes are built from the document's OWN label
// prefixes (fig:, tab:, cap:) and from the words it writes before its references, and
// the only vocabulary in play is NUMBERED_OBJECT_WORDS, which already ships.
const REFERENCE_LEAD = /([\p{L}]{2,})(\.?)[\s~]*$/u

// How far back a naming word may sit. The same window learnReferenceWords uses, for the
// same reason: further than this and the "word before the reference" is a word from the
// previous clause.
const REFERENCE_LEAD_SPAN = 40

// overleaf-lab: tokens grouped by prefix, in one sorted pass. "fig", "figura" and
// "figure" are one class because they share a stem; "sec" and "sez" are two, which is
// right, because a document is written in one language and only uses one of them.
//
// The obvious implementation compares every token with every other one, which is
// quadratic in the number of distinct label prefixes - a number a student's file
// decides. Sorted, a prefix always comes immediately before the tokens it introduces,
// so a stack of open prefixes groups them in one pass.
function prefixClasses(tokens) {
    const parent = new Map()
    for (const token of tokens) if (token.length >= 2 && !parent.has(token)) parent.set(token, token)
    const find = token => {
        let node = token
        while (parent.get(node) !== node) {
            parent.set(node, parent.get(parent.get(node)))
            node = parent.get(node)
        }
        return node
    }
    const stack = []
    for (const token of [...parent.keys()].sort()) {
        while (stack.length > 0 && !token.startsWith(stack[stack.length - 1])) stack.pop()
        if (stack.length > 0) {
            const root = find(stack[stack.length - 1])
            const mine = find(token)
            if (root !== mine) parent.set(mine, root)
        }
        stack.push(token)
    }
    return token => (parent.has(token) ? find(token) : token)
}

// Two names for the same object that differ only in their last letter are the same
// name inflected: "figura"/"figure", "tabella"/"tabelle", "sezione"/"sezioni". Reporting
// a plural as a second style would accuse every document that ever writes "le Figure 3
// e 4", which is correct Italian. An abbreviation is a different length, so "fig." and
// "figura" stay two styles, which is the case this check exists for.
function sameStyleName(a, b) {
    return a === b || (a.length === b.length && a.slice(0, -1) === b.slice(0, -1))
}

CHECKS['reference-style-mixing'] = {
    describe: 'a numbered object is called the same way before every reference to it',
    run(docs) {
        const words = [...new Set([...learnReferenceWords(docs), ...NUMBERED_OBJECT_WORDS])]
        // The same hand-written numbers manual-numbering finds, read here for their
        // NAME rather than for the number: "Figura 3" is a style like any other.
        const manual = new RegExp(
            `(?<![\\p{L}])(${words.map(escapeRegExp).join('|')})[\\s~]*(\\d+(?:\\.\\d+)*)`,
            'giu'
        )
        const observed = []
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            for (const use of collectReferenceUses(doc.text)) {
                const lead = REFERENCE_LEAD.exec(
                    doc.text.slice(Math.max(0, use.index - REFERENCE_LEAD_SPAN), use.index)
                )
                if (!lead) continue
                const word = lead[1].toLowerCase()
                // A preposition or an article is not the name of anything: the same
                // stopset manual-numbering already needs, for the same defect.
                if (REFERENCE_STOPWORDS.has(word)) continue
                const colon = use.name.indexOf(':')
                observed.push({
                    // The document's own class marker when it has one, and the naming
                    // word itself when it does not.
                    token: colon > 1 ? use.name.slice(0, colon).toLowerCase() : word,
                    style: `${word}${lead[2]}`,
                    path: doc.path,
                    line: at(use.index),
                })
            }
            for (const m of doc.text.matchAll(manual)) {
                if (looksLikeYear(m[2])) continue
                observed.push({
                    token: m[1].toLowerCase(),
                    style: m[1].toLowerCase(),
                    path: doc.path,
                    line: at(m.index),
                })
            }
        }
        if (observed.length === 0)
            return result(
                'na',
                L(
                    'No reference in the document is preceded by a word naming what it points at.',
                    'Nessun richiamo del documento è preceduto da una parola che nomina l\'oggetto puntato.'
                )
            )
        const classOf = prefixClasses(observed.map(o => o.token).concat(NUMBERED_OBJECT_WORDS))
        const classes = new Map()
        for (const item of observed) {
            const name = classOf(item.token)
            if (!classes.has(name)) classes.set(name, new Map())
            const styles = classes.get(name)
            if (!styles.has(item.style)) {
                styles.set(item.style, { count: 0, path: item.path, line: item.line })
            }
            styles.get(item.style).count += 1
        }
        const bad = []
        for (const [name, styles] of classes) {
            // Styles that are one another's inflection are one style.
            const groups = []
            for (const [style, entry] of styles) {
                const group = groups.find(g => sameStyleName(g.style, style))
                if (group) group.count += entry.count
                else groups.push({ style, count: entry.count, path: entry.path, line: entry.line })
            }
            if (groups.length < 2) continue
            const first = groups.slice().sort((a, b) => a.line - b.line)[0]
            bad.push({
                path: first.path,
                line: first.line,
                what: L(
                    `references to "${name}" are introduced by ${groups.length} different words: ${groups
                        .map(g => `"${g.style}" x${g.count}`)
                        .join(', ')}`,
                    `i richiami a "${name}" sono introdotti da ${groups.length} parole diverse: ${groups
                        .map(g => `"${g.style}" x${g.count}`)
                        .join(', ')}`
                ),
            })
        }
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `Each of the ${classes.size} kind${
                        classes.size === 1 ? '' : 's'
                    } of numbered object is introduced by one word throughout (${observed.length} references read).`,
                    `Ognuno dei ${classes.size} tipi di oggetto numerato è introdotto sempre dalla stessa parola ` +
                        `(${observed.length} richiami letti).`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${classes.size} kind${
                    classes.size === 1 ? '' : 's'
                } of numbered object ${bad.length === 1 ? 'is' : 'are'} named in more than one way: ${listing(bad)}`,
                `${bad.length} tipi di oggetto numerato su ${classes.size} sono nominati in più di un modo: ${listing(
                    bad
                )}`
            ),
            bad
        )
    },
}

// overleaf-lab: the prose a READER reads, with everything that is not prose blanked and
// every offset kept. Maths is symbol names, a comment is not typeset, a label or a file
// name is an identifier. Verbatim and inline \verb are already blank by the time a check
// runs (see runCheck), so they are not repeated here.
//
// Text formatting is deliberately NOT unwrapped, unlike acronymScannable: the checks
// below are about the formatting itself.
const INLINE_DOLLAR_MATHS = /\$\$[\s\S]{0,4000}?\$\$|(?<!\\)\$[^$\n]{0,400}?(?<!\\)\$/g

function proseOnly(text) {
    return blankEnvironments(
        blankDisplayMaths(text.replace(INLINE_DOLLAR_MATHS, blankSpan)),
        DISPLAY_MATHS_ENVIRONMENTS
    )
        .replace(/(?<!\\)%[^\n]*/g, blankSpan)
        .replace(NON_PROSE_ARGUMENT, blankSpan)
}

// overleaf-lab: a word the document italicises in one place and sets in roman in
// another. Which of the two is right is not decidable here and is not the point: a
// technical term, a foreign word or a variable name is either emphasised throughout or
// nowhere, and the fact this reports is that the document does both.
const ITALIC_MARKUP = /\\(?:textit|emph|textsl)\s*\{([^{}]{0,200})\}/g

// Short words say nothing. A "the" or an "il" italicised once inside a title is not a
// document that cannot make up its mind, and reporting it would bury the terms that
// are. Built into the pattern so the number lives in one place.
const MIN_ITALIC_WORD = 4
const PROSE_WORD = new RegExp(`\\p{L}{${MIN_ITALIC_WORD},}`, 'gu')

function proseWords(text, into, where) {
    // A command name is not a word the reader sees: \centering must not count as an
    // occurrence of "centering".
    const stripped = text.replace(/\\[a-zA-Z]+/g, blankSpan)
    for (const m of stripped.matchAll(PROSE_WORD)) {
        const word = m[0].toLowerCase()
        const entry = into.get(word)
        if (entry) entry.count += 1
        else into.set(word, { count: 1, path: where.path, line: where.at(where.offset + m.index) })
    }
}

CHECKS['italic-coherence'] = {
    describe: 'a word is either emphasised throughout the document or nowhere',
    run(docs) {
        const italic = new Map()
        const plain = new Map()
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const prose = proseOnly(doc.text)
            const spans = []
            for (const m of prose.matchAll(ITALIC_MARKUP)) {
                // Where the emphasised text starts in the real file, so the line the
                // report prints is the line the student sees.
                const inner = m.index + m[0].length - m[1].length - 1
                spans.push([m.index, m.index + m[0].length])
                proseWords(m[1], italic, { path: doc.path, at, offset: inner })
            }
            // The plain pass reads the same prose with the emphasised spans blanked, so
            // no occurrence is counted on both sides.
            proseWords(blankRanges(prose, mergeSpans(spans)), plain, { path: doc.path, at, offset: 0 })
        }
        if (italic.size === 0)
            return result(
                'na',
                L(
                    'The document emphasises no word of four letters or more with \\textit or \\emph.',
                    'Il documento non enfatizza nessuna parola di quattro lettere o più con \\textit o \\emph.'
                )
            )
        const bad = []
        for (const [word, entry] of italic) {
            const other = plain.get(word)
            if (!other) continue
            bad.push({
                path: entry.path,
                line: entry.line,
                what: L(
                    `"${word}" is emphasised ${entry.count} time${
                        entry.count === 1 ? '' : 's'
                    } and set in roman ${other.count} time${other.count === 1 ? '' : 's'}`,
                    `"${word}" è enfatizzata ${entry.count} volt${
                        entry.count === 1 ? 'a' : 'e'
                    } e scritta in tondo ${other.count} volt${other.count === 1 ? 'a' : 'e'}`
                ),
            })
        }
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `None of the ${italic.size} emphasised words of four letters or more also appears in ordinary prose.`,
                    `Nessuna delle ${italic.size} parole enfatizzate di quattro lettere o più compare anche nel testo normale.`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${italic.size} emphasised words also appear in ordinary prose: ${listing(bad)}`,
                `${bad.length} parole enfatizzate su ${italic.size} compaiono anche nel testo normale: ${listing(bad)}`
            ),
            bad
        )
    },
}

// overleaf-lab: the unbreakable space before a cross-reference. "Figure\n\ref{fig:a}"
// lets LaTeX break the line between the word and its number, so a page can end with
// "see Figure" and the next one begin with "3". A tie (~) forbids exactly that.
//
// The rule is ChkTeX's, reached through the CheckMyTex project (MIT), which is where
// the idea of running a LaTeX linter's checks over a whole thesis and reporting them
// with file:line came from. What is NOT taken from either is the verdict: this file
// reports the fact and the counts, and the rubric decides whether the document has to
// care.
const TIE_CANDIDATE = /\\(?!href|hyperref|nocite)([a-zA-Z]{0,32}(?:ref|cite[a-zA-Z]{0,32}))\*?\s*[[{]/g

CHECKS['tie-before-ref'] = {
    describe: 'a reference or citation is tied to the word before it with ~, not left on a breakable space',
    run(docs) {
        const breakable = []
        const glued = []
        let tied = 0
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            for (const m of doc.text.matchAll(TIE_CANDIDATE)) {
                const before = m.index === 0 ? '' : doc.text[m.index - 1]
                // A bare preposition or article before the reference is not the word
                // the tie rule protects: the rule keeps the NAME of the object with
                // its number ("Figura~3"), and a break after "in" or "descritto in"
                // is ordinary typesetting - \autoref even prints its own name.
                // "Come descritto in \autoref{sec:x}" was reported as breakable on a
                // document that is right. The stopword list is the one the reference
                // scans already trust, and the exemption removes the pair from the
                // count entirely: a tie after a preposition is not "well written",
                // it is simply not required.
                const leadWord = /([\p{L}]{1,20})[ \t\n~]{0,4}$/u.exec(
                    doc.text.slice(Math.max(0, m.index - 24), m.index)
                )
                if (leadWord && REFERENCE_STOPWORDS.has(leadWord[1].toLowerCase())) continue
                // A thin space is as unbreakable as a tie.
                if (before === '~' || (before === ',' && doc.text[m.index - 2] === '\\')) {
                    tied += 1
                    continue
                }
                // What is on the OTHER side of the space. A reference that opens a
                // sentence or a line has no word to be tied to, and the newline before
                // it is the source wrapping, not a break the reader will ever see: the
                // rule is about the word, so a full stop or a bracket there means the
                // reference is not counted at all.
                let back = m.index - 1
                while (back >= 0 && /[ \t\n]/.test(doc.text[back])) back -= 1
                const word = back >= 0 && /[\p{L}\p{N}]/u.test(doc.text[back])
                // The word the reference should have been tied to, and no more: the slice
                // starts mid-token often enough that the first partial one is dropped.
                const quoted = doc.text
                    .slice(Math.max(0, m.index - 20), m.index + m[0].length)
                    .replace(/\s+/g, ' ')
                    .replace(/^\S*\s+/, '')
                    .trim()
                if (word && /[ \t\n]/.test(before)) {
                    breakable.push({
                        path: doc.path,
                        line: at(m.index),
                        what: L(`"${quoted}" (ordinary space)`, `"${quoted}" (spazio normale)`),
                    })
                } else if (/[\p{L}\p{N}]/u.test(before)) {
                    glued.push({
                        path: doc.path,
                        line: at(m.index),
                        what: L(`"${quoted}" (no space at all)`, `"${quoted}" (nessuno spazio)`),
                    })
                }
                // Anything else - a bracket, a full stop, the start of a line - is not a
                // word the reference has to stay with, so it is not counted at all.
            }
        }
        const total = tied + breakable.length + glued.length
        if (total === 0)
            return result(
                'na',
                L(
                    'No reference or citation in the document follows a word.',
                    'Nessun richiamo o citazione del documento segue una parola.'
                )
            )
        const bad = breakable.concat(glued)
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `All ${total} references and citations that follow a word are tied to it with ~ or a thin space.`,
                    `Tutti i ${total} richiami e citazioni che seguono una parola sono legati a essa con ~ o uno spazio sottile.`
                )
            )
        return result(
            'missing',
            L(
                `${bad.length} of ${total} references and citations that follow a word can be split from it: ` +
                    `${breakable.length} after an ordinary space, ${glued.length} with no space at all. ${listing(bad)}`,
                `${bad.length} richiami e citazioni su ${total} che seguono una parola possono esserne separati: ` +
                    `${breakable.length} dopo uno spazio normale, ${glued.length} senza nessuno spazio. ${listing(bad)}`
            ),
            bad
        )
    },
}

// overleaf-lab: two things a keyboard produces and LaTeX does not typeset. A straight
// double quote stays a straight double quote in the PDF instead of becoming a pair of
// curly ones, and three full stops are set with the spacing of three sentence ends
// rather than of an ellipsis. Both rules are ChkTeX's, reached through CheckMyTex (MIT).
const STRAIGHT_QUOTE = /"/g
const LITERAL_ELLIPSIS = /(?<!\.)\.{3,}(?!\.)/g
const LATEX_QUOTE = /``|\\enquote\s*\{|\\glqq|\\og(?![a-zA-Z])/g
const LATEX_ELLIPSIS = /\\[lc]?dots(?![a-zA-Z])/g
const BARE_URL = /https?:\/\/\S+/g

// overleaf-lab: the two ways a `"` in the source is NOT a straight quotation mark. This
// check is authoritative - it hands the author a correction, not an opinion - so every
// one of these has to be known before it may speak.
//
// AN ACCENT COMMAND. `\"o` is how an umlaut is written on a keyboard that has none, and
// it is in every thesis that cites a German name: Schr\"odinger and M\"uller alone were
// read as three straight double quotes, that is three corrections that would break the
// names. The RUN of backslashes is counted rather than the single character in front,
// because `\\"` is a line break followed by a real quotation mark: an odd run makes the
// quote part of a command, an even one leaves it as text.
//
// A BABEL SHORTHAND. Under babel's german option `"` is active markup and `W"orter` is
// an umlaut, not two halves of a quotation. It is markup only where it is glued to
// letters on BOTH sides, and that two-sidedness is the trade-off: `"Wort"` in the same
// document is a real straight quotation and is still reported, at the price of missing
// the word-initial `"Osterreich`. A quotation mark with a space next to it is read as a
// quotation mark, because a finding the author dismisses in a second costs less than a
// correction that would break a word.
const GERMAN_SHORTHAND_OPTIONS = ['german', 'ngerman', 'austrian', 'naustrian', 'swissgerman']

// The same shape as LANGUAGE_PACKAGE further down, deliberately not shared: that one
// answers which language the document declares, this one whether one character became
// markup, and tightening either for the other would be a change nobody asked for.
const PACKAGE_LOAD = /\\usepackage\s*(?:\[([^\]]{0,200})\])?\s*\{([^}]{0,400})\}/g
const ONE_LETTER = /\p{L}/u

function optionTokens(text) {
    return String(text || '')
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(Boolean)
}

// Asked once for the whole project, because babel is loaded in the preamble and the
// shorthand is typed in a chapter file three directories away.
function loadsGermanShorthands(docs) {
    for (const doc of docs) {
        for (const m of String(doc.text || '').matchAll(PACKAGE_LOAD)) {
            const packages = optionTokens(m[2])
            // \usepackage{ngerman} is the older spelling and defines the same shorthands.
            if (packages.some(name => GERMAN_SHORTHAND_OPTIONS.includes(name))) return true
            if (packages.includes('babel') && optionTokens(m[1]).some(o => GERMAN_SHORTHAND_OPTIONS.includes(o)))
                return true
        }
    }
    return false
}

function isAccentCommand(text, index) {
    let run = 0
    while (index - run - 1 >= 0 && text[index - run - 1] === '\\') run += 1
    return run % 2 === 1
}

function isGermanShorthand(text, index) {
    return ONE_LETTER.test(text[index - 1] || '') && ONE_LETTER.test(text[index + 1] || '')
}

CHECKS['typographic-input'] = {
    describe: 'quotation marks and ellipses are written the way LaTeX typesets them',
    run(docs) {
        const bad = []
        let quotes = 0
        let goodQuotes = 0
        let ellipses = 0
        let goodEllipses = 0
        let prose = 0
        const files = sources(docs)
        const german = loadsGermanShorthands(files)
        for (const doc of files) {
            const at = lineLookup(doc.text)
            // A link is not prose: the quotes and the dots inside a URL are part of the
            // address. \url and \href are already blanked as identifiers by proseOnly;
            // a bare link typed into the text is not, and urls-in-text is the check that
            // has something to say about that one.
            const text = proseOnly(doc.text).replace(BARE_URL, blankSpan)
            prose += (text.match(/\p{L}/gu) || []).length
            goodQuotes += (text.match(LATEX_QUOTE) || []).length
            goodEllipses += (text.match(LATEX_ELLIPSIS) || []).length
            for (const m of text.matchAll(STRAIGHT_QUOTE)) {
                if (isAccentCommand(text, m.index)) continue
                if (german && isGermanShorthand(text, m.index)) continue
                quotes += 1
                bad.push({
                    path: doc.path,
                    line: at(m.index),
                    what: L(
                        `straight double quote in "${text.slice(m.index, m.index + 30).split('\n')[0].trim()}"`,
                        `virgolette dritte in "${text.slice(m.index, m.index + 30).split('\n')[0].trim()}"`
                    ),
                })
            }
            for (const m of text.matchAll(LITERAL_ELLIPSIS)) {
                ellipses += 1
                bad.push({
                    path: doc.path,
                    line: at(m.index),
                    what: L(
                        `"${m[0]}" typed as full stops instead of \\dots`,
                        `"${m[0]}" scritto come punti invece che con \\dots`
                    ),
                })
            }
        }
        if (prose === 0)
            return result(
                'na',
                L(
                    'The document carries no prose outside maths, listings and markup.',
                    'Il documento non contiene prosa fuori da formule, listati e comandi.'
                )
            )
        if (bad.length === 0)
            return result(
                'ok',
                L(
                    `No straight double quote and no ellipsis typed as full stops in the prose ` +
                        `(${goodQuotes} LaTeX quotations and ${goodEllipses} \\dots are written the right way).`,
                    `Nessuna virgoletta dritta e nessun'ellissi scritta come punti nella prosa ` +
                        `(${goodQuotes} citazioni LaTeX e ${goodEllipses} \\dots sono scritte nel modo giusto).`
                )
            )
        return result(
            'missing',
            L(
                `${quotes} straight double quotes and ${ellipses} ellipses typed as full stops, against ` +
                    `${goodQuotes} LaTeX quotations and ${goodEllipses} \\dots written the right way: ${listing(bad)}`,
                `${quotes} virgolette dritte e ${ellipses} ellissi scritte come punti, contro ` +
                    `${goodQuotes} citazioni LaTeX e ${goodEllipses} \\dots scritte nel modo giusto: ${listing(bad)}`
            ),
            bad
        )
    },
}

// overleaf-lab: the document is set up for the language it is written in. Without a
// babel or polyglossia declaration LaTeX hyphenates with English patterns, so an
// Italian thesis breaks its words in the wrong places on every page, and the fixed
// names it prints ("Chapter", "Contents", "Bibliography") stay in English.
//
// TWO-VALUED AND QUIET ON PURPOSE. The check only speaks when the rubric has declared a
// language (LANG_DECLARED, set by the controller at the start of a run) and the document
// carries accented prose, which is the evidence that the text is not plain ASCII English.
// Anything else is `na`: a check that guesses the language of a document from its words
// would be a language detector, and this file only answers what a parser can decide.
const LANGUAGE_NAMES = {
    en: ['english', 'british', 'american', 'ukenglish', 'usenglish'],
    it: ['italian', 'italiano'],
}
const LANGUAGE_PACKAGE = /\\usepackage\s*(?:\[([^\]]{0,200})\])?\s*\{([^}]{0,400})\}/g
const LANGUAGE_SETTER =
    /\\(?:setmainlanguage|setdefaultlanguage|setotherlanguage|selectlanguage|babelprovide)\s*(?:\[[^\]]{0,200}\])?\s*\{([^}]{0,400})\}/g
const CLASS_OPTIONS = /\\documentclass\s*(?:\[([^\]]{0,200})\])?\s*\{[^}]{0,400}\}/g

// A letter that is not an ASCII letter: an accent, a cedilla, an umlaut. Written as a
// unicode class rather than as a range of escapes, so the source stays readable.
const NON_ASCII_LETTER = /(?=\p{L})[^A-Za-z]/u

// The same accent typed the LaTeX way, which is how a document written on a keyboard
// without accents spells them: \`a, \'e, \"o.
const LATEX_ACCENT = /\\[`'^"~=.]\s*\{?[a-zA-Z]/

CHECKS['language-support'] = {
    describe: 'the preamble declares the language the document is written in (babel or polyglossia)',
    run(docs) {
        if (!LANG_DECLARED)
            return result(
                'na',
                L(
                    'No rubric language is set for this run, so there is no language to look for in the preamble.',
                    'Per questa esecuzione non è impostata nessuna lingua della griglia, quindi non c\'è nessuna lingua da cercare nel preambolo.'
                )
            )
        const wanted = LANGUAGE_NAMES[LANG] || LANGUAGE_NAMES.en
        const spoken = L('English', 'italiano')
        let accented = null
        let mechanism = null
        let declared = null
        const options = []
        const classOptions = []
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            const prose = proseOnly(doc.text)
            if (!accented) {
                const m = NON_ASCII_LETTER.exec(prose) || LATEX_ACCENT.exec(prose)
                if (m) accented = { path: doc.path, line: at(m.index), what: prose.slice(m.index, m.index + 20).split('\n')[0].trim() }
            }
            for (const m of doc.text.matchAll(LANGUAGE_PACKAGE)) {
                if (!/\b(?:babel|polyglossia)\b/.test(m[2])) continue
                mechanism = mechanism || { path: doc.path, line: at(m.index), what: m[2].trim() }
                options.push({ text: m[1] || '', path: doc.path, line: at(m.index) })
            }
            for (const m of doc.text.matchAll(LANGUAGE_SETTER)) {
                mechanism = mechanism || { path: doc.path, line: at(m.index), what: m[0].slice(0, 40) }
                options.push({ text: m[1] || '', path: doc.path, line: at(m.index) })
            }
            for (const m of doc.text.matchAll(CLASS_OPTIONS)) {
                classOptions.push({ text: m[1] || '', path: doc.path, line: at(m.index) })
            }
        }
        // babel reads the CLASS options too: `\documentclass[italian]{book}` with a bare
        // \usepackage{babel} is a complete declaration, and refusing to see it would
        // report a defect on a template that is correct.
        for (const option of options.concat(mechanism ? classOptions : [])) {
            const tokens = option.text.toLowerCase().split(/[^a-z]+/)
            if (tokens.some(token => wanted.includes(token))) {
                declared = option
                break
            }
        }
        if (!accented)
            return result(
                'na',
                L(
                    'The document carries no accented prose, so nothing here shows which language it is set in.',
                    'Il documento non contiene prosa accentata, quindi non c\'è nulla che mostri per quale lingua sia impostato.'
                )
            )
        if (declared)
            return result(
                'ok',
                L(
                    `The preamble declares ${spoken} for babel or polyglossia, at ${declared.path}:${declared.line}.`,
                    `Il preambolo dichiara l'${spoken} per babel o polyglossia, in ${declared.path}:${declared.line}.`
                ),
                [declared].map(d => ({ path: d.path, line: d.line, what: d.text.slice(0, 40) }))
            )
        return result(
            'missing',
            mechanism
                ? L(
                      `No ${spoken} hyphenation is declared: ${mechanism.path}:${mechanism.line} loads a language ` +
                          `mechanism (${mechanism.what}) but no option names ${spoken}. The document carries accented ` +
                          `prose (${accented.path}:${accented.line}).`,
                      `Non è dichiarato l'${spoken} per la sillabazione: ${mechanism.path}:${mechanism.line} carica un ` +
                          `meccanismo di lingua (${mechanism.what}) ma nessuna opzione nomina l'${spoken}. Il documento ` +
                          `contiene prosa accentata (${accented.path}:${accented.line}).`
                  )
                : L(
                      `No ${spoken} hyphenation or babel declaration was found in the preamble, and the document ` +
                          `carries accented prose (${accented.path}:${accented.line}).`,
                      `Nel preambolo non è stata trovata nessuna dichiarazione di babel o polyglossia per l'${spoken}, ` +
                          `e il documento contiene prosa accentata (${accented.path}:${accented.line}).`
                  ),
            [accented]
        )
    },
}

// ===========================================================================
// citation setup: which citation STYLE the preamble declares
// ===========================================================================
// overleaf-lab: "the in-text citation style is consistent / is author-year / is
// numeric" was a whole-document model pass, and on four of nine real projects it
// came back "not checked: does not fit the context window". The style is not in the
// text at all: it is three declarations in the preamble (natbib options, a biblatex
// style, \bibliographystyle) plus a census of the \cite family, and a parser reads
// those in a millisecond on a project of any size. Three check NAMES share one
// reader because the question ("what does the preamble set?") is one; which answer
// satisfies the rubric is the rubric's choice of name, exactly like every other
// [check:] opt-in - the catalogue stays policy-free.
//
// What is deliberately NOT judged here: hand-typed citations in prose. Measured over
// the whole corpus, the "(Author, year)" shape appears zero times and every typed
// "[12]" candidate was an interval or a macro arity marker, so a rule would only
// manufacture accusations; the model keeps that half of the requirement.
const NATBIB_PACKAGE = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{natbib\}/g
const BIBLATEX_PACKAGE = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{biblatex\}/g
const BIBLIOGRAPHY_STYLE = /\\bibliographystyle\s*\{\s*([^}]{1,80}?)\s*\}/g

// The classic .bst names, by the style they print. The *nat styles (plainnat,
// abbrvnat, unsrtnat) follow the natbib OPTIONS and decide nothing by themselves;
// a trailing "url" is a common suffix of a patched style ("unsrturl") and is
// stripped before the name is looked up.
const NUMERIC_BIB_STYLES = /^(?:plain|unsrt|abbrv|alpha|ieeetr|ieee|acm|siam)$/i
const AUTHORYEAR_BIB_STYLES = /^(?:apalike|apacite|chicago|harvard|agsm|kluwer|agu|newapa|named|authordate\d?)$/i

// One \cite-family census, shared by the three names. \citep/\citet and their
// variants exist only under natbib and always print author-year; a plain \cite
// prints whatever the setup says, so it joins the total and decides nothing.
const AUTHORYEAR_CITE = /\\cite(?:p|t|alp|alt|author|year|yearpar)\*?\s*(?:\[[^\]]{0,200}\])*\s*\{/g
const ANY_CITE = /\\[a-zA-Z]{0,32}cite[a-zA-Z]{0,32}\*?\s*(?:\[[^\]]{0,200}\])*\s*\{/g

function citationSetup(docs) {
    const declarations = []
    let authorYearCites = 0
    let totalCites = 0
    for (const doc of sources(docs)) {
        const at = lineLookup(doc.text)
        // Comments are dead code here as everywhere: a template that ships an
        // alternative setup commented out (`%\usepackage[style=authoryear]{biblatex}`
        // under a live natbib line - a real course template does exactly this) must
        // not read as a contradiction. Offsets are preserved so :line stays true.
        const text = doc.text.replace(/(?<!\\)%[^\n]*/g, blankSpan)
        for (const m of text.matchAll(NATBIB_PACKAGE)) {
            declarations.push({ kind: 'natbib', options: m[1] || '', path: doc.path, line: at(m.index), shown: m[0].slice(0, 60) })
        }
        for (const m of text.matchAll(BIBLATEX_PACKAGE)) {
            declarations.push({ kind: 'biblatex', options: m[1] || '', path: doc.path, line: at(m.index), shown: m[0].slice(0, 60) })
        }
        for (const m of text.matchAll(BIBLIOGRAPHY_STYLE)) {
            declarations.push({ kind: 'bibstyle', options: m[1], path: doc.path, line: at(m.index), shown: m[0].slice(0, 60) })
        }
        authorYearCites += (text.match(AUTHORYEAR_CITE) || []).length
        totalCites += (text.match(ANY_CITE) || []).length
    }
    // Every signal is classified on its own, so a contradiction between two of them
    // is visible instead of being resolved silently by precedence.
    //
    // natbib WITHOUT a mode option decides nothing by itself: the package defaults
    // to author-year but silently reverts to numerical when the bibliography
    // carries no author-year labels, which is exactly what a template that pairs
    // bare natbib with a numeric .bst relies on (a real internship template ships
    // `[sort&compress]{natbib}` over `\bibliographystyle{plain}` and renders
    // numbers). Only an explicit numbers/super or authoryear option speaks.
    const natbibNumeric = declarations.some(
        d => d.kind === 'natbib' && /\b(?:numbers|super)\b/i.test(d.options)
    )
    const natbibPresent = declarations.some(d => d.kind === 'natbib')
    const classified = []
    for (const d of declarations) {
        let styleClass = null
        if (d.kind === 'natbib') {
            if (/\b(?:numbers|super)\b/i.test(d.options)) styleClass = 'numeric'
            else if (/\bauthoryear\b/i.test(d.options)) styleClass = 'authoryear'
        } else if (d.kind === 'biblatex') {
            const m = /style\s*=\s*([a-z-]+)/i.exec(d.options)
            if (m && /^(?:authoryear|apa|chicago-authordate)/i.test(m[1])) styleClass = 'authoryear'
            else styleClass = 'numeric' // biblatex defaults to the numeric style
        } else {
            const name = d.options.replace(/url$/i, '')
            if (/nat$/i.test(name)) {
                // plainnat/abbrvnat/unsrtnat print whatever the natbib options say;
                // paired with modeless natbib they print the pair's default,
                // author-year. Without natbib they decide nothing (and would not
                // compile anyway).
                styleClass = natbibNumeric ? 'numeric' : natbibPresent ? 'authoryear' : null
            } else if (NUMERIC_BIB_STYLES.test(name)) styleClass = 'numeric'
            else if (AUTHORYEAR_BIB_STYLES.test(name)) styleClass = 'authoryear'
        }
        classified.push({ ...d, styleClass })
    }
    const decisive = classified.filter(d => d.styleClass !== null)
    // The package options outrank the .bst name when both speak: natbib rewrites the
    // citation commands whatever style file formats the list, so `[numbers]` next to
    // an author-year .bst RENDERS numeric. Both still count as signals for the
    // consistency question.
    const lead =
        decisive.find(d => d.kind === 'natbib') ||
        decisive.find(d => d.kind === 'biblatex') ||
        decisive[0] ||
        null
    const styles = new Set(decisive.map(d => d.styleClass))
    return { declarations: classified, decisive, lead, styles, authorYearCites, totalCites }
}

function describeDeclarations(list) {
    return list
        .map(d => `${d.path}:${d.line} ${d.shown}`)
        .slice(0, MAX_EXAMPLES)
        .join(' | ')
}

function citationSetupVerdict(docs, wanted) {
    const setup = citationSetup(docs)
    if (setup.totalCites === 0)
        return result(
            'na',
            L(
                'The document cites nothing, so there is no citation style to judge.',
                'Il documento non cita nulla, quindi non c\'è nessuno stile di citazione da giudicare.'
            )
        )
    const conflict =
        setup.styles.size > 1
            ? result(
                  'missing',
                  L(
                      `The preamble declares contradictory citation setups (author-year and numeric at once): ` +
                          `${describeDeclarations(setup.decisive)}. One of them decides what the reader sees; ` +
                          `keep one and delete the others.`,
                      `Il preambolo dichiara configurazioni di citazione contraddittorie (autore-anno e numerica insieme): ` +
                          `${describeDeclarations(setup.decisive)}. Solo una decide ciò che il lettore vede; ` +
                          `tenerne una ed eliminare le altre.`
                  ),
                  setup.decisive.map(d => ({ path: d.path, line: d.line, what: d.shown }))
              )
            : null
    if (conflict) return conflict
    if (!setup.lead)
        return result(
            'na',
            L(
                'No recognisable citation setup was found: no natbib options, no biblatex style, no known ' +
                    '\\bibliographystyle name. The style cannot be decided from the preamble.',
                'Non è stata trovata nessuna configurazione di citazione riconoscibile: niente opzioni natbib, ' +
                    'niente stile biblatex, nessun nome noto in \\bibliographystyle. Lo stile non è decidibile dal preambolo.'
            )
        )
    const is = setup.lead.styleClass
    const setupLine = describeDeclarations(setup.decisive)
    const okAnswer = result(
        'ok',
        L(
            `The preamble sets one ${is === 'numeric' ? 'numeric' : 'author-year'} citation style ` +
                `(${setupLine}) and the text cites ${setup.totalCites} times through the \\cite family.`,
            `Il preambolo imposta un solo stile di citazione ${is === 'numeric' ? 'numerico' : 'autore-anno'} ` +
                `(${setupLine}) e il testo cita ${setup.totalCites} volte tramite la famiglia \\cite.`
        ),
        [{ path: setup.lead.path, line: setup.lead.line, what: setup.lead.shown }]
    )
    if (wanted === 'consistent') return okAnswer
    if (is === wanted) return okAnswer
    return result(
        'missing',
        L(
            `The preamble sets a ${is === 'numeric' ? 'numeric' : 'an author-year'} citation style ` +
                `(${setupLine}), so the ${setup.totalCites} \\cite commands will render ` +
                `${is === 'numeric' ? 'as numbers' : 'as author-year'}, not ` +
                `${wanted === 'numeric' ? 'as numbers' : 'as author-year'} as this document type requires.`,
            `Il preambolo imposta uno stile di citazione ${is === 'numeric' ? 'numerico' : 'autore-anno'} ` +
                `(${setupLine}), quindi i ${setup.totalCites} comandi \\cite verranno resi ` +
                `${is === 'numeric' ? 'come numeri' : 'come autore-anno'}, non ` +
                `${wanted === 'numeric' ? 'come numeri' : 'come autore-anno'} come richiede questo tipo di documento.`
        ),
        setup.decisive.map(d => ({ path: d.path, line: d.line, what: d.shown }))
    )
}

CHECKS['citation-setup-authoryear'] = {
    describe: 'the preamble sets an author-year citation style (natbib options, biblatex style, .bst name)',
    run(docs) {
        return citationSetupVerdict(docs, 'authoryear')
    },
}

CHECKS['citation-setup-numeric'] = {
    describe: 'the preamble sets a numeric citation style (natbib options, biblatex style, .bst name)',
    run(docs) {
        return citationSetupVerdict(docs, 'numeric')
    },
}

CHECKS['citation-setup-consistent'] = {
    describe: 'the preamble declares one citation setup, not a contradiction of styles',
    run(docs) {
        return citationSetupVerdict(docs, 'consistent')
    },
}

// ===========================================================================
// long sentences
// ===========================================================================
// overleaf-lab: "sentences over ~40 words are split" is a word count, not a
// judgement, and the per-chapter model answers for it were the least stable in the
// stored runs: found on one pass, gone on the identical next one, quotes mangled by
// transcription. Counting is what a parser is for. The guards below are each paid
// for by a measured false positive of the naive rule on the real corpus:
//   - tabular material produced 140-word "sentences" out of table rows, so the
//     table-like environments are blanked and any span still carrying cell or rule
//     markup is refused;
//   - lists are excluded by the requirement itself, so the list environments are
//     blanked whole;
//   - a paragraph with no sentence mark at all (float debris, a lone heading tail)
//     is not a sentence: only spans that END with sentence punctuation count;
//   - inline maths would inflate the count with symbol tokens, so it is blanked and
//     a span must remain mostly letters to qualify.
// The threshold is the rubric's own number. The rubric says "indicatively", which
// is why the listing is worst-first: the reader meets the 70-word monster before
// the 41-word borderline case, and the count is stated so the tolerance stays with
// the policy, not with the scan.
const SENTENCE_WORD_LIMIT = 40
const SENTENCE_BLANKED_ENVIRONMENTS = [
    'tabular', 'tabularx', 'tabulary', 'tabu', 'longtable', 'array',
    'itemize', 'enumerate', 'description',
    'tikzpicture', 'circuitikz', 'pgfpicture',
    'algorithm', 'algorithmic', 'algorithmx',
    'matrix', 'pmatrix', 'bmatrix', 'cases',
    'thebibliography',
]
// A line that starts markup, not prose: it flushes the paragraph. \item flushes so
// the run-in text of a list written OUTSIDE a blanked environment (a custom list)
// still starts a fresh span rather than gluing onto the previous sentence.
const SENTENCE_STRUCTURAL_LINE =
    /^\s*\\(?:item(?![a-zA-Z])|part\b|chapter\b|(?:sub){0,2}section\b|(?:sub)?paragraph\b|begin\b|end\b|caption\b|centering\b|includegraphics\b|label\b|(?:new|clear)page\b|[hv]space\b|noindent\s*$|documentclass\b|usepackage\b|maketitle\b|tableofcontents\b|addcontentsline\b|hypertarget\b|pagebreak\b|input\b|include\b|bibliograph|printbibliography\b|appendix\b|frontmatter\b|mainmatter\b|backmatter\b)/
const SENTENCE_SPLIT = /(?<=[.!?;:])\s+(?=[\p{Lu}])/u
const SENTENCE_WORD = /[\p{L}][\p{L}'’-]*/gu
const SENTENCE_TERMINATOR = /[.!?]['")\]]*\s*$/
const SENTENCE_TABLE_DEBRIS = /[&]|\\\\|\\(?:hline|multirow|multicolumn|toprule|midrule|bottomrule)\b/

CHECKS['long-sentences'] = {
    describe: `no prose sentence runs past ${SENTENCE_WORD_LIMIT} words (lists, tables and formulas excluded)`,
    run(docs) {
        const over = []
        let sentencesRead = 0
        for (const doc of sources(docs)) {
            const at = lineLookup(doc.text)
            // proseOnly blanks maths, comments and identifier arguments; the \( \)
            // inline form and the list/table environments are blanked on top, all
            // offset-preserving so the line numbers keep pointing at the source.
            // Environments FIRST: proseOnly blanks `\begin{...}` markers along with
            // the other non-prose arguments, so blanking after it can no longer
            // find the environments at all - measured as 150-word "sentences" read
            // out of a thebibliography whose \begin had already been erased.
            let prose = blankEnvironments(doc.text, SENTENCE_BLANKED_ENVIRONMENTS)
            prose = proseOnly(prose)
            prose = blankRanges(prose, pairedMathsSpans(prose, '(', ')'))
            const lines = prose.split('\n')
            let buffer = ''
            let bufferStart = 0
            let offset = 0
            const flush = () => {
                if (!/\S/.test(buffer)) {
                    buffer = ''
                    return
                }
                let position = bufferStart
                for (const span of buffer.split(SENTENCE_SPLIT)) {
                    const words = span.match(SENTENCE_WORD) || []
                    const tokens = span.match(/\S+/g) || []
                    if (words.length >= 5) sentencesRead += 1
                    if (
                        words.length > SENTENCE_WORD_LIMIT &&
                        SENTENCE_TERMINATOR.test(span) &&
                        !SENTENCE_TABLE_DEBRIS.test(span) &&
                        words.length / tokens.length > 0.6
                    ) {
                        over.push({
                            path: doc.path,
                            line: at(position + (span.length - span.trimStart().length)),
                            words: words.length,
                            what: '',
                            head: span.replace(/\s+/g, ' ').trim().slice(0, 70),
                        })
                    }
                    position += span.length + 1
                }
                buffer = ''
            }
            for (const line of lines) {
                if (!/\S/.test(line) || SENTENCE_STRUCTURAL_LINE.test(line)) {
                    flush()
                    bufferStart = offset + line.length + 1
                } else {
                    if (!buffer) bufferStart = offset
                    buffer += line + ' '
                }
                offset += line.length + 1
            }
            flush()
        }
        if (sentencesRead === 0)
            return result(
                'na',
                L(
                    'The document carries no running prose to measure.',
                    'Il documento non contiene prosa continua da misurare.'
                )
            )
        if (over.length === 0)
            return result(
                'ok',
                L(
                    `No prose sentence exceeds ${SENTENCE_WORD_LIMIT} words (${sentencesRead} sentences read; ` +
                        'lists, tables and formulas excluded).',
                    `Nessun periodo supera le ${SENTENCE_WORD_LIMIT} parole (${sentencesRead} periodi letti; ` +
                        'elenchi, tabelle e formule esclusi).'
                )
            )
        // Worst first: the rubric's threshold is indicative, so the reader must meet
        // the clearest cases before the borderline ones.
        over.sort((a, b) => b.words - a.words)
        const shown = over.map(o => ({
            path: o.path,
            line: o.line,
            what: L(`${o.words} words: "${o.head}..."`, `${o.words} parole: "${o.head}..."`),
        }))
        return result(
            'missing',
            L(
                `${over.length} of ${sentencesRead} prose sentences run past ${SENTENCE_WORD_LIMIT} words ` +
                    `(longest first): ${listing(shown)}`,
                `${over.length} periodi su ${sentencesRead} superano le ${SENTENCE_WORD_LIMIT} parole ` +
                    `(dal più lungo): ${listing(shown)}`
            ),
            shown
        )
    },
}

// ===========================================================================
// acronyms missing from the list
// ===========================================================================
// overleaf-lab: the mirror of acronyms-declared-unused, and the requirement the
// model measurably answered wrong on two real theses: "no acronym used in the text
// is missing from the acronym list" came back "ok" on a document using FSM
// forty-two times with a fifty-eight-entry list that never declares it. The
// undeclared-acronym scan already exists (acronym-first-use uses it); this check
// asks it the list-membership question. All its conservatism is inherited on
// purpose: three prose uses minimum, no digits, two-to-four letters, caps-line and
// declaration blanking, and a token whose first use carries a parenthetical
// expansion stays out - an author who wrote "Boundary Value Analysis (BVA)" did
// right by the reader, and whether the LIST must also carry it is the judgement
// half that stays with the requirement's own text.
//
// "ID" is the one corpus-measured token that is caps-written prose rather than a
// short form ("the Mission Profile ID"); function words in caps (AND, OR, NOT in
// \texttt truth tables) are already refused by CAPITALISED_PROSE_WORDS.
const LIST_MEMBERSHIP_STOPWORDS = new Set(['ID'])

CHECKS['acronyms-missing-from-list'] = {
    describe: 'no short form used repeatedly in the text is missing from the acronym list',
    run(docs) {
        const declared = collectDeclaredAcronyms(docs)
        if (declared.size === 0)
            return result(
                'na',
                L(
                    'The document declares no acronym list, so there is no list to be missing from. ' +
                        'Whether a list is required at all is a structure question, not this check.',
                    'Il documento non dichiara nessun elenco di acronimi, quindi non c\'è un elenco da cui mancare. ' +
                        'Se un elenco sia obbligatorio è una questione di struttura, non di questo controllo.'
                )
            )
        // The reference list is not running prose: an ISSN inside a \bibitem is
        // bibliographic data, and telling the author to add it to the acronym list
        // is noise (measured on a real thesis whose thebibliography lives in
        // main.tex). Blanked BEFORE the shared scan, because that scan's own
        // non-prose blanking erases the \begin marker the environment blanker
        // needs; and blanked here rather than inside the shared scan, so the other
        // acronym checks keep their own view of the document.
        const scannable = acronymScannable(
            docs.map(doc => ({ ...doc, text: blankEnvironments(String(doc.text || ''), ['thebibliography']) }))
        )
        const missing = findUndeclaredAcronyms(scannable, declared).filter(
            f => !LIST_MEMBERSHIP_STOPWORDS.has(f.token)
        )
        if (missing.length === 0)
            return result(
                'ok',
                L(
                    `The acronym list (${declared.size} entries) covers the text: no undeclared all-caps ` +
                        `short form reaches ${MIN_UNDECLARED_USES} prose uses.`,
                    `L'elenco degli acronimi (${declared.size} voci) copre il testo: nessuna sigla non dichiarata ` +
                        `raggiunge ${MIN_UNDECLARED_USES} usi nella prosa.`
                )
            )
        const shown = missing.map(f => ({
            path: f.path,
            line: f.line,
            what: L(`${f.token} (${f.count} uses, not in the list)`, `${f.token} (${f.count} usi, non in elenco)`),
        }))
        return result(
            'missing',
            L(
                `${missing.length} short form${missing.length === 1 ? ' is' : 's are'} used in the text but ` +
                    `missing from the acronym list (${declared.size} entries): ${listing(shown)}`,
                `${missing.length} sigl${missing.length === 1 ? 'a è usata' : 'e sono usate'} nel testo ma ` +
                    `manca${missing.length === 1 ? '' : 'no'} dall'elenco degli acronimi (${declared.size} voci): ${listing(shown)}`
            ),
            shown
        )
    },
}

// ===========================================================================
// unique labels
// ===========================================================================
// overleaf-lab: LaTeX does not fail on a duplicate \label - it warns in a log
// nobody reads and silently binds every \ref to ONE of the definitions, so a real
// thesis carried `\label{eq: transfer}` four times and its references pointed at
// whichever equation won. The one measured false-positive shape is the ORPHAN
// file: a deprecated chapter kept in the project but never \input pulls its labels
// into the scan although LaTeX never sees them, so duplicates are counted only
// over the files reachable from the root document. Without a recognisable root the
// scan falls open to every file: a duplicate is then still real inside any one
// file, and a cross-file one is worth reading even if it might span an orphan.
const INPUT_COMMAND = /\\(?:input|include|subfile)\s*\{([^}]{1,200})\}/g

function reachableSources(docs) {
    const all = sources(docs)
    // \begin{document} before \documentclass: the course templates put the class
    // in a setup file that main.tex inputs, so the class marker names a file that
    // inputs nothing and the walk would end there with the whole thesis unread.
    // The document body always lives in the root file.
    const root =
        all.find(d => /\\begin\s*\{document\}/.test(d.text)) ||
        all.find(d => /\\documentclass(?![a-zA-Z])/.test(d.text))
    if (!root) return { docs: all, rooted: false }
    // Leading ./ and ../ are stripped rather than resolved: the docs carry project
    // paths, not a filesystem, so `\input{../shared/intro}` is matched by its tail.
    // Without this the climbed-to file dropped out of the reachable set and a real
    // duplicate label across it was invisible.
    const normalise = p =>
        p
            .replace(/\\/g, '/')
            .replace(/^(?:\.\.?\/){0,8}/, '')
            .replace(/\.tex$/i, '')
            .toLowerCase()
    const resolve = arg => {
        const clean = normalise(arg.trim())
        if (!clean) return null
        return (
            all.find(d => normalise(d.path) === clean) ||
            all.find(d => normalise(d.path).endsWith(`/${clean}`)) ||
            null
        )
    }
    const reached = new Set([root])
    const queue = [root]
    while (queue.length > 0) {
        const doc = queue.shift()
        for (const m of doc.text.matchAll(INPUT_COMMAND)) {
            const target = resolve(m[1])
            if (target && !reached.has(target)) {
                reached.add(target)
                queue.push(target)
            }
        }
    }
    // Include order, root first: the traversal above is breadth-first for cycle
    // safety, but readers of the result (the headings fact) want document order,
    // which a depth-first walk in match order gives.
    const ordered = []
    const seen = new Set()
    const walk = doc => {
        if (seen.has(doc)) return
        seen.add(doc)
        ordered.push(doc)
        for (const m of doc.text.matchAll(INPUT_COMMAND)) {
            const target = resolve(m[1])
            if (target && reached.has(target)) walk(target)
        }
    }
    walk(root)
    return { docs: ordered, rooted: true }
}

const LABEL_DEFINITION = /\\label\s*\{\s*([^{}]{1,200}?)\s*\}/g

CHECKS['unique-labels'] = {
    describe: 'no \\label name is defined twice (a duplicate silently rebinds every \\ref)',
    run(docs) {
        const { docs: reachable, rooted } = reachableSources(docs)
        const definitions = new Map()
        let total = 0
        for (const doc of reachable) {
            const at = lineLookup(doc.text)
            const macros = macroDefinitionRegions(doc.text)
            for (const m of doc.text.matchAll(LABEL_DEFINITION)) {
                if (insideSpans(macros, m.index)) continue
                total += 1
                const name = m[1]
                if (!definitions.has(name)) definitions.set(name, [])
                definitions.get(name).push({ path: doc.path, line: at(m.index) })
            }
        }
        if (total === 0)
            return result(
                'na',
                L('The document defines no labels.', 'Il documento non definisce nessuna label.')
            )
        const duplicated = [...definitions.entries()].filter(([, sites]) => sites.length > 1)
        const scope = rooted
            ? L(
                  `${reachable.length} files reachable from the main file`,
                  `${reachable.length} file raggiungibili dal file principale`
              )
            : L('all files; no main file was recognised', 'tutti i file; nessun file principale riconosciuto')
        if (duplicated.length === 0)
            return result(
                'ok',
                L(
                    `All ${definitions.size} label names are defined once (${scope}).`,
                    `Tutti i ${definitions.size} nomi di label sono definiti una sola volta (${scope}).`
                )
            )
        // How often the duplicate is actually referenced decides how loud the harm
        // is, so the count rides along with each finding.
        let references = null
        const referenceCount = name => {
            if (!references) {
                references = new Map()
                for (const doc of reachable) {
                    for (const use of collectReferenceUses(doc.text)) {
                        references.set(use.name, (references.get(use.name) || 0) + 1)
                    }
                }
            }
            return references.get(name) || 0
        }
        const shown = duplicated.map(([name, sites]) => {
            const refs = referenceCount(name)
            return {
                path: sites[0].path,
                line: sites[0].line,
                what: L(
                    `\\label{${name}} defined ${sites.length} times (${sites
                        .map(s => `${s.path}:${s.line}`)
                        .join(', ')})${refs > 0 ? `; referenced ${refs} times, each \\ref binds to only one of them` : ''}`,
                    `\\label{${name}} definita ${sites.length} volte (${sites
                        .map(s => `${s.path}:${s.line}`)
                        .join(', ')})${refs > 0 ? `; richiamata ${refs} volte, ogni \\ref si aggancia a una sola` : ''}`
                ),
            }
        })
        return result(
            'missing',
            L(
                `${duplicated.length} label name${duplicated.length === 1 ? ' is' : 's are'} defined more than ` +
                    `once (${scope}): ${listing(shown)}`,
                `${duplicated.length} nom${duplicated.length === 1 ? 'e di label è definito' : 'i di label sono definiti'} ` +
                    `più di una volta (${scope}): ${listing(shown)}`
            ),
            shown
        )
    },
}

// ===========================================================================
// opening headings, as a FACT for the scan hints
// ===========================================================================
// overleaf-lab: the internship rubrics open with three compulsory parts in a fixed
// order. Their PRESENCE is sometimes readable from the headings ("1. Descrizione
// Struttura Ospitante" matches by title), but their ABSENCE never is: a heading
// that names the company fulfils the "hosting institution" part without containing
// any keyword, so a title scan can recognise satisfaction and can never prove a
// violation. That asymmetry is why this is a FACT LINE for the model's scan hints
// and not a check: the verdict stays with the reader of the skeleton, and the fact
// - built by code from the sources - survives every grounding filter that a
// model-transcribed quote does not. English on purpose: the scan-hints block it
// joins is the machine-facing prompt surface, which is English throughout.
const OPENING_PART_PATTERNS = [
    ['hosting institution', /struttura\s+ospitante|azienda\s+ospitante|hosting\s+(?:institution|organi[sz]ation|company)|host\s+(?:institution|organi[sz]ation)/i],
    ['motivation/context', /motivazion|contesto|motivation|context/i],
    ['aims/activities', /finalit|obiettiv|attivit|objectives?|aims?\b|goals?\b|activities/i],
]
const OPENING_HEADINGS_CAP = 12

export function openingHeadingsFact(docs) {
    const { docs: reachable } = reachableSources(docs)
    const headings = []
    for (const doc of reachable) {
        if (headings.length >= OPENING_HEADINGS_CAP) break
        const at = lineLookup(doc.text)
        for (const h of collectHeadings(doc.text)) {
            if (h.level > SECTION_LEVELS.section) continue
            headings.push({ title: h.title, path: doc.path, line: at(h.index) })
            if (headings.length >= OPENING_HEADINGS_CAP) break
        }
    }
    if (headings.length === 0) return null
    const matches = []
    for (const [partName, pattern] of OPENING_PART_PATTERNS) {
        const index = headings.findIndex(h => pattern.test(h.title))
        if (index !== -1) matches.push(`${partName} -> #${index + 1}`)
    }
    const listed = headings
        .map((h, i) => `${i + 1} "${h.title}" (${h.path}:${h.line})`)
        .join(' | ')
    const tail =
        matches.length > 0
            ? `keyword matches: ${matches.join(', ')}`
            : 'no heading title matches the opening-part keywords (a title can still fulfil a part by its content)'
    return `- Opening headings (include order, first ${headings.length}): ${listed}. ${tail}.`
}

// A misspelled check name must be loud. Answering "ok" would report a requirement as
// met that nothing ever looked at, which is the worst outcome available here.
export function runCheck(name, docs) {
    const check = CHECKS[name]
    if (!check) {
        return result(
            'na',
            L(
                `Unknown structural check "${name}". Available: ${Object.keys(CHECKS).join(', ')}.`,
                `Controllo strutturale sconosciuto "${name}". Disponibili: ${Object.keys(CHECKS).join(', ')}.`
            )
        )
    }
    try {
        // Verbatim first: a listing that SHOWS `\begin{comment}` as an example is code,
        // and its body is already spaces by the time the comment scan runs.
        const sanitised = (docs || []).map(doc => ({
            path: doc.path,
            text: blankInlineVerb(blankFalseConditionals(blankCommentEnvironments(blankVerbatimBodies(String(doc.text || ''))))),
        }))
        // Nothing to read is "na" for EVERY check, uniformly. Left to the individual
        // checks, the absence-shaped ones ("no bare link appears", "no TODO is left")
        // answered "ok" on an empty project, which is vacuously true and reads as a
        // requirement that was met. A queue retry on a project whose files failed to
        // load is exactly how that reaches a report.
        if (!sanitised.some(doc => doc.text.trim().length > 0)) {
            return result(
                'na',
                L(
                    'The project contains no source text to inspect.',
                    'Il progetto non contiene testo sorgente da ispezionare.'
                )
            )
        }
        return check.run(sanitised)
    } catch (err) {
        return result(
            'na',
            L(
                `The structural check "${name}" failed: ${err.message}`,
                `Il controllo strutturale "${name}" non è riuscito: ${err.message}`
            )
        )
    }
}

export function listChecks() {
    return Object.entries(CHECKS).map(([name, c]) => ({ name, describe: c.describe }))
}

export default {
    CHECKS,
    runCheck,
    listChecks,
    setChecksLanguage,
    L,
    openingHeadingsFact,
    ACRONYM_DECLARATION,
    blankHandAcronymLists,
}
