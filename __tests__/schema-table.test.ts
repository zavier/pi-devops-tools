import { describe, it, expect } from "vitest";
import { formatSchemaMarkdown } from "../formatting/schema-table";
import type { SqlRow } from "../types";

const columns: SqlRow[] = [
  {
    COLUMN_NAME: "id",
    COLUMN_TYPE: "bigint(20)",
    IS_NULLABLE: "NO",
    COLUMN_KEY: "PRI",
    COLUMN_DEFAULT: null,
    EXTRA: "auto_increment",
    COLUMN_COMMENT: "",
  },
  {
    COLUMN_NAME: "user_id",
    COLUMN_TYPE: "bigint(20)",
    IS_NULLABLE: "YES",
    COLUMN_KEY: "MUL",
    COLUMN_DEFAULT: null,
    EXTRA: "",
    COLUMN_COMMENT: "下单用户",
  },
];

const indexes: SqlRow[] = [
  { INDEX_NAME: "PRIMARY", COLUMN_NAME: "id", NON_UNIQUE: 0, SEQ_IN_INDEX: 1 },
  { INDEX_NAME: "idx_user", COLUMN_NAME: "user_id", NON_UNIQUE: 1, SEQ_IN_INDEX: 1 },
];

describe("formatSchemaMarkdown", () => {
  it("renders a header, a column table, and grouped indexes", () => {
    const out = formatSchemaMarkdown("orders", "shop", columns, indexes);

    expect(out).toContain("### orders — shop");
    expect(out).toContain("| 列 | 类型 | Null | Key | 默认 | Extra | 注释 |");
    expect(out).toContain("| id | bigint(20) |  | PK |  | auto_increment |  |");
    expect(out).toContain("| user_id | bigint(20) | YES | FK |  |  | 下单用户 |");
    expect(out).toContain("**索引（2）**");
    expect(out).toContain("- `PRIMARY` [UNIQUE]: id");
    expect(out).toContain("- `idx_user`: user_id");
  });

  it("escapes pipe characters in comments so the table doesn't break", () => {
    const cols: SqlRow[] = [
      {
        COLUMN_NAME: "type",
        COLUMN_TYPE: "varchar(10)",
        IS_NULLABLE: "YES",
        COLUMN_KEY: "",
        COLUMN_DEFAULT: null,
        EXTRA: "",
        COLUMN_COMMENT: "a|b",
      },
    ];
    const out = formatSchemaMarkdown("t", "db", cols, []);
    expect(out).toContain("a\\|b");
  });
});
