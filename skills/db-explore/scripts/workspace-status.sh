#!/bin/bash
# Check the current database workspace state.
# Usage: ./scripts/workspace-status.sh

DB_DIR="$HOME/.pi/database"
WORKSPACE_FILE="$DB_DIR/workspace.json"
STATE_DB="$DB_DIR/state.db"

echo "=== pi-devops-tools Workspace Status ==="
echo ""

if [ -f "$WORKSPACE_FILE" ]; then
  echo "Current selection:"
  python3 -c "
import json
with open('$WORKSPACE_FILE') as f:
    data = json.load(f)
print(f'  Environment:  {data.get(\"environment\", \"?\")}')
print(f'  Connection:   {data.get(\"connectionId\", \"?\")}')
print(f'  Database:     {data.get(\"database\", \"?\")}')
"
else
  echo "  No workspace selection (run /db switch first)"
fi

echo ""

if [ -f "$STATE_DB" ]; then
  echo "Metadata:"
  REL_COUNT=$(sqlite3 "$STATE_DB" "SELECT COUNT(*) FROM table_relations;" 2>/dev/null)
  echo "  Relations:    ${REL_COUNT:-0} registered"
  HIST_COUNT=$(sqlite3 "$STATE_DB" "SELECT COUNT(*) FROM query_history;" 2>/dev/null)
  echo "  Query history: ${HIST_COUNT:-0} entries"
  FAV_COUNT=$(sqlite3 "$STATE_DB" "SELECT COUNT(*) FROM favorites;" 2>/dev/null)
  echo "  Favorites:    ${FAV_COUNT:-0} saved"
else
  echo "  No metadata DB found at $STATE_DB"
fi

echo ""
echo "Config file: $DB_DIR/../connections.yaml"
if [ -f "$DB_DIR/../connections.yaml" ]; then
  echo "  Connections configured:"
  python3 -c "
import yaml, sys
try:
    with open('$DB_DIR/../connections.yaml') as f:
        config = yaml.safe_load(f)
    if config and 'connections' in config:
        for name, cfg in config['connections'].items():
            env = cfg.get('environment', '?')
            host = cfg.get('host', '?')
            def_db = cfg.get('defaultDatabase', '')
            db_info = f' (default: {def_db})' if def_db else ''
            print(f'    {name} → {env} @ {host}{db_info}')
    else:
        print('  (empty)')
except Exception as e:
    print(f'  (error reading config: {e})')
" 2>/dev/null || echo "  (pyyaml not available — install with: pip3 install pyyaml)"
