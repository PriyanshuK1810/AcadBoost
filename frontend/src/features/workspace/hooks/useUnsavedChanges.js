import { useContext, useEffect } from 'react'
import { useBlocker } from 'react-router'
import { WorkspaceContext } from './useWorkspace'
export default function useUnsavedChanges(dirty) {
  const registerUnsavedChanges =
    useContext(WorkspaceContext)?.registerUnsavedChanges
  useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search) &&
      !window.confirm('You have unsaved changes. Leave this page?'),
  )
  useEffect(() => {
    if (!dirty) return
    const unregister = registerUnsavedChanges?.()
    const unload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', unload)
    return () => {
      window.removeEventListener('beforeunload', unload)
      unregister?.()
    }
  }, [dirty, registerUnsavedChanges])
}
