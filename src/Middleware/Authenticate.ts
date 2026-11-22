import type { RequestHandler } from 'express';
import type { Dependencies } from '../Main/Dependencies.js';
import { publicUser } from '../Modules/User/User.js';
import { errorHandler } from './ErrorHandler.js';
import { errorResponse } from './ErrorResponse.js';
export function authenticate(d: Dependencies): RequestHandler {
  return async (req, res, next) => {
    const token = d.sessions.token(req);
    if (!token) {
      errorResponse(res, 401, 'UNAUTHENTICATED', 'Sign in to continue');
      return;
    }
    try {
      const user = await d.sessions.authenticateToken(token);
      if (!user) {
        errorResponse(res, 401, 'UNAUTHENTICATED', 'Sign in to continue');
        return;
      }
      res.locals.user = publicUser(user);
      next();
    } catch (error) {
      errorHandler(error, req, res, next);
    }
  };
}
