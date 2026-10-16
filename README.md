# warlock-gis-mcp

A local MCP server for Claude Desktop / Cowork with **exactly one tool**:

```
inspect_gis_dataset(dataset)
```

It gives Warlock **read-only inspection of one dataset's schema** in the City's
PROD enterprise geodatabase, through a fixed, locally configured, read-only
connection, so engineering analysis can use the real schema before a script
is proposed. It is a companion to the Warlock GIS Engineering Pipeline and
uses the same deployment model as Warlock Jira MCP: a packaged `.mcpb` Claude
Desktop extension with no third-party dependencies.

It is **not** a GIS automation framework. It has no write or execution
capability.

> **Status:** v0.1.1 (fixes a false-positive leak rejection of a single
> backslash in metadata). Offline tests pass. Installed as a Claude Desktop
> extension and accepted on Windows/Cowork against `GIS.PARK.Park` (PROD,
> read-only). Not yet approved for use by the pipeline: SKILL-002 in
> `gis-engineering-pipeline` currently prohibits geodatabase connections;
> using this tool from the pipeline requires a reviewed change there.

---

## Public interface

| | |
|---|---|
| Tool | `inspect_gis_dataset` |
| `dataset` | Qualified name, 2 or 3 dot-separated parts of letters, digits and underscores, e.g. `GIS.PARK.Park`. Nothing else is accepted. No fuzzy matching. |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` |

Returns JSON:

| Key | Content |
|---|---|
| `status` | `ok`, `not_found`, or `error` |
| `error_code` | `null` when ok; otherwise one of `INVALID_NAME`, `NOT_FOUND`, `CONFIG_ERROR`, `ARCPY_UNAVAILABLE`, `UNSUPPORTED_DATASET_TYPE`, `TIMEOUT`, `INSPECTION_FAILED`, `OUTPUT_REJECTED` |
| `environment` | Always `PROD (read-only)` |
| `dataset` | The requested name (`null` for `INVALID_NAME`) |
| `resolved_name` | Name as stored, e.g. `GIS.PARK.Park`, or `<FeatureDataset>/<name>` when inside a feature dataset |
| `dataset_type` | `FeatureClass` or `Table` (other types return `UNSUPPORTED_DATASET_TYPE`) |
| `geometry_type` | e.g. `Polygon`; `null` for tables |
| `versioned`, `archived` | `true` / `false` / `null` |
| `fields[]` | `name`, `alias`, `type`, `length`, `nullable`, `required`, `default`, `domain` |
| `subtypes` | `null`, or `{ field, default_code, values: [{ code, name, field_domains }] }` |
| `domains[]` | Only domains referenced by this dataset's fields or subtypes: `name`, `description`, `domain_type`, `field_type`, `coded_values` or `range` |
| `inspected_at` | UTC timestamp |

On `not_found` or `error`, all detail keys are `null`. Errors are fixed codes
only; ArcPy messages are never returned.

---

## Architecture

```
Claude Desktop / Cowork
   │ stdio (newline-delimited JSON-RPC 2.0)
   ▼
server/index.js  ── minimal MCP server (same pattern as Warlock Jira MCP)
   │
server/core.js   ── validate name · resolve local config · run worker
   │                (execFile, no shell, timeout, one at a time)
   │                · check output shape · reject connection details
   ▼
ArcGIS Pro python.exe  worker/inspect_dataset.py  (metadata calls only)
   │
   └─ %LOCALAPPDATA%\WarlockGisMcp\config.json ──▶ PROD read-only .sde
```

- **No npm packages.** Node built-ins only (`child_process`, `fs`, `os`,
  `path`, `readline`). Claude Desktop runs it with its built-in Node.
- **The worker** uses only `Exists`, `Describe`, `ListFields`,
  `ListDatasets`, `da.ListDomains`, `da.ListSubtypes`, and prints one JSON
  object. No cursors, SQL, geoprocessing tools, or file writes.
- **Lookup** is the workspace root, then one level into each feature
  dataset. It never walks the whole geodatabase.
- **Start-up** is unconditional, as in Warlock Jira MCP, so the server starts
  however Claude's Node runtime loads it (any path spelling, any launcher).

### Local configuration (outside the repository and the package)

The server finds `WarlockGisMcp\config.json` without relying on Claude
passing `LOCALAPPDATA` through:

1. `%LOCALAPPDATA%\WarlockGisMcp\config.json`, if `LOCALAPPDATA` is set;
2. otherwise `<user profile>\AppData\Local\WarlockGisMcp\config.json`, where
   the profile folder comes from Node's `os.homedir()` (from `USERPROFILE`,
   or from the Windows account if that is missing).

If neither exists, every call returns `CONFIG_ERROR`. The server passes the
resolved path to the worker (`WARLOCK_GIS_MCP_CONFIG`), which accepts only a
path ending in `WarlockGisMcp\config.json`, and fills in `USERPROFILE`,
`LOCALAPPDATA` and `APPDATA` for ArcGIS Pro if the host did not pass them.
The folder name is not case-sensitive.

### Safety controls

| Control | Where |
|---|---|
| Only a validated dataset name is accepted; no path, environment, SQL, or code | `isValidDatasetName` (core) and `DATASET_NAME_RE` (worker) |
| Fixed interpreter and script, `execFile` with `shell: false`, timeout, output size limit, one inspection at a time | `runWorker`, `callTool` |
| Read-only metadata calls only | worker; enforced by an allowlist test |
| Connection details never returned: the worker rejects output containing the `.sde` path, folder or file name; the server rejects anything resembling a path, connection property or secret | `leaks_connection_details`, `checkWorkerResult` |
| Strict output shape: unexpected keys or types are rejected | `checkWorkerResult` |
| Worker stderr (may hold server/instance names) discarded; logs hold dataset, result code, duration only | `runWorker`, `log` |
| Fails closed on missing config, missing `.sde`, missing ArcPy, timeout, crash, bad output | every path returns an error code with no detail |
| No `.sde` file, config, credentials or logs in Git or the bundle | `.gitignore`; `scripts/build_mcpb.py` allowlist and checks |

The code only reads, but the **primary control is the database account**:
the `.sde` connection uses an account with read-only privileges, confirmed by
the DBA.

---

## Files

| Path | Purpose | In bundle |
|---|---|---|
| `manifest.json` | Claude Desktop extension manifest (MCPB 0.2). One tool, Windows only, no settings. | yes |
| `package.json` | Metadata. **No dependencies.** | yes |
| `server/index.js` | Minimal MCP stdio server: `initialize`, `ping`, `tools/list`, `tools/call`. | yes |
| `server/core.js` | Validation, config resolution, worker call, output checks. | yes |
| `worker/inspect_dataset.py` | ArcPy metadata inspection (ArcGIS Pro Python). | yes |
| `test/validate.test.mjs` | Offline tests. | no |
| `scripts/build_mcpb.py` | Builds the `.mcpb` with the Python standard library. | no |
| `config.example.json` | Placeholder config. | no |
| `.gitignore` | Keeps connection files, config, logs and build output out of Git. | no |

---

## Local config (once per workstation)

Skip if `%LOCALAPPDATA%\WarlockGisMcp\config.json` already exists.

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\WarlockGisMcp"
Copy-Item config.example.json "$env:LOCALAPPDATA\WarlockGisMcp\config.json"
notepad "$env:LOCALAPPDATA\WarlockGisMcp\config.json"
```

| Key | Value |
|---|---|
| `pythonExe` | ArcGIS Pro Python, normally `C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe` |
| `sdeConnectionFile` | Absolute path to the PROD **read-only** `.sde` file |
| `timeoutSeconds` | Optional, 5–300 (default 60) |

Restrict the `.sde` file and config to your account.

---

## Test and build (no network, no geodatabase)

PowerShell's execution policy may block `npm.ps1`; use `npm.cmd`, or call
Node directly.

```powershell
npm.cmd test        # or: node --test

& "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" scripts\build_mcpb.py
```

Result: `dist\warlock-gis-mcp-0.1.1.mcpb` and its SHA-256. The build is
reproducible (same source files → same SHA-256), refuses to run if the
manifest or package declare anything unexpected, bundles only the five
runtime files, and checks them for connection file paths.

The tests never read the real config: every test that resolves config or
runs the server/worker uses a temporary profile folder. Tests that need a
stand-in `arcpy` are skipped automatically if the interpreter has real ArcPy.

---

## Install in Claude Desktop (manual)

1. Claude Desktop → **Settings → Extensions**.
2. Install from file (or drag the file onto the page):
   `dist\warlock-gis-mcp-0.1.1.mcpb`.
3. Review the prompt. There are no settings to enter: the extension reads
   only the local config file.
4. Keep **Use built-in Node.js for MCP** enabled (Settings → Extensions,
   advanced), as for Warlock Jira MCP.

Do **not** register this server through Developer → *Edit Config*
(`claude_desktop_config.json`).

Uninstall: Settings → Extensions → Warlock GIS Schema → Uninstall. The local
config and `.sde` file are not touched.

Updating: rebuild, then install the new `.mcpb` over the old one. Editing
the source folder has no effect on the installed extension.

---

## Verify Cowork can see the tool

1. Restart Claude Desktop after installing.
2. Start a new Cowork session.
3. Ask: *"List your tools whose names contain inspect_gis_dataset. Do not
   call any tool."*
4. Expected: one tool, `inspect_gis_dataset`, with only a `dataset`
   parameter.

---

## Controlled first test

1. Call `inspect_gis_dataset("GIS.PARK.DoesNotExist")` → expect `NOT_FOUND`.
2. Call `inspect_gis_dataset("GIS.PARK.Park")` → expect `status: ok`;
   compare with the direct worker result.
3. Confirm the output contains no path, server name, user name or
   credentials.

If a call returns `CONFIG_ERROR`, the extension could not find the local
config; `ARCPY_UNAVAILABLE` or `INSPECTION_FAILED` while the direct worker
works means the extension's process environment differs. Check the
extension's MCP log (Settings → Developer → Open Logs Folder): it holds only
start-up lines and `tool_call` lines with dataset, result code and duration.

---

## Not in v0.1

Any write, execution, DEV/TEST targets, record counts or feature values,
relationship classes, attribute rules, indexes, privileges, catalog
browsing, or fuzzy name matching. Add only when Warlock shows a need.
