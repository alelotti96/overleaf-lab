// overleaf-lab: "projects API" module. Three JSON endpoints that let a script
// create and list projects with the personal access token the user already has
// for the Git Bridge, so `ol new "cubaco-pdr"` can create a project and clone it
// without a browser. That matters here because the instance sits behind OIDC:
// there is no username and password to automate, and the workaround so far was a
// stock of empty projects made by hand.
//
// The module owns no token UI, no schema and no frontend. It reuses the
// git-bridge token store and the core project handlers, which is also why it
// refuses to load without the Git Bridge: its tokens are the only credential
// this API accepts.
//
// Opt-in, like the publish module: an instance that faces the internet gains no
// new route unless the operator asks for it.
import logger from '@overleaf/logger'

let ProjectsApiModule = {}

const projectsApiEnabled = process.env.PROJECTS_API_ENABLED === 'true'
const gitBridgeEnabled = process.env.GIT_BRIDGE_ENABLED === 'true'

if (projectsApiEnabled && gitBridgeEnabled) {
    const { default: ProjectsApiRouter } = await import('./app/src/ProjectsApiRouter.mjs')
    logger.info({}, '[projects-api] Module loaded')
    ProjectsApiModule = {
        name: 'projects-api',
        router: ProjectsApiRouter,
    }
} else if (projectsApiEnabled) {
    // One line, and it names the variable to look at: a module that loaded and
    // then rejected every request would be much harder to diagnose than one that
    // says on startup why it is not there.
    logger.error(
        {},
        '[projects-api] Module NOT loaded: GIT_BRIDGE_ENABLED is not "true" and git tokens are the only credential this API accepts'
    )
} else {
    logger.info({}, '[projects-api] Module NOT loaded (set PROJECTS_API_ENABLED=true to enable)')
}

export default ProjectsApiModule
