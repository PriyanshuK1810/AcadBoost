import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const requestId = '00000000-0000-4000-8000-000000000001';

// Use the app's real console and request completion logger in a child process.
const probe = `
  import request from 'supertest';
  import { gzipSync } from 'node:zlib';
  import { createApp } from './src/app.js';

  const [scenario, marker, requestId] = process.argv.slice(1);
  let reads = 0;
  let sessions = 0;
  const prisma = {
    user: { findFirst: async () => {
      reads += 1;
      // Even a similarly tagged error from application code is an internal failure.
      throw Object.assign(new SyntaxError(marker + '-message'), {
        status: 400, type: 'entity.parse.failed', body: marker + '-error-body',
      });
    } },
    authSession: { create: async () => { sessions += 1; } },
  };
  const api = request(createApp({ prisma, settings: { env: 'development' } }));
  const review = scenario === 'review';
  const path = scenario === 'unmatched' ? '/api/v1/' + marker : review
    ? '/api/v1/organizations/00000000-0000-4000-8000-000000000001/activity-plans/00000000-0000-4000-8000-000000000002'
    : '/api/v1/auth/password/login';
  const body = scenario === 'internal'
    ? JSON.stringify({ identifier: 'synthetic@example.test', password: marker + '-password' })
    : '{"password":"' + marker + '-password","reset_token":"' + marker + '-token",';
  const pending = api[review ? 'patch' : 'post'](path + '?secret=' + marker + '-query')
    .set('Content-Type', scenario === 'charset' ? 'application/json; charset=' + marker : 'application/json')
    .set('X-Request-ID', requestId)
    .set('Authorization', 'Bearer ' + marker + '-authorization')
    .set('Cookie', 'outpost_refresh=' + marker + '-cookie');
  if (review) pending.set('Content-Encoding', 'gzip').write(gzipSync(body));
  else pending.send(body);
  const response = await pending;
  console.log(JSON.stringify({ probe: true, status: response.status, body: response.body,
    requestId: response.headers['x-request-id'], responseLeaked: response.text.includes(marker),
    reads, sessions }));
`;

it.each([
  ['login', 400, 'invalid_json', 'Malformed JSON request body.', 0],
  ['review', 400, 'invalid_json', 'Malformed JSON request body.', 0],
  ['unmatched', 400, 'invalid_json', 'Malformed JSON request body.', 0],
  ['charset', 500, 'internal_error', 'Internal server error', 0],
  ['internal', 500, 'internal_error', 'Internal server error', 1],
])('logs safe diagnostics for %s errors', async (scenario, status, code, message, reads) => {
  const marker = 'T11-synthetic-' + randomUUID();
  const { stdout, stderr } = await run(process.execPath, [
    '--input-type=module', '--eval', probe, scenario, marker, requestId,
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'development', DEBUG: '' },
    timeout: 15000,
  }).catch((error) => { throw new Error(`Request probe failed (${error.code ?? 'unknown'})`); });
  const { probe: isProbe, ...result } = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  expect(isProbe).toBe(true);
  expect.soft(result.status).toBe(status);
  expect(result.responseLeaked || [stdout, stderr].some((stream) =>
    stream.toLowerCase().includes(marker.toLowerCase()))).toBe(false);
  expect(result).toEqual({ status, body: { error: { code, message, request_id: requestId } },
    requestId, responseLeaked: false, reads, sessions: 0 });
  expect(stdout).toContain('request.completed');
  expect(stderr).toContain('request.failed');
  expect(stderr).toContain(requestId);
  expect(stderr).toContain(code);
}, 20000);
