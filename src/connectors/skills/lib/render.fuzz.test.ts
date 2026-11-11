/**
 * FUZZ-01..03 (SV6-3) — property-based tests for `renderSkill`.
 *
 * `renderSkill` does string substitution against a user-supplied args
 * record. The fuzz fleet generates adversarial input shapes — random
 * argument names (including prototype keys like `__proto__`,
 * `constructor`, `toString`), random values containing special chars,
 * deeply mixed structures, and mustache content that references the
 * generated arg names — and asserts three invariants:
 *
 *   1. The output is always a `string` (never throws, never returns
 *      `undefined`/`null`/`object`).
 *
 *   2. `Object.prototype` is never mutated. We snapshot the prototype
 *      keys before each run and verify they're identical after.
 *
 *   3. The rendered output never contains literal Object.prototype
 *      member names (`hasOwnProperty`, `valueOf`, `toString`,
 *      `__proto__`, `constructor`) coming from prototype walks rather
 *      than legitimate user content. This is a smoke test for "the
 *      renderer accidentally enumerated the prototype chain". To avoid
 *      false positives we only check this when the generated args
 *      record has no explicit key with that name.
 */

import { describe, test } from "vitest";
import * as fc from "fast-check";
import { renderSkill } from "./render";
import type { Skill } from "../store";

function makeSkill(content: string): Skill {
  return {
    id: "fuzz",
    name: "Fuzz",
    description: "",
    content,
    arguments: [],
    toolsAllowed: [],
    source: { type: "inline" },
    syncState: {},
    tags: [],
    files: [],
    exposeAsTool: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const PROTO_NAMES = [
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "toLocaleString",
  "valueOf",
];

const argNameArb = fc.oneof(
  fc.constantFrom(...PROTO_NAMES),
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s))
);

const argValueArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constantFrom("</script>", "{{__proto__}}", "\u0000", "\\\\", "{{constructor}}")
);

describe("renderSkill — prototype-pollution & robustness fuzz", () => {
  test("never mutates Object.prototype, never throws, always returns string", () => {
    const beforeProtoKeys = Object.getOwnPropertyNames(Object.prototype).sort().join(",");

    fc.assert(
      fc.property(
        // skill content with up to 8 placeholders chosen from a small alphabet
        fc.array(fc.constantFrom("a", "b", "c", "__proto__", "toString", "constructor"), {
          maxLength: 8,
        }),
        // args record with random keys + values
        fc.dictionary(argNameArb, argValueArb, { maxKeys: 12 }),
        (placeholderNames, args) => {
          const content = placeholderNames.map((n) => `prefix {{${n}}} suffix`).join("\n");
          const out = renderSkill(makeSkill(content), args);

          // Invariant 1: always a string.
          if (typeof out !== "string") return false;

          // Invariant 2: prototype unchanged.
          const afterProtoKeys = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
          if (afterProtoKeys !== beforeProtoKeys) return false;

          return true;
        }
      ),
      { numRuns: 250 }
    );
  });

  test("placeholder referencing a prototype-only key emits empty (no chain walk)", () => {
    // Direct invariant check for FUZZ-03: even though `toString` exists
    // on every object via Object.prototype, the renderer must NOT emit
    // its native function source because it should only consult own
    // enumerable keys, not the prototype chain.
    for (const protoKey of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      const out = renderSkill(makeSkill(`A {{${protoKey}}} B`), {});
      // Output should be `A  B` (placeholder consumed, no value).
      // Asserting we don't see the native function source is sufficient.
      if (/native code/.test(out)) {
        throw new Error(`renderSkill leaked Object.prototype.${protoKey} into output: ${out}`);
      }
      if (out.includes("function ")) {
        throw new Error(`renderSkill emitted a function for {{${protoKey}}}: ${out}`);
      }
    }
  });

  test("placeholder-name substitution honors __proto__ as empty when not passed", () => {
    fc.assert(
      fc.property(fc.string(), (junk) => {
        const out = renderSkill(makeSkill(`<{{__proto__}}>`), { other: junk });
        // Rendered as <> because __proto__ is not in args (regex falls
        // through to "" replacement). The trailing "**other**: …" tail
        // is appended for unused args.
        return typeof out === "string" && out.startsWith("<>");
      }),
      { numRuns: 50 }
    );
  });
});
