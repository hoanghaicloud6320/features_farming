'use strict';

const fs = require('node:fs');
const { GoogleGenAI } = require('@google/genai');

const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

function loadApiKeys(file) {
  if (!fs.existsSync(file)) throw new Error(`Gemini API key file not found: ${file}`);
  const keys = fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!keys.length) throw new Error(`Gemini API key file contains no keys: ${file}`);
  if (keys.some((key) => /\s/.test(key))) throw new Error('Gemini API keys must contain no whitespace');
  return [...new Set(keys)];
}

function sanitizedError(error, keys) {
  let message = error instanceof Error ? error.message : String(error);
  for (const key of keys) message = message.replaceAll(key, '[REDACTED_API_KEY]');
  return {
    name: error?.name || 'Error',
    status: error?.status || error?.code || null,
    message: message.slice(0, 500),
  };
}

async function generateJsonWithFallback({
  apiKeys,
  prompt,
  responseJsonSchema,
  model = DEFAULT_MODEL,
  maxOutputTokens = 16_000,
  seed = 73_921,
}) {
  if (!Array.isArray(apiKeys) || !apiKeys.length) throw new Error('At least one Gemini API key is required');
  const failures = [];
  for (let index = 0; index < apiKeys.length; index += 1) {
    const apiKey = apiKeys[index];
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema,
          temperature: 0.15,
          seed,
          maxOutputTokens,
        },
      });
      if (!response.text) throw new Error('Gemini returned no text');
      return {
        data: JSON.parse(response.text),
        model,
        keyIndex: index,
        usageMetadata: response.usageMetadata || null,
        responseId: response.responseId || null,
      };
    } catch (error) {
      failures.push({ keyIndex: index, ...sanitizedError(error, apiKeys) });
    }
  }
  const summary = failures.map((failure) => (
    `key #${failure.keyIndex + 1}: ${failure.status || failure.name} ${failure.message}`
  )).join('; ');
  throw new Error(`Every Gemini API key failed. ${summary}`);
}

module.exports = {
  DEFAULT_MODEL,
  generateJsonWithFallback,
  loadApiKeys,
};
