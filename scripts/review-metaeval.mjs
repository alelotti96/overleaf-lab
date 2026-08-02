#!/usr/bin/env node
//=============================================================================
// REVIEW META-EVAL: measure a compliance review instead of eyeballing it
//=============================================================================
// The compliance reviewer is judged today by reading its reports, which cannot
// answer the questions that decide anything: does model A actually find more than
// model B, does a prompt change help, how often does a clean document get flagged?
//
// This harness answers them by MUTATION TESTING. It takes a document you consider
// clean (your gold), injects violations defined in a mutation file, runs the review
// on each mutant, and reports how many injected faults were detected (recall) and
// how many findings the clean run produced (false-positive baseline). Because the
// reviewer runs at temperature 0, the numbers are reproducible.
//
// NOTHING here is specific to a language, an institution or a document type: the
// mutations live in YOUR config file, the gold document stays on YOUR disk. See
// scripts/review-mutations.example.json for the format.
//
// Usage:
//   node scripts/review-metaeval.mjs --gold <dir> --mutations <file.json> \
//        --api <http://host:port/v1> --model <model-id> --rubric <file.txt> \
//        [--out <report.json>] [--keep]
//
//   --gold       directory with the LaTeX sources (recursed; .tex and .bib used)
//   --mutations  JSON file describing the faults to inject (see the example)
//   --api        OpenAI-compatible base URL (llama-server or the router)
//   --model      model id to review with
//   --rubric     text file with the rubric guidelines (one requirement per line)
//   --out        write the full JSON result here (default: metaeval-result.json)
//   --keep       keep the generated mutant directories for inspection
//   --dry-run    only report which mutations apply to the gold document, and where,
//                without calling the model (use it while writing the mutation file)
//
// Exit code is 0 when every mutation was detected, 1 otherwise, so it can gate a
// change: run it before and after touching the prompt, the model or the pipeline.
//=============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

//-----------------------------------------------------------------------------
// Arguments
//-----------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {}
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i]
        if (!key.startsWith('--')) continue
        const name = key.slice(2)
        const next = argv[i + 1]
        if (next === undefined || next.startsWith('--')) {
            args[name] = true
        } else {
            args[name] = next
            i++
        }
    }
    return args
}

const args = parseArgs(process.argv)
const DRY_RUN = Boolean(args['dry-run'])
// A dry run never calls the model, so it only needs the document and the mutations.
const REQUIRED = DRY_RUN
    ? ['gold', 'mutations']
    : ['gold', 'mutations', 'api', 'model', 'rubric']
for (const required of REQUIRED) {
    if (!args[required]) {
        console.error(`Missing --${required}. See the header of this file for usage.`)
        process.exit(2)
    }
}
const OUT = args.out || 'metaeval-result.json'

//-----------------------------------------------------------------------------
// Load the gold document
//-----------------------------------------------------------------------------
function loadDocs(root) {
    const docs = []
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(full)
            else if (/\.(tex|bib)$/i.test(entry.name)) {
                const text = fs.readFileSync(full, 'utf8')
                if (text.trim()) {
                    docs.push({
                        path: '/' + path.relative(root, full).split(path.sep).join('/'),
                        text,
                    })
                }
            }
        }
    }
    walk(root)
    docs.sort((a, b) => a.path.localeCompare(b.path))
    return docs
}

const goldDocs = loadDocs(args.gold)
if (goldDocs.length === 0) {
    console.error(`No .tex/.bib files found under ${args.gold}`)
    process.exit(2)
}
const rubric = args.rubric ? fs.readFileSync(args.rubric, 'utf8') : ''

//-----------------------------------------------------------------------------
// Mutations
//-----------------------------------------------------------------------------
// A mutation is { id, class, description, file?, find, replace, expect, only? } where
// `find` is a regex (first match is replaced unless `all` is true) and `expect` is
// a list of lowercase substrings; a review DETECTS the mutation when a non-ok item
// mentions any of them. Keeping detection substring-based (rather than requirement
// indexes) keeps the harness independent of how the rubric is numbered.
//
// `only` optionally narrows a mutant's run to some requirements, as 1-based indexes
// into the rubric (`"only": [5, 7]`). It exists because the default is expensive and
// mostly wasted: a removed caption is looked for by every requirement about units,
// citations and structure too, and on a 30-requirement rubric that is 30 model calls
// to answer one question. Targeting cuts a run by an order of magnitude and makes
// "tweak the rubric, measure again" a minute instead of an hour.
//
// Know what you give up. A targeted run measures whether THAT requirement catches
// the fault; the full run also measures whether some OTHER requirement catches it
// (which is how the unit errors were found landing under the spelling requirement)
// and what a mutant does to the rest of the report. Target while iterating, run
// everything before drawing a conclusion. The baseline always runs in full, since
// its whole job is to count false positives across the rubric.
const mutations = JSON.parse(fs.readFileSync(args.mutations, 'utf8'))
if (!Array.isArray(mutations) || mutations.length === 0) {
    console.error('The mutations file must contain a non-empty JSON array')
    process.exit(2)
}

// By default a mutation injects exactly ONE fault, in the first file that matches:
// a single defect hidden somewhere in a long document is both the realistic case and
// the hard one (it is what "lost in the middle" costs you). `all: true` injects the
// fault everywhere instead, which measures a different, much easier thing.
function applyMutation(docs, mutation) {
    const out = []
    let applied = 0
    for (const doc of docs) {
        const skip =
            (mutation.file && doc.path !== mutation.file) ||
            (applied > 0 && !mutation.all)
        if (skip) {
            out.push(doc)
            continue
        }
        const re = new RegExp(mutation.find, mutation.all ? 'gm' : 'm')
        if (!re.test(doc.text)) {
            out.push(doc)
            continue
        }
        out.push({
            path: doc.path,
            text: doc.text.replace(re, mutation.replace ?? ''),
        })
        applied += 1
    }
    return { docs: out, applied }
}

//-----------------------------------------------------------------------------
// Review driver
//-----------------------------------------------------------------------------
// The harness talks to the model directly with the SAME contract as the module
// (document first, one requirement per pass, analysis-first strict JSON schema at
// temperature 0). It deliberately does not import the module: this measures the
// prompt-and-model contract, which is what the mutations are about, and it runs
// outside a container against any OpenAI-compatible endpoint.
const ITEM_SCHEMA = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    analysis: { type: 'string' },
                    requirement: { type: 'string' },
                    status: { type: 'string', enum: ['ok', 'partial', 'missing', 'na'] },
                    evidence: { type: 'string' },
                    suggestion: { type: 'string' },
                },
                required: ['analysis', 'requirement', 'status', 'evidence', 'suggestion'],
                additionalProperties: false,
            },
        },
    },
    required: ['items'],
    additionalProperties: false,
}

const SYSTEM_PROMPT = `You are a meticulous reviewer that checks whether a LaTeX document complies with writing guidelines.
Be strict and skeptical: "ok" means you verified the requirement, not that you found related-looking text.
Use the "analysis" field as your worksheet BEFORE judging. Quote verbatim from the document with its file path; never cite line or equation numbers.
Return ONLY a JSON object shaped {"items":[{"analysis":"...","requirement":"...","status":"ok|partial|missing|na","evidence":"...","suggestion":"..."}]}.`

function splitRequirements(text) {
    const lines = String(text).split('\n')
    const requirements = []
    let current = null
    for (const raw of lines) {
        const line = raw.trim()
        if (!line) continue
        if (/^(\d+[.)]|[-*])\s+/.test(line)) {
            if (current) requirements.push(current)
            current = line
        } else if (current) {
            current += ' ' + line
        }
    }
    if (current) requirements.push(current)
    return requirements.length ? requirements : [String(text).trim()]
}

async function reviewOnce(docs, label, only) {
    const assembled = docs
        .map(d => `% ===== FILE: ${d.path} =====\n${d.text}`)
        .join('\n\n')
    const all = splitRequirements(rubric)
    const requirements =
        Array.isArray(only) && only.length > 0
            ? only
                  .map(n => all[n - 1])
                  .filter(Boolean)
            : all
    const items = []
    for (const [index, requirement] of requirements.entries()) {
        process.stdout.write(`\r  ${label}: pass ${index + 1}/${requirements.length}   `)
        const body = {
            model: args.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: `DOCUMENT:\n${assembled}\n\nGUIDELINES (check ONLY these):\n${requirement}`,
                },
            ],
            temperature: 0,
            max_tokens: 4000,
            response_format: {
                type: 'json_schema',
                json_schema: { name: 'review', strict: true, schema: ITEM_SCHEMA },
            },
        }
        try {
            const response = await fetch(`${args.api}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (!response.ok) {
                items.push({ requirement, status: 'na', evidence: `HTTP ${response.status}` })
                continue
            }
            const data = await response.json()
            const content = (data?.choices?.[0]?.message?.content || '').replace(
                /<think>[\s\S]*?<\/think>/gi,
                ''
            )
            const first = content.indexOf('{')
            const last = content.lastIndexOf('}')
            const parsed = JSON.parse(content.slice(first, last + 1))
            // Fold a pass's items into at most one per status, exactly as the module
            // does before it builds a report. Without this the harness counts three
            // items where the feature shows one, and its numbers stop being
            // comparable with the reports they are supposed to explain.
            const byStatus = new Map()
            for (const item of parsed.items || []) {
                const status = ['ok', 'partial', 'missing', 'na'].includes(item.status)
                    ? item.status
                    : 'na'
                const existing = byStatus.get(status)
                if (!existing) {
                    byStatus.set(status, {
                        requirement,
                        status,
                        evidence: String(item.evidence || ''),
                        suggestion: String(item.suggestion || ''),
                    })
                    continue
                }
                const evidence = String(item.evidence || '')
                if (evidence && !existing.evidence.includes(evidence)) {
                    existing.evidence += ` | ${evidence}`
                }
            }
            items.push(...byStatus.values())
        } catch (err) {
            items.push({ requirement, status: 'na', evidence: `error: ${err.message}` })
        }
    }
    process.stdout.write('\r' + ' '.repeat(60) + '\r')
    return items
}

// A mutation counts as detected when a NON-ok item mentions one of its expected
// markers anywhere in requirement/evidence/suggestion.
function detects(items, mutation) {
    const needles = (mutation.expect || []).map(s => s.toLowerCase())
    if (needles.length === 0) return false
    for (const item of items) {
        if (item.status === 'ok' || item.status === 'na') continue
        const hay = `${item.requirement} ${item.evidence} ${item.suggestion}`.toLowerCase()
        if (needles.some(n => hay.includes(n))) return true
    }
    return false
}

//-----------------------------------------------------------------------------
// Run
//-----------------------------------------------------------------------------
const started = Date.now()
console.log(`gold: ${goldDocs.length} files from ${args.gold}`)
console.log(`mutations: ${mutations.length} from ${args.mutations}`)

// A dry run answers the only question worth asking before spending model time: does
// each mutation actually change the gold document, and where?
if (DRY_RUN) {
    let unusable = 0
    for (const mutation of mutations) {
        const { docs, applied } = applyMutation(goldDocs, mutation)
        const changed = docs.filter(
            (d, i) => d.text !== goldDocs[i].text
        )
        if (applied === 0) {
            unusable += 1
            console.log(`  SKIP  ${mutation.id.padEnd(24)} pattern not found in the gold document`)
            continue
        }
        const delta = changed
            .map(d => `${d.path} (${d.text.length - goldDocs.find(g => g.path === d.path).text.length >= 0 ? '+' : ''}${d.text.length - goldDocs.find(g => g.path === d.path).text.length} chars)`)
            .join(', ')
        console.log(`  OK    ${mutation.id.padEnd(24)} ${delta}`)
        if (!Array.isArray(mutation.expect) || mutation.expect.length === 0) {
            console.log(`        WARNING: no "expect" markers, this mutation can never be detected`)
            unusable += 1
        }
    }
    console.log(
        `\n${mutations.length - unusable}/${mutations.length} mutations are usable on this document.`
    )
    process.exit(unusable === 0 ? 0 : 1)
}

console.log(`model: ${args.model} at ${args.api}\n`)

console.log('baseline (clean document)...')
const baselineItems = await reviewOnce(goldDocs, 'baseline')
const baselineNegatives = baselineItems.filter(
    i => i.status === 'missing' || i.status === 'partial'
)
console.log(
    `  baseline: ${baselineNegatives.length} non-ok of ${baselineItems.length} requirements` +
        ' (these are either real defects of the gold document or false positives)'
)
for (const item of baselineNegatives) {
    console.log(`    [${item.status}] ${String(item.requirement).slice(0, 90)}`)
}

const results = []
for (const [index, mutation] of mutations.entries()) {
    const { docs, applied } = applyMutation(goldDocs, mutation)
    if (applied === 0) {
        console.log(
            `\n${index + 1}/${mutations.length} ${mutation.id}: SKIPPED (pattern not found in the gold document)`
        )
        results.push({ ...mutation, applied: 0, detected: null })
        continue
    }
    const targeted = Array.isArray(mutation.only) && mutation.only.length > 0
    console.log(
        `\n${index + 1}/${mutations.length} ${mutation.id} [${mutation.class}]${
            targeted ? ` (only requirements ${mutation.only.join(', ')})` : ''
        }`
    )
    const items = await reviewOnce(docs, mutation.id, mutation.only)
    const detected = detects(items, mutation)
    const negatives = items.filter(i => i.status === 'missing' || i.status === 'partial')
    console.log(
        `  ${detected ? 'DETECTED' : 'MISSED  '}  (${negatives.length} non-ok items in this run)`
    )
    results.push({
        id: mutation.id,
        class: mutation.class,
        description: mutation.description,
        applied,
        detected,
        targeted,
        negatives: negatives.length,
        items,
    })

    if (args.keep) {
        const dir = path.join(os.tmpdir(), `metaeval-${mutation.id}`)
        for (const doc of docs) {
            const target = path.join(dir, doc.path)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, doc.text)
        }
        console.log(`  mutant kept at ${dir}`)
    }
}

//-----------------------------------------------------------------------------
// Report
//-----------------------------------------------------------------------------
const evaluated = results.filter(r => r.detected !== null)
const byClass = new Map()
for (const r of evaluated) {
    const entry = byClass.get(r.class) || { total: 0, detected: 0 }
    entry.total += 1
    if (r.detected) entry.detected += 1
    byClass.set(r.class, entry)
}

console.log('\n' + '='.repeat(70))
console.log('RECALL BY CLASS')
for (const [cls, entry] of [...byClass].sort()) {
    const rate = entry.detected / entry.total
    console.log(
        `  ${cls.padEnd(28)} ${entry.detected}/${entry.total}  ${(rate * 100).toFixed(0)}%`
    )
}
const detectedTotal = evaluated.filter(r => r.detected).length
console.log(
    `  ${'OVERALL'.padEnd(28)} ${detectedTotal}/${evaluated.length}  ${(
        (detectedTotal / Math.max(evaluated.length, 1)) *
        100
    ).toFixed(0)}%`
)
console.log(`  baseline non-ok on the clean document: ${baselineNegatives.length}`)
const targetedCount = evaluated.filter(r => r.targeted).length
if (targetedCount > 0) {
    console.log(
        `  NOTE: ${targetedCount} mutation(s) ran against selected requirements only,` +
            ' so this measures those requirements, not the whole rubric.'
    )
}
const skipped = results.filter(r => r.detected === null)
if (skipped.length) {
    console.log(`  skipped (pattern not in gold): ${skipped.map(r => r.id).join(', ')}`)
}
console.log(`  elapsed: ${Math.round((Date.now() - started) / 1000)}s`)
console.log('='.repeat(70))

const missed = evaluated.filter(r => !r.detected)
if (missed.length) {
    console.log('\nMISSED MUTATIONS (what this configuration cannot see):')
    for (const r of missed) console.log(`  ${r.id} [${r.class}]: ${r.description}`)
}

fs.writeFileSync(
    OUT,
    JSON.stringify(
        {
            model: args.model,
            api: args.api,
            gold: args.gold,
            files: goldDocs.map(d => d.path),
            baseline: { items: baselineItems, negatives: baselineNegatives.length },
            results,
        },
        null,
        2
    )
)
console.log(`\nfull result written to ${OUT}`)
process.exit(missed.length === 0 ? 0 : 1)
