'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { lineageValue } = require('./v8-cases');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function activeLink(definition, item, sessionNumber) {
  const lineage = definition.lineages.find((candidate) => candidate.id === item.lineage);
  return !lineage.activeSessions || lineage.activeSessions.includes(sessionNumber);
}

function writeV8Recording({
  definition,
  directory,
  sessionNumber,
  iterationCount,
}) {
  const host = `v8-${definition.seed}.test`;
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
  }) => {
    requestNumber += 1;
    const id = `${definition.id}-s${sessionNumber}-r${requestNumber}`;
    const bodyFile = `bodies/${id}.json`;
    requests.push({
      id,
      requestId: id,
      iterationId,
      requestTimestamp: requestNumber * 10,
      responseTimestamp: requestNumber * 10 + 1,
      durationMs: 3 + (requestNumber % 9),
      resourceType: 'Fetch',
      request: {
        method,
        url: `${origin}${route}`,
        headers: requestBody ? { 'content-type': 'application/json' } : {},
        postData: requestBody ? JSON.stringify(requestBody) : undefined,
      },
      response: {
        status,
        mimeType: 'application/json',
      },
      body: { file: bodyFile },
    });
    writeJson(path.join(directory, bodyFile), responseBody);
  };

  for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
    const iterationId = `iteration-${iteration}`;
    const before = requests.length;
    const values = Object.fromEntries(definition.lineages.map((lineage) => [
      lineage.id,
      lineageValue(definition, lineage.id, sessionNumber, iteration),
    ]));
    for (let stepIndex = 0; stepIndex < definition.steps.length; stepIndex += 1) {
      const definitionStep = definition.steps[stepIndex];
      const activeRequestLinks = definitionStep.requestLinks
        .filter((item) => activeLink(definition, item, sessionNumber));
      const activeResponseLinks = definitionStep.responseLinks
        .filter((item) => activeLink(definition, item, sessionNumber));
      const query = new URLSearchParams();
      const requestBody = {
        label: `${definition.id}-${sessionNumber}-${iteration}-${definitionStep.role}`,
      };
      for (const item of activeRequestLinks) {
        if (item.location === 'query') query.set(item.field, values[item.lineage]);
        else requestBody[item.field] = values[item.lineage];
      }
      const responseBody = {
        ok: true,
        revision: iteration + stepIndex,
      };
      for (const item of activeResponseLinks) {
        responseBody[item.field] = values[item.lineage];
      }
      const queryText = query.toString();
      addRequest({
        iterationId,
        method: definitionStep.method,
        route: `${definitionStep.route}${queryText ? `?${queryText}` : ''}`,
        requestBody: Object.keys(requestBody).length > 1 || !['GET', 'DELETE'].includes(definitionStep.method)
          ? requestBody
          : null,
        status: [200, 201, 202, 204][stepIndex % 4],
        responseBody,
      });
    }
    for (let noiseIndex = 0; noiseIndex < definition.noiseRequests; noiseIndex += 1) {
      addRequest({
        iterationId,
        method: 'PATCH',
        route: definition.noiseRoute,
        requestBody: {
          eventId: `event-${definition.seed}-${sessionNumber}-${iteration}-${noiseIndex}`,
          ordinal: noiseIndex,
        },
        status: 202,
        responseBody: {
          stored: true,
          receipt: `receipt-${definition.seed}-${sessionNumber}-${iteration}-${noiseIndex}`,
        },
      });
    }
    iterations.push({
      id: iterationId,
      requestCount: requests.length - before,
      reason: 'gym-v8-generated',
    });
  }

  writeJson(path.join(directory, 'manifest.json'), {
    id: `${definition.id}-session-${sessionNumber}`,
    startUrl: `${origin}/`,
    benchmark: 'farmer-gym-v8-lineage-compression',
    suiteSeed: definition.seed,
    caseId: definition.id,
  });
  writeJson(path.join(directory, 'iterations.json'), iterations);
  writeJson(path.join(directory, 'requests.json'), requests);
  writeJson(path.join(directory, 'cookies.json'), []);
}

module.exports = {
  writeV8Recording,
};
