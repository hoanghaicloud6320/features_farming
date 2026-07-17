'use strict';

async function request(path, options) {
  const response = await fetch(path, options);
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function runEasy(label) {
  const start = await request('/api/marble/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  return request('/api/marble/confirm', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: start.runId, handoffKey: start.handoffKey }),
  });
}

async function runMedium(label) {
  const start = await request('/api/lattice/seed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  const authorization = btoa(start.capsule)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return request('/api/lattice/unseal', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authorization}`,
    },
    body: JSON.stringify({ runId: start.runId }),
  });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function runHard(label, sequence = 1) {
  const origin = await request('/api/prism/origin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, sequence }),
  });
  const proof = (await sha256(`${origin.seed}:${origin.salt}:${label}`)).slice(0, 24);
  const bridge = await request('/api/prism/bridge', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: origin.runId, proof }),
  });
  return request('/api/prism/complete', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: origin.runId, ticket: bridge.bridgeTicket }),
  });
}

async function runNoise(label, sequence = 1) {
  const opened = await request('/api/aurora/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, sequence }),
  });
  for (let index = 0; index < 18; index += 1) {
    await request('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: opened.runId,
        ordinal: index,
        observed: opened.channels[(index * 7) % opened.channels.length].signal,
        payload: Array.from({ length: 10 }, (_, item) => `${label}-${index}-${item}`),
      }),
    });
  }
  return request('/api/aurora/close', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId: opened.runId,
      signal: opened.channels[23].signal,
    }),
  });
}

const V5_TRANSFORMS = {
  'simple-exact-noise': { operation: 'exact', field: 'token', noise: 24 },
  'simple-base64-noise': { operation: 'base64url', noise: 24 },
  'simple-case-noise': { operation: 'uppercase', noise: 24 },
  'simple-prefix-noise': { operation: 'prefix', value: 'MARKER-', noise: 24 },
  'hard-sha256-clean': { operation: 'hash', algorithm: 'SHA-256', fields: ['seed', 'salt', '$label'], delimiter: ':', length: 24, noise: 0 },
  'hard-sha1-clean': { operation: 'hash', algorithm: 'SHA-1', fields: ['nonce', '$label'], delimiter: '|', length: 32, noise: 0 },
  'hard-md5-clean': { operation: 'md5', fields: ['salt', 'seed', '$label'], delimiter: '-', length: 32, noise: 0 },
  'hard-sha256-nodelim-clean': { operation: 'hash', algorithm: 'SHA-256', fields: ['seed', 'nonce', '$label'], delimiter: '', length: 40, noise: 0 },
  'hard-sha256-noise': { operation: 'hash', algorithm: 'SHA-256', fields: ['seed', 'salt', '$label'], delimiter: ':', length: 24, noise: 30 },
  'hard-sha1-noise': { operation: 'hash', algorithm: 'SHA-1', fields: ['nonce', '$label'], delimiter: '.', length: 36, noise: 30 },
  'hard-md5-noise': { operation: 'md5', fields: ['salt', 'seed', '$label'], delimiter: '/', length: 28, noise: 30 },
  'hard-sha256-candidate-noise': { operation: 'hash', algorithm: 'SHA-256', fields: ['challenge', 'nonce', '$label'], delimiter: '-', length: 32, noise: 36 },
};

function md5(value) {
  // Compact browser implementation used only by the synthetic recorder workflow.
  function rotateLeft(number, count) {
    return (number << count) | (number >>> (32 - count));
  }
  function addUnsigned(x, y) {
    const x4 = x & 0x40000000;
    const y4 = y & 0x40000000;
    const x8 = x & 0x80000000;
    const y8 = y & 0x80000000;
    const result = (x & 0x3fffffff) + (y & 0x3fffffff);
    if (x4 & y4) return result ^ 0x80000000 ^ x8 ^ y8;
    if (x4 | y4) return (result & 0x40000000) ? result ^ 0xc0000000 ^ x8 ^ y8 : result ^ 0x40000000 ^ x8 ^ y8;
    return result ^ x8 ^ y8;
  }
  const f = (x, y, z) => (x & y) | ((~x) & z);
  const g = (x, y, z) => (x & z) | (y & (~z));
  const h = (x, y, z) => x ^ y ^ z;
  const i = (x, y, z) => y ^ (x | (~z));
  function step(fn, a, b, c, d, x, s, ac) {
    return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, fn(b, c, d)), addUnsigned(x, ac)), s), b);
  }
  const utf8 = unescape(encodeURIComponent(value));
  const words = [];
  for (let index = 0; index < utf8.length; index += 1) {
    words[index >> 2] = (words[index >> 2] || 0) | (utf8.charCodeAt(index) << ((index % 4) * 8));
  }
  words[utf8.length >> 2] = (words[utf8.length >> 2] || 0) | (0x80 << ((utf8.length % 4) * 8));
  words[(((utf8.length + 8) >> 6) + 1) * 16 - 2] = utf8.length * 8;
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const shifts = [
    7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21,
  ];
  const functions = [f, g, h, i];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32));
  for (let offset = 0; offset < words.length; offset += 16) {
    const previous = [a, b, c, d];
    for (let round = 0; round < 64; round += 1) {
      const group = Math.floor(round / 16);
      const wordIndex = group === 0 ? round : group === 1 ? (5 * round + 1) % 16 : group === 2 ? (3 * round + 5) % 16 : (7 * round) % 16;
      const next = step(functions[group], a, b, c, d, words[offset + wordIndex] || 0, shifts[(group * 4) + (round % 4)], constants[round]);
      a = d;
      d = c;
      c = b;
      b = next;
    }
    a = addUnsigned(a, previous[0]);
    b = addUnsigned(b, previous[1]);
    c = addUnsigned(c, previous[2]);
    d = addUnsigned(d, previous[3]);
  }
  return [a, b, c, d].map((word) => (
    [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')
  )).join('');
}

async function v5Proof(spec, opened, label) {
  if (spec.operation === 'exact') return opened[spec.field];
  if (spec.operation === 'base64url') {
    return btoa(opened.capsule).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
  if (spec.operation === 'uppercase') return opened.token.toUpperCase();
  if (spec.operation === 'prefix') return `${spec.value}${opened.token}`;
  const input = spec.fields.map((field) => field === '$label' ? label : opened[field]).join(spec.delimiter);
  if (spec.operation === 'md5') return md5(input).slice(0, spec.length);
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest(spec.algorithm, bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, spec.length);
}

async function runV5(caseId, label, sequence = 1) {
  const spec = V5_TRANSFORMS[caseId];
  const base = `/api/v5/${caseId}`;
  const opened = await request(`${base}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label, sequence }),
  });
  for (let index = 0; index < spec.noise; index += 1) {
    await request(`${base}/events`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: opened.runId,
        ordinal: index,
        observedToken: opened.candidates.length
          ? opened.candidates[(index * 7) % opened.candidates.length].token
          : `empty-${index}`,
        proofCandidate: `${label}-${sequence}-${index}`,
        payload: Array.from({ length: 8 }, (_, item) => `${caseId}-${index}-${item}`),
      }),
    });
  }
  return request(`${base}/close`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId: opened.runId,
      proof: await v5Proof(spec, opened, label),
    }),
  });
}

window.Gym = {
  runChallenge(challenge, label, sequence) {
    if (challenge === 'easy') return runEasy(label);
    if (challenge === 'medium') return runMedium(label);
    if (challenge === 'hard') return runHard(label, sequence);
    if (challenge === 'noise') return runNoise(label, sequence);
    if (V5_TRANSFORMS[challenge]) return runV5(challenge, label, sequence);
    throw new Error(`Unknown challenge: ${challenge}`);
  },
};

for (const button of document.querySelectorAll('button[data-challenge]')) {
  button.addEventListener('click', async () => {
    const challenge = button.dataset.challenge;
    const output = document.querySelector(`#result-${challenge}`);
    button.disabled = true;
    output.textContent = 'Running…';
    try {
      const label = `browser-${Date.now().toString(36)}`;
      const result = await window.Gym.runChallenge(challenge, label, 1);
      output.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      output.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}
