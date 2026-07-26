import type { Database } from "better-sqlite3";
import type { ColumnRef, ColumnRelation, RelatedResult } from "./types";
import { RelationStore, type RelationRow } from "./relation/store";

/**
 * The seam through which BFS executes queries. Supplied by the caller
 * (QueryRunner wires it to the connection manager) — keeps RelationGraph
 * DB-agnostic and testable with a stub.
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
  // In-memory forward graph for BFS traversal, rebuilt on each mutation
  private forward = new Map<string, ForwardEntry>();

  constructor(db: Database) {
    this.store = new RelationStore(db);
    this.rebuildForward();
  }

  /** Rebuild the in-memory forward graph from the store. */
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

    // Forward
    const fwdEntry = this.forward.get(sk) ?? { source, targets: [] };
    if (!fwdEntry.targets.some(e => key(e.target) === tk)) {
      fwdEntry.targets.push({ target, relationType });
      this.forward.set(sk, fwdEntry);
    }

    // Reverse (bidirectional)
    const revEntry = this.forward.get(tk) ?? { source: target, targets: [] };
    if (!revEntry.targets.some(e => key(e.target) === sk)) {
      revEntry.targets.push({ target: source, relationType });
      this.forward.set(tk, revEntry);
    }
  }

  // ── CRUD (through store) ──────────────────────────────────────

  register(source: ColumnRef, target: ColumnRef, relationType = "MANY_TO_ONE"): RelationRow {
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

    const row = this.store.insert(rel);
    this.addToForward(source, target, relationType);
    return row;
  }

  remove(source: ColumnRef, target: ColumnRef): boolean {
    const all = this.store.list({
      schema: source.schema,
      table: source.table,
    });

    const match = all.find(r =>
      r.column_name === source.column &&
      r.condition === (source.condition ?? "") &&
      r.ref_schema === target.schema &&
      r.ref_table === target.table &&
      r.ref_column === target.column
    );

    if (!match) return false;

    this.store.delete(match.id);
    this.rebuildForward();
    return true;
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

  // ── BFS traversal ─────────────────────────────────────────────

  getDirectRelations(schema: string, table: string): Map<ColumnRef, ColumnRef[]> {
    const result = new Map<ColumnRef, ColumnRef[]>();
    for (const entry of this.forward.values()) {
      if (entry.source.schema !== schema || entry.source.table !== table) continue;
      if (entry.targets.length === 0) continue;
      result.set(entry.source, entry.targets.map(t => t.target));
    }
    return result;
  }

  async bfsQuery(
    query: QueryFn,
    schema: string,
    table: string,
    rows: Record<string, any>[],
    maxDepth: number,
    limit: number
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

      for (const [sourceCol, targetCols] of refs) {
        const values = item.rows
          .map(r => r[sourceCol.column])
          .filter(v => v != null);

        if (values.length === 0) continue;

        for (const targetCol of targetCols) {
          const tk = key(targetCol);
          if (visited.has(tk)) continue;
          visited.add(tk);

          // Parameterized IN (?) — mysql2 expands the array. No string
          // interpolation of values. Table names are schema-qualified so
          // cross-schema relations work and no USE state is required.
          let whereClause = `\`${targetCol.column}\` IN (?)`;
          if (targetCol.condition) {
            whereClause = `(${whereClause}) AND (${targetCol.condition})`;
          }

          const sql = `SELECT * FROM \`${targetCol.schema}\`.\`${targetCol.table}\` WHERE ${whereClause} LIMIT ${limit}`;
          const { rows: resultRows, elapsed } = await query(sql, [values]);

          const joinPath = item.joinPath
            ? `${item.joinPath} -> ${sourceCol.table}.${sourceCol.column} -> ${targetCol.table}.${targetCol.column}`
            : `${sourceCol.table}.${sourceCol.column} -> ${targetCol.table}.${targetCol.column}`;

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
            depth: item.depth + 1,
            joinPath,
          });
        }
      }
    }

    return results;
  }

  // ── Foreign key sync ──────────────────────────────────────────

  mergeForeignKeys(newRelations: ColumnRelation[]): number {
    let added = 0;
    const allExisting = this.store.list();

    for (const r of newRelations) {
      const exists = allExisting.some(ex =>
        ex.schema === r.schema && ex.table_name === r.table &&
        ex.column_name === r.column && ex.condition === (r.condition ?? "") &&
        ex.ref_schema === r.refSchema && ex.ref_table === r.refTable &&
        ex.ref_column === r.refColumn
      );
      if (!exists) {
        this.store.insert({
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
