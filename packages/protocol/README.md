# CrossCheck shared protocol

A owns this package. Both Node/tsx and Vite consume the exact same `src/index.ts` entry; use TypeScript-aware tooling. `npm run build -w @crosscheck/protocol` additionally emits `dist/` for a future JavaScript distribution. No browser entry imports filesystem, environment, or Node-only code.

## Public contract

- `validateReportEnvelope(value: unknown): ReportEnvelope` throws `ZodError` on invalid input. `safeParseReportEnvelope` provides a nonthrowing result for browser forms. Validation checks structure and semantics; it does **not** verify any chain record.
- `validateReportPayload`, `reportPayloadSchema`, `reportEnvelopeSchema`, `modelResultSchema`, `chainProofSchema`, `anchorInputSchema`, `certificateRecordSchema`, `publicConfigSchema` are strict schemas. Unknown report fields are rejected instead of silently dropped. Models must occur in slot order `a`, `b`.
- `deriveAgreement([a, b])` / `calculateAgreement([a, b])`: `0` same non-unknown successful verdicts; `1` differing non-unknown successful verdicts; `2` one success or any `unable_to_determine`; `null` both adapters failed. A `null` result must become a failed task with no payload/certificate.
- `hashContent(text)` returns lowercase `0x` Ethereum **Keccak-256**, not SHA3-256. It hashes exact UTF-8 bytes without trimming, changing line endings or Unicode normalization. Invalid lone UTF-16 surrogates are rejected before encoding.
- `canonicalizePayload(payload)` validates then serializes using [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) semantics. Keys sort by UTF-16 code units at every object depth; arrays retain order; JSON number/string serialization follows ECMAScript. There is no Unicode normalization. Unsupported values and non-finite numbers fail.
- `hashPayload(payload)` hashes that canonical UTF-8 string. `proof` remains outside payload and has no effect on this hash.
- `canonicalizeJson(value)` supports other JSON structures, including non-secret model configuration. `hashContent(canonicalizeJson(config))` can produce `model_config_hash`.

All wire types use the specified snake_case contract. `PublicConfig`, `VerifyAccepted`, `CertificateResponse`, `ReportHashes`, `JobEventDataMap` and `JobEvent` supplement the core types. Events carry increasing numeric `id`, `event`, and `data` including `job_id`; SSE uses `event`, `id` and serialized `data` fields. `done` means processing finished, not that anchoring succeeded. `block_number` and `deployment_block` use unsigned decimal strings; `block_time` is a nonempty string to permit the chain adapter's documented timestamp representation. An empty `requested_model` is accepted only for a failed result whose `error_code` is `NOT_CONFIGURED`, so absent environment configuration can remain explicit without inventing a model ID.

## Fixtures and checks

`fixtures/normal.demo.json` is explicitly synthetic with `mode: demo`, demo providers, and `proof: null`. It includes leading/trailing whitespace, CRLF and Chinese text to catch accidental input normalization. `tampered.demo.json` changes original text, so both hashes differ. `reason-tampered.demo.json` changes a model reason, so only `verdict_hash` differs. Expected fingerprints are in `expected-hashes.json`; canonical bytes are in `normal.canonical.txt` with no terminal newline.

These files contain no real model results, transaction records or chain confirmation claims. Compare imported files to a record read from the known deployment; comparing to file-supplied proof/hash alone is not verification. JSON must be parsed once before schema validation; never use `JSON.stringify` alone as the payload hash input. Standard `JSON.parse` cannot detect duplicate object keys; producers must emit unique keys as required by I-JSON.

```sh
npm run typecheck -w @crosscheck/protocol
npm test -w @crosscheck/protocol
npm run fixtures:check -w @crosscheck/protocol
# Regenerate only when intentionally updating the fixed protocol fixtures:
npx tsx packages/protocol/scripts/generate-fixtures.ts
```

The dependencies are `zod ^3.24.2` and `@noble/hashes ^1.8.0`. The Keccak import is `@noble/hashes/sha3`, not its `sha3_256` export. Tests run with `tsx --test` and use fixed Ethereum vectors plus canonicalization, schema, agreement and tampering cases.
