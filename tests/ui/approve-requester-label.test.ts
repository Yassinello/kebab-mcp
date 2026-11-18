import { describe, it, expect } from "vitest";
import { requesterLabel } from "../../app/approve/[id]/requester-label";

describe("approval page — requester label", () => {
  it("names an unnamed key as an AI client", () => {
    expect(requesterLabel("be05be07")).toBe("An AI client (key be05be07)");
  });
  it("keeps a device name as is", () => {
    expect(requesterLabel("Claude on my laptop")).toBe("Claude on my laptop");
  });
});
