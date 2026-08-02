// overleaf-lab: the "Compliance check" button in the editor toolbar, next to
// Publish and Share. It does not own any UI of its own: it opens the compliance
// rail panel, which is where the review lives. The point is discoverability, a
// student looking at the top bar before handing in should find the check there.
//
// The core toolbar renders it through a two-line anchored patch, the same way the
// publish module's button is rendered.
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import OLButton from '@/shared/components/ol/ol-button'
import MaterialIcon from '@/shared/components/material-icon'
import getMeta from '@/utils/meta'
import { useLLMFeatures } from '../hooks/use-llm-features'

export default function LLMComplianceToolbarButton() {
    const { t } = useTranslation()
    const features = useLLMFeatures()

    // The module itself can be off in this instance, in which case there is no
    // review to open and no rail entry to select either.
    const llmEnabled = !!(getMeta('ol-ExposedSettings') as any)?.llmEnabled

    const openCompliancePanel = useCallback(() => {
        window.dispatchEvent(
            new CustomEvent('ui:select-rail-tab', {
                detail: { tab: 'llm-compliance', open: true },
            })
        )
    }, [])

    // Wait for the flags before deciding: unlike the rail entry, this button can
    // afford to appear a moment late, and a button that offers a disabled feature
    // is worse than one that shows up on the second frame.
    if (!llmEnabled || !features.loaded || !features.reviewEnabled) {
        return null
    }

    return (
        <div className="ide-redesign-toolbar-button-container">
            <OLButton
                size="sm"
                variant="secondary"
                leadingIcon={<MaterialIcon type="fact_check" />}
                onClick={openCompliancePanel}
            >
                {t('compliance_check', 'Compliance check')}
            </OLButton>
        </div>
    )
}
