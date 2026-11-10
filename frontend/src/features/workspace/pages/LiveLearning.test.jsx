import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as learningApi from '../learningApi'
import CoordinatorLearningPage from './CoordinatorLearningPage'
import StudentLearningPage from './StudentLearningPage'
import LiveCohortProgressPage from './LiveCohortProgressPage'
vi.mock('../learningApi', () => ({
  listOrganizations: vi.fn(),
  createOrganization: vi.fn(),
  listRoadmaps: vi.fn(),
  createRoadmap: vi.fn(),
  publishRoadmapVersion: vi.fn(),
  listCohorts: vi.fn(),
  createCohort: vi.fn(),
  rotateCohortJoinCode: vi.fn(),
  revokeCohortJoinCode: vi.fn(),
  getCohortEnrollments: vi.fn(),
  removeCohortEnrollment: vi.fn(),
  reactivateCohortEnrollment: vi.fn(),
  withdrawFromCohort: vi.fn(),
  joinCohort: vi.fn(),
  getMyLearning: vi.fn(),
  setTopicProgress: vi.fn(),
  getCohortProgress: vi.fn(),
  getCohortDeadlines: vi.fn(),
  getCohortActivity: vi.fn(),
  setWeekDeadline: vi.fn(),
  removeWeekDeadline: vi.fn(),
}))
afterEach(cleanup)
it('preselects the published roadmap and organization from a cohort assignment link', async () => {
  learningApi.listOrganizations.mockResolvedValue([
    { id: 'other-org', name: 'Other campus', role: 'owner' },
    { id: 'target-org', name: 'Target campus', role: 'owner' },
  ])
  learningApi.listRoadmaps.mockResolvedValue([
    {
      id: 'r1',
      name: 'Another path',
      version_id: 'other-version',
      status: 'published',
      topics: [],
    },
    {
      id: 'r2',
      name: 'Chosen path',
      version_id: 'target-version',
      status: 'published',
      topics: [],
    },
  ])
  render(
    <MemoryRouter
      initialEntries={[
        '/app/coordinator/learning?organizationId=target-org&roadmapVersionId=target-version#cohort-setup',
      ]}
    >
      <CoordinatorLearningPage />
    </MemoryRouter>,
  )
  await waitFor(() =>
    expect(screen.getByLabelText('Roadmap')).toHaveValue('target-version'),
  )
  expect(learningApi.listRoadmaps).toHaveBeenCalledWith('target-org')
  expect(screen.getByLabelText('Working in')).toHaveValue('target-org')
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(learningApi.listOrganizations).mockResolvedValue([])
  vi.mocked(learningApi.listRoadmaps).mockResolvedValue([])
  vi.mocked(learningApi.listCohorts).mockResolvedValue([])
  vi.mocked(learningApi.getCohortDeadlines).mockResolvedValue({ weeks: [] })
  vi.mocked(learningApi.getCohortActivity).mockResolvedValue({
    events: [],
    next_cursor: null,
  })
})
it('lets staff create an organization, open its roadmaps, and assign an existing published version to a cohort', async () => {
  const org = { id: 'org-1', name: 'Campus', role: 'owner' }
  const roadmap = {
    id: 'roadmap-1',
    organization_id: org.id,
    name: 'Career readiness',
    description: '',
    version_id: 'version-1',
    version_number: 1,
    status: 'draft',
    topics: [{ id: 'topic-1', title: 'Set goals', description: '', week: 1 }],
  }
  const cohort = {
    id: 'cohort-1',
    organization_id: org.id,
    name: '2026 cohort',
    roadmap_version_id: roadmap.version_id,
    roadmap_name: roadmap.name,
    invite_code: 'abcdefghijklmnopqrstuvwx12345678',
    student_count: 0,
  }
  vi.mocked(learningApi.createOrganization).mockResolvedValue(org)
  vi.mocked(learningApi.listRoadmaps).mockResolvedValue([
    { ...roadmap, status: 'published' },
  ])
  vi.mocked(learningApi.createCohort).mockResolvedValue(cohort)
  render(
    <MemoryRouter>
      <CoordinatorLearningPage />
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Organization name'), {
    target: { value: 'Campus' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create organization' }))
  await waitFor(() =>
    expect(learningApi.createOrganization).toHaveBeenCalledWith('Campus'),
  )
  expect(
    await screen.findByRole('link', { name: 'Browse organization roadmaps' }),
  ).toHaveAttribute('href', '/app/coordinator/roadmaps?organizationId=org-1')
  expect(
    screen.queryByRole('button', { name: /Publish reviewed draft/ }),
  ).not.toBeInTheDocument()
  expect(learningApi.publishRoadmapVersion).not.toHaveBeenCalled()
  fireEvent.change(await screen.findByLabelText('Cohort name'), {
    target: { value: cohort.name },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create cohort' }))
  expect(await screen.findByText(cohort.invite_code)).toBeInTheDocument()
  expect(learningApi.createCohort).toHaveBeenCalledWith(
    org.id,
    cohort.name,
    roadmap.version_id,
  )
  expect(
    screen.getByRole('link', { name: /view live progress/i }),
  ).toHaveAttribute(
    'href',
    '/app/coordinator/learning/cohort-1?organizationId=org-1',
  )
})

it('isolates failed and delayed learning reads and late join codes across organizations', async () => {
  const a = { id: 'a', name: 'Campus A', role: 'owner' }
  const b = { id: 'b', name: 'Campus B', role: 'owner' }
  const cohort = {
    id: 'a-cohort',
    name: 'Cohort A',
    organization_id: a.id,
    join_code_status: 'active',
  }
  const roadmap = {
    version_id: 'a-version',
    name: 'Roadmap A',
    organization_id: a.id,
    status: 'published',
  }
  const late = Promise.withResolvers()
  const secondA = Promise.withResolvers()
  learningApi.listOrganizations.mockResolvedValue([a, b])
  learningApi.listRoadmaps.mockImplementation(async (id) =>
    id === a.id ? [roadmap] : [],
  )
  learningApi.listCohorts
    .mockResolvedValueOnce([cohort])
    .mockRejectedValueOnce(new Error('Simulated B outage'))
    .mockImplementationOnce(() => secondA.promise)
    .mockResolvedValue([])
  learningApi.rotateCohortJoinCode.mockReturnValue(late.promise)
  render(
    <MemoryRouter
      initialEntries={['/app/coordinator/learning?organizationId=a']}
    >
      <CoordinatorLearningPage />
    </MemoryRouter>,
  )
  await screen.findByText('Cohort A')
  fireEvent.click(screen.getByRole('button', { name: 'Rotate join code' }))
  const switchTo = (id) =>
    fireEvent.change(screen.getByLabelText('Working in'), {
      target: { value: id },
    })
  switchTo(b.id)
  expect(screen.queryByText('Cohort A')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Roadmap')).not.toBeInTheDocument()
  expect(await screen.findByRole('alert')).toHaveTextContent('Campus B')
  expect(screen.queryByText('No cohorts yet')).not.toBeInTheDocument()
  await act(async () =>
    late.resolve({ ...cohort, invite_code: 'obsolete-code' }),
  )
  expect(screen.queryByText('obsolete-code')).not.toBeInTheDocument()
  switchTo(a.id)
  await waitFor(() => expect(learningApi.listCohorts).toHaveBeenCalledTimes(3))
  switchTo(b.id)
  expect(await screen.findByText('No cohorts yet')).toBeInTheDocument()
  await act(async () => secondA.resolve([cohort]))
  expect(screen.queryByText('Cohort A')).not.toBeInTheDocument()
  expect(learningApi.rotateCohortJoinCode).toHaveBeenCalledExactlyOnceWith(
    cohort.id,
  )
})
it('lets a student join and persist topic completion', async () => {
  const assignment = {
    cohort_id: 'cohort-1',
    cohort_name: '2026 cohort',
    organization_name: 'Campus',
    roadmap_name: 'Career readiness',
    completed: 0,
    total: 1,
    percent: 0,
    topics: [
      {
        id: 'topic-1',
        title: 'Set goals',
        description: '',
        week: 1,
        completed: false,
        completed_at: null,
      },
    ],
  }
  vi.mocked(learningApi.getMyLearning)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([assignment])
    .mockResolvedValueOnce([
      {
        ...assignment,
        completed: 1,
        percent: 100,
        topics: [
          {
            ...assignment.topics[0],
            completed: true,
            completed_at: '2026-09-25T00:00:00Z',
          },
        ],
      },
    ])
  vi.mocked(learningApi.joinCohort).mockResolvedValue({
    cohort_id: 'cohort-1',
    cohort_name: '2026 cohort',
    organization_name: 'Campus',
  })
  vi.mocked(learningApi.setTopicProgress).mockResolvedValue()
  render(
    <MemoryRouter>
      <StudentLearningPage />
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Join code'), {
    target: { value: 'abcdefghijklmnopqrstuvwx12345678' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Join cohort' }))
  expect(
    await screen.findByRole('heading', { name: 'Career readiness' }),
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }))
  await waitFor(() =>
    expect(learningApi.setTopicProgress).toHaveBeenCalledWith('topic-1', true),
  )
  expect(await screen.findByText('1 of 1 topics completed')).toBeInTheDocument()
})
it('shows zero-progress students in the coordinator report', async () => {
  vi.mocked(learningApi.getCohortProgress).mockResolvedValue({
    cohort_id: 'cohort-1',
    cohort_name: '2026 cohort',
    roadmap_name: 'Career readiness',
    students: [
      { id: 'student-1', name: 'Mira', completed: 0, total: 1, percent: 0 },
    ],
    topics: [
      { id: 'topic-1', title: 'Set goals', completed: 0, total: 1, percent: 0 },
    ],
    average_percent: 0,
  })
  render(
    <MemoryRouter initialEntries={['/app/coordinator/learning/cohort-1']}>
      <Routes>
        <Route
          path="/app/coordinator/learning/:cohortId"
          element={<LiveCohortProgressPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
  expect(await screen.findByText('Mira')).toBeInTheDocument()
  expect(screen.getByText('0 / 1 topics')).toBeInTheDocument()
  expect(learningApi.getCohortProgress).toHaveBeenCalledWith('cohort-1')
})
it('does not request progress for a cohort outside the selected organization', async () => {
  learningApi.listOrganizations.mockResolvedValue([
    { id: 'org-a', name: 'Campus A', role: 'owner' },
    { id: 'org-b', name: 'Campus B', role: 'owner' },
  ])
  learningApi.listCohorts.mockResolvedValue([
    { id: 'cohort-1', organization_id: 'org-a' },
  ])
  render(
    <MemoryRouter
      initialEntries={[
        '/app/coordinator/learning/cohort-1?organizationId=org-b',
      ]}
    >
      <Routes>
        <Route
          path="/app/coordinator/learning/:cohortId"
          element={<LiveCohortProgressPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
  expect(
    await screen.findByRole('heading', { name: 'Cohort unavailable' }),
  ).toBeInTheDocument()
  expect(learningApi.listCohorts).toHaveBeenCalledWith('org-b')
  expect(learningApi.getCohortProgress).not.toHaveBeenCalled()
})

it('shows a useful error when a student enters an invalid join code', async () => {
  vi.mocked(learningApi.getMyLearning).mockResolvedValue([])
  vi.mocked(learningApi.joinCohort).mockRejectedValue(
    new Error('Join code was not found.'),
  )
  render(
    <MemoryRouter>
      <StudentLearningPage />
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Join code'), {
    target: { value: 'abcdefghijklmnopqrstuvwx12345678' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Join cohort' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Join code was not found.',
  )
  expect(screen.getByRole('button', { name: 'Join cohort' })).toBeEnabled()
})

it('lets coordinators rotate and revoke codes and manage cohort enrollment', async () => {
  const organization = { id: 'org-1', name: 'Campus', role: 'owner' }
  const cohort = {
    id: 'cohort-1',
    organization_id: organization.id,
    name: '2026 cohort',
    roadmap_version_id: 'version-1',
    roadmap_name: 'Career readiness',
    join_code_status: 'active',
    invite_code_expires_at: '2026-10-06T00:00:00Z',
    student_count: 1,
  }
  vi.mocked(learningApi.listOrganizations).mockResolvedValue([organization])
  vi.mocked(learningApi.listRoadmaps).mockResolvedValue([
    {
      id: 'roadmap-1',
      version_id: 'version-1',
      name: 'Career readiness',
      status: 'published',
      topics: [],
    },
  ])
  vi.mocked(learningApi.listCohorts).mockResolvedValue([cohort])
  vi.mocked(learningApi.getCohortEnrollments)
    .mockResolvedValueOnce([
      {
        id: 'enrollment-1',
        user_id: 'student-1',
        display_name: 'Mira',
        status: 'active',
      },
    ])
    .mockResolvedValueOnce([
      {
        id: 'enrollment-1',
        user_id: 'student-1',
        display_name: 'Mira',
        status: 'inactive',
        end_reason: 'staff_removed',
      },
    ])
    .mockResolvedValueOnce([
      {
        id: 'enrollment-1',
        user_id: 'student-1',
        display_name: 'Mira',
        status: 'active',
      },
    ])
  vi.mocked(learningApi.rotateCohortJoinCode).mockResolvedValue({
    ...cohort,
    invite_code: 'new-one-time-code',
  })
  vi.mocked(learningApi.revokeCohortJoinCode).mockResolvedValue()
  vi.mocked(learningApi.removeCohortEnrollment).mockResolvedValue()
  vi.mocked(learningApi.reactivateCohortEnrollment).mockResolvedValue({
    id: 'enrollment-1',
    status: 'active',
  })
  render(
    <MemoryRouter>
      <CoordinatorLearningPage />
    </MemoryRouter>,
  )
  expect(
    await screen.findByText(/Student join code · active/),
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Rotate join code' }))
  expect(await screen.findByText('new-one-time-code')).toBeInTheDocument()
  expect(learningApi.rotateCohortJoinCode).toHaveBeenCalledWith('cohort-1')
  fireEvent.click(screen.getByRole('button', { name: 'Show roster' }))
  expect(await screen.findByText('Mira')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove Mira' }))
  await waitFor(() =>
    expect(learningApi.removeCohortEnrollment).toHaveBeenCalledWith(
      'cohort-1',
      'enrollment-1',
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Reinstate Mira' }))
  await waitFor(() =>
    expect(learningApi.reactivateCohortEnrollment).toHaveBeenCalledWith(
      'cohort-1',
      'enrollment-1',
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Revoke join code' }))
  await waitFor(() =>
    expect(learningApi.revokeCohortJoinCode).toHaveBeenCalledWith('cohort-1'),
  )
  expect(screen.queryByText('new-one-time-code')).not.toBeInTheDocument()
  expect(screen.getByText(/Student join code · revoked/)).toBeInTheDocument()
})

it('lets a student withdraw from an assigned cohort without losing the join workflow', async () => {
  const assignment = {
    cohort_id: 'cohort-1',
    cohort_name: '2026 cohort',
    organization_name: 'Campus',
    roadmap_name: 'Career readiness',
    completed: 0,
    total: 0,
    percent: 0,
    topics: [],
  }
  vi.mocked(learningApi.getMyLearning)
    .mockResolvedValueOnce([assignment])
    .mockResolvedValueOnce([])
  vi.mocked(learningApi.withdrawFromCohort).mockResolvedValue()
  render(
    <MemoryRouter>
      <StudentLearningPage />
    </MemoryRouter>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Leave cohort' }))
  await waitFor(() =>
    expect(learningApi.withdrawFromCohort).toHaveBeenCalledWith('cohort-1'),
  )
  expect(
    await screen.findByText(
      'You left 2026 cohort. Your saved progress is retained.',
    ),
  ).toBeInTheDocument()
  expect(
    screen.getByRole('heading', { name: 'Join a cohort' }),
  ).toBeInTheDocument()
})
