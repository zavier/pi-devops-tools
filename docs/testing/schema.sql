-- ============================================================================
-- pi 扩展测试环境 — 表结构与种子数据
-- 目标: MySQL 8.0+; 库名使用占位符, 由 docs/testing/init-env.mjs 自动替换为
--       每轮生成的唯一库名(__MAIN_DB__ = 主测试库, __REF_DB__ = 跨库测试库)
-- 手动执行示例:
--   sed 's/__MAIN_DB__/test_db/g; s/__REF_DB__/system/g' schema.sql | mysql
-- 设计原则:
--   * 所有关系均为"逻辑关系"(命名约定 + 索引), 不设置任何外键约束
--   * 覆盖关系类型: 1:1 / 1:N / N:M(桥接表) / 自引用 / 可空引用 / 跨库引用
--   * 覆盖边界: 无主键表 / 数字开头表名 / 保留字列名 / LONGTEXT 大字段 / 软删除 / JSON / ENUM
--   * 种子数据经过手工核算, 各测试用例的预期结果可精确验证
-- 清理: 执行本文件末尾的 DROP 段可完全还原环境
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. 跨库测试表 (__REF_DB__.regions, 供 t_customers.region_id 跨库关联)
-- ----------------------------------------------------------------------------
USE `__REF_DB__`;
DROP TABLE IF EXISTS `regions`;
CREATE TABLE `regions` (
  `id`   INT NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(10) NOT NULL,
  `name` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='地区(跨库测试)';

INSERT INTO `regions` (`id`, `code`, `name`) VALUES
  (1, 'CN-SH', '上海'),
  (2, 'CN-BJ', '北京'),
  (3, 'CN-GD', '广东'),
  (4, 'US-CA', '加州');

-- ----------------------------------------------------------------------------
-- 1. 商品分类 (自引用树: parent_id → t_categories.id)
-- ----------------------------------------------------------------------------
USE `__MAIN_DB__`;
DROP TABLE IF EXISTS `t_categories`;
CREATE TABLE `t_categories` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(50) NOT NULL,
  `parent_id`  INT NULL COMMENT '→ t_categories.id (自引用, 顶层为 NULL)',
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_parent_id` (`parent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品分类(自引用)';

INSERT INTO `t_categories` (`id`, `name`, `parent_id`, `sort_order`) VALUES
  (1, '数码', NULL, 1),
  (2, '手机', 1, 1),
  (3, '笔记本', 1, 2),
  (4, '服饰', NULL, 2),
  (5, '男装', 4, 1),
  (6, '女装', 4, 2);

-- ----------------------------------------------------------------------------
-- 2. 商品 (category_id → t_categories.id; 含软删除/下架状态/emoji 商品名)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_products`;
CREATE TABLE `t_products` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `category_id` INT NOT NULL COMMENT '→ t_categories.id',
  `sku`         VARCHAR(32) NOT NULL,
  `name`        VARCHAR(100) NOT NULL,
  `description` TEXT NULL,
  `price`       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `stock`       INT NOT NULL DEFAULT 0,
  `status`      ENUM('on_sale','off_shelf','deleted') NOT NULL DEFAULT 'on_sale',
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sku` (`sku`),
  KEY `idx_category_id` (`category_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品';

INSERT INTO `t_products` (`id`, `category_id`, `sku`, `name`, `description`, `price`, `stock`, `status`) VALUES
  (1, 2, 'SKU-001', 'iPhone 15',      'A16 芯片',        5999.00, 100, 'on_sale'),
  (2, 2, 'SKU-002', '小米 14',        NULL,              3999.00,  50, 'on_sale'),
  (3, 3, 'SKU-003', 'MacBook Air',    'M3 芯片 13寸',     7999.00,  20, 'on_sale'),
  (4, 3, 'SKU-004', 'ThinkPad X1',    NULL,              9999.00,   0, 'off_shelf'),
  (5, 5, 'SKU-005', '纯棉T恤',         '100% 纯棉',         99.00, 500, 'on_sale'),
  (6, 5, 'SKU-006', '牛仔裤',          NULL,              199.00, 300, 'on_sale'),
  (7, 6, 'SKU-007', '连衣裙',          '夏季新款',         299.00, 150, 'on_sale'),
  (8, 6, 'SKU-008', '高跟鞋 🥿',       NULL,              399.00,   0, 'off_shelf'),
  (9, 1, 'SKU-009', '无线耳机',        '降噪',             499.00,  80, 'on_sale'),
  (10, 1, 'SKU-010', '旧款平板',       '清仓',            1299.00,  10, 'deleted');

-- ----------------------------------------------------------------------------
-- 3. 客户 (region_id → __REF_DB__.regions.id 跨库; 软删除 deleted_at; is_active 停用)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_customers`;
CREATE TABLE `t_customers` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(50) NOT NULL,
  `email`         VARCHAR(100) NOT NULL,
  `phone`         VARCHAR(20) NULL,
  `region_id`     INT NULL COMMENT '→ __REF_DB__.regions.id (跨库)',
  `level`         ENUM('normal','vip','svip') NOT NULL DEFAULT 'normal',
  `balance`       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `is_active`     TINYINT(1) NOT NULL DEFAULT 1,
  `deleted_at`    DATETIME NULL COMMENT '软删除时间, 非 NULL 表示已删除',
  `registered_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_username` (`username`),
  UNIQUE KEY `uk_email` (`email`),
  KEY `idx_region_id` (`region_id`),
  KEY `idx_level` (`level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='客户';

INSERT INTO `t_customers` (`id`, `username`, `email`, `phone`, `region_id`, `level`, `balance`, `is_active`, `deleted_at`, `registered_at`) VALUES
  (1, 'alice', 'alice@test.com',   '13800000001', 1,    'vip',    88.50, 1, NULL,              '2024-01-01 10:00:00'),
  (2, 'bob',   'bob@test.com',     '13800000002', 2,    'normal',  0.00, 1, NULL,              '2024-01-02 10:00:00'),
  (3, 'carol', 'carol@test.com',   NULL,          3,    'svip', 1024.25, 1, NULL,              '2024-01-03 10:00:00'),
  (4, 'dave',  'dave@test.com',    '13800000004', NULL, 'normal', 12.00, 1, NULL,              '2024-01-04 10:00:00'),
  (5, 'erin',  'erin@test.com',    '13800000005', 1,    'vip',   500.00, 0, NULL,              '2024-01-05 10:00:00'),
  (6, 'frank', 'frank@test.com',   NULL,          2,    'normal',  0.00, 1, '2024-06-01 09:00:00', '2024-01-06 10:00:00'),
  (7, 'grace', 'grace@test.com',   '13800000007', 4,    'normal', 33.33, 1, NULL,              '2024-01-07 10:00:00'),
  (8, 'hank',  'hank@test.com',    '13800000008', NULL, 'vip',    76.00, 1, NULL,              '2024-01-08 10:00:00');

-- ----------------------------------------------------------------------------
-- 4. 优惠券 (customer_id 可空 = 公共券; 含已使用/已过期)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_coupons`;
CREATE TABLE `t_coupons` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `code`        VARCHAR(20) NOT NULL,
  `customer_id` INT NULL COMMENT '→ t_customers.id, NULL = 公共券',
  `discount`    DECIMAL(10,2) NOT NULL,
  `min_spend`   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `expire_at`   DATE NOT NULL,
  `used_at`     DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`),
  KEY `idx_customer_id` (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='优惠券';

INSERT INTO `t_coupons` (`id`, `code`, `customer_id`, `discount`, `min_spend`, `expire_at`, `used_at`) VALUES
  (1, 'VIP100',  1,   100.00, 1000.00, '2025-12-31', NULL),
  (2, 'NEW50',   NULL,  50.00,  500.00, '2025-12-31', NULL),
  (3, 'BIG200',  3,   200.00, 2000.00, '2025-12-31', '2025-05-01 12:00:00'),
  (4, 'OLD10',   NULL,  10.00,  100.00, '2023-01-01', NULL),
  (5, 'FRANK88', 6,    88.00,  800.00, '2025-12-31', NULL),
  (6, 'HANK30',  8,    30.00,  300.00, '2025-12-31', NULL);

-- ----------------------------------------------------------------------------
-- 5. 订单 (customer_id / coupon_id; total_amount 与明细+券核算一致, 可交叉验证)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_orders`;
CREATE TABLE `t_orders` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `order_no`     VARCHAR(32) NOT NULL,
  `customer_id`  INT NOT NULL COMMENT '→ t_customers.id',
  `coupon_id`    INT NULL COMMENT '→ t_coupons.id',
  `total_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `status`       ENUM('pending','paid','shipped','completed','cancelled') NOT NULL DEFAULT 'pending',
  `remark`       VARCHAR(255) NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_no` (`order_no`),
  KEY `idx_customer_id` (`customer_id`),
  KEY `idx_status` (`status`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单';

INSERT INTO `t_orders` (`id`, `order_no`, `customer_id`, `coupon_id`, `total_amount`, `status`, `remark`, `created_at`) VALUES
  (1,  'ORD-2025-0001', 1, 1,   6897.00, 'paid',      NULL,      '2025-01-05 10:00:00'),
  (2,  'ORD-2025-0002', 1, NULL,  594.00, 'shipped',   '加急',    '2025-01-10 11:00:00'),
  (3,  'ORD-2025-0003', 2, 2,   3949.00, 'pending',   NULL,      '2025-02-01 09:30:00'),
  (4,  'ORD-2025-0004', 3, NULL, 1299.00, 'completed', NULL,      '2025-02-14 15:00:00'),
  (5,  'ORD-2025-0005', 3, NULL,  698.00, 'cancelled', '客户取消', '2025-02-15 16:00:00'),
  (6,  'ORD-2025-0006', 4, NULL,    0.00, 'pending',   NULL,      '2025-03-01 10:00:00'),
  (7,  'ORD-2025-0007', 5, NULL,   99.00, 'pending',   NULL,      '2025-03-02 10:00:00'),
  (8,  'ORD-2025-0008', 8, 6,    368.00, 'shipped',   NULL,      '2025-03-10 14:00:00'),
  (9,  'ORD-2025-0009', 6, NULL, 7999.00, 'paid',      NULL,      '2025-03-11 10:00:00'),
  (10, 'ORD-2025-0010', 1, NULL,  499.00, 'cancelled', '重复下单', '2025-03-12 10:00:00');

-- 核算 (total = Σ qty×unit_price − 券面额):
--   ord1: 5999+499×2=6997 −100 = 6897 ✓    ord2: 99×6=594 ✓
--   ord3: 3999 −50 = 3949 ✓                 ord4: 1299 ✓
--   ord5: 299+399=698 ✓                     ord6: 无明细 0 ✓
--   ord7: 99 ✓                              ord8: 199×2=398 −30 = 368 ✓
--   ord9: 7999 ✓                            ord10: 499 ✓

-- ----------------------------------------------------------------------------
-- 6. 订单明细 (N:M 桥接: order_id × product_id; 复合唯一)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_order_items`;
CREATE TABLE `t_order_items` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `order_id`   INT NOT NULL COMMENT '→ t_orders.id',
  `product_id` INT NOT NULL COMMENT '→ t_products.id',
  `quantity`   INT NOT NULL DEFAULT 1,
  `unit_price` DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_product` (`order_id`, `product_id`),
  KEY `idx_product_id` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单明细';

INSERT INTO `t_order_items` (`id`, `order_id`, `product_id`, `quantity`, `unit_price`) VALUES
  (1,  1,  1, 1, 5999.00),
  (2,  1,  9, 2,  499.00),
  (3,  2,  5, 6,   99.00),
  (4,  3,  2, 1, 3999.00),
  (5,  4, 10, 1, 1299.00),
  (6,  5,  7, 1,  299.00),
  (7,  5,  8, 1,  399.00),
  (8,  7,  5, 1,   99.00),
  (9,  8,  6, 2,  199.00),
  (10, 9,  3, 1, 7999.00),
  (11, 10, 9, 1,  499.00);
-- 注: 订单 6 无明细 (LEFT JOIN / 空明细测试)

-- ----------------------------------------------------------------------------
-- 7. 客户资料 (1:1, 主键即外键; avatar_url 全 NULL 测列折叠; preferences JSON)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_customer_profiles`;
CREATE TABLE `t_customer_profiles` (
  `customer_id` INT NOT NULL COMMENT '→ t_customers.id (一对一)',
  `nickname`    VARCHAR(50) NULL,
  `bio`         TEXT NULL,
  `avatar_url`  VARCHAR(200) NULL,
  `preferences` JSON NULL,
  PRIMARY KEY (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='客户资料(一对一)';

INSERT INTO `t_customer_profiles` (`customer_id`, `nickname`, `bio`, `avatar_url`, `preferences`) VALUES
  (1, '爱丽丝', '资深果粉', NULL, JSON_OBJECT('theme','dark','lang','zh-CN')),
  (2, 'Bob',    NULL,       NULL, NULL),
  (3, '卡萝',   '买买买',   NULL, JSON_OBJECT('theme','light')),
  (5, '艾琳',   NULL,       NULL, NULL),
  (8, 'Hank',   '新人',     NULL, NULL);
-- 注: 客户 4/6/7 无资料 (LEFT JOIN 测试); avatar_url 全 NULL (列折叠测试)

-- ----------------------------------------------------------------------------
-- 8. 标签 + 9. 商品-标签 (N:M 桥接, 复合主键)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_product_tags`;
DROP TABLE IF EXISTS `t_tags`;
CREATE TABLE `t_tags` (
  `id`   INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='标签';

INSERT INTO `t_tags` (`id`, `name`) VALUES
  (1, '热销'), (2, '新品'), (3, '清仓'), (4, '高端');

CREATE TABLE `t_product_tags` (
  `product_id` INT NOT NULL COMMENT '→ t_products.id',
  `tag_id`     INT NOT NULL COMMENT '→ t_tags.id',
  PRIMARY KEY (`product_id`, `tag_id`),
  KEY `idx_tag_id` (`tag_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品-标签';

INSERT INTO `t_product_tags` (`product_id`, `tag_id`) VALUES
  (1, 1), (1, 4),
  (2, 1),
  (3, 4),
  (4, 4),
  (5, 1),
  (9, 2),
  (10, 3);
-- 注: 商品 6/7/8 无标签; 标签 2(新品) 仅挂在商品 9 上

-- ----------------------------------------------------------------------------
-- 10. 审计日志 (无主键! 151 行, 测 LIMIT 自动追加 / 重复 id / 无索引展示)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_audit_logs`;
CREATE TABLE `t_audit_logs` (
  `id`          INT NULL,
  `action`      VARCHAR(50) NOT NULL,
  `operator_id` INT NULL,
  `detail`      VARCHAR(255) NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_operator_id` (`operator_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='审计日志(无主键)';

INSERT INTO `t_audit_logs` (`id`, `action`, `operator_id`, `detail`, `created_at`)
WITH RECURSIVE seq AS (
  SELECT 1 AS n
  UNION ALL
  SELECT n + 1 FROM seq WHERE n < 150
)
SELECT
  n,
  ELT(1 + (n % 4), 'LOGIN', 'ORDER_CREATED', 'ORDER_PAID', 'PRODUCT_VIEW'),
  IF(n % 7 = 0, NULL, 1 + (n % 8)),
  CONCAT('audit record #', n),
  DATE_ADD('2025-01-01', INTERVAL n DAY)
FROM seq;

INSERT INTO `t_audit_logs` (`id`, `action`, `operator_id`, `detail`) VALUES
  (1, 'LOGIN', 1, 'duplicate id row');
-- 注: 共 151 行, id=1 出现两次 (无主键证明)

-- ----------------------------------------------------------------------------
-- 11. 大文档 (body 100KB, 测 50KB 输出截断)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_documents`;
CREATE TABLE `t_documents` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `title`      VARCHAR(100) NOT NULL,
  `body`       LONGTEXT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='大文档(截断测试)';

INSERT INTO `t_documents` (`id`, `title`, `body`) VALUES
  (1, '短文档', '这是一篇测试文档。'),
  (2, '空文档', NULL),
  (3, '长文档', REPEAT('长文测试内容ABC123', 5000));

-- ----------------------------------------------------------------------------
-- 12. 订单归档 (与 t_orders 同构, 测 UNION / 跨表合并)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_orders_archive`;
CREATE TABLE `t_orders_archive` (
  `id`           INT NOT NULL,
  `order_no`     VARCHAR(32) NOT NULL,
  `customer_id`  INT NOT NULL COMMENT '→ t_customers.id',
  `coupon_id`    INT NULL,
  `total_amount` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `status`       VARCHAR(20) NOT NULL,
  `remark`       VARCHAR(255) NULL,
  `created_at`   DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_customer_id` (`customer_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单归档';

INSERT INTO `t_orders_archive` (`id`, `order_no`, `customer_id`, `coupon_id`, `total_amount`, `status`, `remark`, `created_at`) VALUES
  (101, 'ORD-2024-0101', 1, NULL,  699.00, 'completed', NULL, '2024-11-01 10:00:00'),
  (102, 'ORD-2024-0102', 2, NULL, 2999.00, 'completed', NULL, '2024-12-01 10:00:00'),
  (103, 'ORD-2024-0103', 3, NULL,  199.00, 'completed', NULL, '2024-12-25 10:00:00');

-- ----------------------------------------------------------------------------
-- 13. 数字开头表名 (需反引号, 测引用处理)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `2024_sales`;
CREATE TABLE `2024_sales` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `product_id` INT NOT NULL COMMENT '→ t_products.id',
  `qty`        INT NOT NULL DEFAULT 0,
  `amount`     DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  KEY `idx_product_id` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='2024销售(数字开头表名)';

INSERT INTO `2024_sales` (`id`, `product_id`, `qty`, `amount`) VALUES
  (1, 1,  5, 29995.00),
  (2, 2,  3, 11997.00),
  (3, 5, 20,  1980.00),
  (4, 6, 10,  1990.00),
  (5, 7,  8,  2392.00),
  (6, 9, 12,  5988.00),
  (7, 3,  2, 15998.00),
  (8, 5,  7,   693.00);

-- ----------------------------------------------------------------------------
-- 14. 配置表 (列名为保留字 key, 测反引号处理)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `t_config`;
CREATE TABLE `t_config` (
  `id`    INT NOT NULL AUTO_INCREMENT,
  `key`   VARCHAR(50) NOT NULL COMMENT '保留字列名, 需反引号',
  `value` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='配置(保留字列名)';

INSERT INTO `t_config` (`id`, `key`, `value`) VALUES
  (1, 'site.name',             'Pi 数据库工具'),
  (2, 'site.timezone',         'Asia/Shanghai'),
  (3, 'order.auto_confirm_days', '7'),
  (4, 'emoji.icon',            '🎉');

-- ============================================================================
-- 清理段 (还原环境时执行)
-- ============================================================================
-- USE `__MAIN_DB__`;
-- DROP TABLE IF EXISTS `2024_sales`, `t_config`, `t_orders_archive`, `t_documents`,
--   `t_audit_logs`, `t_product_tags`, `t_tags`, `t_customer_profiles`, `t_order_items`,
--   `t_orders`, `t_coupons`, `t_customers`, `t_products`, `t_categories`;
-- USE `__REF_DB__`;
-- DROP TABLE IF EXISTS `regions`;
