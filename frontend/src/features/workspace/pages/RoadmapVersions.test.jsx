import {
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
  saveRoadmapDraft: vi.fn(),
  submitRoadmapVersion: vi.fn(),
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
beforeEach(() => {
  vi.clearAllMocks()
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
it('saves a draft before submission, then copies the reviewed snapshot', async () => {
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
    .mockResolvedValueOnce([
      { ...edited, status: 'in_review', revision: 9 },
      {
        ...edited,
        version_id: 'version-2',
        version_number: 2,
        status: 'draft',
        revision: 1,
      },
    ])
  vi.mocked(api.saveRoadmapDraft).mockResolvedValue({ ...edited, revision: 8 })
  vi.mocked(api.submitRoadmapVersion).mockResolvedValue({
    ...edited,
    status: 'in_review',
    revision: 9,
  })
  vi.mocked(api.copyRoadmapVersion).mockResolvedValue({
    ...edited,
    version_id: 'version-2',
    version_number: 2,
    status: 'draft',
    revision: 1,
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
  fireEvent.click(screen.getByRole('button', { name: 'Copy as new draft' }))
  await waitFor(() =>
    expect(api.copyRoadmapVersion).toHaveBeenCalledWith(
      'org-1',
      'roadmap-1',
      'version-1',
      9,
    ),
  )
  expect(
    await screen.findByRole('button', { name: /Version 2/ }),
  ).toBeInTheDocument()
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
function renderVersions() {
  return render(
    <RouterProvider
      router={createMemoryRouter(
        [{ path: '/r/:roadmapId', element: <RoadmapVersionsPage /> }],
        { initialEntries: ['/r/roadmap-1?organizationId=org-1'] },
      )}
    />,
  )
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
it('uses the selected source revision for copy and refreshes the list', async () => {
  const source = {
    ...original,
    version_id: 'version-2',
    version_number: 2,
    revision: 15,
    status: 'published',
  }
  const copy = {
    ...original,
    version_id: 'version-3',
    version_number: 3,
    revision: 1,
  }
  api.listRoadmapVersions
    .mockResolvedValueOnce([original, source])
    .mockResolvedValueOnce([original, source, copy])
  api.copyRoadmapVersion.mockResolvedValue(copy)
  renderVersions()
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
