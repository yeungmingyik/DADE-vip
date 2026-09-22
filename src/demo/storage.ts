import { DemoError, type DemoState } from "./domain";

export const DEMO_STORAGE_KEY = "sspc-vip:browser-demo:v1";

export function readDemoStorage(): DemoState | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(DEMO_STORAGE_KEY);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1) throw new DemoError("INVALID_STATE", 409);
    const state = value as DemoState;
    if (![state.members, state.stores, state.gifts, state.purchases, state.redemptions, state.activity, state.staff, state.rules, state.audit, state.refunds, state.challenges, state.registrations].every(Array.isArray) || !state.sessions || !state.idempotency) throw new DemoError("INVALID_STATE", 409);
    return state;
  } catch (error) {
    if (error instanceof DemoError) throw error;
    throw new DemoError("INTERNAL_ERROR", 500);
  }
}

export async function withDemoStorage<T>(initial: () => DemoState, operation: (state: DemoState) => { state: DemoState; value: T }, signal?: AbortSignal | null): Promise<T> {
  if (typeof window === "undefined" || typeof navigator === "undefined" || !navigator.locks) throw new DemoError("INTERNAL_ERROR", 500);
  return navigator.locks.request(DEMO_STORAGE_KEY, { mode: "exclusive", ...(signal ? { signal } : {}) }, () => {
    signal?.throwIfAborted();
    const stored = readDemoStorage();
    const state = stored ?? initial();
    const output = operation(state);
    if (!stored || output.state !== state) {
      try { window.localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(output.state)); }
      catch { throw new DemoError("INTERNAL_ERROR", 500); }
    }
    return output.value;
  });
}
