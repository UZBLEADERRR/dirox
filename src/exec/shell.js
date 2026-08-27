/**
 * Parsing a command line well enough to judge it.
 *
 * The sandbox used to refuse every shell metacharacter, which is safe and
 * also useless: `tsc && vite build` is what a build script looks like, and
 * `npm test 2>&1 | tail -40` is how anyone reads a failing one. Refusing
 * composition does not make the agent safer, it makes it unable to work and
 * pushes the same commands into `package.json` where nothing inspects them.
 *
 * So the line is parsed instead. Composition is allowed; *substitution* is
 * not. That distinction is the whole design:
 *
 *   allowed      && || ; | > >> < 2>&1  and globs and $VAR
 *   refused      $(…) `…` <(…) >(…) and a trailing &
 *
 * With substitution gone, every executable that will run is visible in the
 * text — so each one can be checked against the allowlist before anything
 * starts, and the check cannot be defeated by a command that computes its own
 * name at runtime. A background `&` is refused for a different reason: it
 * would outlive the run that is accountable for it.
 */

/** Operators that separate one command from the next. */
const CONTROL = new Set(['&&', '||', ';', '|']);

/** Operators that redirect a stream to a file rather than start a command. */
const REDIRECT = new Set(['>', '>>', '<', '2>', '2>>', '&>', '1>', '1>>']);

/** `2>&1` and friends join one stream to another; there is no file involved. */
const STREAM_JOIN = /^\d?>&\d$/;

/** Writable device targets that are not really files. */
const DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/**
 * Substitution, in every spelling. Each one turns text into a new command at
 * runtime, which is exactly what makes a static check meaningless.
 */
const SUBSTITUTION = [
  { pattern: /\$\(/, why: 'command substitution' },
  { pattern: /`/, why: 'backtick substitution' },
  { pattern: /<\(/, why: 'process substitution' },
  { pattern: />\(/, why: 'process substitution' },
  { pattern: /[\n\r]/, why: 'a newline' }
];

/**
 * Split a command line into tokens, keeping operators as their own tokens and
 * remembering whether each word was quoted.
 *
 * Quoting matters twice over: a quoted `&&` is an argument, not an operator,
 * and a quoted `*` is a literal rather than a glob.
 *
 * @returns {{tokens: Array<{value:string, quoted:boolean, operator:boolean}>}|{error:string}}
 */
export function lex(command) {
  const text = String(command ?? '');
  const tokens = [];

  let current = '';
  let quoted = false;
  let started = false;
  let quote = null;

  const push = () => {
    if (!started) return;
    tokens.push({ value: current, quoted, operator: false });
    current = '';
    quoted = false;
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quote) {
      if (char === '\\' && quote === '"' && index + 1 < text.length) {
        current += text[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) { quote = null; continue; }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") { quote = char; quoted = true; started = true; continue; }

    if (char === '\\' && index + 1 < text.length) {
      current += text[index + 1];
      started = true;
      index += 1;
      continue;
    }

    if (/\s/.test(char)) { push(); continue; }

    // Operators. Longest match first, so `>>` is not two `>`, and a file
    // descriptor join like `1>&2` is one token rather than a redirect
    // followed by a background `&`.
    const rest = text.slice(index);
    const joined = rest.match(/^>&\d/);
    const operator = joined
      ? joined[0]
      : ['&&', '||', '>>', ';', '|', '>', '<', '&'].find(candidate => rest.startsWith(candidate));

    if (operator) {
      // A bare digit immediately before a redirect names the stream being
      // redirected: it belongs to the operator, not to the previous word.
      const prefix = !quoted && /^\d$/.test(current) ? current : '';
      if (prefix) { current = ''; started = false; }
      push();

      tokens.push({ value: `${prefix}${operator}`, quoted: false, operator: true });
      index += operator.length - 1;
      continue;
    }

    current += char;
    started = true;
  }

  if (quote) return { error: 'The command has an unclosed quote' };
  push();

  return { tokens };
}

/**
 * Group tokens into the commands that will actually run.
 *
 * @returns {{segments: Array<{executable:string, args:string[], redirects:string[]}>}|{error:string}}
 */
export function segment(tokens) {
  const segments = [];
  let current = { executable: null, args: [], redirects: [] };
  let expectRedirectTarget = false;

  const finish = () => {
    if (current.executable) segments.push(current);
    current = { executable: null, args: [], redirects: [] };
  };

  for (const token of tokens) {
    if (token.operator) {
      if (token.value === '&') {
        return { error: 'Running a command in the background is not permitted: it would outlive the task that started it.' };
      }
      if (STREAM_JOIN.test(token.value)) continue;   // a stream join, not a target
      if (CONTROL.has(token.value)) {
        if (!current.executable) return { error: `Nothing to run before \`${token.value}\`` };
        finish();
        continue;
      }
      if (REDIRECT.has(token.value)) { expectRedirectTarget = true; continue; }
      return { error: `\`${token.value}\` is not permitted` };
    }

    if (expectRedirectTarget) {
      current.redirects.push(token.value);
      expectRedirectTarget = false;
      continue;
    }

    if (!current.executable) current.executable = token.value;
    else current.args.push(token.value);
  }

  if (expectRedirectTarget) return { error: 'A redirection has no target' };
  finish();

  if (!segments.length) return { error: 'The command could not be parsed' };
  return { segments };
}

/**
 * Is this redirection target inside the workspace?
 *
 * A command may compose freely and still must not write outside the directory
 * it was given. `/dev/null` is the one absolute path anybody actually needs.
 */
export function redirectAllowed(target) {
  const value = String(target || '');
  if (!value) return false;
  if (DEVICES.has(value)) return true;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  return !value.split('/').includes('..');
}

/** Does this line compose, or is it a single command? */
export function isComposed(tokens) {
  return tokens.some(token => token.operator);
}

export function findSubstitution(command) {
  for (const rule of SUBSTITUTION) {
    if (rule.pattern.test(String(command ?? ''))) return rule.why;
  }
  return null;
}

export { CONTROL, REDIRECT, DEVICES };
