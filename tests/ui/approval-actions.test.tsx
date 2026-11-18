/**
 * @vitest-environment jsdom
 */
/**
 * /approve buttons: an outgoing message is only unlocked ("Approved."),
 * a kebab_config settings change is applied at once ("Applied. You can go
 * back to your conversation.") or shows why it was not.
 */
import "../components/setup";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalActions } from "../../app/approve/[id]/approval-actions";

const base = { id: "a".repeat(32), sig: "b".repeat(64), tenant: null, minutesLeft: 12 };

function respond(status: number, body: Record<string, unknown>) {
  vi.mocked(globalThis.fetch).mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe("ApprovalActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("outgoing message: unchanged wording, approved then sent by the assistant", async () => {
    respond(200, { ok: true, status: "approved" });
    render(<ApprovalActions {...base} status="pending" />);
    fireEvent.click(screen.getByText("Approve and allow sending"));
    await waitFor(() => expect(screen.getByText("Approved.")).toBeTruthy());
    expect(screen.getByText(/tell the assistant it is approved/)).toBeTruthy();
  });

  it("settings change: applied right away", async () => {
    respond(200, { ok: true, status: "applied", message: "Instance settings updated." });
    render(<ApprovalActions {...base} status="pending" kind="config" />);
    fireEvent.click(screen.getByText("Approve and apply"));
    await waitFor(() =>
      expect(screen.getByText("Applied. You can go back to your conversation.")).toBeTruthy()
    );
  });

  it("settings change: shows why it could not be applied", async () => {
    respond(422, { ok: false, error: "apply_failed", message: 'No AI client with id "x".' });
    render(<ApprovalActions {...base} status="pending" kind="config" />);
    fireEvent.click(screen.getByText("Approve and apply"));
    await waitFor(() => expect(screen.getByText(/Not applied: No AI client/)).toBeTruthy());
  });

  it("settings change: reject says nothing changed", async () => {
    respond(200, { ok: true, status: "rejected" });
    render(<ApprovalActions {...base} status="pending" kind="config" />);
    fireEvent.click(screen.getByText("Reject"));
    await waitFor(() => expect(screen.getByText("Rejected — nothing changed.")).toBeTruthy());
  });
});
