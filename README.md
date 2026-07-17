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

Sample A/B outputs are committed under `generated/`. `gym-ab-current` is the latest
complete 4-challenge matrix with a 24,000-character evidence budget. The
`gym-ab`, `gym-ab-v2`, `gym-ab-v3`, and `gym-ab-v4-noise` directories preserve
earlier benchmark runs for comparison. API keys, captured input data, and other
generated working files remain excluded from Git.

Run only the noisy fixed-budget benchmark with three trials:

```powershell
$env:GYM_CHALLENGES = "noise"
$env:GYM_TRIALS = "3"
$env:GYM_CONTEXT_BUDGET_CHARS = "24000"
$env:GYM_AB_OUTPUT = "generated/gym-ab-v4-noise"
npm run gym:ab
```

See `GYM_V4_EVALUATION.md` for the experiment where raw failed 3/3 while both farmed features and raw + features passed 3/3.

## Farmer Gym A/B V5

V5 scores the farmer directly and does not call or score Gemini. It contains
12 cases split evenly across:

- simple transformations with heavy telemetry noise;
- hard hash-derived transformations with almost no noise;
- hard hash-derived transformations with heavy noise and plausible decoys.

The A/B arms are:

- A: farming one five-iteration session;
- B: cross-session farming over three sessions / fifteen iterations.

Every case has independent Gym ground truth for core/noise endpoint
classification, ordered workflow, and required data-flow transformations.

```powershell
npm run gym:v5
```

The canonical result is written to `generated/gym-ab-v5/`. See
`GYM_V5_EVALUATION.md` for the score definition, current result, and known
farmer gap found by the benchmark.

## Real dashboard API-contract A/B

The KeyManager dashboard experiment records repeated login and license CRUD
workflows from a real browser, farms the recordings, redacts sensitive values,
and asks Gemini for an API contract under the same four evidence conditions:
none, raw, features, and raw + features.

```powershell
$env:KEYMANAGER_ADMIN_NAME = "<admin-name>"
npm run keymanager:contract-ab
```

The experiment uses a fixed evidence budget for every non-empty arm and writes
portable contracts under `generated/keymanager-contract-ab/`. Runtime browser
recordings and full farm outputs remain ignored.

Run the non-canonical features-only unroll diagnostic after the main matrix:

```powershell
npm run keymanager:feature-unroll
```

This reuses the same feature evidence but explicitly asks Gemini to expand
generalized `:var` siblings into concrete endpoints when examples support it.
