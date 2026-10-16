// Offline tests for Warlock GIS MCP v0.1.
// No MCP SDK, no ArcPy, no geodatabase connection required.
//
//   npm test        (or: node --test)
//
// The worker fail-closed tests need a Python interpreter on PATH (or set
// WARLOCK_TEST_PYTHON). They use a temporary LOCALAPPDATA, never the real
// config, and the ArcPy-unavailable test is skipped automatically if the
// interpreter has arcpy, so these tests never open a real connection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOL_DEFINITION,
  TOOL_NAME,
  ENVIRONMENT,
  WORKER_PATH,
  isValidDatasetName,
  envelope,
  checkWorkerResult,
  inspectDataset,
  loadConfig,
} from "../src/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

function okResult(overrides = {}) {
  return {
    status: "ok",
    error_code: null,
    environment: ENVIRONMENT,
    dataset: "GIS.PARKS.PARKS",
    resolved_name: "GIS.PARKS.PARKS",
    dataset_type: "FeatureClass",
    geometry_type: "Polygon",
    versioned: true,
    archived: false,
    fields: [
      { name: "OBJECTID", alias: "OBJECTID", type: "OID", length: 4,
        nullable: false, required: true, default: null, domain: null },
      { name: "Status", alias: "Status", type: "String", length: 20,
        nullable: true, required: false, default: "Active", domain: "ParkStatus" },
      { name: "Shape.STArea()", alias: "Shape.STArea()", type: "Double", length: 8,
        nullable: true, required: true, default: null, domain: null },
    ],
    subtypes: {
      field: "ParkType",
      default_code: 1,
      values: [
        { code: 1, name: "Neighbourhood", field_domains: { Status: "ParkStatus" } },
        { code: 2, name: "Regional", field_domains: {} },
      ],
    },
    domains: [
      { name: "ParkStatus", description: "Park status", domain_type: "CodedValue",
        field_type: "Text", range: null,
        coded_values: [{ code: "Active", description: "Active" },
                       { code: "Closed", description: "Closed" }] },
      { name: "Slope", description: null, domain_type: "Range",
        field_type: "Double", coded_values: null, range: { min: 0, max: 90 } },
    ],
    inspected_at: "2026-10-16T20:00:00+00:00",
    ...overrides,
  };
}

const fakeConfig = () => ({ pythonExe: "C:\\fake\\python.exe", timeoutSeconds: 60 });

// ---------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------

test("exactly one tool, read-only annotations, single dataset argument", () => {
  assert.equal(TOOL_DEFINITION.name, "inspect_gis_dataset");
  assert.equal(TOOL_NAME, "inspect_gis_dataset");
  assert.deepEqual(Object.keys(TOOL_DEFINITION.inputSchema.properties), ["dataset"]);
  assert.deepEqual(TOOL_DEFINITION.inputSchema.required, ["dataset"]);
  assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal(TOOL_DEFINITION.annotations.readOnlyHint, true);
  assert.equal(TOOL_DEFINITION.annotations.destructiveHint, false);
  assert.equal(TOOL_DEFINITION.annotations.openWorldHint, false);
});

// ---------------------------------------------------------------------
// Dataset name validation
// ---------------------------------------------------------------------

test("accepts qualified dataset names", () => {
  for (const name of ["GIS.PARKS.PARKS", "GIS.Parks", "gis.util.Fleet_Unit", "A.B"]) {
    assert.equal(isValidDatasetName(name), true, name);
  }
});

test("rejects paths, SQL, code and malformed names", () => {
  const bad = [
    "", "PARKS", "GIS..PARKS", ".GIS.PARKS", "GIS.PARKS.", "A.B.C.D",
    "C:\\data\\prod.sde\\GIS.PARKS", "..\\GIS.PARKS", "GIS/PARKS",
    "GIS.PARKS; DROP TABLE x", "GIS.PARKS' OR '1'='1", "GIS.PARKS PARKS",
    "GIS.PARKS\n", "GIS.PARKS && calc", "$(whoami).X", "GIS.PÄRKS",
    "A." + "B".repeat(129), null, undefined, 42, ["GIS.PARKS"], { d: "GIS.PARKS" },
  ];
  for (const name of bad) {
    assert.equal(isValidDatasetName(name), false, JSON.stringify(name));
  }
});

// ---------------------------------------------------------------------
// Output validation
// ---------------------------------------------------------------------

test("accepts a well-formed ok result", () => {
  assert.equal(checkWorkerResult(okResult(), "GIS.PARKS.PARKS"), null);
});

test("accepts a Table with no geometry, subtypes or domains", () => {
  const r = okResult({ dataset_type: "Table", geometry_type: null,
                       subtypes: null, domains: [] });
  assert.equal(checkWorkerResult(r, "GIS.PARKS.PARKS"), null);
});

test("accepts not_found and error envelopes", () => {
  assert.equal(checkWorkerResult(envelope("GIS.X.Y", "not_found", "NOT_FOUND"), "GIS.X.Y"), null);
  assert.equal(checkWorkerResult(envelope("GIS.X.Y", "error", "CONFIG_ERROR"), "GIS.X.Y"), null);
  assert.equal(checkWorkerResult(envelope(null, "error", "INVALID_NAME"), "GIS.X.Y"), null);
});

test("rejects extra, missing or mistyped keys", () => {
  const ds = "GIS.PARKS.PARKS";
  assert.notEqual(checkWorkerResult({ ...okResult(), catalog_path: "x" }, ds), null);
  const missing = okResult(); delete missing.archived;
  assert.notEqual(checkWorkerResult(missing, ds), null);
  assert.notEqual(checkWorkerResult(okResult({ versioned: "yes" }), ds), null);
  assert.notEqual(checkWorkerResult(okResult({ dataset_type: "RasterDataset" }), ds), null);
  assert.notEqual(checkWorkerResult(okResult({ environment: "DEV" }), ds), null);
  assert.notEqual(checkWorkerResult(okResult({ error_code: "NOT_FOUND" }), ds), null);

  const field = okResult();
  field.fields[0].precision = 0;
  assert.notEqual(checkWorkerResult(field, ds), null);

  const domain = okResult();
  domain.domains[0].split_policy = "Default";
  assert.notEqual(checkWorkerResult(domain, ds), null);
});

test("rejects a result for a different dataset than requested", () => {
  assert.notEqual(checkWorkerResult(okResult(), "GIS.OTHER.PARKS"), null);
});

test("rejects detail fields on non-ok results", () => {
  const r = envelope("GIS.X.Y", "not_found", "NOT_FOUND");
  r.fields = [];
  assert.notEqual(checkWorkerResult(r, "GIS.X.Y"), null);
});

test("rejects results that contain connection details", () => {
  const ds = "GIS.PARKS.PARKS";
  const leaks = [
    "C:\\kelowna\\DatabaseConnections\\prod.sde",
    "prod_readonly.sde",
    "\\\\fileserver\\share",
    "sde:sqlserver:gisdb01",
    "SERVER=gisdb01",
    "Instance = sde:oracle",
    "User=gis_reader",
    "password",
  ];
  for (const text of leaks) {
    const r = okResult();
    r.fields[1].alias = text;
    assert.equal(checkWorkerResult(r, ds), "leak", text);
  }
});

// ---------------------------------------------------------------------
// Handler fails closed
// ---------------------------------------------------------------------

test("invalid name never loads config or runs the worker", async () => {
  let called = false;
  const r = await inspectDataset("C:\\x.sde", {
    load: () => { called = true; return fakeConfig(); },
    run: async () => { called = true; return { ok: true, stdout: "" }; },
  });
  assert.equal(called, false);
  assert.equal(r.error_code, "INVALID_NAME");
  assert.equal(r.dataset, null);
});

test("missing config -> CONFIG_ERROR, worker not run", async () => {
  let ran = false;
  const r = await inspectDataset("GIS.PARKS.PARKS", {
    load: () => null,
    run: async () => { ran = true; return { ok: true, stdout: "" }; },
  });
  assert.equal(ran, false);
  assert.equal(r.error_code, "CONFIG_ERROR");
});

test("timeout, failure, bad JSON and bad shape all fail closed", async () => {
  const cases = [
    [{ ok: false, stdout: "", timedOut: true }, "TIMEOUT"],
    [{ ok: false, stdout: "", timedOut: false }, "INSPECTION_FAILED"],
    [{ ok: true, stdout: "Traceback (most recent call last):", timedOut: false }, "OUTPUT_REJECTED"],
    [{ ok: true, stdout: JSON.stringify({ status: "ok" }), timedOut: false }, "OUTPUT_REJECTED"],
    [{ ok: true, stdout: JSON.stringify(okResult({ resolved_name: "C:\\db.sde\\GIS.PARKS.PARKS" })), timedOut: false }, "OUTPUT_REJECTED"],
  ];
  for (const [outcome, code] of cases) {
    const r = await inspectDataset("GIS.PARKS.PARKS", {
      load: fakeConfig, run: async () => outcome,
    });
    assert.equal(r.status, "error");
    assert.equal(r.error_code, code);
    assert.equal(r.fields, null);
    assert.equal(checkWorkerResult(r, "GIS.PARKS.PARKS"), null);
  }
});

test("valid worker output is passed through unchanged", async () => {
  const expected = okResult();
  const r = await inspectDataset("GIS.PARKS.PARKS", {
    load: fakeConfig,
    run: async () => ({ ok: true, stdout: JSON.stringify(expected) + "\n", timedOut: false }),
  });
  assert.deepEqual(r, expected);
});

test("loadConfig fails closed without a usable config", () => {
  assert.equal(loadConfig({}), null);
  const dir = mkdtempSync(path.join(tmpdir(), "warlock-cfg-"));
  try {
    assert.equal(loadConfig({ LOCALAPPDATA: dir }), null);
    mkdirSync(path.join(dir, "WarlockGisMcp"));
    const file = path.join(dir, "WarlockGisMcp", "config.json");
    writeFileSync(file, "{ not json");
    assert.equal(loadConfig({ LOCALAPPDATA: dir }), null);
    writeFileSync(file, JSON.stringify({ pythonExe: "python.exe" }));
    assert.equal(loadConfig({ LOCALAPPDATA: dir }), null);
    writeFileSync(file, JSON.stringify({ pythonExe: path.join(dir, "missing", "python.exe") }));
    assert.equal(loadConfig({ LOCALAPPDATA: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Static safety checks on the source
// ---------------------------------------------------------------------

test("worker uses only allowlisted ArcPy metadata calls", () => {
  const src = read("worker/inspect_dataset.py");
  const code = src.replace(/"""[\s\S]*?"""/g, "").replace(/#.*$/gm, "");
  const allowed = new Set([
    "arcpy.Exists", "arcpy.Describe", "arcpy.ListFields", "arcpy.ListDatasets",
    "arcpy.da.ListDomains", "arcpy.da.ListSubtypes", "arcpy.env.workspace",
  ]);
  const used = new Set(code.match(/arcpy(\.[A-Za-z_]+)+/g) || []);
  for (const call of used) assert.ok(allowed.has(call), `not allowlisted: ${call}`);
  assert.ok(used.size > 0);
});

test("worker contains no SQL, cursors, writes, shell or dynamic code", () => {
  const code = read("worker/inspect_dataset.py")
    .replace(/"""[\s\S]*?"""/g, "").replace(/#.*$/gm, "");
  const forbidden = [
    "subprocess", "os.system", "os.popen", "__import__", "importlib", "ArcSDESQLExecute", "Cursor", "arcpy.management",
    "arcpy.mp", "arcpy.conversion", "Editor", "sys.argv[2", "input(",
  ];
  for (const token of forbidden) assert.ok(!code.includes(token), token);
  // Built-in eval/exec/compile (re.compile is allowed).
  assert.ok(!/(?<![\w.])(eval|exec|compile)\s*\(/.test(code), "dynamic code");
  assert.equal((code.match(/\bopen\(/g) || []).length, 1, "only the config read may open a file");
  assert.ok(!/open\([^)]*["'][wa+]/.test(code), "no file opened for writing");
});

test("server spawns only with execFile and never with a shell", () => {
  const src = read("src/server.mjs");
  const imports = src.match(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/);
  assert.ok(imports);
  assert.deepEqual(imports[1].split(",").map((s) => s.trim()).filter(Boolean), ["execFile"]);
  assert.ok(src.includes("shell: false"));
  for (const token of ["shell: true", "spawn(", "execSync", "eval(", "new Function"]) {
    assert.ok(!src.includes(token), token);
  }
});

test("connection files and local config are excluded from Git", () => {
  const lines = read(".gitignore").split(/\r?\n/).map((l) => l.trim());
  for (const entry of ["*.sde", "config.json", "*.log", "node_modules/"]) {
    assert.ok(lines.includes(entry), entry);
  }
  const example = JSON.parse(read("config.example.json"));
  assert.match(example.sdeConnectionFile, /\\path\\to\\/);
});

// ---------------------------------------------------------------------
// Worker fails closed (real Python, no ArcPy connection)
// ---------------------------------------------------------------------

function findPython() {
  const candidates = [process.env.WARLOCK_TEST_PYTHON, "python3", "python"].filter(Boolean);
  for (const exe of candidates) {
    const r = spawnSync(exe, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return exe;
  }
  return null;
}

const PYTHON = findPython();

function hasArcpy() {
  const r = spawnSync(PYTHON, ["-I", "-c",
    "import importlib.util,sys;sys.exit(0 if importlib.util.find_spec('arcpy') else 1)"]);
  return r.status === 0;
}

function runWorkerWith(env, args) {
  const out = execFileSync(PYTHON, [WORKER_PATH, ...args], {
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const lines = out.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, "worker prints exactly one line");
  return JSON.parse(lines[0]);
}

test("worker rejects invalid names before reading config", { skip: !PYTHON }, () => {
  for (const args of [["C:\\x.sde"], ["GIS.PARKS; x"], [], ["GIS.A", "GIS.B"]]) {
    const r = runWorkerWith({}, args);
    assert.equal(r.error_code, "INVALID_NAME");
    assert.equal(checkWorkerResult(r, "unused"), null);
  }
});

test("worker returns CONFIG_ERROR without a usable config", { skip: !PYTHON }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "warlock-wk-"));
  try {
    assert.equal(runWorkerWith({}, ["GIS.PARKS.PARKS"]).error_code, "CONFIG_ERROR");
    assert.equal(runWorkerWith({ LOCALAPPDATA: dir }, ["GIS.PARKS.PARKS"]).error_code, "CONFIG_ERROR");

    mkdirSync(path.join(dir, "WarlockGisMcp"));
    const cfg = path.join(dir, "WarlockGisMcp", "config.json");
    writeFileSync(cfg, JSON.stringify({ sdeConnectionFile: path.join(dir, "missing.sde") }));
    const r = runWorkerWith({ LOCALAPPDATA: dir }, ["GIS.PARKS.PARKS"]);
    assert.equal(r.error_code, "CONFIG_ERROR");
    assert.equal(checkWorkerResult(r, "GIS.PARKS.PARKS"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stand-in arcpy module (temporary folder only) so the worker's
// inspection path and output shape can be tested with no ArcGIS at all.
const FAKE_ARCPY = String.raw`
import os
from types import SimpleNamespace as NS

class _Env: workspace = None
env = _Env()

_FD = "GIS.Parks_FD"
_FC = "GIS.PARKS.PARKS"

def _rel(p):
    return os.path.relpath(p, os.environ["FAKE_SDE"]).replace(os.sep, "/")

def Exists(p):
    return _rel(p) in (_FD + "/" + _FC, "GIS.UTIL.Leaky")

def ListDatasets(feature_type=None):
    return [_FD]

def Describe(p):
    name = _rel(p).split("/")[-1]
    return NS(name=name, dataType="FeatureClass", shapeType="Polygon",
              isVersioned=True, isArchived=False, subtypeFieldName="ParkType")

def ListFields(p):
    alias = os.environ["FAKE_SDE"] if _rel(p) == "GIS.UTIL.Leaky" else "Status"
    return [
        NS(name="OBJECTID", aliasName="OBJECTID", type="OID", length=4,
           isNullable=False, required=True, defaultValue=None, domain=""),
        NS(name="Status", aliasName=alias, type="String", length=20,
           isNullable=True, required=False, defaultValue="Active", domain="ParkStatus"),
        NS(name="ParkType", aliasName="Park Type", type="SmallInteger", length=2,
           isNullable=True, required=False, defaultValue=1, domain=""),
    ]

class da:
    @staticmethod
    def ListSubtypes(p):
        return {
            1: {"Name": "Neighbourhood", "Default": True, "SubtypeField": "ParkType",
                "FieldValues": {"Status": ("Active", NS(name="ParkStatus")),
                                "Size": (None, NS(name="ParkSize"))}},
            2: {"Name": "Regional", "Default": False, "SubtypeField": "ParkType",
                "FieldValues": {"Status": ("Active", None)}},
        }

    @staticmethod
    def ListDomains(ws):
        return [
            NS(name="ParkStatus", description="Park status", domainType="CodedValue",
               type="Text", codedValues={"Active": "Active", "Closed": "Closed"}, range=None),
            NS(name="ParkSize", description="Hectares", domainType="Range",
               type="Double", codedValues=None, range=[0.0, 500.0]),
            NS(name="Unrelated", description="Not used here", domainType="CodedValue",
               type="Text", codedValues={"X": "X"}, range=None),
        ]
`;

function withFakeArcpy(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "warlock-fake-"));
  try {
    const lib = path.join(dir, "lib");
    mkdirSync(lib);
    writeFileSync(path.join(lib, "arcpy.py"), FAKE_ARCPY);
    mkdirSync(path.join(dir, "WarlockGisMcp"));
    const sde = path.join(dir, "conn", "PROD_READ_ONLY.sde");
    mkdirSync(path.dirname(sde));
    writeFileSync(sde, "");
    writeFileSync(path.join(dir, "WarlockGisMcp", "config.json"),
      JSON.stringify({ sdeConnectionFile: sde }));
    return fn({ LOCALAPPDATA: dir, PYTHONPATH: lib, FAKE_SDE: sde });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("worker output (fake arcpy) passes the server's strict checks",
  { skip: !PYTHON || hasArcpy() }, () => {
    withFakeArcpy((env) => {
      const r = runWorkerWith(env, ["GIS.PARKS.PARKS"]);
      assert.equal(checkWorkerResult(r, "GIS.PARKS.PARKS"), null);
      assert.equal(r.status, "ok");
      assert.equal(r.resolved_name, "GIS.Parks_FD/GIS.PARKS.PARKS");
      assert.equal(r.geometry_type, "Polygon");
      assert.equal(r.subtypes.field, "ParkType");
      assert.equal(r.subtypes.default_code, 1);
      assert.deepEqual(r.subtypes.values[0].field_domains,
        { Status: "ParkStatus", Size: "ParkSize" });
      // Only domains referenced by fields or subtypes, never "Unrelated".
      assert.deepEqual(r.domains.map((d) => d.name), ["ParkSize", "ParkStatus"]);
      assert.deepEqual(r.domains[0].range, { min: 0, max: 500 });
    });
  });

test("worker returns NOT_FOUND for a missing dataset (fake arcpy)",
  { skip: !PYTHON || hasArcpy() }, () => {
    withFakeArcpy((env) => {
      const r = runWorkerWith(env, ["GIS.NOPE.NOPE"]);
      assert.equal(r.error_code, "NOT_FOUND");
      assert.equal(checkWorkerResult(r, "GIS.NOPE.NOPE"), null);
    });
  });

test("worker rejects its own output if it contains the connection path (fake arcpy)",
  { skip: !PYTHON || hasArcpy() }, () => {
    withFakeArcpy((env) => {
      const r = runWorkerWith(env, ["GIS.UTIL.Leaky"]);
      assert.equal(r.error_code, "OUTPUT_REJECTED");
      assert.equal(r.fields, null);
      assert.ok(!JSON.stringify(r).includes("PROD_READ_ONLY"));
    });
  });

test("worker returns ARCPY_UNAVAILABLE where arcpy is not installed",
  { skip: !PYTHON || hasArcpy() }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "warlock-wk-"));
    try {
      mkdirSync(path.join(dir, "WarlockGisMcp"));
      const sde = path.join(dir, "dummy.sde");
      writeFileSync(sde, "");
      writeFileSync(path.join(dir, "WarlockGisMcp", "config.json"),
        JSON.stringify({ sdeConnectionFile: sde }));
      const r = runWorkerWith({ LOCALAPPDATA: dir }, ["GIS.PARKS.PARKS"]);
      assert.equal(r.error_code, "ARCPY_UNAVAILABLE");
      assert.equal(checkWorkerResult(r, "GIS.PARKS.PARKS"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
