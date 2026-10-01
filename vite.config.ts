import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The build is one self-contained index.html (script, styles and ship catalog inlined), so
// it works from any GitHub Pages URL — user site, project site or custom domain — with no
// base path to configure and nothing else to upload.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: "docs" },
});
