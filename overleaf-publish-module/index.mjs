// overleaf-lab: "publish document" module. Serves a project's compiled PDF at a
// stable public URL (optionally password protected), independent of the LLM
// module. Opt-in: the instance faces the internet, so nothing is exposed unless
// the operator says so explicitly.
import logger from '@overleaf/logger'

let PublishModule = {}

const publishEnabled = process.env.PUBLISH_ENABLED === 'true'

if (publishEnabled) {
    const { default: PublishRouter } = await import('./app/src/PublishRouter.mjs')
    logger.info({}, '[publish] Module loaded')
    PublishModule = {
        name: 'publish',
        router: PublishRouter,
    }
} else {
    logger.info({}, '[publish] Module NOT loaded (set PUBLISH_ENABLED=true to enable)')
}

export default PublishModule
