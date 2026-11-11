import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AccountRecoveryPage from './AccountRecoveryPage'
import GoogleLoginPage from './GoogleLoginPage'
import PhoneLoginPage from './PhoneLoginPage'
import * as api from './authApi'

vi.mock('./authApi', async (importOriginal) => ({
  ...(await importOriginal()),
  requestPhoneCode: vi.fn(),
  verifyPhoneCode: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  confirmEmailVerification: vi.fn(),
}))

beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)

const token = 'x'.repeat(43)
const renderPage = (element, url = '/auth') => {
  const router = createMemoryRouter(
    [
      { path: '/auth', element },
      { path: '/app/student', element: <h1>Student workspace</h1> },
    ],
    { initialEntries: [url] },
  )
  render(<RouterProvider router={router} />)
  return router
}
const fill = (label, value) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const press = (name) => fireEvent.click(screen.getByRole('button', { name }))

it('does not initiate a Google flow without a safe return contract', () => {
  renderPage(<GoogleLoginPage />)
  expect(screen.getByText(/Google sign-in is unavailable/)).toBeVisible()
  expect(screen.getByRole('link', { name: 'Password' })).toHaveAttribute(
    'href',
    '/login',
  )
  expect(screen.queryByRole('button', { name: /Google/i })).toBeNull()
})

it('distinguishes an accepted phone request from delivery and verifies through the shared sign-in path', async () => {
  api.requestPhoneCode.mockResolvedValue(undefined)
  api.verifyPhoneCode.mockResolvedValue({ account_type: 'student' })
  renderPage(<PhoneLoginPage />)
  fill(/Phone number/, '+12025550123')
  press('Request code')
  expect(await screen.findByRole('status')).toHaveTextContent(
    /delivery isn’t confirmed/i,
  )
  expect(screen.getByLabelText('Six-digit code')).toHaveFocus()
  fill('Six-digit code', '012345')
  press('Verify and sign in')
  expect(
    await screen.findByRole('heading', { name: 'Student workspace' }),
  ).toBeVisible()
  expect(api.verifyPhoneCode).toHaveBeenCalledExactlyOnceWith(
    '+12025550123',
    '012345',
  )
})

it('handles invalid or expired OTPs and rate limits without replaying the request', async () => {
  api.requestPhoneCode
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce({ status: 429 })
  api.verifyPhoneCode.mockRejectedValue({ status: 401 })
  renderPage(<PhoneLoginPage />)
  fill(/Phone number/, '+12025550123')
  press('Request code')
  await screen.findByLabelText('Six-digit code')
  fill('Six-digit code', '012345')
  press('Verify and sign in')
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /invalid or expired/,
  )
  press('Request another code')
  expect(await screen.findByRole('alert')).toHaveTextContent(/too many/i)
  expect(api.requestPhoneCode).toHaveBeenCalledTimes(2)
})

it('uses an enumeration-safe accepted response for recovery', async () => {
  api.requestPasswordReset.mockResolvedValue(undefined)
  renderPage(<AccountRecoveryPage mode="forgot" />)
  fill('Email address', 'fixture@example.test')
  press('Request reset link')
  expect(await screen.findByRole('status')).toHaveTextContent(
    /if the address is eligible/i,
  )
  expect(
    screen.queryByRole('button', { name: 'Request reset link' }),
  ).toBeNull()
})

it('scrubs reset tokens from the address and visible controls; confirmed reset cannot be submitted again', async () => {
  api.resetPassword.mockResolvedValue(undefined)
  const router = renderPage(
    <AccountRecoveryPage mode="reset" />,
    '/auth?token=' + token,
  )
  await waitFor(() => expect(router.state.location.search).toBe(''))
  expect(screen.queryByLabelText(/token/i)).toBeNull()
  fill('New password', 'synthetic passphrase')
  fill('Confirm new password', 'synthetic passphrase')
  press('Update password')
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Password updated',
  )
  expect(screen.queryByLabelText('New password')).toBeNull()
  expect(api.resetPassword).toHaveBeenCalledExactlyOnceWith(
    token,
    'synthetic passphrase',
  )
})

it('shows safe recovery when an email link is invalid, expired, or used', async () => {
  api.confirmEmailVerification.mockRejectedValue({
    status: 400,
    message: token,
  })
  renderPage(<AccountRecoveryPage mode="verify" />, '/auth?token=' + token)
  press('Verify email')
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /invalid, expired, or already used/i,
  )
  expect(document.body.textContent).not.toContain(token)
  expect(screen.queryByRole('button', { name: 'Verify email' })).toBeNull()
  expect(
    screen.getByRole('link', { name: 'Go to My account' }),
  ).toHaveAttribute('href', '/app/account')
})
