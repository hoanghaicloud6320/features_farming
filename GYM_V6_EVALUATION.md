# Farmer Gym V6 and multi-seed evaluation

## Objective

This iteration separates two kinds of variance:

1. The KeyManager contract generator is measured across several model seeds
   while holding the recorded application evidence constant.
2. Farmer extraction is measured on seeded, newly generated Gym cases whose
   routes, field names, values, decoys, and transform parameters vary.

The Gym ground truth is generated independently from farmer output. The
recordings use the normal recorder format, so farming and scoring exercise the
same input boundary as recorded applications.

## KeyManager contract generation across seeds

Five seeds were run for each of three evidence arms: raw, features, and
raw+features.

| Arm | Runs | Endpoint coverage | Exact status sets | No hallucination | Correct cookie auth | Mean prompt tokens |
|---|---:|---:|---:|---:|---:|---:|
| Raw | 5 | 100% | 100% | 100% | 0% | 18,046 |
| Features | 5 | 100% | 100% | 100% | 100% | 12,407 |
| Raw+features | 5 | 100% | 100% | 100% | 100% | 16,933 |

All arms recovered both tested lifecycle dependencies in every run. The full
contract text varied across all five seeds in every arm, but the measured
endpoint, status, hallucination, and dependency behavior remained stable.

Features are therefore not merely shorter than raw evidence. They consistently
make the authentication transport explicit enough for the model to name the
`km_admin` cookie. Raw evidence alone missed that behavior under all five
seeds. Features also use 31.3% fewer prompt tokens than raw and 26.7% fewer
than raw+features.

## Seeded Gym V6

V6 uses three seeds. Each seed creates seven cases, for 21 total cases. Every
case has two sessions and four iterations per session.

The generated dimensions include:

- randomized paths and non-semantic field names;
- randomized candidate and telemetry noise;
- unstable single-session decoys;
- arbitrary prefix/suffix, affine numeric, HMAC-SHA256, JSON-base64url,
  reverse-string, and array-selection relations;
- finite semantic sibling routes with deliberately incompatible statuses and
  response schemas.

The transform families are holdouts from V5. Random field names deliberately
avoid the farmer's semantic field-name allowlist.

| Arm | Mean score | Worst case | Relation recall | Perfect cases |
|---|---:|---:|---:|---:|
| Single session | 84.57 | 80.00 | 58.3% | 14.3% |
| Cross-session | **90.48** | **86.67** | 58.3% | 28.6% |

| Family | Cases | Single | Cross-session | Cross relation recall |
|---|---:|---:|---:|---:|
| Arbitrary affix | 3 | 80.00 | 86.67 | 50% |
| Affine numeric | 3 | 80.00 | 86.67 | 50% |
| HMAC-SHA256 | 3 | 80.00 | 86.67 | 50% |
| JSON-base64url | 3 | 80.00 | 86.67 | 50% |
| Reverse string | 3 | 80.00 | 86.67 | 50% |
| Array selection | 3 | 92.00 | 100.00 | 100% |
| Semantic siblings | 3 | 100.00 | 100.00 | n/a |

## Interpretation

The farmer remains precise on structural evidence: all V6 cases correctly
classify core and noise endpoints and preserve workflow order. Semantic sibling
member attribution is also exact for member coverage, statuses, schemas, and
session/iteration provenance.

Cross-session aggregation improves mean score by 5.91 points and removes the
seeded accidental relation, but it cannot invent transform detectors. For five
new transform families the farmer finds the ordinary run identifier relation
and misses the novel proof relation, hence 50% relation recall. Exact array
selection is already supported and reaches 100%.

This is the intended pressure from V6: deterministic algorithms provide
candidate relationships and attribution before the LLM prompt. The model is
not asked to search an unrestricted Cartesian product of values or infer which
semantic siblings should be compared.

## Accuracy limits

- V6 is synthetic. Seed diversity measures robustness within these generators,
  not the distribution of all real applications.
- Three Gym seeds and five model seeds are enough to reveal repeatable gaps,
  but are not confidence bounds for production accuracy.
- Direct recorder-format generation covers farmer input and scoring, but not
  browser timing, redirects, streaming, or transport capture failures.
- Unsupported transform families reduce the score by design. Adding detectors
  should be validated on new holdout seeds and families, not only these cases.
- KeyManager checks evaluate observable contract facts, not prose quality or
  whether generated code passes an external API conformance suite.

## Reproduce

```powershell
npm run keymanager:contract-multiseed
npm run gym:v6
```

Custom seeds can be supplied through `KEYMANAGER_SEEDS` and `GYM_V6_SEEDS`.
