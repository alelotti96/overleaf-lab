#!/usr/bin/env node
//===============================================================================
// Test runner for the LLM module (compliance review).
//===============================================================================
// Usage, from anywhere:
//   node overleaf-llm-image/test/run.mjs
//
// No dependencies, no test framework, no build: plain node against the vendored
// sources. Exits non-zero if any suite fails, so it works as a pre-commit or CI gate.
//
// WHY THESE LOOK UNUSUAL. The controller imports Overleaf internals
// (SessionManager, ProjectEntityHandler, @overleaf/settings) that only exist inside
// the container, so it cannot simply be imported here. Each suite instead slices the
// helper functions out of the real source file and evaluates them, which means the
// tests exercise the code that actually ships rather than a copy of it. The cost is
// that a suite breaks when the text it anchors on moves: when that happens the fix is
// to update the anchor, not to delete the test.
//
// A failing anchor is reported as a failure on purpose. A test that silently skips
// because it can no longer find what it tests is worse than no test at all.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTROLLER = path.resolve(HERE, '../vendor/llm/app/src/LLMComplianceController.mjs')

if (!fs.existsSync(CONTROLLER)) {
    console.error(`Cannot find the controller at ${CONTROLLER}`)
    process.exit(1)
}

const suites = fs
    .readdirSync(HERE)
    .filter(f => f.endsWith('.test.mjs'))
    .sort()

if (suites.length === 0) {
    console.error('No .test.mjs suites found next to this runner')
    process.exit(1)
}

// Syntax-check the sources first: a suite that cannot even parse the module would
// otherwise fail with a confusing extraction error.
const sources = [
    CONTROLLER,
    path.resolve(HERE, '../vendor/llm/app/src/LLMPrompts.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMAdminController.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMRouter.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMComplianceStore.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMComplianceMailer.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMStructuralChecks.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMLanguageTool.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMBibVerify.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMImageMetrics.mjs'),
    path.resolve(HERE, '../vendor/llm/app/src/LLMAISignals.mjs'),
]
for (const source of sources) {
    if (!fs.existsSync(source)) continue
    const check = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' })
    if (check.status !== 0) {
        console.error(`SYNTAX ERROR in ${path.basename(source)}\n${check.stderr}`)
        process.exit(1)
    }
}
console.log(`syntax ok (${sources.length} sources)\n`)

let failed = 0
for (const suite of suites) {
    const run = spawnSync(process.execPath, [path.join(HERE, suite)], {
        encoding: 'utf8',
        env: {
            ...process.env,
            CTRL: CONTROLLER,
            ADMIN: path.resolve(HERE, '../vendor/llm/app/src/LLMAdminController.mjs'),
            STORE: path.resolve(HERE, '../vendor/llm/app/src/LLMComplianceStore.mjs'),
            MAILER: path.resolve(HERE, '../vendor/llm/app/src/LLMComplianceMailer.mjs'),
            HOOK: path.resolve(HERE, '../vendor/llm/frontend/js/hooks/use-llm-compliance.ts'),
            PANE: path.resolve(HERE, '../vendor/llm/frontend/js/components/llm-compliance-pane.tsx'),
            CHECKS: path.resolve(HERE, '../vendor/llm/app/src/LLMStructuralChecks.mjs'),
            LANGUAGETOOL: path.resolve(HERE, '../vendor/llm/app/src/LLMLanguageTool.mjs'),
            CHAT: path.resolve(HERE, '../vendor/llm/app/src/LLMChatController.mjs'),
            ADMIN: path.resolve(HERE, '../vendor/llm/app/src/LLMAdminController.mjs'),
            PUBLISH: path.resolve(HERE, '../../overleaf-publish-module/app/src/PublishController.mjs'),
        },
    })
    const name = suite.replace('.test.mjs', '')
    if (run.status === 0) {
        console.log(`PASS  ${name}`)
    } else {
        failed += 1
        console.log(`FAIL  ${name}`)
        // Only the failing lines, so the output stays readable with many suites.
        const lines = `${run.stdout}${run.stderr}`.split('\n')
        for (const line of lines) {
            if (/FAIL|Error|error:/.test(line)) {
                console.log(`        ${line.trim()}`)
            }
        }
    }
}

console.log(
    `\n${suites.length - failed}/${suites.length} suites passed` +
        (failed ? ` (${failed} failed)` : '')
)
process.exit(failed ? 1 : 0)
