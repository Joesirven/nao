import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const IAP_ASSERTION_HEADER = 'x-goog-iap-jwt-assertion';

const IAP_ISSUER = 'https://cloud.google.com/iap';
const IAP_PUBLIC_KEYS_URL = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_AGE_SECONDS = 10 * 60 + 2 * CLOCK_SKEW_SECONDS;

export interface IapIdentity {
	subject: string;
	email: string;
}

export type IapVerification = { verified: true; identity: IapIdentity } | { verified: false; reason: string };

export interface IapVerificationOptions {
	audience: string;
	allowedDomains: string[];
	keySet: JWTVerifyGetKey;
	currentDate?: Date;
}

let googleIapKeySet: JWTVerifyGetKey | null = null;

/** Google's published IAP signing keys, fetched lazily and cached by jose across requests. */
export function getGoogleIapKeySet(): JWTVerifyGetKey {
	if (!googleIapKeySet) {
		googleIapKeySet = createRemoteJWKSet(new URL(IAP_PUBLIC_KEYS_URL));
	}
	return googleIapKeySet;
}

/**
 * Verify the signed `x-goog-iap-jwt-assertion` header as Google documents it: ES256 signature from
 * the published key set, exact issuer and audience, `exp` and `iat` within the allowed skew, and an
 * email whose domain and hosted domain (`hd`) are both allowed.
 */
export async function verifyIapAssertion(
	assertion: string | null | undefined,
	options: IapVerificationOptions,
): Promise<IapVerification> {
	if (!assertion) {
		return { verified: false, reason: 'missing_assertion' };
	}

	let payload: Record<string, unknown>;
	try {
		({ payload } = await jwtVerify(assertion, options.keySet, {
			algorithms: ['ES256'],
			issuer: IAP_ISSUER,
			audience: options.audience,
			clockTolerance: CLOCK_SKEW_SECONDS,
			maxTokenAge: MAX_TOKEN_AGE_SECONDS,
			requiredClaims: ['sub', 'email', 'iat', 'exp'],
			currentDate: options.currentDate,
		}));
	} catch (error) {
		return { verified: false, reason: describeVerificationError(error) };
	}

	if (payload.aud !== options.audience) {
		return { verified: false, reason: 'audience_not_exact' };
	}
	return checkIdentityClaims(payload, options.allowedDomains);
}

function checkIdentityClaims(payload: Record<string, unknown>, allowedDomains: string[]): IapVerification {
	const { sub, email, hd } = payload;
	if (typeof sub !== 'string' || !sub || typeof email !== 'string') {
		return { verified: false, reason: 'invalid_identity_claims' };
	}

	const normalizedEmail = email.trim().toLowerCase();
	const emailDomain = getEmailDomain(normalizedEmail);
	if (!emailDomain || !allowedDomains.includes(emailDomain)) {
		return { verified: false, reason: 'email_domain_not_allowed' };
	}
	if (typeof hd !== 'string' || !allowedDomains.includes(hd.toLowerCase())) {
		return { verified: false, reason: 'hosted_domain_not_allowed' };
	}

	return { verified: true, identity: { subject: sub, email: normalizedEmail } };
}

function getEmailDomain(email: string): string | null {
	const parts = email.split('@');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return null;
	}
	return parts[1];
}

function describeVerificationError(error: unknown): string {
	if (error instanceof errors.JOSEError) {
		return error.code;
	}
	return 'verification_failed';
}
