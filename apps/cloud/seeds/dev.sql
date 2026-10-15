-- Local development only: an agent whose key is "dev-agent-key-0123456789" (stored as SHA-256).
INSERT OR IGNORE INTO agents (id, name, key_hash, created_at, created_by)
VALUES ('01DEVAGENT0000000000000000', 'Local dev agent',
        '105f53b26a19d7eba0735648c1d0eb66bbd20b18b69743cd73408bd4fa506397', 0, 'seed');
