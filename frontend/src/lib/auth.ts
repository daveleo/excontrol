/** The settings-lock bearer token — one shared password, not a per-user login (see auth.ts on the backend). */
const TOKEN_KEY = "excontrol.settingsToken";

export const getToken = (): string | undefined => localStorage.getItem(TOKEN_KEY) || undefined;
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);
