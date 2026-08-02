// The "AI writing signals" section, which is the one part of the review that could do
// real damage if it were wrong: it is read next to a student's name.
//
// So the suite is written against the two promises the section makes. It never reports
// a single hit, and it has no absolute threshold for style: a chapter is only ever
// compared against the other chapters of the SAME document. Both promises are cheap to
// break by accident and expensive to have broken in front of a supervisor, so each one
// has a case here that goes red the moment the constant behind it moves.
//
// Unlike most suites in this directory, this one imports the real modules instead of
// slicing them: they are pure functions with no Overleaf imports, which is itself part
// of the design (phase 1 makes no model call and touches nothing).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = process.env.CTRL ? path.dirname(process.env.CTRL) : path.resolve(HERE, '../vendor/llm/app/src')
const MODULE = path.join(SRC, 'LLMAISignals.mjs')
const PATTERNS = path.join(SRC, 'ai-signal-patterns.mjs')

let signals
let patternData
try {
    signals = await import(pathToFileURL(MODULE).href)
    patternData = await import(pathToFileURL(PATTERNS).href)
} catch (err) {
    console.error(`FAIL: could not load the AI signals module\n${err.stack || err.message}`)
    process.exit(1)
}

const {
    analyzeAiWritingSignals,
    compilePatterns,
    computeChapterMetrics,
    findArtifacts,
    findClusters,
    flagDeviations,
    lexicalMatches,
    plainProse,
    splitSentences,
    hasAiSignals,
    buildChapterSource,
    collectClusters,
    stdev,
    median,
    medianAbsoluteDeviation,
    SIGNAL_DEFINITIONS,
    MIN_CHAPTERS_FOR_BASELINE,
    CLUSTER_MIN_MARKERS,
    LIMITS,
} = signals
const { LEXICAL_PATTERNS, ARTIFACT_PATTERNS, AI_SIGNAL_PATTERNS_VERSION } = patternData

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// The characters this module is about are never written literally in this repository,
// here no more than in the sources.
const EM_DASH = String.fromCharCode(0x2014)
const LEFT_QUOTE = String.fromCharCode(0x201c)
const RIGHT_QUOTE = String.fromCharCode(0x201d)

// ---------------------------------------------------------------------------
// every shipped pattern compiles, and every one of them can actually match
// ---------------------------------------------------------------------------
// Compiling is not enough. `\bè` compiles and never matches anything, because `\b` is
// defined over ASCII word characters and an accented letter is not one: half the
// Italian list would have been dead code that no test noticed. Each entry therefore
// gets a specimen it MUST match.
{
    check('the pattern list is dated', /^\d{4}-\d{2}$/.test(AI_SIGNAL_PATTERNS_VERSION), AI_SIGNAL_PATTERNS_VERSION)
    const compiled = compilePatterns(LEXICAL_PATTERNS)
    check(
        'every lexical pattern compiles under the u flag',
        compiled.length === LEXICAL_PATTERNS.length,
        `${compiled.length}/${LEXICAL_PATTERNS.length}`
    )
    check(
        'every lexical pattern carries an id, a language and a label',
        LEXICAL_PATTERNS.every(p => p.id && (p.lang === 'en' || p.lang === 'it') && p.label && p.source)
    )
    const ids = LEXICAL_PATTERNS.map(p => p.id)
    check('lexical ids are unique', ids.length === new Set(ids).size)
    check(
        'both languages are shipped and always applied',
        LEXICAL_PATTERNS.some(p => p.lang === 'en') && LEXICAL_PATTERNS.some(p => p.lang === 'it')
    )
    const artifacts = compilePatterns(ARTIFACT_PATTERNS)
    check(
        'every artifact pattern compiles under the u flag',
        artifacts.length === ARTIFACT_PATTERNS.length,
        `${artifacts.length}/${ARTIFACT_PATTERNS.length}`
    )
}

const SPECIMENS = {
    'en-delve': 'We delve into the measurements of the second run.',
    'en-showcase': 'This chapter showcases the prototype.',
    'en-underscore': 'The results underscore the need for a larger sample.',
    'en-testament': 'The uptime is a testament to the design.',
    'en-tapestry': 'A rich tapestry of related work.',
    'en-pivotal': 'This was a pivotal decision.',
    'en-crucial': 'The timing is crucial.',
    'en-intricate': 'An intricate control loop.',
    'en-landscape': 'the evolving landscape of embedded software',
    'en-meticulous': 'a meticulous calibration of the sensor',
    'en-boasts': 'The board boasts eight cores.',
    'en-not-only-but-also': 'The method is not only faster but also cheaper.',
    'en-additionally': 'Additionally, the test was repeated.',
    'en-important-to-note': 'It is important to note that the sample was small.',
    'en-crucial-role': 'Latency plays a crucial role in the result.',
    'it-importante-sottolineare': "E' importante sottolineare che il campione era ridotto.",
    'it-ruolo-cruciale': 'La cache gioca un ruolo cruciale.',
    'it-ruolo-fondamentale': 'La rete riveste un ruolo fondamentale.',
    'it-mondo-in-evoluzione': 'In un mondo in continua evoluzione servono strumenti nuovi.',
    'it-non-solo-ma-anche': 'Il metodo non solo riduce i costi ma anche i tempi.',
    'it-vale-la-pena': 'Vale la pena notare questo comportamento.',
    'it-testimonianza-di': 'una testimonianza del lavoro svolto',
    'it-sbloccare-potenziale': 'per sbloccare il pieno potenziale del sistema',
    'it-cuore-pulsante': 'il cuore pulsante del sistema',
    'it-continua-evoluzione': 'Il settore risulta in continua evoluzione.',
    'it-cruciale-fondamentale': 'un requisito imprescindibile del progetto',
}
{
    const missing = LEXICAL_PATTERNS.filter(p => !SPECIMENS[p.id])
    check('every shipped pattern has a specimen in this suite', missing.length === 0, missing.map(p => p.id).join(','))
    for (const pattern of LEXICAL_PATTERNS) {
        const specimen = SPECIMENS[pattern.id]
        if (!specimen) continue
        const hits = lexicalMatches(specimen).map(h => h.id)
        check(`${pattern.id} matches its specimen`, hits.includes(pattern.id), hits.join(',') || 'no match at all')
    }
    // An Italian pattern over English prose, and the other way round, must simply not
    // match: that is what lets both lists run over every chapter with no language
    // detection step, which is one less thing to get wrong on a bilingual thesis.
    const english = lexicalMatches('The results underscore the need for a larger sample of measurements.')
    check('an Italian pattern does not fire on English prose', english.every(h => h.lang === 'en'), english.map(h => h.id).join(','))
    const italian = lexicalMatches('La rete riveste un ruolo fondamentale nel sistema descritto.')
    check('an English pattern does not fire on Italian prose', italian.every(h => h.lang === 'it'), italian.map(h => h.id).join(','))
}

// ---------------------------------------------------------------------------
// overlapping markers are one marker
// ---------------------------------------------------------------------------
// "riveste un ruolo fondamentale" contains "fondamentale". Counted as two, one turn of
// phrase reaches two thirds of the cluster threshold on its own.
{
    const hits = lexicalMatches('La rete riveste un ruolo fondamentale nel progetto.')
    check('a phrase and the word inside it count once', hits.length === 1, hits.map(h => h.id).join(','))
    const english = lexicalMatches('Latency plays a crucial role in this design.')
    check('the longer English phrase wins over the word inside it', english.length === 1, english.map(h => h.id).join(','))
}

// ---------------------------------------------------------------------------
// the statistics, on hand-computed fixtures
// ---------------------------------------------------------------------------
{
    // Sentence lengths 2, 10, 3, 9. Mean 6, squared deviations 16+16+9+9 = 50,
    // variance 12.5, standard deviation 3.535533905932738.
    const text = [
        'One two.',
        'Alpha beta gamma delta epsilon zeta eta theta iota kappa.',
        'Red green blue.',
        'Alpha beta gamma delta epsilon zeta eta theta iota.',
    ].join(' ')
    const sentences = splitSentences(text)
    check('the fixture splits into the four sentences it was built from', sentences.length === 4, `${sentences.length}`)
    check('stdev of the hand-computed sample', Math.abs(stdev([2, 10, 3, 9]) - 3.535533905932738) < 1e-12)
    const metrics = computeChapterMetrics({ name: 'Fixture', text })
    check(
        'the chapter metric reproduces the hand-computed burstiness',
        Math.abs(metrics.signals.sentenceLengthVariation - 3.535533905932738) < 1e-9,
        `${metrics.signals.sentenceLengthVariation}`
    )
    check('and counts the 24 words of the fixture', metrics.words === 24, `${metrics.words}`)
    // A chapter of equal-length sentences has zero variation, which is the direction
    // that carries the signal.
    const flat = computeChapterMetrics({ name: 'Flat', text: 'one two three. four five six. seven eight nine.' })
    check('identical sentence lengths give zero variation', flat.signals.sentenceLengthVariation === 0)
}
{
    // Paragraph word counts 5, 15, 10: mean 10, variance (25+25+0)/3, spread 4.0824829,
    // relative spread 0.40824829.
    const paragraph = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
    const metrics = computeChapterMetrics({ name: 'P', text: [paragraph(5), paragraph(15), paragraph(10)].join('\n\n') })
    check(
        'paragraph uniformity is the spread relative to the mean',
        Math.abs(metrics.signals.paragraphLengthVariation - 0.4082482904638631) < 1e-9,
        `${metrics.signals.paragraphLengthVariation}`
    )
}
{
    check('median of an even sample', median([1, 2, 3, 4]) === 2.5)
    check('median absolute deviation', medianAbsoluteDeviation([2, 2, 3, 8]) === 0.5, `${medianAbsoluteDeviation([2, 2, 3, 8])}`)
    check('every defined signal is actually computed', SIGNAL_DEFINITIONS.every(d => d.id in computeChapterMetrics({ name: 'x', text: 'a b c. d e f. g h i.' }).signals))
}

// ---------------------------------------------------------------------------
// the em-dash, counted in both spellings and never written literally
// ---------------------------------------------------------------------------
{
    const metrics = computeChapterMetrics({
        name: 'Dashes',
        text: `The result --- and this matters ${EM_DASH} was reproduced twice.`,
    })
    check('both spellings of the em-dash are counted', metrics.counts.emDash === 2, `${metrics.counts.emDash}`)
    const enDash = computeChapterMetrics({ name: 'Ranges', text: 'pages 10--12 and 14--16' })
    check('an en-dash range is not an em-dash', enDash.counts.emDash === 0, `${enDash.counts.emDash}`)
    // The pattern that finds the literal character must itself be an escape: this
    // codebase does not contain the character, and a grep for it has to stay empty.
    const literal = ARTIFACT_PATTERNS.find(p => p.id === 'artifact-literal-em-dash')
    check('the em-dash artifact pattern is written as a unicode escape', literal.source === '\\u2014', JSON.stringify(literal.source))
    for (const file of [MODULE, PATTERNS]) {
        const text = fs.readFileSync(file, 'utf8')
        check(
            `${path.basename(file)} contains no literal em-dash character`,
            !text.includes(EM_DASH),
            `${text.indexOf(EM_DASH)}`
        )
    }
}

// ---------------------------------------------------------------------------
// the baseline: a chapter is compared against its own document, or against nothing
// ---------------------------------------------------------------------------
const flatSignals = {
    emDashPer1000: 2,
    sentenceLengthVariation: 5,
    paragraphLengthVariation: 0.4,
    connectiveOpeningsPer100Sentences: 10,
    tripletsPer1000: 1,
    listItemsPer1000: 2,
    boldLeadItemsPer1000: 0,
    lexicalMarkersPer1000: 1,
}
const fakeChapter = (name, emDashRate, emDashCount) => ({
    name,
    words: 1000,
    evidence: {},
    counts: { emDash: emDashCount, triplets: 3, items: 5, boldItems: 3, openers: 3, markers: 3 },
    signals: { ...flatSignals, emDashPer1000: emDashRate },
})
// A chapter that is either exactly like its neighbours or unlike them on every single
// signal. Used to build the worst case the stored block can be asked to hold.
const fakeChapterOnEverySignal = (name, different) => ({
    name,
    words: 1000,
    evidence: {},
    counts: { emDash: 40, triplets: 40, items: 40, boldItems: 40, openers: 40, markers: 40 },
    signals: different
        ? {
              emDashPer1000: 40,
              sentenceLengthVariation: 20,
              paragraphLengthVariation: 1.4,
              connectiveOpeningsPer100Sentences: 60,
              tripletsPer1000: 20,
              listItemsPer1000: 40,
              boldLeadItemsPer1000: 20,
              lexicalMarkersPer1000: 30,
          }
        : { ...flatSignals },
})
{
    // Four chapters agree, the fifth does not: exactly one chapter, on exactly the one
    // signal that differs. Everything else is identical across the five, so there is no
    // spread to measure and those signals say nothing rather than saying zero.
    const five = [
        fakeChapter('One', 2, 2),
        fakeChapter('Two', 2, 2),
        fakeChapter('Three', 2, 2),
        fakeChapter('Four', 2, 2),
        fakeChapter('Five', 20, 20),
    ]
    const { compared, flagged } = flagDeviations(five)
    check('five chapters are compared', compared === 5, `${compared}`)
    check('exactly one chapter is flagged', flagged.length === 1, flagged.map(f => f.name).join(','))
    check('and it is the one that deviates', flagged[0]?.name === 'Five', flagged[0]?.name)
    check(
        'on exactly the signal that deviates',
        flagged[0]?.signals.length === 1 && flagged[0].signals[0].id === 'emDashPer1000',
        (flagged[0]?.signals || []).map(s => s.id).join(',')
    )
    check(
        'and the report carries the value and the median it was compared against',
        flagged[0]?.signals[0].value === 20 && flagged[0].signals[0].thesisMedian === 2,
        JSON.stringify(flagged[0]?.signals[0])
    )

    // THE SAME DEVIATION, three chapters. Below four there is no baseline worth the
    // name: the median moves with the chapter under test, so nothing may be flagged.
    const three = [fakeChapter('One', 2, 2), fakeChapter('Two', 2, 2), fakeChapter('Five', 20, 20)]
    const short = flagDeviations(three)
    check('three chapters flag nothing at all', short.flagged.length === 0, short.flagged.map(f => f.name).join(','))
    check('and the minimum is the documented one', MIN_CHAPTERS_FOR_BASELINE === 4, `${MIN_CHAPTERS_FOR_BASELINE}`)
}
{
    // A document whose chapters vary normally. The highest chapter sits exactly three
    // median absolute deviations out, which is the boundary: at the boundary nothing is
    // flagged, because "more than three" is the rule.
    const spread = [
        fakeChapter('One', 2, 2),
        fakeChapter('Two', 3, 3),
        fakeChapter('Three', 1, 1),
        fakeChapter('Four', 4, 4),
        fakeChapter('Five', 6, 6),
    ]
    const { flagged } = flagDeviations(spread)
    check('a chapter at the top of an ordinary spread is not flagged', flagged.length === 0, flagged.map(f => f.name).join(','))
}
{
    // The floor that makes "a single hit is never reported" true. One em-dash in a
    // chapter whose neighbours have none is an infinite relative difference and would
    // otherwise be pointed at.
    const one = [
        fakeChapter('One', 0, 0),
        fakeChapter('Two', 0, 0),
        fakeChapter('Three', 0, 0),
        fakeChapter('Four', 0, 0),
        fakeChapter('Five', 5, 1),
    ]
    const { flagged } = flagDeviations(one)
    check('one occurrence is never enough to flag a chapter', flagged.length === 0, JSON.stringify(flagged))
}

// ---------------------------------------------------------------------------
// end to end, on chapters that are text rather than numbers
// ---------------------------------------------------------------------------
const proseChapter = extra => {
    const body = [
        'The measurement setup is described in this section of the work.',
        'Each run was repeated three times and the median was retained.',
        'The board was kept at room temperature during every acquisition.',
        'Results are reported with the uncertainty of the instrument.',
        'A second operator repeated the procedure on a different day.',
        'The two series agree within the stated uncertainty.',
        'No correction was applied to the raw readings of the sensor.',
        'The complete tables are given in the appendix of this document.',
    ]
    return `${body.join(' ')}\n\n${body.join(' ')}\n\n${body.join(' ')}${extra ? `\n\n${extra}` : ''}`
}
{
    const chapters = [
        { name: 'Chapter one', text: proseChapter('') },
        { name: 'Chapter two', text: proseChapter('') },
        { name: 'Chapter three', text: proseChapter('') },
        { name: 'Chapter four', text: proseChapter('') },
        {
            name: 'Chapter five',
            text: proseChapter(
                `The setup ${EM_DASH} described above ${EM_DASH} was reused here ${EM_DASH} without changes ${EM_DASH} throughout ${EM_DASH} the campaign ${EM_DASH} in every run ${EM_DASH} of the second series ${EM_DASH} as noted.`
            ),
        },
    ]
    const block = analyzeAiWritingSignals(chapters)
    check('the block names the pattern version it used', block.version === AI_SIGNAL_PATTERNS_VERSION, block.version)
    check('the totals count every chapter', block.totals.chapters === 5, JSON.stringify(block.totals))
    check(
        'the chapter that reads differently is the one flagged',
        block.flaggedChapters.length === 1 && block.flaggedChapters[0].name === 'Chapter five',
        block.flaggedChapters.map(f => f.name).join(',')
    )
    check(
        'and the em-dash density is what named it',
        (block.flaggedChapters[0]?.signals || []).some(s => s.id === 'emDashPer1000'),
        (block.flaggedChapters[0]?.signals || []).map(s => s.id).join(',')
    )
    const emDash = (block.flaggedChapters[0]?.signals || []).find(s => s.id === 'emDashPer1000')
    check('the flagged signal quotes the passages it counted', (emDash?.excerpts || []).length > 0)
    // Eight em-dashes, five excerpts kept: the row has to say what it is a sample of,
    // or the reader reads five and believes there were five.
    check(
        'and says how many occurrences the quotations are a sample of',
        emDash?.excerpts.length === LIMITS.excerptsPerSignal && emDash?.excerptsTotal === 8,
        `${emDash?.excerpts.length} shown of ${emDash?.excerptsTotal}`
    )
    check(
        'nothing is capped on an ordinary document',
        block.totals.artifacts.shown === block.totals.artifacts.total &&
            block.totals.clusters.shown === block.totals.clusters.total &&
            block.totals.flaggedChapters.shown === block.totals.flaggedChapters.total,
        JSON.stringify(block.totals)
    )
    // A short document has no baseline, so the same five chapters cut into three flag
    // nothing: same text, fewer chapters, no claim.
    const shorter = analyzeAiWritingSignals(chapters.slice(2))
    check('the same text in three chapters flags nothing', shorter.flaggedChapters.length === 0)
}
{
    // A clean thesis produces an empty block, and an empty block is what makes the
    // report render no section at all.
    const clean = analyzeAiWritingSignals(
        ['One', 'Two', 'Three', 'Four', 'Five'].map(name => ({ name, text: proseChapter('') }))
    )
    check('a clean document flags nothing', clean.flaggedChapters.length === 0, JSON.stringify(clean.flaggedChapters))
    check('and carries no artifacts and no clusters', clean.artifacts.length === 0 && clean.clusters.length === 0)
    check('so the renderer is told there is nothing to show', hasAiSignals(clean) === false)
}

// ---------------------------------------------------------------------------
// clusters: three DISTINCT markers in one paragraph, never two, never one repeated
// ---------------------------------------------------------------------------
{
    const two = findClusters([
        { name: 'C', text: 'It is important to note that the timing is crucial for the outcome of the run.' },
    ]).clusters
    check('two distinct markers in a paragraph are not reported', two.length === 0, JSON.stringify(two))

    const three = findClusters([
        {
            name: 'C',
            text: 'It is important to note that the timing is crucial. Additionally, the sample was small.',
        },
    ]).clusters
    check('three distinct markers in a paragraph are reported', three.length === 1, JSON.stringify(three))
    check('and the report says which three', (three[0]?.markers || []).length === 3, (three[0]?.markers || []).join(' | '))
    check('with a short quotation of the paragraph', (three[0]?.paragraphExcerpt || '').length > 0 && three[0].paragraphExcerpt.length <= 160)
    check('the threshold is the documented one', CLUSTER_MIN_MARKERS === 3, `${CLUSTER_MIN_MARKERS}`)

    const repeated = findClusters([
        { name: 'C', text: 'This is crucial. That is crucial. Everything about it is crucial.' },
    ]).clusters
    check('one marker three times is one marker', repeated.length === 0, JSON.stringify(repeated))

    // Markers do not reach across a paragraph break: two paragraphs with two markers
    // each are two ordinary paragraphs.
    const split = findClusters([
        {
            name: 'C',
            text: 'It is important to note that the timing is crucial.\n\nAdditionally, the design is pivotal.',
        },
    ]).clusters
    check('markers do not cross a paragraph break', split.length === 0, JSON.stringify(split))

    // A cluster is local: it is reported with no baseline at all, from one chapter.
    const lone = analyzeAiWritingSignals([
        {
            name: 'Only chapter',
            text: 'It is important to note that the timing is crucial. Additionally, the sample was small.',
        },
    ])
    check('a cluster is reported even with a single chapter', lone.clusters.length === 1, JSON.stringify(lone.clusters))
}

// ---------------------------------------------------------------------------
// artifacts: always reported, whatever the document looks like
// ---------------------------------------------------------------------------
{
    const docs = [
        { path: '/chapters/intro.tex', text: 'A sentence with an oaicite marker left in it.' },
        { path: '/chapters/method.tex', text: 'See :contentReference[oaicite:2]{index=2} for the source.' },
        { path: '/chapters/results.tex', text: 'Reference turn0search3 was consulted.' },
        { path: '/chapters/links.tex', text: 'https://example.org/page?utm_source=chatgpt.com' },
        { path: '/chapters/quotes.tex', text: `He said ${LEFT_QUOTE}it works${RIGHT_QUOTE} in the interview.` },
        { path: '/chapters/dash.tex', text: `The result ${EM_DASH} unexpected ${EM_DASH} was kept.` },
    ]
    const found = findArtifacts(docs).artifacts
    const byId = new Set(found.map(a => a.id))
    for (const id of [
        'artifact-oaicite',
        'artifact-content-reference',
        'artifact-turn-marker',
        'artifact-chatgpt-utm',
        'artifact-typographic-quotes',
        'artifact-literal-em-dash',
    ]) {
        check(`${id} is found`, byId.has(id), [...byId].join(','))
    }
    check('an artifact names the file it is in', found.every(a => a.file.startsWith('/chapters/')), found.map(a => a.file).join(','))
    check('and the line it is on', found.every(a => a.line >= 1))
    check('the tool markers are listed before the paste markers', found.findIndex(a => a.kind === 'paste') > found.findIndex(a => a.kind === 'tool'))
    check('repeated occurrences are one row with a count', found.find(a => a.id === 'artifact-literal-em-dash')?.occurrences === 2)

    // The point of the category: no baseline, no threshold, no minimum. One marker in a
    // twenty-word document is reported.
    const tiny = analyzeAiWritingSignals([{ name: 'Only', text: 'A short note with an oaicite marker in it.' }])
    check('a single artifact is reported with no baseline at all', tiny.artifacts.length === 1, JSON.stringify(tiny.artifacts))
    check('and the section is therefore rendered', hasAiSignals(tiny) === true)

    // Per-file attribution when the caller passes the documents a chapter is made of,
    // which is the shape the controller holds after segmentation.
    const perFile = analyzeAiWritingSignals([
        {
            name: 'Chapter one',
            docs: [
                { path: '/a.tex', text: 'Clean text with nothing in it at all.' },
                { path: '/b.tex', text: 'A line with oaicite in it.' },
            ],
        },
    ])
    check('an artifact is attributed to the file it is in, not to the chapter', perFile.artifacts[0]?.file === '/b.tex', JSON.stringify(perFile.artifacts))

    // A .bib is a segment of its own in the review, and it is not prose: a few thousand
    // author names with no sentences in them. It must not enter the baseline, and it
    // must still be scanned for artifacts.
    const withBib = analyzeAiWritingSignals([
        { name: 'One', text: proseChapter('') },
        { name: 'Two', text: proseChapter('') },
        { name: 'Three', text: proseChapter('') },
        { name: 'Four', text: proseChapter('') },
        {
            name: '/refs.bib',
            standalone: true,
            docs: [
                {
                    path: '/refs.bib',
                    text: '@article{a2020, title={A}, url={https://x.org/p?utm_source=chatgpt.com}}',
                },
            ],
        },
    ])
    check('a standalone non-prose file is left out of the baseline', withBib.totals.chapters === 4, `${withBib.totals.chapters}`)
    check(
        'but it is still scanned for artifacts',
        withBib.artifacts.some(a => a.id === 'artifact-chatgpt-utm' && a.file === '/refs.bib'),
        JSON.stringify(withBib.artifacts)
    )
}

// ---------------------------------------------------------------------------
// what the block may and may not contain
// ---------------------------------------------------------------------------
{
    const block = analyzeAiWritingSignals([
        { name: 'One', text: `${proseChapter('')} oaicite` },
        { name: 'Two', text: proseChapter('') },
        { name: 'Three', text: proseChapter('') },
        { name: 'Four', text: proseChapter('') },
        {
            name: 'Five',
            text: proseChapter(
                `It is important to note that the timing is crucial. Additionally, the sample ${EM_DASH} small ${EM_DASH} was reused ${EM_DASH} throughout ${EM_DASH} the work.`
            ),
        },
    ])
    const json = JSON.stringify(block)
    check('the block survives a round trip through JSON', JSON.stringify(JSON.parse(json)) === json)
    check('it has the four documented top-level keys', ['version', 'totals', 'artifacts', 'flaggedChapters', 'clusters'].every(k => k in block))
    // The section is not a detector and nothing stored may read as one.
    check('it never states a probability or calls itself a detection', !/probabilit|detection|detector|confidence that/i.test(json), json.slice(0, 200))
    check('and never asserts that something was generated', !/was (?:written|generated) by/i.test(json))
    // A per-signal excerpt is `{ text, file, line }` since it learned where it came
    // from, and was a bare string before. The bounds below are about the TEXT, and they
    // are asked of it through both shapes so that neither can drift out of them.
    const excerpts = [
        ...block.artifacts.map(a => a.excerpt),
        ...block.clusters.map(c => c.paragraphExcerpt),
        ...block.flaggedChapters.flatMap(f => f.signals.flatMap(s => s.excerpts)),
    ].map(e => (typeof e === 'string' ? e : e?.text || ''))
    check('every excerpt is short enough to read', excerpts.every(e => e.length <= 160), `${Math.max(0, ...excerpts.map(e => e.length))}`)
    check('and every excerpt is a single line', excerpts.every(e => !e.includes('\n')))
}

// ---------------------------------------------------------------------------
// LaTeX that is not prose must not be counted as prose
// ---------------------------------------------------------------------------
{
    const prose = plainProse(
        [
            '\\chapter{Method}',
            'The value \\cite{smith2020} was taken from the literature.',
            '\\begin{lstlisting}',
            'for (int i = 0; i < n; i++) { total += x[i]; }',
            '\\end{lstlisting}',
            'The equation $E = mc^2$ closes the argument.',
            '\\begin{tabular}{ll}a & b \\\\ c & d\\end{tabular}',
        ].join('\n')
    )
    check('a citation key is not counted as a word', !/smith2020/.test(prose), prose)
    check('a code listing is not counted as prose', !/total/.test(prose), prose)
    check('inline maths is not counted as prose', !/mc\^2/.test(prose), prose)
    check('a table body is not counted as prose', !/\ba\b\s*&/.test(prose), prose)
    check('but the text around it survives', /taken from the literature/.test(prose) && /closes the argument/.test(prose), prose)
    // Text inside a formatting command is text the author wrote, and the lexical list
    // has to see it.
    check('a word inside \\textbf is still a word', lexicalMatches(plainProse('This step is \\textbf{crucial} here.')).length === 1)
}

// ---------------------------------------------------------------------------
// what the prose reduction does with markup that never closes
// ---------------------------------------------------------------------------
// A file being edited is a file half written, and half of a LaTeX file is markup with
// no closing half. The rule is that an unterminated construct blanks NOTHING: reading
// it to the end of the chapter would delete prose the author did write, and every
// number this module reports would then describe a document nobody handed in.
{
    const unclosed = plainProse(String.raw`\begin{align}` + '\nx = y\n\nThe measurement is described here.')
    check('an unclosed environment does not swallow the chapter', /measurement is described/.test(unclosed), unclosed)
    const closed = plainProse(String.raw`\begin{align}` + '\nx = y\n' + String.raw`\end{align}` + '\nThe measurement is described here.')
    check('a closed environment is still not prose', !/x = y/.test(closed), closed)
    check('and the prose after it survives', /measurement is described/.test(closed), closed)
    // Same name inside itself: one blanked span, not a stray \end left in the prose.
    const nested = plainProse(
        String.raw`\begin{align}\begin{align}q = r\end{align}s = t\end{align}` + ' Prose after the block.'
    )
    check('a nested environment is blanked with its parent', !/q = r|s = t/.test(nested), nested)
    check('and nothing of the markup is left behind', !/begin|end|align/.test(nested), nested)
    // A starred environment is closed by its starred name and by nothing else, which is
    // what the backreference in the old pattern said too.
    const starred = plainProse(String.raw`\begin{equation*}u = v\end{equation*}` + ' Prose after the block.')
    check('a starred environment is paired with its own name', !/u = v/.test(starred), starred)
    const maths = plainProse(String.raw`Before. \[ z = w \] between. $$ a = b $$ after.`)
    check('display maths in both spellings is not prose', !/z = w|a = b/.test(maths), maths)
    check('and the prose around it is kept', /Before/.test(maths) && /between/.test(maths) && /after/.test(maths), maths)
    const openMaths = plainProse(String.raw`\[ z = w` + '\n\nThe rest of the chapter is prose.')
    check('an unclosed display maths does not swallow the chapter', /rest of the chapter/.test(openMaths), openMaths)
}

// ---------------------------------------------------------------------------
// tripwire: the adversarial shapes, which are one paste away
// ---------------------------------------------------------------------------
// This file had no timing test at all, and that is precisely how it kept a quadratic
// pass: `\begin{X}[\s\S]*?\end{X}` rescans to the end of the file once per opener when
// the \end is missing, so M unclosed opens over n bytes cost O(M*n) with M growing with
// n. Measured here before the linear scan replaced it: 1600 unclosed `\begin{align}`
// cost 101 ms and 6400 (825 KB) cost 1180 ms, which extrapolates to about five seconds
// per 2 MB chapter - synchronous, inside the request, on every review, from one pasted
// file. The ceilings are LOOSE on purpose: they are tripwires and not benchmarks, and
// the curve they exist to catch blows through them by seconds.
//
// Each shape also has to leave the surrounding prose alone, because "fast" is trivially
// bought by deleting the document.
{
    const BUDGET_MS = 2000
    // The count, not the size of the unit, is what separates the two curves: the
    // quadratic cost is O(M*n) with n proportional to M, so it grows with the SQUARE of
    // the number of unclosed openers while the linear one grows with M. At 32000 the
    // reverted scan takes about ten seconds here and the linear one about a tenth of a
    // second, which is the margin a tripwire needs to be worth having.
    const COUNT = 32000
    const PROSE = 'ordinary prose with plain words in it.'
    const tripwire = (name, unit, count = COUNT) => {
        const text = `${unit}\n${PROSE}\n`.repeat(count)
        const started = Date.now()
        const prose = plainProse(text)
        const elapsed = Date.now() - started
        check(
            `${count} ${name} stay linear`,
            elapsed < BUDGET_MS,
            `${elapsed}ms for ${Math.round(text.length / 1024)}KB`
        )
        check(`and the prose around ${name} survives`, prose.includes(PROSE), prose.slice(0, 80))
    }
    tripwire('unclosed environments', String.raw`\begin{align} x = y`)
    tripwire('unclosed starred environments', String.raw`\begin{equation*} x = y`)
    tripwire('unclosed display brackets', String.raw`\[ x = y`)
    tripwire('unpaired dollars', '$ x = y')
    tripwire('unpaired double dollars', '$$ x = y')
    // The whole entry point on the same shape, since that is what the review calls: the
    // chapter cut is not what makes it cheap, the scan is.
    const chapter = `${String.raw`\begin{align} x = y`}\n${PROSE}\n`.repeat(COUNT)
    const started = Date.now()
    const block = analyzeAiWritingSignals([{ name: 'Pasted', text: chapter }])
    const elapsed = Date.now() - started
    check('a chapter of unclosed environments is analysed in seconds', elapsed < 10000, `${elapsed}ms`)
    check('and the prose in it was still counted', block.totals.words > 0, JSON.stringify(block.totals))
}

// ---------------------------------------------------------------------------
// a pathological document must not be able to grow what is stored
// ---------------------------------------------------------------------------
// This block is written three times over: into the job result, into the Mongo document
// the dashboard reads and into the archived HTML. A thesis pasted out of a word
// processor carries thousands of typographic quotes, and an unbounded list would grow
// all three at once. So the lists are capped, and because a cap the reader cannot see
// is a lie about how much was found, every one of them is stored next to its true
// total, with the counting still running over the whole text.
{
    const marked = 'It is important to note that the timing is crucial. Additionally, the sample was small.'
    const dashes = Array.from({ length: 30 }, () => `alpha ${EM_DASH} beta`).join(' ')
    const paragraphs = Array.from({ length: 10 }, () => marked).join('\n\n')
    const chapters = Array.from({ length: 8 }, (_, c) => ({
        name: `Chapter ${c + 1}`,
        docs: Array.from({ length: 6 }, (_, f) => ({
            path: `/chapter${c + 1}/part${f + 1}.tex`,
            text: `${dashes}\n\n${paragraphs}\n\n${LEFT_QUOTE}quoted${RIGHT_QUOTE}`,
        })),
    }))
    const block = analyzeAiWritingSignals(chapters)
    const size = JSON.stringify(block).length

    check('the artifact list is capped', block.artifacts.length === LIMITS.artifactRows, `${block.artifacts.length}`)
    check(
        'and the true number of rows is stored with it',
        block.totals.artifacts.shown === block.artifacts.length && block.totals.artifacts.total === 96,
        JSON.stringify(block.totals.artifacts)
    )
    check(
        'the occurrences on a kept row are counted over the whole file, not up to the cap',
        block.artifacts.filter(a => a.id === 'artifact-literal-em-dash').every(a => a.occurrences === 30),
        block.artifacts
            .filter(a => a.id === 'artifact-literal-em-dash')
            .map(a => a.occurrences)
            .join(',')
    )
    check('the cluster list is capped', block.clusters.length === LIMITS.clusters, `${block.clusters.length}`)
    check(
        'and every cluster in the document was still counted',
        block.totals.clusters.shown === block.clusters.length && block.totals.clusters.total === 480,
        JSON.stringify(block.totals.clusters)
    )
    check(
        'the flagged table is capped by signal rows, with its true total',
        block.totals.flaggedSignals.shown <= LIMITS.flaggedSignals &&
            block.totals.flaggedSignals.total >= block.totals.flaggedSignals.shown,
        JSON.stringify(block.totals.flaggedSignals)
    )
    check(
        'no signal row carries more excerpts than the cap',
        block.flaggedChapters.every(c => c.signals.every(s => s.excerpts.length <= LIMITS.excerptsPerSignal))
    )
    check('the whole block stays under 64 KB on this document', size < 64 * 1024, `${Math.round(size / 1024)}KB`)

    // Worst case for the flagged table specifically: twenty-five chapters that agree
    // and eight that differ on every signal at once, which is 64 rows against a cap of
    // 30. The chapter count is not the thing that decides the size of the block, the
    // number of rows is, so that is what the cap is on.
    const crowded = [
        ...Array.from({ length: 25 }, (_, i) => fakeChapterOnEverySignal(`Ordinary ${i + 1}`, false)),
        ...Array.from({ length: 8 }, (_, i) => fakeChapterOnEverySignal(`Different ${i + 1}`, true)),
    ]
    const crowdedFlags = flagDeviations(crowded)
    check(
        'the worst case really does produce more rows than the cap',
        crowdedFlags.totalSignals === 64,
        `${crowdedFlags.totalSignals} rows`
    )
    check(
        'the signal-row cap holds when many chapters deviate at once',
        crowdedFlags.shownSignals === LIMITS.flaggedSignals,
        `${crowdedFlags.shownSignals} shown of ${crowdedFlags.totalSignals}`
    )
    check(
        'and no chapter is kept with an empty row list',
        crowdedFlags.flagged.length > 0 && crowdedFlags.flagged.every(c => c.signals.length > 0),
        `${crowdedFlags.flagged.length} chapters`
    )
    check(
        'the rows that survive the cut are the ones furthest from the median',
        crowdedFlags.flagged.every(c => c.signals.every((s, i, all) => i === 0 || all[i - 1].robustScore >= s.robustScore))
    )
}

// ---------------------------------------------------------------------------
// tripwire: a long document must stay cheap, because this runs on every review
// ---------------------------------------------------------------------------
{
    const filler = `${proseChapter('')}\n\n`.repeat(120)
    const chapters = Array.from({ length: 8 }, (_, i) => ({ name: `Chapter ${i + 1}`, text: filler }))
    const bytes = chapters.reduce((n, c) => n + c.text.length, 0)
    const t0 = Date.now()
    const block = analyzeAiWritingSignals(chapters)
    const elapsed = Date.now() - t0
    check('a multi-megabyte document is analysed in seconds, not minutes', elapsed < 10000, `${elapsed}ms for ${Math.round(bytes / 1024)}KB`)
    check('and the pass produces a usable block', block.totals.words > 0)
}

// ---------------------------------------------------------------------------
// degenerate input must not throw: this runs inside a finished review
// ---------------------------------------------------------------------------
{
    for (const input of [null, undefined, [], [{}], [{ name: 'x' }], [{ name: 'x', text: '' }], [{ text: null }]]) {
        let threw = null
        try {
            analyzeAiWritingSignals(input)
        } catch (err) {
            threw = err
        }
        check(`degenerate input survives: ${JSON.stringify(input)}`, threw === null, threw?.message)
    }
    check('an absent block is not something to render', hasAiSignals(null) === false && hasAiSignals(undefined) === false)
}

// ---------------------------------------------------------------------------
// WHERE THE QUOTED PASSAGE IS
// ---------------------------------------------------------------------------
// This section asks the reader to go and judge a passage for themselves, and for as long
// as it quoted sentences with no address that was an instruction nobody could follow.
// What is pinned here is that the address is EXACT where it is given, ABSENT where it
// cannot be derived, and never a guess: a wrong line in this section sends a supervisor
// to the wrong paragraph of a student's thesis.
//
// The fixtures are hand-counted. Every expected line below can be read off the array
// literal that produced it, which is the only way an off-by-one in the line arithmetic
// is visible in a test rather than in a report.
{
    const alpha = [
        'Chapter text begins on line one.',      // 1
        'A second line of ordinary prose.',      // 2
        'The extraordinary circumstances here.', // 3
        'A fourth line of ordinary prose.',      // 4
    ].join('\n')
    // The second file opens with a ONE-CHARACTER line on purpose. The two characters of
    // the blank line that joins the parts are part of every offset into the chapter, and
    // a version of this that forgets them is off by exactly two: with a long first line
    // that error is invisible, and with this one it lands on the wrong line.
    const beta = [
        'b',                                         // 1
        'Another file starts here.',                 // 2
        'Another remarkable observation was made.',  // 3
    ].join('\n')
    const source = buildChapterSource([
        { path: '/chapters/alpha.tex', text: alpha },
        { path: '/chapters/beta.tex', text: beta },
    ])

    // ROUTE ONE: an offset into the chapter, which is the parts joined by a blank line.
    // Exact by arithmetic, in whichever part the offset lands.
    const chapter = `${alpha}\n\n${beta}`
    check(
        'an offset in the first file gives that file and its line',
        JSON.stringify(source.atOffset(chapter.indexOf('extraordinary'))) ===
            '{"file":"/chapters/alpha.tex","line":3}',
        JSON.stringify(source.atOffset(chapter.indexOf('extraordinary')))
    )
    check(
        'an offset PAST the join lands in the second file, at its own line 3',
        JSON.stringify(source.atOffset(chapter.indexOf('remarkable'))) ===
            '{"file":"/chapters/beta.tex","line":3}',
        JSON.stringify(source.atOffset(chapter.indexOf('remarkable')))
    )
    // THE JOIN, measured at the one place it is visible: the very first character of the
    // second file. Two characters of drift here and every line of every file after the
    // first is wrong, which is a supervisor sent to the wrong paragraph.
    check(
        'the first character of the second file is its own line 1',
        JSON.stringify(source.atOffset(chapter.indexOf(beta))) ===
            '{"file":"/chapters/beta.tex","line":1}',
        JSON.stringify(source.atOffset(chapter.indexOf(beta)))
    )
    check('the first character of the chapter is line 1', source.atOffset(0)?.line === 1)
    check('the last character of the first file is still its last line', source.atOffset(alpha.length - 1)?.line === 4, JSON.stringify(source.atOffset(alpha.length - 1)))
    check('an offset off the end of everything is nowhere', source.atOffset(99999) === null)
    check('a nonsense offset is nowhere, not line 1', source.atOffset(-5) === null && source.atOffset(NaN) === null)

    // ROUTE TWO: a passage cut out of the PROSE, whose offset means nothing because
    // plainProse blanked the markup it stood next to. Found by its own words instead.
    check(
        'a prose passage is found in the file it came from',
        JSON.stringify(source.find('The extraordinary circumstances here')) ===
            '{"file":"/chapters/alpha.tex","line":3}',
        JSON.stringify(source.find('The extraordinary circumstances here'))
    )
    check(
        'and one from the second file is found in the second file',
        JSON.stringify(source.find('Another remarkable observation was made')) ===
            '{"file":"/chapters/beta.tex","line":3}',
        JSON.stringify(source.find('Another remarkable observation was made'))
    )
    // THE PROMISE THAT MATTERS. A passage that is not in the source has no location, and
    // the module says so rather than offering the nearest thing it found.
    check('a passage that is in no file has no location', source.find('nothing of the sort was ever written') === null)
    // A SHORT FRAGMENT IS NOT AN ADDRESS. "prose" is on two lines of the first file and
    // would be on twenty in a real thesis; matching on it would put a confident, wrong
    // line number under a quotation. The minimum length is what stops that, so a word
    // that IS in the source has to come back with no location at all.
    check(
        'a fragment too short to be distinctive is refused even though it is there',
        alpha.includes('prose') && source.find('prose') === null,
        JSON.stringify(source.find('prose'))
    )
    check('and a short phrase with a capital elsewhere is not matched either', source.find('a fourth') === null)
    check('an empty passage is nowhere', source.find('') === null && source.find(null) === null)
    // The excerpt arrives whitespace-collapsed and wrapped in ellipsis markers, and the
    // source has line breaks and indentation. Neither may stop a match.
    const wrapped = buildChapterSource([
        { path: '/w.tex', text: 'first line\n    The  extraordinary\n\tcircumstances   here abound.\nlast' },
    ])
    check(
        'a passage broken across lines and indented is still found, at its first line',
        JSON.stringify(wrapped.find('...The extraordinary circumstances here abound...')) === '{"file":"/w.tex","line":2}',
        JSON.stringify(wrapped.find('...The extraordinary circumstances here abound...'))
    )
    check('an empty part list finds nothing and throws nothing', buildChapterSource([]).find('anything at all here') === null)
    check('and a malformed part list survives', buildChapterSource(null).atOffset(0) === null)
}
{
    // THE SAME THING END TO END, through the real entry point, on a document whose lines
    // are countable by hand. The em-dash signal is collected on the RAW text (route one)
    // and the lexical markers on the prose (route two), so one document exercises both.
    // TWO documents, and the signals are all in the SECOND one, at lines this literal
    // states. That is the arrangement that exercises the join: a chapter is its parts
    // concatenated, so a line number computed without allowing for the separator would
    // be plausible, confident and wrong for every file after the first.
    //
    // The bulk comes first because a chapter under MIN_CHAPTER_WORDS takes no part in
    // the baseline and would flag nothing at all.
    const loud = {
        name: 'Loud',
        docs: [
            { path: '/loud/bulk.tex', text: proseChapter('') },
            {
                path: '/loud/two.tex',
                text: [
                    // 1: four em-dashes, which is over this signal's minimum count
                    `A sentence ${EM_DASH} interrupted ${EM_DASH} by dashes ${EM_DASH} and ${EM_DASH} again.`,
                    '', // 2
                    // 3: three distinct lexical markers, so a cluster, in its own paragraph
                    'It is important to note that the timing is crucial. Additionally, the sample was small.',
                ].join('\n'),
            },
        ],
    }
    const block = analyzeAiWritingSignals([
        { name: 'One', text: proseChapter('') },
        { name: 'Two', text: proseChapter('') },
        { name: 'Three', text: proseChapter('') },
        { name: 'Four', text: proseChapter('') },
        loud,
    ])

    // The cluster: three distinct markers, all of them on line 3 of that one file.
    const cluster = (block.clusters || [])[0]
    check('a cluster is reported', Boolean(cluster), JSON.stringify(block.clusters))
    check('the cluster still carries its quotation under its old name', (cluster?.paragraphExcerpt || '').length > 0)
    check(
        'and now also the file and the line it is on',
        cluster?.file === '/loud/two.tex' && cluster?.line === 3,
        `${cluster?.file}:${cluster?.line}`
    )
    // The per-signal excerpts: the shape changed, additively.
    const flagged = (block.flaggedChapters || []).find(c => c.name === 'Loud')
    const emSignal = (flagged?.signals || []).find(s => s.id === 'emDashPer1000')
    const first = (emSignal?.excerpts || [])[0]
    check('the em-dash signal is flagged on the loud chapter', Boolean(emSignal), (flagged?.signals || []).map(s => s.id).join(','))
    check('an excerpt still carries its text', typeof first?.text === 'string' && first.text.length > 0, JSON.stringify(first))
    check(
        'and the file and line the dash is actually on',
        first?.file === '/loud/two.tex' && first?.line === 1,
        `${first?.file}:${first?.line}`
    )
    check(
        'every located excerpt names a file the review actually read',
        (flagged?.signals || []).every(s => (s.excerpts || []).every(e => !e.file || e.file === '/loud/two.tex')),
        JSON.stringify((flagged?.signals || []).flatMap(s => s.excerpts || []))
    )
    // The caps are untouched by the shape change: this is a shape change and nothing else.
    check(
        'no signal row carries more excerpts than the cap, still',
        (block.flaggedChapters || []).every(c => c.signals.every(s => (s.excerpts || []).length <= LIMITS.excerptsPerSignal))
    )
    check('the totals still count what they counted', block.totals.chapters === 5 && block.totals.clusters.shown === block.clusters.length)
    check('a located block still survives JSON', JSON.stringify(JSON.parse(JSON.stringify(block))) === JSON.stringify(block))
    // And the section is still not a detector.
    check('nothing about a location reads as a verdict', !/probabilit|detection|detector/i.test(JSON.stringify(block)))
}
{
    // BACKWARD COMPATIBILITY, in the module. Every caller that had no source to give
    // still works and still gets exactly what it got before, minus the location it never
    // had: this module is imported by its own tests and by anything reusing it, and the
    // review is only one of its callers.
    const metrics = computeChapterMetrics({
        name: 'C',
        text: `A line with an em dash \u2014 in it.\nAnother line of prose here.`,
    })
    const excerpts = metrics.evidence.emDashPer1000 || []
    check('with no source, an excerpt still has its text', excerpts.length > 0 && typeof excerpts[0].text === 'string')
    check('and no file or line is invented for it', excerpts.every(e => e.file === undefined && e.line === undefined), JSON.stringify(excerpts[0]))
    const sink = []
    collectClusters('C', 'It is important to note that the timing is crucial. Additionally, the sample was small.', sink)
    check('a cluster collected with no source keeps its excerpt', (sink[0]?.paragraphExcerpt || '').length > 0)
    check('and claims no location', sink[0] && !('file' in sink[0]) && !('line' in sink[0]), JSON.stringify(sink[0]))
}

{
    // ReDoS tripwires for plainProse. Every pattern here has the same disease when the
    // bound is removed: a cheap anchor (`\cmd[`, `\begin{x}[`) followed by a negated
    // class that rescans to the end of the input for every opener that never closes.
    // These inputs are what a hostile single-line chapter looks like, sized so the
    // unbounded version takes seconds while the bounded one stays in milliseconds:
    // the thresholds are generous enough for a slow CI box and still far below what
    // any quadratic rescans cost at this size.
    const hostile = [
        ['generic command with an unclosed option', '\\a['.repeat(40000)],
        ['non-prose command with an unclosed option', '\\cite['.repeat(20000)],
        ['environment with an unclosed option', '\\begin{x}['.repeat(18000)],
    ]
    for (const [name, payload] of hostile) {
        const startedAt = Date.now()
        plainProse(payload)
        const elapsed = Date.now() - startedAt
        check(`plainProse stays linear on: ${name}`, elapsed < 1500, `${elapsed}ms on ${payload.length} bytes`)
    }
    // The two artifact heads that went quadratic on adjacent runs: a 64 KB
    // alphanumeric run before TRIPLET's comma, and a run of blank lines between
    // \item and its bold lead. Both measured in seconds before the caps; with
    // them, milliseconds. findArtifacts is the real consumer of both.
    const runPayloads = [
        ['a 64 KB alphanumeric run (TRIPLET head)', 'a'.repeat(64000) + ' , x and y'],
        ['a 64 KB run of blank lines before a bold item', '\\item' + '\n'.repeat(64000) + '\\textbf{x'],
    ]
    for (const [name, payload] of runPayloads) {
        const startedAt = Date.now()
        computeChapterMetrics({ name: 'hostile', text: payload })
        const elapsed = Date.now() - startedAt
        check(`chapter metrics stay linear on: ${name}`, elapsed < 1500, `${elapsed}ms`)
    }

    // The bound must not change what an author's own arguments get: blanked.
    const prose = plainProse('before \\cite[p. 3]{smith2020} after')
    check('a real citation is still blanked whole', /before\s+after/.test(prose), JSON.stringify(prose))
    // And an argument sized like an attack stays VISIBLE, never silently deleted:
    // the counts must keep describing a document somebody actually handed in.
    const wall = 'k'.repeat(700)
    check('an oversized argument survives as text instead of costing a rescan', plainProse(`\\cite{${wall}}`).includes(wall))
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
