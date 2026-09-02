// overleaf-lab: the only credential this API accepts is the personal access
// token the user already created for the Git Bridge, validated by the
// git-bridge module's own manager. Reusing that token is a deliberate trust
// decision: it already grants read and write on every project the user can
// reach, so letting it also create and list projects adds no new capability
// class, and it saves the user a second secret to store and revoke.
//
// The header parsing is the git-bridge middleware's, minus the project
// permission check: there is no project in these requests, only a user.
import logger from '@overleaf/logger'
import GitBridgePATManager from '../../../git-bridge/app/src/GitBridgePATManager.mjs'

const BEARER_RE = /^Bearer\s+(\S+)$/i

// ONE answer for every failure kind. Missing header, wrong scheme, unknown
// token, expired token and deleted user are indistinguishable from outside: the
// difference between them is exactly what a caller probing for valid tokens
// would want to read.
function unauthorized(res) {
    return res.status(401).json({ error: 'unauthorized' })
}

async function requireToken(req, res, next) {
    try {
        const header = (req.headers && req.headers.authorization) || ''
        const match = BEARER_RE.exec(header)
        if (!match) return unauthorized(res)
        // getUserId checks the olp_ prefix, the sha256 hash, the git_bridge
        // scope, the expiry and that the user still exists, and it refreshes
        // lastUsedAt. Nothing is left for this middleware to re-check.
        const userId = await GitBridgePATManager.getUserId(match[1])
        if (!userId) return unauthorized(res)
        // The one place a user id enters a request. Every handler reads it from
        // here and never from the body or the query, so the API cannot be asked
        // to act on behalf of somebody else.
        req.user_id = String(userId)
        next()
    } catch (err) {
        // A thrown error is a broken instance, not a bad token, and answering
        // 401 would send the user off revoking a token that is fine.
        logger.error({ err }, '[projects-api] token check failed')
        res.status(500).json({ error: 'internal error' })
    }
}

export default {
    requireToken,
}
