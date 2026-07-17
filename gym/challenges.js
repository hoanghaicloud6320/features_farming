'use strict';

const crypto = require('node:crypto');

const CHALLENGES = {
  easy: {
    id: 'easy',
    title: 'Marble Relay',
    difficulty: 'Easy · direct value flow',
    description: 'Copy a value from one response into the next request.',
    routes: ['/api/marble/session', '/api/marble/confirm'],
  },
  medium: {
    id: 'medium',
    title: 'Lattice Capsule',
    difficulty: 'Medium · transformed value flow',
    description: 'Transform a response value before using it as authorization.',
    routes: ['/api/lattice/seed', '/api/lattice/unseal'],
  },
  hard: {
    id: 'hard',
    title: 'Prism Bridge',
    difficulty: 'Hard · inferred bridge plus direct relay',
    description: 'Infer an unobserved bridge transformation, then relay its output.',
    routes: ['/api/prism/origin', '/api/prism/bridge', '/api/prism/complete'],
  },
  noise: {
    id: 'noise',
    title: 'Aurora Needle',
    difficulty: 'Noisy · dependency hidden among decoys',
    description: 'Find one stable response-to-request dependency inside a large, noisy timeline.',
    routes: ['/api/aurora/open', '/api/aurora/close'],
  },
};

function opaque(prefix, bytes = 9) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

function prismProof(seed, salt, label) {
  return crypto.createHash('sha256')
    .update(`${seed}:${salt}:${label}`)
    .digest('hex')
    .slice(0, 24);
}

module.exports = {
  CHALLENGES,
  opaque,
  prismProof,
};
