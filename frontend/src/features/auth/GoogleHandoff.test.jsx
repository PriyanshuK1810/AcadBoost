import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { StrictMode } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import GoogleLoginPage from './GoogleLoginPage'
import GoogleCompletionPage from './GoogleCompletionPage'
import * as client from '../../shared/api/client'

vi.mock('../../shared/api/client', () => ({
  canStartGoogleSignIn: vi.fn(),
  checkGoogleAvailability: vi.fn(),
  beginGoogleSignIn: vi.fn(),
  completeGoogleSignIn: vi.fn(),
  restoreAuthSession: vi.fn(),
  apiRequest: vi.fn(),
  authenticateSession: vi.fn(),
  endAuthSession: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  client.checkGoogleAvailability.mockResolvedValue(true)
})
afterEach(cleanup)

function renderPage(element, url = '/auth/google/complete') {
  const router = createMemoryRouter(
    [
      { path: '/auth/google', element },
      { path: '/auth/google/complete', element },
      { path: '/app/student', element: <h1>Student workspace</h1> },
      { path: '/app/coordinator', element: <h1>Coordinator workspace</h1> },
      { path: '/login', element: <h1>Password sign-in</h1> },
    ],
    { initialEntries: [url] },
  )
  render(<RouterProvider router={router} />)
  return router
}

it('keeps Google sign-in unavailable without the approved browser configuration', () => {
  client.canStartGoogleSignIn.mockReturnValue(false)
  renderPage(<GoogleLoginPage />, '/auth/google')
  expect(screen.getByText(/Google sign-in is unavailable/)).toBeVisible()
  expect(
    screen.queryByRole('button', { name: /continue with google/i }),
  ).toBeNull()
})

it('prevents duplicate initiation and presents a safe error', async () => {
  client.canStartGoogleSignIn.mockReturnValue(true)
  let reject
  client.beginGoogleSignIn.mockReturnValue(
    new Promise((_, fail) => {
      reject = fail
    }),
  )
  renderPage(<GoogleLoginPage />, '/auth/google')
  const button = await screen.findByRole('button', {
    name: /continue with google/i,
  })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(client.beginGoogleSignIn).toHaveBeenCalledTimes(1)
  expect(button).toBeDisabled()
  reject(new Error('secret details'))
  expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t start/i)
  expect(document.body.textContent).not.toContain('secret details')
})

it('rejects a non-first-party authorization destination', async () => {
  client.canStartGoogleSignIn.mockReturnValue(true)
  client.beginGoogleSignIn.mockResolvedValue('https://other.example/authorize')
  renderPage(<GoogleLoginPage />, '/auth/google')
  fireEvent.click(
    await screen.findByRole('button', { name: /continue with google/i }),
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t start/i)
  expect(client.beginGoogleSignIn).toHaveBeenCalledTimes(1)
})

it.each([
  'cancelled',
  'invalid',
  'unavailable',
  'unknown',
  '',
  '__proto__',
  'constructor',
])('never activates a callback with result %s', async (result) => {
  renderPage(<GoogleCompletionPage />, `/auth/google/complete?result=${result}`)
  expect(await screen.findByRole('alert')).toBeVisible()
  expect(client.completeGoogleSignIn).not.toHaveBeenCalled()
  expect(screen.getByRole('link', { name: /try again/i })).toHaveAttribute(
    'href',
    '/auth/google',
  )
})

it('updates the result message when the completion URL changes', async () => {
  const router = renderPage(
    <GoogleCompletionPage />,
    '/auth/google/complete?result=invalid',
  )
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /invalid or expired/i,
  )
  await router.navigate('/auth/google/complete?result=cancelled')
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(/cancelled/i),
  )
  expect(client.completeGoogleSignIn).not.toHaveBeenCalled()
})

it.each([
  [{ code: 'google_activation_uncertain' }, /could not be confirmed/i],
  [{ status: 503 }, /unavailable right now/i],
])(
  'shows a safe distinct error for activation failure %#',
  async (error, expected) => {
    client.completeGoogleSignIn.mockRejectedValue(error)
    renderPage(<GoogleCompletionPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent(expected)
    expect(client.completeGoogleSignIn).toHaveBeenCalledTimes(1)
  },
)

it('activates once under StrictMode and replaces navigation to the account dashboard', async () => {
  client.completeGoogleSignIn.mockResolvedValue({ account_type: 'coordinator' })
  const router = renderPage(
    <StrictMode>
      <GoogleCompletionPage />
    </StrictMode>,
  )
  expect(
    await screen.findByRole('heading', { name: 'Coordinator workspace' }),
  ).toBeVisible()
  expect(client.completeGoogleSignIn).toHaveBeenCalledTimes(1)
  expect(router.state.historyAction).toBe('REPLACE')
})

it('shows an existing session conflict with explicit resume and sign-out choices', async () => {
  client.completeGoogleSignIn.mockRejectedValue({ code: 'session_conflict' })
  renderPage(<GoogleCompletionPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /already signed in/i,
  )
  expect(
    screen.getByRole('button', { name: /continue current session/i }),
  ).toBeVisible()
  expect(screen.getByRole('button', { name: /sign out/i })).toBeVisible()
})

it('resumes an existing session only after an explicit choice', async () => {
  client.completeGoogleSignIn.mockRejectedValue({ code: 'session_conflict' })
  client.restoreAuthSession.mockResolvedValue({ account_type: 'student' })
  renderPage(<GoogleCompletionPage />)
  await screen.findByRole('alert')
  expect(client.restoreAuthSession).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole('button', { name: /continue current session/i }),
  )
  expect(
    await screen.findByRole('heading', { name: 'Student workspace' }),
  ).toBeVisible()
  expect(client.restoreAuthSession).toHaveBeenCalledTimes(1)
})

it('signs out only after an explicit choice and confirmation', async () => {
  client.completeGoogleSignIn.mockRejectedValue({ code: 'session_conflict' })
  client.endAuthSession.mockResolvedValue()
  renderPage(<GoogleCompletionPage />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
  expect(
    await screen.findByRole('heading', { name: 'Password sign-in' }),
  ).toBeVisible()
  expect(client.endAuthSession).toHaveBeenCalledTimes(1)
})

it('does not replay an uncertain activation on retry', async () => {
  client.completeGoogleSignIn.mockRejectedValue(new Error('network'))
  renderPage(<GoogleCompletionPage />)
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /unavailable right now/i,
  )
  await waitFor(() =>
    expect(client.completeGoogleSignIn).toHaveBeenCalledTimes(1),
  )
  expect(screen.getByRole('link', { name: /try again/i })).toHaveAttribute(
    'href',
    '/auth/google',
  )
})

it('does not offer Google initiation when server availability is disabled', async () => {
  client.canStartGoogleSignIn.mockReturnValue(true)
  client.checkGoogleAvailability.mockResolvedValue(false)
  renderPage(<GoogleLoginPage />, '/auth/google')
  expect(
    await screen.findByText(/Google sign-in is unavailable/i),
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: /continue with google/i }),
  ).toBeNull()
})

it('fails closed when server availability cannot be checked', async () => {
  client.canStartGoogleSignIn.mockReturnValue(true)
  client.checkGoogleAvailability.mockRejectedValue(new Error('network'))
  renderPage(<GoogleLoginPage />, '/auth/google')
  expect(
    await screen.findByText(/Google sign-in is unavailable/i),
  ).toBeVisible()
  expect(
    screen.queryByRole('button', { name: /continue with google/i }),
  ).toBeNull()
})
