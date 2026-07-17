# Gym V4: Marginal Value of Farmed Features

## Result

V4 was designed specifically to test whether adding farmed features helps beyond a raw HTTP timeline under a fixed context budget.

Model: `gemini-3.1-flash-lite`

Design:

- one newly-created localhost challenge;
- four evidence conditions;
- three fixed-seed trials per condition;
- 24,000 JSON characters maximum evidence per cell;
- live execution against a fresh hidden evaluator.

| Evidence | Accepted | Mean score | Mean requests | Mean prompt tokens |
|---|---:|---:|---:|---:|
| No evidence | 0/3 | 0/10 | 0.00 | 356 |
| Raw recorder | 0/3 | 3/10 | 2.67 | 14,143 |
| Farmed features | 3/3 | 10/10 | 2.00 | 14,065 |
| Raw + features | 3/3 | 10/10 | 2.00 | 12,446 |

This run demonstrates the missing comparison from V3:

```text
raw + features > raw
```

for successful automation: 3/3 versus 0/3.

## Aurora Needle

Each recorded iteration contains:

1. `POST /api/aurora/open`;
2. a response with 36 structurally identical, changing signal values;
3. 18 telemetry requests and large decoy responses;
4. `PUT /api/aurora/close`.

The signal required by the final request is regenerated for every new run. Reusing a value from a recording always fails.

Across 3 sessions and 15 iterations, the recorder captured 300 requests. The farmer classified the 270 `/api/events` requests as telemetry noise and retained the stable core workflow:

```text
POST /api/aurora/open
  -> PUT /api/aurora/close
```

It also found the decisive relation with 15/15 iteration support:

```text
open.response.body.channels[23].signal
  -> close.request.body.signal
```

## What Gemini did

All three raw-only automations:

- discovered the correct open and close endpoints;
- copied the dynamic `runId`;
- guessed `channels[0].signal`;
- reached the hidden close evaluator;
- received HTTP 422.

All three features-only automations and all three raw+features automations used:

```js
const signal = openData.channels[23].signal;
```

They completed the challenge in exactly two requests and received hidden acceptance.

This isolates the benefit reasonably well: raw supplied enough structure to reach the target, while farming supplied the cross-iteration dependency needed to choose the correct dynamic value.

## Context-budget policy

Every evidence arm had the same 24,000-character JSON ceiling.

- Raw preserves direct request/response observations, includes the first and last event, and then adds middle events until the budget is exhausted. Oversized bodies become explicit truncated previews.
- Features prioritize core endpoints, core-to-core relations, stable workflow, fields, and schemas.
- Raw+features reserves 67% for the feature summary and 33% for raw observations, including a small envelope allowance.
- The prompt records the applied budget and omitted counts.

The limit is a deterministic JSON-character proxy, not an exact tokenizer quota. Actual Gemini prompt-token usage is recorded separately.

## Guardrails

- The website and routes were created locally for this run.
- Gemini had no browser, source code, page JavaScript, tools, or documentation.
- Values changed on every live execution.
- Generated code was limited to the exact ephemeral localhost origin and six requests.
- The server independently recorded route coverage, statuses, request count, and final acceptance.
- Three different fixed seeds were used consistently across all conditions.

## Artifacts

- Matrix: `generated/gym-ab-v4-noise/matrix.md`
- Full result: `generated/gym-ab-v4-noise/matrix.json`
- Generated automation and execution evidence:
  `generated/gym-ab-v4-noise/noise/<condition>/trial-<n>/`
- Farm report: `output/gym/noise/report.md`
- Raw sessions: `demo-data/gym/noise/`

These runtime artifacts are ignored by Git.

## Reproduce

```powershell
$env:GYM_CHALLENGES = "noise"
npm run gym:collect

$env:GYM_TRIALS = "3"
$env:GYM_CONTEXT_BUDGET_CHARS = "24000"
$env:GYM_AB_OUTPUT = "generated/gym-ab-v4-noise-repeat"
npm run gym:ab
```
