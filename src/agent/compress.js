/**
 * Compressing a tool result before the model ever sees it.
 *
 * History already digests *old* results. This is the other half: a fresh one
 * still arrives whole, and most of a tool result is not information. `npm
 * install` prints a thousand lines to say it worked. A build prints its whole
 * pipeline to say it compiled. A test run prints every passing test to say
 * nothing broke.
 *
 * What the model needs from a command is almost always: did it work, and if
 * not, what went wrong. Everything else is noise it pays for twice — once on
 * arrival, and again on every subsequent call while it sits in the history.
 *
 * Two rules keep this from becoming lossy in the way that matters:
 *
 *   1. Failure is never compressed the way success is. When something breaks,
 *      the detail *is* the information, so a failing result keeps its errors
 *      in full and loses only the parts that were already succeeding.
 *   2. Compression is deterministic. No model call, no judgement — a
 *      summariser that costs a model call to save tokens has not saved
 *      anything, and one that guesses is worse than none.
 */

/** Below this, there is nothing worth compressing. */
const FLOOR = 600;

/** Lines that carry the reason something failed. */
const SIGNAL = /\b(error|err!|fail(ed|ure|ing)?|exception|traceback|panic|fatal|cannot|unable|not found|undefined|null is not|expected|received|assert|refus|denied|conflict|timeout|ENOENT|EACCES|SyntaxError|TypeError|ReferenceError)\b/i;

/** Lines that are pure ceremony. */
const NOISE = /^\s*(npm (WARN|notice)|added \d+ packages?|found \d+ vulnerabilit|audited \d+|up to date|\d+ packages? are looking|run `npm|Progress:|\[?=+>?\s*\]?\s*\d+%|Downloading|Fetching|Resolving|Building fresh packages|\s*$)/i;

/**
 * A package install, in the four numbers anybody reads.
 *
 * The output is a thousand lines of progress and a summary at the end; the
 * summary is the part that answers the question.
 */
function compressInstall(text) {
  const added = text.match(/added (\d+) packages?/i)?.[1];
  const removed = text.match(/removed (\d+) packages?/i)?.[1];
  const audited = text.match(/audited (\d+) packages?/i)?.[1];
  const vulnerabilities = text.match(/(\d+) vulnerabilit(?:y|ies)/i)?.[1];
  const funding = text.match(/(\d+) packages? are looking for funding/i)?.[1];

  if (!added && !removed && !audited) return null;

  return [
    added ? `${added} package(s) added` : null,
    removed ? `${removed} removed` : null,
    audited ? `${audited} audited` : null,
    vulnerabilities && vulnerabilities !== '0' ? `${vulnerabilities} vulnerability(ies) reported` : 'no vulnerabilities reported',
    funding ? null : null
  ].filter(Boolean).join(', ');
}

/**
 * Keep the lines that explain a failure, and a little of what surrounded them.
 *
 * A stack trace is only useful with the line above it, and an assertion only
 * with the line below.
 */
function keepFailures(text, { limit = 60, context = 1 } = {}) {
  const lines = text.split('\n');
  const wanted = new Set();

  lines.forEach((line, index) => {
    if (!SIGNAL.test(line)) return;
    for (let offset = -context; offset <= context; offset += 1) {
      const at = index + offset;
      if (at >= 0 && at < lines.length) wanted.add(at);
    }
  });

  if (!wanted.size) return null;

  const kept = [...wanted].sort((a, b) => a - b).slice(0, limit);
  const out = [];
  let previous = -1;

  for (const index of kept) {
    if (previous >= 0 && index > previous + 1) out.push(`  … ${index - previous - 1} line(s)`);
    out.push(lines[index]);
    previous = index;
  }
  return out.join('\n');
}

/** Strip progress bars, warnings and blank runs. */
function dropNoise(text) {
  const lines = text.split('\n').filter(line => !NOISE.test(line));
  return lines.join('\n');
}

/**
 * Compress one tool result.
 *
 * @param {string} name      the tool that produced it
 * @param {{ok?:boolean, output?:string, metadata?:object}} result
 * @param {{limit?:number}} [options]
 * @returns {{output:string, compressed:boolean, from:number, to:number}}
 */
export function compressResult(name, result, { limit = 6000 } = {}) {
  const text = String(result?.output ?? '');
  const from = text.length;
  const failed = result?.ok === false;

  if (from <= FLOOR) return { output: text, compressed: false, from, to: from };

  let body = text;

  // ── the tool decides what matters about its own output ──
  if (/^(install_dependency|dependency_audit)$/.test(name) && !failed) {
    const summary = compressInstall(text);
    if (summary) body = summary;
  } else if (failed) {
    // The detail is the information. Keep every line that explains the
    // failure and drop the ones that were merely working.
    body = keepFailures(dropNoise(text)) ?? dropNoise(text);
  } else if (/^(run_tests|run_build|run_linter|execute_command)$/.test(name)) {
    // It worked. The verdict and the tail are what a person would read.
    const cleaned = dropNoise(text);
    const lines = cleaned.split('\n').filter(Boolean);
    body = lines.length > 24
      ? `${lines.slice(0, 4).join('\n')}\n  … ${lines.length - 16} line(s)\n${lines.slice(-12).join('\n')}`
      : cleaned;
  } else {
    body = dropNoise(text);
  }

  body = body.trim();
  if (!body) body = failed ? '(failed with no output)' : '(no output)';

  // A hard ceiling regardless: head and tail, because the middle of anything
  // this long is never the part that mattered.
  if (body.length > limit) {
    const head = Math.floor(limit * 0.4);
    const tail = limit - head - 80;
    body = `${body.slice(0, head)}\n\n… ${(body.length - head - tail).toLocaleString()} characters omitted …\n\n${body.slice(-tail)}`;
  }

  const to = body.length;
  // Saying so matters: the model must know it is looking at a summary, or it
  // will reason about what is missing as though it were absent.
  const note = to < from
    ? `\n\n[summarised: ${from.toLocaleString()} → ${to.toLocaleString()} characters. Re-run with more specific arguments if you need the rest.]`
    : '';

  return { output: to < from ? body + note : text, compressed: to < from, from, to };
}

export { SIGNAL, NOISE, keepFailures, compressInstall, FLOOR };
