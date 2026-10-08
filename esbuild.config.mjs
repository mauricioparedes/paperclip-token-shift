import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets();
await Promise.all([build(presets.esbuild.worker), build(presets.esbuild.manifest)]);
