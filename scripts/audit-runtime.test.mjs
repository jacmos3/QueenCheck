import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAuditResult, parseAuditReport, runRuntimeAudit } from './audit-runtime.mjs';

const report = (vulnerabilities) => JSON.stringify({ metadata: { vulnerabilities } });

test('parses an npm audit JSON object', () => {
  assert.equal(parseAuditReport(report({ high: 0, critical: 0 })).metadata.vulnerabilities.high, 0);
});

test('passes valid reports without high or critical advisories', () => {
  assert.deepEqual(
    classifyAuditResult({ status: 1, stdout: report({ low: 2, moderate: 1, high: 0, critical: 0 }) }),
    { kind: 'clean', high: 0, critical: 0 }
  );
});

test('fails valid reports containing high or critical advisories', () => {
  assert.deepEqual(
    classifyAuditResult({ status: 1, stdout: report({ high: 2, critical: 1 }) }),
    { kind: 'vulnerable', high: 2, critical: 1 }
  );
});

test('recognizes bounded timeouts and known registry failures as transient', () => {
  assert.equal(classifyAuditResult({ status: null, timedOut: true }).kind, 'transient');
  assert.equal(classifyAuditResult({ status: 1, stdout: '{', stderr: 'npm error code E503' }).kind, 'transient');
  assert.equal(classifyAuditResult({ status: 1, stdout: JSON.stringify({ error: { code: 'ENOTFOUND' } }) }).kind, 'transient');
  assert.equal(classifyAuditResult({
    status: 1,
    stdout: JSON.stringify({ message: 'network timeout at: https://registry.npmjs.org/-/npm/v1/security/audits/quick', error: { summary: '', detail: '' } })
  }).kind, 'transient');
});

test('fails malformed output and unknown npm errors', () => {
  assert.equal(classifyAuditResult({ status: 1, stdout: '{', stderr: 'unexpected failure' }).kind, 'failure');
  assert.equal(classifyAuditResult({ status: 1, stdout: JSON.stringify({ error: { code: 'EUSAGE' } }) }).kind, 'failure');
});

test('fails closed after three recognized transient failures', async () => {
  let attempts = 0;
  const result = await runRuntimeAudit(
    '.',
    () => {
      attempts += 1;
      return { kind: 'transient', message: 'registry unavailable' };
    },
    async () => {},
  );
  assert.equal(result, 1);
  assert.equal(attempts, 3);
});
