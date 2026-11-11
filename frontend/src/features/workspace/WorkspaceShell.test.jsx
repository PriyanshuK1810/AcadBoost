import {
  cleanup,
  within,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as authApi from '../auth/authApi'
import * as reviewApi from '../review/reviewApi'
import * as learningApi from './learningApi'
import WorkspaceShell from './components/WorkspaceShell'
import useUnsavedChanges from './hooks/useUnsavedChanges'
import StudentRoadmapPage from './pages/StudentRoadmapPage'
vi.mock('../auth/authApi', () => ({
  restoreSession: vi.fn(),
  signOut: vi.fn(),
  dashboardPath: (role) =>
    role === 'coordinator' ? '/app/coordinator' : '/app/student',
}))
vi.mock('../review/reviewApi', () => ({
  getReviewOverview: vi.fn(),
  updateReviewProgress: vi.fn(),
  resetReviewProgress: vi.fn(),
}))
vi.mock('./learningApi', () => ({
  listOrganizations: vi.fn(),
  getMyLearning: vi.fn(),
  setTopicProgress: vi.fn(),
  joinCohort: vi.fn(),
  withdrawFromCohort: vi.fn(),
}))
const topic = {
  key: 'goals',
  title: 'Set your career goals',
  description: 'Choose a direction.',
  week: 1,
  status: 'not_started',
  completed_at: null,
}
const overview = {
  scenario: 'illustrative',
  student: {
    roadmap_title: 'Career Readiness',
    completed: 0,
    total: 1,
    percent: 0,
    next_topic: topic,
    phases: [
      {
        title: 'Find your direction',
        description: 'Start here.',
        topics: [topic],
      },
    ],
  },
  coordinator: {
    cohort_title: 'Example Cohort',
    roadmap_title: 'Career Readiness',
    members: [
      {
        name: 'Mira Student',
        completed: 0,
        total: 1,
        percent: 0,
        is_you: true,
      },
    ],
    average_percent: 0,
    topics: [{ title: topic.title, completed: 0, total: 1, percent: 0 }],
  },
}
function renderRoadmap() {
  return render(
    <MemoryRouter initialEntries={['/app/student/roadmap']}>
      <Routes>
        <Route path="/app" element={<WorkspaceShell />}>
          <Route path="student/roadmap" element={<StudentRoadmapPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  learningApi.listOrganizations.mockResolvedValue([])
  vi.mocked(reviewApi.getReviewOverview).mockResolvedValue(overview)
})
it('shows the actual selected organization in the coordinator sidebar', async () => {
  authApi.restoreSession.mockResolvedValue({
    id: 'staff',
    display_name: 'Coordinator',
    account_type: 'coordinator',
  })
  learningApi.listOrganizations.mockResolvedValue([
    { id: 'org-1', name: 'First campus', role: 'owner' },
    { id: 'org-2', name: 'Chosen college', role: 'coordinator' },
  ])
  render(
    <MemoryRouter
      initialEntries={['/app/coordinator/roadmaps?organizationId=org-2']}
    >
      <Routes>
        <Route path="/app" element={<WorkspaceShell />}>
          <Route path="coordinator/roadmaps" element={<h1>Roadmaps</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  expect(
    await within(
      await screen.findByRole('complementary', {
        name: 'Workspace navigation',
      }),
    ).findByText('Chosen college'),
  ).toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'Acadboost home' }),
  ).toHaveTextContent('Learning Workspace')
  expect(screen.queryByText('Outpost workspace')).not.toBeInTheDocument()
})
afterEach(cleanup)

function ScopedRoute() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output aria-label="Current route">
        {location.pathname + location.search}
      </output>
      <button onClick={() => navigate(-1)}>Go back</button>
    </>
  )
}

function mockOrganizationMemberships() {
  authApi.restoreSession.mockResolvedValue({
    id: 'staff',
    display_name: 'Coordinator',
    account_type: 'coordinator',
  })
  learningApi.listOrganizations.mockResolvedValue([
    { id: 'org-1', name: 'First campus', role: 'owner' },
    { id: 'org-2', name: 'Chosen college', role: 'owner' },
  ])
}

function renderScopedWorkspace(path) {
  mockOrganizationMemberships()
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app" element={<WorkspaceShell />}>
          <Route path="*" element={<ScopedRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

it('keeps the organization picker aligned with the draft while a switch is blocked', async () => {
  mockOrganizationMemberships()
  function DirtyEditor() {
    useUnsavedChanges(true)
    return <input aria-label="Draft text" defaultValue="Unsaved edit" />
  }
  const router = createMemoryRouter(
    [
      {
        path: '/app',
        element: <WorkspaceShell />,
        children: [
          {
            path: 'coordinator/roadmaps/:roadmapId/versions',
            element: <DirtyEditor />,
          },
          { path: 'coordinator/roadmaps', element: <h1>Roadmaps</h1> },
        ],
      },
    ],
    {
      initialEntries: [
        '/app/coordinator/roadmaps/r1/versions?organizationId=org-1',
      ],
    },
  )
  render(<RouterProvider router={router} />)
  const picker = await screen.findByRole('combobox', { name: 'Organization' })
  let valueDuringPrompt
  const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => {
    valueDuringPrompt = picker.value
    return false
  })
  try {
    fireEvent.change(picker, { target: { value: 'org-2' } })
    expect(confirm).toHaveBeenCalledOnce()
    expect(valueDuringPrompt).toBe('org-1')
    expect(picker).toHaveValue('org-1')
    expect(screen.getByLabelText('Draft text')).toHaveValue('Unsaved edit')
  } finally {
    confirm.mockRestore()
  }
})

it('preserves the selected organization through sidebar navigation and Back', async () => {
  renderScopedWorkspace('/app/coordinator?organizationId=org-2')
  const picker = await screen.findByRole('combobox', { name: 'Organization' })
  expect(picker).toHaveValue('org-2')
  const cohorts = screen.getByRole('link', { name: 'Cohorts' })
  expect(cohorts).toHaveAttribute(
    'href',
    '/app/coordinator/cohorts?organizationId=org-2',
  )
  fireEvent.click(cohorts)
  fireEvent.change(picker, { target: { value: 'org-1' } })
  expect(screen.getByLabelText('Current route')).toHaveTextContent(
    '/app/coordinator/cohorts?organizationId=org-1',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
  expect(picker).toHaveValue('org-2')
  expect(learningApi.listOrganizations).toHaveBeenCalledTimes(1)
})

it.each([
  ['/app/coordinator/learning/c1', '/app/coordinator/learning'],
  ['/app/coordinator/activity-plans/p1', '/app/coordinator/roadmaps'],
  ['/app/coordinator/roadmaps/r1/versions', '/app/coordinator/roadmaps'],
])(
  'switches from %s without reusing the old resource ID',
  async (path, destination) => {
    renderScopedWorkspace(`${path}?organizationId=org-1&versionId=v1`)
    const picker = await screen.findByRole('combobox', { name: 'Organization' })
    fireEvent.change(picker, { target: { value: 'org-2' } })
    expect(screen.getByLabelText('Current route')).toHaveTextContent(
      `${destination}?organizationId=org-2`,
    )
  },
)

it('uses the organization detail path ahead of a conflicting query', async () => {
  renderScopedWorkspace('/app/organizations/org-1?organizationId=org-2')
  expect(
    await screen.findByRole('combobox', { name: 'Organization' }),
  ).toHaveValue('org-1')
})
it('requires a signed-in account before loading workspace data', async () => {
  vi.mocked(authApi.restoreSession).mockResolvedValue(null)
  renderRoadmap()
  expect(
    await screen.findByRole('heading', { name: 'Sign in to continue' }),
  ).toBeInTheDocument()
  expect(reviewApi.getReviewOverview).not.toHaveBeenCalled()
})
it('loads assigned learning without sample data and preserves completion when saving fails', async () => {
  vi.mocked(authApi.restoreSession).mockResolvedValue({
    id: 'user-1',
    display_name: 'Mira Student',
    username: 'mira',
    primary_email: 'mira@example.edu',
    email_verified_at: null,
    account_type: 'student',
  })
  learningApi.getMyLearning.mockResolvedValue([
    {
      cohort_id: 'c1',
      cohort_name: 'Class',
      organization_name: 'Campus',
      roadmap_name: 'Live roadmap',
      roadmap_version_number: 1,
      completed: 0,
      total: 1,
      percent: 0,
      topics: [{ id: 't1', title: 'Live topic', completed: false }],
    },
  ])
  let rejectSave = () => undefined
  vi.mocked(learningApi.setTopicProgress).mockReturnValue(
    new Promise((_, reject) => {
      rejectSave = reject
    }),
  )
  renderRoadmap()
  fireEvent.click(await screen.findByRole('button', { name: 'Mark complete' }))
  expect(learningApi.setTopicProgress).toHaveBeenCalledWith('t1', true)
  expect(reviewApi.getReviewOverview).not.toHaveBeenCalled()
  rejectSave(new Error('Save failed'))
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refresh your learning to check the saved state.',
    ),
  )
  expect(screen.getByText('0 of 1 topics completed')).toBeInTheDocument()
})
it.each([
  ['student', '/app/coordinator', 'Student workspace'],
  ['coordinator', '/app/student', 'Coordinator workspace'],
])(
  'keeps a %s account out of the other dashboard',
  async (accountType, start, expected) => {
    vi.mocked(authApi.restoreSession).mockResolvedValue({
      id: 'user-1',
      display_name: 'Mira',
      username: 'mira',
      primary_email: 'mira@example.edu',
      email_verified_at: null,
      account_type: accountType,
    })
    render(
      <MemoryRouter initialEntries={[start]}>
        <Routes>
          <Route path="/app" element={<WorkspaceShell />}>
            <Route path="student" element={<h1>Student workspace</h1>} />
            <Route
              path="coordinator"
              element={<h1>Coordinator workspace</h1>}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
    expect(
      await screen.findByRole('heading', { name: expected }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', {
        name:
          expected === 'Student workspace'
            ? 'Coordinator workspace'
            : 'Student workspace',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /Coordinator preview/i }),
    ).not.toBeInTheDocument()
  },
)
it('opens a focus-contained mobile drawer and restores focus with Escape', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  authApi.restoreSession.mockResolvedValue({
    id: 'u',
    display_name: 'Mira',
    account_type: 'student',
  })
  learningApi.getMyLearning.mockResolvedValue([])
  renderRoadmap()
  const trigger = await screen.findByRole('button', { name: 'Open menu' })
  expect(document.querySelector('.workspace-sidebar')).toHaveAttribute('inert')
  trigger.focus()
  fireEvent.click(trigger)
  expect(document.querySelector('.workspace-main-area')).toHaveAttribute(
    'inert',
  )
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(trigger).toHaveFocus()
  expect(document.querySelector('.workspace-sidebar')).toHaveAttribute('inert')
  vi.unstubAllGlobals()
})
