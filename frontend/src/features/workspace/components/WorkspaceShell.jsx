import {
  useCallback,
  useEffect,
  useState,
  useRef,
  useSyncExternalStore,
} from 'react'
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router'
import {
  restoreSession,
  signOut,
  signOutAll,
  dashboardPath,
} from '../../auth/authApi'
import {
  canRestoreSession,
  getSessionPhase,
  subscribeSession,
} from '../../../shared/api/client'
import SessionStatusDialog from '../../auth/SessionStatusDialog'
import WorkspaceAccountMenu from '../../auth/WorkspaceAccountMenu'
import BrandWordmark from '../../../app/BrandWordmark'
import { PRODUCT_TAGLINE } from '../../../app/brand'
import { WorkspaceContext } from '../hooks/useWorkspace'
import {
  useOrganizationSelection,
  withOrganization,
} from '../hooks/useOrganizationScope'
import ForestLandscapeArtwork from './ForestLandscapeArtwork'
const studentLinks = [
  { to: '/app/student', label: 'Overview', end: true },
  { to: '/app/student/learning', label: 'My assigned learning' },
  { to: '/app/student/roadmap', label: 'Assigned roadmap' },
  { to: '/app/student/activity', label: 'Activity' },
  { to: '/app/student/deadlines', label: 'Deadlines' },
]
const coordinatorLinks = [
  { to: '/app/coordinator', label: 'Overview', end: true },
  { to: '/app/coordinator/learning', label: 'Live learning' },
  { to: '/app/coordinator/cohorts', label: 'Cohorts' },
  { to: '/app/coordinator/roadmaps', label: 'Roadmaps' },
  { to: '/app/coordinator/imports', label: 'Imports' },
  { to: '/app/coordinator/students', label: 'Student progress' },
  { to: '/app/coordinator/topic-statistics', label: 'Topic statistics' },
  { to: '/app/coordinator/at-risk', label: 'Student support' },
]
export default function WorkspaceShell() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const sessionPhase = useSyncExternalStore(subscribeSession, getSessionPhase)
  const unsavedEditors = useRef(new Set())
  const registerUnsavedChanges = useCallback(() => {
    const editor = Symbol()
    const editors = unsavedEditors.current
    editors.add(editor)
    return () => editors.delete(editor)
  }, [])
  const triggerRef = useRef(null),
    sidebarRef = useRef(null)
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.('(max-width: 760px)').matches ?? false,
  )
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 760px)')
    if (!media) return
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!menuOpen || !mobile) return
    const trigger = triggerRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const focusables = () =>
      Array.from(sidebarRef.current?.querySelectorAll('a,button') || [])
    focusables()[0]?.focus()
    const key = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuOpen(false)
      }
      if (e.key === 'Tab') {
        const items = focusables(),
          first = items[0],
          last = items.at(-1)
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', key)
      trigger?.focus()
    }
  }, [menuOpen, mobile])
  const location = useLocation()
  const navigate = useNavigate()
  const coordinatorView = user?.account_type === 'coordinator'
  const scope = useOrganizationSelection(coordinatorView)
  const { organization, organizations, requestedId, selectOrganization } = scope
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const restored = await restoreSession()
        if (!active) return
        if (restored && canRestoreSession()) setUser(restored)
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Unable to load your workspace.',
          )
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])
  useEffect(() => {
    if (sessionPhase === 'signed-out' || leaving) {
      navigate('/login', {
        replace: true,
        state: { signedOut: sessionPhase === 'signed-out' },
      })
    }
  }, [leaving, navigate, sessionPhase])

  function retrySignOut(scope) {
    const action = scope === 'all' ? signOutAll : signOut
    void action().catch(() => {})
  }

  function leaveWorkspace(scope) {
    if (!canRestoreSession()) return false
    if (
      unsavedEditors.current.size &&
      !window.confirm(
        'You have unsaved changes. Signing out will discard them. Sign out anyway?',
      )
    )
      return false
    retrySignOut(scope)
    return true
  }

  const sessionDialog = ['signing-out', 'logout-failed', 'expired'].includes(
    sessionPhase,
  ) && (
    <SessionStatusDialog
      phase={sessionPhase}
      onRetry={() => retrySignOut()}
      onSignIn={() => setLeaving(true)}
    />
  )
  if (leaving || sessionPhase === 'signed-out') return null
  if (sessionPhase === 'expired' || (!user && sessionDialog)) {
    return <main className="workspace-gate">{sessionDialog}</main>
  }
  if (loading)
    return (
      <main className="workspace-gate">
        <div className="workspace-gate-card">
          <BrandWordmark className="workspace-logo" />
          <p>Loading your workspace…</p>
        </div>
      </main>
    )
  if (!user)
    return (
      <main className="workspace-gate">
        <div className="workspace-gate-card">
          <BrandWordmark className="workspace-logo" />
          <h1>Sign in to continue</h1>
          <p>Your workspace is available after you sign in.</p>
          <Link className="button button-primary" to="/login">
            Sign in
          </Link>
        </div>
      </main>
    )
  const home = dashboardPath(user.account_type)
  const scoped = (path) =>
    coordinatorView ? withOrganization(path, organization?.id) : path
  if (
    location.pathname === '/app' ||
    (location.pathname.startsWith('/app/student') && coordinatorView) ||
    (location.pathname.startsWith('/app/coordinator') && !coordinatorView)
  ) {
    return <Navigate to={home} replace />
  }
  return (
    <WorkspaceContext.Provider
      value={{
        user,
        error,
        signOut: leaveWorkspace,
        registerUnsavedChanges,
        organizationScope: coordinatorView ? { ...scope, managed: true } : null,
      }}
    >
      <div className="workspace-layout">
        <aside
          className={'workspace-sidebar' + (menuOpen ? ' is-open' : '')}
          ref={sidebarRef}
          id="workspace-navigation"
          inert={mobile && !menuOpen}
          aria-label="Workspace navigation"
          onClick={(event) => {
            if (event.target.closest('a')) setMenuOpen(false)
          }}
        >
          <ForestLandscapeArtwork variant="sidebar" />
          {mobile && (
            <button className="drawer-close" onClick={() => setMenuOpen(false)}>
              Close navigation
            </button>
          )}
          <BrandWordmark
            className="workspace-brand"
            to={scoped(home)}
            tagline={PRODUCT_TAGLINE}
          />
          <div className="workspace-org">
            <span className="workspace-org-mark">
              {organization?.name[0]?.toUpperCase() || 'O'}
            </span>
            <span>
              <strong>
                {organization?.name ||
                  (coordinatorView
                    ? 'Your organizations'
                    : 'Student workspace')}
              </strong>
              <small>
                {organization
                  ? 'Organization workspace'
                  : coordinatorView
                    ? 'Manage college learning'
                    : 'Your assigned learning'}
              </small>
            </span>
            <Link
              to={
                coordinatorView
                  ? scoped('/app/organizations')
                  : '/app/student/learning'
              }
              aria-label={
                coordinatorView ? 'Organization context' : 'Assigned learning'
              }
            >
              →
            </Link>
          </div>
          <div className="workspace-view-switch" aria-label="Account type">
            <span className="is-selected">
              {coordinatorView ? 'Coordinator' : 'Student'}
            </span>
          </div>
          <nav className="workspace-nav" aria-label="Primary">
            <p className="workspace-nav-heading">
              {coordinatorView ? 'Coordinator' : 'Student'}
            </p>
            {(coordinatorView ? coordinatorLinks : studentLinks).map((item) => (
              <NavLink
                key={item.to}
                to={scoped(item.to)}
                end={item.end}
                className={({ isActive }) =>
                  'workspace-nav-link' + (isActive ? ' is-active' : '')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>{' '}
          <div className="workspace-sidebar-bottom">
            <Link to="/review/status">Build status</Link>
            <Link to="/">Public website</Link>
          </div>
        </aside>
        {menuOpen && (
          <button
            className="workspace-scrim"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
        )}
        <div className="workspace-main-area" inert={mobile && menuOpen}>
          <header
            className={
              'workspace-topbar' +
              (organizations.length ? ' has-organization-picker' : '')
            }
          >
            <div className="workspace-topbar-left">
              <button
                className="workspace-menu-button"
                type="button"
                ref={triggerRef}
                aria-controls="workspace-navigation"
                aria-label="Open menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                ☰
              </button>
              <span className="workspace-breadcrumb">
                Workspace <span>/</span>{' '}
                {(coordinatorView ? coordinatorLinks : studentLinks).find(
                  (item) => item.to === location.pathname,
                )?.label ||
                  (location.pathname.includes('activity-plans')
                    ? 'Activity plan'
                    : location.pathname.includes('versions')
                      ? 'Roadmap versions'
                      : location.pathname.startsWith(
                            '/app/coordinator/learning/',
                          )
                        ? 'Cohort report'
                        : 'Account')}
              </span>
            </div>
            {coordinatorView && organizations.length > 0 && (
              <label className="workspace-topbar-organization">
                <span className="sr-only">Organization</span>
                <select
                  aria-label="Organization"
                  value={organization?.id || ''}
                  title={organization?.name}
                  onChange={(event) => {
                    const nextId = event.currentTarget.value
                    // The current route stays authoritative while an unsaved-work prompt is open.
                    event.currentTarget.value = organization?.id ?? ''
                    selectOrganization(nextId)
                  }}
                >
                  <option value="" disabled hidden={!!organization}>
                    {requestedId !== null && !organization
                      ? 'Organization unavailable'
                      : 'Select an organization'}
                  </option>
                  {organizations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="workspace-topbar-actions">
              <WorkspaceAccountMenu
                user={user}
                accountPath={scoped('/app/account')}
                onSignOut={leaveWorkspace}
              />
            </div>
          </header>
          <main className="workspace-content" id="main-content">
            {error && (
              <div className="workspace-alert" role="alert">
                {error}
                <button
                  type="button"
                  onClick={() => setError('')}
                  aria-label="Dismiss error"
                >
                  ×
                </button>
              </div>
            )}
            <Outlet />
          </main>
        </div>
      </div>
      {sessionDialog}
    </WorkspaceContext.Provider>
  )
}
