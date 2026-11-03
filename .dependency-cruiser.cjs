// Dependency rules from the plan (Section 8.5).
// tsconfig.depcruise.json maps @specledger/<name> to that package's src, so imports between
// workspace packages are checked against source whether or not anything has been built.
// Rules also match the bare name, which is what an import resolves to when it cannot be resolved.

const ADAPTERS = '(db|llm|ingest|exporters|eval)';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Import cycles make modules impossible to understand or test in isolation.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'core-imports-only-zod',
      severity: 'error',
      comment:
        'packages/core is pure domain logic: its source may import only its own files and zod. ' +
        'No Node built-ins, no I/O libraries and no other workspace package.',
      from: { path: '^packages/core/src/', pathNot: '\\.test\\.ts$' },
      to: { pathNot: ['^packages/core/', 'node_modules/zod/', '^zod$'] },
    },
    {
      name: 'core-tests-only-core-zod-and-test-tools',
      severity: 'error',
      comment:
        'Tests in packages/core may add test libraries, but not I/O or other workspace packages.',
      from: { path: '^packages/core/.+\\.test\\.ts$' },
      to: {
        pathNot: [
          '^packages/core/',
          'node_modules/(zod|vitest|fast-check)/',
          'node_modules/@vitest/',
          '^(zod|vitest|fast-check)$',
        ],
      },
    },
    {
      name: 'adapters-do-not-import-each-other',
      severity: 'error',
      comment:
        'db, llm, ingest, exporters and eval may depend on core but never on each other, ' +
        'so each adapter can be understood, tested and replaced alone.',
      from: { path: `^packages/${ADAPTERS}/` },
      to: {
        path: [`^packages/${ADAPTERS}/`, `^@specledger/${ADAPTERS}($|/)`],
        pathNot: ['^packages/$1/', '^@specledger/$1($|/)'],
      },
    },
    {
      name: 'nothing-imports-apps',
      severity: 'error',
      comment:
        'Apps are entry points. Packages must not depend on them and apps must not depend on ' +
        'each other.',
      from: { path: '^(apps|packages)/([^/]+)/' },
      to: {
        path: ['^apps/', '^@specledger/(api|web)($|/)'],
        pathNot: ['^apps/$2/'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^(apps|packages)/[^/]+/(dist|coverage|\\.turbo)/' },
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
