// Bundles the whole extension (src/extension.ts + its import tree + deps like ssh2)
// into a single dist/extension.js, so `vsce package` doesn't ship all of node_modules.
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** ssh2 optionally loads native addons (cpu-features, *.node) in a try/catch.
 *  Keep them external rather than bundling; if they're missing at runtime, ssh2
 *  falls back to pure JS. */
const ignoreNativeAddons = {
  name: "ignore-native-addons",
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }));
    build.onResolve({ filter: /^cpu-features$/ }, () => ({ path: "cpu-features", external: true }));
  },
};

/** In watch mode, print markers so the VS Code background task can tell when a
 *  build starts and finishes (paired with the problemMatcher.background patterns
 *  in .vscode/tasks.json). */
const watchLog = {
  name: "watch-log",
  setup(build) {
    build.onStart(() => console.log("[watch] build started"));
    build.onEnd(() => console.log("[watch] build finished"));
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    format: "cjs",
    platform: "node",
    target: "node18",
    // VS Code injects the `vscode` module at runtime, so keep it out of the bundle.
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
    plugins: watch ? [ignoreNativeAddons, watchLog] : [ignoreNativeAddons],
  });

  if (watch) {
    await ctx.watch();
    console.log("[esbuild] watching...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
