import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// version comes from the build (git tag / CI), falling back to package.json
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};
const version = process.env.APP_VERSION?.replace(/^v/, "") || pkg.version;

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  define: { __APP_VERSION__: JSON.stringify(version) },
  // bundle completo: l'immagine runtime non contiene node_modules
  noExternal: [/^(?!node:).*/],
  clean: true,
  minify: process.env.NODE_ENV === "production",
  sourcemap: false,
  splitting: false,
  dts: false,
  banner: {
    // shim per le dipendenze CJS bundlate (esbuild usa `require` come fallback)
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});
