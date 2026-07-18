'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { farmRecording } = require('./farm');

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecordingDirectory(directory) {
  return ['manifest.json', 'requests.json', 'iterations.json']
    .every((name) => fs.existsSync(path.join(directory, name)));
}

function discoverRecordings(inputDirectory) {
  if (isRecordingDirectory(inputDirectory)) return [inputDirectory];
  if (!fs.existsSync(inputDirectory)) throw new Error(`Input directory does not exist: ${inputDirectory}`);
  return fs.readdirSync(inputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(inputDirectory, entry.name))
    .filter(isRecordingDirectory)
    .sort();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function endpointBase(signature) {
  const queryIndex = signature.indexOf('?');
  return queryIndex >= 0 ? signature.slice(0, queryIndex) : signature;
}

function aggregateByKey(sessionResults, selector, keyOf, summarize) {
  const groups = new Map();
  for (const session of sessionResults) {
    for (const item of selector(session.result)) {
      const key = keyOf(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ sessionId: session.sessionId, item });
    }
  }
  return [...groups.entries()].map(([key, entries]) => summarize(key, entries));
}

function sumCounts(entries, selector) {
  const counts = new Map();
  for (const entry of entries) {
    for (const [key, count] of Object.entries(selector(entry) || {})) {
      counts.set(key, (counts.get(key) || 0) + count);
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))));
}

function aggregateNested(entries, selector, keyOf, summarize) {
  const groups = new Map();
  for (const entry of entries) {
    for (const item of selector(entry.item)) {
      const key = keyOf(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ sessionId: entry.sessionId, item });
    }
  }
  return [...groups.values()].map(summarize);
}

function aggregateEndpointMembers(entries, usableCount) {
  const groups = new Map();
  for (const entry of entries) {
    for (const member of entry.item.members || []) {
      const key = endpointBase(member.signature);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ sessionId: entry.sessionId, item: member });
    }
  }
  return [...groups.entries()].map(([routeKey, memberEntries]) => {
    const first = memberEntries[0].item;
    const queryKeys = [...new Set(memberEntries.flatMap((entry) => entry.item.queryKeys || []))].sort();
    const fields = aggregateNested(
      memberEntries,
      (member) => member.fields || [],
      (field) => `${field.side}|${field.location}|${field.fieldPath}`,
      (fieldEntries) => {
        const field = fieldEntries[0].item;
        return {
          side: field.side,
          location: field.location,
          fieldPath: field.fieldPath,
          sessionPresence: new Set(fieldEntries.map((entry) => entry.sessionId)).size,
          iterationPresence: fieldEntries.reduce((sum, entry) => sum + entry.item.iterationPresence, 0),
          behaviors: [...new Set(fieldEntries.map((entry) => entry.item.classification))].sort(),
          types: [...new Set(fieldEntries.map((entry) => entry.item.type))].sort(),
          examples: fieldEntries.flatMap((entry) => entry.item.examples || []).slice(0, 8),
        };
      },
    ).sort((a, b) => a.side.localeCompare(b.side) || a.fieldPath.localeCompare(b.fieldPath));
    const schemas = aggregateNested(
      memberEntries,
      (member) => member.schemas || [],
      (schema) => `${schema.side}|${schema.location}|${schema.fieldPath}|${schema.kind}`,
      (schemaEntries) => {
        const schema = schemaEntries[0].item;
        return {
          side: schema.side,
          location: schema.location,
          fieldPath: schema.fieldPath,
          kind: schema.kind,
          sessionPresence: new Set(schemaEntries.map((entry) => entry.sessionId)).size,
          observationCount: schemaEntries.reduce((sum, entry) => sum + entry.item.observationCount, 0),
          types: [...new Set(schemaEntries.flatMap((entry) => entry.item.types || []))].sort(),
          itemTypes: [...new Set(schemaEntries.flatMap((entry) => entry.item.itemTypes || []))].sort(),
          keys: [...new Set(schemaEntries.flatMap((entry) => entry.item.keys || []))].sort(),
          examples: schemaEntries.flatMap((entry) => entry.item.examples || []).slice(0, 8),
        };
      },
    ).sort((a, b) => a.side.localeCompare(b.side) || a.fieldPath.localeCompare(b.fieldPath));
    const relations = aggregateNested(
      memberEntries,
      (member) => member.relations || [],
      (relation) => [
        relation.kind,
        relation.source.endpoint,
        relation.source.side,
        relation.source.location,
        relation.source.fieldPath,
        relation.target.endpoint,
        relation.target.side,
        relation.target.location,
        relation.target.fieldPath,
      ].join('|'),
      (relationEntries) => {
        const relation = relationEntries[0].item;
        return {
          kind: relation.kind,
          source: relation.source,
          sources: relation.sources,
          target: relation.target,
          sessionPresence: new Set(relationEntries.map((entry) => entry.sessionId)).size,
          supportIterations: relationEntries.reduce((sum, entry) => sum + entry.item.supportIterations, 0),
          transforms: [...new Set(relationEntries
            .map((entry) => JSON.stringify(entry.item.transform))
            .filter((value) => value !== undefined))].map(JSON.parse),
          examples: relationEntries.flatMap((entry) => entry.item.evidence || []).slice(0, 5),
        };
      },
    ).sort((a, b) => b.sessionPresence - a.sessionPresence || b.supportIterations - a.supportIterations);
    return {
      routeKey,
      signature: `${routeKey}?${queryKeys.join(',')}`,
      method: first.method,
      hostname: first.hostname,
      pathnameTemplate: first.pathnameTemplate,
      queryKeys,
      sessionPresence: new Set(memberEntries.map((entry) => entry.sessionId)).size,
      sessionPresenceRatio: round(new Set(memberEntries.map((entry) => entry.sessionId)).size / Math.max(usableCount, 1)),
      iterationPresence: memberEntries.reduce((sum, entry) => sum + entry.item.iterationPresence, 0),
      totalRequestCount: memberEntries.reduce((sum, entry) => sum + entry.item.requestCount, 0),
      sessionSupport: memberEntries.map((entry) => ({
        sessionId: entry.sessionId,
        iterationPresence: entry.item.iterationPresence,
        requestCount: entry.item.requestCount,
      })),
      statusCounts: sumCounts(memberEntries, (entry) => entry.item.statusCounts),
      examples: [...new Set(memberEntries.flatMap((entry) => entry.item.examples || []))].slice(0, 12),
      fields,
      requestFields: fields.filter((field) => field.side === 'request'),
      schemas,
      responseSchemas: schemas.filter((schema) => schema.side === 'response'),
      relations,
    };
  }).sort((a, b) => a.signature.localeCompare(b.signature));
}

function collectionReport(summary) {
  const lines = ['# Cross-session features report', ''];
  const coreFields = summary.crossSessionFields
    .filter((field) => (
      field.endpointClassifications.includes('core')
      && ['url.query', 'url.path', 'body.json', 'body.form'].includes(field.location)
    ))
    .sort((a, b) => {
      const variableA = a.behaviors.some((behavior) => behavior !== 'constant') ? 1 : 0;
      const variableB = b.behaviors.some((behavior) => behavior !== 'constant') ? 1 : 0;
      return variableB - variableA || b.sessionPresence - a.sessionPresence || a.display.localeCompare(b.display);
    });
  const notableRelations = summary.crossSessionRelations.filter((relation) => (
    relation.sourceEndpointClassifications.includes('core')
    && relation.targetEndpointClassifications.includes('core')
    && !relation.source.includes('.cookie')
    && !relation.target.includes('.cookie')
  ));
  const cookieRelations = summary.crossSessionRelations.filter((relation) => (
    relation.source.includes('response.cookie')
    || relation.target.includes('request.cookie')
    || relation.kind.includes('token')
    || relation.kind.includes('jwt')
  ));
  const coreArraySchemas = summary.crossSessionSchemas.filter((schema) => (
    schema.kind === 'array' && schema.endpointClassifications.includes('core')
  ));
  lines.push('## Collection overview', '');
  lines.push(`- ${summary.sessionCount} recording sessions were analyzed; ${summary.usableSessionCount} contained captured iteration requests.`);
  lines.push(`- ${summary.iterationCount} total usable iterations contain ${summary.capturedRequestCount} captured requests.`);
  lines.push(`- ${summary.crossSessionEndpoints.length} endpoint structures were seen across the collection.`);
  lines.push('');

  lines.push('## Stable workflow across sessions', '');
  for (let index = 0; index < summary.consensusWorkflow.length; index += 1) {
    const step = summary.consensusWorkflow[index];
    lines.push(`${index + 1}. \`${step.endpoint}\` -- present in ${step.sessionPresence}/${summary.usableSessionCount} usable sessions; median position ${step.medianPosition}.`);
  }
  if (!summary.consensusWorkflow.length) lines.push('No endpoint sequence repeated across usable sessions.');
  lines.push('');

  lines.push('## Cross-session fields', '');
  for (const field of coreFields.slice(0, 30)) {
    lines.push(`- \`${field.display}\` -- ${field.behaviors.join(', ')}; seen in ${field.sessionPresence}/${summary.usableSessionCount} sessions.`);
  }
  if (!coreFields.length) lines.push('No structured field on core endpoints repeated across sessions.');
  lines.push('');

  lines.push('## Cross-session data flows', '');
  for (const relation of notableRelations.slice(0, 30)) {
    const transform = relation.transforms.length
      ? ` Forward transform: \`${JSON.stringify(relation.transforms[0])}\`.`
      : '';
    lines.push(`- **${relation.kind}** in ${relation.sessionPresence}/${summary.usableSessionCount} sessions: \`${relation.source}\` -> \`${relation.target}\`.${transform}`);
  }
  if (!notableRelations.length) lines.push('No core-to-core value-flow relation repeated across sessions.');
  lines.push('');

  lines.push('## Stable array schemas', '');
  for (const schema of coreArraySchemas.slice(0, 20)) {
    lines.push(`- \`${schema.endpoint} :: ${schema.side}${schema.fieldPath}\` -- ${schema.sessionPresence}/${summary.usableSessionCount} sessions; length ${schema.arrayLengthRange.min}..${schema.arrayLengthRange.max}; items: ${schema.itemTypes.join(', ') || 'unknown'}.`);
  }
  if (!coreArraySchemas.length) lines.push('No array schema on core endpoints repeated across sessions.');
  lines.push('');

  lines.push('## Cookies and token lineage', '');
  for (const cookie of summary.crossSessionCookies.slice(0, 15)) {
    lines.push(`- \`${cookie.name}\` on \`${cookie.domain || '(host only)'}\` -- ${cookie.sessionPresence}/${summary.usableSessionCount} sessions, ${cookie.distinctObservedValues} observed value(s), ${cookie.httpOnly ? 'HttpOnly' : 'script-readable'}, ${cookie.secure ? 'Secure' : 'not Secure'}.`);
  }
  if (!summary.crossSessionCookies.length) lines.push('No cookie repeated across sessions.');
  for (const relation of cookieRelations.slice(0, 10)) {
    lines.push(`- Lineage **${relation.kind}**: \`${relation.source}\` -> \`${relation.target}\` in ${relation.sessionPresence} session(s).`);
  }
  lines.push('');

  lines.push('## Workflow variation', '');
  lines.push(`- Optional branch candidates across sessions: ${summary.patternTotals.optionalBranches}.`);
  lines.push(`- Retry candidates across sessions: ${summary.patternTotals.retries}.`);
  lines.push(`- Polling candidates across sessions: ${summary.patternTotals.polling}.`);
  lines.push('');

  lines.push('## Session quality', '');
  for (const session of summary.sessions) {
    lines.push(`- \`${session.id}\`: ${session.iterationCount} usable iterations, ${session.capturedRequestCount} captured requests, ${session.responseBodyWarningCount} body warnings.`);
  }
  lines.push('');
  lines.push('Individual session evidence is stored under `sessions/<recording-id>/`.');
  return `${lines.join('\n')}\n`;
}

function aggregateSessions(sessionResults) {
  const usable = sessionResults.filter((session) => session.result.summary.recording.capturedRequestCount > 0);
  const usableCount = usable.length;
  const endpoints = aggregateByKey(
    usable,
    (result) => result.endpoints,
    (endpoint) => endpointBase(endpoint.signature),
    (routeKey, entries) => {
      const queryKeys = [...new Set(entries.flatMap((entry) => entry.item.queryKeys || []))].sort();
      return {
      routeKey,
      signature: `${routeKey}?${queryKeys.join(',')}`,
      queryKeys,
      sessionPresence: new Set(entries.map((entry) => entry.sessionId)).size,
      sessionPresenceRatio: round(new Set(entries.map((entry) => entry.sessionId)).size / Math.max(usableCount, 1)),
      totalRequestCount: entries.reduce((sum, entry) => sum + entry.item.requestCount, 0),
      statusCounts: sumCounts(entries, (entry) => entry.item.statusCounts),
      classifications: [...new Set(entries.map((entry) => entry.item.classifications))].sort(),
      medianDurationMs: median(entries.map((entry) => entry.item.medianDurationMs).filter(Number.isFinite)),
      examples: [...new Set(entries.flatMap((entry) => entry.item.examples))].slice(0, 5),
      members: aggregateEndpointMembers(entries, usableCount),
      familyOnlyAttributes: {
        fields: [...new Set(entries.flatMap((entry) => entry.item.familyOnlyAttributes?.fields || []))],
        schemas: [...new Set(entries.flatMap((entry) => entry.item.familyOnlyAttributes?.schemas || []))],
        relations: [...new Set(entries.flatMap((entry) => entry.item.familyOnlyAttributes?.relations || []))],
      },
      attributionWarnings: [...new Set(entries.flatMap((entry) => entry.item.attributionWarnings || []))],
    };
    },
  ).sort((a, b) => b.sessionPresence - a.sessionPresence || b.totalRequestCount - a.totalRequestCount);
  const endpointClassifications = new Map(endpoints.map((endpoint) => [endpoint.signature, endpoint.classifications]));
  const endpointAliases = new Map();
  for (const session of usable) {
    for (const endpoint of session.result.endpoints) {
      const aggregate = endpoints.find((candidate) => candidate.routeKey === endpointBase(endpoint.signature));
      if (aggregate) endpointAliases.set(endpoint.signature, aggregate.signature);
    }
  }

  const fields = aggregateByKey(
    usable,
    (result) => result.fields,
    (field) => {
      const normalizedPath = field.location.startsWith('body.') ? field.fieldPath.replace(/\[\d+\]/g, '[]') : field.fieldPath;
      return `${endpointAliases.get(field.endpoint) || field.endpoint}|${field.side}|${field.location}|${normalizedPath}`;
    },
    (_key, entries) => {
      const first = entries[0].item;
      const endpoint = endpointAliases.get(first.endpoint) || first.endpoint;
      const fieldPath = first.location.startsWith('body.')
        ? first.fieldPath.replace(/\[\d+\]/g, '[]')
        : first.fieldPath;
      return {
        endpoint,
        side: first.side,
        location: first.location,
        fieldPath,
        display: `${endpoint} :: ${first.side}.${first.location}${fieldPath}`,
        endpointClassifications: endpointClassifications.get(endpoint) || [],
        sessionPresence: new Set(entries.map((entry) => entry.sessionId)).size,
        behaviors: [...new Set(entries.map((entry) => entry.item.classification))].sort(),
        types: [...new Set(entries.map((entry) => entry.item.type))].sort(),
        examples: entries.flatMap((entry) => entry.item.examples.slice(0, 1).map((example) => ({
          sessionId: entry.sessionId,
          iterationId: example.iterationId,
          value: example.value,
        }))).slice(0, 8),
      };
    },
  ).filter((field) => field.sessionPresence >= Math.min(2, usableCount))
    .sort((a, b) => b.sessionPresence - a.sessionPresence || a.display.localeCompare(b.display));

  const relations = aggregateByKey(
    usable,
    (result) => result.relations,
    (relation) => {
      const sourceEndpoint = endpointAliases.get(relation.source.endpoint) || relation.source.endpoint;
      const targetEndpoint = endpointAliases.get(relation.target.endpoint) || relation.target.endpoint;
      return `${relation.kind}|${sourceEndpoint}|${relation.source.side}|${relation.source.location}|${relation.source.fieldPath}|${targetEndpoint}|${relation.target.side}|${relation.target.location}|${relation.target.fieldPath}`;
    },
    (_key, entries) => {
      const first = entries[0].item;
      const sourceEndpoint = endpointAliases.get(first.source.endpoint) || first.source.endpoint;
      const targetEndpoint = endpointAliases.get(first.target.endpoint) || first.target.endpoint;
      const source = `${sourceEndpoint} :: ${first.source.side}.${first.source.location}${first.source.fieldPath}`;
      const target = `${targetEndpoint} :: ${first.target.side}.${first.target.location}${first.target.fieldPath}`;
      return {
        kind: first.kind,
        source,
        sources: first.sources,
        target,
        sourceEndpoint,
        targetEndpoint,
        sourceEndpointClassifications: endpointClassifications.get(sourceEndpoint) || [],
        targetEndpointClassifications: endpointClassifications.get(targetEndpoint) || [],
        sessionPresence: new Set(entries.map((entry) => entry.sessionId)).size,
        averageConfidence: round(entries.reduce((sum, entry) => sum + entry.item.confidence, 0) / entries.length),
        supportIterations: entries.reduce((sum, entry) => sum + entry.item.supportIterations, 0),
        transforms: [...new Set(entries.map((entry) => JSON.stringify(entry.item.transform)).filter((value) => value !== undefined))].map(JSON.parse),
      };
    },
  ).filter((relation) => relation.sessionPresence >= Math.min(2, usableCount))
    .sort((a, b) => b.sessionPresence - a.sessionPresence || b.averageConfidence - a.averageConfidence);

  const schemas = aggregateByKey(
    usable,
    (result) => result.schemas,
    (schema) => `${endpointAliases.get(schema.endpoint) || schema.endpoint}|${schema.side}|${schema.location}|${schema.fieldPath}|${schema.kind}`,
    (_key, entries) => {
      const first = entries[0].item;
      const endpoint = endpointAliases.get(first.endpoint) || first.endpoint;
      const ranges = entries.map((entry) => entry.item.arrayLengthRange).filter(Boolean);
      return {
        endpoint,
        side: first.side,
        location: first.location,
        fieldPath: first.fieldPath,
        kind: first.kind,
        endpointClassifications: endpointClassifications.get(endpoint) || [],
        sessionPresence: new Set(entries.map((entry) => entry.sessionId)).size,
        types: [...new Set(entries.flatMap((entry) => entry.item.types))].sort(),
        itemTypes: [...new Set(entries.flatMap((entry) => entry.item.itemTypes))].sort(),
        keys: [...new Set(entries.flatMap((entry) => entry.item.keys))].sort(),
        arrayLengthRange: ranges.length
          ? {
            min: Math.min(...ranges.map((range) => range.min)),
            max: Math.max(...ranges.map((range) => range.max)),
            median: median(ranges.map((range) => range.median)),
          }
          : null,
      };
    },
  ).filter((schema) => schema.sessionPresence >= Math.min(2, usableCount))
    .sort((a, b) => b.sessionPresence - a.sessionPresence || a.fieldPath.localeCompare(b.fieldPath));

  const workflowPositions = new Map();
  for (const session of usable) {
    session.result.workflow.forEach((step, position) => {
      const endpoint = endpointAliases.get(step.endpoint) || step.endpoint;
      if (!workflowPositions.has(endpoint)) workflowPositions.set(endpoint, []);
      workflowPositions.get(endpoint).push({ sessionId: session.sessionId, position });
    });
  }
  const consensusWorkflow = [...workflowPositions.entries()]
    .map(([endpoint, positions]) => ({
      endpoint,
      sessionPresence: new Set(positions.map((item) => item.sessionId)).size,
      medianPosition: median(positions.map((item) => item.position)),
    }))
    .filter((step) => step.sessionPresence >= Math.max(1, Math.ceil(usableCount * 0.5)))
    .sort((a, b) => a.medianPosition - b.medianPosition || b.sessionPresence - a.sessionPresence);

  const cookies = aggregateByKey(
    usable,
    (result) => result.cookieInventory,
    (cookie) => `${cookie.name}|${cookie.domain}|${cookie.path}`,
    (_key, entries) => {
      const first = entries[0].item;
      return {
        name: first.name,
        domain: first.domain,
        path: first.path,
        secure: entries.some((entry) => entry.item.secure),
        httpOnly: entries.some((entry) => entry.item.httpOnly),
        sessionPresence: new Set(entries.map((entry) => entry.sessionId)).size,
        distinctObservedValues: Math.max(...entries.map((entry) => entry.item.distinctObservedValues)),
        consumers: [...new Set(entries.flatMap((entry) => entry.item.consumers.map((consumer) => consumer.endpoint)))].slice(0, 20),
      };
    },
  ).sort((a, b) => b.sessionPresence - a.sessionPresence || a.name.localeCompare(b.name));

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    sessionCount: sessionResults.length,
    usableSessionCount: usableCount,
    iterationCount: usable.reduce((sum, session) => sum + session.result.summary.recording.iterationCount, 0),
    capturedRequestCount: usable.reduce((sum, session) => sum + session.result.summary.recording.capturedRequestCount, 0),
    sessions: sessionResults.map((session) => ({
      id: session.sessionId,
      iterationCount: session.result.summary.recording.iterationCount,
      capturedRequestCount: session.result.summary.recording.capturedRequestCount,
      responseBodyWarningCount: session.result.summary.recording.responseBodyWarningCount,
    })),
    crossSessionEndpoints: endpoints,
    crossSessionFields: fields,
    crossSessionRelations: relations,
    crossSessionSchemas: schemas,
    crossSessionCookies: cookies,
    consensusWorkflow,
    patternTotals: {
      optionalBranches: usable.reduce((sum, session) => sum + session.result.workflowPatterns.optionalBranches.length, 0),
      retries: usable.reduce((sum, session) => sum + session.result.workflowPatterns.retries.length, 0),
      polling: usable.reduce((sum, session) => sum + session.result.workflowPatterns.polling.length, 0),
    },
  };
}

async function farmInput({ inputDirectory, outputDirectory, maxJsonBytes }) {
  const recordings = discoverRecordings(inputDirectory);
  if (!recordings.length) {
    throw new Error(`No recording directories found under: ${inputDirectory}`);
  }
  if (recordings.length === 1 && path.resolve(recordings[0]) === path.resolve(inputDirectory)) {
    const result = await farmRecording({ inputDirectory, outputDirectory, maxJsonBytes });
    return { mode: 'recording', result };
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const sessionResults = [];
  for (const recordingDirectory of recordings) {
    const sessionId = path.basename(recordingDirectory);
    const sessionOutput = path.join(outputDirectory, 'sessions', sessionId);
    const result = await farmRecording({
      inputDirectory: recordingDirectory,
      outputDirectory: sessionOutput,
      maxJsonBytes,
    });
    sessionResults.push({ sessionId, recordingDirectory, result });
  }
  const summary = aggregateSessions(sessionResults);
  writeJson(path.join(outputDirectory, 'cross-session.json'), summary);
  writeJson(path.join(outputDirectory, 'endpoints.cross-session.json'), summary.crossSessionEndpoints);
  writeJson(path.join(outputDirectory, 'fields.cross-session.json'), summary.crossSessionFields);
  writeJson(path.join(outputDirectory, 'relations.cross-session.json'), summary.crossSessionRelations);
  writeJson(path.join(outputDirectory, 'schemas.cross-session.json'), summary.crossSessionSchemas);
  writeJson(path.join(outputDirectory, 'cookies.cross-session.json'), summary.crossSessionCookies);
  fs.writeFileSync(path.join(outputDirectory, 'report.md'), collectionReport(summary));
  return { mode: 'collection', summary, sessionResults };
}

module.exports = {
  aggregateSessions,
  discoverRecordings,
  farmInput,
  isRecordingDirectory,
};
