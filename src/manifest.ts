import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { instanceConfigSchema } from "./config.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "mauricioparedes.token-shift",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Token Shift",
  description:
    "Runs selected agents during their configured workday, stopping before the Claude quota reset and preserving quota after their workday ends.",
  author: "Mauricio Paredes",
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
    "instance.settings.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [{
      type: "companySettingsPage",
      id: "agent-selection",
      displayName: "Token Shift Agents",
      exportName: "AgentSelectionPage",
      routePath: "token-shift-agents",
    }],
  },
  instanceConfigSchema,
  jobs: [
    {
      jobKey: "reconcile",
      displayName: "Reconcile agent schedule",
      description: "Pauses or resumes the configured agents according to their workday and the Claude quota reset.",
      schedule: "* * * * *",
    },
  ],
};

export default manifest;
