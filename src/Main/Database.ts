import type { Client, InStatement, InValue, Value, Row } from '@libsql/client';

// Repositories read columns by name. Transactions keep the official client's contract.
export interface QueryResult {
  columns: string[];
  columnTypes: string[];
  rows: Record<string, Value>[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}
export interface QueryExecutor {
  execute(statement: InStatement): Promise<QueryResult>;
}
export type Database = QueryExecutor & Pick<Client, 'batch' | 'transaction'>;
export type { InValue, Row };
