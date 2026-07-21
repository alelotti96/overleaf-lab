import logger from '@overleaf/logger'
import AuthenticationController from '../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import AuthorizationMiddleware from '../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs'
import LLMChatController from './LLMChatController.mjs'
import LLMSettingsController from './LLMSettingsController.mjs'
import LLMAdminController from './LLMAdminController.mjs'
import LLMComplianceController from './LLMComplianceController.mjs'
import Settings from '@overleaf/settings'
import SessionManager from '../../../../app/src/Features/Authentication/SessionManager.mjs'
import { db as _saDb, ObjectId as _saObjectId } from '../../../../app/src/infrastructure/mongodb.mjs'

// overleaf-lab: gate the LLM admin routes to super_admin only, consistent with
// scripts/patch-super-admin.js (Manage Site / Manage Projects). Checks isAdmin,
// then queries Mongo for the super_admin adminRole (no reliance on session state).
async function ensureUserIsSuperAdmin(req, res, next) {
    const user = SessionManager.getSessionUser(req.session)
    if (!user || user.isAdmin !== true) {
        return res.redirect('/restricted')
    }
    try {
        const dbUser = await _saDb.users.findOne(
            { _id: new _saObjectId(user._id) },
            { projection: { adminRoles: 1 } }
        )
        if (dbUser && dbUser.adminRoles && dbUser.adminRoles.includes('super_admin')) {
            return next()
        }
    } catch (err) {
        logger.error({ err }, '[LLM] DB error checking super_admin role')
    }
    return res.redirect('/restricted')
}

export default {
    apply(webRouter) {
        logger.info(
            {
                allowUserSettings: Settings.llm?.allowUserSettings,
                apiUrl: process.env.LLM_API_URL ? '(set)' : '(not set)',
                apiKey: process.env.LLM_API_KEY ? '(set)' : '(not set)',
                modelName: process.env.LLM_MODEL_NAME,
            },
            '[LLM] Registering routes'
        )

        // Chat and model endpoints (project-scoped)
        webRouter.post(
            '/project/:Project_id/llm/chat',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMChatController.chat
        )
        logger.debug({}, '[LLM] Route registered: POST /project/:id/llm/chat')

        webRouter.get(
            '/project/:Project_id/llm/models',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMChatController.getModels
        )
        logger.debug({}, '[LLM] Route registered: GET /project/:id/llm/models')

        // overleaf-lab: per-feature enable flags for the project UI.
        webRouter.get(
            '/project/:Project_id/llm/features',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMChatController.getFeatures
        )
        logger.debug({}, '[LLM] Route registered: GET /project/:id/llm/features')

        // overleaf-lab: source lines around a compile-error line for "Ask AI about this error"
        webRouter.get(
            '/project/:Project_id/llm/source-context',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMChatController.getSourceContext
        )
        logger.debug({}, '[LLM] Route registered: GET /project/:id/llm/source-context')

        // Inline completion endpoint (project-scoped)
        webRouter.post(
            '/project/:Project_id/llm/completion',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMChatController.completion
        )
        logger.debug({}, '[LLM] Route registered: POST /project/:id/llm/completion')

        // overleaf-lab: document compliance review endpoints (project-scoped)
        webRouter.get(
            '/project/:Project_id/llm/compliance/rubrics',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMComplianceController.getRubrics
        )
        logger.debug({}, '[LLM] Route registered: GET /project/:id/llm/compliance/rubrics')

        webRouter.post(
            '/project/:Project_id/llm/compliance/start',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMComplianceController.startReview
        )
        logger.debug({}, '[LLM] Route registered: POST /project/:id/llm/compliance/start')

        webRouter.get(
            '/project/:Project_id/llm/compliance/status/:jobId',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMComplianceController.statusReview
        )
        logger.debug({}, '[LLM] Route registered: GET /project/:id/llm/compliance/status/:jobId')

        webRouter.post(
            '/project/:Project_id/llm/compliance/cancel/:jobId',
            AuthorizationMiddleware.ensureUserCanReadProject,
            LLMComplianceController.cancelReview
        )
        logger.debug({}, '[LLM] Route registered: POST /project/:id/llm/compliance/cancel/:jobId')

        // User LLM settings (only if allowed)
        if (Settings.llm && Settings.llm.allowUserSettings) {
            webRouter.get(
                '/user/llm-settings',
                AuthenticationController.requireLogin(),
                LLMSettingsController.llmSettingsPage
            )
            logger.debug({}, '[LLM] Route registered: GET /user/llm-settings')
        } else {
            logger.debug(
                { allowUserSettings: Settings.llm?.allowUserSettings },
                '[LLM] Skipping /user/llm-settings route (user settings disabled)'
            )
        }

        webRouter.post(
            '/user/llm-settings/check',
            AuthenticationController.requireLogin(),
            LLMSettingsController.checkLLMConnection
        )
        logger.debug({}, '[LLM] Route registered: POST /user/llm-settings/check')

        webRouter.post(
            '/user/llm-settings/models',
            AuthenticationController.requireLogin(),
            LLMSettingsController.scanUserModels
        )
        logger.debug({}, '[LLM] Route registered: POST /user/llm-settings/models')

        webRouter.post(
            '/user/llm-settings',
            AuthenticationController.requireLogin(),
            LLMSettingsController.saveLLMSettings
        )
        logger.debug({}, '[LLM] Route registered: POST /user/llm-settings')

        logger.info({}, '[LLM] All routes registered successfully')

        // Admin routes
        webRouter.get(
            '/admin/llm/settings',
            ensureUserIsSuperAdmin,
            LLMAdminController.adminSettingsPage
        )
        logger.debug({}, '[LLM] Route registered: GET /admin/llm/settings')

        webRouter.get(
            '/admin/llm/settings/json',
            ensureUserIsSuperAdmin,
            LLMAdminController.getAdminSettings
        )
        logger.debug({}, '[LLM] Route registered: GET /admin/llm/settings/json')

        webRouter.post(
            '/admin/llm/settings',
            ensureUserIsSuperAdmin,
            LLMAdminController.saveAdminSettings
        )
        logger.debug({}, '[LLM] Route registered: POST /admin/llm/settings')

        webRouter.post(
            '/admin/llm/settings/check',
            ensureUserIsSuperAdmin,
            LLMAdminController.checkAdminLLMConnection
        )
        logger.debug({}, '[LLM] Route registered: POST /admin/llm/settings/check')

        webRouter.get(
            '/admin/llm/models',
            ensureUserIsSuperAdmin,
            LLMAdminController.scanAdminModels
        )
        logger.debug({}, '[LLM] Route registered: GET /admin/llm/models')
    },
}
