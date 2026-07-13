const BILLING_DRAFT_KEY = 'botmem.v2.billing-draft';

export interface BillingDraft {
  readonly email: string;
  readonly workspaceName: string;
}

export function rememberBillingDraft(storage: Storage, draft: BillingDraft): void {
  try {
    storage.setItem(BILLING_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Checkout must still proceed when browser storage is blocked.
  }
}

export function loadBillingDraft(storage: Storage): BillingDraft | null {
  let value: string | null;
  try {
    value = storage.getItem(BILLING_DRAFT_KEY);
  } catch {
    return null;
  }
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'email' in parsed &&
      'workspaceName' in parsed &&
      typeof parsed.email === 'string' &&
      typeof parsed.workspaceName === 'string'
    ) {
      return { email: parsed.email, workspaceName: parsed.workspaceName };
    }
  } catch {
    // Ignore invalid browser-local state; the server remains the source of truth.
  }
  return null;
}

/** Reads the browser storage capability itself inside the guard as privacy modes may deny it. */
export function rememberBrowserBillingDraft(draft: BillingDraft): void {
  try {
    rememberBillingDraft(window.sessionStorage, draft);
  } catch {
    // Checkout is server-authoritative and must not depend on browser storage.
  }
}

export function loadBrowserBillingDraft(): BillingDraft | null {
  try {
    return loadBillingDraft(window.sessionStorage);
  } catch {
    return null;
  }
}
