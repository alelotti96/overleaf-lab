import { renderInReactLayout } from '@/react'
import '@/utils/meta'
import '@/utils/webpack-public-path'
import '@/infrastructure/error-reporter'
import '@/i18n'
import LLMComplianceSettingsPage from '../../components/llm-compliance-settings-page'

renderInReactLayout('llm-compliance-settings-root', () => <LLMComplianceSettingsPage />)
