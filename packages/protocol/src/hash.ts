import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { validateReportPayload } from './schema.js';
import { assertValidUnicode } from './unicode.js';
import type { ReportPayload } from './types.js';

/**
 * RFC 8785 JSON Canonicalization Scheme semantics: ECMAScript number/string
 * serialization and recursively sorted UTF-16 property names. No normalization.
 * Accepts only JSON data, rejecting non-finite numbers, sparse arrays, cycles,
 * lone surrogates, accessors and non-plain objects rather than coercing them.
 */
export function canonicalizeJson(value: unknown): string {
  const stack = new Set<object>();
  const serialize = (current: unknown): string => {
    if (current === null) return 'null';
    if (typeof current === 'string') {
      assertValidUnicode(current);
      return JSON.stringify(current);
    }
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('JSON numbers must be finite');
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') throw new TypeError('Only JSON data can be canonicalized');
    if (stack.has(current)) throw new TypeError('JSON data must not contain cycles');
    stack.add(current);
    try {
      if (Array.isArray(current)) {
        const entries: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !('value' in descriptor)) throw new TypeError('Sparse arrays and accessors are not JSON data');
          entries.push(serialize(descriptor.value));
        }
        if (Object.keys(current).some((key) => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) {
          throw new TypeError('Arrays must not contain named properties');
        }
        if (Object.getOwnPropertySymbols(current).length) throw new TypeError('JSON data must not contain symbol keys');
        return `[${entries.join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Only plain JSON objects can be canonicalized');
      }
      if (Object.getOwnPropertySymbols(current).length) throw new TypeError('JSON data must not contain symbol keys');
      const properties = Object.keys(current).sort().map((key) => {
        assertValidUnicode(key);
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor)) throw new TypeError('Accessors are not JSON data');
        return `${JSON.stringify(key)}:${serialize(descriptor.value)}`;
      });
      return `{${properties.join(',')}}`;
    } finally {
      stack.delete(current);
    }
  };
  return serialize(value);
}

/** Ethereum Keccak-256 of exact UTF-8 bytes, with no trim or Unicode normalization. */
export function hashContent(rawText: string): string {
  if (typeof rawText !== 'string') throw new TypeError('Content must be a string');
  assertValidUnicode(rawText);
  return `0x${bytesToHex(keccak_256(new TextEncoder().encode(rawText)))}`;
}

export function canonicalizePayload(payload: ReportPayload): string {
  validateReportPayload(payload);
  return canonicalizeJson(payload);
}

/** proof, transaction details, certificate IDs and hashes never belong in payload. */
export function hashPayload(payload: ReportPayload): string {
  return hashContent(canonicalizePayload(payload));
}
