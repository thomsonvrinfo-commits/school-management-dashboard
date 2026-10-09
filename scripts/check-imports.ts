/**
 * Static check that needs no installed dependencies: every relative import resolves to a real file, and every
 * package a workspace imports is declared in that workspace's package.json (or is a Node built-in / sibling workspace).
 * Run: npm run check:imports
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workspaces = ["apps/web", "apps/api", "packages/domain", "packages/contracts", "packages/sync", "packages/db"];
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const problems: string[] = [];
let files = 0;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

for (const ws of workspaces) {
  const pkg = JSON.parse(readFileSync(join(root, ws, "package.json"), "utf8"));
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  for (const file of walk(join(root, ws))) {
    files += 1;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2])!;
      const where = `${relative(root, file)}: "${spec}"`;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        if (!existsSync(target) && !existsSync(`${target}.ts`) && !existsSync(`${target}.tsx`)) problems.push(`${where} does not resolve to a file`);
        if (!/\.(ts|tsx|css|json)$/.test(spec)) problems.push(`${where} is missing its file extension`);
        continue;
      }
      if (builtins.has(spec) || spec.startsWith("node:") || spec.startsWith("virtual:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (!declared.has(name)) problems.push(`${where} is not declared in ${ws}/package.json`);
    }
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`OK: ${files} source files, all relative imports resolve and all packages are declared.`);
