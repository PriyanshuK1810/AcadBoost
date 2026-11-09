import request from 'supertest';
import { expect } from 'vitest';

export async function readVersion(app, id, headers = {}) {
  const result = await request(app).get(`/api/v1/roadmap-versions/${id}`).set(headers);
  expect(result.status).toBe(200);
  return result.body;
}
export async function submitRoadmap(app, id, headers = {}) {
  const version = await readVersion(app, id, headers);
  const result = await request(app).post(`/api/v1/roadmap-versions/${id}/submit`).set(headers).send({ revision: version.revision });
  expect(result.status).toBe(200);
  return result.body;
}
export async function publishRoadmap(app, id, headers = {}, path = `/api/v1/roadmap-versions/${id}/approve`) {
  const submitted = await submitRoadmap(app, id, headers);
  const result = await request(app).post(path).set(headers).send({ revision: submitted.revision, submission_id: submitted.pending_submission.id });
  expect(result.status).toBe(200);
  return result;
}
export async function archiveRoadmap(app, id, headers = {}, path = `/api/v1/roadmap-versions/${id}/archive`) {
  const version = await readVersion(app, id, headers);
  return request(app).post(path).set(headers).send({ revision: version.revision });
}
