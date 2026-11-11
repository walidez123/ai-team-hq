'use strict';
const { spawn, execFile } = require('child_process');
const path = require('path');
const { createLineSplitter, updateAgyConfigComment, updateOpencodeFrontmatter } = require('../ui/server.js');

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
  // Unit Test 1: Line-buffered stream splitter handles mid-JSON and multi-byte UTF-8 splits
  try {
    const received = [];
    const splitter = createLineSplitter(l => received.push(l));
    const sample1 = JSON.stringify({ event: 'thought', message: 'Analyzing 🚀 architecture' });
    const sample2 = JSON.stringify({ event: 'tool_use', tool: 'read_file', input: { path: 'ui/server.js' } });
    const payload = Buffer.from(`${sample1}\n${sample2}\n`, 'utf8');
    // Slice mid-JSON and mid-emoji
    splitter.write(payload.subarray(0, 17));
    splitter.write(payload.subarray(17, 43));
    splitter.write(payload.subarray(43));
    splitter.end();
    if (received.length === 2 && JSON.parse(received[0]).message.includes('🚀') && JSON.parse(received[1]).tool === 'read_file') {
      ok('unit: createLineSplitter chunk & UTF-8 safety');
    } else {
      fail('unit: createLineSplitter chunk & UTF-8 safety', `received=${JSON.stringify(received)}`);
    }
  } catch (e) {
    fail('unit: createLineSplitter chunk & UTF-8 safety', String(e));
  }

  // Unit Test 2: Frontmatter & config comment writers never corrupt body lines containing "model:"
  try {
    const sampleMd = [
      '---',
      'description: Test agent',
      'mode: subagent',
      'model: old-model',
      '---',
      '',
      'Here is a body line that says:',
      'model: do-not-touch-this-line',
      'reasoningEffort: keep-body-intact',
    ].join('\n');
    const updatedOc = updateOpencodeFrontmatter(sampleMd, 'model', 'new-model');
    const updatedAgy = updateAgyConfigComment(sampleMd, { model: 'gemini-4-argon-high', effort: 'high' });
    const bodyIntactOc = updatedOc.includes('model: new-model') && updatedOc.includes('model: do-not-touch-this-line');
    const bodyIntactAgy = updatedAgy.includes('model=gemini-4-argon-high') && updatedAgy.includes('model: do-not-touch-this-line');
    if (bodyIntactOc && bodyIntactAgy) {
      ok('unit: frontmatter & agy config comment body safety');
    } else {
      fail('unit: frontmatter & agy config comment body safety', `oc=${bodyIntactOc} agy=${bodyIntactAgy}`);
    }
  } catch (e) {
    fail('unit: frontmatter & agy config comment body safety', String(e));
  }

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
      if (res.status === 200 && text.includes('dispatch room') && text.includes('gitPill')) ok('GET /');
      else fail('GET /', `status=${res.status}`);
    } catch (e) { fail('GET /', String(e)); }

    // b. GET /api/team
    try {
      const { res, body } = await fetchJson(BASE + '/api/team');
      const roster = body && body.roster;
      const good = res.status === 200 && Array.isArray(roster) && roster.length === 8 &&
        roster.every(x => x && typeof x.id === 'string' && typeof x.mode === 'string') &&
        (body.engine === 'agy' || body.engine === 'opencode');
      if (good) ok('GET /api/team');
      else fail('GET /api/team', `status=${res.status} roster=${Array.isArray(roster) ? roster.length : 'n/a'}`);
    } catch (e) { fail('GET /api/team', String(e)); }

    // c. GET /api/metrics & project-scoped ?dir=
    try {
      const { res, body } = await fetchJson(BASE + '/api/metrics?dir=' + encodeURIComponent(ROOT));
      if (res.status === 200 && typeof (body && body.total) === 'number' && typeof body.globalTotal === 'number' && body.scopedDir) {
        ok('GET /api/metrics (project-scoped)');
      } else {
        fail('GET /api/metrics (project-scoped)', `status=${res.status} body=${JSON.stringify(body)}`);
      }
    } catch (e) { fail('GET /api/metrics (project-scoped)', String(e)); }

    // c2. GET /api/git-status
    try {
      const { res, body } = await fetchJson(BASE + '/api/git-status?dir=' + encodeURIComponent(ROOT));
      if (res.status === 200 && body && body.isRepo === true && typeof body.branch === 'string') {
        ok('GET /api/git-status');
      } else {
        fail('GET /api/git-status', `status=${res.status} body=${JSON.stringify(body)}`);
      }
    } catch (e) { fail('GET /api/git-status', String(e)); }

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

    // i. real run + stop
    let runId = null;
    let runSkipped = false;
    try {
      const { res, body } = await fetchJson(BASE + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'reply with just: ok' }) });
      if (res.status !== 200 || !body || !body.id) {
        throw new Error(`launch failed status=${res.status} body=${JSON.stringify(body)}`);
      }
      runId = body.id;

      let appeared = false;
      const appearStart = Date.now();
      while (Date.now() - appearStart < 30000) {
        const { body: b2 } = await fetchJson(BASE + '/api/runs');
        const r = (b2 && b2.runs || []).find(x => x.id === runId);
        if (r) { appeared = true; break; }
        await sleep(500);
      }
      if (!appeared) throw new Error('run did not appear in /api/runs within 30s');

      let { body: b3 } = await fetchJson(BASE + '/api/runs');
      let runObj = (b3 && b3.runs || []).find(x => x.id === runId);
      if (runObj && runObj.status === 'error' && /spawn|ENOENT|not found/i.test(String(runObj.error || ''))) {
        runSkipped = true;
        warn('CLI binary could not be spawned; skipping real-run step');
      } else {
        if (runObj && runObj.status === 'running') {
          const stopRes = await fetch(BASE + '/api/runs/' + encodeURIComponent(runId) + '/stop', { method: 'POST' });
          if (stopRes.status !== 200 && stopRes.status !== 409) {
            warn(`stop returned ${stopRes.status}`);
          }
        }
        const termStart = Date.now();
        while (Date.now() - termStart < 30000) {
          const { body: b4 } = await fetchJson(BASE + '/api/runs');
          const r = (b4 && b4.runs || []).find(x => x.id === runId);
          if (r && r.status && r.status !== 'running') { runObj = r; break; }
          await sleep(500);
        }
        const finalStatus = runObj ? runObj.status : null;
        if (finalStatus === 'error' && /spawn|ENOENT|not found/i.test(String(runObj.error || ''))) {
          runSkipped = true;
          warn('CLI binary could not be spawned; skipping real-run step');
        } else if (finalStatus === 'stopped' || finalStatus === 'done') {
          const { body: b5 } = await fetchJson(BASE + '/api/runs');
          const listed = (b5 && b5.runs || []).some(x => x.id === runId);
          if (listed) ok('POST /api/run real run + stop');
          else fail('POST /api/run real run + stop', 'run not listed');
        } else {
          fail('POST /api/run real run + stop', `final status=${finalStatus}`);
        }
      }
    } catch (e) {
      if (/spawn|ENOENT|not found/i.test(String(e))) {
        runSkipped = true;
        warn('CLI binary could not be spawned; skipping real-run step: ' + String(e));
      } else {
        fail('POST /api/run real run + stop', String(e));
      }
    }
    if (runSkipped) {
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
      const good = sRes.r.status === 200 && Array.isArray(body && body.agents) && body.agents.length === 8 && Array.isArray(body && body.catalog) && body.catalog.length > 0;
      if (good) ok('GET /api/agents/settings');
      else fail('GET /api/agents/settings', `status=${sRes.r.status} agents=${body && body.agents && body.agents.length}`);
      if (tRes.dur >= 300) warn(`concurrent /api/team took ${tRes.dur}ms (>=300ms) while settings in flight`);
    } catch (e) { fail('GET /api/agents/settings', String(e)); }

    // l. preferences (routing, engine, timeout)
    let originalPrefs = null;
    try {
      const { body: orig } = await fetchJson(BASE + '/api/preferences');
      originalPrefs = orig;
      const r1 = await fetch(BASE + '/api/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelRouting: 'dynamic', engine: 'agy', inactivityTimeoutMin: 15 }),
      });
      if (r1.status !== 200) throw new Error(`valid prefs status=${r1.status}`);
      const r2 = await fetch(BASE + '/api/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelRouting: 'bogus' }),
      });
      if (r2.status !== 400) throw new Error(`bogus routing status=${r2.status}`);
      const r3 = await fetch(BASE + '/api/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'invalid-engine' }),
      });
      if (r3.status !== 400) throw new Error(`bogus engine status=${r3.status}`);
      ok('POST /api/preferences (engine, routing, watchdog)');
    } catch (e) {
      fail('POST /api/preferences (engine, routing, watchdog)', String(e));
    } finally {
      try {
        if (originalPrefs) {
          await fetch(BASE + '/api/preferences', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(originalPrefs),
          });
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
