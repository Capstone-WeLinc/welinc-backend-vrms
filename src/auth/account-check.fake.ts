import type { AuthUser, Confirmed } from './account-check';
import { SystemType, UserRole } from './roles';

/** Stands in for AccountCheck in tests: confirms every token as `user`, or throws `error`. */
export class FakeAccountCheck {
  calls = 0;
  error: Error | null = null;

  constructor(
    public user: AuthUser = {
      sub: '00000000-0000-4000-8000-000000000002',
      email: 'vrms.admin@welinc.com',
      name: 'Victor Ramos',
      system: SystemType.VRMS,
      roles: [{ role: UserRole.ADMIN, system: SystemType.VRMS }],
    },
  ) {}

  confirm(): Promise<Confirmed> {
    this.calls++;
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve({ user: this.user, fresh: true });
  }

  status(): Promise<{ sessionExpiresAt: string }> {
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve({
      sessionExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    });
  }

  forget(): void {}
}
