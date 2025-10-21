// src/hooks/useAppPeers.ts
import { useEffect } from 'react';
import { UserState, OnlinePeer } from '../../types';
import { fetchOnlinePeers } from '../../../src/api/peersFinder.ts';

interface UseAppPeersArgs {
	isLoggedIn: boolean;
	myIpnsKey: string;
	userState: UserState | null;
	setOtherUsers: React.Dispatch<React.SetStateAction<OnlinePeer[]>>;
}

/**
 * Manages fetching the list of other online peers.
 */
export const useAppPeers = ({
	isLoggedIn,
	myIpnsKey,
	userState,
	setOtherUsers,
}: UseAppPeersArgs) => {

	useEffect(() => {
		if (!isLoggedIn || !myIpnsKey || !userState?.profile?.name) return;
		
		let intervalId: number;
		const currentUserName = userState.profile.name;
		
		const fetchPeers = async () => {
			try {
				setOtherUsers(await fetchOnlinePeers(myIpnsKey, currentUserName));
			} catch (e) { console.error("Fetch peers error:", e); }
		};
		
		intervalId = window.setInterval(fetchPeers, 30000); 
		fetchPeers(); // Initial fetch
		
		return () => clearInterval(intervalId);
	}, [isLoggedIn, myIpnsKey, userState?.profile?.name, setOtherUsers]);

	// This hook just manages an effect and has no return value.
};