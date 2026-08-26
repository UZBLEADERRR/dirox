import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectionString, quote } from '../src/db/pg.js';
import { readMigrations, checkConnectionMode, checksumOf } from '../src/db/migrate.js';

test('connection strings parse into their parts', () => {
  const c = parseConnectionString('postgresql://user:secret@db.example.com:5432/mydb');
  assert.equal(c.host, 'db.example.com');
  assert.equal(c.port, 5432);
  assert.equal(c.user, 'user');
  assert.equal(c.password, 'secret');
  assert.equal(c.database, 'mydb');
});

test('a Supabase session pooler string parses, including the dotted user', () => {
  const c = parseConnectionString(
    'postgresql://postgres.abcdefghijkl:my%40pass@aws-0-eu-central-1.pooler.supabase.com:5432/postgres');
  assert.equal(c.user, 'postgres.abcdefghijkl');
  // Percent-encoded characters in the password must be decoded, or auth fails.
  assert.equal(c.password, 'my@pass');
  assert.equal(c.port, 5432);
});

test('TLS is on by default and chain verification is opt-in', () => {
  const plain = parseConnectionString('postgresql://u:p@h:5432/d');
  assert.equal(plain.ssl, true);
  // Managed poolers present certificates that do not chain to public roots.
  assert.equal(plain.rejectUnauthorized, false);

  assert.equal(parseConnectionString('postgresql://u:p@h:5432/d?sslmode=verify-full').rejectUnauthorized, true);
  assert.equal(parseConnectionString('postgresql://u:p@h:5432/d?sslmode=disable').ssl, false);
});

test('both postgres:// and postgresql:// are accepted', () => {
  assert.equal(parseConnectionString('postgres://u:p@h/d').host, 'h');
  assert.equal(parseConnectionString('postgresql://u:p@h/d').host, 'h');
});

test('a non-Postgres or malformed string is rejected', () => {
  assert.throws(() => parseConnectionString('mysql://u:p@h/d'), /must start with postgres/);
  assert.throws(() => parseConnectionString('not a url'), /not a valid connection string/);
});

test('the transaction pooler is refused with an actionable message', () => {
  const pooler = parseConnectionString('postgresql://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres');
  assert.throws(() => checkConnectionMode(pooler), /session pooler|6543/);
  // The session pooler on 5432 is fine.
  assert.equal(checkConnectionMode(parseConnectionString('postgresql://u:p@h:5432/d')), true);
});

test('migrations are discovered in filename order', async () => {
  const files = await readMigrations();
  assert.ok(files.length >= 10, `expected at least 10 migrations, found ${files.length}`);
  const names = files.map(f => f.filename);
  assert.deepEqual(names, [...names].sort(), 'migrations must be ordered by filename');
  assert.equal(names[0], '0001_core.sql');
  for (const file of files) {
    assert.ok(file.sql.length > 0, `${file.filename} is empty`);
    assert.match(file.checksum, /^[0-9a-f]{32}$/);
  }
});

test('checksums change when content changes and are stable when it does not', () => {
  assert.equal(checksumOf('select 1'), checksumOf('select 1'));
  assert.notEqual(checksumOf('select 1'), checksumOf('select 2'));
});

test('SQL literal quoting escapes embedded quotes', () => {
  assert.equal(quote("O'Brien"), "'O''Brien'");
  assert.equal(quote('plain'), "'plain'");
});
