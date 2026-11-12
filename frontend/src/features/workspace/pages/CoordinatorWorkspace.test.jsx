import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../learningApi'
import CoordinatorDashboardPage from './CoordinatorDashboardPage'
import StudentProgressPage from './StudentProgressPage'
import TopicStatisticsPage from './TopicStatisticsPage'
import AtRiskPage from './AtRiskPage'
import ImportsPage from './ImportsPage'
vi.mock('../learningApi', () => ({
  listOrganizations: vi.fn(),
  listCohorts: vi.fn(),
  listRoadmaps: vi.fn(),
  getCohortProgress: vi.fn(),
}))
const report = {
  cohort_id: 'c1',
  cohort_name: 'Actual lab',
  roadmap_name: 'Programming',
  roadmap_version_number: 3,
  average_percent: 25,
  metrics: {
    eligible_students: 2,
    topics: 2,
    completed_topic_assignments: 1,
    possible_topic_assignments: 4,
  },
  students: [
    {
      id: 's1',
      name: 'Mira',
      completed: 1,
      total: 2,
      percent: 50,
      below_average: false,
    },
    {
      id: 's2',
      name: 'Arun',
      completed: 0,
      total: 2,
      percent: 0,
      below_average: true,
    },
  ],
  topics: [
    { id: 't1', title: 'Functions', completed: 1, total: 2, percent: 50 },
  ],
}
function show(Page) {
  return render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>,
  )
}
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  api.listOrganizations.mockResolvedValue([
    { id: 'o1', name: 'Campus', role: 'owner' },
  ])
  api.listRoadmaps.mockResolvedValue([])
  api.listCohorts.mockResolvedValue([
    {
      id: 'c1',
      name: 'Actual lab',
      roadmap_name: 'Programming',
      student_count: 2,
    },
  ])
  api.getCohortProgress.mockResolvedValue(report)
})
it('renders selected live cohort metrics and pinned version without sample context', async () => {
  show(CoordinatorDashboardPage)
  expect(
    await screen.findByText('1 / 4 completed topic assignments'),
  ).toBeInTheDocument()
  expect(screen.getByText(/Version 3/)).toBeInTheDocument()
  expect(screen.queryByText('Illustrative scenario')).not.toBeInTheDocument()
})
it.each([
  [StudentProgressPage, 'Arun'],
  [TopicStatisticsPage, 'Functions'],
  [AtRiskPage, 'Arun'],
])(
  'reads real report data for coordinator detail pages',
  async (Page, name) => {
    show(Page)
    expect(await screen.findByText(name)).toBeInTheDocument()
  },
)
it('explains empty institutions and retryable report errors', async () => {
  api.getCohortProgress
    .mockRejectedValueOnce(new Error('Access denied'))
    .mockResolvedValueOnce(report)
  show(CoordinatorDashboardPage)
  expect(await screen.findByRole('alert')).toHaveTextContent('Access denied')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(
    await screen.findByText('1 / 4 completed topic assignments'),
  ).toBeInTheDocument()
})
it('shows an organization setup action when no active organizations exist', async () => {
  api.listOrganizations.mockResolvedValue([])
  show(CoordinatorDashboardPage)
  expect(
    await screen.findByText('No active organization yet'),
  ).toBeInTheDocument()
  expect(api.getCohortProgress).not.toHaveBeenCalled()
})
it('offers roadmap preparation as the sole primary empty-state action without published content', async () => {
  api.listCohorts.mockResolvedValue([])
  api.listRoadmaps.mockResolvedValue([])
  show(CoordinatorDashboardPage)
  expect(
    await screen.findByRole('link', { name: 'Prepare a roadmap' }),
  ).toHaveAttribute('href', '/app/coordinator/roadmaps?organizationId=o1')
  expect(
    screen.queryByRole('link', { name: 'Manage live learning' }),
  ).not.toBeInTheDocument()
})

it('loads the requested organization and ignores an obsolete report when B fails', async () => {
  const delayed = Promise.withResolvers()
  api.listOrganizations.mockResolvedValue([
    { id: 'o2', name: 'Other campus', role: 'owner' },
    { id: 'o1', name: 'Campus', role: 'owner' },
  ])
  api.listCohorts
    .mockResolvedValueOnce([
      { id: 'c1', name: 'Actual lab', organization_id: 'o1' },
    ])
    .mockRejectedValueOnce(new Error('B unavailable'))
    .mockResolvedValueOnce([
      { id: 'c2', name: 'New lab', organization_id: 'o2' },
    ])
  api.getCohortProgress
    .mockReturnValueOnce(delayed.promise)
    .mockResolvedValueOnce({
      ...report,
      cohort_id: 'c2',
      cohort_name: 'New lab',
    })
  render(
    <MemoryRouter initialEntries={['/app/coordinator?organizationId=o1']}>
      <CoordinatorDashboardPage />
    </MemoryRouter>,
  )
  await waitFor(() =>
    expect(api.getCohortProgress).toHaveBeenCalledExactlyOnceWith('c1'),
  )
  expect(api.listCohorts).toHaveBeenCalledExactlyOnceWith('o1')
  fireEvent.change(screen.getByLabelText('Organization'), {
    target: { value: 'o2' },
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('B unavailable')
  await act(async () => delayed.resolve(report))
  expect(screen.queryByText('Actual lab')).not.toBeInTheDocument()
  expect(screen.queryByText('No active cohorts')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(
    await screen.findByRole('heading', { name: 'New lab' }),
  ).toBeInTheDocument()
  expect(api.getCohortProgress).toHaveBeenLastCalledWith('c2')
})

it('keeps a valid cohort in the URL and restores the previous selection with Back', async () => {
  api.listCohorts.mockResolvedValue([
    { id: 'c1', name: 'Actual lab', organization_id: 'o1' },
    { id: 'c2', name: 'Next lab', organization_id: 'o1' },
  ])
  api.getCohortProgress.mockImplementation(async (id) => ({
    ...report,
    cohort_id: id,
    cohort_name: id === 'c1' ? 'Actual lab' : 'Next lab',
  }))
  function Back() {
    const navigate = useNavigate()
    return <button onClick={() => navigate(-1)}>Go back</button>
  }
  render(
    <MemoryRouter
      initialEntries={['/app/coordinator?organizationId=o1&cohortId=c2']}
    >
      <Back />
      <CoordinatorDashboardPage />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('heading', { name: 'Next lab' })).toBeVisible()
  expect(
    screen.getByRole('link', { name: /open cohort details/i }),
  ).toHaveAttribute('href', '/app/coordinator/learning/c2?organizationId=o1')
  fireEvent.change(screen.getByLabelText('Cohort'), { target: { value: 'c1' } })
  expect(
    await screen.findByRole('heading', { name: 'Actual lab' }),
  ).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Go back' }))
  expect(await screen.findByRole('heading', { name: 'Next lab' })).toBeVisible()
})

it('keeps out-of-scope cohort filters away from the progress API', async () => {
  render(
    <MemoryRouter
      initialEntries={['/app/coordinator?organizationId=o1&cohortId=foreign']}
    >
      <CoordinatorDashboardPage />
    </MemoryRouter>,
  )
  expect(
    await screen.findByRole('status', { name: 'Cohort selection' }),
  ).toHaveTextContent('The requested cohort is unavailable')
  expect(
    await screen.findByRole('heading', { name: 'Actual lab' }),
  ).toBeVisible()
  expect(api.getCohortProgress).toHaveBeenCalledExactlyOnceWith('c1')
  fireEvent.click(screen.getByRole('button', { name: 'Reset cohort filter' }))
  expect(
    screen.queryByRole('status', { name: 'Cohort selection' }),
  ).not.toBeInTheDocument()
})

it('labels an empty cohort separately from saved zero progress', async () => {
  api.getCohortProgress.mockResolvedValue({
    ...report,
    average_percent: 0,
    students: [],
    metrics: {
      ...report.metrics,
      eligible_students: 0,
      completed_topic_assignments: 0,
      possible_topic_assignments: 0,
    },
  })
  show(CoordinatorDashboardPage)
  expect(
    await screen.findByRole('heading', { name: 'No eligible students yet' }),
  ).toBeVisible()
  expect(
    screen.getByText('No eligible student–topic assignments'),
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: /download|export/i }),
  ).not.toBeInTheDocument()
})

it('keeps the roster unavailable state free of upload controls', () => {
  show(ImportsPage)
  expect(
    screen.getByRole('heading', { name: 'CSV roster import is unavailable' }),
  ).toBeVisible()
  expect(document.querySelector('input[type=file]')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /upload|import/i }),
  ).not.toBeInTheDocument()
})

it('rejects a report for a different assigned version', async () => {
  api.listCohorts.mockResolvedValue([
    {
      id: 'c1',
      name: 'Actual lab',
      organization_id: 'o1',
      roadmap_version_id: 'pinned',
    },
  ])
  api.getCohortProgress.mockResolvedValue({
    ...report,
    roadmap_version_id: 'different',
  })
  show(CoordinatorDashboardPage)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This cohort report could not be confirmed.',
  )
  expect(
    screen.queryByText('1 / 4 completed topic assignments'),
  ).not.toBeInTheDocument()
})

it('shows unavailable aggregate totals and retains the received student rows', async () => {
  api.getCohortProgress.mockResolvedValue({ ...report, metrics: undefined })
  show(StudentProgressPage)
  expect(
    await screen.findByText('Completion totals are unavailable'),
  ).toBeVisible()
  const search = screen.getByRole('searchbox', { name: 'Find a student' })
  fireEvent.change(search, { target: { value: 'missing' } })
  expect(screen.getByText('No students match this view.')).toBeVisible()
  fireEvent.change(search, { target: { value: '' } })
  expect(screen.getByRole('rowheader', { name: 'Arun' })).toBeVisible()
  expect(screen.getByText('0 / 2 topics')).toBeVisible()
})
