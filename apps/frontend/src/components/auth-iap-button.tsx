import GoogleIcon from '@/components/icons/google-icon.svg';
import { AuthSocialButton } from '@/components/ui/button';
import { signInWithIap } from '@/lib/iap-auth';

interface IapSignInButtonProps {
	email: string;
	label: string | null;
	onSignedIn: () => void;
	onError: (message: string) => void;
	lastUsed?: boolean;
}

export function IapSignInButton({ email, label, onSignedIn, onError, lastUsed }: IapSignInButtonProps) {
	const handleClick = async () => {
		const { error } = await signInWithIap();
		if (error) {
			onError(error);
			return;
		}
		onSignedIn();
	};

	return (
		<div className='grid gap-1.5'>
			<AuthSocialButton
				icon={GoogleIcon}
				label={label ?? `Continue as ${email}`}
				onClick={() => void handleClick()}
				lastUsed={lastUsed}
			/>
			{label && <p className='text-center text-xs text-muted-foreground'>Signed in to Google as {email}</p>}
		</div>
	);
}
