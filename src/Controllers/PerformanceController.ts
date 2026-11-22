import type { RequestHandler } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { paginationSchema } from '../Main/Pagination.js';
import { performanceResponse } from '../Modules/Performance/Performance.js';
export class PerformanceController {
  constructor(private d: Dependencies) {}
  list: RequestHandler = async (req, res) => {
    const q = paginationSchema.parse(req.query);
    res.json({
      data: (await this.d.performances.list(res.locals.user.id, q.page, q.pageSize)).map(
        performanceResponse,
      ),
      ...q,
    });
  };
  sync: RequestHandler = async (_req, res) => {
    const result = await this.d.performanceSync.sync(res.locals.input, res.locals.user.id);
    res.status(result.created ? 201 : 200).json(result);
  };
}
