import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import BrandWordmark from './BrandWordmark'

describe('Acadboost wordmark', () => {
  it('renders a linked wordmark with a stable accessible name', () => {
    render(
      <BrandWordmark
        className="wordmark"
        href="/"
        tagline="Learning Workspace"
      />,
    )

    const link = screen.getByRole('link', { name: 'Acadboost home' })
    expect(link).toHaveAttribute('href', '/')
    expect(link).toHaveTextContent('Acadboost.')
    expect(link).toHaveTextContent('Learning Workspace')
    expect(link.querySelector('span')).toHaveAttribute('aria-hidden', 'true')
  })

  it('renders a noninteractive wordmark when no destination is provided', () => {
    const { container } = render(
      <BrandWordmark className="workspace-logo" />,
    )

    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('.workspace-logo')).toHaveTextContent(
      'Acadboost.',
    )
  })
})
