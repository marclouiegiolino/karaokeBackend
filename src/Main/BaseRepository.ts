import type { Database, InValue, QueryExecutor, Row } from './Database.js';
export abstract class BaseRepository {
  constructor(protected readonly db: Database) {}
  protected async rows<T>(
    sql: string,
    args: InValue[] = [],
    executor: QueryExecutor = this.db,
  ): Promise<T[]> {
    const result = await executor.execute({ sql, args });
    return result.rows as unknown as T[];
  }
  protected async first<T>(
    sql: string,
    args: InValue[] = [],
    executor: QueryExecutor = this.db,
  ): Promise<T | undefined> {
    return (await this.rows<T>(sql, args, executor))[0];
  }
}
