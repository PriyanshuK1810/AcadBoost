import { useEffect, useId, useRef } from 'react'

export default function SessionStatusDialog({ phase, onRetry, onSignIn }) {
  const dialog = useRef(null)
  const heading = useRef(null)
  const titleId = useId()
  const descriptionId = useId()
  const pending = phase === 'signing-out'
  const failed = phase === 'logout-failed'
  const title = pending
    ? 'Signing out…'
    : failed
      ? 'We couldn’t confirm sign-out'
      : 'Session expired'

  useEffect(() => {
    const element = dialog.current
    if (!element.open) {
      if (element.showModal) element.showModal()
      else element.setAttribute('open', '')
    }
    heading.current?.focus()
  }, [phase])

  return (
    <dialog
      ref={dialog}
      className="session-status-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => event.preventDefault()}
    >
      <span className="session-status-icon" aria-hidden="true">
        {pending ? '↻' : failed ? '!' : '◷'}
      </span>
      <h2 id={titleId} ref={heading} tabIndex={-1}>
        {title}
      </h2>
      <p id={descriptionId} role={failed ? 'alert' : 'status'}>
        {pending
          ? 'Ending your session securely. Please wait.'
          : failed
            ? 'We couldn’t verify that your session ended on the server. Try again. If you leave for sign-in, unsaved changes will be lost and the server outcome will still be unknown.'
            : 'Your session has ended. Sign in again to continue. Unsaved changes are lost.'}
      </p>
      {!pending && (
        <div className="session-status-actions">
          <button
            className={`workspace-button${failed ? ' workspace-button-outline' : ''}`}
            type="button"
            onClick={onSignIn}
          >
            Go to sign in
          </button>
          {failed && (
            <button
              className="workspace-button"
              type="button"
              onClick={onRetry}
            >
              Retry sign out
            </button>
          )}
        </div>
      )}
    </dialog>
  )
}
