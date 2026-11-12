import { createClient } from 'redis';

export function createValkeyClient(url) {
  const client = createClient({
    url,
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  client.on('error', () => {});
  let connection;
  async function ready() {
    if (client.isOpen) return;
    connection ??= client.connect().finally(() => { connection = undefined; });
    await connection;
  }
  return {
    async ping() { await ready(); return client.ping(); },
    async set(key, value, options) { await ready(); return client.set(key, value, options); },
    async getDel(key) { await ready(); return client.getDel(key); },
    async eval(script, options) { await ready(); return client.eval(script, options); },
    async close() { if (client.isOpen) await client.close(); },
  };
}
