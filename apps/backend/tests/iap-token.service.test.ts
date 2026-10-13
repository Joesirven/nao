import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { verifyIapAssertion } from '../src/services/iap-token.service';
import {
	createIapTokenFixture,
	type IapTokenFixture,
	nowInSeconds,
	TEST_IAP_AUDIENCE,
	TEST_IAP_KEY_ID,
} from './helpers/iap-token-fixture';

let fixture: IapTokenFixture;

beforeAll(async () => {
	fixture = await createIapTokenFixture();
});

function verify(assertion: string | null | undefined, allowedDomains = ['example.com']) {
	return verifyIapAssertion(assertion, { audience: TEST_IAP_AUDIENCE, allowedDomains, keySet: fixture.keySet });
}

describe('verifyIapAssertion', () => {
	it('accepts a valid token and returns the normalized identity', async () => {
		const token = await fixture.signToken({ claims: { email: 'Alice@Example.com', hd: 'example.com' } });

		await expect(verify(token)).resolves.toEqual({
			verified: true,
			identity: { subject: 'accounts.google.com:1001', email: 'alice@example.com' },
		});
	});

	it('rejects a missing header', async () => {
		await expect(verify(undefined)).resolves.toEqual({ verified: false, reason: 'missing_assertion' });
		await expect(verify('')).resolves.toEqual({ verified: false, reason: 'missing_assertion' });
	});

	it('rejects a wrong audience, including the load balancer format', async () => {
		const token = await fixture.signToken({
			audience: '/projects/123456789/global/backendServices/987654321',
		});

		await expect(verify(token)).resolves.toMatchObject({
			verified: false,
			reason: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
		});
	});

	it('rejects an audience list that merely contains the expected audience', async () => {
		const token = await fixture.signToken({ audience: [TEST_IAP_AUDIENCE, 'another-audience'] });

		await expect(verify(token)).resolves.toEqual({ verified: false, reason: 'audience_not_exact' });
	});

	it('rejects a wrong issuer', async () => {
		const token = await fixture.signToken({ issuer: 'https://accounts.google.com' });

		await expect(verify(token)).resolves.toMatchObject({
			verified: false,
			reason: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
		});
	});

	it('rejects an expired token beyond the clock skew', async () => {
		const issuedAt = nowInSeconds() - 700;
		const token = await fixture.signToken({ issuedAt, expiresAt: nowInSeconds() - 31 });

		await expect(verify(token)).resolves.toEqual({ verified: false, reason: 'ERR_JWT_EXPIRED' });
	});

	it('accepts a token that expired within the clock skew', async () => {
		const token = await fixture.signToken({ issuedAt: nowInSeconds() - 600, expiresAt: nowInSeconds() - 10 });

		await expect(verify(token)).resolves.toMatchObject({ verified: true });
	});

	it('rejects a token issued in the future beyond the clock skew', async () => {
		const issuedAt = nowInSeconds() + 120;
		const token = await fixture.signToken({ issuedAt, expiresAt: issuedAt + 600 });

		await expect(verify(token)).resolves.toEqual({ verified: false, reason: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
	});

	it('rejects a token whose lifetime exceeds what IAP issues', async () => {
		const issuedAt = nowInSeconds() - 3600;
		const token = await fixture.signToken({ issuedAt, expiresAt: nowInSeconds() + 600 });

		await expect(verify(token)).resolves.toEqual({ verified: false, reason: 'ERR_JWT_EXPIRED' });
	});

	it('rejects a token signed by a key outside the published key set', async () => {
		const token = await fixture.signTokenWithUntrustedKey();

		await expect(verify(token)).resolves.toEqual({
			verified: false,
			reason: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
		});
	});

	it('rejects a token signed with a symmetric algorithm', async () => {
		const token = await new SignJWT({ email: 'alice@example.com', hd: 'example.com' })
			.setProtectedHeader({ alg: 'HS256', kid: TEST_IAP_KEY_ID })
			.setIssuer('https://cloud.google.com/iap')
			.setAudience(TEST_IAP_AUDIENCE)
			.setSubject('accounts.google.com:1001')
			.setIssuedAt()
			.setExpirationTime('10m')
			.sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough'));

		await expect(verify(token)).resolves.toEqual({ verified: false, reason: 'ERR_JOSE_ALG_NOT_ALLOWED' });
	});

	it('rejects a tampered payload', async () => {
		const [header, , signature] = (await fixture.signToken()).split('.');
		const forgedPayload = Buffer.from(
			JSON.stringify({ email: 'mallory@example.com', hd: 'example.com', sub: 'x' }),
		).toString('base64url');

		await expect(verify(`${header}.${forgedPayload}.${signature}`)).resolves.toMatchObject({ verified: false });
	});

	it('rejects a malformed header value', async () => {
		await expect(verify('not-a-token')).resolves.toMatchObject({ verified: false });
	});

	it('rejects an email from a domain that is not allowed', async () => {
		const token = await fixture.signToken({ claims: { email: 'eve@other.example', hd: 'other.example' } });

		await expect(verify(token)).resolves.toEqual({ verified: false, reason: 'email_domain_not_allowed' });
	});

	it('rejects an allowed email domain on an account outside the hosted domain', async () => {
		const consumerAccount = await fixture.signToken({ claims: { email: 'alice@example.com', hd: undefined } });
		const otherWorkspace = await fixture.signToken({ claims: { email: 'alice@example.com', hd: 'other.example' } });

		await expect(verify(consumerAccount)).resolves.toEqual({
			verified: false,
			reason: 'hosted_domain_not_allowed',
		});
		await expect(verify(otherWorkspace)).resolves.toEqual({ verified: false, reason: 'hosted_domain_not_allowed' });
	});

	it('rejects a token without an email claim', async () => {
		const token = await fixture.signToken({ claims: { email: undefined } });

		await expect(verify(token)).resolves.toMatchObject({ verified: false });
	});

	it('does not match subdomains of an allowed domain', async () => {
		const token = await fixture.signToken({ claims: { email: 'alice@sub.example.com', hd: 'sub.example.com' } });

		await expect(verify(token)).resolves.toEqual({ verified: false, reason: 'email_domain_not_allowed' });
	});
});
