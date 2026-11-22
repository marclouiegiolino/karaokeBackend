import { AppError } from '../Utils/AppError.js';
import type { User } from '../Modules/User/User.js';
export function requireOwner(user: User, ownerId: string) {
  if (user.id !== ownerId) throw new AppError(404, 'NOT_FOUND', 'Resource not found');
}
