import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = resolve(appRoot, 'build');
const fallbackDocument = resolve(buildDirectory, '200.html');
const apacheConfig = resolve(appRoot, 'deploy/apache/.htaccess');
const output = resolve(process.argv[2] ?? 'queencheck-apache.zip');

if (!existsSync(fallbackDocument)) throw new Error('Run `npm run build` before packaging.');
if (!existsSync(apacheConfig)) throw new Error('Apache deployment configuration is missing.');
if (existsSync(output)) throw new Error(`Refusing to overwrite existing archive: ${output}`);

const staging = mkdtempSync(resolve(tmpdir(), 'queencheck-apache-'));
try {
  cpSync(buildDirectory, staging, { recursive: true });
  rmSync(resolve(staging, '_headers'), { force: true });
  copyFileSync(resolve(staging, '200.html'), resolve(staging, 'index.html'));
  copyFileSync(apacheConfig, resolve(staging, '.htaccess'));
  execFileSync('zip', ['-q', '-r', output, '.'], { cwd: staging, stdio: 'inherit' });
  console.log(output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
