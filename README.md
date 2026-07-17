# Features Farming

`features_farming` is the analysis half of the request-recording workflow. It does not launch a browser or mutate recordings. It reads one recording directory or a parent containing several comparable recordings and extracts:

- endpoint and payload structures;
- fields that are constant, variable, increasing or decreasing across iterations;
- repeated value copies between URL, payload and JSON response fields;
- a noise-reduced likely request sequence;
- automation-oriented input, constant and dependency hints;
- array schemas whose paths do not depend on array indices;
- URL/base64/JWT/authorization-token and numeric transformation candidates;
- machine-readable forward transforms for supported encoded authorization flows;
- cookie producers, consumers, rotation and security metadata;
- redirect and script/parser initiator dependency edges;
- optional branches, retries, polling and sequence variants;
- evidence that repeats across separate recording sessions;
- a plain-language Markdown report with concrete evidence.

## Run

```powershell
npm run farm -- `
  --input ..\requests_recorder\recordings\samples\jsonplaceholder-post\<recording-id> `
  --output .\output\jsonplaceholder-post
```

The input must contain `manifest.json`, `requests.json` and `iterations.json`.

To compare every recording session in a scenario:

```powershell
npm run farm -- `
  --input ..\requests_recorder\recordings\samples\wikipedia-search `
  --output .\output\collections\wikipedia-search
```

Collection mode writes a top-level cross-session report and keeps the complete evidence for every run under `sessions/<recording-id>/`.

## Output

```text
output/<name>/
├── report.md
├── summary.json
├── endpoints.json
├── fields.json
├── schemas.json
├── relations.json
├── workflow.json
├── workflow-patterns.json
├── dependency-graph.json
├── cookies.json
├── automation-hints.json
├── body-warnings.json
└── occurrences.jsonl
```

Collection mode additionally writes `cross-session.json` plus cross-session endpoint, field, relation, schema and cookie indexes.

This is an evidence generator, not a proof engine. A relation means that the same value repeatedly appeared in compatible timeline positions. Confidence, iteration support and concrete examples are kept so a person or a later automation generator can judge it.

Cookie, authorization, CSRF, password, secret and token values are redacted from exported evidence and replaced with short hashes so equality/rotation can still be analyzed without copying credentials into reports.

## Test

```powershell
npm test
```

## Gemini automation demo

The demo records three sessions against the anonymous, read-only Art Institute of Chicago API, farms the collection, asks `gemini-3.1-flash-lite` to create three constrained Node.js tests, validates the generated source, and then runs it.

The API key file is expected at `./gemini-api-key.txt`, with one key per line. Keys are tried in order and are never included in prompts or output. The file is excluded from Git by `.gitignore`.

```powershell
npm run demo:collect
node src/cli.js --input .\demo-data\artic-artworks --output .\output\demo\artic-artworks
npm run demo:generate
npm run demo:test
```

Generated code is rejected if it uses child processes, filesystem/network modules, environment variables, eval, dynamic imports, or a host other than `api.artic.edu`.

Run the controlled A/B comparison:

```powershell
npm run demo:ab
```

Both conditions use the same model, seed, temperature, output schema, tasks and safety rules. The only changed prompt block is `EVIDENCE: null` versus the selected farm output. Both generated bundles are safety-checked, executed live and scored with the same 12-point rubric.

## Local automation gym

The project includes a contamination-resistant localhost website with four new workflows:

- easy direct response-to-request copies;
- medium Bearer + base64url transformation;
- hard multi-hop flow with one deliberately unresolved hash bridge.
- noisy dependency selection among 36 candidates and 270 telemetry requests.

Start the website:

```powershell
npm run gym:start
```

Collect 3 sessions × 5 iterations for every challenge and farm them:

```powershell
npm run gym:collect
```

Run the real 3 × 4 Gemini execution matrix:

```powershell
npm run gym:ab
```

The four evidence conditions are no evidence, raw recorder, farmed features, and raw + features. Generated automation is executed against a fresh localhost server and scored using hidden acceptance plus route coverage. See `GYM_EVALUATION.md` for the final result and interpretation.

Run only the noisy fixed-budget benchmark with three trials:

```powershell
$env:GYM_CHALLENGES = "noise"
$env:GYM_TRIALS = "3"
$env:GYM_CONTEXT_BUDGET_CHARS = "24000"
$env:GYM_AB_OUTPUT = "generated/gym-ab-v4-noise"
npm run gym:ab
```

See `GYM_V4_EVALUATION.md` for the experiment where raw failed 3/3 while both farmed features and raw + features passed 3/3.
