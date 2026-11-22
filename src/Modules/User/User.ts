import type { AppRole } from '../../Security/AppRoles.js';
export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: AppRole;
  is_active: number;
  created_at: number;
}
export interface UserRecord extends User {
  password_hash: string;
}
export function publicUser(record: UserRecord | User): User {
  const { id, username, email, display_name, role, is_active, created_at } = record;
  return { id, username, email, display_name, role, is_active, created_at };
}
