'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  applyV6Transform,
  deterministicValue,
} = require('./v6-cases');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function semanticResponse(definition, actionIndex, iteration) {
  const field = definition.schemaFields[actionIndex];
  if (actionIndex === 0) return { [field]: `state-${iteration}` };
  if (actionIndex === 1) return { [field]: { revision: iteration, enabled: iteration % 2 === 0 } };
  return { [field]: [{ code: `code-${iteration}`, weight: iteration * 3 }] };
}

function writeV6Recording({
  definition,
  directory,
  sessionNumber,
  iterationCount,
}) {
  const host = `v6-${definition.seed}.test`;
  const origin = `https://${host}`;
  const bodyDirectory = path.join(directory, 'bodies');
  fs.mkdirSync(bodyDirectory, { recursive: true });
  const requests = [];
  const iterations = [];
  let requestNumber = 0;

  const addRequest = ({
    iterationId,
    method,
    route,
    requestBody,
    status,
    responseBody,
    resourceType = 'Fetch',
  }) => {
    requestNumber += 1;
    const id = `${definition.id}-s${sessionNumber}-r${requestNumber}`;
    const bodyFile = responseBody === undefined ? null : `bodies/${id}.json`;
    const timestamp = requestNumber * 10;
    requests.push({
      id,
      requestId: id,
      iterationId,
      requestTimestamp: timestamp,
      responseTimestamp: timestamp + 1,
      durationMs: 4 + (requestNumber % 7),
      resourceType,
      request: {
        method,
        url: `${origin}${route}`,
        headers: requestBody === undefined ? {} : { 'content-type': 'application/json' },
        postData: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      },
      response: {
        status,
        mimeType: responseBody === undefined ? 'text/plain' : 'application/json',
      },
      body: bodyFile ? { file: bodyFile } : undefined,
    });
    if (bodyFile) writeJson(path.join(directory, bodyFile), responseBody);
  };

  for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
    const iterationId = `iteration-${iteration}`;
    const before = requests.length;
    if (definition.family === 'semantic-siblings') {
      definition.actions.forEach((action, actionIndex) => {
        addRequest({
          iterationId,
          method: 'GET',
          route: `${definition.base}/${action}`,
          status: definition.statuses[actionIndex],
          responseBody: semanticResponse(definition, actionIndex, iteration),
        });
      });
      for (let noiseIndex = 0; noiseIndex < definition.noiseRequests; noiseIndex += 1) {
        addRequest({
          iterationId,
          method: 'PATCH',
          route: definition.noiseRoute,
          requestBody: { ordinal: noiseIndex, sample: `${definition.id}-${iteration}-${noiseIndex}` },
          status: 202,
          responseBody: { stored: true, event: `${iteration}-${noiseIndex}` },
        });
      }
    } else {
      const label = `${definition.id}-s${sessionNumber}-sample-${iteration}`;
      const values = deterministicValue(definition, sessionNumber, iteration, label);
      const runId = `run-${definition.seed}-${sessionNumber}-${iteration}`;
      values.payloads = Array.from({ length: 8 }, (_, payloadIndex) => ({
        [definition.fields.sourceField]: payloadIndex === definition.transform.selectedIndex
          ? values.source
          : `${values.source}-decoy-${payloadIndex}`,
        ordinal: payloadIndex,
      }));
      const proof = applyV6Transform(definition, values, label);
      addRequest({
        iterationId,
        method: 'POST',
        route: definition.routes.open,
        requestBody: { label, sequence: (sessionNumber * 100) + iteration },
        status: 200,
        responseBody: {
          runId,
          ...(definition.family === 'array-selection' ? {} : {
            [definition.fields.sourceField]: definition.family === 'affine-numeric' ? values.number : values.source,
          }),
          [definition.fields.secondSourceField]: values.secondSource,
          payloads: values.payloads,
          unstableHint: sessionNumber === 1 ? proof : `${values.source}-unstable`,
          candidates: Array.from({ length: definition.candidateCount }, (_, candidateIndex) => ({
            candidate: `${values.secondSource}-${candidateIndex}`,
            score: candidateIndex * 7 + iteration,
          })),
        },
      });
      for (let noiseIndex = 0; noiseIndex < definition.noiseRequests; noiseIndex += 1) {
        addRequest({
          iterationId,
          method: 'PATCH',
          route: definition.routes.noise,
          requestBody: {
            runId,
            ordinal: noiseIndex,
            decoy: `${values.source}-${noiseIndex}`,
            candidate: `${label}-${noiseIndex}`,
          },
          status: 202,
          responseBody: {
            stored: true,
            echo: `${values.secondSource}-${noiseIndex}`,
            samples: Array.from({ length: 6 }, (_, sampleIndex) => `${noiseIndex}-${sampleIndex}`),
          },
        });
      }
      addRequest({
        iterationId,
        method: 'PUT',
        route: definition.routes.close,
        requestBody: {
          runId,
          [definition.fields.targetField]: proof,
        },
        status: 200,
        responseBody: { accepted: true, challenge: definition.id },
      });
    }
    iterations.push({
      id: iterationId,
      requestCount: requests.length - before,
      reason: 'gym-v6-generated',
    });
  }

  writeJson(path.join(directory, 'manifest.json'), {
    id: `${definition.id}-session-${sessionNumber}`,
    startUrl: `${origin}/`,
    benchmark: 'farmer-gym-v6',
    suiteSeed: definition.seed,
    caseId: definition.id,
  });
  writeJson(path.join(directory, 'iterations.json'), iterations);
  writeJson(path.join(directory, 'requests.json'), requests);
  writeJson(path.join(directory, 'cookies.json'), []);
  return {
    directory,
    requestCount: requests.length,
  };
}

module.exports = {
  semanticResponse,
  writeV6Recording,
};
