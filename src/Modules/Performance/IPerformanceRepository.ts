import type { Performance } from './Performance.js';
export interface IPerformanceRepository {
  findById(id: string): Promise<Performance | undefined>;
  insert(p: Performance): Promise<boolean>;
  list(userId: string, page: number, pageSize: number): Promise<Performance[]>;
}
