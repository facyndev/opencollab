import fs from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  esbuildPlugins: [
    {
      name: "svg-base64",
      setup(build) {
        build.onLoad({ filter: /\.svg$/ }, async (args) => {
          const buffer = await fs.promises.readFile(args.path);
          const base64 = buffer.toString("base64");
          return {
            contents: `export default "data:image/svg+xml;base64,${base64}";`,
            loader: "js",
          };
        });
      },
    },
  ],
  loader: {
    ".png": "dataurl",
  },
});
