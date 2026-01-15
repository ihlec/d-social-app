import React, { createContext, useContext } from 'react';
import { useAppAuth } from '../features/auth/useAuth';

export interface AuthContextState {
    isLoggedIn: boolean | null;
    userState: import('../types').UserState | null;
    setUserState: React.Dispatch<React.SetStateAction<import('../types').UserState | null>>;
    myIpnsKey: string;
    myPeerId: string;
    latestStateCID: string;
    setLatestStateCID: React.Dispatch<React.SetStateAction<string>>;
    loginWithKubo: (apiUrl: string, keyName: string, username?: string, password?: string) => Promise<{ success: boolean; state?: import('../types').UserState; key?: string }>;
    logout: () => void;
    isInitializeDialogOpen: boolean;
    onInitializeUser: () => void;
    onRetryLogin: () => void;
    
    // Session Unlock
    isSessionLocked: boolean;
    unlockSession: (password: string) => Promise<boolean>;
}

export const AuthContext = createContext<AuthContextState | null>(null);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const auth = useAppAuth();

    return (
        <AuthContext.Provider value={auth}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuthContext = () => {
    const context = useContext(AuthContext);
    if (!context) throw new Error("useAuthContext must be used within AuthProvider");
    return context;
};
