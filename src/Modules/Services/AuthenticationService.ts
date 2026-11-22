import type { Response } from 'express';
import type { IUserRepository } from '../User/IUserRepository.js';
import type { RegisterRequest } from '../../DTOs/Auth/RegisterRequest.js';
import type { LoginRequest } from '../../DTOs/Auth/LoginRequest.js';
import { PasswordHasher } from '../../Security/PasswordHasher.js';
import { SessionService } from '../../Security/SessionService.js';
import { publicUser } from '../User/User.js';
import { AppError } from '../../Utils/AppError.js';
export class AuthenticationService {
  constructor(
    private users: IUserRepository,
    private passwords: PasswordHasher,
    private sessions: SessionService,
  ) {}
  async register(input: RegisterRequest, res: Response) {
    const hash = await this.passwords.hash(input.password);
    const user = {
      id: crypto.randomUUID(),
      username: input.username,
      email: input.email,
      display_name: input.displayName,
      password_hash: hash,
      role: 'USER' as const,
      is_active: 1,
      created_at: Date.now(),
    };
    try {
      await this.users.create(user);
    } catch (e) {
      if (String(e).includes('UNIQUE constraint'))
        throw new AppError(409, 'ACCOUNT_UNAVAILABLE', 'Username or email is unavailable');
      throw e;
    }
    await this.sessions.create(user.id, res);
    return publicUser(user);
  }
  async login(input: LoginRequest, res: Response) {
    const user = await this.users.findByLogin(input.login);
    const valid = await this.passwords.verify(input.password, user?.password_hash ?? '');
    if (!user || !valid || !user.is_active) return undefined;
    await this.sessions.create(user.id, res);
    return publicUser(user);
  }
}
