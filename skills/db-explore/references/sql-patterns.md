# Common SQL Patterns

Quick-reference for common exploration queries. All queries go through `db_query`.

## Row counts

```sql
-- Single table
SELECT COUNT(*) FROM table_name;

-- All tables in database (MySQL 8+)
SELECT TABLE_NAME, TABLE_ROWS
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'your_db'
ORDER BY TABLE_ROWS DESC;
```

## Sampling

```sql
-- Random sample (good for inspecting value distributions)
SELECT * FROM table_name ORDER BY RAND() LIMIT 10;

-- Most recent rows (if created_at / id exists)
SELECT * FROM table_name ORDER BY id DESC LIMIT 10;
```

## FK discovery

```sql
-- Find columns ending in _id (candidate FKs)
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'your_db'
  AND COLUMN_NAME LIKE '%\_id'
ORDER BY TABLE_NAME, COLUMN_NAME;
```

## Cardinality check

```sql
-- Distinct values in a candidate FK column
SELECT COUNT(DISTINCT fk_column) AS distinct_values,
       COUNT(*) AS total_rows,
       COUNT(DISTINCT fk_column) / COUNT(*) AS selectivity
FROM table_name;
```

## Index coverage

```sql
-- Indexes on a specific table
SHOW INDEX FROM table_name;

-- Tables missing a primary key
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'your_db'
  AND TABLE_NAME NOT IN (
    SELECT DISTINCT TABLE_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = 'your_db' AND INDEX_NAME = 'PRIMARY'
  );
```

## Soft-delete check

```sql
-- Check for common soft-delete patterns
SELECT COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = 'your_db'
  AND COLUMN_NAME IN ('deleted_at', 'is_deleted', 'is_active', 'status', 'deleted', 'archived_at')
ORDER BY TABLE_NAME, COLUMN_NAME;
```

## EXPLAIN

```sql
-- Check query plan before running expensive queries
EXPLAIN SELECT ... FROM ... JOIN ... WHERE ...;
```
