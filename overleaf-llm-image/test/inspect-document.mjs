#!/usr/bin/env node
//===============================================================================
// Print the SCAN HINTS a review would compute for a document, without calling a model.
//===============================================================================
// Usage:
//   node overleaf-llm-image/test/inspect-document.mjs <path-to-project>
//
// Point it at a folder of .tex/.bib files (an Overleaf project downloaded as source)
// and it prints exactly the mechanical facts the model would be given: counts,
// caption-less floats, unreferenced labels by kind, broken references, acronym and
// citation bookkeeping. Useful to check a rubric against a real document, and to see
// whether a finding in a report was a mechanical fact or the model's own judgement.
//
// Unlike the .test.mjs suites this needs a document, so it is not part of the runner.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CTRL =
    process.env.CTRL ||
    path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../vendor/llm/app/src/LLMComplianceController.mjs'
    )

const ROOT = process.argv[2]
if (!ROOT || !fs.existsSync(ROOT)) {
    console.error('Usage: node inspect-document.mjs <path-to-project-folder>')
    console.error('The folder should contain the .tex and .bib sources of a project.')
    process.exit(1)
}

const src = fs.readFileSync(CTRL, 'utf8')
const cut = (from, to) => {
    const a = src.indexOf(from)
    const b = src.indexOf(to)
    if (a === -1 || b === -1 || b <= a) throw new Error(`cannot locate ${from}`)
    return src.slice(a, b)
}
// eslint-disable-next-line no-new-func
const h = new Function(
    'logger',
    `${cut('function stripLatexComments(', '// overleaf-lab: characters per token')}
     ${cut('const FLOAT_ENVIRONMENTS', '// overleaf-lab: split the rubric guidelines')}
     return { stripLatexComments, buildScanHints, buildStructuralFacts, parseScanPatterns }`
)({ debug() {} })

const files = []
;(function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(tex|bib)$/i.test(e.name)) files.push(p)
    }
})(ROOT)

// Mirror the controller's assembly: skip empty docs, strip comments.
const strippedDocs = []
for (const f of files) {
    const text = fs.readFileSync(f, 'utf8')
    if (!text.trim()) continue
    strippedDocs.push({
        path: '/' + path.relative(ROOT, f).replace(/\\/g, '/'),
        text: h.stripLatexComments(text),
    })
}


console.log(`assembled ${strippedDocs.length} non-empty docs\n`)
const hints = h.buildScanHints(strippedDocs, [])
console.log(hints)
console.log()


const stripped = strippedDocs.reduce((n, d) => n + d.text.length, 0)
console.log(
    `
${strippedDocs.length} files, ${stripped} chars after comment stripping ` +
        `(roughly ${Math.ceil(stripped / 3)} tokens by the fallback heuristic; the ` +
        'review asks the backend for an exact count).'
)
