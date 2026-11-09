import { afterEach, expect, it, vi } from 'vitest'
import {
  ApiRequestError,
  clearAccessToken,
  setAccessToken,
} from '../../shared/api/client'
import {
  approveRoadmapVersion,
  archiveRoadmapVersion,
  copyRoadmapVersion,
  listRoadmapReviews,
  listRoadmapVersions,
  publishRoadmapVersion,
  rejectRoadmapVersion,
  saveRoadmapDraft,
  submitRoadmapVersion,
} from './learningApi'

const organizationId = 'org/one'
const roadmapId = 'roadmap?one'
const versionId = 'version#one'
const versionIds = [organizationId, roadmapId, versionId]
const submissionId = 'cf04105f-b41d-4b9c-97d0-e8d7bf391cbe'
const versionsUrl =
  '/api/v1/organizations/org%2Fone/roadmaps/roadmap%3Fone/versions'
const versionUrl = `${versionsUrl}/version%23one`
const phases = [
  {
    title: 'SQL',
    weeks: [
      { title: 'Queries', topics: [{ title: 'Joins', description: '' }] },
    ],
  },
]
const pendingSubmission = {
  id: submissionId,
  version_id: versionId,
  submitted_revision: 14,
  decision: 'pending',
}

function respondWith(body, status = 200) {
  const fetch = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: async () => body,
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

function expectRequest(fetch, url, method, body) {
  expect(fetch).toHaveBeenCalledTimes(1)
  const [[requestUrl, options]] = fetch.mock.calls
  expect(requestUrl).toBe(url)
  expect(options.method ?? 'GET').toBe(method)
  expect(options.body).toBe(
    body === undefined ? undefined : JSON.stringify(body),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearAccessToken()
})

it('loads nested roadmap versions with their original lifecycle metadata', async () => {
  const versions = [
    { status: 'draft', revision: 3, pending_submission: null, phases },
    {
      status: 'in_review',
      revision: 14,
      pending_submission: pendingSubmission,
    },
    { status: 'published', revision: 8, pending_submission: null },
    { status: 'archived', revision: 5, pending_submission: null },
  ]
  const fetch = respondWith(versions)
  await expect(listRoadmapVersions(organizationId, roadmapId)).resolves.toBe(
    versions,
  )
  expectRequest(fetch, versionsUrl, 'GET')
})

it('submits the supplied revision using the shared authenticated transport', async () => {
  const submitted = {
    status: 'in_review',
    revision: 14,
    pending_submission: pendingSubmission,
    phases,
  }
  const fetch = respondWith(submitted)
  setAccessToken('session')
  await expect(submitRoadmapVersion(...versionIds, 13)).resolves.toBe(submitted)
  expectRequest(fetch, `${versionUrl}/submit`, 'POST', { revision: 13 })
  expect(fetch.mock.calls[0][1]).toMatchObject({
    credentials: 'include',
    headers: {
      Authorization: 'Bearer session',
      'Content-Type': 'application/json',
    },
  })
})

it.each([
  ['approve', approveRoadmapVersion],
  ['publish', publishRoadmapVersion],
])('sends the exact decision identity to /%s', async (action, decide) => {
  const published = {
    status: 'published',
    revision: 15,
    pending_submission: null,
  }
  const fetch = respondWith(published)
  await expect(decide(...versionIds, 14, submissionId)).resolves.toBe(published)
  expectRequest(fetch, `${versionUrl}/${action}`, 'POST', {
    revision: 14,
    submission_id: submissionId,
  })
})

it('forwards rejection text unchanged at the UTF-16 limit and returns the draft', async () => {
  const reason = '📝'.repeat(1000)
  const draft = { status: 'draft', revision: 15, pending_submission: null }
  const fetch = respondWith(draft)
  await expect(
    rejectRoadmapVersion(...versionIds, 14, submissionId, reason),
  ).resolves.toBe(draft)
  expectRequest(fetch, `${versionUrl}/reject`, 'POST', {
    revision: 14,
    submission_id: submissionId,
    reason,
  })
})

it('archives the version with its current revision', async () => {
  const archived = {
    status: 'archived',
    revision: 16,
    pending_submission: null,
  }
  const fetch = respondWith(archived)
  await expect(archiveRoadmapVersion(...versionIds, 15)).resolves.toBe(archived)
  expectRequest(fetch, `${versionUrl}/archive`, 'POST', { revision: 15 })
})

it('saves the original hierarchy and its revision with nested PUT', async () => {
  const draft = {
    status: 'draft',
    revision: 13,
    phases,
    pending_submission: null,
  }
  const fetch = respondWith(draft)
  await expect(saveRoadmapDraft(...versionIds, phases, 12)).resolves.toBe(draft)
  expectRequest(fetch, versionUrl, 'PUT', { revision: 12, phases })
})

it('copies using the source version identity and revision', async () => {
  const draft = {
    version_id: 'new-version',
    status: 'draft',
    revision: 1,
    pending_submission: null,
  }
  const fetch = respondWith(draft, 201)
  await expect(copyRoadmapVersion(...versionIds, 16)).resolves.toBe(draft)
  expectRequest(fetch, versionsUrl, 'POST', {
    revision: 16,
    source_version_id: versionId,
  })
})

it.each([
  [undefined, 20, 0, 20],
  [{ limit: 100, offset: 10000 }, 100, 10000, null],
])(
  'loads review history with pagination options %j',
  async (options, limit, offset, nextOffset) => {
    const history = {
      version_id: versionId,
      status: 'in_review',
      revision: 14,
      pending_submission: pendingSubmission,
      reviews: nextOffset === null ? [] : [pendingSubmission],
      pagination: { limit, offset, next_offset: nextOffset },
    }
    const fetch = respondWith(history)
    await expect(listRoadmapReviews(...versionIds, options)).resolves.toBe(
      history,
    )
    expectRequest(
      fetch,
      `${versionUrl}/reviews?limit=${limit}&offset=${offset}`,
      'GET',
    )
  },
)

it.each([
  [401, 'unauthorized'],
  [403, 'forbidden'],
  [404, 'not_found'],
  [409, 'conflict'],
  [422, 'validation_error'],
  [500, 'internal_error'],
])('preserves HTTP %i and the backend error envelope', async (status, code) => {
  const error = {
    code,
    message: 'Roadmap request failed',
    request_id: 'request-123',
    details: [{ loc: ['body', 'revision'], type: 'invalid_type' }],
  }
  const fetch = respondWith({ error }, status)
  const result = archiveRoadmapVersion(...versionIds, 15)
  await expect(result).rejects.toBeInstanceOf(ApiRequestError)
  await expect(result).rejects.toMatchObject({ status, ...error })
  expectRequest(fetch, `${versionUrl}/archive`, 'POST', { revision: 15 })
})

it.each([
  ['approve', approveRoadmapVersion, []],
  ['reject', rejectRoadmapVersion, ['Add transaction exercises.']],
])('does not replay a stale /%s decision', async (action, decide, extra) => {
  const fetch = respondWith(
    { error: { code: 'conflict', message: 'Stale roadmap review' } },
    409,
  )
  await expect(
    decide(...versionIds, 14, submissionId, ...extra),
  ).rejects.toMatchObject({
    status: 409,
    message: 'Stale roadmap review',
  })
  const body = { revision: 14, submission_id: submissionId }
  if (extra.length) body.reason = extra[0]
  expectRequest(fetch, `${versionUrl}/${action}`, 'POST', body)
})

it('returns a draft conflict without replaying the save', async () => {
  const fetch = respondWith({ error: { code: 'conflict' } }, 409)
  await expect(
    saveRoadmapDraft(...versionIds, phases, 12),
  ).rejects.toMatchObject({
    status: 409,
    code: 'conflict',
  })
  expectRequest(fetch, versionUrl, 'PUT', { revision: 12, phases })
})

it('lets the server validate rejection length without truncating the reason', async () => {
  const reason = `${'📝'.repeat(1000)}a`
  const fetch = respondWith({ error: { code: 'validation_error' } }, 422)
  await expect(
    rejectRoadmapVersion(...versionIds, 14, submissionId, reason),
  ).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  expectRequest(fetch, `${versionUrl}/reject`, 'POST', {
    revision: 14,
    submission_id: submissionId,
    reason,
  })
})

it('fails before sending legacy revision-free mutations or incomplete decisions', () => {
  const fetch = respondWith({})
  expect(() => saveRoadmapDraft(...versionIds, phases)).toThrow('revision')
  expect(() => copyRoadmapVersion(...versionIds)).toThrow('revision')
  expect(() => archiveRoadmapVersion(...versionIds)).toThrow('revision')
  expect(() => publishRoadmapVersion(...versionIds)).toThrow('revision')
  expect(() => publishRoadmapVersion(...versionIds, 14)).toThrow(
    'submission ID',
  )
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects a path segment the browser would normalize as traversal', () => {
  const fetch = respondWith({})
  expect(() =>
    submitRoadmapVersion(organizationId, roadmapId, '..', 14),
  ).toThrow('Invalid roadmap path ID')
  expect(fetch).not.toHaveBeenCalled()
})
