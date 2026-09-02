// ===========================================================================
// A LaTeX project on disk, in the shape the controller reads out of Overleaf.
// ===========================================================================
//
// The controller reads a project through readProjectSources, which merges two
// Overleaf notions:
//   - DOCS, from ProjectEntityHandler.promises.getAllDocs(projectId): an object
//     keyed by doc path whose values carry a `lines` array. The controller joins
//     the lines with '\n' and keeps {path, text}.
//   - FILES, from getAllFiles(projectId): everything uploaded, keyed by path,
//     whose values carry _id/hash/size and whose bytes come from the file store.
//     Text-like ones (.bib .tex .cls .sty .bst .txt .md) are read into the same
//     {path, text} shape; raster ones are measured by the figure metrics.
//
// PATHS CARRY A LEADING SLASH. Verified against the controller (partitionByInclusion
// resolves an \input against both `name.tex` and `/name.tex`) and against the
// archived reports of real reviews, whose documentFiles read `/main.tex`,
// `/contenuti.tex` and so on.

import fs from 'node:fs'
import path from 'node:path'

// Same list the controller calls TEXTUAL_FILE_EXTENSION, so nothing that would be
// reviewed inside the container is invisible here.
const TEXT_EXTENSIONS = /\.(bib|tex|cls|sty|bst|txt|md)$/i

// What a figure can be. The metrics module decides what it can actually measure;
// this only decides what is offered to it.
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|bmp|tiff?|pdf|eps|ps|svg)$/i

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.github', 'out', '__pycache__'])

// A text file bigger than this is not a chapter, it is data. The controller caps
// linked text files at 2 MB for the same reason.
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/**
 * Read a LaTeX project directory.
 *
 * Returns { root, docs, files, skipped }:
 *   docs    [{path, text}]                 text sources, in stable path order
 *   files   [{path, diskPath, size}]       binaries, served from disk by the bench fetch
 *   skipped [{path, reason}]               what was left out and why
 */
export function readProject(root, options = {}) {
    const absoluteRoot = path.resolve(root)
    if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
        throw new Error(`bench project: ${absoluteRoot} is not a directory`)
    }
    const maxTextBytes = options.maxTextBytes || MAX_TEXT_BYTES

    const docs = []
    const files = []
    const skipped = []

    const walk = directory => {
        const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
        )
        for (const entry of entries) {
            const full = path.join(directory, entry.name)
            if (entry.isDirectory()) {
                if (SKIP_DIRECTORIES.has(entry.name)) {
                    continue
                }
                walk(full)
                continue
            }
            if (!entry.isFile()) {
                continue
            }
            // Overleaf paths use forward slashes and start at the project root.
            const projectPath = `/${path.relative(absoluteRoot, full).split(path.sep).join('/')}`
            const stat = fs.statSync(full)
            if (TEXT_EXTENSIONS.test(entry.name)) {
                if (stat.size > maxTextBytes) {
                    skipped.push({ path: projectPath, reason: `text file over ${maxTextBytes} bytes` })
                    continue
                }
                const text = fs.readFileSync(full, 'utf8')
                // The controller drops empty docs in readProjectSources; do the
                // same here so the two agree on what the project contains.
                if (!text.trim()) {
                    skipped.push({ path: projectPath, reason: 'empty file' })
                    continue
                }
                docs.push({ path: projectPath, text })
                continue
            }
            if (BINARY_EXTENSIONS.test(entry.name)) {
                files.push({ path: projectPath, diskPath: full, size: stat.size })
                continue
            }
            skipped.push({ path: projectPath, reason: 'not a text source or a figure' })
        }
    }
    walk(absoluteRoot)

    if (docs.length === 0) {
        throw new Error(`bench project: no .tex/.bib sources under ${absoluteRoot}`)
    }
    return { root: absoluteRoot, docs, files, skipped }
}

/** Total characters of the text sources, for the run header. */
export function projectSize(project) {
    return project.docs.reduce((total, doc) => total + doc.text.length, 0)
}
