import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME } from './index.js';

describe('@specledger/db public entry point', () => {
  it('loads and identifies the package', () => {
    expect(PACKAGE_NAME).toBe('@specledger/db');
  });
});
