import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import {
  learningRoles,
  useOrganizationScope,
} from '../hooks/useOrganizationScope'
import { listPlans, uploadPlan } from '../activityPlanApi'
import ActivityPlanSteps from '../components/ActivityPlanSteps'
import { PageHeading } from '../components/WorkspaceUI'

const reviewPath = (org, id) =>
  '/app/coordinator/activity-plans/' +
  encodeURIComponent(id) +
  '?' +
  new URLSearchParams({ organizationId: org })

function fileProblem(file, limits) {
  if (!file) return 'Choose a PDF to upload.'
  if (!file.size) return 'This PDF is empty. Choose a PDF with selectable text.'
  if (
    !/\.pdf$/i.test(file.name) ||
    (file.type &&
      !['application/pdf', 'application/octet-stream'].includes(file.type))
  ) {
    return 'Choose a PDF file.'
  }
  if (limits && file.size > limits.max_bytes) {
    return 'This PDF exceeds the upload limit. Choose a smaller file.'
  }
  return ''
}

function uploadMessage(error) {
  if (error.status === 401 || error.status === 403) {
    return 'You do not have permission to upload to this organization.'
  }
  if (error.code === 'pdf_invalid')
    return 'This file could not be read as a PDF. Choose a valid PDF.'
  if (error.status === 413)
    return 'This PDF exceeds the upload limit. Choose a smaller file.'
  if (error.status === 503)
    return 'Upload storage is temporarily unavailable. Your file and plan name are still selected.'
  if (error.status === 400 || error.status === 422)
    return 'The upload was rejected. Check the PDF and plan name and try again.'
  return 'The upload could not be confirmed. Check Uploaded activity plans before uploading again.'
}

export default function ActivityPlanUploadPage() {
  const scope = useOrganizationScope()
  const { organization, loading, error, requestedId } = scope
  const organizations = scope.organizations.filter((item) =>
    learningRoles.includes(item.role),
  )
  const org =
    scope.managed || requestedId !== null
      ? organization && learningRoles.includes(organization.role)
        ? organization.id
        : null
      : organizations[0]?.id
  const back =
    '/app/coordinator/roadmaps' +
    (org ? '?' + new URLSearchParams({ organizationId: org }) : '')
  return (
    <div className="activity-plan-flow">
      <PageHeading
        eyebrow="Coordinator / Roadmaps"
        title="Import from PDF"
        description="Upload a text-based activity plan, check the extracted outline, and create a roadmap draft."
      />
      <Link className="workspace-text-link" to={back}>
        ← All roadmaps
      </Link>
      <ActivityPlanSteps step={0} />
      <section className="workspace-card import-form">
        <h2>Upload a PDF</h2>
        <p>
          Choose a PDF with selectable text. Scanned pages need a text-based
          export before import.
        </p>
        {loading && <p role="status">Loading your organizations…</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && organizations.length === 0 && (
          <p>
            You need an active Owner, Admin, or Coordinator membership to import
            a plan. <Link to="/app/organizations">Manage organizations</Link>
          </p>
        )}
        {!loading &&
          !error &&
          !org &&
          (requestedId !== null || !!organization) && (
            <p className="form-error" role="alert">
              This organization is unavailable for PDF import. Choose an
              organization you can access.
            </p>
          )}
        {!scope.managed && !!organizations.length && (
          <label className="form-field">
            Organization
            <select
              value={org || ''}
              onChange={(event) => scope.selectOrganization(event.target.value)}
            >
              <option value="" disabled>
                Select an organization
              </option>
              {organizations.map((row) => (
                <option value={row.id} key={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {org && <UploadForm key={org} org={org} back={back} />}
      </section>
    </div>
  )
}

function UploadForm({ org, back }) {
  const navigate = useNavigate()
  const [limits, setLimits] = useState(null)
  const [limitsError, setLimitsError] = useState('')
  const [reload, setReload] = useState(0)
  const [name, setName] = useState('')
  const [file, setFile] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploaded, setUploaded] = useState(null)
  const [uncertain, setUncertain] = useState(false)
  const request = useRef(null)

  useEffect(() => {
    let active = true
    listPlans(org)
      .then((result) => {
        if (active) setLimits(result.limits)
      })
      .catch((cause) => {
        if (active)
          setLimitsError(
            [401, 403].includes(cause.status) ? 'denied' : 'unavailable',
          )
      })
    return () => {
      active = false
      request.current = null
    }
  }, [org, reload])

  async function submit(event) {
    event.preventDefault()
    if (!limits || request.current || uploaded || uncertain) return
    const problem = fileProblem(file, limits)
    if (problem || name.trim().length < 2 || name.trim().length > 200) {
      setError(problem || 'Enter a plan name with 2–200 characters.')
      return
    }

    const current = {}
    request.current = current
    setBusy(true)
    setError('')
    try {
      const plan = await uploadPlan(org, name.trim(), file)
      if (request.current !== current) return
      if (plan.organization_id !== org || !plan.id)
        throw new Error('Invalid upload response')
      const path = reviewPath(org, plan.id)
      setUploaded(path)
      try {
        await navigate(path)
      } catch {
        // Keep the confirmed plan link available if navigation cannot finish.
      }
    } catch (cause) {
      if (request.current !== current) return
      setError(uploadMessage(cause))
      if (!cause.status || (cause.status >= 500 && cause.status !== 503))
        setUncertain(true)
    } finally {
      if (request.current === current) {
        request.current = null
        setBusy(false)
      }
    }
  }

  return (
    <>
      {!limits && !limitsError && <p role="status">Loading PDF limits…</p>}
      {limitsError && (
        <>
          <p className="form-error" role="alert">
            {limitsError === 'denied'
              ? 'You do not have permission to import here.'
              : 'The PDF limits could not be loaded.'}
          </p>
          {limitsError !== 'denied' && (
            <button
              type="button"
              className="workspace-button workspace-button-outline"
              onClick={() => {
                setLimitsError('')
                setReload((value) => value + 1)
              }}
            >
              Retry loading limits
            </button>
          )}
        </>
      )}
      {limits && (
        <p id="activity-plan-limits">
          One PDF · up to {limits.max_bytes / 1048576} MiB · {limits.max_pages}{' '}
          pages · {limits.max_characters.toLocaleString()} extracted characters.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {uploaded ? (
        <Link className="workspace-button" to={uploaded}>
          Open uploaded plan
        </Link>
      ) : (
        <form onSubmit={submit} className="learning-form">
          <label className="form-field">
            Plan name
            <input
              required
              minLength={2}
              maxLength={200}
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="form-field">
            PDF file
            <input
              type="file"
              accept=".pdf,application/pdf"
              required
              disabled={busy}
              aria-describedby={limits ? 'activity-plan-limits' : undefined}
              onChange={(event) => {
                const selected = event.target.files[0] || null
                setFile(selected)
                setError(selected ? fileProblem(selected, limits) : '')
              }}
            />
          </label>
          {file && (
            <p className="activity-plan-filename">Selected: {file.name}</p>
          )}
          <div className="activity-plan-actions">
            <button
              className="workspace-button"
              disabled={busy || !limits || uncertain}
            >
              {busy ? 'Uploading…' : 'Upload activity plan'}
            </button>
            <Link
              className="workspace-button workspace-button-outline"
              to={back}
            >
              {busy || uncertain ? 'View uploaded plans' : 'Back to Roadmaps'}
            </Link>
          </div>
          {busy && <p role="status">Uploading your PDF…</p>}
        </form>
      )}
    </>
  )
}

export function UploadedPlans({ organizationId }) {
  return (
    <UploadedPlanList key={organizationId} organizationId={organizationId} />
  )
}
function UploadedPlanList({ organizationId }) {
  const [plans, setPlans] = useState([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!organizationId) return
    let active = true
    listPlans(organizationId)
      .then((r) => {
        if (active) {
          setPlans(r.plans)
          setError('')
        }
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [organizationId, retry])
  if (!organizationId) return null
  return (
    <section className="uploaded-plans" aria-label="Uploaded activity plans">
      <h2>Uploaded activity plans</h2>
      {loading && <p role="status">Loading uploaded plans…</p>}
      {error && (
        <div>
          <p className="form-error" role="alert">
            {error}
          </p>
          <button
            onClick={() => {
              setLoading(true)
              setError('')
              setRetry((n) => n + 1)
            }}
          >
            Try again
          </button>
        </div>
      )}
      {!loading && !plans.length && !error && <p>No uploaded plans yet.</p>}
      {plans.map((p) => (
        <article key={p.id} className="workspace-card roadmap-summary">
          <div>
            <p className="workspace-card-label">{p.status}</p>
            <h3>{p.name}</h3>
            <p>{p.filename}</p>
          </div>
          <Link
            className="workspace-text-link"
            to={`/app/coordinator/activity-plans/${p.id}?organizationId=${organizationId}`}
          >
            {p.status === 'converted'
              ? 'View import result'
              : 'Continue review'}{' '}
            →
          </Link>
        </article>
      ))}
    </section>
  )
}
