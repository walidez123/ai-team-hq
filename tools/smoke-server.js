'use strict';
const http = require('http');
const { spawn, execFile } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
let counter = 0;
const warnings = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ok(name) { counter++; passed++; console.log(`ok ${counter} ${name}`); }
function fail(name, detail) { counter++; failed++; console.log(`FAIL ${name}: ${detail}`); }
function warn(msg) { warnings.push(msg); console.log(`WARN: ${msg}`); }

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

async function waitForServer(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE + '/');
      if (res.status === 200) return true;
    } catch { /* not ready */ }
    await sleep(300);
  }
  return false;
}

function killServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) { resolve(); return; }
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
        try { child.kill(); } catch { /* best effort */ }
        resolve();
      });
    } else {
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
      setTimeout(resolve, 500);
    }
  });
}

async function main() {
  const child = spawn('node', ['ui/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', d => { serverOutput += d.toString(); });
  child.stderr.on('data', d => { serverOutput += d.toString(); });

  try {
    const ready = await waitForServer(15000);
    if (!ready) {
      console.log('FAIL server did not start within 15s');
      console.log(serverOutput);
      process.exitCode = 1;
      await killServer(child);
      return;
    }

    // a. GET /
    try {
      const res = await fetch(BASE + '/');
      const text = await res.text();
      if (res.status === 200 && text.includes('dispatch room')) ok('GET /');
      else fail('GET /', `status=${res.status} contains=${text.includes('dispatch room')}`);
    } catch (e) { fail('GET /', String(e)); }

    // b. GET /api/team
    try {
      const { res, body } = await fetchJson(BASE + '/api/team');
      const roster = body && body.roster;
      const good = res.status === 200 && Array.isArray(roster) && roster.length === 8 &&
        roster.every(x => x && typeof x.id === 'string' && typeof x.mode === 'string');
      if (good) ok('GET /api/team');
      else fail('GET /api/team', `status=${res.status} roster=${Array.isArray(roster) ? roster.length : 'n/a'}`);
    } catch (e) { fail('GET /api/team', String(e)); }

    // c. GET /api/metrics
    try {
      const { res, body } = await fetchJson(BASE + '/api/metrics');
      if (res.status === 200 && typeof (body && body.total) === 'number') ok('GET /api/metrics');
      else fail('GET /api/metrics', `status=${res.status} total=${body && body.total}`);
    } catch (e) { fail('GET /api/metrics', String(e)); }

    // d. GET /api/reports
    try {
      const { res, body } = await fetchJson(BASE + '/api/reports');
      if (res.status === 200 && Array.isArray(body && body.reports)) ok('GET /api/reports');
      else fail('GET /api/reports', `status=${res.status}`);
    } catch (e) { fail('GET /api/reports', String(e)); }

    // e. GET /api/runs
    try {
      const { res, body } = await fetchJson(BASE + '/api/runs');
      if (res.status === 200 && Array.isArray(body && body.runs)) ok('GET /api/runs');
      else fail('GET /api/runs', `status=${res.status}`);
    } catch (e) { fail('GET /api/runs', String(e)); }

    // f. POST /api/run malformed JSON
    try {
      const res = await fetch(BASE + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
      if (res.status === 400) ok('POST /api/run malformed JSON');
      else fail('POST /api/run malformed JSON', `status=${res.status}`);
    } catch (e) { fail('POST /api/run malformed JSON', String(e)); }

    // g. POST /api/run unknown agent
    try {
      const { res, body } = await fetchJson(BASE + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'x', agent: 'nope' }) });
      const msg = body && body.error ? String(body.error) : '';
      if (res.status === 400 && msg.includes('unknown agent')) ok('POST /api/run unknown agent');
      else fail('POST /api/run unknown agent', `status=${res.status} error=${msg}`);
    } catch (e) { fail('POST /api/run unknown agent', String(e)); }

    // h. POST /api/runs/does-not-exist/stop
    try {
      const res = await fetch(BASE + '/api/runs/does-not-exist/stop', { method: 'POST' });
      if (res.status === 404) ok('POST stop unknown run');
      else fail('POST stop unknown run', `status=${res.status}`);
    } catch (e) { fail('POST stop unknown run', String(e)); }

    // j. (run before i? order: i then j per plan; do j here after h, before i? Plan order i then j then k then l. We'll follow i, j, k, l.)
    // i. real run
    let runId = null;
    let runSkipped = false;
    try {
      const { res, body } = await fetchJson(BASE + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'reply with just: ok' }) });
      if (res.status !== 200 || !body || !body.id) {
        throw new Error(`launch failed status=${res.status} body=${JSON.stringify(body)}`);
      }
      runId = body.id;

      // wait for /api/runs to show it
      let appeared = false;
      const appearStart = Date.now();
      while (Date.now() - appearStart < 90000) {
        const { body: b2 } = await fetchJson(BASE + '/api/runs');
        const r = (b2 && b2.runs || []).find(x => x.id === runId);
        if (r) { appeared = true; break; }
        await sleep(1000);
      }
      if (!appeared) throw new Error('run did not appear in /api/runs within 90s');

      // check spawn failure: if run already errored with spawn-ish error, skip
      let { body: b3 } = await fetchJson(BASE + '/api/runs');
      let runObj = (b3 && b3.runs || []).find(x => x.id === runId);
      if (runObj && runObj.status === 'error' && /spawn|ENOENT|not found/i.test(String(runObj.error || ''))) {
        runSkipped = true;
        warn('opencode could not be spawned; skipping real-run step');
      } else {
        // if still running, post stop
        if (runObj && runObj.status === 'running') {
          const stopRes = await fetch(BASE + '/api/runs/' + encodeURIComponent(runId) + '/stop', { method: 'POST' });
          // 200 expected; 409 acceptable if race
          if (stopRes.status !== 200 && stopRes.status !== 409) {
            warn(`stop returned ${stopRes.status}`);
          }
        }
        // wait until terminal
        const termStart = Date.now();
        while (Date.now() - termStart < 90000) {
          const { body: b4 } = await fetchJson(BASE + '/api/runs');
          const r = (b4 && b4.runs || []).find(x => x.id === runId);
          if (r && r.status && r.status !== 'running') { runObj = r; break; }
          await sleep(1000);
        }
        const finalStatus = runObj ? runObj.status : null;
        // detect spawn failure after terminal
        if (finalStatus === 'error' && /spawn|ENOENT|not found/i.test(String(runObj.error || ''))) {
          runSkipped = true;
          warn('opencode could not be spawned; skipping real-run step');
        } else if (finalStatus === 'stopped' || finalStatus === 'done') {
          // ensure listed
          const { body: b5 } = await fetchJson(BASE + '/api/runs');
          const listed = (b5 && b5.runs || []).some(x => x.id === runId);
          if (listed) ok('POST /api/run real run + stop');
          else fail('POST /api/run real run + stop', 'run not listed');
        } else {
          fail('POST /api/run real run + stop', `final status=${finalStatus}`);
        }
      }
    } catch (e) {
      // If launch itself failed due to spawn, skip
      if (/spawn|ENOENT|not found/i.test(String(e))) {
        runSkipped = true;
        warn('opencode could not be spawned; skipping real-run step: ' + String(e));
      } else {
        fail('POST /api/run real run + stop', String(e));
      }
    }
    if (runSkipped) {
      // mark as warning, not failure: print an ok? Requirement: skip-with-warning, not fail. We'll not increment fail; print warn already.
      // To keep test count meaningful, record a pass as skipped? We'll just warn.
      console.log('SKIP real-run step (warning above)');
    }

    // j. GET /api/stream?run=nope
    try {
      const res = await fetch(BASE + '/api/stream?run=nope');
      if (res.status === 404) ok('GET /api/stream unknown run');
      else fail('GET /api/stream unknown run', `status=${res.status}`);
    } catch (e) { fail('GET /api/stream unknown run', String(e)); }

    // k. GET /api/agents/settings + concurrent team timing
    try {
      const measure = async (url) => {
        const s = Date.now();
        const r = await fetch(url);
        const body = await r.json().catch(() => null);
        return { r, body, dur: Date.now() - s };
      };
      const [sRes, tRes] = await Promise.all([
        measure(BASE + '/api/agents/settings'),
        measure(BASE + '/api/team'),
      ]);
      const body = sRes.body;
      const good = sRes.r.status === 200 && Array.isArray(body && body.agents) && body.agents.length === 8 && Array.isArray(body && body.catalog);
      if (good) ok('GET /api/agents/settings');
      else fail('GET /api/agents/settings', `status=${sRes.r.status} agents=${body && body.agents && body.agents.length}`);
      if (tRes.dur >= 300) warn(`concurrent /api/team took ${tRes.dur}ms (>=300ms) while settings in flight`);
    } catch (e) { fail('GET /api/agents/settings', String(e)); }

    // l. preferences
    let originalPrefs = null;
    try {
      const { body: orig } = await fetchJson(BASE + '/api/preferences');
      originalPrefs = orig;
      // dynamic
      const r1 = await fetch(BASE + '/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelRouting: 'dynamic' }) });
      if (r1.status !== 200) throw new Error(`dynamic status=${r1.status}`);
      // bogus
      const r2 = await fetch(BASE + '/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelRouting: 'bogus' }) });
      if (r2.status !== 400) throw new Error(`bogus status=${r2.status}`);
      ok('POST /api/preferences');
    } catch (e) {
      fail('POST /api/preferences', String(e));
    } finally {
      // restore original
      try {
        if (originalPrefs && originalPrefs.modelRouting) {
          await fetch(BASE + '/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelRouting: originalPrefs.modelRouting }) });
        }
      } catch { /* best effort */ }
    }

  } finally {
    await killServer(child);
  }

  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${warnings.length} warnings`);
  if (warnings.length) warnings.forEach(w => console.log('  - ' + w));
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(e => {
  console.error('Unhandled:', e);
  process.exitCode = 1;
});