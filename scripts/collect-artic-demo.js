#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { NetworkRecorder } = require('../../requests_recorder/src/recorder');

const QUERIES = ['netsuke', 'mezzotint', 'faience', 'cassone', 'cyanotype'];
const START_URL = 'https://api.artic.edu/api/v1/artworks?limit=1&fields=id,title';
const USER_AGENT = 'features-farming-demo (local evaluation)';

async function waitForIterationEnd(recorder, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (recorder.iterationState().active && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (recorder.iterationState().active) await recorder.endIteration('collector-timeout');
}

async function collectOne(outputRoot, runNumber) {
  const recorder = new NetworkRecorder({
    outputRoot,
    startUrl: START_URL,
    headless: true,
    showControls: false,
    captureBodies: true,
    maxBodyBytes: 5 * 1024 * 1024,
    iterationQuietMs: 700,
    iterationMinMs: 0,
    iterationMaxMs: 12_000,
  });
  try {
    const { page } = await recorder.start();
    await page.waitForTimeout(500);
    for (let index = 0; index < QUERIES.length; index += 1) {
      await recorder.startIteration('artic-demo-collector');
      const result = await page.evaluate(async ({ query, userAgent, runNumber, index }) => {
        const searchResponse = await fetch('/api/v1/artworks/search', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'AIC-User-Agent': userAgent,
            'x-demo-run': String(runNumber),
          },
          body: JSON.stringify({
            q: query,
            query: { term: { is_public_domain: true } },
            size: 3,
            from: index,
            fields: ['id', 'title', 'artist_display', 'date_display', 'image_id', 'is_public_domain'],
          }),
        });
        if (!searchResponse.ok) throw new Error(`Search failed with ${searchResponse.status}`);
        const search = await searchResponse.json();
        const artworkId = search.data?.[0]?.id;
        if (!Number.isInteger(artworkId)) throw new Error(`No artwork id for ${query}`);
        const detailResponse = await fetch(
          `/api/v1/artworks/${artworkId}?fields=id,title,artist_display,date_display,image_id,is_public_domain`,
          { headers: { 'AIC-User-Agent': userAgent, 'x-demo-run': String(runNumber) } },
        );
        if (!detailResponse.ok) throw new Error(`Detail failed with ${detailResponse.status}`);
        const detail = await detailResponse.json();
        return { query, artworkId, title: detail.data?.title || null };
      }, { query: QUERIES[index], userAgent: USER_AGENT, runNumber, index });
      console.log(`run ${runNumber}, iteration ${index + 1}: ${result.query} -> ${result.artworkId} ${result.title || ''}`);
      await waitForIterationEnd(recorder);
    }
    await recorder.stop('artic-demo-complete');
    return recorder.sessionDir;
  } catch (error) {
    await recorder.stop('artic-demo-error');
    throw error;
  }
}

async function main() {
  const workspace = path.resolve(__dirname, '..');
  const outputRoot = path.join(workspace, 'demo-data', 'artic-artworks');
  fs.mkdirSync(outputRoot, { recursive: true });
  const sessions = [];
  for (let runNumber = 1; runNumber <= 3; runNumber += 1) {
    sessions.push(await collectOne(outputRoot, runNumber));
  }
  fs.writeFileSync(
    path.join(outputRoot, 'demo-sessions.json'),
    `${JSON.stringify({ collectedAt: new Date().toISOString(), sessions }, null, 2)}\n`,
  );
  console.log(`Collected ${sessions.length} sessions under ${outputRoot}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
