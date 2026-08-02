#!/usr/bin/env node
//===============================================================================
// Test runner for the publish module.
//===============================================================================
// Usage, from anywhere:
//   node overleaf-publish-module/test/run.mjs
//
// Or a single suite on its own, which is often what you want while working on
// one:
//   node overleaf-publish-module/test/slug.test.mjs
//
// No dependencies, no test framework, no build: plain node against the module's
// own sources. Exits non-zero if any suite fails, so it works as a gate.
//
// This module keeps its own runner on purpose. It is a separate module from the
// LLM one, it ships in a different image layer, and a suite that only makes
// sense here has no business making somebody else's runner red.
//
// The suites slice the controller's source and evaluate it, because it imports
// Overleaf internals that only exist inside the container. That means a suite
// breaks when the text it anchors on moves: when that happens the fix is to
// update the anchor, never to delete the test.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTROLLER = path.resolve(HERE, '../app/src/PublishController.mjs')
const ROUTER = path.resolve(HERE, '../app/src/PublishRouter.mjs')
const INDEX = path.resolve(HERE, '../index.mjs')

if (!fs.existsSync(CONTROLLER)) {
    console.error(`Cannot find the controller at ${CONTROLLER}`)
    process.exit(1)
}

// Syntax-check the sources first: a suite that cannot even parse the module
// would otherwise fail with a confusing extraction error.
for (const source of [CONTROLLER, ROUTER, INDEX]) {
    if (!fs.existsSync(source)) continue
    const parsed = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' })
    if (parsed.status !== 0) {
        console.error(`SYNTAX ERROR in ${path.basename(source)}\n${parsed.stderr}`)
        process.exit(1)
    }
}
console.log('syntax ok (3 sources)\n')

const suites = fs
    .readdirSync(HERE)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()

if (suites.length === 0) {
    console.error('No .test.mjs suites found next to this runner')
    process.exit(1)
}

let failed = 0
for (const suite of suites) {
    const run = spawnSync(process.execPath, [path.join(HERE, suite)], {
        encoding: 'utf8',
        env: { ...process.env, PUBLISH: CONTROLLER, ROUTER, PANEL: path.resolve(HERE, '../frontend/js/components/publish-button.tsx') },
    })
    const name = suite.replace('.test.mjs', '')
    if (run.status === 0) {
        console.log(`PASS  ${name}`)
    } else {
        failed += 1
        console.log(`FAIL  ${name}`)
        // Only the failing lines, so the output stays readable.
        for (const line of `${run.stdout}${run.stderr}`.split('\n')) {
            if (/FAIL|Error|error:/.test(line)) console.log(`        ${line.trim()}`)
        }
    }
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed` + (failed ? ` (${failed} failed)` : ''))
process.exit(failed ? 1 : 0)
