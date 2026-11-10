import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MarketingPage from './MarketingPage'

afterEach(cleanup)

describe('interactive homepage', () => {
  it('preserves navigation destinations and closes the mobile menu', () => {
    render(<MarketingPage />)
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    const menu = screen.getByRole('button', { name: 'Toggle navigation' })
    expect(
      within(nav).getByRole('link', { name: 'The pathway' }),
    ).toHaveAttribute('href', '#pathway')
    expect(screen.getByRole('link', { name: 'View demo' })).toHaveAttribute(
      'href',
      '/review',
    )
    expect(
      screen.getByRole('link', { name: 'Create your account' }),
    ).toHaveAttribute('href', '/register')
    fireEvent.click(menu)
    expect(menu).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(within(nav).getByRole('link', { name: 'The pathway' }))
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(menu)
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(menu).toHaveAttribute('aria-expanded', 'false')
    expect(menu).toHaveFocus()
  })

  it('updates the selected learning stage and associated explanation', () => {
    render(<MarketingPage />)
    const build = screen.getByRole('button', { name: /build skills/i })
    expect(build).toHaveAttribute('aria-pressed', 'true')
    const experience = screen.getByRole('button', { name: /gain experience/i })
    fireEvent.mouseEnter(experience)
    expect(build).toHaveAttribute('aria-pressed', 'true')
    expect(experience).toHaveAttribute('aria-pressed', 'false')
    for (const [name, detail] of [
      [/gain experience/i, /apply what you learn through practice/i],
      [/be career ready/i, /connect your skills and experience/i],
      [/build skills/i, /build a foundation through a structured path/i],
    ]) {
      const button = screen.getByRole('button', { name })
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByText(detail)).toBeVisible()
    }
  })

  it('selects learning-cycle cards with bounded controls and direct selection', () => {
    render(<MarketingPage />)
    const previous = screen.getByRole('button', {
      name: 'Previous learning-cycle card',
    })
    const next = screen.getByRole('button', {
      name: 'Next learning-cycle card',
    })
    const position = screen.getByRole('status')
    expect(position).toHaveTextContent('1 of 3 · Plan with a roadmap')
    expect(previous).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(previous)
    expect(position).toHaveTextContent('1 of 3')
    fireEvent.click(next)
    expect(position).toHaveTextContent('2 of 3 · Guide each cohort')
    fireEvent.click(previous)
    expect(position).toHaveTextContent('1 of 3')
    const last = screen.getByRole('button', {
      name: 'Select Understand progress',
    })
    last.focus()
    fireEvent.click(last)
    expect(last).toHaveFocus()
    expect(last).toHaveAttribute('aria-pressed', 'true')
    expect(position).toHaveTextContent('3 of 3 · Understand progress')
    expect(next).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(next)
    expect(position).toHaveTextContent('3 of 3')
  })

  it('keeps the carousel on the current card over time', () => {
    vi.useFakeTimers()
    try {
      render(<MarketingPage />)
      vi.advanceTimersByTime(60_000)
      expect(screen.getByRole('status')).toHaveTextContent('1 of 3')
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens and closes a single learning-cycle disclosure', () => {
    render(<MarketingPage />)
    const buttons = screen.getAllByRole('button', { name: /learn more/i })
    fireEvent.click(buttons[0])
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByText(/a shared roadmap makes the sequence/i),
    ).toBeVisible()
    fireEvent.click(buttons[1])
    expect(buttons[0]).toHaveAttribute('aria-expanded', 'false')
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(buttons[1])
    expect(buttons[1]).toHaveAttribute('aria-expanded', 'false')
    const detail = document.getElementById(
      buttons[1].getAttribute('aria-controls'),
    )
    expect(detail).not.toBeVisible()
  })

  it('closes the outgoing disclosure when navigating and preserves control focus', () => {
    render(<MarketingPage />)
    const learn = screen.getByRole('button', {
      name: 'Learn more about Plan with a roadmap',
    })
    const next = screen.getByRole('button', {
      name: 'Next learning-cycle card',
    })
    fireEvent.click(learn)
    next.focus()
    fireEvent.click(next)
    expect(next).toHaveFocus()
    expect(learn).toHaveAttribute('aria-expanded', 'false')
    expect(
      document.getElementById(learn.getAttribute('aria-controls')),
    ).not.toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 of 3 · Guide each cohort',
    )
  })

  it('explores audiences and illustrative weeks without implying saved progress', () => {
    render(<MarketingPage />)
    const students = screen
      .getByRole('heading', { name: 'For students' })
      .closest('article')
    fireEvent.click(
      within(students).getByRole('button', { name: /explore for students/i }),
    )
    expect(within(students).getByRole('button')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(
      within(students).getByText(/see the next step in a learning path/i),
    ).toBeVisible()
    const roadmap = screen.getByRole('complementary', {
      name: 'Example roadmap',
    })
    expect(within(roadmap).getByText(/example content/i)).toBeVisible()
    const second = within(roadmap).getByRole('button', { name: /week 02/i })
    const goal = document.getElementById(second.getAttribute('aria-controls'))
    expect(goal).toHaveAttribute('aria-live', 'polite')
    expect(goal).toHaveTextContent('Week 01 goal')
    fireEvent.click(second)
    expect(second).toHaveAttribute('aria-pressed', 'true')
    expect(goal).toHaveTextContent('Week 02 goal')
    expect(
      within(roadmap).getByText(/bring your practice together/i),
    ).toBeVisible()
    fireEvent.click(within(roadmap).getByRole('button', { name: /week 03/i }))
    expect(
      within(roadmap).getByText(/prepare to talk about your work/i),
    ).toBeVisible()
  })

  it('flips a card back with the same focused control and exposes only the active face', () => {
    render(<MarketingPage />)
    const button = screen.getByRole('button', { name: 'Explore For students' })
    const article = button.closest('article')
    const front = within(article).getByRole('heading', {
      name: 'For students',
    }).parentElement
    const back = document.getElementById(button.getAttribute('aria-controls'))
    expect(front).not.toHaveAttribute('inert')
    expect(back).toHaveAttribute('inert')
    expect(back).toHaveAttribute('aria-hidden', 'true')
    button.focus()
    fireEvent.click(button)
    expect(
      within(article).getByRole('button', { name: 'Flip back · For students' }),
    ).toBe(button)
    expect(button).toHaveFocus()
    expect(front).toHaveAttribute('inert')
    expect(front).toHaveAttribute('aria-hidden', 'true')
    expect(back).not.toHaveAttribute('inert')
    expect(within(back).getByText('Follow your assigned roadmap')).toBeVisible()
    expect(
      within(article).getByRole('heading', { name: 'How Acadboost helps' })
        .parentElement,
    ).toBe(back)
    expect(within(article).getAllByRole('button', { hidden: true })).toEqual([
      button,
    ])
    fireEvent.click(button)
    expect(button).toHaveFocus()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(back).toHaveAttribute('inert')
    expect(front).not.toHaveAttribute('inert')
  })
})
