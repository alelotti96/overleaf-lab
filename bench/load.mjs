// ===========================================================================
// THE LOADER: the real compliance controller, outside the container.
// ===========================================================================
//
// LLMComplianceController.mjs is ~8700 lines and imports Overleaf internals
// (@overleaf/logger, @overleaf/settings, SessionManager, ProjectEntityHandler)
// plus three siblings that themselves reach Mongo and the mailer. None of that
// exists outside the web container, so the module cannot simply be imported.
//
// WHAT THIS DOES, AND THE RULE IT KEEPS. It reads the controller SOURCE,
// comments out ONLY the import lines that need the container, replaces them
// with stubs declared in an injected prelude, rewrites the safe sibling imports
// to absolute file URLs (so they load FOR REAL from their own directory), leaves
// every other byte intact, appends an export of the internal review entry point,
// and imports the result.
//
// THE RULE IS BINDING: the review loop is never rewritten, re-implemented or
// approximated here. A bench that reimplements the loop measures a different
// program than the one that ships. This exact technique once caught a TDZ bug
// (activeChecks reading `requirements` before its declaration) that `node
// --check` and thirty test suites all missed, because nobody else called
// performReview.
//
// A missing anchor is a LOUD failure, never a silent skip: if the controller
// grows an import this loader has no stub for, loadController throws and names
// it, rather than letting a ReferenceError surface forty passes into a review.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
export const CONTROLLER_PATH = path.resolve(
    REPO,
    'overleaf-llm-image/vendor/llm/app/src/LLMComplianceController.mjs'
)
const CONTROLLER_DIR = path.dirname(CONTROLLER_PATH)

// The shipped prompt defaults. Dependency-free module, so it loads for real and
// the bench runs the same system prompt a production review runs.
const PROMPTS = await import(
    pathToFileURL(path.join(CONTROLLER_DIR, 'LLMPrompts.mjs')).href
)

// The synthetic file store. Nothing is ever sent there: the bench fetch below
// answers these URLs from disk, which is how figure measurement works offline.
const BENCH_FILESTORE = 'http://bench.filestore.invalid'

// ---------------------------------------------------------------------------
// import classification
// ---------------------------------------------------------------------------

// Container-only by specifier shape: the Overleaf packages and any path that
// climbs out of the module directory into the web app sources.
const NEEDS_CONTAINER = spec =>
    /^@overleaf\//.test(spec) || /(^|\/)app\/src\//.test(spec) || /^\.\.\//.test(spec)

// Siblings that live next to the controller but pull the container in with them
// (Mongo store, mailer, the admin settings reader). Stubbed, not loaded.
const STUBBED_SIBLINGS = new Set([
    './LLMAdminController.mjs',
    './LLMComplianceStore.mjs',
    './LLMComplianceMailer.mjs',
])

const IMPORT_LINE = /^import\s+(?:(.+?)\s+from\s+)?['"]([^'"]+)['"];?\s*$/

// The identifiers an import clause binds, so the prelude can declare exactly
// those and no more. Handles `X`, `{ a, b as c }`, `X, { a }` and `* as X`.
function boundNames(clause) {
    if (!clause) {
        return []
    }
    const names = []
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
    if (namespace) {
        names.push(namespace[1])
    }
    const braced = clause.match(/\{([^}]*)\}/)
    if (braced) {
        for (const part of braced[1].split(',')) {
            const piece = part.trim()
            if (!piece) continue
            const alias = piece.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
            names.push(alias ? alias[1] : piece)
        }
    }
    const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '')
    for (const piece of head.split(',')) {
        const trimmed = piece.trim()
        if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
            names.push(trimmed)
        }
    }
    return names
}

// ---------------------------------------------------------------------------
// the stubs
// ---------------------------------------------------------------------------

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

function makeLogger(level = 'warn', sink = console) {
    const threshold = LEVELS[level] === undefined ? LEVELS.warn : LEVELS[level]
    const records = []
    const emit = (name, weight) => (context, message) => {
        const text = typeof context === 'string' ? context : message
        records.push({ level: name, message: text, context: typeof context === 'string' ? null : context })
        if (weight < threshold) {
            return
        }
        const detail =
            context && typeof context === 'object'
                ? Object.entries(context)
                      .filter(([key]) => key !== 'err')
                      .map(([key, value]) => `${key}=${short(value)}`)
                      .join(' ')
                : ''
        sink.error(`  [${name}] ${text || ''}${detail ? `  ${detail}` : ''}`)
        if (context && context.err) {
            sink.error(`         ${context.err.message || context.err}`)
        }
    }
    return {
        records,
        debug: emit('debug', LEVELS.debug),
        info: emit('info', LEVELS.info),
        warn: emit('warn', LEVELS.warn),
        error: emit('error', LEVELS.error),
        fatal: emit('error', LEVELS.error),
        err: emit('error', LEVELS.error),
    }
}

const short = value => {
    if (value === null || value === undefined) return String(value)
    if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 80)}...` : value
    if (typeof value === 'object') {
        try {
            const text = JSON.stringify(value)
            return text.length > 80 ? `${text.slice(0, 80)}...` : text
        } catch (err) {
            return '[object]'
        }
    }
    return String(value)
}

// An inert module that RECORDS. Every method answers like a successful no-op and
// every call is kept, so a bench run can say what the review asked the store or
// the mailer to do without any of it happening.
function makeRecorder(name, explicit = {}) {
    const calls = []
    const target = { __calls: calls, __name: name, ...explicit }
    return new Proxy(target, {
        get(object, property) {
            // Never answer `then`: an accidental `await store` would otherwise
            // see a thenable and hang on a promise nobody resolves.
            if (typeof property !== 'string' || property === 'then') {
                return object[property]
            }
            if (property in object) {
                const value = object[property]
                if (typeof value !== 'function' || property.startsWith('__')) {
                    return value
                }
                return (...args) => {
                    calls.push({ method: property, args })
                    return value(...args)
                }
            }
            return (...args) => {
                calls.push({ method: property, args, unknown: true })
                return Promise.resolve(null)
            }
        },
    })
}

// ---------------------------------------------------------------------------
// the fetch layer
// ---------------------------------------------------------------------------
//
// THE enable_thinking TRAP. This controller deliberately does NOT send
// chat_template_kwargs: on the lab install an llm router sits in front of the
// backends and injects enable_thinking:false there (see the comment at the
// compliance_review request body). Pointed straight at a llama.cpp server there
// is no router, the model reasons aloud, the grammar-constrained content comes
// back empty and the review degrades to n.a. (measured: 14 of 20 requirements
// lost). So the bench puts the field back at the fetch layer, where the router
// would have, and nowhere near the review loop.
function makeBenchFetch({ underlying, injectChatTemplateKwargs, chatTemplateKwargs, files, log }) {
    return async function benchFetch(url, options = {}) {
        const target = String(url)

        // The synthetic file store: figure bytes served from disk, no socket.
        if (target.startsWith(BENCH_FILESTORE)) {
            const id = target.slice(target.lastIndexOf('/') + 1)
            const entry = files.get(id)
            if (!entry) {
                log.push({ url: target, kind: 'filestore', ok: false, status: 404, ms: 0 })
                return new Response('not found', { status: 404 })
            }
            const started = Date.now()
            const bytes = fs.readFileSync(entry.diskPath)
            log.push({
                url: target,
                kind: 'filestore',
                path: entry.path,
                ok: true,
                status: 200,
                bytes: bytes.length,
                ms: Date.now() - started,
            })
            return new Response(bytes, {
                status: 200,
                headers: { 'content-length': String(bytes.length) },
            })
        }

        let effective = options
        let schema = null
        const isChat = /\/chat\/completions(\?|$)/.test(target)
        if (isChat && typeof options.body === 'string') {
            let body = null
            try {
                body = JSON.parse(options.body)
            } catch (err) {
                body = null
            }
            if (body) {
                schema = body.response_format?.json_schema?.name || null
                if (injectChatTemplateKwargs) {
                    const existing = body.chat_template_kwargs
                    if (!existing || typeof existing !== 'object') {
                        body.chat_template_kwargs = { ...chatTemplateKwargs }
                    } else {
                        body.chat_template_kwargs = { ...chatTemplateKwargs, ...existing }
                    }
                    effective = { ...options, body: JSON.stringify(body) }
                }
            }
        }

        const started = Date.now()
        const entry = {
            url: target,
            kind: isChat ? 'chat' : kindOf(target),
            schema,
            method: (options.method || 'GET').toUpperCase(),
            requestBytes: typeof effective.body === 'string' ? effective.body.length : 0,
            startedAt: started,
        }
        log.push(entry)
        try {
            const response = await underlying(url, effective)
            entry.ms = Date.now() - started
            entry.status = response.status
            entry.ok = response.ok
            return response
        } catch (err) {
            entry.ms = Date.now() - started
            entry.ok = false
            entry.error = err.name === 'AbortError' ? 'aborted' : err.message
            throw err
        }
    }
}

const kindOf = url => {
    if (/\/tokenize(\?|$)/.test(url)) return 'tokenize'
    if (/\/models(\?|$)/.test(url)) return 'models'
    return 'other'
}

// ---------------------------------------------------------------------------
// the source transform
// ---------------------------------------------------------------------------

// The names the appended export block exposes. performReview is required (the
// bench exists to call it); the rest are exported when present, because they are
// useful to inspect and harmless to miss.
const REQUIRED_EXPORTS = ['performReview']
const OPTIONAL_EXPORTS = [
    'runReviewPasses',
    'splitRubric',
    'estimateTokens',
    'buildSkeleton',
    'readProjectSources',
    'refreshReviewEndpoints',
    'recordReviewOutcome',
    'detectRubricLanguage',
]

export function transformSource(source, { token, stubNames }) {
    const lines = source.split('\n')
    const stubbed = []
    const rewritten = []
    let lastImportLine = -1

    for (let i = 0; i < lines.length; i += 1) {
        const match = IMPORT_LINE.exec(lines[i])
        if (!match) {
            continue
        }
        const [, clause, spec] = match
        lastImportLine = i
        if (/^node:/.test(spec)) {
            continue
        }
        if (NEEDS_CONTAINER(spec) || STUBBED_SIBLINGS.has(spec)) {
            const names = boundNames(clause)
            stubbed.push({ spec, names, line: i })
            lines[i] = `// [bench] container-only import stubbed: ${lines[i]}`
            continue
        }
        if (/^\.\//.test(spec)) {
            // A sibling that loads for real. Only the specifier changes, so the
            // module the bench runs is byte-for-byte the shipped one.
            const absolute = pathToFileURL(path.resolve(CONTROLLER_DIR, spec)).href
            lines[i] = lines[i].replace(spec, absolute)
            rewritten.push(spec)
        }
    }

    if (lastImportLine === -1) {
        throw new Error('bench loader: no import lines found in the controller, the anchor moved')
    }

    const declared = []
    const missing = []
    for (const entry of stubbed) {
        for (const name of entry.names) {
            if (!stubNames.has(name)) {
                missing.push(`${name} (from ${entry.spec})`)
                continue
            }
            declared.push(`const ${name} = __BENCH.stubs.${name}`)
        }
    }
    if (missing.length > 0) {
        throw new Error(
            'bench loader: the controller imports something this loader has no stub for: ' +
                `${missing.join(', ')}. Add it to buildStubs() in bench/load.mjs.`
        )
    }

    const prelude = [
        '',
        '// ===== bench harness prelude, injected by bench/load.mjs =====',
        `const __BENCH = globalThis.__OVERLEAF_BENCH_CTX__.get(${JSON.stringify(token)})`,
        ...declared,
        // Shadows the global fetch for this module only. fetchWithLimit and the
        // default parameter of makeReviewFetch both read this binding, so every
        // call the review makes goes through the bench fetch.
        'const fetch = __BENCH.fetch',
        '// ===== end bench harness prelude =====',
        '',
    ].join('\n')
    lines.splice(lastImportLine + 1, 0, prelude)

    const exported = [...REQUIRED_EXPORTS]
    for (const name of REQUIRED_EXPORTS) {
        if (!new RegExp(`function\\s+${name}\\s*\\(`).test(source)) {
            throw new Error(`bench loader: ${name} is not in the controller any more, find its new name`)
        }
    }
    for (const name of OPTIONAL_EXPORTS) {
        if (new RegExp(`function\\s+${name}\\s*\\(`).test(source)) {
            exported.push(name)
        }
    }

    const tail = [
        '',
        '// ===== bench harness exports, appended by bench/load.mjs =====',
        `export { ${exported.join(', ')} }`,
        '',
    ].join('\n')

    return {
        code: lines.join('\n') + tail,
        stubbed: stubbed.map(entry => entry.spec),
        loadedForReal: rewritten,
        exported,
    }
}

// ---------------------------------------------------------------------------
// the stub set
// ---------------------------------------------------------------------------

function buildStubs(options) {
    const {
        docs = [],
        files = [],
        rubrics = [],
        endpoints = [],
        llmApiUrl = null,
        llmApiKey = null,
        reviewModel = '',
        reviewModelBackup = '',
        maxContextTokens = 32000,
        reviewMaxTokens = 12000,
        siteUrl = '',
        logLevel = 'warn',
        onProgress = null,
        prompts = {},
    } = options

    const logger = makeLogger(logLevel)

    // The project, in the two shapes Overleaf hands the controller: docs (the
    // editable text ones) and files (everything else, read through the file
    // store). Both come from disk here.
    const docsByPath = {}
    for (const doc of docs) {
        docsByPath[doc.path] = { lines: String(doc.text).split('\n') }
    }
    const filesById = new Map()
    const filesByPath = {}
    for (const file of files) {
        const id = crypto.createHash('sha1').update(file.path).digest('hex').slice(0, 24)
        filesById.set(id, file)
        filesByPath[file.path] = {
            _id: id,
            hash: file.hash || null,
            size: typeof file.size === 'number' ? file.size : undefined,
        }
    }

    const ProjectEntityHandler = {
        promises: {
            getAllDocs: async () => docsByPath,
            getAllFiles: async () => filesByPath,
        },
    }

    const store = makeRecorder('ComplianceStore', {
        rubricFingerprint: guidelines =>
            crypto.createHash('sha1').update(String(guidelines || '')).digest('hex'),
        updateJobProgressQuietly: async (jobId, progress) => {
            if (onProgress) {
                onProgress(progress)
            }
            return null
        },
        saveReportQuietly: async () => null,
        saveFailureQuietly: async () => null,
        forgetJobQuietly: async () => null,
        markJobStatusQuietly: async () => null,
        rememberJobQuietly: async () => null,
        findLatestRecordQuietly: async () => null,
        // The boot resume must find nothing to adopt: the bench owns the one job
        // it runs and nothing else is owed.
        claimInterruptedJobs: async () => [],
    })

    const mailer = makeRecorder('ComplianceMailer', {
        isEmailConfigured: () => false,
        notifyReviewFinishedQuietly: async () => null,
    })

    const admin = {
        llmApiUrl,
        llmApiKey,
        allowedModels: reviewModel ? [reviewModel] : [],
        completionModel: '',
        reviewModel,
        reviewModelBackup,
        reviewEndpoints: endpoints,
        maxContextTokens,
        reviewMaxTokens,
        chatEnabled: true,
        completionEnabled: true,
        reviewEnabled: true,
    }

    const effectivePrompts = {
        askAiSystemPrompt: PROMPTS.DEFAULT_ASK_AI_SYSTEM_PROMPT,
        errorPrompt: PROMPTS.DEFAULT_ERROR_PROMPT,
        reviewSystemPrompt: PROMPTS.DEFAULT_REVIEW_SYSTEM_PROMPT,
        completionSystemPrompt: PROMPTS.DEFAULT_COMPLETION_SYSTEM_PROMPT,
        askAiActionPrompts: PROMPTS.DEFAULT_ASK_AI_ACTION_PROMPTS,
        ...prompts,
    }

    return {
        logger,
        Settings: {
            siteUrl,
            // The synthetic file store, served from disk by the bench fetch. No
            // v1_history entry on purpose: the history strategy dynamically
            // imports ProjectGetter, which is container-only.
            apis: { filestore: { url: BENCH_FILESTORE } },
            llm: { enabled: true },
        },
        expressify: handler => handler,
        SessionManager: {
            getLoggedInUserId: req => (req && req.session && req.session.userId) || 'bench-user',
        },
        ProjectEntityHandler,
        getAdminLLMSettings: async () => admin,
        getComplianceRubrics: async () => rubrics,
        getLLMFeatureFlags: async () => ({
            chatEnabled: true,
            completionEnabled: true,
            reviewEnabled: true,
        }),
        getLLMPrompts: async () => effectivePrompts,
        ComplianceStore: store,
        ComplianceMailer: mailer,
        // not a stub of an import, carried through for the bench's own use
        __filesById: filesById,
        __admin: admin,
        __prompts: effectivePrompts,
    }
}

// ---------------------------------------------------------------------------
// loadController
// ---------------------------------------------------------------------------

let loadCounter = 0

/**
 * Load the real compliance controller with the container-only pieces stubbed.
 *
 * overrides:
 *   docs            [{path, text}]   the project, as ProjectEntityHandler.getAllDocs would give it
 *   files           [{path, diskPath, size}]  binary project files, served from disk
 *   rubrics         [{id, name, guidelines, scanPatterns}]
 *   endpoints       [{id, label, url, model, modelBackup}]  the review backend pool
 *   llmApiUrl       string           legacy single-backend address (defaults to endpoints[0].url)
 *   reviewModel     string           model alias (defaults to endpoints[0].model)
 *   fetch           function         underlying fetch; defaults to the global one
 *   injectChatTemplateKwargs boolean defaults to true unless the controller sends the field itself
 *   languageToolUrl string           LanguageTool endpoint; DISABLED unless set
 *   bibVerifyMailto string           Crossref contact; bibliography check DISABLED unless set
 *   logLevel        debug|info|warn|error|silent
 *   onProgress      function({passesDone, passesTotal, currentRequirement})
 */
export async function loadController(overrides = {}) {
    const source = fs.readFileSync(CONTROLLER_PATH, 'utf8')
    const token = `bench-${process.pid}-${(loadCounter += 1)}-${Date.now()}`

    const endpoints = overrides.endpoints || []
    const first = endpoints[0] || {}
    const stubs = buildStubs({
        ...overrides,
        endpoints,
        llmApiUrl: overrides.llmApiUrl || first.url || null,
        reviewModel: overrides.reviewModel || first.model || '',
        reviewModelBackup: overrides.reviewModelBackup || first.modelBackup || '',
    })

    // The two outbound checks that leave the machine, both off unless asked for.
    // Read from process.env at call time by their modules, so setting them here,
    // before the controller is evaluated, is what decides them.
    if (overrides.languageToolUrl) {
        process.env.LLM_LANGUAGETOOL_URL = overrides.languageToolUrl
    } else {
        delete process.env.LLM_LANGUAGETOOL_URL
    }
    if (overrides.bibVerifyMailto) {
        process.env.LLM_BIB_VERIFY_MAILTO = overrides.bibVerifyMailto
    } else {
        delete process.env.LLM_BIB_VERIFY_MAILTO
    }

    // Does the controller send chat_template_kwargs itself? Checked, not assumed:
    // the day it does, the wrapper must stop adding it (it would then be the
    // controller's field, and two of them is a merge nobody asked for).
    const controllerSendsChatTemplateKwargs = /chat_template_kwargs\s*:/.test(source)
    const injectChatTemplateKwargs =
        overrides.injectChatTemplateKwargs !== undefined
            ? overrides.injectChatTemplateKwargs
            : !controllerSendsChatTemplateKwargs

    const fetchLog = []
    const benchFetch = makeBenchFetch({
        underlying: overrides.fetch || ((url, init) => globalThis.fetch(url, init)),
        injectChatTemplateKwargs,
        chatTemplateKwargs: overrides.chatTemplateKwargs || { enable_thinking: false },
        files: stubs.__filesById,
        log: fetchLog,
    })

    const stubNames = new Set(
        Object.keys(stubs).filter(name => !name.startsWith('__'))
    )
    const transformed = transformSource(source, { token, stubNames })

    if (!globalThis.__OVERLEAF_BENCH_CTX__) {
        globalThis.__OVERLEAF_BENCH_CTX__ = new Map()
    }
    globalThis.__OVERLEAF_BENCH_CTX__.set(token, { stubs, fetch: benchFetch })

    const tempPath = path.join(os.tmpdir(), `overleaf-bench-controller-${token}.mjs`)
    fs.writeFileSync(tempPath, transformed.code, 'utf8')
    let module
    try {
        module = await import(pathToFileURL(tempPath).href)
    } finally {
        try {
            fs.unlinkSync(tempPath)
        } catch (err) {
            // The module is already loaded; a leftover temp file is not a failure.
        }
    }

    return {
        // the review entry point, exactly as processQueue calls it
        performReview: module.performReview,
        module,
        stubs,
        logger: stubs.logger,
        store: stubs.ComplianceStore,
        mailer: stubs.ComplianceMailer,
        fetchLog,
        controllerSendsChatTemplateKwargs,
        injectChatTemplateKwargs,
        transform: {
            stubbed: transformed.stubbed,
            loadedForReal: transformed.loadedForReal,
            exported: transformed.exported,
        },
        /**
         * A job in the shape startReview builds and processQueue hands over.
         * The endpoint is set explicitly, which is what pickup does, so nothing
         * depends on the module-level pool snapshot being refreshed first.
         */
        makeJob(job = {}) {
            const endpoint =
                job.endpoint ||
                (endpoints.length > 0
                    ? {
                          id: endpoints[0].id || 'bench',
                          label: endpoints[0].label || 'bench',
                          url: endpoints[0].url || null,
                          model: endpoints[0].model || null,
                          modelBackup: endpoints[0].modelBackup || null,
                      }
                    : null)
            return {
                id: job.id || `bench-job-${Date.now()}`,
                projectId: job.projectId || 'benchproject000000000001',
                userId: job.userId || 'benchuser0000000000000001',
                rubricId: job.rubricId || (overrides.rubrics && overrides.rubrics[0]?.id) || 'bench',
                rubricName: job.rubricName || 'bench',
                rubricFingerprint: 'bench',
                // The panel asks the user to confirm a document-type mismatch; a
                // bench run has nobody to ask, so it defaults to confirmed and
                // the type gate is skipped. Pass confirmed:false to exercise it.
                confirmed: job.confirmed !== undefined ? job.confirmed : true,
                mode: job.mode || 'full',
                status: 'running',
                result: null,
                errorCode: null,
                message: null,
                documentTokensEstimate: null,
                maxContextTokens: null,
                reviewMaxTokens: null,
                controller: job.controller || new AbortController(),
                endpoint,
                createdAt: Date.now(),
                startedAt: Date.now(),
                finishedAt: null,
                passesTotal: null,
                passesDone: 0,
                currentRequirement: '',
            }
        },
        dispose() {
            globalThis.__OVERLEAF_BENCH_CTX__.delete(token)
        },
    }
}

export { BENCH_FILESTORE, makeLogger }
