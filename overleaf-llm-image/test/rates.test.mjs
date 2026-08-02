// Extract the REAL throughput-resolution block from the controller and verify:
// env > measured > fallback precedence, sample-size gating (cache-hit poisoning),
// and probe seeding.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.CTRL, 'utf8')
const lines = src.split('\n')
const start = lines.findIndex(l => l.includes('An explicit env value always wins'))
const end = lines.findIndex(l => l.includes('floor for the review timeout'))
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the throughput block')
    process.exit(1)
}
const snippet = lines.slice(start, end).join('\n')

let ok = true
function check(name, actual, expected) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected)
    if (!pass) ok = false
    console.log(`[${name}] ${pass ? 'PASS' : 'FAIL'}  got=${JSON.stringify(actual)}`)
    if (!pass) console.log(`         want=${JSON.stringify(expected)}`)
}

function build(env) {
    // eslint-disable-next-line no-new-func
    return new Function(
        'process',
        'logger',
        'fetch',
        `${snippet}\n; return { effectiveRates, recordTimings }`
    )({ env }, { debug() {} }, async () => {
        throw new Error('probe must not be called in this test')
    })
}

// Realistic llama.cpp timings payloads
const REAL_REVIEW = { prompt_per_second: 5432.1, prompt_n: 47676, predicted_per_second: 149.5, predicted_n: 1500 }
const PROBE = { prompt_per_second: 900, prompt_n: 660, predicted_per_second: 100, predicted_n: 8 }
const CACHE_HIT = { prompt_per_second: 75.97, prompt_n: 1, predicted_per_second: 148.8, predicted_n: 1400 }

// 1) no env, no measurement -> CPU fallbacks
let m = build({})
check('fallback', m.effectiveRates(), { prefillTps: 80, genTps: 4 })

// 2) a real review (strong samples) is learned
m = build({})
m.recordTimings(REAL_REVIEW)
check('real review wins', m.effectiveRates(), { prefillTps: 5432.1, genTps: 149.5 })

// 3) THE BUG: a cache-hit rerun must NOT poison the prefill calibration.
//    Its generation sample is real (1400 tokens actually generated) and may update.
m.recordTimings(CACHE_HIT)
check('cache hit does not poison prefill', m.effectiveRates(), { prefillTps: 5432.1, genTps: 148.8 })

// 4) probe-sized samples seed an EMPTY calibration (this is how the probe works)
m = build({})
m.recordTimings(PROBE)
check('probe seeds when empty', m.effectiveRates(), { prefillTps: 900, genTps: 100 })

// 5) ...and a later real review replaces the probe seed
m.recordTimings(REAL_REVIEW)
check('review replaces probe', m.effectiveRates(), { prefillTps: 5432.1, genTps: 149.5 })

// 6) ...but probe-sized samples never replace a strong measurement
m.recordTimings(PROBE)
check('probe cannot demote strong', m.effectiveRates(), { prefillTps: 5432.1, genTps: 149.5 })

// 7) a cache hit on a FRESH process (below the MIN floor) must not seed either
m = build({})
m.recordTimings({ prompt_per_second: 75.97, prompt_n: 1, predicted_per_second: 100, predicted_n: 2 })
check('tiny sample never seeds', m.effectiveRates(), { prefillTps: 80, genTps: 4 })

// 8) timings without sample sizes are rejected (rate alone cannot be judged)
m = build({})
m.recordTimings({ prompt_per_second: 5000, predicted_per_second: 100 })
check('no sample size -> rejected', m.effectiveRates(), { prefillTps: 80, genTps: 4 })

// 9) a pinned env value wins over any measurement
m = build({ LLM_REVIEW_PREFILL_TPS: '5400', LLM_REVIEW_GEN_TPS: '150' })
m.recordTimings(REAL_REVIEW)
check('env wins over measured', m.effectiveRates(), { prefillTps: 5400, genTps: 150 })

// 10) junk timings do not corrupt anything
m = build({})
m.recordTimings(undefined)
m.recordTimings({})
m.recordTimings({ prompt_per_second: 0, prompt_n: 50000, predicted_per_second: -3, predicted_n: 500 })
check('junk keeps fallback', m.effectiveRates(), { prefillTps: 80, genTps: 4 })

// 11) partial strong sample updates only its own field
m = build({})
m.recordTimings({ predicted_per_second: 150, predicted_n: 1500 })
check('partial timings', m.effectiveRates(), { prefillTps: 80, genTps: 150 })

console.log('RESULT:', ok ? 'ALL PASS' : 'FAILURES')
process.exit(ok ? 0 : 1)
