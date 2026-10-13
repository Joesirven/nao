import { useQuery } from '@tanstack/react-query';

import { fetchIapStatus } from '@/lib/iap-auth';

export function useIapStatus() {
	return useQuery({ queryKey: ['iap-status'], queryFn: fetchIapStatus, retry: false, staleTime: 0 });
}
