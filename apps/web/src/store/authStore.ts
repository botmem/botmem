import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@botmem/shared';

interface AuthState {
  user: User | null;
  login: (email: string, password: string) => boolean;
  signup: (email: string, password: string, name: string) => void;
  logout: () => void;
  completeOnboarding: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      login: (email: string, _password: string) => {
        const stored = localStorage.getItem('botmem-users');
        const users: User[] = stored ? JSON.parse(stored) : [];
        const found = users.find((u) => u.email === email);
        if (found) {
          set({ user: found });
          return true;
        }
        return false;
      },
      signup: (email: string, _password: string, name: string) => {
        const user: User = {
          id: crypto.randomUUID(),
          email,
          name,
          onboarded: false,
        };
        const stored = localStorage.getItem('botmem-users');
        const users: User[] = stored ? JSON.parse(stored) : [];
        users.push(user);
        localStorage.setItem('botmem-users', JSON.stringify(users));
        set({ user });
      },
      logout: () => set({ user: null }),
      completeOnboarding: () =>
        set((state) => {
          if (!state.user) return state;
          const updated = { ...state.user, onboarded: true };
          const stored = localStorage.getItem('botmem-users');
          const users: User[] = stored ? JSON.parse(stored) : [];
          const idx = users.findIndex((u) => u.id === updated.id);
          if (idx >= 0) users[idx] = updated;
          localStorage.setItem('botmem-users', JSON.stringify(users));
          return { user: updated };
        }),
    }),
    { name: 'botmem-auth' }
  )
);
