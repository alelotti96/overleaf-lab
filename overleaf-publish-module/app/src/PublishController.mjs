// overleaf-lab: publish a project's compiled PDF at a stable public URL.
//
// The whole design is driven by one fact: the instance faces the open internet,
// so the public surface must be impossible to steer. The public route accepts a
// TOKEN and nothing else: the token resolves server-side to a project, and the
// only thing the route will ever stream is that project's compiled output.pdf.
// No path from user input to a filename, no query parameters, no redirect to
// anything a visitor typed, and an unknown, revoked or never-compiled token all
// return the same plain 404.
//
// The URL is stable and the content follows the project: on each visit the
// cached copy is refreshed (throttled) from the compiler's latest successful
// output for the user who published; if the compiler no longer holds an output
// (its cache expires), the last cached copy keeps the link alive. Publishing
// requires WRITE access to the project; a read-only collaborator cannot expose
// someone else's work.
//
// The optional password is stored as a scrypt hash, never in clear. A correct
// answer sets a signed, expiring cookie (HMAC over a per-document secret), so
// the password is asked once per browser and nothing about it is stored server-
// side beyond the hash. Wrong answers are rate limited harder than downloads.
//
// A published document can also carry an optional custom name, so that the link
// can be read out loud ("/published/thesis-guide.pdf" instead of a random
// token). The name is an ADDITION, never a replacement: the token keeps working
// forever, so a link already shared with somebody never breaks, and both forms
// resolve to the same document and the same cached file on disk. The name is
// guessable by construction, which is the point of having one, so the default
// stays the random token and the choice is left to whoever publishes.
//
// A name, once used, is never recycled: releasing it (renaming, removing it,
// unpublishing) puts it in a register it never leaves, and only the project that
// released it can take it back. So a link somebody wrote down can lead to that
// project's document or to nothing at all, and never, at any point in the
// future, to a DIFFERENT project's document. That is the one failure a guessable
// URL makes possible and the one nobody could notice from the outside.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import logger from '@overleaf/logger'
import { getCollectionInternal, waitForDb } from '../../../../app/src/infrastructure/mongodb.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'

const COLLECTION = 'publishedDocuments'
// overleaf-lab: released custom names live here forever, one document per name,
// { slug, projectId, releasedAt }. They have to outlive the published document
// itself (unpublishing deletes that one), which is why this is a collection of
// its own and not a field on the document.
const NAMES_COLLECTION = 'publishedDocumentNames'
const PUBLISHED_DIR = process.env.PUBLISHED_PDF_DIR || '/var/lib/overleaf/data/published'
const OUTPUT_ROOT = process.env.PUBLISH_CLSI_OUTPUT_DIR || '/var/lib/overleaf/data/output'
const TOKEN_RE = /^[A-Za-z0-9_-]{28,40}$/
// Deliberately NOT derived from TOKEN_RE: the two shapes overlap (a lowercase
// name of 28 to 40 characters is also a syntactically valid token) and they must
// keep separate meanings, so each one gets its own pattern and its own lookup.
// The pattern accepts only the canonical form: lowercase, no leading or trailing
// separator, 3 to 64 characters (1 + 1..62 + 1).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/
const ID_RE = /^[0-9a-f]{24}$/
const REFRESH_THROTTLE_MS = 30 * 1000
const COOKIE_TTL_MS = 2 * 60 * 60 * 1000
const MAX_PASSWORD_CHARS = 200
const MAX_CUSTOM_NAME_CHARS = 200
const MAX_SLUG_CHARS = 64

let collectionPromise = null
function docs() {
    if (!collectionPromise) {
        collectionPromise = waitForDb()
            .then(() => getCollectionInternal(COLLECTION))
            .then(async collection => {
                // Uniqueness of the custom name is a property of the whole
                // instance, so the database is the only place that can enforce
                // it: the check in the publish handler can always lose a race,
                // the index cannot. SPARSE on purpose, because documents without
                // a custom name simply do not enter the index (a field set to
                // null would, and the second unnamed document would collide).
                // Created from code so that enabling the module is enough: an
                // index an operator has to remember to create by hand is an
                // index that will be missing on the day it matters.
                try {
                    await collection.createIndex(
                        { slug: 1 },
                        { unique: true, sparse: true, name: 'publish_slug_unique' }
                    )
                } catch (err) {
                    logger.warn({ err }, '[publish] could not create the custom name index')
                }
                return collection
            })
    }
    return collectionPromise
}

// overleaf-lab: the register of released names. A custom name that a project has
// let go NEVER becomes available to a different project, so that a link somebody
// wrote down, printed or sent by mail can only ever lead to the document it led
// to, or to nothing at all. It can never lead to SOMEBODY ELSE'S document, which
// is the one outcome a guessable URL makes possible and the one outcome that
// would be impossible to notice from the outside.
//
// The register is keyed by the name and unique, not sparse: every entry has one.
// Its only other content is who released it, which is what lets the same project
// take its own name back, and when.
let namesPromise = null
function names() {
    if (!namesPromise) {
        namesPromise = waitForDb()
            .then(() => getCollectionInternal(NAMES_COLLECTION))
            .then(async collection => {
                try {
                    await collection.createIndex(
                        { slug: 1 },
                        { unique: true, name: 'publish_released_slug_unique' }
                    )
                } catch (err) {
                    logger.warn({ err }, '[publish] could not create the released name index')
                }
                return collection
            })
    }
    return namesPromise
}

// ---------------------------------------------------------------------------
// Small pure helpers (unit tested by slicing: keep them dependency-free).
// ---------------------------------------------------------------------------

function isValidToken(token) {
    return TOKEN_RE.test(String(token || ''))
}

// overleaf-lab: the ONLY place that transforms a custom name. Everything after
// this point validates instead of fixing, so there is exactly one definition of
// "canonical" and no doubt about what ended up stored: a free string typed by
// the publisher ("Thesis Guide 2026") becomes "thesis-guide-2026" here, and from
// there on it is just another input to be accepted or refused.
// Accents fold onto their base letter through NFKD (an "e" with an accent
// decomposes into "e" plus a combining mark, and the mark is dropped), so a name
// typed properly keeps its spelling once in ASCII. Anything else at all, spaces
// and punctuation and emoji alike, becomes a separator; runs collapse and the
// ends are trimmed. Truncation comes last and can leave a separator hanging, so
// the ends are trimmed again after it.
function slugify(input) {
    return String(input === undefined || input === null ? '' : input)
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .slice(0, MAX_SLUG_CHARS)
        .replace(/-+$/, '')
}

// Canonical form only: a name that slugify would have changed is refused rather
// than quietly repaired, which is what keeps the stored value and the URL the
// publisher was shown the same string. The doubled separator is the one case the
// pattern alone cannot express, and it matters because slugify collapses runs,
// so "a--b" can never be the output of the transformation above.
function isValidSlug(slug) {
    const value = String(slug === undefined || slug === null ? '' : slug)
    return SLUG_RE.test(value) && !value.includes('--')
}

// overleaf-lab: resolve the single thing the public routes accept, a key that is
// either the random token or the document's custom name. The TOKEN IS TRIED
// FIRST AND WINS: the two shapes overlap, and a custom name must never be able
// to shadow somebody else's token link. Whatever the visitor typed, the rest of
// the request works off the DOCUMENT and never off the key, so the cached file
// stays named after the token, a custom name never becomes a second copy of the
// PDF, and it never reaches a path at all.
async function findPublished(collection, key) {
    if (isValidToken(key)) {
        const byToken = await collection.findOne({ token: key })
        if (byToken) return byToken
    }
    // Validated before it becomes a query on purpose: an empty or absent value
    // serializes to null and would match the first document that simply has no
    // custom name.
    if (isValidSlug(key)) return await collection.findOne({ slug: key })
    return null
}

// A name is released when the project holding it renames it away, removes it or
// unpublishes altogether. From that moment it is in the register for good: the
// entry is what makes the name unavailable to everybody else, forever.
async function releaseName(register, slug, projectId) {
    if (!isValidSlug(slug)) return
    await register.updateOne(
        { slug },
        { $set: { slug, projectId, releasedAt: new Date() } },
        { upsert: true }
    )
}

// The register entry goes away when the project that released the name takes it
// back: the name is live again, and a live name is already unique by index.
async function reclaimName(register, slug) {
    if (!isValidSlug(slug)) return
    await register.deleteOne({ slug })
}

// The only question the publish handler needs answered: may THIS project claim
// this name? A name nobody ever released is free. A name this project released
// is its own to take back, so renaming there and back, or unpublishing and
// publishing again, costs nothing. Anything else is refused, and refused with
// exactly the answer a name that is live somewhere else gets, so that no caller
// can tell a name in use from a name that once existed.
async function claimableBy(register, slug, projectId) {
    const released = await register.findOne({ slug })
    return !released || released.projectId === projectId
}

// The pretty URL when there is one, the token URL always: the panel shows the
// first and keeps the second visible, because that is the link that outlives
// every rename.
function publicUrls(doc) {
    const tokenUrl = `/published/${doc.token}.pdf`
    return {
        url: doc.slug ? `/published/${doc.slug}.pdf` : tokenUrl,
        tokenUrl,
        slug: doc.slug || '',
    }
}

// overleaf-lab: fixed-window rate limiter per key, in memory. This instance runs
// one web process, so a Map is enough; the limiter exists to blunt scraping and
// password guessing, not to bill anyone. Expired windows are pruned on touch.
function makeRateLimiter(limit, windowMs) {
    const hits = new Map()
    return key => {
        const now = Date.now()
        if (hits.size > 10000) {
            for (const [k, v] of hits) {
                if (v.resetAt <= now) hits.delete(k)
            }
        }
        const entry = hits.get(key)
        if (!entry || entry.resetAt <= now) {
            hits.set(key, { count: 1, resetAt: now + windowMs })
            return true
        }
        entry.count += 1
        return entry.count <= limit
    }
}

// overleaf-lab: the compiler writes every compile under a fresh build id,
//   <outputRoot>/<projectId>-<userId>/generated-files/<buildId>/output.pdf
// (verified on the live instance's disk). The build id changes at each compile,
// so no fixed URL into the compiler can ever hit it; but web and compiler share
// one container and one data volume here, so the latest successful output is
// simply the newest output.pdf on disk. Ids are validated hex before touching
// a path, and build directory names come from readdir, never from a request.
async function findCompiledPdf(outputRoot, projectId, userId, fsp = fs.promises) {
    if (!ID_RE.test(String(projectId)) || !ID_RE.test(String(userId))) return null
    for (const dir of [`${projectId}-${userId}`, String(projectId)]) {
        const generated = path.join(outputRoot, dir, 'generated-files')
        let entries = []
        try {
            entries = await fsp.readdir(generated, { withFileTypes: true })
        } catch (err) {
            entries = []
        }
        const builds = []
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const candidate = path.join(generated, entry.name, 'output.pdf')
            try {
                const stat = await fsp.stat(candidate)
                if (stat.isFile()) builds.push({ candidate, mtime: stat.mtimeMs })
            } catch (err) {
                // A build directory without an output.pdf is a failed compile: skip.
            }
        }
        if (builds.length > 0) {
            builds.sort((a, b) => b.mtime - a.mtime)
            return builds[0].candidate
        }
        // Older compiler layouts keep the output flat in the project directory.
        try {
            const flat = path.join(outputRoot, dir, 'output.pdf')
            const stat = await fsp.stat(flat)
            if (stat.isFile()) return flat
        } catch (err) {
            // No flat output either: try the next directory shape.
        }
    }
    return null
}

function signCookieValue(secret, expiresAt) {
    const mac = crypto.createHmac('sha256', secret).update(String(expiresAt)).digest('hex')
    return `${expiresAt}.${mac}`
}

function verifyCookieValue(secret, value) {
    const m = /^(\d{1,16})\.([a-f0-9]{64})$/.exec(String(value || ''))
    if (!m) return false
    const expiresAt = Number(m[1])
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
    const expected = crypto.createHmac('sha256', secret).update(m[1]).digest('hex')
    const got = Buffer.from(m[2], 'hex')
    const want = Buffer.from(expected, 'hex')
    return got.length === want.length && crypto.timingSafeEqual(got, want)
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16)
    const hash = await new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key)))
    )
    return `${salt.toString('hex')}.${hash.toString('hex')}`
}

async function verifyPassword(password, stored) {
    const m = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(String(stored || ''))
    if (!m) return false
    const salt = Buffer.from(m[1], 'hex')
    const want = Buffer.from(m[2], 'hex')
    const got = await new Promise((resolve, reject) =>
        crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key)))
    )
    return got.length === want.length && crypto.timingSafeEqual(got, want)
}

// ---------------------------------------------------------------------------
// Publish / unpublish / status (authenticated, write access enforced in router)
// ---------------------------------------------------------------------------

async function publish(req, res) {
    const projectId = req.params.Project_id
    const userId = SessionManager.getLoggedInUserId(req.session)
    const rawPassword = req.body && req.body.password
    if (rawPassword !== undefined && rawPassword !== null && rawPassword !== '') {
        if (typeof rawPassword !== 'string' || rawPassword.length > MAX_PASSWORD_CHARS) {
            return res.status(400).json({ error: 'invalid password' })
        }
    }
    const rawCustomName = req.body ? req.body.customName : undefined
    if (rawCustomName !== undefined && rawCustomName !== null && rawCustomName !== '') {
        // Bounded before any work is done on it: the transformation below is
        // linear, but nothing good comes of running it on a megabyte of text.
        if (typeof rawCustomName !== 'string' || rawCustomName.length > MAX_CUSTOM_NAME_CHARS) {
            return res.status(400).json({ error: 'invalid custom name' })
        }
    }
    const collection = await docs()
    const register = await names()
    const existing = await collection.findOne({ projectId })
    const token = existing ? existing.token : crypto.randomBytes(24).toString('base64url')

    // Custom name. An ABSENT field keeps whatever the document already has: this
    // endpoint is also how an existing publication is updated, and a client that
    // knows nothing about custom names must not wipe one. An explicitly empty
    // value is the way to remove it and go back to the token alone.
    const previousSlug = existing ? existing.slug || '' : ''
    let slug = previousSlug
    if (rawCustomName === '' || rawCustomName === null) {
        slug = ''
    } else if (typeof rawCustomName === 'string') {
        const candidate = slugify(rawCustomName)
        // Validated, not repaired: a name that does not come out of slugify in
        // canonical form (too short once stripped, empty because it was only
        // punctuation) is refused, so the publisher is never handed a URL that
        // silently differs from what was typed.
        if (!isValidSlug(candidate)) {
            return res.status(400).json({ error: 'invalid custom name' })
        }
        if (candidate !== previousSlug) {
            // Two ways of being unavailable, ONE answer. A name in use by
            // another document and a name another document has released are
            // refused identically, on purpose: the difference between them is
            // exactly the history that must not be readable from outside.
            const taken = await collection.findOne({ slug: candidate })
            if (taken && taken.projectId !== projectId) {
                return res.status(409).json({ error: 'custom name already taken' })
            }
            if (!(await claimableBy(register, candidate, projectId))) {
                return res.status(409).json({ error: 'custom name already taken' })
            }
        }
        slug = candidate
    }

    // Password: only an explicitly empty value removes the protection. A body
    // that says nothing about the password (the panel sends the field only when
    // one was typed) must never silently unprotect a document that was
    // protected, which is exactly what would happen the first time somebody
    // renames the link of an already published, password protected document.
    let passwordHash = existing ? existing.passwordHash || null : null
    if (typeof rawPassword === 'string' && rawPassword !== '') {
        passwordHash = await hashPassword(rawPassword)
    } else if (rawPassword === '' || rawPassword === null) {
        passwordHash = null
    }

    const update = {
        $set: {
            projectId,
            token,
            // The publisher's compiles are the ones the link follows: they are
            // the person who decided the document is ready to be seen.
            publisherUserId: userId,
            passwordHash,
            cookieSecret: existing?.cookieSecret || crypto.randomBytes(32).toString('hex'),
            updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
    }
    // Removed rather than blanked: the unique index is sparse, and a field left
    // there as null would still be indexed, so the second document without a
    // custom name would collide with the first.
    if (slug) update.$set.slug = slug
    else update.$unset = { slug: '' }

    try {
        await collection.updateOne({ projectId }, update, { upsert: true })
    } catch (err) {
        // The index is the guard that actually holds: the check above can lose a
        // race against another publisher claiming the same name a millisecond
        // earlier, and this is what that race looks like when it happens.
        if (err && (err.code === 11000 || err.code === 11001)) {
            return res.status(409).json({ error: 'custom name already taken' })
        }
        logger.warn({ projectId, err }, '[publish] could not save the published document')
        return res.status(500).json({ error: 'internal error' })
    }

    // The register moves only after the write went through, so it always
    // describes names as they really are: this one is live again and leaves the
    // register, the one left behind enters it and stays there.
    try {
        if (slug && slug !== previousSlug) await reclaimName(register, slug)
        if (previousSlug && previousSlug !== slug) await releaseName(register, previousSlug, projectId)
    } catch (err) {
        // The document is published either way, so this is not worth failing the
        // request over; it IS worth a line, because a release that did not make
        // it into the register is a name that went back to being free.
        logger.warn({ projectId, err }, '[publish] could not update the released name register')
    }

    logger.info(
        { projectId, userId, protected: !!passwordHash, named: !!slug },
        '[publish] document published'
    )
    res.json({ ...publicUrls({ token, slug }), hasPassword: !!passwordHash })
    // Fire and forget AFTER answering: a link that says 404 until its author
    // remembers to recompile is a broken promise, so publishing warms it up.
    warmUpPublishedPdf({ projectId, publisherUserId: userId, token }).catch(() => {})
}

// overleaf-lab: compile the project server-side as the publisher, then refresh the
// cached copy immediately (throttle bypassed). Dynamic import inside try/catch,
// exactly like the mailer's core imports: a core path that moves in a future base
// image must degrade this warm-up to a log line, never crash the module. A FAILED
// compile changes nothing: the cache keeps the last successful PDF, so a published
// link never regresses; a project that never compiled successfully has nothing to
// show yet, and honestly answers 404 until it does.
async function warmUpPublishedPdf(doc) {
    try {
        const mod = await import('../../../../app/src/Features/Compile/CompileManager.mjs')
        const CompileManager = mod.default || mod
        if (CompileManager.promises && typeof CompileManager.promises.compile === 'function') {
            await CompileManager.promises.compile(doc.projectId, doc.publisherUserId, {})
        } else if (typeof CompileManager.compile === 'function') {
            await new Promise((resolve, reject) =>
                CompileManager.compile(doc.projectId, doc.publisherUserId, {}, err =>
                    err ? reject(err) : resolve()
                )
            )
        } else {
            throw new Error('CompileManager has no usable compile function')
        }
        lastRefresh.delete(doc.token)
        await refreshCache(doc)
        logger.info({ projectId: doc.projectId }, '[publish] warm-up compile finished')
    } catch (err) {
        logger.warn(
            { projectId: doc.projectId, err },
            '[publish] warm-up compile failed, the link will follow the next successful compile'
        )
    }
}

async function unpublish(req, res) {
    const projectId = req.params.Project_id
    const collection = await docs()
    const doc = await collection.findOne({ projectId })
    await collection.deleteOne({ projectId })
    // The cached copy dies with the link: a revoked document must not survive on
    // disk waiting for the token to leak.
    if (doc && isValidToken(doc.token)) {
        try {
            await fs.promises.unlink(cachePath(doc.token))
        } catch (err) {
            // Already gone (never compiled, or a previous unpublish): fine.
        }
        lastRefresh.delete(doc.token)
    }
    // The document is gone, the name it carried is not: it goes into the
    // register, where it stays. Unpublishing and publishing again under the same
    // name is free for this project and impossible for anybody else.
    if (doc && doc.slug) {
        try {
            await releaseName(await names(), doc.slug, projectId)
        } catch (err) {
            logger.warn({ projectId, err }, '[publish] could not register the released name')
        }
    }
    logger.info({ projectId }, '[publish] document unpublished')
    res.json({ ok: true })
}

async function status(req, res) {
    const projectId = req.params.Project_id
    const collection = await docs()
    const doc = await collection.findOne({ projectId })
    res.json(
        doc
            ? { published: true, ...publicUrls(doc), hasPassword: !!doc.passwordHash }
            : { published: false }
    )
}

// ---------------------------------------------------------------------------
// The public route
// ---------------------------------------------------------------------------

const allowDownload = makeRateLimiter(60, 60 * 1000)
const allowAuthAttempt = makeRateLimiter(10, 60 * 1000)
const lastRefresh = new Map() // token -> ms timestamp of the last CLSI attempt

function cachePath(token) {
    // The token was validated against TOKEN_RE, so it cannot traverse; the join
    // with a fixed directory is belt and braces.
    //
    // ALWAYS the token, never the custom name. Callers resolve the request key to
    // a document first and pass doc.token here, which is what keeps one published
    // document to one cached file: a rename must not orphan the cache or create a
    // second copy of the same PDF, and a name chosen by a user must never be part
    // of a filename in the first place.
    return path.join(PUBLISHED_DIR, `${token}.pdf`)
}

async function refreshCache(doc) {
    const now = Date.now()
    if ((lastRefresh.get(doc.token) || 0) + REFRESH_THROTTLE_MS > now) return
    lastRefresh.set(doc.token, now)
    const source = await findCompiledPdf(OUTPUT_ROOT, doc.projectId, doc.publisherUserId)
    if (!source) {
        logger.warn(
            { projectId: doc.projectId, outputRoot: OUTPUT_ROOT },
            '[publish] no compiled output on disk, the cached copy (if any) stays'
        )
        return
    }
    try {
        await fs.promises.mkdir(PUBLISHED_DIR, { recursive: true })
        const tmp = cachePath(doc.token) + '.tmp'
        await fs.promises.copyFile(source, tmp)
        await fs.promises.rename(tmp, cachePath(doc.token))
        logger.info({ projectId: doc.projectId, source }, '[publish] cache refreshed')
    } catch (err) {
        logger.warn({ projectId: doc.projectId, source, err }, '[publish] cache refresh failed')
    }
}

// A deliberately self-contained password page: no assets, no scripts, nothing
// to tamper with. All styling is inline CSS; the form posts back to a fixed
// sibling path derived from the validated request key.
//
// The key echoed into the form is the one the visitor used, token or custom
// name, and not the document's token: a visitor who only knows the custom name
// has no business being handed the permanent link, and the page is served
// BEFORE any password is checked. It is safe to interpolate because it passed
// TOKEN_RE or SLUG_RE, neither of which admits a character with a meaning in
// HTML.
function passwordPage(key, wrong) {
    return (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Protected document</title>' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<style>' +
        ':root{color-scheme:light dark}' +
        '*{box-sizing:border-box;margin:0}' +
        'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
        'min-height:100vh;display:flex;align-items:center;justify-content:center;' +
        'background:#f4f5f7;color:#1c1f23;padding:1rem}' +
        '.card{background:#fff;border:1px solid #e0e3e8;border-radius:12px;' +
        'box-shadow:0 8px 30px rgba(0,0,0,.06);padding:2.25rem 2rem;width:100%;max-width:23rem;text-align:center}' +
        '.lock{width:3rem;height:3rem;border-radius:50%;background:#eef1f5;' +
        'display:flex;align-items:center;justify-content:center;margin:0 auto 1rem;font-size:1.4rem}' +
        'h1{font-size:1.15rem;font-weight:600;margin-bottom:.4rem}' +
        'p.hint{font-size:.88rem;color:#5b6470;margin-bottom:1.4rem}' +
        'p.err{font-size:.88rem;color:#c0392b;background:rgba(192,57,43,.08);' +
        'border-radius:8px;padding:.5rem .75rem;margin-bottom:1rem}' +
        'input{width:100%;padding:.65rem .8rem;font-size:1rem;border:1px solid #c8cdd4;' +
        'border-radius:8px;background:transparent;color:inherit;text-align:center}' +
        'input:focus{outline:2px solid #4a90d9;outline-offset:1px;border-color:#4a90d9}' +
        'button{width:100%;margin-top:.85rem;padding:.65rem;font-size:1rem;font-weight:600;' +
        'border:0;border-radius:8px;background:#2f7a3d;color:#fff;cursor:pointer}' +
        'button:hover{background:#276633}' +
        '@media(prefers-color-scheme:dark){' +
        'body{background:#14171a;color:#e8eaed}' +
        '.card{background:#1e2226;border-color:#2e343a;box-shadow:0 8px 30px rgba(0,0,0,.4)}' +
        '.lock{background:#2a3037}' +
        'p.hint{color:#9aa4af}' +
        'input{border-color:#3a424a}' +
        '}' +
        '</style></head><body>' +
        '<div class="card">' +
        '<div class="lock">&#128274;</div>' +
        '<h1>This document is password protected</h1>' +
        '<p class="hint">Enter the password to open the PDF.</p>' +
        (wrong ? '<p class="err">Wrong password, try again.</p>' : '') +
        `<form method="POST" action="/published/${key}/auth">` +
        '<input type="password" name="password" autofocus autocomplete="current-password" ' +
        'maxlength="200" placeholder="Password" aria-label="Password">' +
        '<button type="submit">Open document</button>' +
        '</form></div></body></html>'
    )
}

// Derived from the DOCUMENT's token, not from the key the visitor typed, so one
// published document has exactly one cookie: the password is asked once and both
// forms of the link are then open in that browser. Cookies already held by
// visitors of a token link keep working unchanged.
function cookieName(token) {
    return `pubdoc_${token.slice(0, 8)}`
}

// The app-wide security policy (nonce-based, no inline styles, restricted
// form-action) also lands on these public responses: it blanked the page's
// styling and silently ate the form submit (observed live: clicking Open did
// nothing at all). This page needs exactly two things, its own inline style
// block and a same-origin form post; our own policy allows those and keeps
// everything else forbidden.
function sendPasswordPage(res, key, wrong) {
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'"
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.status(401).type('html').send(passwordPage(key, wrong))
}

// The key in the URL is a token or a custom name; from the lookup on it is only
// ever the document. A key of the wrong shape, an unknown one, a revoked one and
// one that was never compiled all end on the same plain 404, whichever of the
// two forms it was: a custom name that nobody claimed must not be
// distinguishable from a token nobody holds.
async function servePdf(req, res) {
    const key = req.params.key
    if (!isValidToken(key) && !isValidSlug(key)) return res.status(404).type('text').send('Not found')
    if (!allowDownload(req.ip || 'unknown')) return res.status(429).type('text').send('Too many requests')
    const collection = await docs()
    const doc = await findPublished(collection, key)
    if (!doc) return res.status(404).type('text').send('Not found')
    if (doc.passwordHash) {
        const cookieHeader = String(req.headers.cookie || '')
        const match = cookieHeader.match(new RegExp(`${cookieName(doc.token)}=([^;]+)`))
        if (!match || !verifyCookieValue(doc.cookieSecret, decodeURIComponent(match[1]))) {
            return sendPasswordPage(res, key, false)
        }
    }
    await refreshCache(doc)
    const file = cachePath(doc.token)
    if (!fs.existsSync(file)) {
        // Published but never compiled since: same shape as any other miss.
        return res.status(404).type('text').send('Not found')
    }
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'inline; filename="document.pdf"')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')
    fs.createReadStream(file).pipe(res)
}

// The public router mounts no form body parser, so the password field is read off
// the request stream by hand when req.body is absent (observed live: the form
// posted, the body was never parsed, and every attempt came back "wrong
// password"). Bounded: a password form has no business being bigger than 4 KB.
function readForm(req) {
    // Trust an upstream body parser only if it actually produced the field: some
    // parsers leave an empty object for content types they skip, and an empty
    // object must not shadow the real form waiting on the stream.
    if (req.body && typeof req.body.password === 'string') return Promise.resolve(req.body)
    return new Promise(resolve => {
        let raw = ''
        let done = false
        const finish = () => {
            if (done) return
            done = true
            resolve(Object.fromEntries(new URLSearchParams(raw)))
        }
        req.on('data', chunk => {
            raw += chunk
            if (raw.length > 4096) {
                raw = ''
                finish()
            }
        })
        req.on('end', finish)
        req.on('error', finish)
        setTimeout(finish, 5000)
    })
}

// The same resolution as servePdf, so the protection is one thing and not two:
// there is no form of the link that reaches the PDF without answering, and no
// form that answers on behalf of the other.
async function authenticate(req, res) {
    const key = req.params.key
    if (!isValidToken(key) && !isValidSlug(key)) return res.status(404).type('text').send('Not found')
    if (!allowAuthAttempt(req.ip || 'unknown')) return res.status(429).type('text').send('Too many requests')
    const collection = await docs()
    const doc = await findPublished(collection, key)
    if (!doc || !doc.passwordHash) return res.status(404).type('text').send('Not found')
    const form = await readForm(req)
    const password = typeof form.password === 'string' ? form.password : ''
    if (password.length === 0 || password.length > MAX_PASSWORD_CHARS || !(await verifyPassword(password, doc.passwordHash))) {
        return sendPasswordPage(res, key, true)
    }
    const expiresAt = Date.now() + COOKIE_TTL_MS
    const value = encodeURIComponent(signCookieValue(doc.cookieSecret, expiresAt))
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
    res.setHeader(
        'Set-Cookie',
        `${cookieName(doc.token)}=${value}; Path=/published/; Max-Age=${Math.floor(COOKIE_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
    )
    // Fixed destination derived from the validated key, never from input, and
    // back to the same form of the link the visitor came in with.
    res.redirect(`/published/${key}.pdf`)
}

export default {
    publish,
    unpublish,
    status,
    servePdf,
    authenticate,
}
