/** Reject lone UTF-16 surrogates instead of silently hashing U+FFFD. */
export function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('Strings must not contain lone UTF-16 surrogates');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('Strings must not contain lone UTF-16 surrogates');
    }
  }
}

export function isValidUnicode(value: string): boolean {
  try {
    assertValidUnicode(value);
    return true;
  } catch {
    return false;
  }
}
