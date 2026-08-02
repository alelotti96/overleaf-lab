// Two readers that fetch bytes from somewhere else and have to stop reading.
//
// A cap enforced AFTER the body is in memory is a statement about what we keep, not
// about what we spend: the oversized file is buffered in full inside the review process
// either way. Both readers below are on paths a student can trigger (a stored figure, a
// DOI that resolves to a registry we do not run), so the cap has to bind on the wire.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = process.env.CTRL ? path.dirname(process.env.CTRL) : path.resolve(HERE, '../vendor/llm/app/src')
const BIBVERIFY = path.join(SRC, 'LLMBibVerify.mjs')
const src = fs.readFileSync(process.env.CTRL, 'utf8')
const bib = fs.readFileSync(BIBVERIFY, 'utf8')

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

function slice(text, from, to, what) {
    const start = text.indexOf(from)
    const end = text.indexOf(to, start)
    if (start === -1 || end === -1 || end <= start) {
        console.error(`FAIL: could not locate ${what}`)
        process.exit(1)
    }
    return text.slice(start, end)
}

// A body that hands out one chunk at a time and remembers whether it was cancelled:
// "the transfer stopped" is the property under test, and a Buffer.length assertion
// cannot see it.
function streamOf(chunks) {
    const state = { delivered: 0, cancelled: false }
    return {
        state,
        body: {
            getReader() {
                let i = 0
                return {
                    async read() {
                        if (i >= chunks.length) return { done: true, value: undefined }
                        const value = chunks[i++]
                        state.delivered += value.length
                        return { done: false, value }
                    },
                    async cancel() {
                        state.cancelled = true
                    },
                }
            },
        },
    }
}

// ===========================================================================
// project files: the cap binds before the bytes are ours
// ===========================================================================
const readBytesRaw = new Function(
    'fetchWithLimit',
    'AUX_FETCH_TIMEOUT_MS',
    `${slice(src, 'const readProjectFileBytes = async', '// overleaf-lab: the ladder of ways', 'readProjectFileBytes')};
     return readProjectFileBytes`
)
// The real fetchWithLimit runs the consume step INSIDE its armed window (that is
// the whole M2 fix: the body read must be abortable). The fake honours the same
// contract, or the reader would get the raw response back instead of its own
// consumer's result.
const readBytes = (impl, timeout) =>
    readBytesRaw(async (url, options, timeoutMs, jobSignal, consume) => {
        const response = await impl(url, options)
        return consume ? consume(response) : response
    }, timeout)

const headersOf = map => ({ get: name => (name.toLowerCase() in map ? map[name.toLowerCase()] : null) })

{
    // Content-Length is the cheapest refusal there is: no body read at all.
    let bodyRead = false
    const read = readBytes(async () => ({
        ok: true,
        headers: headersOf({ 'content-length': '5000000' }),
        get body() {
            bodyRead = true
            return null
        },
        async arrayBuffer() {
            bodyRead = true
            return new ArrayBuffer(5000000)
        },
    }), 1000)
    let threw = null
    try {
        await read('http://filestore/x', undefined, 1024)
    } catch (err) {
        threw = err
    }
    check('a declared size over the cap is refused', threw !== null && /too large/.test(threw.message))
    check('and nothing is read', bodyRead === false, 'the point of the header is to spend nothing')
}
{
    // A wrong (or absent) Content-Length costs nothing: the reader counts what arrives
    // and stops itself.
    const chunk = new Uint8Array(400)
    const s = streamOf([chunk, chunk, chunk, chunk, chunk])
    const read = readBytes(async () => ({ ok: true, headers: headersOf({}), body: s.body }), 1000)
    let threw = null
    try {
        await read('http://filestore/x', undefined, 1000)
    } catch (err) {
        threw = err
    }
    check('an undeclared oversized body is refused too', threw !== null && /too large/.test(threw.message))
    check(
        'the transfer stops as soon as the cap is crossed',
        s.state.delivered <= 1200,
        `${s.state.delivered} bytes read for a 1000 byte cap`
    )
    check('and the connection is cancelled, not left open', s.state.cancelled === true)
}
{
    const s = streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
    const read = readBytes(async () => ({ ok: true, headers: headersOf({ 'content-length': '5' }), body: s.body }), 1000)
    const buffer = await read('http://filestore/x', undefined, 1024)
    check(
        'a file under the cap arrives whole and in order',
        Buffer.compare(buffer, Buffer.from([1, 2, 3, 4, 5])) === 0,
        buffer.toString('hex')
    )
}
{
    // Not every response is a stream (a mock, an already-buffered body): the cap is
    // still a cap.
    const read = readBytes(async () => ({
        ok: true,
        headers: headersOf({}),
        body: null,
        async arrayBuffer() {
            return new ArrayBuffer(2048)
        },
    }), 1000)
    let threw = null
    try {
        await read('http://filestore/x', undefined, 1024)
    } catch (err) {
        threw = err
    }
    check('a non-streaming response is capped as well', threw !== null && /too large/.test(threw.message))
}
{
    const read = readBytes(async () => ({ ok: false, status: 404, headers: headersOf({}) }), 1000)
    let threw = null
    try {
        await read('http://filestore/x', undefined, 1024)
    } catch (err) {
        threw = err
    }
    check('an HTTP failure still names the status', threw !== null && /HTTP 404/.test(threw.message))
}

// ===========================================================================
// bibliography verification: a registry answer is not unbounded either
// ===========================================================================
const readText = new Function(
    `${slice(bib, 'const MAX_RESPONSE_CHARS', 'class Budget', 'readBoundedText')};
     return { readBoundedText, MAX_RESPONSE_CHARS }`
)()

check(
    'the cap is generous enough for a real record',
    readText.MAX_RESPONSE_CHARS >= 128 * 1024,
    `${readText.MAX_RESPONSE_CHARS} chars`
)
{
    const encoder = new TextEncoder()
    const s = streamOf([encoder.encode('a'.repeat(2000)), encoder.encode('b'.repeat(2000))])
    const text = await readText.readBoundedText({ body: s.body }, 1000)
    check('a long answer is cut at the cap', text.length === 1000, `${text.length}`)
    check('and the rest is never asked for', s.state.delivered <= 2000, `${s.state.delivered}`)
    check('the transfer is cancelled', s.state.cancelled === true)
}
{
    const s = streamOf([new TextEncoder().encode('{"status":"ok"}')])
    const text = await readText.readBoundedText({ body: s.body }, 1000)
    check('a normal answer comes back whole', text === '{"status":"ok"}', text)
}
{
    const text = await readText.readBoundedText(
        { body: null, async text() { return 'x'.repeat(50) } },
        10
    )
    check('a non-streaming answer is bounded too', text.length === 10, `${text.length}`)
}
check(
    'and the Budget uses it instead of response.text()',
    /text = await readBoundedText\(response, MAX_RESPONSE_CHARS\)/.test(bib) &&
        !/text = await response\.text\(\)/.test(bib.slice(bib.indexOf('class Budget'))),
    'the body is still read before anything branches on the status, only not without a limit'
)

// ===========================================================================
// the text reader as a whole: budgeted, and its failure strings scrubbed
// ===========================================================================
// The per-file cap above bounds one file. Nothing bounded how many files, how many
// bytes in total, or for how long a project full of 2 MB uploads could keep the
// review fetching; and the failure reasons named internal service URLs on their way
// into the report, the archive and the prompt. Both properties live in
// readTextualProjectFiles, sliced here with the real constants and the real scrubber.
const textReaderSource = [
    slice(src, 'const TEXTUAL_FILE_EXTENSION', '// overleaf-lab: failure reasons cross', 'the text reader constants'),
    slice(src, 'const scrubUrls =', "// overleaf-lab: read a file's bytes", 'scrubUrls'),
    slice(src, 'async function readTextualProjectFiles(', '// overleaf-lab: measure the effective resolution', 'readTextualProjectFiles'),
].join('\n')

function makeTextReader({ files, strategies, filestoreUrl = 'http://filestore:3009', historyUrl = null, clock = null }) {
    const warnings = []
    // eslint-disable-next-line no-new-func
    const readTextualProjectFiles = new Function(
        'ProjectEntityHandler',
        'logger',
        'buildFileReadStrategies',
        'Date',
        `${textReaderSource}; return readTextualProjectFiles`
    )(
        { promises: { getAllFiles: async () => files } },
        { warn: (fields, message) => warnings.push({ fields, message }) },
        async () => ({ strategies, filestoreUrl, historyUrl }),
        clock || Date
    )
    return { warnings, run: () => readTextualProjectFiles('proj-1') }
}

{
    // The reason the report keeps is scrubbed; the reason the log keeps is not.
    const address = 'http://filestore:3009/project/p/file/f1'
    const reader = makeTextReader({
        files: { 'refs.bib': { _id: 'f1', size: 100, hash: 'h' } },
        strategies: [{
            name: 'filestore',
            url: () => address,
            read: async () => { throw new Error(`connect ECONNREFUSED ${address}`) },
        }],
    })
    const result = await reader.run()
    const reason = result.skipped[0] && result.skipped[0].reason
    check('a stored failure reason keeps no internal URL', typeof reason === 'string' && !/https?:\/\//.test(reason), reason)
    check('and says an address was removed rather than hiding that', /\[internal url\]/.test(reason), reason)
    check('while the log keeps the address the operator needs', reader.warnings.some(w => w.fields.reason && w.fields.reason.includes(address)))
}
{
    // The no-strategy branch used to print both configured base URLs verbatim.
    const reader = makeTextReader({
        files: { 'refs.bib': { _id: 'f1', size: 100, hash: 'h' } },
        strategies: [],
    })
    const result = await reader.run()
    const reason = result.skipped[0] && result.skipped[0].reason
    check('no-strategy reasons name what is configured, not where', /filestore configured; history not configured/.test(reason), reason)
    check('and carry no URL either', !/https?:\/\//.test(reason), reason)
}
{
    // Count budget: file 101 is skipped and says why, files 1..100 are read.
    const files = {}
    for (let i = 0; i < 103; i++) files[`notes-${i}.txt`] = { _id: `f${i}`, size: 10, hash: 'h' }
    const reader = makeTextReader({
        files,
        strategies: [{ name: 'filestore', read: async () => Buffer.from('some text') }],
    })
    const result = await reader.run()
    check('the file-count budget binds', result.files.length === 100, `${result.files.length} read`)
    check('and the files past it are named with the reason', result.skipped.length === 3 && result.skipped.every(s => /more than 100 linked text files/.test(s.reason)), JSON.stringify(result.skipped[0]))
}
{
    // Byte budget: 2 MB per file is allowed, 20 MB across the project is the wall.
    const files = {}
    for (let i = 0; i < 11; i++) files[`chunk-${i}.txt`] = { _id: `f${i}`, size: 2 * 1024 * 1024, hash: 'h' }
    const big = Buffer.alloc(2 * 1024 * 1024, 'a')
    const reader = makeTextReader({
        files,
        strategies: [{ name: 'filestore', read: async () => big }],
    })
    const result = await reader.run()
    check('the total byte budget binds', result.files.length === 10, `${result.files.length} read`)
    check('and names itself', result.skipped.length === 1 && /text byte budget/.test(result.skipped[0].reason), JSON.stringify(result.skipped[0]))
}
{
    // Time budget, on a clock the test controls: each read costs 31 fake seconds,
    // so the third file finds the 60-second budget spent.
    let now = 0
    const reader = makeTextReader({
        files: {
            'a.txt': { _id: 'f1', size: 10, hash: 'h' },
            'b.txt': { _id: 'f2', size: 10, hash: 'h' },
            'c.txt': { _id: 'f3', size: 10, hash: 'h' },
        },
        strategies: [{ name: 'filestore', read: async () => { now += 31000; return Buffer.from('text') } }],
        clock: { now: () => now },
    })
    const result = await reader.run()
    check('the time budget binds', result.files.length === 2 && result.skipped.length === 1, `${result.files.length} read, ${result.skipped.length} skipped`)
    check('and names itself too', result.skipped.every(s => /text time budget/.test(s.reason)), JSON.stringify(result.skipped[0]))
}

// The module has to keep parsing after all this.
await import(pathToFileURL(BIBVERIFY).href)

console.log(ok ? '\nbounded_reads: all good' : '\nbounded_reads: FAILURES')
process.exit(ok ? 0 : 1)
