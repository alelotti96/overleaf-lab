#!/usr/bin/env node
// ===========================================================================
// THE BENCH: one real compliance review, outside the container, against a
// backend of your choosing.
// ===========================================================================
//
// Usage:
//   node bench/run.mjs --project <dir> --rubric <file> --endpoint <url> --model <alias>
//                      [--out <file>] [--mode full|fast] [--language-tool <url>]
//                      [--max-context <n>] [--max-tokens <n>] [--typecheck]
//                      [--log debug|info|warn|error|silent]
//
// Example (backslash continuation is bash-only, PowerShell wants one line):
//   node bench/run.mjs --project "tesi-esempio/extracted/<project>" \
//                      --rubric templates/<rubric>.txt \
//                      --endpoint http://<llm-host>:<port>/v1 --model <alias>
//
// It loads the SHIPPED controller through bench/load.mjs and calls its own
// performReview. Nothing about the review loop is reimplemented here: this file
// only assembles the inputs, prints what comes back and times it.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadController } from './load.mjs'
import { readProject, projectSize } from './project.mjs'
import { makeScriptedBackend } from './scripted-backend.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const args = { mode: 'full', log: 'warn', confirmed: true }
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i]
        const next = () => {
            const value = argv[i + 1]
            if (value === undefined || value.startsWith('--')) {
                fail(`${flag} needs a value`)
            }
            i += 1
            return value
        }
        switch (flag) {
            case '--project': args.project = next(); break
            case '--rubric': args.rubric = next(); break
            case '--endpoint': args.endpoint = next(); break
            case '--model': args.model = next(); break
            case '--model-backup': args.modelBackup = next(); break
            case '--out': args.out = next(); break
            case '--mode': args.mode = next(); break
            case '--rubric-name': args.rubricName = next(); break
            case '--scan-patterns': args.scanPatterns = next(); break
            case '--settings': args.settings = next(); break
            case '--language-tool': args.languageTool = next(); break
            case '--bib-mailto': args.bibMailto = next(); break
            case '--max-context': args.maxContext = Number.parseInt(next(), 10); break
            case '--max-tokens': args.maxTokens = Number.parseInt(next(), 10); break
            case '--log': args.log = next(); break
            // Run the document-type gate the panel normally asks the user about.
            case '--typecheck': args.confirmed = false; break
            // Same command line, no backend: every model call is answered from
            // its own JSON schema. For checking the wiring before spending GPU.
            case '--dry-run': args.dryRun = true; break
            case '--help': case '-h': args.help = true; break
            default: fail(`unknown argument ${flag}`)
        }
    }
    return args
}

// The rubric the review runs, from a plain text file or from an exported copy of
// the instance's admin settings. The settings path is the faithful one: it carries
// the scan patterns with the guidelines, and the two belong together.
function resolveRubric(args) {
    if (args.settings) {
        const settingsPath = path.resolve(REPO, args.settings)
        if (!fs.existsSync(settingsPath)) fail(`no settings file at ${settingsPath}`)
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        const rubrics = Array.isArray(settings.complianceRubrics) ? settings.complianceRubrics : []
        if (rubrics.length === 0) fail(`${settingsPath} declares no complianceRubrics`)
        const picked = args.rubricName
            ? rubrics.find(entry => entry.name === args.rubricName || entry.id === args.rubricName)
            : rubrics[0]
        if (!picked) {
            fail(
                `no rubric named ${args.rubricName} in ${settingsPath}; it has: ` +
                    rubrics.map(entry => entry.name).join(', ')
            )
        }
        return {
            id: picked.id || 'bench-rubric',
            name: picked.name || 'rubric',
            guidelines: picked.guidelines || '',
            scanPatterns: picked.scanPatterns || '',
            source: `${settingsPath} (rubric "${picked.name}")`,
        }
    }
    const rubricPath = path.resolve(REPO, args.rubric)
    if (!fs.existsSync(rubricPath)) fail(`no rubric at ${rubricPath}`)
    return {
        id: 'bench-rubric',
        name: args.rubricName || path.basename(rubricPath, path.extname(rubricPath)),
        guidelines: fs.readFileSync(rubricPath, 'utf8'),
        scanPatterns: args.scanPatterns
            ? fs.readFileSync(path.resolve(REPO, args.scanPatterns), 'utf8')
            : '',
        source: rubricPath,
    }
}

function fail(message) {
    console.error(`bench: ${message}`)
    console.error('run node bench/run.mjs --help for the arguments')
    process.exit(2)
}

const USAGE = `
node bench/run.mjs --project <dir> --rubric <file> --endpoint <url> --model <alias>

  --project <dir>       LaTeX project directory (read only)
  --rubric <file>       rubric text file, one requirement per numbered line
  --endpoint <url>      OpenAI-style base URL, e.g. http://host:9090/v1
  --model <alias>       model id as the backend serves it
  --model-backup <id>   optional backup model for the failover
  --out <file>          where the full result JSON goes
                        (default bench/out/<project>-<model>-<timestamp>.json)
  --mode full|fast      full calls the model, fast runs the deterministic half only
  --rubric-name <text>  rubric display name (default: the rubric file name)
  --scan-patterns <f>   file with the rubric scan patterns, "Label :: regex" per line
  --settings <file>     a copy of the instance's llm-admin-settings.json: the rubric
                        (guidelines AND scan patterns) is taken from it, which is the
                        highest-fidelity way to reproduce a production review.
                        --rubric-name picks which one; the first is used otherwise
  --language-tool <url> enable LanguageTool at this address (OFF by default)
  --bib-mailto <email>  enable the Crossref bibliography check (OFF by default)
  --max-context <n>     context window to budget against (default 32000)
  --max-tokens <n>      per-pass answer budget (default 12000)
  --typecheck           run the document-type gate instead of confirming it
  --dry-run             answer every model call from its own JSON schema instead
                        of sending it, to check the wiring before spending GPU
  --log <level>         debug|info|warn|error|silent (default warn)
`

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

const pad = (text, width) => String(text).padEnd(width)
const firstLine = text =>
    String(text || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line.length > 0) || ''
const clip = (text, width) =>
    String(text).length > width ? `${String(text).slice(0, width - 1)}…` : String(text)

function formatMs(ms) {
    if (ms < 1000) return `${Math.round(ms)} ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
    const minutes = Math.floor(ms / 60000)
    return `${minutes}m ${Math.round((ms % 60000) / 1000)}s`
}

// The phases, as the fetch log records them. Every model call carries the name of
// the JSON schema it was constrained by, which is exactly the phase it belongs to.
const PHASE_LABEL = {
    tokenize: '/tokenize (exact prompt count)',
    models: '/models (model availability)',
    filestore: 'figure bytes from disk',
    json_mode_probe: 'JSON schema probe',
    document_type: 'document type check',
    compliance_review: 'review passes',
    candidate_check: 'per-candidate passes',
    compliance_verification: 'double-check passes',
    compliance_summary: 'closing summary',
}

function phaseTable(fetchLog) {
    const phases = new Map()
    for (const call of fetchLog) {
        const key = call.kind === 'chat' ? call.schema || 'chat (no schema)' : call.kind
        if (!phases.has(key)) {
            phases.set(key, { calls: 0, ms: 0, failed: 0, bytes: 0 })
        }
        const phase = phases.get(key)
        phase.calls += 1
        phase.ms += call.ms || 0
        phase.bytes += call.requestBytes || 0
        if (call.ok === false) {
            phase.failed += 1
        }
    }
    return phases
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (args.help) {
        console.log(USAGE)
        return 0
    }
    if (!args.project) fail('--project is required')
    if (!args.rubric && !args.settings) fail('--rubric or --settings is required')
    if (args.mode !== 'fast' && !args.endpoint) fail('--endpoint is required in full mode')
    if (args.mode !== 'fast' && !args.model) fail('--model is required in full mode')

    const projectDir = path.resolve(REPO, args.project)
    const project = readProject(projectDir)
    const rubric = resolveRubric(args)

    // A [per-candidate] requirement is answered by a closed-question pass over the
    // passages a SCAN PATTERN found. With no pattern for its label the requirement
    // comes back n.a. with that reason, which is honest but is not what the
    // instance does, so the difference is announced instead of discovered later in
    // the report.
    const perCandidate = [...rubric.guidelines.matchAll(/\[per-candidate:\s*([^\]]+)\]/g)].map(m =>
        m[1].trim()
    )
    const patternLabels = new Set(
        rubric.scanPatterns
            .split('\n')
            .map(line => line.split('::')[0].trim().toLowerCase())
            .filter(Boolean)
    )
    const unpatterned = perCandidate.filter(label => !patternLabels.has(label.toLowerCase()))

    console.log('='.repeat(78))
    console.log(`project    ${projectDir}`)
    console.log(
        `           ${project.docs.length} text sources, ${project.files.length} figures, ` +
            `${(projectSize(project) / 1024).toFixed(1)} kB of LaTeX`
    )
    console.log(`rubric     ${rubric.source} (${rubric.name})`)
    if (unpatterned.length > 0) {
        console.log(
            `WARNING    ${unpatterned.length} of ${perCandidate.length} [per-candidate] requirements ` +
                'have no scan pattern and will come back n.a.'
        )
        console.log(`           missing patterns for: ${unpatterned.join(', ')}`)
        console.log('           pass --scan-patterns or --settings to reproduce the instance')
    }
    console.log(`endpoint   ${args.endpoint || 'none, fast mode'}`)
    console.log(`model      ${args.model || 'none, fast mode'}`)
    console.log(`mode       ${args.mode}${args.confirmed ? '' : ', document type gate ON'}`)
    if (args.dryRun) {
        console.log('DRY RUN    no backend is contacted: every model call is answered from its schema')
    }
    console.log('='.repeat(78))

    // One line per pass. The controller moves the counter and the label in two
    // separate writes, so printing on every update would double every line: the
    // label is what changes once per pass, so that is what is watched.
    let lastRequirement = null
    const onProgress = progress => {
        const requirement = progress.currentRequirement || ''
        if (requirement === lastRequirement || !requirement) {
            return
        }
        lastRequirement = requirement
        const total = progress.passesTotal || '?'
        console.log(
            `[${String(progress.passesDone + 1).padStart(3)}/${String(total).padStart(3)}] ${clip(
                requirement,
                96
            )}`
        )
    }

    const controller = await loadController({
        docs: project.docs,
        files: project.files,
        rubrics: [rubric],
        endpoints: args.endpoint
            ? [
                  {
                      id: 'bench',
                      label: 'bench',
                      url: args.endpoint,
                      model: args.model,
                      modelBackup: args.modelBackup || null,
                  },
              ]
            : [],
        fetch: args.dryRun ? makeScriptedBackend(args.model || 'dry-run').fetchImpl : undefined,
        maxContextTokens: args.maxContext || 32000,
        reviewMaxTokens: args.maxTokens || 12000,
        languageToolUrl: args.languageTool,
        bibVerifyMailto: args.bibMailto,
        logLevel: args.log,
        onProgress,
    })

    console.log(
        `loader     stubbed ${controller.transform.stubbed.length} container-only imports, ` +
            `loaded ${controller.transform.loadedForReal.length} siblings for real`
    )
    console.log(
        `           chat_template_kwargs: ${
            controller.controllerSendsChatTemplateKwargs
                ? 'sent by the controller itself'
                : controller.injectChatTemplateKwargs
                  ? 'added by the bench fetch wrapper (enable_thinking:false)'
                  : 'NOT SENT, the backend had better disable thinking itself'
        }`
    )
    console.log('-'.repeat(78))

    const job = controller.makeJob({
        rubricId: rubric.id,
        rubricName: rubric.name,
        mode: args.mode,
        confirmed: args.confirmed,
    })

    const started = Date.now()
    let outcome
    try {
        outcome = await controller.performReview(job)
    } catch (err) {
        console.error(`\nthe review THREW after ${formatMs(Date.now() - started)}: ${err.stack || err}`)
        writeResult(args, project, rubric, job, controller, { type: 'crash', error: String(err && err.stack) }, started)
        return 1
    }
    const elapsed = Date.now() - started

    console.log('-'.repeat(78))
    if (outcome.type !== 'done') {
        console.log(`REVIEW DID NOT COMPLETE: ${outcome.errorCode}`)
        console.log(`  ${outcome.message}`)
    } else {
        const items = outcome.result.items || []
        const tally = {}
        for (const item of items) {
            tally[item.status] = (tally[item.status] || 0) + 1
        }
        console.log(`${items.length} items: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`)
        console.log('')
        items.forEach((item, index) => {
            console.log(
                `${String(index + 1).padStart(3)}. ${pad(item.status.toUpperCase(), 8)} ${clip(
                    (item.requirement || '').replace(/\s+/g, ' '),
                    92
                )}`
            )
            const evidence = firstLine(item.evidence)
            if (evidence) {
                console.log(`     ${clip(evidence, 100)}`)
            }
            if (item.modelFailure) {
                console.log('     [the model never produced an answer for this one]')
            }
        })
        if (outcome.result.summary) {
            console.log('')
            console.log(`summary    ${clip(String(outcome.result.summary).replace(/\s+/g, ' '), 300)}`)
        }
    }

    console.log('')
    console.log(`total      ${formatMs(elapsed)}`)
    const phases = phaseTable(controller.fetchLog)
    let modelMs = 0
    for (const [key, phase] of phases) {
        const label = PHASE_LABEL[key] || key
        // A 404 on /tokenize is not a failure: a bare llama.cpp does not serve it
        // and the review falls back to estimateTokens, which is expected.
        const note =
            key === 'tokenize' && phase.failed === phase.calls
                ? '  absent, the token estimate was used'
                : phase.failed
                  ? `  ${phase.failed} FAILED`
                  : ''
        console.log(
            `  ${pad(label, 34)} ${String(phase.calls).padStart(4)} calls  ${pad(
                formatMs(phase.ms),
                10
            )} ${phase.calls > 1 ? `(mean ${formatMs(phase.ms / phase.calls)})` : ''}${note}`
        )
        if (key !== 'filestore') {
            modelMs += phase.ms
        }
    }
    console.log(`  ${pad('everything not the backend', 34)}       ${formatMs(elapsed - modelMs)}`)

    const outPath = writeResult(args, project, rubric, job, controller, outcome, started)
    console.log('')
    console.log(`written    ${outPath}`)
    return 0
}

function writeResult(args, project, rubric, job, controller, outcome, started) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const outPath = args.out
        ? path.resolve(REPO, args.out)
        : path.join(
              HERE,
              'out',
              `${path.basename(project.root).replace(/[^\w.-]+/g, '_')}-${(args.model || 'fast').replace(
                  /[^\w.-]+/g,
                  '_'
              )}-${stamp}.json`
          )
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(
        outPath,
        JSON.stringify(
            {
                bench: {
                    ranAt: new Date().toISOString(),
                    elapsedMs: Date.now() - started,
                    project: project.root,
                    documents: project.docs.map(doc => doc.path),
                    figures: project.files.map(file => file.path),
                    rubric: {
                        name: rubric.name,
                        source: rubric.source,
                        guidelineChars: rubric.guidelines.length,
                        scanPatternLines: rubric.scanPatterns.split('\n').filter(line => line.trim()).length,
                    },
                    endpoint: args.endpoint || null,
                    model: args.model || null,
                    mode: args.mode,
                    confirmed: args.confirmed,
                    chatTemplateKwargs: {
                        sentByController: controller.controllerSendsChatTemplateKwargs,
                        addedByBench: controller.injectChatTemplateKwargs,
                    },
                    stubbedImports: controller.transform.stubbed,
                    siblingsLoadedForReal: controller.transform.loadedForReal,
                },
                job: {
                    passesTotal: job.passesTotal,
                    passesDone: job.passesDone,
                    documentTokensEstimate: job.documentTokensEstimate,
                },
                calls: controller.fetchLog.map(call => ({
                    kind: call.kind,
                    schema: call.schema || null,
                    status: call.status === undefined ? null : call.status,
                    ok: call.ok === undefined ? null : call.ok,
                    ms: call.ms || 0,
                    requestBytes: call.requestBytes || 0,
                    error: call.error || null,
                })),
                outcome,
            },
            null,
            2
        ),
        'utf8'
    )
    return outPath
}

process.exit(await main())
