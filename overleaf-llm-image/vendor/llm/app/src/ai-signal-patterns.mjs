// overleaf-lab: the default pattern lists behind the "AI writing signals" section.
//
// DATA ONLY. Nothing here decides anything: the lists are read by LLMAISignals.mjs,
// which counts, compares against the document's own baseline and reports. A pattern
// firing once is never reported, so this file is allowed to be generous.
//
// DATED, BECAUSE IT ROTS. Model style moves, and a list written against one
// generation of models is a list of yesterday's habits. The version below is what a
// stored report carries, so an old report can still be read for what it was: the
// signals a reader would have looked at in August 2026, not a timeless judgement.
//
// BOTH LANGUAGES, ALWAYS APPLIED. An Italian pattern over English prose simply does
// not match, so there is nothing to gain from guessing the language first and a real
// failure mode to avoid: a thesis written in English with an Italian abstract, or the
// other way round, would have half its text scanned with the wrong list.
//
// PROVENANCE. The English list is the measured one: the excess-vocabulary study over
// 15M PubMed abstracts (Kobak et al.) named delve, showcase, underscore, testament,
// pivotal, intricate, meticulous, boasts and the "not only ... but also" frame as the
// words whose frequency jumped after 2022. The Italian list has no corpus study
// behind it and is curated: treat it as weaker evidence, which is exactly why no
// single hit is ever reported.

export const AI_SIGNAL_PATTERNS_VERSION = '2026-08'

// overleaf-lab: word edges that survive accented letters. `\b` is defined over ASCII
// word characters, so `\bimportante` after "e'" behaves, but `\bè` does NOT: the
// boundary asks for a word character next to `è`, which is not one under `\b`, and the
// pattern silently never matches. Unicode property guards say what was meant.
const OPEN = String.raw`(?<![\p{L}\p{N}])`
const CLOSE = String.raw`(?![\p{L}\p{N}])`
const marker = body => `${OPEN}(?:${body})${CLOSE}`

// overleaf-lab: the gap inside a split frame ("not only X but also Y"). Bounded and
// sentence-local on purpose: `[^.]{0,120}` cannot backtrack into the next sentence and
// cannot backtrack exponentially, which matters because these run over student text
// with no way to time a match out.
const GAP = String.raw`[^.]{0,120}?`

// overleaf-lab: stock phrasing. Each entry is one PHENOMENON, not one wording: the
// aggregator suppresses overlapping matches, so a longer phrase that contains a
// shorter one ("plays a crucial role" over "crucial") counts once, not twice.
export const LEXICAL_PATTERNS = [
    // ---- English: the measured list ----
    { id: 'en-delve', lang: 'en', label: 'delve into', source: marker(String.raw`delv(?:e|es|ed|ing)`) },
    { id: 'en-showcase', lang: 'en', label: 'showcase', source: marker(String.raw`showcas(?:e|es|ed|ing)`) },
    {
        id: 'en-underscore',
        lang: 'en',
        label: 'underscores (as a verb)',
        source: marker(String.raw`underscor(?:e|es|ed|ing)\s+(?:the|a|an|its|their|our|how|that|this)`),
    },
    { id: 'en-testament', lang: 'en', label: 'a testament to', source: marker(String.raw`(?:a|is a)\s+testament\s+to`) },
    { id: 'en-tapestry', lang: 'en', label: 'tapestry', source: marker(String.raw`tapestr(?:y|ies)`) },
    { id: 'en-pivotal', lang: 'en', label: 'pivotal', source: marker(String.raw`pivotal`) },
    { id: 'en-crucial', lang: 'en', label: 'crucial', source: marker(String.raw`crucial(?:ly)?`) },
    { id: 'en-intricate', lang: 'en', label: 'intricate', source: marker(String.raw`intricate(?:ly)?`) },
    {
        id: 'en-landscape',
        lang: 'en',
        // The literal landscape of a photograph, or `\usepackage{landscape}`, must not
        // count: only the figurative frames do.
        label: 'landscape (figurative)',
        source: marker(
            String.raw`(?:(?:ever[-\s]?(?:changing|evolving)|evolving|current|modern|digital|technological|academic|competitive|research|shifting)\s+landscape|landscape\s+of\s+\p{L}+)`
        ),
    },
    { id: 'en-meticulous', lang: 'en', label: 'meticulous', source: marker(String.raw`meticulous(?:ly)?`) },
    { id: 'en-boasts', lang: 'en', label: 'boasts', source: marker(String.raw`boast(?:s|ing)`) },
    {
        id: 'en-not-only-but-also',
        lang: 'en',
        label: 'not only ... but also',
        source: marker(String.raw`not\s+only${GAP}but\s+also`),
    },
    { id: 'en-additionally', lang: 'en', label: 'additionally,', source: marker(String.raw`additionally\s*,`) },
    {
        id: 'en-important-to-note',
        lang: 'en',
        label: 'it is important to note',
        source: marker(String.raw`it\s+is\s+(?:important|worth|essential|crucial)\s+(?:to\s+note|noting|to\s+mention)`),
    },
    {
        id: 'en-crucial-role',
        lang: 'en',
        label: 'plays a crucial role',
        source: marker(
            String.raw`play(?:s|ed|ing)?\s+an?\s+(?:crucial|pivotal|vital|key|significant|important|central)\s+role`
        ),
    },
    // 'moreover / furthermore' was removed after measuring its natural base rate
    // on 75 published pre-2023 theses of this domain: 88% of HUMAN documents use
    // it (median 2.3 hits per 10k words, flat across the AI epoch boundary). A
    // marker most humans trip is not a marker, it is cluster fuel for false
    // positives next to a student's name.

    // ---- Italian: the curated list ----
    {
        id: 'it-importante-sottolineare',
        lang: 'it',
        label: 'è importante sottolineare',
        source: marker(String.raw`(?:è|e')\s+importante\s+(?:sottolineare|notare|evidenziare|ricordare|precisare)`),
    },
    {
        id: 'it-ruolo-cruciale',
        lang: 'it',
        label: 'gioca / riveste un ruolo cruciale',
        source: marker(
            String.raw`(?:gioca|giocano|riveste|rivestono|svolge|svolgono|assume|assumono)\s+un\s+ruolo\s+(?:cruciale|chiave|centrale|determinante|primario)`
        ),
    },
    {
        id: 'it-ruolo-fondamentale',
        lang: 'it',
        label: 'riveste un ruolo fondamentale',
        source: marker(
            String.raw`(?:gioca|giocano|riveste|rivestono|svolge|svolgono|assume|assumono|ha|hanno)\s+un\s+ruolo\s+fondamentale`
        ),
    },
    {
        id: 'it-mondo-in-evoluzione',
        lang: 'it',
        label: 'in un mondo / panorama in continua evoluzione',
        source: marker(
            String.raw`in\s+un\s+(?:mondo|panorama|contesto|scenario|settore|ambito)\s+in\s+(?:continua|costante|rapida)\s+(?:evoluzione|crescita|trasformazione|cambiamento)`
        ),
    },
    {
        id: 'it-non-solo-ma-anche',
        lang: 'it',
        label: 'non solo ... ma anche',
        source: marker(String.raw`non\s+solo${GAP}ma\s+anche`),
    },
    {
        id: 'it-vale-la-pena',
        lang: 'it',
        label: 'vale la pena notare',
        source: marker(String.raw`vale\s+la\s+pena\s+(?:di\s+)?(?:notare|sottolineare|ricordare|evidenziare|menzionare)`),
    },
    {
        id: 'it-testimonianza-di',
        lang: 'it',
        label: 'testimonianza di',
        source: marker(String.raw`testimonianza\s+(?:di|del|dello|della|dei|degli|delle)`),
    },
    {
        id: 'it-sbloccare-potenziale',
        lang: 'it',
        label: 'sbloccare il potenziale',
        source: marker(String.raw`sblocca(?:re|ndo|no)?\s+(?:il\s+|un\s+)?(?:pieno\s+|vero\s+)?potenziale`),
    },
    { id: 'it-cuore-pulsante', lang: 'it', label: 'cuore pulsante', source: marker(String.raw`cuore\s+pulsante`) },
    {
        id: 'it-continua-evoluzione',
        lang: 'it',
        label: 'in continua evoluzione',
        source: marker(String.raw`in\s+(?:continua|costante|rapida)\s+evoluzione`),
    },
    // The bare-word branch (cruciale / fondamentale alone) was removed after
    // measuring its natural base rate: 90% of published pre-2023 Italian theses
    // of this domain use those words, with a DELTA OF ZERO across the AI epoch
    // boundary. The phrasal forms above (riveste un ruolo cruciale) survive:
    // their base rate is 10%. What stays here is the genuinely rare tail.
    {
        id: 'it-cruciale-fondamentale',
        lang: 'it',
        label: 'imprescindibile / imperativo',
        source: marker(
            String.raw`(?:imprescindibile|imprescindibili|imperativo|imperativa)`
        ),
    },
]

// overleaf-lab: sentence openers that a connective density counts. Language-neutral by
// construction: both lists run over every sentence, and the one that does not apply
// contributes nothing.
export const SENTENCE_OPENERS = [
    'however',
    'moreover',
    'furthermore',
    'additionally',
    'in addition',
    'therefore',
    'thus',
    'consequently',
    'overall',
    'in conclusion',
    'in summary',
    'notably',
    'importantly',
    'ultimately',
    'on the other hand',
    'inoltre',
    'tuttavia',
    'pertanto',
    'quindi',
    'dunque',
    'infine',
    'in conclusione',
    'in sintesi',
    'in particolare',
    'di conseguenza',
    'in definitiva',
    "d'altra parte",
]

// overleaf-lab: leftovers of a chat interface pasted into the source. These are not
// style, they are DEBRIS, and they are the only thing in this file allowed a firm
// word: `oaicite` is not something a person types.
//
// Two kinds, because they are not equally telling. `tool` markers come out of one
// specific product and have no other way of reaching a .tex file. `paste` markers only
// say the text came from a rich-text source, which may be a chat window, a word
// processor or a web page, so they are reported as what they are: evidence of pasting,
// not of a model.
//
// The em-dash pattern is built from a unicode escape, never from a literal character,
// because this codebase forbids the literal one in its own files: a grep for it must
// keep returning nothing.
export const ARTIFACT_PATTERNS = [
    {
        id: 'artifact-oaicite',
        kind: 'tool',
        label: 'oaicite citation marker',
        source: String.raw`oaicite`,
    },
    {
        id: 'artifact-content-reference',
        kind: 'tool',
        label: 'contentReference marker',
        source: String.raw`contentReference`,
    },
    {
        id: 'artifact-turn-marker',
        kind: 'tool',
        label: 'turn/search tool marker',
        source: String.raw`turn\d+(?:search|view|news|image|file)\d+`,
    },
    {
        id: 'artifact-chatgpt-utm',
        kind: 'tool',
        label: 'chatgpt.com tracking parameter in a URL',
        source: String.raw`utm_source=chatgpt\.com`,
    },
    {
        id: 'artifact-typographic-quotes',
        kind: 'paste',
        label: 'typographic quotes in the LaTeX source',
        source: '[\\u201c\\u201d\\u2018\\u2019]',
    },
    {
        id: 'artifact-literal-em-dash',
        kind: 'paste',
        label: 'literal em-dash character in the LaTeX source',
        source: '\\u2014',
    },
]

export default {
    AI_SIGNAL_PATTERNS_VERSION,
    LEXICAL_PATTERNS,
    SENTENCE_OPENERS,
    ARTIFACT_PATTERNS,
}
