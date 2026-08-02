import React from 'react'
import { useTranslation } from 'react-i18next'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import LLMCompliancePane from './llm-compliance-pane'
import { RailElement } from '@/features/ide-react/util/rail-types'
import getMeta from '@/utils/meta'
import { useLLMFeatures } from '../hooks/use-llm-features'

// overleaf-lab: the compliance review used to be a tab inside the AI assistant
// panel, which put a document check behind an icon that reads as "chatbot" and
// tied its visibility to the chat feature. It is its own rail entry now: the two
// features are enabled independently by the admin, so they get one icon each.

function LLMComplianceRailPane() {
    const { t } = useTranslation()
    const features = useLLMFeatures()

    return (
        <div className="llm-rail-panel">
            <RailPanelHeader title={t('compliance_check', 'Compliance check')} />

            {features.loaded && !features.reviewEnabled ? (
                <div
                    style={{
                        padding: '12px',
                        color: 'var(--content-secondary, inherit)',
                        opacity: 0.7,
                        fontSize: 13,
                    }}
                >
                    {t(
                        'llm_review_disabled',
                        'The compliance check is currently disabled by the administrator.'
                    )}
                </div>
            ) : (
                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        flex: 1,
                        minHeight: 0,
                        overflow: 'hidden',
                    }}
                >
                    <LLMCompliancePane />
                </div>
            )}
        </div>
    )
}

const llmComplianceRailEntry: RailElement = {
    key: 'llm-compliance',
    // Material Symbols: a document with a tick, which is what this does. Reusing
    // the chat's robot here would say "this is the AI assistant" again.
    icon: 'fact_check',
    title: 'Compliance check',
    component: <LLMComplianceRailPane />,
    // overleaf-lab: `hide` is called during render, but the per-project feature
    // flags arrive from an async fetch, so they cannot be read here directly. The
    // flag is published on window by llm-source-editor-component, exactly as
    // __llmChatEnabled already is for the "Ask AI" tooltip entry. Fail open while
    // it is still undefined, so the icon does not flicker in on every load.
    hide: () =>
        !(getMeta('ol-ExposedSettings') as any)?.llmEnabled ||
        (window as any).__llmReviewEnabled === false,
}

export default llmComplianceRailEntry
