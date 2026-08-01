#!/usr/bin/env node
/**
 * 测试环境初始化/清理脚本 — 为 pi 数据库扩展的端到端测试生成唯一库对。
 *
 * 每次运行生成两个命名唯一的数据库(主测试库 + 跨库测试库), 执行
 * schema.sql(占位符 __MAIN_DB__ / __REF_DB__ 自动替换)完成建表与种子,
 * 并把环境记录写入 ~/.pi/database/test-env.json, 供 --cleanup 一键销毁。
 *
 * 用法:
 *   node init-env.mjs                 # 生成新库对并初始化 (默认连接 local)
 *   node init-env.mjs --connection qa # 用指定连接
 *   node init-env.mjs --prefix demo   # 自定义库名前缀 (默认 test)
 *   node init-env.mjs --json          # 输出 JSON (供脚本消费)
 *   node init-env.mjs --cleanup       # 按记录文件销毁上一轮库对并删除记录
 *   node init-env.mjs --preflight     # 只做环境自检(节点/依赖/连接/版本/权限), 不建库
 *   node init-env.mjs --skip-preflight # 跳过初始化前的自动自检
 *
 * 环境要求(详见 docs/testing/requirements.md):
 *   - Node.js ≥ 20
 *   - 本脚本必须在扩展仓库内运行(node_modules 中的 js-yaml/mysql2)
 *   - 目标 MySQL ≥ 8.0(递归 CTE / JSON / ENUM), 连接账号需建库/删库/建表权限
 *
 * 密码只从 connections.yaml 加载后直接传给 mysql2, 不打印、不落盘。
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { createConnection } from "mysql2/promise";

// ── 常量 ────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".pi", "database", "connections.yaml");
const ENV_RECORD_PATH = join(homedir(), ".pi", "database", "test-env.json");
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_SQL = join(HERE, "schema.sql");
const DEFAULT_PREFIX = "test";

// ── 参数解析 ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hasFlag = (name) => args.includes(name);

const connectionId = getArg("--connection") ?? "local";
const prefix = getArg("--prefix") ?? DEFAULT_PREFIX;
const schemaPath = getArg("--schema") ?? DEFAULT_SCHEMA_SQL;
const asJson = hasFlag("--json");
const doCleanup = hasFlag("--cleanup");
const preflightOnly = hasFlag("--preflight");
const skipPreflight = hasFlag("--skip-preflight");

if (!/^[A-Za-z0-9_]+$/.test(prefix)) {
  die("prefix 只允许字母/数字/下划线", 2);
}

// ── 工具 ────────────────────────────────────────────────────────────────

function die(msg, code = 1) {
  console.error(`init-env: ${msg}`);
  process.exit(code);
}

function out(obj) {
  if (asJson) console.log(JSON.stringify(obj));
  else console.log(`init-env: ${obj}`);
}

const resolveEnv = (v) => v.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");

function uniqueName(base) {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d+Z$/, "");
  const rand = Math.random().toString(16).slice(2, 6);
  return `${base}_${ts}_${rand}`;
}

function loadRecord() {
  if (!existsSync(ENV_RECORD_PATH)) return null;
  return JSON.parse(readFileSync(ENV_RECORD_PATH, "utf8"));
}

async function connect(conn) {
  return createConnection({
    host: conn.host,
    port: conn.port,
    user: conn.username,
    password: resolveEnv(conn.password),
    multipleStatements: true,
  });
}

// ── 预检 ────────────────────────────────────────────────────────────────

async function preflight(conn) {
  const checks = [];
  const ok = (name, detail) => checks.push({ name, pass: true, detail });
  const fail = (name, detail, fix) => checks.push({ name, pass: false, detail, fix });

  // 1. Node.js 版本
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor >= 20) {
    ok("Node.js ≥ 20", process.version);
  } else {
    fail("Node.js ≥ 20", `当前 ${process.version}`, "升级 Node.js 至 20+ (推荐 22/24 LTS)");
  }

  // 2. 依赖可解析 (js-yaml / mysql2)
  for (const dep of ["js-yaml", "mysql2/promise"]) {
    try {
      await import(dep);
      ok(`依赖 ${dep}`, "可解析");
    } catch {
      fail(`依赖 ${dep}`, "无法解析", "在扩展仓库根目录执行 npm install");
    }
  }

  // 3. 配置文件与连接定义
  if (!existsSync(CONFIG_PATH)) {
    fail(
      "connections.yaml",
      "文件不存在",
      `创建 ${CONFIG_PATH} (模板见 docs/testing/requirements.md)`,
    );
  } else {
    ok("connections.yaml", CONFIG_PATH);
    const file = parseYaml(readFileSync(CONFIG_PATH, "utf8"));
    if (!file.connections?.[connectionId]) {
      fail(
        `连接 ${connectionId}`,
        "配置中不存在",
        `可用: ${Object.keys(file.connections ?? {}).join(", ") || "(无)"}; 或用 --connection 指定其他连接`,
      );
    } else {
      ok(`连接 ${connectionId}`, "配置存在");
    }
  }

  // 4-6. 连接可达 / 版本 / 建删库权限 (依赖前 3 项通过)
  if (checks.every((c) => c.pass)) {
    let db;
    try {
      db = await connect(conn);
      ok("连接可达", `${conn.host}:${conn.port} (${conn.username})`);
    } catch (err) {
      fail(
        "连接可达",
        `连接失败: ${err.code ?? err.message}`,
        "检查主机/端口/账号密码, 或 MySQL 服务是否启动",
      );
    }

    if (db) {
      try {
        const [[{ v }]] = await db.query("SELECT VERSION() AS v");
        const isMaria = /mariadb/i.test(v);
        if (
          (!isMaria && parseInt(v, 10) >= 8) ||
          (isMaria && parseInt(v, 10) >= 10 && parseInt(v.split(".")[1], 10) >= 2)
        ) {
          ok("MySQL 版本", `${v}${isMaria ? " (MariaDB, 兼容)" : ""}`);
        } else {
          fail(
            "MySQL 版本",
            `当前 ${v}`,
            "需 MySQL 8.0+ (schema.sql 使用递归 CTE/JSON), 推荐官方镜像 mysql:8",
          );
        }
      } catch (err) {
        fail("MySQL 版本", `查询失败: ${err.message}`);
      }

      // 权限探测: 建库 → 建表 → 删库
      const probe = `preflight_${Date.now()}`;
      try {
        await db.query(`CREATE DATABASE IF NOT EXISTS \`${probe}\``);
        await db.query(`CREATE TABLE \`${probe}\`.t (id INT)`);
        await db.query(`DROP DATABASE \`${probe}\``);
        ok("建/删库权限", "CREATE DATABASE / CREATE TABLE / DROP DATABASE 均可用");
      } catch (err) {
        fail(
          "建/删库权限",
          `探测失败: ${err.message}`,
          "测试账号需要建库/建表/删库权限, 最小授权 SQL 见 docs/testing/requirements.md",
        );
      }
      await db.end().catch(() => {});
    }
  }

  return checks;
}

// ── 清理 ────────────────────────────────────────────────────────────────

async function cleanup() {
  const rec = loadRecord();
  if (!rec) {
    out("没有环境记录, 无需清理");
    return;
  }
  const { connection, mainDb, refDb } = rec;
  const file = parseYaml(readFileSync(CONFIG_PATH, "utf8"));
  const conn = file.connections[connection];
  if (!conn) die(`连接 '${connection}' 不存在, 无法清理 ${mainDb}/${refDb}`);

  const db = await connect(conn);
  for (const name of [mainDb, refDb]) {
    await db.query(`DROP DATABASE IF EXISTS \`${name}\``);
    out(`已删除数据库 ${name}`);
  }
  await db.end();
  rmSync(ENV_RECORD_PATH);
  out(`环境记录已清除 (${connection})`);
}

// ── 初始化 ──────────────────────────────────────────────────────────────

async function init() {
  const file = parseYaml(readFileSync(CONFIG_PATH, "utf8"));
  const conn = file.connections[connectionId];
  if (!conn)
    die(
      `连接 '${connectionId}' 不存在 (connections.yaml 中可用的: ${Object.keys(file.connections).join(", ")})`,
    );

  const mainDb = uniqueName(`${prefix}_main`);
  const refDb = uniqueName(`${prefix}_ref`);
  out(`连接: ${connectionId}; 主库: ${mainDb}; 跨库: ${refDb}`);

  let sql = readFileSync(schemaPath, "utf8");
  sql = sql.replaceAll("__MAIN_DB__", mainDb).replaceAll("__REF_DB__", refDb);
  // 剥注释再分句 (-- 行注释 / /* */ 块注释)
  sql = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const db = await connect(conn);
  await db.query(`CREATE DATABASE IF NOT EXISTS \`${mainDb}\``);
  await db.query(`CREATE DATABASE IF NOT EXISTS \`${refDb}\``);

  let count = 0;
  for (const stmt of sql.split(";")) {
    const s = stmt.trim();
    if (!s) continue;
    await db.query(s);
    count++;
  }
  await db.end();

  const record = {
    connection: connectionId,
    mainDb,
    refDb,
    prefix,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(ENV_RECORD_PATH, JSON.stringify(record, null, 2));
  out(`初始化完成: ${count} 条语句, 共 ${mainDb} + ${refDb} (记录: ${ENV_RECORD_PATH})`);
  if (!asJson) {
    out("");
    out("下一步: 在 pi 中执行  /db switch 选择连接后, 手动切到主库 " + mainDb);
    out("        (或用 db_tables/db_query 的 database 参数直接指定)");
    out("测试结束: 运行  node init-env.mjs --cleanup  一键销毁");
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────

async function runPreflight(conn) {
  const checks = await preflight(conn);
  const pad = Math.max(...checks.map((c) => c.name.length)) + 2;
  for (const c of checks) {
    console.log(`${c.pass ? "✅" : "❌"} ${c.name.padEnd(pad)}${c.detail}`);
    if (!c.pass && c.fix) console.log(`   → 修复: ${c.fix}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  if (failed > 0) {
    console.error(
      `\npreflight: ${failed} 项未通过, 请修复后重试 (详见 docs/testing/requirements.md)`,
    );
    process.exit(1);
  }
  console.log(`\npreflight: 全部通过 (${checks.length} 项)`);
}

if (doCleanup) {
  await cleanup();
} else {
  const file = parseYaml(readFileSync(CONFIG_PATH, "utf8"));
  const conn = file.connections?.[connectionId];
  if (!conn)
    die(
      `连接 '${connectionId}' 不存在 (connections.yaml 中可用的: ${Object.keys(file.connections ?? {}).join(", ") || "(无)"})`,
    );
  if (preflightOnly) {
    await runPreflight(conn);
  } else {
    if (!skipPreflight) {
      const checks = await preflight(conn);
      const failed = checks.filter((c) => !c.pass);
      if (failed.length > 0) {
        console.error("preflight 未通过, 中止初始化; 可用 --skip-preflight 跳过(不推荐)");
        for (const f of failed)
          console.error(`❌ ${f.name}: ${f.detail}${f.fix ? ` → ${f.fix}` : ""}`);
        process.exit(1);
      }
      out(`自检通过 (${checks.length} 项)`);
    }
    await init();
  }
}
