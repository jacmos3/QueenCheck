import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apacheConfig = readFileSync(resolve(appRoot, 'deploy/apache/.htaccess'), 'utf8');

test('Apache redirects every plain HTTP request without trusting forwarded headers', () => {
  assert.doesNotMatch(apacheConfig, /X-Forwarded-Proto/i);
  assert.match(
    apacheConfig,
    /RewriteCond %\{HTTPS\} !=on\s+RewriteRule \^ https:\/\/queencheck\.semproxlab\.it%\{REQUEST_URI\} \[R=301,L,NE\]/
  );
  assert.ok(
    apacheConfig.indexOf('RewriteCond %{HTTPS} !=on') < apacheConfig.indexOf('RewriteRule ^ 200.html [L]'),
    'the HTTPS redirect must run before the SPA fallback'
  );
});
