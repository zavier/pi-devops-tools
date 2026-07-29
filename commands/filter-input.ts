/**
 * Pure keyboard-input reducers for custom TUI components.
 *
 * pi-tui's handleInput() receives RAW terminal bytes (\x7f, \r, \x1b)
 * or CSI-u sequences (Kitty keyboard protocol). Use matchesKey(data, keyId)
 * to decode special keys — NEVER compare data directly against byte
 * literals, because Kitty protocol sends multi-byte escape sequences.
 *
 * These reducers encapsulate that contract so they can be unit-tested
 * independently with raw byte inputs.
 */

import { matchesKey, Key } from "@earendil-works/pi-tui";

// ── Filter reducer (for fuzzy table picker) ─────────────────────

export interface FilterResult {
  filterText: string;
  action: "filter" | "navigate" | "none";
}

/**
 * Pure reducer for the fuzzy table picker filter bar.
 *
 * Accumulates printable characters, deletes on Backspace/Delete,
 * passes through navigation keys (Enter, Esc, arrows, etc.).
 */
export function createFilterReducer(): {
  handleKey: (data: string) => FilterResult;
  getFilterText: () => string;
} {
  let filterText = "";

  function handleKey(data: string): FilterResult {
    // Special keys first — before printable char check, because
    // some raw bytes (e.g. DEL = 127) are ≥ 32 and would otherwise
    // be misclassified as printable.
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      filterText = filterText.slice(0, -1);
      return { filterText, action: "filter" };
    }

    // Printable characters: single code-point, code ≥ 32
    const code = data.charCodeAt(0);
    if (data.length === 1 && code >= 32) {
      filterText += data;
      return { filterText, action: "filter" };
    }

    // Navigation keys (enter, esc, arrows, tab) — pass through unchanged
    return { filterText, action: "navigate" };
  }

  return { handleKey, getFilterText: () => filterText };
}

// ── Password reducer (for masked input) ─────────────────────────

export interface PasswordResult {
  password: string;
  action: "submit" | "cancel" | "update" | "none";
}

/**
 * Pure reducer for masked password entry.
 *
 * Enter → submit, Escape → cancel, Backspace → delete last char,
 * printable characters → append.
 */
export function createPasswordReducer(): {
  handleKey: (data: string) => PasswordResult;
  getPassword: () => string;
} {
  let password = "";

  function handleKey(data: string): PasswordResult {
    if (matchesKey(data, Key.enter)) {
      return { password, action: "submit" };
    }

    if (matchesKey(data, Key.escape)) {
      return { password, action: "cancel" };
    }

    if (matchesKey(data, Key.backspace)) {
      password = password.slice(0, -1);
      return { password, action: "update" };
    }

    const code = data.charCodeAt(0);
    if (data.length === 1 && code >= 32) {
      password += data;
      return { password, action: "update" };
    }

    return { password, action: "none" };
  }

  return { handleKey, getPassword: () => password };
}
