import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: {
		NAO_IAP_ADMIN_EMAILS: 'Admin@Example.com, second-admin@example.com' as string | undefined,
		NAO_IAP_DEFAULT_ROLE: 'viewer' as 'admin' | 'user' | 'viewer',
	},
	getFirstOrganization: vi.fn(),
	initializeDefaultOrganizationForFirstUser: vi.fn(),
	addUserToDefaultOrganizationIfExists: vi.fn(),
	addUserToDefaultProjectIfExists: vi.fn(),
	addOrgMemberIfMissing: vi.fn(),
	updateOrgMemberRole: vi.fn(),
	getDefaultProject: vi.fn(),
	updateProjectMemberRole: vi.fn(),
}));

vi.mock('../src/env', () => ({ env: mocks.env, isCloud: false }));
vi.mock('../src/queries/organization.queries', () => ({
	getFirstOrganization: mocks.getFirstOrganization,
	initializeDefaultOrganizationForFirstUser: mocks.initializeDefaultOrganizationForFirstUser,
	addUserToDefaultOrganizationIfExists: mocks.addUserToDefaultOrganizationIfExists,
	addUserToDefaultProjectIfExists: mocks.addUserToDefaultProjectIfExists,
	addOrgMemberIfMissing: mocks.addOrgMemberIfMissing,
	updateOrgMemberRole: mocks.updateOrgMemberRole,
}));
vi.mock('../src/queries/project.queries', () => ({
	getDefaultProject: mocks.getDefaultProject,
	updateProjectMemberRole: mocks.updateProjectMemberRole,
}));

import { mayCreateIapUser, syncIapUserMembership } from '../src/services/iap-user-provisioning.service';

const ORGANIZATION = { id: 'org-1' };
const PROJECT = { id: 'project-1' };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.env.NAO_IAP_ADMIN_EMAILS = 'Admin@Example.com, second-admin@example.com';
	mocks.env.NAO_IAP_DEFAULT_ROLE = 'viewer';
	mocks.getFirstOrganization.mockResolvedValue(ORGANIZATION);
	mocks.getDefaultProject.mockResolvedValue(PROJECT);
});

describe('mayCreateIapUser', () => {
	it('refuses an unlisted email on a fresh install so the first arrival never becomes administrator', async () => {
		mocks.getFirstOrganization.mockResolvedValue(null);

		await expect(mayCreateIapUser('alice@example.com')).resolves.toBe(false);
	});

	it('allows a listed administrator to create the first account', async () => {
		mocks.getFirstOrganization.mockResolvedValue(null);

		await expect(mayCreateIapUser('admin@example.com')).resolves.toBe(true);
	});

	it('allows any verified user once the organization exists', async () => {
		await expect(mayCreateIapUser('alice@example.com')).resolves.toBe(true);
	});

	it('refuses everyone on a fresh install when no administrator is listed', async () => {
		mocks.env.NAO_IAP_ADMIN_EMAILS = undefined;
		mocks.getFirstOrganization.mockResolvedValue(null);

		await expect(mayCreateIapUser('admin@example.com')).resolves.toBe(false);
	});
});

describe('syncIapUserMembership', () => {
	it('gives a new unlisted user the least-privileged role by default', async () => {
		await syncIapUserMembership({ userId: 'user-1', email: 'alice@example.com', isNewUser: true });

		expect(mocks.addUserToDefaultOrganizationIfExists).toHaveBeenCalledWith('user-1', 'viewer');
		expect(mocks.addUserToDefaultProjectIfExists).toHaveBeenCalledWith('user-1', 'viewer');
		expect(mocks.initializeDefaultOrganizationForFirstUser).not.toHaveBeenCalled();
		expect(mocks.updateOrgMemberRole).not.toHaveBeenCalled();
		expect(mocks.updateProjectMemberRole).not.toHaveBeenCalled();
	});

	it('uses the configured default role for new users', async () => {
		mocks.env.NAO_IAP_DEFAULT_ROLE = 'user';

		await syncIapUserMembership({ userId: 'user-1', email: 'alice@example.com', isNewUser: true });

		expect(mocks.addUserToDefaultProjectIfExists).toHaveBeenCalledWith('user-1', 'user');
	});

	it('leaves the memberships of an existing unlisted user untouched', async () => {
		await syncIapUserMembership({ userId: 'user-1', email: 'alice@example.com', isNewUser: false });

		expect(mocks.addUserToDefaultOrganizationIfExists).not.toHaveBeenCalled();
		expect(mocks.addUserToDefaultProjectIfExists).not.toHaveBeenCalled();
		expect(mocks.addOrgMemberIfMissing).not.toHaveBeenCalled();
		expect(mocks.updateOrgMemberRole).not.toHaveBeenCalled();
		expect(mocks.updateProjectMemberRole).not.toHaveBeenCalled();
	});

	it('makes a listed email administrator of the organization and default project on first sign-in', async () => {
		await syncIapUserMembership({ userId: 'admin-1', email: 'admin@example.com', isNewUser: true });

		expect(mocks.initializeDefaultOrganizationForFirstUser).toHaveBeenCalledWith('admin-1');
		expect(mocks.addUserToDefaultProjectIfExists).toHaveBeenCalledWith('admin-1', 'admin');
		expect(mocks.addOrgMemberIfMissing).toHaveBeenCalledWith({ orgId: 'org-1', userId: 'admin-1', role: 'admin' });
		expect(mocks.updateOrgMemberRole).toHaveBeenCalledWith('org-1', 'admin-1', 'admin');
		expect(mocks.updateProjectMemberRole).toHaveBeenCalledWith('project-1', 'admin-1', 'admin');
		expect(mocks.addUserToDefaultOrganizationIfExists).not.toHaveBeenCalled();
	});

	it('promotes an existing user whose email is listed', async () => {
		await syncIapUserMembership({ userId: 'user-2', email: 'second-admin@example.com', isNewUser: false });

		expect(mocks.updateOrgMemberRole).toHaveBeenCalledWith('org-1', 'user-2', 'admin');
		expect(mocks.updateProjectMemberRole).toHaveBeenCalledWith('project-1', 'user-2', 'admin');
	});

	it('does not treat a listed address as a domain or substring match', async () => {
		await syncIapUserMembership({ userId: 'user-3', email: 'admin@example.com.evil', isNewUser: true });
		await syncIapUserMembership({ userId: 'user-4', email: 'notadmin@example.com', isNewUser: true });

		expect(mocks.updateOrgMemberRole).not.toHaveBeenCalled();
		expect(mocks.addUserToDefaultProjectIfExists).toHaveBeenCalledWith('user-3', 'viewer');
		expect(mocks.addUserToDefaultProjectIfExists).toHaveBeenCalledWith('user-4', 'viewer');
	});
});
