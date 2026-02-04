/**
 * Super Admin Patch for Overleaf CEP
 *
 * This script runs inside the sharelatex container at startup.
 * It patches AdminToolsRouter.mjs and router.mjs to add super_admin
 * role checks on sensitive admin routes.
 *
 * After patching:
 * - /admin (Manage Site) → requires super_admin
 * - /admin/project/* (Manage Projects) → requires super_admin
 * - /admin/user/:id/delete, DELETE /admin/user/:id → requires super_admin
 * - /admin/user (Manage Users, list/create/update) → requires isAdmin only (unchanged)
 */

const fs = require('fs')

const ADMIN_TOOLS_ROUTER = '/overleaf/services/web/modules/admin-tools/app/src/AdminToolsRouter.mjs'
const MAIN_ROUTER = '/overleaf/services/web/app/src/router.mjs'

const PATCH_MARKER = 'SUPER_ADMIN_PATCH'

// The ensureUserIsSuperAdmin middleware function (ESM compatible)
// Queries MongoDB directly so it doesn't depend on session serialization of adminRoles
function getSuperAdminMiddlewareCode(mongoImportPath, sessionManagerImportPath) {
  return `
// ${PATCH_MARKER}: Import for super_admin role check
import { db as _saDb, ObjectId as _saObjectId } from '${mongoImportPath}'
import _saSessionManager from '${sessionManagerImportPath}'

// ${PATCH_MARKER}: Middleware to ensure user has super_admin role
async function ensureUserIsSuperAdmin(req, res, next) {
  const user = _saSessionManager.getSessionUser(req.session)
  if (!user || user.isAdmin !== true) {
    return res.redirect('/restricted')
  }
  try {
    const dbUser = await _saDb.users.findOne(
      { _id: new _saObjectId(user._id) },
      { projection: { adminRoles: 1 } }
    )
    if (dbUser && dbUser.adminRoles && dbUser.adminRoles.includes('super_admin')) {
      return next()
    }
  } catch (err) {
    console.error('[Super Admin] DB error checking super_admin role:', err)
  }
  return res.redirect('/restricted')
}
`
}

function patchAdminToolsRouter() {
  if (!fs.existsSync(ADMIN_TOOLS_ROUTER)) {
    console.log('[Super Admin] AdminToolsRouter.mjs not found, skipping')
    return false
  }

  let content = fs.readFileSync(ADMIN_TOOLS_ROUTER, 'utf8')

  // If already patched, restore from backup first to re-apply cleanly
  if (content.includes(PATCH_MARKER)) {
    const bakFile = ADMIN_TOOLS_ROUTER + '.bak'
    if (fs.existsSync(bakFile)) {
      console.log('[Super Admin] Re-patching AdminToolsRouter.mjs from backup')
      content = fs.readFileSync(bakFile, 'utf8')
    } else {
      console.log('[Super Admin] AdminToolsRouter.mjs already patched (no backup to re-apply)')
      return true
    }
  } else {
    // First time: create backup
    fs.writeFileSync(ADMIN_TOOLS_ROUTER + '.bak', content)
  }

  // Relative paths from modules/admin-tools/app/src/
  const mongoPath = '../../../../app/src/infrastructure/mongodb.mjs'
  const sessionManagerPath = '../../../../app/src/Features/Authentication/SessionManager.mjs'

  const middlewareCode = getSuperAdminMiddlewareCode(mongoPath, sessionManagerPath)

  // Find the last import statement and insert our code after it
  const importRegex = /^import\s+.+$/gm
  let lastImportEnd = 0
  let match
  while ((match = importRegex.exec(content)) !== null) {
    lastImportEnd = match.index + match[0].length
  }

  if (lastImportEnd > 0) {
    content = content.slice(0, lastImportEnd) + '\n' + middlewareCode + content.slice(lastImportEnd)
  } else {
    content = middlewareCode + '\n' + content
  }

  // Replace ensureUserIsSiteAdmin with ensureUserIsSuperAdmin on ALL /admin/project routes
  // Routes are multi-line: path on one line, middleware on the next, e.g.:
  //   webRouter.get('/admin/project',
  //     AuthorizationMiddleware.ensureUserIsSiteAdmin,
  //   webRouter.post('/admin/project/:project_id/trash',
  //     AuthorizationMiddleware.ensureUserIsSiteAdmin,
  const lines = content.split('\n')
  let prevLineHadProjectRoute = false
  let replacementCount = 0
  const finalLines = lines.map(line => {
    // Same-line case: both path and middleware on one line
    if (line.includes('/admin/project') && line.includes('ensureUserIsSiteAdmin')) {
      replacementCount++
      return line.replace(/AuthorizationMiddleware\.ensureUserIsSiteAdmin/g, 'ensureUserIsSuperAdmin')
    }
    // Multi-line case: path line contains /admin/project (any sub-route)
    if (line.includes('/admin/project')) {
      prevLineHadProjectRoute = true
      return line
    }
    // Next line after a project route path: replace middleware if present
    if (prevLineHadProjectRoute && line.includes('ensureUserIsSiteAdmin')) {
      prevLineHadProjectRoute = false
      replacementCount++
      return line.replace(/AuthorizationMiddleware\.ensureUserIsSiteAdmin/g, 'ensureUserIsSuperAdmin')
    }
    // Reset flag if next non-empty line doesn't have the middleware
    if (prevLineHadProjectRoute && line.trim() !== '') {
      prevLineHadProjectRoute = false
    }
    return line
  })

  console.log(`[Super Admin] Replaced ensureUserIsSiteAdmin on ${replacementCount} /admin/project route(s)`)
  content = finalLines.join('\n')

  // Third pass: restrict user delete/purge routes to super_admin
  // Target routes:
  //   webRouter.post('/admin/user/:userId/delete',
  //     AuthorizationMiddleware.ensureUserIsSiteAdmin,
  //   webRouter.delete('/admin/user/:userId',
  //     AuthorizationMiddleware.ensureUserIsSiteAdmin,
  const lines2 = content.split('\n')
  let prevLineHadDeleteRoute = false
  let deleteReplacementCount = 0
  const deleteLines = lines2.map(line => {
    // Match: POST /admin/user/:userId/delete (path contains /delete)
    // Match: webRouter.delete('/admin/user/ (HTTP DELETE method on user route)
    const isUserDeleteRoute = (
      (line.includes('/admin/user') && line.includes('/delete')) ||
      (line.match(/webRouter\.delete\s*\(/) && line.includes('/admin/user'))
    )

    // Same-line case
    if (isUserDeleteRoute && line.includes('ensureUserIsSiteAdmin')) {
      deleteReplacementCount++
      return line.replace(/AuthorizationMiddleware\.ensureUserIsSiteAdmin/g, 'ensureUserIsSuperAdmin')
    }
    // Multi-line case: path on this line
    if (isUserDeleteRoute) {
      prevLineHadDeleteRoute = true
      return line
    }
    // Next line: replace middleware
    if (prevLineHadDeleteRoute && line.includes('ensureUserIsSiteAdmin')) {
      prevLineHadDeleteRoute = false
      deleteReplacementCount++
      return line.replace(/AuthorizationMiddleware\.ensureUserIsSiteAdmin/g, 'ensureUserIsSuperAdmin')
    }
    if (prevLineHadDeleteRoute && line.trim() !== '') {
      prevLineHadDeleteRoute = false
    }
    return line
  })

  console.log(`[Super Admin] Replaced ensureUserIsSiteAdmin on ${deleteReplacementCount} user delete route(s)`)
  content = deleteLines.join('\n')

  fs.writeFileSync(ADMIN_TOOLS_ROUTER, content)
  console.log('[Super Admin] AdminToolsRouter.mjs patched successfully')
  return true
}

function patchMainRouter() {
  if (!fs.existsSync(MAIN_ROUTER)) {
    console.log('[Super Admin] router.mjs not found, skipping')
    return false
  }

  let content = fs.readFileSync(MAIN_ROUTER, 'utf8')

  // If already patched, restore from backup first to re-apply cleanly
  if (content.includes(PATCH_MARKER)) {
    const bakFile = MAIN_ROUTER + '.bak'
    if (fs.existsSync(bakFile)) {
      console.log('[Super Admin] Re-patching router.mjs from backup')
      content = fs.readFileSync(bakFile, 'utf8')
    } else {
      console.log('[Super Admin] router.mjs already patched (no backup to re-apply)')
      return true
    }
  } else {
    // First time: create backup
    fs.writeFileSync(MAIN_ROUTER + '.bak', content)
  }

  // Relative paths from app/src/
  const mongoPath = './infrastructure/mongodb.mjs'
  const sessionManagerPath = './Features/Authentication/SessionManager.mjs'

  const middlewareCode = getSuperAdminMiddlewareCode(mongoPath, sessionManagerPath)

  // Find the last top-level import and insert after it
  const importRegex = /^import\s+.+$/gm
  let lastImportEnd = 0
  let match
  while ((match = importRegex.exec(content)) !== null) {
    lastImportEnd = match.index + match[0].length
  }

  if (lastImportEnd > 0) {
    content = content.slice(0, lastImportEnd) + '\n' + middlewareCode + content.slice(lastImportEnd)
  } else {
    content = middlewareCode + '\n' + content
  }

  // Replace ensureUserIsSiteAdmin (or ensureUserIsAdmin) with ensureUserIsSuperAdmin
  // ONLY on the main /admin route (exact match, not /admin/user or /admin/project)
  // The route and middleware may be on the same or different lines
  const lines = content.split('\n')
  let prevLineHadAdminRoute = false
  let replacementCount = 0
  const modifiedLines = lines.map(line => {
    // Check for exact '/admin' (not /admin/) with admin middleware on the same line
    if ((line.includes('ensureUserIsSiteAdmin') || line.includes('ensureUserIsAdmin')) &&
        (line.match(/['"]\/admin['"]/) || line.match(/['"]\/admin['"]\s*,/)) &&
        !line.includes('/admin/')) {
      replacementCount++
      return line.replace(/AuthorizationMiddleware\.ensureUserIsSiteAdmin/g, 'ensureUserIsSuperAdmin')
                 .replace(/ensureUserIsAdmin/g, 'ensureUserIsSuperAdmin')
    }
    // Check for '/admin' on its own line (multi-line route definition)
    if ((line.match(/['"]\/admin['"]/) || line.match(/['"]\/admin['"]\s*,/)) &&
        !line.includes('/admin/')) {
      prevLineHadAdminRoute = true
      return line
    }
    if (prevLineHadAdminRoute && (line.includes('ensureUserIsSiteAdmin') || line.includes('ensureUserIsAdmin'))) {
      prevLineHadAdminRoute = false
      replacementCount++
      return line.replace(/AuthorizationMiddleware\.ensureUserIsSiteAdmin/g, 'ensureUserIsSuperAdmin')
                 .replace(/ensureUserIsAdmin/g, 'ensureUserIsSuperAdmin')
    }
    if (prevLineHadAdminRoute && line.trim() !== '') {
      prevLineHadAdminRoute = false
    }
    return line
  })

  console.log(`[Super Admin] Replaced admin middleware on ${replacementCount} /admin route(s)`)
  content = modifiedLines.join('\n')

  fs.writeFileSync(MAIN_ROUTER, content)
  console.log('[Super Admin] router.mjs patched successfully')
  return true
}

// Execute
console.log('[Super Admin] Starting super_admin route patches...')
const r1 = patchAdminToolsRouter()
const r2 = patchMainRouter()

if (r1 || r2) {
  console.log('[Super Admin] Route patching complete')
} else {
  console.log('[Super Admin] No files were patched (files not found or already patched)')
}
