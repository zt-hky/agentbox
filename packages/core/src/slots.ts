export const MIN_SLOT = 1;
export const MAX_SLOT = 4999;

function assertSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
    throw new RangeError(`slot must be an integer in ${MIN_SLOT}..${MAX_SLOT}, got ${slot}`);
  }
}

export function tenantUid(slot: number): number {
  assertSlot(slot);
  return 200000 + slot;
}

export function subuidStart(slot: number): number {
  assertSlot(slot);
  return 300000000 + slot * 65536;
}

export function ports(slot: number): { t3: number; code: number } {
  assertSlot(slot);
  return { t3: 20000 + 2 * slot, code: 20001 + 2 * slot };
}
