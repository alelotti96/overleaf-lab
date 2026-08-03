// Run the REAL exported-report builder and check what it produces.
//
// The builder used to live inside the TypeScript hook and had to be sliced out to
// be testable at all. It is now a shared plain-ESM module (the store archives the
// same HTML the download button builds), so the suite imports the real file the
// way both callers do: no slicing, no type stripping, nothing to drift.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SHARED = path.join(
    path.dirname(process.env.HOOK),
    '..', '..', '..', 'shared', 'compliance-report-html.mjs'
)

let buildReportHtml
let parseGotoParam
try {
    ;({ buildReportHtml, parseGotoParam } = await import(pathToFileURL(SHARED).href))
} catch (err) {
    console.error(`FAIL: could not load the shared report builder\n${err.message}`)
    process.exit(1)
}

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// The builder's OWN <style> and <script> are static markup it writes itself, and the
// stylesheet even names some sections in comments. Every "did a payload survive"
// question below is therefore asked of the document without them.
//
// This is not a hole: nothing from the result is interpolated into either block except
// the guided-mode key and the progress template, and both are pinned separately (see
// "the inline script cannot be broken out of"). If that ever stops being true, that
// block goes red, not this helper.
const CHROME = /<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g
const bodyOf = html => html.replace(CHROME, '')
const scriptOf = html => (/<script>[\s\S]*?<\/script>/.exec(html) || [''])[0]

const base = {
    ok: true,
    rubric: { id: 'r', name: 'Rubric' },
    model: 'a-model',
    documentTokensEstimate: 100,
    maxContextTokens: 1000,
    summary: 'A summary.',
    documentFiles: [],
    documentFilesSkipped: [],
    items: [],
}
const item = (over = {}) => ({
    requirement: 'R',
    status: 'missing',
    evidence: 'e',
    suggestion: '',
    ...over,
})

// ---- the met-requirements list must not be rendered through Array.map ----
// map passes the array INDEX as the second argument, which the renderer reads as a
// line number: met requirement number three printed a fabricated "L3", and the
// "Also at" filter then dropped any real location whose line equalled that index.
{
    const html = buildReportHtml({
        ...base,
        items: [
            item({ requirement: 'A', status: 'ok' }),
            item({ requirement: 'B', status: 'ok', locations: [{ path: 'main.tex', line: 1 }] }),
            item({ requirement: 'C', status: 'ok', locations: [{ path: 'main.tex', line: 2 }] }),
        ],
    })
    check('no fabricated line gutter on met requirements', !/<span class="ln">L[12]<\/span>/.test(html))
    check('a met requirement keeps its location', html.includes('main.tex:2'))
}

// ---- two files can both have a finding on the same line ----
{
    const html = buildReportHtml({
        ...base,
        items: [
            item({
                locations: [
                    { path: 'appendix.tex', line: 5 },
                    { path: 'main.tex', line: 5 },
                ],
            }),
        ],
    })
    check('a same-line location in another file is kept', html.includes('main.tex:5'))
}

// ---- anchors have to be unique or deep links land on the wrong finding ----
{
    const html = buildReportHtml({
        ...base,
        items: [
            item({ requirement: 'The thesis must contain a dedicated chapter on method' }),
            item({ requirement: 'The thesis must contain a dedicated chapter on results' }),
        ],
    })
    const ids = [...html.matchAll(/id="(req-[^"]+)"/g)].map(m => m[1])
    check('requirements sharing an opening clause get distinct ids', ids.length === new Set(ids).size, ids.join(','))
}
{
    // Two real, different files in a project; lowercasing the anchor merged them.
    const html = buildReportHtml({
        ...base,
        items: [
            item({ requirement: 'P', locations: [{ path: 'Main.tex', line: 1 }] }),
            item({ requirement: 'Q', locations: [{ path: 'main.tex', line: 1 }] }),
        ],
    })
    const ids = [...html.matchAll(/id="(file-[^"]+)"/g)].map(m => m[1])
    check('paths differing only in case get distinct anchors', ids.length === new Set(ids).size, ids.join(','))
}

// ---- every finding appears exactly once, and the prose agrees with the body ----
{
    const html = buildReportHtml({
        ...base,
        items: [
            item({ requirement: 'One', locations: [{ path: 'a.tex', line: 3 }, { path: 'b.tex', line: 9 }] }),
            item({ requirement: 'Two', sourceFiles: ['a.tex', 'b.tex'] }),
            item({ requirement: 'Three' }),
        ],
    })
    const ids = [...html.matchAll(/id="(req-[^"]+)"/g)].map(m => m[1])
    check('a multi-location finding is rendered once', ids.length === 3, ids.join(','))
    // Two of the three findings touch b.tex as well, but each is filed under exactly
    // one home, so b.tex is never a block of its own: one file plus the loose group.
    check('the heading counts the loose group as a place', /in 2 places/.test(html), (html.match(/<h2>[^<]*<\/h2>/) || [''])[0])
    // Every index link must resolve to an id that exists in the document.
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map(m => m[1])
    const allIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
    check('every index link resolves', hrefs.every(h => allIds.has(h)), hrefs.join(','))
}

// ---- degenerate results must not crash or print "undefined" ----
{
    const html = buildReportHtml({ ...base, documentTokensEstimate: undefined, summary: '', items: [] })
    check('nothing renders as the literal undefined', !html.includes('undefined'))
    check('an empty review still renders', html.includes('Nothing to fix'))
}

// ---- escaping: the model's words and the student's LaTeX both land in this HTML ----
{
    const html = buildReportHtml({
        ...base,
        summary: '<script>alert(1)</script>',
        items: [
            item({
                requirement: '<img src=x onerror=alert(1)>',
                evidence: '" onmouseover="alert(2)',
                suggestion: '</div><script>alert(3)</script>',
                locations: [{ path: '<b>.tex', line: 1 }],
            }),
        ],
    })
    check('no tag from the model survives', !/<img src=x/.test(html) && !/<script>alert/.test(html))
    check('no attribute breakout', !/onmouseover="alert/.test(html))
}
{
    // The same question asked of EVERY field, not only the three above. The report is
    // built from strings that come from three untrusted places at once - the model, the
    // student's LaTeX (quoted verbatim into the evidence and into the file lists) and
    // the rubric an admin typed - and a field that nobody thought to escape is a
    // stored-XSS in a document a supervisor opens. Escaping is the kind of thing that
    // is right until somebody adds a field, so the sweep covers the whole shape.
    const payloads = [
        '<script>alert(document.domain)</script>',
        '"><img src=x onerror=alert(1)>',
        ']]><svg onload=alert(1)>',
        '<style>*{display:none}</style>',
        '[a](javascript:alert(1))',
        '</title><script>alert(1)</script>',
        '" onmouseover="alert(1)',
        'x</textarea></style></script><iframe src=javascript:alert(1)>',
    ]
    const html = buildReportHtml({
        ...base,
        rubric: { id: 'r', name: payloads[0] },
        model: payloads[1],
        summary: payloads[2],
        documentFiles: [payloads[3]],
        documentFilesSkipped: [{ path: payloads[4], reason: payloads[5] }],
        documentFilesNotIncluded: [payloads[6]],
        items: payloads.map((p, i) =>
            item({
                requirement: `${i + 1}. ${p}`,
                status: i % 2 ? 'missing' : 'ok',
                evidence: `/main.tex:1 "${p}"`,
                suggestion: p,
                locations: [{ path: p, line: 3 }],
                sourceFiles: [p],
            })
        ),
        delta: {
            comparable: true,
            resolved: [{ requirement: payloads[7] }],
            regressed: [{ requirement: payloads[0] }],
            stillOpenCount: 1,
            previousAt: null,
        },
    })
    // The builder's own stylesheet and script are static markup; everything else in the
    // body came from a payload or from a fixed map.
    const body = bodyOf(html)
    // Only a RAW `<` can open a tag; an escaped payload keeps its `onerror=` and its
    // `javascript:` as inert text, which is why the test is about the bracket and not
    // about the words inside it.
    for (const live of [/<script/i, /<iframe/i, /<svg/i, /<img/i, /<textarea/i, /<style>\*/i]) {
        const at = body.search(live)
        check(
            `no ${live.source} survives any field`,
            at === -1,
            at === -1 ? '' : JSON.stringify(body.slice(Math.max(0, at - 60), at + 80))
        )
    }
    // And nothing that carries a bracket reaches the document as written.
    for (const p of payloads.filter(p => /[<>]/.test(p))) {
        check(`a payload with markup never appears raw (${p.slice(0, 18)})`, !body.includes(p), body.includes(p) ? 'unescaped' : '')
    }
    // Markdown is deliberately NOT rendered anywhere in the compliance path, so a link
    // payload stays inert TEXT rather than becoming a javascript: anchor. Pinned as the
    // behaviour it is, because rendering markdown here later would silently re-open it.
    check('a markdown link is left as inert text', body.includes('[a](javascript:alert(1))') && !/href="javascript/i.test(body))
    // The anchors are built from the requirement text, which is a payload here: an id
    // that carried a quote would break out of the attribute it sits in.
    const ids = [...html.matchAll(/id="([^"]*)"/g)].map(m => m[1])
    check('every generated id is quote-free and word-only', ids.every(id => /^[\w-]*$/.test(id)), ids.filter(id => !/^[\w-]*$/.test(id)).join(' | '))
}

// ---- the delta says which of the three "no comparison" cases it is ----
{
    const first = buildReportHtml({ ...base, delta: { comparable: false, reason: 'no_previous' } })
    check('a first review says so', /first stored review/i.test(first))
    const edited = buildReportHtml({ ...base, delta: { comparable: false, reason: 'rubric_changed' } })
    check('an edited rubric is named as the reason', /rubric changed/i.test(edited))
    const same = buildReportHtml({ ...base, delta: { comparable: true, resolved: [], regressed: [] } })
    check('an unchanged verdict set is stated, not left blank', /No verdict changed/i.test(same))
}

// ---- inside a file, the certain findings come first ----
// Ordering by line alone put a "partial" on line 3 above a "missing" on line 200, so
// the first thing the author read was the least certain thing the review had to say.
{
    const html = buildReportHtml({
        ...base,
        items: [
            item({ status: 'partial', requirement: 'UNSURE', locations: [{ path: '/a.tex', line: 3 }] }),
            item({ status: 'missing', requirement: 'CERTAIN', locations: [{ path: '/a.tex', line: 200 }] }),
        ],
    })
    check(
        'a certain finding is placed above an uncertain one in the same file',
        html.indexOf('CERTAIN') < html.indexOf('UNSURE'),
        `certain@${html.indexOf('CERTAIN')} unsure@${html.indexOf('UNSURE')}`
    )
}

// ---- long evidence has to be readable ----
// A model listing twenty offending figures writes one per line. Rendered as a single
// paragraph that is the wall of text that makes a report go unread, and the report
// only ever split on the pipe the structural checks use.
{
    const listed = [
        '1. /a.tex: \\includegraphics{one.png} (raster diagram)',
        '2. /a.tex: \\includegraphics{two.png} (raster diagram)',
        '- /b.tex: \\includegraphics{three.png} (photograph, legitimate)',
    ].join('\n')
    const html = buildReportHtml({ ...base, items: [item({ evidence: listed })] })
    const bullets = (html.match(/<li>/g) || []).length
    check('newline-separated evidence becomes a list', bullets >= 3, `${bullets} <li>`)
    check('and the numbering marker is not doubled', !/<li>1\./.test(html) && !/<li>-\s/.test(html))
    check('and every entry survives', /three\.png/.test(html) && /one\.png/.test(html))
}
{
    // One line stays one line: a short evidence must not be wrapped in a list.
    const html = buildReportHtml({ ...base, items: [item({ evidence: 'a single statement' })] })
    check('a one-line evidence is not turned into a list', !/<li>a single statement/.test(html))
}

// ---- the AI writing signals section ----
// The section that costs the most if it is wrong, because it is read next to a
// student's name. Two things are pinned here: it says nothing at all when there is
// nothing to say, and when it does speak it carries its own disclaimer, inside the
// section, where a forwarded or printed page still shows it.
const SECTION_TITLE = 'AI writing signals'
{
    const clean = bodyOf(buildReportHtml({ ...base, items: [item()] }))
    check('a review with no signals block renders no section', !clean.includes(SECTION_TITLE))
    // A block that ran and found nothing is the common case on an honest thesis, and
    // it must be indistinguishable from no block at all: a heading over the words
    // "nothing found" still puts the question in the document.
    const empty = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        aiSignals: { version: '2026-08', totals: { words: 1000, chapters: 5 }, artifacts: [], flaggedChapters: [], clusters: [] },
    }))
    check('an empty signals block renders no section either', !empty.includes(SECTION_TITLE))
    check('and does not leave an empty box behind', !empty.includes('class="aisig"'))
}
{
    const html = buildReportHtml({
        ...base,
        items: [item()],
        aiSignals: {
            version: '2026-08',
            totals: {
                words: 42000,
                chapters: 6,
                comparedChapters: 6,
                artifacts: { shown: 1, total: 47 },
                flaggedChapters: { shown: 1, total: 3 },
                clusters: { shown: 1, total: 12 },
            },
            legend: [{ id: 'emDashPer1000', label: 'Em-dashes per 1000 words', note: 'The most heavily measured single tell.' }],
            artifacts: [
                {
                    id: 'artifact-oaicite',
                    kind: 'tool',
                    pattern: 'oaicite',
                    label: 'oaicite citation marker',
                    file: '/chapters/method.tex',
                    line: 88,
                    occurrences: 2,
                    excerpt: 'see :contentReference[oaicite:2] for the source',
                },
            ],
            flaggedChapters: [
                {
                    name: 'Chapter four',
                    signals: [
                        {
                            id: 'emDashPer1000',
                            label: 'Em-dashes per 1000 words',
                            value: 21.4,
                            thesisMedian: 1.2,
                            direction: 'above',
                            excerpts: ['the setup, described above, was reused'],
                            excerptsTotal: 31,
                        },
                    ],
                },
            ],
            clusters: [
                {
                    chapter: 'Chapter two',
                    paragraphExcerpt: 'It is important to note that the timing is crucial. Moreover, the sample was small.',
                    markers: ['it is important to note', 'crucial', 'moreover / furthermore'],
                    markersTotal: 5,
                },
            ],
        },
    })
    check('the section appears when the block has something in it', html.includes(SECTION_TITLE))
    // The disclaimer is not optional and is not a footnote: it is the first thing in
    // the section, in the section.
    check('it states that this is not proof', /not proof/i.test(html))
    check('and that false positives are common for non-native writers', /false positives are common/i.test(html) && /not their first/i.test(html))
    check('it never claims a probability or a detection', !/probabilit|detection|detector/i.test(html.replace(/<style>[\s\S]*?<\/style>/g, '')))
    check('the artifact, its file, its line and its quotation are all shown', html.includes('oaicite citation marker') && html.includes('/chapters/method.tex:88') && html.includes('2 times'))
    check('the flagged chapter is named with its value and the median it was compared with', html.includes('Chapter four') && html.includes('21.4') && html.includes('1.2'))
    check('the excerpt behind the number is quoted', html.includes('the setup, described above, was reused'))
    check('the cluster names the phrases that made it one', html.includes('Chapter two') && html.includes('moreover / furthermore'))
    check('the pattern list version is stated', html.includes('2026-08'))
    check('what each signal means is explained once, not once per chapter', html.includes('The most heavily measured single tell.'))
    // NO SILENT CAPS. Every list in the block is bounded, so wherever the report shows
    // fewer rows than were found it has to say so: a reader who sees one artifact and
    // is not told there are forty-seven has been misled by the report itself.
    check('a capped artifact list says how many rows there are', /Showing the first 1 of 47 rows/.test(html))
    check('a capped chapter list says how many chapters there are', /Showing the first 1 of 3 chapters/.test(html))
    check('a capped cluster list says how many paragraphs there are', /Showing the first 1 of 12 paragraphs/.test(html))
    check('a sampled excerpt list says what it is a sample of', /Showing 1 of 31 occurrences/.test(html))
    check('a cluster with more markers than it lists says so', /and 2 more/.test(html))
    check('nothing in the section renders as the literal undefined', !html.includes('undefined'))
    // Position: the section is a separate one, after the findings the review is
    // actually about, so nobody reads it first.
    check('the section sits after the findings and before the footer', html.indexOf(SECTION_TITLE) > html.indexOf('things to fix') && html.indexOf(SECTION_TITLE) < html.indexOf('class="notes"'))
}
{
    // A block assembled by an older or a partial run: missing counts, missing lines,
    // missing excerpts. None of it may print "undefined" into a document a supervisor
    // reads.
    const html = buildReportHtml({
        ...base,
        items: [item()],
        aiSignals: {
            totals: {},
            artifacts: [{ id: 'a', kind: 'paste', label: 'typographic quotes', file: '', occurrences: 1 }],
            flaggedChapters: [{ name: 'Chapter one', signals: [{ id: 'x', label: 'A signal' }] }],
            clusters: [{ chapter: 'Chapter one' }],
        },
    })
    check('a half-filled block never prints undefined', !html.includes('undefined'))
    check('and still renders the section', html.includes(SECTION_TITLE))
    check('with no cap claimed that the block does not support', !/Showing/.test(bodyOf(html)))
}
{
    // Nothing was cut short: the report must not say "showing the first N of N", which
    // reads as a cap where there is none.
    const html = buildReportHtml({
        ...base,
        items: [item()],
        aiSignals: {
            version: '2026-08',
            totals: { artifacts: { shown: 2, total: 2 }, clusters: { shown: 0, total: 0 }, flaggedChapters: { shown: 0, total: 0 } },
            artifacts: [
                { id: 'a', kind: 'tool', label: 'oaicite citation marker', file: '/a.tex', line: 2, occurrences: 1, excerpt: 'x' },
                { id: 'b', kind: 'paste', label: 'typographic quotes', file: '/b.tex', line: 3, occurrences: 1, excerpt: 'y' },
            ],
            flaggedChapters: [],
            clusters: [],
        },
    })
    check('a complete list is not announced as a partial one', !/Showing/.test(bodyOf(html)))
    check('a single occurrence is not rendered as a count', !/1 times/.test(html))
}
{
    // Same sweep as the rest of the report: every string in this block comes from the
    // student's own LaTeX, quoted back verbatim.
    const p = '"><img src=x onerror=alert(1)><script>alert(2)</script>'
    const html = buildReportHtml({
        ...base,
        items: [item()],
        aiSignals: {
            version: p,
            totals: { words: 1, chapters: 1, comparedChapters: 1 },
            artifacts: [{ id: p, kind: 'tool', pattern: p, label: p, file: p, line: 1, occurrences: 1, excerpt: p }],
            flaggedChapters: [
                { name: p, signals: [{ id: p, label: p, value: 1, thesisMedian: 0, note: p, excerpts: [p] }] },
            ],
            clusters: [{ chapter: p, paragraphExcerpt: p, markers: [p] }],
        },
    })
    const body = bodyOf(html)
    check('no markup from a quoted passage survives the section', !/<img src=x/.test(body) && !/<script>alert/.test(body))
    check('and the payload never appears raw', !body.includes(p))
}

// ---------------------------------------------------------------------------
// the two MEASURED-FACT sections: the bibliography check and the figure resolution
// ---------------------------------------------------------------------------
// Both blocks were computed, stored in Mongo and rendered by nobody, so the strongest
// mechanical statement this pipeline can make about a bibliography (a DOI that resolves
// nowhere) reached the student only if the model happened to repeat a hint line. What
// is pinned here is what a reader is owed: the facts with their TRUE totals, the grade
// next to every finding so a suggestion cannot read as a violation, the assumption
// printed next to every estimated number, and - the one that costs the most when it is
// missing - a check that was configured and did not run saying so in the report rather
// than leaving a silence that reads as a pass.
const BIB_TITLE = 'Bibliography check'
const FIG_TITLE = 'Figure resolution'
const bibBlock = (over = {}) => ({
    enabled: true,
    checked: 12,
    total: 40,
    requests: 14,
    findings: [],
    unchecked: [],
    uncheckedByReason: {},
    totals: { findings: { shown: 0, total: 0 }, unchecked: { shown: 0, total: 0 } },
    ...over,
})
const figBlock = (over = {}) => ({
    version: '2026-08',
    assumedTextWidthMm: 160,
    totals: {
        figures: 3,
        raster: 2,
        vector: 1,
        formats: { png: 1, jpeg: 1 },
        measured: { shown: 2, total: 2 },
        unchecked: { shown: 0, total: 0 },
    },
    dpiRange: { min: 95, max: 600 },
    measured: [],
    unchecked: [],
    ...over,
})

{
    // Absent means absent: a deployment without the check renders no section at all.
    const none = bodyOf(buildReportHtml({ ...base, items: [item()] }))
    check('no bibliography block renders no section', !none.includes(BIB_TITLE))
    check('no figures block renders no section', !none.includes(FIG_TITLE))
    const nulled = bodyOf(buildReportHtml({ ...base, items: [item()], bibVerify: null, imageMetrics: null }))
    check('a null block renders no section either', !nulled.includes(BIB_TITLE) && !nulled.includes(FIG_TITLE))
    // A figures block that measured nothing and failed to measure nothing (every figure
    // vector, or none at all) is the same as no block: a heading over an empty table
    // only sends the reader looking for something that is not there.
    const empty = bodyOf(buildReportHtml({ ...base, items: [item()], imageMetrics: figBlock() }))
    check('a figures block with no rows renders no section', !empty.includes(FIG_TITLE))
}
{
    // THE ASSERTION THESE SECTIONS EXIST FOR. The check was configured, it did not run,
    // and the report says so where the findings would have been. Silence here is read
    // as "the bibliography is fine", which is the single most expensive thing this
    // report can imply by accident.
    const html = buildReportHtml({
        ...base,
        items: [item()],
        bibVerify: { enabled: false, reason: 'the check was enabled but did not run' },
        imageMetrics: { enabled: false, reason: 'the file store could not be reached' },
    })
    const body = bodyOf(html)
    check('a bibliography check that did not run still gets its section', body.includes(BIB_TITLE))
    check('and says NOT RUN', /NOT RUN/.test(body))
    check('and names the reason', body.includes('the check was enabled but did not run'))
    check(
        'and states what the silence does NOT mean',
        /nothing here says whether its references exist/i.test(body)
    )
    check('a figures check that did not run says so too', body.includes(FIG_TITLE) && body.includes('the file store could not be reached'))
    check('two NOT RUN lines, one per block', (body.match(/NOT RUN/g) || []).length === 2)
    // Nothing is claimed about the document itself.
    check('a NOT RUN section renders no table and no findings', !/<table/.test(body))
}
{
    const html = buildReportHtml({
        ...base,
        items: [item()],
        bibVerify: bibBlock({
            findings: [
                {
                    kind: 'doi_not_found',
                    key: 'smith2020',
                    file: '/refs.bib',
                    line: 42,
                    entryTitle: 'A study of nothing',
                    detail: 'DOI 10.1234/xyz returns 404 from the Crossref REST API.',
                    grade: 'fact',
                },
                {
                    kind: 'doi_mismatch',
                    key: 'rossi2019',
                    file: '/refs.bib',
                    line: 60,
                    entryTitle: 'Deep learning for bridges',
                    foundTitle: 'A survey of medieval pottery',
                    foundDoi: '10.5555/other',
                    detail: 'The DOI resolves to a record with a different title.',
                    grade: 'fact',
                },
                {
                    kind: 'arxiv_published_version',
                    key: 'lee2021',
                    file: '/refs.bib',
                    line: 88,
                    entryTitle: 'Attention is all you need',
                    foundTitle: 'Attention is all you need',
                    detail: 'Suggestion only: citing the preprint is not an error.',
                    grade: 'suggestion',
                },
            ],
            uncheckedByReason: { no_doi: 20, doi_registered_outside_crossref: 5, network_error: 3 },
            totals: { findings: { shown: 3, total: 9 }, unchecked: { shown: 20, total: 28 } },
        }),
    })
    const body = bodyOf(html)
    check('the section appears when the check ran', body.includes(BIB_TITLE))
    check('the checked-of-total line is there, with the request count', /Checked 12 of 40 entries in 14 requests/.test(body), (body.match(/Checked[^<]*/) || [''])[0])
    // "12 of 40" with no account of the other 28 reads as a bibliography that mostly
    // passed, so every unchecked entry is counted under the reason it was not checked.
    check('the unchecked entries are counted by reason', /20 carry no DOI/.test(body) && /5 have a DOI registered outside Crossref/.test(body) && /3 could not be reached/.test(body), (body.match(/Not checked:[^<]*/) || [''])[0])
    check('each kind of finding gets its own heading', /resolves nowhere/.test(body) && /resolves to a different work/.test(body) && /also holds as published/.test(body))
    check('the entry key and its file:line are shown', body.includes('smith2020') && body.includes('/refs.bib:42'))
    // BOTH titles, or the reader cannot check the claim that made the finding.
    check('both titles are quoted on a mismatch', body.includes('Deep learning for bridges') && body.includes('A survey of medieval pottery'))
    check('the entry title is quoted even when there is no record title', body.includes('A study of nothing'))
    // THE GRADE. A suggestion about a preprint and a DOI that resolves nowhere sit in
    // the same list; rendering them alike turns a courtesy into an accusation.
    check('a verified fact is labelled as one', /verified fact/.test(body))
    check('a suggestion says it is not a violation', /suggestion, not a violation/.test(body))
    check('the cap on the list is stated with the true total', /Showing the first 3 of 9 findings/.test(body))
    check('nothing in the section renders as the literal undefined', !body.includes('undefined'))
}
{
    // A clean bibliography still gets the sentence that bounds the claim.
    const body = bodyOf(buildReportHtml({ ...base, items: [item()], bibVerify: bibBlock({ checked: 40, total: 40 }) }))
    check('a clean check says what it is a statement about', /statement about the checked entries only/i.test(body))
    check('and claims no cap it does not have', !/Showing the first/.test(body))
    // NOTHING CHECKED IS NOT A CLEAN BIBLIOGRAPHY. Over zero resolved entries the same
    // sentence is a vacuous truth that reads as an all-clear, which is the silent-section
    // mistake wearing a sentence.
    const nothing = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        bibVerify: bibBlock({ checked: 0, total: 0, requests: 0 }),
    }))
    check('a check that resolved nothing does not claim everything resolved', !/statement about the checked entries only/i.test(nothing))
    check('and still says how much it checked', /Checked 0 of 0 entries/.test(nothing))
}
{
    // A finding kind this renderer has never heard of must still reach the reader,
    // under its own name, rather than being silently filtered out by the group list.
    const body = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        bibVerify: bibBlock({
            findings: [{ kind: 'doi_typo_suspected', key: 'k1', file: '/r.bib', line: 2, entryTitle: 'T', detail: 'D', grade: 'uncertain' }],
            totals: { findings: { shown: 1, total: 1 }, unchecked: { shown: 0, total: 0 } },
        }),
    }))
    check('a finding of an unknown kind is still rendered', body.includes('doi_typo_suspected') && body.includes('k1'))
}
{
    const html = buildReportHtml({
        ...base,
        items: [item()],
        imageMetrics: figBlock({
            totals: {
                figures: 9,
                raster: 7,
                vector: 2,
                formats: { png: 5, jpeg: 2 },
                measured: { shown: 2, total: 6 },
                unchecked: { shown: 1, total: 4 },
            },
            measured: [
                { path: 'img/plot.png', file: '/main.tex', line: 30, format: 'png', width: 600, height: 400, dpi: 95, exact: false, renderedWidthMm: 160, spec: 'width=\\textwidth', basis: 'width-relative' },
                { path: 'img/photo.jpg', file: '/main.tex', line: 44, format: 'jpeg', width: 3000, height: 2000, dpi: 600, exact: true, renderedWidthMm: 127, spec: 'width=127mm', basis: 'width-absolute' },
            ],
            unchecked: [{ path: 'img/scan.png', file: '/main.tex', line: 60, reason: 'only a height is given, so the printed width is not stated' }],
        }),
    })
    const body = bodyOf(html)
    check('the figures section appears when something was measured', body.includes(FIG_TITLE))
    check('the raster/vector counts and the formats are stated', /7 raster, 2 vector \(5 png, 2 jpeg\)/.test(body), (body.match(/\d+ raster[^<]*/) || [''])[0])
    check('the range over ALL measured figures is stated', /Lowest 95 DPI, highest 600 DPI/.test(body))
    check('a row carries the figure, its file:line, its pixels and its printed width', body.includes('img/plot.png') && body.includes('/main.tex:30') && body.includes('600 x 400') && body.includes('160 mm'))
    check('and the DPI', /95 DPI/.test(body) && /600 DPI/.test(body))
    // THE ASSUMPTION TRAVELS WITH THE NUMBER. A figure sized as a fraction of
    // \textwidth has no printed width until a text width is assumed, and a reader who
    // is shown the number with the assumption in a footnote quotes the number.
    check('an estimated DPI names the text width it assumed', /estimated: assumes a text width of 160 mm/.test(body))
    check('an exact DPI says it is exact and assumes nothing', /\(exact\)/.test(body))
    check('the cap on the measured list is stated with the true total', /Showing the 2 lowest of 6 measured figures/.test(body))
    // The label is the whole point of the second list: an unmeasured figure listed
    // under the low ones is read as a low one.
    check('the unmeasured figures are labelled as unmeasured, NOT as low resolution', /treat these as unmeasured, not as low resolution/i.test(body))
    check('an unmeasured figure carries the reason it could not be measured', body.includes('img/scan.png') && body.includes('only a height is given'))
    check('the cap on the unmeasured list is stated too', /Showing the first 1 of 4/.test(body))
    check('nothing in the figures section renders as the literal undefined', !body.includes('undefined'))
    // No verdicts: the block states numbers, the rubric states thresholds.
    check(
        'the section never judges a figure',
        !/(too low|insufficient|unacceptable|poor quality|fails)/i.test(body),
        (body.match(/(too low|insufficient|unacceptable|poor quality|fails)/i) || [''])[0]
    )
}
{
    // Nothing was cut: no cap may be claimed, in either list.
    const body = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        imageMetrics: figBlock({
            measured: [{ path: 'a.png', file: '/m.tex', line: 1, width: 100, height: 100, dpi: 300, exact: true, renderedWidthMm: 8.5 }],
            totals: { figures: 1, raster: 1, vector: 0, formats: { png: 1 }, measured: { shown: 1, total: 1 }, unchecked: { shown: 0, total: 0 } },
        }),
    }))
    check('a complete figure list is not announced as a partial one', !/Showing/.test(body))
    // A block from an older run, with half the fields missing.
    const half = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        imageMetrics: { measured: [{ path: 'a.png' }], unchecked: [{ path: 'b.png' }], totals: {} },
    }))
    check('a half-filled figures block never prints undefined', !half.includes('undefined'))
    check('and still renders the section', half.includes(FIG_TITLE))
}
{
    // The same hostile sweep the rest of the report gets. A figure path and a bib title
    // are STUDENT-WRITTEN strings that travel through a third-party API and back, so
    // both are stored-XSS candidates in a document a supervisor opens.
    const p = '"><img src=x onerror=alert(1)><script>alert(2)</script>'
    const html = buildReportHtml({
        ...base,
        items: [item()],
        bibVerify: bibBlock({
            reason: p,
            findings: [
                { kind: p, key: p, file: p, line: 3, entryTitle: p, foundTitle: p, foundDoi: p, detail: p, grade: p },
            ],
            uncheckedByReason: { [p]: 2 },
            totals: { findings: { shown: 1, total: 4 }, unchecked: { shown: 1, total: 2 } },
        }),
        imageMetrics: figBlock({
            totals: {
                figures: 1,
                raster: 1,
                vector: 0,
                formats: { [p]: 1 },
                measured: { shown: 1, total: 2 },
                unchecked: { shown: 1, total: 2 },
            },
            measured: [{ path: p, file: p, line: 1, format: p, width: 10, height: 10, dpi: 1, exact: false, renderedWidthMm: 1, spec: p, basis: p }],
            unchecked: [{ path: p, file: p, line: 2, reason: p, spec: p }],
        }),
    })
    const body = bodyOf(html)
    check('no markup from a figure path or a bib title survives', !/<img src=x/.test(body) && !/<script>alert/.test(body))
    check('and neither payload appears raw', !body.includes(p))
    check('an unknown grade or kind is escaped like everything else', !/<iframe|<svg/i.test(body))
}
{
    // The NOT RUN reason is a string too, and it is the one a failure path writes.
    const p = '</p><script>alert(1)</script>'
    const body = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        bibVerify: { enabled: false, reason: p },
        imageMetrics: { enabled: false, reason: p },
    }))
    check('the NOT RUN reason is escaped', !/<script>alert/.test(body) && !body.includes(p))
}

// ---------------------------------------------------------------------------
// the delta must not hide the requirements it could not compare
// ---------------------------------------------------------------------------
// A requirement that came back n.a. this run (the check refused, the model answered
// twice with something unusable, the backend was down) is neither fixed nor new, and
// the store now says how many there were. The report has to print it, INCLUDING in the
// case where nothing else moved: that is exactly the run that used to render as "no
// verdict changed" over a comparison that quietly left five requirements out.
{
    const moved = buildReportHtml({
        ...base,
        delta: {
            comparable: true,
            resolved: [{ requirement: '1. Something' }],
            regressed: [],
            stillOpenCount: 2,
            notRecheckedCount: 3,
        },
    })
    check('the delta says how many requirements could not be re-checked', /3 requirements could not be re-checked this run/.test(moved), (moved.match(/[^>]*could not be re-checked[^<]*/) || [''])[0])
    const still = buildReportHtml({
        ...base,
        delta: { comparable: true, resolved: [], regressed: [], notRecheckedCount: 1 },
    })
    check('and says it even when no verdict moved', /1 requirement could not be re-checked/.test(still) && /No verdict changed/.test(still))
    check('the singular is a singular', !/1 requirements could not/.test(still))
    const clean = buildReportHtml({ ...base, delta: { comparable: true, resolved: [], regressed: [] } })
    check('a run that re-checked everything says nothing about it', !/could not be re-checked/.test(clean))
}

// ---------------------------------------------------------------------------
// the report chrome speaks the rubric's language
// ---------------------------------------------------------------------------
// Everything the model writes already does, and so do the sentences the controller
// builds, so this page was the last surface where an Italian thesis came back as
// Italian findings wedged between English furniture. Two languages, one flat table,
// English whenever the result does not say.
{
    const italian = buildReportHtml({
        ...base,
        language: 'it',
        documentFiles: ['/main.tex'],
        items: [
            item({ requirement: '1. Requisito', evidence: 'Riscontro qui', suggestion: 'Fai questo', locations: [{ path: '/main.tex', line: 3 }] }),
            item({ requirement: '2. Altro', status: 'ok' }),
        ],
        delta: { comparable: true, resolved: [{ requirement: '3. Terzo' }], regressed: [], stillOpenCount: 1, notRecheckedCount: 2 },
    })
    check('the page declares the language it is written in', /<html lang="it"/.test(italian))
    check('the labels of a finding are translated', italian.includes('Riscontro') && italian.includes('Cosa fare') && italian.includes('Mancante'))
    check('the counts line is translated', /cosa da correggere, in 1 punto/.test(italian), (italian.match(/<h2>[^<]*<\/h2>/) || [''])[0])
    check('the delta labels are translated', italian.includes('Rispetto alla review precedente') && italian.includes('risolto:'))
    check('the not-re-checked line is translated', /non si sono potuti ricontrollare/.test(italian))
    check('the footer is translated', /sono stati collegati a un file/.test(italian))
    check('the met-requirements fold is translated', /requisito soddisfatto/.test(italian))
    check('nothing in the Italian report renders as the literal undefined', !italian.includes('undefined'))

    const english = buildReportHtml({ ...base, items: [item()] })
    check('a result with no language is English, as it always was', /<html lang="en"/.test(english) && english.includes('Evidence'))
    const unknown = buildReportHtml({ ...base, language: 'de', items: [item()] })
    check(
        'a language nobody translated falls back to English',
        /<html lang="en"/.test(unknown) && unknown.includes('Evidence') && !unknown.includes('Riscontro')
    )
}
{
    // The split-vote badge is the ENGINE's, and the engine speaks the rubric's language,
    // so the reader's badge has to be readable in both. The two spellings pinned here
    // are the contract with the controller: warning_marker.test.mjs checks the marker
    // the controller actually writes against the same regex, so neither side can move
    // on its own. If one of these two lines goes red, the two files disagree.
    const english = buildReportHtml({
        ...base,
        items: [item({ evidence: 'The chapter has no summary. [verdict agreed by 2 of 3 readings]' })],
    })
    check('the English split-vote marker becomes a badge', /<span class="warn">2 of 3 readings agree<\/span>/.test(english), (english.match(/<span class="warn">[^<]*/) || [''])[0])
    check('and the raw marker never reaches the reader', !english.includes('[verdict agreed by'))
    const italian = buildReportHtml({
        ...base,
        language: 'it',
        items: [item({ evidence: 'Il capitolo non ha un riassunto. [verdetto concorde in 2 letture su 3]' })],
    })
    check('the Italian split-vote marker becomes a badge too', /<span class="warn">2 letture su 3 concordi<\/span>/.test(italian), (italian.match(/<span class="warn">[^<]*/) || [''])[0])
    check('and its raw marker does not reach the reader either', !italian.includes('[verdetto concorde in'))
    // Cross-language: an Italian marker in an English report is still a badge (the
    // report language and the language the item was written in can disagree on an
    // archived report rendered by a later run).
    const crossed = buildReportHtml({
        ...base,
        items: [item({ evidence: 'x [verdetto concorde in 1 letture su 3]' })],
    })
    check('the badge regex reads both spellings whatever the page language is', /<span class="warn">1 of 3 readings agree<\/span>/.test(crossed))
}

// ---------------------------------------------------------------------------
// THE SOURCE EXCERPT, from the controller's bounds to the reader's code block
// ---------------------------------------------------------------------------
// A file:line is a coordinate; the excerpt is the thing a student can act on. It is
// also the only part of this report that copies SOURCE BYTES verbatim into a page a
// supervisor opens, and the only part with an unbounded input behind it, so the whole
// of what follows is about two questions: is it escaped, and is it bounded.
//
// The bounds are read out of the REAL controller rather than restated here, so a bound
// that is loosened in the source cannot leave a green test behind claiming otherwise.
const excerptTools = (() => {
    const ctrl = fs.readFileSync(process.env.CTRL, 'utf8')
    const start = ctrl.indexOf('const EXCERPT_CONTEXT_LINES')
    const end = ctrl.indexOf('function projectDeepLinkBase(')
    if (start === -1 || end === -1 || end <= start) {
        console.error(
            'FAIL: could not locate the excerpt bounds in the controller. If they were ' +
                'renamed, update the anchors here rather than deleting this block.'
        )
        process.exit(1)
    }
    // eslint-disable-next-line no-new-func
    return new Function(
        `${ctrl.slice(start, end)}
        return {
            attachSourceExcerpts, excerptAt,
            EXCERPT_MAX_CHARS, EXCERPT_MAX_LOCATIONS, EXCERPT_BUDGET_CHARS,
            EXCERPT_CONTEXT_LINES,
        }`
    )()
})()
const {
    attachSourceExcerpts,
    excerptAt,
    EXCERPT_MAX_CHARS,
    EXCERPT_MAX_LOCATIONS,
    EXCERPT_BUDGET_CHARS,
    EXCERPT_CONTEXT_LINES,
} = excerptTools

{
    // The bounds the code advertises are the bounds it has. Pinned as NUMBERS because
    // the whole discipline is a size discipline: this text is stored three times over
    // (the result document, the archived HTML, the copy the student downloads), and a
    // bound quietly raised by a factor of ten is a Mongo problem nobody sees until the
    // nightly backup grows.
    check('the per-excerpt bound is 320 characters', EXCERPT_MAX_CHARS === 320, String(EXCERPT_MAX_CHARS))
    check('at most 12 locations of one finding are excerpted', EXCERPT_MAX_LOCATIONS === 12, String(EXCERPT_MAX_LOCATIONS))
    check('the whole report is bounded at 120 KB of excerpt', EXCERPT_BUDGET_CHARS === 120 * 1024, String(EXCERPT_BUDGET_CHARS))
    check('two lines of context either side', EXCERPT_CONTEXT_LINES === 2, String(EXCERPT_CONTEXT_LINES))
}
{
    // BOUND ONE: one excerpt never exceeds its allowance, whatever the file holds. A
    // single minified .tex line is not hypothetical; it is what a generated document
    // looks like.
    const lines = ['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(4000), 'd'.repeat(4000), 'e'.repeat(4000)]
    const excerpt = excerptAt(lines, 3)
    const size = excerpt.lines.reduce((n, l) => n + l.length, 0)
    check('a monstrous line is cut to the per-excerpt bound', size <= EXCERPT_MAX_CHARS, `${size} chars`)
    check('and the excerpt says it was cut', excerpt.clipped === true)
    check('the offending line is the one that keeps the room', excerpt.lines[excerpt.mark].length > excerpt.lines[0].length)
    check('a cut line ends in an ellipsis rather than mid-word', excerpt.lines.every(l => l.endsWith('...')))
    // The marking is the point of the whole block: without it the reader has five lines
    // and no idea which one the finding is about.
    check('the offending line is marked by index', excerpt.mark === EXCERPT_CONTEXT_LINES && excerpt.start === 1)
}
{
    // The excerpt walls: line 1 of the file, last line of the file, and a line that is
    // not in the file at all. None of these may throw, and none may invent a line.
    const lines = ['one', 'two', 'three']
    const first = excerptAt(lines, 1)
    check('an excerpt at line 1 starts at line 1', first.start === 1 && first.mark === 0 && first.lines.length === 3)
    const last = excerptAt(lines, 3)
    check('an excerpt at the last line stops there', last.start === 1 && last.mark === 2 && last.lines.length === 3)
    check('a line past the end of the file has no excerpt', excerptAt(lines, 4) === null)
    check('line zero and a fractional line have no excerpt', excerptAt(lines, 0) === null && excerptAt(lines, 1.5) === null)
    check('a file that is not there has no excerpt', excerptAt(null, 1) === null)
    // Blank space around a blank line is nothing to look at, and an empty code block
    // under a finding reads as "there is nothing there", which is a claim.
    check('an all-blank window renders no excerpt', excerptAt(['', '  ', '', '\t', ''], 3) === null)
}
{
    // BOUND TWO: a finding with fifty locations gets twelve excerpts, and the report is
    // told about the other thirty-eight.
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
    const items = [
        { locations: Array.from({ length: 50 }, (_, i) => ({ path: '/a.tex', line: i + 1 })) },
    ]
    const tally = attachSourceExcerpts(items, [{ path: '/a.tex', text }])
    const got = items[0].locations.filter(l => l.excerpt).length
    check('a finding gets at most twelve excerpts', got === EXCERPT_MAX_LOCATIONS, `${got}`)
    check('and the ones it got are the first ones', items[0].locations.slice(0, 12).every(l => l.excerpt))
    check('the tally counts what the cap kept out', tally.capped === 38 && tally.clipped === true, `capped ${tally.capped}`)
    check('and how many it attached', tally.attached === 12, String(tally.attached))
}
{
    // BOUND THREE: the whole-report budget. Enough findings and the budget runs out
    // partway; everything after that carries no excerpt AND the report says so.
    const text = Array.from({ length: 400 }, () => 'x'.repeat(150)).join('\n')
    const items = Array.from({ length: 400 }, (_, i) => ({
        locations: [{ path: '/big.tex', line: i + 1 }],
    }))
    const tally = attachSourceExcerpts(items, [{ path: '/big.tex', text }])
    check('the whole report stays inside the excerpt budget', tally.chars <= EXCERPT_BUDGET_CHARS, `${tally.chars} chars`)
    check('the budget actually bit on this input', tally.capped > 0, `capped ${tally.capped}`)
    check('and the report knows it was clipped', tally.clipped === true)
    const attached = items.filter(i => i.locations[0].excerpt).length
    check('the findings before the cap kept their excerpts', attached === tally.attached && attached > 0, `${attached}`)
}
{
    // Nothing was cut: no clip may be claimed. Same rule as every other cap in this
    // report, and the one that keeps the honest note honest.
    const items = [{ locations: [{ path: '/a.tex', line: 2 }] }]
    const tally = attachSourceExcerpts(items, [{ path: '/a.tex', text: 'one\ntwo\nthree' }])
    check('a report that lost nothing claims no clip', tally.clipped === false && tally.capped === 0)
    check('and the excerpt is attached raw, not escaped', items[0].locations[0].excerpt.lines.join('|') === 'one|two|three')
    // A location in a file the review never read gets nothing rather than a wrong file.
    const orphan = [{ locations: [{ path: '/ghost.tex', line: 1 }] }]
    attachSourceExcerpts(orphan, [{ path: '/a.tex', text: 'one' }])
    check('a location in an unknown file gets no excerpt', !orphan[0].locations[0].excerpt)
}
{
    // The honest note, in the document, in both languages. "Excerpts stop halfway down
    // the report" and "the review could not place those findings" look identical to a
    // reader, and only one of them is true.
    const withExcerpts = (over = {}) => ({
        ...base,
        items: [item({ locations: [{ path: '/a.tex', line: 2, excerpt: { start: 1, mark: 1, lines: ['one', 'two', 'three'] } }] })],
        ...over,
    })
    const clipped = bodyOf(buildReportHtml(withExcerpts({ excerpts: { capped: 7, clipped: true, attached: 3 } })))
    check('a clipped report says how many locations lost their excerpt', /7 locations have no source excerpt/.test(clipped), (clipped.match(/[^>]*no source excerpt[^<]*/) || [''])[0])
    const one = bodyOf(buildReportHtml(withExcerpts({ excerpts: { capped: 1, clipped: true } })))
    check('and the singular is a singular', /1 location has no source excerpt/.test(one))
    const whole = bodyOf(buildReportHtml(withExcerpts({ excerpts: { capped: 0, clipped: false, attached: 3 } })))
    check('a report that clipped nothing says nothing about it', !/no source excerpt/.test(whole))
    const older = bodyOf(buildReportHtml(withExcerpts()))
    check('an archived result with no excerpt tally claims no clip', !/no source excerpt/.test(older))
    const italian = bodyOf(buildReportHtml(withExcerpts({ language: 'it', excerpts: { capped: 4, clipped: true } })))
    // The apostrophe is escaped, as everything in this document is, so the assertion is
    // about the words either side of it.
    check('the clip note is translated', /4 posizioni non hanno/.test(italian) && /estratto del sorgente/.test(italian), (italian.match(/[^>]*estratto del sorgente[^<]*/) || [''])[0])
    check('and the source label with it', italian.includes('Nel sorgente'))
}
{
    // The excerpt as the reader sees it: the lines, their numbers, and the marking that
    // says which one the finding is about.
    const html = buildReportHtml({
        ...base,
        items: [
            item({
                requirement: 'A requirement',
                locations: [
                    {
                        path: '/chapters/intro.tex',
                        line: 42,
                        excerpt: {
                            start: 40,
                            mark: 2,
                            lines: [
                                '\\section{Introduction}',
                                '',
                                'This thesis is about \\emph{things}.',
                                'It has a second sentence.',
                                '\\subsection{Scope}',
                            ],
                        },
                    },
                ],
            }),
        ],
    })
    const body = bodyOf(html)
    check('the excerpt is rendered as a code block', /<pre class="src">/.test(body))
    check('every line of it reaches the reader', body.includes('This thesis is about') && body.includes('\\subsection{Scope}'))
    check('the line numbers are the file\'s own', /class="n">40</.test(body) && /class="n">44</.test(body))
    // THE MARKING. Five lines with nothing to distinguish them is not an excerpt, it is
    // a paragraph of somebody else's LaTeX.
    check('the offending line is marked, and only it', (body.match(/class="sl hit"/g) || []).length === 1)
    const hit = /<span class="sl hit">[\s\S]*?<\/span><\/span>/.exec(body) || ['']
    check('and the marked line is the one the finding is about', hit[0].includes('This thesis is about'), hit[0].slice(0, 90))
    check('the section is labelled so the block is not mistaken for evidence', body.includes('In the source'))
    // A location that has its own code block must not also be listed under "Also at":
    // one location, one place in the document.
    check('an excerpted location is not printed twice', (body.match(/\/chapters\/intro\.tex:42/g) || []).length === 1)
    check('no line is claimed to be shortened when none was', !/Long lines are shown shortened/.test(body))
    const cut = bodyOf(buildReportHtml({
        ...base,
        items: [item({ locations: [{ path: '/a.tex', line: 1, excerpt: { start: 1, mark: 0, lines: ['x...'], clipped: true } }] })],
    }))
    check('a shortened line says so', /Long lines are shown shortened/.test(cut))
}
{
    // A malformed excerpt from an older run, or from a document that went through Mongo:
    // no start, no mark, a null line, an empty list. None of it may print "undefined" or
    // an empty box, and none of it may throw.
    const body = bodyOf(buildReportHtml({
        ...base,
        items: [
            item({ requirement: 'A', locations: [{ path: '/a.tex', line: 1, excerpt: { lines: ['only'] } }] }),
            item({ requirement: 'B', locations: [{ path: '/b.tex', line: 1, excerpt: { start: 3, mark: 0, lines: [null, 'x'] } }] }),
            item({ requirement: 'C', locations: [{ path: '/c.tex', line: 1, excerpt: { start: 1, mark: 0, lines: [] } }] }),
            item({ requirement: 'D', locations: [{ path: '/d.tex', line: 1, excerpt: null }] }),
        ],
    }))
    check('a half-filled excerpt never prints undefined', !body.includes('undefined'))
    check('an excerpt with no lines renders no empty code block', (body.match(/<pre class="src">/g) || []).length === 2)
    // The location is still placed: it is the finding's home, so it is the file block it
    // is filed under plus the line in the gutter, exactly as it was before excerpts
    // existed. An empty excerpt must cost the reader nothing.
    check('and a location whose excerpt is empty is still placed', body.includes('/c.tex') && body.includes('/d.tex') && (body.match(/<span class="ln">L1<\/span>/g) || []).length >= 2)
}
{
    // THE SWEEP THAT MATTERS MOST. The excerpt is the student's own LaTeX, byte for byte,
    // in a document a supervisor opens. Everything else in this report is a sentence
    // somebody wrote about the source; this is the source.
    const payloads = [
        '<script>alert(document.domain)</script>',
        '"><img src=x onerror=alert(1)>',
        '</pre><iframe src=javascript:alert(1)>',
        '</span></span><svg onload=alert(1)>',
        '\\href{javascript:alert(1)}{click}',
        '</style><style>*{display:none}</style>',
    ]
    const html = buildReportHtml({
        ...base,
        completedAt: '2026-08-02T10:00:00.000Z',
        items: payloads.map((p, i) =>
            item({
                requirement: `${i + 1}. A requirement`,
                locations: [
                    {
                        path: `/ch${i}.tex`,
                        line: 5,
                        excerpt: { start: 3, mark: 2, lines: ['before', p, p, p, 'after'], clipped: true },
                    },
                ],
            })
        ),
    })
    const body = bodyOf(html)
    for (const live of [/<script/i, /<iframe/i, /<svg/i, /<img/i, /<style/i]) {
        const at = body.search(live)
        check(
            `no ${live.source} survives an excerpt`,
            at === -1,
            at === -1 ? '' : JSON.stringify(body.slice(Math.max(0, at - 70), at + 80))
        )
    }
    // Only a RAW `<` can open a tag, so the question is asked of the payloads that
    // carry one. The \href payload deliberately carries none: it is LaTeX, it stays
    // LaTeX, and the assertion about it is the one below.
    for (const p of payloads.filter(p => /[<>]/.test(p))) {
        check(`the excerpt payload never appears raw (${p.slice(0, 16)})`, !body.includes(p))
    }
    check('and it does appear, escaped, because the reader is meant to see it', body.includes('&lt;script&gt;alert(document.domain)&lt;/script&gt;'))
    check('a LaTeX \\href to javascript: is shown as the text it is', body.includes('\\href{javascript:alert(1)}{click}') && !/href="javascript/i.test(body))
    // The excerpt travels through the script tag's neighbourhood too: nothing from a
    // payload may end up inside it.
    const script = scriptOf(html)
    for (const p of payloads) {
        check(`no excerpt payload reaches the inline script (${p.slice(0, 12)})`, !script.includes(p))
    }
}

// ---------------------------------------------------------------------------
// GUIDED MODE: the ticks, the progress, and the page with scripting turned off
// ---------------------------------------------------------------------------
{
    const guided = buildReportHtml({
        ...base,
        completedAt: '2026-08-02T10:11:12.000Z',
        items: [item({ requirement: '1. One' }), item({ requirement: '2. Two' }), item({ requirement: '3. Three', status: 'ok' })],
    })
    // EXACTLY ONCE. Two progress bars disagreeing with each other is worse than none,
    // and a second script re-registers every listener.
    check('the guide bar is emitted exactly once', (guided.match(/id="guide"/g) || []).length === 1)
    check('the progress readout exactly once', (guided.match(/id="gtext"/g) || []).length === 1)
    check('the fill exactly once', (guided.match(/id="gfill"/g) || []).length === 1)
    check('one script, no more', (guided.match(/<script>/g) || []).length === 1 && (guided.match(/<\/script>/g) || []).length === 1)
    check('the three controls exactly once each', ['gprev', 'gnext', 'gclear'].every(id => (guided.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1))
    // A tick belongs to a thing to fix. A met requirement has nothing to tick off, and a
    // checkbox next to one asks the reader to act on something already satisfied.
    check('one tick per finding to fix, and none on the met ones', (guided.match(/class="fx"/g) || []).length === 2)
    check('the fixable findings are marked as such', (guided.match(/class="item [\w-]+ fixable"/g) || []).length === 2)
    check('the progress starts honest', guided.includes('0 of 2 fixed'))
    // The tick has to name the finding it belongs to, and the finding has to be
    // reachable by that name, or a restored tick lands on the wrong card.
    const ticks = [...guided.matchAll(/data-fx="([^"]+)"/g)].map(m => m[1])
    const ids = new Set([...guided.matchAll(/id="([^"]+)"/g)].map(m => m[1]))
    check('every tick points at a finding that exists', ticks.length === 2 && ticks.every(id => ids.has(id)), ticks.join(','))
    check('and the findings can be focused when navigated to', (guided.match(/tabindex="-1"/g) || []).length === 3)
    // THE KEY. A newer report must not inherit the previous run's ticks: the findings
    // are not the same findings, and a tick carried over marks as fixed something
    // nobody fixed.
    check('the storage key carries the report timestamp', guided.includes("'llm-review-guide:2026-08-02T10:11:12.000Z'"), (guided.match(/llm-review-guide:[^']*/) || [''])[0])
    const other = buildReportHtml({ ...base, completedAt: '2026-08-03T09:00:00.000Z', items: [item()] })
    check('a different run gets a different key', other.includes('llm-review-guide:2026-08-03T09:00:00.000Z'))
    const undated = buildReportHtml({ ...base, items: [item()] })
    check('a report with no timestamp still has a key, not the word undefined', undated.includes("'llm-review-guide:'") && !undated.includes('undefined'))
    // A clean review has nothing to work through, so it gets no machinery at all.
    const clean = buildReportHtml({ ...base, items: [item({ status: 'ok' })] })
    check('a review with nothing to fix carries no guide and no script', !clean.includes('id="guide"') && !clean.includes('<script>'))
}
{
    // THE PAGE WITH SCRIPTING OFF. Everything guided is hidden by CSS and revealed by
    // the script, so a browser that will not run it shows a plain report rather than a
    // row of controls that do nothing when clicked.
    const html = buildReportHtml({ ...base, completedAt: '2026-08-02T10:00:00.000Z', items: [item()] })
    const style = (/<style>[\s\S]*?<\/style>/.exec(html) || [''])[0]
    check('the guided chrome is hidden until a script says otherwise', /\.guide,\.fixbox\{display:none\}/.test(style))
    check('and the script is what says otherwise', /documentElement\.className \+= ' guided'/.test(html))
    check('the revealed rules hang off that class', /\.guided \.guide\{/.test(style) && /\.guided \.fixbox\{/.test(style))
    // PRINT. There is nothing to click on paper, and a struck-through finding on a
    // monochrome printer reads as deleted rather than as done.
    const print = (/@media print\{[\s\S]*?\n  \}/.exec(style) || [''])[0]
    check('print hides the guide and the ticks', /\.guide,\.fixbox\{display:none!important\}/.test(print), print ? '' : 'no print block found')
    check('print un-fades a finding that was ticked', /\.item\.done\{opacity:1\}/.test(print))
    check('and drops the strike-through with it', /\.item\.done \.rtext\{text-decoration:none\}/.test(print))
    // The report is opened from a Downloads folder, offline, months later. Anything it
    // needs from a host it will not have.
    const external = [...html.matchAll(/(?:src|href)\s*=\s*"(https?:[^"]*)"/gi)].map(m => m[1])
    check('nothing in the page is fetched from a host', external.length === 0, external.join(' '))
    check('no protocol-relative asset either', !/(?:src|href)\s*=\s*"\/\//i.test(html))
    check('no @import and no url() in the stylesheet', !/@import/i.test(style) && !/url\(/i.test(style))
}

// ---------------------------------------------------------------------------
// THE DEEP LINK BACK INTO THE EDITOR
// ---------------------------------------------------------------------------
{
    const withUrl = (projectUrl) =>
        buildReportHtml({
            ...base,
            projectUrl,
            items: [
                item({
                    requirement: '1. One',
                    locations: [
                        { path: '/main.tex', line: 12, excerpt: { start: 11, mark: 1, lines: ['a', 'b', 'c'] } },
                        { path: '/chapters/two.tex', line: 7 },
                    ],
                }),
            ],
        })
    const linked = withUrl('https://overleaf.example.org/project/64b1f0aa11bb22cc33dd44ee')
    check('a location links back into the editor', /href="https:\/\/overleaf\.example\.org\/project\/64b1f0aa11bb22cc33dd44ee\?llmGoto=/.test(linked), (linked.match(/href="https[^"]*llmGoto[^"]*"/) || [''])[0])
    check('the excerpted location is linked as well as the listed one', (linked.match(/llmGoto=/g) || []).length === 2)
    check('the path and the line are the whole parameter', linked.includes('llmGoto=%2Fmain.tex%3A12') && linked.includes('llmGoto=%2Fchapters%2Ftwo.tex%3A7'))
    check('the link says what it does', linked.includes('Open this line in the editor'))
    // The one exception to "no absolute URL in this page", and it has to be the only
    // one: every http(s) href must be a link to this project and nothing else.
    const hrefs = [...linked.matchAll(/href="(https?:[^"]*)"/gi)].map(m => m[1])
    check('every absolute link points at this project', hrefs.length === 2 && hrefs.every(h => h.startsWith('https://overleaf.example.org/project/64b1f0aa11bb22cc33dd44ee?llmGoto=')), hrefs.join(' '))
    check('and no absolute src exists at all', !/src\s*=\s*"https?:/i.test(linked))

    // NO siteUrl, NO LINKS. A relative href in a file sitting in a Downloads folder
    // points at the filesystem, which is worse than plain text.
    const plain = withUrl('')
    check('an instance with no site URL emits no links', !plain.includes('llmGoto') && !/href="https?:/i.test(plain))
    check('but the locations are still there as text', plain.includes('/main.tex:12') && plain.includes('/chapters/two.tex') && /<span class="ln">L7<\/span>/.test(plain))
    check('and the excerpt is still rendered', /<pre class="src">/.test(plain))

    // The value reaches this renderer out of Mongo, and it lands in an href.
    for (const hostile of [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'https://ok.example.org" onmouseover="alert(1)',
        'https://ok.example.org/x><script>alert(1)</script>',
        "https://ok.example.org/'+alert(1)+'",
        'ftp://example.org/project/1',
        '//evil.example.org/project/1',
        '/project/1',
    ]) {
        const html = withUrl(hostile)
        const body = bodyOf(html)
        check(`a hostile project URL produces no link (${hostile.slice(0, 22)})`, !body.includes('llmGoto'), (body.match(/href="[^"]*llmGoto[^"]*"/) || [''])[0])
        check(`and no markup from it (${hostile.slice(0, 14)})`, !/<script|<iframe|onmouseover=/i.test(body))
    }
}
{
    // THE READING END. The parameter arrives from an address bar and from files that
    // have been forwarded and edited by hand. It is a path and a line, and the shape
    // test is the only reason nothing else can be made of it.
    check('a plain path and line is accepted', JSON.stringify(parseGotoParam('?llmGoto=chapters%2Fintro.tex%3A42')) === '{"path":"chapters/intro.tex","line":42}')
    check('the review\'s leading slash is normalised away', parseGotoParam('?llmGoto=%2Fmain.tex%3A7')?.path === 'main.tex')
    check('a leading ./ goes too', parseGotoParam('?llmGoto=.%2Fmain.tex%3A7')?.path === 'main.tex')
    check('other parameters do not confuse it', parseGotoParam('?a=1&llmGoto=main.tex%3A3&b=2')?.line === 3)
    check('a search string with no parameter is nothing', parseGotoParam('') === null && parseGotoParam('?other=1') === null)
    check('a path with spaces, as project files really have', parseGotoParam('?llmGoto=my+chapter.tex%3A1')?.path === 'my chapter.tex')
    // Every one of these must be refused. The list is the threat model written down:
    // traversal, absolute paths, schemes, injection, and a line that is not a line.
    const hostile = [
        'llmGoto=../../../../etc/passwd:1',
        'llmGoto=%2E%2E%2F%2E%2E%2Fetc%2Fpasswd%3A1',
        'llmGoto=chapters%2F..%2F..%2Fsecret.tex%3A1',
        'llmGoto=chapters%2F.%2Fintro.tex%3A1',
        'llmGoto=javascript%3Aalert(1)',
        'llmGoto=https%3A%2F%2Fevil.example.org%2Fx.tex%3A1',
        'llmGoto=file%3A%2F%2F%2Fetc%2Fpasswd%3A1',
        'llmGoto=main.tex%3A0',
        'llmGoto=main.tex%3A-4',
        'llmGoto=main.tex%3A1.5',
        'llmGoto=main.tex%3A99999999999',
        'llmGoto=main.tex%3Aalert(1)',
        'llmGoto=main.tex',
        'llmGoto=%3A12',
        'llmGoto=main.tex%3A',
        'llmGoto=%3Cscript%3Ealert(1)%3C%2Fscript%3E%3A1',
        'llmGoto=main.tex%22%20onload%3D%22alert(1)%3A1',
        'llmGoto=C%3A%5CWindows%5Csystem32%3A1',
        'llmGoto=%2F%2Fevil.example.org%2Fx.tex%3A1',
        'llmGoto=main.tex%0A%3A1',
        'llmGoto=%00main.tex%3A1',
        `llmGoto=${'a'.repeat(500)}.tex%3A1`,
        'llmGoto=main.tex%3A1%3A2',
        'llmGoto=%2F%2F%2F%3A1',
    ]
    for (const query of hostile) {
        const got = parseGotoParam(`?${query}`)
        check(`refused: ${decodeURIComponent(query).slice(9, 46)}`, got === null, got ? JSON.stringify(got) : '')
    }
    check('a value longer than the cap is refused whatever it says', parseGotoParam(`?llmGoto=${'a/'.repeat(300)}x.tex%3A1`) === null)
    check('nothing that survives can carry a traversal segment', ['..', '.', ''].every(seg => parseGotoParam(`?llmGoto=a%2F${encodeURIComponent(seg)}%2Fb.tex%3A1`) === null))
}
{
    // The two ends are one contract: what the renderer WRITES is what the parser READS.
    // The split-vote marker rotted exactly because writer and reader never referred to
    // each other, so this closes the loop by round-tripping a real link.
    const html = buildReportHtml({
        ...base,
        projectUrl: 'https://ol.example.org/project/abc123',
        items: [item({ locations: [{ path: '/chapters/state of the art.tex', line: 128 }] })],
    })
    const href = (/href="(https:\/\/ol\.example\.org[^"]*)"/.exec(html) || [])[1]
    check('the report emitted a link to round-trip', Boolean(href), String(href))
    const round = parseGotoParam(href ? href.slice(href.indexOf('?')) : '')
    check(
        'the parser reads back exactly what the renderer wrote',
        round && round.path === 'chapters/state of the art.tex' && round.line === 128,
        JSON.stringify(round)
    )
}

// ---------------------------------------------------------------------------
// the AI-signals passages get an address, and the same link back into the editor
// ---------------------------------------------------------------------------
// This is the section that asks the reader to go and judge a passage themselves, so a
// quotation with nowhere to go is an instruction nobody can follow. The rules of the
// section are unchanged and are re-checked here: it still states no verdict, it still
// carries its own caveat, and a location adds an address to a quotation and nothing else.
const signalsBlock = (over = {}) => ({
    version: '2026-08',
    totals: { words: 42000, chapters: 6, comparedChapters: 6 },
    artifacts: [
        {
            id: 'a',
            kind: 'tool',
            label: 'oaicite citation marker',
            file: '/chapters/method.tex',
            line: 88,
            occurrences: 2,
            excerpt: 'see the source',
        },
    ],
    flaggedChapters: [
        {
            name: 'Chapter four',
            signals: [
                {
                    id: 'emDashPer1000',
                    label: 'Em-dashes per 1000 words',
                    value: 21.4,
                    thesisMedian: 1.2,
                    direction: 'above',
                    excerpts: [
                        { text: 'the setup, described above, was reused', file: '/chapters/four.tex', line: 210 },
                    ],
                    excerptsTotal: 31,
                },
            ],
        },
    ],
    clusters: [
        {
            chapter: 'Chapter two',
            paragraphExcerpt: 'It is important to note that the timing is crucial.',
            file: '/chapters/two.tex',
            line: 45,
            markers: ['it is important to note', 'crucial'],
            markersTotal: 2,
        },
    ],
    ...over,
})
{
    const url = 'https://ol.example.org/project/deadbeef'
    const html = buildReportHtml({ ...base, items: [item()], projectUrl: url, aiSignals: signalsBlock() })
    const body = bodyOf(html)
    check('an artifact still shows its file and line', body.includes('/chapters/method.tex:88'))
    check('a cluster now shows the file and line it is in', body.includes('/chapters/two.tex:45'), (body.match(/Chapter two[\s\S]{0,160}/) || [''])[0])
    check('and a per-signal excerpt shows where it was quoted from', body.includes('/chapters/four.tex:210'))
    check('the excerpt text is still there next to its address', body.includes('the setup, described above, was reused'))
    // The same link, the same parameter, the same mechanism as a finding's location.
    for (const spot of ['%2Fchapters%2Fmethod.tex%3A88', '%2Fchapters%2Ftwo.tex%3A45', '%2Fchapters%2Ffour.tex%3A210']) {
        check(`the passage links back into the editor (${spot.slice(-12)})`, body.includes(`${url}?llmGoto=${spot}`), (body.match(/href="[^"]*llmGoto[^"]*"/g) || []).join(' '))
    }
    // And the section's own rules, re-checked because a change here is a change to the
    // section that costs the most when it is wrong.
    check('the section still says it is not proof', /not proof/i.test(body))
    check('and still claims no probability or detection', !/probabilit|detection|detector/i.test(body))
    // Round-trip, as with the findings: what the renderer writes the parser reads.
    const back = parseGotoParam('?llmGoto=%2Fchapters%2Ffour.tex%3A210')
    check('a signals link parses back to its own file and line', back?.path === 'chapters/four.tex' && back?.line === 210, JSON.stringify(back))
}
{
    // NO SITE URL, NO LINKS, here as everywhere: the addresses stay, as text.
    const body = bodyOf(buildReportHtml({ ...base, items: [item()], aiSignals: signalsBlock() }))
    check('with no project URL the passages keep their address as text', body.includes('/chapters/two.tex:45') && body.includes('/chapters/four.tex:210'))
    check('and carry no link', !body.includes('llmGoto') && !/href="https?:/i.test(body))
}
{
    // BACKWARD COMPATIBILITY, in the renderer. A block archived before the signals module
    // learned to place its passages stores excerpts as bare STRINGS and clusters with no
    // file. Today's renderer is handed that block, and it must render exactly what it
    // always rendered rather than the words "[object Object]" or an empty bullet.
    const body = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        projectUrl: 'https://ol.example.org/project/deadbeef',
        aiSignals: signalsBlock({
            clusters: [
                {
                    chapter: 'Chapter two',
                    paragraphExcerpt: 'It is important to note that the timing is crucial.',
                    markers: ['it is important to note', 'crucial'],
                    markersTotal: 2,
                },
            ],
            flaggedChapters: [
                {
                    name: 'Chapter four',
                    signals: [
                        {
                            id: 'emDashPer1000',
                            label: 'Em-dashes per 1000 words',
                            value: 21.4,
                            thesisMedian: 1.2,
                            direction: 'above',
                            excerpts: ['the setup, described above, was reused'],
                            excerptsTotal: 31,
                        },
                    ],
                },
            ],
        }),
    }))
    check('an old string excerpt still renders as its text', body.includes('the setup, described above, was reused'))
    check('and never as an object', !body.includes('[object Object]') && !body.includes('undefined'))
    check('an old cluster with no file still renders its quotation', body.includes('It is important to note that the timing is crucial.'))
    check('and claims no address it does not have', !/Chapter two<\/strong> <a/.test(body) && !/Chapter two<\/strong> <code/.test(body))
    // A passage with a file but no line is a whole file, and the parameter cannot say
    // that, so it keeps the chip and loses the link rather than pointing at a line
    // nobody measured.
    const fileOnly = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        projectUrl: 'https://ol.example.org/project/deadbeef',
        aiSignals: signalsBlock({
            artifacts: [{ id: 'a', kind: 'paste', label: 'typographic quotes', file: '/refs.bib', occurrences: 3, excerpt: 'x' }],
            clusters: [],
            flaggedChapters: [],
        }),
    }))
    check('a file with no line is shown without a fabricated line', fileOnly.includes('/refs.bib') && !/refs\.bib:0/.test(fileOnly))
    check('and is not linked to one either', !/llmGoto=%2Frefs.bib/.test(fileOnly))
}
{
    // The hostile sweep, again, over the fields that just gained a rendering path. A
    // file name and a passage are both STUDENT-WRITTEN strings.
    const p = '"><img src=x onerror=alert(1)><script>alert(2)</script>'
    const body = bodyOf(buildReportHtml({
        ...base,
        items: [item()],
        projectUrl: 'https://ol.example.org/project/deadbeef',
        aiSignals: signalsBlock({
            artifacts: [{ id: p, kind: 'tool', label: p, file: p, line: 1, occurrences: 2, excerpt: p }],
            clusters: [{ chapter: p, paragraphExcerpt: p, file: p, line: 2, markers: [p], markersTotal: 1 }],
            flaggedChapters: [
                {
                    name: p,
                    signals: [
                        { id: p, label: p, value: 1, thesisMedian: 0, excerpts: [{ text: p, file: p, line: 3 }, p], excerptsTotal: 9 },
                    ],
                },
            ],
        }),
    }))
    check('no markup survives a located passage', !/<img src=x/.test(body) && !/<script>alert/.test(body))
    // The payload never appears raw, and it DOES appear with its brackets turned into
    // entities: the question is not whether the words "onerror=" are in the document
    // (they are, as text, and the reader is meant to see them) but whether a raw `<`
    // ever opens a tag. Undoing the entities before asking would be undoing the very
    // escaping under test.
    check('the payload appears escaped and never raw', !body.includes(p) && body.includes('&lt;img src=x'))
    // The payload also lands inside an href now, which is a place it never reached before.
    const hrefs = [...body.matchAll(/href="([^"]*)"/g)].map(m => m[1])
    check('every link is still a well-formed link to this project', hrefs.filter(h => h.startsWith('http')).every(h => h.startsWith('https://ol.example.org/project/deadbeef?llmGoto=')), hrefs.join(' '))
    check('and nothing in one can close its own attribute', hrefs.every(h => !h.includes('"') && !h.includes('<')))
}

// ---- eleventh wave: what the reader of the live report asked for ----
// The finding is filed under the file its own evidence names (not the alphabetically
// first anchor), "What to do" sits above the evidence, a long evidence list folds
// behind its first sentence, three or more source excerpts fold behind their chips,
// and every location prints its `what` next to the address.
{
    const html = bodyOf(
        buildReportHtml({
            ...base,
            items: [
                item({
                    evidence:
                        'File: /Frontmatter/frontespizio.tex, riga 6: no credit near the logo.',
                    suggestion: 'Add the credit in the caption.',
                    locations: [
                        { path: '/Frontmatter/acronimi.tex', line: 2, what: 'stray anchor' },
                        { path: '/Frontmatter/frontespizio.tex', line: 6 },
                    ],
                }),
            ],
        })
    )
    check(
        'the finding is filed under the file its evidence names',
        /class="fileblock" id="file-[^"]*frontespizio[^"]*"/.test(html)
    )
    check(
        'and not under the alphabetically first anchor',
        !/class="fileblock" id="file-[^"]*acronimi[^"]*"/.test(html)
    )
    const sg = html.indexOf('class="sg"')
    const ev = html.indexOf('class="ev"')
    check('what-to-do renders above the evidence', sg !== -1 && ev !== -1 && sg < ev)
    check('an also-at location prints its what', html.includes('stray anchor'))
}
{
    const parts = [
        '45 of 604 sentences run past 40 words (longest first):',
        'a.tex:1 one', 'a.tex:2 two', 'a.tex:3 three', 'a.tex:4 four', 'a.tex:5 five',
    ]
    const html = bodyOf(buildReportHtml({ ...base, items: [item({ evidence: parts.join(' | ') })] }))
    const fold = html.indexOf('<details class="more">')
    check('a long evidence list keeps its first sentence in view', fold !== -1 && html.indexOf('45 of 604') < fold)
    check('and folds the rest under a counted summary', html.includes('<summary>5 more</summary>'))
    check('nothing folded is lost', html.includes('a.tex:5 five'))
    const short = bodyOf(buildReportHtml({ ...base, items: [item({ evidence: parts.slice(0, 4).join(' | ') })] }))
    check('a short list stays unfolded', !short.includes('<details class="more">'))
}
{
    const loc = line => ({
        path: 'main.tex',
        line,
        what: `equation eq${line} is unnumbered`,
        excerpt: { start: line, mark: 0, lines: [`\\[ x_${line} \\]`] },
    })
    const three = bodyOf(
        buildReportHtml({ ...base, items: [item({ locations: [loc(1), loc(2), loc(3)] })] })
    )
    check('three excerpts fold behind one control', three.includes('Show the 3 source excerpts'))
    const chips = three.indexOf('main.tex:1')
    const fold = three.indexOf('<details class="more">')
    check('the chips row stays in view above the fold', chips !== -1 && fold !== -1 && chips < fold)
    check('each chip carries its what', three.includes('equation eq2 is unnumbered'))
    const two = bodyOf(buildReportHtml({ ...base, items: [item({ locations: [loc(1), loc(2)] })] }))
    check('two excerpts stay unfolded', !two.includes('source excerpts'))
    check('a source block header names what is at the line', /class="srchd"[\s\S]{0,200}?equation eq1 is unnumbered/.test(two))
}
{
    const html = bodyOf(
        buildReportHtml({
            ...base,
            items: [item()],
            imageMetrics: figBlock({
                measured: [
                    { path: 'Immagini/a.png', file: '/main.tex', line: 3, width: 360, height: 151, renderedWidthMm: 96, dpi: 95, exact: false },
                ],
            }),
        })
    )
    check('the figures table explains how to read itself', html.includes('How to read the table'))
}

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
