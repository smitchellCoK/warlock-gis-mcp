# Warlock GIS MCP (v0.1)

A very small MCP server that gives Claude / Warlock one capability: **read-only
inspection of one dataset's schema** in the City's PROD enterprise geodatabase,
through a fixed, locally configured, read-only connection.

It is a companion to the Warlock GIS Engineering Pipeline. It is **not** a GIS
automation framework, and it has no execution capability.

> **Status:** v0.1 source and offline tests only. Not yet tested against a
> geodatabase. Not yet approved for use by the pipeline: SKILL-002 in
> `gis-engineering-pipeline` currently prohibits geodatabase connections
> (hard rule 2, §1, §12). Using this tool from the pipeline requires a
> reviewed change there.

---

## Public interface

One tool:

```
inspect_gis_dataset(dataset)
```

| | |
|---|---|
| `dataset` | Qualified name, 2 or 3 dot-separated parts of letters, digits and underscores, e.g. `GIS.PARKS.PARKS`. Nothing else is accepted. |
| Annotations | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false` |

Returns JSON:

| Key | Content |
|---|---|
| `status` | `ok`, `not_found`, or `error` |
| `error_code` | `null` when ok; otherwise one of `INVALID_NAME`, `NOT_FOUND`, `CONFIG_ERROR`, `ARCPY_UNAVAILABLE`, `UNSUPPORTED_DATASET_TYPE`, `TIMEOUT`, `INSPECTION_FAILED`, `OUTPUT_REJECTED` |
| `environment` | Always `PROD (read-only)` |
| `dataset` | The requested name (`null` for `INVALID_NAME`) |
| `resolved_name` | Name as stored, e.g. `GIS.PARKS.PARKS`, or `<FeatureDataset>/<name>` when inside a feature dataset |
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
Claude Desktop --stdio--> src/server.mjs --execFile, no shell--> ArcGIS Pro python.exe
                          (validate name,                         worker/inspect_dataset.py
                           check output, fail closed)             (metadata calls only)
                                                                         |
                        %LOCALAPPDATA%\WarlockGisMcp\config.json --> PROD read-only .sde
```

- **Node** handles MCP only. It reads `pythonExe` and `timeoutSeconds` from
  the local config. It never reads the `.sde` path.
- **The worker** reads the `.sde` path from the same local config, uses only
  `Exists`, `Describe`, `ListFields`, `ListDatasets`, `da.ListDomains`,
  `da.ListSubtypes`, and prints one JSON object. No cursors, SQL,
  geoprocessing tools, or file writes.
- Lookup is the workspace root, then one level into each feature dataset. It
  never walks the whole geodatabase.
- One inspection runs at a time.

### Safety controls

| Control | Where |
|---|---|
| Only a validated dataset name is accepted; no path, environment, SQL, or code | `isValidDatasetName` (Node) and `DATASET_NAME_RE` (worker) |
| Fixed interpreter and script, `execFile` with `shell: false`, timeout, output size limit | `runWorker` |
| Read-only metadata calls only | worker; enforced by an allowlist test |
| Connection details never returned: worker rejects output containing the `.sde` path, folder or file name; server rejects anything resembling a path, connection property or secret | `leaks_connection_details`, `checkWorkerResult` |
| Strict output shape: unexpected keys or types are rejected | `checkWorkerResult` |
| Worker stderr (may hold server/instance names) discarded; logs hold dataset, result code, duration only | `runWorker`, `log` |
| Fails closed on missing config, missing `.sde`, missing ArcPy, timeout, crash, bad output | all paths return an error code with no detail |
| `.sde` files and `config.json` never committed | `.gitignore` |

The code only reads, but the **primary control is the database account**:
the `.sde` connection must use an account with read-only privileges, confirmed
by the DBA.

---

## Setup (Windows workstation with ArcGIS Pro)

1. **Install dependencies** (from this folder):

   ```powershell
   npm install
   ```

   Confirm that `@modelcontextprotocol/sdk@1.32.1` (MCP TypeScript SDK v1)
   installed and that `npm audit` is clean. Commit `package-lock.json`.

2. **Create the local config** (outside Git):

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

3. **Register with Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "warlock-gis": {
         "command": "node",
         "args": ["C:\\Users\\SMitchel\\warlock\\warlock-gis-mcp\\src\\server.mjs"]
       }
     }
   }
   ```

   Restart Claude Desktop.

---

## Tests

```powershell
npm test
```

Offline only: no MCP SDK, ArcPy, or geodatabase needed. They cover the
interface, name validation, output validation and leak detection, fail-closed
handling, static checks that the worker uses only allowlisted ArcPy calls and
the server never uses a shell, `.gitignore` coverage, and the worker run
against a stand-in `arcpy` module in a temporary folder.

Worker tests need a Python on `PATH` (or `WARLOCK_TEST_PYTHON`). They use a
temporary `LOCALAPPDATA`, never the real config. Tests that need the stand-in
`arcpy` are skipped automatically if the interpreter has real ArcPy.

---

## Not in v0.1

Any write, execution, DEV/TEST targets, record counts or feature values,
relationship classes, attribute rules, indexes, privileges, or catalog
browsing. Add only when Warlock shows a need.
