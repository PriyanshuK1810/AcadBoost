import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../learningApi'
import { WorkspaceContext } from '../hooks/useWorkspace'
import StudentDashboardPage from './StudentDashboardPage'
import StudentLearningPage from './StudentLearningPage'
import StudentRoadmapPage from './StudentRoadmapPage'

vi.mock('../learningApi', () => ({
  getMyLearning: vi.fn(),
  setTopicProgress: vi.fn(),
  joinCohort: vi.fn(),
  withdrawFromCohort: vi.fn(),
}))
const topic = {
  id: 't1',
  title: 'First live topic',
  description: 'Practice',
  order_index: 0,
  week: 0,
  completed: false,
  completed_at: null,
}
const assignment = {
  cohort_id: 'c1',
  cohort_name: 'Lab group',
  organization_name: 'Campus',
  roadmap_name: 'Programming',
  roadmap_version_id: 'v1',
  roadmap_version_number: 3,
  completed: 0,
  total: 1,
  percent: 0,
  topics: [topic],
  phases: [
    {
      id: 'p1',
      title: 'Foundations',
      weeks: [{ id: 'w1', title: 'Getting started', topics: [topic] }],
    },
  ],
}
function show(Page, entry = '/') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <WorkspaceContext.Provider value={{ user: { display_name: 'Mira' } }}>
        <Page />
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  )
}
afterEach(cleanup)
beforeEach(() => vi.resetAllMocks())
it('keeps a slow learning retry in a loading state rather than showing empty learning', async () => {
  let resolveRead
  api.getMyLearning
    .mockRejectedValueOnce(new Error('Disconnected'))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
  show(StudentLearningPage)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(screen.getByRole('status')).toHaveTextContent(/Loading/)
  expect(screen.queryByText('No assigned roadmap yet')).not.toBeInTheDocument()
  await waitFor(() => expect(api.getMyLearning).toHaveBeenCalledTimes(2))
  resolveRead([assignment])
  await screen.findByText('Getting started')
})
it('makes live cohort progress and the pinned version the student dashboard', async () => {
  api.getMyLearning.mockResolvedValue([assignment])
  show(StudentDashboardPage)
  expect(
    await screen.findByRole('heading', { name: 'Programming' }),
  ).toBeInTheDocument()
  expect(screen.getByText(/Version 3/)).toBeInTheDocument()
  expect(
    screen.getByRole('heading', { name: 'First live topic' }),
  ).toBeInTheDocument()
  expect(screen.queryByText(/Review scenario/)).not.toBeInTheDocument()
})
it('shows a retryable error rather than calling failed reads an empty assignment list', async () => {
  api.getMyLearning
    .mockRejectedValueOnce(new Error('Network unavailable'))
    .mockResolvedValueOnce([])
  show(StudentDashboardPage)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Network unavailable',
  )
  expect(screen.queryByText('No assigned roadmap yet')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('No assigned roadmap yet')).toBeInTheDocument()
})
it('shows the ordered phase/week tree and reloads persisted progress after a write', async () => {
  api.getMyLearning.mockResolvedValueOnce([assignment]).mockResolvedValueOnce([
    {
      ...assignment,
      completed: 1,
      percent: 100,
      topics: [{ ...topic, completed: true }],
      phases: [
        {
          ...assignment.phases[0],
          weeks: [
            {
              ...assignment.phases[0].weeks[0],
              topics: [{ ...topic, completed: true }],
            },
          ],
        },
      ],
    },
  ])
  api.setTopicProgress.mockResolvedValue(undefined)
  show(StudentLearningPage)
  expect(
    await screen.findByRole('heading', { name: 'Getting started' }),
  ).toBeInTheDocument()
  expect(screen.getByText('Foundations').closest('details')).toHaveAttribute(
    'open',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }))
  expect(
    await screen.findByRole('button', { name: 'Completed ✓' }),
  ).toHaveAttribute('aria-pressed', 'true')
  expect(api.setTopicProgress).toHaveBeenCalledWith('t1', true)
})
it('keeps cohorts distinct while counting shared assigned topics only once', async () => {
  api.getMyLearning.mockResolvedValue([
    assignment,
    { ...assignment, cohort_id: 'c2', cohort_name: 'Second group' },
  ])
  show(StudentDashboardPage)
  expect(
    await screen.findByText('Of 1 distinct assigned topics'),
  ).toBeInTheDocument()
  expect(screen.getByText(/Campus \/ Second group/)).toBeInTheDocument()
  expect(screen.getAllByRole('heading', { name: 'Programming' })).toHaveLength(
    2,
  )
  expect(
    screen.getByRole('link', { name: 'Continue learning in Second group' }),
  ).toHaveAttribute('href', '/app/student/roadmap?cohortId=c2')
})

it('shows only the cohort from an authorized deep link and switches to a different pinned version', async () => {
  api.getMyLearning.mockResolvedValue([
    assignment,
    {
      ...assignment,
      cohort_id: 'c2',
      cohort_name: 'Second group',
      roadmap_name: 'Second curriculum',
      roadmap_version_id: 'v2',
      roadmap_version_number: 4,
    },
  ])
  show(StudentRoadmapPage, '/app/student/roadmap?cohortId=c1')
  expect(await screen.findByText('Assigned version 3')).toBeInTheDocument()
  expect(screen.queryByText('Second curriculum')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Join cohort' }),
  ).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('combobox', { name: 'Cohort' }), {
    target: { value: 'c2' },
  })
  expect(screen.getByText('Assigned version 4')).toBeInTheDocument()
  expect(screen.queryByText('Assigned version 3')).not.toBeInTheDocument()
})

it('keeps unavailable cohort links from showing a different cohort', async () => {
  api.getMyLearning.mockResolvedValue([assignment])
  show(StudentRoadmapPage, '/app/student/roadmap?cohortId=unavailable')
  expect(
    await screen.findByText('This cohort is unavailable'),
  ).toBeInTheDocument()
  expect(screen.queryByText('Programming')).not.toBeInTheDocument()
})

it('validates an empty code and gives the same recovery for invalid, expired, or revoked codes', async () => {
  api.getMyLearning.mockResolvedValue([])
  api.joinCohort.mockRejectedValue({ status: 404 })
  show(StudentLearningPage)
  await screen.findByText('No assigned roadmap yet')
  const join = screen.getByRole('button', { name: 'Join cohort' })
  fireEvent.click(join)
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Enter your cohort’s join code',
  )
  expect(api.joinCohort).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Join code'), {
    target: { value: 'x'.repeat(43) },
  })
  fireEvent.click(join)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'invalid, expired, or revoked',
  )
  expect(screen.queryByText(/You joined/)).not.toBeInTheDocument()
})

it('preserves confirmed enrollment through a failed refresh and retries only the read', async () => {
  api.getMyLearning
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('Read failed'))
    .mockResolvedValueOnce([assignment])
  let confirmJoin
  api.joinCohort.mockImplementation(
    () =>
      new Promise((resolve) => {
        confirmJoin = resolve
      }),
  )
  show(StudentLearningPage)
  await screen.findByText('No assigned roadmap yet')
  fireEvent.change(screen.getByLabelText('Join code'), {
    target: { value: 'x'.repeat(43) },
  })
  const button = screen.getByRole('button', { name: 'Join cohort' })
  fireEvent.click(button)
  fireEvent.submit(button.closest('form'))
  expect(api.joinCohort).toHaveBeenCalledTimes(1)
  confirmJoin({ cohort_id: 'c1', cohort_name: 'Lab group' })
  expect(await screen.findByText('You joined Lab group.')).toBeInTheDocument()
  expect(await screen.findByRole('alert')).toHaveTextContent('Read failed')
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(
    await screen.findByRole('link', { name: 'Open assigned learning' }),
  ).toHaveAttribute('href', '/app/student/roadmap?cohortId=c1')
  expect(api.joinCohort).toHaveBeenCalledTimes(1)
})

it('requires a refresh after an uncertain write without replaying it', async () => {
  api.getMyLearning.mockResolvedValue([assignment])
  api.setTopicProgress.mockRejectedValue(new Error('Connection lost'))
  show(StudentRoadmapPage)
  const topic = await screen.findByRole('button', { name: 'Mark complete' })
  fireEvent.click(topic)
  expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t confirm')
  expect(topic).toBeDisabled()
  expect(topic).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh your learning' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Mark complete' })).toBeEnabled(),
  )
  expect(api.setTopicProgress).toHaveBeenCalledExactlyOnceWith('t1', true)
})
it('shows loading while assigned learning is pending', () => {
  api.getMyLearning.mockReturnValue(new Promise(() => {}))
  show(StudentDashboardPage)
  expect(screen.getByRole('status')).toHaveTextContent('Loading')
  expect(screen.queryByText('No assigned roadmap yet')).not.toBeInTheDocument()
})
