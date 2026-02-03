import type { LeasePayload } from "./types";
import type { CommandDef } from "./commands";

export class LeaseManager {
  private owner: string | null = null;
  private expiresTs: number = 0;

  /** Update lease from MQTT message (retained lease topic) */
  update(payload: LeasePayload): void {
    const now = Date.now();

    // If there's a current valid lease from a different owner, reject
    if (this.owner && this.owner !== payload.owner && this.expiresTs > now) {
      console.log(`[lease] Rejected lease request from ${payload.owner} — held by ${this.owner} until ${new Date(this.expiresTs).toISOString()}`);
      return;
    }

    this.owner = payload.owner;
    this.expiresTs = payload.expiresTs;
    console.log(`[lease] Lease granted to ${payload.owner} until ${new Date(payload.expiresTs).toISOString()}`);
  }

  /** Check if a lease is currently active */
  isActive(): boolean {
    return this.owner !== null && this.expiresTs > Date.now();
  }

  /** Get current lease holder (null if no active lease) */
  getOwner(): string | null {
    if (!this.isActive()) return null;
    return this.owner;
  }

  /** Get lease expiry timestamp */
  getExpiresTs(): number {
    return this.expiresTs;
  }

  /** Get current lease state for WebSocket broadcast */
  getState(): { owner: string | null; expiresTs: number; active: boolean } {
    return {
      owner: this.isActive() ? this.owner : null,
      expiresTs: this.expiresTs,
      active: this.isActive(),
    };
  }
}

/** Validate whether a client is allowed to execute a command */
export function validateLease(
  leaseManager: LeaseManager,
  clientId: string,
  isLocal: boolean,
  commandDef: CommandDef,
): { allowed: boolean; reason?: string } {
  // Non-lease commands are always allowed
  if (!commandDef.requiresLease) {
    return { allowed: true };
  }

  // Local bypass for allowed commands
  if (isLocal && commandDef.localBypass) {
    return { allowed: true };
  }

  // Check lease
  if (!leaseManager.isActive()) {
    return { allowed: false, reason: "No active lease" };
  }

  if (leaseManager.getOwner() !== clientId) {
    return { allowed: false, reason: `Lease held by ${leaseManager.getOwner()}` };
  }

  return { allowed: true };
}
