// Warlock GIS MCP - v0.1
//
// One tool: inspect_gis_dataset(dataset)
// Read-only schema inspection of one dataset in the fixed, locally
// configured PROD read-only enterprise geodatabase connection.
//
// Safety boundary:
// - The only caller input is a dataset name, validated against a strict
//   pattern before anything runs.
// - The worker runs with a fixed interpreter (from local config), a fixed
//   script path, no shell, and a timeout.
// - The worker's JSON is checked against a strict shape and for
//   connection details before it is returned. Anything unexpected fails
//   closed with a fixed error code.
// - Worker stderr is discarded. Logs carry dataset, result code and
//   duration only.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SERVER_NAME = "warlock-gis-mcp";
export const SERVER_VERSION = "0.1.0";
export const TOOL_NAME = "inspect_gis_dataset";
export const ENVIRONMENT = "PROD (read-only)";

export const DATASET_NAME_RE =
  /^[A-Za-z0-9_]{1,128}(\.[A-Za-z0-9_]{1,128}){1,2}$/;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_PATH = path.resolve(HERE, "..", "worker", "inspect_dataset.py");

const CONFIG_DIR_NAME = "WarlockGisMcp";
const CONFIG_FILE_NAME = "config.json";
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export const ERROR_CODES = new Set([
  "INVALID_NAME",
  "NOT_FOUND",
  "CONFIG_ERROR",
  "ARCPY_UNAVAILABLE",
  "UNSUPPORTED_DATASET_TYPE",
  "TIMEOUT",
  "INSPECTION_FAILED",
  "OUTPUT_REJECTED",
]);

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Read-only inspection of one dataset's schema in the City GIS PROD " +
    "enterprise geodatabase (fixed read-only connection). Returns dataset " +
    "type, geometry type, versioned/archived status, fields, subtypes and " +
    "the definitions of domains the dataset uses. Metadata only: no feature " +
    "data, no changes.",
  inputSchema: {
    type: "object",
    properties: {
      dataset: {
        type: "string",
        description:
          "Qualified dataset name, e.g. GIS.PARKS.PARKS. Letters, digits and " +
          "underscores in two or three dot-separated parts.",
        pattern: DATASET_NAME_RE.source,
        minLength: 3,
        maxLength: 386,
      },
    },
    required: ["dataset"],
    additionalProperties: false,
  },
  annotations: {
    title: "Inspect GIS dataset schema (PROD, read-only)",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ---------------------------------------------------------------------
// Input validation and result envelope
// ---------------------------------------------------------------------

export function isValidDatasetName(value) {
  return typeof value === "string" && DATASET_NAME_RE.test(value);
}

export function envelope(dataset, status, errorCode) {
  return {
    status,
    error_code: errorCode,
    environment: ENVIRONMENT,
    dataset,
    resolved_name: null,
    dataset_type: null,
    geometry_type: null,
    versioned: null,
    archived: null,
    fields: null,
    subtypes: null,
    domains: null,
    inspected_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  };
}

// ---------------------------------------------------------------------
// Local configuration (outside Git)
// ---------------------------------------------------------------------

export function configPath(env = process.env) {
  const base = env.LOCALAPPDATA;
  return base ? path.join(base, CONFIG_DIR_NAME, CONFIG_FILE_NAME) : null;
}

// Node needs only the interpreter and timeout. The worker reads the
// connection file path itself, so it never passes through this process.
export function loadConfig(env = process.env) {
  const file = configPath(env);
  if (!file || !existsSync(file)) return null;

  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }

  const pythonExe = config?.pythonExe;
  if (
    typeof pythonExe !== "string" ||
    !path.isAbsolute(pythonExe) ||
    path.basename(pythonExe).toLowerCase() !== "python.exe" ||
    !existsSync(pythonExe)
  ) {
    return null;
  }

  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (config.timeoutSeconds !== undefined) {
    const t = config.timeoutSeconds;
    if (!Number.isInteger(t) || t < 5 || t > 300) return null;
    timeoutSeconds = t;
  }

  return { pythonExe, timeoutSeconds };
}

// ---------------------------------------------------------------------
// Worker invocation
// ---------------------------------------------------------------------

// Resolves { ok, stdout, timedOut }. Never rejects.
export function runWorker(config, dataset) {
  return new Promise((resolve) => {
    execFile(
      config.pythonExe,
      [WORKER_PATH, dataset],
      {
        shell: false,
        windowsHide: true,
        timeout: config.timeoutSeconds * 1000,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout) => {
        // stderr is intentionally ignored: it may hold ArcPy messages
        // with server or instance details.
        if (error) {
          resolve({
            ok: false,
            stdout: "",
            timedOut:
              Boolean(error.killed) &&
              error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          });
        } else {
          resolve({ ok: true, stdout, timedOut: false });
        }
      }
    );
  });
}

// ---------------------------------------------------------------------
// Output validation (strict shape, no connection details)
// ---------------------------------------------------------------------

const TOP_KEYS = [
  "status", "error_code", "environment", "dataset", "resolved_name",
  "dataset_type", "geometry_type", "versioned", "archived", "fields",
  "subtypes", "domains", "inspected_at",
];
const FIELD_KEYS = [
  "name", "alias", "type", "length", "nullable", "required", "default", "domain",
];
const SUBTYPES_KEYS = ["field", "default_code", "values"];
const SUBTYPE_VALUE_KEYS = ["code", "name", "field_domains"];
const DOMAIN_KEYS = [
  "name", "description", "domain_type", "field_type", "coded_values", "range",
];

// Anything that looks like a path, connection property or secret.
const LEAK_PATTERNS = [
  /\.sde\b/i,
  /[A-Za-z]:[\\/]/,
  /\\\\/,
  /\bsde:/i,
  /password/i,
  /\b(server|instance|user(name)?|uid|pwd)\s*=/i,
];

const MAX_STRING = 1024;
const MAX_LIST = 10000;

function hasExactKeys(obj, keys) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const actual = Object.keys(obj);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

const isStr = (v) => typeof v === "string" && v.length <= MAX_STRING;
const isStrOrNull = (v) => v === null || isStr(v);
const isBoolOrNull = (v) => v === null || typeof v === "boolean";
const isInt = (v) => Number.isInteger(v);
const isScalar = (v) =>
  v === null || typeof v === "boolean" || Number.isFinite(v) || isStr(v);
const isList = (v) => Array.isArray(v) && v.length <= MAX_LIST;

function validField(f) {
  return (
    hasExactKeys(f, FIELD_KEYS) &&
    isStr(f.name) && isStrOrNull(f.alias) && isStr(f.type) &&
    isInt(f.length) && typeof f.nullable === "boolean" &&
    typeof f.required === "boolean" && isScalar(f.default) &&
    isStrOrNull(f.domain)
  );
}

function validSubtypes(s) {
  if (s === null) return true;
  return (
    hasExactKeys(s, SUBTYPES_KEYS) &&
    isStr(s.field) &&
    (s.default_code === null || isInt(s.default_code)) &&
    isList(s.values) &&
    s.values.every(
      (v) =>
        hasExactKeys(v, SUBTYPE_VALUE_KEYS) &&
        isInt(v.code) && isStrOrNull(v.name) &&
        v.field_domains && typeof v.field_domains === "object" &&
        !Array.isArray(v.field_domains) &&
        Object.entries(v.field_domains).every(([k, d]) => isStr(k) && isStr(d))
    )
  );
}

function validDomain(d) {
  if (!hasExactKeys(d, DOMAIN_KEYS)) return false;
  if (!isStr(d.name) || !isStrOrNull(d.description)) return false;
  if (!isStr(d.field_type)) return false;

  if (d.domain_type === "CodedValue") {
    return (
      d.range === null && isList(d.coded_values) &&
      d.coded_values.every(
        (c) => hasExactKeys(c, ["code", "description"]) &&
          isScalar(c.code) && isStrOrNull(c.description)
      )
    );
  }
  if (d.domain_type === "Range") {
    return (
      d.coded_values === null &&
      (d.range === null ||
        (hasExactKeys(d.range, ["min", "max"]) &&
          isScalar(d.range.min) && isScalar(d.range.max)))
    );
  }
  return false;
}

function containsLeak(value) {
  const text = JSON.stringify(value);
  return LEAK_PATTERNS.some((re) => re.test(text));
}

// Returns null if valid, otherwise a short reason (for tests only; never
// returned to the caller).
export function checkWorkerResult(result, requestedDataset) {
  if (!hasExactKeys(result, TOP_KEYS)) return "keys";
  if (result.environment !== ENVIRONMENT) return "environment";
  if (!isStr(result.inspected_at)) return "inspected_at";

  const { status, error_code: code } = result;

  if (status === "error") {
    if (!ERROR_CODES.has(code) || code === "NOT_FOUND") return "error_code";
  } else if (status === "not_found") {
    if (code !== "NOT_FOUND") return "error_code";
  } else if (status === "ok") {
    if (code !== null) return "error_code";
  } else {
    return "status";
  }

  // An INVALID_NAME result never echoes the rejected input.
  const expectedDataset = code === "INVALID_NAME" ? null : requestedDataset;
  if (result.dataset !== expectedDataset) return "dataset";

  if (status !== "ok") {
    const detail = TOP_KEYS.slice(4, 12);
    if (!detail.every((k) => result[k] === null)) return "detail_on_non_ok";
  } else {
    if (!isStr(result.resolved_name)) return "resolved_name";
    if (!["FeatureClass", "Table"].includes(result.dataset_type)) return "dataset_type";
    if (!isStrOrNull(result.geometry_type)) return "geometry_type";
    if (result.dataset_type === "Table" && result.geometry_type !== null) return "geometry_type";
    if (!isBoolOrNull(result.versioned)) return "versioned";
    if (!isBoolOrNull(result.archived)) return "archived";
    if (!isList(result.fields) || !result.fields.every(validField)) return "fields";
    if (!validSubtypes(result.subtypes)) return "subtypes";
    if (!isList(result.domains) || !result.domains.every(validDomain)) return "domains";
  }

  if (containsLeak(result)) return "leak";
  return null;
}

// ---------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------

export async function inspectDataset(
  dataset,
  { load = loadConfig, run = runWorker } = {}
) {
  if (!isValidDatasetName(dataset)) {
    return envelope(null, "error", "INVALID_NAME");
  }

  const config = load();
  if (!config) return envelope(dataset, "error", "CONFIG_ERROR");

  const outcome = await run(config, dataset);
  if (outcome.timedOut) return envelope(dataset, "error", "TIMEOUT");
  if (!outcome.ok) return envelope(dataset, "error", "INSPECTION_FAILED");

  let result;
  try {
    result = JSON.parse(String(outcome.stdout).trim());
  } catch {
    return envelope(dataset, "error", "OUTPUT_REJECTED");
  }

  if (checkWorkerResult(result, dataset) !== null) {
    return envelope(dataset, "error", "OUTPUT_REJECTED");
  }
  return result;
}

// One inspection at a time against PROD.
let queue = Promise.resolve();
function serialized(task) {
  const next = queue.then(task, task);
  queue = next.catch(() => {});
  return next;
}

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

// ---------------------------------------------------------------------
// MCP server (stdio)
// ---------------------------------------------------------------------

export async function main() {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [TOOL_DEFINITION],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    let result;
    if (name !== TOOL_NAME) {
      result = envelope(null, "error", "INVALID_NAME");
    } else if (
      !args || typeof args !== "object" ||
      Object.keys(args).length !== 1 || !("dataset" in args)
    ) {
      result = envelope(null, "error", "INVALID_NAME");
    } else {
      const started = Date.now();
      try {
        result = await serialized(() => inspectDataset(args.dataset));
      } catch {
        result = envelope(
          isValidDatasetName(args.dataset) ? args.dataset : null,
          "error",
          "INSPECTION_FAILED"
        );
      }
      log(
        `inspect dataset=${result.dataset ?? "(invalid)"} ` +
          `result=${result.error_code ?? "OK"} ms=${Date.now() - started}`
      );
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: result.status === "error",
    };
  });

  await server.connect(new StdioServerTransport());
  log(`v${SERVER_VERSION} started (${ENVIRONMENT})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    log("failed to start");
    process.exit(1);
  });
}
