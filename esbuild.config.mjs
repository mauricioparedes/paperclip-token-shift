import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
await Promise.all([build(presets.esbuild.worker), build(presets.esbuild.manifest), build(presets.esbuild.ui)]);
