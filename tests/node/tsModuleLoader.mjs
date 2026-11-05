import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

export function createTsModuleLoader(overrides = {}) {
  const cache = new Map();
  const load = source => {
    const filename = path.resolve(source);
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} }; cache.set(filename, module.exports);
    const localRequire = createRequire(filename);
    const require = name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(filename), name);
        for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
          if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate)) return load(candidate);
        }
      }
      return localRequire(name);
    };
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), { fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
    new Function("exports", "module", "require", compiled)(module.exports, module, require);
    return module.exports;
  };
  return load;
}
