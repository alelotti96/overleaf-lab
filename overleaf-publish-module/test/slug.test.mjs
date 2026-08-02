// overleaf-lab: the optional custom public link, end to end against the REAL
// controller source.
//
// Usage, from anywhere:
//   node overleaf-publish-module/test/slug.test.mjs
// or, with every suite of this module at once:
//   node overleaf-publish-module/test/run.mjs
//
// WHY THIS LOOKS UNUSUAL. The controller imports Overleaf internals
// (SessionManager, the mongodb infrastructure) that only exist inside the
// container, so it cannot be imported here. The suite instead slices the module
// body out of the real file and evaluates it with those imports injected, which
// means it exercises the code that actually ships and not a copy of it. The cost
// is that a failing slice is a failing suite: when the anchors move the fix is to
// update them, never to delete the test. A suite that silently skips what it was
// written to protect is worse than no suite at all.
//
// Some inputs below are accented on purpose and two of them are the same word in
// two different spellings, one code point against a letter plus a combining
// mark. They are meant to be indistinguishable on screen: that is the case the
// module has to get right.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const CONTROLLER =
    process.env.PUBLISH ||
    fileURLToPath(new URL('../app/src/PublishController.mjs', import.meta.url))

const src = fs.readFileSync(CONTROLLER, 'utf8')

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// Loading the real module body
// ---------------------------------------------------------------------------

const START = 'const COLLECTION ='
const END = 'export default {'
const start = src.indexOf(START)
const end = src.indexOf(END)
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the module body in the publish controller')
    process.exit(1)
}

// The cache directory is read from the environment while the module body runs, so
// it is pointed at a throwaway directory before anything is evaluated. The
// compiler output root is pointed at a directory that does not exist: every test
// here is about resolving a link, not about compiling, and a cache refresh that
// finds nothing must leave the cached copy alone.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-publish-test-'))
const PUBLISHED_DIR = path.join(TMP, 'published')
process.env.PUBLISHED_PDF_DIR = PUBLISHED_DIR
process.env.PUBLISH_CLSI_OUTPUT_DIR = path.join(TMP, 'no-such-output')
fs.mkdirSync(PUBLISHED_DIR, { recursive: true })

const logger = { info: () => {}, warn: () => {}, error: () => {} }
const SessionManager = { getLoggedInUserId: () => 'a'.repeat(24) }

const EXPORTS = [
    'publish',
    'unpublish',
    'status',
    'servePdf',
    'authenticate',
    'slugify',
    'isValidSlug',
    'isValidToken',
    'findPublished',
    'publicUrls',
    'cachePath',
    'cookieName',
    'signCookieValue',
    'releaseName',
    'reclaimName',
    'claimableBy',
    'COLLECTION',
    'NAMES_COLLECTION',
]

// A fresh instance per scenario: the module memoises both collection handles and
// keeps its rate limiters in module scope, so scenarios must not share one. The
// register of released names is a second collection, handed out by name exactly
// as the real infrastructure does.
function loadModule(collection, register = makeCollection()) {
    // eslint-disable-next-line no-new-func
    const loaded = new Function(
        'crypto',
        'fs',
        'path',
        'logger',
        'getCollectionInternal',
        'waitForDb',
        'SessionManager',
        `${src.slice(start, end)}; return { ${EXPORTS.join(', ')} }`
    )(
        crypto,
        fs,
        path,
        logger,
        name => (name === 'publishedDocuments' ? collection : register),
        async () => {},
        SessionManager
    )
    // A typo in either collection name would silently hand every lookup the same
    // fake and make the whole suite meaningless.
    if (loaded.COLLECTION !== 'publishedDocuments' || loaded.NAMES_COLLECTION === loaded.COLLECTION) {
        console.error('FAIL: the module does not use two distinct collections any more')
        process.exit(1)
    }
    loaded.register = register
    return loaded
}

// ---------------------------------------------------------------------------
// Fakes: a Mongo collection with just enough semantics, and an Express response
// ---------------------------------------------------------------------------

// enforceUnique models the index the module creates on the custom name. It is a
// switch because the two guards must hold on their own: the check inside the
// handler (the collection pretends to have no index at all) and the index itself
// (the handler is raced and only the write can still fail).
function makeCollection({ rows = [], enforceUnique = true } = {}) {
    const collection = {
        rows,
        queries: [],
        indexes: [],
        async createIndex(spec, options) {
            collection.indexes.push({ spec, options })
            return 'ok'
        },
        async findOne(query) {
            collection.queries.push(query)
            return (
                collection.rows.find(row =>
                    Object.entries(query).every(([key, value]) => row[key] === value)
                ) || null
            )
        },
        async updateOne(filter, update, options = {}) {
            const row = collection.rows.find(candidate =>
                Object.entries(filter).every(([key, value]) => candidate[key] === value)
            )
            const isInsert = !row
            if (isInsert && !options.upsert) return { matchedCount: 0 }
            const next = { ...(row || filter), ...(update.$set || {}) }
            if (isInsert) Object.assign(next, update.$setOnInsert || {})
            for (const field of Object.keys(update.$unset || {})) delete next[field]
            if (enforceUnique && next.slug) {
                const clash = collection.rows.find(
                    candidate => candidate !== row && candidate.slug === next.slug
                )
                if (clash) {
                    const err = new Error('E11000 duplicate key error')
                    err.code = 11000
                    throw err
                }
            }
            if (isInsert) collection.rows.push(next)
            else collection.rows[collection.rows.indexOf(row)] = next
            return { matchedCount: 1 }
        },
        async deleteOne(filter) {
            const index = collection.rows.findIndex(candidate =>
                Object.entries(filter).every(([key, value]) => candidate[key] === value)
            )
            if (index >= 0) collection.rows.splice(index, 1)
            return { deletedCount: index >= 0 ? 1 : 0 }
        },
    }
    return collection
}

// A writable stream wearing the handful of Express methods the controller uses:
// the PDF path pipes a read stream into it, every other answer goes through
// json or send.
function makeRes() {
    const res = new Writable({
        write(chunk, encoding, callback) {
            res.chunks.push(Buffer.from(chunk))
            callback()
        },
    })
    res.chunks = []
    res.statusCode = 200
    res.headers = {}
    res.body = null
    res.contentType = ''
    res.redirected = ''
    res.done = new Promise(resolve => res.on('finish', resolve))
    res.status = code => {
        res.statusCode = code
        return res
    }
    res.type = value => {
        res.contentType = value
        return res
    }
    res.setHeader = (name, value) => {
        res.headers[name] = value
        return res
    }
    res.getHeader = name => res.headers[name]
    res.json = payload => {
        res.body = payload
        res.end()
        return res
    }
    res.send = payload => {
        res.body = payload
        res.end()
        return res
    }
    res.redirect = url => {
        res.redirected = url
        res.statusCode = 302
        res.end()
        return res
    }
    return res
}

function makeReq(overrides = {}) {
    return {
        params: {},
        body: {},
        headers: {},
        session: {},
        ip: 'test-ip',
        protocol: 'https',
        ...overrides,
    }
}

async function call(handler, req) {
    const res = makeRes()
    await handler(req, res)
    await res.done
    return res
}

// Everything a visitor can observe of an answer, so that "the same answer" can
// be asserted instead of described.
function shapeOf(res) {
    return JSON.stringify({
        status: res.statusCode,
        type: res.contentType,
        body: res.body,
        headers: res.headers,
    })
}

const TOKEN = 'A'.repeat(32)
const OTHER_TOKEN = 'B'.repeat(32)
const PASSWORD = 'example-password-for-this-test'

function publishedRow(extra = {}) {
    return {
        projectId: 'p'.repeat(24),
        token: TOKEN,
        publisherUserId: 'u'.repeat(24),
        passwordHash: null,
        cookieSecret: 'c'.repeat(64),
        ...extra,
    }
}

// ---------------------------------------------------------------------------
// 1. Slugification: the one place that transforms
// ---------------------------------------------------------------------------
{
    const m = loadModule(makeCollection())
    const cases = [
        ['Thesis Guide 2026', 'thesis-guide-2026', 'spaces become separators and case is folded'],
        // The next two lines look the same and are not: the first spells the
        // accent as one code point, the second as a letter followed by a
        // combining mark. Both must come out of slugify identically, which is
        // the whole reason the module normalises before it strips.
        ['Perché la tesi', 'perche-la-tesi', 'a precomposed accent folds to its base letter'],
        ['Perché la tesi', 'perche-la-tesi', 'a decomposed accent folds too'],
        ['ÀÈÌÒÙ', 'aeiou', 'uppercase accents fold and then lowercase'],
        ['a/b:c?d', 'a-b-c-d', 'path and query characters become separators'],
        ['  leading and trailing  ', 'leading-and-trailing', 'the ends are trimmed'],
        ['a---b', 'a-b', 'runs of separators collapse'],
        ['---abc---', 'abc', 'separators at the ends are dropped'],
        ['tesi_2026', 'tesi-2026', 'an underscore is not in the class either'],
        ['aßç', 'a-c', 'a letter without a decomposition becomes a separator'],
        ['\u{1f600} emoji \u{1f600}', 'emoji', 'emoji are separators'],
        ['', '', 'the empty string stays empty'],
        ['!!!', '', 'only punctuation collapses to nothing'],
        ['   ', '', 'only spaces collapse to nothing'],
        ['../../etc/passwd', 'etc-passwd', 'a traversal attempt comes out as plain letters'],
        ['.hidden', 'hidden', 'a leading dot cannot survive'],
    ]
    for (const [input, expected, why] of cases) {
        check(
            `slugify: ${why}`,
            m.slugify(input) === expected,
            `${JSON.stringify(input)} -> ${JSON.stringify(m.slugify(input))}`
        )
    }

    check('slugify: null and undefined are the empty string', m.slugify(null) === '' && m.slugify(undefined) === '')
    check('slugify: a number is not a crash', m.slugify(2026) === '2026')

    const long = 'a'.repeat(200)
    check('slugify: the result never exceeds 64 characters', m.slugify(long).length === 64)
    // Sixty three letters, a separator, then more: the truncation lands exactly
    // on the separator and must not leave it dangling at the end.
    const trailing = `${'a'.repeat(63)} bcdef`
    check(
        'slugify: truncation never leaves a trailing separator',
        m.slugify(trailing).length <= 64 && !m.slugify(trailing).endsWith('-'),
        m.slugify(trailing)
    )
    check(
        'slugify: everything it produces is either empty or valid',
        cases.every(([input]) => m.slugify(input) === '' || m.isValidSlug(m.slugify(input)))
    )
    check(
        'slugify: applying it twice changes nothing',
        [...cases.map(one => one[0]), long, trailing].every(
            input => m.slugify(m.slugify(input)) === m.slugify(input)
        )
    )
}

// ---------------------------------------------------------------------------
// 2. Validation: canonical form only, and never confused with a token
// ---------------------------------------------------------------------------
{
    const m = loadModule(makeCollection())
    for (const value of ['abc', 'thesis-guide', 'a-1', 'tesi-2026', '0-0', 'a'.repeat(64)]) {
        check(`valid name: ${value.slice(0, 20)}`, m.isValidSlug(value))
    }
    const bad = [
        ['Thesis-Guide', 'uppercase is not canonical'],
        ['thesis guide', 'a space is not canonical'],
        ['-thesis', 'a leading separator'],
        ['thesis-', 'a trailing separator'],
        ['a--b', 'a doubled separator is never what slugify produces'],
        ['--ab', 'a doubled leading separator'],
        ['ab--', 'a doubled trailing separator'],
        ['ab', 'shorter than three characters'],
        ['a', 'a single character'],
        ['', 'the empty string'],
        ['a'.repeat(65), 'longer than sixty four characters'],
        ['tesi_2026', 'an underscore is outside the class'],
        ['tesi.pdf', 'a dot is outside the class'],
        ['../../etc/passwd', 'a traversal attempt'],
        ['..', 'the parent directory'],
        ['.hidden', 'a leading dot'],
        ['a/b', 'a slash'],
        ['a%2fb', 'an encoded slash'],
        ['perché', 'a precomposed accent'],
        ['perché', 'a combining mark'],
        [' abc ', 'padded with spaces'],
        ['abc\n', 'a trailing newline, which some regex dialects would let through'],
        ['abc\nx', 'an embedded newline'],
    ]
    for (const [value, why] of bad) {
        check(`invalid name: ${why}`, !m.isValidSlug(value), JSON.stringify(value))
    }
    check('invalid name: null and undefined', !m.isValidSlug(null) && !m.isValidSlug(undefined))

    // The two shapes overlap on purpose, which is why they are two decisions and
    // not one pattern reused.
    const overlapping = 'a'.repeat(32)
    check(
        'a lowercase name of token length is valid under BOTH patterns',
        m.isValidSlug(overlapping) && m.isValidToken(overlapping)
    )
    check('a token with uppercase in it is not a valid name', !m.isValidSlug(TOKEN))
    check('a name is not automatically a token', !m.isValidToken('thesis-guide'))
}

// ---------------------------------------------------------------------------
// 3. Resolution: the token wins, both forms reach the same document
// ---------------------------------------------------------------------------
{
    const named = publishedRow({ slug: 'thesis-guide' })
    const other = publishedRow({ projectId: 'q'.repeat(24), token: OTHER_TOKEN })
    const collection = makeCollection({ rows: [named, other] })
    const m = loadModule(collection)

    check('the token resolves to its document', (await m.findPublished(collection, TOKEN)) === named)
    check('the custom name resolves to the same document', (await m.findPublished(collection, 'thesis-guide')) === named)
    check('an unclaimed name resolves to nothing', (await m.findPublished(collection, 'not-taken')) === null)
    check('a key of the wrong shape resolves to nothing', (await m.findPublished(collection, '../../etc/passwd')) === null)
    check(
        'a key of the wrong shape never even becomes a query',
        !collection.queries.some(query => JSON.stringify(query).includes('etc'))
    )
    check(
        'a document without a name is never matched by an empty lookup',
        (await m.findPublished(collection, '')) === null && (await m.findPublished(collection, undefined)) === null
    )

    // A name that is also a syntactically valid token must not be swallowed by
    // the token lookup, and a name equal to somebody else's token must never
    // shadow it.
    const overlap = 'z'.repeat(32)
    const decoy = publishedRow({ projectId: 'r'.repeat(24), token: 'C'.repeat(32), slug: overlap })
    const victim = publishedRow({ projectId: 's'.repeat(24), token: 'd'.repeat(32) })
    const thief = publishedRow({ projectId: 't'.repeat(24), token: 'E'.repeat(32), slug: 'd'.repeat(32) })
    const collection2 = makeCollection({ rows: [decoy, victim, thief] })
    const m2 = loadModule(collection2)
    check('a name shaped like a token still resolves as a name', (await m2.findPublished(collection2, overlap)) === decoy)
    check('a name equal to another document token never shadows it', (await m2.findPublished(collection2, 'd'.repeat(32))) === victim)
}

// ---------------------------------------------------------------------------
// 4. Publishing: slugify, validate, refuse duplicates
// ---------------------------------------------------------------------------
{
    const collection = makeCollection()
    const m = loadModule(collection)

    const res = await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: '  Thesis Guide 2026! ' } })
    )
    check('publishing with a custom name answers 200', res.statusCode === 200, String(res.statusCode))
    check('the stored name is the canonical form', collection.rows[0].slug === 'thesis-guide-2026')
    check('the answer carries the pretty URL', res.body.url === '/published/thesis-guide-2026.pdf', JSON.stringify(res.body))
    check('the answer still carries the token URL', res.body.tokenUrl === `/published/${collection.rows[0].token}.pdf`)
    check('the answer carries the name itself', res.body.slug === 'thesis-guide-2026')
    check(
        'the module asks the database for a unique sparse index',
        collection.indexes.length === 1 &&
            collection.indexes[0].options.unique === true &&
            collection.indexes[0].options.sparse === true
    )

    const token = collection.rows[0].token
    const renamed = await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: 'Second Name' } })
    )
    check('renaming keeps the token', collection.rows[0].token === token)
    check('renaming replaces the name', collection.rows[0].slug === 'second-name')
    check('renaming answers with the new URL', renamed.body.url === '/published/second-name.pdf')

    // The name the rename left behind is NOT free again. It was this fixture
    // that used to pin recycling as the wanted behaviour; it pins the opposite
    // now, and that is the whole point of the register.
    const reused = await call(
        m.publish,
        makeReq({ params: { Project_id: 'q'.repeat(24) }, body: { customName: 'thesis guide 2026' } })
    )
    check('a released name is NOT free for another project', reused.statusCode === 409, String(reused.statusCode))
    check('the released name went into the register', m.register.rows.length === 1 &&
        m.register.rows[0].slug === 'thesis-guide-2026' &&
        m.register.rows[0].projectId === 'p'.repeat(24) &&
        m.register.rows[0].releasedAt instanceof Date, JSON.stringify(m.register.rows))
    check('a refused claim leaves the other project unpublished', collection.rows.length === 1)

    const takenBack = await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: 'thesis guide 2026' } })
    )
    check('the project that released it can take it back', takenBack.statusCode === 200 && takenBack.body.slug === 'thesis-guide-2026')
    check('a name taken back leaves the register', !m.register.rows.some(row => row.slug === 'thesis-guide-2026'))
    check('the document carries it again', collection.rows[0].slug === 'thesis-guide-2026')
    check(
        'and the name it left behind is now the released one',
        m.register.rows.some(row => row.slug === 'second-name' && row.projectId === 'p'.repeat(24))
    )

    const cleared = await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: '' } })
    )
    check('an empty name removes it from the document', !('slug' in collection.rows[0]), JSON.stringify(collection.rows[0]))
    check(
        'with no name the answer falls back to the token URL',
        cleared.body.url === `/published/${token}.pdf` && cleared.body.slug === ''
    )
    check(
        'removing a name releases it as well',
        m.register.rows.some(row => row.slug === 'thesis-guide-2026' && row.projectId === 'p'.repeat(24))
    )

    // A second project, on a name of its own, to pin what an absent field does.
    await call(
        m.publish,
        makeReq({ params: { Project_id: 'q'.repeat(24) }, body: { customName: 'another name' } })
    )
    await call(m.publish, makeReq({ params: { Project_id: 'q'.repeat(24) }, body: {} }))
    check('a body that says nothing about the name keeps it', collection.rows[1].slug === 'another-name')
    check('and keeping a name does not release anything', !m.register.rows.some(row => row.slug === 'another-name'))
}

// Refusals: not canonical once slugified, unbounded, or not a string at all.
{
    const collection = makeCollection()
    const m = loadModule(collection)
    for (const [value, why] of [
        ['ab', 'a name too short to be a link'],
        ['!!!', 'a name made only of punctuation'],
        ['  ', 'a name made only of spaces'],
        ['-', 'a name made only of a separator'],
    ]) {
        const res = await call(
            m.publish,
            makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: value } })
        )
        check(`publishing refuses ${why}`, res.statusCode === 400, `${JSON.stringify(value)} -> ${res.statusCode}`)
    }
    check('a refused name publishes nothing at all', collection.rows.length === 0)

    const tooLong = await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: 'a'.repeat(1000) } })
    )
    check('publishing refuses an unbounded name', tooLong.statusCode === 400)
    const notAString = await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: { $ne: null } } })
    )
    check('publishing refuses a name that is not a string', notAString.statusCode === 400)
    check('a query operator never reaches the database as a name', collection.rows.length === 0)

    // A traversal attempt never survives as one: either it is refused, or it
    // comes out as plain letters. Nothing with a dot or a slash in it can be
    // stored, which is what keeps the name away from every path.
    await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: '../../etc/passwd' } })
    )
    const stored = collection.rows.length ? collection.rows[0].slug : ''
    check(
        'a traversal attempt never reaches the database as one',
        m.isValidSlug(stored) && !stored.includes('.') && !stored.includes('/'),
        JSON.stringify(stored)
    )
}

// Collision: refused by the handler even when the database has no index...
{
    const taken = publishedRow({ projectId: 'z'.repeat(24), token: OTHER_TOKEN, slug: 'thesis-guide' })
    const collection = makeCollection({ rows: [taken], enforceUnique: false })
    const m = loadModule(collection)
    const res = await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: 'Thesis Guide' } })
    )
    check('a name already taken is refused with 409', res.statusCode === 409, String(res.statusCode))
    check('the refusal says what happened', typeof res.body.error === 'string' && res.body.error.length > 0)
    check('a refused name creates no document', collection.rows.length === 1)
    const again = await call(
        m.publish,
        makeReq({ params: { Project_id: 'z'.repeat(24) }, body: { customName: 'thesis-guide' } })
    )
    check('the project that owns the name can republish under it', again.statusCode === 200)
}

// ...and refused by the index alone when the handler loses a race.
{
    const collection = makeCollection({ enforceUnique: true })
    const m = loadModule(collection)
    const original = collection.findOne
    let raced = false
    collection.findOne = async query => {
        const result = await original.call(collection, query)
        // Somebody else claims the name between the check and the write.
        if (!raced && 'slug' in query) {
            raced = true
            collection.rows.push(
                publishedRow({ projectId: 'z'.repeat(24), token: OTHER_TOKEN, slug: 'thesis-guide' })
            )
        }
        return result
    }
    const res = await call(
        m.publish,
        makeReq({ params: { Project_id: 'p'.repeat(24) }, body: { customName: 'thesis-guide' } })
    )
    check('a name lost to a race is still refused with 409', res.statusCode === 409, String(res.statusCode))
}

// ---------------------------------------------------------------------------
// 4b. A released name is never recycled
// ---------------------------------------------------------------------------
// The guarantee: a link name that has been let go can lead to the document it
// led to, or to nothing, but never to a different project's document.
{
    const collection = makeCollection()
    const m = loadModule(collection)
    const OWNER = 'p'.repeat(24)
    const STRANGER = 'q'.repeat(24)

    // Rename A to B, then let somebody else ask for A.
    await call(m.publish, makeReq({ params: { Project_id: OWNER }, body: { customName: 'name-a' } }))
    check(
        'the register is indexed unique on the name',
        m.register.indexes.length === 1 &&
            m.register.indexes[0].options.unique === true &&
            JSON.stringify(m.register.indexes[0].spec) === JSON.stringify({ slug: 1 }),
        JSON.stringify(m.register.indexes)
    )
    await call(m.publish, makeReq({ params: { Project_id: OWNER }, body: { customName: 'name-b' } }))
    const strangerWantsA = await call(
        m.publish,
        makeReq({ params: { Project_id: STRANGER }, body: { customName: 'name-a' } })
    )
    check('a name released by a rename is refused to everybody else', strangerWantsA.statusCode === 409)

    // The refusal must be the same one a name that is LIVE somewhere else gets,
    // byte for byte: telling the two apart would be an oracle for what used to
    // exist on this instance.
    const strangerWantsB = await call(
        m.publish,
        makeReq({ params: { Project_id: STRANGER }, body: { customName: 'name-b' } })
    )
    check(
        'released and in use are indistinguishable from outside',
        shapeOf(strangerWantsA) === shapeOf(strangerWantsB),
        `${shapeOf(strangerWantsA)} vs ${shapeOf(strangerWantsB)}`
    )

    // The owner goes back and forth as much as it likes.
    const backToA = await call(
        m.publish,
        makeReq({ params: { Project_id: OWNER }, body: { customName: 'name-a' } })
    )
    check('the owner can rename back and forth', backToA.statusCode === 200 && backToA.body.slug === 'name-a')
    const backToB = await call(
        m.publish,
        makeReq({ params: { Project_id: OWNER }, body: { customName: 'name-b' } })
    )
    check('and back again', backToB.statusCode === 200 && backToB.body.slug === 'name-b')

    // Unpublishing and publishing again under the same name costs nothing.
    await call(m.unpublish, makeReq({ params: { Project_id: OWNER } }))
    check('unpublishing releases the name it carried', m.register.rows.some(row => row.slug === 'name-b' && row.projectId === OWNER))
    check('the document itself is gone', collection.rows.length === 0)
    const strangerWantsBAgain = await call(
        m.publish,
        makeReq({ params: { Project_id: STRANGER }, body: { customName: 'name-b' } })
    )
    check(
        'the register outlives the document it came from',
        strangerWantsBAgain.statusCode === 409,
        String(strangerWantsBAgain.statusCode)
    )
    const republished = await call(
        m.publish,
        makeReq({ params: { Project_id: OWNER }, body: { customName: 'name-b' } })
    )
    check('the owner republishes under the same name without friction', republished.statusCode === 200 && republished.body.slug === 'name-b')
    check('and a republished name is live, not released', !m.register.rows.some(row => row.slug === 'name-b'))

    // A name is claimed once and once only: every name the register has ever
    // seen belongs to exactly one project.
    const owners = new Set(m.register.rows.map(row => `${row.slug}:${row.projectId}`))
    check('the register never holds two owners for one name', owners.size === m.register.rows.length)
}

// The race: the checks pass for the owner, and the write still loses to somebody
// who got there first. The unique index is what decides, and it decides against
// a duplicate.
{
    const collection = makeCollection({ enforceUnique: true })
    const m = loadModule(collection)
    const OWNER = 'p'.repeat(24)
    await call(m.publish, makeReq({ params: { Project_id: OWNER }, body: { customName: 'name-a' } }))
    await call(m.publish, makeReq({ params: { Project_id: OWNER }, body: { customName: 'name-b' } }))

    const original = collection.findOne
    let raced = false
    collection.findOne = async query => {
        const result = await original.call(collection, query)
        if (!raced && 'slug' in query) {
            raced = true
            collection.rows.push(publishedRow({ projectId: 'z'.repeat(24), token: OTHER_TOKEN, slug: 'name-a' }))
        }
        return result
    }
    const res = await call(m.publish, makeReq({ params: { Project_id: OWNER }, body: { customName: 'name-a' } }))
    check('a just released name lost to a race is refused with 409', res.statusCode === 409, String(res.statusCode))
    const carrying = collection.rows.filter(row => row.slug === 'name-a')
    check('and no two documents ever carry the same name', carrying.length === 1)
}

// ---------------------------------------------------------------------------
// 5. Status
// ---------------------------------------------------------------------------
{
    const named = publishedRow({ slug: 'thesis-guide' })
    const collection = makeCollection({ rows: [named] })
    const m = loadModule(collection)
    const res = await call(m.status, makeReq({ params: { Project_id: named.projectId } }))
    check(
        'status returns the pretty URL, the token URL and the name',
        res.body.published === true &&
            res.body.url === '/published/thesis-guide.pdf' &&
            res.body.tokenUrl === `/published/${TOKEN}.pdf` &&
            res.body.slug === 'thesis-guide',
        JSON.stringify(res.body)
    )
    const missing = await call(m.status, makeReq({ params: { Project_id: 'x'.repeat(24) } }))
    check('status of an unpublished project says so', missing.body.published === false)
}

// ---------------------------------------------------------------------------
// 6. Serving: one document, one cached file, whichever URL was typed
// ---------------------------------------------------------------------------
{
    const named = publishedRow({ slug: 'thesis-guide' })
    const collection = makeCollection({ rows: [named] })
    const m = loadModule(collection)
    const cached = m.cachePath(TOKEN)
    fs.writeFileSync(cached, '%PDF-1.7 pretend')

    const byToken = await call(m.servePdf, makeReq({ params: { key: TOKEN } }))
    const bySlug = await call(m.servePdf, makeReq({ params: { key: 'thesis-guide' } }))
    check(
        'the token form streams the PDF',
        byToken.headers['Content-Type'] === 'application/pdf' &&
            Buffer.concat(byToken.chunks).toString() === '%PDF-1.7 pretend'
    )
    check(
        'the custom name streams the very same bytes',
        Buffer.concat(bySlug.chunks).toString() === Buffer.concat(byToken.chunks).toString()
    )
    check(
        'the cached copy is named after the token and nothing else',
        fs.readdirSync(PUBLISHED_DIR).join(',') === `${TOKEN}.pdf`,
        fs.readdirSync(PUBLISHED_DIR).join(',')
    )
    check(
        'the cache path is derived from the token, never from the name',
        m.cachePath(named.token) === cached && !cached.includes('thesis-guide')
    )

    // Unknown, wrong shape and never compiled must all answer the same thing.
    const unknownToken = await call(m.servePdf, makeReq({ params: { key: 'Q'.repeat(32) } }))
    const unknownSlug = await call(m.servePdf, makeReq({ params: { key: 'never-claimed' } }))
    const malformed = await call(m.servePdf, makeReq({ params: { key: '../../etc/passwd' } }))
    check('an unclaimed name answers exactly like an unknown token', shapeOf(unknownSlug) === shapeOf(unknownToken), shapeOf(unknownSlug))
    check('a malformed key answers exactly like an unknown token', shapeOf(malformed) === shapeOf(unknownToken))
    check('and that same answer is a plain 404', unknownToken.statusCode === 404 && unknownToken.body === 'Not found')

    fs.unlinkSync(cached)
    const goneToken = await call(m.servePdf, makeReq({ params: { key: TOKEN } }))
    const goneSlug = await call(m.servePdf, makeReq({ params: { key: 'thesis-guide' } }))
    check('a published but never compiled document answers the same 404 by token', shapeOf(goneToken) === shapeOf(unknownToken))
    check('a published but never compiled document answers the same 404 by name', shapeOf(goneSlug) === shapeOf(unknownToken))
}

// Revoking takes the name down with the document and the cached copy.
{
    const named = publishedRow({ slug: 'thesis-guide' })
    const collection = makeCollection({ rows: [named] })
    const m = loadModule(collection)
    fs.writeFileSync(m.cachePath(TOKEN), '%PDF-1.7 pretend')
    await call(m.unpublish, makeReq({ params: { Project_id: named.projectId } }))
    check('unpublishing deletes the cached copy', !fs.existsSync(m.cachePath(TOKEN)))
    const revoked = await call(m.servePdf, makeReq({ params: { key: 'thesis-guide' } }))
    check('a revoked name answers a plain 404', revoked.statusCode === 404 && revoked.body === 'Not found')
}

// ---------------------------------------------------------------------------
// 7. The password protects both forms of the link
// ---------------------------------------------------------------------------
{
    const named = publishedRow({ slug: 'thesis-guide' })
    const collection = makeCollection({ rows: [named] })
    const m = loadModule(collection)
    fs.writeFileSync(m.cachePath(TOKEN), '%PDF-1.7 pretend')

    // The hash is produced the way the module produces it, by publishing.
    await call(
        m.publish,
        makeReq({
            params: { Project_id: named.projectId },
            body: { password: PASSWORD, customName: 'thesis-guide' },
        })
    )
    check(
        'publishing with a password stores a hash and never the password',
        typeof collection.rows[0].passwordHash === 'string' && !collection.rows[0].passwordHash.includes(PASSWORD)
    )

    const byToken = await call(m.servePdf, makeReq({ params: { key: TOKEN } }))
    const bySlug = await call(m.servePdf, makeReq({ params: { key: 'thesis-guide' } }))
    check('the token form asks for the password', byToken.statusCode === 401)
    check('the custom name form asks for the password too', bySlug.statusCode === 401, String(bySlug.statusCode))
    check(
        'neither form leaked a single byte of the PDF',
        byToken.chunks.length === 0 && bySlug.chunks.length === 0 && !String(bySlug.body).includes('%PDF')
    )
    check(
        'the password page posts back to the form the visitor used',
        String(bySlug.body).includes('action="/published/thesis-guide/auth"')
    )
    check(
        'the password page does not hand the permanent link to a name visitor',
        !String(bySlug.body).includes(TOKEN)
    )
    check(
        'the password page still carries its own security policy',
        String(bySlug.headers['Content-Security-Policy'] || '').includes("form-action 'self'")
    )

    const authed = await call(
        m.authenticate,
        makeReq({ params: { key: 'thesis-guide' }, body: { password: PASSWORD } })
    )
    check('answering through the name redirects back to the name', authed.redirected === '/published/thesis-guide.pdf')
    const setCookie = String(authed.headers['Set-Cookie'] || '')
    check(
        'the cookie is named after the document, not after the key that was used',
        setCookie.startsWith(`${m.cookieName(TOKEN)}=`),
        setCookie.slice(0, 40)
    )
    const cookie = setCookie.split(';')[0]
    const openedBySlug = await call(m.servePdf, makeReq({ params: { key: 'thesis-guide' }, headers: { cookie } }))
    const openedByToken = await call(m.servePdf, makeReq({ params: { key: TOKEN }, headers: { cookie } }))
    check('with the cookie the name opens the document', Buffer.concat(openedBySlug.chunks).toString() === '%PDF-1.7 pretend')
    check('the same cookie opens the token form as well', Buffer.concat(openedByToken.chunks).toString() === '%PDF-1.7 pretend')

    const forged = await call(
        m.servePdf,
        makeReq({
            params: { key: 'thesis-guide' },
            headers: {
                cookie: `${m.cookieName(TOKEN)}=${encodeURIComponent(m.signCookieValue('another-secret', Date.now() + 60000))}`,
            },
        })
    )
    check('a cookie signed with another secret does not open the name form', forged.statusCode === 401)
    const expired = await call(
        m.servePdf,
        makeReq({
            params: { key: 'thesis-guide' },
            headers: {
                cookie: `${m.cookieName(TOKEN)}=${encodeURIComponent(m.signCookieValue(collection.rows[0].cookieSecret, Date.now() - 1000))}`,
            },
        })
    )
    check('an expired cookie does not open the name form', expired.statusCode === 401)
    const wrong = await call(
        m.authenticate,
        makeReq({ params: { key: 'thesis-guide' }, body: { password: 'another-example-value' } })
    )
    check('a wrong password through the name is refused', wrong.statusCode === 401 && String(wrong.body).includes('Wrong password'))
    const unknownAuth = await call(
        m.authenticate,
        makeReq({ params: { key: 'never-claimed' }, body: { password: PASSWORD } })
    )
    check('answering for an unclaimed name is a plain 404', unknownAuth.statusCode === 404 && unknownAuth.body === 'Not found')

    // Renaming the link is the same request as publishing, and it must not
    // quietly unprotect a protected document.
    await call(
        m.publish,
        makeReq({ params: { Project_id: named.projectId }, body: { customName: 'renamed-guide' } })
    )
    check('renaming keeps the password', !!collection.rows[0].passwordHash)
    const afterRename = await call(m.servePdf, makeReq({ params: { key: 'renamed-guide' } }))
    check('the renamed link still asks for the password', afterRename.statusCode === 401)
    const oldName = await call(m.servePdf, makeReq({ params: { key: 'thesis-guide' } }))
    check('the old name stops resolving after a rename', oldName.statusCode === 404)
    const stillTheToken = await call(m.servePdf, makeReq({ params: { key: TOKEN } }))
    check('the token link never breaks', stillTheToken.statusCode === 401)
}

// ---------------------------------------------------------------------------
// 8. Tripwires on the source: properties that live in the shape of the code
// ---------------------------------------------------------------------------
check(
    'the custom name has its own pattern, separate from the token one',
    src.includes('const SLUG_RE =') &&
        src.includes('const TOKEN_RE =') &&
        src.indexOf('const SLUG_RE =') !== src.indexOf('const TOKEN_RE =')
)
check(
    'the unique sparse index is created by the module itself',
    src.includes('createIndex') && src.includes('unique: true') && src.includes('sparse: true')
)
check('the cache path is never built from anything but a token', !/cachePath\((?:doc\.)?(?:slug|key)\)/.test(src))

// ---------------------------------------------------------------------------
// 9. The panel's live preview must agree with the server
// ---------------------------------------------------------------------------
// The preview decides nothing, but a preview that disagrees with the server
// shows the publisher a URL that will not be the one they get.
{
    const PANEL =
        process.env.PANEL ||
        fileURLToPath(new URL('../frontend/js/components/publish-button.tsx', import.meta.url))
    const panel = fs.readFileSync(PANEL, 'utf8')
    const from = panel.indexOf('function previewSlug(')
    const to = panel.indexOf('\n}', from)
    if (from === -1 || to === -1) {
        check('the panel still carries a preview to compare against', false)
    } else {
        // The only thing standing between the panel source and plain JavaScript
        // is one type annotation.
        const body = panel.slice(from, to + 2).replace('input: string', 'input')
        // eslint-disable-next-line no-new-func
        const preview = new Function('MAX_SLUG_CHARS', `${body}; return previewSlug`)(64)
        const m = loadModule(makeCollection())
        const inputs = [
            'Thesis Guide 2026',
            'Perché la tesi',
            'ÀÈÌÒÙ',
            '  padded  ',
            'a---b',
            'tesi_2026',
            '../../etc/passwd',
            '!!!',
            'a'.repeat(200),
            `${'a'.repeat(63)} bcdef`,
        ]
        const disagreements = inputs.filter(input => preview(input) !== m.slugify(input))
        check(
            'the panel preview agrees with the server on every case',
            disagreements.length === 0,
            JSON.stringify(disagreements)
        )
    }
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
