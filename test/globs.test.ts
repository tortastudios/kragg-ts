/**
 * Tests for `src/util/` — the fnmatch-compatible glob matcher and the
 * `// kragg: ignore` suppression markers.
 *
 * The glob tests are deliberately adversarial rather than smoke tests. The
 * matcher decides which files are EXEMPT from the structure budgets and from
 * mutation scope, so a pattern that matches too much silently switches gates
 * off for files nobody meant to exempt — and nothing in the output says so.
 * The escaping cases below (`.`, `+`, `(`, `)`, `|`, `$`, `\`) are the ones
 * where a naive `String.replace`-based translator quietly turns a literal
 * path into a wildcard.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { matchesAny, matchesGlob } from "../src/util/globs.ts";
import {
  lineSuppressed,
  SUPPRESS_BLOCK_COMMENT,
  SUPPRESS_LINE_COMMENT,
  suppressed,
} from "../src/util/suppress.ts";

describe("matchesGlob: wildcards", () => {
  it("matches a plain literal path", () => {
    assert.equal(matchesGlob("src/a.ts", "src/a.ts"), true);
    assert.equal(matchesGlob("src/b.ts", "src/a.ts"), false);
  });

  it("anchors both ends", () => {
    assert.equal(matchesGlob("ab", "a"), false);
    assert.equal(matchesGlob("ba", "a"), false);
    assert.equal(matchesGlob("a.tsx", "*.ts"), false);
    assert.equal(matchesGlob("a.ts", "*.ts"), true);
  });

  it("lets `*` span a slash, because this is fnmatch and not shell globbing", () => {
    assert.equal(matchesGlob("src/deep/nested/a.ts", "src/*.ts"), true);
    assert.equal(matchesGlob("src/a.ts", "*"), true);
  });

  it("treats `**` as a single `*`, not as a shell recursive glob", () => {
    // `src/**/*.ts` collapses to `src/*/*.ts`, so it still needs the second
    // slash. This is exactly what Python's fnmatch does; a project writing
    // `**` expecting shell semantics gets fewer matches, never more.
    assert.equal(matchesGlob("src/a/b.ts", "src/**/*.ts"), true);
    assert.equal(matchesGlob("src/a.ts", "src/**/*.ts"), false);
  });

  it("matches exactly one character for `?`", () => {
    assert.equal(matchesGlob("a.ts", "?.ts"), true);
    assert.equal(matchesGlob("ab.ts", "?.ts"), false);
    assert.equal(matchesGlob(".ts", "?.ts"), false);
    // `?` spans a slash too, same as `*`.
    assert.equal(matchesGlob("a/b", "a?b"), true);
  });

  it("is case-sensitive on every platform", () => {
    assert.equal(matchesGlob("README.md", "readme.md"), false);
    assert.equal(matchesGlob("SRC/A.TS", "src/*.ts"), false);
  });

  it("matches the empty pattern against the empty string only", () => {
    assert.equal(matchesGlob("", ""), true);
    assert.equal(matchesGlob("a", ""), false);
  });

  it("does not let a trailing newline slip past the end anchor", () => {
    assert.equal(matchesGlob("a.ts\n", "*.ts"), false);
  });
});

describe("matchesGlob: regex metacharacter escaping", () => {
  it("treats `.` as a literal, not as any-character", () => {
    assert.equal(matchesGlob("src.a.ts", "src.a.ts"), true);
    assert.equal(matchesGlob("srcXa.ts", "src.a.ts"), false);
  });

  it("treats every other regex metacharacter as a literal", () => {
    for (const literal of [
      "a+b",
      "a(b)c",
      "a|b",
      "a^b",
      "a$b",
      "a{2}b",
      "a\\b",
      "a]b",
    ]) {
      assert.equal(matchesGlob(literal, literal), true, `${literal} !~ itself`);
    }
  });

  it("does not let a grouped alternation act as a group", () => {
    assert.equal(matchesGlob("(a|b)", "(a|b)"), true);
    assert.equal(matchesGlob("a", "(a|b)"), false);
    assert.equal(matchesGlob("b", "(a|b)"), false);
  });

  it("does not let `+` or `{n}` quantify", () => {
    assert.equal(matchesGlob("aab", "a+b"), false);
    assert.equal(matchesGlob("aab", "a{2}b"), false);
  });

  it("has no backslash escape: `\\` is an ordinary character", () => {
    // fnmatch does not define an escape, so `\*` is a literal backslash
    // followed by a wildcard — not a literal asterisk.
    assert.equal(matchesGlob("\\anything", "\\*"), true);
    assert.equal(matchesGlob("*", "\\*"), false);
    assert.equal(matchesGlob("ab", "a\\b"), false);
  });
});

describe("matchesGlob: character classes", () => {
  it("matches a member of the class", () => {
    assert.equal(matchesGlob("b.ts", "[abc].ts"), true);
    assert.equal(matchesGlob("d.ts", "[abc].ts"), false);
  });

  it("supports ranges", () => {
    assert.equal(matchesGlob("m.ts", "[a-z].ts"), true);
    assert.equal(matchesGlob("M.ts", "[a-z].ts"), false);
  });

  it("negates with a leading `!`", () => {
    assert.equal(matchesGlob("d.ts", "[!abc].ts"), true);
    assert.equal(matchesGlob("a.ts", "[!abc].ts"), false);
    // `^` is NOT the fnmatch negation character; it is an ordinary member.
    assert.equal(matchesGlob("^.ts", "[^abc].ts"), true);
    assert.equal(matchesGlob("d.ts", "[^abc].ts"), false);
  });

  it("takes a `]` in the first member position literally", () => {
    assert.equal(matchesGlob("]", "[]]"), true);
    assert.equal(matchesGlob("a", "[]a]"), true);
    assert.equal(matchesGlob("]", "[]a]"), true);
    assert.equal(matchesGlob("b", "[]a]"), false);
    assert.equal(matchesGlob("]", "[!]a]"), false);
    assert.equal(matchesGlob("b", "[!]a]"), true);
  });

  it("treats an unterminated `[` as a literal `[`", () => {
    assert.equal(matchesGlob("[abc", "[abc"), true);
    assert.equal(matchesGlob("a", "[abc"), false);
    // `[]` never closes (the `]` is consumed as a member), so it is literal.
    assert.equal(matchesGlob("[]", "[]"), true);
    assert.equal(matchesGlob("[!]", "[!]"), true);
  });

  it("keeps regex metacharacters inert inside a class", () => {
    assert.equal(matchesGlob(".", "[.]"), true);
    assert.equal(matchesGlob("a", "[.]"), false);
    assert.equal(matchesGlob("\\", "[\\]"), true);
    assert.equal(matchesGlob("^", "[a^]"), true);
    assert.equal(matchesGlob("-", "[a-]"), true);
    assert.equal(matchesGlob("-", "[-a]"), true);
  });

  it("never matches on an invalid range, and never throws", () => {
    // Python's fnmatch collapses a reversed range to a never-matching group,
    // poisoning the whole pattern. A typo must exempt nothing, not everything.
    assert.equal(matchesGlob("a", "[z-a]"), false);
    assert.equal(matchesGlob("m", "[z-a]"), false);
    assert.equal(matchesGlob("src/[z-a].ts", "src/[z-a].ts"), false);
  });
});

describe("matchesAny", () => {
  it("is false for an empty pattern list", () => {
    assert.equal(matchesAny("src/a.ts", []), false);
  });

  it("is true when any pattern matches", () => {
    const patterns = ["docs/*", "*.generated.ts", "src/vendor/*"];
    assert.equal(matchesAny("src/vendor/lib.ts", patterns), true);
    assert.equal(matchesAny("a.generated.ts", patterns), true);
    assert.equal(matchesAny("src/app.ts", patterns), false);
  });

  it("returns consistent answers when a pattern is reused (cache safety)", () => {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(matchesAny("src/a.ts", ["src/*.ts"]), true);
      assert.equal(matchesAny("test/a.ts", ["src/*.ts"]), false);
    }
  });

  it("stays correct past the pattern cache capacity", () => {
    // The cache clears wholesale when full; a cleared cache must not change
    // an answer, only re-derive it.
    for (let i = 0; i < 600; i += 1) {
      assert.equal(matchesGlob(`f${String(i)}.ts`, `f${String(i)}.ts`), true);
    }
    assert.equal(matchesGlob("src/a.ts", "src/*.ts"), true);
  });
});

describe("suppression markers", () => {
  const line = `const x = eval(src); ${SUPPRESS_LINE_COMMENT}`;
  const block = `const x = eval(src); ${SUPPRESS_BLOCK_COMMENT}`;

  it("accepts both the line and block comment forms", () => {
    assert.equal(lineSuppressed(line), true);
    assert.equal(lineSuppressed(block), true);
  });

  it("allows a trailing reason after the marker", () => {
    assert.equal(
      lineSuppressed(`${SUPPRESS_LINE_COMMENT} reviewed: constant input`),
      true,
    );
  });

  it("rejects every near-miss spelling", () => {
    // The rigidity is deliberate: one greppable spelling, and an exemption
    // that cannot be written by accident.
    for (const near of [
      "const x = 1; //kragg: ignore",
      "const x = 1; // KRAGG: IGNORE",
      "const x = 1; // kragg:ignore",
      "const x = 1; // kragg ignore",
      "const x = 1; # kragg: ignore",
      "const x = 1;",
      "",
    ]) {
      assert.equal(lineSuppressed(near), false, `must not accept: ${near}`);
    }
  });

  it("suppresses on the node's own line", () => {
    assert.equal(suppressed(["a", line, "c"], 2), true);
    assert.equal(suppressed(["a", line, "c"], 1), false);
    assert.equal(suppressed(["a", line, "c"], 3), false);
  });

  it("suppresses when the marker is anywhere in a multi-line span", () => {
    const lines = ["start(", "  arg,", block, ");"];
    assert.equal(suppressed(lines, 1, 4), true);
    assert.equal(suppressed(lines, 1, 2), false);
    assert.equal(suppressed(lines, 4, 4), false);
  });

  it("treats out-of-range lines as not suppressed rather than throwing", () => {
    // Fail closed: a span that disagrees with the file still reports the
    // violation instead of crashing the gate or silently exempting it.
    assert.equal(suppressed([], 1, 5), false);
    assert.equal(suppressed(["a"], 0, 9), false);
    assert.equal(suppressed(["a"], -3), false);
    assert.equal(suppressed([line], 0, 9), true);
  });

  it("tolerates an end line before the start line", () => {
    assert.equal(suppressed(["a", line], 2, 1), true);
  });
});
