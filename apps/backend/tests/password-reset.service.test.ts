import { verifyPassword } from 'better-auth/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getUser: vi.fn(),
	getAccountById: vi.fn(),
	updateAccountPassword: vi.fn(),
	createCredentialAccount: vi.fn(),
}));

vi.mock('../src/queries/user.queries', () => ({ getUser: mocks.getUser }));
vi.mock('../src/queries/account.queries', () => ({
	getAccountById: mocks.getAccountById,
	updateAccountPassword: mocks.updateAccountPassword,
	createCredentialAccount: mocks.createCredentialAccount,
}));

import { resetLocalPassword } from '../src/services/password-reset.service';

const USER = { id: 'user-1', email: 'alice@example.com' };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getUser.mockImplementation(async ({ email }: { email: string }) => (email === USER.email ? USER : null));
});

describe('resetLocalPassword', () => {
	it('replaces the password of a user who already has one', async () => {
		mocks.getAccountById.mockResolvedValue({ id: 'account-1', password: 'old-hash' });

		const reset = await resetLocalPassword('alice@example.com');

		expect(reset).toMatchObject({ status: 'reset', email: 'alice@example.com' });
		const [accountId, hash, userId] = mocks.updateAccountPassword.mock.calls[0];
		expect([accountId, userId]).toEqual(['account-1', 'user-1']);
		await expect(
			verifyPassword({ hash, password: (reset as { temporaryPassword: string }).temporaryPassword }),
		).resolves.toBe(true);
		expect(mocks.createCredentialAccount).not.toHaveBeenCalled();
	});

	it('creates a password for a user whose password was revoked by proxy sign-in', async () => {
		mocks.getAccountById.mockResolvedValue(null);

		const reset = await resetLocalPassword('Alice@Example.com');

		expect(reset).toMatchObject({ status: 'created', email: 'alice@example.com' });
		const [userId, hash] = mocks.createCredentialAccount.mock.calls[0];
		expect(userId).toBe('user-1');
		await expect(
			verifyPassword({ hash, password: (reset as { temporaryPassword: string }).temporaryPassword }),
		).resolves.toBe(true);
		expect(mocks.updateAccountPassword).not.toHaveBeenCalled();
	});

	it('reports an unknown email', async () => {
		await expect(resetLocalPassword('nobody@example.com')).resolves.toEqual({ status: 'user_not_found' });
	});
});
