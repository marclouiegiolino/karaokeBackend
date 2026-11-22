import { createHash, randomBytes } from 'node:crypto';
export const newToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
