// overleaf-lab: "no evident spelling or grammar errors", answered by a proof-reader
// instead of by a language model.
//
// Of every requirement a thesis rubric carries, this is the one a model is worst at and
// a dedicated tool is best at. A model reading a chapter reports the two mistakes it
// happens to notice, invents a third, misses the agreement error in the sentence it
// quoted, and answers differently on the next run; it also spends a whole pass per file
// doing it. LanguageTool answers the same question from a rule base and a morphological
// dictionary: locally, deterministically, in both Italian and English, for free, and
// with an exact file:line for every finding. Handing it the requirement removes a pass
// from the review AND gives the student a better answer.
//
// OPT-IN, like everything else expensive in this module. With LLM_LANGUAGETOOL_URL
// unset this file reports `enabled: false` and nothing changes: the requirement stays
// with the model exactly as it is today. An instance that has no LanguageTool container
// must behave exactly as it did before this file existed.
//
// WHY THE TEXT IS BLANKED RATHER THAN ANNOTATED. LanguageTool has a `data` parameter
// that takes markup/text annotations, and it is the more faithful way to feed it LaTeX.
// It is not what this module does, because the offsets it answers with are offsets into
// the ASSEMBLED PLAIN TEXT, which then has to be mapped back through a table to reach a
// real file and a real line. This module instead sends text of the SAME LENGTH as the
// source, with everything that is not prose replaced by spaces (the transform style the
// structural checks already use), so a LanguageTool offset IS an offset into the
// student's file and the line number is exact by construction, with no table to get
// wrong. The cost is that a blanked span leaves a gap in the sentence LanguageTool
// reads; the category exclusions and the false-positive filters below exist because of
// that, and are what keeps the gap from becoming a finding.
//
// CREDIT. The idea of driving LanguageTool over LaTeX sources, and the false-positive
// filters kept below (a match inside a command token, inside the braces of a
// \cite/\ref/\label, on the capitalised word in front of a \cite, on any word carrying
// a backslash), come from CheckMyTex by Dominik Krupke, MIT licensed:
// https://github.com/d-krupke/CheckMyTex. This is an independent reimplementation in
// JavaScript against the same public LanguageTool HTTP API; no code was copied.
//
// GENERIC BY CONSTRUCTION, like LLMStructuralChecks.mjs next to it: this file knows
// about LaTeX and about the LanguageTool API, and nothing about any rubric, university
// or template. It reads no request, opens no socket it was not configured to open by an
// administrator, and holds no state between calls.
//
// The offset-preserving helpers here (blankSpan, blankRanges, findEnvironments,
// readBracedArgument, lineLookup) are a deliberately MINIMAL reimplementation of the
// ones in LLMStructuralChecks.mjs. They are not imported: that module is loaded inside
// the container with a module-global report language and a catalogue of checks this one
// has no business touching, and the subset needed here is fifty lines. Where the two
// disagree the structural checks are the reference; the shapes are kept identical on
// purpose so a reader moving between the files recognises them.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// overleaf-lab: the rubric's language is 'it' or 'en' (see detectRubricLanguage in the
// controller and setChecksLanguage in the structural checks). LanguageTool wants a
// full locale, and it must be an explicit one: `auto` is a detector, and a detector
// makes the answer depend on which chapter happened to be sent first, which is exactly
// the run-to-run variation this file exists to remove.
//
// en-US is the default English variant. An institution whose rubric demands British
// spelling passes 'en-GB' straight through: any value that already looks like a locale
// is used as it is, so the option is an escape hatch and not a second mapping table.
const LANGUAGE_CODES = { it: 'it-IT', en: 'en-US' }
const DEFAULT_LANGUAGE_CODE = 'en-US'

export function languageToolCode(language) {
    const raw = String(language || '').trim()
    if (/^[a-z]{2}-[A-Za-z]{2,3}$/.test(raw)) {
        return `${raw.slice(0, 2).toLowerCase()}-${raw.slice(3).toUpperCase()}`
    }
    return LANGUAGE_CODES[raw.toLowerCase()] || DEFAULT_LANGUAGE_CODE
}

// overleaf-lab: LanguageTool's own request size limit is a deployment setting
// (`maxTextLength`), and the public default is well under a thesis chapter. Splitting
// at 18k characters keeps every request comfortably inside the usual configurations and
// keeps a single slow request from holding the review; the split is at a PARAGRAPH
// boundary so no rule ever loses the sentence it needs.
export const MAX_CHUNK_CHARS = 18000

// overleaf-lab: a ceiling on how much work one review may ask of the LanguageTool
// container. 200 chunks is about 3.6 MB of source, which is an order of magnitude above
// a real thesis and two above a report; it exists so that a deliberately enormous
// upload cannot turn one click into a thousand HTTP requests. Reaching it is reported
// (`totals.chunksSkipped`), never silent: a partial answer presented as a complete one
// is the failure this module is meant to avoid.
export const MAX_CHUNKS = 200

// overleaf-lab: how many matches are STORED. A first draft with a systematic habit
// (every "pò", every missing accent) produces hundreds of hits of the same shape, and a
// report that lists them all is a report nobody reads. The true totals travel next to
// the list, so the evidence can say "60 shown of 412" instead of implying there were 60.
export const MAX_STORED_MATCHES = 60

const DEFAULT_TIMEOUT_MS = 30 * 1000

// overleaf-lab: how much of the source is quoted around a match, so the student can see
// what was flagged without opening the file, and clipped so one very long line cannot
// push a wall of text into the report.
const EXCERPT_CONTEXT_CHARS = 40
const EXCERPT_MAX_CHARS = 180
const MESSAGE_MAX_CHARS = 300
const SUGGESTION_MAX_CHARS = 120
const MAX_SUGGESTIONS = 3

// overleaf-lab: THE CATEGORIES THIS MODULE DOES NOT REPORT, and why each group is out.
//
// LanguageTool ships far more than grammar and spelling: it has opinions about style,
// about repetition, about whether a sentence is too wordy, and about typography. Three
// separate reasons keep them out of a compliance report:
//
//   - TYPOGRAPHY is decided by LaTeX, not by the author. Quote marks, the spacing
//     around punctuation, the dash the class file substitutes: reporting them tells the
//     student to fix something their template produced. Worse, this module's own
//     blanking creates whitespace that was not there (a blanked equation is a run of
//     spaces), so WHITESPACE_RULE and its family would fire on nearly every paragraph
//     containing maths. Those would be findings manufactured by this file.
//   - STYLE, REDUNDANCY, REPETITIONS and their relatives are matters of taste that the
//     rubric already covers where it cares, in the requirements the model reads. A
//     parser verdict is presented to the student as exact; spending that credibility on
//     "consider a shorter word" devalues the spelling findings standing next to it.
//   - CASING is excluded for the same reason TYPOGRAPHY is: after a display equation is
//     blanked, a sentence that continues on the other side of it looks to LanguageTool
//     like a new sentence starting in lower case. That is an artefact of the transform,
//     not of the thesis.
//
// What stays: TYPOS (spelling), GRAMMAR (including agreement), PUNCTUATION (a missing
// comma before a subordinate, not a curly quote), CONFUSED_WORDS, COMPOUNDING and
// CORRESPONDENCE. Those are the categories where a hit is a defect the author can and
// should fix, and where the rubric's requirement actually points.
//
// The list is a CONSTANT and it is documented here rather than being tuned per
// institution: a rubric that wants a different trade-off overrides it per call, and an
// override is visible in the integration rather than hidden in an environment variable.
export const EXCLUDED_CATEGORIES = [
    'STYLE',
    'TYPOGRAPHY',
    'CASING',
    'REDUNDANCY',
    'REPETITIONS',
    'REPETITIONS_STYLE',
    'PLAIN_ENGLISH',
    'CREATIVE_WRITING',
    'WIKIPEDIA',
    'COLLOQUIALISMS',
    'NONSTANDARD_PHRASES',
    'REGIONALISMS',
    'GENDER_NEUTRALITY',
    'IDIOMS',
    'BARBARISMS',
    'MISUSED_TERMS_EU_PUBLICATIONS',
    'SEMANTICS',
]

// overleaf-lab: individual rules that survive their category and still must not be
// reported. Every one of them is here because the BLANKING can produce it, not because
// the rule is wrong: an equation replaced by spaces ends a sentence that never ended, a
// blanked \label leaves a paragraph with no full stop, a table cell blanked of its
// separators leaves two words with a hole between them. Naming the rules is narrower
// than excluding another whole category, and each name is a defect this module would
// otherwise invent.
export const EXCLUDED_RULES = [
    'UPPERCASE_SENTENCE_START',
    'PUNCTUATION_PARAGRAPH_END',
    'WHITESPACE_RULE',
    'COMMA_PARENTHESIS_WHITESPACE',
    'DOUBLE_PUNCTUATION',
    'UNPAIRED_BRACKETS',
    'EN_UNPAIRED_BRACKETS',
    'IT_UNPAIRED_BRACKETS',
    'SENTENCE_WHITESPACE',
]

// ---------------------------------------------------------------------------
// Offset-preserving helpers (minimal reimplementation, see the header)
// ---------------------------------------------------------------------------

// Blank a span while preserving every offset and every newline, so a line number
// computed afterwards is still the line of the real source.
function blankSpan(span) {
    return span.replace(/[^\n]/g, ' ')
}

// Blank a set of spans with ONE rebuild of the string. The obvious loop copies the
// whole document per span and is quadratic in the number of spans, which on a LaTeX
// file is the number of commands in it. Ranges are sorted and merged here rather than
// demanded sorted from the caller: the command scanner emits a closing brace after the
// ranges nested inside it, and dropping those would leave markup in the prose.
function blankRanges(text, ranges) {
    if (ranges.length === 0) return text
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0])
    const merged = []
    for (const [start, end] of sorted) {
        if (end <= start) continue
        const last = merged[merged.length - 1]
        if (last && start <= last[1]) last[1] = Math.max(last[1], end)
        else merged.push([start, end])
    }
    const pieces = []
    let cursor = 0
    for (const [start, end] of merged) {
        pieces.push(text.slice(cursor, start), blankSpan(text.slice(start, end)))
        cursor = end
    }
    pieces.push(text.slice(cursor))
    return pieces.join('')
}

// Balanced scan for \begin{env}...\end{env}, one pass over the begin/end tokens with a
// stack per name, so the cost is linear in the document. An environment whose \end is
// missing blanks NOTHING: stretching it to the end of the file would hide the rest of
// the chapter from the proof-reader, which is the expensive way to be wrong.
function findEnvironments(text, names) {
    const token = new RegExp(`\\\\(begin|end)\\s*\\{(${names.join('|')})\\*?\\}`, 'g')
    const open = new Map()
    const blocks = []
    let match
    while ((match = token.exec(text)) !== null) {
        const name = match[2]
        if (!open.has(name)) open.set(name, [])
        const stack = open.get(name)
        if (match[1] === 'begin') {
            stack.push(match.index)
        } else if (stack.length > 0) {
            // Innermost first, so a nested environment does not close its parent.
            blocks.push([stack.pop(), match.index + match[0].length])
        }
    }
    return blocks
}

// Read one braced argument, counting nesting, so a title carrying a group is not cut at
// the first inner closing brace. Bounded, because a brace that never closes must not
// cost a walk to the end of the document once per command.
const MAX_BRACED_ARGUMENT = 4000

function readBracedArgument(text, openIndex) {
    let depth = 0
    const limit = Math.min(text.length, openIndex + MAX_BRACED_ARGUMENT)
    for (let i = openIndex; i < limit; i++) {
        const c = text[i]
        if (c === '\\') {
            i += 1
            continue
        }
        if (c === '{') depth += 1
        else if (c === '}') {
            depth -= 1
            if (depth === 0) return i
        }
    }
    return -1
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

// overleaf-lab: `[warning: ...]` at the end of an evidence string is the ENGINE's
// reliability marker, and only the engine may write it. This module quotes raw student
// text into `excerpt`, so a student who writes that sequence in their own LaTeX would
// otherwise have it rendered as the amber badge in the report. Same neutralisation as
// the structural checks apply to their own evidence: the words survive, the bracket
// that makes them a marker does not.
function neutraliseWarningMarker(text) {
    return String(text ?? '')
        .replace(/\[\s*warning\s*:([^\]]*)\]/gi, '(warning:$1)')
        .replace(/\[\s*warning\s*:/gi, '(warning:')
}

function clip(text, max) {
    const value = String(text ?? '')
    // Three dots, like the controller's own clip: the report is read as plain text in
    // one place and as HTML in another, and a single-character ellipsis is not the same
    // string in both.
    return value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value
}

// ---------------------------------------------------------------------------
// LaTeX -> prose, at constant offsets
// ---------------------------------------------------------------------------

// Environments whose content is not prose in any language: shown code, maths, and
// pictures described in a drawing language. Blanked whole, delimiters included.
const NON_PROSE_ENVIRONMENTS = [
    'verbatim',
    'Verbatim',
    'lstlisting',
    'minted',
    'alltt',
    'comment',
    'filecontents',
    'equation',
    'displaymath',
    'align',
    'alignat',
    'gather',
    'multline',
    'flalign',
    'eqnarray',
    'IEEEeqnarray',
    'split',
    'cases',
    'tikzpicture',
    'pgfpicture',
    'circuitikz',
    'pspicture',
]

// overleaf-lab: how many braced arguments each command hides from the proof-reader.
// The default is ZERO: an unknown command is assumed to wrap prose, because most of
// them do (\textbf{bold word} contributes "bold word", and a rule about that word must
// still fire). The commands listed here carry identifiers instead: a label name, a
// citation key, a file path, a package name, a colour model. Feeding those to a spell
// checker produces a finding for every figure in the document.
//
// The counts are EXACT rather than "all following groups": \cite{a}{b} is not a thing,
// and a greedy count would swallow the braced group of whatever came next in the prose.
const COMMAND_ARGUMENTS = new Map([
    ['label', 1],
    ['includegraphics', 1],
    ['input', 1],
    ['include', 1],
    ['subfile', 1],
    ['usepackage', 1],
    ['RequirePackage', 1],
    ['documentclass', 1],
    ['bibliography', 1],
    ['bibliographystyle', 1],
    ['addbibresource', 1],
    ['graphicspath', 1],
    ['lstinputlisting', 1],
    ['lstset', 1],
    ['url', 1],
    ['nolinkurl', 1],
    ['href', 1],
    ['begin', 1],
    ['end', 1],
    ['index', 1],
    ['bibitem', 1],
    ['color', 1],
    ['pagecolor', 1],
    ['pagestyle', 1],
    ['thispagestyle', 1],
    ['hypersetup', 1],
    ['geometry', 1],
    ['setlength', 2],
    ['addtolength', 2],
    ['setcounter', 2],
    ['textcolor', 1],
    ['colorbox', 1],
    ['definecolor', 3],
    ['newcommand', 2],
    ['renewcommand', 2],
    ['providecommand', 2],
    ['newenvironment', 3],
    ['renewenvironment', 3],
    ['newtheorem', 2],
    ['acro', 2],
    ['newacronym', 3],
    ['DeclareAcronym', 2],
    ['newglossaryentry', 2],
    // Scaffolding measured leaking on a real template (2026-08-03): the "toc"
    // and "chapter" of \addcontentsline came back as "Hoc" and "charter", and a
    // \lstdefinestyle body offered "brevilinea" for breaklines. The third
    // argument of \addcontentsline is the printed title and stays prose.
    ['addcontentsline', 2],
    ['addtocontents', 2],
    ['lstdefinestyle', 2],
    ['titleformat', 5],
    ['titlespacing', 4],
    ['fancyhead', 1],
    ['fancyfoot', 1],
    ['fancyhf', 1],
    ['captionsetup', 1],
    ['sisetup', 1],
    ['pgfplotsset', 1],
    ['DeclareMathOperator', 2],
    ['newcolumntype', 2],
    ['rowcolor', 1],
    ['cellcolor', 1],
    ['columncolor', 1],
    ['arrayrulecolor', 1],
    ['counterwithout', 2],
    ['counterwithin', 2],
    ['afterpage', 1],
    // "bottom" of a \newgeometry came back as "botto" on a real title page.
    ['newgeometry', 1],
    // \texttt carries identifiers and file names ("lstlisting" came back as
    // "splitting" on a real document): code, not prose to proof-read.
    ['texttt', 1],
])

// Every cross-reference and citation spelling, whatever the package. \href is excluded
// explicitly because it ends in the letters "ref" and its SECOND argument is the visible
// text of the link, which is prose and must reach the proof-reader; it takes its own
// entry above. \hyperref names its label in brackets, which the bracket rule below
// blanks anyway.
// The command-name repetitions are capped at 32 for the same reason IDENTIFIER_ARGUMENT_SPAN
// is: this is anchored and tested on short names, but the cap makes the shape uniformly
// safe and matches the longest real command ("acrshortpl", 10) with room to spare.
const IDENTIFIER_COMMAND = /^(?:(?!href$|hyperref$)[a-zA-Z]{0,32}ref|[a-zA-Z]{0,32}cite[a-zA-Z]{0,32}|gls[a-z]{0,32}|acr[a-z]{0,32}|ac[slfp]?)$/

// \crefrange{a}{b} and \cpageref ranges name two labels.
const RANGE_COMMAND = /^[a-zA-Z]{0,32}range$/

function bracedArgumentsToBlank(name) {
    if (COMMAND_ARGUMENTS.has(name)) return COMMAND_ARGUMENTS.get(name)
    if (RANGE_COMMAND.test(name) && IDENTIFIER_COMMAND.test(name.replace(/range$/, ''))) return 2
    if (IDENTIFIER_COMMAND.test(name)) return 1
    return 0
}

// How far past a command the scanner will walk looking for its arguments. A command and
// its arguments live together; a blank line between them means the command had none and
// the text that follows is a new paragraph, which must not be eaten.
const ARGUMENT_GAP_CHARS = 120
const MAX_COMMAND_ARGUMENTS = 6
const MAX_OPTIONAL_ARGUMENT = 300

function nextArgumentStart(text, from) {
    let newlines = 0
    for (let i = from; i < text.length && i - from < ARGUMENT_GAP_CHARS; i++) {
        const c = text[i]
        if (c === '\n') {
            newlines += 1
            if (newlines > 1) return -1
            continue
        }
        if (c === ' ' || c === '\t' || c === '\r') continue
        return i
    }
    return -1
}

// overleaf-lab: the command TOKENS themselves, their optional arguments, and the braced
// arguments that carry identifiers rather than words. One forward scan: the cursor only
// ever moves forward, so a file full of commands costs a single pass whatever it
// contains.
//
// What survives is exactly what a reader sees. `\textbf{parola}` leaves "parola" where
// it was, `\item Testo` leaves "Testo", `\ref{fig:uno}` leaves nothing at all. The
// braces are removed by the caller's final pass, which is what stops "parola" from
// being read as part of a longer token.
function blankCommands(text) {
    const ranges = []
    // A control word (\alpha, \textbf) or a control symbol (\\, \%, \&, \{). Both are
    // markup; neither is a word the proof-reader may see.
    const token = /\\([a-zA-Z@]+)\*?|\\[^a-zA-Z\s]/g
    let match
    while ((match = token.exec(text)) !== null) {
        const name = match[1] || ''
        let cursor = match.index + match[0].length
        ranges.push([match.index, cursor])
        let remaining = name ? bracedArgumentsToBlank(name) : 0
        for (let n = 0; n < MAX_COMMAND_ARGUMENTS; n++) {
            const at = nextArgumentStart(text, cursor)
            if (at === -1) break
            if (text[at] === '[') {
                // An optional argument is placement (`[htbp]`), a width, a package
                // option or a listing's own settings: never prose, for every command.
                const close = text.indexOf(']', at)
                if (close === -1 || close - at > MAX_OPTIONAL_ARGUMENT) break
                ranges.push([at, close + 1])
                cursor = close + 1
                continue
            }
            if (text[at] === '{' && remaining > 0) {
                const close = readBracedArgument(text, at)
                if (close === -1) break
                ranges.push([at, close + 1])
                cursor = close + 1
                remaining -= 1
                continue
            }
            break
        }
        // Forward only. The braced group of a prose command is deliberately NOT skipped:
        // the scan continues inside it, so a command nested in bold text is blanked too.
        token.lastIndex = cursor
    }
    return blankRanges(text, ranges)
}

// overleaf-lab: inline maths, paired in ONE pass over the delimiters. The obvious lazy
// regex rescans from every unmatched `$` to the end of the file, which is quadratic on a
// document that contains one; this module refuses to be the place that reintroduces the
// shape the structural checks were rewritten to remove. An odd number of delimiters
// leaves the last one unpaired and blanks nothing after it, which is the safe side.
function blankDollarMaths(text) {
    if (!text.includes('$')) return text
    const tokens = []
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === '\\') {
            i += 1
            continue
        }
        if (c === '$') {
            const double = text[i + 1] === '$'
            tokens.push([i, double ? i + 2 : i + 1])
            if (double) i += 1
        }
    }
    const ranges = []
    for (let i = 0; i + 1 < tokens.length; i += 2) {
        ranges.push([tokens[i][0], tokens[i + 1][1]])
    }
    return blankRanges(text, ranges)
}

// Display maths written `\[ ... \]` and inline maths written `\( ... \)`, paired the
// same way and for the same reason. The lookbehind is there because `\\[2mm]` is a line
// break with extra spacing inside a table, not display maths.
const MATHS_DELIMITER = /(?<!\\)\\([[\]()])/g

function blankDelimitedMaths(text) {
    const ranges = []
    const open = { '[': null, '(': null }
    const closes = { ']': '[', ')': '(' }
    for (const match of text.matchAll(MATHS_DELIMITER)) {
        const c = match[1]
        if (c === '[' || c === '(') {
            if (open[c] === null) open[c] = match.index
        } else {
            const start = open[closes[c]]
            if (start === null) continue
            ranges.push([start, match.index + match[0].length])
            open[closes[c]] = null
        }
    }
    return blankRanges(text, ranges)
}

// overleaf-lab: text the author has switched off, and text that is markup by position
// rather than by command. A line comment is not prose (and stripLatexComments upstream
// has usually removed it already, which makes this idempotent rather than redundant:
// the module must also be correct when handed raw sources). An escaped `\%` is not a
// comment, so the odd-backslash rule the controller uses applies here too.
function blankLineComments(text) {
    if (!text.includes('%')) return text
    const ranges = []
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (c === '\\') {
            i += 1
            continue
        }
        if (c !== '%') continue
        const end = text.indexOf('\n', i)
        const stop = end === -1 ? text.length : end
        ranges.push([i, stop])
        i = stop
    }
    return blankRanges(text, ranges)
}

// Inline verbatim: `\verb|\begin{figure}|` is how a thesis SHOWS a command instead of
// using it, and what it shows is code. The delimiter is whatever character follows the
// command, per the manual; an unterminated one blanks nothing.
const INLINE_VERB_HEAD = /\\(?:verb\*?|lstinline)(?:\[[^\]\n]{0,200}\])?/g

function blankInlineVerb(text) {
    if (!text.includes('\\verb') && !text.includes('\\lstinline')) return text
    const head = new RegExp(INLINE_VERB_HEAD.source, 'g')
    const ranges = []
    let match
    while ((match = head.exec(text)) !== null) {
        const open = text[match.index + match[0].length]
        if (open === undefined || open === '\n') continue
        const close = open === '{' ? '}' : open
        const from = match.index + match[0].length + 1
        const end = text.indexOf(close, from)
        const newline = text.indexOf('\n', from)
        if (end === -1 || (newline !== -1 && newline < end)) continue
        ranges.push([match.index, end + 1])
        head.lastIndex = end + 1
    }
    return blankRanges(text, ranges)
}

// overleaf-lab: the preamble is configuration, and the proof-reader must never see it.
// \usepackage names, class options, colour definitions and the geometry setup are a
// dense field of tokens that no dictionary contains, and every one of them comes back
// as a spelling mistake in a file the student did not write and must not change.
//
// Only blanked when this file HAS a preamble: a chapter pulled in with \input has no
// \begin{document}, and blanking to the first line of such a file would blank the
// chapter. Anything after \end{document} goes for the same reason it is not typeset.
function blankOutsideDocument(text) {
    const ranges = []
    const begin = text.indexOf('\\begin{document}')
    if (begin !== -1) ranges.push([0, begin + '\\begin{document}'.length])
    const end = text.indexOf('\\end{document}')
    if (end !== -1) ranges.push([end, text.length])
    return blankRanges(text, ranges)
}

// The characters that structure LaTeX without ever being read as words: the braces the
// command scanner left behind, the tabular column separator, the tie, and the sub- and
// superscript markers that survive outside maths mode.
const STRUCTURAL_CHARACTERS = /[{}&~^_]/g

// overleaf-lab: the whole transform, in the one order that works.
//
// Verbatim first, because a listing that SHOWS `%` or `$` is code and its body must be
// spaces before the comment and maths scans run. Comments next, because a commented-out
// `\begin{equation}` must not open a maths region for the scan that follows. Then the
// preamble, the environments, the maths, the commands, and last the structural
// characters the command scanner deliberately left in place.
//
// The output has EXACTLY the length of the input and exactly its newlines. That is the
// property everything downstream rests on, and it is what the tests pin first.
// A SHORT italic group is the typographic convention for a foreign or technical
// term ("modelli di \textit{Deep Learning}", "\emph{ground truth}"): the italics
// are the author saying "this is not Italian", and sending the words to an
// Italian proof-reader turned every one of them into a typo on a real thesis.
// Three words at most, no sentence punctuation: an italicised full clause is
// emphasis on prose, and prose stays checked.
const SHORT_ITALIC = /\\(?:textit|emph|textsl)\s{0,20}\{([^{}]{1,60})\}/g

function blankShortItalics(text) {
    const ranges = []
    for (const m of text.matchAll(SHORT_ITALIC)) {
        const inner = m[1].trim()
        if (!inner || /[.:;!?]/.test(inner)) continue
        if (inner.split(/\s+/).length > 3) continue
        ranges.push([m.index, m.index + m[0].length])
    }
    return blankRanges(text, ranges)
}

export function toProse(text) {
    const source = String(text ?? '')
    let prose = blankInlineVerb(source)
    prose = blankRanges(prose, findEnvironments(prose, NON_PROSE_ENVIRONMENTS))
    prose = blankLineComments(prose)
    prose = blankOutsideDocument(prose)
    prose = blankDollarMaths(prose)
    prose = blankDelimitedMaths(prose)
    // Before blankCommands, which would keep the words and blank only the
    // command token: here the WORDS are the thing to hide.
    prose = blankShortItalics(prose)
    prose = blankCommands(prose)
    return prose.replace(STRUCTURAL_CHARACTERS, ' ')
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

// overleaf-lab: cut a file into requests LanguageTool will accept, at paragraph
// boundaries, each carrying the offset it starts at. `base` is the whole point: every
// offset the server answers with is relative to the chunk, and `base + offset` is an
// offset into the student's file. Get that wrong and every line number in the report is
// wrong in a way nobody notices, because the numbers still look plausible.
//
// Chunks that are entirely blank after the transform (a preamble, a file of nothing but
// figures) are dropped rather than sent: they cost a round trip and can produce nothing.
export function chunkProse(prose, limit = MAX_CHUNK_CHARS) {
    const chunks = []
    let start = 0
    while (start < prose.length) {
        if (prose.length - start <= limit) {
            chunks.push({ base: start, text: prose.slice(start) })
            break
        }
        const window = prose.slice(start, start + limit)
        // A paragraph break, else any line break, else a hard cut: a generated table or
        // an exported chapter can be one line of 200k characters, and that file must
        // still be checked rather than skipped.
        let cut = window.lastIndexOf('\n\n')
        if (cut <= 0) cut = window.lastIndexOf('\n')
        cut = cut <= 0 ? limit : cut + 1
        chunks.push({ base: start, text: prose.slice(start, start + cut) })
        start += cut
    }
    return chunks.filter(chunk => chunk.text.trim().length > 0)
}

// ---------------------------------------------------------------------------
// False-positive filters (see the CheckMyTex credit in the header)
// ---------------------------------------------------------------------------

// Every command token in the ORIGINAL source, so a match that lands on one can be
// recognised. After the transform a command is spaces and no rule should fire on it;
// this is the second line of defence, and it is the one that holds when the transform is
// handed text some other stage has already rewritten.
const COMMAND_TOKEN_SPAN = /\\[a-zA-Z@]+\*?/g

// The braces of the commands whose argument is a name: a label, a key, a reference.
// LanguageTool reads "fig:schema-blocchi" as a misspelled word, and there are as many of
// those in a thesis as there are figures.
//
// The command-name repetitions are BOUNDED at 32. The braces and the optional bracket
// were already capped, but `[a-zA-Z]*cite[a-zA-Z]*` on a `\` followed by 80 KB of "cite"
// (no braces, so the span can never complete) backtracked quadratically - measured at
// 27 s here, 8 s on the smaller probe. The longest real cross-reference or citation
// command in the corpus is "autoref"/"citep" (7 and 5 letters), so 32 is generous
// headroom while making each backslash constant-time.
const IDENTIFIER_ARGUMENT_SPAN =
    /\\(?:label|[a-zA-Z]{0,32}ref|[a-zA-Z]{0,32}cite[a-zA-Z]{0,32})\*?\s*(?:\[[^\]\n]{0,200}\])?\s*\{[^{}]{0,400}\}/g

// A capitalised word immediately in front of a citation is an author's name written the
// way every citation style asks for it: "come mostrato da Rossi \cite{rossi2019}". No
// dictionary contains it and no student should be told to fix it. The gap allows the
// tie and the spaces a LaTeX author puts there.
const CITATION_AFTER = /^[\s~]{0,4}\\[a-zA-Z]{0,32}cite/

function spansOf(text, pattern) {
    const spans = []
    for (const match of text.matchAll(pattern)) {
        spans.push([match.index, match.index + match[0].length])
    }
    return spans
}

function insideSpans(spans, start, end) {
    let lo = 0
    let hi = spans.length - 1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (start < spans[mid][0]) hi = mid - 1
        else if (start >= spans[mid][1]) lo = mid + 1
        else return end <= spans[mid][1]
    }
    return false
}

// ---------------------------------------------------------------------------
// The domain dictionary
// ---------------------------------------------------------------------------

// overleaf-lab: the terms an institution's documents legitimately contain and no
// dictionary does. "biblatex", "Overleaf", "quaternione", the name of a laboratory, the
// name of a satellite: every one of them is a spelling finding on every page it appears,
// and a report whose first ten items are the name of the thesis's own subject is a
// report the student stops reading.
//
// Administrator-provided, comma-separated, from LLM_LANGUAGETOOL_DICT or from the call.
// How many matches it removed is COUNTED and reported: a whitelist that silently
// swallows findings is indistinguishable from a checker that found nothing.
// The English loanwords an engineering thesis written in Italian uses as plain
// Italian words. They are exactly the class the vocabulary filter (four or more
// uses) already handles when frequent; this list covers the SAME words when
// they appear once or twice, which "payload" three times in a real chapter
// measured against the live engine. Generic engineering and space vocabulary
// only, on purpose: anything narrower belongs in LLM_LANGUAGETOOL_DICT, which
// the administrator owns.
export const DEFAULT_LOANWORDS = [
    'payload', 'dataset', 'frame', 'pipeline', 'hardware', 'software', 'firmware',
    'buffer', 'driver', 'debug', 'debugging', 'testing', 'benchmark', 'baseline',
    'workflow', 'setup', 'layout', 'display', 'sensor', 'array', 'cluster',
    'download', 'upload', 'link', 'file', 'folder', 'directory', 'thread',
    'timestamp', 'timeline', 'deadline', 'feedback', 'trend', 'range', 'target',
    'default', 'standard', 'performance', 'docking', 'thruster', 'launcher',
    'lander', 'rover', 'flyby', 'downlink', 'uplink', 'housekeeping', 'jitter',
    'detumbling', 'deployment', 'deployer', 'tracking', 'pointing', 'imaging',
    'servicing', 'servicer', 'deorbit', 'deorbiting', 'stationkeeping', 'rendezvous',
    'rendering', 'mesh', 'texture', 'shader', 'slot', 'chip', 'chipset', 'board',
]

export function parseDictionary(...sources) {
    const terms = new Set()
    for (const source of sources) {
        if (!source) continue
        const list = Array.isArray(source) ? source : String(source).split(/[,\n]/)
        for (const raw of list) {
            const term = String(raw || '').trim().toLowerCase()
            if (term) terms.add(term)
        }
    }
    return terms
}

// A match is whitelisted when the text it flags IS one of the terms. Compared without
// case, and with the punctuation the rule may have included on either side removed, so
// "Overleaf," and "Overleaf" are the same word. Never a substring test: "il" inside
// "biblatex" must not silence a real finding.
function isWhitelisted(dictionary, flagged) {
    if (dictionary.size === 0) return false
    const word = flagged.trim().replace(/^[^\p{L}\p{N}\\]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()
    return word.length > 0 && dictionary.has(word)
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

// Files whose content is data or configuration rather than prose. A .bib read by a
// spell checker is a few hundred author names and journal titles, every one of them a
// finding, and none of them a sentence anybody wrote.
const NON_PROSE_FILES = /\.(?:bib|cls|sty|bst|bbl|aux|log|pdf|png|jpe?g|eps|svg)$/i

// The title page is not the student's prose: it is names, degrees and layout,
// and a proof-reader loose on it "corrected" a supervisor's surname on a real
// project. Same philosophy as the review's own skip of the ringraziamenti.
const TITLE_PAGE_FILES = /(?:^|\/)(?:frontespizio|frontispiece|titlepage|title_?page|copertina)[^/]*\.tex$/i

function resolveUrl(options = {}) {
    const raw = String(options.url || process.env.LLM_LANGUAGETOOL_URL || '').trim()
    return raw
}

// The endpoint, from whatever the administrator wrote. A base URL is the documented
// form ("http://languagetool:8010"), and the two fuller spellings are accepted because
// an administrator who pastes the URL from the LanguageTool documentation gets one of
// them and deserves a working instance rather than a 404 in a log nobody reads.
function checkEndpoint(url) {
    const base = url.replace(/\/+$/, '')
    if (/\/v2\/check$/.test(base)) return base
    if (/\/v2$/.test(base)) return `${base}/check`
    return `${base}/v2/check`
}

export function isLanguageToolEnabled(options = {}) {
    return resolveUrl(options).length > 0
}

// Productive prefixes of Italian (and scientific Latin/Greek) word formation,
// longest first so the alternation never stops at a shorter variant. The
// dictionary will never enumerate "sottocampionamento" or "defocalizzata",
// but the BASE after the prefix is a dictionary word, and that is checkable
// against the engine itself. A closed list of prefixes is linguistics, not a
// whitelist of words: it does not grow with the corpus.
const DERIVATION_PREFIX =
    /^(?:elettro|pseudo|contro|sotto|sovra|sopra|micro|macro|multi|quasi|retro|termo|astro|radio|inter|intra|extra|ultra|mono|nano|mega|meta|poli|para|anti|semi|iper|auto|aero|foto|post|ipo|pre|sub|neo|tri|bi|ri|de|co|par)-?([\p{L}]{4,})$/u

// One word per line against a given dictionary; only the speller's own
// verdicts count (a grammar rule tripping on a bare word list means nothing).
async function spellerRejects(endpoint, language, words, { fetchImpl, timeoutMs, signal }) {
    const text = words.join('\n')
    const body = new URLSearchParams({ text, language, enabledOnly: 'false' })
    const matches = await postCheck(endpoint, body, { fetchImpl, timeoutMs, signal })
    const rejected = new Set()
    for (const m of matches) {
        const rid = String((m && m.rule && m.rule.id) || '')
        const cat = String((m && m.rule && m.rule.category && m.rule.category.id) || '')
        if (cat !== 'TYPOS' && !rid.startsWith('MORFOLOGIK') && !rid.startsWith('HUNSPELL')) continue
        const s = Number(m.offset) || 0
        const w = text.slice(s, s + (Number(m.length) || 0)).toLowerCase()
        if (w) rejected.add(w)
    }
    return rejected
}

function emptyTotals() {
    return {
        matches: 0,
        kept: 0,
        shown: 0,
        droppedByWhitelist: 0,
        droppedAsVocabulary: 0,
        droppedAsForeign: 0,
        droppedAsCompound: 0,
        filtered: 0,
        chunks: 0,
        chunksSkipped: 0,
    }
}

// overleaf-lab: a fetch that cannot hang forever and honours a job cancel, for the same
// reason the controller's auxiliary calls have one: the review queue runs one job at a
// time, so a container that accepts the connection and never answers blocks every later
// review for every user until the process is restarted.
async function postCheck(endpoint, body, { fetchImpl, timeoutMs, signal }) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal) {
        if (signal.aborted) controller.abort()
        else signal.addEventListener('abort', abort, { once: true })
    }
    const timer = setTimeout(abort, timeoutMs)
    try {
        const response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: body.toString(),
            signal: controller.signal,
        })
        if (!response.ok) {
            const detail = typeof response.text === 'function' ? clip(await response.text(), 200) : ''
            throw new Error(`LanguageTool answered ${response.status}${detail ? `: ${detail}` : ''}`)
        }
        const payload = await response.json()
        return Array.isArray(payload && payload.matches) ? payload.matches : []
    } finally {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', abort)
    }
}

/**
 * Proof-read the assembled LaTeX sources.
 *
 * @param {Array<{path: string, text: string}>} docs the project sources, exactly the
 *        shape the structural checks take. Offsets in `text` are the offsets the report
 *        will quote, so pass the same documents the rest of the review reads.
 * @param {object} [options]
 * @param {string} [options.language] the rubric's language, 'it' or 'en'; a full locale
 *        ('en-GB') is passed through.
 * @param {string} [options.url] the LanguageTool base URL. Defaults to
 *        LLM_LANGUAGETOOL_URL. ADMINISTRATOR INPUT ONLY: never wire this to anything a
 *        request body can reach, or the review becomes a way to make the server fetch a
 *        URL of the caller's choosing.
 * @param {string|string[]} [options.dictionary] domain terms to ignore, added to
 *        LLM_LANGUAGETOOL_DICT.
 * @returns {Promise<object>} a JSON-able report; never throws.
 */
export async function checkDocuments(docs, options = {}) {
    const url = resolveUrl(options)
    const language = languageToolCode(options.language)
    if (!url) {
        // Not configured is not a failure: the requirement stays with the model, and the
        // caller can tell the two apart because `enabled` is false and `error` is not set.
        return { enabled: false, ok: true, language, files: 0, matches: [], totals: emptyTotals() }
    }

    const fetchImpl = options.fetchImpl || globalThis.fetch
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
    const dictionary = parseDictionary(DEFAULT_LOANWORDS, process.env.LLM_LANGUAGETOOL_DICT, options.dictionary)
    const excludedCategories = options.excludedCategories || EXCLUDED_CATEGORIES
    const excludedRules = options.excludedRules || EXCLUDED_RULES
    const excluded = new Set(excludedCategories)
    const excludedRuleSet = new Set(excludedRules)
    const endpoint = checkEndpoint(url)
    const totals = emptyTotals()
    const stored = []
    // Spelling findings park here instead of going straight into `stored`: they
    // are resolved in ONE batched cross-language call after the scan (see below).
    const pendingSpellings = []

    const inspected = (docs || []).filter(
        doc =>
            doc &&
            typeof doc.text === 'string' &&
            !NON_PROSE_FILES.test(String(doc.path || '')) &&
            !TITLE_PAGE_FILES.test(String(doc.path || ''))
    )

    // The document's own vocabulary, project-wide, counted BY STEM. A word the
    // dictionary does not know but the author uses FOUR or more times is
    // terminology, not a typo: "plenottica", "dataset" and "rendering" each came
    // back dozens of times on a real thesis, burying the two genuine
    // misspellings. Four and not three, measured: "superfice" appeared three
    // times in a published thesis as a REAL recurring typo, and it must keep
    // firing. The stem (final -s and final vowel folded) is what lets the
    // INFLECTED forms count together: "plenottici" was reported as a fresh typo
    // on a document that used "plenottica" thirty times.
    const stemOf = word =>
        word
            .toLowerCase()
            .replace(/s$/, '')
            .replace(/[aeio]$/, '')
    const vocabulary = new Map()
    for (const doc of inspected) {
        for (const m of toProse(doc.text).matchAll(/[\p{L}-]{4,}/gu)) {
            const stem = stemOf(m[0])
            vocabulary.set(stem, (vocabulary.get(stem) || 0) + 1)
        }
    }

    try {
        for (const doc of inspected) {
            const source = doc.text
            const prose = toProse(source)
            // A file that is configuration end to end (a setup.tex pulled in from
            // the preamble has no \begin{document}, so the preamble blank cannot
            // touch it) leaves almost no prose behind. What little survives is
            // option keys the command table does not know yet, and every one of
            // them comes back as a typo in a file the student must not edit.
            // BOTH conditions, deliberately: few words alone would also skip a
            // real two-line abstract.tex, whose few words are however most of
            // its file. Configuration is the only thing that is short on prose
            // AND buried in markup.
            const proseWords = (prose.match(/\p{L}{3,}/gu) || []).length
            const proseLetters = (prose.match(/\p{L}/gu) || []).length
            if (proseWords < 40 && proseLetters < source.length * 0.15) {
                continue
            }
            const at = lineLookup(source)
            // The false-positive spans are computed on the ORIGINAL source, because a
            // match is judged by what the student actually wrote at that offset.
            const commandSpans = spansOf(source, COMMAND_TOKEN_SPAN)
            const identifierSpans = spansOf(source, IDENTIFIER_ARGUMENT_SPAN)

            for (const chunk of chunkProse(prose)) {
                if (totals.chunks >= MAX_CHUNKS) {
                    totals.chunksSkipped += 1
                    continue
                }
                totals.chunks += 1
                const body = new URLSearchParams({ text: chunk.text, language, enabledOnly: 'false' })
                if (excludedCategories.length) body.set('disabledCategories', excludedCategories.join(','))
                if (excludedRules.length) body.set('disabledRules', excludedRules.join(','))
                // The server is ASKED to leave the excluded categories out and the
                // answer is filtered anyway: a LanguageTool build whose language pack
                // spells a category differently would otherwise let a whole class of
                // style note into a report that promises grammar and spelling.
                const matches = await postCheck(endpoint, body, { fetchImpl, timeoutMs, signal: options.signal })

                for (const match of matches) {
                    totals.matches += 1
                    const rule = (match && match.rule) || {}
                    const category = (rule.category && rule.category.id) || ''
                    const ruleId = rule.id || ''
                    if (excluded.has(category) || excludedRuleSet.has(ruleId)) {
                        totals.filtered += 1
                        continue
                    }
                    const start = chunk.base + (Number(match.offset) || 0)
                    const end = start + (Number(match.length) || 0)
                    if (end <= start || end > source.length) {
                        // An offset the source cannot carry is not a finding anybody can
                        // act on: it would point at a line that does not exist.
                        totals.filtered += 1
                        continue
                    }
                    const flagged = source.slice(start, end)
                    // ---- the CheckMyTex filters, in the order they are cheapest ----
                    // A word carrying a backslash is a command the transform missed, not
                    // a word.
                    if (flagged.includes('\\')) {
                        totals.filtered += 1
                        continue
                    }
                    // Entirely inside a command token, or inside the braces of a
                    // \cite/\ref/\label.
                    if (insideSpans(commandSpans, start, end) || insideSpans(identifierSpans, start, end)) {
                        totals.filtered += 1
                        continue
                    }
                    // A capitalised word immediately before a citation is an author.
                    if (/^\p{Lu}/u.test(flagged) && CITATION_AFTER.test(source.slice(end, end + 16))) {
                        totals.filtered += 1
                        continue
                    }
                    // A locale note is not a mistake: the en-US dictionary flags
                    // "behaviour" as British English (and en-GB flags "behavior"
                    // back), and a thesis written in European English is full of
                    // exactly that. Measured against the live engine.
                    if (
                        /^MORFOLOGIK_RULE_EN/.test(ruleId) &&
                        /(?:British|American) English/i.test(String(match.message || ''))
                    ) {
                        totals.filtered += 1
                        continue
                    }
                    // The STYLE rules of the Italian pack (ST_*: the d eufonica
                    // note, "output" with Italian alternatives offered). Advice,
                    // not error, and the requirement this check answers says
                    // spelling and grammar. Ids measured on the live engine.
                    if (/^ST_\d/.test(ruleId)) {
                        totals.filtered += 1
                        continue
                    }
                    // "GND GND" in a table, "100nF 100nF" in a parts list: a
                    // repeated IDENTIFIER is layout, not stuttered prose.
                    // Measured 478 times on the 75-thesis corpus. Repeated
                    // lowercase words ("la la") remain findings.
                    if (
                        /WORD_REPEAT/.test(ruleId) &&
                        /^[0-9A-Z][\w.%°-]{0,15}(?:\s{1,5}[0-9A-Z][\w.%°-]{0,15}){1,5}$/u.test(flagged.trim())
                    ) {
                        totals.filtered += 1
                        continue
                    }
                    // ``??'' quoted as an example: a punctuation-only finding
                    // wrapped in quote characters is text TALKING ABOUT
                    // punctuation, not using it. Measured on the course guide.
                    if (
                        !/\p{L}/u.test(flagged) &&
                        /["'`«»‘’“”]/.test(
                            source.slice(Math.max(0, start - 2), start) + source.slice(end, end + 2)
                        )
                    ) {
                        totals.filtered += 1
                        continue
                    }
                    // "punto a punto", "passo a passo": the X a X fixed
                    // expression is the one measured false positive of the
                    // Italian a/ha rule, and it is decidable in code. Real
                    // a/ha mistakes never mirror the same word on both sides.
                    if (ruleId.startsWith('ER_')) {
                        const leftWord = /([\p{L}]{2,30})\s{1,5}$/u.exec(source.slice(Math.max(0, start - 36), start))
                        const rightWord = /^[aA]\s{1,5}([\p{L}]{2,30})/u.exec(source.slice(start, end + 36))
                        if (leftWord && rightWord && leftWord[1].toLowerCase() === rightWord[1].toLowerCase()) {
                            totals.filtered += 1
                            continue
                        }
                    }
                    // ---- the domain dictionary, counted apart ----
                    if (isWhitelisted(dictionary, flagged)) {
                        totals.droppedByWhitelist += 1
                        continue
                    }
                    const spellingRule = category === 'TYPOS' || ruleId.startsWith('MORFOLOGIK')
                    // A Capitalised unknown word in MID-sentence is a proper noun
                    // (Space Economy, Sputnik, Cycles): student typos are rarely
                    // capitalised, and names of products and programmes are
                    // endless. At a sentence start nothing can be told, so it
                    // stays a finding there (and the cross-check below still
                    // gets a say). The full stop of a title ("prof. Modenini",
                    // "dott. Rossi") or of a dotted initial ("via B. Carnaccini")
                    // ends no sentence, and it is precisely where surnames live:
                    // those count as mid-sentence.
                    const beforeFlagged = source.slice(Math.max(0, start - 40), start)
                    if (
                        spellingRule &&
                        /^\p{Lu}[\p{Ll}\p{Lu}-]+$/u.test(flagged) &&
                        (!/(?:^|[.:;!?]\s{0,10}|\n[ \t]*\n[ \t]*)$/.test(beforeFlagged) ||
                            /\b(?:[Pp]roff?|[Dd]ott|[Dd]r|[Ii]ng|[Aa]vv|[Ss]igg?|[Mm]rs?|[Mm]s|[Ss]t|[Ff]igg?|[Tt]ab|[Ee]qq?|[Ss]ez|[Cc]ap|[Vv]ol|[Pp]agg?|[Ee]cc|etc)\.\s{1,10}$/u.test(beforeFlagged) ||
                            /\b\p{Lu}\.\s{1,10}$/u.test(beforeFlagged))
                    ) {
                        totals.filtered += 1
                        continue
                    }
                    // "ssa" of "dott.ssa": a short lowercase token glued right
                    // after a dotted abbreviation is the abbreviation's tail,
                    // not a word.
                    if (
                        spellingRule &&
                        /^\p{Ll}{1,5}$/u.test(flagged) &&
                        /\p{L}\.$/u.test(source.slice(Math.max(0, start - 2), start))
                    ) {
                        totals.filtered += 1
                        continue
                    }
                    // gg/mm/aaaa: a token that is one letter repeated is a
                    // placeholder or a pattern letter, never a typo.
                    if (spellingRule && /^(\p{L})\1{1,29}$/u.test(flagged)) {
                        totals.filtered += 1
                        continue
                    }
                    // ---- the document's own vocabulary (see the map above) ----
                    // Spelling rules only: a grammar finding on a frequent word
                    // ("la dataset" for "il dataset") is still a finding.
                    if (
                        spellingRule &&
                        /^[\p{L}-]+$/u.test(flagged) &&
                        (vocabulary.get(stemOf(flagged)) || 0) >= 4
                    ) {
                        totals.droppedAsVocabulary += 1
                        continue
                    }
                    const replacements = Array.isArray(match.replacements) ? match.replacements : []
                    const record = {
                        file: doc.path,
                        line: at(start),
                        ruleId,
                        category,
                        message: clip(neutraliseWarningMarker(match.message || ''), MESSAGE_MAX_CHARS),
                        // The flagged span travels wrapped in « » so the reader
                        // sees WHICH word tripped the rule without hunting
                        // through the excerpt; the HTML report turns the pair
                        // into a highlight.
                        excerpt: clip(
                            neutraliseWarningMarker(
                                (
                                    source.slice(Math.max(0, start - EXCERPT_CONTEXT_CHARS), start).replace(/\s+/g, ' ') +
                                    '«' +
                                    source.slice(start, end).replace(/\s+/g, ' ') +
                                    '»' +
                                    source.slice(end, end + EXCERPT_CONTEXT_CHARS).replace(/\s+/g, ' ')
                                ).trim()
                            ),
                            EXCERPT_MAX_CHARS
                        ),
                        suggestion: clip(
                            neutraliseWarningMarker(
                                replacements
                                    .slice(0, MAX_SUGGESTIONS)
                                    .map(r => String((r && r.value) || ''))
                                    .filter(Boolean)
                                    .join(' / ')
                            ),
                            SUGGESTION_MAX_CHARS
                        ),
                    }
                    // A spelling finding waits for the cross-language verdict
                    // below; everything else is final here. Two letters is
                    // enough: "of" in a quoted English title is exactly the
                    // kind of word the cross-check absolves.
                    if (spellingRule && /^[\p{L}-]{2,}$/u.test(flagged)) {
                        pendingSpellings.push({ record, word: flagged })
                    } else {
                        totals.kept += 1
                        if (stored.length < MAX_STORED_MATCHES) stored.push(record)
                    }
                }
            }
        }
    } catch (err) {
        // A LanguageTool that is down, slow or misconfigured must not take the review
        // with it, and must not be reported as "no spelling errors found" either: the
        // caller sees ok:false and says so, or falls back to the model.
        return {
            enabled: true,
            ok: false,
            language,
            files: inspected.length,
            matches: [],
            totals: emptyTotals(),
            error: clip(err && err.message ? err.message : String(err), 200),
        }
    }

    // ---- the foreign-word cross-check, one batched call ----
    // A whitelist of anglicisms loses by construction: every thesis brings new
    // ones. The OTHER dictionary of the same engine is the authority that
    // scales: a word the Italian speller rejects but the English speller
    // accepts is a foreign term in the prose, not a typo (and symmetrically
    // for an English thesis quoting Italian). One request for the whole
    // project. On ANY failure the findings are KEPT: a proof-reader hiccup
    // must not absolve real typos.
    // `crossCheck: false` exists for the suite, whose offset-pinned stubs cannot
    // answer a second request meaningfully. Production always leaves it on.
    const crossEnabled = options.crossCheck !== false
    if (pendingSpellings.length) {
        const foreign = new Set()
        try {
            if (!crossEnabled) throw new Error('cross-check disabled')
            const crossLanguage = String(language).toLowerCase().startsWith('it') ? 'en-US' : 'it'
            const unique = [...new Set(pendingSpellings.map(p => p.word.toLowerCase()))]
            const crossText = unique.join('\n')
            const crossBody = new URLSearchParams({ text: crossText, language: crossLanguage, enabledOnly: 'false' })
            const crossMatches = await postCheck(endpoint, crossBody, { fetchImpl, timeoutMs, signal: options.signal })
            const flaggedThere = new Set()
            for (const m of crossMatches) {
                const s = Number(m.offset) || 0
                const e = s + (Number(m.length) || 0)
                const w = crossText.slice(s, e).toLowerCase()
                if (w) flaggedThere.add(w)
            }
            for (const w of unique) {
                if (!flaggedThere.has(w)) foreign.add(w)
            }
        } catch (err) {
            foreign.clear()
        }
        const survivors = pendingSpellings.filter(p => !foreign.has(p.word.toLowerCase()))
        totals.droppedAsForeign += pendingSpellings.length - survivors.length

        // ---- the derived-word check, the same principle one level down ----
        // What survives both dictionaries is often a word BUILT from
        // dictionary words: a productive prefix on an Italian base
        // (ricampionamento, defocalizzata, nanosatelliti), a hyphenated
        // compound (micro-camere, sotto-array, keep-out), or a fused pair of
        // foreign words (keyframe). Decompose and ask the engines about the
        // PARTS, in two batched calls for the whole project. Fused pairs are
        // only absolved by the OTHER language on purpose: "dellamassa" is a
        // real missing-space typo and its parts are Italian, while a fused
        // Italian pair pretending to be one word has no business existing
        // outside the prefix list. Failure keeps the findings, as above.
        const derived = new Set()
        try {
            if (!crossEnabled) throw new Error('cross-check disabled')
            const crossLanguage = String(language).toLowerCase().startsWith('it') ? 'en-US' : 'it'
            const plans = new Map()
            const parts = new Set()
            for (const p of survivors) {
                const w = p.word.toLowerCase()
                if (plans.has(w) || w.length < 5 || w.length > 24 || !/^[\p{L}-]{5,24}$/u.test(w)) continue
                const decompositions = []
                if (w.includes('-')) {
                    const segments = w.split('-').filter(Boolean)
                    if (segments.length >= 2 && segments.length <= 4 && segments.every(s => s.length >= 2)) {
                        decompositions.push({ eitherLanguage: segments })
                    }
                } else {
                    const prefixed = DERIVATION_PREFIX.exec(w)
                    if (prefixed) decompositions.push({ eitherLanguage: [prefixed[1]] })
                    for (let i = 3; i <= w.length - 3; i++) {
                        decompositions.push({ crossOnly: [w.slice(0, i), w.slice(i)] })
                    }
                }
                if (!decompositions.length) continue
                plans.set(w, decompositions)
                for (const d of decompositions) {
                    for (const s of d.eitherLanguage || d.crossOnly) parts.add(s)
                }
            }
            if (plans.size && parts.size <= 600) {
                // A speller that rejects NOTHING is broken in disguise, and
                // with it every two-part split would validate and absolve
                // real typos. The canary is a string no dictionary knows: it
                // must come back rejected from BOTH calls, or the whole stage
                // distrusts the answers and keeps the findings.
                const canary = 'qzjxvkwq'
                const list = [...parts, canary]
                const callOptions = { fetchImpl, timeoutMs, signal: options.signal }
                const rejectedSame = await spellerRejects(endpoint, language, list, callOptions)
                const rejectedCross = await spellerRejects(endpoint, crossLanguage, list, callOptions)
                if (!rejectedSame.has(canary) || !rejectedCross.has(canary)) {
                    throw new Error('speller canary not rejected')
                }
                for (const [w, decompositions] of plans) {
                    const absolved = decompositions.some(d =>
                        d.eitherLanguage
                            ? d.eitherLanguage.every(s => !rejectedSame.has(s) || !rejectedCross.has(s))
                            : d.crossOnly.every(s => !rejectedCross.has(s))
                    )
                    if (absolved) derived.add(w)
                }
            }
        } catch (err) {
            derived.clear()
        }
        for (const p of survivors) {
            if (derived.has(p.word.toLowerCase())) {
                totals.droppedAsCompound += 1
                continue
            }
            totals.kept += 1
            if (stored.length < MAX_STORED_MATCHES) stored.push(p.record)
        }
    }

    totals.shown = stored.length
    return {
        enabled: true,
        ok: true,
        language,
        files: inspected.length,
        matches: stored,
        totals,
    }
}

export default {
    checkDocuments,
    isLanguageToolEnabled,
    languageToolCode,
    toProse,
    chunkProse,
    parseDictionary,
    EXCLUDED_CATEGORIES,
    EXCLUDED_RULES,
    MAX_STORED_MATCHES,
    MAX_CHUNK_CHARS,
    MAX_CHUNKS,
}
