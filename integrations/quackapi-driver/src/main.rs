use reqwest::Client;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[derive(Clone, Debug, Eq, PartialEq)]
struct Endpoint {
    host: String,
    port: u16,
}

impl Endpoint {
    fn from_params(params: &Value) -> Result<Self, String> {
        let host = params
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("127.0.0.1")
            .trim()
            .to_ascii_lowercase();
        if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
            return Err("This driver only connects to the local QuackAPI service".into());
        }
        let port = params.get("port").and_then(Value::as_u64).unwrap_or(9495);
        let port = u16::try_from(port).map_err(|_| "Invalid QuackAPI port")?;
        if port == 0 {
            return Err("Invalid QuackAPI port".into());
        }
        Ok(Self { host, port })
    }

    fn url(&self) -> String {
        let host = if self.host == "::1" {
            "[::1]"
        } else {
            self.host.as_str()
        };
        format!("http://{host}:{}/sql", self.port)
    }
}

async fn run_sql(client: &Client, params: &Value, sql: &str) -> Result<Value, String> {
    let endpoint = Endpoint::from_params(params)?;
    let response = client
        .post(endpoint.url())
        .json(&json!({"sql": sql}))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "QuackAPI returned HTTP {status}: {}",
            body.chars().take(2_000).collect::<String>()
        ));
    }
    serde_json::from_str(&body).map_err(|_| "QuackAPI returned invalid JSON".into())
}

fn encode_cell(value: &Value, data_type: &str) -> Value {
    match value {
        Value::Number(number) => {
            let text = number.to_string();
            let safe_integer = number
                .as_i64()
                .is_some_and(|n| (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n))
                || number.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991);
            let integer_text = text.chars().all(|c| c == '-' || c.is_ascii_digit());
            let binary_float = matches!(data_type, "DOUBLE" | "FLOAT" | "REAL");
            if data_type.contains("DECIMAL(") || (!safe_integer && (integer_text || !binary_float))
            {
                Value::String(text)
            } else {
                value.clone()
            }
        }
        Value::Array(values) => {
            let element_type = data_type.strip_suffix("[]").unwrap_or(data_type);
            Value::Array(
                values
                    .iter()
                    .map(|value| encode_cell(value, element_type))
                    .collect(),
            )
        }
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(name, value)| (name.clone(), encode_cell(value, data_type)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn query_result(payload: Value, _elapsed_ms: u128) -> Result<Value, String> {
    let outer_rows = if let Some(rows) = payload.as_array() {
        rows.as_slice()
    } else {
        payload
            .get("rows")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .ok_or_else(|| "QuackAPI response did not contain rows".to_string())?
    };
    let receipt = outer_rows
        .first()
        .and_then(Value::as_object)
        .ok_or_else(|| "QuackAPI response did not contain a self-dispatch receipt".to_string())?;
    let status = receipt
        .get("status")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let error = receipt.get("error").filter(|value| !value.is_null());
    if status != 200 || error.is_some() {
        return Err(error
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("QuackAPI self-dispatch failed with status {status}")));
    }
    let rows = receipt
        .get("rows")
        .and_then(Value::as_array)
        .ok_or_else(|| "QuackAPI receipt did not contain rows".to_string())?;
    let column_metadata = receipt
        .get("columns")
        .and_then(Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .map(|column| {
                    let name = column
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "QuackAPI returned a column without a name".to_string())?;
                    let data_type = column
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("UNKNOWN");
                    Ok::<_, String>((name.to_owned(), data_type.to_owned()))
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let columns = column_metadata
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let values = rows
        .iter()
        .map(|row| {
            if let Some(values) = row.as_array() {
                values
                    .iter()
                    .enumerate()
                    .map(|(index, value)| {
                        encode_cell(
                            value,
                            column_metadata
                                .get(index)
                                .map(|(_, data_type)| data_type.as_str())
                                .unwrap_or("UNKNOWN"),
                        )
                    })
                    .collect::<Vec<_>>()
            } else {
                columns
                    .iter()
                    .zip(column_metadata.iter().map(|(_, data_type)| data_type))
                    .map(|(column, data_type)| {
                        encode_cell(row.get(column).unwrap_or(&Value::Null), data_type)
                    })
                    .collect::<Vec<_>>()
            }
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "columns": columns,
        "column_types": column_metadata.iter().map(|(_, data_type)| data_type).collect::<Vec<_>>(),
        "rows": values,
        // Query receipts do not report affected rows. Match Tabularis' built-in
        // drivers, which report zero for SELECT results.
        "affected_rows": 0,
        "truncated": false,
        "pagination": null,
    }))
}

fn wrap_query(query: &str) -> String {
    let escaped = query.replace('\'', "''");
    format!(
        "WITH query_source AS (SELECT '{escaped}'::VARCHAR AS executable_sql), \
         posted AS (SELECT *, array_agg(selfdispatch(executable_sql)) AS arr \
                    FROM query_source GROUP BY ALL) \
         SELECT receipt.status, receipt.error, receipt.rows, \
                list_transform(receipt.columns, lambda c: \
                    {{'name': c.name, 'type': c.type::VARCHAR}}) AS columns \
         FROM posted CROSS JOIN UNNEST(arr) AS u(receipt)"
    )
}

async fn handle(client: &Client, request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    let result = match method {
        "initialize" => Ok(Value::Null),
        "ping" | "test_connection" => {
            let connection = params.get("params").unwrap_or(&Value::Null);
            run_sql(client, connection, "SELECT 1 AS tabularis_connection_check")
                .await
                .map(|_| {
                    if method == "ping" {
                        Value::Null
                    } else {
                        json!({"success": true})
                    }
                })
        }
        "get_databases" => Ok(json!(["dev"])),
        "get_schemas"
        | "get_tables"
        | "get_views"
        | "get_materialized_views"
        | "get_routines"
        | "get_triggers" => Ok(json!([])),
        "execute_query" => {
            let connection = params.get("params").unwrap_or(&Value::Null);
            let query = params
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let start = std::time::Instant::now();
            run_sql(client, connection, &wrap_query(query))
                .await
                .and_then(|payload| query_result(payload, start.elapsed().as_millis()))
        }
        _ => {
            return json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": -32601, "message": format!("Method not found: {method}")}
            })
        }
    };
    match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err(error) => {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32000, "message": error}})
        }
    }
}

#[tokio::main]
async fn main() {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("HTTP client configuration is valid");
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Value>(&line) {
                Ok(request) => handle(&client, request).await,
                Err(error) => json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": {"code": -32700, "message": error.to_string()}
                }),
            },
            Err(error) => {
                eprintln!("failed reading plugin input: {error}");
                break;
            }
        };
        if response.get("id").is_some_and(Value::is_null) {
            continue;
        }
        if writeln!(stdout, "{response}")
            .and_then(|_| stdout.flush())
            .is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{query_result, Endpoint};
    use serde::Deserialize;
    use serde_json::json;

    // Mirrors src-tauri/src/models.rs::QueryResult and Pagination.
    #[derive(Deserialize)]
    struct TabularisQueryResult {
        columns: Vec<String>,
        rows: Vec<Vec<serde_json::Value>>,
        affected_rows: u64,
        #[serde(default)]
        truncated: bool,
        pagination: Option<TabularisPagination>,
        additional_results: Option<Vec<TabularisQueryResult>>,
        server_time_ms: Option<f64>,
        fetch_time_ms: Option<f64>,
    }

    #[allow(dead_code)]
    #[derive(Deserialize)]
    struct TabularisPagination {
        page: u32,
        page_size: u32,
        total_rows: Option<u64>,
        has_more: bool,
    }

    #[test]
    fn endpoint_only_accepts_loopback_hosts_and_valid_ports() {
        let endpoint = Endpoint::from_params(&json!({"host":"::1","port":9495})).unwrap();
        assert_eq!(endpoint.url(), "http://[::1]:9495/sql");
        assert!(Endpoint::from_params(&json!({"host":"dev.example","port":9495})).is_err());
        assert!(Endpoint::from_params(&json!({"host":"localhost","port":70000})).is_err());
    }

    #[test]
    fn maps_json_rows_and_preserves_null_values() {
        let payload = serde_json::from_str(
            r#"[{"status":200,"error":null,"rows":[{"z":1,"a":null},{"z":2,"a":"x"}],"columns":[{"name":"z","type":"INTEGER"},{"name":"a","type":"VARCHAR"}]}]"#,
        )
        .unwrap();
        let result = query_result(payload, 4).unwrap();
        assert_eq!(result["columns"], json!(["z", "a"]));
        assert_eq!(result["rows"], json!([[1, null], [2, "x"]]));
        assert_eq!(result["column_types"], json!(["INTEGER", "VARCHAR"]));
        let typed: TabularisQueryResult = serde_json::from_value(result).unwrap();
        assert_eq!(typed.columns, ["z", "a"]);
        assert_eq!(typed.rows.len(), 2);
        assert_eq!(typed.affected_rows, 0);
        assert!(!typed.truncated);
        assert!(typed.pagination.is_none());
        assert!(typed.additional_results.is_none());
        assert!(typed.server_time_ms.is_none());
        assert!(typed.fetch_time_ms.is_none());
    }

    #[test]
    fn wraps_queries_as_one_self_dispatch_program() {
        let wrapped = super::wrap_query("SELECT 'a' AS value");
        assert!(wrapped.contains("SELECT ''a'' AS value"));
        assert!(wrapped.contains("array_agg(selfdispatch(executable_sql))"));
        assert!(wrapped.contains("lambda c:"));
    }
    #[test]
    fn preserves_exact_numbers_at_the_javascript_boundary() {
        let payload = serde_json::from_str(r#"[{"status":200,"error":null,"rows":[{"i":9007199254740993,"d":12345678901234567890.123456789,"h":340282366920938463463374607431768211455,"f":0.125}],"columns":[{"name":"i","type":"BIGINT"},{"name":"d","type":"DECIMAL(38,9)"},{"name":"h","type":"UHUGEINT"},{"name":"f","type":"DOUBLE"}]}]"#).unwrap();
        let result = query_result(payload, 0).unwrap();
        assert_eq!(
            result["rows"],
            json!([[
                "9007199254740993",
                "12345678901234567890.123456789",
                "340282366920938463463374607431768211455",
                0.125
            ]])
        );
    }

    #[test]
    fn preserves_empty_schema_nulls_and_nested_exact_values() {
        let empty = serde_json::from_str(
            r#"[{"status":200,"error":null,"rows":[],"columns":[{"name":"n","type":"INTEGER"}]}]"#,
        )
        .unwrap();
        let result = query_result(empty, 0).unwrap();
        assert_eq!(result["columns"], json!(["n"]));
        assert_eq!(result["rows"], json!([]));
        let nested = serde_json::from_str(r#"[{"status":200,"error":null,"rows":[{"v":[1234567890.123456789,null],"s":""}],"columns":[{"name":"v","type":"DECIMAL(20,9)[]"},{"name":"s","type":"VARCHAR"}]}]"#).unwrap();
        let result = query_result(nested, 0).unwrap();
        assert_eq!(
            result["rows"],
            json!([[["1234567890.123456789", null], ""]])
        );
    }

    #[test]
    fn surfaces_inner_sql_errors_instead_of_empty_success() {
        let failed = json!([{"status":500,"error":"Binder failure","rows":[],"columns":[]}]);
        assert_eq!(query_result(failed, 0).unwrap_err(), "Binder failure");
    }
}
