// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IapStatus } from '@/lib/iap-auth';
import { Route } from '@/routes/login';

const mocks = vi.hoisted(() => ({
	iapStatus: { data: undefined as IapStatus | undefined, isPending: false },
	search: { error: undefined as string | undefined, redirect: undefined as string | undefined },
	signInWithIap: vi.fn(),
	assign: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
	createFileRoute: () => (options: Record<string, unknown>) => ({
		...options,
		useSearch: () => mocks.search,
	}),
	Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
	useNavigate: () => vi.fn(),
	useRouter: () => ({ history: { push: vi.fn() } }),
}));

vi.mock('@tanstack/react-query', () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) => ({
		data: queryKey[0] === 'system.getPublicConfig' ? { enableUserLogin: true, enableUserSignup: false } : undefined,
		isPending: false,
	}),
}));

vi.mock('@/main', () => {
	const procedure = (path: string[]): unknown =>
		new Proxy(() => undefined, {
			get: (_target, key: string) =>
				key === 'queryOptions' ? () => ({ queryKey: [path.join('.')] }) : procedure([...path, key]),
		});
	return { trpc: procedure([]) };
});

vi.mock('@/hooks/use-iap-status', () => ({ useIapStatus: () => mocks.iapStatus }));
vi.mock('@/lib/iap-auth', () => ({ signInWithIap: mocks.signInWithIap }));
vi.mock('@/lib/auth-client', () => ({
	signIn: { email: vi.fn() },
	handleGoogleSignIn: vi.fn(),
	handleGithubSignIn: vi.fn(),
	handleGitlabSignIn: vi.fn(),
	handleOidcSignIn: vi.fn(),
}));
vi.mock('@/hooks/use-nao-mode', () => ({ useIsCloud: () => false }));
vi.mock('@/hooks/use-branding', () => ({
	useBranding: () => ({ enabled: false }),
	brandingAssetUrl: () => '',
	DEFAULT_BRAND_COLOR: '#000000',
}));
vi.mock('@/contexts/theme.provider', () => ({ useIsDarkMode: () => false }));
vi.mock('@/components/brand-gradient-backdrop', () => ({ BrandGradientBackdrop: () => null }));
vi.mock('@/components/auth-microsoft-button', () => ({
	useIsMicrosoftSetup: () => ({ isSetup: false, isPending: false }),
	MicrosoftSignInButton: () => null,
}));

const Login = (Route as unknown as { component: React.FC }).component;

function passwordField() {
	return document.querySelector('input[name="password"]');
}

beforeEach(() => {
	localStorage.clear();
	mocks.iapStatus = { data: undefined, isPending: false };
	mocks.search = { error: undefined, redirect: undefined };
	mocks.signInWithIap.mockReset().mockResolvedValue({ error: null });
	vi.stubGlobal('location', { ...window.location, search: '', assign: mocks.assign });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	mocks.assign.mockReset();
});

function status(overrides: Partial<IapStatus> = {}): IapStatus {
	return {
		enabled: true,
		email: 'alice@example.com',
		autoSignIn: false,
		buttonLabel: null,
		hidePasswordLogin: true,
		...overrides,
	};
}

describe('login page with Identity-Aware Proxy automatic sign-in', () => {
	it('signs in without a click and continues to the page that was asked for', async () => {
		mocks.iapStatus.data = status({ autoSignIn: true });
		mocks.search = { error: undefined, redirect: '/settings/account' };

		render(<Login />);

		await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith('/settings/account'));
		expect(mocks.signInWithIap).toHaveBeenCalledTimes(1);
		expect(passwordField()).toBeNull();
	});

	it('does not sign in automatically without a verified identity', async () => {
		mocks.iapStatus.data = status({ email: null, autoSignIn: false });

		render(<Login />);

		await Promise.resolve();
		expect(mocks.signInWithIap).not.toHaveBeenCalled();
		expect(passwordField()).not.toBeNull();
	});

	it('shows the button instead of signing in right after an explicit sign-out', async () => {
		mocks.iapStatus.data = status({ autoSignIn: false });

		render(<Login />);

		expect(screen.getByRole('button', { name: 'Continue as alice@example.com' })).toBeDefined();
		await Promise.resolve();
		expect(mocks.signInWithIap).not.toHaveBeenCalled();
	});

	it('signs in with the button after a sign-out', async () => {
		mocks.iapStatus.data = status({ autoSignIn: false });

		render(<Login />);
		fireEvent.click(screen.getByRole('button', { name: 'Continue as alice@example.com' }));

		await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith('/'));
		expect(mocks.signInWithIap).toHaveBeenCalledTimes(1);
	});

	it('falls back to the button once, without retrying, when automatic sign-in is refused', async () => {
		mocks.iapStatus.data = status({ autoSignIn: true });
		mocks.signInWithIap.mockResolvedValue({ error: 'Not allowed' });

		render(<Login />);

		expect(await screen.findByText('Not allowed')).toBeDefined();
		expect(screen.getByRole('button', { name: 'Continue as alice@example.com' })).toBeDefined();
		expect(mocks.signInWithIap).toHaveBeenCalledTimes(1);
		expect(mocks.assign).not.toHaveBeenCalled();
	});
});

describe('login page with the Identity-Aware Proxy button', () => {
	it('shows the normal page when the feature is off', () => {
		mocks.iapStatus.data = status({ enabled: false, email: null, hidePasswordLogin: false });

		render(<Login />);

		expect(passwordField()).not.toBeNull();
		expect(screen.queryByRole('button', { name: /continue as/i })).toBeNull();
		expect(mocks.signInWithIap).not.toHaveBeenCalled();
	});

	it('replaces the email and password fields with one button when a verified identity is present', () => {
		mocks.iapStatus.data = status();

		render(<Login />);

		expect(screen.getByRole('button', { name: 'Continue as alice@example.com' })).toBeDefined();
		expect(passwordField()).toBeNull();
		expect(screen.queryByText(/use email and password/i)).toBeNull();
		expect(screen.queryByText(/email and password login is disabled/i)).toBeNull();
	});

	it('shows the normal page when the feature is on but no valid identity is present', () => {
		mocks.iapStatus.data = status({ email: null });

		render(<Login />);

		expect(passwordField()).not.toBeNull();
		expect(screen.queryByRole('button', { name: /continue as/i })).toBeNull();
	});

	it('uses the configured label and still names the verified account', () => {
		mocks.iapStatus.data = status({ buttonLabel: 'Sign in with your company Google account' });

		render(<Login />);

		expect(screen.getByRole('button', { name: 'Sign in with your company Google account' })).toBeDefined();
		expect(screen.getByText('Signed in to Google as alice@example.com')).toBeDefined();
	});

	it('keeps password sign-in reachable when hiding is turned off', () => {
		mocks.iapStatus.data = status({ hidePasswordLogin: false });

		render(<Login />);

		expect(screen.getByRole('button', { name: 'Continue as alice@example.com' })).toBeDefined();
		fireEvent.click(screen.getByText(/use email and password/i));
		expect(passwordField()).not.toBeNull();
	});

	it('hides the form while the proxy status is loading', () => {
		mocks.iapStatus = { data: undefined, isPending: true };

		render(<Login />);

		expect(passwordField()).toBeNull();
	});

	it('shows the server error and stays on the page when sign-in is refused', async () => {
		mocks.iapStatus.data = status();
		mocks.signInWithIap.mockResolvedValue({ error: 'Not allowed' });

		render(<Login />);
		fireEvent.click(screen.getByRole('button', { name: 'Continue as alice@example.com' }));

		expect(await screen.findByText('Not allowed')).toBeDefined();
		expect(mocks.assign).not.toHaveBeenCalled();
	});
});
