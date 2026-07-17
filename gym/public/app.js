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

window.Gym = {
  runChallenge(challenge, label, sequence) {
    if (challenge === 'easy') return runEasy(label);
    if (challenge === 'medium') return runMedium(label);
    if (challenge === 'hard') return runHard(label, sequence);
    if (challenge === 'noise') return runNoise(label, sequence);
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
