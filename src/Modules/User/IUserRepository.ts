import type { UserRecord } from './User.js';
export interface IUserRepository {
  findById(id: string): Promise<UserRecord | undefined>;
  findByLogin(login: string): Promise<UserRecord | undefined>;
  create(user: UserRecord): Promise<void>;
}
