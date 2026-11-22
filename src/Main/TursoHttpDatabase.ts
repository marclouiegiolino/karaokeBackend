import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type InValue,
  type Value,
  type TransactionMode,
} from '@libsql/client/web';
import type { Database, QueryResult } from './Database.js';

type TransactionClient = Pick<Client, 'batch' | 'transaction'>;
type Options = {
  url: string;
  authToken: string;
  fetch?: typeof fetch;
  transactionClient?: () => TransactionClient | Promise<TransactionClient>;
};

// Never include SQL, arguments, tokens, provider bodies or network causes in errors.
export class TursoHttpError extends Error {
  constructor(
    public readonly code = 'DATABASE_UNAVAILABLE',
    unique = false,
  ) {
    super(unique ? 'UNIQUE constraint failed' : 'Database request could not be confirmed');
    this.name = 'TursoHttpError';
  }
}

const integerPattern = /^-?\d+$/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'string' || !integerPattern.test(value))
    throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new TursoHttpError('DATABASE_INTEGER_RANGE');
  return n;
}
function toBase64(bytes: Uint8Array) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
function encode(value: InValue): Record<string, unknown> {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'text', value };
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'bigint') {
    if (value < -9223372036854775808n || value > 9223372036854775807n)
      throw new TursoHttpError('DATABASE_ARGUMENT_RANGE');
    return { type: 'integer', value: String(value) };
  }
  // Match libSQL's number mode: JavaScript numbers and Dates are Hrana floats.
  if (value instanceof Date) value = value.valueOf();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TursoHttpError('DATABASE_ARGUMENT_RANGE');
    return { type: 'float', value };
  }
  if (value instanceof ArrayBuffer)
    return { type: 'blob', base64: toBase64(new Uint8Array(value)) };
  if (value instanceof Uint8Array) return { type: 'blob', base64: toBase64(value) };
  throw new TursoHttpError('DATABASE_ARGUMENT_TYPE');
}
function decode(input: unknown): Value {
  const cell = record(input);
  switch (cell.type) {
    case 'null':
      return null;
    case 'text':
      if (typeof cell.value === 'string') return cell.value;
      break;
    case 'integer':
      return integer(cell.value);
    case 'float':
      if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return cell.value;
      break;
    case 'blob':
      if (
        typeof cell.base64 === 'string' &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cell.base64)
      ) {
        const bytes = Buffer.from(cell.base64, 'base64');
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      }
      break;
  }
  throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
}
function queryResult(input: unknown): QueryResult {
  const result = record(input);
  if (
    !Array.isArray(result.cols) ||
    !Array.isArray(result.rows) ||
    !Number.isSafeInteger(result.affected_row_count) ||
    Number(result.affected_row_count) < 0
  )
    throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
  const columns: string[] = [];
  const columnTypes: string[] = [];
  for (const input of result.cols) {
    const col = record(input);
    if (col.name !== null && col.name !== undefined && typeof col.name !== 'string')
      throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
    if (col.decltype !== null && col.decltype !== undefined && typeof col.decltype !== 'string')
      throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
    columns.push((col.name as string | null | undefined) ?? '');
    columnTypes.push((col.decltype as string | null | undefined) ?? '');
  }
  const rows = result.rows.map((input) => {
    if (!Array.isArray(input) || input.length !== columns.length)
      throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
    const row: Record<string, Value> = Object.create(null);
    for (let i = 0; i < columns.length; i++) {
      const value = decode(input[i]);
      if (!Object.hasOwn(row, columns[i]!)) row[columns[i]!] = value;
    }
    return row;
  });
  const id = result.last_insert_rowid;
  if (id !== null && id !== undefined && (typeof id !== 'string' || !integerPattern.test(id)))
    throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
  const rowid = typeof id === 'string' ? BigInt(id) : undefined;
  if (rowid !== undefined && (rowid < -9223372036854775808n || rowid > 9223372036854775807n))
    throw new TursoHttpError('DATABASE_INTEGER_RANGE');
  return {
    columns,
    columnTypes,
    rows,
    rowsAffected: Number(result.affected_row_count),
    lastInsertRowid: rowid,
  };
}

/** Stateless one-statement pipelines; official libSQL handles every transaction. */
export class TursoHttpDatabase implements Database {
  readonly #options: Options;
  readonly #endpoint: string;
  readonly #request: typeof fetch;
  readonly #headers: Readonly<Record<string, string>>;
  #warmupFetch?: typeof fetch;
  #sdk?: Promise<TransactionClient>;
  constructor(options: Options) {
    this.#options = options;
    let url: URL;
    try {
      url = new URL(options.url.replace(/^libsql:/, 'https:'));
    } catch {
      throw new TursoHttpError('DATABASE_CONFIGURATION');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !options.authToken
    )
      throw new TursoHttpError('DATABASE_CONFIGURATION');
    this.#endpoint = url.origin + '/v2/pipeline';
    // Workers' global fetch requires its global receiver when stored on a class.
    this.#request = options.fetch ?? fetch.bind(globalThis);
    this.#headers = Object.freeze({
      Authorization: 'Bearer ' + options.authToken,
      'Content-Type': 'application/json',
    });
  }
  private transactionClient() {
    return (this.#sdk ??= Promise.resolve().then(() => {
      if (this.#options.transactionClient) return this.#options.transactionClient();
      return createClient({
        url: this.#options.url,
        authToken: this.#options.authToken,
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          (this.#warmupFetch ?? this.#request)(input, init),
      });
    }));
  }
  async prewarm() {
    if (this.#options.transactionClient) {
      await this.transactionClient();
      return;
    }
    const OrigRequest = globalThis.Request;
    const origAbortTimeout = AbortSignal.timeout;
    try {
      globalThis.Request = class WarmupRequest {
        url: string;
        method: string;
        headers: Headers;
        body: unknown;
        constructor(input: RequestInfo | URL, init: RequestInit = {}) {
          this.url = String(input);
          this.method = init.method ?? 'GET';
          this.headers = new Headers(init.headers);
          this.body = init.body;
        }
      } as unknown as typeof Request;
      AbortSignal.timeout = () => new AbortController().signal;
      this.#warmupFetch = (async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          baton: null,
          results: [
            {
              type: 'ok',
              response: {
                type: 'execute',
                result: {
                  cols: [
                    { name: 'id', decltype: 'TEXT' },
                    { name: 'n', decltype: 'INTEGER' },
                  ],
                  rows: [
                    [
                      { type: 'text', value: 'w' },
                      { type: 'integer', value: '1' },
                    ],
                  ],
                  affected_row_count: 1,
                  last_insert_rowid: '1',
                },
              },
            },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
      })) as unknown as typeof fetch;
      await this.execute({ sql: 'SELECT ?, ?', args: ['w', 1] });

      this.#warmupFetch = (async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          baton: null,
          results: [
            { type: 'ok', response: { type: 'store_sql' } },
            {
              type: 'ok',
              response: {
                type: 'batch',
                result: {
                  step_results: [
                    { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null },
                    {
                      cols: [{ name: 'id', decltype: 'TEXT' }],
                      rows: [[{ type: 'text', value: 'w' }]],
                      affected_row_count: 1,
                      last_insert_rowid: '1',
                    },
                    { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null },
                    null,
                  ],
                  step_errors: [null, null, null, null],
                },
              },
            },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
      })) as unknown as typeof fetch;
      await this.batch([{ sql: 'SELECT ?', args: [1] }], 'write');
      await Promise.resolve();
    } finally {
      this.#warmupFetch = undefined;
      globalThis.Request = OrigRequest;
      AbortSignal.timeout = origAbortTimeout;
    }
  }
  transaction(mode?: TransactionMode) {
    return this.transactionClient().then((client) => client.transaction(mode));
  }
  batch(...args: Parameters<Client['batch']>) {
    return this.transactionClient().then((client) => client.batch(...args));
  }
  async execute(statement: InStatement, args?: InArgs): Promise<QueryResult> {
    const source = typeof statement === 'string' ? { sql: statement, args } : statement;
    if (typeof source.sql !== 'string') throw new TursoHttpError('DATABASE_ARGUMENT_TYPE');
    const bindings = source.args ?? [];
    const stmt = Array.isArray(bindings)
      ? { sql: source.sql, args: bindings.map(encode), want_rows: true }
      : {
          sql: source.sql,
          named_args: Object.entries(bindings).map(([name, value]) => ({
            name,
            value: encode(value),
          })),
          want_rows: true,
        };
    let response: Response;
    try {
      // A lost write acknowledgement must never trigger an automatic replay or SDK fallback.
      response = await (this.#warmupFetch ?? this.#request)(this.#endpoint, {
        method: 'POST',
        headers: this.#headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ requests: [{ type: 'execute', stmt }, { type: 'close' }] }),
      });
    } catch {
      throw new TursoHttpError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new TursoHttpError();
    }
    try {
      const payload = record(await response.json());
      if (!Array.isArray(payload.results) || payload.results.length !== 2)
        throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
      const first = record(payload.results[0]);
      if (first.type === 'error') {
        const error = record(first.error);
        const code =
          typeof error.code === 'string' && /^SQLITE_[A-Z0-9_]{1,80}$/.test(error.code)
            ? error.code
            : 'DATABASE_QUERY_ERROR';
        const unique =
          code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
          (code === 'SQLITE_CONSTRAINT' &&
            typeof error.message === 'string' &&
            error.message.startsWith('UNIQUE constraint failed'));
        throw new TursoHttpError(code, unique);
      }
      const executed = record(first.response);
      const closed = record(payload.results[1]);
      if (
        first.type !== 'ok' ||
        executed.type !== 'execute' ||
        closed.type !== 'ok' ||
        record(closed.response).type !== 'close'
      )
        throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
      return queryResult(executed.result);
    } catch (error) {
      if (error instanceof TursoHttpError) throw error;
      throw new TursoHttpError('DATABASE_PROTOCOL_ERROR');
    }
  }
}
