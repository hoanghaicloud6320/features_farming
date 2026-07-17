'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { CHALLENGES, opaque, prismProof } = require('./challenges');
const { V5_CASE_BY_ID, applyTransform } = require('./v5-cases');

const PUBLIC_DIRECTORY = path.join(__dirname, 'public');

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function text(response, status, value, contentType) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(value),
    'cache-control': 'no-store',
  });
  response.end(value);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createGymServer() {
  const sessions = new Map();
  const metrics = new Map();

  function observe(request, route, status, accepted = false) {
    const benchmarkRun = String(request.headers['x-gym-benchmark-run'] || '').trim();
    if (!benchmarkRun) return;
    const current = metrics.get(benchmarkRun) || { requests: [], accepted: false };
    current.requests.push({ method: request.method, route, status });
    current.accepted ||= accepted;
    metrics.set(benchmarkRun, current);
  }

  async function api(request, response, pathname) {
    let body;
    try {
      body = await readJson(request);
    } catch {
      observe(request, pathname, 400);
      json(response, 400, { error: 'invalid_json' });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/marble/session') {
      const runId = opaque('marble');
      const handoffKey = opaque('handoff');
      sessions.set(runId, { challenge: 'easy', handoffKey });
      observe(request, pathname, 200);
      json(response, 200, { runId, handoffKey, phase: 'ready' });
      return;
    }
    if (request.method === 'PUT' && pathname === '/api/marble/confirm') {
      const state = sessions.get(body.runId);
      const accepted = state?.challenge === 'easy' && body.handoffKey === state.handoffKey;
      observe(request, pathname, accepted ? 200 : 422, accepted);
      json(response, accepted ? 200 : 422, { accepted, challenge: 'easy' });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/lattice/seed') {
      const runId = opaque('lattice');
      const capsule = opaque('capsule', 12);
      sessions.set(runId, { challenge: 'medium', capsule });
      observe(request, pathname, 200);
      json(response, 200, { runId, capsule, encoding: 'base64url', phase: 'sealed' });
      return;
    }
    if (request.method === 'PUT' && pathname === '/api/lattice/unseal') {
      const state = sessions.get(body.runId);
      const authorization = String(request.headers.authorization || '');
      const expected = state
        ? `Bearer ${Buffer.from(state.capsule, 'utf8').toString('base64url')}`
        : '';
      const accepted = state?.challenge === 'medium' && authorization === expected;
      observe(request, pathname, accepted ? 200 : 401, accepted);
      json(response, accepted ? 200 : 401, { accepted, challenge: 'medium' });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/prism/origin') {
      const label = String(body.label || '');
      const sequence = Number(body.sequence);
      if (!label || !Number.isInteger(sequence)) {
        observe(request, pathname, 422);
        json(response, 422, { error: 'label_and_sequence_required' });
        return;
      }
      const runId = opaque('prism');
      const seed = opaque('seed', 10);
      const salt = opaque('salt', 7);
      sessions.set(runId, { challenge: 'hard', seed, salt, label, sequence });
      observe(request, pathname, 200);
      json(response, 200, { runId, seed, salt, phase: 'origin' });
      return;
    }
    if (request.method === 'PUT' && pathname === '/api/prism/bridge') {
      const state = sessions.get(body.runId);
      const accepted = state?.challenge === 'hard'
        && body.proof === prismProof(state.seed, state.salt, state.label);
      if (!accepted) {
        observe(request, pathname, 422);
        json(response, 422, { accepted: false, error: 'invalid_bridge' });
        return;
      }
      const bridgeTicket = opaque('bridge');
      state.bridgeTicket = bridgeTicket;
      observe(request, pathname, 200);
      json(response, 200, { accepted: true, bridgeTicket, phase: 'bridged' });
      return;
    }
    if (request.method === 'PATCH' && pathname === '/api/prism/complete') {
      const state = sessions.get(body.runId);
      const accepted = state?.challenge === 'hard'
        && Boolean(state.bridgeTicket)
        && body.ticket === state.bridgeTicket;
      observe(request, pathname, accepted ? 200 : 422, accepted);
      json(response, accepted ? 200 : 422, { accepted, challenge: 'hard' });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/aurora/open') {
      const runId = opaque('aurora');
      const channels = Array.from({ length: 36 }, (_, index) => ({
        channelId: `ch-${String(index + 1).padStart(2, '0')}`,
        signal: opaque('signal', 12),
        amplitude: 1000 + (index * 17) + Number(body.sequence || 0),
        checksumHint: opaque('hint', 7),
      }));
      const selectedIndex = 23;
      sessions.set(runId, {
        challenge: 'noise',
        signal: channels[selectedIndex].signal,
      });
      observe(request, pathname, 200);
      json(response, 200, {
        runId,
        phase: 'spectrum',
        channels,
        diagnostics: {
          sampleWindow: 36,
          calibration: opaque('calibration', 18),
          generatedAtTick: Number(body.sequence || 0),
        },
      });
      return;
    }
    if (request.method === 'POST' && pathname === '/api/events') {
      observe(request, pathname, 202);
      json(response, 202, {
        stored: true,
        eventId: opaque('event'),
        echo: body,
        decoys: Array.from({ length: 8 }, (_, index) => ({
          index,
          value: opaque('decoy', 14),
        })),
      });
      return;
    }
    if (request.method === 'PUT' && pathname === '/api/aurora/close') {
      const state = sessions.get(body.runId);
      const accepted = state?.challenge === 'noise' && body.signal === state.signal;
      observe(request, pathname, accepted ? 200 : 422, accepted);
      json(response, accepted ? 200 : 422, { accepted, challenge: 'noise' });
      return;
    }

    const v5Match = pathname.match(/^\/api\/v5\/([^/]+)\/(open|close|events)$/);
    if (v5Match) {
      const definition = V5_CASE_BY_ID.get(v5Match[1]);
      const action = v5Match[2];
      if (!definition) {
        observe(request, pathname, 404);
        json(response, 404, { error: 'unknown_v5_case' });
        return;
      }
      if (request.method === 'POST' && action === 'open') {
        const label = String(body.label || '');
        const sequence = Number(body.sequence);
        if (!label || !Number.isInteger(sequence)) {
          observe(request, pathname, 422);
          json(response, 422, { error: 'label_and_sequence_required' });
          return;
        }
        const runId = opaque('v5run');
        const values = {
          runId,
          label,
          token: opaque('token', 12).toLowerCase(),
          capsule: opaque('capsule', 12),
          seed: opaque('seed', 10),
          salt: opaque('salt', 8),
          nonce: opaque('nonce', 11),
          challenge: opaque('challenge', 10),
        };
        const proof = applyTransform(definition, values);
        const collisionCandidate = label.includes('-s1-')
          ? proof
          : opaque('collisionDecoy', 16);
        sessions.set(runId, { challenge: definition.id, proof });
        const candidates = Array.from({ length: definition.candidateCount }, (_, index) => ({
          candidateId: `candidate-${String(index + 1).padStart(2, '0')}`,
          token: opaque('decoyToken', 12),
          seedHint: opaque('decoySeed', 10),
          nonceHint: opaque('decoyNonce', 10),
        }));
        observe(request, pathname, 200);
        json(response, 200, {
          runId,
          token: values.token,
          capsule: values.capsule,
          seed: values.seed,
          salt: values.salt,
          nonce: values.nonce,
          challenge: values.challenge,
          collisionCandidate,
          candidates,
          metadata: {
            caseId: definition.id,
            sequence,
            candidateCount: candidates.length,
          },
        });
        return;
      }
      if (request.method === 'PATCH' && action === 'events') {
        observe(request, pathname, 202);
        json(response, 202, {
          stored: true,
          eventId: opaque('v5event'),
          echo: body,
          decoys: Array.from({ length: 10 }, (_, index) => ({
            index,
            proofHint: opaque('proofHint', 16),
            tokenHint: opaque('tokenHint', 12),
          })),
        });
        return;
      }
      if (request.method === 'PUT' && action === 'close') {
        const state = sessions.get(body.runId);
        const accepted = state?.challenge === definition.id && body.proof === state.proof;
        observe(request, pathname, accepted ? 200 : 422, accepted);
        json(response, accepted ? 200 : 422, {
          accepted,
          challenge: definition.id,
        });
        return;
      }
      observe(request, pathname, 405);
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }

    observe(request, pathname, 404);
    json(response, 404, { error: 'unknown_route' });
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await api(request, response, url.pathname);
      return;
    }
    const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'styles.css'].includes(asset)) {
      text(response, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }
    const types = {
      'index.html': 'text/html; charset=utf-8',
      'app.js': 'text/javascript; charset=utf-8',
      'styles.css': 'text/css; charset=utf-8',
    };
    text(response, 200, fs.readFileSync(path.join(PUBLIC_DIRECTORY, asset), 'utf8'), types[asset]);
  });

  return {
    server,
    challenges: CHALLENGES,
    getMetrics(runId) {
      return metrics.get(runId) || { requests: [], accepted: false };
    },
    resetMetrics(runId) {
      metrics.delete(runId);
    },
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return `http://${host}:${address.port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

if (require.main === module) {
  const gym = createGymServer();
  gym.listen(Number(process.env.GYM_PORT || 43127)).then((origin) => {
    console.log(`Features Farming Gym is ready at ${origin}`);
  });
}

module.exports = { createGymServer };
