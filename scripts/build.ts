import { join } from "node:path";

const repo = join(import.meta.dir, "..");

/**
 * Bundles a host's view entry (Mirador's by default) into `<outdir>/view.js`: one ES module with React and the styles
 * inside, since Mirador's canvas frame loads nothing from the network.
 *
 * Mirador loads the view into a sandboxed frame with an opaque origin, where WebKit hides the message of every error
 * the view throws. So view.js only holds the bundle as text and runs it from a blob: URL of the frame's own, whose
 * errors say what they are (the same trick as in neo-manuscript).
 */
export async function buildView(outdir: string, entry = join(repo, "hosts", "mirador", "view.tsx")) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: process.env.SPECTRA_MINIFY !== "0",
    splitting: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new Error(`Building the view failed:\n${result.logs.join("\n")}`);
  if (result.outputs.length !== 1) throw new Error(`Expected one output file, got ${result.outputs.map((output) => output.path).join(", ")}`);
  const bundle = await result.outputs[0]!.text();
  const loader = `const code = ${JSON.stringify(bundle)};\nimport(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));\n`;
  const path = join(outdir, "view.js");
  await Bun.write(path, loader);
  return { path, size: loader.length };
}

if (import.meta.main) {
  const output = await buildView(join(repo, "dist"));
  console.log(`${output.path}: ${(output.size / 1024).toFixed(0)} KB`);
}
