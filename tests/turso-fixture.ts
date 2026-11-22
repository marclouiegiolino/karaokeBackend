import type { Client, InArgs, InValue, Value } from '@libsql/client';
import { TursoHttpDatabase } from '../src/Main/TursoHttpDatabase.js';

// Local in-memory protocol fixture only; it never contacts Turso or reads credentials.
export function sqlitePipelineDatabase(db: Client) {
  const fromWire = (cell: Record<string, any>): InValue => {
    if (cell.type === 'null') return null;
    if (cell.type === 'integer') return BigInt(cell.value);
    if (cell.type === 'blob') return Buffer.from(cell.base64, 'base64');
    return cell.value;
  };
  const toWire = (value: Value) => {
    if (value === null) return { type: 'null' };
    if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value)))
      return { type: 'integer', value: String(value) };
    if (typeof value === 'number') return { type: 'float', value };
    if (typeof value === 'string') return { type: 'text', value };
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  };
  let calls = 0;
  let transactionClients = 0;
  const native = new TursoHttpDatabase({
    url: 'libsql://native-fixture.invalid',
    authToken: 'test-only-no-token',
    transactionClient: () => {
      transactionClients++;
      return db;
    },
    fetch: async (_url, init) => {
      calls++;
      const payload = JSON.parse(String(init?.body));
      const stmt = payload.requests[0].stmt;
      const args: InArgs = stmt.named_args
        ? Object.fromEntries(
            stmt.named_args.map((a: { name: string; value: Record<string, unknown> }) => [
              a.name,
              fromWire(a.value),
            ]),
          )
        : stmt.args.map(fromWire);
      let first;
      try {
        const rs = await db.execute({ sql: stmt.sql, args });
        first = {
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: rs.columns.map((name, i) => ({ name, decltype: rs.columnTypes[i] ?? null })),
              rows: rs.rows.map((row) => rs.columns.map((c) => toWire(row[c]!))),
              affected_row_count: rs.rowsAffected,
              last_insert_rowid:
                rs.lastInsertRowid === undefined ? null : String(rs.lastInsertRowid),
            },
          },
        };
      } catch (error) {
        const e = error as { code?: string; extendedCode?: string; message?: string };
        first = { type: 'error', error: { code: e.extendedCode ?? e.code, message: e.message } };
      }
      return Response.json({
        baton: null,
        results: [first, { type: 'ok', response: { type: 'close' } }],
      });
    },
  });
  return { native, calls: () => calls, transactionClients: () => transactionClients };
}
