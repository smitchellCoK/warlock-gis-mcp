// Offline tests for Warlock GIS MCP v0.1 (packaged .mcpb model).
// No npm packages, no ArcPy, no geodatabase connection.
//
//   npm.cmd test    (or: node --test)
//
// Safety of the tests themselves:
// - Every test that resolves config, or runs the server or worker, points
//   LOCALAPPDATA / USERPROFILE / HOME at a temporary folder (or passes a
//   stub home folder), so the real %LOCALAPPDATA%\WarlockGisMcp\config.json
//   is never found and no real connection can be opened.
// - Tests that use a stand-in arcpy module are skipped if the interpreter
//   has real ArcPy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, chmodSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("../server/core.js");
const {
  TOOL_DEFINITION, TOOL_NAME, ENVIRONMENT, WORKER_PATH, CONFIG_ENV_VAR,
  isValidDatasetName, envelope, checkWorkerResult, inspectDataset, callTool,
  configCandidates, resolveConfigPath, loadConfig, workerEnv,
} = core;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server", "index.js");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const IS_WIN = process.platform === "win32";

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), `warlock-${prefix}-`));
}

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

const fakeConfig = () => ({
  pythonExe: "C:\\fake\\python.exe", timeoutSeconds: 60, configPath: "C:\\fake\\config.json",
});

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

// Regression: GIS.PARK.Park returned OUTPUT_REJECTED because a coded-value
// domain had a single backslash in both its code and description (9 chars).
// A single backslash is ordinary text; only a double backslash (UNC path)
// is a connection detail.
test("accepts a single backslash in a coded-domain code and description", () => {
  const ds = "GIS.PARKS.PARKS";
  for (const value of ["Open\\Shut", "Yes\\No", "A\\B"]) {
    const r = okResult();
    r.domains[0].coded_values.push({ code: value, description: value });
    assert.equal(checkWorkerResult(r, ds), null, value);
  }
});

test("still rejects genuine UNC / double-backslash paths anywhere in the result", () => {
  const ds = "GIS.PARKS.PARKS";
  const uncs = ["\\\\fileserver\\share", "\\\\gisfs01\\conn\\x", "see \\\\srv\\gis", "a\\\\b"];
  const places = [
    (r, v) => { r.domains[0].coded_values.push({ code: v, description: "x" }); },
    (r, v) => { r.domains[0].coded_values.push({ code: "x", description: v }); },
    (r, v) => { r.fields[1].alias = v; },
    (r, v) => { r.domains[1].description = v; },
  ];
  for (const v of uncs) {
    for (const put of places) {
      const r = okResult();
      put(r, v);
      assert.equal(checkWorkerResult(r, ds), "leak", v);
    }
  }
  // A single backslash does not hide a drive path or .sde name.
  for (const v of ["C:\\data\\prod.sde", "conn\\prod.sde", "D:\\GIS"]) {
    const r = okResult();
    r.domains[0].coded_values.push({ code: v, description: "x" });
    assert.equal(checkWorkerResult(r, ds), "leak", v);
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

test("callTool rejects missing, extra or non-object arguments", async () => {
  const deps = {
    load: () => assert.fail("config must not be read"),
    run: async () => assert.fail("worker must not run"),
  };
  for (const args of [undefined, null, [], "GIS.PARKS.PARKS", {},
                      { dataset: "GIS.PARKS.PARKS", sde: "C:\\x.sde" },
                      { path: "GIS.PARKS.PARKS" }]) {
    const r = await callTool(args, deps);
    assert.equal(r.error_code, "INVALID_NAME", JSON.stringify(args));
  }
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

test("inspections run one at a time", async () => {
  let running = 0;
  let maxRunning = 0;
  const run = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    return { ok: true, stdout: JSON.stringify(okResult()), timedOut: false };
  };
  const calls = [1, 2, 3].map(() =>
    callTool({ dataset: "GIS.PARKS.PARKS" }, { load: fakeConfig, run }));
  const results = await Promise.all(calls);
  assert.equal(maxRunning, 1);
  assert.ok(results.every((r) => r.status === "ok"));
});

// ---------------------------------------------------------------------
// Config resolution (does not depend on LOCALAPPDATA being inherited)
// ---------------------------------------------------------------------

function writeConfig(base, config) {
  const dir = path.join(base, "WarlockGisMcp");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
  return file;
}

test("config is found via LOCALAPPDATA, else via the profile folder", () => {
  const dir = tempDir("cfg");
  try {
    const local = path.join(dir, "AppData", "Local");
    const file = writeConfig(local, {});
    const home = () => dir;

    // LOCALAPPDATA inherited.
    assert.equal(resolveConfigPath({ LOCALAPPDATA: local }, () => "/nowhere"), file);
    // LOCALAPPDATA not inherited: derived from the profile folder.
    assert.equal(resolveConfigPath({}, home), file);
    // LOCALAPPDATA points somewhere without a config: profile folder used.
    assert.equal(resolveConfigPath({ LOCALAPPDATA: path.join(dir, "empty") }, home), file);
    // Relative or blank values are ignored.
    assert.deepEqual(configCandidates({ LOCALAPPDATA: "relative" }, () => ""), []);
    // Nothing resolvable: fail closed.
    assert.equal(resolveConfigPath({}, () => { throw new Error("no home"); }), null);
    assert.equal(resolveConfigPath({}, () => path.join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig fails closed without a usable config", () => {
  const dir = tempDir("cfg");
  const home = () => dir;
  const local = path.join(dir, "AppData", "Local");
  try {
    assert.equal(loadConfig({}, home), null);
    writeConfig(local, "{ not json");
    assert.equal(loadConfig({}, home), null);
    writeConfig(local, { pythonExe: "python.exe" });
    assert.equal(loadConfig({}, home), null);
    writeConfig(local, { pythonExe: path.join(dir, "missing", "python.exe") });
    assert.equal(loadConfig({}, home), null);

    const exe = path.join(dir, "python.exe");
    writeFileSync(exe, "");
    writeConfig(local, { pythonExe: exe, timeoutSeconds: 1 });
    assert.equal(loadConfig({}, home), null);
    const file = writeConfig(local, { pythonExe: exe, timeoutSeconds: 30 });
    assert.deepEqual(loadConfig({}, home), { pythonExe: exe, timeoutSeconds: 30, configPath: file });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker environment carries the config path and profile folders", () => {
  const cfg = { configPath: "/x/WarlockGisMcp/config.json" };
  const env = workerEnv(cfg, { PATH: "p" }, () => "/home/u");
  assert.equal(env[CONFIG_ENV_VAR], cfg.configPath);
  assert.equal(env.PATH, "p");
  assert.equal(env.USERPROFILE, "/home/u");
  assert.equal(env.LOCALAPPDATA, path.join("/home/u", "AppData", "Local"));
  assert.equal(env.APPDATA, path.join("/home/u", "AppData", "Roaming"));
  // Existing values are kept.
  const kept = workerEnv(cfg, { LOCALAPPDATA: "/L" }, () => "/home/u");
  assert.equal(kept.LOCALAPPDATA, "/L");
});

// ---------------------------------------------------------------------
// Static safety checks on the source and packaging
// ---------------------------------------------------------------------

function stripPy(src) {
  return src.replace(/"""[\s\S]*?"""/g, "").replace(/#.*$/gm, "");
}

test("worker uses only allowlisted ArcPy metadata calls", () => {
  const code = stripPy(read("worker/inspect_dataset.py"));
  const allowed = new Set([
    "arcpy.Exists", "arcpy.Describe", "arcpy.ListFields", "arcpy.ListDatasets",
    "arcpy.da.ListDomains", "arcpy.da.ListSubtypes", "arcpy.env.workspace",
  ]);
  const used = new Set(code.match(/arcpy(\.[A-Za-z_]+)+/g) || []);
  for (const call of used) assert.ok(allowed.has(call), `not allowlisted: ${call}`);
  assert.ok(used.size > 0);
});

test("worker contains no SQL, cursors, writes, shell or dynamic code", () => {
  const code = stripPy(read("worker/inspect_dataset.py"));
  const forbidden = [
    "subprocess", "os.system", "os.popen", "__import__", "importlib",
    "ArcSDESQLExecute", "Cursor", "arcpy.management", "arcpy.mp",
    "arcpy.conversion", "Editor", "sys.argv[2", "input(",
  ];
  for (const token of forbidden) assert.ok(!code.includes(token), token);
  // Built-in eval/exec/compile (re.compile is allowed).
  assert.ok(!/(?<![\w.])(eval|exec|compile)\s*\(/.test(code), "dynamic code");
  assert.equal((code.match(/\bopen\(/g) || []).length, 1, "only the config read may open a file");
  assert.ok(!/open\([^)]*["'][wa+]/.test(code), "no file opened for writing");
});

test("server has no npm dependencies and spawns only via execFile without a shell", () => {
  const builtins = new Set(builtinModules);
  for (const rel of ["server/index.js", "server/core.js"]) {
    const src = read(rel);
    for (const [, mod] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      assert.ok(
        builtins.has(mod.replace(/^node:/, "")) || mod.startsWith("./") || mod.startsWith("../"),
        `${rel} requires a non-built-in module: ${mod}`
      );
    }
    for (const token of ["shell: true", "spawn(", "execSync", "eval(", "new Function", "writeFile"]) {
      assert.ok(!src.includes(token), `${rel}: ${token}`);
    }
  }
  const coreSrc = read("server/core.js");
  const cp = coreSrc.match(/const\s*\{([^}]*)\}\s*=\s*require\('child_process'\)/);
  assert.ok(cp);
  assert.deepEqual(cp[1].split(",").map((s) => s.trim()).filter(Boolean), ["execFile"]);
  assert.ok(coreSrc.includes("shell: false"));
  assert.ok(!read("server/index.js").includes("child_process"));
});

test("package.json has no dependencies and matches the manifest", () => {
  const pkg = JSON.parse(read("package.json"));
  const manifest = JSON.parse(read("manifest.json"));
  assert.deepEqual(pkg.dependencies, {});
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.main, "server/index.js");
});

test("manifest: Windows-only Node extension with one tool and no settings", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.equal(m.name, "warlock-gis-mcp");
  assert.equal(m.server.type, "node");
  assert.equal(m.server.entry_point, "server/index.js");
  assert.equal(m.server.mcp_config.command, "node");
  assert.deepEqual(m.server.mcp_config.args, ["${__dirname}/server/index.js"]);
  assert.equal(m.server.mcp_config.env, undefined, "no environment values in the manifest");
  assert.equal(m.user_config, undefined, "no settings: config stays in the local config file");
  assert.deepEqual(m.tools.map((t) => t.name), ["inspect_gis_dataset"]);
  assert.deepEqual(m.compatibility.platforms, ["win32"]);
});

test("build script bundles exactly the runtime files", () => {
  const src = read("scripts/build_mcpb.py");
  const block = src.match(/INCLUDE = \[([\s\S]*?)\]/);
  assert.ok(block);
  const files = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(files, [
    "manifest.json", "package.json", "server/index.js", "server/core.js",
    "worker/inspect_dataset.py",
  ]);
});

test("connection files, local config and build output are excluded from Git", () => {
  const lines = read(".gitignore").split(/\r?\n/).map((l) => l.trim());
  for (const entry of ["*.sde", "config.json", "*.log", "dist/", "*.mcpb", "node_modules/"]) {
    assert.ok(lines.includes(entry), entry);
  }
  const example = JSON.parse(read("config.example.json"));
  assert.match(example.sdeConnectionFile, /\\path\\to\\/);
});

// ---------------------------------------------------------------------
// The real server over stdio (no config reachable)
// ---------------------------------------------------------------------

function isolatedEnv(dir, extra = {}) {
  return {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    USERPROFILE: dir,
    HOME: dir,
    ...extra,
  };
}

// Sends messages, closes stdin, collects stdout lines and stderr.
function talk(args, messages, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("server timed out")); }, 20000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.split("\n").filter(Boolean);
      resolve({ code, lines, replies: lines.map((l) => JSON.parse(l)), stderr: err });
    });
    for (const m of messages) child.stdin.write((typeof m === "string" ? m : JSON.stringify(m)) + "\n");
    child.stdin.end();
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const byId = (replies, id) => replies.find((r) => r.id === id);
const toolResult = (reply) => JSON.parse(reply.result.content[0].text);

test("stdio server: handshake, one tool, ping, and protocol errors", async () => {
  const dir = tempDir("srv");
  try {
    const { code, replies, stderr } = await talk([SERVER], [
      INIT,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      LIST,
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { jsonrpc: "2.0", id: 4, method: "resources/list" },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run_sql", arguments: {} } },
      "{ not json",
    ], isolatedEnv(dir));

    assert.equal(code, 0);
    const init = byId(replies, 1).result;
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.equal(init.serverInfo.name, "warlock-gis-mcp");
    assert.deepEqual(byId(replies, 2).result.tools.map((t) => t.name), ["inspect_gis_dataset"]);
    assert.deepEqual(byId(replies, 3).result, {});
    assert.equal(byId(replies, 4).error.code, -32601);
    assert.equal(byId(replies, 5).error.code, -32602);
    assert.ok(replies.some((r) => r.id === null && r.error.code === -32700));
    assert.equal(replies.length, 6, "notifications get no reply");
    // stderr is JSON log lines only, with no paths.
    for (const line of stderr.split("\n").filter(Boolean)) JSON.parse(line);
    assert.ok(!stderr.includes(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio server: tool calls fail closed without a reachable config", async () => {
  const dir = tempDir("srv");
  try {
    const call = (id, args) => ({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "inspect_gis_dataset", arguments: args } });
    const { replies, stderr } = await talk([SERVER], [
      INIT,
      call(10, { dataset: "C:\\x.sde" }),
      call(11, { dataset: "GIS.PARKS.PARKS", sde: "C:\\x.sde" }),
      call(12, { dataset: "GIS.PARKS.PARKS" }),
    ], isolatedEnv(dir));

    for (const [id, code, dataset] of [[10, "INVALID_NAME", null], [11, "INVALID_NAME", null],
                                       [12, "CONFIG_ERROR", "GIS.PARKS.PARKS"]]) {
      const reply = byId(replies, id);
      assert.equal(reply.result.isError, true);
      const r = toolResult(reply);
      assert.equal(r.error_code, code);
      assert.equal(r.dataset, dataset);
      assert.equal(checkWorkerResult(r, "GIS.PARKS.PARKS"), null);
    }
    assert.ok(stderr.includes('"result":"CONFIG_ERROR"'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio server starts however it is launched (alternate path, require() launcher)", async () => {
  const dir = tempDir("srv");
  try {
    // A differently spelled path to the same file.
    let alt;
    if (IS_WIN) {
      alt = SERVER.toUpperCase();
    } else {
      symlinkSync(ROOT, path.join(dir, "link"));
      alt = path.join(dir, "link", "server", "index.js");
    }
    // A launcher that loads the server the way a host runtime might.
    const launcher = path.join(dir, "launcher.cjs");
    writeFileSync(launcher, `require(${JSON.stringify(SERVER)});\n`);

    for (const args of [[alt], [launcher]]) {
      const { replies } = await talk(args, [INIT, LIST], isolatedEnv(dir));
      assert.deepEqual(byId(replies, 2).result.tools.map((t) => t.name),
        ["inspect_gis_dataset"], args[0]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Worker (real Python, stand-in arcpy, no connection)
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

const NO_FAKE = !PYTHON || hasArcpy();

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
  const dir = tempDir("wk");
  try {
    const ds = ["GIS.PARKS.PARKS"];
    assert.equal(runWorkerWith({}, ds).error_code, "CONFIG_ERROR");
    assert.equal(runWorkerWith({ LOCALAPPDATA: dir }, ds).error_code, "CONFIG_ERROR");

    // A config whose .sde file does not exist.
    const cfg = writeConfig(dir, { sdeConnectionFile: path.join(dir, "missing.sde") });
    assert.equal(runWorkerWith({ [CONFIG_ENV_VAR]: cfg }, ds).error_code, "CONFIG_ERROR");

    // A config path from the server that is not a WarlockGisMcp\config.json
    // fails closed, even if the file exists.
    const other = path.join(dir, "other.json");
    writeFileSync(other, JSON.stringify({ sdeConnectionFile: path.join(dir, "x.sde") }));
    assert.equal(runWorkerWith({ [CONFIG_ENV_VAR]: other }, ds).error_code, "CONFIG_ERROR");
    assert.equal(runWorkerWith({ [CONFIG_ENV_VAR]: "WarlockGisMcp/config.json" }, ds).error_code,
      "CONFIG_ERROR");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stand-in arcpy module (temporary folder only).
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

// Temporary profile with a config, a dummy .sde and the stand-in arcpy.
// Cleans up after the callback, including async callbacks.
function withFakeSetup(fn) {
  const dir = tempDir("fake");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    const lib = path.join(dir, "lib");
    mkdirSync(lib);
    writeFileSync(path.join(lib, "arcpy.py"), FAKE_ARCPY);
    const sde = path.join(dir, "conn", "PROD_READ_ONLY.sde");
    mkdirSync(path.dirname(sde));
    writeFileSync(sde, "");
    const local = path.join(dir, "AppData", "Local");
    result = fn({ dir, lib, sde, local });
  } catch (error) {
    cleanup();
    throw error;
  }
  if (result && typeof result.then === "function") return result.finally(cleanup);
  cleanup();
  return result;
}

test("worker output (stand-in arcpy) passes the server's strict checks", { skip: NO_FAKE }, () => {
  withFakeSetup(({ lib, sde, local }) => {
    const cfg = writeConfig(local, { sdeConnectionFile: sde });
    const env = { [CONFIG_ENV_VAR]: cfg, PYTHONPATH: lib, FAKE_SDE: sde };

    const r = runWorkerWith(env, ["GIS.PARKS.PARKS"]);
    assert.equal(checkWorkerResult(r, "GIS.PARKS.PARKS"), null);
    assert.equal(r.status, "ok");
    assert.equal(r.resolved_name, "GIS.Parks_FD/GIS.PARKS.PARKS");
    assert.equal(r.subtypes.default_code, 1);
    assert.deepEqual(r.subtypes.values[0].field_domains, { Status: "ParkStatus", Size: "ParkSize" });
    assert.deepEqual(r.domains.map((d) => d.name), ["ParkSize", "ParkStatus"]);
    assert.deepEqual(r.domains[0].range, { min: 0, max: 500 });

    assert.equal(runWorkerWith(env, ["GIS.NOPE.NOPE"]).error_code, "NOT_FOUND");

    const leaky = runWorkerWith(env, ["GIS.UTIL.Leaky"]);
    assert.equal(leaky.error_code, "OUTPUT_REJECTED");
    assert.ok(!JSON.stringify(leaky).includes("PROD_READ_ONLY"));
  });
});

test("worker finds the config via LOCALAPPDATA when run directly", { skip: NO_FAKE }, () => {
  withFakeSetup(({ lib, sde, local }) => {
    writeConfig(local, { sdeConnectionFile: sde });
    const r = runWorkerWith({ LOCALAPPDATA: local, PYTHONPATH: lib, FAKE_SDE: sde },
      ["GIS.PARKS.PARKS"]);
    assert.equal(r.status, "ok");
  });
});

test("worker returns ARCPY_UNAVAILABLE where arcpy is not installed", { skip: NO_FAKE }, () => {
  withFakeSetup(({ sde, local }) => {
    const cfg = writeConfig(local, { sdeConnectionFile: sde });
    const r = runWorkerWith({ [CONFIG_ENV_VAR]: cfg }, ["GIS.PARKS.PARKS"]);
    assert.equal(r.error_code, "ARCPY_UNAVAILABLE");
    assert.equal(checkWorkerResult(r, "GIS.PARKS.PARKS"), null);
  });
});

// End to end: stdio server -> config resolved without LOCALAPPDATA ->
// worker -> stand-in arcpy. POSIX only (needs an executable named
// python.exe; on Windows the real one is ArcGIS Pro's).
test("end to end through the stdio server, without LOCALAPPDATA inherited",
  { skip: NO_FAKE || IS_WIN }, async () => {
    await withFakeSetup(async ({ dir, lib, sde, local }) => {
      const exe = path.join(dir, "bin", "python.exe");
      mkdirSync(path.dirname(exe));
      writeFileSync(exe, `#!/bin/sh\nexec ${JSON.stringify(PYTHON)} "$@"\n`);
      chmodSync(exe, 0o755);
      writeConfig(local, { pythonExe: exe, sdeConnectionFile: sde, timeoutSeconds: 30 });

      // No LOCALAPPDATA: the server must derive it from the profile folder.
      const env = isolatedEnv(dir, { PYTHONPATH: lib, FAKE_SDE: sde });
      delete env.LOCALAPPDATA;

      const call = (id, dataset) => ({ jsonrpc: "2.0", id, method: "tools/call",
        params: { name: "inspect_gis_dataset", arguments: { dataset } } });
      const { replies, stderr } = await talk([SERVER],
        [INIT, call(20, "GIS.PARKS.PARKS"), call(21, "GIS.NOPE.NOPE")], env);

      const ok = byId(replies, 20);
      assert.equal(ok.result.isError, false);
      const r = toolResult(ok);
      assert.equal(r.status, "ok");
      assert.equal(r.resolved_name, "GIS.Parks_FD/GIS.PARKS.PARKS");
      assert.equal(toolResult(byId(replies, 21)).error_code, "NOT_FOUND");

      const all = JSON.stringify(replies) + stderr;
      for (const secret of [sde, dir, "PROD_READ_ONLY"]) assert.ok(!all.includes(secret), secret);
    });
  });
