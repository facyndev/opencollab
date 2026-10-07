import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

// Argon2id with the library defaults (64 MiB, 3 passes), which follow the
// OWASP baseline. The PHC string carries its own parameters, so they can be
// raised later without breaking existing hashes.
@Injectable()
export class PasswordService {
  private dummy?: Promise<string>;

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Spends the same time as a real check so unknown users are not detectable by timing. */
  async verifyDummy(password: string): Promise<void> {
    this.dummy ??= this.hash('dummy-password-for-timing');
    await this.verify(await this.dummy, password);
  }
}
