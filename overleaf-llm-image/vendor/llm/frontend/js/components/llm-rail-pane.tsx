import React from 'react'
import { useTranslation } from 'react-i18next'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import LLMChatPane from './llm-chat-pane'
import { RailElement } from '@/features/ide-react/util/rail-types'
import getMeta from '@/utils/meta'
import { useLLMFeatures } from '../hooks/use-llm-features'

// overleaf-lab: chat only. The compliance review used to share this panel behind
// a tab bar; it has its own rail entry now (llm-compliance-rail-pane), because
// the admin enables the two features independently and a document check does not
// belong behind a chatbot icon.

function LLMRailPane() {
    const { t } = useTranslation()
    const features = useLLMFeatures()

    return (
        <div className="llm-rail-panel">
            <RailPanelHeader title={t('ai_assistant', 'AI Assistant')} />

            {features.loaded && !features.chatEnabled ? (
                <div
                    style={{
                        padding: '12px',
                        color: 'var(--content-secondary, inherit)',
                        opacity: 0.7,
                        fontSize: 13,
                    }}
                >
                    {t(
                        'llm_chat_disabled',
                        'The AI assistant is currently disabled by the administrator.'
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
                    <LLMChatPane />
                </div>
            )}
        </div>
    )
}

const llmRailEntry: RailElement = {
    key: 'llm-chat',
    icon: 'smart_toy',
    title: 'AI Assistant',
    component: <LLMRailPane />,
    // overleaf-lab: see llm-compliance-rail-pane for why the runtime flag is read
    // off window here rather than from the hook.
    hide: () =>
        !(getMeta('ol-ExposedSettings') as any)?.llmEnabled ||
        (window as any).__llmChatEnabled === false,
}

export default llmRailEntry
