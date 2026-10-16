'use strict';

// Warlock GIS MCP - core logic (no MCP protocol code here).
//
// One tool: inspect_gis_dataset(dataset)
// Read-only schema inspection of one dataset in the fixed, locally
// configured PROD read-only enterprise geodatabase connection.
//
// Safety boundary:
// - The only caller input is a dataset name, validated against a strict
//   pattern before anything runs.
// - The worker runs with a fixed interpreter (from local config), a fixed
//   script path, no shell, a timeout, and one inspection at a time.
// - The worker's JSON is checked against a strict shape and for
//   connection details before it is returned. Anything unexpected fails
//   closed with a fixed error code.
// - Worker stderr is discarded. Logs carry dataset, result code and
//   duration only.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOOL_NAME = 'inspect_gis_dataset';
const ENVIRONMENT = 'PROD (read-only)';

const DATASET_NAME_RE = /^[A-Za-z0-9_]{1,128}(\.[A-Za-z0-9_]{1,128}){1,2}$/;

const WORKER_PATH = path.resolve(__dirname, '..', 'worker', 'inspect_dataset.py');

const CONFIG_DIR_NAME = 'WarlockGisMcp';
const CONFIG_FILE_NAME = 'config.json';
// Passed to the worker so it reads the same config file the server
// resolved. Set only by this server, never by the caller.
const CONFIG_ENV_VAR = 'WARLOCK_GIS_MCP_CONFIG';
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

const ERROR_CODES = new Set([
  'INVALID_NAME',
  'NOT_FOUND',
  'CONFIG_ERROR',
  'ARCPY_UNAVAILABLE',
  'UNSUPPORTED_DATASET_TYPE',
  'TIMEOUT',
  'INSPECTION_FAILED',
  'OUTPUT_REJECTED'
]);

const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    'Read-only inspection of one dataset\'s schema in the City GIS PROD ' +
    'enterprise geodatabase (fixed read-only connection). Returns dataset ' +
    'type, geometry type, versioned/archived status, fields, subtypes and ' +
    'the definitions of domains the dataset uses. Metadata only: no feature ' +
    'data, no changes.',
  inputSchema: {
    type: 'object',
    properties: {
      dataset: {
        type: 'string',
        description:
          'Qualified dataset name, e.g. GIS.PARKS.PARKS. Letters, digits and ' +
          'underscores in two or three dot-separated parts.',
        pattern: DATASET_NAME_RE.source,
        minLength: 3,
        maxLength: 386
      }
    },
    required: ['dataset'],
    additionalProperties: false
  },
  annotations: {
    title: 'Inspect GIS dataset schema (PROD, read-only)',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
};

// ---------------------------------------------------------------------
// Input validation and result envelope
// ---------------------------------------------------------------------

function isValidDatasetName(value) {
  return typeof value === 'string' && DATASET_NAME_RE.test(value);
}

function envelope(dataset, status, errorCode) {
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
    inspected_at: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
  };
}

// ---------------------------------------------------------------------
// Local configuration (outside the repository and the package)
// ---------------------------------------------------------------------

// Candidate locations of %LOCALAPPDATA%\WarlockGisMcp\config.json, in
// order. Does not rely on the host passing LOCALAPPDATA through: the
// second candidate is derived from the user's profile folder, which
// os.homedir() resolves from USERPROFILE or, if that is missing, from the
// Windows account itself.
function configCandidates(env = process.env, homedir = os.homedir) {
  const candidates = [];
  const add = (base) => {
    if (typeof base === 'string' && base && path.isAbsolute(base)) {
      const file = path.join(base, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
      if (!candidates.includes(file)) candidates.push(file);
    }
  };

  add(env.LOCALAPPDATA);
  let home = '';
  try {
    home = homedir();
  } catch {
    home = '';
  }
  if (home) add(path.join(home, 'AppData', 'Local'));
  return candidates;
}

function resolveConfigPath(env = process.env, homedir = os.homedir) {
  for (const file of configCandidates(env, homedir)) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here; try the next candidate
    }
  }
  return null;
}

// Node needs only the interpreter and timeout. The worker reads the
// connection file path itself, so it never passes through this process.
function loadConfig(env = process.env, homedir = os.homedir) {
  const file = resolveConfigPath(env, homedir);
  if (!file) return null;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }

  const pythonExe = config && config.pythonExe;
  if (
    typeof pythonExe !== 'string' ||
    !path.isAbsolute(pythonExe) ||
    path.basename(pythonExe).toLowerCase() !== 'python.exe' ||
    !fs.existsSync(pythonExe)
  ) {
    return null;
  }

  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (config.timeoutSeconds !== undefined) {
    const t = config.timeoutSeconds;
    if (!Number.isInteger(t) || t < 5 || t > 300) return null;
    timeoutSeconds = t;
  }

  return { pythonExe, timeoutSeconds, configPath: file };
}

// Environment for the worker: the server's own environment, the resolved
// config path, and the standard Windows profile folders filled in if the
// host did not pass them (ArcGIS Pro expects them).
function workerEnv(config, env = process.env, homedir = os.homedir) {
  const out = { ...env, [CONFIG_ENV_VAR]: config.configPath };
  let home = '';
  try {
    home = homedir();
  } catch {
    home = '';
  }
  if (home) {
    if (!out.USERPROFILE) out.USERPROFILE = home;
    if (!out.LOCALAPPDATA) out.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
    if (!out.APPDATA) out.APPDATA = path.join(home, 'AppData', 'Roaming');
  }
  return out;
}

// ---------------------------------------------------------------------
// Worker invocation
// ---------------------------------------------------------------------

// Resolves { ok, stdout, timedOut }. Never rejects.
function runWorker(config, dataset) {
  return new Promise((resolve) => {
    execFile(
      config.pythonExe,
      [WORKER_PATH, dataset],
      {
        shell: false,
        windowsHide: true,
        timeout: config.timeoutSeconds * 1000,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
        env: workerEnv(config)
      },
      (error, stdout) => {
        // stderr is intentionally ignored: it may hold ArcPy messages
        // with server or instance details.
        if (error) {
          resolve({
            ok: false,
            stdout: '',
            timedOut:
              Boolean(error.killed) &&
              error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
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
  'status', 'error_code', 'environment', 'dataset', 'resolved_name',
  'dataset_type', 'geometry_type', 'versioned', 'archived', 'fields',
  'subtypes', 'domains', 'inspected_at'
];
const FIELD_KEYS = [
  'name', 'alias', 'type', 'length', 'nullable', 'required', 'default', 'domain'
];
const SUBTYPES_KEYS = ['field', 'default_code', 'values'];
const SUBTYPE_VALUE_KEYS = ['code', 'name', 'field_domains'];
const DOMAIN_KEYS = [
  'name', 'description', 'domain_type', 'field_type', 'coded_values', 'range'
];

// Anything that looks like a path, connection property or secret.
const LEAK_PATTERNS = [
  /\.sde\b/i,
  /[A-Za-z]:[\\/]/,
  // UNC path: two literal backslashes, i.e. four in the JSON text that
  // containsLeak tests. A single backslash (two in JSON) is ordinary text.
  /\\\\\\\\/,
  /\bsde:/i,
  /password/i,
  /\b(server|instance|user(name)?|uid|pwd)\s*=/i
];

const MAX_STRING = 1024;
const MAX_LIST = 10000;

function hasExactKeys(obj, keys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const actual = Object.keys(obj);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

const isStr = (v) => typeof v === 'string' && v.length <= MAX_STRING;
const isStrOrNull = (v) => v === null || isStr(v);
const isBoolOrNull = (v) => v === null || typeof v === 'boolean';
const isInt = (v) => Number.isInteger(v);
const isScalar = (v) =>
  v === null || typeof v === 'boolean' || Number.isFinite(v) || isStr(v);
const isList = (v) => Array.isArray(v) && v.length <= MAX_LIST;

function validField(f) {
  return (
    hasExactKeys(f, FIELD_KEYS) &&
    isStr(f.name) && isStrOrNull(f.alias) && isStr(f.type) &&
    isInt(f.length) && typeof f.nullable === 'boolean' &&
    typeof f.required === 'boolean' && isScalar(f.default) &&
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
        v.field_domains && typeof v.field_domains === 'object' &&
        !Array.isArray(v.field_domains) &&
        Object.entries(v.field_domains).every(([k, d]) => isStr(k) && isStr(d))
    )
  );
}

function validDomain(d) {
  if (!hasExactKeys(d, DOMAIN_KEYS)) return false;
  if (!isStr(d.name) || !isStrOrNull(d.description)) return false;
  if (!isStr(d.field_type)) return false;

  if (d.domain_type === 'CodedValue') {
    return (
      d.range === null && isList(d.coded_values) &&
      d.coded_values.every(
        (c) => hasExactKeys(c, ['code', 'description']) &&
          isScalar(c.code) && isStrOrNull(c.description)
      )
    );
  }
  if (d.domain_type === 'Range') {
    return (
      d.coded_values === null &&
      (d.range === null ||
        (hasExactKeys(d.range, ['min', 'max']) &&
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
function checkWorkerResult(result, requestedDataset) {
  if (!hasExactKeys(result, TOP_KEYS)) return 'keys';
  if (result.environment !== ENVIRONMENT) return 'environment';
  if (!isStr(result.inspected_at)) return 'inspected_at';

  const status = result.status;
  const code = result.error_code;

  if (status === 'error') {
    if (!ERROR_CODES.has(code) || code === 'NOT_FOUND') return 'error_code';
  } else if (status === 'not_found') {
    if (code !== 'NOT_FOUND') return 'error_code';
  } else if (status === 'ok') {
    if (code !== null) return 'error_code';
  } else {
    return 'status';
  }

  // An INVALID_NAME result never echoes the rejected input.
  const expectedDataset = code === 'INVALID_NAME' ? null : requestedDataset;
  if (result.dataset !== expectedDataset) return 'dataset';

  if (status !== 'ok') {
    const detail = TOP_KEYS.slice(4, 12);
    if (!detail.every((k) => result[k] === null)) return 'detail_on_non_ok';
  } else {
    if (!isStr(result.resolved_name)) return 'resolved_name';
    if (!['FeatureClass', 'Table'].includes(result.dataset_type)) return 'dataset_type';
    if (!isStrOrNull(result.geometry_type)) return 'geometry_type';
    if (result.dataset_type === 'Table' && result.geometry_type !== null) return 'geometry_type';
    if (!isBoolOrNull(result.versioned)) return 'versioned';
    if (!isBoolOrNull(result.archived)) return 'archived';
    if (!isList(result.fields) || !result.fields.every(validField)) return 'fields';
    if (!validSubtypes(result.subtypes)) return 'subtypes';
    if (!isList(result.domains) || !result.domains.every(validDomain)) return 'domains';
  }

  if (containsLeak(result)) return 'leak';
  return null;
}

// ---------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------

async function inspectDataset(dataset, deps = {}) {
  const load = deps.load || loadConfig;
  const run = deps.run || runWorker;

  if (!isValidDatasetName(dataset)) {
    return envelope(null, 'error', 'INVALID_NAME');
  }

  const config = load();
  if (!config) return envelope(dataset, 'error', 'CONFIG_ERROR');

  const outcome = await run(config, dataset);
  if (outcome.timedOut) return envelope(dataset, 'error', 'TIMEOUT');
  if (!outcome.ok) return envelope(dataset, 'error', 'INSPECTION_FAILED');

  let result;
  try {
    result = JSON.parse(String(outcome.stdout).trim());
  } catch {
    return envelope(dataset, 'error', 'OUTPUT_REJECTED');
  }

  if (checkWorkerResult(result, dataset) !== null) {
    return envelope(dataset, 'error', 'OUTPUT_REJECTED');
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

// Entry point for tools/call. `args` is the raw arguments object.
// Never throws; always returns a result envelope.
async function callTool(args, deps = {}) {
  if (
    !args || typeof args !== 'object' || Array.isArray(args) ||
    Object.keys(args).length !== 1 || !('dataset' in args)
  ) {
    return envelope(null, 'error', 'INVALID_NAME');
  }
  try {
    return await serialized(() => inspectDataset(args.dataset, deps));
  } catch {
    return envelope(
      isValidDatasetName(args.dataset) ? args.dataset : null,
      'error',
      'INSPECTION_FAILED'
    );
  }
}

module.exports = {
  TOOL_NAME,
  TOOL_DEFINITION,
  ENVIRONMENT,
  DATASET_NAME_RE,
  ERROR_CODES,
  WORKER_PATH,
  CONFIG_ENV_VAR,
  isValidDatasetName,
  envelope,
  configCandidates,
  resolveConfigPath,
  loadConfig,
  workerEnv,
  runWorker,
  checkWorkerResult,
  inspectDataset,
  callTool
};
