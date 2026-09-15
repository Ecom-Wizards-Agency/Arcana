import { RuleTester } from 'eslint';
import { crossPackageImports } from './cross-package-imports.mjs';
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
tester.run('cross-package-imports', crossPackageImports, {
  valid: [
    { filename: '/repo/apps/web/src/view.js', options: [{ existing: [{ file: 'apps/web/src/view.js', source: '../../../packages/core/src/old.js' }] }], code: "import '../../../packages/core/src/old.js';" },
    { filename: '/repo/apps/web/src/view.js', code: "import { foo } from '@wizard-ads/core';" },
    { filename: '/repo/apps/web/src/view.js', code: "import { foo } from '../local.js';" },
  ],
  invalid: [
    { filename: '/repo/apps/web/src/view.js', options: [{ existing: [{ file: 'apps/web/src/view.js', source: '../../../packages/core/src/old.js' }] }], code: "import '../../../packages/core/src/new.js';", errors: [{ messageId: 'boundary' }] },
    { filename: '/repo/apps/web/src/view.js', code: "import { foo } from '../../../packages/core/src/foo.js';", errors: [{ messageId: 'boundary' }] },
    { filename: '/repo/apps/web/src/view.js', code: "export * from '../../../packages/core/src/foo.js';", errors: [{ messageId: 'boundary' }] },
    { filename: '/repo/apps/web/src/view.js', code: "import('../../../packages/core/src/foo.js');", errors: [{ messageId: 'boundary' }] },
  ],
});
