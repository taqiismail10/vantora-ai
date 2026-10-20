/**
 * The copilot answer leaves the provider layer decorated in markdown and is
 * shown as plain text. These cases pin the exact stripping contract.
 */

import { describe, expect, it } from "vitest";

import { plainCopilotText } from "../ask";

describe("plainCopilotText", () => {
  it("removes ATX heading markers but keeps the heading text", () => {
    expect(plainCopilotText("### Summary\nRecovery plan cost $1,369.88.")).toBe(
      "Summary\nRecovery plan cost $1,369.88.",
    );
  });

  it("keeps a numbered heading when the marker is stripped", () => {
    expect(plainCopilotText("## 1. Overview")).toBe("1. Overview");
  });

  it("does not touch a '#12' style reference", () => {
    expect(plainCopilotText("See invoice #12 on the schedule.")).toBe("See invoice #12 on the schedule.");
  });

  it("unwraps bold and single-star emphasis", () => {
    expect(plainCopilotText("The **plan cost** is $1,369.88, of which *$688* is risk.")).toBe(
      "The plan cost is $1,369.88, of which $688 is risk.",
    );
  });

  it("leaves multiplication-style asterisks next to word characters alone", () => {
    expect(plainCopilotText("a*2+b*3 and 5 * 6")).toBe("a*2+b*3 and 5 * 6");
  });

  it("converts star bullets to hyphen bullets, keeping the indent", () => {
    expect(plainCopilotText("  * Payroll day 11\n* File locks day 9")).toBe(
      "  - Payroll day 11\n- File locks day 9",
    );
  });

  it("drops fenced-code lines and keeps fenced content, leaving whitespace untouched", () => {
    expect(plainCopilotText("```text\nrun_recovery_optimization\n```")).toBe("run_recovery_optimization\n");
  });

  it("unwraps inline code ticks without harming underscores", () => {
    expect(plainCopilotText("`run_recovery_optimization` priced the levers.")).toBe(
      "run_recovery_optimization priced the levers.",
    );
  });

  it("is idempotent, so deterministic answers (already plain) pass through unchanged", () => {
    const clean = [
      "How short are we? Cash bottoms at -$1,150 on day 12.",
      "Options:", 
      "- Collect the Horizon invoice at a 1.5% discount.",
    ].join("\n");
    expect(plainCopilotText(clean)).toBe(clean);
    expect(plainCopilotText(plainCopilotText("## **Summary**\n*x*"))).toBe(plainCopilotText("## **Summary**\n*x*"));
  });

  it("handles the empty string", () => {
    expect(plainCopilotText("")).toBe("");
  });
});
