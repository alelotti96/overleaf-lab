// overleaf-lab: the "Lists" button next to Publish and Share, and its modal. Lives
// in the lists module; the core toolbar renders it through a two-line anchored
// patch, exactly as the publish button does.
//
// The button decides BY ITSELF whether to exist: on mount it asks the status
// endpoint, and if the call fails (the module is disabled, so the route is not
// registered) it renders nothing. No meta tags, no server-side signalling, and an
// image built with the module still shows a clean toolbar when the operator sets
// LISTS_ENABLED=false. Read-only collaborators never see it either: both actions
// write into the project.
//
// EVERY STRING HERE IS ENGLISH, deliberately and without exception, including the
// error messages and the result summary. The only thing that follows the language
// of the DOCUMENT is the LaTeX the server generates: the heading of a created file
// and the column of definitions it fills in.
//
// WHY A PREVIEW STEP. Both actions modify the project, so both ask first. The
// preview is not a separate code path that could drift from the real one: it is
// the same request with dryRun, computed by the same scan, so what the dialog
// shows is what the button will do.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormText from '@/shared/components/ol/ol-form-text'
import {
    OLModal,
    OLModalHeader,
    OLModalTitle,
    OLModalBody,
    OLModalFooter,
} from '@/shared/components/ol/ol-modal'
import MaterialIcon from '@/shared/components/material-icon'
import getMeta from '@/utils/meta'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'
import { useIdeReactContext } from '@/features/ide-react/context/ide-react-context'

type ListKind = 'acronyms' | 'symbols'

type ListStatus = {
    available: boolean
    canCreate: boolean
    reason?: string
    path?: string
    language?: 'it' | 'en'
    entries?: number
}

type StatusResponse = {
    ok: boolean
    documentLanguage: 'it' | 'en'
    lists: Partial<Record<ListKind, ListStatus>>
}

type Outcome = {
    mode: 'update' | 'create'
    kind: ListKind
    path: string
    language: 'it' | 'en'
    existingEntries: number
    wrote: boolean
    added: { key: string; definition: string; count: number }[]
    addedWithDefinition: string[]
    addedWithoutDefinition: string[]
    unusedKept: string[]
    truncated?: boolean
    remaining?: number
    definitionsDropped?: boolean
    hookup?: {
        mode: 'adjacent' | 'before-main' | 'manual'
        path: string | null
        line: string
        packageLine: string | null
        reason?: string | null
    }
}

const KIND_LABEL: Record<ListKind, string> = {
    acronyms: 'acronyms',
    symbols: 'symbols',
}

// The names are all in the payload; only the DISPLAY is shortened, and it says so
// when it shortens. A reader who wants the rest has the list in the response.
const MAX_SHOWN = 15

function nameList(keys: string[]) {
    if (keys.length <= MAX_SHOWN) return keys.join(', ')
    return `${keys.slice(0, MAX_SHOWN).join(', ')}, and ${keys.length - MAX_SHOWN} more`
}

function statusOf(err: unknown) {
    const response = (err as { response?: { status?: number } })?.response
    return typeof response?.status === 'number' ? response.status : 0
}

function errorMessage(err: unknown) {
    const data = (err as { data?: { error?: string } })?.data
    switch (data?.error) {
        case 'list_already_exists':
            return 'A list of this kind already exists in the project now. Close this dialog, reopen it, and update the list instead.'
        case 'file_exists':
            return 'A file with that name already exists in the project. Nothing was written.'
        case 'no_list_file':
            return 'The project has no list file of this kind any more.'
        case 'no_list_container':
            return 'The list file has no table, description list or acronym environment to add rows to.'
        case 'document_too_large':
            // The module rewrites the whole document it merges into, and it will not
            // rewrite one it has only partly read: doing so would delete everything
            // past the point it stopped reading.
            return 'That file is too large for this module to read in full, so it will not rewrite it. Nothing was written. Splitting the file into chapters with \\input is the usual fix.'
        case 'rate_limited':
            return 'Too many list requests in the last minute. Wait a moment and try again.'
        case 'unsupported_layout':
            // Two different lists reach this: a table whose column count the module
            // refuses to guess at, and an item list with no [labels], whose entries
            // this parser cannot read. Saying "the list is empty" was wrong for the
            // second one, which is exactly the case where the author is looking at a
            // list that plainly is not.
            return 'The layout of this list is not one this module can write into. Add one entry by hand in the shape you want and press the button again: every later row copies it.'
        default:
            if (statusOf(err) === 403) {
                return 'You need write access to this project to change its lists.'
            }
            // The server sends an English sentence with every code it defines, so a
            // code this panel has not been taught still says something true.
            return (err as { data?: { message?: string } })?.data?.message ?? 'Something went wrong. Nothing was written.'
    }
}

// One panel per list. It owns its own preview, its own result and its own error,
// because the two lists are two independent actions that happen to share a dialog.
function ListPanel({
    kind,
    status,
    documentLanguage,
    onChanged,
}: {
    kind: ListKind
    status: ListStatus | undefined
    documentLanguage: 'it' | 'en'
    onChanged: () => void
}) {
    const [language, setLanguage] = useState<'it' | 'en'>(documentLanguage)
    const [preview, setPreview] = useState<Outcome | null>(null)
    const [result, setResult] = useState<Outcome | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => setLanguage(documentLanguage), [documentLanguage])

    const projectId = getMeta('ol-project_id')
    const action = status?.available ? 'update' : 'create'
    const endpoint = `/project/${projectId}/lists/${kind}/${action}`

    const run = useCallback(
        (dryRun: boolean) => {
            setBusy(true)
            setError('')
            postJSON(endpoint, { body: { dryRun, language } })
                .then(data => {
                    const outcome = data as Outcome
                    if (dryRun) setPreview(outcome)
                    else {
                        setResult(outcome)
                        setPreview(null)
                        onChanged()
                    }
                })
                .catch(err => {
                    setPreview(null)
                    setError(errorMessage(err))
                })
                .finally(() => setBusy(false))
        },
        [endpoint, language, onChanged]
    )

    if (!status) return null

    if (!status.available && !status.canCreate) {
        // Three different dead ends, and each one says which it is. The empty
        // project used to reach the panel as no entry at all, which rendered as a
        // dialog with nothing in it and left the author unable to tell an empty
        // project from a broken button.
        return (
            <OLFormGroup>
                <OLFormLabel>The {KIND_LABEL[kind]} list</OLFormLabel>
                <OLFormText>
                    {status.reason === 'empty_project'
                        ? 'This project has no document to scan yet. Write some text first, then come back.'
                        : status.reason === 'document_too_large'
                          ? `${status.path} is too large for this module to read in full, so it will not rewrite it. Splitting it into chapters with \\input is the usual fix.`
                          : status.path
                            ? `Found in ${status.path}, but it has no table, description list or acronym environment to add rows to. Add one row by hand and this button will copy its shape from then on.`
                            : 'Not available in this project.'}
                </OLFormText>
            </OLFormGroup>
        )
    }

    const heading = status.available
        ? `Update the ${KIND_LABEL[kind]} list`
        : `Create a list of ${KIND_LABEL[kind]}`

    return (
        <OLFormGroup>
            <OLFormLabel>{heading}</OLFormLabel>

            {status.available ? (
                <OLFormText>
                    {`Found in ${status.path} (${status.entries ?? 0} entries, ${
                        status.language === 'it' ? 'Italian' : 'English'
                    }). Existing rows are never changed or removed: new entries are added and nothing else.`}
                </OLFormText>
            ) : (
                <>
                    <OLFormText>
                        This project has no {KIND_LABEL[kind]} list file. A new file will be
                        created and filled in with what the scan finds. A line pointing at it
                        is added to the main file only when there is one obvious place for it;
                        otherwise the exact line to paste is shown here.
                    </OLFormText>
                    <div style={{ marginTop: 8, display: 'flex', gap: 16 }}>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                                type="radio"
                                name={`lists-language-${kind}`}
                                checked={language === 'en'}
                                onChange={() => {
                                    setLanguage('en')
                                    setPreview(null)
                                }}
                            />
                            English
                        </label>
                        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                                type="radio"
                                name={`lists-language-${kind}`}
                                checked={language === 'it'}
                                onChange={() => {
                                    setLanguage('it')
                                    setPreview(null)
                                }}
                            />
                            Italian
                        </label>
                    </div>
                    <OLFormText>
                        {`Detected from the document: ${
                            documentLanguage === 'it' ? 'Italian' : 'English'
                        }.`}{' '}
                        The choice decides the file name, the heading and the language of the
                        generated descriptions.
                    </OLFormText>
                </>
            )}

            {preview ? <OutcomeSummary outcome={preview} preview /> : null}
            {result ? <OutcomeSummary outcome={result} /> : null}
            {error ? <p style={{ color: 'var(--red-60, #dc3545)' }}>{error}</p> : null}

            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                {preview ? (
                    <>
                        <OLButton
                            variant="primary"
                            disabled={busy || preview.added.length === 0}
                            onClick={() => run(false)}
                        >
                            {status.available ? 'Add these entries' : 'Create the file'}
                        </OLButton>
                        <OLButton variant="secondary" disabled={busy} onClick={() => setPreview(null)}>
                            Back
                        </OLButton>
                    </>
                ) : (
                    <OLButton variant="secondary" disabled={busy} onClick={() => run(true)}>
                        {busy ? 'Scanning...' : status.available ? 'Scan for new entries' : 'Scan and preview'}
                    </OLButton>
                )}
            </div>
        </OLFormGroup>
    )
}

// overleaf-lab: what the run found, in words. Three things are always said, in
// this order, and none of them is optional:
//
//   1. WHICH entries, by name, split into the ones a definition was filled in for
//      and the ones left blank. A count alone tells the author nothing they can
//      act on.
//   2. That the filled-in definitions come from a DEFAULT list and have to be
//      reviewed. The master list is a dictionary of the most likely meaning in a
//      space thesis, and the next thesis may well mean the other one.
//   3. That the scan is heuristic and may have missed things. It is a parser, not
//      a reader, and telling the author otherwise would be the one dishonest line
//      in the whole module.
function OutcomeSummary({ outcome, preview }: { outcome: Outcome; preview?: boolean }) {
    const filled = outcome.addedWithDefinition
    const blank = outcome.addedWithoutDefinition
    const kind = KIND_LABEL[outcome.kind]
    const verb = preview ? 'would be added' : 'added'

    return (
        <div style={{ marginTop: 8, fontSize: '0.9em' }}>
            {outcome.added.length === 0 ? (
                <p>
                    {outcome.mode === 'update'
                        ? `Nothing to add: every ${kind} the scan found is already in the list.`
                        : `The scan found no ${kind} to put in the list. The file would still be created, with an empty table.`}
                </p>
            ) : (
                <p>
                    {`${outcome.added.length} ${kind} ${verb}`}
                    {filled.length > 0 ? `. Filled from the default list: ${nameList(filled)}` : ''}
                    {blank.length > 0 ? `. Left blank for you to complete: ${nameList(blank)}` : ''}
                    {'.'}
                </p>
            )}

            {outcome.truncated ? (
                <p>
                    {`One press adds at most ${outcome.added.length} entries and the scan found ${
                        outcome.remaining ?? 0
                    } more. Press the button again to add the rest.`}
                </p>
            ) : null}

            {outcome.definitionsDropped ? (
                <p>
                    The rows in this list carry a key and no description column, so the new
                    entries were added as keys only and the definitions were not written.
                    Add a description column, or fill them in by hand.
                </p>
            ) : null}

            {filled.length > 0 && !outcome.definitionsDropped ? (
                <p>
                    Definitions were filled from the module default list. Review them: your
                    thesis may use a different meaning for the same short form.
                </p>
            ) : null}

            <p>
                The scan is heuristic and may have missed entries. Skim your chapters for
                anything that is still not listed.
            </p>

            {outcome.unusedKept.length > 0 ? (
                <p>
                    {`Kept, although the scan could not find them in the text: ${nameList(
                        outcome.unusedKept
                    )}. Nothing is ever removed from a list.`}
                </p>
            ) : null}

            {outcome.mode === 'create' && outcome.hookup ? (
                <p>
                    {outcome.hookup.mode === 'manual'
                        ? `The main file was not touched${
                              outcome.hookup.reason === 'document_too_large'
                                  ? ' because it is too large for this module to read in full'
                                  : ''
                          }. Add this line where the list should appear: ${outcome.hookup.line}`
                        : `${preview ? 'Will be added' : 'Added'} to ${outcome.hookup.path}: ${
                              outcome.hookup.line
                          }${
                              outcome.hookup.packageLine
                                  ? ` (and ${outcome.hookup.packageLine} in the preamble, which the generated table needs)`
                                  : ''
                          }`}
                    {outcome.hookup.mode === 'manual' && outcome.hookup.packageLine
                        ? ` Add ${outcome.hookup.packageLine} to the preamble too: the generated table needs it.`
                        : ''}
                </p>
            ) : null}

            {!preview ? (
                <p>
                    {`Written to ${outcome.path}. Every change is in the project history and can be undone.`}
                </p>
            ) : null}
        </div>
    )
}

export default function ProjectListsButton() {
    const { t } = useTranslation()
    const { permissionsLevel } = useIdeReactContext()
    const projectId = getMeta('ol-project_id')

    const [status, setStatus] = useState<StatusResponse | null>(null)
    const [showModal, setShowModal] = useState(false)
    const [reloadToken, setReloadToken] = useState(0)

    const canWrite = permissionsLevel === 'owner' || permissionsLevel === 'readAndWrite'

    useEffect(() => {
        if (!projectId || !canWrite) return
        getJSON(`/project/${projectId}/lists`)
            .then(data => setStatus(data as StatusResponse))
            .catch(() => setStatus(null)) // feature off: the button never appears
    }, [projectId, canWrite, reloadToken])

    const reload = useCallback(() => setReloadToken(token => token + 1), [])

    if (!status || !canWrite) {
        return null
    }

    return (
        <>
            <div className="ide-redesign-toolbar-button-container">
                <OLButton
                    size="sm"
                    variant="secondary"
                    leadingIcon={<MaterialIcon type="format_list_bulleted" />}
                    onClick={() => setShowModal(true)}
                >
                    {t('acronyms_and_symbols', 'Acronyms and symbols')}
                </OLButton>
            </div>
            <OLModal show={showModal} onHide={() => setShowModal(false)}>
                <OLModalHeader>
                    <OLModalTitle>Acronyms and symbols lists</OLModalTitle>
                </OLModalHeader>
                <OLModalBody>
                    <p>
                        This scans the project and adds the acronyms and symbols it finds to
                        the lists at the front of the document. It reads the document only:
                        no text is sent anywhere and no model is involved.
                    </p>
                    <ListPanel
                        kind="acronyms"
                        status={status.lists.acronyms}
                        documentLanguage={status.documentLanguage}
                        onChanged={reload}
                    />
                    <ListPanel
                        kind="symbols"
                        status={status.lists.symbols}
                        documentLanguage={status.documentLanguage}
                        onChanged={reload}
                    />
                </OLModalBody>
                <OLModalFooter>
                    <OLButton variant="secondary" onClick={() => setShowModal(false)}>
                        {t('close', 'Close')}
                    </OLButton>
                </OLModalFooter>
            </OLModal>
        </>
    )
}
