# Gemini automation demo evaluation

## Experiment

- Target: Art Institute of Chicago public API.
- Authentication: none.
- Recording: 3 independent sessions, 5 iterations per session.
- Captured workflow per iteration:
  1. `POST /api/v1/artworks/search`
  2. read `response.data[0].id`
  3. `GET /api/v1/artworks/{id}`
- Gemini SDK: `@google/genai` 2.12.0.
- Model: `gemini-3.1-flash-lite`.

The Gemini prompt contained only selected farmed features. It did not contain the API documentation or raw recording bodies.

## Farm quality

The farm reduced 30 captured requests to two stable core endpoints and identified:

- changing search query `q`;
- increasing `from`;
- constant `size`, selected fields and public-domain filter;
- `data` as an array of exactly three objects in the observed runs;
- response schemas for search and detail;
- the exact `search.response.data[0].id -> detail.request.path` dependency in all three sessions;
- no cookie, retry, polling or body-capture failure.

## Gemini result

Gemini produced:

1. a search response structure test;
2. a direct artwork detail test;
3. a search-then-detail workflow that copies the first response ID into the second request.

All three generated files passed the static safety policy and executed successfully against the live API.

## Assessment

The result demonstrates that the farm is rich enough to generate a small but correct two-request automation without API documentation. The strongest evidence is that Gemini reproduced the response-to-request dependency rather than merely guessing two independent endpoints.

The generated assertions are intentionally light. The model did not fully reuse every recorded constant, the public-domain filter, pagination behavior, or the complete response schema. Error schemas, rate-limit behavior and malformed-input examples were absent from the recording, so Gemini correctly identified them as missing evidence.

Overall demo score: **8/10** for pathway discovery and starter automation, **5/10** for production-ready validation depth.
