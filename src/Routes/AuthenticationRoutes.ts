import { Router } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { AuthenticationController } from '../Controllers/AuthenticationController.js';
import { authenticate } from '../Middleware/Authenticate.js';
import { errorHandler } from '../Middleware/ErrorHandler.js';
import { rateLimit } from '../Middleware/RateLimit.js';
import { validateRequest } from '../Middleware/ValidateRequest.js';
import { registerSchema } from '../DTOs/Auth/RegisterRequest.js';
import { loginSchema } from '../DTOs/Auth/LoginRequest.js';
export function authenticationRoutes(d: Dependencies) {
  const r = Router(),
    c = new AuthenticationController(d);
  r.post('/register', rateLimit(d, 'auth'), validateRequest(registerSchema), c.register);
  r.post('/login', rateLimit(d, 'auth'), validateRequest(loginSchema), c.login);
  r.get('/me', authenticate(d), c.me);
  r.post('/logout', c.logout);
  r.use(errorHandler);
  return r;
}
