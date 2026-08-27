import assert from 'node:assert/strict'
import test from 'node:test'

import { findSchemaQualifiedSpecialForms } from './check-sql-special-forms.mjs'

test('flags schema-qualified PostgreSQL conditional expressions', () => {
  const sql = [
    'select pg_catalog.coalesce(total_cents, 0);',
    "select public.nullif(note, '');",
    'select custom_schema.greatest(first_value, second_value);',
    'select pg_catalog.least(first_value, second_value);',
  ].join('\n')

  assert.deepEqual(findSchemaQualifiedSpecialForms(sql), [
    {
      construct: 'COALESCE',
      line: 1,
      text: 'select pg_catalog.coalesce(total_cents, 0);',
    },
    {
      construct: 'NULLIF',
      line: 2,
      text: "select public.nullif(note, '');",
    },
    {
      construct: 'GREATEST',
      line: 3,
      text: 'select custom_schema.greatest(first_value, second_value);',
    },
    {
      construct: 'LEAST',
      line: 4,
      text: 'select pg_catalog.least(first_value, second_value);',
    },
  ])
})

test('accepts unqualified forms and ignores SQL comments', () => {
  const sql = [
    '-- select pg_catalog.coalesce(total_cents, 0);',
    "/* select public.nullif(note, ''); */",
    'select coalesce(total_cents, 0);',
    "select nullif(note, '');",
    'select greatest(first_value, second_value);',
    'select least(first_value, second_value);',
  ].join('\n')

  assert.deepEqual(findSchemaQualifiedSpecialForms(sql), [])
})
