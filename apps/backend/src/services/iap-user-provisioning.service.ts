import { env } from '../env';
import * as orgQueries from '../queries/organization.queries';
import * as projectQueries from '../queries/project.queries';
import { isIapAdministratorEmail } from './iap-auth.service';

/**
 * A fresh install has no organization yet; only a listed administrator may create the first
 * account through the proxy, so the first person to arrive never becomes administrator by default.
 */
export async function mayCreateIapUser(email: string): Promise<boolean> {
	if (isIapAdministratorEmail(email)) {
		return true;
	}
	return (await orgQueries.getFirstOrganization()) !== null;
}

/**
 * Listed administrators are promoted on every sign-in. Other users only receive the default role
 * when their account is created, so linked accounts keep the memberships they already had.
 */
export async function syncIapUserMembership({
	userId,
	email,
	isNewUser,
}: {
	userId: string;
	email: string;
	isNewUser: boolean;
}): Promise<void> {
	if (isIapAdministratorEmail(email)) {
		await grantAdministrator(userId);
		return;
	}
	if (isNewUser) {
		await orgQueries.addUserToDefaultOrganizationIfExists(userId, env.NAO_IAP_DEFAULT_ROLE);
		await orgQueries.addUserToDefaultProjectIfExists(userId, env.NAO_IAP_DEFAULT_ROLE);
	}
}

async function grantAdministrator(userId: string): Promise<void> {
	await orgQueries.initializeDefaultOrganizationForFirstUser(userId);
	await orgQueries.addUserToDefaultProjectIfExists(userId, 'admin');

	const organization = await orgQueries.getFirstOrganization();
	if (!organization) {
		return;
	}
	await orgQueries.addOrgMemberIfMissing({ orgId: organization.id, userId, role: 'admin' });
	await orgQueries.updateOrgMemberRole(organization.id, userId, 'admin');

	const project = await projectQueries.getDefaultProject();
	if (project) {
		await projectQueries.updateProjectMemberRole(project.id, userId, 'admin');
	}
}
