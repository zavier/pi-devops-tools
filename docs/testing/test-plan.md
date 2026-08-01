# pi 数据库扩展 — 端到端测试用例集

> **执行方式**: 本文件是单一事实来源(预期值)。实际执行请用 [ai-runner.md](ai-runner.md) —
> 由 AI 自动执行 L1 层(A/B/C/E/F), 并生成人工验证清单(L2 写操作确认 + L3 交互命令), 人逐项打勾即可。
> 目的: 系统性验证 pi 的 db 扩展(pi-devops-tools)全部能力,覆盖工具调用、只读策略、
> 写操作确认、关系管理与 BFS 联表、输出格式与边界情况。
> 配套脚本(docs/testing/ 下): `init-env.mjs` 每轮自动生成命名唯一的库对并初始化,
> `schema.sql` 为表结构与种子数据(库名占位符,由脚本替换)。

## 1. 测试环境

> 环境要求、全新机器部署步骤、连接配置模板与 FAQ 见 [requirements.md](requirements.md)。
> **动态环境**: 每轮测试运行 `init-env.mjs` 生成两个命名唯一的数据库
> (主测试库 `{MAIN_DB}` + 跨库测试库 `{REF_DB}`, 形如 `test_main_20260801_123456_ab12`),
> 不依赖任何固定库, 多轮测试互不干扰。

| 项           | 值                                                              |
| ------------ | --------------------------------------------------------------- |
| MySQL        | 8.0.46 (localhost:3306)                                         |
| 主测试库     | `{MAIN_DB}`(每轮动态生成, 连接 `local`, 环境 default)           |
| 跨库测试库   | `{REF_DB}`(每轮动态生成)                                        |
| 连接数       | 示例: 5 个配置(local / qa / dd / ddd / ddddd), 均指向同一实例   |
| 常驻工具     | db_query, db_tables, db_mutate, db_tools                        |
| 懒加载工具   | db_discover, db_list_relations, db_relation(经 `db_tools` 启用) |
| 默认查询上限 | 无 LIMIT 的 SELECT 自动追加 `LIMIT 100`                         |
| 输出上限     | 50KB / 2000 行                                                  |

### 1.1 环境初始化与清理

```bash
# 初始化(生成唯一库对 + 建表 + 种子数据, 环境记录写入 ~/.pi/database/test-env.json)
node docs/testing/init-env.mjs
# 或指定连接 / 自定义前缀 / 输出 JSON(供脚本消费)
node docs/testing/init-env.mjs --connection local --prefix demo --json
# 测试结束, 一键销毁上一轮库对
node docs/testing/init-env.mjs --cleanup
```

初始化后, 用例中的 `{MAIN_DB}` / `{REF_DB}` 即本次生成的库名。
工具调用可用 `database` 参数直接指定(如 `db_tables(database:"{MAIN_DB}")`),
交互命令则先 `/db switch` 切换到主库(见 G0)。

## 2. 表清单(动态主库 {MAIN_DB} 共 14 张; 若在含原有 test_users 的固定库则为 15 张)

| 表                  | 行数 | 设计意图                                                      |
| ------------------- | ---- | ------------------------------------------------------------- |
| test_users          | 10   | 原有基础表(基线)                                              |
| t_categories        | 6    | 自引用树(parent_id → id)                                      |
| t_products          | 10   | 1:N 子表; ENUM 状态; emoji 商品名; 软删除状态                 |
| t_customers         | 8    | 主实体; 跨库引用 region_id; 软删除 deleted_at; JSON 友好      |
| t_coupons           | 6    | 可空引用(customer_id NULL = 公共券)                           |
| t_orders            | 10   | 核心事实表; 金额与明细+券核算一致                             |
| t_order_items       | 11   | N:M 桥接(order_id × product_id, 复合唯一)                     |
| t_customer_profiles | 5    | 1:1(customer_id 即主键); avatar_url 全 NULL; preferences JSON |
| t_tags              | 4    | 字典表                                                        |
| t_product_tags      | 8    | N:M 桥接(复合主键)                                            |
| t_audit_logs        | 151  | 无主键(id 有重复); 测 LIMIT 追加与输出截断                    |
| t_documents         | 3    | LONGTEXT 100KB; 测 50KB 输出截断                              |
| t_orders_archive    | 3    | 与 t_orders 同构; 测 UNION; status 全相同测列折叠             |
| 2024_sales          | 8    | 数字开头表名, 需反引号                                        |
| t_config            | 4    | 保留字列名 `key`; 中文/emoji 值                               |

另有 `{REF_DB}.regions`(4 行)用于跨库查询测试。

## 3. 逻辑关系地图(无外键约束, 用 `db_relation` 注册)

| #   | 源(多/子)                       | 目标(一/父)     | 类型        | 备注                        |
| --- | ------------------------------- | --------------- | ----------- | --------------------------- |
| R1  | t_customers.region_id           | regions.id      | MANY_TO_ONE | 跨库({REF_DB})⚠️ 见 §6 限制 |
| R2  | t_customer_profiles.customer_id | t_customers.id  | ONE_TO_ONE  | 逻辑 1:1                    |
| R3  | t_orders.customer_id            | t_customers.id  | MANY_TO_ONE | 核心链路                    |
| R4  | t_orders.coupon_id              | t_coupons.id    | MANY_TO_ONE | 可空                        |
| R5  | t_order_items.order_id          | t_orders.id     | MANY_TO_ONE | 核心链路                    |
| R6  | t_order_items.product_id        | t_products.id   | MANY_TO_ONE | 核心链路                    |
| R7  | t_products.category_id          | t_categories.id | MANY_TO_ONE |                             |
| R8  | t_categories.parent_id          | t_categories.id | MANY_TO_ONE | 自引用                      |
| R9  | t_product_tags.product_id       | t_products.id   | MANY_TO_ONE |                             |
| R10 | t_product_tags.tag_id           | t_tags.id       | MANY_TO_ONE |                             |
| R11 | t_coupons.customer_id           | t_customers.id  | MANY_TO_ONE | 可空                        |
| R12 | t_orders_archive.customer_id    | t_customers.id  | MANY_TO_ONE | 归档                        |
| R13 | 2024_sales.product_id           | t_products.id   | MANY_TO_ONE | 数字表名                    |

注册后 BFS 可达的链路示例: customers → orders → order_items → products → categories; customers → profiles; customers → coupons; products ⇄ tags。

## 4. 种子数据核算基准(测试预期的数值依据)

- 订单状态分布: pending 3 / paid 2 / shipped 2 / completed 1 / cancelled 2
- 按状态聚合: pending=4048.00, paid=14896.00, shipped=962.00, completed=1299.00, cancelled=1197.00(Σ=22402.00)
- 客户订单数: alice 3 / bob 1 / carol 2 / dave 1 / erin 1 / frank 1 / grace 0 / hank 1
- 客户-地区: alice→上海, bob→北京, carol→广东, dave→NULL, erin→上海, frank→北京, grace→加州, hank→NULL
- 有订单明细的商品: 除 ThinkPad X1(id=4) 外的全部 9 个商品
- 无标签商品: 6/7/8; 无资料的客户: 4/6/7; 无明细订单: ORD-2025-0006

---

## 5. 测试用例

### A. 工具加载与发现(db_tools / db_discover)

| ID  | 场景                 | 操作                             | 预期结果                                                                                                     |
| --- | -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A1  | 懒工具加载 discover  | `db_tools(query:"discover")`     | 启用 1 个工具: db_discover(下一轮可用); db_list_relations / db_relation 未启用                               |
| A2  | 懒工具加载 relations | `db_tools(query:"relations")`    | 启用 db_list_relations + db_relation                                                                         |
| A3  | 空查询加载全部       | `db_tools(query:"")`             | 启用全部 3 个懒工具                                                                                          |
| A4  | 无关关键词           | `db_tools(query:"favorite")`     | 无匹配, 返回空                                                                                               |
| A5  | 模糊关键词           | `db_tools(query:"relationship")` | 命中 relations 类关键词(子串匹配), 启用关系工具                                                              |
| A6  | 列出全部连接         | `db_discover()`                  | 5 个连接(local/qa/dd/ddd/ddddd), 含环境分组与 defaultDatabase; **密码不出现(脱敏)**; 标注当前选中(连接 + 库) |
| A7  | 指定连接发现库       | `db_discover(connection:"qa")`   | 返回该连接上的数据库列表, 包含当轮生成的 {MAIN_DB} / {REF_DB}(同一实例的库都会列出)                          |
| A8  | 不存在的连接         | `db_discover(connection:"nope")` | 报错, 不崩溃                                                                                                 |

### B. 表结构(db_tables)

| ID  | 场景              | 操作                                     | 预期结果                                                                                                                  |
| --- | ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| B1  | 列表模式          | `db_tables()`                            | 当前库 14 张表, 名称完整(含 `2024_sales`)                                                                                 |
| B2  | 指定数据库        | `db_tables(database:"{REF_DB}")`         | 仅 regions 1 张                                                                                                           |
| B3  | 索引齐全的表      | `db_tables(table:"t_orders")`            | 8 列 + 5 索引: PRIMARY(UNIQUE), uk_order_no(UNIQUE), idx_customer_id, idx_status, idx_created_at; 类型/Null/默认/注释完整 |
| B4  | 复合索引/复合主键 | `db_tables(table:"t_product_tags")`      | 主键为 (product_id, tag_id) 复合; 另有 idx_tag_id                                                                         |
| B5  | 无主键表          | `db_tables(table:"t_audit_logs")`        | 显示 5 列, 索引仅 idx_operator_id, **无 PRIMARY**                                                                         |
| B6  | 1:1 表            | `db_tables(table:"t_customer_profiles")` | customer_id 标记 PK, 含 JSON 类型列                                                                                       |
| B7  | 不存在的表        | `db_tables(table:"t_nope")`              | 实测: **不报错**, 返回空结构(0 列 0 索引)                                                                                 |
| B8  | 列注释展示        | `db_tables(table:"t_customers")`         | 注释含"跨库"、"软删除时间"等, 索引 5 个(2 UNIQUE + 3 普通)                                                                |

### C. 只读查询(db_query)

| ID  | 场景               | 操作(SQL)                                                                                                                              | 预期结果                                                                                  |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| C1  | 基础全表           | `SELECT * FROM t_customers`                                                                                                            | 8 行, 10 列; 输出含 Connection/Database/Rows/耗时信息                                     |
| C2  | 单条件             | `SELECT * FROM t_orders WHERE status='pending'`                                                                                        | 3 行(ORD-...0003/0006/0007)                                                               |
| C3  | IN 多值            | `... WHERE status IN ('paid','shipped')`                                                                                               | 4 行                                                                                      |
| C4  | LIKE 中文          | `SELECT * FROM t_products WHERE name LIKE '%iPhone%'`                                                                                  | 1 行(iPhone 15)                                                                           |
| C5  | 范围               | `SELECT * FROM t_products WHERE price BETWEEN 100 AND 500`                                                                             | 4 行(199/299/399/499)                                                                     |
| C6  | 排序+显式 LIMIT    | `SELECT order_no,total_amount FROM t_orders ORDER BY total_amount DESC LIMIT 3`                                                        | 3 行: 7999.00 → 6897.00 → 3949.00(**LIMIT 尊重, 不重复追加**)                             |
| C7  | **LIMIT 注入**     | `SELECT * FROM t_audit_logs`(151 行, 无 LIMIT)                                                                                         | 恰好返回 100 行(自动追加 LIMIT 100)                                                       |
| C8  | 显式 LIMIT 超量    | `SELECT * FROM t_audit_logs LIMIT 200`                                                                                                 | 返回全部 151 行                                                                           |
| C9  | LIMIT 0            | `SELECT * FROM t_products LIMIT 0`                                                                                                     | 0 行, 无报错                                                                              |
| C10 | 聚合 GROUP BY      | `SELECT status, COUNT(*) cnt, SUM(total_amount) total FROM t_orders GROUP BY status`                                                   | 5 组, 数值见 §4(22402.00 合计可交叉验证)                                                  |
| C11 | HAVING             | `SELECT customer_id, COUNT(*) c, SUM(total_amount) s FROM t_orders GROUP BY customer_id HAVING c>=2`                                   | 2 行: customer 1(3 单/7990.00), customer 3(2 单/1997.00)                                  |
| C12 | INNER JOIN         | `SELECT o.order_no, c.username FROM t_orders o JOIN t_customers c ON o.customer_id=c.id`                                               | 10 行                                                                                     |
| C13 | LEFT JOIN + 聚合   | `SELECT c.username, COUNT(o.id) cnt FROM t_customers c LEFT JOIN t_orders o ON o.customer_id=c.id GROUP BY c.id, c.username`           | 8 行; grace=0(无订单客户可见)                                                             |
| C14 | 三表 JOIN          | `SELECT o.order_no, p.name, i.quantity FROM t_orders o JOIN t_order_items i ON i.order_id=o.id JOIN t_products p ON p.id=i.product_id` | 11 行(明细数)                                                                             |
| C15 | 自连接             | `SELECT p.name 父类, c.name 子类 FROM t_categories p JOIN t_categories c ON c.parent_id=p.id`                                          | 4 行(手机/笔记本/男装/女装)                                                               |
| C16 | 子查询             | `SELECT * FROM t_products WHERE id IN (SELECT product_id FROM t_order_items)`                                                          | 9 行(排除 ThinkPad X1)                                                                    |
| C17 | CTE                | `WITH c AS (SELECT customer_id, COUNT(*) c FROM t_orders GROUP BY customer_id) SELECT * FROM c WHERE c>=2`                             | **被只读守卫拒绝**(仅允许 SELECT 开头; 单测已固化, 属设计)                                |
| C18 | **跨库查询**       | `SELECT c.username, r.name FROM t_customers c LEFT JOIN {REF_DB}.regions r ON c.region_id=r.id ORDER BY c.id`                          | 8 行: 上海/北京/广东/NULL/上海/北京/加州/NULL                                             |
| C19 | information_schema | `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='{MAIN_DB}' ORDER BY TABLE_NAME`                                  | 14 张表                                                                                   |
| C20 | SHOW 透传          | `SHOW TABLES`                                                                                                                          | 正常返回表列表(不追加 LIMIT)                                                              |
| C21 | DESCRIBE 透传      | `DESCRIBE t_products`                                                                                                                  | 10 行结构信息(Field/Type/Null/Key/Default/Extra)                                          |
| C22 | EXPLAIN 透传       | `EXPLAIN SELECT * FROM t_orders WHERE customer_id=1`                                                                                   | 返回执行计划行(id/select_type/table/type/possible_keys...)                                |
| C23 | **只读守卫**       | `db_query("INSERT INTO t_tags(name) VALUES('x')")`                                                                                     | 报错"仅允许只读 SQL"; UPDATE/DELETE/CREATE 同理被拒                                       |
| C24 | FOR UPDATE         | `SELECT * FROM t_customers WHERE id=1 FOR UPDATE`                                                                                      | 正常执行(不追加 LIMIT 导致语法错误)                                                       |
| C25 | 空结果             | `SELECT * FROM t_products WHERE id=9999`                                                                                               | 0 行, 无报错                                                                              |
| C26 | NULL 判定          | `SELECT * FROM t_coupons WHERE customer_id IS NULL`                                                                                    | 2 行(NEW50 / OLD10)                                                                       |
| C27 | COALESCE           | `SELECT username, COALESCE(phone,'无') FROM t_customers`                                                                               | 8 行; carol/frank 显示"无"                                                                |
| C28 | emoji/中文         | `SELECT * FROM t_products WHERE name LIKE '%高跟鞋%'`                                                                                  | 1 行(高跟鞋 🥿, emoji 正常显示)                                                           |
| C29 | 保留字列名         | ``SELECT `key`,`value` FROM t_config``                                                                                                 | 4 行(site.name / site.timezone / order.auto_confirm_days / emoji.icon)                    |
| C30 | 保留字无反引号     | `SELECT key FROM t_config`                                                                                                             | 语法错误(MySQL 保留字), 属预期                                                            |
| C31 | 数字表名           | `` SELECT * FROM `2024_sales` ``                                                                                                       | 8 行                                                                                      |
| C32 | 数字表名无反引号   | `SELECT * FROM 2024_sales`                                                                                                             | 实测: **正常返回 8 行**(MySQL 8 允许数字开头标识符; 建议仍用反引号)                       |
| C33 | UNION              | `SELECT order_no FROM t_orders UNION ALL SELECT order_no FROM t_orders_archive`                                                        | 13 行                                                                                     |
| C34 | JSON 提取          | `SELECT customer_id, JSON_UNQUOTE(JSON_EXTRACT(preferences,'$.theme')) FROM t_customer_profiles WHERE preferences IS NOT NULL`         | 2 行(dark / light)                                                                        |
| C35 | 软删除过滤         | `SELECT * FROM t_customers WHERE deleted_at IS NOT NULL`                                                                               | 1 行(frank)                                                                               |
| C36 | 多语句注入         | `SELECT 1; SELECT 2`                                                                                                                   | 被拒(mysql2 禁止多语句)                                                                   |
| C37 | LIMIT 偏移形式     | `SELECT * FROM t_audit_logs LIMIT 10, 5`                                                                                               | ⚠️ 已知边界: 会被追加 LIMIT 100 导致语法错误(见 §6)                                       |
| C38 | 大小写表名         | `SELECT * FROM T_CUSTOMERS`                                                                                                            | 实测: **报错 Table doesn't exist**(取决于服务器 lower_case_table_names, 本实例区分大小写) |
| C39 | 非法 SQL           | `SELECT FROM WHERE`                                                                                                                    | 明确报错, 不崩溃                                                                          |
| C40 | 注释               | `SELECT 1 /* 注释 */` / `SELECT 1 -- 注释`                                                                                             | 正常返回 1                                                                                |

### D. 写操作(db_mutate, 全部需人工确认)

> 破坏性用例, 执行后按"还原"列恢复, 保证套件可重复运行。

| ID  | 场景                | 操作(SQL)                                                                   | 预期结果                                                                    | 还原                                                                      |
| --- | ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | INSERT 单行         | `INSERT INTO t_tags(name) VALUES('回归A')`                                  | 确认对话框出现(展示 SQL 与目标库); 批准后 affected 1                        | `DELETE FROM t_tags WHERE name='回归A'`                                   |
| D2  | INSERT 多行         | `INSERT INTO t_tags(name) VALUES('回归B'),('回归C')`                        | 确认后 affected 2                                                           | 同上                                                                      |
| D3  | 写后读验证          | `SELECT * FROM t_tags`                                                      | 6 行(原 4 + 2), 新行 id 自增                                                | —                                                                         |
| D4  | UPDATE 带 WHERE     | `UPDATE t_tags SET name='热卖' WHERE name='热销'`                           | 确认对话框**无警告**; affected 1                                            | `UPDATE t_tags SET name='热销' WHERE name='热卖'`                         |
| D5  | **UPDATE 无 WHERE** | `UPDATE t_tags SET name='X'`                                                | 对话框出现**橙色警告**"没有 WHERE 子句 — 将影响表中所有行!"; 取消则数据不变 | 取消即可                                                                  |
| D6  | DELETE 带 WHERE     | `DELETE FROM t_tags WHERE name='回归B'`                                     | affected 1                                                                  | —                                                                         |
| D7  | **DELETE 无 WHERE** | `DELETE FROM t_tags`                                                        | 同 D5 橙色警告; 取消不执行                                                  | 取消即可                                                                  |
| D8  | REPLACE             | `REPLACE INTO t_config(id, \`key\`, \`value\`) VALUES(4,'emoji.icon','🚀')` | affected 2(删 1 插 1), 值更新                                               | `REPLACE INTO t_config(id,\`key\`,\`value\`) VALUES(4,'emoji.icon','🎉')` |
| D9  | **DDL 拒绝**        | `db_mutate("CREATE TABLE x(id INT)")`                                       | 直接报错"DDL 被禁止", **不弹确认框**; DROP/ALTER/TRUNCATE 同理              | —                                                                         |
| D10 | SELECT 拒绝         | `db_mutate("SELECT 1")`                                                     | 报错"仅允许 DML 写操作"                                                     | —                                                                         |
| D11 | 中文写入回读        | `INSERT INTO t_config(\`key\`,\`value\`) VALUES('test.中文','测试值')`      | 确认执行后回读正常(utf8mb4 无乱码)                                          | `DELETE FROM t_config WHERE \`key\`='test.中文'`                          |
| D12 | 取消确认            | 触发任意 INSERT 后**取消**                                                  | 无数据变化(回读验证)                                                        | —                                                                         |
| D13 | 指定库写入          | `db_mutate(sql, database:"{REF_DB}")`                                       | 写入 {REF_DB} 库(如 regions 加行), 对话框标注目标库                         | `DELETE FROM regions WHERE id>4`                                          |

### E. 关系管理(db_relation / db_list_relations)

| ID  | 场景             | 操作                                                                                                                                                   | 预期结果                                                                                                                                                |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 注册 MANY_TO_ONE | `db_relation(action:"register", table:"t_orders", column:"customer_id", refTable:"t_customers", refColumn:"id")`                                       | 返回 `Relation #N: t_orders.customer_id → t_customers.id (MANY_TO_ONE)`                                                                                 |
| E2  | **幂等重复注册** | 再次注册 E1 同对                                                                                                                                       | 不产生重复; `db_list_relations` 中仍只有 1 条该关系                                                                                                     |
| E3  | 注册 ONE_TO_ONE  | `db_relation(action:"register", table:"t_customer_profiles", column:"customer_id", refTable:"t_customers", refColumn:"id", relationType:"ONE_TO_ONE")` | 返回关系类型为 ONE_TO_ONE                                                                                                                               |
| E4  | 注册带 condition | `db_relation(action:"register", table:"t_orders", column:"customer_id", refTable:"t_customers", refColumn:"id", condition:"is_active = 1")`            | 注册成功, 列表显示 condition; 注意与 E1 是**两条不同关系**(condition 参与唯一键)                                                                        |
| E5  | 列出全部         | `db_list_relations()`                                                                                                                                  | 显示当前库所有已注册关系(编号/方向/类型/条件)                                                                                                           |
| E6  | 按表过滤         | `db_list_relations(table:"t_orders")`                                                                                                                  | 仅含 t_orders 相关(源或目标)                                                                                                                            |
| E7  | 指定库列出       | `db_list_relations(database:"{REF_DB}")`                                                                                                               | {REF_DB} 库无注册关系 → "No relations registered"                                                                                                       |
| E8  | 删除关系         | `db_relation(action:"delete", table:"t_orders", column:"customer_id", refTable:"t_customers", refColumn:"id")`                                         | 实测: delete **精确匹配列+condition**; 删除成功后, 再删同一条 → "No matching relation found"; 带 condition 的关系需用带同 condition 注册时…见 §6 限制 3 |
| E9  | 注册全套         | 按 §3 注册 R2~R13(除 R1)                                                                                                                               | 全部成功, 列表 **12 条**(R2-R13); 注意: 关系注册在当前库({MAIN_DB})下进行, 记录带库名, 旧库关系不会串扰新库                                             |
| E10 | 错误引用不校验   | 注册 `t_orders.customer_id → t_nope.id`                                                                                                                | 工具层面注册成功(不校验目标存在), BFS 时会失败 — 记录为已知行为                                                                                         |
| E11 | 清理关系         | 删除 E4/E10 等测试关系                                                                                                                                 | 列表恢复预期                                                                                                                                            |

### F. 输出格式与边界

| ID  | 场景               | 操作                                   | 预期结果                                                                                                                            |
| --- | ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **全 NULL 列折叠** | `SELECT * FROM t_customer_profiles`    | 5 行; avatar_url 列被折叠, 输出附摘要"已隐藏 1 列(全为 NULL)"                                                                       |
| F1b | JSON 列折叠注意    | 同上                                   | preferences(JSON)列**也会被折叠**——渲染器按序列化值判定"所有行取值相同"(实测 [object Object]); 要看 JSON 内容请用 JSON_EXTRACT(C34) |
| F2  | 全同值列折叠       | `SELECT * FROM t_orders_archive`       | status 列全为 completed → 折叠提示                                                                                                  |
| F3  | **50KB 截断**      | `SELECT * FROM t_documents WHERE id=3` | body(~100KB)输出被截断, 不卡死                                                                                                      |
| F4  | 宽表显示           | `SELECT * FROM t_orders`               | 表格/转置/键值对按终端宽度自适应; ctrl+o 展开全部行                                                                                 |
| F5  | 大结果集           | `SELECT * FROM t_audit_logs LIMIT 200` | 151 行完整显示(未触 2000 行上限)                                                                                                    |
| F6  | 空库列表           | `db_tables(database:"sys")`            | 0 张表, 明确提示                                                                                                                    |

### G. 交互命令(手动, 需在 pi 终端操作)

| ID  | 场景             | 操作                                                                      | 预期结果                                                                                                                                                          |
| --- | ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0  | **环境接入**     | `node docs/testing/init-env.mjs` 后, `/db switch` → 选连接 → 选 {MAIN_DB} | 当前库为 {MAIN_DB}, 状态栏更新                                                                                                                                    |
| G1  | 工作区面板       | `/db`                                                                     | 显示连接状态、当前库、子命令列表                                                                                                                                  |
| G2  | 切换连接         | `/db switch` → 选 qa                                                      | 当前库变为 qa 默认库; 状态栏更新                                                                                                                                  |
| G3  | defaultDatabase  | `/db switch` → 选 local                                                   | 验证配置行为: 自动选中配置的 defaultDatabase(若指向已清理的旧库, 则需手动选库, 属配置残留非扩展问题)                                                              |
| G4  | 切换库           | `/db switch` → local → 选 {MAIN_DB}                                       | 切换到 {MAIN_DB}                                                                                                                                                  |
| G5  | 表列表           | `/db tables`                                                              | 15 张表                                                                                                                                                           |
| G6  | 表结构           | `/db schema t_orders`                                                     | markdown 表格渲染, 持久展示                                                                                                                                       |
| G7  | 选表查询         | `/db query t_orders` → 输入 `status='paid'`                               | 2 行; **有注册关系时询问"查询关联表?"**                                                                                                                           |
| G8  | **BFS 关联查询** | G7 选择"📎 一起查询关联表"                                                | 主表结果 + 摘要行"关联表(N 个)— 详情见 LLM 上下文"(实测: TUI 不渲染完整关联表格, 完整内容在 LLM 上下文可见); 关联区块含 customers/coupons/order_items/products 等 |
| G9  | BFS 多跳         | `/db query t_customers` → WHERE `id=1` → 关联表                           | 修复后(见 §7.2)提示关联查询; 关联 profiles(1)/orders(3)/coupons(1)/archive(1)等 8 个区块                                                                          |
| G10 | 关系发现         | `/db relations discover`                                                  | 同步外键 0 条(本环境无系统外键) → 之后**总会询问**"是否使用 AI 分析表关系?"(选 ⏭ 跳过即可; 选 🤖 会生成 ER 图交 AI 分析并自动注册)                               |
| G11 | ER 图            | `/db relations er-diagram`                                                | 展示已注册关系图                                                                                                                                                  |
| G12 | 收藏             | `/db favorite add` + `/db favorite`                                       | 收藏成功并按库分组列出                                                                                                                                            |
| G13 | 历史             | `/db history` / `/db history t_orders`                                    | 最近 20 条 / 关键词过滤(匹配 **SQL 文本**, 中文表名搜不到; 无匹配时提示"未找到")                                                                                  |
| G14 | 扩展开关         | `/db off` → `/db on`                                                      | 状态栏移除/恢复; 工具调用报错提示未启用                                                                                                                           |

### H. 环境还原与回归

| ID  | 场景     | 操作                                                             | 预期结果                               |
| --- | -------- | ---------------------------------------------------------------- | -------------------------------------- |
| H1  | 数据还原 | 执行 D 组还原 SQL + `DELETE FROM t_tags WHERE name LIKE '回归%'` | `SELECT * FROM t_tags` = 4 行          |
| H2  | 关系清理 | 删除 E4/E10 测试关系                                             | `db_list_relations()` 与 E9 注册集一致 |
| H3  | 全套重建 | `node docs/testing/init-env.mjs`(或先 `--cleanup` 再重跑)        | 幂等: 新生成唯一库对, 计数与 §2 一致   |
| H4  | 回归抽查 | 重跑 C10/C13/C18                                                 | 结果与首次一致(确定性)                 |

## 6. 已知限制与边界(源码确认, 测试时注意)

1. **LIMIT 偏移形式**: `LIMIT 10, 5` 与 `LIMIT 5 OFFSET 10` 都不是"尾部 LIMIT 数字"形式, 会被追加 `LIMIT 100` → 语法错误(已由单测固化, sql-policy.test.ts)。分页目前只能写 `LIMIT n`; 如需 OFFSET 分页需改进 TRAILING_LIMIT_RE。
2. **跨库关系**: `db_relation` 注册时源/目标 schema 均取当前库, **无法注册跨库关系**(如 t_customers.region_id → {REF_DB}.regions.id 会注册成 {MAIN_DB}.regions.id, BFS 报错)。跨库仍可经 `db_query` 用 `库.表` 限定直接 JOIN。
3. **错误引用不校验**: `db_relation` 不验证目标表/列是否存在, 错误引用在 BFS 时才会暴露。
   **condition 删除限制**(实测): `db_relation` delete 参数不含 condition, 带 condition 的关系无法经工具删除(需 /db relations remove 或直接清理 state.db)。
4. **多语句被拒**: mysql2 默认禁止 multi-statements, 注入类输入安全。
5. **DDL 全拒**: db_mutate 只放行 INSERT/UPDATE/DELETE/REPLACE; 建表请用 mysql 客户端或脚本。
6. **输出上限**: 结果 50KB / 2000 行截断, 大字段(如 t_documents.body)会被截断显示, 属预期。
7. 写操作始终有人工确认门禁, 无 WHERE 的 UPDATE/DELETE 会显示警告。

## 7. 与单元测试的覆盖关系(回归策略)

扩展仓库 `__tests__/` 现有 10 个单测文件、139 个用例(`npm test`, 约 0.4s)。
本套端到端用例与单测是**互补**关系: 单测覆盖纯逻辑(快速、无环境依赖),
端到端覆盖真实 MySQL + pi 运行时行为(数据正确性、确认弹窗、交互流)。

图例: 🟢 单测已覆盖(端到端跑时属回归确认) / 🟡 部分覆盖(核心逻辑已测, 集成点仍需端到端) / 🔴 仅端到端(必须真实环境)

| 用例组                                                    | 单测覆盖情况                                                                                                            | 对应单测文件                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A1-A5 工具加载/关键词匹配                                 | 🟢 懒工具目录、关键词匹配(含大小写/空查询/无关词)、applyInitialToolSet 收敛                                             | db-tool-catalog.test.ts (13)           |
| A6 连接列表+脱敏                                          | 🟡 listConnections 逻辑与 queryLimit/env 解析已测; 真实列表与脱敏需端到端                                               | workspace-target / db-config           |
| A6b 配置加载错误路径                                      | 🟢 空文件/标量顶层/缺 connections 映射/缺必填字段/port+username 默认值                                                  | db-config (5)                          |
| A7 指定连接发现库                                         | 🔴 真实数据库枚举                                                                                                       | —                                      |
| A8 未知连接报错                                           | 🟢 未知连接抛错并列出可用 ID                                                                                            | workspace-target                       |
| B1-B2 表列表/指定库                                       | 🟡 目标解析(database/connection 覆盖)已测; 真实库清单需端到端                                                           | workspace-target                       |
| B3-B8 表结构/索引/无主键/注释                             | 🟡 markdown 渲染与管道符转义已测; information_schema 真实数据需端到端                                                   | schema-table.test.ts (2)               |
| C7-C9 LIMIT 追加/尊重/0                                   | 🟢 无界追加、尾部 LIMIT 保留、子查询内 LIMIT 追加外层、分号剥离                                                         | sql-policy.test.ts (17)                |
| C20-C22 SHOW/DESCRIBE/EXPLAIN 透传                        | 🟢 透传判定逻辑; 真实执行结果需端到端                                                                                   | sql-policy                             |
| C23 只读守卫                                              | 🟢 INSERT/UPDATE/DELETE/DROP/WITH 全部拒绝, 含词边界防护                                                                | sql-policy                             |
| C24 FOR UPDATE                                            | 🟢 不追加 LIMIT                                                                                                         | sql-policy                             |
| C37 LIMIT 偏移形式                                        | 🟢 已固化: 逗号与 OFFSET 形式都会被追加 LIMIT(现状), 文档 §6 已同步                                                     | sql-policy                             |
| C 组其余(数据正确性/JOIN/聚合/跨库/JSON/UNION/中文/NULL)  | 🔴 端到端用例集的核心价值, 单测无法替代(真实数据断言)                                                                   | —                                      |
| D1-D4/D6/D8/D11-D13 写操作流程                            | 🔴 确认弹窗 + 真实数据变更, 必须人工/端到端                                                                             | —                                      |
| D5/D7 无 WHERE 警告, D9 DDL 拒绝, D10 SELECT 拒绝         | 🟢 已补齐: prepareMutationQuery 校验层(操作类型/警告/DDL 拒绝) + MUTATION_SQL_RE 词边界; 确认弹窗与真实数据变更仍端到端 | sql-policy (12)                        |
| E1-E8 关系注册/幂等/condition/删除/过滤                   | 🟢 注册检索、幂等 upsert、condition 区分、按表过滤、删除、database override                                             | relation-graph (13) + workspace-target |
| E9 注册全套                                               | 🟡 注册机制已测; 批量实操需端到端                                                                                       | relation-graph                         |
| E9b 外键同步 mergeForeignKeys                             | 🟢 新增计数/重复跳过/condition 区分/默认类型(discover 流程落点)                                                         | relation-graph (4)                     |
| E10 错误引用不校验                                        | 🟢 已固化: 注册不校验目标存在性, BFS 查询错误被吞掉不崩溃                                                               | relation-graph (2)                     |
| F1/F1b/F2 列折叠(全 NULL/同值)                            | 🟢 全 NULL/同值/混合/单行/空结果检测                                                                                    | result-table.test.ts (30)              |
| F4 布局自适应/截断                                        | 🟢 水平/转置/垂直格式、20 行截断、超长单元格…[+N]; ctrl+o 展开交互 🔴                                                   | result-table                           |
| F3 50KB 截断                                              | 🟡 单元格截断已测; 执行器 50KB/2000 行上限需端到端确认                                                                  | result-table                           |
| F5/F6 大结果集/空库                                       | 🔴 端到端                                                                                                               | —                                      |
| G8/G9 BFS 遍历逻辑                                        | 🟢 bfsQuery: 参数化 IN、condition 追加、NULL 值跳过、maxDepth、循环防护、跨 schema; **交互流程本身 🔴 人工**            | relation-graph (6)                     |
| G8/G9 BFS 遍历逻辑                                        | 🟢 bfsQuery: 参数化 IN、condition 追加、NULL 值跳过、maxDepth、循环防护、跨 schema; **交互流程本身 🔴 人工**            | relation-graph (6)                     |
| G12 收藏存储                                              | 🟢 save/list(库+关键词过滤)/delete, 含无选择时全局收藏                                                                  | workspace-target (5)                   |
| G13 历史存储                                              | 🟢 保存/倒序/关键词与库过滤/删除                                                                                        | history.test.ts (6)                    |
| G14 扩展开关                                              | 🟢 开关读写、损坏/缺失回退                                                                                              | extension-toggle.test.ts (8)           |
| G 组命令输出格式化                                        | 🟢 sanitizeRows(JSON 安全)/formatRelatedResults/formatRelationsList/formatFavoriteList/formatEntry/entryToItem          | commands-format.test.ts (19)           |
| G 组参数补全 getCompletions                               | 🟢 子子命令展开/尾随空格/表名补全/大小写/未就绪与异常回退                                                               | db-command.test.ts (11)                |
| G 组其余(/db 面板/switch/schema/query/relations/favorite) | 🔴 pi TUI 交互, 必须人工                                                                                                | —                                      |
| H 组环境还原                                              | 🔴 端到端                                                                                                               | —                                      |

### 7.1 建议的回归节奏

- **日常迭代**: `npm test`(198 个, <1s)快速回归; 改动触及 sql-policy / relation-graph / result-table / workspace / 命令层格式化时, 对应单测即为第一道防线。
- **每轮迭代收尾或发布前**: 跑端到端套件(A-F 工具层用例, 可交给 agent 自动执行断言 + G 组人工抽查关键流)。
- 单测已覆盖: prepareMutationQuery、LIMIT 偏移、错误引用、mergeForeignKeys、favorites 存储、配置错误路径、命令层格式化与补全逻辑。
- **仍无单测的已知面**: db-manager 的 information_schema SQL 构造与结果映射(内联在方法内, 需提取纯函数后可测, 列为改进方向); 其余均需端到端/人工(确认弹窗 UI、TUI 交互、真实 MySQL 数据行为)。

## 8. 执行建议

1. 先运行 `node docs/testing/init-env.mjs` 生成唯一库对, 记下 {MAIN_DB} / {REF_DB}(也可 `--json` 输出)。
2. 按 **A → B → C → E → F** 顺序跑工具层用例(全部只读, 可安全重复); C 组是核心。
3. **D 组**单独一轮跑, 每个用例注意确认对话框内容(操作类型/目标库/橙色警告)。
4. **G 组**手动验证交互流, 先做 G0 接入 {MAIN_DB}; G8/G9 需先完成 E9 注册全套关系。
5. 收尾跑 H 组还原, 最后 `node docs/testing/init-env.mjs --cleanup` 销毁环境; 下一轮重新生成即可复用。

6. 先运行 `node docs/testing/init-env.mjs` 生成唯一库对, 记下 {MAIN_DB} / {REF_DB}(也可 `--json` 输出)。
7. 按 **A → B → C → E → F** 顺序跑工具层用例(全部只读, 可安全重复); C 组是核心。
8. **D 组**单独一轮跑, 每个用例注意确认对话框内容(操作类型/目标库/警告)。
9. **G 组**手动验证交互流, 先做 G0 接入 {MAIN_DB}; G8/G9 需先完成 E9 注册全套关系。
10. 收尾跑 H 组还原, 最后 `node docs/testing/init-env.mjs --cleanup` 销毁环境; 下一轮重新生成即可复用。
