const labels = ['Upload', 'Extract & Review', 'Create Draft']

export default function ActivityPlanSteps({ step }) {
  return (
    <ol className="activity-plan-steps" aria-label="PDF import progress">
      {labels.map((label, index) => (
        <li
          key={label}
          aria-current={index === step ? 'step' : undefined}
          className={index <= step ? 'is-reached' : undefined}
        >
          <span aria-hidden="true">{index + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  )
}
