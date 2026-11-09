// Run from backend-js: node scripts/verify-roadmap-review.mjs [--full]
// Creates NEW disposable resources; never migrates the configured source DB.
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';
import { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { loadSettings } from '../src/core/config.js';

const settings = loadSettings();
const suffix = randomBytes(6).toString('hex');
const database = `outpost_t04c_${suffix}`, bucket = `outpost-t04c-${suffix}`;
const evidenceDir = resolve(process.env.T04C_OUTPUT_DIR || '../docs/verification/t04c');
await fs.mkdir(evidenceDir, { recursive: true });
const url = new URL(settings.databaseUrl); url.pathname = `/${database}`;
const env = { ...process.env, OUTPOST_DATABASE_URL: url.href, T04C_DATABASE_URL: url.href, T04D_DATABASE_URL: url.href,
  T04D_EVIDENCE_DIR: evidenceDir,
  T04C_EVIDENCE_PATH: resolve(evidenceDir, 'database-evidence.json'),
  OUTPOST_OBJECT_BUCKET: bucket, OUTPOST_ENV: 'test', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: 'true' };
const results = [];
const runKind = process.argv.includes('--full') ? 'full' : 'database';
const redact = text => text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]');
async function run(name, args, cwd = process.cwd()) {
  const started = Date.now();
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    child.once('error', reject); child.once('close', exit => resolveRun({ exit, output }));
  });
  await fs.writeFile(resolve(evidenceDir, `${name}.log`), redact(result.output));
  const entry = { name, command: `node ${args.join(' ')}`, cwd, exit: result.exit, elapsedMs: Date.now() - started };
  results.push(entry); console.log(`${name}: exit ${result.exit}`);
  await fs.writeFile(resolve(evidenceDir, `commands-${runKind}.json`), JSON.stringify(results, null, 2));
  return result.exit;
}
const admin = new pg.Client({ connectionString: settings.databaseUrl, connectionTimeoutMillis: 5000 });
let created = false, bucketCreated = false, s3;
const resources = { database, bucket: null, purpose: 'New disposable T04-C verification resources', createdAt: new Date().toISOString() };
try {
  await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`); created = true;
  if (process.argv.includes('--full') && settings.objectStorage) {
    const storage = settings.objectStorage;
    s3 = new S3Client({ endpoint: storage.endpoint, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey } });
    await s3.send(new CreateBucketCommand({ Bucket: bucket })); bucketCreated = true; resources.bucket = bucket;
    env.OUTPOST_OBJECT_ACCESS_KEY = storage.accessKey; env.OUTPOST_OBJECT_SECRET_KEY = storage.secretKey;
    env.OUTPOST_OBJECT_ENDPOINT = storage.endpoint;
  }
  await fs.writeFile(resolve(evidenceDir, `resources-${runKind}.json`), JSON.stringify(resources, null, 2));
  if (await run('fresh-migrate', ['node_modules/prisma/build/index.js', 'migrate', 'deploy'])) throw new Error('Fresh migration failed');
  await run('prisma-validate', ['node_modules/prisma/build/index.js', 'validate']);
  await run('prisma-generate', ['node_modules/prisma/build/index.js', 'generate']);
  await run('migration-status', ['node_modules/prisma/build/index.js', 'migrate', 'status']);
  await run('schema-drift', ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code']);
  await run('new-tests', ['node_modules/vitest/vitest.mjs', 'run', 'tests/db/roadmap-review.test.js', '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${resolve(evidenceDir, 'new-tests.json')}`]);
  if (process.argv.includes('--full')) {
    await run('backend-full', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', '--exclude', 'tests/db/roadmap-review.test.js', '--reporter=default', '--reporter=json', `--outputFile.json=${resolve(evidenceDir, 'backend-full.json')}`]);
    await run('frontend-tests', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1', '--reporter=default', '--reporter=json', `--outputFile.json=${resolve(evidenceDir, 'frontend-tests.json')}`], resolve('../frontend'));
    await run('frontend-lint', ['node_modules/eslint/bin/eslint.js', '.'], resolve('../frontend'));
    await run('frontend-build', ['node_modules/vite/bin/vite.js', 'build'], resolve('../frontend'));
  }
} finally {
  // Cleanup touches only the exact database/bucket created by this invocation.
  if (bucketCreated) {
    let listed;
    do {
      listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      if (listed.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: listed.Contents.map(({ Key }) => ({ Key })) } }));
    } while (listed.IsTruncated);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket })); resources.bucketDeleted = true; s3.destroy();
  }
  if (created) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
    await admin.query(`DROP DATABASE "${database}"`); resources.databaseDeleted = true;
  }
  await admin.end();
  resources.finishedAt = new Date().toISOString();
  await fs.writeFile(resolve(evidenceDir, `resources-${runKind}.json`), JSON.stringify(resources, null, 2));
}
if (results.some(r => r.exit !== 0)) process.exitCode = 1;
