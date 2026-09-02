#!/usr/bin/env node
//===============================================================================
// Test runner for the projects API module.
//===============================================================================
// Usage, from anywhere:
//   node overleaf-projects-api-module/test/run.mjs
//
// Or a single suite on its own, which is often what you want while working on
// one:
//   node overleaf-projects-api-module/test/helpers.test.mjs
//
// No dependencies, no test framework, no build: plain node against the module's
// own sources. Exits non-zero if any suite fails, so it works as a gate.
//
// The module keeps its own runner for the same reason the publish one does: it
// ships in its own image layer and a suite that only makes sense here has no
// business making somebody else's runner red.
//
// Unlike the publish suites, nothing here slices and evaluates a controller.
// Everything worth pinning lives in ProjectsApiHelpers.mjs, which imports no
// Overleaf internals at all, so the suite imports the shipped file directly and
// cannot drift from it. The router, the controller and the auth middleware DO
// import files that exist only inside the container, so all this runner can do
// for them is a syntax check; the smoke test after the image build is what
// proves their imports resolve.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELPERS = path.resolve(HERE, '../app/src/ProjectsApiHelpers.mjs')
const SOURCES = [
    path.resolve(HERE, '../index.mjs'),
    path.resolve(HERE, '../app/src/ProjectsApiRouter.mjs'),
    path.resolve(HERE, '../app/src/ProjectsApiController.mjs'),
    path.resolve(HERE, '../app/src/ProjectsApiAuth.mjs'),
    HELPERS,
]

for (const source of SOURCES) {
    if (!fs.existsSync(source)) {
        console.error(`Cannot find ${source}`)
        process.exit(1)
    }
    const parsed = spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' })
    if (parsed.status !== 0) {
        console.error(`SYNTAX ERROR in ${path.basename(source)}\n${parsed.stderr}`)
        process.exit(1)
    }
}
console.log(`syntax ok (${SOURCES.length} sources)\n`)

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
        env: { ...process.env, HELPERS },
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
