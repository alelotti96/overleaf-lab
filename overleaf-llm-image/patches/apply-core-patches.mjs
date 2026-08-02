#!/usr/bin/env node
// apply-core-patches.mjs
// -----------------------------------------------------------------------------
// Idempotent, ANCHOR-BASED application of the FUNCTIONAL parts of PR #171
// (yu-i-i/overleaf-cep, commit f908a9698b — the Local-LLM AI Assistant) onto the
// core Overleaf web files. The PR's cosmetic prettier reformatting is dropped on
// purpose — only behaviour-carrying lines are re-applied here.
//
// Why anchors instead of line-numbered .patch files:
//   The base image (overleafcep/sharelatex:6.2.0-ext-v5.0) drifts from the PR's
//   branch. Line patches would reject on any nearby change; string anchors match
//   the stable code around each edit and survive unrelated drift.
//
// Contract:
//   * Every edit is IDEMPOTENT: if its result is already present the edit is
//     skipped, so the script is safe to re-run.
//   * If an edit is neither already-applied NOR its anchor is found, the script
//     FAILS LOUDLY: it collects every such miss, prints them, and exits non-zero
//     so a silently-drifted base image can never yield a half-patched build.
//
// Usage:  node apply-core-patches.mjs [WEB_DIR]
//         WEB_DIR defaults to $WEB_DIR or /overleaf/services/web
// -----------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'

const WEB_DIR =
  process.argv[2] || process.env.WEB_DIR || '/overleaf/services/web'

// Literal-string edit: replace the first occurrence of `anchor` with
// `replacement`. `done` reports whether the edit is already applied.
function strEdit(id, done, anchor, replacement) {
  return {
    id,
    isDone: content => content.includes(done),
    run: content => {
      if (!content.includes(anchor)) return null
      // Function replacer => `$` in the replacement is NOT interpreted.
      return content.replace(anchor, () => replacement)
    },
  }
}

// Regex edit: `regex` must match; `build(m)` returns the replacement text.
function reEdit(id, done, regex, build) {
  return {
    id,
    isDone: content => content.includes(done),
    run: content => {
      const m = regex.exec(content)
      if (!m) return null
      return content.slice(0, m.index) + build(m) + content.slice(m.index + m[0].length)
    },
  }
}

// -----------------------------------------------------------------------------
// The edit set, grouped by file. Paths are relative to WEB_DIR.
// -----------------------------------------------------------------------------
const FILES = [
  // 1) config/settings.defaults.js -------------------------------------------
  {
    path: 'config/settings.defaults.js',
    edits: [
      strEdit(
        'settings: sourceEditorExtensions -> llm-inline-completion',
        'modules/llm/frontend/js/extensions/llm-inline-completion',
        '    sourceEditorExtensions: [],',
        [
          '    sourceEditorExtensions: [',
          '      Path.resolve(',
          '        __dirname,',
          "        '../modules/llm/frontend/js/extensions/llm-inline-completion'",
          '      ),',
          '    ],',
        ].join('\n')
      ),
      strEdit(
        'settings: sourceEditorComponents -> llm-source-editor-component',
        'modules/llm/frontend/js/components/llm-source-editor-component',
        '    sourceEditorComponents: [],',
        [
          '    sourceEditorComponents: [',
          '      Path.resolve(',
          '        __dirname,',
          "        '../modules/llm/frontend/js/components/llm-source-editor-component'",
          '      ),',
          '    ],',
        ].join('\n')
      ),
      strEdit(
        'settings: pdfLogEntryHeaderActionComponents -> pdf-log-entry-ask-ai-button',
        'modules/llm/frontend/js/components/pdf-log-entry-ask-ai-button',
        '    pdfLogEntryHeaderActionComponents: [],',
        [
          '    pdfLogEntryHeaderActionComponents: [',
          '      Path.resolve(',
          '        __dirname,',
          "        '../modules/llm/frontend/js/components/pdf-log-entry-ask-ai-button'",
          '      ),',
          '    ],',
        ].join('\n')
      ),
      // overleaf-lab: TWO rail entries, not one. The compliance review used to be
      // a tab inside the AI assistant panel, which hid a document check behind a
      // chatbot icon and tied its visibility to the chat feature; the admin
      // enables the two independently, so each gets its own icon. The done-marker
      // is the compliance path: it is the one that is missing on a tree patched
      // by an older version of this script.
      strEdit(
        'settings: railEntries -> llm-rail-pane + llm-compliance-rail-pane',
        'modules/llm/frontend/js/components/llm-compliance-rail-pane',
        '    railEntries: [],',
        [
          '    railEntries: [',
          '      Path.resolve(',
          '        __dirname,',
          "        '../modules/llm/frontend/js/components/llm-rail-pane'",
          '      ),',
          '      Path.resolve(',
          '        __dirname,',
          "        '../modules/llm/frontend/js/components/llm-compliance-rail-pane'",
          '      ),',
          '    ],',
        ].join('\n')
      ),
      strEdit(
        "settings: moduleImportSequence += 'llm'",
        "    'llm',",
        "    'git-bridge',\n",
        "    'git-bridge',\n    'llm',\n"
      ),
      // overleaf-lab: the publish module (public PDF links) loads right after the
      // llm one; this edit anchors on the line the previous edit just inserted.
      strEdit(
        "settings: moduleImportSequence += 'publish'",
        "    'publish',",
        "    'llm',\n",
        "    'llm',\n    'publish',\n"
      ),
      // overleaf-lab: the lists module (symbols/acronyms generator) is a sibling of
      // publish: deterministic, LLM-free, and loaded right after it. Anchors on the
      // line the previous edit just inserted, same chain as llm -> publish.
      strEdit(
        "settings: moduleImportSequence += 'lists'",
        "    'lists',",
        "    'publish',\n",
        "    'publish',\n    'lists',\n"
      ),
    ],
  },

  // 1b) ide-react toolbar: the Publish button, from the publish module ---------
  // The import path climbs from frontend/js/features/ide-react/components/toolbar
  // back to services/web and into modules/publish. The button renders before
  // ShareProjectButton and hides itself when the module is disabled (it probes
  // its own status route on mount), so this patch is safe on an instance that
  // never sets PUBLISH_ENABLED.
  {
    path: 'frontend/js/features/ide-react/components/toolbar/toolbar.tsx',
    edits: [
      strEdit(
        'toolbar: import PublishProjectButton',
        'modules/publish/frontend/js/components/publish-button',
        "import ShareProjectButton from './share-project-button'\n",
        "import ShareProjectButton from './share-project-button'\nimport PublishProjectButton from '../../../../../../modules/publish/frontend/js/components/publish-button'\n"
      ),
      // overleaf-lab: the compliance check button sits with Publish and Share, so
      // that a student about to hand in finds it where the other "I am done"
      // actions are. It hides itself when the review feature is off. This edit
      // anchors on the import the previous one just inserted.
      strEdit(
        'toolbar: import LLMComplianceToolbarButton',
        'modules/llm/frontend/js/components/llm-compliance-toolbar-button',
        "import PublishProjectButton from '../../../../../../modules/publish/frontend/js/components/publish-button'\n",
        "import PublishProjectButton from '../../../../../../modules/publish/frontend/js/components/publish-button'\nimport LLMComplianceToolbarButton from '../../../../../../modules/llm/frontend/js/components/llm-compliance-toolbar-button'\n"
      ),
      strEdit(
        'toolbar: render PublishProjectButton before Share',
        '<PublishProjectButton />',
        '        <ShareProjectButton />\n',
        '        <PublishProjectButton />\n        <ShareProjectButton />\n'
      ),
      strEdit(
        'toolbar: render LLMComplianceToolbarButton before Publish',
        '<LLMComplianceToolbarButton />',
        '        <PublishProjectButton />\n',
        '        <LLMComplianceToolbarButton />\n        <PublishProjectButton />\n'
      ),
      // overleaf-lab: the Lists button (symbols/acronyms generator) sits between
      // the compliance check and Publish: it is part of the same "I am about to
      // hand in" ritual. It hides itself when its module is disabled. Both edits
      // anchor on lines the publish edits above already put in place.
      strEdit(
        'toolbar: import ProjectListsButton',
        'modules/lists/frontend/js/components/lists-button',
        "import PublishProjectButton from '../../../../../../modules/publish/frontend/js/components/publish-button'\n",
        "import PublishProjectButton from '../../../../../../modules/publish/frontend/js/components/publish-button'\nimport ProjectListsButton from '../../../../../../modules/lists/frontend/js/components/lists-button'\n"
      ),
      strEdit(
        'toolbar: render ProjectListsButton before Publish',
        '<ProjectListsButton />',
        '        <PublishProjectButton />\n',
        '        <ProjectListsButton />\n        <PublishProjectButton />\n'
      ),
    ],
  },

  // 2) review-panel/components/review-tooltip-menu.tsx ------------------------
  {
    path: 'frontend/js/features/review-panel/components/review-tooltip-menu.tsx',
    edits: [
      strEdit(
        'review-tooltip: import getMeta',
        "import getMeta from '@/utils/meta'",
        "import { sendMB } from '@/infrastructure/event-tracking'",
        "import { sendMB } from '@/infrastructure/event-tracking'\nimport getMeta from '@/utils/meta'"
      ),
      strEdit(
        'review-tooltip: thread onHide into portal',
        'onHide={() => setShow(false)}',
        '    <ReviewTooltipMenuContent onAddComment={addComment} />,',
        '    <ReviewTooltipMenuContent onAddComment={addComment} onHide={() => setShow(false)} />,'
      ),
      strEdit(
        'review-tooltip: onHide in memo prop type',
        'onAddComment: () => void; onHide: () => void',
        'const ReviewTooltipMenuContent = memo<{ onAddComment: () => void }>(',
        'const ReviewTooltipMenuContent = memo<{ onAddComment: () => void; onHide: () => void }>('
      ),
      strEdit(
        'review-tooltip: onHide in function params',
        'function ReviewTooltipMenuContent({ onAddComment, onHide })',
        '  function ReviewTooltipMenuContent({ onAddComment }) {',
        '  function ReviewTooltipMenuContent({ onAddComment, onHide }) {'
      ),
      strEdit(
        'review-tooltip: llmEnabled gate',
        'const llmEnabled =',
        '    const [visible, setVisible] = useState(false)',
        "    const [visible, setVisible] = useState(false)\n\n    const llmEnabled = !!(getMeta('ol-ExposedSettings') as any)?.llmEnabled\n    // overleaf-lab: hide Ask AI when the admin disabled the chat feature at runtime\n    const llmChatEnabled = (window as any).__llmChatEnabled !== false"
      ),
      strEdit(
        'review-tooltip: Ask AI button',
        'llm-ask-ai-selection',
        '        </button>\n        {showChangesButtons && (',
        [
          '        </button>',
          '        {llmEnabled && llmChatEnabled && (',
          '          <>',
          '            <div className="review-tooltip-menu-divider" />',
          '            <button',
          '              className="review-tooltip-menu-button"',
          '              onClick={() => {',
          '                const selectedText = view.state.sliceDoc(',
          '                  state.selection.main.from,',
          '                  state.selection.main.to',
          '                )',
          '                document.dispatchEvent(',
          "                  new CustomEvent('llm-ask-ai-selection', {",
          '                    detail: { text: selectedText },',
          '                  })',
          '                )',
          '                onHide()',
          '              }}',
          '            >',
          '              <MaterialIcon type="smart_toy" />',
          "              {t('ask_ai', 'Ask AI')}",
          '            </button>',
          '          </>',
          '        )}',
          '        {showChangesButtons && (',
        ].join('\n')
      ),
    ],
  },

  // 3) ide-react/context/rail-context.tsx ------------------------------------
  {
    path: 'frontend/js/features/ide-react/context/rail-context.tsx',
    edits: [
      strEdit(
        "rail-context: RailTabKey += 'llm-chat'",
        "| 'llm-chat'",
        "  | 'workbench'\n",
        "  | 'workbench'\n  | 'llm-chat'\n"
      ),
    ],
  },

  // 4) app/src/infrastructure/ExpressLocals.mjs ------------------------------
  {
    path: 'app/src/infrastructure/ExpressLocals.mjs',
    edits: [
      strEdit(
        'ExpressLocals: expose llmAllowUserSettings + llmEnabled',
        'llmAllowUserSettings: Settings.llm?.allowUserSettings',
        '      linkedInInsightsPartnerId: Settings.analytics?.linkedIn?.partnerId,\n',
        '      linkedInInsightsPartnerId: Settings.analytics?.linkedIn?.partnerId,\n' +
          '      llmAllowUserSettings: Settings.llm?.allowUserSettings ?? false,\n' +
          '      llmEnabled: Settings.llm?.enabled ?? false,\n'
      ),
    ],
  },

  // 5) app/src/models/User.mjs -----------------------------------------------
  {
    path: 'app/src/models/User.mjs',
    edits: [
      strEdit(
        'User: LLM per-user schema fields',
        'useOwnLLMSettings',
        [
          '    dsMobileApp: {',
          '      subscribed: { type: Boolean },',
          '    },',
        ].join('\n'),
        [
          '    dsMobileApp: {',
          '      subscribed: { type: Boolean },',
          '    },',
          '    // LLM module: per-user AI assistant settings',
          '    useOwnLLMSettings: { type: Boolean, default: false },',
          "    llmApiKey: { type: String, default: '' },",
          "    llmModelName: { type: String, default: '' },",
          "    llmApiUrl: { type: String, default: '' },",
          "    llmCompletionModel: { type: String, default: '' },",
        ].join('\n')
      ),
    ],
  },

  // 6) app/views/layout/navbar-marketing.pug ---------------------------------
  //    Tab-indented: derive indentation from the matched anchor lines so we do
  //    not hard-code tab counts (robust against reindentation drift).
  {
    path: 'app/views/layout/navbar-marketing.pug',
    edits: [
      reEdit(
        'navbar-marketing: admin LLM Settings + Compliance check items',
        "/admin/compliance/settings",
        /([^\S\r\n]*)if canDisplayScriptLogMenu(\r?\n)([^\S\r\n]*)\+dropdown-menu-link-item\(href='\/admin\/script-logs'\) View Script Logs/,
        m => {
          const ifIndent = m[1]
          const nl = m[2]
          const itemIndent = m[3]
          return (
            m[0] +
            nl +
            ifIndent +
            'if settings.llm && settings.llm.enabled' +
            nl +
            itemIndent +
            "+dropdown-menu-link-item(href='/admin/llm/settings') LLM Settings" +
            nl +
            itemIndent +
            "+dropdown-menu-link-item(href='/admin/compliance/settings') Compliance check"
          )
        }
      ),
      reEdit(
        'navbar-marketing: user AI Settings item',
        "/user/llm-settings",
        /([^\S\r\n]*)\+dropdown-menu-link-item\(href='\/user\/settings'\) #\{translate\('account_settings'\)\}(\r?\n)/,
        m => {
          const itemIndent = m[1]
          const nl = m[2]
          // one extra indent level; the file uses tab indentation.
          const childIndent = itemIndent + '\t'
          return (
            m[0] +
            itemIndent +
            'if settings.llm && settings.llm.allowUserSettings' +
            nl +
            childIndent +
            "+dropdown-menu-link-item(href='/user/llm-settings') AI Settings" +
            nl
          )
        }
      ),
    ],
  },

  // 7) shared/components/navbar/account-menu-items.tsx (getMeta already imported)
  {
    path: 'frontend/js/shared/components/navbar/account-menu-items.tsx',
    edits: [
      strEdit(
        'account-menu: AI Settings item',
        '/user/llm-settings',
        [
          '      <NavDropdownLinkItem href="/user/settings">',
          "        {t('account_settings')}",
          '      </NavDropdownLinkItem>',
        ].join('\n'),
        [
          '      <NavDropdownLinkItem href="/user/settings">',
          "        {t('account_settings')}",
          '      </NavDropdownLinkItem>',
          "      {getMeta('ol-ExposedSettings')?.llmAllowUserSettings ? (",
          '        <NavDropdownLinkItem href="/user/llm-settings">',
          "          {t('ai_settings', 'AI Settings')}",
          '        </NavDropdownLinkItem>',
          '      ) : null}',
        ].join('\n')
      ),
    ],
  },

  // 8) shared/components/navbar/admin-menu.tsx --------------------------------
  {
    path: 'frontend/js/shared/components/navbar/admin-menu.tsx',
    edits: [
      strEdit(
        'admin-menu: import getMeta',
        "import getMeta from '@/utils/meta'",
        "import { useSendProjectListMB } from '@/features/project-list/components/project-list-events'",
        "import { useSendProjectListMB } from '@/features/project-list/components/project-list-events'\nimport getMeta from '@/utils/meta'"
      ),
      // overleaf-lab: two entries, because the compliance check has its own admin
      // page now: the LLM one is about chat and inline completion.
      strEdit(
        'admin-menu: LLM Settings + Compliance check items',
        '/admin/compliance/settings',
        '    </NavDropdownMenu>\n  )\n}',
        [
          "      {(getMeta('ol-ExposedSettings') as any)?.llmEnabled ? (",
          '        <NavDropdownLinkItem href="/admin/llm/settings">',
          '          LLM Settings',
          '        </NavDropdownLinkItem>',
          '      ) : null}',
          "      {(getMeta('ol-ExposedSettings') as any)?.llmEnabled ? (",
          '        <NavDropdownLinkItem href="/admin/compliance/settings">',
          '          Compliance check',
          '        </NavDropdownLinkItem>',
          '      ) : null}',
          '    </NavDropdownMenu>',
          '  )',
          '}',
        ].join('\n')
      ),
    ],
  },

  // 9) locales/en.json — per-key insertion; only add keys that are missing.
  //    (Base 6.2.0 already ships "ai_assistant" with the same value.)
  {
    path: 'locales/en.json',
    edits: [
      localeEdit('ai_assistant', 'AI Assistant'),
      localeEdit(
        'ai_assistant_description',
        'Get help with LaTeX syntax, formatting, and troubleshooting'
      ),
      localeEdit('ask_ai_about_error', 'Ask AI about this error'),
    ],
  },

  // 10) types/exposed-settings.ts --------------------------------------------
  {
    path: 'types/exposed-settings.ts',
    edits: [
      strEdit(
        'exposed-settings: llmAllowUserSettings?: boolean',
        'llmAllowUserSettings?: boolean',
        '  linkedInInsightsPartnerId?: string\n',
        '  linkedInInsightsPartnerId?: string\n  llmAllowUserSettings?: boolean\n'
      ),
    ],
  },
]

// A locale key insertion: insert `  "key": "value",` immediately before the
// stable "ai_can_make_mistakes" key, but only if the key is not already present.
function localeEdit(key, value) {
  const anchor = '  "ai_can_make_mistakes":'
  const line = `  ${JSON.stringify(key)}: ${JSON.stringify(value)},\n`
  return {
    id: `en.json: "${key}"`,
    isDone: content => new RegExp(`\\n\\s*${JSON.stringify(key)}\\s*:`).test(content),
    run: content => {
      if (!content.includes(anchor)) return null
      return content.replace(anchor, () => line + anchor)
    },
  }
}

// -----------------------------------------------------------------------------
// Engine
// -----------------------------------------------------------------------------
const misses = []
const applied = []
const skipped = []

for (const file of FILES) {
  const abs = path.join(WEB_DIR, file.path)
  let content
  try {
    content = fs.readFileSync(abs, 'utf8')
  } catch (err) {
    misses.push(`${file.path}: cannot read file (${err.code || err.message})`)
    continue
  }
  const before = content
  for (const edit of file.edits) {
    if (edit.isDone(content)) {
      skipped.push(`${file.path} :: ${edit.id}`)
      continue
    }
    const next = edit.run(content)
    if (next == null) {
      misses.push(`${file.path} :: ${edit.id} — ANCHOR NOT FOUND`)
      continue
    }
    content = next
    applied.push(`${file.path} :: ${edit.id}`)
  }
  if (content !== before) {
    fs.writeFileSync(abs, content)
  }
}

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------
console.log(`[apply-core-patches] WEB_DIR=${WEB_DIR}`)
console.log(`[apply-core-patches] applied=${applied.length} already=${skipped.length} missed=${misses.length}`)
for (const a of applied) console.log(`  APPLIED  ${a}`)
for (const s of skipped) console.log(`  ALREADY  ${s}`)

if (misses.length > 0) {
  console.error('\n[apply-core-patches] FAILED — the following anchors were not found:')
  for (const m of misses) console.error(`  MISS     ${m}`)
  console.error(
    '\nThe base image has drifted from the expected v6.2.0-ext-v5.0 source.\n' +
      'Do NOT ship this image. Re-validate the anchors above against the base and\n' +
      'update overleaf-llm-image/patches/apply-core-patches.mjs before rebuilding.'
  )
  process.exit(1)
}

console.log('\n[apply-core-patches] OK — all functional LLM core edits are in place.')
