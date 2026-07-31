/**
 * 临时复现脚本：模拟 pi 编辑器对 /db 命令参数补全的完整链路。
 * 用 pi-tui 真实的 CombinedAutocompleteProvider + db.ts 的补全逻辑。
 * 用法：node scripts/repro-autocomplete.mjs
 */
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

// 从 commands/db.ts 复制 getCompletions 核心逻辑（保持逐行一致）
const SUBCOMMANDS = [
  "switch",
  "add",
  "tables",
  "schema",
  "query",
  "history",
  "favorite",
  "relations",
  "on",
  "off",
];

function getCompletions(prefix) {
  const parts = prefix.trim().split(/\s+/);
  const hasTrailingSpace = prefix.endsWith(" ");
  const sub = parts[0];
  const partial = hasTrailingSpace ? "" : (parts[1] ?? "");

  const subSubs = {
    favorite: ["add"],
    relations: ["add", "remove", "discover", "er-diagram"],
  };

  if (parts.length === 1 && SUBCOMMANDS.includes(sub) && sub in subSubs) {
    return subSubs[sub]
      .filter((s) => s.startsWith(partial))
      .map((s) => ({ value: `${sub} ${s} `, label: s }));
  }

  if (parts.length === 1 && !hasTrailingSpace) {
    return SUBCOMMANDS.filter((s) => s.startsWith(sub)).map((s) => ({
      value: s + " ",
      label: s,
    }));
  }

  if (subSubs[sub] && parts.length === 2 && !hasTrailingSpace) {
    const filtered = subSubs[sub].filter((s) => s.startsWith(partial));
    if (filtered.length > 0) {
      return filtered.map((s) => ({ value: `${sub} ${s} `, label: s }));
    }
  }

  return null;
}

const provider = new CombinedAutocompleteProvider(
  [{ name: "db", getArgumentCompletions: getCompletions }],
  "/tmp",
  null,
);

const cases = [
  ["/db ", 4, false, "自然输入（空格后）"],
  ["/db o", 5, false, "自然输入 o"],
  ["/db on", 6, false, "自然输入 on"],
  ["/db s", 5, false, "自然输入 s（对照）"],
  ["/db switch", 9, false, "自然输入 switch（对照）"],
  ["/db o", 5, true, "Tab 强制（force）"],
  ["/db on", 6, true, "Tab 强制 on（force）"],
];

for (const [text, col, force, label] of cases) {
  const res = await provider.getSuggestions([text], 0, col, {
    signal: new AbortController().signal,
    force,
  });
  console.log(
    `${label.padEnd(22)} "${text}" force=${force} →`,
    res ? JSON.stringify(res.items.map((i) => i.value)) : "null（无候选）",
  );
}
