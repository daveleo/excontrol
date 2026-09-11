/**
 * Settings-lock contract. This is a single shared password gating the config surface
 * (device setup, preset & schedule editing) on a trusted LAN — not a multi-user login.
 * Zone/power/preset-apply control is never gated, so any phone on the network can still
 * run the room.
 */
export interface AuthStatus {
  locked: boolean;
}

export interface LoginBody {
  password: string;
}
export interface LoginResponse {
  token: string;
}

/** Setting a password for the first time needs no current one; changing/removing one does. */
export interface SetPasswordBody {
  currentPassword?: string;
  /** null / omitted removes the lock entirely */
  newPassword?: string | null;
}
