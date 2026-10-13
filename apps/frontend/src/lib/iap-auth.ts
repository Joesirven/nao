import { authClient } from '@/lib/auth-client';

export interface IapStatus {
	enabled: boolean;
	email: string | null;
	autoSignIn: boolean;
	buttonLabel: string | null;
	hidePasswordLogin: boolean;
}

const DISABLED_IAP_STATUS: IapStatus = {
	enabled: false,
	email: null,
	autoSignIn: false,
	buttonLabel: null,
	hidePasswordLogin: false,
};

/** Asks the server whether this request carries a valid Identity-Aware Proxy identity to offer on the login page. */
export async function fetchIapStatus(): Promise<IapStatus> {
	const { data } = await authClient.$fetch<IapStatus>('/iap/status', { method: 'GET' });
	return data ?? DISABLED_IAP_STATUS;
}

/** The server verifies the signed proxy header again on this request; the browser sends no identity itself. */
export async function signInWithIap(): Promise<{ error: string | null }> {
	const { error } = await authClient.$fetch('/iap/sign-in', { method: 'POST' });
	if (!error) {
		return { error: null };
	}
	return { error: error.message || 'Sign-in through your company account failed. Please try again.' };
}
