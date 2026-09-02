// overleaf-lab: every call into a core handler must go through its .promises
// export.
//
// Usage, from anywhere:
//   node overleaf-projects-api-module/test/promises.test.mjs
// or, with the module's whole runner:
//   node overleaf-projects-api-module/test/run.mjs
//
// This suite exists because of a bug that shipped: the controller awaited
// ProjectDetailsHandler.validateProjectName(name), which is the callbackified
// default export. Awaited without a callback it rejects for EVERY name, the
// surrounding catch turned that into a 400, and no project could ever be
// created. Nothing offline can run the controller (its imports resolve only
// inside the container), but the mistake is visible in the source text: a core
// handler used as `Handler.method(` instead of `Handler.promises.method(`.
// So this suite reads the controller as text and pins the calling convention.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const CONTROLLER = fileURLToPath(
    new URL('../app/src/ProjectsApiController.mjs', import.meta.url)
)
const source = fs.readFileSync(CONTROLLER, 'utf8')

// The core handlers the controller imports. UserGetter is included even though
// today's controller may not call it here: if a call appears, it gets checked.
const HANDLERS = [
    'ProjectDetailsHandler',
    'ProjectCreationHandler',
    'ProjectGetter',
    'UserGetter',
]

let failures = 0
function test(name, fn) {
    try {
        fn()
        console.log(`[PASS] ${name}`)
    } catch (err) {
        failures += 1
        console.log(`[FAIL] ${name}`)
        console.log(`        ${String(err && err.message).split('\n')[0]}`)
    }
}

for (const handler of HANDLERS) {
    test(`${handler}: every member access is .promises (or an import line)`, () => {
        // Every `Handler.something` in the source, with the line it sits on so a
        // failure names the exact spot.
        const uses = []
        const re = new RegExp(`\\b${handler}\\.(\\w+)`, 'g')
        for (const match of source.matchAll(re)) {
            const line = source.slice(0, match.index).split('\n').length
            uses.push({ member: match[1], line })
        }
        // 'mjs' is the import line: `from '.../ProjectDetailsHandler.mjs'`.
        const wrong = uses.filter(use => use.member !== 'promises' && use.member !== 'mjs')
        assert.deepEqual(
            wrong,
            [],
            `${handler} used without .promises at line(s) ` +
                wrong.map(use => `${use.line} (.${use.member})`).join(', ')
        )
    })
}

// The check must not be vacuous: the controller really does call these two.
test('the pins bite: ProjectDetailsHandler and ProjectCreationHandler are actually called', () => {
    assert.ok(/ProjectDetailsHandler\.promises\.validateProjectName\(/.test(source))
    assert.ok(/ProjectCreationHandler\.promises\[/.test(source))
})

if (failures > 0) {
    console.log(`\n${failures} failing`)
    process.exit(1)
}
console.log('\nall green')
