export type FieldDraft = { value: unknown; baseValue: unknown; version: number; saved: boolean };

export function sameFieldValue(a: unknown, b: unknown) {
  return JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
}

export function reportFieldValue(value: unknown) {
  return Array.isArray(value) || (value !== null && typeof value === "object") ? JSON.stringify(value) : String(value ?? "");
}

// Drafts are independent of focus and lock ownership. Neither a poll nor a late
// save for another field is allowed to replace unsaved input.
export class DocumentDrafts {
  entries: Record<string, FieldDraft> = {};
  private version = 0;

  change(key: string, value: unknown, baseValue: unknown) {
    this.entries[key] = {
      value, baseValue: this.entries[key]?.baseValue ?? baseValue ?? "",
      version: ++this.version, saved: false,
    };
  }

  acknowledge(key: string, sent: FieldDraft) {
    const current = this.entries[key];
    if (!current) return;
    // Typing may have continued while the request was in flight.
    this.entries[key] = { ...current, baseValue: sent.value, saved: current.version === sent.version };
  }

  reconcile(remote: Record<string, unknown>) {
    for (const [key, draft] of Object.entries(this.entries)) {
      if (draft.saved && sameFieldValue(remote[key], draft.value)) delete this.entries[key];
    }
  }

  values(remote: Record<string, unknown>) {
    return { ...remote, ...Object.fromEntries(Object.entries(this.entries).map(([key, draft]) => [key, draft.value])) };
  }

  get pendingKeys() { return Object.keys(this.entries).filter((key) => !this.entries[key].saved); }

  restore(raw: string | null) {
    if (!raw) return;
    try {
      const entries: unknown = JSON.parse(raw);
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
      for (const [key, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== "object" || !("value" in entry) || !("baseValue" in entry)) continue;
        this.entries[key] = { value: entry.value, baseValue: entry.baseValue, version: ++this.version, saved: false };
      }
    } catch { /* A corrupt browser draft must not stop the editor loading. */ }
  }
}
