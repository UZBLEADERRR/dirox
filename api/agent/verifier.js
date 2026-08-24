const RETRY_LIMIT = 2;

function numberOrNull(value) { return value === undefined || value === null || value === '' ? null : Number(value); }

/** Evidence, rather than prose alone, determines completion. */
export function verifyResult(result = {}, evidence = {}, options = {}) {
  const exitCode = numberOrNull(evidence.exitCode ?? result.exitCode);
  const output = String(evidence.tests ?? evidence.build ?? evidence.output ?? result.output ?? result.result ?? '').toLowerCase();
  const hasFailure = /(?:fail(?:ed|ure)?|error|exception|build failed|tests?\s+failed)/.test(output);
  const hasChecks = evidence.tests !== undefined || evidence.build !== undefined || evidence.output !== undefined || exitCode !== null;
  const hasPositiveOutput = /\b(pass(?:ed|es)?|success(?:ful)?|build succeeded|all tests|\bok\b)/.test(output);
  const passed = hasChecks && !hasFailure && exitCode !== 1 && exitCode !== 2 && (exitCode === 0 || hasPositiveOutput);
  const retries = Math.max(0, Number(options.retries) || 0);
  return { passed, retry: !passed && retries < RETRY_LIMIT, retries, retryLimit: RETRY_LIMIT, evidence: { exitCode, output: output.slice(0, 4000) }, reason: passed ? 'Evidence checks passed' : (hasFailure ? 'Tests or build reported a failure' : 'Missing successful evidence') };
}

export { RETRY_LIMIT };
export default verifyResult;
