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
import ActivityPlanUploadPage, { UploadedPlans } from './ActivityPlanUploadPage'
import * as learning from '../learningApi'
import * as api from '../activityPlanApi'

vi.mock('../learningApi', () => ({ listOrganizations: vi.fn() }))
vi.mock('../activityPlanApi', () => ({
  listPlans: vi.fn(),
  uploadPlan: vi.fn(),
}))
const limits = { max_bytes: 10485760, max_pages: 50, max_characters: 200000 }
beforeEach(() => {
  vi.clearAllMocks()
  learning.listOrganizations.mockResolvedValue([
    { id: 'student-org', name: 'Student campus', role: 'student' },
    { id: 'staff-org', name: 'Staff campus', role: 'coordinator' },
  ])
  api.listPlans.mockResolvedValue({ plans: [], limits })
})
afterEach(cleanup)
it('offers authorized organizations without falling back from an unauthorized link', async () => {
  render(
    <MemoryRouter initialEntries={['/upload?organizationId=student-org']}>
      <ActivityPlanUploadPage />
    </MemoryRouter>,
  )
  await screen.findByRole('option', { name: 'Staff campus' })
  expect(
    screen.queryByRole('option', { name: 'Student campus' }),
  ).not.toBeInTheDocument()
  expect(screen.getByLabelText('Organization')).toHaveValue('')
  expect(screen.getByRole('alert')).toHaveTextContent(
    'This organization is unavailable',
  )
  expect(api.listPlans).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Organization'), {
    target: { value: 'staff-org' },
  })
  await waitFor(() => expect(api.listPlans).toHaveBeenCalledWith('staff-org'))
  expect(api.listPlans).not.toHaveBeenCalledWith('student-org')
})
it('keeps the selected file and plan name after a failed upload', async () => {
  api.uploadPlan.mockRejectedValue({ status: 503 })
  render(
    <MemoryRouter>
      <ActivityPlanUploadPage />
    </MemoryRouter>,
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Upload activity plan' }),
    ).toBeEnabled(),
  )
  fireEvent.change(screen.getByLabelText('Plan name'), {
    target: { value: 'Learning plan' },
  })
  const file = new File(['%PDF-1.7'], 'learning.pdf', {
    type: 'application/pdf',
  })
  fireEvent.change(screen.getByLabelText('PDF file'), {
    target: { files: [file] },
  })
  fireEvent.submit(
    screen
      .getByRole('button', { name: 'Upload activity plan' })
      .closest('form'),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Upload storage is temporarily unavailable',
  )
  expect(screen.getByLabelText('Plan name')).toHaveValue('Learning plan')
  expect(screen.getByLabelText('PDF file').files[0]).toBe(file)
})
it('does not show a prior organization’s plans while another organization loads', async () => {
  api.listPlans.mockResolvedValueOnce({
    plans: [
      {
        id: 'p1',
        name: 'Private plan',
        filename: 'private.pdf',
        status: 'ready',
      },
    ],
    limits,
  })
  const view = render(
    <MemoryRouter>
      <UploadedPlans organizationId="first" />
    </MemoryRouter>,
  )
  await screen.findByText('Private plan')
  api.listPlans.mockReturnValue(new Promise(() => {}))
  view.rerender(
    <MemoryRouter>
      <UploadedPlans organizationId="second" />
    </MemoryRouter>,
  )
  expect(screen.queryByText('Private plan')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Loading')
})

it.each([
  [
    'unsupported type',
    () => new File(['text'], 'notes.txt', { type: 'text/plain' }),
    'Choose a PDF file.',
  ],
  [
    'empty file',
    () => new File([], 'empty.pdf', { type: 'application/pdf' }),
    'This PDF is empty.',
  ],
  [
    'over-limit PDF',
    () =>
      new File([new Uint8Array(limits.max_bytes + 1)], 'big.pdf', {
        type: 'application/pdf',
      }),
    'This PDF exceeds the upload limit.',
  ],
])('rejects %s before upload', async (_label, makeFile, message) => {
  render(
    <MemoryRouter>
      <ActivityPlanUploadPage />
    </MemoryRouter>,
  )
  const input = await screen.findByLabelText('PDF file')
  await screen.findByText(/up to 10 MiB/)
  fireEvent.change(input, { target: { files: [makeFile()] } })
  expect(screen.getByRole('alert')).toHaveTextContent(message)
  fireEvent.submit(input.form)
  expect(api.uploadPlan).not.toHaveBeenCalled()
})

it('starts one scoped upload and drops its late result after an organization change', async () => {
  learning.listOrganizations.mockResolvedValue([
    { id: 'staff-org', name: 'Staff campus', role: 'coordinator' },
    { id: 'other-org', name: 'Other campus', role: 'admin' },
  ])
  let complete
  api.uploadPlan.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  render(
    <MemoryRouter>
      <ActivityPlanUploadPage />
    </MemoryRouter>,
  )
  await screen.findByText(/up to 10 MiB/)
  const file = new File(['%PDF-1.7'], 'activity.pdf', {
    type: 'application/pdf',
  })
  const input = screen.getByLabelText('PDF file')
  fireEvent.change(screen.getByLabelText('Plan name'), {
    target: { value: 'Staff plan' },
  })
  fireEvent.change(input, { target: { files: [file] } })
  fireEvent.submit(input.form)
  fireEvent.submit(input.form)
  expect(api.uploadPlan).toHaveBeenCalledExactlyOnceWith(
    'staff-org',
    'Staff plan',
    file,
  )
  expect(screen.getByRole('status')).toHaveTextContent('Uploading your PDF')
  fireEvent.change(screen.getByLabelText('Organization'), {
    target: { value: 'other-org' },
  })
  await act(async () =>
    complete({ id: 'first-plan', organization_id: 'staff-org' }),
  )
  expect(screen.getByLabelText('Plan name')).toHaveValue('')
  expect(screen.queryByText('Selected: activity.pdf')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('link', { name: 'Open uploaded plan' }),
  ).not.toBeInTheDocument()
})
