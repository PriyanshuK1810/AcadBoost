import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as learningApi from '../learningApi'
import { useWorkspace } from '../hooks/useWorkspace'
import OrganizationsPage from './OrganizationsPage'
import OrganizationDetailPage from './OrganizationDetailPage'

vi.mock('../hooks/useWorkspace', () => ({ useWorkspace: vi.fn() }))
vi.mock('../learningApi', () => ({
  listOrganizations: vi.fn(),
  getOrganization: vi.fn(),
  listOrganizationMembers: vi.fn(),
  listOrganizationInvitations: vi.fn(),
  listMentorAssignments: vi.fn(),
  assignMentor: vi.fn(),
  revokeMentorAssignment: vi.fn(),
  createOrganizationInvitation: vi.fn(),
  revokeOrganizationInvitation: vi.fn(),
  acceptOrganizationInvitation: vi.fn(),
  updateOrganizationMember: vi.fn(),
  transferOrganizationOwnership: vi.fn(),
}))

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useWorkspace).mockReturnValue({
    user: { id: 'owner-1', account_type: 'coordinator' },
    organizationScope: {
      organizations: [{ id: 'org-1', name: 'Campus', role: 'owner' }],
      loading: false,
      retry: vi.fn(),
    },
  })
  vi.mocked(learningApi.listOrganizations).mockResolvedValue([
    { id: 'org-1', name: 'Campus', role: 'owner' },
  ])
  vi.mocked(learningApi.getOrganization).mockResolvedValue({
    id: 'org-1',
    name: 'Campus',
    role: 'owner',
  })
  vi.mocked(learningApi.listOrganizationMembers).mockResolvedValue([
    {
      id: 'membership-1',
      user_id: 'owner-1',
      display_name: 'Mira',
      email: 'mira@example.edu',
      role: 'owner',
      status: 'active',
    },
  ])
  vi.mocked(learningApi.listOrganizationInvitations).mockResolvedValue([])
  vi.mocked(learningApi.listMentorAssignments).mockResolvedValue({
    assignments: [],
    mentors: [],
    cohorts: [],
  })
})

it('lets an owner issue an invitation and displays its one-time code', async () => {
  vi.mocked(learningApi.createOrganizationInvitation).mockResolvedValue({
    code: 'secret-code',
  })
  render(
    <MemoryRouter initialEntries={['/app/organizations/org-1']}>
      <Routes>
        <Route
          path="/app/organizations/:organizationId"
          element={<OrganizationDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Staff email'), {
    target: { value: 'new@example.edu' },
  })
  fireEvent.change(screen.getByLabelText('Invitation role'), {
    target: { value: 'mentor' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))
  await waitFor(() =>
    expect(learningApi.createOrganizationInvitation).toHaveBeenCalledWith(
      'org-1',
      'new@example.edu',
      'mentor',
    ),
  )
  expect(await screen.findByText('secret-code')).toBeInTheDocument()
})

it('keeps the full member identity and Owner controls together for long names and emails', async () => {
  const name = 'Coordinator' + 'LongUnbrokenName'.repeat(8)
  const email = 'disposable@a-very-long-department.fixture.example.test'
  const member = {
    id: 'membership-2',
    user_id: 'coordinator-2',
    display_name: name,
    email,
    account_type: 'coordinator',
    role: 'coordinator',
    status: 'active',
  }
  learningApi.listOrganizationMembers.mockResolvedValue([member])
  learningApi.listMentorAssignments
    .mockResolvedValueOnce({
      assignments: [],
      mentors: [],
      cohorts: [],
    })
    .mockResolvedValueOnce({
      assignments: [],
      mentors: [{ id: member.id, display_name: name }],
      cohorts: [],
    })
  learningApi.updateOrganizationMember.mockResolvedValue({
    ...member,
    role: 'mentor',
  })
  render(
    <MemoryRouter initialEntries={['/app/organizations/org-1']}>
      <Routes>
        <Route
          path="/app/organizations/:organizationId"
          element={<OrganizationDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
  expect(await screen.findByRole('heading', { name })).toBeVisible()
  expect(screen.getByText(email)).toBeVisible()
  expect(screen.getByText('coordinator · active')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Deactivate' })).toBeEnabled()
  await screen.findByLabelText('Mentor')
  const role = screen.getByRole('combobox', { name: `Role for ${name}` })
  fireEvent.change(role, { target: { value: 'mentor' } })
  expect(learningApi.updateOrganizationMember).toHaveBeenCalledWith(
    'org-1',
    'membership-2',
    { role: 'mentor' },
  )
  expect(await screen.findByRole('option', { name })).toBeInTheDocument()
})

it('lets a coordinator accept a staff invitation', async () => {
  vi.mocked(learningApi.acceptOrganizationInvitation).mockResolvedValue({
    organization_name: 'Campus',
    role: 'mentor',
  })
  render(
    <MemoryRouter>
      <OrganizationsPage />
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Staff invitation code'), {
    target: { value: 'valid-code' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }))
  await waitFor(() =>
    expect(learningApi.acceptOrganizationInvitation).toHaveBeenCalledWith(
      'valid-code',
    ),
  )
  expect(await screen.findByText(/joined Campus/i)).toBeInTheDocument()
})

it('keeps the confirmed invitation when the follow-up list refresh fails', async () => {
  learningApi.listOrganizationInvitations
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error('Temporary outage'))
  learningApi.createOrganizationInvitation.mockResolvedValue({
    code: 'issued-code',
  })
  render(
    <MemoryRouter initialEntries={['/app/organizations/org-1']}>
      <Routes>
        <Route
          path="/app/organizations/:organizationId"
          element={<OrganizationDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Staff email'), {
    target: { value: 'new@example.edu' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The change was saved',
  )
  expect(screen.getByText('issued-code')).toBeInTheDocument()
  expect(learningApi.createOrganizationInvitation).toHaveBeenCalledTimes(1)
})

it('discards a late one-time invitation and its follow-up read after leaving the organization', async () => {
  const workspace = useWorkspace()
  workspace.organizationScope.organizations = [
    { id: 'a', name: 'Campus a', role: 'owner' },
    { id: 'b', name: 'Campus b', role: 'owner' },
  ]
  const delayed = Promise.withResolvers()
  learningApi.createOrganizationInvitation.mockReturnValue(delayed.promise)
  learningApi.getOrganization.mockImplementation(async (id) => ({
    id,
    name: `Campus ${id}`,
    role: 'owner',
  }))
  render(
    <MemoryRouter initialEntries={['/app/organizations/a']}>
      <Link to="/app/organizations/b">Open B</Link>
      <Routes>
        <Route
          path="/app/organizations/:organizationId"
          element={<OrganizationDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.change(await screen.findByLabelText('Staff email'), {
    target: { value: 'disposable@example.test' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }))
  expect(
    learningApi.createOrganizationInvitation,
  ).toHaveBeenCalledExactlyOnceWith(
    'a',
    'disposable@example.test',
    'coordinator',
  )
  fireEvent.click(screen.getByRole('link', { name: 'Open B' }))
  await screen.findByRole('heading', { name: 'Campus b' })
  await act(async () => delayed.resolve({ code: 'obsolete-invite' }))
  expect(screen.queryByText('obsolete-invite')).not.toBeInTheDocument()
  expect(screen.queryByText(/Invitation created/)).not.toBeInTheDocument()
  expect(learningApi.listOrganizationInvitations.mock.calls).toEqual([
    ['a'],
    ['b'],
  ])
})

it('lets an owner deactivate a staff member from the member directory', async () => {
  vi.mocked(learningApi.listOrganizationMembers).mockResolvedValue([
    {
      id: 'membership-1',
      user_id: 'owner-1',
      display_name: 'Mira',
      email: 'mira@example.edu',
      account_type: 'coordinator',
      role: 'owner',
      status: 'active',
    },
    {
      id: 'membership-2',
      user_id: 'staff-1',
      display_name: 'Ari',
      email: 'ari@example.edu',
      account_type: 'coordinator',
      role: 'mentor',
      status: 'active',
    },
  ])
  vi.mocked(learningApi.updateOrganizationMember).mockResolvedValue({
    status: 'inactive',
  })
  render(
    <MemoryRouter initialEntries={['/app/organizations/org-1']}>
      <Routes>
        <Route
          path="/app/organizations/:organizationId"
          element={<OrganizationDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }))
  await waitFor(() =>
    expect(learningApi.updateOrganizationMember).toHaveBeenCalledWith(
      'org-1',
      'membership-2',
      { status: 'inactive' },
    ),
  )
})

it('links an owner to organization management', async () => {
  render(
    <MemoryRouter initialEntries={['/app/organizations']}>
      <OrganizationsPage />
    </MemoryRouter>,
  )
  expect(
    await screen.findByRole('link', { name: /manage organization/i }),
  ).toHaveAttribute('href', '/app/organizations/org-1')
})

it('links a Mentor membership to its own workspace without offering governance', () => {
  const workspace = useWorkspace()
  const membership = { id: 'org-1', name: 'Campus', role: 'mentor' }
  workspace.organizationScope.organization = membership
  workspace.organizationScope.organizations = [membership]
  render(
    <MemoryRouter initialEntries={['/app/organizations']}>
      <OrganizationsPage />
    </MemoryRouter>,
  )
  expect(screen.getByText('Mentor membership')).toBeVisible()
  expect(
    screen.getByRole('link', { name: /open mentor workspace/i }),
  ).toHaveAttribute('href', '/app/coordinator/learning?organizationId=org-1')
  expect(
    screen.queryByRole('link', { name: /manage organization/i }),
  ).not.toBeInTheDocument()
})

it.each(['admin', 'coordinator', 'mentor', 'student', null])(
  'does not load Owner-only data through a direct link for role %s',
  async (role) => {
    vi.mocked(useWorkspace).mockReturnValue({
      user: {
        id: 'viewer',
        account_type: role === 'student' ? 'student' : 'coordinator',
      },
      organizationScope: {
        organizations: [
          { id: 'other-org', name: 'Other campus', role: 'owner' },
          ...(role ? [{ id: 'org-1', name: 'Campus', role }] : []),
        ],
      },
    })
    render(
      <MemoryRouter initialEntries={['/app/organizations/org-1']}>
        <Routes>
          <Route
            path="/app/organizations/:organizationId"
            element={<OrganizationDetailPage />}
          />
        </Routes>
      </MemoryRouter>,
    )
    expect(
      await screen.findByRole('heading', { name: 'Owner access required' }),
    ).toBeVisible()
    expect(learningApi.getOrganization).not.toHaveBeenCalled()
    expect(learningApi.listOrganizationMembers).not.toHaveBeenCalled()
    expect(learningApi.listOrganizationInvitations).not.toHaveBeenCalled()
  },
)

it('shows an owner the member directory without credential fields', async () => {
  render(
    <MemoryRouter initialEntries={['/app/organizations/org-1']}>
      <Routes>
        <Route
          path="/app/organizations/:organizationId"
          element={<OrganizationDetailPage />}
        />
      </Routes>
    </MemoryRouter>,
  )
  expect(
    await screen.findByRole('heading', { name: 'Campus' }),
  ).toBeInTheDocument()
  expect(await screen.findByText('Mira')).toBeInTheDocument()
  expect(screen.getByText('mira@example.edu')).toBeInTheDocument()
  expect(learningApi.getOrganization).toHaveBeenCalledWith('org-1')
  expect(learningApi.listOrganizationMembers).toHaveBeenCalledWith('org-1')
})
