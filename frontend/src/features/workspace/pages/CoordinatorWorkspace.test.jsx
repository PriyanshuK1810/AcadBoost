import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../learningApi'
import CoordinatorDashboardPage from './CoordinatorDashboardPage'
import StudentProgressPage from './StudentProgressPage'
import TopicStatisticsPage from './TopicStatisticsPage'
import AtRiskPage from './AtRiskPage'
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
