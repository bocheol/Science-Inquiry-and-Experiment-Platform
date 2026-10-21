BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL search_path = pg_catalog;
SELECT json_build_object(
  'database', current_database(),
  'tls', COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), FALSE),
  'stats_visible', (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
    OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE'),
  'track_activities', current_setting('track_activities') = 'on',
  'unknown_client_sessions', (SELECT count(*) FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND (state IS NULL OR state = 'disabled')),
  'active_other_transactions', (SELECT count(*) FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid()
      AND (xact_start IS NOT NULL OR state IN ('active', 'fastpath function call'))),
  'prepared_transactions', (SELECT count(*) FROM pg_prepared_xacts WHERE database = current_database()),
  'migrations', (SELECT json_agg(t ORDER BY version)
    FROM (SELECT version, name, checksum FROM public.schema_migrations) t)
) AS inspection;
COMMIT;
