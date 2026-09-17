#!/usr/bin/env node
/**
 * Site checks for the portfolio.
 *
 * Deliberately dependency-free (plain Node, no install step) so CI stays fast
 * and there is no lockfile to keep current for a ten-file static site.
 *
 * Run: node scripts/check-site.mjs
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "index.html");

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);

const html = readFileSync(HTML, "utf8");

/* ------------------------------------------------------------------ *
 * Minimal HTML tag scanner
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/** Yield { tag, attrs, line, selfClosing } for every start/end tag. */
function* tags(src) {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, closing, tag, rawAttrs, selfClose] = m;
    const line = src.slice(0, m.index).split("\n").length;
    const attrs = {};
    for (const a of rawAttrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    yield { tag: tag.toLowerCase(), closing: closing === "/", attrs, line, selfClosing: selfClose === "/" };
  }
}

const allTags = [...tags(html)];
const startTags = allTags.filter((t) => !t.closing);

/* ------------------------------------------------------------------ *
 * 1. Tag balance
 * ------------------------------------------------------------------ */

{
  const stack = [];
  for (const t of allTags) {
    if (t.closing) {
      const open = stack.pop();
      if (!open) fail(`line ${t.line}: stray </${t.tag}>`);
      else if (open.tag !== t.tag)
        fail(`line ${t.line}: </${t.tag}> does not match <${open.tag}> opened on line ${open.line}`);
    } else if (!VOID_TAGS.has(t.tag) && !t.selfClosing) {
      stack.push(t);
    }
  }
  for (const t of stack) fail(`line ${t.line}: <${t.tag}> is never closed`);
}

/* ------------------------------------------------------------------ *
 * 2. Duplicate IDs
 * ------------------------------------------------------------------ */

{
  const seen = new Map();
  for (const t of startTags) {
    const id = t.attrs.id;
    if (!id) continue;
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, n] of seen) if (n > 1) fail(`duplicate id "${id}" (${n} occurrences)`);
}

/* ------------------------------------------------------------------ *
 * 3. Heading outline — no skipped levels, exactly one h1
 * ------------------------------------------------------------------ */

{
  const headings = startTags
    .filter((t) => /^h[1-6]$/.test(t.tag))
    .map((t) => ({ level: Number(t.tag[1]), line: t.line }));

  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length !== 1) fail(`expected exactly one <h1>, found ${h1s.length}`);

  let prev = 0;
  for (const h of headings) {
    if (prev && h.level > prev + 1)
      fail(`line ${h.line}: <h${h.level}> skips a level after <h${prev}>`);
    prev = h.level;
  }
}

/* ------------------------------------------------------------------ *
 * 4. Images — alt text, intrinsic dimensions, and files that exist
 * ------------------------------------------------------------------ */

const LOCAL_RE = /^(?!https?:|mailto:|data:|#|\/\/)(.+)$/;

/** Expand a srcset attribute into its individual candidate URLs. */
function srcsetUrls(value) {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

{
  const imgs = startTags.filter((t) => t.tag === "img");
  if (imgs.length === 0) fail("no <img> elements found — did the markup change?");

  for (const img of imgs) {
    const where = `line ${img.line} <img src="${img.attrs.src || "(none)"}">`;

    if (!("alt" in img.attrs)) fail(`${where}: missing alt attribute`);
    if (!img.attrs.width || !img.attrs.height)
      fail(`${where}: missing width/height (causes layout shift)`);

    for (const url of srcsetUrls(img.attrs.srcset ?? "")) {
      const local = url.match(LOCAL_RE);
      if (local && !existsSync(join(ROOT, local[1])))
        fail(`${where}: srcset candidate "${url}" does not exist`);
    }

    const src = img.attrs.src;
    if (src) {
      const local = src.match(LOCAL_RE);
      if (local && !existsSync(join(ROOT, local[1])))
        fail(`${where}: file "${src}" does not exist`);
    }
  }

  // <picture> sources and <link>/<meta> image hints
  for (const t of startTags) {
    if (t.tag === "source" && "srcset" in t.attrs) {
      for (const url of srcsetUrls(t.attrs.srcset)) {
        const local = url.match(LOCAL_RE);
        if (local && !existsSync(join(ROOT, local[1])))
          fail(`line ${t.line} <source>: candidate "${url}" does not exist`);
      }
    }
    if (t.tag === "link" && t.attrs.rel === "preload") {
      for (const url of srcsetUrls(t.attrs.imagesrcset ?? "")) {
        const local = url.match(LOCAL_RE);
        if (local && !existsSync(join(ROOT, local[1])))
          fail(`line ${t.line} <link rel=preload>: candidate "${url}" does not exist`);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 5. Every internal anchor points at a real id
 * ------------------------------------------------------------------ */

{
  const ids = new Set(startTags.map((t) => t.attrs.id).filter(Boolean));
  for (const t of startTags) {
    if (t.tag !== "a") continue;
    const href = t.attrs.href ?? "";
    if (!href.startsWith("#") || href === "#") {
      if (href === "#") fail(`line ${t.line}: <a href="#"> placeholder link`);
      continue;
    }
    if (!ids.has(href.slice(1)))
      fail(`line ${t.line}: anchor "${href}" has no matching id`);
  }
}

/* ------------------------------------------------------------------ *
 * 6. Other local files referenced by the page actually exist
 * ------------------------------------------------------------------ */

{
  for (const t of startTags) {
    for (const attr of ["href", "src"]) {
      const v = t.attrs[attr];
      if (!v) continue;
      const local = v.match(LOCAL_RE);
      if (!local) continue;
      const clean = local[1].split(/[?#]/)[0];
      if (!clean || clean.endsWith("/")) continue;
      if (!existsSync(join(ROOT, clean)))
        fail(`line ${t.line}: <${t.tag} ${attr}="${v}"> points at a missing file`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 7. External <script> tags must carry SRI
 * ------------------------------------------------------------------ */

{
  for (const t of startTags) {
    if (t.tag !== "script" || !t.attrs.src) continue;
    if (!/^https?:/.test(t.attrs.src)) continue;
    if (!t.attrs.integrity || !t.attrs.crossorigin)
      fail(
        `line ${t.line}: external script "${t.attrs.src}" is missing integrity/crossorigin`,
      );
  }
}

/* ------------------------------------------------------------------ *
 * 8. Performance budget
 * ------------------------------------------------------------------ */

const BUDGETS = [
  { file: "index.html", max: 120 * 1024, label: "HTML (with inline CSS + JS)" },
  { file: "og-preview.png", max: 120 * 1024, label: "social preview" },
];

for (const b of BUDGETS) {
  const p = join(ROOT, b.file);
  if (!existsSync(p)) continue;
  const size = statSync(p).size;
  if (size > b.max)
    fail(`${b.file} is ${(size / 1024).toFixed(0)} KB, over the ${b.max / 1024} KB budget (${b.label})`);
}

// No single raster asset should be oversized for how it is displayed.
{
  const rasterBudget = 80 * 1024;
  const raster = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(png|jpe?g|webp|avif|gif)$/i.test(entry) && !entry.startsWith("og-")) raster.push(p);
    }
  };
  walk(join(ROOT, "assets"));
  for (const p of raster) {
    const size = statSync(p).size;
    if (size > rasterBudget)
      fail(
        `${p.replace(ROOT + "/", "")} is ${(size / 1024).toFixed(0)} KB — over the ${rasterBudget / 1024} KB per-image budget. Resize to its display size and convert to WebP.`,
      );
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

if (warnings.length) {
  console.log("Warnings:");
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log("");
}

if (failures.length) {
  console.error(`FAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}

console.log("PASS — structure, assets, headings and budgets all check out.");
