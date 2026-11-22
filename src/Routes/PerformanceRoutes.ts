import { Router } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { PerformanceController } from '../Controllers/PerformanceController.js';
import { errorHandler } from '../Middleware/ErrorHandler.js';
import { validateRequest } from '../Middleware/ValidateRequest.js';
import { syncPerformanceSchema } from '../DTOs/Performance/SyncPerformanceRequest.js';
export function performanceRoutes(d: Dependencies) {
  const r = Router(),
    c = new PerformanceController(d);
  r.get('/', c.list);
  r.post('/sync', validateRequest(syncPerformanceSchema), c.sync);
  r.use(errorHandler);
  return r;
}
