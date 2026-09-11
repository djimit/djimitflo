# G272 observability route semantic validation

The local `createTestDb` fixture was intentionally kept unchanged because
other tests define their own approval-policy schema. The observability fixture
now supplies its canonical minimal `execution_events` and `approval_policies`
tables and exercises the real route/service queries: metrics, risk trends,
policy statistics, execution activity and malformed-window rejection.

Result: 2/2 tests passed, with empty projections returning 200 and malformed
windows returning typed 400 responses. This is local HTTP/SQLite behavior;
production deployment and authenticated browser behavior remain separate.
