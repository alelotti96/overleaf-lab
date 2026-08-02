// Extract the pure security helpers from the publish module and pin them: token
// shape, cookie signing, rate limiting and the on-disk output lookup are the
// pieces a mistake in which becomes an internet-facing hole.
import fs from 'node:fs'
import path from 'node:path'

const src = fs.readFileSync(process.env.PUBLISH, 'utf8')
const start = src.indexOf('function isValidToken(')
const end = src.indexOf('// Publish / unpublish / status')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the helpers in the publish controller')
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const h = await new Function(
    'crypto',
    'path',
    'fs',
    'TOKEN_RE',
    'ID_RE',
    `${src.slice(start, end)}; return { isValidToken, makeRateLimiter, findCompiledPdf, signCookieValue, verifyCookieValue, hashPassword, verifyPassword }`
)(
    await import('node:crypto').then(m => m.default),
    path,
    fs,
    /^[A-Za-z0-9_-]{28,40}$/,
    /^[0-9a-f]{24}$/
)

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---- token shape ----
const goodToken = 'A'.repeat(32)
check('a 32-char urlsafe token is valid', h.isValidToken(goodToken))
check('a short token is not', !h.isValidToken('abc'))
check('a traversal attempt is not a token', !h.isValidToken('../../etc/passwd'))
check('a token with a slash is rejected', !h.isValidToken('A'.repeat(30) + '/x'))
check('a real generated token is valid', h.isValidToken((await import('node:crypto')).randomBytes(24).toString('base64url')))

// ---- rate limiter ----
{
    const allow = h.makeRateLimiter(3, 60 * 1000)
    const results = [allow('ip1'), allow('ip1'), allow('ip1'), allow('ip1')]
    check('the limiter allows up to the limit and then refuses', results.join(',') === 'true,true,true,false')
    check('another key has its own window', allow('ip2') === true)
}

// ---- cookie signing ----
{
    const secret = 'topsecret'
    const future = Date.now() + 60 * 1000
    const value = h.signCookieValue(secret, future)
    check('a signed cookie verifies', h.verifyCookieValue(secret, value))
    check('a tampered cookie does not', !h.verifyCookieValue(secret, value.replace(/.$/, c => (c === 'a' ? 'b' : 'a'))))
    check('an expired cookie does not', !h.verifyCookieValue(secret, h.signCookieValue(secret, Date.now() - 1000)))
    check('a cookie signed with another secret does not', !h.verifyCookieValue('other', value))
    check('garbage does not verify', !h.verifyCookieValue(secret, 'lol') && !h.verifyCookieValue(secret, ''))
}

// ---- password hashing ----
{
    // An obviously fake value: a plausible-looking one trips secret scanners on
    // every run of the repo, and this test only needs SOME string.
    const fake = 'example-password-for-this-test'
    const stored = await h.hashPassword(fake)
    check('the stored form is salt.hash, never the clear text', /^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(stored) && !stored.includes(fake))
    check('the right password verifies', await h.verifyPassword(fake, stored))
    check('the wrong password does not', !(await h.verifyPassword('another-example-value', stored)))
    check('a malformed stored hash refuses everything', !(await h.verifyPassword(fake, 'not-a-hash')))
}

// ---- on-disk output lookup ----
{
    // A tiny fake of fs.promises over a { path: mtimeMs } map, enough for the
    // readdir/stat calls the lookup makes.
    const makeFakeFs = files => ({
        async readdir(dir) {
            const prefix = dir + path.sep
            const names = new Set()
            for (const f of Object.keys(files)) {
                if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split(path.sep)[0])
            }
            if (names.size === 0) throw new Error('ENOENT')
            return [...names].map(name => ({
                name,
                isDirectory: () =>
                    Object.keys(files).some(f => f.startsWith(path.join(dir, name) + path.sep)),
            }))
        },
        async stat(p) {
            if (!(p in files)) throw new Error('ENOENT')
            return { isFile: () => true, mtimeMs: files[p] }
        },
    })
    const root = path.join('data', 'output')
    const p = '6974b4935b457420be561b72'
    const u = '68f6943f5c32885931c6d79b'
    const oldBuild = path.join(root, `${p}-${u}`, 'generated-files', '19fb8f62c98-ebdcdf17cf97d720', 'output.pdf')
    const newBuild = path.join(root, `${p}-${u}`, 'generated-files', '19fb8f636e9-c113e21fd0d6f0aa', 'output.pdf')
    const twoBuilds = makeFakeFs({ [oldBuild]: 1000, [newBuild]: 2000 })
    check('the newest build wins', (await h.findCompiledPdf(root, p, u, twoBuilds)) === newBuild)
    const flat = makeFakeFs({ [path.join(root, p, 'output.pdf')]: 1000 })
    check('the flat legacy layout is found', (await h.findCompiledPdf(root, p, u, flat)) === path.join(root, p, 'output.pdf'))
    check('nothing on disk gives null', (await h.findCompiledPdf(root, p, u, makeFakeFs({}))) === null)
    check('a non-hex project id never touches the disk', (await h.findCompiledPdf(root, '../../etc', u, twoBuilds)) === null)
    check('a non-hex user id never touches the disk', (await h.findCompiledPdf(root, p, 'x/../..', twoBuilds)) === null)
}

// ---- the password page must carry its own security policy ----
// The app-wide CSP blanked the page's styling and ate the form submit (observed
// live); the page sends its own. A tripwire on the source, not a slice: the
// header lives inside the response path.
check(
    "the password page sets its own CSP with form-action 'self'",
    src.includes("form-action 'self'") && src.includes("style-src 'unsafe-inline'") && src.includes("default-src 'none'")
)

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
