import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import RailPanelHeader from '@/features/ide-react/components/rail/rail-panel-header'
import LLMChatPane from './llm-chat-pane'
import LLMCompliancePane from './llm-compliance-pane'
import { RailElement } from '@/features/ide-react/util/rail-types'
import getMeta from '@/utils/meta'

function LLMRailPane() {
    const { t } = useTranslation()
    // overleaf-lab: switch between the chat assistant and the whole-document
    // compliance review inside the same rail panel.
    const [tab, setTab] = useState<'chat' | 'review'>('chat')

    const tabButtonStyle = (active: boolean): React.CSSProperties => ({
        appearance: 'none',
        background: 'none',
        border: 'none',
        padding: '6px 12px',
        cursor: 'pointer',
        color: active ? 'var(--content-primary, inherit)' : 'var(--content-secondary, #6c757d)',
        fontWeight: active ? 'bold' : 'normal',
        borderBottom: active
            ? '2px solid var(--content-primary, currentColor)'
            : '2px solid transparent',
    })

    return (
        <div className="llm-rail-panel">
            <RailPanelHeader title={t('ai_assistant', 'AI Assistant')} />

            {/* overleaf-lab: lightweight two-tab bar */}
            <div
                style={{
                    display: 'flex',
                    gap: 4,
                    borderBottom: '1px solid var(--border-divider, rgba(125,125,125,0.2))',
                }}
                role="tablist"
            >
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'chat'}
                    style={tabButtonStyle(tab === 'chat')}
                    onClick={() => setTab('chat')}
                >
                    {t('chat', 'Chat')}
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'review'}
                    style={tabButtonStyle(tab === 'review')}
                    onClick={() => setTab('review')}
                >
                    {t('review', 'Review')}
                </button>
            </div>

            {tab === 'chat' ? <LLMChatPane /> : <LLMCompliancePane />}
        </div>
    )
}

const llmRailEntry: RailElement = {
    key: 'llm-chat',
    icon: 'smart_toy',
    title: 'AI Assistant',
    component: <LLMRailPane />,
    hide: () => !(getMeta('ol-ExposedSettings') as any)?.llmEnabled,
}

export default llmRailEntry
