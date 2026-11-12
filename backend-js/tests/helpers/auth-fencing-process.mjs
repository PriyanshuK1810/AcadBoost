import { createApp } from '../../src/app.js';
import { createValkeyClient } from '../../src/core/valkey.js';
import { createPrismaClient } from '../../src/db/client.js';

const database = new URL(process.env.M01B_R1_DATABASE_URL);
const cache = new URL(process.env.M01B_R1_VALKEY_URL);
if (database.hostname !== '127.0.0.1' || database.port !== '5433' ||
    !/^\/outpost_m01b_r1_[a-z0-9_]+$/.test(database.pathname) ||
    cache.hostname !== '127.0.0.1' || Number(cache.port) <= 1024 || cache.port === '6379') {
  throw new Error('Disposable loopback services required');
}
const prisma = createPrismaClient(database.href);
const redisClient = createValkeyClient(cache.href);
const settings = {
  env: 'test',
  googleHandoffEnabled: true,
  publicAppOrigin: process.env.M01B_R1_PROCESS_ORIGIN,
  authSigningKey: process.env.M01B_R1_PROCESS_SIGNING_KEY,
};
const server = createApp({ prisma, redisClient, settings }).listen(0, '127.0.0.1', () => {
  process.send({ port: server.address().port });
});
