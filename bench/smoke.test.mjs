#!/usr/bin/env node
// ===========================================================================
// OFFLINE PROOF THAT THE BENCH WORKS.
// ===========================================================================
//
//   node bench/smoke.test.mjs
//
// It loads the real controller through bench/load.mjs, runs a full review over a
// tiny synthetic two-file project against a SCRIPTED fetch stub, and checks the
// things that would make a bench run a lie:
//
//   - every requirement of the rubric comes back with a verdict
//   - not one byte left the machine (the global fetch is replaced by a sentinel
//     that throws, and the counter behind it stays at zero)
//   - every /chat/completions body carried chat_template_kwargs.enable_thinking
//     === false, which is what a bare llama.cpp endpoint needs and what this
//     controller deliberately leaves to the router
//   - the whole thing finishes in well under a minute
//
// No model, no LanguageTool, no Crossref, no Mongo. If this fails, the bench is
// measuring something other than the shipped review.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { loadController } from './load.mjs'
import { readProject } from './project.mjs'
import { makeScriptedBackend } from './scripted-backend.mjs'

const TIME_BUDGET_MS = 60 * 1000

let failures = 0
function check(name, condition, detail) {
    if (!condition) failures += 1
    console.log(`[${condition ? 'PASS' : 'FAIL'}] ${name}${detail ? `  ${detail}` : ''}`)
}

// ---------------------------------------------------------------------------
// the synthetic project
// ---------------------------------------------------------------------------

const FIGURE_LINE = '\\includegraphics[width=0.6\\textwidth]{Immagini/schema.png}'

const MAIN_TEX = `\\documentclass[12pt]{report}
\\usepackage{graphicx}

\\begin{document}
\\input{capitolo}
\\end{document}
`

const CHAPTER_TEX = `\\chapter{Introduzione}
Il presente elaborato descrive l'attivita' di tirocinio svolta presso il laboratorio.
Si definisce il rapporto fra le due masse come grandezza caratteristica del sistema.
La misura della lunghezza focale vale 5.5\\,mm e resta costante durante la prova.

\\begin{figure}[h]
    \\centering
    ${FIGURE_LINE}
\\end{figure}

\\chapter{Conclusioni}
I risultati ottenuti confermano il modello adottato entro il 4\\% previsto.
`

const RUBRIC = `Relazione finale di tirocinio curricolare, redatta in italiano. Stai esaminando i sorgenti LaTeX del progetto.
1. La relazione e' redatta in terza persona: nessun pronome o verbo di prima persona.
2. Ogni figura ha una didascalia che ne descrive il contenuto.
3. Le unita' di misura sono separate dal valore con uno spazio fine.
`

// The smallest PNG a header reader will accept: signature, a well formed IHDR
// declaring 800x600, and IEND. The figure metrics only read the header, and a
// real figure here is what exercises the bench file store (bytes served from
// disk, never from a socket).
function tinyPng(width, height) {
    const crc = buffer =>
        typeof zlib.crc32 === 'function'
            ? zlib.crc32(buffer)
            : // Fallback for a Node without zlib.crc32.
              (() => {
                  let value = 0xffffffff
                  for (const byte of buffer) {
                      value ^= byte
                      for (let bit = 0; bit < 8; bit += 1) {
                          value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
                      }
                  }
                  return (value ^ 0xffffffff) >>> 0
              })()
    const chunk = (type, data) => {
        const head = Buffer.alloc(4)
        head.writeUInt32BE(data.length, 0)
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
        const tail = Buffer.alloc(4)
        tail.writeUInt32BE(crc(body), 0)
        return Buffer.concat([head, body, tail])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 2 // truecolour
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IEND', Buffer.alloc(0)),
    ])
}

function writeSyntheticProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-bench-smoke-'))
    fs.writeFileSync(path.join(root, 'main.tex'), MAIN_TEX, 'utf8')
    fs.writeFileSync(path.join(root, 'capitolo.tex'), CHAPTER_TEX, 'utf8')
    fs.mkdirSync(path.join(root, 'Immagini'))
    fs.writeFileSync(path.join(root, 'Immagini', 'schema.png'), tinyPng(800, 600))
    return root
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

const MODEL = 'bench-scripted-model'
const root = writeSyntheticProject()
const project = readProject(root)
check('the synthetic project reads as two docs and one figure', project.docs.length === 2 && project.files.length === 1, `${project.docs.map(d => d.path).join(' ')} | ${project.files.map(f => f.path).join(' ')}`)

// One requirement comes back as a violation, with a quote the document really
// contains, so the grounding check and the double-check pass are exercised
// rather than skipped.
const { fetchImpl, seen } = makeScriptedBackend(MODEL, (schemaName, body) => {
    const question = body.messages?.[1]?.content || ''
    if (schemaName !== 'compliance_review' || !/didascalia/.test(question)) {
        return null
    }
    return {
        items: [
            {
                analysis: 'Ho esaminato tutti gli ambienti figure del documento.',
                requirement: 'ogni figura ha una didascalia',
                evidence: `/capitolo.tex: "${FIGURE_LINE}" senza \\caption.`,
                status: 'missing',
                suggestion: 'Aggiungere una \\caption alla figura.',
            },
        ],
    }
})

// THE CANARY. Any call that escapes the stub reaches this and is counted, and it
// throws so the failure is loud rather than a slow test.
const realFetch = globalThis.fetch
let escapedCalls = 0
globalThis.fetch = (...args) => {
    escapedCalls += 1
    throw new Error(`the smoke test tried to reach the network: ${args[0]}`)
}

const rubric = {
    id: 'smoke',
    name: 'smoke rubric',
    guidelines: RUBRIC,
    scanPatterns: '',
}

const progress = []
const controller = await loadController({
    docs: project.docs,
    files: project.files,
    rubrics: [rubric],
    endpoints: [{ id: 'smoke', label: 'smoke', url: 'http://scripted.invalid/v1', model: MODEL }],
    fetch: fetchImpl,
    logLevel: 'silent',
    onProgress: entry => progress.push({ ...entry }),
})

check(
    'the controller still leaves chat_template_kwargs to the router',
    controller.controllerSendsChatTemplateKwargs === false && controller.injectChatTemplateKwargs === true,
    'the day it sends the field itself, the bench wrapper must stop adding it'
)
check(
    'the safe siblings are loaded for real, not stubbed',
    controller.transform.loadedForReal.length >= 5,
    controller.transform.loadedForReal.join(' ')
)
check(
    'only the container-only imports are stubbed',
    controller.transform.stubbed.every(
        spec => /^@overleaf\//.test(spec) || /app\/src\//.test(spec) || /LLM(Admin|ComplianceStore|ComplianceMailer)/.test(spec)
    ),
    controller.transform.stubbed.join(' ')
)

// confirmed:false on purpose, so the document type gate runs too.
const job = controller.makeJob({ rubricId: rubric.id, rubricName: rubric.name, confirmed: false })
const started = Date.now()
const outcome = await controller.performReview(job)
const elapsed = Date.now() - started

globalThis.fetch = realFetch

// ---------------------------------------------------------------------------
// what has to be true
// ---------------------------------------------------------------------------

check('the review completed', outcome.type === 'done', outcome.type === 'done' ? '' : `${outcome.errorCode}: ${outcome.message}`)

const items = (outcome.result && outcome.result.items) || []
const requirements = controller.module.splitRubric
    ? controller.module.splitRubric(RUBRIC).requirements
    : []
check('the rubric split into three requirements', requirements.length === 3, `got ${requirements.length}`)

const withoutVerdict = requirements.filter(
    requirement => !items.some(item => item.requirement === requirement)
)
check(
    'every requirement came back with a verdict',
    requirements.length > 0 && withoutVerdict.length === 0,
    withoutVerdict.length ? `missing: ${withoutVerdict.map(r => r.slice(0, 40)).join(' | ')}` : `${items.length} items`
)
check(
    'every verdict is one of the four the schema allows',
    items.length > 0 && items.every(item => ['ok', 'partial', 'missing', 'na'].includes(item.status)),
    items.map(item => item.status).join(' ')
)
check(
    'no item is an n.a. from a model that never answered',
    items.every(item => !item.modelFailure),
    items.filter(item => item.modelFailure).map(item => item.evidence).join(' | ')
)
check(
    'the grounded violation survived the double-check',
    items.some(item => item.status === 'missing' && /includegraphics/.test(item.evidence || '')),
    items.map(item => `${item.status}`).join(' ')
)

check('not one call escaped to the real network', escapedCalls === 0, `${escapedCalls} escaped`)
check(
    'the scripted backend was actually used',
    seen.chatBodies.length >= 4,
    `${seen.chatBodies.length} chat calls, ${seen.urls.length} calls in total`
)

const chatCalls = controller.fetchLog.filter(call => call.kind === 'chat')
const withoutFlag = seen.chatBodies.filter(
    body => !body.chat_template_kwargs || body.chat_template_kwargs.enable_thinking !== false
)
check(
    'every /chat/completions body carried chat_template_kwargs.enable_thinking === false',
    seen.chatBodies.length > 0 && withoutFlag.length === 0,
    `${seen.chatBodies.length - withoutFlag.length}/${seen.chatBodies.length}`
)
check(
    'the bench fetch log saw the same calls',
    chatCalls.length === seen.chatBodies.length,
    `${chatCalls.length} logged, ${seen.chatBodies.length} received`
)
check(
    'the JSON schema probe, the type check and the summary all ran',
    ['json_mode_probe', 'document_type', 'compliance_summary'].every(name =>
        chatCalls.some(call => call.schema === name)
    ),
    [...new Set(chatCalls.map(call => call.schema))].join(' ')
)
const measuredFigure = outcome.result?.imageMetrics?.measured?.[0] || null
check(
    'the figure bytes were served from disk and measured, not fetched over a socket',
    controller.fetchLog.some(call => call.kind === 'filestore' && call.ok) &&
        measuredFigure &&
        measuredFigure.width === 800 &&
        measuredFigure.height === 600,
    measuredFigure
        ? `${measuredFigure.path} ${measuredFigure.width}x${measuredFigure.height} at ${measuredFigure.dpi} DPI`
        : JSON.stringify(outcome.result?.imageMetrics?.unchecked || null).slice(0, 160)
)
check(
    '/tokenize is absent and the review carried on with the estimate',
    controller.fetchLog.some(call => call.kind === 'tokenize' && call.status === 404) &&
        job.documentTokensEstimate > 0,
    `estimate ${job.documentTokensEstimate} tokens`
)
check('progress was reported pass by pass', progress.length >= 3, `${progress.length} updates`)
check(
    'the store and the mailer were called but did nothing',
    controller.store.__calls.length > 0 && controller.mailer.__calls.length === 0,
    `${controller.store.__calls.length} store calls`
)
check(`the whole review took under a minute`, elapsed < TIME_BUDGET_MS, `${(elapsed / 1000).toFixed(1)} s`)

controller.dispose()
fs.rmSync(root, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? 'smoke: ALL PASS' : `smoke: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
