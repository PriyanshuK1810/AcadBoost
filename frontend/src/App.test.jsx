import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './app/App'
import WorkspaceShell from './features/workspace/components/WorkspaceShell'
import useUnsavedChanges from './features/workspace/hooks/useUnsavedChanges'
import { clearAccessToken, setAccessToken } from './shared/api/client'
afterEach(() => {
  cleanup()
  clearAccessToken()
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

it('keeps a failed sign-out in the workspace and only opens sign-in after a confirmed retry', async () => {
  window.history.replaceState({}, '', '/app/account')
  setAccessToken('session')
  const first = Promise.withResolvers()
  const user = {
    id: 'student',
    display_name: 'Disposable Student',
    account_type: 'student',
  }
  let logoutCalls = 0
  const fetchMock = vi.fn(async (input) => {
    const path = String(input)
    if (path.endsWith('/me')) return Response.json(user)
    if (path.endsWith('/auth/logout')) {
      logoutCalls++
      return logoutCalls === 1
        ? first.promise
        : new Response(null, { status: 204 })
    }
    return Response.json([])
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<App />)
  fireEvent.click(
    await screen.findByRole('button', { name: 'Account options' }),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Sign out', exact: true }))
  expect(
    await screen.findByRole('dialog', { name: /Signing out/i }),
  ).toBeInTheDocument()
  first.resolve(new Response(null, { status: 500 }))
  expect(
    await screen.findByRole('dialog', { name: /couldn’t confirm sign-out/i }),
  ).toBeInTheDocument()
  expect(window.location.pathname).toBe('/app/account')
  fireEvent.click(screen.getByRole('button', { name: 'Retry sign out' }))
  await waitFor(() => expect(window.location.pathname).toBe('/login'))
  expect(logoutCalls).toBe(2)
  expect(
    fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/refresh')),
  ).toBe(false)
})

it('cancels sign-out without touching a dirty draft and prompts only once on confirmed departure', async () => {
  setAccessToken('session')
  const user = {
    id: 'coordinator',
    display_name: 'Disposable Coordinator',
    account_type: 'coordinator',
  }
  const logout = vi.fn(() => new Response(null, { status: 204 }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input) => {
      const path = String(input)
      if (path.endsWith('/me')) return Response.json(user)
      if (path.endsWith('/auth/logout')) return logout()
      return Response.json([])
    }),
  )
  function Draft() {
    const [text, setText] = useState('Saved draft')
    useUnsavedChanges(text !== 'Saved draft')
    return (
      <input
        aria-label="Draft topic"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    )
  }
  const confirm = vi
    .spyOn(window, 'confirm')
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true)
  try {
    const router = createMemoryRouter(
      [
        {
          path: '/app',
          element: <WorkspaceShell />,
          children: [{ path: 'coordinator/draft', element: <Draft /> }],
        },
        { path: '/login', element: <h1>Sign in again</h1> },
      ],
      { initialEntries: ['/app/coordinator/draft'] },
    )
    render(<RouterProvider router={router} />)
    const topic = await screen.findByRole('textbox', { name: 'Draft topic' })
    fireEvent.change(topic, { target: { value: 'My unsaved edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Account options' }))
    const signOut = screen.getByRole('button', {
      name: 'Sign out',
      exact: true,
    })
    fireEvent.click(signOut)
    expect(topic).toHaveValue('My unsaved edit')
    expect(logout).not.toHaveBeenCalled()
    expect(router.state.location.pathname).toBe('/app/coordinator/draft')

    fireEvent.click(signOut)
    expect(
      await screen.findByRole('heading', { name: 'Sign in again' }),
    ).toBeVisible()
    expect(logout).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(
      screen.queryByRole('textbox', { name: 'Draft topic' }),
    ).not.toBeInTheDocument()
    await act(() => router.navigate('/app/coordinator/draft'))
    expect(router.state.location.pathname).toBe('/login')
  } finally {
    confirm.mockRestore()
  }
})
describe('Outpost landing page', () => {
  it('introduces the learning-to-career pathway and its main sections', () => {
    render(<App />)
    expect(
      within(screen.getByRole('banner')).getByRole('link', {
        name: 'Acadboost home',
      }),
    ).toHaveAttribute('href', '#home')
    expect(screen.queryByText(/Outpost helps/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: /a guided path from learning to career readiness for every student/i,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: /build skills\. gain experience\. be career ready/i,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: /built around the whole learning cycle/i,
      }),
    ).toBeInTheDocument()
  })
  it('labels the illustrative roadmap and keeps the hero image-free', () => {
    render(<App />)
    expect(
      screen.getByRole('complementary', { name: 'Example roadmap' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: /^career readiness$/i,
      }),
    ).toBeInTheDocument()
    expect(document.querySelectorAll('img')).toHaveLength(0)
  })
  it('links navigation and the primary action to real page sections', () => {
    render(<App />)
    expect(screen.getByRole('link', { name: 'The pathway' })).toHaveAttribute(
      'href',
      '#pathway',
    )
    expect(screen.getAllByRole('link', { name: /get started/i })).toHaveLength(
      2,
    )
    expect(screen.getByRole('link', { name: 'View demo' })).toHaveAttribute(
      'href',
      '/review',
    )
    expect(
      screen.getByRole('link', { name: 'Create your account' }),
    ).toHaveAttribute('href', '/register')
    expect(screen.getByRole('link', { name: /for colleges/i })).toHaveAttribute(
      'href',
      '#for-colleges',
    )
  })
  it('keeps the compact navigation menu button accessible and toggleable', () => {
    render(<App />)
    const menuButton = screen.getByRole('button', {
      name: /toggle navigation/i,
    })
    expect(menuButton).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(menuButton)
    expect(menuButton).toHaveAttribute('aria-expanded', 'true')
  })
})
describe('Outpost cards and authentication', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/')
  })
  it('presents all learning points as individual cards', () => {
    render(<App />)
    expect(screen.getAllByRole('article')).toHaveLength(8)
    expect(screen.getByText('Build skills')).toBeInTheDocument()
    expect(screen.getByText('Plan with a roadmap')).toBeInTheDocument()
    expect(screen.getByText('For students')).toBeInTheDocument()
  })
  it('waits for refresh-session restoration before enabling sign in', async () => {
    window.history.replaceState({}, '', '/login')
    let resolveRefresh = () => undefined
    const refreshPending = new Promise((resolve) => {
      resolveRefresh = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(refreshPending))
    render(<App />)
    expect(
      screen.getByRole('link', { name: 'Acadboost home' }),
    ).toHaveAttribute('href', '/')
    expect(screen.getByText('New to Acadboost?')).toBeInTheDocument()
    const submitButton = await screen.findByRole('button', {
      name: /checking your session/i,
    })
    expect(submitButton).toBeDisabled()
    resolveRefresh(new Response(null, { status: 401 }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled(),
    )
  })
  it.each([
    ['student', '/app/student'],
    ['coordinator', '/app/coordinator'],
  ])(
    'sends a %s account to its dashboard after login',
    async (accountType, target) => {
      window.history.replaceState({}, '', '/login')
      const user = {
        id: 'user-1',
        display_name: 'Mira',
        username: 'mira',
        primary_email: 'mira@example.edu',
        email_verified_at: null,
        account_type: accountType,
      }
      const fetchMock = vi.fn(async (input, _options) => {
        void _options
        const url = String(input)
        if (url.endsWith('/auth/refresh'))
          return new Response(null, { status: 401 })
        if (url.endsWith('/auth/password/login'))
          return new Response(JSON.stringify({ access_token: 'token' }), {
            status: 200,
          })
        if (url.endsWith('/me'))
          return new Response(JSON.stringify(user), { status: 200 })
        if (url.endsWith('/review/overview'))
          return new Response(
            JSON.stringify({
              scenario: 'illustrative',
              student: {
                roadmap_title: 'Roadmap',
                completed: 0,
                total: 0,
                percent: 0,
                next_topic: null,
                phases: [],
              },
              coordinator:
                accountType === 'coordinator'
                  ? {
                      cohort_title: 'Cohort',
                      roadmap_title: 'Roadmap',
                      members: [],
                      average_percent: 0,
                      topics: [],
                    }
                  : null,
            }),
            { status: 200 },
          )
        throw new Error('Unexpected request: ' + url)
      })
      vi.stubGlobal('fetch', fetchMock)
      render(<App />)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled(),
      )
      fireEvent.change(screen.getByLabelText(/email or username/i), {
        target: { value: 'mira@example.edu' },
      })
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'long-enough-password' },
      })
      fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
      await waitFor(() => expect(window.location.pathname).toBe(target))
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).endsWith('/auth/password/login'),
        ),
      ).toBe(true)
    },
  )
  it('registers the chosen account type and redirects to login without automatic sign-in', async () => {
    window.history.replaceState({}, '', '/register')
    setAccessToken('prior-session-token')
    const fetchMock = vi.fn(async (input, _options) => {
      void _options
      const url = String(input)
      if (url.endsWith('/auth/password/register'))
        return new Response(JSON.stringify({ id: 'user-2' }), { status: 201 })
      if (url.endsWith('/auth/refresh'))
        return new Response(null, { status: 401 })
      throw new Error('Unexpected request: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: /coordinator/i }))
    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: 'Mira Coordinator' },
    })
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'mira_coordinator' },
    })
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'mira@example.edu' },
    })
    fireEvent.change(screen.getAllByLabelText(/^password/i)[0], {
      target: { value: 'a-long-secure-password' },
    })
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'a-long-secure-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create account/i }))
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(await screen.findByRole('status')).toHaveTextContent(
      /account created/i,
    )
    const register = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/auth/password/register'),
    )
    expect(register).toBeDefined()
    expect(JSON.parse(String(register?.[1]?.body))).toMatchObject({
      account_type: 'coordinator',
      email: 'mira@example.edu',
    })
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith('/auth/password/login'),
      ),
    ).toBe(false)
    expect(fetchMock.mock.calls).toHaveLength(1)
  })
  it('explains an existing account when registration returns a conflict', async () => {
    window.history.replaceState({}, '', '/register')
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: 'Registration cannot be completed with these identifiers',
          },
        }),
        { status: 409 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: 'Mira Student' },
    })
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'mira_student' },
    })
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'mira@example.edu' },
    })
    fireEvent.change(screen.getAllByLabelText(/^password/i)[0], {
      target: { value: 'a-long-secure-password' },
    })
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'a-long-secure-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /create account/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /email or username is already registered/i,
    )
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('shows safe API error messages on the login form', async () => {
    window.history.replaceState({}, '', '/login')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { message: 'Invalid credentials' } }),
            { status: 401 },
          ),
        ),
    )
    render(<App />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled(),
    )
    fireEvent.change(screen.getByLabelText(/email or username/i), {
      target: { value: 'mira@example.edu' },
    })
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'incorrect-password' },
    })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid credentials',
    )
  })
})
