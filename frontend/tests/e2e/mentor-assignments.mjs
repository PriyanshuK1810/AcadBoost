import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer as createVite } from 'vite';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '../../..');
const backend = join(root, 'backend-js');
const requireBackend = createRequire(join(backend, 'package.json'));
const load = (file) => import(pathToFileURL(join(backend, file)).href);
const target = new URL((process.env.M02_TEST_DATABASE_URL ?? '').replace(/^postgresql\+psycopg:\/\//, 'postgresql://'));
assert(['postgres:', 'postgresql:'].includes(target.protocol));
assert.equal(target.hostname, '127.0.0.1');
assert.equal(target.port, '5433');
assert.match(target.pathname, /^\/outpost_m02_[a-z0-9_]+$/);
const { createPrismaClient } = await load('src/db/client.js');
const { createApp } = await load('src/app.js');
const { issueSession, registerUser } = await load('src/modules/auth/service.js');
const supertest = requireBackend('supertest');
const prisma = createPrismaClient(target.href);
const settings = { env: 'test', authSigningKey: randomUUID() + randomUUID() };
const api = createApp({ prisma, settings });
const password = randomUUID() + '!Aa1';
const id = randomUUID().replaceAll('-', '');
let server, vite, browser, certificateDirectory;

async function account(name) {
  const username = name.toLowerCase() + '_' + id;
  const user = await registerUser(prisma, {
    display_name: name, username, email: username + '@example.test', password, account_type: 'coordinator',
  });
  return { user, username };
}

async function signIn(page, origin, actor, path) {
  await page.goto(origin + '/login');
  await page.getByLabel('Email or username').fill(actor.username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  const login = page.waitForResponse((response) => response.url().endsWith('/auth/password/login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  assert.equal((await login).status(), 200);
  await page.waitForURL('**/app/**');
  await page.goto(origin + path);
}

try {
  const [identity] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert.equal(identity.name, target.pathname.slice(1));
  const [owner, mentor] = await Promise.all([account('Owner'), account('Mentor')]);
  const organization = await prisma.organization.create({ data: { name: 'Browser campus', slug: 'm02-' + id } });
  const other = await prisma.organization.create({ data: { name: 'Other campus', slug: 'm02-other-' + id } });
  await prisma.organizationMembership.createMany({ data: [
    { organizationId: organization.id, userId: owner.user.id, role: 'owner' },
    { organizationId: organization.id, userId: mentor.user.id, role: 'mentor' },
    { organizationId: other.id, userId: mentor.user.id, role: 'coordinator' },
  ] });
  const { access } = await issueSession(prisma, settings, owner.user, 'fixture', { get: () => undefined });
  const post = (path, body) => supertest(api).post('/api/v1' + path).set('Authorization', 'Bearer ' + access).send(body);
  const orgPath = '/organizations/' + organization.id;
  const roadmap = await post(orgPath + '/roadmaps', {
    name: 'Browser curriculum', topics: [{ title: 'Pinned browser topic' }],
  }).expect(201);
  const versionPath = '/roadmap-versions/' + roadmap.body.version_id;
  const submission = await post(versionPath + '/submit', { revision: roadmap.body.revision }).expect(200);
  await post(versionPath + '/approve', { revision: submission.body.revision, submission_id: submission.body.pending_submission.id }).expect(200);
  const createCohort = (name) => post(orgPath + '/cohorts', { name, roadmap_version_id: roadmap.body.version_id }).expect(201);
  const cohort = (await createCohort('Assigned browser cohort')).body;
  const unassigned = (await createCohort('Unassigned browser cohort')).body;
  const week = roadmap.body.phases[0].weeks[0];
  await supertest(api).put(`/api/v1/cohorts/${cohort.id}/weeks/${week.id}/deadline`)
    .set('Authorization', 'Bearer ' + access).send({ due_at: '2027-02-01T12:00:00Z', time_zone: 'UTC' }).expect(200);

  certificateDirectory = await mkdtemp(join(tmpdir(), 'outpost-m02-cert-'));
  const key = join(certificateDirectory, 'key.pem');
  const cert = join(certificateDirectory, 'cert.pem');
  execFileSync(process.env.M02_OPENSSL ?? 'openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  vite = await createVite({ root: join(root, 'frontend'), server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    if (req.url.startsWith('/api/')) api(req, res);
    else vite.middlewares(req, res);
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const origin = 'https://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: process.env.M02_BROWSER });
  const ownerPage = await browser.newPage({ ignoreHTTPSErrors: true });
  const mentorPage = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const mentorPath = '/app/coordinator?organizationId=' + organization.id;
  await signIn(mentorPage, origin, mentor, mentorPath);
  await mentorPage.getByText('No cohorts are assigned to you.').waitFor();
  await signIn(ownerPage, origin, owner, '/app' + orgPath + '?organizationId=' + organization.id);
  const panel = ownerPage.getByRole('region', { name: 'Mentor assignments' });
  await panel.getByLabel('Mentor', { exact: true }).selectOption({ label: 'Mentor' });
  await panel.getByLabel('Cohort', { exact: true }).selectOption({ label: cohort.name });
  await panel.getByRole('button', { name: 'Assign mentor' }).click();
  const revoke = panel.getByRole('button', { name: `Remove Mentor from ${cohort.name}` });
  await revoke.waitFor();
  await mentorPage.reload();
  const assigned = mentorPage.getByRole('button', { name: cohort.name, exact: true });
  await assigned.click();
  await mentorPage.getByText('Pinned browser topic', { exact: true }).waitFor();
  await mentorPage.getByText(/Progress is available when at least 5 eligible students/).waitFor();
  await mentorPage.getByText('Deadline:', { exact: false }).waitFor();
  assert.equal(await mentorPage.getByRole('button', { name: unassigned.name, exact: true }).count(), 0);

  await mentorPage.getByLabel('Organization', { exact: true }).selectOption(other.id);
  await mentorPage.getByText('Pinned browser topic', { exact: true }).waitFor({ state: 'detached' });
  await mentorPage.getByLabel('Organization', { exact: true }).selectOption(organization.id);
  await assigned.click();
  await mentorPage.getByText('Pinned browser topic', { exact: true }).waitFor();
  await revoke.click();
  await revoke.waitFor({ state: 'detached' });
  await assigned.focus();
  await assigned.press('Enter');
  await mentorPage.getByRole('alert').filter({ hasText: 'assignment has been revoked' }).waitFor();
  assert.equal(await mentorPage.getByText('Pinned browser topic', { exact: true }).count(), 0);
  await mentorPage.reload();
  await mentorPage.getByText('No cohorts are assigned to you.').waitFor();
  console.log('M02 browser acceptance passed: Owner assign and revoke, Mentor empty state, pin, privacy, deadline, and organization/role switch.');
} finally {
  await browser?.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((ready) => server.close(ready));
  }
  await vite?.close();
  await prisma.$disconnect();
  if (certificateDirectory) {
    await rm(join(certificateDirectory, 'key.pem'), { force: true });
    await rm(join(certificateDirectory, 'cert.pem'), { force: true });
    await rmdir(certificateDirectory);
  }
}
