import { describe, expect, it } from 'vitest';

import * as api from './index.js';

describe('@specledger/api public entry point', () => {
  it('loads and exposes the config and logger factories', () => {
    expect(api.PACKAGE_NAME).toBe('@specledger/api');
    expect(typeof api.parseConfig).toBe('function');
    expect(typeof api.formatConfigIssues).toBe('function');
    expect(typeof api.createLogger).toBe('function');
  });
});
