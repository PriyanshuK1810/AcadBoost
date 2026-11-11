import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../learningApi'
import * as plans from '../activityPlanApi'
import RoadmapVersionsPage from './RoadmapVersionsPage'
import '../../../app/workspace.css'

vi.mock('../activityPlanApi', () => ({
  listPlans: vi.fn().mockResolvedValue({ plans: [] }),
}))
vi.mock('../learningApi', () => ({
  listOrganizations: vi.fn(),
  listRoadmapVersions: vi.fn(),
  listRoadmapReviews: vi.fn(),
  saveRoadmapDraft: vi.fn(),
  submitRoadmapVersion: vi.fn(),
  approveRoadmapVersion: vi.fn(),
  rejectRoadmapVersion: vi.fn(),
  archiveRoadmapVersion: vi.fn(),
  copyRoadmapVersion: vi.fn(),
}))
const original = {
  id: 'roadmap-1',
  organization_id: 'org-1',
  name: 'Career path',
  description: '',
  version_id: 'version-1',
  version_number: 1,
  revision: 7,
  status: 'draft',
  topics: [
    { id: 'topic-1', title: 'Set goals', description: '', order_index: 1 },
  ],
  phases: [
    {
      id: 'phase-1',
      title: 'Learning path',
      order_index: 1,
      weeks: [
        {
          id: 'week-1',
          title: 'Week 1',
          order_index: 1,
          topics: [
            {
              id: 'topic-1',
              title: 'Set goals',
              description: '',
              order_index: 1,
            },
          ],
        },
      ],
    },
  ],
}
afterEach(cleanup)

const pendingReview = {
  ...original,
  status: 'in_review',
  pending_submission: {
    id: 'ad6383ae-eb85-444b-a902-fc00c3c44bc0',
    version_id: original.version_id,
    submitted_revision: original.revision,
    decision: 'pending',
    submitted_by: { id: 'reviewer-user', display_name: 'Test reviewer' },
  },
}
const approved = {
  ...original,
  revision: 8,
  status: 'published',
  pending_submission: null,
}
const rejected = { ...original, revision: 8, pending_submission: null }

function reviewerDialog(name) {
  return screen.getByRole('dialog', { name })
}

it.each(['owner', 'admin', 'coordinator', 'mentor', 'student'])(
  'only permits Owner and Admin reviewer controls for role %s',
  async (role) => {
    api.listOrganizations.mockResolvedValue([{ id: 'org-1', role }])
    api.listRoadmapVersions.mockResolvedValue([pendingReview])
    renderVersions()
    await screen.findByText('This version is under review.')
    const permitted = ['owner', 'admin'].includes(role)
    expect(
      !!screen.queryByRole('button', { name: 'Approve and Publish' }),
    ).toBe(permitted)
    expect(
      !!screen.queryByRole('button', { name: 'Reject', exact: true }),
    ).toBe(permitted)
  },
)

it.each(['draft', 'published', 'archived'])(
  'hides reviewer decisions for %s',
  async (status) => {
    api.listRoadmapVersions.mockResolvedValue([{ ...original, status }])
    renderVersions()
    await screen.findByRole('heading', { name: 'Version history' })
    expect(
      screen.queryByRole('group', { name: 'Review decision' }),
    ).not.toBeInTheDocument()
  },
)

it('cancels approval without a request and restores trigger focus', async () => {
  api.listRoadmapVersions.mockResolvedValue([pendingReview])
  renderVersions()
  const approve = await screen.findByRole('button', {
    name: 'Approve and Publish',
  })
  fireEvent.click(approve)
  const dialog = reviewerDialog('Approve and publish this version?')
  expect(dialog).toHaveAccessibleDescription(
    /publish the reviewed roadmap version/i,
  )
  expect(dialog).toHaveTextContent('Career path · Version 1')
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
  expect(cancel).toHaveFocus()
  fireEvent.click(cancel)
  expect(approve).toHaveFocus()
  expect(api.approveRoadmapVersion).not.toHaveBeenCalled()
})

it('approves the exact pending attempt once and reconciles the authoritative list', async () => {
  let finish
  const other = { ...original, version_id: 'version-2', version_number: 2 }
  api.approveRoadmapVersion.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  api.listRoadmapVersions
    .mockResolvedValueOnce([other, pendingReview])
    .mockResolvedValueOnce([other, approved])
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Approve and Publish' }),
  )
  const dialog = reviewerDialog('Approve and publish this version?')
  const confirm = within(dialog).getByRole('button', {
    name: 'Approve and Publish',
  })
  fireEvent.click(confirm)
  const otherChoice = screen.getByRole('button', { name: /version 2/i })
  expect(otherChoice).toBeDisabled()
  fireEvent.click(otherChoice)
  fireEvent.submit(dialog.querySelector('form'))
  expect(api.approveRoadmapVersion).toHaveBeenCalledExactlyOnceWith(
    'org-1',
    'roadmap-1',
    original.version_id,
    7,
    pendingReview.pending_submission.id,
  )
  expect(
    screen.queryByText(
      'Approved and published. This roadmap version is ready for learners.',
    ),
  ).not.toBeInTheDocument()
  finish(approved)
  await screen.findByText(/Approved and published/)
  await waitFor(() => expect(dialog).not.toHaveAttribute('open'))
  expect(api.listRoadmapVersions).toHaveBeenCalledTimes(2)
  expect(
    screen.getByRole('heading', { name: original.name, level: 2 }),
  ).toHaveFocus()
  expect(
    screen.queryByRole('group', { name: 'Review decision' }),
  ).not.toBeInTheDocument()
  expect(screen.getAllByText('Published').length).toBeGreaterThan(0)
})

it('does not apply an approval response after navigating to another roadmap', async () => {
  let finish
  api.approveRoadmapVersion.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  api.listRoadmapVersions
    .mockResolvedValueOnce([pendingReview])
    .mockResolvedValueOnce([
      {
        ...original,
        id: 'roadmap-2',
        name: 'Other roadmap',
        version_id: 'version-2',
      },
    ])
  const router = createMemoryRouter(
    [{ path: '/r/:roadmapId', element: <RoadmapVersionsPage /> }],
    { initialEntries: ['/r/roadmap-1?organizationId=org-1'] },
  )
  render(<RouterProvider router={router} />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Approve and Publish' }),
  )
  fireEvent.click(
    within(reviewerDialog('Approve and publish this version?')).getByRole(
      'button',
      { name: 'Approve and Publish' },
    ),
  )
  await act(() => router.navigate('/r/roadmap-2?organizationId=org-1'))
  await screen.findByRole('heading', { name: 'Other roadmap', level: 2 })
  await act(async () => {
    finish(approved)
  })
  expect(
    screen.getByRole('heading', { name: 'Other roadmap', level: 2 }),
  ).toBeVisible()
  expect(screen.queryByText(/Approved and published/)).not.toBeInTheDocument()
  expect(api.listRoadmapVersions).toHaveBeenCalledTimes(2)
})

it.each([
  { pending_submission: null },
  { revision: undefined },
  {
    pending_submission: {
      ...pendingReview.pending_submission,
      version_id: 'unrelated-version',
    },
  },
  {
    pending_submission: {
      ...pendingReview.pending_submission,
      submitted_revision: 6,
    },
  },
  {
    pending_submission: {
      ...pendingReview.pending_submission,
      id: 'not-a-uuid',
    },
  },
])(
  'blocks decisions without valid current review metadata %#',
  async (override) => {
    api.listRoadmapVersions.mockResolvedValue([
      { ...pendingReview, ...override },
    ])
    renderVersions()
    expect(
      await screen.findByRole('button', { name: 'Approve and Publish' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Reject', exact: true }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Refresh review status' }),
    ).toBeEnabled()
    expect(api.approveRoadmapVersion).not.toHaveBeenCalled()
    expect(api.rejectRoadmapVersion).not.toHaveBeenCalled()
  },
)

it('invalidates an open approval when the selected version changes', async () => {
  const other = { ...original, version_id: 'version-2', version_number: 2 }
  api.listRoadmapVersions.mockResolvedValue([other, pendingReview])
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Approve and Publish' }),
  )
  const dialog = reviewerDialog('Approve and publish this version?')
  const confirmation = within(dialog).getByRole('button', {
    name: 'Approve and Publish',
  })
  fireEvent.click(screen.getByRole('button', { name: /version 2/i }))
  expect(dialog).not.toHaveAttribute('open')
  fireEvent.click(confirmation)
  expect(api.approveRoadmapVersion).not.toHaveBeenCalled()
  expect(
    await screen.findByRole('button', { name: 'Review draft' }),
  ).toBeEnabled()
})

it('preserves successful approval when the authoritative refresh fails', async () => {
  api.listRoadmapVersions
    .mockResolvedValueOnce([pendingReview])
    .mockRejectedValueOnce(new Error('raw server detail'))
    .mockResolvedValueOnce([pendingReview])
    .mockResolvedValueOnce([approved])
  api.approveRoadmapVersion.mockResolvedValueOnce(approved)
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Approve and Publish' }),
  )
  fireEvent.click(
    within(reviewerDialog('Approve and publish this version?')).getByRole(
      'button',
      { name: 'Approve and Publish' },
    ),
  )
  expect(
    await screen.findByText(/decision succeeded, but the latest version list/),
  ).toBeVisible()
  expect(screen.getByText(/Approved and published/)).toBeVisible()
  expect(screen.getAllByText('Published').length).toBeGreaterThan(0)
  expect(screen.queryByText(/raw server detail/)).not.toBeInTheDocument()
  const refresh = screen.getByRole('button', { name: 'Refresh review status' })
  fireEvent.click(refresh)
  await screen.findByText(/Current review information could not be loaded/)
  expect(screen.getAllByText('Published').length).toBeGreaterThan(0)
  expect(
    screen.queryByRole('group', { name: 'Review decision' }),
  ).not.toBeInTheDocument()
  fireEvent.click(refresh)
  await screen.findByText(/Current server version loaded/)
  expect(refresh).not.toBeInTheDocument()
  expect(api.approveRoadmapVersion).toHaveBeenCalledTimes(1)
})

it('validates rejection using UTF-16 units and submits the exact trimmed reason', async () => {
  api.listRoadmapVersions
    .mockResolvedValueOnce([pendingReview])
    .mockResolvedValueOnce([rejected])
  api.rejectRoadmapVersion.mockResolvedValueOnce(rejected)
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Reject', exact: true }),
  )
  const dialog = reviewerDialog('Reject this roadmap version?')
  const reason = within(dialog).getByRole('textbox', {
    name: 'Reason for rejection',
  })
  const reject = within(dialog).getByRole('button', { name: 'Reject Version' })
  expect(reason).toHaveFocus()
  expect(reject).toBeDisabled()
  expect(within(dialog).getByText('0 / 2,000')).toBeVisible()
  fireEvent.change(reason, { target: { value: '   ' } })
  expect(reject).toBeDisabled()
  fireEvent.change(reason, { target: { value: '😀'.repeat(1000) + 'x' } })
  expect(within(dialog).getByText('2,001 / 2,000')).toBeVisible()
  expect(reason).toHaveAttribute('aria-invalid', 'true')
  expect(reject).toBeDisabled()
  const limit = '😀'.repeat(999) + ' x'
  fireEvent.change(reason, { target: { value: limit } })
  expect(within(dialog).getByText('2,000 / 2,000')).toBeVisible()
  expect(reject).toBeEnabled()
  fireEvent.click(reject)
  await screen.findByText(/returned to Draft for revision/)
  expect(api.rejectRoadmapVersion).toHaveBeenCalledExactlyOnceWith(
    'org-1',
    'roadmap-1',
    original.version_id,
    7,
    pendingReview.pending_submission.id,
    limit,
  )
  expect(screen.getByRole('button', { name: 'Review draft' })).toBeEnabled()
})

it('cancels rejection without a mutation', async () => {
  api.listRoadmapVersions.mockResolvedValue([pendingReview])
  renderVersions()
  const trigger = await screen.findByRole('button', {
    name: 'Reject',
    exact: true,
  })
  fireEvent.click(trigger)
  const dialog = reviewerDialog('Reject this roadmap version?')
  fireEvent.change(within(dialog).getByLabelText('Reason for rejection'), {
    target: { value: 'Add learning goals.' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(trigger).toHaveFocus()
  expect(api.rejectRoadmapVersion).not.toHaveBeenCalled()
})

it('retains rejection feedback on conflict and requires a fresh explicit decision after refresh', async () => {
  const newer = {
    ...pendingReview,
    revision: 9,
    pending_submission: {
      ...pendingReview.pending_submission,
      id: 'f11f8db1-cb84-4e58-bd8b-964658bc71c4',
      submitted_revision: 9,
    },
  }
  api.listRoadmapVersions
    .mockResolvedValueOnce([pendingReview])
    .mockResolvedValueOnce([newer])
    .mockResolvedValueOnce([{ ...rejected, revision: 10 }])
  api.rejectRoadmapVersion
    .mockRejectedValueOnce({ status: 409, request_id: 'review-123' })
    .mockResolvedValueOnce({ ...rejected, revision: 10 })
  renderVersions()
  const trigger = await screen.findByRole('button', {
    name: 'Reject',
    exact: true,
  })
  fireEvent.click(trigger)
  const dialog = reviewerDialog('Reject this roadmap version?')
  fireEvent.change(within(dialog).getByLabelText('Reason for rejection'), {
    target: { value: '  Add goals to week one.  ' },
  })
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Reject Version' }),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /Review changed.*Reference: review-123/,
  )
  expect(trigger).toBeDisabled()
  expect(screen.getByText('View unsent rejection feedback')).toBeInTheDocument()
  expect(api.rejectRoadmapVersion).toHaveBeenCalledExactlyOnceWith(
    'org-1',
    'roadmap-1',
    original.version_id,
    7,
    pendingReview.pending_submission.id,
    'Add goals to week one.',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh review status' }))
  await waitFor(() => expect(trigger).toBeEnabled())
  expect(api.rejectRoadmapVersion).toHaveBeenCalledTimes(1)
  fireEvent.click(trigger)
  expect(within(dialog).getByLabelText('Reason for rejection')).toHaveValue(
    '  Add goals to week one.  ',
  )
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Reject Version' }),
  )
  await screen.findByText(/returned to Draft/)
  expect(api.rejectRoadmapVersion).toHaveBeenLastCalledWith(
    'org-1',
    'roadmap-1',
    original.version_id,
    9,
    newer.pending_submission.id,
    'Add goals to week one.',
  )
})

it.each([
  [401, /session has expired/],
  [403, /do not have permission/],
  [404, /no longer available/],
  [422, /server rejected the review details/],
  [500, /server could not confirm/],
  [undefined, /outcome could not be confirmed/],
])(
  'handles review error %s without leaking details or retrying',
  async (status, message) => {
    api.listRoadmapVersions.mockResolvedValue([pendingReview])
    api.rejectRoadmapVersion.mockRejectedValueOnce(
      Object.assign(new Error('unsafe internal error'), { status }),
    )
    renderVersions()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Reject', exact: true }),
    )
    const dialog = reviewerDialog('Reject this roadmap version?')
    fireEvent.change(within(dialog).getByLabelText('Reason for rejection'), {
      target: { value: 'Retain this feedback.' },
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Reject Version' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByText(/unsafe internal error/)).not.toBeInTheDocument()
    expect(api.rejectRoadmapVersion).toHaveBeenCalledTimes(1)
    if ([401, 403, 422].includes(status)) {
      expect(within(dialog).getByLabelText('Reason for rejection')).toHaveValue(
        'Retain this feedback.',
      )
    } else {
      expect(
        screen.getByRole('button', { name: 'Reject', exact: true }),
      ).toBeDisabled()
      expect(
        screen.getByText('View unsent rejection feedback'),
      ).toBeInTheDocument()
    }
  },
)
beforeEach(() => {
  vi.clearAllMocks()
  api.listRoadmapReviews.mockImplementation(
    async (_organization, _roadmap, version, { offset }) =>
      historyPage(version, [], { offset }),
  )
  plans.listPlans.mockResolvedValue({ plans: [] })
  vi.mocked(api.listOrganizations).mockResolvedValue([
    { id: 'org-1', name: 'Campus', role: 'owner' },
  ])
  vi.mocked(api.listRoadmapVersions).mockResolvedValue([original])
})
it('takes the published version directly to its organization cohort setup', async () => {
  api.listRoadmapVersions.mockResolvedValue([
    { ...original, status: 'published' },
  ])
  const router = createMemoryRouter(
    [{ path: '/roadmaps/:roadmapId', element: <RoadmapVersionsPage /> }],
    { initialEntries: ['/roadmaps/roadmap-1?organizationId=org-1'] },
  )
  render(<RouterProvider router={router} />)
  const link = await screen.findByRole('link', { name: 'Assign to cohort' })
  expect(link).toHaveAttribute(
    'href',
    '/app/coordinator/learning?organizationId=org-1&roadmapVersionId=version-1#cohort-setup',
  )
  const badges = screen.getAllByText('Published')
  expect(badges).toHaveLength(2)
  for (const badge of badges) {
    expect(badge).toHaveClass('roadmap-status-badge--published')
  }
})
it('saves a draft before submission and hides copy while it is in review', async () => {
  const edited = {
    ...original,
    topics: [{ ...original.topics[0], title: 'Build skills' }],
    phases: [
      {
        ...original.phases[0],
        weeks: [
          {
            ...original.phases[0].weeks[0],
            topics: [
              {
                ...original.phases[0].weeks[0].topics[0],
                title: 'Build skills',
              },
            ],
          },
        ],
      },
    ],
  }
  api.listRoadmapVersions
    .mockResolvedValueOnce([original])
    .mockResolvedValueOnce([{ ...edited, revision: 8 }])
    .mockResolvedValueOnce([{ ...edited, status: 'in_review', revision: 9 }])
  vi.mocked(api.saveRoadmapDraft).mockResolvedValue({ ...edited, revision: 8 })
  vi.mocked(api.submitRoadmapVersion).mockResolvedValue({
    ...edited,
    status: 'in_review',
    revision: 9,
  })
  render(
    <RouterProvider
      router={createMemoryRouter(
        [
          {
            path: '/app/coordinator/roadmaps/:roadmapId/versions',
            element: <RoadmapVersionsPage />,
          },
        ],
        {
          initialEntries: [
            '/app/coordinator/roadmaps/roadmap-1/versions?organizationId=org-1',
          ],
        },
      )}
    />,
  )
  fireEvent.change(await screen.findByLabelText('Topic 1'), {
    target: { value: 'Build skills' },
  })
  expect(screen.getByRole('button', { name: 'Review draft' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await waitFor(() =>
    expect(api.saveRoadmapDraft).toHaveBeenCalledWith(
      'org-1',
      'roadmap-1',
      'version-1',
      [
        {
          title: 'Learning path',
          weeks: [
            {
              title: 'Week 1',
              topics: [{ title: 'Build skills', description: '' }],
            },
          ],
        },
      ],
      7,
    ),
  )
  await screen.findByText(
    'Draft saved. Review it before submitting for review.',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Review draft' }))
  expect(
    screen.getByRole('region', { name: 'Draft review' }),
  ).toHaveTextContent('1 phases · 1 weeks · 1 topics')
  fireEvent.click(screen.getByRole('button', { name: 'Submit for Review' }))
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Submit for Review',
    }),
  )
  await waitFor(() =>
    expect(api.submitRoadmapVersion).toHaveBeenCalledWith(
      'org-1',
      'roadmap-1',
      'version-1',
      8,
    ),
  )
  expect(
    await screen.findByText('This version is under review.'),
  ).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Copy as new draft' })).toBeNull()
  expect(api.copyRoadmapVersion).not.toHaveBeenCalled()
})
it('shows the complete saved hierarchy in publication review and multiline descriptions', async () => {
  render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: '/r/:roadmapId', element: <RoadmapVersionsPage /> }],
        { initialEntries: ['/r/roadmap-1?organizationId=org-1'] },
      )}
    />,
  )
  expect((await screen.findByLabelText('Description')).tagName).toBe('TEXTAREA')
  fireEvent.click(screen.getByRole('button', { name: 'Review draft' }))
  expect(
    screen.getByRole('region', { name: 'Draft review' }),
  ).toHaveTextContent('Set goals')
})
it('explains invalid outline fields before save or publication', async () => {
  render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: '/r/:roadmapId', element: <RoadmapVersionsPage /> }],
        { initialEntries: ['/r/roadmap-1?organizationId=org-1'] },
      )}
    />,
  )
  fireEvent.change(await screen.findByLabelText('Topic 1'), {
    target: { value: '' },
  })
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Review draft' })).toBeDisabled()
  expect(
    screen.getByRole('region', { name: 'Outline needs attention' }),
  ).toHaveTextContent('Topic 1')
})
it('includes imported source warnings in the saved publication review', async () => {
  plans.listPlans.mockResolvedValue({
    plans: [
      {
        id: 'plan-1',
        roadmap_id: 'roadmap-1',
        warnings: [
          {
            id: 'warning-1',
            message: 'Check table reading order',
            page_number: 2,
            review_item_id: 'source-1',
          },
        ],
      },
    ],
  })
  render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: '/r/:roadmapId', element: <RoadmapVersionsPage /> }],
        { initialEntries: ['/r/roadmap-1?organizationId=org-1'] },
      )}
    />,
  )
  await screen.findByRole('link', { name: 'View source and review decisions' })
  fireEvent.click(screen.getByRole('button', { name: 'Review draft' }))
  const review = screen.getByRole('region', { name: 'Draft review' })
  expect(review).toHaveTextContent('Check table reading order')
  expect(review).toHaveTextContent('Page 2')
})
function historyPage(
  version,
  reviews,
  { status = 'draft', revision = 9, offset = 0, next = null } = {},
) {
  return {
    version_id: version,
    status,
    revision,
    pending_submission:
      reviews.find((attempt) => attempt.decision === 'pending') || null,
    reviews,
    pagination: { limit: 20, offset, next_offset: next },
  }
}

function historyAttempt(id, decision, fields = {}) {
  return {
    id,
    version_id: original.version_id,
    submitted_revision: 7,
    submitted_at: '2026-11-10T04:00:00Z',
    submitted_by: { id: 'submitter', display_name: 'Fixture submitter' },
    decision,
    reviewed_at: decision === 'pending' ? null : '2026-11-10T05:00:00Z',
    reviewed_by:
      decision === 'pending'
        ? null
        : { id: 'reviewer', display_name: 'Fixture reviewer' },
    rejection_reason: null,
    ...fields,
  }
}

it.each(['owner', 'admin', 'coordinator'])(
  'requests scoped review history for %s',
  async (role) => {
    api.listOrganizations.mockResolvedValue([{ id: 'org-1', role }])
    let finish
    api.listRoadmapReviews.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    renderVersions()
    await screen.findByRole('heading', { name: 'Review history' })
    expect(
      screen.getByText('Loading review history…', {
        selector: 'p[role="status"]',
      }),
    ).toBeVisible()
    await waitFor(() =>
      expect(api.listRoadmapReviews).toHaveBeenCalledExactlyOnceWith(
        'org-1',
        'roadmap-1',
        'version-1',
        { limit: 20, offset: 0 },
      ),
    )
    finish(historyPage(original.version_id, []))
    expect(await screen.findByText('No review history yet')).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Returned for revision' }),
    ).not.toBeInTheDocument()
  },
)

it.each(['mentor', 'student'])(
  'never issues staff history reads for %s',
  async (role) => {
    api.listOrganizations.mockResolvedValue([{ id: 'org-1', role }])
    renderVersions()
    await screen.findByText('Staff review history restricted')
    expect(api.listRoadmapReviews).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('heading', { name: 'Review history' }),
    ).not.toBeInTheDocument()
  },
)

it('displays the latest rejection on a Draft and renders older decisions in server order', async () => {
  const text =
    'Revise the objectives.\n📝 <img src=x onerror=alert(1)> ' +
    'word'.repeat(400)
  const newest = historyAttempt('newest', 'rejected', {
    rejection_reason: text,
  })
  const older = historyAttempt('older', 'approved', {
    submitted_revision: 3,
    reviewed_at: null,
    reviewed_by: null,
  })
  api.listRoadmapReviews.mockResolvedValueOnce(
    historyPage(original.version_id, [newest, older]),
  )
  renderVersions()
  const panel = await screen.findByRole('region', {
    name: 'Returned for revision',
  })
  expect(panel).toHaveTextContent(/Revise the objectives.*📝.*<img src=x/)
  expect(panel.querySelector('img')).toBeNull()
  expect(panel.querySelector('time')).toHaveAttribute(
    'datetime',
    newest.reviewed_at,
  )
  expect(panel).toHaveTextContent('By Fixture reviewer')
  expect(screen.getAllByText('Draft').length).toBeGreaterThan(0)
  expect(screen.getByText('Previously returned for revision')).toBeVisible()
  const attempts = within(
    screen.getByRole('list', { name: /Review attempts/ }),
  ).getAllByRole('listitem')
  expect(attempts[0]).toHaveTextContent('Rejected')
  expect(attempts[1]).toHaveTextContent('Approved and published')
  expect(attempts[1].querySelector('summary time')).toBeNull()
  expect(
    screen.getByRole('button', { name: 'Submit for Review' }),
  ).toBeEnabled()
})

it('keeps earlier rejection in history after resubmission, with the new pending attempt first', async () => {
  const prior = historyAttempt('old', 'rejected', {
    rejection_reason: 'Add objectives.',
  })
  const newer = historyAttempt('new', 'pending', { submitted_revision: 10 })
  api.listRoadmapReviews
    .mockResolvedValueOnce(historyPage(original.version_id, [prior]))
    .mockResolvedValueOnce(
      historyPage(original.version_id, [newer, prior], {
        status: 'in_review',
        revision: 10,
      }),
    )
  const submitted = { ...pendingReview, revision: 10 }
  api.submitRoadmapVersion.mockResolvedValueOnce(submitted)
  api.listRoadmapVersions
    .mockResolvedValueOnce([original])
    .mockResolvedValueOnce([submitted])
  renderVersions()
  await screen.findByRole('region', { name: 'Returned for revision' })
  fireEvent.click(screen.getByRole('button', { name: 'Submit for Review' }))
  fireEvent.click(
    within(
      screen.getByRole('dialog', { name: 'Submit roadmap for review?' }),
    ).getByRole('button', { name: 'Submit for Review' }),
  )
  await screen.findByText('This version is under review.')
  const attempts = within(
    await screen.findByRole('list', { name: /Review attempts/ }),
  ).getAllByRole('listitem')
  expect(attempts[0]).toHaveTextContent('Awaiting review decision')
  expect(attempts[1]).toHaveTextContent('Add objectives.')
  expect(
    screen.queryByRole('region', { name: 'Returned for revision' }),
  ).not.toBeInTheDocument()
  expect(api.listRoadmapReviews).toHaveBeenCalledTimes(2)
})

it('shows truthful feedback when the rejected attempt has no reason', async () => {
  api.listRoadmapReviews.mockResolvedValueOnce(
    historyPage(original.version_id, [historyAttempt('no-reason', 'rejected')]),
  )
  renderVersions()
  expect(
    await screen.findByRole('region', { name: 'Returned for revision' }),
  ).toHaveTextContent('No rejection feedback was provided.')
})

it('distinguishes a failed first load from empty history and retries page one', async () => {
  api.listRoadmapReviews.mockRejectedValueOnce({
    status: 500,
    request_id: 'history-test',
    message: 'raw details',
  })
  renderVersions()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /could not be loaded.*history-test/,
  )
  expect(screen.queryByText('No review history yet')).not.toBeInTheDocument()
  expect(screen.queryByText('raw details')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry review history' }))
  await screen.findByText('No review history yet')
  expect(api.listRoadmapReviews).toHaveBeenLastCalledWith(
    'org-1',
    'roadmap-1',
    'version-1',
    { limit: 20, offset: 0 },
  )
})

it('reports history permission denial without suggesting empty history or a retry', async () => {
  api.listRoadmapReviews.mockRejectedValueOnce({ status: 403 })
  renderVersions()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'You do not have access to this review history.',
  )
  expect(screen.queryByText('No review history yet')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /retry review history/i }),
  ).not.toBeInTheDocument()
})

it('paginates using next_offset, preserves prior attempts on error, and deduplicates on retry', async () => {
  const first = historyAttempt('first', 'approved')
  const second = historyAttempt('second', 'rejected', { submitted_revision: 4 })
  let fail
  api.listRoadmapReviews
    .mockResolvedValueOnce(
      historyPage(original.version_id, [first], { next: 20 }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
    .mockResolvedValueOnce(
      historyPage(original.version_id, [first, second], { offset: 20 }),
    )
  renderVersions()
  const loadMore = await screen.findByRole('button', {
    name: 'Load more history',
  })
  fireEvent.click(loadMore)
  fireEvent.click(loadMore)
  expect(api.listRoadmapReviews).toHaveBeenCalledTimes(2)
  expect(api.listRoadmapReviews).toHaveBeenLastCalledWith(
    'org-1',
    'roadmap-1',
    'version-1',
    { limit: 20, offset: 20 },
  )
  fail(new Error('offline'))
  const retry = await screen.findByRole('button', {
    name: 'Retry loading more history',
  })
  const list = screen.getByRole('list', { name: /Review attempts/ })
  expect(within(list).getAllByRole('listitem')).toHaveLength(1)
  fireEvent.click(retry)
  await waitFor(() =>
    expect(within(list).getAllByRole('listitem')).toHaveLength(2),
  )
  expect(api.listRoadmapReviews).toHaveBeenLastCalledWith(
    'org-1',
    'roadmap-1',
    'version-1',
    { limit: 20, offset: 20 },
  )
  expect(
    screen.queryByRole('button', { name: 'Load more history' }),
  ).not.toBeInTheDocument()
})

it.each([false, true])(
  'ignores obsolete version reads including pagination (%s)',
  async (pagination) => {
    let finish
    const other = { ...original, version_id: 'version-2', version_number: 2 }
    api.listRoadmapVersions.mockResolvedValue([other, original])
    if (pagination)
      api.listRoadmapReviews.mockResolvedValueOnce(
        historyPage(
          original.version_id,
          [
            historyAttempt('first', 'rejected', {
              rejection_reason: 'Old feedback',
            }),
          ],
          { next: 20 },
        ),
      )
    api.listRoadmapReviews.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    renderVersions()
    if (pagination)
      fireEvent.click(
        await screen.findByRole('button', { name: 'Load more history' }),
      )
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    fireEvent.click(screen.getByRole('button', { name: /Version 2/ }))
    await screen.findByText('No review history yet')
    await act(async () => {
      finish(
        historyPage(
          original.version_id,
          [
            historyAttempt('old', 'rejected', {
              rejection_reason: 'Obsolete feedback',
            }),
          ],
          { offset: pagination ? 20 : 0 },
        ),
      )
    })
    expect(
      screen.queryByText(/Obsolete feedback|Old feedback/),
    ).not.toBeInTheDocument()
    expect(screen.getByText('No review history yet')).toBeVisible()
  },
)

it('supersedes a pending pagination read when history is refreshed', async () => {
  let finish
  api.listRoadmapReviews
    .mockResolvedValueOnce(
      historyPage(
        original.version_id,
        [historyAttempt('initial', 'approved')],
        { next: 20 },
      ),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValueOnce(
      historyPage(original.version_id, [
        historyAttempt('refreshed', 'rejected', {
          rejection_reason: 'Current feedback',
        }),
      ]),
    )
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Load more history' }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }))
  await screen.findByRole('region', { name: 'Returned for revision' })
  await act(async () => {
    finish(
      historyPage(
        original.version_id,
        [historyAttempt('obsolete', 'approved')],
        { offset: 20 },
      ),
    )
  })
  expect(
    within(screen.getByRole('list', { name: /Review attempts/ })).getAllByRole(
      'listitem',
    ),
  ).toHaveLength(1)
  expect(
    screen.getByRole('region', { name: 'Returned for revision' }),
  ).toHaveTextContent('Current feedback')
})

it('preserves loaded attempts when a refresh fails', async () => {
  api.listRoadmapReviews
    .mockResolvedValueOnce(
      historyPage(original.version_id, [
        historyAttempt('first', 'rejected', {
          rejection_reason: 'Keep this feedback',
        }),
      ]),
    )
    .mockRejectedValueOnce(new Error('offline'))
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Refresh history' }),
  )
  await screen.findByRole('alert')
  expect(
    screen.getByRole('region', { name: 'Returned for revision' }),
  ).toHaveTextContent('Keep this feedback')
  expect(screen.getByRole('list', { name: /Review attempts/ })).toBeVisible()
})

it('discards old history when the organization and roadmap change', async () => {
  api.listOrganizations.mockResolvedValue([
    { id: 'org-1', role: 'owner' },
    { id: 'org-2', role: 'coordinator' },
  ])
  let finish
  api.listRoadmapReviews.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const router = renderVersions()
  await screen.findByText('Loading review history…', {
    selector: 'p[role="status"]',
  })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  await act(() => router.navigate('/r/roadmap-2?organizationId=org-2'))
  await screen.findByText('No review history yet')
  await act(async () => {
    finish(
      historyPage(original.version_id, [
        historyAttempt('obsolete', 'rejected'),
      ]),
    )
  })
  expect(api.listRoadmapReviews).toHaveBeenLastCalledWith(
    'org-2',
    'roadmap-2',
    original.version_id,
    { limit: 20, offset: 0 },
  )
  expect(screen.getByText('No review history yet')).toBeVisible()
  expect(
    screen.queryByRole('region', { name: 'Returned for revision' }),
  ).not.toBeInTheDocument()
})

it('removes previously loaded staff history when a refresh is denied', async () => {
  api.listRoadmapReviews
    .mockResolvedValueOnce(
      historyPage(original.version_id, [historyAttempt('private', 'rejected')]),
    )
    .mockRejectedValueOnce({ status: 403 })
  renderVersions()
  await screen.findByRole('region', { name: 'Returned for revision' })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh history' }))
  await screen.findByText('History restricted')
  expect(
    screen.queryByRole('list', { name: /Review attempts/ }),
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('region', { name: 'Returned for revision' }),
  ).not.toBeInTheDocument()
})

function renderVersions() {
  const router = createMemoryRouter(
    [{ path: '/r/:roadmapId', element: <RoadmapVersionsPage /> }],
    { initialEntries: ['/r/roadmap-1?organizationId=org-1'] },
  )
  render(<RouterProvider router={router} />)
  return router
}
it('preserves edits on a 409 and requires an explicit decision before saving with the latest revision', async () => {
  api.saveRoadmapDraft.mockRejectedValueOnce(
    Object.assign(new Error('Conflict'), { status: 409 }),
  )
  api.listRoadmapVersions
    .mockResolvedValueOnce([original])
    .mockResolvedValueOnce([
      {
        ...original,
        revision: 8,
        phases: [{ ...original.phases[0], title: 'Server update' }],
      },
    ])
  renderVersions()
  fireEvent.change(await screen.findByLabelText('Topic 1'), {
    target: { value: 'My edit' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  expect(
    await screen.findByRole('region', { name: 'Version recovery' }),
  ).toHaveTextContent('Roadmap changed')
  expect(screen.getByLabelText('Topic 1')).toHaveValue('My edit')
  expect(api.saveRoadmapDraft).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Review latest version' }))
  expect(
    await screen.findByLabelText('Latest server version'),
  ).toHaveTextContent('Server update')
  expect(screen.getByLabelText('Topic 1')).toHaveValue('My edit')
  fireEvent.click(
    screen.getByRole('button', { name: 'Keep editing with latest revision' }),
  )
  api.saveRoadmapDraft.mockResolvedValueOnce({ ...original, revision: 9 })
  api.listRoadmapVersions.mockResolvedValueOnce([{ ...original, revision: 9 }])
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  await waitFor(() =>
    expect(api.saveRoadmapDraft).toHaveBeenLastCalledWith(
      'org-1',
      'roadmap-1',
      'version-1',
      expect.any(Array),
      8,
    ),
  )
})
it('does not send a mutation without the selected version revision', async () => {
  api.listRoadmapVersions.mockResolvedValue([
    { ...original, revision: undefined },
  ])
  renderVersions()
  fireEvent.change(await screen.findByLabelText('Topic 1'), {
    target: { value: 'My edit' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
  expect(api.saveRoadmapDraft).not.toHaveBeenCalled()
  expect(
    screen.getByRole('region', { name: 'Version recovery' }),
  ).toBeInTheDocument()
  expect(screen.getByLabelText('Topic 1')).toHaveValue('My edit')
})
it.each(['draft', 'in_review'])(
  'does not offer copy for %s',
  async (status) => {
    api.listRoadmapVersions.mockResolvedValue([{ ...original, status }])
    renderVersions()
    await screen.findByRole('button', { name: /Version 1/ })
    expect(
      screen.queryByRole('button', { name: 'Copy as new draft' }),
    ).toBeNull()
    expect(api.copyRoadmapVersion).not.toHaveBeenCalled()
  },
)
it.each(['published', 'archived'])(
  'copies a %s source using its revision and refreshes the list',
  async (status) => {
    const source = {
      ...original,
      version_id: 'version-2',
      version_number: 2,
      revision: 15,
      status,
    }
    const copy = {
      ...original,
      version_id: 'version-3',
      version_number: 3,
      revision: 1,
    }
    const otherDraft = {
      ...copy,
      version_id: 'unrelated-version-4',
      version_number: 4,
    }
    api.listRoadmapVersions
      .mockResolvedValueOnce([original, source])
      .mockResolvedValue([original, source, copy, otherDraft])
    api.copyRoadmapVersion.mockResolvedValue(copy)
    const router = renderVersions()
    fireEvent.click(await screen.findByRole('button', { name: /Version 2/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy as new draft' }))
    await waitFor(() =>
      expect(api.copyRoadmapVersion).toHaveBeenCalledWith(
        'org-1',
        'roadmap-1',
        'version-2',
        15,
      ),
    )
    expect(
      await screen.findByRole('button', { name: /Version 3/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(api.listRoadmapVersions).toHaveBeenCalledTimes(2)
    expect(router.state.location.search).toBe(
      '?organizationId=org-1&versionId=version-3',
    )
    await act(() => router.navigate(-1))
    expect(
      await screen.findByRole('button', { name: /Version 2/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(router.state.location.search).toBe(
      '?organizationId=org-1&versionId=version-2',
    )
    await act(() => router.navigate(1))
    expect(
      await screen.findByRole('button', { name: /Version 3/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(api.copyRoadmapVersion).toHaveBeenCalledTimes(1)
  },
)
it('preserves a confirmed copy when the exact draft list cannot load and retries only the read', async () => {
  const source = { ...original, status: 'published' }
  const created = {
    ...original,
    version_id: 'created-draft',
    version_number: 2,
  }
  api.copyRoadmapVersion.mockResolvedValue(created)
  api.listRoadmapVersions
    .mockResolvedValueOnce([source])
    .mockRejectedValueOnce(new Error('Service unavailable'))
    .mockResolvedValue([source, created])
  const router = renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Copy as new draft' }),
  )
  expect(await screen.findByText(/Draft v2 created/)).toBeInTheDocument()
  expect(router.state.location.search).toContain('versionId=created-draft')
  expect(screen.queryByRole('textbox', { name: 'Topic 1' })).toBeNull()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Retry version list' }),
  )
  expect(
    await screen.findByRole('textbox', { name: 'Topic 1' }),
  ).toBeInTheDocument()
  expect(api.copyRoadmapVersion).toHaveBeenCalledTimes(1)
})

it('uses an exact URL and restores focus when choosing a version in the native picker', async () => {
  const older = { ...original, status: 'in_review' }
  const latest = { ...original, version_id: 'version-2', version_number: 2 }
  api.listRoadmapVersions.mockResolvedValue([older, latest])
  const router = renderVersions()
  const picker = () => screen.getByLabelText('Selected version')
  await screen.findByLabelText('Selected version')
  expect(
    screen.getByRole('option', { name: 'Version 1 · In review' }),
  ).toBeInTheDocument()
  fireEvent.change(picker(), { target: { value: older.version_id } })
  expect(
    await screen.findByText('This version is under review.'),
  ).toBeInTheDocument()
  expect(picker()).toHaveValue(older.version_id)
  expect(picker()).toHaveFocus()
  expect(router.state.location.search).toBe(
    '?organizationId=org-1&versionId=version-1',
  )
  expect(api.copyRoadmapVersion).not.toHaveBeenCalled()
})

it('does not navigate to a copy response with a different organization', async () => {
  api.listRoadmapVersions.mockResolvedValue([
    { ...original, status: 'published' },
  ])
  api.copyRoadmapVersion.mockResolvedValue({
    ...original,
    organization_id: 'org-2',
    version_id: 'foreign-copy',
  })
  const router = renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Copy as new draft' }),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'did not identify its draft',
  )
  expect(router.state.location.search).toBe('?organizationId=org-1')
  expect(
    screen.getByRole('button', { name: 'Copy as new draft' }),
  ).toBeDisabled()
  expect(api.copyRoadmapVersion).toHaveBeenCalledTimes(1)
})
it('archives with the selected revision and reloads authoritative status', async () => {
  const published = { ...original, status: 'published' }
  const archived = { ...published, status: 'archived', revision: 8 }
  api.listRoadmapVersions
    .mockResolvedValueOnce([published])
    .mockResolvedValueOnce([archived])
  api.archiveRoadmapVersion.mockResolvedValue(archived)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Archive version' }),
  )
  await waitFor(() =>
    expect(api.archiveRoadmapVersion).toHaveBeenCalledWith(
      'org-1',
      'roadmap-1',
      'version-1',
      7,
    ),
  )
  expect(
    await screen.findByText(
      'Version archived. Existing cohorts still use this exact version.',
    ),
  ).toBeInTheDocument()
  expect(api.listRoadmapVersions).toHaveBeenCalledTimes(2)
  vi.restoreAllMocks()
})
it.each([
  ['copy', 'Copy as new draft', 'copyRoadmapVersion'],
  ['archive', 'Archive version', 'archiveRoadmapVersion'],
])(
  'does not retry a %s conflict until the version is refreshed',
  async (operation, label, apiName) => {
    const published = { ...original, status: 'published' }
    api.listRoadmapVersions.mockResolvedValue([published])
    api[apiName].mockRejectedValueOnce(
      Object.assign(new Error('Conflict'), { status: 409 }),
    )
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderVersions()
    fireEvent.click(await screen.findByRole('button', { name: label }))
    expect(
      await screen.findByRole('region', { name: 'Version recovery' }),
    ).toBeInTheDocument()
    expect(api[apiName]).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(api[apiName]).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'Review latest version' }),
    )
    await waitFor(() =>
      expect(api.listRoadmapVersions).toHaveBeenCalledTimes(2),
    )
    expect(api[apiName]).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  },
)
it.each([
  ['owner', true],
  ['admin', true],
  ['coordinator', true],
  ['mentor', false],
  ['student', false],
])('limits submission for the %s organization role', async (role, allowed) => {
  api.listOrganizations.mockResolvedValue([
    { id: 'org-1', name: 'Campus', role },
  ])
  renderVersions()
  await screen.findByLabelText('Topic 1')
  expect(!!screen.queryByRole('button', { name: 'Submit for Review' })).toBe(
    allowed,
  )
  expect(api.submitRoadmapVersion).not.toHaveBeenCalled()
})
it.each(['in_review', 'published', 'archived'])(
  'keeps %s content read-only without submission',
  async (status) => {
    api.listRoadmapVersions.mockResolvedValue([{ ...original, status }])
    renderVersions()
    await screen.findByRole('button', { name: /Version 1/ })
    expect(screen.queryByLabelText('Topic 1')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Submit for Review' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Publish version/ }),
    ).not.toBeInTheDocument()
    if (status === 'in_review')
      expect(
        screen.getByText('This version is under review.'),
      ).toBeInTheDocument()
  },
)
it('requires confirmation, allows cancel, and submits the selected revision once', async () => {
  const submitted = {
    ...original,
    status: 'in_review',
    revision: 8,
    pending_submission: { id: 'sub-1' },
  }
  api.submitRoadmapVersion.mockResolvedValue(submitted)
  api.listRoadmapVersions
    .mockResolvedValueOnce([original])
    .mockResolvedValueOnce([submitted])
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Submit for Review' }),
  )
  const dialog = screen.getByRole('dialog', {
    name: 'Submit roadmap for review?',
  })
  expect(dialog).toHaveAttribute(
    'aria-describedby',
    'roadmap-submit-description',
  )
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(api.submitRoadmapVersion).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Submit for Review' }))
  const confirm = within(screen.getByRole('dialog')).getByRole('button', {
    name: 'Submit for Review',
  })
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  await waitFor(() => expect(api.submitRoadmapVersion).toHaveBeenCalledTimes(1))
  expect(api.submitRoadmapVersion).toHaveBeenCalledWith(
    'org-1',
    'roadmap-1',
    'version-1',
    7,
  )
  expect(
    await screen.findByText('This version is under review.'),
  ).toBeInTheDocument()
  expect(api.listRoadmapVersions).toHaveBeenCalledTimes(2)
})
it('blocks submission of unsaved changes while keeping Save draft available', async () => {
  renderVersions()
  fireEvent.change(await screen.findByLabelText('Topic 1'), {
    target: { value: 'Local edit' },
  })
  expect(
    screen.getByRole('button', { name: 'Submit for Review' }),
  ).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled()
  expect(api.submitRoadmapVersion).not.toHaveBeenCalled()
})
it.each([409, 422, 403])(
  'surfaces submission error %s without retrying',
  async (status) => {
    api.submitRoadmapVersion.mockRejectedValueOnce(
      Object.assign(new Error('Server response'), { status }),
    )
    renderVersions()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Submit for Review' }),
    )
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Submit for Review',
      }),
    )
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(api.submitRoadmapVersion).toHaveBeenCalledTimes(1)
    if (status === 409)
      expect(
        screen.getByRole('region', { name: 'Version recovery' }),
      ).toBeInTheDocument()
    expect(screen.getByLabelText('Topic 1')).toBeInTheDocument()
  },
)
it('preserves the successful response when the subsequent refresh fails', async () => {
  api.submitRoadmapVersion.mockResolvedValue({
    ...original,
    status: 'in_review',
    revision: 8,
  })
  api.listRoadmapVersions
    .mockResolvedValueOnce([original])
    .mockRejectedValueOnce(new Error('Offline'))
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Submit for Review' }),
  )
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Submit for Review',
    }),
  )
  expect(
    await screen.findByText('This version is under review.'),
  ).toBeInTheDocument()
  expect(screen.getByRole('alert')).toHaveTextContent('Submission succeeded')
  expect(api.submitRoadmapVersion).toHaveBeenCalledTimes(1)
})
it('keeps the submitted response when a refreshed list still reports the old draft', async () => {
  api.submitRoadmapVersion.mockResolvedValue({
    ...original,
    status: 'in_review',
    revision: 8,
  })
  api.listRoadmapVersions
    .mockResolvedValueOnce([original])
    .mockResolvedValueOnce([original])
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Submit for Review' }),
  )
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Submit for Review',
    }),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Submission succeeded',
  )
  expect(screen.getByText('This version is under review.')).toBeInTheDocument()
  expect(screen.queryByLabelText('Topic 1')).not.toBeInTheDocument()
})
it('blocks a stale confirmation after local content changes', async () => {
  renderVersions()
  fireEvent.click(
    await screen.findByRole('button', { name: 'Submit for Review' }),
  )
  fireEvent.change(screen.getByLabelText('Topic 1'), {
    target: { value: 'Changed after opening' },
  })
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Submit for Review',
    }),
  )
  expect(api.submitRoadmapVersion).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent(
    'changed before submission',
  )
  expect(screen.getByLabelText('Topic 1')).toHaveValue('Changed after opening')
})
it.each([
  [401, 'session has expired'],
  [undefined, 'could not be confirmed'],
])(
  'handles authentication or network uncertainty (%s)',
  async (status, text) => {
    api.submitRoadmapVersion.mockRejectedValueOnce(
      Object.assign(new Error('Unavailable'), { status }),
    )
    renderVersions()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Submit for Review' }),
    )
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Submit for Review',
      }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(api.submitRoadmapVersion).toHaveBeenCalledTimes(1)
  },
)

it('opens an older scoped version from the URL and selects it again on reload', async () => {
  const older = { ...original, status: 'in_review' }
  const latest = { ...original, version_id: 'version-3', version_number: 3 }
  api.listRoadmapVersions.mockResolvedValue([older, latest])
  const path = '/r/roadmap-1?organizationId=org-1&versionId=version-1#roadmap-review-feedback'
  const open = () => render(
    <RouterProvider router={createMemoryRouter([{ path: '/r/:roadmapId', element: <RoadmapVersionsPage /> }], { initialEntries: [path] })} />,
  )
  const first = open()
  const selection = () => screen.findByRole('button', { name: /Version 1/ })
  expect(await selection()).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('region', { name: 'Review feedback and history' })).toHaveFocus()
  expect(api.listRoadmapVersions).toHaveBeenCalledWith('org-1', 'roadmap-1')
  first.unmount()
  open()
  expect(await selection()).toHaveAttribute('aria-pressed', 'true')
})

it('rejects an unavailable exact version without selecting or reading another version', async () => {
  api.listRoadmapVersions.mockResolvedValue([
    original,
    { ...original, organization_id: 'org-2', version_id: 'foreign', version_number: 2 },
  ])
  render(
    <RouterProvider router={createMemoryRouter([{ path: '/r/:roadmapId', element: <RoadmapVersionsPage /> }], { initialEntries: ['/r/roadmap-1?organizationId=org-1&versionId=foreign'] })} />,
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('The requested roadmap version is unavailable')
  expect(screen.getByRole('button', { name: /Version 1/ })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.queryByRole('button', { name: /Version 2/ })).not.toBeInTheDocument()
  expect(api.listRoadmapReviews).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: /Version 1/ }))
  await waitFor(() => expect(api.listRoadmapReviews).toHaveBeenCalledWith('org-1', 'roadmap-1', 'version-1', { limit: 20, offset: 0 }))
})
