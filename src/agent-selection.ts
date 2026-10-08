export interface AgentOption {
  id: string;
  name: string;
  role: string;
  status: string;
  selectable: boolean;
}

export interface AgentSelectionData {
  companyId: string;
  agents: AgentOption[];
  agentIds: string[];
  source: "selection" | "config";
}
