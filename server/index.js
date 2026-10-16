#!/usr/bin/env node
'use strict';

// Warlock GIS MCP - minimal MCP server over stdio (newline-delimited
// JSON-RPC 2.0). No third-party dependencies. Same pattern as Warlock Jira
// MCP.
//
// Exposes exactly one tool: inspect_gis_dataset(dataset).
// stdout carries protocol messages only; logs go to stderr.

const readline = require('readline');
const core = require('./core');

const SERVER_INFO = {
  name: 'warlock-gis-mcp',
  version: require('../package.json').version
};
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// --- logging (stderr; dataset, result code and duration only) -------------

function log(event, fields) {
  const entry = { ts: new Date().toISOString(), event, ...(fields || {}) };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

// --- JSON-RPC helpers ---------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// --- request handling ---------------------------------------------------

async function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      log('initialize', { protocolVersion });
      return reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, { tools: [core.TOOL_DEFINITION] });

    case 'tools/call': {
      const name = params && params.name;
      if (name !== core.TOOL_NAME) {
        return replyError(id, -32602, 'Unknown tool');
      }
      const started = Date.now();
      const result = await core.callTool(params && params.arguments);
      log('tool_call', {
        dataset: result.dataset,
        result: result.error_code || 'OK',
        ms: Date.now() - started
      });
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result.status === 'error'
      });
    }

    default:
      if (!isNotification) {
        return replyError(id, -32601, 'Method not found');
      }
      return undefined;
  }
}

let started = false;

function start() {
  if (started) return;
  started = true;

  // Diagnostics for the Claude Desktop MCP log. Error name/code only:
  // never messages, stacks, env, paths, or worker output.
  process.on('uncaughtException', (e) => {
    log('fatal', { error: (e && (e.code || e.name)) || 'unknown' });
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    log('unhandled_rejection', { error: (e && (e.code || e.name)) || 'unknown' });
  });
  // Host closed the pipe: exit quietly instead of crashing on EPIPE.
  process.stdout.on('error', (e) => {
    if (e && e.code === 'EPIPE') process.exit(0);
  });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const inFlight = new Set();

  rl.on('line', (line) => {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      return replyError(null, -32700, 'Parse error');
    }

    const task = (async () => {
      try {
        await handle(message);
      } catch (e) {
        log('internal_error', {});
        if (message && message.id !== undefined && message.id !== null) {
          replyError(message.id, -32603, 'Internal error');
        }
      }
    })();
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  });

  // Host closed stdin: finish in-flight requests (an inspection may be
  // running), then exit once their replies have been written. Unlike Jira,
  // a GIS call can take seconds, so exiting immediately could drop a reply.
  rl.on('close', () => {
    Promise.allSettled([...inFlight]).then(() => {
      process.exitCode = 0;
      // Exit naturally so stdout is flushed; force exit if anything lingers.
      setTimeout(() => process.exit(0), 2000).unref();
    });
  });
  log('started', {
    tool: core.TOOL_NAME,
    version: SERVER_INFO.version,
    node: process.versions.node,
    environment: core.ENVIRONMENT
  });
}

// Start unconditionally, as Warlock Jira MCP does. Claude Desktop's built-in
// Node runtime may load this file through its own launcher, where an
// "is this the main module" check is false and the server would never
// start. Starting unconditionally also covers paths spelled with a
// different case. Tests therefore run this file as a child process and
// never require() it.
start();

module.exports = { handle, start };
