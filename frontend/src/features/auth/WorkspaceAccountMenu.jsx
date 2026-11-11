import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'

export default function WorkspaceAccountMenu({ user, accountPath, onSignOut }) {
  const [open, setOpen] = useState(false)
  const menu = useRef(null)
  const trigger = useRef(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const dismiss = (event) => {
      if (!menu.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  return (
    <div
      className="workspace-account-menu"
      ref={menu}
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }}
    >
      <button
        className="workspace-account-link"
        type="button"
        ref={trigger}
        aria-label="Account options"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((visible) => !visible)}
      >
        <span className="workspace-avatar" aria-hidden="true">
          {user.display_name.slice(0, 1).toUpperCase()}
        </span>
        <span>{user.display_name}</span>
      </button>
      <div className="workspace-account-options" id={panelId} hidden={!open}>
        <Link to={accountPath} onClick={() => setOpen(false)}>
          My account
        </Link>
        <button
          type="button"
          onClick={() => {
            if (onSignOut()) setOpen(false)
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
