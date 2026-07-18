# Contract generation matrix

Model: `gemini-3.1-flash-lite`

| Suite | Arm | Cases | Quality /100 | Endpoint F1 | Exact statuses | Complete cases | Tokens/case | Latency s | Complete cases / 1k tokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| v1 | none | 3 | 10.00 | 0.0% | 0.0% | 0.0% | 72.7 | 1.36 | 0 |
| v1 | raw | 3 | 71.35 | 100.0% | 0.0% | 0.0% | 190.7 | 3.29 | 0 |
| v1 | features | 3 | 100.00 | 100.0% | 100.0% | 100.0% | 402 | 3.83 | 2.488 |
| v1 | raw-features | 3 | 80.00 | 100.0% | 0.0% | 0.0% | 520 | 3.74 | 0 |
| v2 | none | 3 | 10.00 | 0.0% | 0.0% | 0.0% | 72.7 | 1.24 | 0 |
| v2 | raw | 3 | 71.35 | 100.0% | 0.0% | 0.0% | 190.7 | 3.22 | 0 |
| v2 | features | 3 | 100.00 | 100.0% | 100.0% | 100.0% | 402 | 3.93 | 2.488 |
| v2 | raw-features | 3 | 80.00 | 100.0% | 0.0% | 0.0% | 520 | 3.73 | 0 |
| v3 | none | 3 | 10.00 | 0.0% | 0.0% | 0.0% | 72.7 | 1.24 | 0 |
| v3 | raw | 3 | 71.35 | 100.0% | 0.0% | 0.0% | 190.7 | 3.11 | 0 |
| v3 | features | 3 | 100.00 | 100.0% | 100.0% | 100.0% | 402 | 3.83 | 2.488 |
| v3 | raw-features | 3 | 80.00 | 100.0% | 0.0% | 0.0% | 520 | 4.14 | 0 |
| v4 | none | 1 | 10.00 | 0.0% | 0.0% | 0.0% | 182 | 1.24 | 0 |
| v4 | raw | 1 | 54.50 | 80.0% | 0.0% | 0.0% | 422 | 2.28 | 0 |
| v4 | features | 1 | 100.00 | 100.0% | 100.0% | 100.0% | 544 | 2.28 | 1.838 |
| v4 | raw-features | 1 | 54.50 | 80.0% | 0.0% | 0.0% | 784 | 2.39 | 0 |
| v5 | none | 12 | 10.00 | 0.0% | 0.0% | 0.0% | 43.6 | 2.48 | 0 |
| v5 | raw | 12 | 67.74 | 71.4% | 83.3% | 25.0% | 314.3 | 14.40 | 0.796 |
| v5 | features | 12 | 100.00 | 100.0% | 100.0% | 100.0% | 1017.5 | 13.17 | 0.983 |
| v5 | raw-features | 12 | 76.79 | 85.7% | 100.0% | 33.3% | 1288.2 | 14.92 | 0.259 |
| v6 | none | 21 | 10.00 | 0.0% | 0.0% | 0.0% | 56.3 | 3.54 | 0 |
| v6 | raw | 21 | 82.43 | 81.1% | 100.0% | 0.0% | 328.7 | 29.29 | 0 |
| v6 | features | 21 | 100.00 | 100.0% | 100.0% | 100.0% | 749 | 24.98 | 1.335 |
| v6 | raw-features | 21 | 89.89 | 100.0% | 100.0% | 100.0% | 1021.4 | 19.75 | 0.979 |
| v7 | none | 40 | 10.00 | 0.0% | 0.0% | 0.0% | 52.3 | 6.20 | 0 |
| v7 | raw | 40 | 82.38 | 81.0% | 100.0% | 0.0% | 325.9 | 50.75 | 0 |
| v7 | features | 40 | 100.00 | 100.0% | 100.0% | 100.0% | 731.5 | 50.16 | 1.367 |
| v7 | raw-features | 40 | 97.86 | 100.0% | 100.0% | 100.0% | 1005 | 47.64 | 0.995 |
| v8 | none | 25 | 10.00 | 0.0% | 0.0% | 0.0% | 53.3 | 3.92 | 0 |
| v8 | raw | 25 | 85.34 | 91.7% | 100.0% | 20.0% | 444.3 | 46.29 | 0.45 |
| v8 | features | 25 | 100.00 | 100.0% | 100.0% | 100.0% | 943.2 | 45.21 | 1.06 |
| v8 | raw-features | 25 | 86.67 | 91.7% | 100.0% | 20.0% | 1334.2 | 45.47 | 0.15 |
| keymanager | none | 1 | 10.00 | 0.0% | 0.0% | 0.0% | 201 | 1.12 | 0 |
| keymanager | raw | 1 | 77.71 | 100.0% | 100.0% | 100.0% | 14871 | 3.73 | 0.067 |
| keymanager | features | 1 | 81.14 | 100.0% | 100.0% | 100.0% | 6701 | 4.56 | 0.149 |
| keymanager | raw-features | 1 | 70.00 | 100.0% | 100.0% | 100.0% | 10477 | 4.44 | 0.095 |

Quality weights: endpoint F1 40%, exact status sets 20%, request-field recall 15%, response-field recall 15%, and no hallucinated endpoints 10%.

Complete-contract token efficiency is the number of cases with full endpoint coverage, exact status sets, and no hallucinated endpoints per 1,000 prompt tokens. Quality points per 1,000 tokens remain available in matrix.json.

V1, V2, and V3 intentionally share the original three recordings but use different model seeds. This measures generation variance without pretending they are distinct datasets.
