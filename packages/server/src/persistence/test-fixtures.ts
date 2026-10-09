import type { UserId } from '../domain';
import type { UserRepository } from './user.repository';

let counter = 0;

// Persists a user with a unique username, as every aggregate FK needs one.
export async function seedUser(users: UserRepository, prefix = 'user'): Promise<UserId> {
  counter += 1;
  const user = await users.create({
    username: `${prefix}${counter}`,
    email: `${prefix}${counter}@example.com`,
    displayName: `${prefix} ${counter}`,
  });
  return user.id;
}
