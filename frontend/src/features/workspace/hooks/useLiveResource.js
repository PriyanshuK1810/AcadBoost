import { useCallback, useEffect, useState } from 'react'

// The caller supplies a stable loader. Ignore stale reads after navigation/retry.
export function useLiveResource(loader) {
  const [resource, setResource] = useState({
    data: null,
    loading: true,
    error: '',
  })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    Promise.resolve()
      .then(() => {
        if (!active) return undefined
        setResource({ data: null, loading: true, error: '' })
        return loader()
      })
      .then(
        (data) => {
          if (active)
            setResource({ data, loading: false, error: '', loader, revision })
        },
        (cause) => {
          if (active)
            setResource({
              data: null,
              loading: false,
              error:
                cause instanceof Error
                  ? cause.message
                  : 'Unable to load your data.',
              errorStatus: cause?.status,
              loader,
              revision,
            })
        },
      )
    return () => {
      active = false
    }
  }, [loader, revision])
  const retry = useCallback(() => setRevision((value) => value + 1), [])
  return resource.loader === loader && resource.revision === revision
    ? { ...resource, retry }
    : { data: null, loading: true, error: '', retry }
}
