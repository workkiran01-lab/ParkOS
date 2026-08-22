import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist', 'src/routeTree.gen.ts'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
  },
  {
    // TanStack Router route files must export the Route object;
    // shadcn/ui components export variant helpers alongside the component
    files: ['src/routes/**/*.tsx', 'src/components/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Supabase Edge Functions execute in Deno rather than the browser runtime.
    files: ['supabase/functions/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.worker,
        Deno: 'readonly',
      },
    },
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
)
