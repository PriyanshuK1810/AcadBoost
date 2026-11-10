import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../learningApi'
import RoadmapsPage from './RoadmapsPage'

vi.mock('../activityPlanApi', () => ({
  listPlans: vi.fn().mockResolvedValue({ plans: [] }),
}))
vi.mock('../learningApi', () => ({
  listOrganizations: vi.fn(),
  listRoadmaps: vi.fn(),
  listRoadmapReviews: vi.fn(),
  createRoadmap: vi.fn(),
}))
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listOrganizations).mockResolvedValue([
    { id: 'org-1', name: 'Campus', role: 'coordinator' },
  ])
  vi.mocked(api.listRoadmaps).mockResolvedValue([])
  api.listRoadmapReviews.mockImplementation(async (_org, _roadmap, id) => ({
    version_id: id,
    status: 'draft',
    reviews: [],
  }))
})
it('creates a draft and links to its version editor', async () => {
  vi.mocked(api.createRoadmap).mockResolvedValue({
    id: 'roadmap-1',
    organization_id: 'org-1',
    name: 'Career readiness',
    description: '',
    version_id: 'version-1',
    version_number: 1,
    status: 'draft',
    topics: [{ id: 'topic-1', title: 'Set goals' }],
    phases: [],
  })
  render(
    <MemoryRouter>
      <RoadmapsPage />
    </MemoryRouter>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Create roadmap' }))
  fireEvent.change(await screen.findByLabelText('Roadmap name'), {
    target: { value: 'Career readiness' },
  })
  fireEvent.change(screen.getByLabelText('Starter topics, one per line'), {
    target: { value: 'Set goals' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
  await waitFor(() =>
    expect(api.createRoadmap).toHaveBeenCalledWith('org-1', {
      name: 'Career readiness',
      description: '',
      topics: [{ title: 'Set goals', description: '' }],
    }),
  )
  expect(
    await screen.findByRole('link', {
      name: 'Continue Editing for Career readiness v1',
    }),
  ).toHaveAttribute(
    'href',
    '/app/coordinator/roadmaps/roadmap-1/versions?organizationId=org-1&versionId=version-1',
  )
})
it('keeps creation behind an explicit action and exposes activity plan import', async () => {
  render(
    <MemoryRouter>
      <RoadmapsPage />
    </MemoryRouter>,
  )
  await screen.findByText('No roadmaps yet')
  expect(screen.queryByLabelText('Roadmap name')).not.toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'Import from PDF' }),
  ).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Create roadmap' }))
  expect(screen.getByLabelText('Roadmap name')).toBeInTheDocument()
})

function renderRoadmaps(path = '/app/coordinator/roadmaps') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RoadmapsPage />
    </MemoryRouter>,
  )
}

function version(id, number, status, fields = {}) {
  return {
    id,
    organization_id: 'org-1',
    name: id,
    description: '',
    version_id: id + '-v' + number,
    version_number: number,
    revision: 2,
    status,
    ...fields,
  }
}

function section(name) {
  return within(screen.getByRole('heading', { name }).closest('details'))
}

it('preserves published availability and separately exposes each pending and draft version', async () => {
  const pending = (number, submitted) =>
    version('Engineering', number, 'in_review', {
      description: 'Portfolio development',
      pending_submission: {
        version_id: 'Engineering-v' + number,
        decision: 'pending',
        submitted_at: submitted,
        submitted_by: { display_name: 'Fixture submitter' },
      },
    })
  api.listRoadmaps.mockResolvedValue([
    version('Engineering', 1, 'published', {
      description: 'Portfolio development',
    }),
    pending(2, '2026-10-03T12:00:00Z'),
    version('Engineering', 4, 'draft', {
      description: 'Portfolio development',
    }),
    pending(3, '2026-10-02T12:00:00Z'),
    version('History', 1, 'archived'),
    version('Published curriculum', 1, 'published'),
    version('Incomplete metadata', null, null),
    version('Missing submission metadata', 1, 'in_review'),
  ])
  renderRoadmaps('/app/coordinator/roadmaps?organizationId=org-1')
  await screen.findByRole('link', {
    name: 'Continue Editing for Engineering v4',
  })
  expect(api.listRoadmaps).toHaveBeenCalledExactlyOnceWith('org-1')
  expect(api.listRoadmapReviews).toHaveBeenCalledExactlyOnceWith(
    'org-1',
    'Engineering',
    'Engineering-v4',
    { limit: 1, offset: 0 },
  )
  const queue = section('Pending Review')
  expect(queue.getByText('3 versions')).toBeVisible()
  const links = queue.getAllByRole('link')
  expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
    'View Version for Engineering v2',
    'View Version for Engineering v3',
    'View Version for Missing submission metadata v1',
  ])
  expect(links[0]).toHaveAttribute(
    'href',
    '/app/coordinator/roadmaps/Engineering/versions?organizationId=org-1&versionId=Engineering-v2',
  )
  expect(queue.getAllByText('By Fixture submitter')).toHaveLength(2)
  expect(
    queue.queryByText('Archived', { selector: 'span' }),
  ).not.toBeInTheDocument()
  const active = section('Active Roadmaps')
  expect(active.getByText('2 confirmed roadmaps')).toBeVisible()
  expect(
    active
      .getByRole('link', { name: 'View Versions for Engineering v1' })
      .closest('article'),
  ).toHaveTextContent(/Version v1\s*Published/)
  expect(
    active
      .getByRole('link', { name: 'View Versions for History v1' })
      .closest('article'),
  ).toHaveTextContent('Archived')
  expect(
    active
      .getByRole('link', { name: 'View Versions for Incomplete metadata' })
      .closest('article'),
  ).not.toHaveTextContent('Version v')
  const filter = screen.getByLabelText(
    'Latest version status (Active Roadmaps)',
  )
  fireEvent.change(filter, { target: { value: 'published' } })
  expect(
    active.queryByRole('heading', { name: 'Engineering' }),
  ).not.toBeInTheDocument()
  expect(
    active.getByRole('heading', { name: 'Published curriculum' }),
  ).toBeVisible()
  expect(queue.getAllByRole('link')).toHaveLength(3)
  fireEvent.change(filter, { target: { value: '' } })
  const query = screen.getByRole('searchbox', { name: 'Search roadmaps' })
  fireEvent.change(query, { target: { value: 'PORTFOLIO' } })
  expect(queue.getAllByRole('link')).toHaveLength(2)
  expect(active.getAllByRole('link')).toHaveLength(2)
  fireEvent.change(query, { target: { value: 'no possible match' } })
  expect(screen.getByText('No matching roadmaps')).toBeVisible()
  fireEvent.change(query, { target: { value: '' } })
  expect(queue.getAllByRole('link')).toHaveLength(3)
  expect(api.listRoadmapReviews).toHaveBeenCalledTimes(1)
  expect(api.listRoadmaps).toHaveBeenCalledTimes(1)
})

it('renders long titles and HTML-like descriptions as text', async () => {
  const name = 'Long title '.repeat(19).trim()
  api.listRoadmaps.mockResolvedValue([
    version('roadmap-1', 1, 'draft', {
      name,
      description: '<b>Literal text</b>',
    }),
  ])
  renderRoadmaps()
  const title = await screen.findByRole('heading', { name })
  expect(title.closest('article').querySelector('b')).toBeNull()
  expect(screen.getByText('<b>Literal text</b>')).toBeVisible()
})

it.each(['mentor', 'student'])(
  'does not read staff roadmaps or show creation for %s',
  async (role) => {
    api.listOrganizations.mockResolvedValue([
      { id: 'org-1', name: 'Campus', role },
    ])
    renderRoadmaps()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role does not have access',
    )
    expect(api.listRoadmaps).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: 'Create roadmap' }),
    ).not.toBeInTheDocument()
  },
)

it.each(['owner', 'admin', 'coordinator'])(
  'allows %s to open the existing creation form',
  async (role) => {
    api.listOrganizations.mockResolvedValue([
      { id: 'org-1', name: 'Campus', role },
    ])
    renderRoadmaps()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Create roadmap' }),
    )
    expect(screen.getByLabelText('Roadmap name')).toBeVisible()
  },
)

it('keeps an inaccessible organization query from falling back to the first organization', async () => {
  renderRoadmaps('/app/coordinator/roadmaps?organizationId=unavailable')
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'This organization is unavailable',
  )
  expect(api.listRoadmaps).not.toHaveBeenCalled()
})

it('prompts for organization setup when there are no memberships', async () => {
  api.listOrganizations.mockResolvedValue([])
  renderRoadmaps()
  expect(
    await screen.findByRole('heading', { name: 'Select an organization' }),
  ).toBeVisible()
  expect(api.listRoadmaps).not.toHaveBeenCalled()
})

it('distinguishes loading, list failure, and a successful empty retry', async () => {
  let fail
  api.listRoadmaps.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
  )
  renderRoadmaps()
  expect(await screen.findByText('Loading roadmaps…')).toBeVisible()
  await waitFor(() => expect(fail).toBeTypeOf('function'))
  await act(async () => fail(new Error('internal information')))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Roadmaps could not be loaded',
  )
  expect(
    screen.queryByText(/internal information|No roadmaps yet/),
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry roadmaps' }))
  expect(await screen.findByText('No roadmaps yet')).toBeVisible()
})

it('shows an API permission denial without exposing creation or empty history', async () => {
  api.listRoadmaps.mockRejectedValueOnce({ status: 403 })
  renderRoadmaps()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'You do not have permission to view these roadmaps',
  )
  expect(
    screen.queryByRole('button', { name: 'Create roadmap' }),
  ).not.toBeInTheDocument()
  expect(screen.queryByText('No roadmaps yet')).not.toBeInTheDocument()
})

it('ignores a late response after changing organizations and excludes mismatched rows', async () => {
  let finish
  api.listOrganizations.mockResolvedValue([
    { id: 'org-1', name: 'Campus', role: 'owner' },
    { id: 'org-2', name: 'Second campus', role: 'coordinator' },
  ])
  api.listRoadmaps
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValueOnce([
      version('Second roadmap', 1, 'draft', { organization_id: 'org-2' }),
      version('Mismatched roadmap', 1, 'published'),
    ])
  renderRoadmaps()
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent.change(screen.getByLabelText('Organization for roadmaps'), {
    target: { value: 'org-2' },
  })
  await screen.findByRole('heading', { name: 'Second roadmap' })
  await act(async () => finish([version('Late roadmap', 1, 'in_review')]))
  expect(
    screen.queryByText(/Late roadmap|Mismatched roadmap/),
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('link', {
      name: 'Continue Editing for Second roadmap v1',
    }),
  ).toHaveAttribute(
    'href',
    '/app/coordinator/roadmaps/Second%20roadmap/versions?organizationId=org-2&versionId=Second+roadmap-v1',
  )
})

it('validates starter topics, blocks duplicate submits, and keeps inputs when creation fails', async () => {
  let fail
  api.createRoadmap.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject
      }),
  )
  renderRoadmaps()
  fireEvent.click(await screen.findByRole('button', { name: 'Create roadmap' }))
  fireEvent.change(screen.getByLabelText('Roadmap name'), {
    target: { value: 'Path' },
  })
  const topics = screen.getByLabelText('Starter topics, one per line')
  const submit = screen.getByRole('button', { name: 'Create draft' })
  fireEvent.change(topics, { target: { value: '   ' } })
  fireEvent.submit(submit.form)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Enter 1–24 starter topics',
  )
  expect(api.createRoadmap).not.toHaveBeenCalled()
  fireEvent.change(topics, { target: { value: 'One topic' } })
  fireEvent.submit(submit.form)
  fireEvent.submit(submit.form)
  expect(api.createRoadmap).toHaveBeenCalledTimes(1)
  await act(async () => fail(new Error('private details')))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The roadmap could not be created',
  )
  expect(topics).toHaveValue('One topic')
  expect(screen.queryByText('private details')).not.toBeInTheDocument()
})

it.each(['owner', 'admin'])(
  'offers %s exact reviewer links without exposing decisions in the list',
  async (role) => {
    api.listOrganizations.mockResolvedValue([
      { id: 'org-1', name: 'Campus', role },
    ])
    api.listRoadmaps.mockResolvedValue([version('Design', 2, 'in_review')])
    renderRoadmaps()
    expect(
      await screen.findByRole('link', { name: 'Review Version for Design v2' }),
    ).toHaveAttribute(
      'href',
      '/app/coordinator/roadmaps/Design/versions?organizationId=org-1&versionId=Design-v2',
    )
    expect(
      screen.queryByRole('button', { name: /approve|reject/i }),
    ).not.toBeInTheDocument()
    expect(api.listRoadmapReviews).not.toHaveBeenCalled()
  },
)

it('classifies returned drafts by the latest completed review and links to their feedback', async () => {
  api.listRoadmaps.mockResolvedValue([
    version('Returned path', 1, 'draft'),
    version('Fresh path', 2, 'draft'),
    version('Previously rejected, now pending', 1, 'in_review'),
    version('Previously rejected, now published', 1, 'published'),
    version('Archived path', 1, 'archived'),
  ])
  api.listRoadmapReviews.mockImplementation(async (_org, _roadmap, id) => ({
    version_id: id,
    status: 'draft',
    reviews: id.startsWith('Returned')
      ? [
          {
            id: 'attempt-1',
            version_id: id,
            decision: 'rejected',
            reviewed_at: '2026-10-01T12:00:00Z',
            rejection_reason: '<b>Literal feedback</b> ' + '学'.repeat(240),
          },
        ]
      : [],
  }))
  renderRoadmaps()
  const feedback = await screen.findByRole('link', {
    name: 'View Feedback for Returned path v1',
  })
  expect(feedback).toHaveAttribute(
    'href',
    '/app/coordinator/roadmaps/Returned%20path/versions?organizationId=org-1&versionId=Returned+path-v1#roadmap-review-feedback',
  )
  const returned = section('Expired & Returned')
  expect(returned.getByText('1 returned version')).toBeVisible()
  expect(
    returned.getByText('Returned for revision', { exact: true }),
  ).toBeVisible()
  expect(returned.getByText('Draft')).toHaveClass('roadmap-status-badge--draft')
  expect(returned.getByText(/^<b>Literal feedback/).textContent).toHaveLength(
    181,
  )
  expect(feedback.closest('article').querySelector('b')).toBeNull()
  expect(
    returned.getByText(/Approval-expiration tracking is not configured/),
  ).toBeVisible()
  expect(
    section('Active Roadmaps').queryByRole('link', { name: /Returned path/ }),
  ).not.toBeInTheDocument()
  expect(
    section('Pending Review').getByRole('link', { name: /now pending/ }),
  ).toBeVisible()
  expect(api.listRoadmapReviews.mock.calls.map(([, name]) => name)).toEqual([
    'Returned path',
    'Fresh path',
  ])
  fireEvent.change(
    screen.getByLabelText('Latest version status (Active Roadmaps)'),
    { target: { value: 'archived' } },
  )
  expect(feedback).toBeVisible()
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: 'RETURNED PATH' },
  })
  expect(feedback).toBeVisible()
  expect(section('Pending Review').queryByRole('link')).not.toBeInTheDocument()
  expect(api.listRoadmapReviews).toHaveBeenCalledTimes(2)
})

it('limits history concurrency, deduplicates versions, and retries only failed classifications', async () => {
  const rows = ['One', 'Two', 'Three', 'Four', 'Five'].map((name) =>
    version(name, 1, 'draft'),
  )
  api.listRoadmaps.mockResolvedValue([...rows, rows[0]])
  const requests = new Map()
  api.listRoadmapReviews.mockImplementation(
    (_org, _roadmap, id) =>
      new Promise((resolve, reject) => requests.set(id, { resolve, reject })),
  )
  renderRoadmaps()
  await waitFor(() => expect(requests.size).toBe(3))
  const returned = section('Expired & Returned')
  expect(returned.getByText('Checking drafts…')).toBeVisible()
  expect(returned.queryByText('0 returned versions')).not.toBeInTheDocument()
  const complete = (id) =>
    requests.get(id).resolve({ version_id: id, status: 'draft', reviews: [] })
  await act(async () =>
    requests.get('One-v1').reject(new Error('private message')),
  )
  await waitFor(() => expect(requests.size).toBe(4))
  expect(
    returned.getByRole('button', { name: 'Retry history checks' }),
  ).toBeDisabled()
  await act(async () => complete('Two-v1'))
  await waitFor(() => expect(requests.size).toBe(5))
  await act(async () => ['Three-v1', 'Four-v1', 'Five-v1'].forEach(complete))
  expect(returned.getByText('Partial results')).toBeVisible()
  expect(returned.queryByText('0 returned versions')).not.toBeInTheDocument()
  expect(returned.queryByText('private message')).not.toBeInTheDocument()
  fireEvent.click(
    returned.getByRole('button', { name: 'Retry history checks' }),
  )
  await waitFor(() => expect(api.listRoadmapReviews).toHaveBeenCalledTimes(6))
  expect(api.listRoadmapReviews).toHaveBeenLastCalledWith(
    'org-1',
    'One',
    'One-v1',
    { limit: 1, offset: 0 },
  )
  await act(async () => complete('One-v1'))
  expect(returned.getByText('0 returned versions')).toBeVisible()
})

it('drops late draft history when the organization changes and refuses mismatched history', async () => {
  api.listOrganizations.mockResolvedValue([
    { id: 'org-1', name: 'Campus', role: 'owner' },
    { id: 'org-2', name: 'Second campus', role: 'coordinator' },
  ])
  api.listRoadmaps.mockImplementation(async (org) => [
    version(org === 'org-1' ? 'Old path' : 'New path', 1, 'draft', {
      organization_id: org,
    }),
  ])
  let finish
  api.listRoadmapReviews
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValueOnce({
      version_id: 'Old path-v1',
      status: 'draft',
      reviews: [],
    })
  renderRoadmaps()
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent.change(screen.getByLabelText('Organization for roadmaps'), {
    target: { value: 'org-2' },
  })
  await screen.findByText('Partial results')
  await act(async () =>
    finish({
      version_id: 'Old path-v1',
      status: 'draft',
      reviews: [
        {
          id: 'old',
          version_id: 'Old path-v1',
          decision: 'rejected',
          rejection_reason: 'Old private feedback',
        },
      ],
    }),
  )
  expect(
    screen.queryByText(/Old path|Old private feedback/),
  ).not.toBeInTheDocument()
  expect(
    screen.getByRole('link', { name: 'Continue Editing for New path v1' }),
  ).toBeVisible()
  expect(api.listRoadmapReviews).toHaveBeenLastCalledWith(
    'org-2',
    'New path',
    'New path-v1',
    { limit: 1, offset: 0 },
  )
})
