import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "c2c.token-shift",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Token Shift",
  description:
    "Pauses selected agents during the workday and lets them run overnight, stopping before the Claude quota reset so the next workday starts with a fresh allowance.",
  author: "C2C",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "agents.read",
    "agents.pause",
    "agents.resume",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema,
  jobs: [
    {
      jobKey: "reconcile",
      displayName: "Reconcile agent schedule",
      description: "Pauses or resumes the configured agents according to the workday and the Claude quota reset.",
      schedule: "* * * * *",
    },
  ],
};

export default manifest;
