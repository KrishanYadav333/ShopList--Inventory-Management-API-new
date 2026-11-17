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
            DEV_AUTH: 'true', COOKIE_SIGNING_KEY: 'test-only-signing-key-0123456789abcdef', SIGNIN_MODE: 'open', SUPER_ADMIN_GITHUB_ID: '999001', TEST_MIGRATIONS: migrations, BREVO_API_KEY: 'xkeysib-test', CF_ANALYTICS_TOKEN: 'cfut_test', CF_ACCOUNT_ID: 'acct_test', EMAIL_FROM: 'noreply@test.example',
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
