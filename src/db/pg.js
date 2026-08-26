/**
 * Minimal PostgreSQL wire-protocol client.
 *
 * Only what a migration runner needs: TLS negotiation, SCRAM-SHA-256
 * authentication and the simple query protocol. No prepared statements, no
 * binary formats, no connection pool.
 *
 * Written rather than taken from npm because it runs exactly once at boot, its
 * surface is small and fully specified, and a failure here is immediate and
 * loud rather than a subtle behaviour change under production traffic. The
 * deployment keeps its property of having nothing to install.
 *
 * Protocol reference: PostgreSQL frontend/backend protocol version 3.0.
 */

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { createHash, createHmac, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';

const pbkdf2Async = promisify(pbkdf2);

const PROTOCOL_VERSION = 196608;   // 3.0
const SSL_REQUEST_CODE = 80877103;

/** Grow-on-demand write buffer for building protocol messages. */
class Writer {
  constructor() { this.chunks = []; }
  byte(value) { this.chunks.push(Buffer.from([value])); return this; }
  int32(value) { const b = Buffer.alloc(4); b.writeInt32BE(value); this.chunks.push(b); return this; }
  cstring(value) { this.chunks.push(Buffer.from(`${value}\0`, 'utf8')); return this; }
  raw(buffer) { this.chunks.push(buffer); return this; }

  /** Frame as a message: [type?][length][body]. Length includes itself. */
  finish(type) {
    const body = Buffer.concat(this.chunks);
    const length = Buffer.alloc(4);
    length.writeInt32BE(body.length + 4);
    return type ? Buffer.concat([Buffer.from(type, 'ascii'), length, body]) : Buffer.concat([length, body]);
  }
}

/** Read fields out of a message body. */
class Reader {
  constructor(buffer) { this.buffer = buffer; this.offset = 0; }
  int32() { const v = this.buffer.readInt32BE(this.offset); this.offset += 4; return v; }
  int16() { const v = this.buffer.readInt16BE(this.offset); this.offset += 2; return v; }
  byte() { return this.buffer[this.offset++]; }
  cstring() {
    const end = this.buffer.indexOf(0, this.offset);
    const value = this.buffer.toString('utf8', this.offset, end === -1 ? this.buffer.length : end);
    this.offset = (end === -1 ? this.buffer.length : end) + 1;
    return value;
  }
  rest() { return this.buffer.subarray(this.offset); }
  get done() { return this.offset >= this.buffer.length; }
}

/** Parse an ErrorResponse or NoticeResponse body into named fields. */
function parseFields(body) {
  const reader = new Reader(body);
  const fields = {};
  const NAMES = {
    S: 'severity', V: 'severityCode', C: 'code', M: 'message', D: 'detail',
    H: 'hint', P: 'position', W: 'where', s: 'schema', t: 'table',
    c: 'column', d: 'dataType', n: 'constraint', F: 'file', L: 'line', R: 'routine'
  };
  while (!reader.done) {
    const type = reader.byte();
    if (!type) break;
    const value = reader.cstring();
    fields[NAMES[String.fromCharCode(type)] || String.fromCharCode(type)] = value;
  }
  return fields;
}

export class PostgresError extends AppError {
  constructor(fields) {
    const where = fields.position ? ` at position ${fields.position}` : '';
    super(`${fields.severity || 'ERROR'}: ${fields.message}${where}`, {
      status: 500, code: 'postgres_error', details: fields
    });
    this.name = 'PostgresError';
    this.pgCode = fields.code;
    this.detail = fields.detail;
    this.hint = fields.hint;
  }
}

/**
 * Parse a Postgres connection URI.
 *
 * Deliberately hand-parsed rather than handed to `new URL`, because a database
 * password is a hostile input for a URL parser and these strings are pasted by
 * hand. A `#` makes `new URL` throw; a `?` swallows the rest as a query; a `%`
 * that is not a valid escape makes decodeURIComponent throw "URI malformed",
 * which says nothing useful to whoever pasted it.
 *
 * The rules that matter: the password runs to the LAST `@` in the authority,
 * and every component is decoded only when decoding actually succeeds.
 */
export function parseConnectionString(uri) {
  const raw = String(uri ?? '').trim();

  if (!raw) {
    throw new AppError('DATABASE_URL is empty', { status: 500, code: 'bad_config' });
  }

  const schemeMatch = /^(postgres(?:ql)?):\/\/(.*)$/is.exec(raw);
  if (!schemeMatch) {
    throw new AppError(
      'DATABASE_URL must start with postgresql:// or postgres://',
      { status: 500, code: 'bad_config' }
    );
  }

  let rest = schemeMatch[2];

  // Credentials end at the LAST '@', which is located before anything else is
  // split off. Doing it in this order means '@', '/', '#' and '?' inside a
  // password are all handled, since none of them can appear in a hostname.
  const at = rest.lastIndexOf('@');
  const credentials = at === -1 ? '' : rest.slice(0, at);
  const afterCredentials = at === -1 ? rest : rest.slice(at + 1);

  // The path begins at the first '/' after the host.
  const pathStart = afterCredentials.indexOf('/');
  const hostPart = pathStart === -1 ? afterCredentials : afterCredentials.slice(0, pathStart);
  const pathAndQuery = pathStart === -1 ? '' : afterCredentials.slice(pathStart + 1);

  const colon = credentials.indexOf(':');
  const rawUser = colon === -1 ? credentials : credentials.slice(0, colon);
  const rawPassword = colon === -1 ? '' : credentials.slice(colon + 1);

  // A query string is only meaningful after the database name.
  let database = pathAndQuery;
  let query = '';
  const questionMark = pathAndQuery.indexOf('?');
  if (questionMark !== -1) {
    database = pathAndQuery.slice(0, questionMark);
    query = pathAndQuery.slice(questionMark + 1);
  }

  // Host may be bracketed for IPv6: [::1]:5432
  let host = hostPart;
  let port = 5432;
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPart);
  if (ipv6) {
    host = ipv6[1];
    if (ipv6[2]) port = Number(ipv6[2]);
  } else {
    const hostColon = hostPart.lastIndexOf(':');
    if (hostColon !== -1) {
      const maybePort = hostPart.slice(hostColon + 1);
      if (/^\d+$/.test(maybePort)) {
        host = hostPart.slice(0, hostColon);
        port = Number(maybePort);
      }
    }
  }

  if (!host) {
    throw new AppError('DATABASE_URL has no host. Expected postgresql://user:password@host:5432/database', {
      status: 500, code: 'bad_config'
    });
  }

  const params = new URLSearchParams(query);
  const sslmode = params.get('sslmode') || 'require';
  const user = safeDecode(rawUser, 'username') || 'postgres';
  const password = safeDecode(rawPassword, 'password');

  // The commonest paste mistake by a wide margin.
  if (/^\[.*\]$/.test(password) || /YOUR[-_]?PASSWORD/i.test(password)) {
    throw new AppError(
      'DATABASE_URL still contains the password placeholder. Replace [YOUR-PASSWORD] with the real database password.',
      { status: 500, code: 'bad_config' }
    );
  }

  return {
    host,
    port,
    user,
    password,
    database: safeDecode(database, 'database') || 'postgres',
    ssl: sslmode !== 'disable',
    // Managed providers present certificates that do not chain to the public
    // roots for the pooler hostname. The channel is still encrypted; this only
    // relaxes hostname and chain verification.
    rejectUnauthorized: sslmode === 'verify-full' || sslmode === 'verify-ca',
    applicationName: params.get('application_name') || 'diroxcode-migrator'
  };
}

/**
 * Percent-decode a component, but only when it is genuinely percent-encoded.
 *
 * A password containing a literal `%` is legal and common; treating it as a
 * broken escape and throwing would reject a perfectly good credential.
 */
function safeDecode(value, what) {
  const text = String(value ?? '');
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    // Not valid percent-encoding, so it was a literal '%' all along.
    logger.debug('connection string component used literally', { component: what });
    return text;
  }
}

// ─── SCRAM-SHA-256 ──────────────────────────────────────────────────────────

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

async function scramProof({ password, clientNonce, serverFirst, clientFirstBare }) {
  const parts = Object.fromEntries(
    serverFirst.split(',').map(part => [part.slice(0, 1), part.slice(2)])
  );
  const serverNonce = parts.r;
  const salt = Buffer.from(parts.s, 'base64');
  const iterations = Number(parts.i);

  if (!serverNonce?.startsWith(clientNonce)) {
    throw new AppError('SCRAM server nonce does not extend the client nonce', { status: 500, code: 'auth_failed' });
  }
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new AppError('SCRAM iteration count is invalid', { status: 500, code: 'auth_failed' });
  }

  // biws is base64("n,,") — the GS2 header, repeated in the final message.
  const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
  const authMessage = `${clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;

  const saltedPassword = await pbkdf2Async(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
  const clientProof = xor(clientKey, clientSignature);

  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest();

  return {
    clientFinal: `${clientFinalWithoutProof},p=${clientProof.toString('base64')}`,
    expectedServerSignature: serverSignature.toString('base64')
  };
}

// ─── client ─────────────────────────────────────────────────────────────────

export class PostgresClient {
  constructor(config) {
    this.config = typeof config === 'string' ? parseConnectionString(config) : config;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];        // queued message handlers
    this.parameters = {};
    this.notices = [];
    this.connected = false;
  }

  /** Open the socket, upgrade to TLS if requested, and authenticate. */
  async connect({ timeoutMs = 20_000 } = {}) {
    const { host, port, ssl } = this.config;

    const plain = await new Promise((resolve, reject) => {
      const socket = netConnect({ host, port });
      const timer = setTimeout(() => { socket.destroy(); reject(new AppError(`Timed out connecting to ${host}:${port}`, { status: 504, code: 'timeout' })); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('error', error => { clearTimeout(timer); reject(new AppError(`Could not reach ${host}:${port} — ${error.message}`, { status: 502, code: 'connect_failed' })); });
    });

    this.socket = ssl ? await this.upgradeTls(plain) : plain;
    this.socket.on('data', chunk => this.onData(chunk));
    this.socket.on('error', error => this.failAll(new AppError(`Connection error: ${error.message}`, { status: 502, code: 'connection_error' })));
    this.socket.on('close', () => {
      this.connected = false;
      this.failAll(new AppError('The database connection closed unexpectedly', { status: 502, code: 'connection_closed' }));
    });

    await this.authenticate();
    this.connected = true;
    return this;
  }

  /** Ask for TLS, then wrap the socket if the server agrees. */
  async upgradeTls(socket) {
    const request = new Writer().int32(SSL_REQUEST_CODE).finish();
    socket.write(request);

    const answer = await new Promise((resolve, reject) => {
      socket.once('data', data => resolve(data[0]));
      socket.once('error', reject);
    });

    if (answer !== 0x53) {   // 'S'
      socket.destroy();
      throw new AppError('The server refused a TLS connection. Add ?sslmode=disable only if the link is already private.', {
        status: 502, code: 'tls_refused'
      });
    }

    // SNI is only meaningful for a hostname; RFC 6066 forbids an IP literal.
    const isIpLiteral = /^[\d.]+$|:/.test(this.config.host);

    return new Promise((resolve, reject) => {
      const secure = tlsConnect({
        socket,
        ...(isIpLiteral ? {} : { servername: this.config.host }),
        rejectUnauthorized: this.config.rejectUnauthorized
      }, () => resolve(secure));
      secure.once('error', error => reject(new AppError(`TLS handshake failed: ${error.message}`, { status: 502, code: 'tls_failed' })));
    });
  }

  /** Accumulate bytes and dispatch whole messages. */
  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    for (;;) {
      if (this.buffer.length < 5) return;
      const type = String.fromCharCode(this.buffer[0]);
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < length + 1) return;      // message not complete yet

      const body = this.buffer.subarray(5, length + 1);
      this.buffer = this.buffer.subarray(length + 1);
      this.dispatch(type, body);
    }
  }

  dispatch(type, body) {
    // Asynchronous messages can arrive at any time and belong to no request.
    if (type === 'S') {                       // ParameterStatus
      const reader = new Reader(body);
      this.parameters[reader.cstring()] = reader.cstring();
      return;
    }
    if (type === 'N') {                       // NoticeResponse
      const fields = parseFields(body);
      this.notices.push(fields);
      this.onNotice?.(fields);
      return;
    }
    if (type === 'K' || type === 'A') return; // BackendKeyData, NotificationResponse

    const handler = this.pending[0];
    if (!handler) return;
    handler(type, body);
  }

  failAll(error) {
    const handlers = this.pending.splice(0);
    for (const handler of handlers) handler('__error__', error);
  }

  send(buffer) {
    if (!this.socket?.writable) throw new AppError('The database connection is not open', { status: 502, code: 'not_connected' });
    this.socket.write(buffer);
  }

  /** Register a handler that consumes messages until it resolves. */
  expect(handle) {
    return new Promise((resolve, reject) => {
      const handler = (type, body) => {
        if (type === '__error__') { this.pending.shift(); return reject(body); }
        try {
          const outcome = handle(type, body);
          if (outcome === undefined) return;               // keep consuming
          this.pending.shift();
          return outcome instanceof Error ? reject(outcome) : resolve(outcome);
        } catch (error) {
          this.pending.shift();
          return reject(error);
        }
      };
      this.pending.push(handler);
    });
  }

  async authenticate() {
    const { user, database, password, applicationName } = this.config;

    const startup = new Writer()
      .int32(PROTOCOL_VERSION)
      .cstring('user').cstring(user)
      .cstring('database').cstring(database)
      .cstring('application_name').cstring(applicationName)
      .cstring('client_encoding').cstring('UTF8')
      .byte(0)
      .finish();

    const done = this.expect((type, body) => {
      if (type === 'E') return new PostgresError(parseFields(body));
      if (type === 'Z') return true;                        // ReadyForQuery
      if (type !== 'R') return undefined;

      const reader = new Reader(body);
      const method = reader.int32();

      switch (method) {
        case 0: return undefined;                           // AuthenticationOk
        case 3: {                                           // cleartext
          this.send(new Writer().cstring(password).finish('p'));
          return undefined;
        }
        case 5: {                                           // MD5
          const salt = reader.rest().subarray(0, 4);
          const inner = createHash('md5').update(password + user, 'utf8').digest('hex');
          const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex');
          this.send(new Writer().cstring(`md5${outer}`).finish('p'));
          return undefined;
        }
        case 10: {                                          // SASL
          const mechanisms = [];
          while (!reader.done) {
            const name = reader.cstring();
            if (!name) break;
            mechanisms.push(name);
          }
          if (!mechanisms.includes('SCRAM-SHA-256')) {
            return new AppError(`The server offered no supported authentication method (${mechanisms.join(', ') || 'none'})`, {
              status: 502, code: 'auth_unsupported'
            });
          }

          this.scram = { clientNonce: randomBytes(18).toString('base64') };
          this.scram.clientFirstBare = `n=*,r=${this.scram.clientNonce}`;
          const initial = `n,,${this.scram.clientFirstBare}`;

          this.send(new Writer()
            .cstring('SCRAM-SHA-256')
            .int32(Buffer.byteLength(initial))
            .raw(Buffer.from(initial, 'utf8'))
            .finish('p'));
          return undefined;
        }
        case 11: {                                          // SASLContinue
          const serverFirst = reader.rest().toString('utf8');
          this.scram.serverFirst = serverFirst;
          // The proof needs PBKDF2, which is async; the reply is sent when ready.
          scramProof({ password, clientNonce: this.scram.clientNonce, serverFirst, clientFirstBare: this.scram.clientFirstBare })
            .then(({ clientFinal, expectedServerSignature }) => {
              this.scram.expectedServerSignature = expectedServerSignature;
              this.send(new Writer().raw(Buffer.from(clientFinal, 'utf8')).finish('p'));
            })
            .catch(error => this.failAll(error));
          return undefined;
        }
        case 12: {                                          // SASLFinal
          const final = reader.rest().toString('utf8');
          const signature = /(?:^|,)v=([^,]+)/.exec(final)?.[1];
          if (signature !== this.scram.expectedServerSignature) {
            // A mismatch means the peer does not hold the password: refuse it.
            return new AppError('The server failed SCRAM verification — the connection may be intercepted', {
              status: 502, code: 'auth_failed'
            });
          }
          return undefined;
        }
        default:
          return new AppError(`Unsupported authentication method ${method}`, { status: 502, code: 'auth_unsupported' });
      }
    });

    this.send(startup);
    await done;
  }

  /**
   * Run one or more statements using the simple query protocol.
   *
   * A multi-statement string runs as a single implicit transaction, which is
   * exactly the semantics a migration file wants.
   *
   * @returns {Promise<Array<{command:string, rows:object[], fields:string[]}>>}
   */
  async query(sql) {
    const results = [];
    let current = null;

    const done = this.expect((type, body) => {
      switch (type) {
        case 'T': {                                         // RowDescription
          const reader = new Reader(body);
          const count = reader.int16();
          const fields = [];
          for (let i = 0; i < count; i += 1) {
            const name = reader.cstring();
            reader.int32(); reader.int16(); reader.int32(); reader.int16(); reader.int32(); reader.int16();
            fields.push(name);
          }
          current = { command: null, fields, rows: [] };
          return undefined;
        }
        case 'D': {                                         // DataRow
          const reader = new Reader(body);
          const count = reader.int16();
          const row = {};
          for (let i = 0; i < count; i += 1) {
            const length = reader.int32();
            if (length === -1) { row[current.fields[i]] = null; continue; }
            row[current.fields[i]] = reader.buffer.toString('utf8', reader.offset, reader.offset + length);
            reader.offset += length;
          }
          current.rows.push(row);
          return undefined;
        }
        case 'C': {                                         // CommandComplete
          const command = new Reader(body).cstring();
          results.push(current ? { ...current, command } : { command, fields: [], rows: [] });
          current = null;
          return undefined;
        }
        case 'I':                                           // EmptyQueryResponse
          results.push({ command: 'EMPTY', fields: [], rows: [] });
          return undefined;
        case 'E':
          this.queryError = new PostgresError(parseFields(body));
          return undefined;                                 // wait for ReadyForQuery
        case 'Z': {                                         // ReadyForQuery
          if (this.queryError) {
            const error = this.queryError;
            this.queryError = null;
            return error;
          }
          return results;
        }
        default:
          return undefined;
      }
    });

    this.send(new Writer().cstring(sql).finish('Q'));
    return done;
  }

  /** Convenience: first row of the first result set. */
  async one(sql) {
    const [first] = await this.query(sql);
    return first?.rows?.[0] ?? null;
  }

  async end() {
    if (!this.socket) return;
    try { this.socket.write(new Writer().finish('X')); } catch { /* already gone */ }
    await new Promise(resolve => {
      this.socket.once('close', resolve);
      this.socket.end();
      setTimeout(resolve, 2000).unref?.();
    });
    this.connected = false;
  }
}

/** Open a connection, run `work`, and always close it. */
export async function withConnection(config, work) {
  const client = new PostgresClient(config);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** SQL string literal quoting, for the few places a value must be inlined. */
export function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
