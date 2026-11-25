/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-inter-module-internal-imports',
      comment:
        'A module may only be imported through its index.ts entry point; direct imports of internal module files from outside the module are forbidden.',
      severity: 'error',
      from: {
        path: '^apps/api/src/',
        pathNot: '^apps/api/src/modules/([^/]+)/',
      },
      to: {
        path: '^apps/api/src/modules/([^/]+)/',
        pathNot: '^apps/api/src/modules/([^/]+)/index\\.(ts|js)$',
      },
    },
    {
      name: 'no-sibling-module-internal-imports',
      comment:
        'Modules cannot import internal files of sibling modules; only index.ts entry points are allowed.',
      severity: 'error',
      from: {
        path: '^apps/api/src/modules/([^/]+)/',
      },
      to: {
        path: '^apps/api/src/modules/([^/]+)/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/([^/]+)/index\\.(ts|js)$'],
      },
    },
    {
      name: 'no-better-auth-outside-identity',
      comment:
        'Only apps/api/src/modules/identity/ may import better-auth (D-007). All other modules must use our own identity module public API.',
      severity: 'error',
      from: {
        path: '^apps/api/src/',
        pathNot: '^apps/api/src/modules/identity/',
      },
      to: {
        path: 'better-auth',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },
  },
};
