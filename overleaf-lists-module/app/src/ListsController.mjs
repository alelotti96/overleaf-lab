// overleaf-lab: build and keep up to date the two lists a thesis carries at the
// front, the list of acronyms and the list of symbols, WITHOUT a language model.
//
// Everything here is a parser. No request ever leaves the container, no model is
// asked anything, and the same project produces the same answer every time. That
// is the whole point: a list of acronyms is a mechanical fact about a document,
// and a mechanical fact should not cost a GPU or arrive differently twice.
//
// THE THREE PROMISES THIS MODULE MAKES TO THE AUTHOR
//
//   1. It never destroys. A row that is already in the list is left exactly as it
//      was, byte for byte, whatever shape it has and whoever wrote it. A row whose
//      entry no longer appears in the document is NOT removed; it is reported and
//      left alone, because "I cannot find it" is not the same as "it is not there"
//      and the author is the one who knows which.
//   2. It never invents a file behind anyone's back. If the project has no list,
//      the module says so and OFFERS to create one; the name of any file it
//      creates is decided by this code from the chosen language, never by anything
//      a request carries, and a line is added to the main file only where there is
//      exactly one right place for it.
//   3. It is idempotent. Running it twice in a row produces zero changes the
//      second time, so it can be pressed without thinking about it.
//
// RECALL BEATS PRECISION HERE, WHICH IS THE OPPOSITE OF THE COMPLIANCE CHECKS.
// The checks in overleaf-llm-image are authoritative: they tell a student their
// document is wrong, so a false accusation there is expensive and they are tuned
// for precision. This module produces a DRAFT the author then curates by hand. An
// extra row is deleted in two seconds; a missing row is never noticed at all, and
// turns up at the viva. So the scans below cast wide: mixed-case forms (DoF, CiA,
// IoU, ReLU6), short forms carrying digits (TF2, 6DOF, L2), plurals folded onto
// their singular (CPOs -> CPO), forms with a hyphen or a slash (TT&C, LEO/MEO,
// with the pieces proposed too), occurrences inside \textbf, \texttt and \emph,
// and occurrences in captions, footnotes and titles, which earlier drafts threw
// away. Recurrence is used to ORDER the result, never to hide an entry.
//
// The anti-junk filter that survives is deliberately small, and every part of it
// is written down where it is applied: a real word set in capitals (NOTA, TESI,
// CHAPTER) is not a short form, a unit is not a short form, a repeated letter is
// not a short form, and a lone lowercase latin letter that occurs once in the
// whole document is not a symbol of the document.
//
// RELATIONSHIP WITH THE LLM MODULE. overleaf-llm-image ships compliance checks
// that parse the SAME two lists (`acronyms-missing-from-list`, `symbol-list`, and
// the hand-written list collectors in LLMStructuralChecks.mjs). That code is the
// REFERENCE IMPLEMENTATION for how a hand-written list is recognised, and the
// vocabulary below (declaration commands, greek command set, symbol wrapper
// macros, the "a lone letter is a symbol, two adjacent letters are a word" rule)
// is a deliberate, hand-kept copy of it. It is a copy and not an import ON
// PURPOSE: this module must work on an instance that never builds the LLM image,
// which is an optional layer. THE TWO MUST BE KEPT ALIGNED BY HAND. If you change
// how a list is parsed there, come here; if you change it here, go there. The
// thresholds are NOT expected to match: see the paragraph above.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import logger from '@overleaf/logger'
import { expressify } from '@overleaf/promise-utils'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import ProjectEntityHandler from '../../../../app/src/Features/Project/ProjectEntityHandler.mjs'
import DocumentUpdaterHandler from '../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs'
import EditorController from '../../../../app/src/Features/Editor/EditorController.mjs'

// ============================================================================
// PURE CORE. Everything from here to readProjectDocs() below is free of Overleaf
// internals and of the file system, which is what lets the test suite slice this
// region out of the real file and exercise the code that actually ships. Keep it
// that way: an import used here is an import the suite has to fake.
// ============================================================================

const MASTER_FIELD_SEPARATOR = '::'

// overleaf-lab: THE ONE LINE THE MODULE WRITES INTO THE DOCUMENT IN ITS OWN VOICE,
// and it had to be written with care. The compliance module ships a `work-markers`
// check that reads COMMENTS on purpose, and flags TODO, FIXME, XXX, HACK, TBD,
// TBU, a bracketed or colon-terminated TBC, "to do:" and "da fare:". A generated
// list whose own notice made the reviewer report the document as unfinished would
// be a self-inflicted finding, so the wording below stays in the neutral
// review/verify vocabulary and the suite pins it against that exact pattern.
//
// It is also the anchor for idempotence: the notice is written once, and a second
// run finds it already there and adds nothing.
const GENERATED_NOTICE =
    '% Some entries in this list were filled automatically from the module default list: review each definition before submission.'

// The largest document this module will read, and the largest project. A project
// is whatever a user uploads, so every loop below has to be bounded by something
// that is not the user's patience.
const MAX_DOC_CHARS = 600000
const MAX_DOCS = 400
const MAX_TOTAL_CHARS = 12000000
// The region under a list heading. A list that never closes must not turn a scan
// into a read of the whole file.
const MAX_REGION_CHARS = 60000
// How many rows one press may add. A document that would add more than this has
// something wrong with it (a corpus pasted into an appendix, a table of numbers
// read as maths), and burying the author under it helps nobody.
const MAX_NEW_ENTRIES = 300

// ----------------------------------------------------------------------------
// The master lists
// ----------------------------------------------------------------------------

// overleaf-lab: `SHORT :: english :: italian` and `symbol :: english :: italian ::
// unit`. Two files, one parser, because the only difference is the optional
// fourth field. Comments and blank lines are dropped; a line with no separator is
// dropped too rather than being read as an entry with no definition, since a line
// like that is a typo and not a declaration.
//
// LAST ONE WINS on a duplicate key. That is what would make an operator's own list
// an OVERRIDE if it were parsed after the default one, and it is also why the
// suite refuses duplicate keys inside a single shipped file: there, a duplicate is
// not an override, it is two people disagreeing in the same document.
function parseMasterList(text) {
    const entries = new Map()
    // These two files are meant to be EDITED by whoever runs the repo, so a typo in
    // them is a matter of when and not whether. One broken line must cost that line
    // and nothing else, and the count travels back so that a file quietly losing
    // half its entries is something the log can say out loud.
    let skipped = 0
    const lines = String(text ?? '').split('\n')
    for (const raw of lines) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const fields = line.split(MASTER_FIELD_SEPARATOR).map(field => field.trim())
        const key = fields[0]
        // A line with no separator is a typo and not a declaration; so is a key with
        // no definition in ANY language, which used to become an entry that said
        // nothing and, being "known to the master", let a single mention of it into
        // every list. An entry that has only the Italian column is legitimate.
        if (fields.length < 2 || !key || (!fields[1] && !fields[2])) {
            skipped += 1
            continue
        }
        entries.set(key, {
            en: fields[1] || '',
            it: fields[2] || '',
            unit: fields[3] || '',
        })
    }
    entries.skipped = skipped
    return entries
}

// The Italian column is optional by design: for an acronym the long form stays in
// English even in an Italian thesis, so most entries have nothing to say here and
// falling back to the English text is the correct answer, not a stopgap.
function masterDefinition(entry, language) {
    if (!entry) return ''
    if (language === 'it' && entry.it) return entry.it
    return entry.en || ''
}

// ----------------------------------------------------------------------------
// Text preparation
// ----------------------------------------------------------------------------

// Offset preserving on purpose: the same text is used both to FIND things (whose
// positions must still address the original document, because that is where rows
// get inserted) and to READ prose out of. Newlines survive so that line-based
// rules keep working.
function blankSpan(match) {
    return String(match).replace(/[^\n]/g, ' ')
}

// overleaf-lab: A COMMENT RUNS TO THE END OF ITS LINE, however long that is. The
// bound this used to carry (`[^\n]{0,4000}`) meant a comment of four thousand and
// one characters was stripped for four thousand of them and left standing for the
// rest, so a list heading parked past the bound inside a commented-out block was
// read as a real heading. indexOf has no such ceiling and is linear, which the
// bounded quantifier was not buying anything over.
function stripComments(text) {
    const source = String(text ?? '')
    let out = ''
    let at = 0
    for (;;) {
        const percent = findUnescapedPercent(source, at)
        if (percent === -1) return out + source.slice(at)
        const lineEnd = source.indexOf('\n', percent)
        const stop = lineEnd === -1 ? source.length : lineEnd
        out += source.slice(at, percent) + ' '.repeat(stop - percent)
        at = stop
    }
}

function findUnescapedPercent(source, from) {
    let at = from
    while (at < source.length) {
        const percent = source.indexOf('%', at)
        if (percent === -1) return -1
        // A backslash escapes the percent only when the backslash is not itself
        // escaped: `\%` is a literal, `\\%` starts a comment.
        let slashes = 0
        while (percent - slashes - 1 >= 0 && source[percent - slashes - 1] === '\\') slashes += 1
        if (slashes % 2 === 0) return percent
        at = percent + 1
    }
    return -1
}

// overleaf-lab: WHY EVERY WHITESPACE RUN BELOW IS CAPPED, AND WHY NO OPTIONAL ATOM
// SITS BETWEEN TWO OF THEM.
//
// `\s*\*?\s*\{` reads like "the command, optional star, the brace" and is a
// catastrophic backtracker: on a run of whitespace that is not followed by a
// brace, the engine tries every way of splitting the run between the first `\s*`
// and the second, which is quadratic in the run for every starting position. The
// pipeline that GET /lists runs, with READ access only, took 31 SECONDS on four
// kilobytes of whitespace, and NON_PROSE_ARGUMENT alone was cubic and never
// finished. stripComments manufactures exactly that input: it blanks a
// commented-out block into a solid run of spaces.
//
// Two rules, applied to every pattern in this file:
//
//   1. an optional atom never separates two whitespace runs. `\s*\*?\s*` becomes
//      `\s{0,40}(?:\*\s{0,40})?`, where the second run is reachable only after a
//      literal star, so there is nothing to split and nothing to backtrack.
//   2. every run is capped, and the two ceilings are a convention rather than
//      constants because a regex literal cannot interpolate one: `{0,40}` is what
//      may sit between a command and its argument, `{0,200}` is indentation the
//      module has to reproduce, which is looser because it gets copied into the
//      file.
//
// Anything longer than the cap simply does not match, which for LaTeX that a human
// wrote is not a case that exists. The suite keeps a ReDoS section with a payload
// and a time ceiling for every pattern here.

const MATHS_ENVIRONMENTS = [
    'equation', 'align', 'gather', 'multline', 'eqnarray', 'displaymath', 'flalign',
    'alignat', 'IEEEeqnarray', 'dmath', 'split',
]

const VERBATIM_ENVIRONMENTS = ['verbatim', 'lstlisting', 'minted', 'Verbatim', 'alltt']

// overleaf-lab: an environment walk. The obvious regex with a backreference cannot
// express "the same name with or without a star" without either missing half the
// cases or backtracking, so the scan is a plain loop: find a \begin, look for its
// \end with indexOf.
//
// THERE USED TO BE A DISTANCE CAP HERE AND IT WAS A HOLE. An environment whose
// \end sat further than MAX_ENV_CHARS away was reported as UNTERMINATED, and an
// unterminated environment is not blanked, so a 208 KB \begin{lstlisting} with a
// perfectly good \end was handed to the scan as ordinary document text: the module
// found the heading inside it and wrote its rows into the listing, which is the
// exact regression the verbatim guard exists to prevent. The cap bought nothing
// either, because indexOf has already scanned to the closer by the time the
// distance can be measured. Found is found.
function findEnvironments(text, names) {
    const found = []
    const alternatives = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const opener = new RegExp(`\\\\begin\\s{0,40}\\{(${alternatives})(\\*?)\\}`, 'g')
    let match
    while ((match = opener.exec(text)) !== null) {
        const name = match[1] + match[2]
        const bodyStart = match.index + match[0].length
        const closer = `\\end{${name}}`
        const closeAt = text.indexOf(closer, bodyStart)
        if (closeAt === -1) {
            found.push({ name, start: match.index, bodyStart, bodyEnd: bodyStart, end: bodyStart, terminated: false })
            continue
        }
        found.push({
            name,
            start: match.index,
            bodyStart,
            bodyEnd: closeAt,
            end: closeAt + closer.length,
            terminated: true,
        })
    }
    return found
}

// overleaf-lab: BUILT IN ONE PASS, and it has to stay that way. Re-slicing the
// whole string once per environment gives the same answer and is quadratic in the
// size of the file: 600 KB carrying 14000 short \begin{equation} blocks, which is
// a thing a student produces by accident, spent SIX SECONDS here, and the project
// cap allows twenty such documents. The web process is single threaded and this
// handler sits on it, so that is not a slow scan, it is an outage. The suite
// keeps a time budget on it.
// `blankUnterminated` decides which way to fail on a \begin whose \end never
// arrives, and the two callers want opposite answers:
//
//   VERBATIM, blanked to the end of the document. The question there is "may the
//   module write here", and an unclosed \begin{lstlisting} means everything after
//   it is inside a listing as far as anyone can tell. Losing the rest of the file
//   from the scan costs recall; getting it wrong costs somebody's appendix.
//
//   MATHS, blanked not at all. The question there is "where are the symbols", and
//   treating the rest of the document as one enormous equation would put every
//   letter of the remaining prose in the list of symbols.
function blankEnvironments(text, names, { blankUnterminated = false } = {}) {
    const found = findEnvironments(text, names).filter(env => env.terminated || blankUnterminated)
    if (found.length === 0) return text
    const pieces = []
    let at = 0
    for (const env of found) {
        // A nested environment sits inside one already blanked. Skipping it is the
        // same answer, since blanking blank text changes nothing.
        if (env.start < at) continue
        const end = env.terminated ? env.end : text.length
        pieces.push(text.slice(at, env.start), blankSpan(text.slice(env.start, end)))
        at = end
    }
    pieces.push(text.slice(at))
    return pieces.join('')
}

// Every shape maths can take. `$...$` is bounded to one line and to a sane length
// because an unbalanced dollar in a 400 KB file would otherwise swallow the rest
// of the document.
function blankMaths(text) {
    return blankEnvironments(
        String(text ?? '')
            .replace(/\$\$[\s\S]{0,20000}?\$\$/g, blankSpan)
            .replace(/\\\[[\s\S]{0,20000}?\\\]/g, blankSpan)
            .replace(/(?<!\\)\$[^$\n]{0,2000}?(?<!\\)\$/g, blankSpan),
        MATHS_ENVIRONMENTS
    )
}

// The arguments that are IDENTIFIERS and not prose: a label, a cite key, a file
// name, a URL, a package name. Reading them as text is how "PDF" in
// \includegraphics{PDF/figure} becomes an acronym the document never wrote.
//
// \texttt, \textbf and \emph are NOT here, unlike in the compliance module: a
// short form set in bold in a caption is still a use, and dropping those cost real
// entries. They are UNWRAPPED instead, one level, just below.
const NON_PROSE_ARGUMENT =
    /\\(?:label|ref|eqref|autoref|cref|Cref|vref|pageref|nameref|cite[a-zA-Z]{0,10}|includegraphics|input|include|includeonly|bibliography|bibliographystyle|addbibresource|usepackage|RequirePackage|documentclass|url|href|path|verb|lstinline|lstinputlisting|graphicspath|newcommand|renewcommand|providecommand|newenvironment|hypersetup|geometry|definecolor)\s{0,40}(?:\*\s{0,40})?(?:\[[^\]]{0,300}\]\s{0,40})?\{[^{}]{0,600}\}/g

// One level of text formatting, unwrapped rather than blanked, so that
// \textbf{ADCS} in a caption reads as ADCS and not as nothing. Length preserving:
// the command and the braces become spaces and the content stays where it was.
const TEXT_FORMATTING =
    /\\(?:textbf|textit|texttt|textsc|textsf|textrm|emph|underline|uline|mathrm|text)\s{0,40}\{([^{}]{0,600})\}/g

function unwrapTextFormatting(text) {
    return String(text ?? '').replace(TEXT_FORMATTING, (whole, inner) => {
        const pad = whole.length - inner.length
        const left = whole.length - inner.length - 1
        return `${' '.repeat(Math.max(0, left))}${inner}${' '.repeat(Math.max(0, pad - left))}`
    })
}

function proseOf(text) {
    return unwrapTextFormatting(
        blankEnvironments(blankMaths(stripComments(text)), VERBATIM_ENVIRONMENTS)
    ).replace(NON_PROSE_ARGUMENT, blankSpan)
}

// overleaf-lab: THE DOCUMENT AS OPPOSED TO WHAT THE DOCUMENT QUOTES. A thesis
// that shows LaTeX in an appendix contains the characters `\chapter*{List of
// Acronyms}` without containing a list of acronyms, and this module WRITES: it
// found that heading inside a code listing, read the fake table under it as the
// project's list, and spliced its generated rows into the middle of the appendix,
// where they typeset as code. The same mistake put the `\input` line of a newly
// created list inside a verbatim block, because an \input SHOWN in a listing is
// not an include either.
//
// Every structural question - which file is the list, which files are included,
// which acronyms the document DECLARES, where the maths is - is asked of this and
// not of the raw text. Prose already had the rule through proseOf; structure did
// not. Length preserving, so an offset found here still addresses the original.
function documentText(text) {
    return blankEnvironments(stripComments(text), VERBATIM_ENVIRONMENTS, { blankUnterminated: true })
}

// ----------------------------------------------------------------------------
// Reading order
// ----------------------------------------------------------------------------

// overleaf-lab: the file that IS the document. Everything else (which folder the
// new list goes in, where its \input belongs, which preamble to look at) hangs off
// this, so it is decided once and by one rule: the file that declares the class
// and opens the document body.
function findMainDoc(docs) {
    const withBoth = docs.filter(
        doc => /\\documentclass/.test(doc.text) && /\\begin\s{0,40}\{document\}/.test(doc.text)
    )
    if (withBoth.length > 0) return withBoth[0]
    const withClass = docs.filter(doc => /\\documentclass/.test(doc.text))
    return withClass[0] || null
}

// `\input{chapters/intro}` names a path relative to the MAIN file's folder, with
// the .tex left off more often than not. Both are normalised here so that an
// include can be matched against the project's own doc paths. A target that tries
// to climb out with `..` is refused rather than resolved: nothing in this module
// ever needs one, and the only thing such a path could do is address a file the
// scan was not meant to reach.
function resolveIncludePath(mainDir, target) {
    const cleaned = String(target || '').trim().replace(/^\.\//, '')
    if (!cleaned || cleaned.includes('..')) return null
    const base = cleaned.endsWith('.tex') ? cleaned : `${cleaned}.tex`
    const joined = `${mainDir}/${base}`.replace(/\/{2,}/g, '/')
    return joined.startsWith('/') ? joined : `/${joined}`
}

const INCLUDE_COMMAND = /\\(?:input|include|subfile|subfileinclude)\s{0,40}\{([^{}]{1,300})\}/g

// overleaf-lab: THE FILES THE SCAN MAY READ AT ALL. A .bib is DATA and not prose,
// and a .sty or a .cls is the template's own machinery rather than the author's
// writing. Reading them was wrong twice over:
//
//   - the publisher and organization fields of a bibliography put IEEE and AIAA
//     into a list of acronyms of a thesis whose text never writes either, and
//     forty English titles were enough function words to make detectDocumentLanguage
//     call an Italian thesis English, which is exactly what the README promises
//     cannot happen;
//   - a university style file that builds its front matter inside a macro
//     (\newcommand{\elencosimboli}{\chapter*{Elenco dei simboli}...}) was read as
//     the author's own list, and the module wrote its generated rows into the
//     middle of the template's .sty.
//
// The compliance module pays for the first half of this rule already (`isBib` and
// `sources()` in LLMStructuralChecks.mjs, written after a check told a student to
// spell out "IEEE" at /refs.bib:4). This module has to pay for MORE of it, and the
// divergence is deliberate: that module only reports, and this one writes into the
// project. The cost is a \newacronym declared inside a .sty, which is not read any
// more; see the known limits in the README.
const NOT_PROSE_FILE = /\.(?:bib|bbl|bst|cls|sty|aux|toc|lof|lot|log|out)$/i

// The order the READER meets the files in, which is the order an "already
// declared" question has to be answered in. Files nothing includes keep their
// place at the end rather than disappearing: a use inside a parked draft is still
// a use, and dropping it would silently shrink the scan.
function orderByInclusion(allDocs) {
    const docs = allDocs.filter(doc => !NOT_PROSE_FILE.test(doc.path))
    const main = findMainDoc(docs)
    if (!main) return docs.slice()
    const byPath = new Map(docs.map(doc => [doc.path, doc]))
    const mainDir = main.path.slice(0, main.path.lastIndexOf('/'))
    const ordered = []
    const seen = new Set()
    const walk = (doc, depth) => {
        if (!doc || seen.has(doc.path) || depth > 12 || ordered.length >= MAX_DOCS) return
        seen.add(doc.path)
        ordered.push(doc)
        for (const match of documentText(doc.text).matchAll(INCLUDE_COMMAND)) {
            const resolved = resolveIncludePath(mainDir, match[1])
            if (resolved && byPath.has(resolved)) walk(byPath.get(resolved), depth + 1)
        }
    }
    walk(main, 0)
    for (const doc of docs) if (!seen.has(doc.path)) ordered.push(doc)
    return ordered
}

// ----------------------------------------------------------------------------
// Which file is the list, and in which language
// ----------------------------------------------------------------------------

// overleaf-lab: GATING IS PER FILE, NEVER PER TEMPLATE. Nothing here knows the
// name of any university template, and nothing should: the code is public and the
// next project is somebody else's. A list exists when a FILE says it does, either
// by its name or by a heading inside it, and an internship report that carries no
// symbols file simply has no symbols list to update.
const LIST_KINDS = {
    acronyms: {
        topic: /acronim|acronym|abbreviaz|abbreviat|sigle|glossar/i,
        italian: /acronimi|abbreviazioni|sigle|glossario|elenco/i,
        english: /acronyms|abbreviations|glossary|list of/i,
        fileName: { it: 'acronimi.tex', en: 'acronyms.tex' },
        heading: { it: 'Elenco degli acronimi', en: 'List of Acronyms' },
    },
    symbols: {
        topic: /simbol|symbol|nomenclatur/i,
        italian: /simboli|nomenclatura|elenco/i,
        english: /symbols|nomenclature|list of/i,
        fileName: { it: 'simboli.tex', en: 'symbols.tex' },
        heading: { it: 'Elenco dei simboli', en: 'List of Symbols' },
    },
}

const SECTIONING_COMMAND = /\\(?:chapter|section|subsection|addchap|addsec)\s{0,40}(?:\*\s{0,40})?\{([^{}]{0,300})\}/g
const NEXT_SECTIONING = /\\(?:chapter|section|subsection|addchap|addsec|part)\s{0,40}(?:\*\s{0,40})?\{/

function baseName(docPath) {
    const cut = String(docPath || '').lastIndexOf('/')
    return cut === -1 ? String(docPath || '') : String(docPath).slice(cut + 1)
}

function dirName(docPath) {
    const cut = String(docPath || '').lastIndexOf('/')
    return cut <= 0 ? '' : String(docPath).slice(0, cut)
}

// Accents and case are folded away so that `Elenco_dei_Simboli.tex`,
// `elenco-simboli.tex` and `ELENCO SIMBOLI.tex` are the same name.
function foldName(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
}

// overleaf-lab: the language of the LIST, which is not necessarily the language of
// the document. A thesis written in Italian with an English "List of Symbols"
// heading wants English descriptions in that table, because that is the language
// the reader of that page is reading. The heading wins over the file name: a file
// called symbols.tex whose heading says "Elenco dei simboli" is an Italian list
// that somebody named in English.
function listLanguage(kind, headingTitle, docPath) {
    const config = LIST_KINDS[kind]
    for (const candidate of [headingTitle, baseName(docPath)]) {
        const folded = foldName(candidate)
        if (!folded) continue
        if (config.italian.test(folded)) return 'it'
        if (config.english.test(folded)) return 'en'
    }
    return 'en'
}

// The stretch of file the list occupies: from its heading to the next sectioning
// command, or the whole file when the list file has no heading of its own (a
// `simboli.tex` that is nothing but a table).
function findListRegion(text, kind) {
    const config = LIST_KINDS[kind]
    SECTIONING_COMMAND.lastIndex = 0
    for (const heading of text.matchAll(SECTIONING_COMMAND)) {
        const title = heading[1]
        if (!config.topic.test(foldName(title))) continue
        const from = heading.index + heading[0].length
        const ahead = text.slice(from, from + MAX_REGION_CHARS)
        const cut = ahead.search(NEXT_SECTIONING)
        return {
            headingStart: heading.index,
            headingTitle: title,
            start: from,
            end: cut === -1 ? Math.min(text.length, from + MAX_REGION_CHARS) : from + cut,
        }
    }
    return null
}

// `acronym` is the environment of the acronym package, and it is its own third
// shape: rows are `\acro{SHORT}{Long form}` commands, not cells and not items.
// A thesis that loads the package keeps its whole list in one, so a module that
// only knew tables told exactly those authors their list "has no table".
const CONTAINER_ENVIRONMENTS = [
    'longtable', 'tabular', 'tabularx', 'tabulary', 'xltabular', 'supertabular',
    'longtabu', 'tabu', 'description', 'itemize', 'acronym',
]

function readBracedArgument(text, openIndex, maxChars = 4000) {
    if (text[openIndex] !== '{') return null
    let depth = 0
    const limit = Math.min(text.length, openIndex + maxChars)
    for (let i = openIndex; i < limit; i += 1) {
        if (text[i] === '\\') {
            i += 1
            continue
        }
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') {
            depth -= 1
            if (depth === 0) return { value: text.slice(openIndex + 1, i), end: i }
        }
    }
    return null
}

// The column specification of a tabular-like environment: the braced group that
// follows, past the optional [t] placement and past the width argument tabularx
// takes. Counting columns is only ever used as a LAST resort, when the list is
// empty and there is no existing row to imitate.
function readColumnSpec(text, afterBegin) {
    let i = afterBegin
    let guard = 0
    while (i < text.length && guard++ < 8) {
        while (i < text.length && /\s/.test(text[i])) i += 1
        if (text[i] === '[') {
            const close = text.indexOf(']', i)
            if (close === -1) return null
            i = close + 1
            continue
        }
        if (text[i] !== '{') return null
        const group = readBracedArgument(text, i)
        if (!group) return null
        if (/[lcrpmbXY]/.test(group.value.replace(/[^A-Za-z]/g, ''))) {
            // `end` is what findContainer needs to know where the rows begin. There
            // used to be a `start` here that nothing ever read.
            return { spec: group.value, end: group.end }
        }
        i = group.end + 1
    }
    return null
}

// How many columns a spec declares: the column-type letters, ignoring everything
// that only decorates them (@{...}, |, >{...}, widths).
function countColumns(spec) {
    const cleaned = String(spec || '')
        .replace(/[@><!]\s{0,40}\{[^{}]{0,200}\}/g, ' ')
        .replace(/\{[^{}]{0,200}\}/g, ' ')
    return (cleaned.match(/[lcrpmbXY]/g) || []).length
}

// The environment the rows live in. The FIRST container inside the region is the
// list: a `center` wrapper around a longtable is stepped over because `center` is
// not a container, and anything after the first one belongs to whatever else the
// author put on the page.
function findContainer(text, region) {
    const slice = text.slice(region.start, region.end)
    const found = findEnvironments(slice, CONTAINER_ENVIRONMENTS).filter(env => env.terminated)
    if (found.length === 0) return null
    const env = found[0]
    const container = {
        name: env.name,
        start: region.start + env.start,
        bodyStart: region.start + env.bodyStart,
        bodyEnd: region.start + env.bodyEnd,
        end: region.start + env.end,
        columns: 0,
        isDescription: env.name === 'description' || env.name === 'itemize',
        isAcroEnv: env.name === 'acronym',
    }
    if (container.isAcroEnv) {
        // `\begin{acronym}[WYSIWYM]` carries the width sample as an optional
        // argument. It is part of the \begin line, not a row, and an EMPTY list
        // must not have the first generated row spliced into the middle of it.
        const ahead = /^\s{0,40}\[[^\]]{0,200}\]/.exec(
            text.slice(container.bodyStart, container.bodyStart + 300)
        )
        if (ahead) container.bodyStart += ahead[0].length
    } else if (!container.isDescription) {
        const spec = readColumnSpec(text, container.bodyStart)
        container.columns = spec ? countColumns(spec.spec) : 0
        // The spec is part of the \begin line, not of the body: rows start after it.
        if (spec) container.bodyStart = spec.end + 1
    }
    return container
}

// ----------------------------------------------------------------------------
// Rows: reading the ones that are there, writing the ones that are not
// ----------------------------------------------------------------------------

// A row terminator is `\\`, optionally with the `[.1mm]` a hand-typeset list uses
// to tighten the spacing. The LAST row of a hand-written table routinely drops it
// because nothing follows, so a trailing row with no terminator is accepted too.
const ROW_TERMINATOR = /\\\\\s{0,40}(?:\[[^\]]{0,40}\]\s{0,40})?$/
const ITEM_ROW = /^(\s{0,200}\\item\s{0,40}\[)([^\]]{0,200})(\]\s{0,40})([\s\S]{0,600})$/
// One row of an `acronym` environment. Groups mirror ITEM_ROW: open, key, the
// middle up to the long form (which keeps the author's column spacing and the
// optional [custom short] argument), value, close. `\acrodef` is accepted as a
// row too: it declares exactly like `\acro` and a list that uses it must not
// have its entries re-added under the other spelling.
// `(?:o|odef)` and not `o(?:def)?`: the suite's tripwire bans any optional atom
// glued to a whitespace run, harmless here or not, because the safe spellings
// are cheap and the dangerous ones all look exactly like the harmless ones.
const ACRO_ROW =
    /^(\s{0,200}\\acr(?:o|odef)\s{0,40}\{)([^{}]{1,200})(\}\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{)([^{}]{0,300})(\}\s{0,200})$/

function splitCells(row) {
    const cells = []
    let current = ''
    for (let i = 0; i < row.length; i += 1) {
        if (row[i] === '\\' && i + 1 < row.length) {
            current += row[i] + row[i + 1]
            i += 1
            continue
        }
        if (row[i] === '&') {
            cells.push(current)
            current = ''
            continue
        }
        current += row[i]
    }
    cells.push(current)
    return cells
}

const TEXT_WRAPPERS = new Set([
    'text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'textsc', 'emph',
    'mathrm', 'operatorname', 'mathop',
])

// The macros that DRESS a symbol without being one. Kept aligned with
// SYMBOL_WRAPPER_MACROS in the LLM module's structural checks.
const SYMBOL_WRAPPER_MACROS = new Set([
    'vec', 'mathbf', 'bm', 'boldsymbol', 'symbf', 'symbfup', 'hat', 'widehat',
    'tilde', 'widetilde', 'dot', 'ddot', 'bar', 'overline', 'underline', 'mathcal',
    'mathbb', 'mathfrak', 'mathit', 'mathsf', 'mathscr', 'ensuremath', 'left',
    'right', 'check', 'acute', 'grave', 'breve', 'boldmath',
])

const GREEK_COMMANDS = new Set([
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
    'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi',
    'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi',
    'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma',
    'Upsilon', 'Phi', 'Psi', 'Omega',
])

// The handful of non-greek commands that a list of symbols really does declare.
// Deliberately tiny: \times and \cdot are multiplication, \sum and \int are
// notation everybody shares, and proposing those would be the junk this module is
// supposed not to produce. These three are quantities or operators a thesis
// defines for itself.
const OPERATOR_SYMBOLS = new Set(['\\nabla', '\\otimes', '\\partial'])

// Nobody puts pi in a list of symbols, and a module that proposed it would be
// wrong in a way that is embarrassing rather than debatable.
const NEVER_A_LIST_SYMBOL = new Set(['\\pi', '\\varpi'])

// The letters a formula uses as a counter rather than as a quantity. Damped only
// when EVERY occurrence is a subscript or superscript: an "n" alone on the left of
// an equation is the size of something and belongs in the list, while the i of x_i
// is the index of a sum and belongs nowhere.
const DUMMY_INDEX_LETTERS = new Set(['i', 'j', 'k', 'n', 'm'])

// overleaf-lab: which token of a written symbol IS the symbol. `\dot{q}` is q,
// `\mathbf{R}_{ij}` is R, `\alpha_{max}` is alpha, `q_w` is q.
//
// THE BASE SYMBOL, NOT THE DECORATED ONE. A list of symbols declares `q` once and
// explains that a subscript names the component; it does not carry four rows for
// q_w, q_x, q_y and q_z. Folding to the base is also what makes the "is it already
// listed" test work against a curated list, which writes \mathbf{q} where the
// maths writes q_w.
//
// TWO KNOWN COLLAPSES, both deliberate. `\mathbb{R}` and `\mathbf{R}_{ij}` both
// reduce to R, and `SO(3)` and `SE(3)` both reduce to S. The consequence is always
// the same and always the safe one: the module believes the symbol is ALREADY in
// the list and adds nothing there.
function symbolToken(raw) {
    const source = String(raw ?? '')
        .replace(/\$/g, '')
        .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '')
        .trim()
    if (!source) return null
    // The delta idiom is one symbol, not two: nobody reads "\Delta v" as a delta
    // followed by a v. This is the only composite the module recognises.
    const delta = /^\\(Delta|delta)\s{0,40}(?:\{\s{0,40})?([A-Za-z])(?![A-Za-z])/.exec(source)
    if (delta) return `\\${delta[1]} ${delta[2]}`
    let i = 0
    let guard = 0
    while (i < source.length && guard++ < 60) {
        const ch = source[i]
        if (ch === '\\') {
            const command = /^\\([a-zA-Z]+)/.exec(source.slice(i))
            if (!command) {
                i += 1
                continue
            }
            i += command[0].length
            const name = command[1]
            if (TEXT_WRAPPERS.has(name)) {
                while (i < source.length && /\s/.test(source[i])) i += 1
                const arg = readBracedArgument(source, i, 200)
                // A word set in maths (\text{est}, \mathrm{sat}) is its own symbol
                // name; a single letter dressed as roman (\mathrm{M}) is that letter.
                if (arg && /[A-Za-z]{2,}/.test(arg.value)) return `\\${name}{${arg.value.trim()}}`
                continue
            }
            if (SYMBOL_WRAPPER_MACROS.has(name)) continue
            return `\\${name}`
        }
        if (/[A-Za-z]/.test(ch)) return ch
        i += 1
    }
    return null
}

// The identity of an acronym row: the short form with its typesetting removed.
// `\textbf{ADCS}` and `ADCS` are the same entry, and `TT\&C` is TT&C.
function acronymKey(raw) {
    return String(raw ?? '')
        .replace(
            /\\(?:textbf|texttt|textsc|textit|textsf|emph|mathrm|mathbf|bf|tt|sc)\s{0,40}\{([^{}]{0,200})\}/g,
            '$1'
        )
        .replace(/\\&/g, '&')
        .replace(/[${}]/g, '')
        .replace(/~/g, ' ')
        .trim()
        .replace(/[.,;:]+$/, '')
        .trim()
}

function entryKey(kind, cell) {
    return kind === 'symbols' ? symbolToken(cell) : acronymKey(cell) || null
}

// A cell can hold several entries at once (`q_x, q_y, q_z`, `\theta_E, \theta_R`,
// `LEO/MEO`). Each of them is registered so that a later scan does not propose one
// of them as missing from a list that plainly contains it.
function entryKeys(kind, cell) {
    const keys = []
    const push = key => {
        if (key && !keys.includes(key)) keys.push(key)
    }
    push(entryKey(kind, cell))
    const raw = String(cell)
    if (/[,/]/.test(raw)) {
        for (const piece of raw.split(/[,/]/)) push(entryKey(kind, piece))
    }
    return keys
}

// overleaf-lab: the rows of an existing list, with the exact text of each one and
// where each one starts. Nothing here rewrites a row; the offsets exist so that
// NEW rows can be inserted between them without a single existing character being
// touched.
function parseRows(text, container, kind) {
    const body = text.slice(container.bodyStart, container.bodyEnd)
    const rows = []
    let offset = container.bodyStart
    const lines = body.split('\n')
    // Where the last line with anything on it is, computed ONCE. The question it
    // answers, "is this the final row of the table", used to be asked by joining
    // every remaining line of the table together on every line of the table, which
    // is quadratic: a 60 KB table of unterminated rows spent three seconds in it.
    let lastContentLine = -1
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].trim()) {
            lastContentLine = index
            break
        }
    }
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const lineStart = offset
        offset += line.length + 1
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('%')) continue
        if (container.isAcroEnv) {
            const acro = ACRO_ROW.exec(line)
            if (!acro) continue
            rows.push({
                raw: line,
                start: lineStart,
                end: lineStart + line.length,
                cells: null,
                item: null,
                acro,
                keys: entryKeys(kind, acro[2]),
                hasValue: acro[4].trim().length > 0,
            })
            continue
        }
        if (container.isDescription) {
            const item = ITEM_ROW.exec(line)
            if (!item) continue
            rows.push({
                raw: line,
                start: lineStart,
                end: lineStart + line.length,
                cells: null,
                item,
                keys: entryKeys(kind, item[2]),
                hasValue: item[4].trim().length > 0,
            })
            continue
        }
        if (!/(?<!\\)&/.test(line)) continue
        const terminated = ROW_TERMINATOR.test(line)
        // A row with no terminator is only a row when it is the last thing in the
        // table; anywhere else it is a line that happens to carry an ampersand.
        if (!terminated && index < lastContentLine) continue
        const cells = splitCells(line.replace(ROW_TERMINATOR, ''))
        const filled = cells.map(cell => cell.trim())
        const keyCell = filled.findIndex(cell => cell.length > 0)
        if (keyCell === -1) continue
        let valueCell = -1
        for (let c = filled.length - 1; c > keyCell; c -= 1) {
            if (filled[c].length > 0) {
                valueCell = c
                break
            }
        }
        rows.push({
            raw: line,
            start: lineStart,
            end: lineStart + line.length,
            cells,
            item: null,
            keyCell,
            valueCell,
            keys: entryKeys(kind, cells[keyCell]),
            hasValue: valueCell !== -1,
        })
    }
    return rows
}

// ----------------------------------------------------------------------------
// Writing a row in the shape the file already uses
// ----------------------------------------------------------------------------

// overleaf-lab: the row the module imitates. The LAST complete row wins, because
// it is the one whose style the author settled on, and because "complete" (a key
// AND a description) is what makes both columns identifiable without guessing.
function chooseTemplate(rows) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].hasValue) return rows[i]
    }
    return rows.length > 0 ? rows[rows.length - 1] : null
}

// What surrounds the content of a cell: `\textbf{` ... `}`, `$ ` ... ` $`, or
// nothing at all. Imitating the shell is what makes a generated row look like a
// row the author typed, and it is why nothing here needs to know the difference
// between a `\textbf` list and a maths list.
function cellShell(content) {
    const wrapped =
        /^(\s{0,200}\\(?:textbf|texttt|textsc|textit|textsf|emph|mathbf|mathrm)\s{0,40}\{)([\s\S]{0,300})(\}\s{0,200})$/.exec(
            content
        )
    if (wrapped) return { prefix: wrapped[1], suffix: wrapped[3] }
    // Lazy on the content, so that the space a hand-typeset cell puts before its
    // closing dollar belongs to the SUFFIX and comes back on the generated row.
    // Greedy, the content swallowed it and every new row read `$ \mu$`.
    const maths = /^(\s{0,200}\$\s{0,40})([\s\S]{0,400}?)(\s{0,40}\$\s{0,200})$/.exec(content)
    if (maths) return { prefix: maths[1], suffix: maths[3] }
    const leading = /^\s*/.exec(content)[0]
    const trailing = /\s*$/.exec(content)[0]
    return { prefix: leading, suffix: content.trim() ? trailing : leading ? '' : ' ' }
}

// A symbol written outside maths mode does not compile. When the list being
// imitated puts its symbols in plain cells (some do) a generated token that
// carries a backslash is wrapped anyway: producing a file that does not build
// would be a worse kind of faithfulness.
function renderKey(kind, key, shell) {
    // An unescaped ampersand inside a table cell is a COLUMN SEPARATOR. Writing
    // TT&C into a longtable row both broke the table and broke idempotence: the
    // next run read the row back as two cells, did not recognise the entry, and
    // added it again for ever.
    if (kind !== 'symbols') return key.replace(/&/g, '\\&')
    if (shell.prefix.includes('$') || shell.prefix.includes('ensuremath')) return key
    if (!/[\\^_]/.test(key)) return key
    return `$${key}$`
}

// overleaf-lab: a unit with a superscript does not compile outside maths mode any
// more than a symbol does. Eight of the twenty-four units in the shipped list carry
// one (m^3/s^2, kg m^2/s, m/s^2, ...), and writing them into a plain cell produced
// a file that fails to build with "Missing $ inserted". Same rule as renderKey,
// same reason: producing a list that does not compile would be a worse kind of
// faithfulness than wrapping it.
function renderUnit(unit) {
    if (!unit) return ''
    return /[\\^_]/.test(unit) ? `$${unit}$` : unit
}

function buildRow(kind, template, key, definition) {
    if (!template) return null
    if (template.acro) {
        // The middle group is copied whole so the new row keeps the template's
        // column spacing, minus the optional [custom short] argument, which
        // belongs to THAT acronym and not to the new one.
        const open = template.acro[1]
        const mid = template.acro[3].replace(/\[[^\]]{0,200}\]\s{0,40}/, '')
        return `${open}${key.replace(/&/g, '\\&')}${mid}${definition}}`
    }
    if (template.item) {
        const open = template.item[1]
        const close = template.item[3]
        return `${open}${key}${close}${definition}`
    }
    const cells = template.cells.slice()
    const keyIndex = template.keyCell
    const valueIndex = template.valueCell
    const keyShell = cellShell(cells[keyIndex])
    cells[keyIndex] = `${keyShell.prefix}${renderKey(kind, key, keyShell)}${keyShell.suffix}`
    if (valueIndex !== -1) {
        const valueShell = cellShell(cells[valueIndex])
        cells[valueIndex] = `${valueShell.prefix}${definition}${valueShell.suffix}`
    }
    const terminator = ROW_TERMINATOR.exec(template.raw)
    return cells.join('&') + (terminator ? terminator[0] : ' \\\\')
}

// overleaf-lab: the fallback for a list that exists but is EMPTY, where there is
// no row to imitate. The three shapes below are the ones this repo has actually
// seen in theses, and each is written down here rather than guessed at run time:
//
//   2 columns   SHORT & Long form \\
//   3 columns   \textbf{SHORT} && Long form \\        (middle column is a gutter)
//   4 columns   & $ symbol $ &  & description \\      (first and third are gutters)
//
// Anything else refuses to invent a layout: the author writes one row by hand and
// every later press copies it exactly, which is a better deal than a table filled
// in the wrong columns.
//
// AND A CONTAINER THIS PARSER CANNOT READ IS NOT AN EMPTY ONE. `\item ADCS, the
// attitude system` carries a key and a definition and this module can see neither
// of them, so the list looked empty, a layout was invented, and `\item[ADCS] ...`
// went in underneath an entry that was plainly already there. Adding a second row
// for something already listed is the one thing the module promises never to do,
// so an item list with no labels at all is refused exactly as an unsupported
// column count is: one row written by hand unblocks every later press.
function hasUnlabelledItems(text, container) {
    if (!container.isDescription) return false
    return /\\item(?![ \t]*\[)/.test(text.slice(container.bodyStart, container.bodyEnd))
}

// The same promise, for the acronym environment: an `\acro` this parser could
// not read as a row (two on one line, a nested brace in the long form) is an
// entry that EXISTS, and writing next to entries it cannot see is how a module
// adds a duplicate. Comment lines are skipped exactly as parseRows skips them.
function hasUnreadAcroRows(text, container, rows) {
    if (!container.isAcroEnv) return false
    let declared = 0
    for (const line of text.slice(container.bodyStart, container.bodyEnd).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('%')) continue
        declared += (line.match(/\\acro(?:def)?(?![a-zA-Z@])/g) || []).length
    }
    return declared > rows.length
}

function templateForEmptyContainer(kind, container, indent) {
    if (container.isAcroEnv) {
        // Groups mirror ACRO_ROW the way the description template mirrors
        // ITEM_ROW: buildRow reads [1] and [3] and closes the row itself.
        return { acro: ['', `${indent}\\acro{`, '', '}{', '', '}'], cells: null, item: null, raw: '' }
    }
    if (container.isDescription) {
        return { item: ['', `${indent}\\item[`, '', '] ', ''], cells: null, raw: '' }
    }
    const columns = container.columns
    if (columns === 2) {
        return { cells: [`${indent}KEY `, ' VALUE '], keyCell: 0, valueCell: 1, raw: ' \\\\', item: null }
    }
    if (columns === 3) {
        return {
            cells: [`${indent}\\textbf{KEY}`, '', ' VALUE '],
            keyCell: 0,
            valueCell: 2,
            raw: ' \\\\',
            item: null,
        }
    }
    if (columns === 4) {
        return {
            cells: [indent, ' $ KEY $ ', '  ', ' VALUE '],
            keyCell: 1,
            valueCell: 3,
            raw: ' \\\\',
            item: null,
        }
    }
    return null
}

// ----------------------------------------------------------------------------
// Scanning the document for acronyms
// ----------------------------------------------------------------------------

// Every form that DECLARES an acronym with a package. Kept aligned with
// ACRONYM_DECLARATION in the LLM module. A declaration must never be read as a use
// of its own acronym, and its long form is worth having: it is the author's own
// wording, which beats anything a master list could offer.
const ACRONYM_DECLARATIONS = [
    { re: /\\acro\s{0,40}\{([^{}]{1,200})\}\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{([^{}]{0,300})\}/g, short: 1, long: 2 },
    {
        re: /\\newacronym\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{[^{}]{0,200}\}\s{0,40}\{([^{}]{1,200})\}\s{0,40}\{([^{}]{0,300})\}/g,
        short: 1,
        long: 2,
    },
]

// overleaf-lab: WIDE ON PURPOSE. A token is any run of letters and digits, which
// may carry an ampersand, a slash or a hyphen inside it, so that TT&C, LEO/MEO and
// R-T-N survive as themselves. What is and is not a short form is decided AFTER
// counting, by isAcronymCandidate, which is where the reasoning lives and where it
// can be read.
const ACRONYM_TOKEN = /(?<![\p{L}\p{N}_\\])([A-Za-z0-9][A-Za-z0-9&/-]{0,15}[A-Za-z0-9])(?![\p{L}\p{N}_])/gu

// An unknown token has to be used more than once. One is a passing mention, and
// even in recall-first mode a list built from single mentions is a list of
// everything. A token the master knows, or one the document DECLARES, gets in on
// the strength of one occurrence.
const MIN_UNKNOWN_ACRONYM_USES = 2

// Real words set in capitals, which is what a title page and a chapter heading are
// made of. The set is kept as small as it can be on purpose: padding it to quieten
// the scan would be hiding entries the list should carry. Roman numerals sit here
// too, because a document that writes "Part II" is not declaring an acronym.
const NOT_ACRONYMS = new Set([
    'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'XIII', 'XIV', 'XV',
    'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI',
    'NOTA', 'NOTE', 'NB', 'TESI', 'LAUREA', 'CORSO', 'ANNO', 'INDICE', 'PARTE',
    'CAPITOLO', 'APPENDICE', 'BIBLIOGRAFIA', 'SOMMARIO', 'ABSTRACT', 'INTRODUZIONE',
    'CONCLUSIONI', 'RINGRAZIAMENTI', 'RELATORE', 'CORRELATORE', 'CANDIDATO',
    'ACCADEMICO', 'UNIVERSITA', 'FACOLTA', 'ALMA', 'MATER', 'STUDIORUM',
    'THESIS', 'CHAPTER', 'SECTION', 'FIGURE', 'TABLE', 'APPENDIX', 'REFERENCES',
    'CONTENTS', 'CONCLUSION', 'INTRODUCTION', 'UNIVERSITY', 'DEPARTMENT', 'SCHOOL',
    'MASTER', 'DEGREE', 'SUPERVISOR', 'CANDIDATE', 'ACADEMIC', 'YEAR', 'PART',
    'THE', 'AND', 'FOR', 'WITH', 'FROM', 'THIS', 'THAT', 'NOT', 'ALL', 'ONE', 'TWO',
    'DI', 'IN', 'DEL', 'DELLA', 'PER', 'CON', 'NON', 'UNA',
])

// Units are written in capitals and are not short forms. Only the ones that
// actually survive the shape test are listed: kW and Hz never reach here.
const UNIT_TOKENS = new Set([
    'MHz', 'GHz', 'kHz', 'THz', 'dB', 'dBm', 'dBi', 'mAh', 'kWh', 'MWh', 'MPa',
    'GPa', 'kPa', 'Nm', 'kN', 'MN', 'kV', 'MV', 'kW', 'MW', 'GW', 'kJ', 'MJ', 'GJ',
    'KB', 'MB', 'GB', 'TB', 'RPM', 'AU',
])

// overleaf-lab: is this token a short form? Everything the scan casts wide is
// narrowed here, and only here.
//
//   - at least two capitals, and at least half the letters capital. That is what
//     tells DoF, CiA, IoU and ReLU6 apart from "Earth-Centred" and "Off-The-Shelf",
//     which carry capitals too but are words.
//   - OR one capital plus a digit in a token of at most four characters, which is
//     the L2 / TF2 / H2 shape. Longer than that and a digit means a part number.
//   - never eight capitals in a row: acronyms are short and words are long, so
//     SPACECRAFT and NAVIGATION in a heading stay out while CONOPS and RANSAC
//     stay in.
//   - never one letter repeated (AAA, III), never a unit, never a real word from
//     the small set above.
//
// A token the master list knows skips all of this: it is a short form because
// somebody wrote down that it is one.
function isAcronymCandidate(token) {
    if (token.length < 2 || token.length > 16) return false
    if (NOT_ACRONYMS.has(token) || NOT_ACRONYMS.has(token.toUpperCase())) return false
    if (UNIT_TOKENS.has(token)) return false
    // A compound is counted (see countAcronymTokens) but never proposed WHOLE
    // unless the master knows it, which is checked before this function is
    // reached. "LEO/MEO" is two entries the author already has words for, not a
    // third one; "Vision-Based" is not an entry at all.
    if (/[/-]/.test(token)) return false
    const letters = token.match(/[A-Za-z]/g) || []
    if (letters.length === 0) return false
    const capitals = token.match(/[A-Z]/g) || []
    const stripped = token.replace(/[^A-Za-z]/g, '')
    if (stripped.length > 1 && new Set(stripped.toUpperCase()).size === 1) return false
    if (capitals.length === letters.length && letters.length >= 8) return false
    if (capitals.length >= 2 && capitals.length / letters.length >= 0.5) return true
    if (capitals.length >= 1 && /[0-9]/.test(token) && token.length <= 4) return true
    return false
}

// A plural short form is the same entry as its singular: a document that writes
// "the CPOs of the mission" is using CPO. Folded only when the singular is
// something the module has other evidence for, so that GPS is never filed as GP.
function singularOf(token, master, counts) {
    const stem = /^([A-Za-z0-9&/-]{2,15}[A-Z0-9])s$/.exec(token)
    if (!stem) return null
    if (master.has(token)) return null
    const base = stem[1]
    if (master.has(base) || counts.has(base)) return base
    return null
}

// A line set in capitals is a title, and a title is prose too: this module reads
// it. Nothing here skips lines. The junk a title used to bring in is handled by
// NOT_ACRONYMS and by the eight-capital rule in isAcronymCandidate, which are
// narrower instruments than throwing the line away.
function countAcronymTokens(docs, blanked) {
    const counts = new Map()
    const bump = token => counts.set(token, (counts.get(token) || 0) + 1)
    for (const doc of docs) {
        const prose = (blanked.get(doc.path) ?? proseOf(doc.text)).replace(/\\&/g, '&')
        for (const match of prose.matchAll(ACRONYM_TOKEN)) {
            const token = match[1]
            bump(token)
            // A compound is proposed whole AND in pieces: LEO/MEO is an entry, and
            // so are LEO and MEO, and which of the three the author wants is the
            // author's business.
            if (/[/-]/.test(token)) {
                for (const piece of token.split(/[/-]/)) {
                    if (piece.length >= 2) bump(piece)
                }
            }
        }
    }
    return counts
}

function collectDeclaredAcronyms(docs) {
    const declared = new Map()
    for (const doc of docs) {
        // A \newacronym SHOWN in a code listing declares nothing.
        const text = documentText(doc.text)
        for (const form of ACRONYM_DECLARATIONS) {
            form.re.lastIndex = 0
            for (const match of text.matchAll(form.re)) {
                const short = match[form.short].trim()
                if (short) declared.set(short, match[form.long].trim())
            }
        }
    }
    return declared
}

// ----------------------------------------------------------------------------
// Scanning the document for symbols
// ----------------------------------------------------------------------------

// A lone letter or a greek command. Two adjacent letters are a word, not a symbol,
// which is the one rule that keeps a formula's \sin and \max out of the list.
const EQUATION_SYMBOL = /\\([a-zA-Z]+)|(?<![\\A-Za-z])([A-Za-z])(?![A-Za-z])/g
const MATHS_WORD_MACRO = /\\(?:text|textrm|mathrm|operatorname|mathop)\s{0,40}\{([^{}]{0,120})\}/g

// Every stretch of maths, inline and display alike. Reading display maths only was
// a precision choice this module deliberately reverses: a quantity a thesis
// introduces in a sentence, "the gain $k$ is tuned", belongs in the list of
// symbols as much as one that gets its own numbered equation.
function mathsSpans(text) {
    const spans = []
    for (const match of text.matchAll(/\$\$[\s\S]{0,20000}?\$\$|(?<!\\)\$[^$\n]{0,2000}?(?<!\\)\$|\\\[[\s\S]{0,20000}?\\\]/g)) {
        spans.push({ body: match[0], display: !match[0].startsWith('$') || match[0].startsWith('$$') })
    }
    for (const env of findEnvironments(text, MATHS_ENVIRONMENTS)) {
        if (!env.terminated) continue
        spans.push({ body: text.slice(env.bodyStart, env.bodyEnd), display: true })
    }
    return spans
}

function isSubscripted(text, index) {
    let i = index - 1
    while (i >= 0 && (text[i] === '{' || text[i] === ' ' || text[i] === '\t')) i -= 1
    return i >= 0 && (text[i] === '_' || text[i] === '^')
}

function collectSymbolUse(docs, blanked) {
    const candidates = new Map()
    const seenAnywhere = new Set()
    for (const doc of docs) {
        const text = blanked.get(`maths:${doc.path}`) ?? stripComments(doc.text)
        for (const span of mathsSpans(text)) {
            const body = span.body.replace(MATHS_WORD_MACRO, blankSpan)
            for (const token of body.matchAll(/\\[a-zA-Z]+|[A-Za-z]/g)) seenAnywhere.add(token[0])
            EQUATION_SYMBOL.lastIndex = 0
            let match
            let skipUntil = -1
            while ((match = EQUATION_SYMBOL.exec(body)) !== null) {
                if (match.index < skipUntil) continue
                let token = null
                if (match[1]) {
                    const command = `\\${match[1]}`
                    if (!GREEK_COMMANDS.has(match[1]) && !OPERATOR_SYMBOLS.has(command)) continue
                    token = command
                    // The delta idiom again: \Delta v is one symbol, and counting the
                    // v separately would put a bare "v" in the list of every document
                    // that writes a manoeuvre.
                    if (match[1] === 'Delta' || match[1] === 'delta') {
                        const ahead = /^\s{0,40}(?:\{\s{0,40})?([A-Za-z])(?![A-Za-z])/.exec(
                            body.slice(match.index + match[0].length)
                        )
                        if (ahead) {
                            token = `\\${match[1]} ${ahead[1]}`
                            skipUntil = match.index + match[0].length + ahead[0].length
                        }
                    }
                } else {
                    token = match[2]
                }
                if (!token || NEVER_A_LIST_SYMBOL.has(token)) continue
                let entry = candidates.get(token)
                if (!entry) {
                    if (candidates.size >= 1000) continue
                    entry = { count: 0, subscripts: 0, display: 0 }
                    candidates.set(token, entry)
                }
                entry.count += 1
                if (span.display) entry.display += 1
                if (isSubscripted(body, match.index)) entry.subscripts += 1
            }
        }
    }
    return { candidates, seenAnywhere }
}

// ----------------------------------------------------------------------------
// The plan: what would be added, what is kept
// ----------------------------------------------------------------------------

// Deterministic and locale independent. localeCompare would sort differently
// depending on which locale the container happens to boot with, and a list that
// reorders itself between two servers is not idempotent.
function compareKeys(a, b) {
    const x = String(a).toLowerCase()
    const y = String(b).toLowerCase()
    if (x < y) return -1
    if (x > y) return 1
    return 0
}

// Recurrence orders the REPORT: a symbol that turns up in six equations is the
// document's symbol and belongs at the top of what the author is asked to look at,
// while one that appears twice can wait. It never removes anything, which is the
// difference between ordering and filtering.
function byRelevance(a, b) {
    if (b.count !== a.count) return b.count - a.count
    return compareKeys(a.key, b.key)
}

// overleaf-lab: is this list alphabetical? Not "is it perfectly sorted": a
// hand-typed list of eighty acronyms always has a handful of slips (CiA filed
// before CCT, fps before FOV), and demanding perfection would send every real list
// down the append path. Four fifths in order is a list somebody meant to sort, and
// a new entry belongs at its letter. Below that the order means something else
// (grouped by theme, with comments between the groups, which is how symbol lists
// are written) and new rows go at the end where they cannot break the grouping.
function looksAlphabetical(keys) {
    if (keys.length < 4) return false
    let ordered = 0
    for (let i = 1; i < keys.length; i += 1) {
        if (compareKeys(keys[i - 1], keys[i]) <= 0) ordered += 1
    }
    return ordered / (keys.length - 1) >= 0.8
}

// The entries the scan could not find in the text, named ONCE each. A list that
// carries the same short form on three rows, which is what a list edited by two
// people over a year looks like, reported it three times: "Kept, although the
// scan could not find them in the text: ADCS, ADCS, ADCS".
function keptOnce(rows, isUnused) {
    const kept = []
    for (const row of rows) {
        const key = row.keys[0]
        if (!key || kept.includes(key)) continue
        if (isUnused(key)) kept.push(key)
    }
    return kept
}

// overleaf-lab: one press adds at most MAX_NEW_ENTRIES rows, and the plan has to
// SAY SO. Silently handing back the first three hundred is how an author ends up
// believing the list is complete when it is not, and it is also where the promise
// that "twice in a row changes nothing" quietly stops being true: with the cap
// biting, the second press adds the next three hundred. Reported, that is a
// feature and the panel can tell the author to press again; unreported, it is a
// lie about what the button did.
function cappedPlan(additions, unusedKept) {
    return {
        additions: additions.slice(0, MAX_NEW_ENTRIES),
        unusedKept,
        remaining: Math.max(0, additions.length - MAX_NEW_ENTRIES),
    }
}

function planAcronyms({ rows, tokenCounts, declared, master, language }) {
    const present = new Set()
    for (const row of rows) for (const key of row.keys) present.add(key)
    const additions = []
    const seen = new Set()
    const propose = (key, definition, count) => {
        if (!key || present.has(key) || seen.has(key)) return
        seen.add(key)
        additions.push({ key, definition, count })
    }
    // A package declaration is the author's own wording and beats the master.
    for (const [short, long] of declared) {
        propose(short, long || masterDefinition(master.get(short), language), tokenCounts.get(short) || 1)
    }
    for (const [token, count] of tokenCounts) {
        // A UNIT IS NOT A SHORT FORM, AND THE MASTER DOES NOT GET A VOTE ON THAT.
        // The master is consulted before isAcronymCandidate, so an entry that was
        // also a unit walked straight past the rule that exists to keep units out:
        // "AU" was in both, and every document that wrote an astronomical unit got
        // it proposed as an acronym. The shipped list no longer carries that entry,
        // and this is what stops the next one somebody adds.
        if (UNIT_TOKENS.has(token)) continue
        const entry = master.get(token)
        if (entry) {
            // The master knows it is a short form; one use is enough and the
            // definition is right by construction.
            propose(token, masterDefinition(entry, language), count)
            continue
        }
        const singular = singularOf(token, master, tokenCounts)
        if (singular) {
            const known = master.get(singular)
            propose(
                singular,
                masterDefinition(known, language),
                (tokenCounts.get(singular) || 0) + count
            )
            continue
        }
        // A token nobody has ever defined has to look like a short form and be used
        // like one. It arrives with an EMPTY description: the author is the only one
        // who knows what it stands for.
        if (count < MIN_UNKNOWN_ACRONYM_USES) continue
        if (!isAcronymCandidate(token)) continue
        propose(token, '', count)
    }
    const unusedKept = keptOnce(rows, key => !tokenCounts.has(key) && !declared.has(key))
    additions.sort(byRelevance)
    return cappedPlan(additions, unusedKept)
}

function planSymbols({ rows, use, master, language }) {
    const present = new Set()
    for (const row of rows) for (const key of row.keys) present.add(key)
    const additions = []
    for (const [token, entry] of use.candidates) {
        if (present.has(token)) continue
        // A letter that is ALWAYS an index is an index. One that stands on its own
        // even once is a quantity.
        if (DUMMY_INDEX_LETTERS.has(token) && entry.subscripts >= entry.count) continue
        const known = master.get(token)
        // THE ONE ANTI-JUNK RULE LEFT FOR SYMBOLS: a lone lowercase latin letter
        // that the whole document writes once is a variable somebody needed for one
        // line, not a symbol of the work. Everything else - capitals, greek,
        // operators, anything the master knows - gets in on one occurrence.
        if (!known && /^[a-z]$/.test(token) && entry.count < 2) continue
        additions.push({
            key: token,
            definition: masterDefinition(known, language),
            // Carried through so that a list this module CREATES can print it. A
            // merge into somebody else's table does not: see buildNewListFile.
            unit: (known && known.unit) || '',
            count: entry.count,
        })
    }
    const unusedKept = keptOnce(rows, key => !use.seenAnywhere.has(key) && !use.candidates.has(key))
    additions.sort(byRelevance)
    return cappedPlan(additions, unusedKept)
}

// ----------------------------------------------------------------------------
// Applying the plan to the file
// ----------------------------------------------------------------------------

function indentOf(line) {
    return /^[ \t]*/.exec(line)[0]
}

function lineStartAt(text, index) {
    const previous = text.lastIndexOf('\n', Math.max(0, index - 1))
    return previous === -1 ? 0 : previous + 1
}

// overleaf-lab: THE ONE FUNCTION THAT MUST NEVER TOUCH AN EXISTING CHARACTER. It
// only ever splices whole new lines between existing ones, so every row that was
// in the file before is in the file after, byte for byte. Splices are applied from
// the bottom up so that the offsets computed against the original text stay valid
// while they are being used.
function applyAdditions(text, container, rows, additions, kind) {
    if (additions.length === 0) return { text, inserted: 0 }
    const endLineStart = lineStartAt(text, container.bodyEnd)
    const indent = rows.length > 0 ? indentOf(rows[0].raw) : `${indentOf(text.slice(endLineStart))}    `
    let template = chooseTemplate(rows)
    if (!template && hasUnlabelledItems(text, container)) return { text, inserted: 0, unsupported: true }
    // Unlike the unlabelled-items case this one refuses even WITH a template:
    // the rows the parser did read are not the problem, the ones it did not are.
    if (hasUnreadAcroRows(text, container, rows)) return { text, inserted: 0, unsupported: true }
    if (!template) template = templateForEmptyContainer(kind, container, indent)
    if (!template) return { text, inserted: 0, unsupported: true }
    // A file written on Windows ends every line with a carriage return. The
    // generated ROWS inherit it from the row they imitate, because the terminator
    // is copied whole; the notice imitates nothing and has to be told, and so does
    // a row built for a container that was empty. One LF line in a CRLF file is
    // what this fixes.
    const carriage = /\r\n/.test(text) ? '\r' : ''
    const withCarriage = line => (carriage && !line.endsWith('\r') ? `${line}${carriage}` : line)
    const alphabetical = looksAlphabetical(rows.map(row => row.keys[0] || '').filter(Boolean))
    // The file is written in alphabetical order whatever order the report is in:
    // the report is sorted by relevance, the FILE is sorted the way a list is read.
    const ordered = additions.slice().sort((a, b) => compareKeys(a.key, b.key))
    const splices = []
    for (const addition of ordered) {
        const rendered = buildRow(kind, template, addition.key, addition.definition)
        if (rendered === null) continue
        let at = endLineStart
        if (alphabetical) {
            for (const row of rows) {
                const key = row.keys[0]
                if (key && compareKeys(key, addition.key) > 0) {
                    at = row.start
                    break
                }
            }
        }
        splices.push({ at, line: withCarriage(rendered) })
    }
    // overleaf-lab: a template whose row has a key and NO second cell (a list whose
    // every entry is still waiting for its definition) gives buildRow nowhere to
    // put one, and it used to drop the text without a word: the panel reported
    // "filled from the default list: RAAN, EKF" and the file got two bare keys.
    // The row is still worth adding; the silence was the defect.
    const definitionsDropped =
        !template.item && template.valueCell === -1 && additions.some(addition => addition.definition)
    if (splices.length === 0) return { text, inserted: 0, definitionsDropped }
    // The notice goes in ONCE, at the head of the list, and only if it is not
    // already there: that is what keeps a second run byte-identical.
    if (!text.includes(GENERATED_NOTICE)) {
        const at = alphabetical ? lineStartAt(text, rows.length > 0 ? rows[0].start : container.bodyEnd) : endLineStart
        splices.push({ at, line: withCarriage(`${indent}${GENERATED_NOTICE}`), notice: true })
    }
    // Stable by position; at equal positions the notice goes first so it stays at
    // the head of the block it introduces.
    splices.sort((a, b) => a.at - b.at || (a.notice ? -1 : 0) - (b.notice ? -1 : 0))
    let out = text
    for (let i = splices.length - 1; i >= 0; i -= 1) {
        out = `${out.slice(0, splices[i].at)}${splices[i].line}\n${out.slice(splices[i].at)}`
    }
    return { text: out, inserted: splices.filter(splice => !splice.notice).length, definitionsDropped }
}

// ----------------------------------------------------------------------------
// Creating a list that does not exist yet
// ----------------------------------------------------------------------------

const BABEL_LANGUAGE = /\\usepackage\s{0,40}\[([^\]]{0,300})\]\s{0,40}\{(?:babel|polyglossia)\}/
const POLYGLOSSIA_MAIN = /\\setdefaultlanguage\s{0,40}\{([^{}]{0,40})\}/
const DOCUMENTCLASS_OPTIONS = /\\documentclass\s{0,40}\[([^\]]{0,300})\]/

const ITALIAN_STOPWORDS = /\b(?:il|lo|la|gli|del|della|degli|delle|che|per|non|con|una|come|sono|nella|dei|alla)\b/g
const ENGLISH_STOPWORDS = /\b(?:the|of|and|to|in|is|that|for|with|this|are|from|which|been|has)\b/g

// overleaf-lab: which language the DOCUMENT is written in, asked only when a list
// has to be created from nothing and there is no heading to read it off. The
// preamble is believed first because it is a declaration and not an inference; the
// word count is the fallback, and it is deliberately a count of function words,
// which is the one thing that cannot be faked by a bibliography full of English
// titles in an Italian thesis.
//
// The answer is only ever a DEFAULT for the dialog. The author picks.
function detectDocumentLanguage(docs) {
    const main = findMainDoc(docs)
    if (main) {
        const preamble = stripComments(main.text).split(/\\begin\s{0,40}\{document\}/)[0]
        const polyglossia = POLYGLOSSIA_MAIN.exec(preamble)
        if (polyglossia) return /ital/i.test(polyglossia[1]) ? 'it' : 'en'
        const babel = BABEL_LANGUAGE.exec(preamble)
        if (babel) {
            // babel makes the LAST option the main language, which is exactly the
            // case a thesis hits: [english,italian] is an Italian document that can
            // quote English, not an English one.
            const options = babel[1].split(',').map(option => option.trim()).filter(Boolean)
            const last = options[options.length - 1] || ''
            if (/ital/i.test(last)) return 'it'
            if (/english|british|american/i.test(last)) return 'en'
        }
        const classOptions = DOCUMENTCLASS_OPTIONS.exec(preamble)
        if (classOptions) {
            if (/\bitalian\b/i.test(classOptions[1])) return 'it'
            if (/\benglish\b/i.test(classOptions[1])) return 'en'
        }
    }
    let italian = 0
    let english = 0
    for (const doc of docs) {
        const prose = proseOf(doc.text).toLowerCase().slice(0, MAX_DOC_CHARS)
        italian += (prose.match(ITALIAN_STOPWORDS) || []).length
        english += (prose.match(ENGLISH_STOPWORDS) || []).length
    }
    return italian > english ? 'it' : 'en'
}

// article-like classes have no \chapter, and a generated file that calls one does
// not compile. The check is on the class name because that is the only thing that
// decides it.
function sectioningLevel(docs) {
    const main = findMainDoc(docs)
    const declared = main ? /\\documentclass\s{0,40}(?:\[[^\]]{0,300}\]\s{0,40})?\{([^{}]{0,60})\}/.exec(main.text) : null
    const name = declared ? declared[1].trim().toLowerCase() : ''
    if (/^(?:article|scrartcl|amsart|ieeetran|acmart|elsarticle|revtex|paper)/.test(name)) return 'section'
    return 'chapter'
}

// The file name is built HERE, from the kind and the chosen language, and from
// nothing else. No part of a request ever reaches a path: the two kinds and the
// two languages are four names, all of them written in this file.
function newListFileName(kind, language) {
    // An OWN property and not an inherited one. `LIST_KINDS['constructor']` is the
    // Object constructor, which is truthy, and the next line threw a TypeError on
    // it. The route can never deliver that kind (kindOf gates it with the same
    // test) but a function whose whole job is "no request ever reaches a path"
    // should not depend on somebody else's guard to avoid a 500.
    if (!Object.prototype.hasOwnProperty.call(LIST_KINDS, kind)) return null
    const config = LIST_KINDS[kind]
    return language === 'it' ? config.fileName.it : config.fileName.en
}

// Where the new file belongs: beside the other front matter when the project has
// some, next to the main file otherwise. "Front matter" is recognised by name, in
// both languages, and the OTHER list counts as the best evidence of all.
const FRONT_MATTER_NAMES =
    /^(?:abstract|sommario|ringraziamenti|acknowledg|dedica|dedication|frontmatter|prefazione|preface|acronimi|acronyms|simboli|symbols|nomenclatur|abbreviazioni|abbreviations|sigle)/

function chooseFolder(docs, otherListPath) {
    if (otherListPath) return dirName(otherListPath)
    for (const doc of docs) {
        if (FRONT_MATTER_NAMES.test(foldName(baseName(doc.path).replace(/\.tex$/, '')))) {
            return dirName(doc.path)
        }
    }
    const main = findMainDoc(docs)
    return main ? dirName(main.path) : ''
}

// The two column layouts of the reference files, written out once. These are the
// shapes the module has to be able to READ anyway, so generating them keeps one
// vocabulary instead of two. The notice sits above the rows, inside the
// environment, so that it travels with the block it introduces and so that a later
// merge finds it and does not write a second one.
function buildNewListFile({ kind, language, entries, sectioning, indentUnit = '    ' }) {
    const config = LIST_KINDS[kind]
    const heading = language === 'it' ? config.heading.it : config.heading.en
    const lines = []
    lines.push(`\\${sectioning}*{${heading}}`)
    lines.push(`\\addcontentsline{toc}{${sectioning}}{${heading}}`)
    lines.push('')
    if (kind === 'acronyms') {
        lines.push('\\begin{longtable}[t]{ m{4em} m{3em} m{25em} }')
        lines.push(`${indentUnit}${GENERATED_NOTICE}`)
        for (const entry of entries) {
            lines.push(`${indentUnit}\\textbf{${entry.key}} && ${entry.definition} \\\\`)
        }
        lines.push('\\end{longtable}')
    } else {
        // overleaf-lab: THE THIRD COLUMN IS THE UNIT COLUMN, and it is a unit column
        // because this function is the one deciding the layout. The master list
        // carries a unit for fifty of its seventy-odd symbols and nothing was ever
        // printing them, which made both the data file's header and the README say
        // something untrue.
        //
        // It is filled HERE and NOT in buildRow, and that asymmetry is the point: a
        // merge writes into a table somebody else designed, where the module's own
        // README calls the narrow middle column a gutter. Guessing that a column it
        // did not design means "unit" and typing m^3/s^2 into it is exactly the kind
        // of invention this module refuses everywhere else. Widened from 1cm, which
        // was too narrow for the units this list actually carries.
        lines.push('\\begin{center}')
        lines.push(`${indentUnit}\\begin{longtable}[t]{ m{1em} m{7em} m{4em} m{10cm} }`)
        lines.push(`${indentUnit}${indentUnit}${GENERATED_NOTICE}`)
        for (const entry of entries) {
            lines.push(
                `${indentUnit}${indentUnit}& $ ${entry.key} $ & ${renderUnit(entry.unit)} & ${entry.definition} \\\\[.1mm]`
            )
        }
        lines.push(`${indentUnit}\\end{longtable}`)
        lines.push('\\end{center}')
    }
    lines.push('')
    return lines.join('\n')
}

// ----------------------------------------------------------------------------
// Hooking the new file into the document
// ----------------------------------------------------------------------------

const CHAPTER_INPUT = /(?:chap|capitol|cap[0-9_-]|introduzione|introduction)/i

// overleaf-lab: WHERE AN \input MAY BE INSERTED AUTOMATICALLY, and where it may
// not. The rule is not "find a plausible spot": it is "act only where there is
// exactly one right answer, and otherwise say so".
//
//   adjacent      the OTHER list is already included somewhere. Its neighbour is
//                 the only place the new list can belong, and the author put it
//                 there themselves.
//   before-main   the document has a \mainmatter, or a first chapter. Front matter
//                 goes before it by definition, after the abstract and the table
//                 of contents that already sit there.
//   manual        anything else. The file is created and the exact line to paste
//                 is handed to the author. Guessing here would put a list of
//                 symbols in the middle of chapter three, and undoing that is a
//                 worse afternoon than pasting one line.
//
// The returned index is a character offset at the START of a line, which is the
// only kind of insertion this module ever performs.
function planMainInsertion({ docs, mainDoc, inputLine, otherListPath }) {
    if (otherListPath) {
        const mainDir = mainDoc ? dirName(mainDoc.path) : ''
        for (const doc of docs) {
            // An \input SHOWN in a listing is not an include, and anchoring on one
            // put the new list's own \input line inside a verbatim block.
            const text = documentText(doc.text)
            for (const match of text.matchAll(INCLUDE_COMMAND)) {
                if (resolveIncludePath(mainDir, match[1]) !== otherListPath) continue
                const start = lineStartAt(doc.text, match.index)
                const lineEnd = doc.text.indexOf('\n', match.index)
                return {
                    mode: 'adjacent',
                    path: doc.path,
                    at: lineEnd === -1 ? doc.text.length : lineEnd + 1,
                    indent: indentOf(doc.text.slice(start)),
                    line: inputLine,
                }
            }
        }
    }
    if (!mainDoc) return { mode: 'manual', line: inputLine }
    const text = documentText(mainDoc.text)
    const bodyAt = text.search(/\\begin\s{0,40}\{document\}/)
    if (bodyAt === -1) return { mode: 'manual', line: inputLine }
    const body = text.slice(bodyAt)
    const mainMatter = /\\mainmatter\b/.exec(body)
    if (mainMatter) {
        const at = lineStartAt(mainDoc.text, bodyAt + mainMatter.index)
        return { mode: 'before-main', path: mainDoc.path, at, indent: '', line: inputLine }
    }
    let firstChapter = -1
    for (const match of body.matchAll(INCLUDE_COMMAND)) {
        if (!CHAPTER_INPUT.test(match[1])) continue
        firstChapter = bodyAt + match.index
        break
    }
    if (firstChapter === -1) {
        const chapter = /\\chapter\s{0,40}(?:\*\s{0,40})?\{/.exec(body)
        if (chapter) firstChapter = bodyAt + chapter.index
    }
    if (firstChapter === -1) return { mode: 'manual', line: inputLine }
    const at = lineStartAt(mainDoc.text, firstChapter)
    return {
        mode: 'before-main',
        path: mainDoc.path,
        at,
        indent: indentOf(mainDoc.text.slice(at)),
        line: inputLine,
    }
}

// The generated tables are longtables, so the package has to be there. It is
// inserted at the only place a package can go, which is why this is not a guess;
// and it is only inserted at all when the \input was inserted too, because a run
// that promised not to touch the main file must not touch it for this either.
const LONGTABLE_PROVIDERS = /\\(?:usepackage|RequirePackage)\s{0,40}(?:\[[^\]]{0,200}\]\s{0,40})?\{[^{}]{0,200}(?:longtable|xltabular|ltablex|ltxtable|longtabu)[^{}]{0,200}\}/

function planPackageInsertion(mainDoc) {
    if (!mainDoc) return null
    const text = documentText(mainDoc.text)
    const preamble = text.split(/\\begin\s{0,40}\{document\}/)[0]
    if (LONGTABLE_PROVIDERS.test(preamble)) return null
    const beginAt = text.search(/\\begin\s{0,40}\{document\}/)
    if (beginAt === -1) return null
    return { path: mainDoc.path, at: lineStartAt(mainDoc.text, beginAt), line: '\\usepackage{longtable}' }
}

// The \input argument: the path of the new file relative to the main file's
// folder, without the extension, which is how LaTeX wants it and how every
// existing include in these projects is written.
function includeTarget(mainDoc, newPath) {
    const mainDir = mainDoc ? dirName(mainDoc.path) : ''
    let relative = newPath
    if (mainDir && newPath.startsWith(`${mainDir}/`)) relative = newPath.slice(mainDir.length + 1)
    else if (newPath.startsWith('/')) relative = newPath.slice(1)
    return relative.replace(/\.tex$/, '')
}

// Several edits to the same document become ONE write. Two writes to the same doc
// would race with each other through the document updater, and the second one
// would be computed against a text the first one has already changed.
function applyLineInsertions(text, insertions) {
    const ordered = insertions.slice().sort((a, b) => b.at - a.at)
    // The main file gets the line terminator the main file already uses, for the
    // same reason a generated row does.
    const carriage = /\r\n/.test(text) ? '\r' : ''
    let out = text
    for (const insertion of ordered) {
        out = `${out.slice(0, insertion.at)}${insertion.indent || ''}${insertion.line}${carriage}\n${out.slice(insertion.at)}`
    }
    return out
}


// The blanked forms every scan shares, computed once per project. Two scans that
// blank the same document differently is how two answers about the same file end
// up disagreeing.
function prepare(docs, listRegions) {
    const blanked = new Map()
    for (const doc of docs) {
        let prose = proseOf(doc.text)
        // An \begin{equation} inside a verbatim block is a picture of an equation,
        // not one: reading it put the symbols of a code sample in the list.
        let maths = documentText(doc.text)
        for (const region of listRegions.get(doc.path) || []) {
            prose = prose.slice(0, region.start) + blankSpan(prose.slice(region.start, region.end)) + prose.slice(region.end)
            maths = maths.slice(0, region.start) + blankSpan(maths.slice(region.start, region.end)) + maths.slice(region.end)
        }
        blanked.set(doc.path, prose)
        blanked.set(`maths:${doc.path}`, maths)
    }
    return blanked
}

// overleaf-lab: find the list file of one kind, if the project has one. This is
// the gate: no file, no merge. A project whose template never carried a list of
// symbols (an internship report, for one) gets a clear "there is none" and the
// offer to create one, and never a file written behind the author's back.
function locateList(docs, kind) {
    const config = LIST_KINDS[kind]
    for (const doc of docs) {
        const text = documentText(doc.text)
        const region = findListRegion(text, kind)
        const nameMatches = config.topic.test(foldName(baseName(doc.path).replace(/\.tex$/, '')))
        if (!region && !nameMatches) continue
        const effective =
            region || { headingStart: 0, headingTitle: '', start: 0, end: Math.min(text.length, MAX_REGION_CHARS) }
        const container = findContainer(text, effective)
        const language = listLanguage(kind, effective.headingTitle, doc.path)
        if (!container) return { doc, region: effective, container: null, language, rows: [] }
        return { doc, region: effective, container, language, rows: parseRows(doc.text, container, kind) }
    }
    return null
}

function regionsByPath(located) {
    const regions = new Map()
    for (const found of located) {
        if (!found) continue
        const list = regions.get(found.doc.path) || []
        list.push({ start: found.region.headingStart, end: found.region.end })
        regions.set(found.doc.path, list)
    }
    return regions
}

// One scan, both kinds, so that a status request and an update request can never
// disagree about the same project.
function scanProject(docs) {
    const located = {
        acronyms: locateList(docs, 'acronyms'),
        symbols: locateList(docs, 'symbols'),
    }
    const blanked = prepare(docs, regionsByPath([located.acronyms, located.symbols]))
    return {
        located,
        blanked,
        tokenCounts: countAcronymTokens(docs, blanked),
        declared: collectDeclaredAcronyms(docs),
        symbolUse: collectSymbolUse(docs, blanked),
    }
}


// overleaf-lab: THE NAMES A NEW FILE MAY NOT BE WRITTEN TO, answered from every
// path the PROJECT has and not from the docs the SCAN happened to read. The two
// are not the same list: readProjectDocs drops a file with nothing in it and
// stops at the project caps, so a `simboli.tex` past the four hundredth document
// was invisible to the guard, and creating a list would have upserted straight
// over it. Overwriting a file the author already wrote is precisely what promise
// number two exists to prevent.
//
// A file with NOTHING in it is deliberately not an obstacle: an author who made
// an empty simboli.tex and pressed the button wants it filled in, and refusing
// there would leave them with a dialog that offers to create a list and a server
// that says the name is taken.
// A project holds DOCS (text Overleaf edits) and FILES (everything uploaded:
// images, PDFs, a .bib dropped in rather than typed). Both occupy a name, and
// asking only the docs is how a create could have upserted a doc on top of an
// uploaded file's path. The compliance controller reads both the same way.
function occupiedPaths(docsByPath, filesByPath) {
    const taken = new Set()
    for (const [docPath, value] of Object.entries(docsByPath || {})) {
        if (!value) continue
        if (!(value.lines || []).join('\n').trim()) continue
        taken.add(docPath)
    }
    for (const [filePath, ref] of Object.entries(filesByPath || {})) {
        if (ref) taken.add(filePath)
    }
    return taken
}

// overleaf-lab: THE WHOLE READING POLICY, in one pure function, so that the suite
// can drive it with a project instead of taking the handlers' word for it.
//
// Note `truncated`. A document longer than MAX_DOC_CHARS is read only as far as
// the cap, and the merge then writes the text it worked on back over the document:
// that is a silent deletion of everything past 600 000 characters, on a press the
// author believes only ADDS rows. The flag travels with the doc so the handlers
// can refuse, and refusing is the only correct answer, because the module cannot
// merge into text it has not read.
function prepareDocs(docsByPath, filesByPath) {
    const docs = []
    let total = 0
    for (const [docPath, value] of Object.entries(docsByPath || {})) {
        if (!value || docs.length >= MAX_DOCS || total >= MAX_TOTAL_CHARS) continue
        const text = (value.lines || []).join('\n')
        if (!text.trim()) continue
        const capped = text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text
        total += capped.length
        docs.push({
            path: docPath,
            id: String(value._id),
            text: capped,
            truncated: capped.length < text.length,
        })
    }
    return { docs: orderByInclusion(docs), taken: occupiedPaths(docsByPath, filesByPath) }
}

// The names travel WHOLE, split into the ones that arrived with a definition and
// the ones that did not. The panel shortens the display; the payload never
// shortens anything, so a user who wants the full list can read the response and a
// later feature can use it without another scan.
function summarise(plan, applied) {
    return {
        // Only the merge can know this: it depends on the shape of the row being
        // imitated, which the plan never sees.
        definitionsDropped: Boolean(applied && applied.definitionsDropped),
        added: plan.additions.map(entry => ({
            key: entry.key,
            definition: entry.definition,
            count: entry.count,
        })),
        addedWithDefinition: plan.additions.filter(entry => entry.definition).map(entry => entry.key),
        addedWithoutDefinition: plan.additions.filter(entry => !entry.definition).map(entry => entry.key),
        unusedKept: plan.unusedKept,
        // What one press could not fit. The panel turns this into "press the button
        // again for the rest"; zero is the ordinary case and says nothing.
        truncated: (plan.remaining || 0) > 0,
        remaining: plan.remaining || 0,
    }
}


// ============================================================================
// END OF THE PURE CORE. Everything below talks to Overleaf.
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(HERE, '../../data')

const masterCache = new Map()

// overleaf-lab: the shipped default lists, read once and kept. They are DATA, not
// configuration: whoever runs this repo is expected to edit the two files in
// data/, and a restart is all it takes. A missing or unreadable file is not fatal
// - the feature still works, every new entry simply arrives with an empty
// description - because a list the author fills in by hand is the fallback the
// whole design already supports.
function loadMaster(kind) {
    if (masterCache.has(kind)) return masterCache.get(kind)
    const file = path.join(DATA_DIR, kind === 'symbols' ? 'symbols-master.txt' : 'acronyms-master.txt')
    // Parsed from an empty string rather than `new Map()`, so that `.skipped` is a
    // number on every path including the one where the file could not be read.
    let parsed = parseMasterList('')
    try {
        parsed = parseMasterList(fs.readFileSync(file, 'utf8'))
        if (parsed.skipped > 0) {
            logger.warn(
                { file, skipped: parsed.skipped, entries: parsed.size },
                '[lists] the master list has lines that are not entries; they were skipped'
            )
        }
    } catch (err) {
        logger.warn({ err, file }, '[lists] could not read the master list; definitions will be empty')
    }
    masterCache.set(kind, parsed)
    return parsed
}

// overleaf-lab: getAllDocs reads the DOCSTORE, which is Mongo's copy of the
// project. A document open in somebody's editor lives in the document updater's
// Redis until it is flushed, so the docstore copy can be behind by whatever has
// been typed since. Reading a stale copy and then writing our merge over the whole
// document would revert those keystrokes, which is the one failure mode of this
// module that the author would experience as data loss rather than as a bad list.
//
// So the project is flushed first. The call is GUARDED and never fatal: this
// module cannot verify outside the container which methods DocumentUpdaterHandler
// exposes, and a missing flush is a smaller problem than a feature that refuses to
// run. See the post-deploy checks in the README: whether the flush is really there
// is the first thing to confirm on a live instance.
async function flushBeforeReading(projectId) {
    const flush = DocumentUpdaterHandler.promises?.flushProjectToMongo
    if (typeof flush !== 'function') {
        logger.warn({ projectId }, '[lists] no flushProjectToMongo available; reading the docstore as it stands')
        return
    }
    try {
        await flush.call(DocumentUpdaterHandler.promises, projectId)
    } catch (err) {
        logger.warn({ projectId, err }, '[lists] could not flush the project before reading')
    }
}

async function readProjectDocs(projectId) {
    await flushBeforeReading(projectId)
    const docsByPath = await ProjectEntityHandler.promises.getAllDocs(projectId)
    let filesByPath = {}
    try {
        filesByPath = await ProjectEntityHandler.promises.getAllFiles(projectId)
    } catch (err) {
        // Only the "is this name free" answer is poorer for it, and it fails safe
        // in the direction of offering a name that turns out to be taken.
        logger.warn({ projectId, err }, '[lists] cannot list project files; names will be checked against docs only')
    }
    return prepareDocs(docsByPath, filesByPath)
}
function planFor(kind, scan, rows, language) {
    if (kind === 'symbols') {
        return planSymbols({ rows, use: scan.symbolUse, master: loadMaster('symbols'), language })
    }
    return planAcronyms({
        rows,
        tokenCounts: scan.tokenCounts,
        declared: scan.declared,
        master: loadMaster('acronyms'),
        language,
    })
}

function writeDoc(projectId, docId, userId, text) {
    return DocumentUpdaterHandler.promises.setDocument(projectId, docId, userId, text.split('\n'), 'lists')
}


// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

function kindOf(req) {
    const kind = String(req.params.kind || '')
    return Object.prototype.hasOwnProperty.call(LIST_KINDS, kind) ? kind : null
}

// overleaf-lab: an English sentence beside every machine code. The panel keeps its
// own wording, which is longer and tells the author what to do next; this is what
// anything else that ever calls these routes gets to read, and it is what the
// panel falls back to for a code it has not been taught. An error that travels as
// a bare code and renders as "something went wrong" is one nobody can act on.
const ERROR_MESSAGES = {
    unknown_list: 'There is no list of that kind. The two kinds are "acronyms" and "symbols".',
    no_list_file: 'The project has no list file of this kind.',
    no_list_container:
        'The list file has no table, description list or acronym environment to add rows to.',
    unsupported_layout:
        'The layout of this list is not one the module can write into. Add one entry by hand in the shape you want and press the button again: every later row copies it.',
    document_too_large:
        'That file is too large for this module to read in full, and it will not rewrite a document it has only partly read. Nothing was written.',
    list_already_exists: 'A list of this kind already exists in the project. Nothing was written.',
    file_exists: 'A file with that name already exists in the project. Nothing was written.',
}

function fail(res, code, error, extra = {}) {
    return res.status(code).json({ ok: false, error, message: ERROR_MESSAGES[error], ...extra })
}

async function status(req, res) {
    const projectId = req.params.Project_id
    const { docs } = await readProjectDocs(projectId)
    if (docs.length === 0) {
        // The SAME SHAPE as any other answer, one entry per kind. Returning an empty
        // `lists` object made the panel render nothing at all for a project with no
        // documents, or for one that is nothing but a .bib: no lists, no buttons, no
        // explanation, and no way for the author to tell that from a broken feature.
        const lists = {}
        for (const kind of Object.keys(LIST_KINDS)) {
            lists[kind] = { available: false, canCreate: false, reason: 'empty_project' }
        }
        return res.json({ ok: true, documentLanguage: 'en', lists })
    }
    const lists = {}
    for (const kind of Object.keys(LIST_KINDS)) {
        const found = locateList(docs, kind)
        if (!found) {
            lists[kind] = { available: false, canCreate: true, reason: 'no_list_file' }
        } else if (found.doc.truncated) {
            // Said HERE and not only when the button is pressed, so the author is
            // not offered an action that is going to be refused.
            lists[kind] = {
                available: false,
                canCreate: false,
                reason: 'document_too_large',
                path: found.doc.path,
                language: found.language,
            }
        } else if (!found.container) {
            lists[kind] = {
                available: false,
                canCreate: false,
                reason: 'no_list_container',
                path: found.doc.path,
                language: found.language,
            }
        } else {
            lists[kind] = {
                available: true,
                canCreate: false,
                path: found.doc.path,
                language: found.language,
                entries: found.rows.length,
            }
        }
    }
    res.json({ ok: true, documentLanguage: detectDocumentLanguage(docs), lists })
}

async function update(req, res) {
    const kind = kindOf(req)
    if (!kind) return fail(res, 400, 'unknown_list')
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    const dryRun = req.body?.dryRun === true
    // The scan is redone HERE, on every call. A dry run computes a plan and shows
    // it, and the document can change between the two: the author adds the entry by
    // hand in the other tab, or writes a new chapter. Nothing of the preview
    // survives into this request, so a stale plan cannot be applied.
    const { docs } = await readProjectDocs(projectId)
    const scan = scanProject(docs)
    const found = scan.located[kind]
    if (!found) return fail(res, 409, 'no_list_file')
    // The merge rewrites the WHOLE document, and a document read only as far as
    // MAX_DOC_CHARS would come back missing everything past it. Nothing about the
    // list is worth deleting the second half of a chapter for.
    if (found.doc.truncated) return fail(res, 409, 'document_too_large', { path: found.doc.path })
    if (!found.container) return fail(res, 409, 'no_list_container', { path: found.doc.path })
    const plan = planFor(kind, scan, found.rows, found.language)
    const applied = applyAdditions(found.doc.text, found.container, found.rows, plan.additions, kind)
    if (applied.unsupported) {
        return fail(res, 409, 'unsupported_layout', { path: found.doc.path })
    }
    const wrote = !dryRun && applied.inserted > 0
    if (wrote) {
        await writeDoc(projectId, found.doc.id, userId, applied.text)
        logger.info({ projectId, kind, path: found.doc.path, added: applied.inserted }, '[lists] list updated')
    }
    res.json({
        ok: true,
        mode: 'update',
        kind,
        path: found.doc.path,
        language: found.language,
        existingEntries: found.rows.length,
        wrote,
        ...summarise(plan, applied),
    })
}

async function create(req, res) {
    const kind = kindOf(req)
    if (!kind) return fail(res, 400, 'unknown_list')
    // The language is the ONLY thing the request decides, and it decides it out of
    // two fixed values. The file name is built from it by newListFileName, in this
    // file, from constants in this file: nothing a request carries ever reaches a
    // path.
    const language = req.body?.language === 'it' ? 'it' : 'en'
    const dryRun = req.body?.dryRun === true
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    const { docs, taken } = await readProjectDocs(projectId)
    const scan = scanProject(docs)
    if (scan.located[kind]) {
        // Either the author created it in another tab while this dialog was open, or
        // the dialog was stale. Both are the same answer: do not overwrite anything.
        return fail(res, 409, 'list_already_exists', { path: scan.located[kind].doc.path })
    }
    const other = kind === 'acronyms' ? 'symbols' : 'acronyms'
    const otherListPath = scan.located[other] ? scan.located[other].doc.path : null
    const plan = planFor(kind, scan, [], language)
    const fileName = newListFileName(kind, language)
    const folder = chooseFolder(docs, otherListPath)
    const candidate = `${folder}/${fileName}`.replace(/\/{2,}/g, '/')
    const target = candidate.startsWith('/') ? candidate : `/${candidate}`
    if (taken.has(target)) {
        return fail(res, 409, 'file_exists', { path: target })
    }
    const mainDoc = findMainDoc(docs)
    const inputLine = `\\input{${includeTarget(mainDoc, target)}}`
    let hookup = planMainInsertion({ docs, mainDoc, inputLine, otherListPath })
    // The hook up rewrites the whole document it inserts into, so a document read
    // only in part must not be one of them. The list file itself is still created:
    // it is new, nothing can be lost writing it, and the author gets the line to
    // paste with a reason attached instead of a create that refuses outright.
    const hookTarget = hookup.mode === 'manual' ? null : docs.find(doc => doc.path === hookup.path)
    if (hookTarget && hookTarget.truncated) {
        hookup = { mode: 'manual', line: inputLine, reason: 'document_too_large', path: hookTarget.path }
    }
    const packageInsertion = hookup.mode === 'manual' ? null : planPackageInsertion(mainDoc)
    const content = buildNewListFile({
        kind,
        language,
        entries: plan.additions.slice().sort((a, b) => compareKeys(a.key, b.key)),
        sectioning: sectioningLevel(docs),
    })
    if (!dryRun) {
        await EditorController.promises.upsertDocWithPath(projectId, target, content.split('\n'), 'lists', userId)
        // Both edits to the SAME document travel in one write.
        const insertions = new Map()
        const push = item => {
            if (!item || !item.path) return
            const list = insertions.get(item.path) || []
            list.push(item)
            insertions.set(item.path, list)
        }
        push(hookup.mode === 'manual' ? null : hookup)
        push(packageInsertion ? { ...packageInsertion, indent: '' } : null)
        for (const [docPath, items] of insertions) {
            const doc = docs.find(entry => entry.path === docPath)
            if (!doc) continue
            await writeDoc(projectId, doc.id, userId, applyLineInsertions(doc.text, items))
        }
        logger.info(
            { projectId, kind, path: target, hookup: hookup.mode, entries: plan.additions.length },
            '[lists] list created'
        )
    }
    res.json({
        ok: true,
        mode: 'create',
        kind,
        path: target,
        language,
        existingEntries: 0,
        wrote: !dryRun,
        hookup: {
            mode: hookup.mode,
            path: hookup.path || null,
            line: inputLine,
            packageLine: packageInsertion ? packageInsertion.line : null,
            reason: hookup.reason || null,
        },
        ...summarise(plan),
    })
}

export default {
    status: expressify(status),
    update: expressify(update),
    create: expressify(create),
}
