import * as protocol from '@crosscheck/protocol';
/** Compatibility for immutable B replay files; all schema/hash work delegates to A. */
Object.assign(window, {
  ShowcaseProtocol: {
    canonicalize: protocol.canonicalizeJson,
    computeHashes(payload: protocol.ReportPayload) {
      return { content_hash: protocol.hashContent(payload.raw_text), verdict_hash: protocol.hashPayload(payload) };
    },
    validateReportEnvelope(value: unknown) {
      const parsed = protocol.safeParseReportEnvelope(value);
      return parsed.success ? { valid: true, errors: [] }
        : { valid: false, errors: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) };
    },
  },
});
