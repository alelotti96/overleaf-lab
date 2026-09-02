// overleaf-lab: routes for the projects API. All three live on the PUBLIC API
// router, which is where they belong and the only place they work: webRouter
// sits behind the login wall (a CLI has no session to redirect to /login with)
// and behind CSRF, which would reject a POST carrying no token from a form. The
// public router is where upstream puts its own unauthenticated endpoints, the
// git-bridge OAuth token route among them, and JSON bodies are parsed globally
// so req.body works here just as it does on the web router.
//
// Every route carries the same two middlewares in the same order: rate limit
// first, then the token. Rate limiting before authentication is deliberate, so
// that a flood of INVALID tokens is limited too; the other way round the cheap
// path would be the unlimited one.
import logger from '@overleaf/logger'
import { RateLimiter } from '../../../../app/src/infrastructure/RateLimiter.mjs'
import RateLimiterMiddleware from '../../../../app/src/Features/Security/RateLimiterMiddleware.mjs'
import ProjectsApiAuth from './ProjectsApiAuth.mjs'
import ProjectsApiController from './ProjectsApiController.mjs'

// Creation is the expensive one and the one a broken script repeats, so it gets
// the tighter budget. Reads are cheap and a listing is what a shell prompt or a
// tab completion would call, so they get a wider one. Per IP: the caller is a
// token holder, not a session, and the point is to bound the machine.
const createRateLimiter = new RateLimiter('projects-api-create', { points: 30, duration: 60 })
const readRateLimiter = new RateLimiter('projects-api-read', { points: 120, duration: 60 })

export default {
    apply(webRouter, privateApiRouter, publicApiRouter) {
        logger.info({}, '[projects-api] Registering routes')

        const router = publicApiRouter || webRouter
        const readLimit = RateLimiterMiddleware.rateLimit(readRateLimiter, { ipOnly: true })
        const createLimit = RateLimiterMiddleware.rateLimit(createRateLimiter, { ipOnly: true })

        router.get('/api/v1/whoami', readLimit, ProjectsApiAuth.requireToken, ProjectsApiController.whoami)
        router.get('/api/v1/projects', readLimit, ProjectsApiAuth.requireToken, ProjectsApiController.list)
        router.post('/api/v1/projects', createLimit, ProjectsApiAuth.requireToken, ProjectsApiController.create)
    },
}
