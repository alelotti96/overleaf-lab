// overleaf-lab: the three handlers of the projects API. They do as little as
// possible themselves: identity comes from the token middleware, the shaping
// rules live in ProjectsApiHelpers, and the actual work is done by the same core
// handlers the web UI calls, so a project created here is byte for byte a
// project created by pressing "New project".
//
// The API never reads a user id from a request. The owner of a new project and
// the subject of every listing is always the token's user, which is what keeps
// this endpoint out of admin territory: there is no shape of request that acts
// on behalf of somebody else.
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'
import ProjectCreationHandler from '../../../../app/src/Features/Project/ProjectCreationHandler.mjs'
import ProjectDetailsHandler from '../../../../app/src/Features/Project/ProjectDetailsHandler.mjs'
import ProjectGetter from '../../../../app/src/Features/Project/ProjectGetter.mjs'
import UserGetter from '../../../../app/src/Features/User/UserGetter.mjs'
import {
    findOwnedDuplicate,
    normaliseName,
    resolveTemplate,
    shapeProject,
    MAX_PROJECT_NAME_CHARS,
    TEMPLATE_NAMES,
} from './ProjectsApiHelpers.mjs'

// The buckets of findAllUsersProjects, strongest access first. The order is also
// the order of the answer ("owned first"), and it decides which role a project
// keeps when it appears in two buckets at once: a collaborator who ALSO holds a
// share link is listed with the access they really have, not with the weaker one
// that happens to come later.
const ROLES = [
    ['owned', 'owner'],
    ['readAndWrite', 'readAndWrite'],
    ['readOnly', 'readOnly'],
    ['tokenReadAndWrite', 'tokenReadAndWrite'],
    ['tokenReadOnly', 'tokenReadOnly'],
    ['review', 'review'],
]

// Requested as an OBJECT and not as the "name lastUpdated archived trashed"
// string form: Mongoose accepts either, and the object is also harmless if the
// argument ever reaches a plain driver signature, where an unknown option is
// ignored and the whole document comes back. Either way every field read below
// is present. _id is always returned.
const PROJECT_FIELDS = { name: 1, lastUpdated: 1, archived: 1, trashed: 1 }

// Trailing slash stripped once, here, so that no answer of this module ever
// carries "//project/" because of how the instance spells its own address.
function siteUrl() {
    return String(Settings.siteUrl || process.env.OVERLEAF_SITE_URL || '').replace(/\/+$/, '')
}

function fail(res, status, error, extra = {}) {
    return res.status(status).json({ error, ...extra })
}

// GET /api/v1/whoami: what `ol login` calls to prove the token works and to show
// whose token it is.
async function whoami(req, res) {
    try {
        const user = await UserGetter.promises.getUser(req.user_id, {
            email: 1,
            first_name: 1,
            last_name: 1,
        })
        // A user deleted between the token check and this lookup is the same
        // thing as an unknown token, and gets the same answer.
        if (!user) return fail(res, 401, 'unauthorized')
        res.json({
            user_id: String(user._id),
            email: user.email || '',
            first_name: user.first_name || '',
            last_name: user.last_name || '',
        })
    } catch (err) {
        logger.error({ err }, '[projects-api] whoami failed')
        fail(res, 500, 'internal error')
    }
}

// GET /api/v1/projects[?owned=1]
async function list(req, res) {
    try {
        const userId = req.user_id
        const projects = await ProjectGetter.promises.findAllUsersProjects(userId, PROJECT_FIELDS)
        const ownedOnly = req.query && (req.query.owned === '1' || req.query.owned === 'true')
        const base = siteUrl()
        const seen = new Set()
        const answer = []
        for (const [bucket, role] of ROLES) {
            if (ownedOnly && bucket !== 'owned') continue
            for (const doc of (projects && projects[bucket]) || []) {
                const entry = shapeProject(doc, role, userId, base)
                // A project can sit in two buckets (a collaborator who also
                // opened the share link). It is one project, so it is listed
                // once, with the first role that claimed it.
                if (!entry.id || seen.has(entry.id)) continue
                seen.add(entry.id)
                answer.push(entry)
            }
        }
        res.json(answer)
    } catch (err) {
        logger.error({ err }, '[projects-api] listing failed')
        fail(res, 500, 'internal error')
    }
}

// POST /api/v1/projects
async function create(req, res) {
    const body = req.body || {}
    const userId = req.user_id
    const name = normaliseName(body.name)
    if (!name) {
        return fail(res, 400, `name is required and must be 1 to ${MAX_PROJECT_NAME_CHARS} characters`)
    }
    const method = resolveTemplate(body.template)
    if (!method) {
        return fail(res, 400, `template must be one of ${TEMPLATE_NAMES.join(', ')}`)
    }
    try {
        // Core's own rule, applied before anything is written, so the API refuses
        // exactly what the web UI refuses and says it in the same words. The
        // error class it throws is not part of the contract here: anything
        // thrown is the caller's mistake about a name, so anything thrown is a
        // 400 carrying that message. The promises export is the one to call:
        // the default export is callbackified and, awaited, rejects for every
        // name, valid or not.
        try {
            await ProjectDetailsHandler.promises.validateProjectName(name)
        } catch (err) {
            return fail(res, 400, (err && err.message) || 'invalid project name')
        }

        // Duplicate guard. Upstream enforces no uniqueness at all, so this is a
        // module-level choice: a script retried after a timeout must not leave
        // "notes", "notes", "notes" behind. `allow_duplicate` is the way out for
        // somebody who really does want two, and the string form is accepted
        // because that is what a curl caller types.
        const allowDuplicate = body.allow_duplicate === true || body.allow_duplicate === 'true'
        if (!allowDuplicate) {
            const projects = await ProjectGetter.promises.findAllUsersProjects(userId, PROJECT_FIELDS)
            const existing = findOwnedDuplicate((projects && projects.owned) || [], name, userId)
            if (existing) {
                return fail(res, 409, 'a project with this name already exists', {
                    id: String(existing._id),
                })
            }
        }

        const project = await ProjectCreationHandler.promises[method](userId, name)
        const id = String(project._id)
        const base = siteUrl()
        logger.info({ userId, projectId: id, template: method }, '[projects-api] project created')
        res.status(201).json({
            id,
            name: project.name || name,
            url: `${base}/project/${id}`,
            git_url: `${base}/git/${id}`,
        })
    } catch (err) {
        logger.error({ err, userId }, '[projects-api] project creation failed')
        fail(res, 500, 'internal error')
    }
}

export default {
    whoami,
    list,
    create,
}
