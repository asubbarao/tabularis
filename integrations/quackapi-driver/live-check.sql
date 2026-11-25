-- what: live QuackAPI driver protocol boundary checks; retain raw bytes to inspect exact numbers.
-- run from the repository root on dev MCP; build the driver with cargo build --release first.
-- tested: 2026-11-13, Sol 6.1: exact numeric strings, NULL vs empty, empty schema and SQL error preserved.
-- read_json inference over heterogeneous rows can itself coerce values; read_lines retains driver wire output.
SELECT content FROM read_lines($cmd$./integrations/quackapi-driver/target/release/tabularis-quackapi-driver <<'RPC'
{"jsonrpc":"2.0","id":1,"method":"execute_query","params":{"params":{"host":"127.0.0.1","port":9495},"query":"SELECT 9007199254740993::BIGINT AS exact_integer, 12345678901234567890.123456789::DECIMAL(38,9) AS exact_decimal, NULL::VARCHAR AS missing, ''::VARCHAR AS empty"}}
{"jsonrpc":"2.0","id":2,"method":"execute_query","params":{"params":{"host":"127.0.0.1","port":9495},"query":"SELECT 1::INTEGER AS n WHERE false"}}
{"jsonrpc":"2.0","id":3,"method":"execute_query","params":{"params":{"host":"127.0.0.1","port":9495},"query":"SELECT no_such_tabularis_column"}}
RPC
|$cmd$);
