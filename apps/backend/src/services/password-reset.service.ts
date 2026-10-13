import { hashPassword } from 'better-auth/crypto';
import crypto from 'crypto';

import * as accountQueries from '../queries/account.queries';
import * as userQueries from '../queries/user.queries';

export type LocalPasswordReset =
	| { status: 'reset' | 'created'; email: string; temporaryPassword: string }
	| { status: 'user_not_found' };

/**
 * Issues a temporary password for a local user. Users who only ever signed in through a provider
 * (for example after Identity-Aware Proxy sign-in revoked an unverified password) get a new password
 * credential, so an administrator can always recover access from the server.
 */
export async function resetLocalPassword(email: string): Promise<LocalPasswordReset> {
	const user = (await userQueries.getUser({ email })) ?? (await userQueries.getUser({ email: email.toLowerCase() }));
	if (!user) {
		return { status: 'user_not_found' };
	}

	const temporaryPassword = crypto.randomBytes(12).toString('base64url');
	const hashedPassword = await hashPassword(temporaryPassword);
	const account = await accountQueries.getAccountById(user.id);
	if (account) {
		await accountQueries.updateAccountPassword(account.id, hashedPassword, user.id);
		return { status: 'reset', email: user.email, temporaryPassword };
	}

	await accountQueries.createCredentialAccount(user.id, hashedPassword);
	return { status: 'created', email: user.email, temporaryPassword };
}
