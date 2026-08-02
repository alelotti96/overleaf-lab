// overleaf-lab: "acronyms and symbols lists" module. Scans a project and keeps its
// list of acronyms and its list of symbols up to date, deterministically, with no
// language model anywhere in the path.
//
// It is a module of its own and not part of overleaf-llm-image on purpose: the LLM
// image is an optional layer that needs a model server, and there is no reason a
// deployment that never builds it should lose a feature that is pure parsing.
//
// ON BY DEFAULT, unlike the publish module. Publishing puts a document on the open
// internet, so it has to be asked for; this writes only into a project the user
// already has write access to, only when they press a button, and only after they
// confirm. Set LISTS_ENABLED=false to keep the routes unregistered, which also
// makes the toolbar button disappear on its own: it probes its own status route on
// mount and renders nothing when the route is not there.
import logger from '@overleaf/logger'

let ListsModule = {}

const listsEnabled = process.env.LISTS_ENABLED !== 'false'

if (listsEnabled) {
    const { default: ListsRouter } = await import('./app/src/ListsRouter.mjs')
    logger.info({}, '[lists] Module loaded')
    ListsModule = {
        name: 'lists',
        router: ListsRouter,
    }
} else {
    logger.info({}, '[lists] Module NOT loaded (LISTS_ENABLED=false)')
}

export default ListsModule
