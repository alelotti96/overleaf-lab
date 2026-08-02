#!/usr/bin/env node
//===============================================================================
// Test runner for the lists module (acronyms and symbols).
//===============================================================================
// Usage, from anywhere:
//   node overleaf-lists-module/test/run.mjs
//
// Or a single suite on its own, which is often what you want while working on one:
//   node overleaf-lists-module/test/lists.test.mjs
//
// No dependencies, no test framework, no build: plain node against the module's
// own sources. Exits non-zero if any suite fails, so it works as a gate.
//
// This module keeps its own runner on purpose, exactly as the publish module does.
// It is a separate module, it ships in its own image layer, and a suite that only
// makes sense here has no business making somebody else's runner red.
//
// The suites SLICE the controller's pure core out of the real file and evaluate
// it, because the controller imports Overleaf internals (SessionManager,
// ProjectEntityHandler, the document updater) that only exist inside the
// container. That means the tests exercise the code that actually ships rather
// than a copy of it, and it also means a suite breaks when the text it anchors on
// moves: when that happens the fix is to update the anchor, never to delete the
// test. A suite that silently skips what it was written to protect is worse than
// no suite at all.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONTROLLER = path.resolve(HERE, '../app/src/ListsController.mjs')
const ROUTER = path.resolve(HERE, '../app/src/ListsRouter.mjs')
const INDEX = path.resolve(HERE, '../index.mjs')
const BUTTON = path.resolve(HERE, '../frontend/js/components/lists-button.tsx')
const ACRONYMS_MASTER = path.resolve(HERE, '../data/acronyms-master.txt')
const SYMBOLS_MASTER = path.resolve(HERE, '../data/symbols-master.txt')

for (const required of [CONTROLLER, ROUTER, INDEX, BUTTON, ACRONYMS_MASTER, SYMBOLS_MASTER]) {
    if (!fs.existsSync(required)) {
        console.error(`Cannot find ${required}`)
        process.exit(1)
    }
}

// Syntax-check the sources first: a suite that cannot even parse the module would
// otherwise fail with a confusing extraction error.
for (const source of [CONTROLLER, ROUTER, INDEX]) {
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
        env: {
            ...process.env,
            LISTS: CONTROLLER,
            ROUTER,
            INDEX,
            BUTTON,
            ACRONYMS_MASTER,
            SYMBOLS_MASTER,
        },
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
