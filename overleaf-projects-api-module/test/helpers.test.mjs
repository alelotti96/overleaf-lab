// overleaf-lab: the four decisions of the projects API that need no container,
// against the REAL shipped file.
//
// Usage, from anywhere:
//   node overleaf-projects-api-module/test/helpers.test.mjs
// or, with the module's whole runner:
//   node overleaf-projects-api-module/test/run.mjs
//
// ProjectsApiHelpers.mjs imports nothing from Overleaf on purpose, so this suite
// imports it instead of slicing it: there is no copy of the logic here and no
// text anchor to drift. The controller, the router and the auth middleware
// cannot be exercised this way (they import core files that exist only inside
// the container), which is exactly why everything worth pinning was put in the
// helpers file to begin with.
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HELPERS =
    process.env.HELPERS ||
    fileURLToPath(new URL('../app/src/ProjectsApiHelpers.mjs', import.meta.url))

const {
    normaliseName,
    resolveTemplate,
    shapeProject,
    findOwnedDuplicate,
    isFiledBy,
    MAX_PROJECT_NAME_CHARS,
    TEMPLATE_NAMES,
} = await import(pathToFileURL(HELPERS).href)

let failures = 0
function test(name, fn) {
    try {
        fn()
        console.log(`[PASS] ${name}`)
    } catch (err) {
        failures += 1
        console.log(`[FAIL] ${name}`)
        console.log(`        ${String(err && err.message).split('\n')[0]}`)
    }
}

const USER = 'a'.repeat(24)
const OTHER = 'b'.repeat(24)
const SITE = 'https://overleaf.example.org'

// ---------------------------------------------------------------------------
// 1. normaliseName: what reaches core, and what never gets that far
// ---------------------------------------------------------------------------

test('normaliseName trims the ends', () => {
    assert.equal(normaliseName('  cubaco-pdr  '), 'cubaco-pdr')
})

test('normaliseName collapses internal whitespace of every kind', () => {
    assert.equal(normaliseName('my   thesis'), 'my thesis')
    assert.equal(normaliseName('my\tthesis'), 'my thesis')
    assert.equal(normaliseName('my\nthesis'), 'my thesis')
    assert.equal(normaliseName(' a \t b \n c '), 'a b c')
})

test('normaliseName leaves an already clean name alone', () => {
    assert.equal(normaliseName('cubaco-pdr'), 'cubaco-pdr')
})

test('normaliseName is idempotent', () => {
    for (const input of ['  a  b  ', 'plain', 'a\tb\nc']) {
        assert.equal(normaliseName(normaliseName(input)), normaliseName(input))
    }
})

test('normaliseName refuses what is empty once trimmed', () => {
    assert.equal(normaliseName(''), null)
    assert.equal(normaliseName('   '), null)
    assert.equal(normaliseName('\n\t '), null)
})

test('normaliseName refuses anything that is not a string', () => {
    for (const input of [null, undefined, 42, {}, [], { $ne: null }, true]) {
        assert.equal(normaliseName(input), null)
    }
})

test('normaliseName accepts exactly the ceiling and refuses one more', () => {
    assert.equal(MAX_PROJECT_NAME_CHARS, 150)
    const atLimit = 'a'.repeat(MAX_PROJECT_NAME_CHARS)
    assert.equal(normaliseName(atLimit), atLimit)
    assert.equal(normaliseName('a'.repeat(MAX_PROJECT_NAME_CHARS + 1)), null)
})

test('normaliseName measures the name AFTER collapsing, not before', () => {
    // 150 letters separated by runs of spaces: too long as typed, fine once
    // collapsed. The rule has to be about the name that gets stored.
    const spaced = 'a'.repeat(75) + '     ' + 'b'.repeat(74)
    assert.equal(normaliseName(spaced), `${'a'.repeat(75)} ${'b'.repeat(74)}`)
})

test('normaliseName keeps accents and punctuation, which core is free to judge', () => {
    assert.equal(normaliseName(' Tesi di Perché (v2) '), 'Tesi di Perché (v2)')
})

// ---------------------------------------------------------------------------
// 2. resolveTemplate: three handler methods and nothing else
// ---------------------------------------------------------------------------

test('resolveTemplate maps the three templates to their handler methods', () => {
    assert.equal(resolveTemplate('blank'), 'createBlankProject')
    assert.equal(resolveTemplate('basic'), 'createBasicProject')
    assert.equal(resolveTemplate('example'), 'createExampleProject')
})

test('resolveTemplate advertises exactly the three names it accepts', () => {
    assert.deepEqual(TEMPLATE_NAMES, ['blank', 'basic', 'example'])
})

test('resolveTemplate defaults an absent template to basic', () => {
    assert.equal(resolveTemplate(undefined), 'createBasicProject')
    assert.equal(resolveTemplate(null), 'createBasicProject')
    assert.equal(resolveTemplate(''), 'createBasicProject')
})

test('resolveTemplate forgives case and padding', () => {
    assert.equal(resolveTemplate(' Basic '), 'createBasicProject')
    assert.equal(resolveTemplate('EXAMPLE'), 'createExampleProject')
})

test('resolveTemplate refuses an unknown template instead of falling back', () => {
    // A typo in a script must not quietly create the wrong kind of project.
    for (const input of ['thesis', 'blanc', 'basic project', 'createBasicProject']) {
        assert.equal(resolveTemplate(input), null)
    }
})

test('resolveTemplate refuses anything that is not a string', () => {
    for (const input of [42, {}, [], true, { $ne: null }]) {
        assert.equal(resolveTemplate(input), null)
    }
})

test('resolveTemplate never hands back a method the caller named itself', () => {
    // The lookup is a Map, so a body asking for a property of Object.prototype
    // gets the same refusal as any other unknown template.
    for (const input of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        assert.equal(resolveTemplate(input), null)
    }
})

// ---------------------------------------------------------------------------
// 3. shapeProject: one list entry, and the per-user meaning of archived/trashed
// ---------------------------------------------------------------------------

const DOC = {
    _id: '6a808805537e7ee009597323',
    name: 'cubaco-pdr',
    lastUpdated: new Date('2026-09-02T21:10:00.000Z'),
    archived: [],
    trashed: [],
}

test('shapeProject builds the documented entry', () => {
    assert.deepEqual(shapeProject(DOC, 'owner', USER, SITE), {
        id: '6a808805537e7ee009597323',
        name: 'cubaco-pdr',
        role: 'owner',
        last_updated: '2026-09-02T21:10:00.000Z',
        archived: false,
        trashed: false,
        url: 'https://overleaf.example.org/project/6a808805537e7ee009597323',
        git_url: 'https://overleaf.example.org/git/6a808805537e7ee009597323',
    })
})

test('shapeProject reports archived and trashed FOR THIS USER', () => {
    const doc = { ...DOC, archived: [OTHER, USER], trashed: [USER] }
    const mine = shapeProject(doc, 'owner', USER, SITE)
    const theirs = shapeProject(doc, 'readAndWrite', 'c'.repeat(24), SITE)
    assert.equal(mine.archived, true)
    assert.equal(mine.trashed, true)
    assert.equal(theirs.archived, false)
    assert.equal(theirs.trashed, false)
})

test('shapeProject compares ids by their string form, not by identity', () => {
    // What comes back from Mongo is an ObjectId, not a string.
    const objectId = { toString: () => USER }
    const doc = { ...DOC, archived: [objectId] }
    assert.equal(shapeProject(doc, 'owner', USER, SITE).archived, true)
})

test('shapeProject honours the legacy boolean form of the two fields', () => {
    const doc = { ...DOC, archived: true, trashed: false }
    const entry = shapeProject(doc, 'owner', USER, SITE)
    assert.equal(entry.archived, true)
    assert.equal(entry.trashed, false)
})

test('shapeProject treats a missing field as not filed away', () => {
    const entry = shapeProject({ _id: 'x'.repeat(24) }, 'owner', USER, SITE)
    assert.equal(entry.archived, false)
    assert.equal(entry.trashed, false)
    assert.equal(entry.name, '')
    assert.equal(entry.last_updated, null)
})

test('shapeProject turns any date shape into ISO 8601, or into null', () => {
    assert.equal(
        shapeProject({ ...DOC, lastUpdated: '2026-09-02T21:10:00.000Z' }, 'owner', USER, SITE).last_updated,
        '2026-09-02T21:10:00.000Z'
    )
    assert.equal(shapeProject({ ...DOC, lastUpdated: 'not a date' }, 'owner', USER, SITE).last_updated, null)
    assert.equal(shapeProject({ ...DOC, lastUpdated: null }, 'owner', USER, SITE).last_updated, null)
})

test('shapeProject never doubles a slash, whatever the site URL looks like', () => {
    const entry = shapeProject(DOC, 'owner', USER, 'https://overleaf.example.org///')
    assert.equal(entry.url, 'https://overleaf.example.org/project/6a808805537e7ee009597323')
    assert.equal(entry.git_url, 'https://overleaf.example.org/git/6a808805537e7ee009597323')
})

test('shapeProject falls back to a relative URL when the instance has no site URL', () => {
    const entry = shapeProject(DOC, 'owner', USER, undefined)
    assert.equal(entry.url, '/project/6a808805537e7ee009597323')
    assert.equal(entry.git_url, '/git/6a808805537e7ee009597323')
})

test('shapeProject carries the role it was given, unchanged', () => {
    for (const role of ['owner', 'readAndWrite', 'readOnly', 'tokenReadAndWrite', 'tokenReadOnly', 'review']) {
        assert.equal(shapeProject(DOC, role, USER, SITE).role, role)
    }
})

test('isFiledBy is the one rule behind both fields', () => {
    assert.equal(isFiledBy([USER], USER), true)
    assert.equal(isFiledBy([OTHER], USER), false)
    assert.equal(isFiledBy([], USER), false)
    assert.equal(isFiledBy(undefined, USER), false)
    assert.equal(isFiledBy(true, USER), true)
    assert.equal(isFiledBy(false, USER), false)
})

// ---------------------------------------------------------------------------
// 4. findOwnedDuplicate: the guard that keeps a retried script honest
// ---------------------------------------------------------------------------

const OWNED = [
    { _id: '1'.repeat(24), name: 'cubaco-pdr', trashed: [] },
    { _id: '2'.repeat(24), name: 'notes', trashed: [USER] },
    { _id: '3'.repeat(24), name: 'thesis draft', trashed: [OTHER] },
    { _id: '4'.repeat(24), name: 'archived one', archived: [USER], trashed: [] },
]

test('findOwnedDuplicate finds the project that already carries the name', () => {
    assert.equal(findOwnedDuplicate(OWNED, 'cubaco-pdr', USER)._id, '1'.repeat(24))
})

test('findOwnedDuplicate compares the normalised names', () => {
    assert.equal(findOwnedDuplicate(OWNED, '  cubaco-pdr ', USER)._id, '1'.repeat(24))
    assert.equal(findOwnedDuplicate(OWNED, 'thesis   draft', USER)._id, '3'.repeat(24))
})

test('findOwnedDuplicate is case sensitive, like the dashboard', () => {
    assert.equal(findOwnedDuplicate(OWNED, 'CUBACO-PDR', USER), null)
})

test('findOwnedDuplicate ignores a project trashed for this user', () => {
    // Its name is not one they can see any more, so it must not block a new one.
    assert.equal(findOwnedDuplicate(OWNED, 'notes', USER), null)
})

test('findOwnedDuplicate still counts a project trashed by somebody else', () => {
    assert.equal(findOwnedDuplicate(OWNED, 'thesis draft', USER)._id, '3'.repeat(24))
})

test('findOwnedDuplicate counts an archived project', () => {
    // Archiving is filing, not deleting: the name is still in use.
    assert.equal(findOwnedDuplicate(OWNED, 'archived one', USER)._id, '4'.repeat(24))
})

test('findOwnedDuplicate answers nothing for a name nobody has', () => {
    assert.equal(findOwnedDuplicate(OWNED, 'brand new', USER), null)
})

test('findOwnedDuplicate survives an empty, absent or malformed list', () => {
    assert.equal(findOwnedDuplicate([], 'cubaco-pdr', USER), null)
    assert.equal(findOwnedDuplicate(undefined, 'cubaco-pdr', USER), null)
    assert.equal(findOwnedDuplicate([null, {}, { name: 42 }], 'cubaco-pdr', USER), null)
})

test('findOwnedDuplicate answers nothing for a name that could not be stored', () => {
    for (const name of ['', '   ', null, { $ne: null }, 'a'.repeat(MAX_PROJECT_NAME_CHARS + 1)]) {
        assert.equal(findOwnedDuplicate(OWNED, name, USER), null)
    }
})

console.log(failures ? `\nRESULT: ${failures} FAILURES` : '\nRESULT: ALL PASS')
process.exit(failures ? 1 : 0)
