// overleaf-lab: routes for the lists module. Reading the status of the two lists
// needs read access; updating one or creating one WRITES INTO THE PROJECT, so both
// sit behind ensureUserCanWriteProjectContent and not behind the read gate.
//
// That distinction is the whole of the authorisation story and it is worth stating
// plainly: ensureUserCanReadProject is satisfied by a read-only collaborator and
// by a link-sharing viewer, neither of whom may edit a single character of
// somebody else's thesis. Overleaf's own editor endpoints use
// ensureUserCanWriteProjectContent for exactly this, and so does the publish
// module next door.
//
// There is no public surface at all: every route is project scoped and lives on
// the webRouter, behind the login wall and behind CSRF.
import logger from '@overleaf/logger'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import ListsController from './ListsController.mjs'

// overleaf-lab: EVERY ROUTE HERE SCANS THE WHOLE PROJECT, which is the most
// expensive thing a logged-in user can ask this instance to do without compiling.
// The status route is the cheapest of the three and is also the one a page load
// fires by itself, so it gets the loose limit; the two that WRITE get the strict
// one, because a hundred presses a minute is not a person and the second press of
// a correct one is already a no-op.
//
// Fixed window, per user and route, in memory. Copied deliberately from the
// publish module next door (makeRateLimiter there) rather than invented: this
// instance runs one web process, so a Map is enough, and the limiter exists to
// blunt a loop, not to bill anyone. Expired windows are pruned on touch.
function makeRateLimiter(limit, windowMs) {
    const hits = new Map()
    return key => {
        const now = Date.now()
        if (hits.size > 10000) {
            for (const [seen, entry] of hits) {
                if (entry.resetAt <= now) hits.delete(seen)
            }
        }
        const entry = hits.get(key)
        if (!entry || entry.resetAt <= now) {
            hits.set(key, { count: 1, resetAt: now + windowMs })
            return true
        }
        entry.count += 1
        return entry.count <= limit
    }
}

const allowStatus = makeRateLimiter(60, 60 * 1000)
const allowWrite = makeRateLimiter(10, 60 * 1000)

// The key is the USER and the route, not the IP: two people behind one university
// NAT are two users, and the same person in two tabs is one.
function limit(allow, name) {
    return (req, res, next) => {
        const userId = SessionManager.getLoggedInUserId(req.session) || 'anonymous'
        if (allow(`${name}:${userId}`)) return next()
        logger.warn({ userId, route: name }, '[lists] rate limited')
        return res.status(429).json({
            ok: false,
            error: 'rate_limited',
            message: 'Too many list requests. Wait a minute and try again.',
        })
    }
}

export default {
    apply(webRouter) {
        logger.info({}, '[lists] Registering routes')

        webRouter.get(
            '/project/:Project_id/lists',
            AuthorizationMiddleware.ensureUserCanReadProject,
            limit(allowStatus, 'status'),
            ListsController.status
        )

        // :kind is checked against a fixed set of two names inside the controller,
        // and it never reaches a path, a file name or a query. See kindOf().
        webRouter.post(
            '/project/:Project_id/lists/:kind/update',
            AuthorizationMiddleware.ensureUserCanWriteProjectContent,
            limit(allowWrite, 'update'),
            ListsController.update
        )

        webRouter.post(
            '/project/:Project_id/lists/:kind/create',
            AuthorizationMiddleware.ensureUserCanWriteProjectContent,
            limit(allowWrite, 'create'),
            ListsController.create
        )

        logger.info({}, '[lists] All routes registered successfully')
    },
}
