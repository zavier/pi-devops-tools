import type { Database } from "better-sqlite3";
import type { ColumnRef, ColumnRelation, RelatedResult } from "./types";
import { RelationStore, type RelationRow } from "./relation/store";

/**
 * BFS 执行查询所用的接缝。由调用方提供
 * （QueryRunner 把它接到连接管理器）——让 RelationGraph
 * 保持数据库无关、可用 stub 测试。
 */
export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ columns: string[]; rows: Record<string, any>[]; elapsed: string }>;

function key(c: ColumnRef): string {
  return `${c.schema}.${c.table}.${c.column}${c.condition ? ":" + c.condition : ""}`;
}

interface ForwardEntry {
  source: ColumnRef;
  targets: { target: ColumnRef; relationType: string }[];
}

export class RelationGraph {
  private store: RelationStore;
  // 供 BFS 遍历的内存前向图，每次变更后重建
  private forward = new Map<string, ForwardEntry>();

  constructor(db: Database) {
    this.store = new RelationStore(db);
    this.rebuildForward();
  }

  /** 从存储重建内存前向图。 */
  private rebuildForward(): void {
    this.forward.clear();
    const all = this.store.list();
    for (const row of all) {
      const source: ColumnRef = {
        schema: row.schema,
        table: row.table_name,
        column: row.column_name,
        condition: row.condition || undefined,
      };
      const target: ColumnRef = {
        schema: row.ref_schema,
        table: row.ref_table,
        column: row.ref_column,
      };
      this.addToForward(source, target, row.relation_type);
    }
  }

  private addToForward(source: ColumnRef, target: ColumnRef, relationType: string): void {
    const sk = key(source);
    const tk = key(target);

    // 前向
    const fwdEntry = this.forward.get(sk) ?? { source, targets: [] };
    if (!fwdEntry.targets.some((e) => key(e.target) === tk)) {
      fwdEntry.targets.push({ target, relationType });
      this.forward.set(sk, fwdEntry);
    }

    // 反向（双向）
    const revEntry = this.forward.get(tk) ?? { source: target, targets: [] };
    if (!revEntry.targets.some((e) => key(e.target) === sk)) {
      revEntry.targets.push({ target: source, relationType });
      this.forward.set(tk, revEntry);
    }
  }

  // ── CRUD（经存储）──────────────────────────────────────

  upsert(source: ColumnRef, target: ColumnRef, relationType = "MANY_TO_ONE"): RelationRow {
    const rel: Omit<ColumnRelation, "id"> = {
      schema: source.schema,
      table: source.table,
      column: source.column,
      condition: source.condition ?? "",
      refSchema: target.schema,
      refTable: target.table,
      refColumn: target.column,
      relationType,
    };

    const row = this.store.upsert(rel);
    // 全量重建：upsert 可能更新既有边的 relationType，
    // 而 addToForward 的去重会跳过它。
    this.rebuildForward();
    return row;
  }

  remove(source: ColumnRef, target: ColumnRef): boolean {
    const deleted = this.store.deleteByColumns(
      source.schema,
      source.table,
      source.column,
      source.condition ?? "",
      target.schema,
      target.table,
      target.column,
    );
    if (deleted) this.rebuildForward();
    return deleted;
  }

  removeById(id: number): boolean {
    const deleted = this.store.delete(id);
    if (deleted) this.rebuildForward();
    return deleted;
  }

  list(schema?: string, table?: string): RelationRow[] {
    return this.store.list({ schema, table });
  }

  listAll(): RelationRow[] {
    return this.store.list();
  }

  // ── BFS 遍历 ─────────────────────────────────────────────

  getDirectRelations(schema: string, table: string): Map<ColumnRef, ColumnRef[]> {
    const result = new Map<ColumnRef, ColumnRef[]>();
    for (const entry of this.forward.values()) {
      if (entry.source.schema !== schema || entry.source.table !== table) continue;
      if (entry.targets.length === 0) continue;
      result.set(
        entry.source,
        entry.targets.map((t) => t.target),
      );
    }
    return result;
  }

  async bfsQuery(
    query: QueryFn,
    schema: string,
    table: string,
    rows: Record<string, any>[],
    maxDepth: number,
    limit: number,
  ): Promise<RelatedResult[]> {
    const results: RelatedResult[] = [];
    const visited = new Set<string>();
    const queue: Array<{
      schema: string;
      table: string;
      rows: Record<string, any>[];
      depth: number;
      joinPath: string;
    }> = [{ schema, table, rows, depth: 0, joinPath: "" }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= maxDepth) continue;

      const refs = this.getDirectRelations(item.schema, item.table);

      // 收集本层所有查询，以便并行执行。
      // 每个查询目标都从当前表独立可达。
      interface QueryTask {
        targetCol: ColumnRef;
        sourceCol: ColumnRef;
        values: unknown[];
        joinPath: string;
        depth: number;
      }
      const batch: QueryTask[] = [];

      for (const [sourceCol, targetCols] of refs) {
        const values = item.rows
          .map((r) => r[sourceCol.column])
          .filter((v) => v !== null && v !== undefined);
        if (values.length === 0) continue;

        for (const targetCol of targetCols) {
          const tk = key(targetCol);
          if (visited.has(tk)) continue;
          visited.add(tk);

          const joinPath = item.joinPath
            ? `${item.joinPath} -> ${sourceCol.table}.${sourceCol.column} -> ${targetCol.table}.${targetCol.column}`
            : `${sourceCol.table}.${sourceCol.column} -> ${targetCol.table}.${targetCol.column}`;

          batch.push({
            targetCol,
            sourceCol,
            values,
            joinPath,
            depth: item.depth + 1,
          });
        }
      }

      // 并行发起本层所有查询。
      const settled = await Promise.allSettled(
        batch.map((t) =>
          (async () => {
            let whereClause = `\`${t.targetCol.column}\` IN (?)`;
            if (t.targetCol.condition) {
              whereClause = `(${whereClause}) AND (${t.targetCol.condition})`;
            }
            const sql = `SELECT * FROM \`${t.targetCol.schema}\`.\`${t.targetCol.table}\` WHERE ${whereClause} LIMIT ${limit}`;
            return query(sql, [t.values]).then((qr) => ({ ...qr, ...t }));
          })(),
        ),
      );

      for (const s of settled) {
        if (s.status !== "fulfilled") continue;
        const { rows: resultRows, elapsed, targetCol, joinPath, depth: nextDepth } = s.value;
        const columns = resultRows.length > 0 ? Object.keys(resultRows[0]) : [];

        results.push({
          schema: targetCol.schema,
          table: targetCol.table,
          columns,
          rows: resultRows,
          rowCount: resultRows.length,
          joinPath,
          elapsed,
        });

        queue.push({
          schema: targetCol.schema,
          table: targetCol.table,
          rows: resultRows,
          depth: nextDepth,
          joinPath,
        });
      }
    }

    return results;
  }

  // ── 外键同步 ──────────────────────────────────────────

  mergeForeignKeys(newRelations: ColumnRelation[]): number {
    let added = 0;
    const allExisting = this.store.list();

    for (const r of newRelations) {
      const exists = allExisting.some(
        (ex) =>
          ex.schema === r.schema &&
          ex.table_name === r.table &&
          ex.column_name === r.column &&
          ex.condition === (r.condition ?? "") &&
          ex.ref_schema === r.refSchema &&
          ex.ref_table === r.refTable &&
          ex.ref_column === r.refColumn,
      );
      if (!exists) {
        this.store.upsert({
          schema: r.schema,
          table: r.table,
          column: r.column,
          condition: r.condition ?? "",
          refSchema: r.refSchema,
          refTable: r.refTable,
          refColumn: r.refColumn,
          relationType: r.relationType ?? "MANY_TO_ONE",
        });
        added++;
      }
    }

    if (added > 0) this.rebuildForward();
    return added;
  }
}
