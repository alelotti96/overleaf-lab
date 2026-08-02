// Extract the REAL helpers from the mailer and test the one decision that can lie to
// the user: whether this instance can send mail at all. The panel promises "you will
// get an email" on the strength of that answer, so a false positive means someone
// closes the browser and waits for a message that was never sent.
//
// The mailer imports @overleaf/settings, which only exists inside the container, so
// the pure part is sliced out and evaluated the way the other suites do it, with a
// fake Settings injected.
import fs from 'node:fs'

const src = fs.readFileSync(process.env.MAILER, 'utf8')
const start = src.indexOf('export function isEmailConfigured')
const end = src.indexOf('export async function notifyReviewFinished')
if (start === -1 || end === -1 || end <= start) {
    console.error('FAIL: could not locate the helpers in the mailer')
    process.exit(1)
}

const Settings = { email: null, siteUrl: 'https://overleaf.example.org/' }
// eslint-disable-next-line no-new-func
const helpers = new Function(
    'Settings',
    `${src.slice(start, end).replace(/export /g, '')}
     return { isEmailConfigured, formatDuration, projectUrl, buildSuccessEmail, buildFailureEmail }`
)(Settings)
const {
    isEmailConfigured,
    formatDuration,
    projectUrl,
    buildSuccessEmail,
    buildFailureEmail,
} = helpers

let ok = true
function check(name, cond, detail) {
    if (!cond) ok = false
    console.log(`[${name}] ${cond ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`)
}

// ---- can this instance send mail ----
Settings.email = null
check('no email settings means no notification', isEmailConfigured() === false)

// The case that matters: config.env ships a placeholder from-address, and the server
// builds Settings.email out of that alone. Trusting it would promise a mail on an
// install that never configured a mail server.
Settings.email = { fromAddress: 'noreply@your-domain.com' }
check(
    'a from-address without a transport is not enough',
    isEmailConfigured() === false
)
Settings.email = { fromAddress: 'noreply@x.org', parameters: {} }
check('an empty parameters object is not enough', isEmailConfigured() === false)

Settings.email = { fromAddress: 'noreply@x.org', parameters: { host: 'smtp.x.org' } }
check('an SMTP host is enough', isEmailConfigured() === true)

Settings.email = { driver: 'ses', parameters: { AWSAccessKeyID: 'k' } }
check('SES credentials are enough', isEmailConfigured() === true)

// ---- the link ----
check(
    'the project link has no double slash',
    projectUrl('abc123') === 'https://overleaf.example.org/project/abc123',
    projectUrl('abc123')
)
{
    const saved = Settings.siteUrl
    Settings.siteUrl = ''
    check('no site url gives no link instead of a broken one', projectUrl('a') === '')
    Settings.siteUrl = saved
}

// ---- duration ----
check('sub-minute durations stay in seconds', formatDuration(45000) === '45 s')
check('longer durations are split', formatDuration(390000) === '6 min 30 s')
check('a missing duration is omitted', formatDuration(null) === '')

// ---- what the message says ----
{
    const email = buildSuccessEmail({
        projectName: 'Tesi <b>finale</b>',
        url: 'https://overleaf.example.org/project/p1',
        rubricName: 'Bachelor thesis',
        counts: { ok: 20, partial: 3, missing: 2, na: 1 },
        durationMs: 390000,
    })
    check('the subject names the project', email.subject.includes('Tesi'))
    check('the tally is in the body', email.text.includes('20 OK'))
    check('the rubric is in the body', email.text.includes('Bachelor thesis'))
    check('the duration is in the body', email.text.includes('6 min 30 s'))
    check('the link is in the body', email.text.includes('/project/p1'))
    check(
        'a project name with markup is escaped in the html part',
        email.html.includes('&lt;b&gt;') && !email.html.includes('<b>finale')
    )
    // The findings quote the document verbatim and mail leaves the server: the
    // builder is not even given the items, and this is what keeps it that way.
    check(
        'the report body is not in the email',
        !email.text.includes('quote') && !email.html.includes('requirement')
    )
}

{
    const email = buildFailureEmail({
        projectName: 'Tesi',
        url: 'https://overleaf.example.org/project/p1',
        rubricName: 'Bachelor thesis',
        message: 'The review request failed or timed out',
    })
    check('a failure is announced as such', /fail|not finish/i.test(email.subject))
    check(
        'a failure says no report was produced',
        email.text.includes('No report was produced')
    )
    check('a failure carries the reason', email.text.includes('timed out'))
}

// A cancelled job is the user's own doing, so it must not generate a message. That
// guard lives in notifyReviewFinished, which cannot be sliced out here; assert the
// source still contains it rather than pretending it is covered.
check(
    "the cancelled guard is still in place",
    /job\.status === 'cancelled'/.test(src)
)

console.log(ok ? '\nALL PASS' : '\nFAILURES')
process.exit(ok ? 0 : 1)
