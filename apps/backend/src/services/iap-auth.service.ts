import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth';
import { APIError } from 'better-auth';
import { createAuthEndpoint, formCsrfMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { revokeUnprovenAccountAccess } from 'better-auth/db';
import { handleOAuthUserInfo } from 'better-auth/oauth2';
import type { JWTVerifyGetKey } from 'jose';

import { env, isCloud } from '../env';
import { logger } from '../utils/logger';
import { IAP_PROVIDER_ID, IAP_SIGN_IN_PATH } from '../utils/utils';
import { IAP_ASSERTION_HEADER, type IapIdentity, verifyIapAssertion } from './iap-token.service';

export interface IapConfig {
	audience: string;
	allowedDomains: string[];
	buttonLabel: string | null;
	hidePasswordLogin: boolean;
}

export interface IapStatus {
	enabled: boolean;
	email: string | null;
	buttonLabel: string | null;
	hidePasswordLogin: boolean;
}

export interface IapAuthOptions {
	config: IapConfig | null;
	keySet: JWTVerifyGetKey;
	mayCreateUser: (email: string) => Promise<boolean>;
	afterSignIn: (signIn: { userId: string; email: string; isNewUser: boolean }) => Promise<void>;
}

const SIGN_IN_UNAVAILABLE_MESSAGE = 'Identity-Aware Proxy sign-in is not available for this request.';

/** Reads the Identity-Aware Proxy settings; the feature stays off unless both audience and domains are set. */
export function getIapConfig(): IapConfig | null {
	const allowedDomains = parseList(env.NAO_IAP_ALLOWED_DOMAINS);
	if (!env.NAO_IAP_AUDIENCE || isCloud) {
		return null;
	}
	if (allowedDomains.length === 0) {
		logger.warn('NAO_IAP_AUDIENCE is set without NAO_IAP_ALLOWED_DOMAINS; Identity-Aware Proxy sign-in stays off', {
			source: 'system',
		});
		return null;
	}

	return {
		audience: env.NAO_IAP_AUDIENCE,
		allowedDomains,
		buttonLabel: env.NAO_IAP_BUTTON_LABEL ?? null,
		hidePasswordLogin: env.NAO_IAP_HIDE_PASSWORD_LOGIN,
	};
}

export function isIapAdministratorEmail(email: string): boolean {
	return parseList(env.NAO_IAP_ADMIN_EMAILS).includes(email.toLowerCase());
}

/**
 * Better-auth plugin that turns a verified Identity-Aware Proxy identity into a nao session.
 * The status endpoint only tells the login page whether to offer the button; the sign-in
 * endpoint verifies the signed header again and never trusts anything the browser sends.
 */
export function iapAuth(options: IapAuthOptions) {
	return {
		id: 'iap',
		endpoints: {
			getIapStatus: createAuthEndpoint('/iap/status', { method: 'GET' }, async (ctx) => {
				return ctx.json(await getIapStatus(ctx.headers, options));
			}),
			signInWithIap: createAuthEndpoint(
				IAP_SIGN_IN_PATH,
				{ method: 'POST', use: [formCsrfMiddleware] },
				async (ctx) => {
					const identity = await requireVerifiedIdentity(ctx.headers, options);
					const session = await signInIdentity(ctx, identity, options);
					await setSessionCookie(ctx, session);
					return ctx.json({ user: { id: session.user.id, email: session.user.email } });
				},
			),
		},
	} satisfies BetterAuthPlugin;
}

async function getIapStatus(headers: Headers | undefined, options: IapAuthOptions): Promise<IapStatus> {
	if (!options.config) {
		return { enabled: false, email: null, buttonLabel: null, hidePasswordLogin: false };
	}

	const identity = await verifyRequestIdentity(headers, options.config, options.keySet);
	return {
		enabled: true,
		email: identity?.email ?? null,
		buttonLabel: options.config.buttonLabel,
		hidePasswordLogin: options.config.hidePasswordLogin,
	};
}

async function requireVerifiedIdentity(headers: Headers | undefined, options: IapAuthOptions): Promise<IapIdentity> {
	const identity = options.config ? await verifyRequestIdentity(headers, options.config, options.keySet) : null;
	if (!identity) {
		throw new APIError('UNAUTHORIZED', { message: SIGN_IN_UNAVAILABLE_MESSAGE });
	}
	return identity;
}

/**
 * Links the identity to the nao user with the same email, or creates one when allowed. A local
 * user whose email was never verified loses its password and sessions first, so whoever registered
 * that address before its owner arrived through the proxy keeps no access to the account.
 */
async function signInIdentity(ctx: GenericEndpointContext, identity: IapIdentity, options: IapAuthOptions) {
	const existing = await ctx.context.internalAdapter.findUserByEmail(identity.email);
	if (!existing && !(await options.mayCreateUser(identity.email))) {
		throw new APIError('FORBIDDEN', {
			message: 'nao has not been set up yet. An administrator listed in NAO_IAP_ADMIN_EMAILS must sign in first.',
		});
	}
	if (existing && !existing.user.emailVerified) {
		await claimUnverifiedUser(ctx, existing.user.id);
	}

	const result = await handleOAuthUserInfo(ctx, {
		userInfo: {
			id: identity.subject,
			email: identity.email,
			emailVerified: true,
			name: identity.email.split('@')[0],
		},
		account: { providerId: IAP_PROVIDER_ID, accountId: identity.subject },
		isTrustedProvider: true,
		trustProviderByName: false,
	});
	if (result.error !== null) {
		throw new APIError('UNAUTHORIZED', { message: result.error });
	}

	await options.afterSignIn({
		userId: result.data.user.id,
		email: identity.email,
		isNewUser: result.isRegister,
	});
	return result.data;
}

async function claimUnverifiedUser(ctx: GenericEndpointContext, userId: string): Promise<void> {
	await revokeUnprovenAccountAccess(ctx, userId);
	await ctx.context.internalAdapter.updateUser(userId, { emailVerified: true, requiresPasswordReset: false });
}

async function verifyRequestIdentity(
	headers: Headers | undefined,
	config: IapConfig,
	keySet: JWTVerifyGetKey,
): Promise<IapIdentity | null> {
	const assertion = headers?.get(IAP_ASSERTION_HEADER);
	const verification = await verifyIapAssertion(assertion, {
		audience: config.audience,
		allowedDomains: config.allowedDomains,
		keySet,
	});
	if (verification.verified) {
		return verification.identity;
	}
	if (assertion) {
		logger.warn('Rejected Identity-Aware Proxy assertion', {
			source: 'system',
			context: { reason: verification.reason },
		});
	}
	return null;
}

function parseList(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}
