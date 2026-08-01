import { describe, it, expect } from "vitest";
import { formatSchemaMarkdown } from "../formatting/schema-table";
import type { SchemaColumn, SchemaIndex } from "../types";

const columns: SchemaColumn[] = [
  {
    name: "id",
    type: "bigint(20)",
    nullable: false,
    key: "PRI",
    default: null,
    extra: "auto_increment",
    comment: "",
  },
  {
    name: "user_id",
    type: "bigint(20)",
    nullable: true,
    key: "MUL",
    default: null,
    extra: "",
    comment: "下单用户",
  },
];

const indexes: SchemaIndex[] = [
  { name: "PRIMARY", columns: ["id"], unique: true },
  { name: "idx_user", columns: ["user_id"], unique: false },
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
    const cols: SchemaColumn[] = [
      {
        name: "type",
        type: "varchar(10)",
        nullable: true,
        key: "",
        default: null,
        extra: "",
        comment: "a|b",
      },
    ];
    const out = formatSchemaMarkdown("t", "db", cols, []);
    expect(out).toContain("a\\|b");
  });
});
