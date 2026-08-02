// overleaf-lab: does the bibliography point at works that exist, and at the works it
// claims?
//
// THE PROBLEM THIS IS FOR. A language model asked for references produces entries that
// are typographically perfect and bibliographically empty: right journal, plausible
// authors, a DOI in the right shape. Nothing in the LaTeX source can tell them apart
// from real ones, so every check in LLMStructuralChecks stops at "the entry carries an
// author, a title and a year" - which a fabricated entry does, by construction. The
// only way to tell is to ask somebody who holds the record.
//
// RESOLUTION IS NOT THE CHECK. A fabricated DOI is often a real DOI: the model copies
// the prefix of a real journal and invents the suffix, and one suffix in a busy prefix
// lands on somebody else's paper. So the check is RESOLVE AND MATCH: the record that
// comes back has to be the work the entry describes, or the entry is pointing the
// reader somewhere else.
//
// WHAT IT NEVER DOES. It never says "fabricated", it never produces a verdict, and it
// never turns a failure of ours into a fault of the student's. Every line it writes is
// a fact about what a public API answered ("Crossref has no record for DOI 10.x/y"),
// and anything that could not be asked about is reported as NOT CHECKED, by name and
// by count. A network that is down must be able to make this section smaller, never
// harsher.
//
// OFF BY DEFAULT. A review that reaches the public internet is a different thing from
// one that reads the project, so it does not happen because a module was deployed: it
// happens because an administrator set a contact address (see BIB_VERIFY_MAILTO_ENV),
// which is also what Crossref's polite pool asks for. With no address there is no
// network access of any kind and the result carries `enabled: false` with a reason, so
// the review can report the check as NOT RUN. Silence here must never read as a pass.
//
// Attribution: the metadata comes from the Crossref REST API
// (https://api.crossref.org, https://www.crossref.org/documentation/retrieve-metadata/rest-api/),
// used inside its polite pool. Existence of a DOI is confirmed against the Handle
// System proxy at https://doi.org/api/handles, which is registry-agnostic. Both are
// public, unauthenticated and free; both are asked politely and sparingly.
//
// PURE AND PORTABLE. No Overleaf imports, no project state, no institution knowledge:
// entries in, JSON out, `fetch` injectable. That is what lets the suite drive every
// branch of it offline.

// overleaf-lab: the one environment variable. Its VALUE is the contact address
// Crossref asks callers to put in the User-Agent so it can reach whoever is generating
// the traffic; its PRESENCE is the opt-in. One variable, so "is this instance allowed
// on the network" has exactly one answer and no way to be half true.
export const BIB_VERIFY_MAILTO_ENV = 'LLM_BIB_VERIFY_MAILTO'

// The polite-pool User-Agent. Crossref routes callers who identify themselves onto a
// pool with better and more predictable service; callers who do not are throttled with
// everybody else. The name says what the traffic is, so an operator who sees it in
// their logs can tell.
const USER_AGENT_PRODUCT = 'overleaf-lab-compliance-review/1.0'

const CROSSREF_WORKS = 'https://api.crossref.org/works'
const DOI_HANDLE_API = 'https://doi.org/api/handles'

// overleaf-lab: bounds on the traffic ONE review may generate. A bibliography is
// student-supplied and can hold a thousand entries; a review is started by clicking a
// button. Without a cap, one click is a thousand requests at somebody else's expense,
// and repeated clicks are an attack on a service that is doing us a favour.
//
// The cap is on REQUESTS, not on entries, and it is spent in the order the entries
// appear, so what gets checked is deterministic and the report can say "checked N of
// M" truthfully instead of implying the whole bibliography was seen.
export const LIMITS = {
    // Hard ceiling on HTTP requests per review, retries included.
    maxRequests: 60,
    // In flight at once. Two is enough to hide the latency of one slow answer and low
    // enough to stay invisible to the far end.
    concurrency: 2,
    // Sustained rate: one request per second, whatever the concurrency does.
    minRequestIntervalMs: 1000,
    // Per request. Crossref answers in a few hundred milliseconds; ten seconds is the
    // point where waiting stops being useful to anybody.
    requestTimeoutMs: 10000,
    // Bounds on what is STORED and shown. Every capped list is reported next to its
    // true total: a cap the reader cannot see is a lie about how much was found.
    findings: 25,
    unchecked: 20,
    // Longest title carried into a finding or a query.
    titleChars: 220,
    // Longest entry body walked for field values. bibEntries already caps what it
    // hands over; this is the guard for any other caller.
    entryChars: 8000,
}

// overleaf-lab: the bands of the title comparison, and why there are three of them.
//
// Two titles for the same work are almost never the same string: the .bib carries
// LaTeX braces and accent commands, the record carries Unicode; one side has the
// subtitle and the other does not; a publisher stores "Part I" and the student does
// not. String equality would report a mismatch on most correct entries, which would
// make the whole section worthless within one report.
//
// So similarity is measured on normalised tokens, and the middle is NOT forced into a
// decision. Above `match` the record is the work and nothing is reported. Below
// `mismatch` the two are about different things and that is stated, with both titles
// quoted so the reader checks it in a second. Between them the answer is "I could not
// tell", which is reported as exactly that and is never a violation.
export const SIMILARITY = {
    match: 0.65,
    mismatch: 0.35,
}

// A title with fewer distinct content tokens than this cannot DISAGREE with anything:
// "Deep learning" overlaps half the corpus, and a title our parser truncated looks
// exactly like a short one. Short titles can still confirm a match, they just cannot
// produce an accusation.
const MIN_TITLE_TOKENS = 3

// Containment rescues the subtitle case ("Attention and memory" against "Attention and
// memory: a review"), where one side simply carries more of the same title. It is only
// trusted when the shorter side is long enough for "fully contained" to mean
// something; below that, two generic words would match any paper that used them.
const MIN_TOKENS_FOR_CONTAINMENT = 4

// A preprint and its published version are routinely a year apart, so "the same year"
// has to mean "within one".
const YEAR_TOLERANCE = 1

// arXiv's own DOI prefix. It is registered with DataCite, not Crossref, so Crossref
// answers 404 for it; that is a fact about which registry holds the record and says
// nothing at all about the entry.
const ARXIV_DOI_PREFIX = /^10\.48550\//i

// ---------------------------------------------------------------------------
// the opt-in gate
// ---------------------------------------------------------------------------

// Deliberately strict about the shape: the address is sent to a third party on every
// request, and a placeholder like "changeme" or a stray shell quote would identify
// this instance as somebody who cannot be reached, which is worse than not being in
// the polite pool at all.
const CONTACT_ADDRESS = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[a-z]{2,}$/i

export function bibVerifyContact(env = process.env) {
    const raw = String((env && env[BIB_VERIFY_MAILTO_ENV]) || '').trim()
    return CONTACT_ADDRESS.test(raw) ? raw : ''
}

export function isBibVerifyEnabled(env = process.env) {
    return bibVerifyContact(env) !== ''
}

function disabledResult(total, reason) {
    return {
        enabled: false,
        reason,
        checked: 0,
        total,
        requests: 0,
        waitedMs: 0,
        findings: [],
        unchecked: [],
        uncheckedByReason: {},
        totals: { findings: { shown: 0, total: 0 }, unchecked: { shown: 0, total: 0 } },
    }
}

// ---------------------------------------------------------------------------
// reading an entry
// ---------------------------------------------------------------------------
//
// THE EXPECTED INPUT, which is also the contract with the caller:
//
//   { key, type, fields, file, line, body }
//
//   key    the citation key, as written after "@article{"          (string, required)
//   type   the entry type, lowercased ("article", "misc", ...)     (string, optional)
//   fields field name -> field value; a Map or a plain object      (optional)
//   file   the path the entry was read from, for the report        (string, optional;
//                                                                   `path` is accepted)
//   line   1-based line of "@type{" inside that file               (number, optional)
//   body   the raw text of the entry, "@article{...}"              (string, optional)
//
// `fields` and `body` are both optional and both are used, because the parser this
// module is wired to (the bibFields walk in LLMStructuralChecks) answers a different
// question from ours: it decides whether a field is PRESENT, so it cuts every value at
// eighty characters and at the first comma, which is exactly what a title must not be
// cut at. When `body` is here the values are re-read from it, untruncated; `fields`
// then fills in anything the body did not hold (a Zotero entry whose abstract pushes
// the title past a capped body). Nothing is imported from that parser: this module
// takes parsed entries and has no opinion on who parsed them.
//
// A truncated title cannot produce an accusation either way: see MIN_TITLE_TOKENS, and
// note that containment treats "our title is a prefix of theirs" as agreement.

const FIELDS_OF_INTEREST = new Set([
    'title',
    'author',
    'year',
    'date',
    'doi',
    'eprint',
    'archiveprefix',
    'eprinttype',
    'url',
    'journal',
    'journaltitle',
    'booktitle',
    'howpublished',
    'note',
])

// Read one field value starting at `from`: braced, quoted or bare. Returns where it
// ended so the caller can carry on walking without re-entering the value.
function readValue(text, from) {
    let i = from
    while (i < text.length && /\s/.test(text[i])) i += 1
    if (text[i] === '{') {
        const start = i
        let depth = 0
        for (; i < text.length; i++) {
            if (text[i] === '{') depth += 1
            else if (text[i] === '}') {
                depth -= 1
                if (depth === 0) {
                    i += 1
                    break
                }
            }
        }
        // A value whose braces never close ends at the end of what we were given,
        // which is the honest reading and, more to the point, terminates.
        const closed = depth === 0
        return { text: text.slice(start + 1, closed ? i - 1 : text.length), end: i }
    }
    if (text[i] === '"') {
        const start = i
        i += 1
        while (i < text.length && !(text[i] === '"' && text[i - 1] !== '\\')) i += 1
        return { text: text.slice(start + 1, i), end: Math.min(i + 1, text.length) }
    }
    const start = i
    while (i < text.length && !/[,}\n]/.test(text[i])) i += 1
    return { text: text.slice(start, i), end: i }
}

// Field names live at brace depth 1: inside the entry, outside every value. A flat
// scan finds "name = value" inside an abstract as well and reads whatever follows it
// as a field, which is how an entry gets a title nobody wrote.
export function collectFields(body) {
    const found = new Map()
    const text = String(body || '').slice(0, LIMITS.entryChars)
    let depth = 0
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === '{') {
            depth += 1
            continue
        }
        if (ch === '}') {
            depth -= 1
            continue
        }
        if (depth !== 1 || !/[a-zA-Z]/.test(ch)) continue
        const m = /^([a-zA-Z]+)\s*=\s*/.exec(text.slice(i, i + 40))
        if (!m) {
            // Skip the rest of the word, so "author" is not re-tested at "uthor".
            while (i + 1 < text.length && /[a-zA-Z]/.test(text[i + 1])) i += 1
            continue
        }
        const name = m[1].toLowerCase()
        const value = readValue(text, i + m[0].length)
        if (FIELDS_OF_INTEREST.has(name) && !found.has(name)) {
            found.set(name, value.text.trim())
        }
        i = Math.max(i, value.end - 1)
    }
    return found
}

function fromCallerFields(fields, name) {
    if (!fields) return ''
    if (typeof fields.get === 'function') {
        return String(fields.get(name) || '')
    }
    if (typeof fields === 'object') {
        for (const key of Object.keys(fields)) {
            if (key.toLowerCase() === name) return String(fields[key] || '')
        }
    }
    return ''
}

// Strip what a caller's parser may have left around the value: the delimiters
// themselves, and the trailing comma of the field.
function unwrapValue(raw) {
    let value = String(raw || '').trim()
    value = value.replace(/,\s*$/, '')
    while (
        (value.startsWith('{') && value.endsWith('}')) ||
        (value.startsWith('"') && value.endsWith('"'))
    ) {
        value = value.slice(1, -1).trim()
    }
    // A value that only OPENS a delimiter is a value somebody truncated. Keeping the
    // stray brace would put it in a quotation the student reads.
    return value.replace(/^[{"]/, '').trim()
}

export function readEntry(entry) {
    const source = entry && typeof entry === 'object' ? entry : {}
    const walked = source.body ? collectFields(source.body) : new Map()
    const field = name => {
        const fromBody = walked.get(name)
        if (fromBody) return unwrapValue(fromBody)
        return unwrapValue(fromCallerFields(source.fields, name))
    }
    return {
        key: String(source.key || '').trim() || '(unnamed entry)',
        type: String(source.type || '').toLowerCase(),
        file: String(source.file || source.path || ''),
        line: Number.isFinite(source.line) ? source.line : null,
        title: field('title'),
        author: field('author'),
        year: readYear(field('year') || field('date')),
        // A DOI is written in a `doi` field, and, just as often in a real .bib, only
        // inside the `url`, the `note` or the `howpublished` of an entry pasted from a
        // publisher page. `doiRaw` keeps whether the entry CLAIMED one, so an entry
        // whose DOI we could not read is reported as unread rather than as absent.
        doi: readDoi(field('doi') || field('url') || field('note') || field('howpublished')),
        doiRaw: field('doi'),
        eprint: field('eprint'),
        archive: field('archiveprefix') || field('eprinttype'),
        url: field('url'),
        venue: field('journal') || field('journaltitle') || field('booktitle'),
    }
}

// ---------------------------------------------------------------------------
// normalising text: LaTeX in, comparable tokens out
// ---------------------------------------------------------------------------

// The accent commands, before the general "drop every control sequence" rule, because
// dropping `\'` from `\'{e}` leaves an `e` and dropping `\'e` whole leaves nothing:
// one spelling of the same word would lose a token and the other would not.
const ACCENT_COMMAND = /\\[`'^"~=.]\s*\{?([a-zA-Z])\}?|\\[cvuHrkb]\s*\{([a-zA-Z])\}/g
const SPECIAL_LETTERS = [
    [/\\ss\b/g, 'ss'],
    [/\\ae\b/gi, 'ae'],
    [/\\oe\b/gi, 'oe'],
    [/\\aa\b/gi, 'a'],
    [/\\o\b/gi, 'o'],
    [/\\l\b/gi, 'l'],
    [/\\i\b/g, 'i'],
    [/\\j\b/g, 'j'],
]

// Crossref stores a title as it was deposited, which for a chemistry or a maths
// journal includes markup: <i>, <sub>, <scp>. It is markup in a field we quote to a
// student, so it comes out here rather than in front of them.
const DEPOSITED_MARKUP = /<\/?[a-z][^>]{0,40}>/gi

// overleaf-lab: the title as a HUMAN reads it, with the LaTeX taken off and nothing
// else changed. This is what gets quoted in a finding: a report that says the entry is
// titled "A Survey of {D}eep {L}earning Methods" quotes the file rather than the title,
// and the reader has to do the parsing that the module was supposed to do for them.
// The accents come out as plain letters, which is the same reading the comparison used
// and is what makes the quoted text and the verdict about it agree.
export function displayText(input) {
    let text = String(input || '')
    text = text.replace(ACCENT_COMMAND, (_, a, b) => a || b)
    for (const [pattern, replacement] of SPECIAL_LETTERS) {
        text = text.replace(pattern, replacement)
    }
    // Escaped punctuation keeps its character; every other control sequence is
    // formatting and becomes a space (so `\emph{a}\emph{b}` does not glue into one
    // word).
    text = text.replace(/\\([%&_$#{}])/g, '$1')
    text = text.replace(/\\[a-zA-Z]+\*?/g, ' ')
    // Braces vanish, they do not become spaces. `{D}eep {L}earning` is how half the
    // bibliographies in the world stop BibTeX lowercasing a proper noun, and turning
    // those braces into whitespace cut the word in two: "d eep l earning" shares no
    // token with "deep learning", so the most ordinary .bib style in existence would
    // have been reported as a citation pointing at a different paper. The separator
    // that `\emph{a}\emph{b}` needs is already provided by the control sequence above.
    text = text.replace(/[{}]/g, '')
    text = text.replace(/[$\\]/g, ' ')
    text = text.replace(DEPOSITED_MARKUP, '')
    return text.replace(/\s+/g, ' ').trim()
}

export function normalizeText(input) {
    // Decompose, then drop the combining marks: this is what makes the Unicode "e"
    // with an acute accent and the LaTeX one the same token, in either direction, for
    // every accent instead of a hand-written list of them. The range is written as
    // escapes on purpose: a combining mark typed literally into a source file is
    // invisible in every editor and in every diff.
    const text = displayText(input)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function titleTokens(input) {
    const normalized = normalizeText(input)
    if (!normalized) return new Set()
    // Tokens of one or two characters are dropped, which is a rule about LENGTH and
    // not a list of words: this file must not know which language the thesis is in.
    // It removes most of the articles and prepositions that inflate the overlap of two
    // unrelated titles in any Latin-script language, and it removes them from both
    // sides equally.
    return new Set(normalized.split(' ').filter(t => t.length > 2))
}

export function titleSimilarity(a, b) {
    const A = titleTokens(a)
    const B = titleTokens(b)
    if (A.size === 0 || B.size === 0) return 0
    let shared = 0
    for (const token of A) {
        if (B.has(token)) shared += 1
    }
    const dice = (2 * shared) / (A.size + B.size)
    const smaller = Math.min(A.size, B.size)
    if (smaller >= MIN_TOKENS_FOR_CONTAINMENT) {
        return Math.max(dice, shared / smaller)
    }
    return dice
}

// BibTeX separates authors with " and ", and writes a name either "Family, Given" or
// "Given Family". Both spellings are in every real bibliography, often in the same
// file, because half of it was pasted from a publisher and half exported from a
// reference manager.
export function authorFamilies(authorField) {
    const families = new Set()
    for (const name of String(authorField || '').split(/\s+and\s+/i)) {
        const person = name.trim()
        if (!person) continue
        const family = person.includes(',')
            ? person.slice(0, person.indexOf(','))
            : person.split(/\s+/).slice(-1)[0]
        const normalized = normalizeText(family).replace(/\s+/g, '')
        if (normalized.length > 1) families.add(normalized)
    }
    return families
}

// Crossref stores a person as {family, given} and an organisation as {name}. An entry
// whose first author is a collaboration ("Astropy Collaboration") has no family at
// all, and reading only `family` there produced an empty set that looked like a
// disagreement.
function recordFamilies(record) {
    const families = new Set()
    for (const author of Array.isArray(record && record.author) ? record.author : []) {
        const raw = author && (author.family || author.name || '')
        const normalized = normalizeText(raw).replace(/\s+/g, '')
        if (normalized.length > 1) families.add(normalized)
    }
    return families
}

function readYear(value) {
    const m = /(1\d{3}|20\d{2})/.exec(String(value || ''))
    return m ? Number(m[1]) : null
}

function recordYear(record) {
    for (const key of ['issued', 'published', 'published-print', 'published-online']) {
        const parts = record && record[key] && record[key]['date-parts']
        const year = Array.isArray(parts) && Array.isArray(parts[0]) ? Number(parts[0][0]) : NaN
        if (Number.isFinite(year) && year > 1000) return year
    }
    return null
}

function recordTitle(record) {
    const title = record && record.title
    if (Array.isArray(title)) return String(title[0] || '')
    return String(title || '')
}

// A DOI arrives as a bare identifier, as a URL, with a "doi:" prefix, wrapped in
// \url{}, or with LaTeX-escaped punctuation. It is also case-insensitive by
// specification, which is why every comparison here lowercases both sides.
const DOI_SHAPE = /10\.\d{4,9}\/[^\s{}"',]+/
export function readDoi(value) {
    const text = String(value || '')
        .replace(/\\url\s*\{([^}]{0,400})\}/gi, '$1')
        .replace(/\\([%&_#])/g, '$1')
    const m = DOI_SHAPE.exec(text)
    if (!m) return ''
    // Trailing punctuation belongs to the sentence, not to the identifier.
    const doi = m[0].replace(/[.,;)\]]+$/, '')
    // A "/"-separated segment that IS "." or ".." is not part of a DOI, it is a
    // path-traversal payload. The suffix is student-controlled and encodeDoi keeps a bare
    // dot intact, so `10.1234/../../../10.5555/x` would climb out of the /works path this
    // module builds and, because Budget.get follows redirects, could resolve to a handle
    // an attacker registered. A real suffix carries dots INSIDE a segment
    // (10.1234/j.foo.2020, 10.48550/arXiv.1234.5678), never a segment that is only dots,
    // so this rejects the attack and leaves every legitimate DOI untouched. A rejected
    // DOI is read as absent, which the caller reports as unread, not as a violation.
    if (doi.split('/').some(seg => seg === '.' || seg === '..')) return ''
    return doi
}

// An entry is a preprint when it says so, in any of the four ways a real bibliography
// says it: the biblatex eprint fields, arXiv's own DOI prefix, an arxiv.org link, or
// the "arXiv preprint arXiv:1234.5678" that Google Scholar puts in `journal`.
export function arxivMarker(entry) {
    const fromDoi = ARXIV_DOI_PREFIX.test(entry.doi) ? entry.doi.replace(ARXIV_DOI_PREFIX, '') : ''
    if (fromDoi) return fromDoi
    if (entry.eprint && (!entry.archive || /arxiv/i.test(entry.archive))) return entry.eprint.trim()
    const fromUrl = /arxiv\.org\/(?:abs|pdf)\/([^\s{}"']+)/i.exec(entry.url)
    if (fromUrl) return fromUrl[1].replace(/\.pdf$/i, '')
    if (/\barxiv\b/i.test(entry.venue)) return 'arxiv'
    return ''
}

// ---------------------------------------------------------------------------
// the network, on a short leash
// ---------------------------------------------------------------------------

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// overleaf-lab: one grant per interval, whatever the concurrency does.
//
// The state is updated SYNCHRONOUSLY before the await, which is the whole trick: two
// workers that call acquire() in the same tick get two different slots instead of both
// reading the same "next allowed" instant and firing together. The clock and the sleep
// are injected so the suite can drive an hour of scheduling in a millisecond, and so
// the accounting can be asserted rather than believed.
export function createRateLimiter({ minIntervalMs = LIMITS.minRequestIntervalMs, now = () => Date.now(), sleep = realSleep } = {}) {
    let nextAt = 0
    let waitedMs = 0
    return {
        async acquire() {
            const current = now()
            const at = Math.max(current, nextAt)
            nextAt = at + minIntervalMs
            const wait = at - current
            if (wait > 0) {
                waitedMs += wait
                await sleep(wait)
            }
            return wait
        },
        get waitedMs() {
            return waitedMs
        },
    }
}

// The failure vocabulary. Every one of these ends with the entry counted as NOT
// CHECKED: none of them is evidence about the bibliography, they are all facts about
// us, the network, or which registry holds a record.
export const UNCHECKED_REASONS = {
    noDoi: 'no_doi',
    unreadableDoi: 'unreadable_doi',
    outsideCrossref: 'doi_registered_outside_crossref',
    requestCap: 'request_cap_reached',
    rateLimited: 'rate_limited',
    networkError: 'network_error',
    cancelled: 'cancelled',
}

export const FINDING_KINDS = {
    notFound: 'doi_not_found',
    mismatch: 'doi_mismatch',
    uncertain: 'doi_check_uncertain',
    arxivPublished: 'arxiv_published_version',
}

// Strongest evidence first, so the cap on the list can never drop a DOI that resolves
// nowhere in favour of a suggestion about a preprint.
const FINDING_ORDER = [
    FINDING_KINDS.notFound,
    FINDING_KINDS.mismatch,
    FINDING_KINDS.uncertain,
    FINDING_KINDS.arxivPublished,
]

// overleaf-lab: how much of a registry's answer is worth reading. A Crossref record
// for one work is a few kilobytes; anything past this is not a record we can use, and
// `response.text()` would buffer whatever the far end decided to send, inside the
// review process. Generous enough that no real answer is truncated, small enough that
// a misbehaving or hostile address cannot cost more than this per request.
const MAX_RESPONSE_CHARS = 512 * 1024

// Read at most maxChars of a response body, then stop the transfer. Always called,
// even when the body is discarded, so the connection is drained or cancelled
// deterministically rather than left open.
async function readBoundedText(response, maxChars) {
    const body = response.body
    if (!body || typeof body.getReader !== 'function') {
        // No stream (a mocked or already-buffered response): still bound the result.
        const text = await response.text()
        return text.length > maxChars ? text.slice(0, maxChars) : text
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let out = ''
    try {
        while (out.length < maxChars) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            out += decoder.decode(value, { stream: true })
        }
        out += decoder.decode()
    } finally {
        try {
            await reader.cancel()
        } catch (err) {
            // The body may already be closed; nothing to do about it.
        }
    }
    return out.length > maxChars ? out.slice(0, maxChars) : out
}

class Budget {
    constructor(options) {
        this.max = options.maxRequests
        this.spent = 0
        this.limiter = options.limiter
        this.fetchImpl = options.fetchImpl
        this.timeoutMs = options.requestTimeoutMs
        this.headers = options.headers
        this.signal = options.signal
        this.cache = new Map()
    }

    get exhausted() {
        return this.spent >= this.max
    }

    // Returns {status, body} or {error}. NEVER throws: a caller that has to remember
    // to catch is a caller that will one day turn a DNS failure into a finding.
    async get(url) {
        for (let attempt = 0; attempt < 2; attempt++) {
            if (this.exhausted) return { error: UNCHECKED_REASONS.requestCap }
            if (this.signal && this.signal.aborted) return { error: UNCHECKED_REASONS.cancelled }
            await this.limiter.acquire()
            if (this.signal && this.signal.aborted) return { error: UNCHECKED_REASONS.cancelled }
            this.spent += 1
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), this.timeoutMs)
            const abort = () => controller.abort()
            if (this.signal) this.signal.addEventListener('abort', abort, { once: true })
            try {
                const response = await this.fetchImpl(url, {
                    headers: this.headers,
                    signal: controller.signal,
                    redirect: 'follow',
                })
                const status = Number(response.status)
                // The body is read before anything branches on the status, because a
                // response nobody reads holds its connection open, and the paths that
                // do not want the body are exactly the ones taken when the far end is
                // already struggling.
                let text = ''
                try {
                    text = await readBoundedText(response, MAX_RESPONSE_CHARS)
                } catch (err) {
                    text = ''
                }
                // A 5xx is the far end having a bad moment, and it is the only status
                // worth asking twice. A 4xx is an answer: asking again is rude and
                // gets the same thing back. A 429 means we are already going too fast,
                // so the polite response is to stop, not to try harder.
                if (status >= 500 && attempt === 0) continue
                if (status >= 500) return { error: UNCHECKED_REASONS.networkError }
                if (status === 429) return { error: UNCHECKED_REASONS.rateLimited }
                return { status, body: text }
            } catch (err) {
                if (this.signal && this.signal.aborted) return { error: UNCHECKED_REASONS.cancelled }
                if (attempt === 0) continue
                return { error: UNCHECKED_REASONS.networkError }
            } finally {
                clearTimeout(timer)
                if (this.signal) this.signal.removeEventListener('abort', abort)
            }
        }
        return { error: UNCHECKED_REASONS.networkError }
    }

    async getJson(url) {
        const cached = this.cache.get(url)
        if (cached) return cached
        const answer = await this.get(url)
        let result
        if (answer.error) {
            result = { error: answer.error }
        } else if (answer.status === 404) {
            result = { absent: true }
        } else if (answer.status >= 400) {
            result = { error: UNCHECKED_REASONS.networkError }
        } else {
            try {
                result = { json: JSON.parse(answer.body) }
            } catch (err) {
                // A 200 that is not JSON is the far end answering something we do not
                // understand, which is our problem and not the student's.
                result = { error: UNCHECKED_REASONS.networkError }
            }
        }
        // A failure is cached too: a bibliography that cites the same broken DOI eight
        // times must cost one request, not eight.
        this.cache.set(url, result)
        return result
    }
}

const encodeDoi = doi => doi.split('/').map(encodeURIComponent).join('/')

// ---------------------------------------------------------------------------
// comparing an entry against the record that came back
// ---------------------------------------------------------------------------

function verdictOf(entry, record) {
    const foundTitle = recordTitle(record)
    const similarity = entry.title && foundTitle ? titleSimilarity(entry.title, foundTitle) : null

    const entryFamilies = authorFamilies(entry.author)
    const found = recordFamilies(record)
    let author = 'unknown'
    if (entryFamilies.size > 0 && found.size > 0) {
        author = [...entryFamilies].some(f => found.has(f)) ? 'match' : 'differ'
    }

    const foundYear = recordYear(record)
    let year = 'unknown'
    if (entry.year && foundYear) {
        year = Math.abs(entry.year - foundYear) <= YEAR_TOLERANCE ? 'match' : 'differ'
    }

    // A title that agrees settles it: the DOI points at the work the entry describes,
    // and nothing else about the record is worth a line in a report.
    if (similarity !== null && similarity >= SIMILARITY.match) {
        return { kind: null, similarity, author, year, foundTitle, foundYear }
    }

    // Whether the titles are even comparable. Two or fewer content words carry no
    // information, and a title our parser cut looks exactly like a short one, so
    // neither side may be turned into an accusation.
    const comparable =
        similarity !== null &&
        titleTokens(entry.title).size >= MIN_TITLE_TOKENS &&
        titleTokens(foundTitle).size >= MIN_TITLE_TOKENS

    if (!comparable) {
        // With no usable title, only a double disagreement is worth mentioning, and
        // only as "could not tell".
        if (author === 'differ' && year === 'differ') {
            return { kind: FINDING_KINDS.uncertain, similarity, author, year, foundTitle, foundYear }
        }
        return { kind: null, similarity, author, year, foundTitle, foundYear }
    }

    if (similarity < SIMILARITY.mismatch) {
        // The author and the year can rescue a title WE mangled: same people, same
        // year, unreadable title is far more likely to be our parsing than a citation
        // pointing at a different paper.
        if (author === 'match' && year !== 'differ') {
            return { kind: FINDING_KINDS.uncertain, similarity, author, year, foundTitle, foundYear }
        }
        return { kind: FINDING_KINDS.mismatch, similarity, author, year, foundTitle, foundYear }
    }
    return { kind: FINDING_KINDS.uncertain, similarity, author, year, foundTitle, foundYear }
}

// Every title that leaves this module goes through here: readable, bounded, and the
// same on both sides of a comparison, so a reader who is shown two titles is shown
// them in the same form the code compared.
const clip = (text, max = LIMITS.titleChars) => {
    const value = displayText(text)
    return value.length > max ? `${value.slice(0, max)}...` : value
}

function makeFinding(kind, entry, extra) {
    return {
        kind,
        key: entry.key,
        file: entry.file,
        line: entry.line,
        entryTitle: clip(entry.title),
        ...extra,
    }
}

// ---------------------------------------------------------------------------
// the checks
// ---------------------------------------------------------------------------

async function checkDoi(entry, budget, out) {
    const answer = await budget.getJson(`${CROSSREF_WORKS}/${encodeDoi(entry.doi)}`)
    if (answer.error) {
        out.unchecked.push({ key: entry.key, reason: answer.error })
        return false
    }

    if (answer.absent) {
        // CROSSREF IS NOT THE DOI SYSTEM. Zenodo, figshare, most datasets and arXiv's
        // own DOIs are registered with DataCite, and Crossref answers 404 for every one
        // of them: measured, on two real and current DOIs. Reporting that 404 as a
        // missing work would accuse a student of fabricating a citation for using
        // Zenodo, which is both wrong and exactly the kind of wrong this module exists
        // to avoid. So a 404 is confirmed against the Handle System, which is
        // registry-agnostic and answers for every DOI that exists anywhere.
        const handle = await budget.getJson(`${DOI_HANDLE_API}/${encodeDoi(entry.doi)}`)
        if (handle.error) {
            out.unchecked.push({ key: entry.key, reason: handle.error })
            return false
        }
        const resolves = !handle.absent && handle.json && Number(handle.json.responseCode) === 1
        if (resolves) {
            out.unchecked.push({ key: entry.key, reason: UNCHECKED_REASONS.outsideCrossref })
            return false
        }
        out.findings.push(
            makeFinding(FINDING_KINDS.notFound, entry, {
                detail:
                    `DOI ${entry.doi} returns 404 from the Crossref REST API, and the DOI resolver ` +
                    'reports no handle registered for it in any registry.',
                grade: 'fact',
            })
        )
        return true
    }

    const record = (answer.json && answer.json.message) || null
    if (!record) {
        out.unchecked.push({ key: entry.key, reason: UNCHECKED_REASONS.networkError })
        return false
    }

    const verdict = verdictOf(entry, record)
    if (verdict.kind === FINDING_KINDS.mismatch) {
        out.findings.push(
            makeFinding(FINDING_KINDS.mismatch, entry, {
                detail:
                    `DOI ${entry.doi} resolves on Crossref to a record titled "${clip(verdict.foundTitle)}", ` +
                    `while the entry is titled "${clip(entry.title)}"` +
                    (verdict.author === 'differ' ? ', and the two carry no author name in common' : '') +
                    (verdict.year === 'differ' && verdict.foundYear
                        ? `; the record is dated ${verdict.foundYear} and the entry ${entry.year}`
                        : '') +
                    '.',
                foundTitle: clip(verdict.foundTitle),
                foundDoi: String(record.DOI || entry.doi),
                grade: 'fact',
            })
        )
    } else if (verdict.kind === FINDING_KINDS.uncertain) {
        out.findings.push(
            makeFinding(FINDING_KINDS.uncertain, entry, {
                detail:
                    `DOI ${entry.doi} resolves on Crossref to a record titled "${clip(verdict.foundTitle)}", ` +
                    `which neither clearly matches nor clearly contradicts the entry title ` +
                    `"${clip(entry.title)}". Not a violation: a human has to look.`,
                foundTitle: clip(verdict.foundTitle),
                foundDoi: String(record.DOI || entry.doi),
                grade: 'uncertain',
            })
        )
    }
    return true
}

async function checkArxiv(entry, budget, out) {
    if (!entry.title || titleTokens(entry.title).size < MIN_TITLE_TOKENS) {
        // Nothing to search with. The reason has to say which of the two situations
        // this is: "carries no DOI", on an entry that carries an arXiv one, would be a
        // false statement about the student's file.
        out.unchecked.push({
            key: entry.key,
            reason: entry.doi ? UNCHECKED_REASONS.outsideCrossref : UNCHECKED_REASONS.noDoi,
        })
        return false
    }
    const query = encodeURIComponent(normalizeText(entry.title).slice(0, LIMITS.titleChars))
    const url =
        `${CROSSREF_WORKS}?query.bibliographic=${query}&rows=3` +
        '&select=DOI,title,author,issued,type'
    const answer = await budget.getJson(url)
    if (answer.error) {
        out.unchecked.push({ key: entry.key, reason: answer.error })
        return false
    }
    const items = (answer.json && answer.json.message && answer.json.message.items) || []
    let best = null
    for (const item of items) {
        const doi = String(item.DOI || '')
        // A preprint is not the published version of itself, and neither is another
        // copy of it on a preprint server.
        if (!doi || ARXIV_DOI_PREFIX.test(doi) || doi.toLowerCase() === entry.doi.toLowerCase()) continue
        if (String(item.type || '') === 'posted-content') continue
        const similarity = titleSimilarity(entry.title, recordTitle(item))
        if (similarity < SIMILARITY.match) continue
        // THE AUTHOR GATE IS NOT OPTIONAL. Measured against the live API: a search for
        // "Attention Is All You Need" answers with "Is Attention All You Need?" by
        // somebody else, whose title tokens are IDENTICAL. Title alone would have
        // suggested a stranger's paper as the published version of the student's
        // citation. An entry with no author cannot pass this gate, which is why it is
        // checked before anything is reported.
        const families = authorFamilies(entry.author)
        if (families.size === 0) continue
        const shared = [...families].some(f => recordFamilies(item).has(f))
        if (!shared) continue
        if (!best || similarity > best.similarity) best = { item, similarity, doi }
    }
    if (best) {
        out.findings.push(
            makeFinding(FINDING_KINDS.arxivPublished, entry, {
                detail:
                    `The entry cites a preprint. Crossref holds a published record with the same title and ` +
                    `a shared author under DOI ${best.doi} ("${clip(recordTitle(best.item))}"). ` +
                    'Suggestion only: citing the preprint is not an error.',
                foundTitle: clip(recordTitle(best.item)),
                foundDoi: best.doi,
                grade: 'suggestion',
            })
        )
    }
    return true
}

// ---------------------------------------------------------------------------
// the entry point
// ---------------------------------------------------------------------------

/**
 * Verify a parsed bibliography against public metadata.
 *
 * @param {Array} entries parsed .bib entries; see readEntry for the expected shape
 * @param {Object} options
 *   env                 the environment to read the opt-in from (default process.env)
 *   fetchImpl           the fetch to use (default globalThis.fetch); injected by tests
 *   now, sleep          the clock, for the rate limiter; injected by tests
 *   signal              an AbortSignal, so cancelling a review stops the traffic
 *   maxRequests,        overrides of LIMITS, for tests and for an operator who wants a
 *   concurrency,        smaller budget than the default
 *   minRequestIntervalMs,
 *   requestTimeoutMs
 * @returns {Promise<Object>} a JSON-able result; never throws, never rejects
 */
export async function verifyBibliography(entries, options = {}) {
    const list = Array.isArray(entries) ? entries : []
    const env = options.env || process.env
    const contact = bibVerifyContact(env)
    if (!contact) {
        const set = String((env && env[BIB_VERIFY_MAILTO_ENV]) || '').trim()
        return disabledResult(
            list.length,
            set
                ? `${BIB_VERIFY_MAILTO_ENV} is not a contact address`
                : `${BIB_VERIFY_MAILTO_ENV} is not set`
        )
    }
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
    if (!fetchImpl) {
        return disabledResult(list.length, 'no fetch implementation is available')
    }

    const limiter = createRateLimiter({
        minIntervalMs: options.minRequestIntervalMs || LIMITS.minRequestIntervalMs,
        now: options.now,
        sleep: options.sleep,
    })
    const budget = new Budget({
        maxRequests: Number.isFinite(options.maxRequests) ? options.maxRequests : LIMITS.maxRequests,
        limiter,
        fetchImpl,
        requestTimeoutMs: options.requestTimeoutMs || LIMITS.requestTimeoutMs,
        signal: options.signal,
        headers: {
            // The polite pool: who we are and who to write to if this traffic is a
            // problem. Crossref asks for exactly this and gives better service for it.
            'User-Agent': `${USER_AGENT_PRODUCT} (mailto:${contact})`,
            Accept: 'application/json',
        },
    })

    const out = { findings: [], unchecked: [] }
    let checked = 0

    // The work list, in the order the entries appear: what the budget buys has to be
    // predictable, so a second review of the same project checks the same entries.
    const queue = []
    for (const raw of list) {
        const entry = readEntry(raw)
        const preprint = arxivMarker(entry)
        if (entry.doi && !ARXIV_DOI_PREFIX.test(entry.doi)) {
            queue.push({ entry, job: 'doi' })
        } else if (preprint || entry.doi) {
            // Either the entry says it is a preprint, or the only DOI it carries is
            // arXiv's own, which is registered with DataCite and which Crossref does
            // not hold. Both are answered the same way: search by title for a published
            // version. DELIBERATELY NOT DONE HERE: resolving the arXiv identifier
            // itself. A fabricated eprint number is a real failure mode, but arXiv has
            // not minted a DOI for every paper that exists, so "no handle" there would
            // sometimes be an accusation aimed at a paper that is perfectly real.
            queue.push({ entry, job: 'arxiv' })
        } else if (entry.doiRaw) {
            out.unchecked.push({ key: entry.key, reason: UNCHECKED_REASONS.unreadableDoi })
        } else {
            out.unchecked.push({ key: entry.key, reason: UNCHECKED_REASONS.noDoi })
        }
    }

    let cursor = 0
    const worker = async () => {
        while (cursor < queue.length) {
            const item = queue[cursor++]
            if (budget.exhausted) {
                out.unchecked.push({ key: item.entry.key, reason: UNCHECKED_REASONS.requestCap })
                continue
            }
            if (options.signal && options.signal.aborted) {
                out.unchecked.push({ key: item.entry.key, reason: UNCHECKED_REASONS.cancelled })
                continue
            }
            try {
                const done =
                    item.job === 'doi'
                        ? await checkDoi(item.entry, budget, out)
                        : await checkArxiv(item.entry, budget, out)
                if (done) checked += 1
            } catch (err) {
                // Nothing in here is allowed to lose a finished review, and no failure
                // of ours is allowed to become a fact about the bibliography.
                out.unchecked.push({ key: item.entry.key, reason: UNCHECKED_REASONS.networkError })
            }
        }
    }

    const lanes = Math.max(1, Math.min(options.concurrency || LIMITS.concurrency, queue.length || 1))
    await Promise.all(Array.from({ length: lanes }, worker))

    out.findings.sort(
        (a, b) => FINDING_ORDER.indexOf(a.kind) - FINDING_ORDER.indexOf(b.kind)
    )
    const uncheckedByReason = {}
    for (const item of out.unchecked) {
        uncheckedByReason[item.reason] = (uncheckedByReason[item.reason] || 0) + 1
    }

    return {
        enabled: true,
        reason: '',
        checked,
        total: list.length,
        requests: budget.spent,
        // Time spent waiting on the throttle, SUMMED OVER THE LANES. With concurrency
        // above one the lanes wait in parallel, so this is larger than the wall clock
        // and is not a duration of the review: it is how much traffic was held back.
        waitedMs: limiter.waitedMs,
        // Capped for the report, counted in full: the totals below are the truth even
        // when the lists are cut.
        findings: out.findings.slice(0, LIMITS.findings),
        unchecked: out.unchecked.slice(0, LIMITS.unchecked),
        uncheckedByReason,
        totals: {
            findings: { shown: Math.min(out.findings.length, LIMITS.findings), total: out.findings.length },
            unchecked: { shown: Math.min(out.unchecked.length, LIMITS.unchecked), total: out.unchecked.length },
        },
    }
}

// ---------------------------------------------------------------------------
// turning the result into facts the review can show
// ---------------------------------------------------------------------------

// overleaf-lab: these lines go into the SCAN HINTS, which are read by the model and
// are English wherever the rest of the hints are English. They are not the student's
// report: the report language belongs to the rubric, and the wording a student reads
// is built by whoever renders the finding, not here.

const KIND_HEADINGS = {
    [FINDING_KINDS.notFound]: 'Citations whose DOI resolves nowhere',
    [FINDING_KINDS.mismatch]: 'Citations whose DOI resolves to a different work',
    [FINDING_KINDS.uncertain]: 'Citations whose DOI could not be confirmed either way',
    [FINDING_KINDS.arxivPublished]: 'Preprints that Crossref also holds as published',
}

const REASON_WORDS = {
    [UNCHECKED_REASONS.noDoi]: 'carry no DOI',
    [UNCHECKED_REASONS.unreadableDoi]: 'carry a DOI that could not be read',
    [UNCHECKED_REASONS.outsideCrossref]: 'have a DOI registered outside Crossref (DataCite: Zenodo, arXiv, datasets)',
    [UNCHECKED_REASONS.requestCap]: 'were past this review\'s request budget',
    [UNCHECKED_REASONS.rateLimited]: 'were refused for rate limiting',
    [UNCHECKED_REASONS.networkError]: 'could not be reached',
    [UNCHECKED_REASONS.cancelled]: 'were dropped when the review was cancelled',
}

export function hasBibVerifyFindings(result) {
    return Boolean(result && result.enabled && result.findings && result.findings.length > 0)
}

export function formatBibVerifyFacts(result) {
    if (!result) return []
    if (!result.enabled) {
        // NOT RUN IS NOT A PASS. Said in the hints as plainly as it will have to be
        // said in the report: with the check off, nothing here is evidence that the
        // bibliography is sound.
        return [
            `- Online bibliography verification: NOT RUN (${result.reason}). ` +
                'No DOI in this project was resolved, so nothing below says whether its references exist.',
        ]
    }

    const where = f => `${f.file || '?'}${f.line ? `:${f.line}` : ''} [${f.key}]`
    const unchecked = Object.entries(result.uncheckedByReason || {})
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => `${n} ${REASON_WORDS[reason] || reason}`)
        .join(', ')

    // The cut is stated ONCE, on the summary line, and in terms of the whole finding
    // list rather than of each heading: the cap is applied to the sorted list, so which
    // headings lost rows is not something a per-heading count could tell the truth
    // about. What matters is that the reader knows the list is not everything.
    const total = (result.totals && result.totals.findings.total) || result.findings.length
    const shown = result.findings.length
    const lines = [
        `- Online bibliography verification (Crossref REST API): checked ${result.checked} of ` +
            `${result.total} entries in ${result.requests} request${result.requests === 1 ? '' : 's'}` +
            (unchecked ? `; not checked: ${unchecked}` : '') +
            (total > shown ? `; showing the first ${shown} of ${total} findings, strongest first` : '') +
            '.',
    ]

    for (const kind of FINDING_ORDER) {
        const of = result.findings.filter(f => f.kind === kind)
        if (of.length === 0) continue
        lines.push(
            `- ${KIND_HEADINGS[kind]} (${of.length}): ` +
                of.map(f => `${where(f)} ${f.detail}`).join(' | ')
        )
    }

    if (result.findings.length === 0) {
        lines.push(
            `- Every DOI that could be checked resolved to a record matching its entry. ` +
                'That is a statement about the checked entries only.'
        )
    }

    lines.push(
        '- These are facts about what a public metadata API answered, not verdicts about the student. ' +
            'A DOI Crossref does not hold may be registered elsewhere, and those entries are counted as not checked above.'
    )
    return lines
}

export default {
    verifyBibliography,
    formatBibVerifyFacts,
    hasBibVerifyFindings,
    isBibVerifyEnabled,
    bibVerifyContact,
    BIB_VERIFY_MAILTO_ENV,
    LIMITS,
    SIMILARITY,
    FINDING_KINDS,
    UNCHECKED_REASONS,
}
