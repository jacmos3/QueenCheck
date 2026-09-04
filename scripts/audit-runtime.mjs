import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const AUDIT_ARGS = [
  'audit', '--package-lock-only', '--omit=dev', '--json',
  '--fetch-timeout=15000', '--fetch-retries=0'
];
const ATTEMPTS = 3;
const PROCESS_TIMEOUT_MS = 45_000;
const TRANSIENT_PATTERN = /\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETDOWN|ENETUNREACH|ENOTFOUND|ESOCKETTIMEDOUT|ETIMEDOUT|E429|E500|E502|E503|E504)\b|\b(?:network timeout|fetch failed|socket hang up|429 Too Many Requests|500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout)\b/i;

const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

export function parseAuditReport(output) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('npm audit returned no JSON');
  let value;
  try { value = JSON.parse(output); }
  catch { throw new Error('npm audit returned malformed JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('npm audit returned an invalid JSON value');
  return value;
}

export function classifyAuditResult({ status, stdout = '', stderr = '', timedOut = false }) {
  const combined = `${stdout}\n${stderr}`;
  let parsed;
  try { parsed = parseAuditReport(stdout); }
  catch (cause) {
    if ((timedOut || TRANSIENT_PATTERN.test(combined)) && status !== 0) {
      return { kind: 'transient', message: timedOut ? 'npm audit process timed out' : 'npm registry or network failure' };
    }
    return { kind: 'failure', message: cause.message };
  }

  const counts = parsed?.metadata?.vulnerabilities;
  if (counts && nonNegativeInteger(counts.high) && nonNegativeInteger(counts.critical)) {
    const high = counts.high;
    const critical = counts.critical;
    if (high + critical > 0) return { kind: 'vulnerable', high, critical };
    if (status === 0 || status === 1) return { kind: 'clean', high, critical };
    return { kind: 'failure', message: `npm audit exited with unexpected status ${status}` };
  }

  const errorText = JSON.stringify(parsed);
  if (status !== 0 && TRANSIENT_PATTERN.test(`${errorText}\n${stderr}`)) {
    return { kind: 'transient', message: 'npm registry or network failure' };
  }
  return { kind: 'failure', message: 'npm audit JSON did not contain vulnerability totals' };
}

export function runAuditAttempt(cwd = process.cwd()) {
  const result = spawnSync('npm', AUDIT_ARGS, {
    cwd,
    encoding: 'utf8',
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (result.error && !timedOut) {
    return { kind: 'failure', message: `npm audit could not start: ${result.error.message}` };
  }
  return classifyAuditResult({
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut
  });
}

const annotationText = (value) => String(value).replace(/[\r\n]+/g, ' ').slice(0, 500);

export async function runRuntimeAudit(
  cwd = process.cwd(),
  attemptRunner = runAuditAttempt,
  pause = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const result = await attemptRunner(cwd);
    if (result.kind === 'clean') {
      console.log('Runtime dependency audit passed: no high or critical vulnerabilities.');
      return 0;
    }
    if (result.kind === 'vulnerable') {
      console.error(`Runtime dependency audit failed: ${result.high} high and ${result.critical} critical vulnerabilities.`);
      return 1;
    }
    if (result.kind === 'failure') {
      console.error(`Runtime dependency audit failed: ${result.message}.`);
      return 1;
    }
    if (attempt < ATTEMPTS) {
      console.warn(`Runtime dependency audit transient failure (${attempt}/${ATTEMPTS}); retrying.`);
      await pause(attempt * 1_000);
    } else {
      console.log(`::warning title=Dependency audit unavailable::${annotationText(`npm audit failed after ${ATTEMPTS} attempts due to a recognized transient registry/network error. Run the workflow again later.`)}`);
      console.error('Runtime dependency audit failed closed because no advisory result was available.');
      return 1;
    }
  }
  return 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await runRuntimeAudit();
