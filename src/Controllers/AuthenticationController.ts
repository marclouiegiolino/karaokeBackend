import type { RequestHandler } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { AppError } from '../Utils/AppError.js';
import { errorHandler } from '../Middleware/ErrorHandler.js';
import { errorResponse } from '../Middleware/ErrorResponse.js';
export class AuthenticationController {
  constructor(private d: Dependencies) {}
  register: RequestHandler = async (req, res, next) => {
    try {
      if (!this.d.config.REGISTRATION_ENABLED)
        throw new AppError(403, 'REGISTRATION_DISABLED', 'Public registration is disabled');
      res.status(201).json({ user: await this.d.auth.register(res.locals.input, res) });
    } catch (error) {
      errorHandler(error, req, res, next);
    }
  };
  login: RequestHandler = async (req, res, next) => {
    try {
      const user = await this.d.auth.login(res.locals.input, res);
      if (!user) {
        errorResponse(res, 401, 'INVALID_CREDENTIALS', 'Invalid login credentials');
        return;
      }
      res.json({ user });
    } catch (error) {
      errorHandler(error, req, res, next);
    }
  };
  me: RequestHandler = (_req, res) => {
    res.json({ user: res.locals.user });
  };
  logout: RequestHandler = async (req, res, next) => {
    try {
      await this.d.sessions.logout(req, res);
      res.status(204).end();
    } catch (error) {
      errorHandler(error, req, res, next);
    }
  };
}
