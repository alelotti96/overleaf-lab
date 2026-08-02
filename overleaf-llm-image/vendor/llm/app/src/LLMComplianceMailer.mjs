// overleaf-lab: tell the user by email that their compliance review is over.
//
// A review takes minutes, and on a long document with a queue in front of it, tens
// of minutes. Waiting in front of the panel for that is a waste of the user's time:
// the finished report is archived in Mongo and the panel re-attaches to it on the
// next visit, so the browser can be closed and the machine shut down. The email is
// what makes that safe to rely on, because without it the only way to learn the
// review has finished is to keep looking.
//
// Nothing in this file may take a review down with it. SMTP is optional in this
// deployment and mail servers fail in ways we do not control, so every path ends in
// a log line and the caller is never told.
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'

// overleaf-lab: whether this instance can actually send mail.
//
// SMTP is configured through the OVERLEAF_EMAIL_* variables, which the server maps
// onto Settings.email. The from-address ALONE creates that object, and our
// config.env ships a placeholder for it, so testing `Settings.email` on its own
// would report "yes" on an install that never configured a mail server and the UI
// would promise a message that never leaves. Require a transport as well.
export function isEmailConfigured() {
    const email = Settings.email
    if (!email) {
        return false
    }
    const parameters = email.parameters || {}
    return Boolean(parameters.host || parameters.AWSAccessKeyID || email.driver === 'ses')
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(
        /[&<>"']/g,
        c =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[c] || c
    )
}

function formatDuration(ms) {
    if (!ms || ms < 0) {
        return ''
    }
    const totalSeconds = Math.round(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return minutes ? `${minutes} min ${seconds} s` : `${seconds} s`
}

function projectUrl(projectId) {
    const base = String(Settings.siteUrl || '').replace(/\/+$/, '')
    return base ? `${base}/project/${projectId}` : ''
}

// overleaf-lab: core modules are imported here rather than at the top of the file on
// purpose. This module is optional garnish on a feature that must keep working: a
// static import of a core path that moves in a future base image would fail at load
// time and take the whole review with it, for the sake of a notification. Imported
// lazily, the worst case is a logged warning and no email.
async function loadCore(path) {
    const imported = await import(path)
    return imported.default || imported
}

async function recipientFor(userId) {
    const UserGetter = await loadCore(
        '../../../../app/src/Features/User/UserGetter.mjs'
    )
    const user = await UserGetter.promises.getUser(userId, { email: 1 })
    return user?.email || null
}

async function projectNameFor(projectId) {
    const ProjectGetter = await loadCore(
        '../../../../app/src/Features/Project/ProjectGetter.mjs'
    )
    const project = await ProjectGetter.promises.getProject(projectId, { name: 1 })
    return project?.name || ''
}

// overleaf-lab: what the message says, and what it deliberately does not.
//
// It carries the verdict tally, the rubric, how long it took and a link, which is
// enough to decide whether to go and read it now. It does NOT carry the report: the
// findings quote the document verbatim, and mail leaves the server, is relayed by
// providers we do not run and lands in archives we do not control. The report stays
// where the access rules still apply, which is inside the project.
function buildSuccessEmail({ projectName, url, rubricName, counts, durationMs }) {
    const named = projectName ? `"${projectName}"` : 'your project'
    const subject = projectName
        ? `Review finished: ${projectName}`
        : 'Your compliance review has finished'
    const duration = formatDuration(durationMs)

    const lines = [
        `The compliance review of ${named} has finished.`,
        '',
        `Rubric: ${rubricName || 'not recorded'}`,
        `Result: ${counts.ok} OK, ${counts.partial} partial, ${counts.missing} missing, ${counts.na} not applicable`,
    ]
    if (duration) {
        lines.push(`Time taken: ${duration}`)
    }
    lines.push(
        '',
        'Open the project and the report will be waiting in the review panel of the AI Assistant. Reports are kept for twelve months.',
        ''
    )
    if (url) {
        lines.push(url)
    }

    const html = [
        `<p>The compliance review of <strong>${escapeHtml(named)}</strong> has finished.</p>`,
        '<ul>',
        `<li>Rubric: ${escapeHtml(rubricName || 'not recorded')}</li>`,
        `<li>Result: <strong>${counts.ok}</strong> OK, <strong>${counts.partial}</strong> partial, <strong>${counts.missing}</strong> missing, ${counts.na} not applicable</li>`,
        duration ? `<li>Time taken: ${escapeHtml(duration)}</li>` : '',
        '</ul>',
        '<p>Open the project and the report will be waiting in the review panel of the AI Assistant. Reports are kept for twelve months.</p>',
        url
            ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`
            : '',
    ]
        .filter(Boolean)
        .join('\n')

    return { subject, text: lines.join('\n'), html }
}

// A failure that arrives silently is worse than no email at all: the user goes back
// to the panel an hour later expecting a report and finds nothing, with no way of
// telling a crash from a review still running. So failures are notified too.
function buildFailureEmail({ projectName, url, rubricName, message }) {
    const named = projectName ? `"${projectName}"` : 'your project'
    const subject = projectName
        ? `Review failed: ${projectName}`
        : 'Your compliance review did not finish'

    const lines = [
        `The compliance review of ${named} did not finish.`,
        '',
        `Rubric: ${rubricName || 'not recorded'}`,
        `Reason: ${message || 'the review failed or timed out'}`,
        '',
        'No report was produced. You can start the review again from the project.',
        '',
    ]
    if (url) {
        lines.push(url)
    }

    const html = [
        `<p>The compliance review of <strong>${escapeHtml(named)}</strong> did not finish.</p>`,
        '<ul>',
        `<li>Rubric: ${escapeHtml(rubricName || 'not recorded')}</li>`,
        `<li>Reason: ${escapeHtml(message || 'the review failed or timed out')}</li>`,
        '</ul>',
        '<p>No report was produced. You can start the review again from the project.</p>',
        url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : '',
    ]
        .filter(Boolean)
        .join('\n')

    return { subject, text: lines.join('\n'), html }
}

export async function notifyReviewFinished(job) {
    // Cancelled by the user: they were at the keyboard when they cancelled it, so
    // there is nothing to tell them.
    if (!job || job.status === 'cancelled') {
        return false
    }
    // overleaf-lab: a type_mismatch is a QUESTION waiting on screen ("is this really
    // the right rubric?"), not a failure. Two reasons it must not be mailed. It would
    // tell the user their review "did not finish" while the panel is asking them
    // something, and its message is the model's own sentence ABOUT their document,
    // written from the outline: chapter titles, what the thesis appears to be about.
    // That is document content, and this file's whole policy is that document content
    // does not leave the server by email.
    if (job.errorCode === 'type_mismatch') {
        return false
    }
    if (!isEmailConfigured()) {
        return false
    }

    const to = await recipientFor(job.userId)
    if (!to) {
        logger.warn(
            { jobId: job.id, userId: job.userId },
            '[LLM] compliance: no address to notify the finished review to'
        )
        return false
    }

    const projectName = await projectNameFor(job.projectId)
    const url = projectUrl(job.projectId)
    const counts = (job.result?.items || []).reduce(
        (acc, item) => {
            acc[item.status] = (acc[item.status] || 0) + 1
            return acc
        },
        { ok: 0, partial: 0, missing: 0, na: 0 }
    )

    const body =
        job.status === 'done'
            ? buildSuccessEmail({
                  projectName,
                  url,
                  rubricName: job.rubricName,
                  counts,
                  durationMs: job.result?.durationMs,
              })
            : buildFailureEmail({
                  projectName,
                  url,
                  rubricName: job.rubricName,
                  message: job.message,
              })

    // EmailSender takes (options, emailType) and sends what we hand it.
    // EmailHandler is the other door into the same place, but it goes through
    // EmailBuilder, which only knows email types registered in the core: using it
    // would mean editing a core file to add a type, which is exactly what this
    // vendored module avoids.
    const EmailSender = await loadCore(
        '../../../../app/src/Features/Email/EmailSender.mjs'
    )
    await EmailSender.promises.sendEmail(
        { to, subject: body.subject, html: body.html, text: body.text },
        'llm-compliance-review'
    )
    logger.debug(
        { jobId: job.id, projectId: job.projectId },
        '[LLM] compliance: review notification sent'
    )
    return true
}

// overleaf-lab: the only entry point the controller uses. It never rejects, so it
// can be fired without being awaited and a mail server that hangs cannot hold up the
// next job in the queue.
export async function notifyReviewFinishedQuietly(job) {
    try {
        return await notifyReviewFinished(job)
    } catch (err) {
        logger.warn(
            { jobId: job?.id, projectId: job?.projectId, err },
            '[LLM] compliance: could not send the review notification'
        )
        return false
    }
}

export default {
    isEmailConfigured,
    notifyReviewFinished,
    notifyReviewFinishedQuietly,
}
