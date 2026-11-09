const presentations = {
  draft: { label: 'Draft', icon: 'document' },
  in_review: { label: 'In review', icon: 'clock' },
  published: { label: 'Published', icon: 'check' },
  archived: { label: 'Archived', icon: 'archive' },
}

function StatusIcon({ name }) {
  const shared = {
    'aria-hidden': true,
    focusable: 'false',
    viewBox: '0 0 16 16',
    fill: 'none',
  }

  if (name === 'document') {
    return (
      <svg {...shared}>
        <path d="M4 1.75h5l3 3v9.5H4z" />
        <path d="M9 1.75v3h3M6.25 8h3.5M6.25 10.5h3.5" />
      </svg>
    )
  }

  if (name === 'clock') {
    return (
      <svg {...shared}>
        <circle cx="8" cy="8" r="5.75" />
        <path d="M8 4.5v3.75l2.5 1.5" />
      </svg>
    )
  }

  if (name === 'check') {
    return (
      <svg {...shared}>
        <circle cx="8" cy="8" r="5.75" />
        <path d="m5.5 8 1.75 1.75 3.5-3.5" />
      </svg>
    )
  }

  return (
    <svg {...shared}>
      <path d="M3 5h10v8H3zM2 2.5h12M6 2.5V5m4-2.5V5" />
    </svg>
  )
}

export default function RoadmapStatusBadge({ status }) {
  const presentation = presentations[status] || {
    label: 'Unknown status',
    icon: null,
  }

  return (
    <span
      className={`roadmap-status-badge roadmap-status-badge--${presentations[status] ? status : 'unknown'}`}
    >
      {presentation.icon && <StatusIcon name={presentation.icon} />}
      {presentation.label}
    </span>
  )
}
