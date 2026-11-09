import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import RoadmapStatusBadge from './RoadmapStatusBadge'
import '../../../app/workspace.css'

it.each([
  ['draft', 'Draft', 'roadmap-status-badge--draft'],
  ['in_review', 'In review', 'roadmap-status-badge--in_review'],
  ['published', 'Published', 'roadmap-status-badge--published'],
  ['archived', 'Archived', 'roadmap-status-badge--archived'],
])('renders the %s lifecycle status', (status, label, className) => {
  const { container } = render(<RoadmapStatusBadge status={status} />)
  const badge = screen.getByText(label)
  expect(badge).toHaveClass(className)
  expect(getComputedStyle(badge).color).not.toBe('rgb(104, 122, 114)')
  expect(getComputedStyle(badge).textTransform).toBe('none')
  expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  expect(container.querySelector('svg')).toHaveAttribute('focusable', 'false')
  expect(container.querySelector('span')).not.toHaveAttribute('tabindex')
})

it.each([undefined, 'rejected', 'IN_REVIEW'])(
  'renders unsupported status %s as a neutral label',
  (status) => {
    const { container } = render(<RoadmapStatusBadge status={status} />)
    expect(screen.getAllByText('Unknown status')[0]).toHaveClass(
      'roadmap-status-badge--unknown',
    )
    expect(container.querySelector('svg')).toBeNull()
  },
)
