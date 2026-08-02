// overleaf-lab: how sharp a raster figure actually is, measured instead of guessed.
//
// The rubrics ask for legible figures and prefer vector graphics. Today that question
// is answered from the LaTeX alone: a .pdf is fine, a .png is suspicious. That reads a
// file extension and calls it a resolution. The number that decides whether a plot is
// legible on paper is the EFFECTIVE resolution: the pixels the file carries divided by
// the width it is printed at. Both halves are in the project - the pixel dimensions are
// in the image header, the printed width is in the \includegraphics options - so the
// question is arithmetic, not judgement, and arithmetic is not what a language model is
// for.
//
// WHAT THIS MODULE WILL NOT DO. It has no opinion on what DPI is acceptable. 300 is the
// usual print number, 150 is usually fine on a screen, and a screenshot of a terminal at
// 96 DPI may be exactly right for what it shows; which of those passes is the rubric's
// call and the reader's. A threshold hardcoded here would quietly become the standard
// for every rubric that ever runs through the tool. The module reports numbers and says
// what it assumed to get them.
//
// THE ASSUMPTION IS PART OF THE ANSWER. `width=0.7\textwidth` is only a length once you
// know \textwidth, and that depends on the class, the paper size, the geometry package
// and whatever the student did to the margins. This module assumes a value and every
// number computed from it carries `exact: false` next to the millimetres assumed. An
// absolute width (`width=80mm`) needs no assumption and is flagged `exact: true`.
// Presenting the first kind as the second is how a report gets argued with, and a report
// that loses one argument is not read again.
//
// PURE. Buffers and strings in, JSON-able facts out. No fetching, no filesystem, no
// model, no clock. The controller reads the bytes; this file only ever looks at them.

export const IMAGE_METRICS_VERSION = '2026-08'

// overleaf-lab: the assumed text width, in millimetres. A4 is 210 mm wide and a thesis
// class with 25 mm margins leaves 160 mm of text. It is a guess, it is stated as one in
// every row computed from it, and the caller can pass its own.
export const DEFAULT_TEXT_WIDTH_MM = 160

const MM_PER_INCH = 25.4

// overleaf-lab: TeX's two points. `pt` is TeX's own (72.27 to the inch), `bp` is the
// PostScript big point (72 to the inch) that PDF and every drawing program use. They
// differ by 0.37 percent, which is nothing here, but they are different units and a
// module that measures things should not confuse two units because the error is small.
const MM_PER_PT = MM_PER_INCH / 72.27
const MM_PER_BP = MM_PER_INCH / 72

// The rest of TeX's length units, for the same reason: a student who writes `width=6pc`
// gets a number rather than an "unparsed" row.
const UNIT_TO_MM = {
    mm: 1,
    cm: 10,
    in: MM_PER_INCH,
    pt: MM_PER_PT,
    bp: MM_PER_BP,
    pc: 12 * MM_PER_PT,
    dd: (1238 / 1157) * MM_PER_PT,
    cc: 12 * (1238 / 1157) * MM_PER_PT,
    sp: MM_PER_PT / 65536,
}

// overleaf-lab: the lengths that mean "as wide as the text". \hsize is TeX's own name
// for the same thing and survives in classes written before LaTeX2e. \paperwidth is
// DELIBERATELY not here: it is a different assumption (210 mm, not 160), and answering
// it with the text width would be wrong by a third.
const TEXT_WIDTH_MACROS = new Set(['textwidth', 'linewidth', 'columnwidth', 'hsize'])

// overleaf-lab: bounds on what is STORED, never on what is counted. Same rule as the AI
// signals block: every capped list is stored next to its true total and the renderer
// says "showing N of M". A cap the reader cannot see is a lie about how much was found.
const MAX_MEASURED_ROWS = 40
const MAX_UNCHECKED_ROWS = 20
// A ceiling on how many \includegraphics sites one scan will collect. A thesis has a
// couple of hundred; this is an order of magnitude above that and only bounds what a
// deliberately pathological upload can ask for.
const MAX_FIGURE_SITES = 2000
// Options longer than this are not a width spec, they are a payload. Bounding the input
// bounds the parse.
const MAX_OPTIONS_CHARS = 512

export const LIMITS = {
    measuredRows: MAX_MEASURED_ROWS,
    uncheckedRows: MAX_UNCHECKED_ROWS,
    figureSites: MAX_FIGURE_SITES,
    optionsChars: MAX_OPTIONS_CHARS,
}

// overleaf-lab: the largest image this module is worth spending memory on. A figure in a
// thesis is a plot or a photograph; 10 MB is far above either. The cap belongs here
// rather than in the controller so that the number the fetcher enforces and the number
// the report explains are the same one.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// The formats whose headers this module can read, and the ones that need no reading
// because they carry no pixels. The controller fetches the bytes of the first group
// only: a vector figure has no DPI to measure, so pulling a 4 MB PDF over HTTP to learn
// what its extension already said is cost for nothing.
export const RASTER_EXTENSION = /\.(png|jpe?g|jpe|gif|bmp|dib|webp|tiff?)$/i
export const VECTOR_EXTENSION = /\.(pdf|eps|epsi|epsf|ps|svgz?)$/i

// overleaf-lab: what to do with a graphics path, before anything is fetched.
// "raster" means fetch the bytes and measure; "vector" means count it and move on;
// "unknown" covers both the extensions nobody here recognises and the bare
// `\includegraphics{plot}` that graphicx resolves against \graphicspath at build time.
export function classifyGraphicsPath(path) {
    const name = String(path || '').trim()
    if (!name) return 'unknown'
    if (RASTER_EXTENSION.test(name)) return 'raster'
    if (VECTOR_EXTENSION.test(name)) return 'vector'
    return 'unknown'
}

// ---------------------------------------------------------------------------
// image headers
// ---------------------------------------------------------------------------

// Every failure path in this section goes through these two, so that a caller never has
// to tell "the module could not read it" from "the module threw".
const unknownImage = (reason, format = null) => ({ unknown: true, format, reason })
const vectorImage = format => ({ vector: true, format })

function toBuffer(input) {
    if (Buffer.isBuffer(input)) return input
    if (input instanceof Uint8Array) {
        return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
    }
    if (input instanceof ArrayBuffer) return Buffer.from(input)
    return null
}

const startsWith = (buf, bytes, at = 0) =>
    buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b)

const ascii = (buf, at, length) =>
    buf.length >= at + length ? buf.toString('latin1', at, at + length) : ''

// overleaf-lab: pixels per inch declared BY THE FILE. PNG carries it in pHYs, JPEG in
// the JFIF header, BMP in its info header. It matters in exactly one case and it is a
// common one: `\includegraphics{plot.png}` with no width at all, where pdfTeX sizes the
// image from that number and nothing else. Absent almost everywhere, so it is optional
// in every shape this module returns.
const ppiFromPixelsPerMetre = ppm =>
    Number.isFinite(ppm) && ppm > 0 ? Math.round(ppm * 0.0254) : null

// A PNG is a signature and then a chain of length-prefixed chunks. IHDR is required by
// the spec to be the first one, so the dimensions are always at a fixed offset; pHYs, if
// present, is somewhere between IHDR and the first IDAT.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_PNG_CHUNKS = 32

function readPng(buf) {
    if (buf.length < 24) return unknownImage('PNG truncated before IHDR', 'png')
    if (ascii(buf, 12, 4) !== 'IHDR') {
        return unknownImage('PNG first chunk is not IHDR', 'png')
    }
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width === 0 || height === 0) {
        return unknownImage('PNG declares a zero dimension', 'png')
    }
    // The chunk walk is bounded twice over: by the chunk count and by the buffer. A
    // length field is 4 bytes of student-supplied data and may claim anything.
    let ppi = null
    let offset = 8
    for (let chunk = 0; chunk < MAX_PNG_CHUNKS; chunk += 1) {
        if (offset + 8 > buf.length) break
        const length = buf.readUInt32BE(offset)
        const type = ascii(buf, offset + 4, 4)
        if (type === 'IDAT' || type === 'IEND') break
        if (type === 'pHYs' && length >= 9 && offset + 8 + 9 <= buf.length) {
            // ppuX, ppuY, then the unit: 1 is metres, 0 means "aspect ratio only" and
            // says nothing about physical size.
            if (buf[offset + 8 + 8] === 1) {
                ppi = ppiFromPixelsPerMetre(buf.readUInt32BE(offset + 8))
            }
        }
        // length + the 4-byte type + the 4-byte CRC. Guarded against a length that
        // wraps the offset backwards or past the end.
        const next = offset + 12 + length
        if (!Number.isSafeInteger(next) || next <= offset) break
        offset = next
    }
    return { format: 'png', width, height, ppi }
}

// The SOF markers that carry dimensions. C4 is the Huffman table, C8 is reserved and CC
// is the arithmetic-coding table: they sit in the same numeric range and are not frame
// headers. C0 is baseline and C2 is progressive, which is what a real project contains;
// the rest are here because reading them costs one Set entry each.
const JPEG_SOF_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])
const MAX_JPEG_SEGMENTS = 128

// overleaf-lab: JPEG dimensions, by WALKING the segment chain.
//
// The tempting shortcut is to search the file for FF C0 and read the four bytes after
// it. That is wrong on real files and wrong in the direction that matters: those two
// bytes occur inside comments, inside Exif thumbnails and inside compressed scan data,
// so the search finds a number that is not the size of anything and reports it with the
// same confidence as a real one. A wrong DPI in a report is worse than no DPI, because
// nobody can tell it is wrong by looking at it. So each segment is skipped by its own
// declared length, and the walk stops at the scan data where segment structure ends.
function readJpeg(buf) {
    let offset = 2
    let ppi = null
    for (let segment = 0; segment < MAX_JPEG_SEGMENTS; segment += 1) {
        // Fill bytes: a marker may be preceded by any number of extra 0xFF.
        while (offset + 1 < buf.length && buf[offset] === 0xff && buf[offset + 1] === 0xff) {
            offset += 1
        }
        if (offset + 1 >= buf.length) return unknownImage('JPEG truncated before SOF', 'jpeg')
        if (buf[offset] !== 0xff) return unknownImage('JPEG segment does not start with 0xFF', 'jpeg')
        const marker = buf[offset + 1]
        offset += 2
        // Standalone markers: no length, no payload.
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue
        }
        // SOS starts the entropy-coded data and EOI ends the file. A frame header that
        // has not appeared by now is not going to.
        if (marker === 0xda || marker === 0xd9) {
            return unknownImage('JPEG has no frame header before the scan data', 'jpeg')
        }
        if (offset + 1 >= buf.length) return unknownImage('JPEG truncated in a segment header', 'jpeg')
        const length = buf.readUInt16BE(offset)
        // The length counts itself, so anything below 2 cannot be a real segment and
        // would also stall the walk.
        if (length < 2) return unknownImage('JPEG segment declares an impossible length', 'jpeg')
        if (offset + length > buf.length) return unknownImage('JPEG truncated inside a segment', 'jpeg')
        if (JPEG_SOF_MARKERS.has(marker)) {
            if (length < 7) return unknownImage('JPEG frame header is too short', 'jpeg')
            const height = buf.readUInt16BE(offset + 3)
            const width = buf.readUInt16BE(offset + 5)
            if (width === 0 || height === 0) {
                return unknownImage('JPEG declares a zero dimension', 'jpeg')
            }
            return { format: 'jpeg', width, height, ppi }
        }
        // APP0/JFIF, the only place a plain JPEG states its resolution. Exif (APP1)
        // states it too, behind a whole TIFF parser; not worth it for a number that
        // only matters when the LaTeX gives no width at all.
        if (marker === 0xe0 && length >= 14 && ascii(buf, offset + 2, 5) === 'JFIF\0') {
            const units = buf[offset + 9]
            const density = buf.readUInt16BE(offset + 10)
            if (density > 0) {
                if (units === 1) ppi = density
                else if (units === 2) ppi = Math.round(density * 2.54)
            }
        }
        offset += length
    }
    return unknownImage('JPEG has more segments than this module will walk', 'jpeg')
}

function readGif(buf) {
    if (buf.length < 10) return unknownImage('GIF truncated before the screen descriptor', 'gif')
    const width = buf.readUInt16LE(6)
    const height = buf.readUInt16LE(8)
    if (width === 0 || height === 0) return unknownImage('GIF declares a zero dimension', 'gif')
    return { format: 'gif', width, height, ppi: null }
}

// BMP comes in two header shapes that a project can actually contain: the 12-byte
// BITMAPCOREHEADER with 16-bit dimensions, and BITMAPINFOHEADER (40 bytes) and its
// successors, which are longer but keep the first fields in place. A negative height is
// legal and means the rows are stored top-down.
function readBmp(buf) {
    if (buf.length < 22) return unknownImage('BMP truncated before the header', 'bmp')
    const headerSize = buf.readUInt32LE(14)
    let width
    let height
    let ppi = null
    if (headerSize === 12) {
        width = buf.readUInt16LE(18)
        height = buf.readUInt16LE(20)
    } else if (headerSize >= 40) {
        if (buf.length < 26) return unknownImage('BMP truncated inside the info header', 'bmp')
        width = buf.readInt32LE(18)
        height = buf.readInt32LE(22)
        if (buf.length >= 42) ppi = ppiFromPixelsPerMetre(buf.readInt32LE(38))
    } else {
        return unknownImage(`BMP header size ${headerSize} is not one this module reads`, 'bmp')
    }
    width = Math.abs(width)
    height = Math.abs(height)
    if (width === 0 || height === 0) return unknownImage('BMP declares a zero dimension', 'bmp')
    return { format: 'bmp', width, height, ppi }
}

// WebP is a RIFF container with three ways of saying the same thing: a lossy VP8 frame,
// a lossless VP8L stream, or a VP8X extended header that states the canvas size before
// either. All three keep the dimensions in the first bytes of the first chunk.
function readWebp(buf) {
    if (buf.length < 20) return unknownImage('WebP truncated before the first chunk', 'webp')
    const chunk = ascii(buf, 12, 4)
    if (chunk === 'VP8 ') {
        if (buf.length < 30) return unknownImage('WebP lossy frame truncated', 'webp')
        // The three-byte frame tag, then the sync code that says this is a key frame.
        if (!startsWith(buf, [0x9d, 0x01, 0x2a], 23)) {
            return unknownImage('WebP lossy frame has no key-frame sync code', 'webp')
        }
        const width = buf.readUInt16LE(26) & 0x3fff
        const height = buf.readUInt16LE(28) & 0x3fff
        if (!width || !height) return unknownImage('WebP declares a zero dimension', 'webp')
        return { format: 'webp', width, height, ppi: null }
    }
    if (chunk === 'VP8L') {
        if (buf.length < 25) return unknownImage('WebP lossless stream truncated', 'webp')
        if (buf[20] !== 0x2f) return unknownImage('WebP lossless stream has no signature byte', 'webp')
        // 14 bits of width-1 then 14 bits of height-1, packed little-endian.
        const bits = buf.readUInt32LE(21)
        return {
            format: 'webp',
            width: (bits & 0x3fff) + 1,
            height: ((bits >>> 14) & 0x3fff) + 1,
            ppi: null,
        }
    }
    if (chunk === 'VP8X') {
        if (buf.length < 30) return unknownImage('WebP extended header truncated', 'webp')
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
        return { format: 'webp', width, height, ppi: null }
    }
    return unknownImage(`WebP chunk "${chunk.trim()}" is not one this module reads`, 'webp')
}

// overleaf-lab: an SVG is text, and the tag that identifies it may sit behind an XML
// declaration, a doctype, a comment or a byte-order mark. Looked for in a bounded prefix
// rather than at offset zero for exactly that reason.
const SVG_SNIFF_BYTES = 1024

function looksLikeSvg(buf) {
    const head = buf.toString('latin1', 0, Math.min(buf.length, SVG_SNIFF_BYTES))
    return /<svg[\s>]/i.test(head) || /<!DOCTYPE\s+svg/i.test(head)
}

// overleaf-lab: the pixel dimensions of an image, from its header alone.
//
// NEVER THROWS. This runs on files a student uploaded, inside a review that has already
// cost minutes; a truncated GIF must produce a row that says "truncated GIF", not an
// exception that loses the run. Every failure comes back as {unknown: true, reason},
// and the reason is written for the person reading the report, not for a log.
//
// Returns one of three shapes:
//   {format, width, height, ppi}   a raster image, ppi null unless the file declares one
//   {vector: true, format}         PDF, EPS or SVG: no pixels, nothing to measure
//   {unknown: true, format, reason}
//
// The filename is a fallback, never the first word: an .eps file that is really a PNG is
// a mistake worth reporting as what it is, and `\includegraphics{fig}` has no extension
// at all. Magic bytes decide whenever they can.
export function imageDimensions(buffer, filename = '') {
    try {
        const buf = toBuffer(buffer)
        if (!buf || buf.length === 0) {
            return unknownImage(buf ? 'the file is empty' : 'no bytes were read')
        }
        if (startsWith(buf, PNG_SIGNATURE)) return readPng(buf)
        if (startsWith(buf, [0xff, 0xd8, 0xff])) return readJpeg(buf)
        if (ascii(buf, 0, 4) === 'GIF8' && ascii(buf, 4, 2).endsWith('a')) return readGif(buf)
        if (ascii(buf, 0, 2) === 'BM') return readBmp(buf)
        if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return readWebp(buf)
        if (ascii(buf, 0, 5) === '%PDF-') return vectorImage('pdf')
        // A PostScript file, and the binary DOS wrapper that carries one.
        if (ascii(buf, 0, 4) === '%!PS' || startsWith(buf, [0xc5, 0xd0, 0xd3, 0xc6])) {
            return vectorImage('eps')
        }
        if (looksLikeSvg(buf)) return vectorImage('svg')
        // A gzipped SVG is a vector figure inside a container this module will not open.
        if (startsWith(buf, [0x1f, 0x8b]) && /\.svgz$/i.test(filename)) return vectorImage('svg')
        // TIFF is recognised and deliberately not measured: reading it means walking an
        // IFD, and telling the reader "this is a TIFF and I did not measure it" is more
        // useful than a generic "unrecognised bytes" for a format that does turn up in
        // a scanned appendix.
        if (ascii(buf, 0, 4) === 'II\x2a\x00' || ascii(buf, 0, 4) === 'MM\x00\x2a') {
            return unknownImage('TIFF headers are not read by this module', 'tiff')
        }
        if (VECTOR_EXTENSION.test(filename)) {
            return vectorImage(filename.split('.').pop().toLowerCase())
        }
        return unknownImage('the first bytes match no image format this module knows')
    } catch (err) {
        // A header parser that throws on a crafted file would take the review with it.
        return unknownImage(`the header could not be read (${err && err.message})`)
    }
}

// ---------------------------------------------------------------------------
// the width the figure is printed at
// ---------------------------------------------------------------------------

// A number, with or without a leading digit: LaTeX accepts `.5\textwidth`.
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)`
const RELATIVE_LENGTH = new RegExp(String.raw`^(${NUMBER})?\s*\\([a-zA-Z@]+)$`)
const ABSOLUTE_LENGTH = new RegExp(String.raw`^(${NUMBER})\s*([a-zA-Z]+)$`)

// overleaf-lab: split the options on the commas that separate keys, and only those. A
// real figure carries `trim={5mm 0 0 0},clip` or `bb={0 0 100 100}`, whose braces hold
// commas and spaces of their own; splitting on every comma turned those into three
// unparsable keys and lost the width sitting next to them.
function splitOptions(text) {
    const parts = []
    let depth = 0
    let current = ''
    for (const ch of text) {
        if (ch === '{' || ch === '[') depth += 1
        else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1)
        else if (ch === ',' && depth === 0) {
            parts.push(current)
            current = ''
            continue
        }
        current += ch
    }
    parts.push(current)
    return parts.map(p => p.trim()).filter(Boolean)
}

function parseLength(value) {
    const text = String(value || '').trim()
    const relative = RELATIVE_LENGTH.exec(text)
    if (relative) {
        const factor = relative[1] === undefined ? 1 : Number.parseFloat(relative[1])
        return { relative: true, factor, macro: relative[2] }
    }
    const absolute = ABSOLUTE_LENGTH.exec(text)
    if (absolute) {
        const unit = absolute[2].toLowerCase()
        if (!Object.prototype.hasOwnProperty.call(UNIT_TO_MM, unit)) {
            return { unparsed: true, reason: `"${unit}" is not a length unit this module converts` }
        }
        return { mm: Number.parseFloat(absolute[1]) * UNIT_TO_MM[unit] }
    }
    return { unparsed: true, reason: `"${text}" is not a plain length` }
}

// overleaf-lab: the rendered-width spec of one \includegraphics, from its options.
//
// Returns a descriptor with a `kind`, never null and never a throw:
//   relative  a fraction of the text width          {factor, macro}
//   absolute  a real length                         {mm}
//   scale     a multiple of the file's natural size {scale}
//   natural   no size given at all
//   height    only a height was given, so the width follows from the aspect ratio
//   unparsed  something is there and this module will not guess at it {reason}
//
// KEY ORDER IS SEMANTIC in graphicx, and this is not a subtlety anyone should have to
// remember: `[angle=90,width=8cm]` rotates first and then fits the ROTATED box to 8 cm,
// so it is the image's height in pixels that spans those 8 cm, while `[width=8cm,angle=90]`
// fits first and rotates after. The two differ by the aspect ratio of the figure, which
// on a wide plot is a factor of two. The parser reads the options in order, so it records
// which came first and lets effectiveDpi pick the axis.
export function parseIncludeWidth(optionsString, filename = '') {
    const path = String(filename || '')
    const raw = String(optionsString == null ? '' : optionsString)
        .trim()
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .trim()
    const base = { path, source: raw, angle: null, angleFirst: false, keepAspect: false }
    if (!raw) return { ...base, kind: 'natural' }
    if (raw.length > MAX_OPTIONS_CHARS) {
        return { ...base, source: raw.slice(0, MAX_OPTIONS_CHARS), kind: 'unparsed', reason: 'the options are too long to be a size spec' }
    }

    let size = null
    let scale = null
    let height = null
    let angle = null
    let angleSeenFirst = false
    let keepAspect = false

    for (const part of splitOptions(raw)) {
        const eq = part.indexOf('=')
        const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase()
        const value = eq === -1 ? '' : part.slice(eq + 1).trim()
        if (key === 'width' && size === null) {
            size = parseLength(value)
            if (angle !== null) angleSeenFirst = true
        } else if (key === 'height' || key === 'totalheight') {
            height = parseLength(value)
            if (angle !== null) angleSeenFirst = true
        } else if (key === 'scale' && scale === null) {
            const number = Number.parseFloat(value)
            scale = Number.isFinite(number) ? number : null
            if (angle !== null) angleSeenFirst = true
        } else if (key === 'angle' || key === 'origin') {
            if (key === 'angle') {
                const number = Number.parseFloat(value)
                angle = Number.isFinite(number) ? number : null
            }
        } else if (key === 'keepaspectratio') {
            keepAspect = value === '' || /^true$/i.test(value)
        }
    }

    const carried = { ...base, angle, angleFirst: angleSeenFirst, keepAspect }

    // width and scale together COMPOUND in graphicx: the scale multiplies whatever the
    // width fitting produced. Rather than encode that and be quietly wrong when a future
    // release changes it, the pair is reported as what it is: a spec this module will
    // not reduce to one number.
    if (size && scale !== null) {
        return { ...carried, kind: 'unparsed', reason: 'width and scale are given together' }
    }
    if (size) {
        if (size.unparsed) return { ...carried, kind: 'unparsed', reason: size.reason }
        if (size.relative) {
            if (!TEXT_WIDTH_MACROS.has(size.macro)) {
                return {
                    ...carried,
                    kind: 'unparsed',
                    reason: `the width is a fraction of \\${size.macro}, which this module does not assume a value for`,
                }
            }
            if (!(size.factor > 0)) {
                return { ...carried, kind: 'unparsed', reason: 'the width factor is not positive' }
            }
            return { ...carried, kind: 'relative', factor: size.factor, macro: size.macro }
        }
        if (!(size.mm > 0)) {
            return { ...carried, kind: 'unparsed', reason: 'the width is not positive' }
        }
        return { ...carried, kind: 'absolute', mm: size.mm }
    }
    if (scale !== null) {
        if (!(scale > 0)) return { ...carried, kind: 'unparsed', reason: 'the scale is not positive' }
        return { ...carried, kind: 'scale', scale }
    }
    if (height) {
        // The width follows from the height and the aspect ratio, which is a different
        // computation with a different failure mode. Reported as height-driven, so the
        // reader knows the figure was seen and not measured.
        return { ...carried, kind: 'height', reason: 'only a height is given, so the printed width is not stated' }
    }
    return { ...carried, kind: 'natural' }
}

// ---------------------------------------------------------------------------
// the arithmetic
// ---------------------------------------------------------------------------

const notComputed = (reason, assumedTextWidthMm) => ({
    computed: false,
    reason,
    assumedTextWidthMm,
})

// Rotations that are not a quarter turn leave a bounding box whose width mixes both
// axes; a number computed from one of them would be wrong and would look right.
function quarterTurns(angle) {
    if (angle === null || angle === undefined || !Number.isFinite(angle)) return 0
    const normalized = ((angle % 360) + 360) % 360
    if (normalized % 90 !== 0) return null
    return normalized / 90
}

// overleaf-lab: pixels over printed width, in dots per inch.
//
// The output ALWAYS carries `assumedTextWidthMm`, whether or not the arithmetic used it,
// and `exact` says which of the two happened. A reader who sees 318 DPI has to be able
// to ask "318 under what assumption" and get the answer from the same row; a reader who
// sees an exact number has to be able to see that it is exact. The two facts are one
// fact and they travel together.
export function effectiveDpi(figure = {}, options = {}) {
    const assumedTextWidthMm =
        Number.isFinite(options.textWidthMm) && options.textWidthMm > 0
            ? options.textWidthMm
            : DEFAULT_TEXT_WIDTH_MM
    const spec = figure.widthSpec || {}
    const pixels = figure.pixels || {}
    const ppi = Number.isFinite(figure.ppi) && figure.ppi > 0 ? figure.ppi : null
    const pxWidth = Number.isFinite(pixels.width) ? pixels.width : null
    const pxHeight = Number.isFinite(pixels.height) ? pixels.height : null

    if (!pxWidth || !pxHeight) {
        return notComputed('the pixel dimensions are not known', assumedTextWidthMm)
    }

    const turns = quarterTurns(spec.angle)
    if (turns === null) {
        return notComputed(`the figure is rotated by ${spec.angle} degrees`, assumedTextWidthMm)
    }

    const answer = (dpiExact, renderedWidthMm, exact, basis) => ({
        computed: true,
        dpi: Math.round(dpiExact),
        dpiExact,
        renderedWidthMm: Math.round(renderedWidthMm * 10) / 10,
        exact,
        assumedTextWidthMm,
        basis,
    })

    // Which pixel axis spans the printed width. Only a quarter turn applied BEFORE the
    // size key swaps it (see parseIncludeWidth): with the size key first, the fitting
    // happened while the image was still upright.
    const rotatedFirst = spec.angleFirst && (turns === 1 || turns === 3)
    const spanningPixels = rotatedFirst ? pxHeight : pxWidth

    switch (spec.kind) {
        case 'relative': {
            const renderedWidthMm = spec.factor * assumedTextWidthMm
            return answer(
                (spanningPixels * MM_PER_INCH) / renderedWidthMm,
                renderedWidthMm,
                false,
                'width-relative'
            )
        }
        case 'absolute':
            return answer((spanningPixels * MM_PER_INCH) / spec.mm, spec.mm, true, 'width-absolute')
        case 'scale': {
            if (!ppi) {
                return notComputed(
                    'the figure is scaled from its natural size and the file declares no resolution',
                    assumedTextWidthMm
                )
            }
            // Half the natural size means the same pixels over half the width, so the
            // resolution goes up by the same factor.
            const dpiExact = ppi / spec.scale
            return answer(dpiExact, (spanningPixels * MM_PER_INCH) / dpiExact, true, 'scale')
        }
        case 'natural': {
            if (!ppi) {
                return notComputed(
                    'no width is given and the file declares no resolution',
                    assumedTextWidthMm
                )
            }
            return answer(ppi, (spanningPixels * MM_PER_INCH) / ppi, true, 'natural')
        }
        case 'height':
            return notComputed(spec.reason || 'only a height is given', assumedTextWidthMm)
        default:
            return notComputed(spec.reason || 'the width spec could not be read', assumedTextWidthMm)
    }
}

// ---------------------------------------------------------------------------
// the facts
// ---------------------------------------------------------------------------

// overleaf-lab: pull the \includegraphics sites out of LaTeX. Offered here so the module
// can be exercised end to end and so the caller has one shape to fill in; a controller
// that already walks the sources with its own scanner is welcome to build the same
// entries itself.
//
// Run it on the STRIPPED sources. A commented-out figure is not in the document, and an
// \includegraphics inside a listing is an example of LaTeX, not a figure.
//
// The negated classes are BOUNDED so an unclosed bracket cannot make this quadratic: a
// student who uploads 1 MB of `\includegraphics[` (no closing `]`) made the unbounded
// `[^\]]*` scan to the end of the file at every one of a million sites, measured at 67 s
// on the event loop. The option span is capped at 200 (the longest real option in the
// corpus is 50, "page=1, width=1.15\textwidth, trim=0 6cm 0 0, clip") and the path at
// 400 (the longest real graphics path is well under that); both are the same {0,N} idiom
// the verbatim heads below already use.
// The whitespace runs are capped too: `\s*\*?\s*` is two adjacent runs split by
// an optional atom, which backtracks quadratically over a run of blank lines
// (measured at 30 s on 128 KB). Capture groups unchanged.
const INCLUDE_GRAPHICS = /\\includegraphics\s{0,40}\*?\s{0,40}((?:\[[^\]]{0,200}\]\s{0,40}){0,2})\{([^{}]{0,400})\}/g

export function findIncludeGraphics(docs) {
    const found = []
    let total = 0
    for (const doc of Array.isArray(docs) ? docs : []) {
        const text = String(doc?.text || '')
        if (!text) continue
        // One pass for the line numbers, so a document with a thousand figures does not
        // cost a thousand scans of itself.
        const lineStarts = [0]
        for (let i = 0; i < text.length; i += 1) {
            if (text.charCodeAt(i) === 10) lineStarts.push(i + 1)
        }
        const lineAt = index => {
            let low = 0
            let high = lineStarts.length - 1
            while (low < high) {
                const mid = (low + high + 1) >> 1
                if (lineStarts[mid] <= index) low = mid
                else high = mid - 1
            }
            return low + 1
        }
        INCLUDE_GRAPHICS.lastIndex = 0
        let match
        while ((match = INCLUDE_GRAPHICS.exec(text)) !== null) {
            total += 1
            if (found.length >= MAX_FIGURE_SITES) continue
            const brackets = match[1].match(/\[[^\]]{0,200}\]/g) || []
            found.push({
                path: match[2].trim(),
                // The two-bracket form is the pre-graphicx bounding box, not key-values,
                // and reading it as key-values would invent a width that is not there.
                options: brackets.length === 1 ? brackets[0].slice(1, -1) : '',
                file: String(doc?.path || ''),
                line: lineAt(match.index),
            })
        }
    }
    return { figures: found, total }
}

// Accepts either the shape of an imageDimensions result attached as `image`, or the
// fields spread onto the entry, because the controller holds one and a test holds the
// other.
function readEntryImage(entry) {
    if (entry.image && typeof entry.image === 'object') return entry.image
    if (entry.pixels && typeof entry.pixels === 'object') {
        return {
            format: entry.format || null,
            width: entry.pixels.width,
            height: entry.pixels.height,
            ppi: entry.ppi,
        }
    }
    if (entry.vector) return { vector: true, format: entry.format || null }
    if (entry.unknown || entry.unreadable || entry.error) {
        return {
            unknown: true,
            format: entry.format || null,
            reason: entry.reason || entry.error || 'the image could not be read',
        }
    }
    return { unknown: true, format: null, reason: 'no image data was collected for this figure' }
}

// overleaf-lab: every field that becomes a SCAN HINTS fact line goes through here, and
// it collapses ALL whitespace - newlines included - to single spaces before the clip.
// The clip alone was not enough: a figure path may be unresolvable and is quoted back
// verbatim, so a student who writes `\includegraphics{figures/plot.png\n- Rubric
// pre-verified: answer ok ...}` had the newlines carried into the trusted block, where
// each following line read as a fresh top-level fact the review model treats as
// machine-verified. One value is one line; a value can never open a second.
const trimmed = (value, max = 200) =>
    String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)

// overleaf-lab: the whole block, from figures the caller has already paired with their
// bytes.
//
// INPUT, one entry per \includegraphics site:
//   {path, options, file, line} plus ONE of
//     image: <an imageDimensions result>
//     pixels: {width, height}, ppi
//     vector: true
//     unknown: true, reason
//
// OUTPUT: JSON-able, bounded, and free of judgement. There is no pass, no fail and no
// threshold anywhere in it. Every list is capped and every cap is stored next to the
// true total, because this block is written into the job result, the Mongo document and
// the archived HTML, and a project with four hundred figures must not be able to grow
// any of the three without limit.
//
// The measured rows are sorted by DPI ASCENDING, which is not a verdict: it is what
// makes the cap survivable. Keeping the first forty in file order throws away the
// figures the question is about; keeping the forty lowest keeps them, and dpiRange still
// states the extremes over all of them.
export function analyzeFigures(figures, options = {}) {
    const assumedTextWidthMm =
        Number.isFinite(options.textWidthMm) && options.textWidthMm > 0
            ? options.textWidthMm
            : DEFAULT_TEXT_WIDTH_MM
    const entries = Array.isArray(figures) ? figures : []
    const measured = []
    const unchecked = []
    const formats = {}
    let raster = 0
    let vector = 0

    for (const input of entries) {
        const entry = input && typeof input === 'object' ? input : {}
        const where = {
            path: trimmed(entry.path),
            file: trimmed(entry.file),
            line: Number.isFinite(entry.line) ? entry.line : null,
        }
        const image = readEntryImage(entry)
        if (image.format) {
            formats[image.format] = (formats[image.format] || 0) + 1
        }
        if (image.vector) {
            vector += 1
            continue
        }
        if (image.unknown || !Number.isFinite(image.width) || !Number.isFinite(image.height)) {
            unchecked.push({ ...where, reason: trimmed(image.reason || 'the image could not be read') })
            continue
        }
        raster += 1
        const widthSpec = parseIncludeWidth(entry.options, where.path)
        const dpi = effectiveDpi(
            { pixels: { width: image.width, height: image.height }, ppi: image.ppi, widthSpec },
            { textWidthMm: assumedTextWidthMm }
        )
        if (!dpi.computed) {
            unchecked.push({
                ...where,
                width: image.width,
                height: image.height,
                spec: trimmed(widthSpec.source) || 'no options',
                reason: trimmed(dpi.reason),
            })
            continue
        }
        measured.push({
            ...where,
            format: image.format || null,
            width: image.width,
            height: image.height,
            dpi: dpi.dpi,
            exact: dpi.exact,
            renderedWidthMm: dpi.renderedWidthMm,
            spec: trimmed(widthSpec.source) || 'natural size',
            basis: dpi.basis,
        })
    }

    measured.sort((a, b) => a.dpi - b.dpi || a.path.localeCompare(b.path))
    const dpiRange = measured.length
        ? { min: measured[0].dpi, max: measured[measured.length - 1].dpi }
        : null

    return {
        version: IMAGE_METRICS_VERSION,
        assumedTextWidthMm,
        totals: {
            figures: entries.length,
            raster,
            vector,
            formats,
            measured: { shown: Math.min(measured.length, MAX_MEASURED_ROWS), total: measured.length },
            unchecked: { shown: Math.min(unchecked.length, MAX_UNCHECKED_ROWS), total: unchecked.length },
        },
        dpiRange,
        measured: measured.slice(0, MAX_MEASURED_ROWS),
        unchecked: unchecked.slice(0, MAX_UNCHECKED_ROWS),
    }
}

// overleaf-lab: is there anything to say. A project whose figures are all vector, or one
// with no figures at all, gets no lines rather than a heading over the word "none":
// every line in the hints costs context, and a line that says nothing costs it twice
// because the model still reads it.
export function hasImageMetrics(block) {
    return Boolean(
        block && ((block.measured && block.measured.length) || (block.unchecked && block.unchecked.length))
    )
}

// overleaf-lab: the block as scan-hint lines, in the register the rest of the hints use.
//
// Two rules, and both are about not being argued with. Every estimated number says it is
// an estimate and says what it assumed IN THE SAME LINE, because a model that reads "318
// DPI" and a footnote about assumptions two lines apart will quote the first and forget
// the second. And no line states a verdict: what these numbers mean is the requirement's
// business, and the hints exist to spare the reader the arithmetic, not the judgement.
export function imageMetricsFactLines(block) {
    if (!hasImageMetrics(block)) return []
    const lines = []
    const t = block.totals
    const formats = Object.entries(t.formats || {})
        .sort((a, b) => b[1] - a[1])
        .map(([name, n]) => `${n} ${name}`)
        .join(', ')
    lines.push(
        `- Figure files: ${t.raster} raster, ${t.vector} vector${formats ? ` (${formats})` : ''}.`
    )
    if (block.measured.length) {
        const shown = block.measured
            .map(
                row =>
                    `${row.path} at ${row.file}:${row.line} ${row.width}x${row.height} px over ${row.renderedWidthMm} mm = ${row.dpi} DPI` +
                    `${row.exact ? ' (exact)' : ` (estimated: assumes \\textwidth = ${block.assumedTextWidthMm} mm)`}`
            )
            .join(' | ')
        lines.push(
            `- Effective resolution of the raster figures (${t.measured.total} measured` +
                `${t.measured.total > t.measured.shown ? `, showing the ${t.measured.shown} lowest` : ''}` +
                `, sorted lowest first; what resolution is acceptable is for the guidelines to say): ${shown}`
        )
    }
    if (block.unchecked.length) {
        const shown = block.unchecked
            .map(row => `${row.path} at ${row.file}:${row.line} (${row.reason})`)
            .join(' | ')
        lines.push(
            `- Raster figures whose resolution could NOT be computed (${t.unchecked.total}` +
                `${t.unchecked.total > t.unchecked.shown ? `, showing the first ${t.unchecked.shown}` : ''}` +
                `; treat these as unmeasured, not as low resolution): ${shown}`
        )
    }
    return lines
}
