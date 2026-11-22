import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { TursoHttpDatabase, TursoHttpError } from '../src/Main/TursoHttpDatabase.js';
import { sqlitePipelineDatabase } from './turso-fixture.js';

const url = 'libsql://fixture-only.invalid';
const authToken = 'fixture-only-private-token';
function result(overrides: Record<string, unknown> = {}) {
  return {
    cols: [],
    rows: [],
    affected_row_count: 0,
    last_insert_rowid: null,
    ...overrides,
  };
}
function reply(value: unknown = result()) {
  return Response.json({
    baton: null,
    results: [
      { type: 'ok', response: { type: 'execute', result: value } },
      { type: 'ok', response: { type: 'close' } },
    ],
  });
}

test('native SQL uses one HTTPS execute-and-close request and keeps bindings separate', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const db = new TursoHttpDatabase({
    url,
    authToken,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return reply();
    },
    transactionClient: () => {
      throw new Error('Ordinary SQL must not initialize the transaction client');
    },
  });
  const text = "quote' and $binding";
  await db.execute({ sql: 'SELECT ? AS value', args: [text] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://fixture-only.invalid/v2/pipeline');
  assert.equal(calls[0]!.init?.method, 'POST');
  assert.equal(calls[0]!.init?.redirect, 'manual');
  assert.ok(calls[0]!.init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    requests: [
      {
        type: 'execute',
        stmt: { sql: 'SELECT ? AS value', args: [{ type: 'text', value: text }], want_rows: true },
      },
      { type: 'close' },
    ],
  });
  assert.equal(new Headers(calls[0]!.init?.headers).get('authorization'), 'Bearer ' + authToken);
  assert.equal(JSON.stringify(db).includes(authToken), false);
});

test('native bindings preserve SDK-compatible scalars, byte slices, dates and named arguments', async () => {
  const db = createClient({ url: 'file::memory:' });
  try {
    const { native, transactionClients } = sqlitePipelineDatabase(db);
    const slice = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
    const args = [null, '€', true, 12.5, 42n, new Date(1234), slice, new Uint8Array([3]).buffer];
    const sql = 'SELECT ? AS a, ? AS b, ? AS c, ? AS d, ? AS e, ? AS f, ? AS g, ? AS h';
    const expected = await db.execute({ sql, args });
    const actual = await native.execute({ sql, args });
    assert.deepEqual(actual.columns, expected.columns);
    for (const c of expected.columns) assert.deepEqual(actual.rows[0]![c], expected.rows[0]![c]);
    assert.equal(Object.getPrototypeOf(actual.rows[0]), null);
    const named = await native.execute({ sql: 'SELECT :value AS value', args: { value: 'named' } });
    assert.equal(named.rows[0]!.value, 'named');
    assert.equal(transactionClients(), 0);
  } finally {
    db.close();
  }
});

test('native row decoder handles empty results, special column names and 64-bit row IDs', async () => {
  const db = new TursoHttpDatabase({
    url,
    authToken,
    fetch: async () =>
      reply(
        result({
          cols: [
            { name: '__proto__', decltype: 'TEXT' },
            { name: 'n', decltype: null },
          ],
          rows: [[{ type: 'text', value: 'safe' }, { type: 'null' }]],
          affected_row_count: 1,
          last_insert_rowid: '9223372036854775807',
        }),
      ),
  });
  const rs = await db.execute('SELECT something');
  assert.equal(rs.rows[0]!.__proto__, 'safe');
  assert.equal(rs.rows[0]!.n, null);
  assert.equal(rs.lastInsertRowid, 9223372036854775807n);
  assert.equal(rs.rowsAffected, 1);
  assert.deepEqual(rs.columnTypes, ['TEXT', '']);
});

test('invalid bindings and unsafe database URLs fail before any network request', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return reply();
  };
  for (const bad of [
    'not a URL',
    'http://host.invalid',
    'https://user:password@host.invalid',
    'libsql://host.invalid/?token=secret',
    'libsql://host.invalid/path',
  ]) {
    assert.throws(
      () => new TursoHttpDatabase({ url: bad, authToken, fetch: request }),
      TursoHttpError,
    );
  }
  assert.throws(() => new TursoHttpDatabase({ url, authToken: '' }), TursoHttpError);
  const db = new TursoHttpDatabase({ url, authToken, fetch: request });
  for (const value of [Infinity, NaN, 9223372036854775808n, new Date(NaN), undefined]) {
    await assert.rejects(db.execute({ sql: 'SELECT ?', args: [value as never] }), TursoHttpError);
  }
  assert.equal(calls, 0);
});

test('malformed provider values, missing acknowledgements and integer overflow fail closed', async () => {
  const badResults = [
    { ...result(), cols: 'wrong' },
    result({ affected_row_count: -1 }),
    result({ last_insert_rowid: '9223372036854775808' }),
    result({ last_insert_rowid: 'not an integer' }),
    ...[
      { type: 'integer', value: '9007199254740992' },
      { type: 'integer', value: '1.5' },
      { type: 'text', value: 5 },
      { type: 'blob', base64: 'bad!' },
      { type: 'unsupported', value: 'secret' },
    ].map((cell) => result({ cols: [{ name: 'n' }], rows: [[cell]] })),
    result({ cols: [{ name: 'n' }], rows: [[]] }),
  ];
  for (const bad of badResults) {
    const db = new TursoHttpDatabase({ url, authToken, fetch: async () => reply(bad) });
    await assert.rejects(db.execute('SELECT secret'), TursoHttpError);
  }
  for (const bad of [
    { results: [] },
    { results: [{ type: 'ok', response: { type: 'execute', result: result() } }] },
    {
      results: [
        { type: 'ok', response: { type: 'execute', result: result() } },
        { type: 'error', error: { message: 'private' } },
      ],
    },
  ]) {
    const db = new TursoHttpDatabase({ url, authToken, fetch: async () => Response.json(bad) });
    await assert.rejects(db.execute('SELECT secret'), TursoHttpError);
  }
});

test('database failures never replay a write, switch clients or expose provider secrets', async () => {
  for (const failure of ['network', 'http', 'redirect', 'json', 'query'] as const) {
    let calls = 0;
    let sdk = 0;
    const db = new TursoHttpDatabase({
      url,
      authToken,
      transactionClient: () => {
        sdk++;
        throw new Error('Must not fall back');
      },
      fetch: async () => {
        calls++;
        if (failure === 'network') throw new Error(authToken + ' lost acknowledgement');
        if (failure === 'http') return new Response(authToken, { status: 503 });
        if (failure === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://untrusted.invalid/' },
          });
        if (failure === 'json') return new Response('private invalid JSON ' + authToken);
        return Response.json({
          results: [
            {
              type: 'error',
              error: { code: 'PRIVATE_' + authToken, message: 'private sql and ' + authToken },
            },
            { type: 'ok', response: { type: 'close' } },
          ],
        });
      },
    });
    await assert.rejects(
      db.execute({ sql: 'INSERT private', args: ['private value'] }),
      (error) => {
        assert.ok(error instanceof TursoHttpError);
        assert.equal(String(error).includes(authToken), false);
        assert.equal(JSON.stringify(error).includes(authToken), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(calls, 1);
    assert.equal(sdk, 0);
  }
});

test('unique conflicts keep registration semantics without exposing SQL or provider messages', async () => {
  const db = createClient({ url: 'file::memory:' });
  try {
    await db.execute('CREATE TABLE accounts (name TEXT UNIQUE)');
    const { native } = sqlitePipelineDatabase(db);
    await native.execute({ sql: 'INSERT INTO accounts VALUES(?)', args: ['private account'] });
    await assert.rejects(
      native.execute({ sql: 'INSERT INTO accounts VALUES(?)', args: ['private account'] }),
      (error) => {
        assert.ok(error instanceof TursoHttpError);
        assert.equal(error.message, 'UNIQUE constraint failed');
        assert.equal(String(error).includes('accounts'), false);
        return true;
      },
    );
  } finally {
    db.close();
  }
});

test('native queries share committed data with official SDK transactions and rollbacks', async () => {
  const db = createClient({ url: 'file::memory:' });
  try {
    const f = sqlitePipelineDatabase(db);
    await f.native.execute('CREATE TABLE balance (id INTEGER PRIMARY KEY, value INTEGER)');
    await f.native.execute('INSERT INTO balance VALUES(1,100)');
    assert.equal(f.transactionClients(), 0);
    const rolledBack = await f.native.transaction('write');
    try {
      await rolledBack.execute('UPDATE balance SET value=0 WHERE id=1');
      await rolledBack.rollback();
    } finally {
      rolledBack.close();
    }
    assert.equal((await f.native.execute('SELECT value FROM balance')).rows[0]!.value, 100);
    const committed = await f.native.transaction('write');
    try {
      await committed.execute('UPDATE balance SET value=80 WHERE id=1');
      await committed.commit();
    } finally {
      committed.close();
    }
    assert.equal((await f.native.execute('SELECT value FROM balance')).rows[0]!.value, 80);
    assert.equal(f.transactionClients(), 1);
  } finally {
    db.close();
  }
});

test('atomic batches retain official SDK rollback and initialize the SDK only once', async () => {
  const db = createClient({ url: 'file::memory:' });
  try {
    const f = sqlitePipelineDatabase(db);
    await f.native.execute('CREATE TABLE items(id INTEGER PRIMARY KEY)');
    await assert.rejects(
      f.native.batch(['INSERT INTO items VALUES(1)', 'INSERT INTO items VALUES(1)'], 'write'),
    );
    assert.equal((await f.native.execute('SELECT COUNT(*) AS n FROM items')).rows[0]!.n, 0);
    await f.native.batch(['INSERT INTO items VALUES(1)', 'INSERT INTO items VALUES(2)'], 'write');
    assert.equal((await f.native.execute('SELECT COUNT(*) AS n FROM items')).rows[0]!.n, 2);
    assert.equal(f.transactionClients(), 1);
  } finally {
    db.close();
  }
});

test('a lost write reply is not retried even when the database already committed', async () => {
  const db = createClient({ url: 'file::memory:' });
  let calls = 0;
  try {
    await db.execute('CREATE TABLE once_only(value TEXT)');
    const native = new TursoHttpDatabase({
      url,
      authToken,
      fetch: async () => {
        calls++;
        await db.execute("INSERT INTO once_only VALUES('committed')");
        throw new Error('Lost response');
      },
    });
    await assert.rejects(
      native.execute("INSERT INTO once_only VALUES('committed')"),
      TursoHttpError,
    );
    assert.equal(calls, 1);
    assert.equal((await db.execute('SELECT COUNT(*) AS n FROM once_only')).rows[0]!.n, 1);
  } finally {
    db.close();
  }
});
