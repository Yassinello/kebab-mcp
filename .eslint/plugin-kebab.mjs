/**
 * kebab ESLint plugin — thin wrapper exposing project-custom rules.
 *
 * Phase 48 (FACADE-03) ships `kebab/no-direct-process-env`. Future
 * rules (Phase 49 `getRequiredEnv` strictness, Phase 50 KEBAB alias
 * deprecation) attach here.
 */

import noDirectProcessEnv from "./rules/no-direct-process-env.mjs";

export default {
  rules: {
    "no-direct-process-env": noDirectProcessEnv,
  },
};
