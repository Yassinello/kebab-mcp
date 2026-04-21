/**
 * Phase 48 / FACADE-03 — RuleTester coverage for
 * `kebab/no-direct-process-env`.
 *
 * Run: `node --test tests/eslint/no-direct-process-env.test.mjs`
 *
 * 3 valid cases + 3 invalid cases exercise the rule logic at the AST
 * level (without depending on the whole lint run). Pairs with the
 * contract test (tests/contract/allowed-direct-env-reads.test.ts)
 * which covers the grep-level fallback.
 */

import { test } from "node:test";
import { RuleTester } from "eslint";
import rule from "../../.eslint/rules/no-direct-process-env.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

test("kebab/no-direct-process-env", () => {
  ruleTester.run("no-direct-process-env", rule, {
    valid: [
      // Calling getConfig() is fine.
      {
        code: "import { getConfig } from '@/core/config-facade'; const x = getConfig('FOO');",
      },
      // Accessing a non-env property on `process` is fine.
      { code: "const pid = process.pid;" },
      // Assignment is SEC-02's domain, not ours.
      { code: "process.env.FOO = 'bar';" },
      { code: "process.env['KEY'] = value;" },
    ],
    invalid: [
      // Direct member read.
      {
        code: "const x = process.env.FOO;",
        errors: [{ messageId: "direct" }],
      },
      // Computed member with string literal.
      {
        code: "const x = process.env['FOO'];",
        errors: [{ messageId: "direct" }],
      },
      // Computed member with dynamic key.
      {
        code: "const x = process.env[key];",
        errors: [{ messageId: "direct" }],
      },
    ],
  });
});
