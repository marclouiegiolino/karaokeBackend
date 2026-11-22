import { BaseRepository } from '../Main/BaseRepository.js';
import type { User } from '../Modules/User/User.js';
export class SessionRepository extends BaseRepository {
  async create(id: string, userId: string, hash: string, expiresAt: number) {
    await this.db.execute({
      sql: 'INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)',
      args: [id, userId, hash, expiresAt, Date.now()],
    });
  }
  findUser(hash: string) {
    return this.first<User>(
      'SELECT u.id,u.username,u.email,u.display_name,u.role,u.is_active,u.created_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1',
      [hash, Date.now()],
    );
  }
  async remove(hash: string) {
    await this.db.execute({ sql: 'DELETE FROM sessions WHERE token_hash=?', args: [hash] });
  }
}
