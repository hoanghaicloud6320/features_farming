#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NetworkRecorder } = require('../../requests_recorder/src/recorder');
const { farmInput } = require('../src/collection');
const { createGymServer } = require('../gym/server');

const CHALLENGE_IDS = process.env.GYM_CHALLENGES
  ? process.env.GYM_CHALLENGES.split(',').map((value) => value.trim()).filter(Boolean)
  : ['easy', 'medium', 'hard', 'noise'];
const ITERATIONS_PER_SESSION = 5;
const SESSION_COUNT = 3;

async function waitForIterationEnd(recorder, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (recorder.iterationState().active && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (recorder.iterationState().active) await recorder.endIteration('gym-collector-timeout');
}

async function collectSession({ origin, outputRoot, challenge, sessionNumber }) {
  const recorder = new NetworkRecorder({
    outputRoot,
    startUrl: origin,
    headless: true,
    showControls: false,
    captureBodies: true,
    maxBodyBytes: 512 * 1024,
    iterationQuietMs: 180,
    iterationMinMs: 0,
    iterationMaxMs: 8_000,
  });
  try {
    const { page } = await recorder.start();
    await page.waitForFunction(() => Boolean(window.Gym));
    for (let index = 0; index < ITERATIONS_PER_SESSION; index += 1) {
      const label = `${challenge}-s${sessionNumber}-sample-${index + 1}`;
      await recorder.startIteration(`gym-${challenge}-collector`);
      const result = await page.evaluate(
        ({ challengeId, sampleLabel, sequence }) => (
          window.Gym.runChallenge(challengeId, sampleLabel, sequence)
        ),
        { challengeId: challenge, sampleLabel: label, sequence: (sessionNumber * 10) + index },
      );
      if (!result.accepted) throw new Error(`${challenge} iteration was not accepted`);
      await waitForIterationEnd(recorder);
    }
    return await recorder.stop(`gym-${challenge}-complete`);
  } catch (error) {
    await recorder.stop(`gym-${challenge}-error`);
    throw error;
  }
}

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const recordingRoot = path.join(workspace, 'demo-data', 'gym');
  const farmRoot = path.join(workspace, 'output', 'gym');
  fs.mkdirSync(recordingRoot, { recursive: true });
  fs.mkdirSync(farmRoot, { recursive: true });

  const gym = createGymServer();
  const origin = await gym.listen();
  const manifest = {
    generatedAt: new Date().toISOString(),
    origin,
    sessionCountPerChallenge: SESSION_COUNT,
    iterationsPerSession: ITERATIONS_PER_SESSION,
    challenges: fs.existsSync(path.join(recordingRoot, 'manifest.json'))
      ? JSON.parse(fs.readFileSync(path.join(recordingRoot, 'manifest.json'), 'utf8')).challenges || {}
      : {},
  };
  try {
    for (const challenge of CHALLENGE_IDS) {
      if (!gym.challenges[challenge]) throw new Error(`Unknown gym challenge: ${challenge}`);
      const challengeRecordingRoot = path.join(recordingRoot, challenge);
      const challengeFarmRoot = path.join(farmRoot, challenge);
      fs.mkdirSync(challengeRecordingRoot, { recursive: true });
      const sessions = [];
      for (let sessionNumber = 1; sessionNumber <= SESSION_COUNT; sessionNumber += 1) {
        const directory = await collectSession({
          origin,
          outputRoot: challengeRecordingRoot,
          challenge,
          sessionNumber,
        });
        sessions.push(directory);
        console.log(`${challenge}: captured session ${sessionNumber}/${SESSION_COUNT}`);
      }
      const farmed = await farmInput({
        inputDirectory: challengeRecordingRoot,
        outputDirectory: challengeFarmRoot,
      });
      manifest.challenges[challenge] = {
        recordings: challengeRecordingRoot,
        farm: challengeFarmRoot,
        sessions,
        capturedRequestCount: farmed.summary.capturedRequestCount,
        relationCount: farmed.summary.crossSessionRelations.length,
      };
      console.log(`${challenge}: farmed ${farmed.summary.crossSessionRelations.length} cross-session relations`);
    }
  } finally {
    await gym.close();
  }
  fs.writeFileSync(
    path.join(recordingRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`Gym collection ready under ${recordingRoot}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
