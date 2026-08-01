# 测试环境要求与全新机器部署指南

> 本套测试(init-env.mjs + schema.sql + test-plan.md)用于反复验证 pi-devops-tools 扩展。
> 目标: 在任何一台机器上, 按本文档操作后即可完整跑通全部用例。

## 1. 环境要求总览

| 依赖                              | 版本/要求                    | 是否必须 | 说明                                                                  |
| --------------------------------- | ---------------------------- | -------- | --------------------------------------------------------------------- |
| pi(终端)                          | 扩展要求 `pi ≥ 0.80`         | ✅ 必须  | 被测对象本身, 需安装并启用 pi-devops-tools 扩展                       |
| Node.js                           | ≥ 20(推荐 22/24 LTS)         | ✅ 必须  | pi 与 init-env.mjs 都依赖                                             |
| MySQL 实例                        | **8.0+**(MariaDB 10.2+ 兼容) | ✅ 必须  | 不一定在本机——任何可达的实例均可(远程/Docker/云)                      |
| 测试账号权限                      | 建库/删库/建表/增删改查      | ✅ 必须  | init 需要 `CREATE DATABASE`/`DROP DATABASE`; 普通只读账号不行         |
| `~/.pi/database/connections.yaml` | 至少 1 条可用连接            | ✅ 必须  | 测试经此配置连库(见 §3)                                               |
| 扩展仓库(node_modules)            | js-yaml + mysql2             | ✅ 必须  | init-env.mjs 从扩展的 node_modules 解析依赖, **脚本必须在仓库内运行** |
| 磁盘/内存/CPU                     | 无特殊要求                   | —        | 全库仅 14 张小表 + 100KB 单行, 可忽略                                 |
| 网络                              | 可达 MySQL 3306 端口         | ✅ 必须  | 远程实例需放行端口                                                    |

**不需要的东西**: 无需 root 系统权限(除非本机装 MySQL)、无需 Docker(可用远程实例)、
无需固定库名(每轮动态生成)、无需系统 `mysql` 客户端(init-env.mjs 用 mysql2 驱动)。

## 2. 全新机器部署步骤(最小路径)

```bash
# 1) 安装 Node.js ≥ 20 (推荐 nvm / fnm)
node --version   # ≥ 20

# 2) 安装 pi 并安装扩展
pi install npm:pi-devops-tools        # 或: git clone 仓库后 pi install ./pi-devops-tools

# 3) 准备 MySQL 8.0+ —— 三选一:
#    a. Docker(最省事, 无需本机安装)
docker run -d --name pi-db-test -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=yourpass -e MYSQL_ROOT_HOST=% mysql:8
#    b. 本机安装 (macOS: brew install mysql / 官方 dmg; 其他平台: 发行版包管理器)
#    c. 远程/云实例(已有则跳过)

# 4) 配置连接(§3), 然后验证连通
#    在 pi 中: /db switch 选连接; 或直接跑预检:

# 5) 克隆扩展仓库到本机(为跑 init-env.mjs 与测试文档)
git clone git@github.com:zavier/pi-devops-tools.git
cd pi-devops-tools && npm install       # 安装 js-yaml / mysql2 等依赖

# 6) 环境自检(8 项检查, 失败会给出修复指引)
node docs/testing/init-env.mjs --preflight

# 7) 初始化测试环境(生成唯一库对 + 建表 + 种子)
node docs/testing/init-env.mjs         # 记下输出的 {MAIN_DB} / {REF_DB}

# 8) 开始测试
#    工具层用例(A-F/H): 在 pi 会话中让 agent 按 test-plan.md 执行
#    命令层用例(G): 手动在 pi 中执行 /db 命令
#    —— 也可以直接用 db_tables/db_query 的 database 参数指定 {MAIN_DB}, 无需切换

# 9) 测试结束, 一键销毁
node docs/testing/init-env.mjs --cleanup
```

## 3. 连接配置(connections.yaml 模板)

文件位置: `~/.pi/database/connections.yaml`。新机器上至少需要一条连接:

```yaml
connections:
  local:
    environment: default
    type: mysql
    host: 127.0.0.1 # 或远程主机 / Docker 容器名
    port: 3306
    username: pi_test # 建议专用测试账号, 见下方最小授权
    password: ${PI_TEST_DB_PASSWORD} # 支持 ${ENV_VAR} 占位符
    defaultDatabase: test_db # 可省略; 测试不依赖它(每轮动态建库)
```

**建议的最小权限测试账号**(替代 root, 用 root 执行一次):

```sql
CREATE USER 'pi_test'@'%' IDENTIFIED BY 'yourpass';
-- 仅放行测试库前缀, 不给其他库任何权限
GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE
  ON `test\_main\_%`.* TO 'pi_test'@'%';
GRANT CREATE, DROP, ALTER, INDEX, SELECT, INSERT, UPDATE, DELETE
  ON `test\_ref\_%`.*  TO 'pi_test'@'%';
FLUSH PRIVILEGES;
-- 注意: init-env.mjs 的 --prefix 需保持默认 test, 才能命中上述授权
```

> `_` 在 GRANT 通配符里需转义为 `\_`(见上); 若用 `--prefix demo` 则授权前缀改为 `demo\_main\_%` / `demo\_ref\_%`。

## 4. 预检内容(init-env.mjs --preflight)

每次 `init-env.mjs`(不带 `--skip-preflight`)自动检查 8 项, 全部通过才建库:

1. Node.js ≥ 20
2. js-yaml / mysql2 可解析(扩展 node_modules 已安装)
3. connections.yaml 存在
4. 指定连接在配置中存在
5. 连接可达(主机/端口/认证)
6. MySQL 版本 ≥ 8.0(递归 CTE / JSON 依赖)
7. 建库 → 建表 → 删库 权限探测(真实执行并立即清理)

失败时打印 `❌ 项目 + 原因 + 修复指引` 并以退出码 1 中止。

## 5. 常见问题(FAQ)

| 现象                               | 原因                                   | 解决                                                                                                    |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `无法解析 js-yaml/mysql2`          | 脚本不在扩展仓库内, 或未 `npm install` | 在扩展仓库根目录 `npm install`; 脚本必须留在 `docs/testing/` 内(可用绝对路径调用, 模块解析基于脚本位置) |
| `连接失败: ECONNREFUSED`           | MySQL 未启动/端口不通                  | `docker ps` 检查容器; 远程实例放行 3306                                                                 |
| `连接失败: ER_ACCESS_DENIED_ERROR` | 账号密码错误                           | 检查 connections.yaml 与 `${ENV_VAR}` 是否已导出                                                        |
| `建/删库权限 探测失败`             | 账号权限不足                           | 用 §3 最小授权 SQL 建专用账号, 或临时用 root                                                            |
| `MySQL 版本 未通过`                | 5.7 及以下                             | schema.sql 依赖递归 CTE(8.0+); 升级或用 `mysql:8` 镜像                                                  |
| `Unknown database 'xxx'`(旧流程)   | 之前依赖固定库 test_db/system          | 动态库流程已无此问题; 若见旧文档, 以 init-env.mjs 为准                                                  |
| 多轮测试的关系残留                 | 关系存于 SQLite(state.db), 带库名      | 旧库关系不串扰新库; 需要时用 `db_list_relations` 查看, `db_relation(action:"delete")` 逐条清理          |
| `--cleanup` 后连接记录还在         | 记录文件已删, 库已删                   | 属正常; 再跑一次提示"无需清理"即幂等完成                                                                |

## 6. 反复执行保障(回归友好性)

- **每轮独立**: 库名含时间戳+随机后缀, 多轮并行不冲突; 不触碰任何固定库
- **幂等**: `--cleanup` 无残留时提示且不报错; schema 重建可重复执行
- **失败即停**: preflight 不过不建库, 错误信息带修复指引
- **可脚本化**: `--json` 输出库名/连接, 便于 CI 或自动化封装(示例见下)
- **预期可断言**: test-plan.md 所有用例给出精确行数/金额/映射, 可人工或由 agent 断言

CI 风格封装示例(每次迭代后自动回归):

```bash
ENV=$(node docs/testing/init-env.mjs --json)
MAIN_DB=$(echo "$ENV" | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).mainDb)}catch{}})' )
# ... 在 pi 会话中按 test-plan.md 跑 A-F 用例(只读, 可自动化断言) ...
node docs/testing/init-env.mjs --cleanup
```
