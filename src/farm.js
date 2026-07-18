'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildLineageIndex } = require('./lineage');

const API_RESOURCE_TYPES = new Set(['Fetch', 'XHR', 'Document']);
const COMMON_STRING_VALUES = new Set([
  'true', 'false', 'null', 'undefined', 'get', 'post', 'http', 'https',
  'application/json', 'text/plain', 'same-origin', 'cors', 'include',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function safeExternalUrl(value) {
  const url = safeUrl(value);
  if (!url) return String(value || '');
  const queryKeys = [...new Set(url.searchParams.keys())].sort();
  return `${url.origin}${url.pathname}${queryKeys.length ? `?${queryKeys.join(',')}` : ''}`;
}

function decodeRepeated(value) {
  let result = String(value);
  for (let count = 0; count < 2; count += 1) {
    try {
      const decoded = decodeURIComponent(result.replace(/\+/g, ' '));
      if (decoded === result) break;
      result = decoded;
    } catch {
      break;
    }
  }
  return result;
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function canonicalValue(value) {
  if (typeof value === 'string') return decodeRepeated(value).normalize('NFKC').trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return null;
}

function isUsefulValue(value, fieldPath, sameRequestEcho = false) {
  if (typeof value === 'string') {
    const canonical = canonicalValue(value);
    if (!canonical || canonical.length > 2048) return false;
    if (sameRequestEcho) return canonical.length > 0;
    if (canonical.length < 3 || COMMON_STRING_VALUES.has(canonical.toLowerCase())) return false;
    return true;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (sameRequestEcho) return true;
    const leaf = fieldPath.split(/[.[\]]/).filter(Boolean).at(-1)?.toLowerCase() || '';
    return Math.abs(value) > 9 || /id|count|index|offset|limit|page|size|version|sequence/.test(leaf);
  }
  return typeof value === 'boolean' && sameRequestEcho;
}

function escapeJsonPathKey(key) {
  return /^[A-Za-z_$][\w$-]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;
}

function flattenValue(value, basePath, add, state, depth = 0) {
  if (state.count >= state.limit || depth > state.maxDepth) return;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    state.count += 1;
    add(basePath, value);
    return;
  }
  if (Array.isArray(value)) {
    const maximum = Math.min(value.length, state.maxArrayItems);
    for (let index = 0; index < maximum; index += 1) {
      flattenValue(value[index], `${basePath}[${index}]`, add, state, depth + 1);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flattenValue(child, `${basePath}${escapeJsonPathKey(key)}`, add, state, depth + 1);
      if (state.count >= state.limit) break;
    }
  }
}

function generalizedPath(fieldPath) {
  return fieldPath.replace(/\[\d+\]/g, '[]');
}

function observeSchema(value, basePath, metadata, store, depth = 0) {
  if (depth > 16) return;
  const common = { ...metadata, fieldPath: generalizedPath(basePath) };
  if (Array.isArray(value)) {
    store.push({
      ...common,
      kind: 'array',
      type: 'array',
      arrayLength: value.length,
      itemTypes: [...new Set(value.slice(0, 100).map(valueType))].sort(),
    });
    for (const item of value.slice(0, 100)) {
      observeSchema(item, `${basePath}[]`, metadata, store, depth + 1);
    }
    return;
  }
  if (value && typeof value === 'object') {
    store.push({
      ...common,
      kind: 'object',
      type: 'object',
      keys: Object.keys(value).sort(),
    });
    for (const [key, child] of Object.entries(value)) {
      observeSchema(child, `${basePath}${escapeJsonPathKey(key)}`, metadata, store, depth + 1);
    }
    return;
  }
  store.push({
    ...common,
    kind: 'scalar',
    type: valueType(value),
    example: value,
  });
}

function buildSchemas(observations, iterationOrder) {
  const groups = new Map();
  for (const observation of observations) {
    const key = [
      observation.endpointId,
      observation.side,
      observation.location,
      observation.fieldPath,
      observation.kind,
    ].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        endpointId: observation.endpointId,
        endpoint: observation.endpoint,
        side: observation.side,
        location: observation.location,
        fieldPath: observation.fieldPath,
        kind: observation.kind,
        types: new Set(),
        iterations: new Set(),
        keys: new Set(),
        itemTypes: new Set(),
        arrayLengths: [],
        examples: [],
        observationCount: 0,
      });
    }
    const group = groups.get(key);
    group.types.add(observation.type);
    group.iterations.add(observation.iterationId);
    for (const keyName of observation.keys || []) group.keys.add(keyName);
    for (const itemType of observation.itemTypes || []) group.itemTypes.add(itemType);
    if (Number.isInteger(observation.arrayLength)) group.arrayLengths.push(observation.arrayLength);
    if (observation.example !== undefined && group.examples.length < 5) group.examples.push(observation.example);
    group.observationCount += 1;
  }
  return [...groups.values()].map((group) => ({
    id: shortHash(`${group.endpointId}|${group.side}|${group.location}|${group.fieldPath}|${group.kind}`),
    endpointId: group.endpointId,
    endpoint: group.endpoint,
    side: group.side,
    location: group.location,
    fieldPath: group.fieldPath,
    kind: group.kind,
    types: [...group.types].sort(),
    iterationPresence: group.iterations.size,
    presenceRatio: round(group.iterations.size / Math.max(iterationOrder.length, 1)),
    observationCount: group.observationCount,
    keys: [...group.keys].sort(),
    itemTypes: [...group.itemTypes].sort(),
    arrayLengthRange: group.arrayLengths.length
      ? { min: Math.min(...group.arrayLengths), max: Math.max(...group.arrayLengths), median: median(group.arrayLengths) }
      : null,
    examples: group.examples,
  })).sort((a, b) => (
    a.endpoint.localeCompare(b.endpoint)
    || a.side.localeCompare(b.side)
    || a.fieldPath.localeCompare(b.fieldPath)
  ));
}

function printableBase64Decode(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 8192) return null;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    if (!decoded || decoded.includes('\uFFFD')) return null;
    const printable = [...decoded].filter((character) => /[\x20-\x7E\u00A0-\uFFFF]/u.test(character)).length / decoded.length;
    return printable >= 0.9 ? decoded : null;
  } catch {
    return null;
  }
}

function occurrenceVariants(occurrence) {
  const variants = [{ key: occurrence.canonical, transform: 'raw' }];
  const lower = occurrence.canonical.toLowerCase();
  if (lower !== occurrence.canonical) variants.push({ key: lower, transform: 'lowercase' });
  if (typeof occurrence.value === 'string') {
    const bearer = occurrence.canonical.match(/^(?:Bearer|Token)\s+(.+)$/i);
    if (bearer) {
      variants.push({ key: bearer[1], transform: 'authorization-token' });
      const decodedBearer = printableBase64Decode(bearer[1]);
      if (decodedBearer) {
        variants.push({
          key: canonicalValue(decodedBearer),
          transform: 'authorization-base64-decoded',
        });
      }
    }
    const decoded = printableBase64Decode(occurrence.canonical);
    if (decoded) variants.push({ key: canonicalValue(decoded), transform: 'base64-decoded' });
    const jwtParts = occurrence.canonical.replace(/^(?:Bearer|Token)\s+/i, '').split('.');
    if (jwtParts.length === 3) {
      const payload = printableBase64Decode(jwtParts[1]);
      if (payload) {
        try {
          const value = JSON.parse(payload);
          flattenValue(value, '$jwt', (fieldPath, child) => {
            const canonical = canonicalValue(child);
            if (canonical && canonical.length >= 3) {
              variants.push({ key: canonical, transform: `jwt-claim:${fieldPath}` });
            }
          }, { count: 0, limit: 100, maxDepth: 8, maxArrayItems: 20 });
        } catch {}
      }
    }
  }
  const deduplicated = new Map();
  for (const variant of variants) {
    if (variant.key !== null && !deduplicated.has(`${variant.key}|${variant.transform}`)) {
      deduplicated.set(`${variant.key}|${variant.transform}`, variant);
    }
  }
  return [...deduplicated.values()];
}

function parseStructuredText(text, contentType = '') {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/json/i.test(contentType) || /^[{[]/.test(trimmed)) {
    try {
      return { format: 'json', value: JSON.parse(trimmed) };
    } catch {}
  }
  if (/x-www-form-urlencoded/i.test(contentType) || (trimmed.includes('=') && !trimmed.includes('\n'))) {
    try {
      const entries = [...new URLSearchParams(trimmed).entries()];
      if (entries.length) {
        const value = {};
        for (const [key, entryValue] of entries) {
          if (Object.hasOwn(value, key)) {
            value[key] = Array.isArray(value[key]) ? [...value[key], entryValue] : [value[key], entryValue];
          } else value[key] = entryValue;
        }
        return { format: 'form', value };
      }
    } catch {}
  }
  return null;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : '';
}

function knownDynamicSegment(segment) {
  if (/^\d+$/.test(segment)) return ':number';
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ':uuid';
  if (/^[0-9a-f]{16,}$/i.test(segment)) return ':hex';
  if (segment.length >= 24 && /^[a-z0-9_=-]+$/i.test(segment)) return ':token';
  return null;
}

function prepareRoutes(records) {
  const groups = new Map();
  for (const record of records) {
    const url = safeUrl(record.request?.url);
    if (!url) continue;
    const decodedSegments = url.pathname.split('/').map(decodeRepeated);
    const first = decodedSegments[1] || '';
    const key = [
      (record.request.method || 'GET').toUpperCase(),
      url.hostname,
      record.resourceType || '',
      decodedSegments.length,
      first,
    ].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ record, url, segments: decodedSegments });
  }

  const routes = new Map();
  for (const entries of groups.values()) {
    const columns = entries[0].segments.map((_, index) => new Set(entries.map((entry) => entry.segments[index])));
    const queryKeys = [...new Set(entries.flatMap((entry) => [...entry.url.searchParams.keys()]))].sort();
    const templateSegments = entries[0].segments.map((segment, index) => {
      const known = knownDynamicSegment(segment);
      if (known) return known;
      return columns[index].size > 1 ? ':var' : segment;
    });
    const representative = entries[0];
    const route = `${representative.record.request.method.toUpperCase()} ${representative.url.hostname}${templateSegments.join('/')}?${queryKeys.join(',')}`;
    const routeInfo = {
      id: shortHash(route),
      signature: route,
      method: representative.record.request.method.toUpperCase(),
      hostname: representative.url.hostname,
      pathnameTemplate: templateSegments.join('/'),
      queryKeys,
      isGeneralizedFamily: templateSegments.includes(':var'),
    };
    for (const entry of entries) {
      const memberSegments = templateSegments.map((segment, index) => (
        segment === ':var' ? entry.segments[index] : segment
      ));
      const memberQueryKeys = [...new Set(entry.url.searchParams.keys())].sort();
      const memberPathname = memberSegments.join('/');
      const memberSignature = `${routeInfo.method} ${routeInfo.hostname}${memberPathname}?${memberQueryKeys.join(',')}`;
      routes.set(entry.record, {
        ...routeInfo,
        member: {
          id: shortHash(`${routeInfo.id}|${memberSignature}`),
          signature: memberSignature,
          method: routeInfo.method,
          hostname: routeInfo.hostname,
          pathnameTemplate: memberPathname,
          queryKeys: memberQueryKeys,
        },
      });
    }
  }
  return routes;
}

function inferRole(record, startHost) {
  const url = safeUrl(record.request?.url);
  const sameSite = Boolean(url && (url.hostname === startHost || url.hostname.endsWith(`.${startHost}`)));
  const apiLike = API_RESOURCE_TYPES.has(record.resourceType)
    || /json/i.test(record.response?.mimeType || '')
    || Boolean(record.request?.postData);
  const staticLike = ['Image', 'Font', 'Stylesheet', 'Media'].includes(record.resourceType);
  return { sameSite, apiLike, staticLike };
}

function addOccurrence(store, occurrence) {
  const canonical = canonicalValue(occurrence.value);
  if (canonical === null) return;
  store.push({
    id: `v${store.length + 1}`,
    ...occurrence,
    type: valueType(occurrence.value),
    canonical,
    preview: canonical.length > 160 ? `${canonical.slice(0, 157)}...` : canonical,
  });
}

function parseSetCookieHeader(header) {
  if (!header || typeof header !== 'string') return [];
  const results = [];
  for (const line of header.split(/\r?\n/)) {
    const first = line.split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator <= 0) continue;
    results.push({
      name: first.slice(0, separator).trim(),
      value: first.slice(separator + 1).trim(),
    });
  }
  return results;
}

function extractOccurrences(inputDirectory, records, routes, maxJsonBytes) {
  const occurrences = [];
  const bodyWarnings = [];
  const schemaObservations = [];

  for (let requestIndex = 0; requestIndex < records.length; requestIndex += 1) {
    const record = records[requestIndex];
    if (!record.iterationId || !record.request?.url) continue;
    const route = routes.get(record);
    const url = safeUrl(record.request.url);
    if (!route || !url) continue;
    const base = {
      iterationId: record.iterationId,
      requestId: record.id || record.requestId,
      requestIndex,
      timestamp: record.requestTimestamp,
      endpointId: route.id,
      endpoint: route.signature,
      memberId: route.isGeneralizedFamily ? route.member.id : null,
      memberEndpoint: route.isGeneralizedFamily ? route.member.signature : null,
    };
    const add = (side, location, fieldPath, value, timestamp = record.requestTimestamp) => {
      addOccurrence(occurrences, { ...base, side, location, fieldPath, value, timestamp });
    };

    url.pathname.split('/').forEach((segment, index) => {
      if (segment) add('request', 'url.path', `$path[${index}]`, decodeRepeated(segment));
    });
    for (const [key, value] of url.searchParams.entries()) {
      add('request', 'url.query', `$query.${key}`, value);
    }

    const requestContentType = headerValue(record.request.headers, 'content-type');
    const requestBody = parseStructuredText(record.request.postData, requestContentType);
    if (requestBody) {
      observeSchema(requestBody.value, '$', {
        iterationId: record.iterationId,
        endpointId: route.id,
        endpoint: route.signature,
        memberId: route.isGeneralizedFamily ? route.member.id : null,
        memberEndpoint: route.isGeneralizedFamily ? route.member.signature : null,
        side: 'request',
        location: `body.${requestBody.format}`,
      }, schemaObservations);
      flattenValue(
        requestBody.value,
        '$',
        (fieldPath, value) => add('request', `body.${requestBody.format}`, fieldPath, value),
        { count: 0, limit: 10000, maxDepth: 14, maxArrayItems: 100 },
      );
    }

    for (const headerName of ['authorization', 'x-csrf-token', 'x-request-id', 'referer', 'origin']) {
      const value = headerValue(record.requestExtraInfo?.headers || record.request.headers, headerName);
      if (value) add('request', 'header', `$header.${headerName}`, value);
    }
    for (const associated of record.requestExtraInfo?.associatedCookies || []) {
      const cookie = associated.cookie;
      if (!cookie?.name || (associated.blockedReasons || []).length) continue;
      add('request', 'cookie', `$cookie.${cookie.name}`, cookie.value);
    }
    const setCookieHeader = headerValue(record.responseExtraInfo?.headers || record.response?.headers, 'set-cookie');
    for (const cookie of parseSetCookieHeader(setCookieHeader)) {
      add('response', 'cookie', `$setCookie.${cookie.name}`, cookie.value, record.responseTimestamp);
    }

    if (record.body?.captureError) {
      bodyWarnings.push({ requestId: base.requestId, endpoint: route.signature, error: record.body.captureError });
    } else if (record.body?.file && /\.json$/i.test(record.body.file)) {
      const bodyFile = path.resolve(inputDirectory, record.body.file);
      const relative = path.relative(inputDirectory, bodyFile);
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(bodyFile)) {
        const size = fs.statSync(bodyFile).size;
        if (size <= maxJsonBytes) {
          try {
            const responseValue = JSON.parse(fs.readFileSync(bodyFile, 'utf8'));
            observeSchema(responseValue, '$', {
              iterationId: record.iterationId,
              endpointId: route.id,
              endpoint: route.signature,
              memberId: route.isGeneralizedFamily ? route.member.id : null,
              memberEndpoint: route.isGeneralizedFamily ? route.member.signature : null,
              side: 'response',
              location: 'body.json',
            }, schemaObservations);
            flattenValue(
              responseValue,
              '$',
              (fieldPath, value) => add('response', 'body.json', fieldPath, value, record.responseTimestamp),
              { count: 0, limit: 25000, maxDepth: 16, maxArrayItems: 100 },
            );
          } catch (error) {
            bodyWarnings.push({ requestId: base.requestId, endpoint: route.signature, error: `Invalid JSON body: ${error.message}` });
          }
        } else {
          bodyWarnings.push({ requestId: base.requestId, endpoint: route.signature, error: `JSON body skipped at ${size} bytes` });
        }
      }
    }
  }
  return { occurrences, bodyWarnings, schemaObservations };
}

function occurrenceFieldKey(occurrence) {
  return `${occurrence.endpointId}|${occurrence.side}|${occurrence.location}|${occurrence.fieldPath}`;
}

function displayField(occurrence) {
  return `${occurrence.endpoint} :: ${occurrence.side}.${occurrence.location}${occurrence.fieldPath}`;
}

function evidenceValue(occurrence) {
  const sensitiveField = `${occurrence.location}.${occurrence.fieldPath}`;
  if (/cookie|authorization|csrf|password|secret|token/i.test(sensitiveField)) {
    return {
      redacted: true,
      valueHash: shortHash(occurrence.canonical),
      length: occurrence.canonical.length,
    };
  }
  return occurrence.value;
}

function classifyFieldSeries(occurrences, iterationOrder) {
  const groups = new Map();
  for (const occurrence of occurrences) {
    const key = occurrenceFieldKey(occurrence);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(occurrence);
  }

  const fields = [];
  for (const group of groups.values()) {
    const byIteration = new Map();
    for (const occurrence of group) {
      if (!byIteration.has(occurrence.iterationId)) byIteration.set(occurrence.iterationId, occurrence);
    }
    const ordered = iterationOrder.map((id) => byIteration.get(id)).filter(Boolean);
    const values = ordered.map((item) => item.value);
    const unique = new Set(values.map((value) => JSON.stringify(value)));
    let classification = unique.size === 1 ? 'constant' : 'variable';
    let step = null;
    if (values.length >= 3 && values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      const differences = values.slice(1).map((value, index) => value - values[index]);
      if (differences.every((value) => value === differences[0])) {
        step = differences[0];
        classification = step > 0 ? 'increasing' : step < 0 ? 'decreasing' : 'constant';
      }
    }
    const first = group[0];
    fields.push({
      id: shortHash(occurrenceFieldKey(first)),
      endpointId: first.endpointId,
      endpoint: first.endpoint,
      side: first.side,
      location: first.location,
      fieldPath: first.fieldPath,
      display: displayField(first),
      type: first.type,
      classification,
      step,
      iterationPresence: byIteration.size,
      iterationPresenceRatio: round(byIteration.size / Math.max(iterationOrder.length, 1)),
      uniqueCount: unique.size,
      examples: ordered.slice(0, 8).map((item) => ({ iterationId: item.iterationId, value: evidenceValue(item) })),
    });
  }
  return fields.sort((a, b) => b.iterationPresence - a.iterationPresence || a.display.localeCompare(b.display));
}

function relationKind(source, target) {
  const exact = source.canonical === target.canonical;
  const caseOnly = source.canonical.toLowerCase() === target.canonical.toLowerCase();
  if (exact) return 'exact-copy';
  if (caseOnly) return 'case-normalized-copy';
  if (
    source.canonical.length >= 4
    && target.canonical.length >= 4
    && (source.canonical.includes(target.canonical) || target.canonical.includes(source.canonical))
  ) return 'substring';
  if (typeof source.value === 'number' && typeof target.value === 'number') return 'numeric-delta';
  return null;
}

function transformedRelationKind(source, target, sourceVariant, targetVariant) {
  if (source.canonical === target.canonical) {
    if (
      typeof source.value === 'string'
      && typeof target.value === 'string'
      && (String(source.value) !== source.canonical || String(target.value) !== target.canonical)
    ) return 'url-decoded-copy';
    return 'exact-copy';
  }
  if (source.canonical.toLowerCase() === target.canonical.toLowerCase()) return 'case-normalized-copy';
  const transforms = new Set([sourceVariant.transform, targetVariant.transform]);
  if (transforms.has('authorization-base64-decoded')) return 'authorization-base64-decoded-copy';
  if (transforms.has('authorization-token')) return 'authorization-token-copy';
  if (transforms.has('base64-decoded')) return 'base64-decoded-copy';
  if ([...transforms].some((value) => value.startsWith('jwt-claim:'))) return 'jwt-claim-copy';
  return null;
}

function relationDirectionAllowed(source, target) {
  if (source.requestIndex > target.requestIndex) return false;
  if (source.requestIndex === target.requestIndex) return source.side === 'request' && target.side === 'response';
  if (source.side === 'response') return true;
  return source.side === 'request' && target.side === 'request';
}

function forwardTransformForRelation(kind, targetOccurrence) {
  if (kind === 'authorization-base64-decoded-copy') {
    const scheme = targetOccurrence.canonical.match(/^(Bearer|Token)\s+/i)?.[1] || 'Bearer';
    return {
      direction: 'source-to-target',
      steps: [
        { operation: 'base64url-encode-utf8', padding: false },
        { operation: 'prefix', value: `${scheme} ` },
      ],
    };
  }
  if (kind === 'authorization-token-copy') {
    const scheme = targetOccurrence.canonical.match(/^(Bearer|Token)\s+/i)?.[1] || 'Bearer';
    return {
      direction: 'source-to-target',
      steps: [{ operation: 'prefix', value: `${scheme} ` }],
    };
  }
  if (kind === 'base64-decoded-copy') {
    return {
      direction: 'source-to-target',
      steps: [{ operation: 'base64url-encode-utf8', padding: false }],
    };
  }
  if (kind === 'case-normalized-copy') {
    const target = targetOccurrence.canonical;
    return {
      direction: 'source-to-target',
      steps: [{ operation: target === target.toLowerCase() ? 'lowercase' : 'uppercase' }],
    };
  }
  return undefined;
}

function findRelations(occurrences, iterationOrder) {
  const byIteration = new Map(iterationOrder.map((id) => [id, []]));
  for (const occurrence of occurrences) {
    if (byIteration.has(occurrence.iterationId)) byIteration.get(occurrence.iterationId).push(occurrence);
  }
  const evidenceGroups = new Map();

  for (const [iterationId, iterationOccurrences] of byIteration) {
    const useful = iterationOccurrences.filter((occurrence) => isUsefulValue(occurrence.value, occurrence.fieldPath));
    const valueIndex = new Map();
    for (const occurrence of useful) {
      for (const variant of occurrenceVariants(occurrence)) {
        const key = variant.key;
        if (!valueIndex.has(key)) valueIndex.set(key, []);
        const bucket = valueIndex.get(key);
        if (bucket.length < 100) bucket.push({ occurrence, variant });
      }
    }
    for (const matches of valueIndex.values()) {
      if (matches.length < 2) continue;
      matches.sort((a, b) => (
        a.occurrence.requestIndex - b.occurrence.requestIndex
        || (a.occurrence.side === 'request' ? -1 : 1)
      ));
      for (let sourceIndex = 0; sourceIndex < matches.length; sourceIndex += 1) {
        const sourceMatch = matches[sourceIndex];
        const source = sourceMatch.occurrence;
        for (let targetIndex = sourceIndex + 1; targetIndex < matches.length; targetIndex += 1) {
          const targetMatch = matches[targetIndex];
          const target = targetMatch.occurrence;
        if (!relationDirectionAllowed(source, target)) continue;
        if (source.id === target.id) continue;
        if (source.endpointId === target.endpointId && source.side === target.side && source.fieldPath === target.fieldPath) continue;
        const kind = transformedRelationKind(source, target, sourceMatch.variant, targetMatch.variant);
        if (!kind) continue;
        const sameRequest = source.requestIndex === target.requestIndex;
        if (!isUsefulValue(source.value, source.fieldPath, sameRequest)) continue;
        const key = [
          source.endpointId, source.side, source.location, source.fieldPath,
          target.endpointId, target.side, target.location, target.fieldPath, kind,
        ].join('|');
        if (!evidenceGroups.has(key)) evidenceGroups.set(key, []);
        const group = evidenceGroups.get(key);
        if (!group.some((item) => item.iterationId === iterationId)) {
          group.push({
            iterationId,
            kind,
            source: { requestId: source.requestId, field: displayField(source), value: evidenceValue(source) },
            target: { requestId: target.requestId, field: displayField(target), value: evidenceValue(target) },
            requestDistance: target.requestIndex - source.requestIndex,
          });
        }
      }
    }
    }
  }

  const relations = [];
  for (const evidence of evidenceGroups.values()) {
    const first = evidence[0];
    const sourceOccurrence = occurrences.find((item) => item.requestId === first.source.requestId && displayField(item) === first.source.field);
    const targetOccurrence = occurrences.find((item) => item.requestId === first.target.requestId && displayField(item) === first.target.field);
    if (!sourceOccurrence || !targetOccurrence) continue;
    const support = evidence.length;
    const ratio = support / Math.max(iterationOrder.length, 1);
    const distinctSourceValues = new Set(evidence.map((item) => JSON.stringify(item.source.value))).size;
    if (distinctSourceValues < 2) continue;
    const sameRequest = sourceOccurrence.requestIndex === targetOccurrence.requestIndex;
    const sourceResponse = sourceOccurrence.side === 'response';
    const rarityBonus = String(sourceOccurrence.canonical).length >= 8 ? 0.08 : 0;
    const confidence = Math.min(0.99, 0.35 + ratio * 0.4 + (sameRequest ? 0.12 : 0) + (sourceResponse ? 0.08 : 0) + rarityBonus);
    relations.push({
      id: shortHash(`${first.source.field}|${first.target.field}`),
      kind: first.kind,
      source: {
        endpointId: sourceOccurrence.endpointId,
        endpoint: sourceOccurrence.endpoint,
        side: sourceOccurrence.side,
        location: sourceOccurrence.location,
        fieldPath: sourceOccurrence.fieldPath,
        display: displayField(sourceOccurrence),
      },
      target: {
        endpointId: targetOccurrence.endpointId,
        endpoint: targetOccurrence.endpoint,
        side: targetOccurrence.side,
        location: targetOccurrence.location,
        fieldPath: targetOccurrence.fieldPath,
        display: displayField(targetOccurrence),
      },
      supportIterations: support,
      supportRatio: round(ratio),
      distinctSourceValues,
      medianRequestDistance: median(evidence.map((item) => item.requestDistance)),
      confidence: round(confidence),
      transform: forwardTransformForRelation(first.kind, targetOccurrence),
      evidence: evidence.slice(0, 5),
    });
  }
  return relations
    .filter((relation) => relation.supportIterations >= Math.min(2, iterationOrder.length))
    .sort((a, b) => b.confidence - a.confidence || b.supportIterations - a.supportIterations);
}

function permutations(values, length, prefix = []) {
  if (prefix.length === length) return [prefix];
  const output = [];
  for (const value of values) {
    if (prefix.includes(value)) continue;
    output.push(...permutations(values, length, [...prefix, value]));
  }
  return output;
}

function findHashRelations(occurrences, iterationOrder) {
  if (iterationOrder.length < 3) return [];
  const targetGroups = new Map();
  for (const occurrence of occurrences) {
    if (
      occurrence.side !== 'request'
      || !/(?:proof|signature|digest|hash)/i.test(occurrence.fieldPath)
      || typeof occurrence.value !== 'string'
      || !/^[0-9a-f]{12,64}$/i.test(occurrence.value)
    ) continue;
    const key = occurrenceFieldKey(occurrence);
    if (!targetGroups.has(key)) targetGroups.set(key, []);
    targetGroups.get(key).push(occurrence);
  }

  const relations = [];
  for (const targets of targetGroups.values()) {
    const targetByIteration = new Map(targets.map((target) => [target.iterationId, target]));
    if (targetByIteration.size < Math.min(3, iterationOrder.length)) continue;
    const candidateMaps = new Map();
    for (const iterationId of iterationOrder) {
      const target = targetByIteration.get(iterationId);
      if (!target) continue;
      const candidates = occurrences.filter((occurrence) => (
        occurrence.iterationId === iterationId
        && occurrence.requestIndex < target.requestIndex
        && /(?:seed|salt|label|nonce|challenge|input|token|key|secret|runId)/i.test(occurrence.fieldPath)
        && ['string', 'integer', 'number'].includes(occurrence.type)
      ));
      const perField = new Map();
      for (const candidate of candidates) {
        const key = occurrenceFieldKey(candidate);
        if (!perField.has(key)) perField.set(key, []);
        perField.get(key).push(candidate);
      }
      candidateMaps.set(iterationId, perField);
    }
    const commonKeys = [...(candidateMaps.values().next().value?.keys() || [])].filter((key) => (
      [...candidateMaps.values()].every((map) => map.get(key)?.length === 1)
    )).slice(0, 12);
    if (!commonKeys.length) continue;

    let match = null;
    const delimiters = ['', ':', '|', '-', '.', '/'];
    const algorithms = ['sha256', 'sha1', 'md5'];
    for (let length = 1; length <= Math.min(3, commonKeys.length) && !match; length += 1) {
      for (const orderedKeys of permutations(commonKeys, length)) {
        for (const delimiter of delimiters) {
          for (const algorithm of algorithms) {
            const valid = [...targetByIteration.entries()].every(([iterationId, target]) => {
              const map = candidateMaps.get(iterationId);
              const input = orderedKeys.map((key) => map.get(key)[0].canonical).join(delimiter);
              const digest = crypto.createHash(algorithm).update(input, 'utf8').digest('hex');
              return digest.slice(0, target.canonical.length).toLowerCase() === target.canonical.toLowerCase();
            });
            if (valid) {
              match = { orderedKeys, delimiter, algorithm };
              break;
            }
          }
          if (match) break;
        }
        if (match) break;
      }
    }
    if (!match) continue;

    const firstIteration = targetByIteration.keys().next().value;
    const firstMap = candidateMaps.get(firstIteration);
    const sourceOccurrences = match.orderedKeys.map((key) => firstMap.get(key)[0]);
    const targetOccurrence = targetByIteration.get(firstIteration);
    relations.push({
      id: shortHash(`${match.orderedKeys.join('|')}|${occurrenceFieldKey(targetOccurrence)}|${match.algorithm}|${match.delimiter}`),
      kind: 'hash-derived-copy',
      source: {
        endpointId: sourceOccurrences[0].endpointId,
        endpoint: sourceOccurrences[0].endpoint,
        side: sourceOccurrences[0].side,
        location: sourceOccurrences[0].location,
        fieldPath: sourceOccurrences[0].fieldPath,
        display: displayField(sourceOccurrences[0]),
      },
      sources: sourceOccurrences.map((source) => ({
        endpointId: source.endpointId,
        endpoint: source.endpoint,
        side: source.side,
        location: source.location,
        fieldPath: source.fieldPath,
        display: displayField(source),
      })),
      target: {
        endpointId: targetOccurrence.endpointId,
        endpoint: targetOccurrence.endpoint,
        side: targetOccurrence.side,
        location: targetOccurrence.location,
        fieldPath: targetOccurrence.fieldPath,
        display: displayField(targetOccurrence),
      },
      supportIterations: targetByIteration.size,
      supportRatio: round(targetByIteration.size / iterationOrder.length),
      distinctSourceValues: new Set([...targetByIteration.keys()].map((iterationId) => (
        match.orderedKeys.map((key) => candidateMaps.get(iterationId).get(key)[0].canonical).join('\u0000')
      ))).size,
      medianRequestDistance: median([...targetByIteration.entries()].map(([iterationId, target]) => (
        target.requestIndex - candidateMaps.get(iterationId).get(match.orderedKeys[0])[0].requestIndex
      ))),
      confidence: 0.96,
      transform: {
        direction: 'sources-to-target',
        operation: 'hash',
        algorithm: match.algorithm,
        inputOrder: sourceOccurrences.map((source) => displayField(source)),
        delimiter: match.delimiter,
        inputEncoding: 'utf8',
        digestEncoding: 'hex',
        slice: { start: 0, length: targetOccurrence.canonical.length },
      },
      evidence: [...targetByIteration.entries()].slice(0, 5).map(([iterationId, target]) => ({
        iterationId,
        sourceFields: match.orderedKeys.map((key) => displayField(candidateMaps.get(iterationId).get(key)[0])),
        target: { requestId: target.requestId, field: displayField(target), value: target.value },
      })),
    });
  }
  return relations;
}

function relationPoint(occurrence) {
  return {
    endpointId: occurrence.endpointId,
    endpoint: occurrence.endpoint,
    side: occurrence.side,
    location: occurrence.location,
    fieldPath: occurrence.fieldPath,
    display: displayField(occurrence),
  };
}

function stableTransformCandidates(occurrences, targets, iterationOrder, maximum = 18) {
  const targetByIteration = new Map(targets.map((target) => [target.iterationId, target]));
  const perField = new Map();
  for (const occurrence of occurrences) {
    const target = targetByIteration.get(occurrence.iterationId);
    if (
      !target
      || occurrence.requestIndex > target.requestIndex
      || occurrence.id === target.id
      || !['string', 'integer', 'number'].includes(occurrence.type)
      || !isUsefulValue(occurrence.value, occurrence.fieldPath, true)
    ) continue;
    const key = occurrenceFieldKey(occurrence);
    if (!perField.has(key)) perField.set(key, new Map());
    const byIteration = perField.get(key);
    if (!byIteration.has(occurrence.iterationId)) byIteration.set(occurrence.iterationId, occurrence);
  }
  const candidates = [...perField.entries()]
    .filter(([, byIteration]) => targets.every((target) => byIteration.has(target.iterationId)))
    .map(([key, byIteration]) => ({
      key,
      byIteration,
      first: byIteration.values().next().value,
      fingerprint: targets.map((target) => byIteration.get(target.iterationId).canonical).join('\u0000'),
    }))
    .filter((candidate) => new Set(
      targets.map((target) => candidate.byIteration.get(target.iterationId).canonical),
    ).size >= 2)
    .sort((a, b) => {
      const score = (candidate) => (
        (candidate.first.side === 'response' ? 40 : 0)
        + (!candidate.first.fieldPath.includes('[') ? 50 : 0)
        + (candidate.first.location.startsWith('body.') ? 10 : 0)
        - Math.max(0, targets[0].requestIndex - candidate.first.requestIndex)
      );
      return score(b) - score(a) || a.key.localeCompare(b.key);
    });
  const unique = [];
  const fingerprints = new Set();
  for (const candidate of candidates) {
    if (fingerprints.has(candidate.fingerprint)) continue;
    fingerprints.add(candidate.fingerprint);
    unique.push(candidate);
    if (unique.length >= maximum) break;
  }
  return unique;
}

function transformEvidence(targets, sources) {
  return targets.slice(0, 5).map((target) => ({
    iterationId: target.iterationId,
    sourceFields: sources.map((source) => displayField(source.byIteration.get(target.iterationId))),
    target: {
      requestId: target.requestId,
      field: displayField(target),
      value: evidenceValue(target),
    },
    requestDistance: target.requestIndex - sources[0].byIteration.get(target.iterationId).requestIndex,
  }));
}

function makeBoundedTransformRelation({
  kind,
  targets,
  sources,
  iterationOrder,
  transform,
  confidence = 0.94,
  promotion,
}) {
  const sourceOccurrences = sources.map((source) => source.first);
  const target = targets[0];
  return {
    id: shortHash([
      kind,
      ...sources.map((source) => source.key),
      occurrenceFieldKey(target),
      JSON.stringify(transform),
    ].join('|')),
    kind,
    source: relationPoint(sourceOccurrences[0]),
    sources: sourceOccurrences.map(relationPoint),
    target: relationPoint(target),
    supportIterations: targets.length,
    supportRatio: round(targets.length / Math.max(iterationOrder.length, 1)),
    distinctSourceValues: new Set(sources.map((source) => source.fingerprint)).size === 1
      ? new Set(targets.map((item) => sources[0].byIteration.get(item.iterationId).canonical)).size
      : targets.length,
    medianRequestDistance: median(targets.map((item) => (
      item.requestIndex - sources[0].byIteration.get(item.iterationId).requestIndex
    ))),
    confidence,
    transform,
    evidenceTier: promotion?.attentionEligible === false ? 'hypothesis' : 'supported',
    promotion: promotion || {
      attentionEligible: true,
      reason: 'Exact bounded transform repeated across the required observations.',
    },
    evidence: transformEvidence(targets, sources),
    note: 'Bounded deterministic candidate verified across repeated observations; not proof of source-code causality.',
  };
}

function decodeBase64urlJson(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function flatScalarValues(value, output = []) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    output.push(canonicalValue(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 12)) flatScalarValues(child, output);
    return output;
  }
  for (const child of Object.values(value).slice(0, 12)) flatScalarValues(child, output);
  return output;
}

function findBoundedTransformRelations(occurrences, iterationOrder) {
  if (iterationOrder.length < 3) return [];
  const minimumSupport = Math.min(3, iterationOrder.length);
  const targetGroups = new Map();
  for (const occurrence of occurrences) {
    if (
      occurrence.side !== 'request'
      || !['body.json', 'body.form', 'url.query', 'header'].includes(occurrence.location)
      || !['string', 'integer', 'number'].includes(occurrence.type)
      || occurrence.canonical.length > 4096
    ) continue;
    const key = occurrenceFieldKey(occurrence);
    if (!targetGroups.has(key)) targetGroups.set(key, []);
    targetGroups.get(key).push(occurrence);
  }

  const relations = [];
  for (const targets of [...targetGroups.values()].slice(0, 80)) {
    const uniqueTargets = [...new Map(targets.map((target) => [target.iterationId, target])).values()];
    if (uniqueTargets.length < minimumSupport) continue;
    if (new Set(uniqueTargets.map((target) => target.canonical)).size < 2) continue;
    const candidates = stableTransformCandidates(occurrences, uniqueTargets, iterationOrder);
    const responseCandidates = candidates.filter((candidate) => candidate.first.side === 'response');
    let matched = false;

    for (const source of responseCandidates) {
      const pairs = uniqueTargets.map((target) => ({
        source: source.byIteration.get(target.iterationId),
        target,
      }));
      if (pairs.every(({ source: item, target }) => (
        typeof item.value === 'string'
        && typeof target.value === 'string'
        && target.canonical === [...item.canonical].reverse().join('')
        && target.canonical !== item.canonical
      ))) {
        relations.push(makeBoundedTransformRelation({
          kind: 'reverse-copy',
          targets: uniqueTargets,
          sources: [source],
          iterationOrder,
          transform: { operation: 'reverse-string' },
        }));
        matched = true;
        break;
      }
      if (pairs.every(({ source: item, target }) => (
        typeof item.value === 'string'
        && typeof target.value === 'string'
        && target.canonical.includes(item.canonical)
        && target.canonical !== item.canonical
      ))) {
        const affixes = pairs.map(({ source: item, target }) => {
          const index = target.canonical.indexOf(item.canonical);
          return {
            prefix: target.canonical.slice(0, index),
            suffix: target.canonical.slice(index + item.canonical.length),
          };
        });
        if (affixes.every((item) => (
          item.prefix === affixes[0].prefix && item.suffix === affixes[0].suffix
        ))) {
          const kind = affixes[0].prefix
            ? (affixes[0].suffix ? 'substring-copy' : 'suffix-copy')
            : 'prefix-copy';
          relations.push(makeBoundedTransformRelation({
            kind,
            targets: uniqueTargets,
            sources: [source],
            iterationOrder,
            transform: { operation: 'affix', ...affixes[0] },
            confidence: 0.92,
          }));
          matched = true;
          break;
        }
      }
      if (pairs.every(({ source: item, target }) => (
        typeof item.value === 'number' && typeof target.value === 'number'
      ))) {
        const numericPairs = pairs.map(({ source: item, target }) => ({
          source: Number(item.value),
          target: Number(target.value),
        }));
        const distinctSourceCount = new Set(numericPairs.map((item) => item.source)).size;
        const distinct = numericPairs.find((item) => item.source !== numericPairs[0].source);
        if (distinct && distinctSourceCount >= 3) {
          const scale = (distinct.target - numericPairs[0].target)
            / (distinct.source - numericPairs[0].source);
          const offset = numericPairs[0].target - scale * numericPairs[0].source;
          if (
            Number.isFinite(scale)
            && Number.isFinite(offset)
            && Math.abs(scale) <= 1_000_000
            && Math.abs(offset) <= 1_000_000_000
            && numericPairs.every((item) => (
              Math.abs((item.source * scale + offset) - item.target) < 1e-9
            ))
            && (Math.abs(scale - 1) > 1e-9 || Math.abs(offset) > 1e-9)
          ) {
            const attentionEligible = (
              distinctSourceCount >= 4
              && Math.abs(scale - 1) > 1e-9
              && Math.abs(offset) > 1e-9
            );
            relations.push(makeBoundedTransformRelation({
              kind: 'affine-numeric',
              targets: uniqueTargets,
              sources: [source],
              iterationOrder,
              transform: {
                operation: 'affine',
                scale: round(scale, 9),
                offset: round(offset, 9),
              },
              confidence: attentionEligible ? 0.94 : 0.68,
              promotion: {
                attentionEligible,
                reason: attentionEligible
                  ? 'At least four distinct inputs support a non-identity scale and non-zero offset.'
                  : 'Transform fits the observations but has limited input diversity or can be explained by a simpler shared trend.',
                observedDistinctInputs: distinctSourceCount,
                requiredDistinctInputs: 4,
                risks: [
                  ...(distinctSourceCount < 4 ? ['limited-input-diversity'] : []),
                  ...(Math.abs(scale - 1) <= 1e-9 ? ['offset-only-fit'] : []),
                  ...(Math.abs(offset) <= 1e-9 ? ['scale-only-fit'] : []),
                  'observational-correlation-not-causality',
                ],
              },
            }));
            matched = true;
            break;
          }
        }
      }
    }
    if (matched) continue;

    const decoded = uniqueTargets.map((target) => decodeBase64urlJson(target.value));
    if (decoded.every(Boolean)) {
      const scalarRows = decoded.map((value) => flatScalarValues(value));
      const width = scalarRows[0].length;
      if (
        width >= 1
        && width <= 6
        && scalarRows.every((row) => row.length === width)
      ) {
        const sources = [];
        for (let column = 0; column < width; column += 1) {
          const source = candidates.find((candidate) => uniqueTargets.every((target, row) => (
            candidate.byIteration.get(target.iterationId).canonical === scalarRows[row][column]
          )));
          if (!source) break;
          sources.push(source);
        }
        if (sources.length === width && new Set(sources.map((source) => source.key)).size === width) {
          relations.push(makeBoundedTransformRelation({
            kind: 'json-base64url',
            targets: uniqueTargets,
            sources,
            iterationOrder,
            transform: {
              operation: 'json-base64url',
              scalarOrder: sources.map((source) => displayField(source.first)),
            },
          }));
          continue;
        }
      }
    }

    if (
      uniqueTargets.every((target) => (
        typeof target.value === 'string' && /^[0-9a-f]{20,64}$/i.test(target.canonical)
      ))
    ) {
      const hmacCandidates = candidates.slice(0, 16);
      let hmacMatch = null;
      for (const keySource of hmacCandidates) {
        for (const firstSource of hmacCandidates) {
          if (firstSource.key === keySource.key) continue;
          for (const secondSource of hmacCandidates) {
            if (secondSource.key === keySource.key || secondSource.key === firstSource.key) continue;
            const valid = uniqueTargets.every((target) => {
              const key = keySource.byIteration.get(target.iterationId).canonical;
              const message = [
                firstSource.byIteration.get(target.iterationId).canonical,
                secondSource.byIteration.get(target.iterationId).canonical,
              ].join('|');
              return crypto.createHmac('sha256', key)
                .update(message, 'utf8')
                .digest('hex')
                .slice(0, target.canonical.length)
                .toLowerCase() === target.canonical.toLowerCase();
            });
            if (valid) {
              hmacMatch = [keySource, firstSource, secondSource];
              break;
            }
          }
          if (hmacMatch) break;
        }
        if (hmacMatch) break;
      }
      if (hmacMatch) {
        relations.push(makeBoundedTransformRelation({
          kind: 'hmac-sha256',
          targets: uniqueTargets,
          sources: hmacMatch,
          iterationOrder,
          transform: {
            operation: 'hmac',
            algorithm: 'sha256',
            keyField: displayField(hmacMatch[0].first),
            inputOrder: hmacMatch.slice(1).map((source) => displayField(source.first)),
            delimiter: '|',
            digestEncoding: 'hex',
            slice: { start: 0, length: uniqueTargets[0].canonical.length },
          },
          confidence: 0.96,
        }));
      }
    }
  }
  return relations;
}

function findNumericRelations(fields, iterationOrder) {
  const numeric = fields.filter((field) => (
    ['integer', 'number'].includes(field.type)
    && field.iterationPresence >= Math.min(3, iterationOrder.length)
    && !field.fieldPath.includes('[')
  ));
  const relations = [];
  for (const source of numeric) {
    for (const target of numeric) {
      if (source.id === target.id) continue;
      if (source.endpointId !== target.endpointId) continue;
      if (!(source.side === 'request' && target.side === 'response')) continue;
      const sourceByIteration = new Map(source.examples.map((item) => [item.iterationId, Number(item.value)]));
      const pairs = target.examples
        .filter((item) => sourceByIteration.has(item.iterationId))
        .map((item) => ({
          iterationId: item.iterationId,
          source: sourceByIteration.get(item.iterationId),
          target: Number(item.value),
        }))
        .filter((item) => Number.isFinite(item.source) && Number.isFinite(item.target));
      if (pairs.length < Math.min(3, iterationOrder.length)) continue;
      if (new Set(pairs.map((item) => item.source)).size < 2) continue;
      const deltas = pairs.map((item) => item.target - item.source);
      const ratios = pairs.filter((item) => item.source !== 0).map((item) => item.target / item.source);
      let kind = null;
      let transform = null;
      if (deltas.every((value) => Math.abs(value - deltas[0]) < 1e-9) && deltas[0] !== 0) {
        kind = 'numeric-delta';
        transform = { operation: 'add', value: round(deltas[0], 9) };
      } else if (
        ratios.length === pairs.length
        && ratios.every((value) => Math.abs(value - ratios[0]) < 1e-9)
        && ratios[0] !== 1
      ) {
        kind = Math.abs(ratios[0] - 1000) < 1e-9 || Math.abs(ratios[0] - 0.001) < 1e-9
          ? 'timestamp-unit-conversion'
          : 'numeric-scale';
        transform = { operation: 'multiply', value: round(ratios[0], 9) };
      }
      if (!kind) continue;
      relations.push({
        id: shortHash(`${source.id}|${target.id}|${kind}`),
        kind,
        source: {
          endpointId: source.endpointId,
          endpoint: source.endpoint,
          side: source.side,
          location: source.location,
          fieldPath: source.fieldPath,
          display: source.display,
        },
        target: {
          endpointId: target.endpointId,
          endpoint: target.endpoint,
          side: target.side,
          location: target.location,
          fieldPath: target.fieldPath,
          display: target.display,
        },
        supportIterations: pairs.length,
        supportRatio: round(pairs.length / Math.max(iterationOrder.length, 1)),
        distinctSourceValues: new Set(pairs.map((item) => item.source)).size,
        medianRequestDistance: 0,
        confidence: round(Math.min(0.92, 0.45 + pairs.length / Math.max(iterationOrder.length, 1) * 0.4)),
        transform,
        evidence: pairs.slice(0, 5).map((item) => ({
          iterationId: item.iterationId,
          source: { field: source.display, value: item.source },
          target: { field: target.display, value: item.target },
          requestDistance: 0,
        })),
      });
    }
  }
  return relations;
}

function findSubstringRelations(occurrences, iterationOrder) {
  const groups = new Map();
  for (const iterationId of iterationOrder) {
    let candidates = occurrences.filter((occurrence) => {
      if (occurrence.iterationId !== iterationId || typeof occurrence.value !== 'string') return false;
      if (occurrence.canonical.length < 4 || occurrence.canonical.length > 512) return false;
      if (occurrence.location === 'url.query' || occurrence.location === 'url.path' || occurrence.location === 'cookie') return true;
      if (occurrence.location === 'header') return /token|authorization|request-id/i.test(occurrence.fieldPath);
      return occurrence.location.startsWith('body.')
        && !occurrence.fieldPath.includes('[')
        && /token|id|key|code|url|name|query|search|title/i.test(occurrence.fieldPath);
    });
    if (candidates.length > 600) {
      candidates = candidates.filter((occurrence) => occurrence.side === 'request').slice(0, 600);
    }
    candidates.sort((a, b) => a.requestIndex - b.requestIndex || (a.side === 'request' ? -1 : 1));
    for (let sourceIndex = 0; sourceIndex < candidates.length; sourceIndex += 1) {
      const source = candidates[sourceIndex];
      for (let targetIndex = sourceIndex + 1; targetIndex < candidates.length; targetIndex += 1) {
        const target = candidates[targetIndex];
        if (!relationDirectionAllowed(source, target)) continue;
        if (source.endpointId === target.endpointId && source.side === target.side && source.fieldPath === target.fieldPath) continue;
        if (source.canonical === target.canonical) continue;
        const sourceLower = source.canonical.toLowerCase();
        const targetLower = target.canonical.toLowerCase();
        const shorter = sourceLower.length <= targetLower.length ? sourceLower : targetLower;
        const longer = sourceLower.length > targetLower.length ? sourceLower : targetLower;
        if (!longer.includes(shorter) || shorter.length / longer.length < 0.3) continue;
        let kind = 'substring-copy';
        if (longer.startsWith(shorter)) kind = 'prefix-copy';
        else if (longer.endsWith(shorter)) kind = 'suffix-copy';
        const key = [
          source.endpointId, source.side, source.location, source.fieldPath,
          target.endpointId, target.side, target.location, target.fieldPath, kind,
        ].join('|');
        if (!groups.has(key)) groups.set(key, []);
        const evidence = groups.get(key);
        if (!evidence.some((item) => item.iterationId === iterationId)) {
          evidence.push({
            iterationId,
            kind,
            source: { requestId: source.requestId, field: displayField(source), value: evidenceValue(source) },
            target: { requestId: target.requestId, field: displayField(target), value: evidenceValue(target) },
            requestDistance: target.requestIndex - source.requestIndex,
            sourceOccurrence: source,
            targetOccurrence: target,
          });
        }
      }
    }
  }
  const relations = [];
  for (const evidence of groups.values()) {
    if (evidence.length < Math.min(2, iterationOrder.length)) continue;
    if (new Set(evidence.map((item) => JSON.stringify(item.source.value))).size < 2) continue;
    const first = evidence[0];
    const source = first.sourceOccurrence;
    const target = first.targetOccurrence;
    const supportRatio = evidence.length / Math.max(iterationOrder.length, 1);
    relations.push({
      id: shortHash(`${first.source.field}|${first.target.field}|${first.kind}`),
      kind: first.kind,
      source: {
        endpointId: source.endpointId,
        endpoint: source.endpoint,
        side: source.side,
        location: source.location,
        fieldPath: source.fieldPath,
        display: displayField(source),
      },
      target: {
        endpointId: target.endpointId,
        endpoint: target.endpoint,
        side: target.side,
        location: target.location,
        fieldPath: target.fieldPath,
        display: displayField(target),
      },
      supportIterations: evidence.length,
      supportRatio: round(supportRatio),
      distinctSourceValues: new Set(evidence.map((item) => JSON.stringify(item.source.value))).size,
      medianRequestDistance: median(evidence.map((item) => item.requestDistance)),
      confidence: round(Math.min(0.88, 0.3 + supportRatio * 0.4)),
      evidence: evidence.slice(0, 5).map(({ sourceOccurrence, targetOccurrence, ...item }) => item),
    });
  }
  return relations;
}

function buildEndpoints(records, routes, iterationOrder, startHost) {
  const groups = new Map();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record.iterationId || !routes.has(record)) continue;
    const route = routes.get(record);
    if (!groups.has(route.id)) {
      groups.set(route.id, {
        ...route,
        requestCount: 0,
        iterations: new Set(),
        positions: [],
        durations: [],
        statuses: new Map(),
        resourceTypes: new Set(),
        examples: [],
        roles: [],
        members: new Map(),
      });
    }
    const group = groups.get(route.id);
    group.requestCount += 1;
    group.iterations.add(record.iterationId);
    group.positions.push(index);
    if (Number.isFinite(record.durationMs)) group.durations.push(record.durationMs);
    if (record.response?.status) group.statuses.set(record.response.status, (group.statuses.get(record.response.status) || 0) + 1);
    group.resourceTypes.add(record.resourceType);
    if (group.examples.length < 3) group.examples.push(record.request.url);
    group.roles.push(inferRole(record, startHost));
    if (route.isGeneralizedFamily) {
      if (!group.members.has(route.member.id)) {
        group.members.set(route.member.id, {
          ...route.member,
          requestCount: 0,
          iterations: new Set(),
          statuses: new Map(),
          queryKeys: new Set(),
          examples: [],
        });
      }
      const member = group.members.get(route.member.id);
      member.requestCount += 1;
      member.iterations.add(record.iterationId);
      if (record.response?.status) {
        member.statuses.set(record.response.status, (member.statuses.get(record.response.status) || 0) + 1);
      }
      for (const queryKey of route.member.queryKeys) member.queryKeys.add(queryKey);
      if (member.examples.length < 5) member.examples.push(record.request.url);
    }
  }

  return [...groups.values()].map((group) => {
    const presenceRatio = group.iterations.size / Math.max(iterationOrder.length, 1);
    const sameSiteRatio = group.roles.filter((role) => role.sameSite).length / group.roles.length;
    const apiRatio = group.roles.filter((role) => role.apiLike).length / group.roles.length;
    const staticRatio = group.roles.filter((role) => role.staticLike).length / group.roles.length;
    const coreScore = presenceRatio * 0.5 + sameSiteRatio * 0.25 + apiRatio * 0.25 - staticRatio * 0.4;
    const telemetryLike = /(?:analytics|telemetry|eventlogging)/i.test(group.hostname)
      || /(?:\/events?|\/rum)(?:\/|$)/i.test(group.pathnameTemplate);
    const frameworkLike = /\/load\.php$/i.test(group.pathnameTemplate);
    let classification = 'supporting';
    if (telemetryLike) classification = 'telemetry-noise';
    else if (staticRatio > 0.7) classification = 'static-noise';
    else if (frameworkLike) classification = 'framework-support';
    else if (sameSiteRatio < 0.2 && apiRatio < 0.5) classification = 'third-party-noise';
    else if (presenceRatio >= 0.6 && coreScore >= 0.55) classification = 'core';
    return {
      id: group.id,
      signature: group.signature,
      method: group.method,
      hostname: group.hostname,
      pathnameTemplate: group.pathnameTemplate,
      queryKeys: group.queryKeys,
      requestCount: group.requestCount,
      iterationPresence: group.iterations.size,
      presenceRatio: round(presenceRatio),
      classifications: classification,
      coreScore: round(coreScore),
      resourceTypes: [...group.resourceTypes].sort(),
      statusCounts: Object.fromEntries([...group.statuses.entries()].sort()),
      medianDurationMs: round(median(group.durations), 1),
      medianTimelinePosition: median(group.positions),
      examples: group.examples,
      members: [...group.members.values()]
        .map((member) => ({
          id: member.id,
          signature: member.signature,
          method: member.method,
          hostname: member.hostname,
          pathnameTemplate: member.pathnameTemplate,
          queryKeys: [...member.queryKeys].sort(),
          requestCount: member.requestCount,
          iterationPresence: member.iterations.size,
          presenceRatio: round(member.iterations.size / Math.max(iterationOrder.length, 1)),
          statusCounts: Object.fromEntries([...member.statuses.entries()].sort()),
          examples: member.examples,
        }))
        .sort((a, b) => a.signature.localeCompare(b.signature)),
    };
  }).sort((a, b) => b.coreScore - a.coreScore || b.requestCount - a.requestCount);
}

function relationShape(relation) {
  const sourceFields = relation.sources?.length
    ? relation.sources.map((source) => `${source.side}|${source.location}|${source.fieldPath}`).sort()
    : [`${relation.source.side}|${relation.source.location}|${relation.source.fieldPath}`];
  return [
    relation.kind,
    sourceFields.join(','),
    relation.target.side,
    relation.target.location,
    relation.target.fieldPath,
  ].join('|');
}

function enrichEndpointMembers(endpoints, memberFields, memberSchemas, memberRelations, familyFields, familySchemas, familyRelations) {
  for (const endpoint of endpoints) {
    if (!endpoint.members.length) continue;
    for (const member of endpoint.members) {
      member.fields = memberFields.filter((field) => field.endpointId === member.id);
      member.requestFields = member.fields.filter((field) => field.side === 'request');
      member.schemas = memberSchemas.filter((schema) => schema.endpointId === member.id);
      member.responseSchemas = member.schemas.filter((schema) => schema.side === 'response');
      member.relationIds = memberRelations.filter((relation) => (
        relation.source.endpointId === member.id
        || relation.target.endpointId === member.id
        || relation.sources?.some((source) => source.endpointId === member.id)
      )).map((relation) => relation.id);
    }

    const memberFieldShapes = new Set(endpoint.members.flatMap((member) => member.fields.map((field) => (
      `${field.side}|${field.location}|${field.fieldPath}`
    ))));
    const memberSchemaShapes = new Set(endpoint.members.flatMap((member) => member.schemas.map((schema) => (
      `${schema.side}|${schema.location}|${schema.fieldPath}|${schema.kind}`
    ))));
    const memberRelationShapes = new Set(memberRelations.map(relationShape));
    const familyOnlyAttributes = {
      fields: familyFields
        .filter((field) => field.endpointId === endpoint.id)
        .filter((field) => !memberFieldShapes.has(`${field.side}|${field.location}|${field.fieldPath}`))
        .map((field) => `${field.side}.${field.location}${field.fieldPath}`),
      schemas: familySchemas
        .filter((schema) => schema.endpointId === endpoint.id)
        .filter((schema) => !memberSchemaShapes.has(`${schema.side}|${schema.location}|${schema.fieldPath}|${schema.kind}`))
        .map((schema) => `${schema.side}.${schema.location}${schema.fieldPath}:${schema.kind}`),
      relations: familyRelations
        .filter((relation) => relation.source.endpointId === endpoint.id || relation.target.endpointId === endpoint.id)
        .filter((relation) => !memberRelationShapes.has(relationShape(relation)))
        .map(relationShape),
    };
    endpoint.familyOnlyAttributes = familyOnlyAttributes;
    endpoint.attributionWarnings = Object.entries(familyOnlyAttributes)
      .filter(([, values]) => values.length)
      .map(([attribute, values]) => (
        `${values.length} ${attribute} item(s) have only family-level evidence and must not be copied to a concrete sibling.`
      ));
  }
}

function buildWorkflow(records, routes, endpoints, iterationOrder) {
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const steps = [];
  for (const iterationId of iterationOrder) {
    const seen = new Set();
    let sequence = 0;
    for (const record of records) {
      if (record.iterationId !== iterationId || !routes.has(record)) continue;
      const route = routes.get(record);
      const endpoint = endpointById.get(route.id);
      if (!endpoint || endpoint.classifications !== 'core' || seen.has(route.id)) continue;
      seen.add(route.id);
      steps.push({ iterationId, endpointId: route.id, sequence: sequence++ });
    }
  }
  const grouped = new Map();
  for (const step of steps) {
    if (!grouped.has(step.endpointId)) grouped.set(step.endpointId, []);
    grouped.get(step.endpointId).push(step);
  }
  return [...grouped.entries()].map(([endpointId, occurrences]) => {
    const endpoint = endpointById.get(endpointId);
    return {
      endpointId,
      endpoint: endpoint.signature,
      medianStep: median(occurrences.map((item) => item.sequence)),
      iterationPresence: new Set(occurrences.map((item) => item.iterationId)).size,
      presenceRatio: endpoint.presenceRatio,
      examples: endpoint.examples,
    };
  }).sort((a, b) => a.medianStep - b.medianStep || b.presenceRatio - a.presenceRatio);
}

function buildCookieInventory(records, snapshotCookies, routes, iterationOrder) {
  const groups = new Map();
  const ensure = (cookie) => {
    const key = `${cookie.name}|${cookie.domain || ''}|${cookie.path || '/'}`;
    if (!groups.has(key)) {
      groups.set(key, {
        name: cookie.name,
        domain: cookie.domain || '',
        path: cookie.path || '/',
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: cookie.sameSite || null,
        consumers: new Map(),
        iterations: new Set(),
        valueHashes: new Set(),
        blockedCount: 0,
      });
    }
    return groups.get(key);
  };
  for (const record of records) {
    const route = routes.get(record);
    for (const associated of record.requestExtraInfo?.associatedCookies || []) {
      const cookie = associated.cookie;
      if (!cookie?.name) continue;
      const group = ensure(cookie);
      if ((associated.blockedReasons || []).length) group.blockedCount += 1;
      else if (route) {
        group.consumers.set(route.signature, (group.consumers.get(route.signature) || 0) + 1);
        if (record.iterationId) group.iterations.add(record.iterationId);
      }
      if (cookie.value) group.valueHashes.add(shortHash(cookie.value));
    }
  }
  for (const cookie of snapshotCookies || []) {
    if (!cookie?.name) continue;
    const group = ensure(cookie);
    group.secure = Boolean(cookie.secure);
    group.httpOnly = Boolean(cookie.httpOnly);
    group.sameSite = cookie.sameSite || group.sameSite;
    if (cookie.value) group.valueHashes.add(shortHash(cookie.value));
  }
  return [...groups.values()].map((group) => ({
    name: group.name,
    domain: group.domain,
    path: group.path,
    secure: group.secure,
    httpOnly: group.httpOnly,
    sameSite: group.sameSite,
    iterationPresence: group.iterations.size,
    presenceRatio: round(group.iterations.size / Math.max(iterationOrder.length, 1)),
    distinctObservedValues: group.valueHashes.size,
    valueHashes: [...group.valueHashes].slice(0, 10),
    blockedCount: group.blockedCount,
    consumers: [...group.consumers.entries()]
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count),
  })).sort((a, b) => b.iterationPresence - a.iterationPresence || a.name.localeCompare(b.name));
}

function buildDependencyGraph(records, routes, endpoints, relations) {
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const urlRecords = new Map();
  for (const record of records) {
    if (!record.request?.url || !routes.has(record)) continue;
    if (!urlRecords.has(record.request.url)) urlRecords.set(record.request.url, []);
    urlRecords.get(record.request.url).push(record);
  }
  const rawEdges = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const targetRoute = routes.get(record);
    if (!targetRoute) continue;
    const location = record.redirectResponse?.headers?.location;
    if (location) {
      const targetRecord = (urlRecords.get(location) || []).find((candidate) => (
        candidate.iterationId === record.iterationId && candidate.requestTimestamp >= record.requestTimestamp
      ));
      const redirectedRoute = targetRecord ? routes.get(targetRecord) : null;
      rawEdges.push({
        type: 'redirect',
        source: targetRoute.signature,
        target: redirectedRoute?.signature || safeExternalUrl(location),
        iterationId: record.iterationId || null,
        evidence: {
          status: record.redirectResponse.status,
          fromUrl: safeExternalUrl(record.redirectResponse.url),
          location: safeExternalUrl(location),
        },
      });
    }

    const initiator = record.initiator || {};
    const initiatorUrl = initiator.url || initiator.stack?.callFrames?.find((frame) => frame.url)?.url;
    if (initiatorUrl) {
      const sourceRecord = [...(urlRecords.get(initiatorUrl) || [])]
        .filter((candidate) => candidate.requestTimestamp <= record.requestTimestamp)
        .sort((a, b) => b.requestTimestamp - a.requestTimestamp)[0];
      const sourceRoute = sourceRecord ? routes.get(sourceRecord) : null;
      rawEdges.push({
        type: sourceRoute ? 'initiator-request' : 'initiator-script',
        source: sourceRoute?.signature || safeExternalUrl(initiatorUrl),
        target: targetRoute.signature,
        iterationId: record.iterationId || null,
        evidence: {
          initiatorType: initiator.type,
          functionName: initiator.stack?.callFrames?.[0]?.functionName || null,
          lineNumber: initiator.lineNumber ?? initiator.stack?.callFrames?.[0]?.lineNumber ?? null,
        },
      });
    }
  }
  for (const relation of relations) {
    rawEdges.push({
      type: `value:${relation.kind}`,
      source: relation.source.endpoint,
      target: relation.target.endpoint,
      iterationId: null,
      evidence: {
        sourceField: relation.source.fieldPath,
        targetField: relation.target.fieldPath,
        supportIterations: relation.supportIterations,
        confidence: relation.confidence,
      },
    });
  }

  const grouped = new Map();
  for (const edge of rawEdges) {
    const key = `${edge.type}|${edge.source}|${edge.target}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: shortHash(key),
        type: edge.type,
        source: edge.source,
        target: edge.target,
        count: 0,
        iterations: new Set(),
        evidence: [],
      });
    }
    const group = grouped.get(key);
    group.count += 1;
    if (edge.iterationId) group.iterations.add(edge.iterationId);
    if (group.evidence.length < 5) group.evidence.push(edge.evidence);
  }
  const edges = [...grouped.values()].map((group) => ({
    id: group.id,
    type: group.type,
    source: group.source,
    target: group.target,
    count: group.count,
    iterationPresence: group.iterations.size || null,
    evidence: group.evidence,
  })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const externalNodes = new Set();
  for (const edge of edges) {
    if (![...endpointById.values()].some((endpoint) => endpoint.signature === edge.source)) externalNodes.add(edge.source);
    if (![...endpointById.values()].some((endpoint) => endpoint.signature === edge.target)) externalNodes.add(edge.target);
  }
  return {
    nodes: [
      ...endpoints.map((endpoint) => ({
        id: endpoint.id,
        label: endpoint.signature,
        type: 'endpoint',
        classification: endpoint.classifications,
      })),
      ...[...externalNodes].map((label) => ({
        id: shortHash(label),
        label,
        type: 'external',
      })),
    ],
    edges,
  };
}

function coefficientOfVariation(values) {
  if (!values.length) return Infinity;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (!mean) return Infinity;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

function detectWorkflowPatterns(records, routes, endpoints, iterationOrder) {
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const perIteration = [];
  for (const iterationId of iterationOrder) {
    const entries = records
      .filter((record) => record.iterationId === iterationId && routes.has(record))
      .sort((a, b) => a.requestTimestamp - b.requestTimestamp)
      .map((record) => ({ record, route: routes.get(record) }));
    perIteration.push({ iterationId, entries });
  }
  const optionalBranches = endpoints
    .filter((endpoint) => endpoint.presenceRatio >= 0.2 && endpoint.presenceRatio < 1 && endpoint.classifications === 'core')
    .map((endpoint) => ({
      endpoint: endpoint.signature,
      iterationPresence: endpoint.iterationPresence,
      presenceRatio: endpoint.presenceRatio,
    }));
  const retries = [];
  const polling = [];
  for (const iteration of perIteration) {
    const byEndpoint = new Map();
    for (const entry of iteration.entries) {
      if (!byEndpoint.has(entry.route.id)) byEndpoint.set(entry.route.id, []);
      byEndpoint.get(entry.route.id).push(entry);
    }
    for (const [endpointId, entries] of byEndpoint) {
      if (entries.length < 2) continue;
      const endpoint = endpointById.get(endpointId);
      if (!endpoint || endpoint.classifications !== 'core') continue;
      const gaps = entries.slice(1).map((entry, index) => entry.record.requestTimestamp - entries[index].record.requestTimestamp);
      const statuses = entries.map((entry) => entry.record.response?.status).filter(Boolean);
      const exactUrls = new Set(entries.map((entry) => entry.record.request.url));
      if (entries.length >= 3 && median(gaps) >= 0.2 && coefficientOfVariation(gaps) <= 0.5) {
        polling.push({
          iterationId: iteration.iterationId,
          endpoint: endpoint.signature,
          count: entries.length,
          medianIntervalMs: round(median(gaps) * 1000, 1),
          intervalVariation: round(coefficientOfVariation(gaps)),
        });
      } else if (exactUrls.size < entries.length || statuses.some((status) => status >= 400)) {
        retries.push({
          iterationId: iteration.iterationId,
          endpoint: endpoint.signature,
          count: entries.length,
          statuses,
          medianGapMs: round(median(gaps) * 1000, 1),
        });
      }
    }
  }
  const variants = new Map();
  for (const iteration of perIteration) {
    const sequence = iteration.entries
      .filter((entry) => endpointById.get(entry.route.id)?.classifications === 'core')
      .map((entry) => entry.route.signature)
      .filter((value, index, all) => index === 0 || all[index - 1] !== value);
    const key = sequence.join(' -> ');
    if (!variants.has(key)) variants.set(key, []);
    variants.get(key).push(iteration.iterationId);
  }
  return {
    optionalBranches,
    retries,
    polling,
    sequenceVariants: [...variants.entries()]
      .map(([sequence, iterations]) => ({ sequence, iterations, count: iterations.length }))
      .sort((a, b) => b.count - a.count),
  };
}

function buildAutomationHints(endpoints, fields, relations, workflow) {
  const endpointById = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint]));
  const isCoreRequestField = (field) => (
    field.side === 'request'
    && endpointById.get(field.endpointId)?.classifications === 'core'
    && ['url.query', 'url.path', 'body.json', 'body.form'].includes(field.location)
  );
  const variableFields = fields.filter((field) => (
    isCoreRequestField(field)
    && field.iterationPresence >= 2
    && ['variable', 'increasing', 'decreasing'].includes(field.classification)
  ));
  const echoedTargets = new Set(
    relations
      .filter((relation) => relation.source.side === 'request' && relation.target.side === 'response')
      .map((relation) => relation.target.display),
  );
  return {
    likelyInputs: variableFields.slice(0, 50).map((field) => ({
      field: field.display,
      behavior: field.classification,
      step: field.step,
      examples: field.examples,
    })),
    likelyConstants: fields
      .filter((field) => isCoreRequestField(field) && field.classification === 'constant' && field.iterationPresenceRatio >= 0.6)
      .slice(0, 50)
      .map((field) => ({ field: field.display, value: field.examples[0]?.value })),
    responseToRequestDependencies: relations
      .filter((relation) => relation.source.side === 'response' && relation.target.side === 'request')
      .slice(0, 50),
    echoedRequestFields: relations
      .filter((relation) => relation.source.side === 'request' && relation.target.side === 'response')
      .slice(0, 50),
    observedResponseOutputs: fields
      .filter((field) => (
        field.side === 'response'
        && endpointById.get(field.endpointId)?.classifications === 'core'
        && field.location === 'body.json'
        && !field.fieldPath.includes('[')
        && field.iterationPresenceRatio >= 0.6
        && !echoedTargets.has(field.display)
      ))
      .sort((a, b) => {
        const depthA = (a.fieldPath.match(/\./g) || []).length;
        const depthB = (b.fieldPath.match(/\./g) || []).length;
        return depthA - depthB || b.iterationPresence - a.iterationPresence;
      })
      .slice(0, 30)
      .map((field) => ({
        field: field.display,
        behavior: field.classification,
        step: field.step,
        examples: field.examples,
      })),
    suggestedSequence: workflow.map((step, index) => ({
      step: index + 1,
      endpoint: step.endpoint,
      optional: step.presenceRatio < 0.8,
    })),
    endpointCount: endpoints.length,
  };
}

function reportMarkdown(summary, automationHints, bodyWarnings) {
  const lines = [];
  lines.push('# Features farm report', '');
  lines.push('## What this recording appears to do', '');
  lines.push(`- ${summary.recording.iterationCount} iterations contain ${summary.recording.capturedRequestCount} captured requests.`);
  lines.push(`- ${summary.endpoints.coreCount} endpoints look central to the repeated workflow; ${summary.endpoints.supportCount} are framework/supporting traffic; ${summary.endpoints.noiseCount} look like static, telemetry or third-party noise.`);
  lines.push(`- ${summary.variables.length} request fields vary between iterations.`);
  lines.push(`- ${summary.relations.length} repeated value-flow relations have supporting evidence.`);
  lines.push(`- ${summary.diagnosticRelationCandidateCount || 0} additional relation hypotheses were retained in \`relations.candidates.json\` but excluded from the actionable projection.`);
  lines.push('');

  lines.push('## Likely workflow', '');
  if (!summary.workflow.length) lines.push('No stable core workflow was identified.');
  for (let index = 0; index < summary.workflow.length; index += 1) {
    const step = summary.workflow[index];
    lines.push(`${index + 1}. \`${step.endpoint}\` -- seen in ${step.iterationPresence}/${summary.recording.iterationCount} iterations${step.presenceRatio < 0.8 ? ' (possibly optional)' : ''}.`);
  }
  lines.push('');

  lines.push('## Core endpoint observations', '');
  lines.push('| Endpoint | Requests | Statuses | Median duration |');
  lines.push('|---|---:|---|---:|');
  for (const endpoint of summary.coreEndpoints) {
    const statuses = Object.entries(endpoint.statusCounts).map(([status, count]) => `${status} x${count}`).join(', ') || 'not observed';
    const duration = endpoint.medianDurationMs === null ? 'unknown' : `${endpoint.medianDurationMs} ms`;
    lines.push(`| \`${endpoint.signature}\` | ${endpoint.requestCount} | ${statuses} | ${duration} |`);
  }
  lines.push('');

  lines.push('## Likely inputs and changing fields', '');
  if (!automationHints.likelyInputs.length) lines.push('No request field changed consistently across multiple iterations.');
  for (const input of automationHints.likelyInputs.slice(0, 20)) {
    const examples = input.examples.map((item) => `${item.iterationId}=${JSON.stringify(item.value)}`).join(', ');
    const behavior = input.step === null ? input.behavior : `${input.behavior} by ${input.step}`;
    lines.push(`- \`${input.field}\` -- ${behavior}; ${examples}`);
  }
  lines.push('');

  lines.push('## Observed response outputs', '');
  if (!automationHints.observedResponseOutputs.length) {
    lines.push('No repeated non-echo JSON response field was available for the core endpoints.');
  }
  for (const output of automationHints.observedResponseOutputs.slice(0, 20)) {
    const examples = output.examples.map((item) => `${item.iterationId}=${JSON.stringify(item.value)}`).join(', ');
    const behavior = ['increasing', 'decreasing'].includes(output.behavior)
      ? `${output.behavior} by ${output.step}`
      : output.behavior;
    lines.push(`- \`${output.field}\` -- ${behavior}; ${examples}`);
  }
  lines.push('');

  lines.push('## Array structures', '');
  if (!summary.arraySchemas.length) lines.push('No repeated structured arrays were observed.');
  for (const schema of summary.arraySchemas.slice(0, 20)) {
    const range = schema.arrayLengthRange
      ? `${schema.arrayLengthRange.min}..${schema.arrayLengthRange.max} items`
      : 'length unknown';
    lines.push(`- \`${schema.endpoint} :: ${schema.side}${schema.fieldPath}\` -- ${range}; item types: ${schema.itemTypes.join(', ') || 'unknown'}.`);
  }
  lines.push('');

  lines.push('## Cookies and tokens', '');
  if (!summary.cookies.length) lines.push('No cookie was observed on captured requests.');
  for (const cookie of summary.cookies.slice(0, 20)) {
    lines.push(`- \`${cookie.name}\` on \`${cookie.domain || '(host only)'}\` -- sent in ${cookie.iterationPresence}/${summary.recording.iterationCount} iterations, ${cookie.distinctObservedValues} observed value(s), ${cookie.httpOnly ? 'HttpOnly' : 'script-readable'}, ${cookie.secure ? 'Secure' : 'not Secure'}.`);
  }
  lines.push('');

  lines.push('## Workflow behavior', '');
  lines.push(`- Optional core branches: ${summary.workflowPatterns.optionalBranches.length}.`);
  lines.push(`- Retry candidates: ${summary.workflowPatterns.retries.length}.`);
  lines.push(`- Polling candidates: ${summary.workflowPatterns.polling.length}.`);
  lines.push(`- Distinct core sequence variants: ${summary.workflowPatterns.sequenceVariants.length}.`);
  for (const retry of summary.workflowPatterns.retries.slice(0, 5)) {
    lines.push(`- Retry candidate: \`${retry.endpoint}\` repeated ${retry.count} times in ${retry.iterationId}.`);
  }
  for (const poll of summary.workflowPatterns.polling.slice(0, 5)) {
    lines.push(`- Polling candidate: \`${poll.endpoint}\` repeated ${poll.count} times every ~${poll.medianIntervalMs} ms in ${poll.iterationId}.`);
  }
  lines.push('');

  lines.push('## Redirect and initiator evidence', '');
  lines.push(`- Redirect edges: ${summary.graph.redirectEdgeCount}.`);
  lines.push(`- Request/script initiator edges: ${summary.graph.initiatorEdgeCount}.`);
  for (const edge of summary.graph.notableEdges.slice(0, 10)) {
    lines.push(`- **${edge.type}**: \`${edge.source}\` -> \`${edge.target}\` (${edge.count} observation(s)).`);
  }
  lines.push('');

  lines.push('## Repeated data flows', '');
  if (!summary.relations.length) lines.push('No relation met the minimum repeated-evidence threshold.');
  for (const relation of summary.relations.slice(0, 30)) {
    lines.push(`- **${relation.kind}** (${Math.round(relation.confidence * 100)}% confidence, ${relation.supportIterations}/${summary.recording.iterationCount} iterations)`);
    lines.push(`  - From: \`${relation.sources?.map((source) => source.display).join(' + ') || relation.source.display}\``);
    lines.push(`  - To: \`${relation.target.display}\``);
    if (relation.transform) lines.push(`  - Transform: \`${JSON.stringify(relation.transform)}\``);
    const evidence = relation.evidence[0];
    if (evidence?.source && evidence?.target) {
      lines.push(`  - Example: ${JSON.stringify(evidence.source.value)} -> ${JSON.stringify(evidence.target.value)}`);
    } else if (evidence?.sourceFields && evidence?.target) {
      lines.push(`  - Example fields: ${evidence.sourceFields.map((field) => `\`${field}\``).join(' + ')} -> \`${evidence.target.field}\``);
    }
  }
  lines.push('');

  lines.push('## Stable request values', '');
  for (const constant of automationHints.likelyConstants.slice(0, 20)) {
    lines.push(`- \`${constant.field}\` = ${JSON.stringify(constant.value)}`);
  }
  if (!automationHints.likelyConstants.length) lines.push('No sufficiently repeated constants were found.');
  lines.push('');

  lines.push('## Caveats', '');
  lines.push('- Relations are evidence-based candidates, not proof of program-level causality.');
  lines.push('- Small common values and static assets are deliberately down-ranked to reduce false matches.');
  lines.push(`- ${bodyWarnings.length} response bodies were unavailable, invalid, or skipped; absence of evidence in those bodies is not treated as evidence of absence.`);
  lines.push('- Cross-recording/session comparison is not yet included in this MVP.');
  lines.push('');
  lines.push('## Files for deeper inspection', '');
  lines.push('- `summary.json`: compact overview used by this report.');
  lines.push('- `endpoints.json`: endpoint templates, frequency, timing and noise/core classification.');
  lines.push('- `fields.json`: every structured field and its behavior across iterations.');
  lines.push('- `relations.json`: candidate value-flow edges with concrete evidence.');
  lines.push('- `workflow.json`: aligned core endpoint sequence.');
  lines.push('- `automation-hints.json`: likely inputs, constants, dependencies and suggested request order.');
  lines.push('- `occurrences.jsonl`: raw searchable value index.');
  return `${lines.join('\n')}\n`;
}

function writeOccurrences(file, occurrences) {
  const stream = fs.openSync(file, 'w');
  try {
    for (const occurrence of occurrences) {
      const sensitive = evidenceValue(occurrence);
      const output = typeof sensitive === 'object' && sensitive?.redacted
        ? {
          ...occurrence,
          value: undefined,
          canonical: undefined,
          preview: '[REDACTED]',
          sensitive,
        }
        : occurrence;
      fs.writeSync(stream, `${JSON.stringify(output)}\n`);
    }
  } finally {
    fs.closeSync(stream);
  }
}

function projectMemberEvidence(items) {
  return items.map((item) => ({
    ...item,
    endpointId: item.memberId || item.endpointId,
    endpoint: item.memberEndpoint || item.endpoint,
  }));
}

function findAllRelations(occurrences, fields, iterationOrder) {
  return [
    ...findRelations(occurrences, iterationOrder),
    ...findHashRelations(occurrences, iterationOrder),
    ...findBoundedTransformRelations(occurrences, iterationOrder),
    ...findSubstringRelations(occurrences, iterationOrder),
    ...findNumericRelations(fields, iterationOrder),
  ].sort((a, b) => b.confidence - a.confidence || b.supportIterations - a.supportIterations);
}

function isAttentionEligibleRelation(relation) {
  return relation.promotion?.attentionEligible !== false;
}

async function farmRecording({
  inputDirectory,
  outputDirectory,
  maxJsonBytes = 5 * 1024 * 1024,
}) {
  const manifestFile = path.join(inputDirectory, 'manifest.json');
  const requestsFile = path.join(inputDirectory, 'requests.json');
  const iterationsFile = path.join(inputDirectory, 'iterations.json');
  for (const file of [manifestFile, requestsFile, iterationsFile]) {
    if (!fs.existsSync(file)) throw new Error(`Missing required recording file: ${file}`);
  }

  const manifest = readJson(manifestFile);
  const records = readJson(requestsFile);
  const iterations = readJson(iterationsFile).filter((iteration) => iteration.requestCount > 0);
  const iterationOrder = iterations.map((iteration) => iteration.id);
  const startHost = safeUrl(manifest.startUrl)?.hostname || '';
  const routes = prepareRoutes(records.filter((record) => record.iterationId));
  const { occurrences, bodyWarnings, schemaObservations } = extractOccurrences(inputDirectory, records, routes, maxJsonBytes);
  const endpoints = buildEndpoints(records, routes, iterationOrder, startHost);
  const fields = classifyFieldSeries(occurrences, iterationOrder);
  const schemas = buildSchemas(schemaObservations, iterationOrder);
  const relationCandidates = findAllRelations(occurrences, fields, iterationOrder);
  const relations = relationCandidates.filter(isAttentionEligibleRelation);
  const memberOccurrences = projectMemberEvidence(occurrences);
  const memberSchemaObservations = projectMemberEvidence(schemaObservations);
  const memberFields = classifyFieldSeries(memberOccurrences, iterationOrder);
  const memberSchemas = buildSchemas(memberSchemaObservations, iterationOrder);
  const memberRelationCandidates = findAllRelations(memberOccurrences, memberFields, iterationOrder);
  const memberRelations = memberRelationCandidates.filter(isAttentionEligibleRelation);
  const lineage = buildLineageIndex(memberRelations, {
    benchmark: 'recording-member-lineage',
    scope: 'actionable',
  });
  const lineageCandidates = buildLineageIndex(memberRelationCandidates, {
    benchmark: 'recording-member-lineage',
    scope: 'candidate-inventory',
  });
  enrichEndpointMembers(endpoints, memberFields, memberSchemas, memberRelations, fields, schemas, relations);
  const workflow = buildWorkflow(records, routes, endpoints, iterationOrder);
  const coreEndpointIds = new Set(endpoints.filter((endpoint) => endpoint.classifications === 'core').map((endpoint) => endpoint.id));
  const notableRelations = relations.filter((relation) => (
    coreEndpointIds.has(relation.source.endpointId)
    && coreEndpointIds.has(relation.target.endpointId)
  ));
  const cookiesFile = path.join(inputDirectory, 'cookies.json');
  const snapshotCookies = fs.existsSync(cookiesFile) ? readJson(cookiesFile) : [];
  const cookieInventory = buildCookieInventory(records, snapshotCookies, routes, iterationOrder);
  const dependencyGraph = buildDependencyGraph(records, routes, endpoints, notableRelations);
  const workflowPatterns = detectWorkflowPatterns(records, routes, endpoints, iterationOrder);
  const variables = fields.filter((field) => (
    field.side === 'request'
    && coreEndpointIds.has(field.endpointId)
    && ['url.query', 'url.path', 'body.json', 'body.form'].includes(field.location)
    && field.iterationPresence >= 2
    && ['variable', 'increasing', 'decreasing'].includes(field.classification)
  ));
  const automationHints = buildAutomationHints(endpoints, fields, notableRelations, workflow);
  const summary = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    recording: {
      id: manifest.id,
      startUrl: manifest.startUrl,
      inputDirectory,
      requestCount: records.length,
      capturedRequestCount: records.filter((record) => record.iterationId).length,
      iterationCount: iterationOrder.length,
      responseBodyWarningCount: bodyWarnings.length,
    },
    endpoints: {
      total: endpoints.length,
      coreCount: endpoints.filter((endpoint) => endpoint.classifications === 'core').length,
      noiseCount: endpoints.filter((endpoint) => endpoint.classifications.endsWith('noise')).length,
      supportCount: endpoints.filter((endpoint) => ['supporting', 'framework-support'].includes(endpoint.classifications)).length,
    },
    valueOccurrenceCount: occurrences.length,
    relationCandidateCount: relationCandidates.length,
    diagnosticRelationCandidateCount: relationCandidates.length - relations.length,
    lineage: lineage.stats,
    candidateLineage: lineageCandidates.stats,
    variables: variables.slice(0, 100),
    relations: notableRelations.slice(0, 100),
    workflow,
    arraySchemas: schemas.filter((schema) => schema.kind === 'array' && schema.presenceRatio >= 0.4).slice(0, 100),
    cookies: cookieInventory.slice(0, 100),
    workflowPatterns,
    graph: {
      nodeCount: dependencyGraph.nodes.length,
      edgeCount: dependencyGraph.edges.length,
      redirectEdgeCount: dependencyGraph.edges.filter((edge) => edge.type === 'redirect').length,
      initiatorEdgeCount: dependencyGraph.edges.filter((edge) => edge.type.startsWith('initiator-')).length,
      notableEdges: dependencyGraph.edges
        .filter((edge) => edge.type === 'redirect' || edge.type === 'initiator-request')
        .slice(0, 20),
    },
    coreEndpoints: endpoints
      .filter((endpoint) => endpoint.classifications === 'core')
      .map((endpoint) => ({
        id: endpoint.id,
        signature: endpoint.signature,
        requestCount: endpoint.requestCount,
        statusCounts: endpoint.statusCounts,
        medianDurationMs: endpoint.medianDurationMs,
        members: endpoint.members,
        familyOnlyAttributes: endpoint.familyOnlyAttributes,
        attributionWarnings: endpoint.attributionWarnings,
      })),
  };

  fs.mkdirSync(outputDirectory, { recursive: true });
  writeJson(path.join(outputDirectory, 'summary.json'), summary);
  writeJson(path.join(outputDirectory, 'endpoints.json'), endpoints);
  writeJson(path.join(outputDirectory, 'fields.json'), fields);
  writeJson(path.join(outputDirectory, 'schemas.json'), schemas);
  writeJson(path.join(outputDirectory, 'members.json'), endpoints.flatMap((endpoint) => endpoint.members.map((member) => ({
    familyEndpointId: endpoint.id,
    familyEndpoint: endpoint.signature,
    ...member,
  }))));
  writeJson(path.join(outputDirectory, 'fields.members.json'), memberFields);
  writeJson(path.join(outputDirectory, 'schemas.members.json'), memberSchemas);
  writeJson(path.join(outputDirectory, 'relations.members.json'), memberRelations);
  writeJson(path.join(outputDirectory, 'relations.json'), relations);
  writeJson(path.join(outputDirectory, 'relations.candidates.json'), relationCandidates);
  writeJson(path.join(outputDirectory, 'relations.members.candidates.json'), {
    schemaVersion: 1,
    representation: 'lineage-index',
    artifact: 'lineage.candidates.json',
    relationCount: memberRelationCandidates.length,
    note: 'Member candidate points and direct edges are stored once in the lineage index.',
  });
  writeJson(path.join(outputDirectory, 'lineage.json'), lineage);
  writeJson(path.join(outputDirectory, 'lineage.candidates.json'), lineageCandidates);
  writeJson(path.join(outputDirectory, 'workflow.json'), workflow);
  writeJson(path.join(outputDirectory, 'workflow-patterns.json'), workflowPatterns);
  writeJson(path.join(outputDirectory, 'dependency-graph.json'), dependencyGraph);
  writeJson(path.join(outputDirectory, 'cookies.json'), cookieInventory);
  writeJson(path.join(outputDirectory, 'automation-hints.json'), automationHints);
  writeJson(path.join(outputDirectory, 'body-warnings.json'), bodyWarnings);
  writeOccurrences(path.join(outputDirectory, 'occurrences.jsonl'), occurrences);
  fs.writeFileSync(path.join(outputDirectory, 'report.md'), reportMarkdown(summary, automationHints, bodyWarnings));
  return {
    summary,
    endpoints,
    fields,
    schemas,
    memberFields,
    memberSchemas,
    memberRelations,
    memberRelationCandidates,
    relations,
    relationCandidates,
    lineage,
    lineageCandidates,
    workflow,
    workflowPatterns,
    dependencyGraph,
    cookieInventory,
    automationHints,
    bodyWarnings,
  };
}

module.exports = {
  canonicalValue,
  classifyFieldSeries,
  farmRecording,
  findBoundedTransformRelations,
  findHashRelations,
  parseStructuredText,
  prepareRoutes,
};
