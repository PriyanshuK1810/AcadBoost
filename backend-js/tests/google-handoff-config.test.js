import { expect, it } from 'vitest';
import { loadSettings } from '../src/core/config.js';

const base = { OUTPOST_DATABASE_URL: 'postgresql://localhost/test' };
const enabled = {
  ...base,
  OUTPOST_GOOGLE_HANDOFF_ENABLED: 'true',
  OUTPOST_PUBLIC_APP_ORIGIN: 'https://app.example.test:8443',
  OUTPOST_GOOGLE_REDIRECT_URI: 'https://app.example.test:8443/api/v1/auth/google/callback',
  OUTPOST_GOOGLE_CLIENT_ID: 'test-client',
  OUTPOST_GOOGLE_CLIENT_SECRET: 'test-secret',
  OUTPOST_AUTH_SIGNING_KEY: 'a'.repeat(32),
};

it('defaults Google handoff to disabled', () => {
  expect(loadSettings(base).googleHandoffEnabled).toBe(false);
});

it('enables Google handoff only on its exact HTTPS origin and callback', () => {
  expect(loadSettings(enabled)).toMatchObject({
    googleHandoffEnabled: true, publicAppOrigin: 'https://app.example.test:8443',
  });
});

it.each([
  { OUTPOST_PUBLIC_APP_ORIGIN: 'http://app.example.test:8443' },
  { OUTPOST_PUBLIC_APP_ORIGIN: 'https://user@app.example.test:8443' },
  { OUTPOST_PUBLIC_APP_ORIGIN: 'https://app.example.test:8443/auth' },
  { OUTPOST_PUBLIC_APP_ORIGIN: 'https://app.example.test:8443?' },
  { OUTPOST_PUBLIC_APP_ORIGIN: 'https://app.example.test:8443#' },
  { OUTPOST_GOOGLE_REDIRECT_URI: 'https://api.example.test:8443/api/v1/auth/google/callback' },
  { OUTPOST_GOOGLE_REDIRECT_URI: 'https://app.example.test/api/v1/auth/google/callback' },
  { OUTPOST_GOOGLE_REDIRECT_URI: 'https://app.example.test:8443/auth/google/callback' },
  { OUTPOST_GOOGLE_CLIENT_SECRET: undefined },
  { OUTPOST_AUTH_SIGNING_KEY: undefined },
])('rejects invalid enabled Google configuration %j', (override) => {
  expect(() => loadSettings({ ...enabled, ...override })).toThrow(/Google handoff/);
});
