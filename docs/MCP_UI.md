# MCP desktop UI tools

The desktop MCP server exposes `open_files`, `list_visible_tabs`, and `run_visible_tab` in addition to its database tools.

`open_files` accepts one to twenty absolute paths to regular UTF-8 files no larger than 50 MiB. Files open as editor tabs regardless of extension or filename, including dotfiles and custom extensions; syntax highlighting is selected when the filename is recognized and otherwise uses plain text. SQL files are executable; other file kinds remain readable without being treated as SQL. Reopening a clean text tab refreshes it from disk, while a dirty tab preserves the editor contents.

The optional `connection_id` selects a configured connection from `list_connections` before opening files. The optional `reveal` flag defaults to `false`. If the desktop app is closed, `open_files` can launch the bundled macOS app in the background; it requires an existing absolute `TABULARIS_DATA_DIR` and passes only that profile path to LaunchServices so the app uses the same isolated data directory. Set `reveal: true` to activate and focus the main window before opening files.

Successful opens appear in the persistent Recent Files menu, which stores a bounded list of paths and can reopen closed files without a file dialog. Acknowledgments include file paths, hashes, dirty state, and tab/connection identifiers; file contents are not returned.

`list_visible_tabs` returns tabs for the active connection, including source paths, dirty state, active tab, and the latest result visible in each tab. `run_visible_tab` is SQL-only: it accepts a SQL file path and the `expected_sha256` from `open_files`, verifies the current saved bytes and clean editor buffer, then uses Tabularis' normal editor run path and acknowledges the result shown on that same tab. `list_visible_tabs` and `run_visible_tab` require the desktop app to be running. SQL tabs belong to the selected connection, so choose one that supports the file's SQL dialect before running it.

### Update an isolated macOS app

Build the web UI before the native executable so the embedded assets match the source. With Node 24 and the pinned pnpm version available, run from the checkout root:

```sh
pnpm build
cd src-tauri
TAURI_CONFIG='{"identifier":"com.tabularis.agent-dev","productName":"Tabularis Agent","build":{"devUrl":null,"frontendDist":"../packages/web-ui/dist"}}' \
cargo build --bin tabularis --features tauri/custom-protocol
```

This embeds the UI without a development server. To update an existing isolated app wrapper, quit that app, copy the executable, and sign the whole bundle after changing either the executable or its Info.plist:

```sh
TABULARIS_AGENT_APP="$HOME/Applications/Tabularis Agent.app"
cp target/debug/tabularis "$TABULARIS_AGENT_APP/Contents/MacOS/tabularis"
codesign --force --deep --sign - "$TABULARIS_AGENT_APP"
codesign --verify --deep --strict --verbose=2 "$TABULARIS_AGENT_APP"
```

### Register the installed app with Codex

Point the MCP entry at the executable inside the stable app bundle. The explicit profile directory must already exist and contain the configured connection. Cold starts forward this profile to the app; an isolated wrapper can also set it in Info.plist's LSEnvironment for manual launches.

```sh
TABULARIS_AGENT_DATA="$HOME/Library/Application Support/tabularis-agent-dev"
codex mcp add tabularis --env "TABULARIS_DATA_DIR=$TABULARIS_AGENT_DATA" \
  -- "$HOME/Applications/Tabularis Agent.app/Contents/MacOS/tabularis" --mcp
```

Pending UI requests are replayed when editor listeners become ready. The main window atomically claims each request before opening files or running SQL, so listener changes cannot execute the same request twice.

Set this server's tool_timeout_sec to 150 to cover the bounded desktop request waits. After a SQL timeout, inspect list_visible_tabs before another run; a transport timeout does not establish that execution was canceled.

For the local DuckDB development service, build `integrations/quackapi-driver` with `cargo build --release`. Install its `.tabularium` manifest and `target/release/tabularis-quackapi-driver` executable in Tabularis' `plugins/drivers/quackapi-local` directory, then restart Tabularis. Create a connection named `dev` with host `127.0.0.1` and port `9495`.

The driver sends SQL to the existing local QuackAPI `/sql` endpoint and rejects non-loopback hosts. It uses column metadata to encode DECIMAL and integers outside JavaScript's safe range as exact strings at the JSON boundary; NULL and empty strings remain distinct. It does not start a server or use DuckDB's database file directly.

The QuackAPI driver is loaded by the desktop UI. The Rust MCP database executor does not load UI driver plugins, so `run_query`, `list_databases`, and `list_tables` do not support this driver. Use `run_visible_tab` to execute saved SQL through the active UI connection and receive its result from the visible tab.
