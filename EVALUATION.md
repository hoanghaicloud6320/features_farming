# Evaluation from a recording newcomer

This evaluation intentionally assumes no prior knowledge of how the sample recordings were produced.

## JSONPlaceholder

The report makes the workflow understandable without opening `requests.json`:

- one repeated `POST /posts`;
- three changing inputs (`title`, `body`, `userId`);
- `userId` increases by one per iteration;
- all three inputs are echoed by the response;
- response `id = 101` is a stable server-side observation.

Verdict: rich enough to draft the core HTTP automation and its basic assertions.

## DummyJSON

The report reduces 29 captured requests to one core search request and eight noise endpoints. It identifies `q` as the changing input, `limit=5` as a request constant, and shows that response `total` and returned `limit` depend on the search result.

Verdict: rich enough to understand and parameterize the search call. It does not yet summarize the repeated product-array item schema, which would help downstream data extraction.

## Wikipedia

The first implementation was too noisy: framework loaders, image referers and analytics dominated the report. After filtering, 385 captured requests become three core endpoints and one changing value family:

```text
index.php?search=<term>
  -> rest.php/.../search/title?q=<term>
  -> /wiki/<term>
```

The same evidence repeats for OpenAI, Chromium, Node.js, Vietnam and Playwright. The report also states that 37 response bodies were unavailable, so it does not overclaim response-derived causality.

Verdict: the reduction is highly useful for pathway discovery. It is not enough to prove which UI event initiated each request or whether the autocomplete response selected the final page.

## Overall

The MVP is information-rich for:

- endpoint discovery and noise reduction;
- stable versus changing request fields;
- simple numeric trends;
- exact value reuse across a timeline;
- request/response echo detection;
- a first automation sequence and assertions.

Version 0.2 adds the previously identified high-value foundations:

1. comparison across separate recording sessions;
2. array schema summarization without array indices;
3. URL/base64/JWT/authorization and numeric transformed matches;
4. initiator, redirect, cookie and token dependency edges;
5. workflow branches, retries, polling loops and sequence variants.

The remaining weaknesses are semantic endpoint classification, UI-event attribution, richer branch alignment, and response bodies that CDP could not retrieve.
