import fs from "node:fs";
import path from "node:path";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type { ColumnRef, ColumnRelation, RelatedResult } from "./types";

function key(c: ColumnRef): string {
  return `${c.schema}.${c.table}.${c.column}${c.condition ? ":" + c.condition : ""}`;
}

function relationKey(r: ColumnRelation): string {
  return `${r.schema}.${r.table}.${r.column}@${r.condition || ""}->${r.refSchema}.${r.refTable}.${r.refColumn}`;
}

interface ForwardEntry {
  source: ColumnRef;
  targets: { target: ColumnRef; relationType: string }[];
}

export class RelationGraph {
  // string key -> { source, targets[] } — stores original source ref for Map-key identity
  private forward = new Map<string, ForwardEntry>();
  // all relations for list/serialize
  private relations: ColumnRelation[] = [];

  register(source: ColumnRef, target: ColumnRef, relationType = "MANY_TO_ONE"): void {
    const sk = key(source);
    const tk = key(target);

    // Forward: source -> target
    const fwdEntry = this.forward.get(sk) ?? { source, targets: [] };
    if (!fwdEntry.targets.some(e => key(e.target) === tk)) {
      fwdEntry.targets.push({ target, relationType });
      this.forward.set(sk, fwdEntry);
    }

    // Reverse: target -> source (bidirectional)
    const revEntry = this.forward.get(tk) ?? { source: target, targets: [] };
    if (!revEntry.targets.some(e => key(e.target) === sk)) {
      revEntry.targets.push({ target: source, relationType });
      this.forward.set(tk, revEntry);
    }

    // Track in relations list
    const rel: ColumnRelation = {
      schema: source.schema,
      table: source.table,
      column: source.column,
      condition: source.condition ?? "",
      refSchema: target.schema,
      refTable: target.table,
      refColumn: target.column,
      relationType,
    };
    if (!this.relations.some(r => relationKey(r) === relationKey(rel))) {
      this.relations.push(rel);
    }
  }

  remove(source: ColumnRef, target: ColumnRef): boolean {
    const sk = key(source);
    const tk = key(target);

    // Remove forward
    const fwdEntry = this.forward.get(sk);
    if (fwdEntry) {
      const idx = fwdEntry.targets.findIndex(e => key(e.target) === tk);
      if (idx >= 0) fwdEntry.targets.splice(idx, 1);
    }

    // Remove reverse
    const revEntry = this.forward.get(tk);
    if (revEntry) {
      const idx = revEntry.targets.findIndex(e => key(e.target) === sk);
      if (idx >= 0) revEntry.targets.splice(idx, 1);
    }

    // Remove from relations list
    const before = this.relations.length;
    this.relations = this.relations.filter(r =>
      !(r.schema === source.schema && r.table === source.table &&
        r.column === source.column && r.condition === (source.condition ?? "") &&
        r.refSchema === target.schema && r.refTable === target.table &&
        r.refColumn === target.column)
    );

    return before !== this.relations.length;
  }

  getDirectRelations(schema: string, table: string): Map<ColumnRef, ColumnRef[]> {
    const result = new Map<ColumnRef, ColumnRef[]>();
    for (const entry of this.forward.values()) {
      if (entry.source.schema !== schema || entry.source.table !== table) continue;
      if (entry.targets.length === 0) continue;
      result.set(entry.source, entry.targets.map(t => t.target));
    }
    return result;
  }

  list(schema?: string, table?: string): ColumnRelation[] {
    return this.relations.filter(r => {
      if (schema && r.schema !== schema) return false;
      if (table && r.table !== table) return false;
      return true;
    });
  }

  async bfsQuery(
    pool: Pool,
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

          const start = Date.now();
          const valueList = values.map(v =>
            typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v)
          ).join(", ");

          let whereClause = `${targetCol.column} IN (${valueList})`;
          if (targetCol.condition) {
            whereClause = `(${whereClause}) AND (${targetCol.condition})`;
          }

          const query = `SELECT * FROM ${targetCol.table} WHERE ${whereClause} LIMIT ${limit}`;
          const [resultRows] = await pool.query<RowDataPacket[]>(query);

          const elapsed = `${((Date.now() - start) / 1000).toFixed(3)}s`;

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

  loadFromFile(cwd?: string): void {
    const baseDir = cwd ?? process.cwd();
    const filePath = path.join(baseDir, ".pi", "table-relations.json");

    if (!fs.existsSync(filePath)) return;

    const raw = fs.readFileSync(filePath, "utf-8");
    const data: ColumnRelation[] = JSON.parse(raw);

    for (const r of data) {
      this.register(
        { schema: r.schema, table: r.table, column: r.column, condition: r.condition || undefined },
        { schema: r.refSchema, table: r.refTable, column: r.refColumn },
        r.relationType
      );
    }
  }

  saveToFile(cwd?: string): void {
    const baseDir = cwd ?? process.cwd();
    const filePath = path.join(baseDir, ".pi", "table-relations.json");
    fs.writeFileSync(filePath, JSON.stringify(this.relations, null, 2), "utf-8");
  }

  mergeForeignKeys(newRelations: ColumnRelation[]): number {
    let added = 0;
    for (const r of newRelations) {
      const exists = this.relations.some(existing =>
        existing.schema === r.schema && existing.table === r.table &&
        existing.column === r.column && existing.refSchema === r.refSchema &&
        existing.refTable === r.refTable && existing.refColumn === r.refColumn
      );
      if (!exists) {
        this.register(
          { schema: r.schema, table: r.table, column: r.column, condition: r.condition || undefined },
          { schema: r.refSchema, table: r.refTable, column: r.refColumn },
          r.relationType
        );
        added++;
      }
    }
    return added;
  }
}
