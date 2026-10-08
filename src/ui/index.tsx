import { useEffect, useState } from "react";
import { useHostContext, useHostNavigation, usePluginAction, usePluginData, type PluginCompanySettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import type { AgentSelectionData } from "../agent-selection.js";

export function AgentSettingsLink() {
  const { companyId } = useHostContext();
  const navigation = useHostNavigation();
  if (!companyId) return null;
  return <a {...navigation.linkProps("../../token-shift-agents")}>Token Shift Agents</a>;
}

export function AgentSelectionPage({ context }: PluginCompanySettingsPageProps) {
  if (!context.companyId) return <p>Select a company to choose its agents.</p>;
  return <CompanyAgentSelection key={context.companyId} companyId={context.companyId} />;
}

function CompanyAgentSelection({ companyId }: { companyId: string }) {
  const { data, loading, error, refresh } = usePluginData<AgentSelectionData>("agent-selection", { companyId });
  const save = usePluginAction("save-agent-selection");
  if (error) return <div role="alert">Could not load agents: {error.message} <button onClick={refresh}>Retry</button></div>;
  if (loading || !data || data.companyId !== companyId) return <p role="status">Loading agents…</p>;
  return <AgentSelectionForm data={data} refresh={refresh} save={async (agentIds) => {
    const result = await save({ companyId, agentIds }) as AgentSelectionData;
    refresh();
    return result;
  }} />;
}

interface FormProps {
  data: AgentSelectionData;
  refresh: () => void;
  save: (agentIds: string[]) => Promise<AgentSelectionData>;
}

export function AgentSelectionForm({ data, refresh, save }: FormProps) {
  const [selected, setSelected] = useState(data.agentIds);
  const [baseline, setBaseline] = useState(data.agentIds);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setSelected(data.agentIds);
    setBaseline(data.agentIds);
  }, [data.agentIds]);
  const dirty = selected.length !== baseline.length || selected.some((id) => !baseline.includes(id));
  const query = search.trim().toLocaleLowerCase();
  const visible = data.agents.filter((agent) => agent.name.toLocaleLowerCase().includes(query));
  const missing = selected.filter((id) => !data.agents.some((agent) => agent.id === id));
  const names = new Map<string, number>();
  for (const agent of data.agents) names.set(agent.name, (names.get(agent.name) ?? 0) + 1);

  function toggle(id: string, checked: boolean) {
    setSelected((ids) => checked ? [...ids, id] : ids.filter((value) => value !== id));
    setMessage("");
    setError("");
  }

  async function submit() {
    setSaving(true);
    setMessage("");
    setError("");
    try {
      const saved = await save(selected);
      setSelected(saved.agentIds);
      setBaseline(saved.agentIds);
      setMessage("Agent selection saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : (cause as { message?: string })?.message ?? "Could not save agent selection.");
    } finally {
      setSaving(false);
    }
  }

  return <section style={{ maxWidth: 720, display: "grid", gap: 16 }}>
    <div>
      <h2>Token Shift Agents</h2>
      <p>Choose the agents that follow your Agent Work Day schedule. Saving an empty selection stops managing agents.</p>
    </div>
    <label style={{ display: "grid", gap: 6 }}>
      Search agents by name
      <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents…" />
    </label>
    <p>{selected.length} selected</p>
    <fieldset disabled={saving} style={{ border: "1px solid var(--border, #888)", borderRadius: 8, padding: 16 }}>
      <legend>Agents</legend>
      {data.agents.length === 0 && <p>No agents in this company.</p>}
      {data.agents.length > 0 && visible.length === 0 && <p>No agents match your search.</p>}
      {visible.map((agent) => <label key={agent.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
        <input type="checkbox" checked={selected.includes(agent.id)}
          disabled={!agent.selectable && !selected.includes(agent.id)}
          onChange={(event) => toggle(agent.id, event.target.checked)} />
        <span>
          <strong>{agent.name}</strong> <span>({agent.role} · {agent.status})</span>
          {(names.get(agent.name) ?? 0) > 1 && <small style={{ display: "block" }}>ID: {agent.id}</small>}
          {!agent.selectable && <small style={{ display: "block" }}>Unavailable; remove from selection before saving.</small>}
        </span>
      </label>)}
      {missing.map((id) => <label key={id} style={{ display: "flex", gap: 12, padding: "10px 0" }}>
        <input type="checkbox" checked onChange={() => toggle(id, false)} />
        <span>Unavailable agent ({id}) — uncheck to remove</span>
      </label>)}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <div style={{ display: "flex", gap: 12 }}>
      <button disabled={saving} onClick={submit}>{saving ? "Saving…" : "Save agent selection"}</button>
      <button disabled={saving} onClick={() => {
        setSelected(baseline);
        setError("");
        setMessage("");
        refresh();
      }}>{dirty ? "Discard changes and refresh" : "Refresh agents"}</button>
    </div>
    {dirty && <p>Unsaved changes</p>}
  </section>;
}
