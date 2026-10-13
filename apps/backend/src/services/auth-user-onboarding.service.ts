import * as orgQueries from '../queries/organization.queries';
import { IAP_PROVIDER_ID } from '../utils/utils';
import { isSocialProviderMicrosoft } from './microsoft-auth.service';
import { isSocialProviderOidc } from './oidc-auth.service';

/**
 * Identity-Aware Proxy users are provisioned by `syncIapUserMembership` after sign-in instead, so the
 * first of them never becomes administrator just by arriving first.
 */
export async function initializeSelfHostedUserAfterCreation(
	userId: string,
	providerId: string | undefined,
	ssoEnabled: boolean,
): Promise<void> {
	if (providerId === IAP_PROVIDER_ID) {
		return;
	}

	await orgQueries.initializeDefaultOrganizationForFirstUser(userId);

	const isSsoProvider = ssoEnabled && (isSocialProviderMicrosoft(providerId) || isSocialProviderOidc(providerId));
	if (isSsoProvider) {
		await orgQueries.addUserToDefaultOrganizationIfExists(userId);
		return;
	}

	if (providerId === 'google' || providerId === 'github' || providerId === 'gitlab') {
		await orgQueries.addUserToDefaultProjectIfExists(userId);
	}
}
