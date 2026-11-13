import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations/control');
  // A throwaway RSA keypair stands in for Clerk's signing key, so tests can mint valid and forged tokens.
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Test-only switches. DEV_AUTH is never set in the deployed config.
          bindings: {
            DEV_AUTH: 'true', SIGNIN_MODE: 'open', SUPER_ADMIN_GITHUB_ID: '999001', TEST_MIGRATIONS: migrations,
            CLERK_JWT_KEY: publicKey, CLERK_SECRET_KEY: 'sk_test_fake', CLERK_ISSUER: 'https://clerk.test', TEST_CLERK_PRIVATE_KEY: privateKey,
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
      testTimeout: 30_000,
    },
  };
});
