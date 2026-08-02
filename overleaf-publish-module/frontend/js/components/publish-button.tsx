// overleaf-lab: the "Publish" button next to Share, and its modal. Lives in the
// publish module; the core toolbar renders it through a two-line anchored patch.
//
// The button decides BY ITSELF whether to exist: on mount it asks the status
// endpoint, and if the call fails (the module is disabled, so the route is not
// registered) it renders nothing. No meta tags, no server-side signalling, and
// an image built with the module still shows a clean toolbar when the operator
// keeps PUBLISH_ENABLED off. Read-only collaborators never see it either:
// publishing is a write-permission action.
//
// The modal also offers the optional custom link. Naming a link and renaming one
// are the same request as publishing, which is why the same field shows before
// and after: the panel never has to explain two different states of the world.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormControl from '@/shared/components/ol/ol-form-control'
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

type PublishStatus = {
    published: boolean
    url?: string
    tokenUrl?: string
    slug?: string
    hasPassword?: boolean
}

// overleaf-lab: the live preview of the custom link, and nothing else. The
// server runs the same transformation and then validates its own result, and its
// answer is the only one that counts: this copy exists so that the publisher can
// watch the URL take shape while typing, not so that the client can decide
// anything. If the two ever drift, the field simply shows a name the server will
// refuse, which is a cosmetic bug and not a hole.
const MAX_SLUG_CHARS = 64
const MIN_SLUG_CHARS = 3

function previewSlug(input: string) {
    return input
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .slice(0, MAX_SLUG_CHARS)
        .replace(/-+$/, '')
}

function statusOf(err: unknown) {
    const response = (err as { response?: { status?: number } })?.response
    return typeof response?.status === 'number' ? response.status : 0
}

export default function PublishProjectButton() {
    const { t } = useTranslation()
    const { permissionsLevel } = useIdeReactContext()
    const projectId = getMeta('ol-project_id')

    const [status, setStatus] = useState<PublishStatus | null>(null)
    const [showModal, setShowModal] = useState(false)
    const [password, setPassword] = useState('')
    const [customName, setCustomName] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [copied, setCopied] = useState(false)

    const canPublish =
        permissionsLevel === 'owner' || permissionsLevel === 'readAndWrite'

    useEffect(() => {
        if (!projectId || !canPublish) return
        getJSON(`/project/${projectId}/publish`)
            .then(data => {
                const next = data as PublishStatus
                setStatus(next)
                setCustomName(next.slug || '')
            })
            .catch(() => setStatus(null)) // feature off: the button never appears
    }, [projectId, canPublish])

    const handlePublish = useCallback(() => {
        setBusy(true)
        setError('')
        // The custom name always travels, so that emptying the field is what
        // removes it; the password only when one was typed, because an absent
        // password field means "leave the protection as it is" and this same
        // request is what renames an already published document.
        const body: { customName: string; password?: string } = { customName }
        if (password) body.password = password
        postJSON(`/project/${projectId}/publish`, { body })
            .then(data => {
                const next = data as PublishStatus
                setStatus({ published: true, ...next })
                // Snap the field to the canonical form the server stored.
                setCustomName(next.slug || '')
                setPassword('')
            })
            .catch(err => {
                const code = statusOf(err)
                if (code === 409) {
                    setError(t('publish_link_taken', 'That link name is already taken'))
                } else if (code === 400) {
                    setError(
                        t(
                            'publish_link_invalid',
                            'That link name cannot be used. Use letters, numbers and hyphens, 3 to 64 characters.'
                        )
                    )
                } else {
                    setError(t('generic_something_went_wrong', 'Something went wrong'))
                }
            })
            .finally(() => setBusy(false))
    }, [projectId, password, customName, t])

    const handleUnpublish = useCallback(() => {
        setBusy(true)
        setError('')
        postJSON(`/project/${projectId}/unpublish`)
            .then(() => {
                setStatus({ published: false })
                setCustomName('')
            })
            .catch(() => setError(t('generic_something_went_wrong', 'Something went wrong')))
            .finally(() => setBusy(false))
    }, [projectId, t])

    const publicUrl = status?.published && status.url ? new URL(status.url, window.location.origin).href : ''
    // The permanent link is worth showing whenever a custom name hides it: it is
    // the one that keeps working after every rename, and the one that is not
    // guessable.
    const tokenUrl =
        status?.published && status.slug && status.tokenUrl
            ? new URL(status.tokenUrl, window.location.origin).href
            : ''
    const slugPreview = previewSlug(customName)
    const previewUrl =
        slugPreview.length >= MIN_SLUG_CHARS
            ? new URL(`/published/${slugPreview}.pdf`, window.location.origin).href
            : ''
    const previewTooShort = customName.trim() !== '' && slugPreview.length < MIN_SLUG_CHARS

    const handleCopy = useCallback(() => {
        if (!publicUrl) return
        navigator.clipboard.writeText(publicUrl).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        })
    }, [publicUrl])

    if (!status || !canPublish) {
        return null
    }

    // The same field before and after publishing: the endpoint is the same too,
    // so renaming a live document is the same action as naming a new one.
    const customLinkField = (
        <OLFormGroup controlId="publish-custom-name">
            <OLFormLabel>{t('publish_custom_link_optional', 'Custom link (optional)')}</OLFormLabel>
            <OLFormControl
                type="text"
                value={customName}
                maxLength={200}
                placeholder={t('publish_custom_link_placeholder', 'thesis guide')}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setCustomName(e.target.value)
                }
            />
            <OLFormText>
                {t(
                    'publish_custom_link_help',
                    'A custom link is easier to share and easier to guess. Leave it empty to keep the random link only.'
                )}
            </OLFormText>
            {previewUrl ? (
                <OLFormText>
                    {t('publish_custom_link_preview', 'Link:')} {previewUrl}
                </OLFormText>
            ) : null}
            {previewTooShort ? (
                <OLFormText>
                    {t(
                        'publish_custom_link_too_short',
                        'Use at least 3 letters or numbers.'
                    )}
                </OLFormText>
            ) : null}
        </OLFormGroup>
    )

    return (
        <>
            <div className="ide-redesign-toolbar-button-container">
                <OLButton
                    size="sm"
                    variant="secondary"
                    leadingIcon={<MaterialIcon type="public" />}
                    onClick={() => setShowModal(true)}
                >
                    {t('publish', 'Publish')}
                </OLButton>
            </div>
            <OLModal show={showModal} onHide={() => setShowModal(false)}>
                <OLModalHeader>
                    <OLModalTitle>{t('publish_document', 'Publish document')}</OLModalTitle>
                </OLModalHeader>
                <OLModalBody>
                    {status.published ? (
                        <>
                            <p>
                                {t(
                                    'publish_document_live',
                                    'This document is published. The link always serves the latest compiled PDF.'
                                )}
                            </p>
                            <OLFormGroup controlId="publish-url">
                                <OLFormLabel>{t('public_link', 'Public link')}</OLFormLabel>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <OLFormControl value={publicUrl} readOnly />
                                    <OLButton variant="secondary" onClick={handleCopy}>
                                        {copied ? t('copied', 'Copied') : t('copy', 'Copy')}
                                    </OLButton>
                                </div>
                                {status.hasPassword ? (
                                    <OLFormText>
                                        {t(
                                            'publish_password_protected',
                                            'The link is password protected.'
                                        )}
                                    </OLFormText>
                                ) : null}
                                {tokenUrl ? (
                                    <OLFormText>
                                        {t('publish_permanent_link', 'Permanent link:')} {tokenUrl}
                                    </OLFormText>
                                ) : null}
                            </OLFormGroup>
                            {customLinkField}
                        </>
                    ) : (
                        <>
                            <p>
                                {t(
                                    'publish_document_explain',
                                    'Publishing creates a public link that serves the latest compiled PDF of this project. Anyone with the link can open it.'
                                )}
                            </p>
                            <OLFormGroup controlId="publish-password">
                                <OLFormLabel>
                                    {t('publish_password_optional', 'Password (optional)')}
                                </OLFormLabel>
                                <OLFormControl
                                    type="password"
                                    value={password}
                                    maxLength={200}
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                                        setPassword(e.target.value)
                                    }
                                />
                                <OLFormText>
                                    {t(
                                        'publish_password_help',
                                        'If set, visitors must enter this password to open the document.'
                                    )}
                                </OLFormText>
                            </OLFormGroup>
                            {customLinkField}
                        </>
                    )}
                    {error ? <p style={{ color: 'var(--red-60, #dc3545)' }}>{error}</p> : null}
                </OLModalBody>
                <OLModalFooter>
                    {status.published ? (
                        <>
                            <OLButton variant="danger" disabled={busy} onClick={handleUnpublish}>
                                {t('unpublish', 'Unpublish')}
                            </OLButton>
                            <OLButton variant="primary" disabled={busy} onClick={handlePublish}>
                                {t('publish_update_link', 'Update link')}
                            </OLButton>
                        </>
                    ) : (
                        <OLButton variant="primary" disabled={busy} onClick={handlePublish}>
                            {t('publish', 'Publish')}
                        </OLButton>
                    )}
                    <OLButton variant="secondary" onClick={() => setShowModal(false)}>
                        {t('close', 'Close')}
                    </OLButton>
                </OLModalFooter>
            </OLModal>
        </>
    )
}
