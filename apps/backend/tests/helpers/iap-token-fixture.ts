import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, type JWTVerifyGetKey, SignJWT } from 'jose';

export const TEST_IAP_AUDIENCE = '/projects/123456789/locations/us-central1/services/nao';
export const TEST_IAP_ISSUER = 'https://cloud.google.com/iap';
export const TEST_IAP_KEY_ID = 'test-iap-key';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface IapTokenFixture {
	keySet: JWTVerifyGetKey;
	signToken: (overrides?: IapTokenOverrides) => Promise<string>;
	signTokenWithUntrustedKey: (overrides?: IapTokenOverrides) => Promise<string>;
}

export interface IapTokenOverrides {
	claims?: JWTPayload & Record<string, unknown>;
	issuedAt?: number;
	expiresAt?: number;
	audience?: string;
	issuer?: string;
}

/** Locally generated ES256 keys standing in for Google's published IAP key set. */
export async function createIapTokenFixture(): Promise<IapTokenFixture> {
	const trusted = await generateKeyPair('ES256', { extractable: true });
	const untrusted = await generateKeyPair('ES256', { extractable: true });
	const publicJwk = { ...(await exportJWK(trusted.publicKey)), kid: TEST_IAP_KEY_ID, alg: 'ES256', use: 'sig' };

	return {
		keySet: createLocalJWKSet({ keys: [publicJwk] }),
		signToken: (overrides) => signIapToken(trusted.privateKey, overrides),
		signTokenWithUntrustedKey: (overrides) => signIapToken(untrusted.privateKey, overrides),
	};
}

export function nowInSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

async function signIapToken(privateKey: SigningKey, overrides: IapTokenOverrides = {}): Promise<string> {
	const issuedAt = overrides.issuedAt ?? nowInSeconds();
	return new SignJWT({
		email: 'alice@example.com',
		hd: 'example.com',
		...overrides.claims,
	})
		.setProtectedHeader({ alg: 'ES256', kid: TEST_IAP_KEY_ID })
		.setIssuer(overrides.issuer ?? TEST_IAP_ISSUER)
		.setAudience(overrides.audience ?? TEST_IAP_AUDIENCE)
		.setSubject((overrides.claims?.sub as string | undefined) ?? 'accounts.google.com:1001')
		.setIssuedAt(issuedAt)
		.setExpirationTime(overrides.expiresAt ?? issuedAt + 600)
		.sign(privateKey);
}
