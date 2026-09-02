// overleaf-lab: everything the projects API decides that needs no database and
// no Overleaf import. It is a file of its own so that the suite can import the
// shipped functions instead of slicing a controller that only resolves inside
// the container: the shaping rules are the part worth pinning, and a suite that
// exercises the real function beats one that exercises a copy of it.
//
// Nothing in here talks to Express, to Mongo or to a handler. Every function is
// pure: same input, same answer, no side effect.

// Core's own ceiling (ProjectDetailsHandler.MAX_PROJECT_NAME_LENGTH). Repeated
// here rather than imported, because importing it would drag the container into
// this file and cost the whole point of it. Core validates the name again
// anyway, so the two can only disagree by being more strict here, never less.
export const MAX_PROJECT_NAME_CHARS = 150

// The three templates the API accepts, mapped to the methods of
// ProjectCreationHandler.promises. The map is the ONLY way a request can reach a
// method name: the value from the body is a lookup key and never a property
// name, so no caller can name a method of its own.
const TEMPLATES = new Map([
    ['blank', 'createBlankProject'],
    ['basic', 'createBasicProject'],
    ['example', 'createExampleProject'],
])

export const TEMPLATE_NAMES = [...TEMPLATES.keys()]
export const DEFAULT_TEMPLATE = 'basic'

// Trim, collapse the internal whitespace, refuse what is empty or unbounded.
// Collapsing matters for the duplicate guard below: "my  thesis" and "my thesis"
// are the same project name to anyone reading the dashboard, so a retried script
// must not slip a second one through on a doubled space.
export function normaliseName(raw) {
    if (typeof raw !== 'string') return null
    const name = raw.replace(/\s+/g, ' ').trim()
    if (name.length === 0 || name.length > MAX_PROJECT_NAME_CHARS) return null
    return name
}

// An absent template is the default one; anything that is not one of the three
// is null, which the controller turns into a 400. Never a silent fallback: a
// typo in a script must not quietly create the wrong kind of project.
export function resolveTemplate(raw) {
    if (raw === undefined || raw === null || raw === '') {
        return TEMPLATES.get(DEFAULT_TEMPLATE)
    }
    if (typeof raw !== 'string') return null
    return TEMPLATES.get(raw.trim().toLowerCase()) || null
}

// archived and trashed are ARRAYS of user ids on the project document, one entry
// per user who filed the project away, so the answer is per user and not per
// project: the same document is trashed for one collaborator and live for the
// next. Documents older than that migration still carry a plain boolean, which
// is honoured rather than read as "not an array, therefore false".
export function isFiledBy(value, userId) {
    if (typeof value === 'boolean') return value
    if (!Array.isArray(value)) return false
    const target = String(userId)
    return value.some(entry => String(entry) === target)
}

// One entry of GET /api/v1/projects. The two URLs are built here and not by the
// client, so a caller never has to know how this instance spells its own address
// or where the Git Bridge lives.
export function shapeProject(doc, role, userId, siteUrl) {
    const project = doc || {}
    const id = String(project._id || project.id || '')
    const base = baseUrl(siteUrl)
    return {
        id,
        name: typeof project.name === 'string' ? project.name : '',
        role,
        last_updated: asIsoDate(project.lastUpdated),
        archived: isFiledBy(project.archived, userId),
        trashed: isFiledBy(project.trashed, userId),
        url: `${base}/project/${id}`,
        git_url: `${base}/git/${id}`,
    }
}

// The duplicate guard of POST /api/v1/projects. Upstream lets a user own ten
// projects called "notes", so this is a module-level choice: a script that is
// retried after a timeout must not leave a trail of identical projects behind.
// A project trashed for this user does not count, because its name is not one
// they can see any more.
export function findOwnedDuplicate(ownedDocs, name, userId) {
    const wanted = normaliseName(name)
    if (!wanted || !Array.isArray(ownedDocs)) return null
    return (
        ownedDocs.find(
            doc => normaliseName(doc && doc.name) === wanted && !isFiledBy(doc && doc.trashed, userId)
        ) || null
    )
}

function baseUrl(siteUrl) {
    if (typeof siteUrl !== 'string') return ''
    return siteUrl.replace(/\/+$/, '')
}

function asIsoDate(value) {
    if (value === undefined || value === null || value === '') return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
