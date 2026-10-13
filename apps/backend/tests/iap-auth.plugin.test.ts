import { betterAuth } from 'better-auth';
import { hashPassword } from 'better-auth/crypto';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { iapAuth, type IapConfig } from '../src/services/iap-auth.service';
import { resolveProviderId } from '../src/utils/utils';
import { createIapTokenFixture, type IapTokenFixture, TEST_IAP_AUDIENCE } from './helpers/iap-token-fixture';

const BASE_URL = 'http://localhost:3000';
const ENABLED_CONFIG: IapConfig = {
	audience: TEST_IAP_AUDIENCE,
	allowedDomains: ['example.com'],
	buttonLabel: 'Sign in with your company Google account',
	hidePasswordLogin: true,
	autoSignIn: true,
};

const hooks = {
	mayCreateUser: vi.fn<(email: string) => Promise<boolean>>(),
	afterSignIn: vi.fn<(signIn: { userId: string; email: string; isNewUser: boolean }) => Promise<void>>(),
};

let fixture: IapTokenFixture;
let hookProviderIds: Array<[string, string | undefined]> = [];

beforeAll(async () => {
	fixture = await createIapTokenFixture();
});

beforeEach(() => {
	hooks.mayCreateUser.mockReset().mockResolvedValue(true);
	hooks.afterSignIn.mockReset().mockResolvedValue(undefined);
	hookProviderIds = [];
});

async function createAuth(config: IapConfig | null = ENABLED_CONFIG) {
	const options = {
		baseURL: BASE_URL,
		secret: 'iap-plugin-test-secret-that-is-long-enough',
		database: new Database(':memory:'),
		emailAndPassword: { enabled: true },
		rateLimit: { enabled: false },
		advanced: { disableOriginCheck: false },
		databaseHooks: {
			user: {
				create: {
					after: async (_user: unknown, ctx: Parameters<typeof resolveProviderId>[0]) => {
						hookProviderIds.push(['user.create', resolveProviderId(ctx)]);
					},
				},
			},
			session: {
				create: {
					after: async (_session: unknown, ctx: Parameters<typeof resolveProviderId>[0]) => {
						hookProviderIds.push(['session.create', resolveProviderId(ctx)]);
					},
				},
			},
		},
		plugins: [
			iapAuth({
				config,
				keySet: fixture.keySet,
				mayCreateUser: hooks.mayCreateUser,
				afterSignIn: hooks.afterSignIn,
			}),
		],
		user: {
			additionalFields: {
				requiresPasswordReset: { type: 'boolean' as const, defaultValue: false, input: false },
			},
		},
	};
	const { runMigrations } = await getMigrations(options);
	await runMigrations();
	const auth = betterAuth(options);
	return { auth, context: await auth.$context };
}

type TestAuth = Awaited<ReturnType<typeof createAuth>>;

function requestStatus(auth: TestAuth['auth'], headers: Record<string, string> = {}) {
	return auth.handler(new Request(`${BASE_URL}/api/auth/iap/status`, { headers }));
}

function requestSignIn(auth: TestAuth['auth'], headers: Record<string, string> = {}) {
	return auth.handler(
		new Request(`${BASE_URL}/api/auth/iap/sign-in`, {
			method: 'POST',
			headers: { origin: BASE_URL, ...headers },
		}),
	);
}

async function signUpWithPassword(auth: TestAuth['auth'], email: string, password = 'Original-password-1') {
	const { user } = await auth.api.signUpEmail({ body: { email, password, name: 'Alice' } });
	return user;
}

function signedOutMarkerFrom(response: Response): string | null {
	const setCookie = response.headers.get('set-cookie') ?? '';
	return /better-auth\.iap_signed_out=1/.exec(setCookie)?.[0] ?? null;
}

function sessionCookieFrom(response: Response): string | null {
	const setCookie = response.headers.get('set-cookie') ?? '';
	return /better-auth\.session_token=[^;]+/.exec(setCookie)?.[0] ?? null;
}

describe('Identity-Aware Proxy status endpoint', () => {
	it('reports the feature as disabled when it is not configured', async () => {
		const { auth } = await createAuth(null);

		const response = await requestStatus(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(await response.json()).toEqual({
			enabled: false,
			email: null,
			autoSignIn: false,
			buttonLabel: null,
			hidePasswordLogin: false,
		});
	});

	it('returns the verified email and presentation settings when a valid token is present', async () => {
		const { auth } = await createAuth();

		const response = await requestStatus(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(await response.json()).toEqual({
			enabled: true,
			email: 'alice@example.com',
			autoSignIn: true,
			buttonLabel: 'Sign in with your company Google account',
			hidePasswordLogin: true,
		});
	});

	it('returns no email when the token is missing or invalid', async () => {
		const { auth } = await createAuth();

		const missing = await requestStatus(auth);
		const invalid = await requestStatus(auth, {
			'x-goog-iap-jwt-assertion': await fixture.signToken({ audience: 'wrong' }),
		});

		expect(await missing.json()).toMatchObject({ enabled: true, email: null, autoSignIn: false });
		expect(await invalid.json()).toMatchObject({ enabled: true, email: null, autoSignIn: false });
	});

	it('passes the hide setting through so administrators can bring the password fields back', async () => {
		const { auth } = await createAuth({ ...ENABLED_CONFIG, hidePasswordLogin: false });

		const response = await requestStatus(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(await response.json()).toMatchObject({ email: 'alice@example.com', hidePasswordLogin: false });
	});
});

describe('Identity-Aware Proxy automatic sign-in after sign-out', () => {
	it('does not sign in automatically when automatic sign-in is turned off', async () => {
		const { auth } = await createAuth({ ...ENABLED_CONFIG, autoSignIn: false });

		const response = await requestStatus(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(await response.json()).toMatchObject({ email: 'alice@example.com', autoSignIn: false });
	});

	it('marks an explicit sign-out so the next visit offers the button instead of signing straight back in', async () => {
		const { auth } = await createAuth();
		const token = await fixture.signToken();
		const signIn = await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': token });

		const signOut = await auth.handler(
			new Request(`${BASE_URL}/api/auth/sign-out`, {
				method: 'POST',
				headers: { origin: BASE_URL, cookie: sessionCookieFrom(signIn)! },
			}),
		);
		const marker = signedOutMarkerFrom(signOut);
		expect(marker).not.toBeNull();

		const afterSignOut = await requestStatus(auth, { 'x-goog-iap-jwt-assertion': token, cookie: marker! });
		expect(await afterSignOut.json()).toMatchObject({ email: 'alice@example.com', autoSignIn: false });
	});

	it('clears the sign-out marker when the user presses the button', async () => {
		const { auth } = await createAuth();
		const marker = 'better-auth.iap_signed_out=1';

		const response = await requestSignIn(auth, {
			'x-goog-iap-jwt-assertion': await fixture.signToken(),
			cookie: marker,
		});

		expect(response.status).toBe(200);
		expect(response.headers.get('set-cookie')).toMatch(/better-auth\.iap_signed_out=;[^,]*Max-Age=0/);
	});
});

describe('Identity-Aware Proxy sign-in endpoint', () => {
	it('creates a user and a session from a valid token', async () => {
		const { auth, context } = await createAuth();

		const response = await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(response.status).toBe(200);
		const cookie = sessionCookieFrom(response);
		expect(cookie).not.toBeNull();
		const session = await auth.api.getSession({ headers: new Headers({ cookie: cookie! }) });
		expect(session?.user.email).toBe('alice@example.com');
		expect(session?.user.emailVerified).toBe(true);

		const accounts = await context.internalAdapter.findAccounts(session!.user.id);
		expect(accounts.map((account) => [account.providerId, account.accountId])).toEqual([
			['iap', 'accounts.google.com:1001'],
		]);
		expect(hooks.afterSignIn).toHaveBeenCalledWith({
			userId: session!.user.id,
			email: 'alice@example.com',
			isNewUser: true,
		});
	});

	it('lets nao database hooks recognise the user and session as created through the proxy', async () => {
		const { auth } = await createAuth();

		await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(hookProviderIds).toEqual([
			['user.create', 'iap'],
			['session.create', 'iap'],
		]);
	});

	it('signs a returning user into the same account', async () => {
		const { auth } = await createAuth();
		const token = await fixture.signToken();

		const first = await (await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': token })).json();
		const second = await (await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': token })).json();

		expect(second.user.id).toBe(first.user.id);
		expect(hooks.afterSignIn).toHaveBeenLastCalledWith(expect.objectContaining({ isNewUser: false }));
	});

	it('links an existing email and password user to the same account and revokes the unproven password', async () => {
		const { auth, context } = await createAuth();
		const existing = await signUpWithPassword(auth, 'alice@example.com');
		await context.internalAdapter.updateUser(existing.id, { requiresPasswordReset: true });

		const response = await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(response.status).toBe(200);
		expect((await response.json()).user.id).toBe(existing.id);
		const linked = await context.internalAdapter.findUserById(existing.id);
		expect(linked).toMatchObject({ emailVerified: true, requiresPasswordReset: false });
		const providers = (await context.internalAdapter.findAccounts(existing.id)).map(
			(account) => account.providerId,
		);
		expect(providers).toEqual(['iap']);
		await expect(
			auth.api.signInEmail({ body: { email: 'alice@example.com', password: 'Original-password-1' } }),
		).rejects.toThrow();
		expect(hooks.afterSignIn).toHaveBeenCalledWith({
			userId: existing.id,
			email: 'alice@example.com',
			isNewUser: false,
		});
	});

	it('keeps the password of an existing user whose email was already verified', async () => {
		const { auth, context } = await createAuth();
		const existing = await signUpWithPassword(auth, 'alice@example.com');
		await context.internalAdapter.updateUser(existing.id, { emailVerified: true });

		const response = await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect((await response.json()).user.id).toBe(existing.id);
		const providers = (await context.internalAdapter.findAccounts(existing.id)).map(
			(account) => account.providerId,
		);
		expect(providers.sort()).toEqual(['credential', 'iap']);
	});

	it('lets an administrator restore password access after the password was revoked', async () => {
		const { auth, context } = await createAuth();
		const existing = await signUpWithPassword(auth, 'alice@example.com');
		await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		await context.internalAdapter.createAccount({
			userId: existing.id,
			providerId: 'credential',
			accountId: existing.id,
			password: await hashPassword('Temporary-password-1'),
		});

		const recovered = await auth.api.signInEmail({
			body: { email: 'alice@example.com', password: 'Temporary-password-1' },
		});
		expect(recovered.user.id).toBe(existing.id);
	});

	it.each([
		['the header is missing', {}],
		[
			'only the unsigned email header is present',
			{ 'x-goog-authenticated-user-email': 'accounts.google.com:alice@example.com' },
		],
	])('refuses to sign in when %s', async (_case, headers: Record<string, string>) => {
		const { auth, context } = await createAuth();

		const response = await requestSignIn(auth, headers);

		expect(response.status).toBe(401);
		expect(sessionCookieFrom(response)).toBeNull();
		expect(await context.internalAdapter.findUserByEmail('alice@example.com')).toBeNull();
	});

	it.each([
		['a wrong audience', { audience: '/projects/123456789/apps/other' }],
		['a wrong issuer', { issuer: 'https://accounts.google.com' }],
		[
			'an expired token',
			{ issuedAt: Math.floor(Date.now() / 1000) - 700, expiresAt: Math.floor(Date.now() / 1000) - 60 },
		],
	])('refuses to sign in with %s', async (_case, overrides) => {
		const { auth } = await createAuth();

		const response = await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken(overrides) });

		expect(response.status).toBe(401);
		expect(sessionCookieFrom(response)).toBeNull();
	});

	it('refuses a bad signature', async () => {
		const { auth } = await createAuth();

		const response = await requestSignIn(auth, {
			'x-goog-iap-jwt-assertion': await fixture.signTokenWithUntrustedKey(),
		});

		expect(response.status).toBe(401);
	});

	it('refuses a disallowed domain without touching an existing account with that email', async () => {
		const { auth, context } = await createAuth();
		const existing = await signUpWithPassword(auth, 'eve@other.example');

		const response = await requestSignIn(auth, {
			'x-goog-iap-jwt-assertion': await fixture.signToken({
				claims: { email: 'eve@other.example', hd: 'other.example' },
			}),
		});

		expect(response.status).toBe(401);
		const providers = (await context.internalAdapter.findAccounts(existing.id)).map(
			(account) => account.providerId,
		);
		expect(providers).toEqual(['credential']);
	});

	it('refuses to sign in when the feature is disabled, even with a valid token', async () => {
		const { auth } = await createAuth(null);

		const response = await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(response.status).toBe(401);
		expect(sessionCookieFrom(response)).toBeNull();
	});

	it('refuses to create a user when provisioning is not allowed', async () => {
		const { auth, context } = await createAuth();
		hooks.mayCreateUser.mockResolvedValue(false);

		const response = await requestSignIn(auth, { 'x-goog-iap-jwt-assertion': await fixture.signToken() });

		expect(response.status).toBe(403);
		expect(await context.internalAdapter.findUserByEmail('alice@example.com')).toBeNull();
		expect(hooks.afterSignIn).not.toHaveBeenCalled();
	});

	it('rejects a cross-site request', async () => {
		const { auth } = await createAuth();

		const response = await requestSignIn(auth, {
			origin: 'https://attacker.example',
			'x-goog-iap-jwt-assertion': await fixture.signToken(),
		});

		expect(response.status).toBe(403);
	});
});
