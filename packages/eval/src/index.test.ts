import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@specledger/eval public entry point', () => {
  it('loads and identifies the package', () => {
    expect(PACKAGE_NAME).toBe('@specledger/eval');
  });
});
