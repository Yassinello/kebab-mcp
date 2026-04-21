/**
 * kebab/no-direct-process-env — Phase 48 / FACADE-03.
 *
 * Forbids direct `process.env.X` reads in production code (src/ + app/).
 * Use `getConfig('X')` from `@/core/config-facade` instead. Boot-path
 * files that cannot route through the facade are exempted via an
 * override block in `eslint.config.mjs` (matched from
 * `ALLOWED_DIRECT_ENV_READS` in `src/core/config-facade.ts`).
 *
 * Why a separate rule from SEC-02: SEC-02's `no-restricted-syntax`
 * guards ASSIGNMENTS to `process.env`; this rule guards READS. Two
 * orthogonal concerns, two rules.
 *
 * Pattern matched:
 *   - `process.env.FOO`             (MemberExpression.MemberExpression)
 *   - `process.env["FOO"]`          (computed MemberExpression)
 *   - `process.env[key]`            (computed MemberExpression)
 *
 * The AssignmentExpression LHS is NOT a "read" even when it looks like
 * a member access — ESLint's AST puts the assignment at the parent
 * level. Check excludes `parent.type === 'AssignmentExpression'` to
 * avoid double-flagging what SEC-02 already catches.
 */

const MESSAGE =
  "Direct process.env read forbidden (FACADE-03). Use getConfig('X') from @/core/config-facade. " +
  "If this is a boot-time read that cannot be migrated, add the file to ALLOWED_DIRECT_ENV_READS in " +
  "src/core/config-facade.ts (with a ≥20-char reason) and extend the override block in eslint.config.mjs.";

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct process.env reads outside the ALLOWED_DIRECT_ENV_READS allowlist",
      recommended: false,
    },
    schema: [],
    messages: {
      direct: MESSAGE,
    },
  },
  create(context) {
    return {
      // Matches both `process.env.FOO` and `process.env["FOO"]` / `process.env[key]`.
      // ESLint AST: outer MemberExpression's object is the inner `process.env`
      // MemberExpression. Guard against AssignmentExpression LHS (SEC-02 owns those).
      MemberExpression(node) {
        const object = node.object;
        if (!object || object.type !== "MemberExpression") return;
        const inner = object;
        if (!inner.object || inner.object.type !== "Identifier") return;
        if (inner.object.name !== "process") return;
        if (!inner.property) return;
        const innerProp = inner.property;
        const innerPropName = innerProp.type === "Identifier" ? innerProp.name : undefined;
        if (innerPropName !== "env") return;

        // Exclude assignment LHS — SEC-02 covers that.
        const parent = node.parent;
        if (parent && parent.type === "AssignmentExpression" && parent.left === node) return;

        context.report({
          node,
          messageId: "direct",
        });
      },
    };
  },
};
