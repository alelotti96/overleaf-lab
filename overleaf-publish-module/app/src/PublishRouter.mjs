// overleaf-lab: routes for the publish module. Publishing and revoking require
// WRITE access to the project (a read-only collaborator must not be able to
// expose someone else's work); the status is readable by anyone who can read the
// project. The two /published/ routes are the module's entire public surface,
// and both take one key and nothing else: the document's random token, or the
// optional custom name its publisher chose. Both resolve server-side to the same
// document; nothing else about the request is ever read from the URL.
import logger from '@overleaf/logger'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import PublishController from './PublishController.mjs'

export default {
    apply(webRouter, privateApiRouter, publicApiRouter) {
        logger.info({}, '[publish] Registering routes')

        webRouter.post(
            '/project/:Project_id/publish',
            AuthorizationMiddleware.ensureUserCanWriteProjectContent,
            PublishController.publish
        )
        webRouter.post(
            '/project/:Project_id/unpublish',
            AuthorizationMiddleware.ensureUserCanWriteProjectContent,
            PublishController.unpublish
        )
        webRouter.get(
            '/project/:Project_id/publish',
            AuthorizationMiddleware.ensureUserCanReadProject,
            PublishController.status
        )

        // Public BY DESIGN, so they must live on the PUBLIC router: webRouter
        // sits behind the global login wall (every route not whitelisted
        // redirects to /login when public access is off, which on an internet-
        // facing instance it rightly is) and behind CSRF, which would also
        // reject the plain HTML password form. The public API router is where
        // upstream puts its own unauthenticated endpoints (the git-bridge OAuth
        // token route, for one). Express treats the dot as a literal, so :key
        // stops before ".pdf".
        const publicRouter = publicApiRouter || webRouter
        publicRouter.get('/published/:key.pdf', PublishController.servePdf)
        publicRouter.post('/published/:key/auth', PublishController.authenticate)
    },
}
