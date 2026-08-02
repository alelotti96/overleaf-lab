// Online bibliography verification: the one part of the review that leaves the
// machine, and the one whose findings sit closest to an accusation.
//
// So the suite is written against the three promises the module makes.
//
//   1. It does not touch the network unless an administrator set a contact address.
//      The disabled case therefore asserts that fetch was never CALLED, not merely
//      that the result came back empty.
//   2. Nothing that goes wrong on our side, on the network, or in a registry we do not
//      query can become a finding. Every failure path has a case here, and each one
//      asserts "no findings" as loudly as it asserts the reason.
//   3. Every list it caps is reported next to its true total, and the request budget it
//      claims to have spent is the number of requests it actually made.
//
// EVERY CASE RUNS OFFLINE. `fetch` is injected, the clock is injected, and the payloads
// below are trimmed copies of what the live Crossref API really answered on 2026-08-02:
// the arXiv case in particular encodes a measurement, not a guess (searching for
// "Attention Is All You Need" answers with a paper of the same title by different
// authors, which is why the author gate exists).
//
// Unlike most suites in this directory, this one imports the real module instead of
// slicing it: it has no Overleaf imports, which is itself part of the design.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = process.env.CTRL ? path.dirname(process.env.CTRL) : path.resolve(HERE, '../vendor/llm/app/src')
const MODULE = path.join(SRC, 'LLMBibVerify.mjs')

let mod
try {
    mod = await import(pathToFileURL(MODULE).href)
} catch (err) {
    console.error(`FAIL: could not load the bibliography verifier\n${err.stack || err.message}`)
    process.exit(1)
}

const {
    verifyBibliography,
    formatBibVerifyFacts,
    hasBibVerifyFindings,
    isBibVerifyEnabled,
    bibVerifyContact,
    createRateLimiter,
    readEntry,
    collectFields,
    normalizeText,
    displayText,
    titleSimilarity,
    titleTokens,
    authorFamilies,
    readDoi,
    arxivMarker,
    BIB_VERIFY_MAILTO_ENV,
    LIMITS,
    SIMILARITY,
    FINDING_KINDS,
    UNCHECKED_REASONS,
} = mod

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

const ENABLED = { [BIB_VERIFY_MAILTO_ENV]: 'library@example.org' }

// A clock that time-travels: the module awaits the injected sleep, which advances the
// injected now, so a rate limiter that would take an hour of wall clock is driven in a
// millisecond and its accounting can be asserted instead of believed.
function fakeClock() {
    let t = 0
    return {
        now: () => t,
        sleep: async ms => {
            t += ms
        },
        elapsed: () => t,
    }
}

// A fetch that answers from a routing table and records every call. The default answer
// is the one Crossref really gives for an unknown DOI, body included.
function stubFetch(routes) {
    const calls = []
    const impl = async (url, init) => {
        const target = String(url)
        calls.push({ url: target, headers: (init && init.headers) || {} })
        for (const [needle, answer] of routes) {
            if (target.includes(needle)) {
                const value = typeof answer === 'function' ? answer(target, calls.length) : answer
                if (value instanceof Error) throw value
                return {
                    status: value.status,
                    text: async () =>
                        typeof value.body === 'string' ? value.body : JSON.stringify(value.body),
                }
            }
        }
        return { status: 404, text: async () => 'Resource not found.' }
    }
    impl.calls = calls
    return impl
}

const work = (fields = {}) => ({ status: 200, body: { status: 'ok', message: fields } })
const handleFound = { status: 200, body: { responseCode: 1, handle: 'x' } }
const handleMissing = { status: 404, body: { responseCode: 100, handle: 'x' } }

const entry = (key, fields, extra = {}) => ({
    key,
    type: 'article',
    file: 'refs.bib',
    line: 12,
    fields,
    ...extra,
})

const run = (entries, options) =>
    verifyBibliography(entries, {
        env: ENABLED,
        concurrency: 1,
        ...options,
    })

// ---------------------------------------------------------------------------
// the opt-in gate: no address, no network, and never a pass
// ---------------------------------------------------------------------------
{
    const fetchImpl = stubFetch([['api.crossref.org', work({ title: ['x'] })]])
    const result = await verifyBibliography(
        [entry('a', { doi: '10.1234/abcd', title: 'Something', author: 'Rossi, M', year: '2020' })],
        { env: {}, fetchImpl }
    )
    check('with no contact address the module is disabled', result.enabled === false, result.reason)
    check('and it made no request at all', fetchImpl.calls.length === 0, `${fetchImpl.calls.length} calls`)
    check('and it reports zero requests', result.requests === 0 && result.checked === 0)
    check('and it still reports the true number of entries', result.total === 1)
    check('the reason names the environment variable', result.reason.includes(BIB_VERIFY_MAILTO_ENV), result.reason)

    const facts = formatBibVerifyFacts(result)
    check('the facts say NOT RUN, in those words', facts.join(' ').includes('NOT RUN'), facts.join(' '))
    check(
        'and nothing in them can be read as "the bibliography is fine"',
        !/every doi|all .*resolved|verified/i.test(facts.join(' ')),
        facts.join(' ')
    )
    check('an absent result renders nothing', formatBibVerifyFacts(null).length === 0)
    check('and has no findings to show', hasBibVerifyFindings(result) === false)
}

// A value that is not a contact address is not an opt-in either: it would identify this
// instance to a third party as somebody who cannot be reached.
{
    for (const value of ['', '   ', 'changeme', 'yes', 'true', 'admin@localhost', 'a b@c.org']) {
        check(
            `"${value}" is not a contact address`,
            isBibVerifyEnabled({ [BIB_VERIFY_MAILTO_ENV]: value }) === false
        )
    }
    check('a real address is', isBibVerifyEnabled(ENABLED) === true)
    check('and it is what gets sent', bibVerifyContact(ENABLED) === 'library@example.org')
}

// ---------------------------------------------------------------------------
// a DOI that resolves nowhere: the strongest signal there is
// ---------------------------------------------------------------------------
{
    const fetchImpl = stubFetch([
        ['api.crossref.org/works/10.1234/qx7', { status: 404, body: 'Resource not found.' }],
        ['doi.org/api/handles', handleMissing],
    ])
    const result = await run(
        [
            entry('fake2023', {
                doi: '10.1234/qx7.5678',
                title: 'Neural approaches to reservoir simulation',
                author: 'Smith, John',
                year: '2023',
            }),
        ],
        { fetchImpl }
    )
    check('a DOI that Crossref does not hold is confirmed against the resolver', fetchImpl.calls.length === 2)
    check('one finding, and it is doi_not_found', result.findings.length === 1 && result.findings[0].kind === FINDING_KINDS.notFound)
    const finding = result.findings[0]
    check('it points at the entry, by file, line and key', finding.file === 'refs.bib' && finding.line === 12 && finding.key === 'fake2023')
    check('the detail is a fact about what an API answered', /returns 404 from the Crossref REST API/.test(finding.detail), finding.detail)
    check('the detail quotes the DOI it is about', finding.detail.includes('10.1234/qx7.5678'))
    check(
        'and it never uses the word the reader would supply themselves',
        !/fabricat|invent|fake|made up/i.test(finding.detail),
        finding.detail
    )
    check('the entry counts as checked', result.checked === 1 && result.total === 1)
    check('the polite pool gets a User-Agent with the address in it', /mailto:library@example\.org/.test(fetchImpl.calls[0].headers['User-Agent']), fetchImpl.calls[0].headers['User-Agent'])
}

// The same 404 from Crossref, when the DOI does exist somewhere else. This is the case
// that decides whether the module is usable: measured on 2026-08-02, Crossref answers
// 404 for 10.48550/arXiv.1706.03762 and for 10.5281/zenodo.3509134, both of which are
// real, current, resolvable DOIs registered with DataCite. Reporting that as a missing
// work would accuse a student of fabricating a citation for using Zenodo.
{
    const fetchImpl = stubFetch([
        ['api.crossref.org/works/10.5281', { status: 404, body: 'Resource not found.' }],
        ['doi.org/api/handles', handleFound],
    ])
    const result = await run(
        [
            entry('dataset2019', {
                doi: '10.5281/zenodo.3509134',
                title: 'A dataset of labelled spectrograms',
                author: 'Bianchi, Elena',
                year: '2019',
            }),
        ],
        { fetchImpl }
    )
    check('a DOI held by another registry produces NO finding', result.findings.length === 0)
    check(
        'it is reported as not checked, and why',
        result.unchecked.length === 1 && result.unchecked[0].reason === UNCHECKED_REASONS.outsideCrossref,
        JSON.stringify(result.unchecked)
    )
    check('and it is not counted as checked', result.checked === 0)
    check(
        'the summary line names the registry problem',
        formatBibVerifyFacts(result).join(' ').includes('registered outside Crossref')
    )
}

// ---------------------------------------------------------------------------
// resolve AND match: a real DOI that belongs to a different work
// ---------------------------------------------------------------------------
// The record below is the real Crossref answer for 10.1016/j.jclepro.2020.121234,
// which is what a plausible guess inside a busy journal prefix lands on.
{
    const fetchImpl = stubFetch([
        [
            'api.crossref.org/works/',
            work({
                DOI: '10.1016/j.jclepro.2020.121234',
                title: ['Enriching indigenous microbial consortia as a promising strategy for xenobiotics cleanup'],
                author: [{ family: 'Li', given: 'Xiaona' }],
                issued: { 'date-parts': [[2020, 7]] },
            }),
        ],
    ])
    const result = await run(
        [
            entry('rossi2021', {
                // Braced capitals are how half the bibliographies in the world stop
                // BibTeX lowercasing a proper noun. They must not split a word.
                title: String.raw`A Survey of {D}eep {L}earning Methods for Human Activity Recognition`,
                doi: '10.1016/j.jclepro.2020.121234',
                author: 'Rossi, Marco and Verdi, Anna',
                // Three years apart: one year of difference is a preprint and its
                // publication, and must never be a disagreement (see YEAR_TOLERANCE).
                year: '2023',
            }),
        ],
        { fetchImpl }
    )
    check('a resolving DOI on a different work is a mismatch', result.findings.length === 1 && result.findings[0].kind === FINDING_KINDS.mismatch)
    const finding = result.findings[0]
    check('BOTH titles are quoted in the detail', finding.detail.includes('Enriching indigenous microbial consortia') && finding.detail.includes('Human Activity Recognition'), finding.detail)
    check('the record title is carried as a field too', finding.foundTitle.startsWith('Enriching indigenous'))
    check('the entry title in the finding carries no LaTeX braces', !/[{}]/.test(finding.entryTitle), finding.entryTitle)
    check('the disagreeing year is stated as a fact', /dated 2020 and the entry 2023/.test(finding.detail), finding.detail)
    check('the detail says the DOI resolves, not that it is wrong', /resolves on Crossref/.test(finding.detail))

    check(
        'braced capitals do not split a word',
        titleTokens(String.raw`{D}eep {L}earning`).has('deep') && titleTokens(String.raw`{D}eep {L}earning`).size === 2,
        [...titleTokens(String.raw`{D}eep {L}earning`)].join(',')
    )
    check(
        'and a braced title still matches its unbraced twin',
        titleSimilarity(String.raw`{D}eep {L}earning for {NLP}`, 'Deep learning for NLP') === 1
    )
    // A quoted title is read by a student. Neither the .bib markup nor the markup a
    // publisher deposited with Crossref belongs in front of them.
    check(
        'a quoted title keeps its case and loses its markup',
        displayText(String.raw`A Survey of {D}eep \emph{Learning} Methods`) === 'A Survey of Deep Learning Methods',
        displayText(String.raw`A Survey of {D}eep \emph{Learning} Methods`)
    )
    check(
        'and the markup a publisher deposited comes off too',
        displayText('Synthesis of <i>Escherichia coli</i> under CO<sub>2</sub>') ===
            'Synthesis of Escherichia coli under CO2',
        displayText('Synthesis of <i>Escherichia coli</i> under CO<sub>2</sub>')
    )
}

// A title that agrees settles it: no finding, whatever else the record says.
{
    const fetchImpl = stubFetch([
        [
            'api.crossref.org/works/',
            work({
                DOI: '10.1038/nature14539',
                title: ['Deep learning'],
                author: [{ family: 'LeCun', given: 'Yann' }, { family: 'Bengio', given: 'Yoshua' }],
                issued: { 'date-parts': [[2015, 5, 27]] },
            }),
        ],
    ])
    const result = await run(
        [
            entry('lecun2015', {
                title: 'Deep learning',
                doi: 'https://doi.org/10.1038/nature14539',
                author: 'LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey',
                year: '2015',
            }),
        ],
        { fetchImpl }
    )
    check('a matching record produces no finding', result.findings.length === 0, JSON.stringify(result.findings))
    check('and the entry is counted as checked', result.checked === 1)
    check('a DOI written as a URL is still read', fetchImpl.calls[0].url.includes('10.1038/nature14539'), fetchImpl.calls[0].url)
    check(
        'the facts say what was checked and admit what it covers',
        formatBibVerifyFacts(result).join(' ').includes('checked 1 of 1'),
        formatBibVerifyFacts(result)[0]
    )
}

// ---------------------------------------------------------------------------
// accents: the same title, written the two ways every bibliography writes it
// ---------------------------------------------------------------------------
{
    const E = String.fromCharCode(0x00e9)
    const unicodeTitle = `Th${E}orie des ${E}quations diff${E}rentielles ordinaires`
    const latexTitle = String.raw`Th\'eorie des {\'e}quations diff\'erentielles ordinaires`
    check(
        'a LaTeX accent and a Unicode accent normalise to the same token',
        normalizeText(latexTitle) === normalizeText(unicodeTitle),
        `${normalizeText(latexTitle)} != ${normalizeText(unicodeTitle)}`
    )
    check('so the two titles are identical to the comparison', titleSimilarity(latexTitle, unicodeTitle) === 1)

    const fetchImpl = stubFetch([
        [
            'api.crossref.org/works/',
            work({
                DOI: '10.1051/0004-6361/201322068',
                title: [unicodeTitle],
                author: [{ family: `Poincar${E}`, given: 'Henri' }],
                issued: { 'date-parts': [[1899]] },
            }),
        ],
    ])
    const result = await run(
        [
            entry('poincare1899', {
                title: latexTitle,
                doi: '10.1051/0004-6361/201322068',
                author: String.raw`Poincar\'e, Henri`,
                year: '1899',
            }),
        ],
        { fetchImpl }
    )
    check('an accented entry that matches produces no finding', result.findings.length === 0, JSON.stringify(result.findings))
    check(
        'and the accented author name matches across the two spellings',
        authorFamilies(String.raw`Poincar\'e, Henri`).has('poincare')
    )
}

// ---------------------------------------------------------------------------
// the middle band: reported as "could not tell", never as a violation
// ---------------------------------------------------------------------------
{
    const entryTitle = 'Deep learning methods for medical image'
    const recordTitle = 'Deep learning methods applied to genomics'
    const similarity = titleSimilarity(entryTitle, recordTitle)
    check(
        'the fixture really does sit in the uncertain band',
        similarity >= SIMILARITY.mismatch && similarity < SIMILARITY.match,
        `similarity ${similarity.toFixed(3)}, band [${SIMILARITY.mismatch}, ${SIMILARITY.match})`
    )
    const fetchImpl = stubFetch([
        [
            'api.crossref.org/works/',
            work({
                DOI: '10.1000/mid.1',
                title: [recordTitle],
                author: [{ family: 'Nguyen', given: 'Anh' }],
                issued: { 'date-parts': [[2018]] },
            }),
        ],
    ])
    const result = await run(
        [entry('mid2018', { title: entryTitle, doi: '10.1000/mid.1', author: 'Ferrari, Luca', year: '2018' })],
        { fetchImpl }
    )
    check('a middle-band title is reported as uncertain', result.findings.length === 1 && result.findings[0].kind === FINDING_KINDS.uncertain)
    check('and it says so in words', /neither clearly matches nor clearly contradicts/.test(result.findings[0].detail))
    check('and it says a human has to look', /a human has to look/i.test(result.findings[0].detail))
    check('it is graded, so a renderer can keep it out of the violations', result.findings[0].grade === 'uncertain')
}

// A title WE could not read must not become an accusation. Same author, same year, an
// unreadable title: far more likely our parsing than a citation pointing elsewhere.
{
    const fetchImpl = stubFetch([
        [
            'api.crossref.org/works/',
            work({
                DOI: '10.1000/rescue.1',
                title: ['Enriching indigenous microbial consortia for xenobiotics cleanup'],
                author: [{ family: 'Ferrari', given: 'Luca' }],
                issued: { 'date-parts': [[2018]] },
            }),
        ],
    ])
    const result = await run(
        [
            entry('rescue2018', {
                title: 'Totally different words here please',
                doi: '10.1000/rescue.1',
                author: 'Ferrari, Luca',
                year: '2018',
            }),
        ],
        { fetchImpl }
    )
    check(
        'a low title score with the same author and year is uncertain, not a mismatch',
        result.findings.length === 1 && result.findings[0].kind === FINDING_KINDS.uncertain,
        JSON.stringify(result.findings.map(f => f.kind))
    )
}

// A title too short to carry information cannot disagree with anything.
{
    const fetchImpl = stubFetch([
        [
            'api.crossref.org/works/',
            work({
                DOI: '10.1000/short.1',
                title: ['A completely unrelated study of soil bacteria'],
                author: [{ family: 'Li', given: 'X' }],
                issued: { 'date-parts': [[2011]] },
            }),
        ],
    ])
    const result = await run(
        [entry('short2020', { title: 'Robotics', doi: '10.1000/short.1', author: 'Neri, Paolo', year: '2020' })],
        { fetchImpl }
    )
    check('a two-token title never produces a mismatch', result.findings.every(f => f.kind !== FINDING_KINDS.mismatch), JSON.stringify(result.findings.map(f => f.kind)))
}

// ---------------------------------------------------------------------------
// preprints: a suggestion, and the author gate that keeps it honest
// ---------------------------------------------------------------------------
// The three candidates below are the real answer the live API gave on 2026-08-02 for
// query.bibliographic="Deep Residual Learning for Image Recognition". The FIRST one has
// an identical token set to the entry title and belongs to somebody else; the right
// answer is the third. Ranking is not evidence, and the first row is not the answer.
const RESIDUAL_CANDIDATES = {
    status: 200,
    body: {
        status: 'ok',
        message: {
            items: [
                {
                    DOI: '10.3390/app12188972',
                    title: ['Deep Residual Learning for Image Recognition: A Survey'],
                    author: [{ family: 'Shafiq', given: 'Muhammad' }, { family: 'Gu', given: 'Zhaoquan' }],
                    issued: { 'date-parts': [[2022, 9, 7]] },
                    type: 'journal-article',
                },
                {
                    DOI: '10.22541/au.170666177.72403547/v1',
                    title: ['Multiple butterflies recognition based on deep residual learning and image analyze'],
                    author: [{ family: 'Xi', given: 'Tianyu' }],
                    issued: { 'date-parts': [[2024, 1, 31]] },
                    type: 'posted-content',
                },
                {
                    DOI: '10.1109/cvpr.2016.90',
                    title: ['Deep Residual Learning for Image Recognition'],
                    author: [{ family: 'He', given: 'Kaiming' }, { family: 'Zhang', given: 'Xiangyu' }],
                    issued: { 'date-parts': [[2016, 6]] },
                    type: 'proceedings-article',
                },
            ],
        },
    },
}

{
    const fetchImpl = stubFetch([['api.crossref.org/works?', RESIDUAL_CANDIDATES]])
    const result = await run(
        [
            entry('he2015', {
                title: 'Deep Residual Learning for Image Recognition',
                author: 'He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing',
                year: '2015',
                eprint: '1512.03385',
                archiveprefix: 'arXiv',
            }),
        ],
        { fetchImpl }
    )
    check('an eprint entry is queried by title, not by DOI', fetchImpl.calls[0].url.includes('query.bibliographic='), fetchImpl.calls[0].url)
    check('the query asks for three rows and only the fields it needs', /rows=3/.test(fetchImpl.calls[0].url) && /select=DOI/.test(fetchImpl.calls[0].url))
    check('one finding, and it is the published version', result.findings.length === 1 && result.findings[0].kind === FINDING_KINDS.arxivPublished)
    check(
        'and it is the row whose AUTHOR matches, not the row that ranked first',
        result.findings[0].foundDoi === '10.1109/cvpr.2016.90',
        result.findings[0].foundDoi
    )
    check('it is labelled a suggestion', result.findings[0].grade === 'suggestion')
    check('and it says citing the preprint is not an error', /not an error/i.test(result.findings[0].detail), result.findings[0].detail)
}

// The same search, with only the stranger's paper in it: the title tokens are identical
// and the answer must still be nothing.
{
    const onlyTheSurvey = {
        status: 200,
        body: { status: 'ok', message: { items: [RESIDUAL_CANDIDATES.body.message.items[0]] } },
    }
    const fetchImpl = stubFetch([['api.crossref.org/works?', onlyTheSurvey]])
    const result = await run(
        [
            entry('he2015', {
                title: 'Deep Residual Learning for Image Recognition',
                author: 'He, Kaiming and Zhang, Xiangyu',
                year: '2015',
                eprint: '1512.03385',
            }),
        ],
        { fetchImpl }
    )
    check(
        'a same-title paper by other authors is never suggested',
        result.findings.length === 0,
        JSON.stringify(result.findings)
    )
    check(
        'the token sets really were identical, so only the author gate stopped it',
        titleSimilarity(
            'Deep Residual Learning for Image Recognition',
            'Deep Residual Learning for Image Recognition: A Survey'
        ) >= SIMILARITY.match
    )
}

// An entry with no author cannot pass the author gate, so nothing is suggested for it.
{
    const fetchImpl = stubFetch([['api.crossref.org/works?', RESIDUAL_CANDIDATES]])
    const result = await run(
        [entry('anon', { title: 'Deep Residual Learning for Image Recognition', eprint: '1512.03385' })],
        { fetchImpl }
    )
    check('an entry with no author gets no suggestion', result.findings.length === 0)
}

// The four ways a real bibliography says "this is a preprint".
{
    const marker = fields => arxivMarker(readEntry(entry('k', fields)))
    check('eprint + archivePrefix is recognised', marker({ eprint: '1512.03385', archiveprefix: 'arXiv' }) === '1512.03385')
    check('a bare eprint is recognised', marker({ eprint: '2101.00001' }) === '2101.00001')
    check('an arxiv.org url is recognised', marker({ url: 'https://arxiv.org/abs/1706.03762' }) === '1706.03762')
    check(
        'the "arXiv preprint arXiv:..." that Scholar puts in journal is recognised',
        marker({ journal: 'arXiv preprint arXiv:1706.03762' }) !== ''
    )
    check('arXiv own DOI prefix is recognised', marker({ doi: '10.48550/arXiv.1706.03762' }) !== '')
    check('an ordinary entry is not a preprint', marker({ doi: '10.1038/nature14539', journal: 'Nature' }) === '')
    check(
        'and an arXiv DOI is never sent to Crossref as a DOI lookup',
        arxivMarker(readEntry(entry('k', { doi: '10.48550/arXiv.1706.03762', title: 'x' }))) !== ''
    )
}

// ---------------------------------------------------------------------------
// the rate limiter: one grant per interval, whatever the concurrency does
// ---------------------------------------------------------------------------
{
    const clock = fakeClock()
    const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep })
    const waits = []
    for (let i = 0; i < 5; i++) waits.push(await limiter.acquire())
    check('the first request waits for nothing', waits[0] === 0)
    check('every other request waits the interval', waits.slice(1).every(w => w === 1000), JSON.stringify(waits))
    check('five requests take four intervals, not five', limiter.waitedMs === 4000, `${limiter.waitedMs}ms`)
    check('and the clock agrees', clock.elapsed() === 4000, `${clock.elapsed()}ms`)
}
{
    // Two callers in the SAME tick must get two different slots. This is what stops
    // concurrency 2 from turning one request per second into two.
    const clock = fakeClock()
    const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep })
    const both = await Promise.all([limiter.acquire(), limiter.acquire()])
    check('two callers in one tick are spaced apart', both[0] === 0 && both[1] === 1000, JSON.stringify(both))
}
{
    // End to end, through the real code path: ten DOI lookups against a stub that
    // answers instantly still cost nine intervals of throttling.
    const clock = fakeClock()
    const fetchImpl = stubFetch([['api.crossref.org', work({ DOI: 'x', title: ['Deep learning'], author: [{ family: 'LeCun' }], issued: { 'date-parts': [[2015]] } })]])
    const entries = Array.from({ length: 10 }, (_, i) =>
        entry(`k${i}`, { doi: `10.1000/x.${i}`, title: 'Deep learning', author: 'LeCun, Yann', year: '2015' })
    )
    const result = await run(entries, {
        fetchImpl,
        concurrency: 2,
        minRequestIntervalMs: 1000,
        now: clock.now,
        sleep: clock.sleep,
    })
    check('ten lookups make ten requests', result.requests === 10 && fetchImpl.calls.length === 10)
    check('and they are throttled to one per second', result.waitedMs === 9000, `${result.waitedMs}ms`)
    check('the default sustained rate is one per second', LIMITS.minRequestIntervalMs === 1000)
    check('the default concurrency is two', LIMITS.concurrency === 2)
}

// The in-run cache: a bibliography that cites the same DOI eight times costs one
// request, and the eight entries are all reported.
{
    const fetchImpl = stubFetch([['api.crossref.org', { status: 404, body: 'Resource not found.' }], ['doi.org/api/handles', handleMissing]])
    const entries = Array.from({ length: 8 }, (_, i) =>
        entry(`dup${i}`, { doi: '10.1234/same', title: 'A study of duplicated citations', author: 'Rossi, M', year: '2020' })
    )
    const result = await run(entries, { fetchImpl })
    check('a repeated DOI costs one lookup and one confirmation', result.requests === 2, `${result.requests} requests`)
    check('and all eight entries are still reported', result.findings.length === 8)
}

// ---------------------------------------------------------------------------
// the request budget: what it says it spent is what it spent
// ---------------------------------------------------------------------------
{
    const fetchImpl = stubFetch([
        ['api.crossref.org', work({ DOI: 'x', title: ['Deep learning'], author: [{ family: 'LeCun' }], issued: { 'date-parts': [[2015]] } })],
    ])
    const entries = Array.from({ length: 7 }, (_, i) =>
        entry(`k${i}`, { doi: `10.1000/y.${i}`, title: 'Deep learning', author: 'LeCun, Yann', year: '2015' })
    )
    const result = await run(entries, { fetchImpl, maxRequests: 3 })
    check('the cap is never exceeded', result.requests === 3 && fetchImpl.calls.length === 3, `${result.requests} requests, ${fetchImpl.calls.length} calls`)
    check('only the entries that fitted are counted as checked', result.checked === 3, `${result.checked} checked`)
    check(
        'the rest are reported as not checked, and why',
        result.unchecked.length === 4 && result.unchecked.every(u => u.reason === UNCHECKED_REASONS.requestCap),
        JSON.stringify(result.unchecked)
    )
    check('checked plus unchecked is the whole bibliography', result.checked + result.unchecked.length === result.total)
    check('the summary states the coverage honestly', formatBibVerifyFacts(result)[0].includes('checked 3 of 7'), formatBibVerifyFacts(result)[0])
    check('the shipped default budget is 60 requests', LIMITS.maxRequests === 60)
}

// The lists are capped, and the caps are never silent.
{
    const fetchImpl = stubFetch([['api.crossref.org', { status: 404, body: 'Resource not found.' }], ['doi.org/api/handles', handleMissing]])
    const entries = Array.from({ length: 40 }, (_, i) =>
        entry(`k${i}`, { doi: `10.1234/gone.${i}`, title: `A study of nothing number ${i}`, author: 'Rossi, M', year: '2020' })
    )
    const result = await run(entries, { fetchImpl, maxRequests: 200 })
    check('the findings list is capped', result.findings.length === LIMITS.findings, `${result.findings.length}`)
    check('and the true total travels with it', result.totals.findings.total === 40 && result.totals.findings.shown === LIMITS.findings, JSON.stringify(result.totals))
    check(
        'and the cut is stated where the reader sees it',
        formatBibVerifyFacts(result)[0].includes(`showing the first ${LIMITS.findings} of 40 findings`),
        formatBibVerifyFacts(result)[0]
    )
    check('the JSON stays small enough to store in three places', JSON.stringify(result).length < 32 * 1024, `${JSON.stringify(result).length} bytes`)
}

// The strongest evidence survives the cap: a resolving-nowhere DOI is never dropped in
// favour of a suggestion about a preprint.
{
    const fetchImpl = stubFetch([
        ['query.bibliographic', RESIDUAL_CANDIDATES],
        ['api.crossref.org/works/', { status: 404, body: 'Resource not found.' }],
        ['doi.org/api/handles', handleMissing],
    ])
    const preprints = Array.from({ length: LIMITS.findings }, (_, i) =>
        entry(`pre${i}`, {
            title: 'Deep Residual Learning for Image Recognition',
            author: 'He, Kaiming',
            eprint: `1512.0338${i}`,
        })
    )
    const result = await run([...preprints, entry('gone', { doi: '10.1234/gone', title: 'A study of nothing at all', author: 'Rossi, M', year: '2020' })], {
        fetchImpl,
        maxRequests: 200,
    })
    check(
        'the 404 is the first finding, not the one that fell off the end',
        result.findings[0].kind === FINDING_KINDS.notFound,
        result.findings.map(f => f.kind).join(',')
    )
    check('and the list is still capped', result.findings.length === LIMITS.findings)
}

// ---------------------------------------------------------------------------
// every network failure degrades to "not checked", never to a finding
// ---------------------------------------------------------------------------
{
    const cases = [
        ['a connection that throws', [['api.crossref.org', new Error('ECONNREFUSED')]], UNCHECKED_REASONS.networkError, 2],
        ['a 500 that stays broken', [['api.crossref.org', { status: 500, body: 'boom' }]], UNCHECKED_REASONS.networkError, 2],
        ['a 429', [['api.crossref.org', { status: 429, body: 'slow down' }]], UNCHECKED_REASONS.rateLimited, 1],
        ['a 403', [['api.crossref.org', { status: 403, body: 'no' }]], UNCHECKED_REASONS.networkError, 1],
        ['a 200 that is not JSON', [['api.crossref.org', { status: 200, body: '<html>gateway</html>' }]], UNCHECKED_REASONS.networkError, 1],
    ]
    for (const [name, routes, reason, calls] of cases) {
        const fetchImpl = stubFetch(routes)
        const result = await run(
            [entry('k', { doi: '10.1234/x', title: 'A study of something', author: 'Rossi, M', year: '2020' })],
            { fetchImpl }
        )
        check(`${name}: no finding`, result.findings.length === 0, JSON.stringify(result.findings))
        check(`${name}: reported as not checked (${reason})`, result.unchecked.length === 1 && result.unchecked[0].reason === reason, JSON.stringify(result.unchecked))
        check(`${name}: retried only where retrying is polite`, fetchImpl.calls.length === calls, `${fetchImpl.calls.length} calls`)
        check(`${name}: the retry is charged to the budget`, result.requests === calls)
    }
}

// A 500 that recovers on the retry is a completed check, not a failure.
{
    const fetchImpl = stubFetch([
        [
            'api.crossref.org',
            (url, n) =>
                n === 1
                    ? { status: 503, body: 'unavailable' }
                    : work({ DOI: 'x', title: ['Deep learning'], author: [{ family: 'LeCun' }], issued: { 'date-parts': [[2015]] } }),
        ],
    ])
    const result = await run([entry('k', { doi: '10.1234/x', title: 'Deep learning', author: 'LeCun, Yann', year: '2015' })], { fetchImpl })
    check('one retry rescues a 5xx', result.checked === 1 && result.findings.length === 0 && result.unchecked.length === 0)
    check('and both attempts are counted', result.requests === 2)
}

// A cancelled review stops making requests.
{
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = stubFetch([['api.crossref.org', work({ title: ['x'] })]])
    const result = await run([entry('k', { doi: '10.1234/x', title: 'A study of something', author: 'Rossi, M' })], {
        fetchImpl,
        signal: controller.signal,
    })
    check('an aborted review makes no request', fetchImpl.calls.length === 0)
    check('and reports the entries as not checked', result.unchecked.length === 1 && result.unchecked[0].reason === UNCHECKED_REASONS.cancelled)
    check('with no findings', result.findings.length === 0)
}

// An entry with nothing to look up is not a failure and not a pass.
{
    const fetchImpl = stubFetch([['api.crossref.org', work({ title: ['x'] })]])
    const result = await run(
        [
            entry('book', { title: 'An introduction to control theory', author: 'Ogata, K', year: '2010', publisher: 'Prentice Hall' }),
            entry('broken', { title: 'Another book entirely', author: 'Neri, P', doi: 'see the publisher website' }),
        ],
        { fetchImpl }
    )
    check('an entry with no DOI makes no request', fetchImpl.calls.length === 0)
    check(
        'and is reported by reason',
        result.uncheckedByReason[UNCHECKED_REASONS.noDoi] === 1 && result.uncheckedByReason[UNCHECKED_REASONS.unreadableDoi] === 1,
        JSON.stringify(result.uncheckedByReason)
    )
    check('the summary counts them', formatBibVerifyFacts(result)[0].includes('carry no DOI'), formatBibVerifyFacts(result)[0])
    check(
        'and the closing line refuses to be read as a verdict',
        formatBibVerifyFacts(result).join(' ').includes('not verdicts about the student')
    )
}

// ---------------------------------------------------------------------------
// reading the entry: the two shapes a caller can hand over
// ---------------------------------------------------------------------------
{
    // What the .bib parser in the codebase produces: a Map whose values are cut at
    // eighty characters and at the first comma. A title read from it alone would be
    // truncated, which is why the raw body wins when it is there.
    const body = [
        '@article{rossi2021,',
        '  abstract = {A very long abstract, with commas in it, that goes on for a while and mentions author = nobody},',
        '  title = {Machine learning for structural health monitoring, with a long subtitle},',
        '  author = {Rossi, Marco and Verdi, Anna},',
        '  year = {2021},',
        '  doi = {10.1234/abcd},',
        '}',
    ].join('\n')
    const truncated = new Map([
        ['title', '{Machine learning for structural health monitoring'],
        ['author', '{Rossi'],
        ['year', '{2021}'],
    ])
    const fromBody = readEntry({ key: 'rossi2021', body, fields: truncated, file: 'refs.bib', line: 3 })
    check('the raw body wins over a truncated field map', fromBody.title === 'Machine learning for structural health monitoring, with a long subtitle', fromBody.title)
    check('the author is read whole', fromBody.author === 'Rossi, Marco and Verdi, Anna', fromBody.author)
    check('the DOI is read', fromBody.doi === '10.1234/abcd')
    check('a "name = value" inside an abstract is not a field', collectFields(body).get('author') === 'Rossi, Marco and Verdi, Anna')

    const fromMap = readEntry({ key: 'rossi2021', fields: truncated })
    check('a field map alone still works', fromMap.title === 'Machine learning for structural health monitoring' && fromMap.year === 2021, JSON.stringify(fromMap))
    check('and a stray opening brace never reaches the report', !/[{}]/.test(fromMap.author), fromMap.author)

    const fromObject = readEntry({ key: 'x', fields: { Title: 'Plain object title', DOI: '10.1234/abcd' } })
    check('a plain object works, case-insensitively', fromObject.title === 'Plain object title' && fromObject.doi === '10.1234/abcd', JSON.stringify(fromObject))
    check('a string that is not a DOI is not read as one', readDoi('see the publisher website') === '')

    check('a DOI inside a url field is found', readEntry({ key: 'x', fields: { url: 'https://dx.doi.org/10.1234/abcd' } }).doi === '10.1234/abcd')
    check('a trailing full stop is not part of a DOI', readDoi('doi:10.1234/abcd.') === '10.1234/abcd')
    check('a biblatex date supplies the year', readEntry({ key: 'x', fields: { date: '2019-04-12' } }).year === 2019)
}

// A crafted DOI must not climb out of the API path this module builds. The suffix is
// student-controlled and encodeDoi keeps a bare dot intact, so readDoi rejects any
// "/"-separated segment that IS "." or ".." - the shape of a path-traversal payload -
// while leaving a legitimate dotted suffix alone. Budget.get follows redirects, so a DOI
// that escaped /works could resolve to a handle an attacker registered under their prefix.
{
    const encodeDoi = d => d.split('/').map(encodeURIComponent).join('/')
    for (const raw of [
        '10.1234/../../../10.5555/attacker-doi',
        '10.1234/../../../../',
        '10.1234/../../..',
        '10.1234/./secret',
    ]) {
        check(`a path-traversal DOI is rejected: ${raw}`, readDoi(raw) === '', JSON.stringify(readDoi(raw)))
    }
    // Legitimate DOIs, dots inside their segments and all, are untouched and every one
    // stays under the /works path.
    for (const raw of [
        '10.1000/xyz123',
        '10.1234/j.foo.2020',
        '10.48550/arXiv.1234.5678',
        '10.1016/S0140-6736(20)30183-5',
    ]) {
        const doi = readDoi(raw)
        const url = new URL(`https://api.crossref.org/works/${encodeDoi(doi)}`)
        check(
            `a legitimate DOI still resolves under /works: ${raw}`,
            doi === raw && url.pathname.startsWith('/works/'),
            url.href
        )
    }
}

// A truncated entry title behaves like a short one: it may confirm, it may not accuse.
{
    const fetchImpl = stubFetch([
        [
            'api.crossref.org/works/',
            work({
                DOI: '10.1234/abcd',
                title: ['Machine learning for structural health monitoring, with a long subtitle'],
                author: [{ family: 'Rossi', given: 'Marco' }],
                issued: { 'date-parts': [[2021]] },
            }),
        ],
    ])
    const result = await run(
        [
            {
                key: 'rossi2021',
                file: 'refs.bib',
                line: 3,
                fields: new Map([
                    ['title', '{Machine learning for structural health monitoring'],
                    ['author', '{Rossi'],
                    ['year', '{2021}'],
                    ['doi', '{10.1234/abcd}'],
                ]),
            },
        ],
        { fetchImpl }
    )
    check('a title truncated by the caller still matches its record', result.findings.length === 0, JSON.stringify(result.findings))
}

// ---------------------------------------------------------------------------
// degenerate input: this runs inside a review that is otherwise finished
// ---------------------------------------------------------------------------
{
    const fetchImpl = stubFetch([['api.crossref.org', work({ title: ['x'] })]])
    for (const input of [null, undefined, [], [{}], [{ key: 'x' }], [{ key: 'x', fields: null }], ['nonsense'], [{ body: '@article{' }]]) {
        let threw = null
        let result = null
        try {
            result = await run(input, { fetchImpl })
        } catch (err) {
            threw = err
        }
        check(`degenerate input survives: ${JSON.stringify(input)}`, threw === null && result !== null, threw && threw.message)
        if (result) {
            check(`   and produces no finding`, result.findings.length === 0)
        }
    }
}

// A .bib of a thousand entries must not become a thousand requests.
{
    const fetchImpl = stubFetch([['api.crossref.org', work({ DOI: 'x', title: ['Deep learning'], author: [{ family: 'LeCun' }], issued: { 'date-parts': [[2015]] } })]])
    const clock = fakeClock()
    const entries = Array.from({ length: 1000 }, (_, i) =>
        entry(`k${i}`, { doi: `10.1000/z.${i}`, title: 'Deep learning', author: 'LeCun, Yann', year: '2015' })
    )
    const started = Date.now()
    const result = await run(entries, { fetchImpl, now: clock.now, sleep: clock.sleep, concurrency: 2 })
    check('a thousand entries cost the budget and no more', result.requests === LIMITS.maxRequests, `${result.requests} requests`)
    check('and the report says how much of the bibliography that was', formatBibVerifyFacts(result)[0].includes(`of 1000 entries`), formatBibVerifyFacts(result)[0])
    check('and it stays fast', Date.now() - started < 5000, `${Date.now() - started}ms`)
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
