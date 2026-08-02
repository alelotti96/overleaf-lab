// Extract the REAL splitRubric from the controller and test the splitting rules.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.CTRL, 'utf8')
const start = src.indexOf('function splitRubric(')
const end = src.indexOf('// overleaf-lab: the compliance reviewer system prompt')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate splitRubric')
    process.exit(1)
}
// eslint-disable-next-line no-new-func
const splitRubric = new Function(`${src.slice(start, end)}; return splitRubric`)()

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// 1) the real 22-requirement rubric (excerpt pattern: numbered, multi-line items)
const rubric22 = Array.from({ length: 22 }, (_, i) =>
    `${i + 1}. Requirement number ${i + 1} of the rubric,\nwith a continuation line.`
).join('\n')
let r = splitRubric(rubric22)
check('22 numbered -> 22 passes', r.requirements.length === 22, `got ${r.requirements.length}`)
check('continuation kept', r.requirements[0].includes('continuation'))
check('order kept', r.requirements[21].startsWith('22.'))

// 2) preamble before requirement 1 is captured, not lost
r = splitRubric(`Rubric for a written report.\nThese apply to the whole document.\n1. First requirement.\n2. Second requirement.`)
check('preamble captured', r.preamble === 'Rubric for a written report.\nThese apply to the whole document.')
check('preamble not a requirement', r.requirements.length === 2)

// 3) bullets split when there are no numbers
r = splitRubric(`- First bulleted requirement\n- Second bulleted requirement\n- Third`)
check('bullets split', r.requirements.length === 3, `got ${r.requirements.length}`)

// 4) sub-bullets inside numbered items do NOT fragment them
r = splitRubric(`1. Requirement with sub-points:\n- sub-point a\n- sub-point b\n2. Another requirement.`)
check('sub-bullets stay inside', r.requirements.length === 2, `got ${r.requirements.length}`)
check('sub-bullet content kept', r.requirements[0].includes('sub-point b'))

// 5) free prose degrades to a single pass over the whole text
const prose = `The document must be written in the third person and in formal language. Figures must have captions.`
r = splitRubric(prose)
check('prose -> single pass', r.requirements.length === 1 && r.requirements[0] === prose)

// 6) a single numbered line also degrades to a single pass (< 2 markers)
r = splitRubric(`1. Single requirement.`)
check('one marker -> single pass', r.requirements.length === 1)

// 7) parenthesis numbering "1)" works
r = splitRubric(`1) First\n2) Second\n3) Third`)
check('paren numbering', r.requirements.length === 3, `got ${r.requirements.length}`)

// 8) empty/whitespace input does not crash
r = splitRubric('')
check('empty input', r.requirements.length === 1 && r.requirements[0] === '')

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
