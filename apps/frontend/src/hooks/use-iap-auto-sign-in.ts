import { useEffect, useRef, useState } from 'react';

import { signInWithIap } from '@/lib/iap-auth';

interface IapAutoSignInOptions {
	enabled: boolean;
	onSignedIn: () => void;
	onError: (message: string) => void;
}

/**
 * Signs in once, without a click, when the server reports a verified proxy identity and no recent
 * sign-out. Returns true while that attempt is in flight; a failure falls back to the button.
 */
export function useIapAutoSignIn({ enabled, onSignedIn, onError }: IapAutoSignInOptions): boolean {
	const hasAttempted = useRef(false);
	const [hasFailed, setHasFailed] = useState(false);

	useEffect(() => {
		if (!enabled || hasAttempted.current) {
			return;
		}
		hasAttempted.current = true;
		void signInWithIap().then(({ error }) => {
			if (error) {
				setHasFailed(true);
				onError(error);
				return;
			}
			onSignedIn();
		});
	}, [enabled, onSignedIn, onError]);

	return enabled && !hasFailed;
}
