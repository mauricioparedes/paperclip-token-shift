// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentSelectionForm } from "../src/ui/index.js";
import type { AgentSelectionData } from "../src/agent-selection.js";

afterEach(cleanup);

const data: AgentSelectionData = {
  companyId: "co_1", agentIds: ["a1"], source: "config",
  agents: [
    { id: "a1", name: "Alice", role: "engineer", status: "idle", selectable: true },
    { id: "a2", name: "Bob", role: "designer", status: "paused", selectable: true },
    { id: "a3", name: "Bob", role: "engineer", status: "terminated", selectable: false },
  ],
};

describe("agent name selection UI", () => {
  it("searches by name while preserving hidden selections and saves IDs", async () => {
    const save = vi.fn(async (agentIds: string[]) => ({ ...data, agentIds, source: "selection" as const }));
    render(<AgentSelectionForm data={data} refresh={vi.fn()} save={save} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bOB" } });
    expect(screen.queryByText("Alice")).toBeNull();
    expect(screen.getByText("ID: a2")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Bob.*designer/ }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Bob.*terminated/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save agent selection" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(["a1", "a2"]));
    expect(await screen.findByText("Agent selection saved.")).toBeTruthy();
  });

  it("allows clearing the complete selection", async () => {
    const save = vi.fn(async (agentIds: string[]) => ({ ...data, agentIds }));
    render(<AgentSelectionForm data={data} refresh={vi.fn()} save={save} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Alice/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save agent selection" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith([]));
  });

  it("retains edits and displays bridge errors when saving fails", async () => {
    const save = vi.fn().mockRejectedValue({ message: "Agent no longer available" });
    const refresh = vi.fn();
    render(<AgentSelectionForm data={data} refresh={refresh} save={save} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Bob.*designer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save agent selection" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Agent no longer available");
    expect((screen.getByRole("checkbox", { name: /Bob.*designer/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes and refresh" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect((screen.getByRole("checkbox", { name: /Bob.*designer/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("allows removing missing agents and shows empty search results", () => {
    render(<AgentSelectionForm data={{ ...data, agentIds: ["missing"] }} refresh={vi.fn()} save={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Unavailable agent/ }));
    expect(screen.getByText("0 selected")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Nobody" } });
    expect(screen.getByText("No agents match your search.")).toBeTruthy();
  });
});
