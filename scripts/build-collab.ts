import esbuild from "esbuild";
import path from "path";

async function main() {
  await esbuild.build({
    entryPoints: [path.resolve(__dirname, "../collab/server.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.resolve(__dirname, "../dist/collab/server.js"),
    sourcemap: "inline",
    banner: {
      js: 'const import_meta_url = typeof __filename !== "undefined" ? require("url").pathToFileURL(__filename).href : "file:///opt/collab/server.js";',
    },
    define: {
      "import.meta.url": "import_meta_url",
    },
  });
  console.log("Collab bundle built successfully to dist/collab/server.js");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
