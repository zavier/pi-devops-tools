import { describe, it, expect } from "vitest";
import { createSessionAutoApprove } from "../state/mutation-approval";

describe("createSessionAutoApprove（会话级免确认开关）", () => {
  it("默认关闭", () => {
    expect(createSessionAutoApprove().enabled).toBe(false);
  });

  it("setEnabled 切换状态", () => {
    const approval = createSessionAutoApprove();
    approval.setEnabled(true);
    expect(approval.enabled).toBe(true);
    approval.setEnabled(false);
    expect(approval.enabled).toBe(false);
  });

  it("reset 回到关闭（会话边界复位）", () => {
    const approval = createSessionAutoApprove();
    approval.setEnabled(true);
    approval.reset();
    expect(approval.enabled).toBe(false);
  });

  it("实例之间互不影响", () => {
    const a = createSessionAutoApprove();
    const b = createSessionAutoApprove();
    a.setEnabled(true);
    expect(a.enabled).toBe(true);
    expect(b.enabled).toBe(false);
  });
});
