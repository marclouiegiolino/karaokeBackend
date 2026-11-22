import { BaseRepository } from '../../Main/BaseRepository.js';
import type { UserRecord } from './User.js';
import type { IUserRepository } from './IUserRepository.js';
export class UserRepository extends BaseRepository implements IUserRepository {
  findById(id: string) {
    return this.first<UserRecord>('SELECT * FROM users WHERE id=?', [id]);
  }
  findByLogin(login: string) {
    return this.first<UserRecord>(
      'SELECT * FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE',
      [login, login],
    );
  }
  async create(u: UserRecord) {
    await this.db.execute({
      sql: 'INSERT INTO users(id,username,email,display_name,password_hash,role,is_active,created_at) VALUES(?,?,?,?,?,?,?,?)',
      args: [
        u.id,
        u.username,
        u.email,
        u.display_name,
        u.password_hash,
        u.role,
        u.is_active,
        u.created_at,
      ],
    });
  }
}
