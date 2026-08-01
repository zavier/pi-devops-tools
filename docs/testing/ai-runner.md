# AI 执行协议 — 自动回归 + 人工验证清单

> 目的: 把 test-plan.md 的执行拆成「AI 自动执行层」与「人工验证层」, 降低人工操作成本。
> **单一事实来源**: 所有用例的预期值以 test-plan.md 为准, 本协议只规定执行编排、断言规则与报告格式。
> 使用方式: 把本文件交给 pi 会话中的 AI(或直接说"按 docs/testing/ai-runner.md 执行测试"), AI 完成自动层后产出人工验证清单, 人逐项操作确认。

## 1. 职责分工

| 层      | 执行者              | 内容                                          | 是否需人在场     |
| ------- | ------------------- | --------------------------------------------- | ---------------- |
| L1 自动 | AI(工具 + bash)     | 环境初始化; A/B/C/E/F 组全部用例; H4 回归抽查 | 否               |
| L2 确认 | AI 发起, 人确认弹窗 | D 组全部(db_mutate 人工确认门禁)              | 是(或推迟到清单) |
| L3 人工 | 人                  | G 组 /db 交互命令; H1/H2 还原                 | 是               |

## 2. 执行流程(AI 视角)

```
Step 0  环境准备: bash 执行 init-env.mjs --json, 记录 {MAIN_DB} / {REF_DB}
Step 1  L1 自动: 按 §3 规则逐条执行 A/B/C/E/F + H4, 记录结果
Step 2  生成人工验证清单: 按 §4 模板, 含 L2(D 组)+ L3(G 组)全部条目, 落盘
Step 3  汇报: 自动层结果摘要 + 人工清单(自包含操作步骤), 等待人验证
Step 4  收尾(人验证完成后): H3 重建或 init-env.mjs --cleanup 销毁, 更新报告
```

- 若 Step 1 中 L1 出现环境性失败(连接失败/权限不足/库不存在): **停止并报告**, 不继续;
  用例级失败(断言不符): 标记 FAIL 并继续。
- 人工清单交付后, 环境**保留不清理**, 直到人完成 L3(清单中注明清理命令)。

## 3. L1 自动执行规则

1. **懒工具**: 先 `db_tools(query:"discover")` / `db_tools(query:"relations")` 启用, 下一轮生效。
2. **目标库**: 工具调用一律显式带 `database: "{MAIN_DB}"`(跨库用例带 `{REF_DB}`), 不依赖当前工作区选择; 连接统一 `local`(或 init 输出中的连接名)。
3. **逐条执行 + 断言**: 对每个用例, 对照 test-plan.md 中同名 ID 的"预期结果"逐项核对(行数、金额、映射、报错文案), 记录格式:

   ```
   | ID | 结果 | 实际摘要 | 与预期差异 |
   | C10 | PASS | 5 组: pending 3/4048.00, paid 2/14896.00... | - |
   | C13 | FAIL | grace 显示 2 而非 0 | 行数不符 |
   ```

4. **读操作**: 一律走 `db_query`; 写操作一律走 `db_mutate`(会弹确认框, L1 不含写操作)。
5. **预期报错类用例**(C23/C30/C36/C37、E10 等): 断言"报错且文案匹配", 报错不等于 FAIL。
6. **报告落盘**: `docs/testing/run-reports/YYYY-MM-DD_HHMM.md`(目录不存在则创建), 内容 = 环境信息 + 结果表 + 人工清单。

## 4. 人工验证清单模板(由 AI 生成)

> 人按编号逐项操作: 操作 → 观察结果 → 对照期望 → 打勾。清单自包含, 无需翻阅其他文档。

```markdown
# 人工验证清单 — {日期} {环境: MAIN_DB/REF_DB}

## A. 写操作确认(L2, 在 pi 会话中让 AI 执行以下 db_mutate, 人在弹窗确认)

- [ ] D1 INSERT: 确认弹窗显示 INSERT / 目标库 {MAIN_DB} → 批准 → 验证 t_tags=5 行
      (AI 执行: db_mutate INSERT INTO t_tags(name) VALUES('回归A'))
- [ ] ...(逐条)

## B. 交互命令验证(L3, 人在 pi 终端操作)

- [ ] G0 环境接入: /db switch → 选连接 → 选 {MAIN_DB}, 状态栏显示 {MAIN_DB}
- [ ] ...(逐条)

## C. 还原与收尾(全部完成后)

- [ ] 执行 D 组还原 SQL(清单内提供), t_tags 恢复 4 行
- [ ] 清理关系 E4/E10
- [ ] node docs/testing/init-env.mjs --cleanup
```

**生成规则**: 人工清单条目必须包含 ① 操作步骤(可照做) ② 期望结果(可核对) ③ 验证方式(如何确认通过)。D 组条目附带完整 SQL 与还原 SQL。

## 5. 用例分层清单(与 test-plan.md 一一对应)

### L1 — AI 自动执行(全部只读或工具管理, 无确认弹窗)

| 组   | 用例                | 执行方式                                                                     |
| ---- | ------------------- | ---------------------------------------------------------------------------- |
| 环境 | init-env.mjs --json | bash(自动含 preflight)                                                       |
| A    | A1-A8               | db_tools / db_discover(A6/A7 断言无密码字段、含 {MAIN_DB}/{REF_DB})          |
| B    | B1-B8               | db_tables(列表/指定库/指定表)                                                |
| C    | C1-C40              | db_query(见 test-plan 各 ID 的 SQL 与预期; C20-C22 用 SHOW/DESCRIBE/EXPLAIN) |
| E    | E1-E11              | db_relation / db_list_relations(E9 注册 R2-R13; E10 用 t_nope 表)            |
| F    | F1-F6               | db_query / db_tables                                                         |
| H4   | 回归抽查            | 重跑 C10/C13/C18 与首轮结果一致                                              |

### L2 — AI 发起 + 人确认弹窗(D 组, 全部走 db_mutate)

| ID  | SQL(执行)                                                                             | 弹窗应显示                                         | 验证                                                              | 还原 SQL                                     |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| D1  | INSERT INTO t_tags(name) VALUES('回归A')                                              | INSERT / {MAIN_DB} / 无警告                        | t_tags=5 行                                                       | DELETE FROM t_tags WHERE name='回归A'        |
| D2  | INSERT INTO t_tags(name) VALUES('回归B'),('回归C')                                    | 同上, 多行                                         | t_tags=6 行(按顺序执行时 D1 已还原, 基准 4 行; 若未还原则为 7 行) | DELETE ... IN ('回归B','回归C')              |
| D4  | UPDATE t_tags SET name='热卖' WHERE name='热销'                                       | UPDATE / 无警告                                    | affected=1, 热卖存在                                              | UPDATE ... SET name='热销' WHERE name='热卖' |
| D5  | UPDATE t_tags SET name='X'(无 WHERE)                                                  | **橙色警告"将影响表中所有行"**                     | 取消→数据不变                                                     | 取消即可                                     |
| D6  | DELETE FROM t_tags WHERE name='回归B'                                                 | DELETE / 无警告(若前置用例已还原, affected 可为 0) | affected=0 属正常                                                 | —                                            |
| D7  | DELETE FROM t_tags(无 WHERE)                                                          | **橙色警告**                                       | 取消→数据不变                                                     | 取消即可                                     |
| D8  | REPLACE INTO t_config(id,`key`,`value`) VALUES(4,'emoji.icon','🚀')                   | REPLACE                                            | 值变 🚀                                                           | REPLACE 还原 🎉                              |
| D11 | INSERT INTO t_config(`key`,`value`) VALUES('test.中文','测试值')                      | INSERT                                             | 回读无乱码                                                        | DELETE WHERE `key`='test.中文'               |
| D13 | db_mutate 带 database:"{REF_DB}": INSERT INTO regions(name,code) VALUES('测试','T-1') | 目标库 {REF_DB}                                    | regions=5 行                                                      | DELETE FROM regions WHERE code='T-1'         |

> D9(DDL 拒绝)/ D10(SELECT 拒绝)/ D12(取消确认): 无需批准, AI 可直接验证报错文案与数据不变(归 L1 执行, 但同样记录在人工清单备查)。

### L3 — 人工操作(G 组 /db 交互命令, 逐条照做)

| ID  | 操作                                        | 期望结果                                                            | 验证方式     |
| --- | ------------------------------------------- | ------------------------------------------------------------------- | ------------ |
| G0  | /db switch → 选连接 → 选 {MAIN_DB}          | 状态栏显示 {MAIN_DB}                                                | 观察状态栏   |
| G1  | /db                                         | 面板显示连接状态/当前库/子命令                                      | 面板出现     |
| G2  | /db switch → qa 连接                        | 当前库变为 qa 默认库                                                | 状态栏变化   |
| G3  | /db switch → local                          | 自动选中配置的 defaultDatabase(或需手动选库)                        | 观察选择流程 |
| G4  | /db switch → local → {MAIN_DB}              | 切回主测试库                                                        | 状态栏       |
| G5  | /db tables                                  | 14 张表                                                             | 列表完整     |
| G6  | /db schema t_orders                         | markdown 表格(8 列 4 索引)                                          | 表格渲染     |
| G7  | /db query t_orders → 输入 status='paid'     | 2 行; 有注册关系时询问"查询关联表?"                                 | 结果 2 行    |
| G8  | G7 中选择"📎 一起查询关联表"                | 主表 + 关联 customers/coupons/order_items/products 区块, 含关联路径 | 关联区块出现 |
| G9  | /db query t_customers → WHERE id=1 → 关联表 | 关联 profiles(1)/orders(3)/coupons(1)                               | 各关联行数   |
| G10 | /db relations discover                      | 0 条(无系统外键)                                                    | 提示 0       |
| G11 | /db relations er-diagram                    | 已注册关系图                                                        | 图示渲染     |
| G12 | /db favorite add(任一 SQL) → /db favorite   | 收藏成功并按库分组列出                                              | 列表出现     |
| G13 | /db history / /db history 订单              | 最近 20 条 / 关键词过滤                                             | 列表过滤     |
| G14 | /db off → /db on                            | 状态栏移除/恢复; 工具报错提示未启用                                 | 状态栏变化   |

## 6. 验收标准

- L1: 全部 PASS 或 FAIL 项均有差异说明, 无环境性中断。
- 人工清单: 条目自包含(操作/期望/验证), 与 test-plan.md 的 ID 可追溯。
- 收尾: D 组还原完成(t_tags=4, t_config 4 行)、测试关系已清理、环境已销毁或保留并注明。
