import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ActivityPlanPage from './ActivityPlanPage'
import * as api from '../activityPlanApi'
import { listRoadmapVersions } from '../learningApi'
vi.mock('../learningApi', () => ({ listRoadmapVersions: vi.fn() }))
vi.mock('../activityPlanApi', () => ({
  getPlan: vi.fn(),
  savePlan: vi.fn(),
  convertPlan: vi.fn(),
  retryPlan: vi.fn(),
  downloadPlan: vi.fn(),
}))
const plan = {
  id: 'p1',
  organization_id: 'o1',
  name: 'Plan',
  status: 'ready',
  revision: 2,
  filename: 'plan.pdf',
  pages: [{ page_number: 1, text: 'Activity 1: Explore' }],
  warnings: [],
  proposal: {
    phases: [
      {
        id: 'ph',
        title: 'Module one',
        weeks: [
          {
            id: 'w',
            title: 'Week one',
            topics: [
              {
                id: 't',
                title: 'Explore',
                description: 'Source details',
                source_refs: ['r'],
              },
            ],
          },
        ],
      },
    ],
  },
  review_items: [
    {
      id: 'r',
      page_number: 1,
      text: 'Activity 1: Explore',
      disposition: 'unresolved',
      topic_id: null,
      reason: '',
    },
  ],
  review_confirmed: false,
}
function show() {
  const router = createMemoryRouter(
    [{ path: '/plans/:planId', element: <ActivityPlanPage /> }],
    { initialEntries: ['/plans/p1?organizationId=o1'] },
  )
  render(<RouterProvider router={router} />)
  return router
}
beforeEach(() => {
  vi.clearAllMocks()
  api.getPlan.mockResolvedValue(structuredClone(plan))
})
afterEach(cleanup)
it('requires source resolution and confirmation, preserving edits when a revision save conflicts', async () => {
  show()
  await screen.findByLabelText('Decision for source 1')
  expect(
    screen.getByRole('button', { name: 'Create roadmap draft' }),
  ).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Decision for source 1'), {
    target: { value: 'excluded' },
  })
  fireEvent.change(screen.getByLabelText('Exclusion reason for source 1'), {
    target: { value: 'Administrative note' },
  })
  fireEvent.click(screen.getByLabelText(/I have checked/))
  api.savePlan.mockRejectedValue({ status: 409 })
  fireEvent.click(screen.getByRole('button', { name: 'Save review' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Review changed')
  expect(screen.getByLabelText('Exclusion reason for source 1')).toHaveValue(
    'Administrative note',
  )
  expect(
    screen.getByRole('button', { name: 'Create roadmap draft' }),
  ).toBeDisabled()
})
it('saves review before allowing conversion', async () => {
  show()
  await screen.findByLabelText('Decision for source 1')
  fireEvent.change(screen.getByLabelText('Decision for source 1'), {
    target: { value: 'included' },
  })
  fireEvent.change(screen.getByLabelText('Activity for source 1'), {
    target: { value: 't' },
  })
  fireEvent.click(screen.getByLabelText(/I have checked/))
  api.savePlan.mockImplementation(async (o, id, p) => ({ ...p, revision: 3 }))
  fireEvent.click(screen.getByRole('button', { name: 'Save review' }))
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Create roadmap draft' }),
    ).toBeEnabled(),
  )
  expect(screen.getByText('Saved')).toBeInTheDocument()
})
it('clears prior activity links when excluding source text', async () => {
  api.getPlan.mockResolvedValue({
    ...structuredClone(plan),
    review_items: [
      { ...plan.review_items[0], disposition: 'included', topic_id: 't' },
    ],
  })
  show()
  await screen.findByLabelText('Decision for source 1')
  fireEvent.change(screen.getByLabelText('Decision for source 1'), {
    target: { value: 'excluded' },
  })
  fireEvent.change(screen.getByLabelText('Exclusion reason for source 1'), {
    target: { value: 'Not part of curriculum' },
  })
  api.savePlan.mockImplementation(async (o, id, p) => p)
  fireEvent.click(screen.getByRole('button', { name: 'Save review' }))
  await waitFor(() => expect(api.savePlan).toHaveBeenCalled())
  expect(api.savePlan.mock.calls[0][2].review_items[0].topic_id).toBeNull()
  expect(
    api.savePlan.mock.calls[0][2].proposal.phases[0].weeks[0].topics[0]
      .source_refs,
  ).toEqual([])
})
it('lets a coordinator add the missing phase and week before regrouping activities', async () => {
  show()
  await screen.findByLabelText('Decision for source 1')
  fireEvent.click(screen.getByRole('button', { name: 'Add phase' }))
  expect(screen.getAllByLabelText('Phase title')).toHaveLength(2)
  fireEvent.click(screen.getAllByRole('button', { name: 'Add week' })[1])
  expect(screen.getAllByLabelText('Week title')).toHaveLength(2)
  fireEvent.change(screen.getByLabelText('Move activity to week'), {
    target: {
      value: screen.getByLabelText('Move activity to week').options[1].value,
    },
  })
  expect(screen.getByLabelText('Activity title')).toHaveValue('Explore')
  api.savePlan.mockImplementation(async (o, id, p) => p)
  fireEvent.click(screen.getByRole('button', { name: 'Save review' }))
  await waitFor(() => expect(api.savePlan).toHaveBeenCalled())
  const saved = api.savePlan.mock.calls[0][2]
  expect(saved.proposal.phases[0].weeks[0].topics).toEqual([])
  expect(saved.proposal.phases[1].weeks[0].topics[0].id).toBe('t')
  expect(saved.proposal.phases[1].weeks[0].topics[0].source_refs).toEqual(['r'])
})
it('requires confirmation again after changing the outline', async () => {
  api.getPlan.mockResolvedValue({
    ...structuredClone(plan),
    review_confirmed: true,
  })
  show()
  fireEvent.change(await screen.findByLabelText('Activity title'), {
    target: { value: 'Revised activity' },
  })
  expect(screen.getByLabelText(/I have checked/)).not.toBeChecked()
})
it('supports arrow-key switching between the mobile review tabs', async () => {
  show()
  const draft = await screen.findByRole('tab', { name: 'Draft' })
  draft.focus()
  fireEvent.keyDown(draft, { key: 'ArrowRight' })
  const source = screen.getByRole('tab', { name: 'Source' })
  expect(source).toHaveAttribute('aria-selected', 'true')
  expect(source).toHaveFocus()
  expect(source).toHaveAttribute('aria-controls', 'plan-source-panel')
})
it('clears the previous review while another organization’s plan is loading', async () => {
  const router = show()
  await screen.findByLabelText('Activity title')
  api.getPlan.mockReturnValue(new Promise(() => {}))
  await act(async () => {
    await router.navigate('/plans/p1?organizationId=other')
  })
  expect(screen.queryByLabelText('Activity title')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Loading activity plan')
})
it('opens the source decision linked to an activity’s stable reference', async () => {
  show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'View source on page 1' }),
  )
  await waitFor(() =>
    expect(screen.getByLabelText('Decision for source 1')).toHaveFocus(),
  )
  expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
})

const reviewedPlan = {
  ...plan,
  review_confirmed: true,
  review_items: [
    { ...plan.review_items[0], disposition: 'included', topic_id: 't' },
  ],
}
const createdDraft = { roadmap_id: 'r1', version_id: 'v1', version_number: 1 }
const draftVersion = {
  id: 'r1',
  organization_id: 'o1',
  version_id: 'v1',
  version_number: 1,
  status: 'draft',
  name: 'Plan',
  revision: 7,
}
const draftLink =
  '/app/coordinator/roadmaps/r1/versions?organizationId=o1&versionId=v1&activityPlanId=p1'

it('converts the saved source revision once and shows the server version details and exact link', async () => {
  api.getPlan.mockResolvedValue(reviewedPlan)
  let finish
  api.convertPlan.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  listRoadmapVersions.mockResolvedValue([draftVersion])
  show()
  const create = await screen.findByRole('button', {
    name: 'Create roadmap draft',
  })
  act(() => {
    create.click()
    create.click()
  })
  expect(api.convertPlan).toHaveBeenCalledExactlyOnceWith('o1', 'p1', 2)
  expect(screen.getByText('Creating roadmap draft…')).toBeVisible()
  await act(async () => finish(createdDraft))
  expect(
    await screen.findByRole('heading', { name: 'Draft created successfully' }),
  ).toBeVisible()
  expect(await screen.findByText('7')).toBeVisible()
  expect(
    screen.getByText('Draft', { selector: '.roadmap-status-badge' }),
  ).toBeVisible()
  expect(
    screen.getByRole('link', { name: 'Open in Roadmap Versions' }),
  ).toHaveAttribute('href', draftLink)
  expect(listRoadmapVersions).toHaveBeenCalledExactlyOnceWith('o1', 'r1')
})

it('reads saved state after uncertain conversion and keeps a confirmed link if metadata is unavailable', async () => {
  api.getPlan
    .mockResolvedValueOnce(reviewedPlan)
    .mockResolvedValueOnce({
      ...reviewedPlan,
      ...createdDraft,
      status: 'converted',
    })
  api.convertPlan.mockRejectedValueOnce(new Error('Connection interrupted'))
  listRoadmapVersions.mockRejectedValueOnce(
    new Error('Metadata temporarily unavailable'),
  )
  show()
  const create = await screen.findByRole('button', {
    name: 'Create roadmap draft',
  })
  fireEvent.click(create)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Draft creation could not be confirmed',
  )
  expect(create).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Reload saved review' }))
  expect(
    await screen.findByRole('link', { name: 'Open in Roadmap Versions' }),
  ).toHaveAttribute('href', draftLink)
  expect(
    await screen.findByText(/current version details could not be loaded/),
  ).toBeVisible()
  expect(api.convertPlan).toHaveBeenCalledTimes(1)
  expect(api.getPlan).toHaveBeenCalledTimes(2)
})

it('does not apply an old conversion result after switching organizations', async () => {
  api.getPlan
    .mockResolvedValueOnce(reviewedPlan)
    .mockResolvedValueOnce({
      ...plan,
      organization_id: 'other',
      name: 'Other plan',
    })
  let finish
  api.convertPlan.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const router = show()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Create roadmap draft' }),
  )
  await act(async () => router.navigate('/plans/p1?organizationId=other'))
  await screen.findByRole('heading', { name: 'Other plan' })
  await act(async () => finish(createdDraft))
  expect(
    screen.queryByRole('link', { name: 'Open in Roadmap Versions' }),
  ).not.toBeInTheDocument()
  expect(listRoadmapVersions).not.toHaveBeenCalled()
})

it('shows the backend extraction failure and offers the saved plan retry', async () => {
  api.getPlan
    .mockResolvedValueOnce({
      ...plan,
      status: 'failed',
      failure: { message: 'No selectable text was found.' },
    })
    .mockResolvedValueOnce({ ...plan, status: 'extracting' })
  api.retryPlan.mockResolvedValueOnce({ ...plan, status: 'queued' })
  show()
  expect(await screen.findByText('No selectable text was found.')).toBeVisible()
  expect(
    screen.queryByRole('button', { name: 'Create roadmap draft' }),
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry extraction' }))
  expect(
    await screen.findByRole('heading', { name: 'Extracting page text' }),
  ).toBeVisible()
  expect(api.retryPlan).toHaveBeenCalledExactlyOnceWith('o1', 'p1', 2)
})

it('prevents editing and conversion when the backend denies access to the import', async () => {
  api.getPlan.mockRejectedValueOnce({
    status: 403,
    message: 'private internal text',
  })
  show()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This activity plan is unavailable',
  )
  expect(screen.queryByText('private internal text')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Create roadmap draft' }),
  ).not.toBeInTheDocument()
  expect(api.convertPlan).not.toHaveBeenCalled()
})
