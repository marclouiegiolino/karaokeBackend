import * as z from 'zod';
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export function pagination(page: number, pageSize: number) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}
