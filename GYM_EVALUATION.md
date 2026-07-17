# Local Gym Evaluation

> This document describes V3. The newer fixed-budget, three-trial experiment
> demonstrating `raw + features > raw` is documented in `GYM_V4_EVALUATION.md`.

## Outcome

The final V3 run produced the intended difficulty separation with `gemini-3.1-flash-lite`:

| Challenge | No evidence | Raw recorder | Farmed features | Raw + features |
|---|---:|---:|---:|---:|
| Easy: Marble Relay | 0/10 | 10/10 | 10/10 | 10/10 |
| Medium: Lattice Capsule | 0/10 | 10/10 | 10/10 | 10/10 |
| Hard: Prism Bridge | 0/10 | 2/10 | 2/10 | 2/10 |

The hidden server accepted 0/3 workflows without evidence and 2/3 workflows in every evidence arm. The hard evidence arms all reached the correct bridge endpoint, giving them 67% route coverage, but their proof was rejected.

This is a real execution matrix with one fixed-seed trial per cell. It demonstrates behavior but is not statistically powered.

## What each level measures

### Easy: direct relay

The first response produces `runId` and `handoffKey`. Both must be copied into the next request.

The farm output exposes:

- the stable two-request workflow;
- both request and response structures;
- two response-to-request `exact-copy` relations supported by 15/15 iterations.

Raw, farmed features, and their combination all generated accepted automation.

### Medium: transformed relay

The first response produces `runId` and `capsule`. The next request needs:

```text
Authorization: Bearer <base64url(capsule)>
```

The first collection run exposed two farmer weaknesses: same-method sibling routes were generalized into one `:var` route, and a Bearer token was not decoded again after its authorization scheme was removed. The gym therefore caused a genuine farmer improvement:

- the routes now remain separately observable in the benchmark;
- Bearer-wrapped base64url values are linked to their source;
- the relation includes a machine-readable source-to-target transform:

```json
{
  "direction": "source-to-target",
  "steps": [
    { "operation": "base64url-encode-utf8", "padding": false },
    { "operation": "prefix", "value": "Bearer " }
  ]
}
```

After this change and an evidence-neutral CommonJS output constraint, the features-only automation passed the hidden evaluator.

### Hard: narrowed but unresolved bridge

The stable flow is:

```text
POST /api/prism/origin
  -> PUT /api/prism/bridge
  -> PATCH /api/prism/complete
```

The farmer correctly exposes:

- the complete endpoint order;
- `origin.response.runId -> bridge.request.runId`;
- `origin.response.runId -> complete.request.runId`;
- `bridge.response.bridgeTicket -> complete.request.ticket`;
- a remaining variable `bridge.request.proof` with no supported source relation.

The hidden bridge is:

```text
sha256(seed + ":" + salt + ":" + label).hex().slice(0, 24)
```

Gemini narrowed the missing computation to a SHA-256/HMAC-style proof, but did not infer the delimiter, inclusion of `label`, and truncation together. Raw and raw+features sometimes reused an observed proof from a different run, which the hidden evaluator rejected. This is the desired boundary: farming identifies both sides of the missing bridge without pretending it has proved the bridge itself.

## Contamination controls

- The localhost website and opaque routes were created for this benchmark.
- Gemini received no browser, source tree, page JavaScript, documentation, or tools.
- Every condition used the same model, task, safety constraints, output schema, and per-challenge seed.
- The condition payload always had the same shape; only `rawTimeline` and `farmedFeatures` changed between cells.
- “Raw” is a transport-noise-reduced projection of captured HTTP requests and responses. It contains no inferred relations.
- Generated code was restricted to the exact ephemeral localhost origin and a maximum of six requests.
- Every request carried a unique benchmark ID. The server recorded route coverage and final acceptance independently of test assertions.
- A clean test exit alone could contribute only 1/10; hidden server acceptance contributed 6/10.

## Audit artifacts

- Final matrix: `generated/gym-ab-v3/matrix.md`
- Full machine-readable result: `generated/gym-ab-v3/matrix.json`
- Per-cell evidence, model assessment, generated code, execution output, and hidden metrics: `generated/gym-ab-v3/<challenge>/<condition>/`
- Current farm reports: `output/gym/<challenge>/report.md`
- Original raw sessions: `demo-data/gym/<challenge>/`
- V1 and V2 diagnostic runs: `generated/gym-ab/` and `generated/gym-ab-v2/`

These directories are intentionally ignored by Git because recordings and generated model output can be large or sensitive.

## Reproduce

```powershell
npm install
npm run gym:collect
npm run gym:ab
```

The Gemini key file defaults to `./gemini-api-key.txt`, one key per line. It is excluded from Git by `.gitignore`. Use `GYM_AB_OUTPUT` to preserve multiple runs:

```powershell
$env:GYM_AB_OUTPUT = "generated/gym-ab-repeat"
npm run gym:ab
```

Run the website by itself:

```powershell
npm run gym:start
```

Then open `http://127.0.0.1:43127`.
