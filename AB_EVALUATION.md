# Gemini prior-knowledge versus features A/B

## Controls

- Model: `gemini-3.1-flash-lite`
- Seed: `91733`
- Temperature: `0.15`
- Three identical functional tasks
- Identical structured-output schema and safety policy
- Identical prompt before the `EVIDENCE` block
- A: `EVIDENCE: null`
- B: selected cross-session farm output

Neither condition had browsing or tools.

## Results

| Metric | A: no features | B: with features |
|---|---:|---:|
| Generated files accepted | 3/3 | 3/3 |
| Live tests passed | 3/3 | 3/3 |
| Automation rubric | 7/12 | 10/12 |
| Model confidence | 0.9 | 1.0 |
| Prompt tokens | 393 | 28,831 |

## Prior knowledge finding

A already knew or correctly reconstructed:

- `/api/v1/artworks/search?q=...`;
- `/api/v1/artworks/{id}`;
- the top-level `data` response;
- `data[0].id`;
- the search-to-detail workflow.

It also chose artwork ID `129884`, a concrete example used prominently by the API's public documentation. This is strong evidence that Art Institute API knowledge was already present in the model rather than derived from our farm.

## Incremental feature value

B uniquely reproduced these recorded properties:

- search is sent as `POST`;
- the query is in a JSON `q` field;
- a JSON `size` control is used.

B passed 10/12 rubric checks versus A's 7/12. Both missed the recorded public-domain filter and explicit field-selection list, showing that feature availability does not guarantee full feature utilization.

## Conclusion

For this target, live pass/fail alone overstates the value of the farm because Gemini already knew the API. The farm still improved behavioral fidelity to the observed traffic by 3 rubric points. A better future benchmark should use a private/local API or a newly created low-visibility site whose routes and schemas cannot plausibly exist in model training.

The B prompt is also much larger. Future evaluation should add a compact evidence condition to measure whether a small, ranked feature subset can retain the 10/12 score at a fraction of 28,831 prompt tokens.
