import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MentorWorkspace from './MentorWorkspace'
import MentorAssignments from './MentorAssignments'
import * as api from '../learningApi'
vi.mock('../learningApi', () => ({
  listMentorCohorts: vi.fn(),
  getMentorCohort: vi.fn(),
  listMentorAssignments: vi.fn(),
  assignMentor: vi.fn(),
  revokeMentorAssignment: vi.fn(),
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
it('shows assigned pinned curriculum and suppresses small cohort progress', async () => {
  api.listMentorCohorts.mockResolvedValue([
    {
      id: 'c1',
      name: 'Cohort A',
      roadmap_name: 'Roadmap',
      roadmap_version_number: 2,
    },
  ])
  api.getMentorCohort.mockResolvedValue({
    cohort: {
      name: 'Cohort A',
      roadmap_name: 'Roadmap',
      roadmap_version_number: 2,
    },
    phases: [
      {
        id: 'p',
        title: 'Phase',
        weeks: [
          {
            id: 'w',
            title: 'Week',
            topics: [{ id: 't', title: 'Topic', description: 'Learn' }],
          },
        ],
      },
    ],
    progress: {
      suppressed: true,
      minimum_eligible_students: 5,
      eligible_students: null,
      percent: null,
    },
    deadlines: [
      { week_id: 'w', due_at: '2026-12-01T12:00:00Z', time_zone: 'UTC' },
    ],
  })
  render(<MentorWorkspace organizationId="o1" organizationName="Campus" />)
  fireEvent.click(await screen.findByRole('button', { name: /cohort a/i }))
  expect(await screen.findByText('Topic')).toBeVisible()
  expect(screen.getByText(/version 2/i)).toBeVisible()
  expect(screen.getByText(/at least 5/i)).toBeVisible()
  expect(screen.getByText(/UTC/)).toBeVisible()
  expect(screen.queryByText(/NaN|undefined/)).toBeNull()
})
it('removes old organization data while a new scope loads', async () => {
  api.listMentorCohorts.mockImplementation((id) =>
    id === 'old'
      ? Promise.resolve([{ id: 'c', name: 'Old cohort' }])
      : new Promise(() => {}),
  )
  const { rerender } = render(
    <MentorWorkspace organizationId="old" organizationName="Old" />,
  )
  expect(await screen.findByText('Old cohort')).toBeVisible()
  rerender(<MentorWorkspace organizationId="new" organizationName="New" />)
  expect(screen.queryByText('Old cohort')).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent(/loading/i)
})
it('lets an owner assign and revoke a mentor from a cohort', async () => {
  api.listMentorAssignments.mockResolvedValue({
    assignments: [],
    mentors: [{ id: 'm', display_name: 'Morgan' }],
    cohorts: [{ id: 'c', name: 'Cohort A' }],
  })
  api.assignMentor.mockResolvedValue({
    id: 'a',
    cohort_id: 'c',
    membership_id: 'm',
  })
  api.revokeMentorAssignment.mockResolvedValue()
  render(<MentorAssignments organizationId="o" />)
  fireEvent.change(await screen.findByLabelText('Mentor'), {
    target: { value: 'm' },
  })
  fireEvent.change(screen.getByLabelText('Cohort'), { target: { value: 'c' } })
  fireEvent.click(screen.getByRole('button', { name: 'Assign mentor' }))
  await waitFor(() =>
    expect(api.assignMentor).toHaveBeenCalledWith('o', 'c', 'm'),
  )
  expect(await screen.findByText(/Morgan.*Cohort A/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /remove Morgan/i }))
  await waitFor(() =>
    expect(api.revokeMentorAssignment).toHaveBeenCalledWith('o', 'c', 'm'),
  )
  expect(screen.queryByText(/Morgan.*Cohort A/)).toBeNull()
})

it('shows aggregate totals and timestamp only when progress is not suppressed', async () => {
  api.listMentorCohorts.mockResolvedValue([{ id: 'c', name: 'Class' }])
  api.getMentorCohort.mockResolvedValue({
    cohort: { name: 'Class', roadmap_name: 'Plan', roadmap_version_number: 4 },
    phases: [],
    deadlines: [],
    progress: {
      suppressed: false,
      eligible_students: 6,
      topics: 2,
      completed_topic_assignments: 9,
      possible_topic_assignments: 12,
      percent: 75,
      as_of: '2026-12-01T12:00:00Z',
    },
  })
  render(<MentorWorkspace organizationId="o" organizationName="Campus" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Class' }))
  expect(await screen.findByText(/75% complete/)).toHaveTextContent('9 of 12')
  expect(screen.getByText(/as of/i)).toBeVisible()
})

it('shows revoked assignment without displaying previously loaded detail', async () => {
  api.listMentorCohorts.mockResolvedValue([
    { id: 'a', name: 'First' },
    { id: 'b', name: 'Second' },
  ])
  api.getMentorCohort.mockImplementation((_org, id) =>
    id === 'a'
      ? Promise.resolve({
          cohort: {
            name: 'First',
            roadmap_name: 'Secret plan',
            roadmap_version_number: 1,
          },
          phases: [],
          deadlines: [],
          progress: { suppressed: true, minimum_eligible_students: 5 },
        })
      : Promise.reject({ status: 403 }),
  )
  render(<MentorWorkspace organizationId="o" organizationName="Campus" />)
  fireEvent.click(await screen.findByRole('button', { name: 'First' }))
  expect(await screen.findByText(/Secret plan/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Second' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/revoked/i)
  expect(screen.queryByText(/Secret plan/)).toBeNull()
})

it('revalidates a selected cohort when its button is activated again', async () => {
  api.listMentorCohorts.mockResolvedValue([{ id: 'c1', name: 'Cohort A' }])
  api.getMentorCohort
    .mockResolvedValueOnce({
      cohort: { name: 'Cohort A', roadmap_name: 'Roadmap' },
      phases: [],
      progress: { suppressed: true, minimum_eligible_students: 5 },
      deadlines: [],
    })
    .mockRejectedValueOnce({ status: 404 })
  render(<MentorWorkspace organizationId="o1" organizationName="Campus" />)
  const cohort = await screen.findByRole('button', { name: 'Cohort A' })
  fireEvent.click(cohort)
  expect(await screen.findByText(/at least 5/)).toBeVisible()
  fireEvent.click(cohort)
  expect(await screen.findByRole('alert')).toHaveTextContent(/revoked/i)
  expect(screen.queryByText(/at least 5/)).toBeNull()
})

it('ignores a late cohort response after switching organization', async () => {
  let resolveOld
  api.listMentorCohorts.mockImplementation((id) =>
    id === 'old'
      ? new Promise((resolve) => {
          resolveOld = resolve
        })
      : Promise.resolve([{ id: 'new-c', name: 'New cohort' }]),
  )
  const { rerender } = render(
    <MentorWorkspace organizationId="old" organizationName="Old" />,
  )
  rerender(<MentorWorkspace organizationId="new" organizationName="New" />)
  expect(await screen.findByText('New cohort')).toBeVisible()
  resolveOld([{ id: 'old-c', name: 'Old cohort' }])
  await waitFor(() => expect(screen.queryByText('Old cohort')).toBeNull())
  expect(screen.getByText('New cohort')).toBeVisible()
})
