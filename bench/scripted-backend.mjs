// ===========================================================================
// A BACKEND THAT ANSWERS FROM THE SCHEMA IT WAS SENT.
// ===========================================================================
//
// Used by the smoke test and by `run.mjs --dry-run`. It is not a model and does
// not pretend to be one: it answers every /chat/completions call with the
// smallest object the request's own JSON schema allows, which is what a
// grammar-constrained backend is guaranteed to produce. That keeps the stub
// honest across changes: a schema the controller edits produces a differently
// shaped answer here too, instead of a canned string that quietly stops fitting.
//
// It also mirrors the two things a bare llama.cpp does that a router hides:
// /tokenize is absent (404, so the review falls back to estimateTokens) and
// /models lists exactly the one alias it serves.

const ENUM_PREFERENCE = {
    status: 'ok',
    violates: 'no',
    refuted: 'none',
    verdict: 'yes',
    ok: 'yes',
}

const STRING_FILLER = {
    analysis: 'Ho letto il documento per intero e ho elencato le occorrenze pertinenti.',
    requirement: 'requisito riformulato',
    evidence: "Controllato l'intero documento, nessuna occorrenza contraria al requisito.",
    suggestion: '',
    reason: 'la struttura corrisponde a quella attesa',
    summary: 'Risposta di prova: nessun modello ha prodotto questo report.',
}

export function fromSchema(schema, context = {}) {
    if (!schema || typeof schema !== 'object') {
        return null
    }
    if (schema.enum && schema.enum.length > 0) {
        const preferred = ENUM_PREFERENCE[context.property]
        return schema.enum.includes(preferred) ? preferred : schema.enum[0]
    }
    switch (schema.type) {
        case 'array': {
            // minItems is what schemaForBatch pins when a call asks N questions.
            const count = schema.minItems || 1
            return Array.from({ length: count }, (unused, index) =>
                fromSchema(schema.items, { ...context, index: index + 1 })
            )
        }
        case 'integer':
        case 'number':
            // The candidate schema requires the answer to say which question it
            // belongs to, and the code maps answers by that number.
            return context.property === 'index' ? context.index || 1 : 0
        case 'object': {
            const object = {}
            for (const property of schema.required || Object.keys(schema.properties || {})) {
                object[property] = fromSchema(schema.properties[property], { ...context, property })
            }
            return object
        }
        default: {
            const filler = STRING_FILLER[context.property]
            return filler === undefined ? 'testo' : filler
        }
    }
}

export function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    })
}

/**
 * @param model the alias /models declares
 * @param answer optional (schemaName, requestBody) => object, to script one call
 *               specially; returning null falls back to the schema-derived answer
 */
export function makeScriptedBackend(model, answer = () => null) {
    const seen = { chatBodies: [], urls: [] }
    const fetchImpl = async (url, options = {}) => {
        const target = String(url)
        seen.urls.push(target)

        if (/\/tokenize$/.test(target)) {
            return new Response('not found', { status: 404 })
        }
        if (/\/models$/.test(target)) {
            return jsonResponse({ data: [{ id: model }] })
        }
        if (!/\/chat\/completions$/.test(target)) {
            throw new Error(`the scripted backend was asked for ${target}`)
        }

        const body = JSON.parse(options.body)
        seen.chatBodies.push(body)
        const schema = body.response_format?.json_schema
        const scripted = answer(schema?.name || null, body)
        return jsonResponse({
            choices: [
                {
                    message: { content: JSON.stringify(scripted || fromSchema(schema?.schema)) },
                    finish_reason: 'stop',
                },
            ],
            // llama.cpp reports these on every response and the controller
            // calibrates its per-pass timeout from them.
            timings: {
                prompt_n: 4096,
                prompt_per_second: 900,
                predicted_n: 300,
                predicted_per_second: 30,
            },
        })
    }
    return { fetchImpl, seen }
}
