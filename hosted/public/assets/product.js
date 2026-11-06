// Pure product state transitions, shared by the UI and behavior tests.
export function demoAssessment(data, event) {
  if (event === "irrelevant")
    return {
      relevant: false,
      relation: "unresolved",
      driver_impacts: [],
      reasoning:
        data.explanations?.irrelevant_reasoning ||
        "An office furniture timetable does not address any of the four investment drivers.",
      what_changed: data.explanations?.irrelevant_changes || [
        "No investment assumption changed. No research was repeated.",
      ],
      proposed_change: {
        action: "no_change",
        revised_statement: null,
        reason: data.explanations?.irrelevant_reason || "No relevant evidence.",
      },
      what_to_watch: data.standing.drivers.map((d) => d.what_to_watch),
    };
  if (event !== "rubin") throw new Error("Unknown demo event");
  const result = data.rubin_assessment;
  return {
    relevant: true,
    relation: result.relation,
    reasoning: result.reasoning,
    driver_impacts: result.driver_impacts.map((i) => ({
      driver_id: i.driver_id,
      relation: i.relation,
      reasoning: i.reasoning,
      exact_quote: i.claims[0].citation.exact_quote,
    })),
    what_changed: data.explanations?.rubin_changes || [
      "The synthetic Rubin timetable moved from September to December.",
      "The prior execution schedule is contradicted. Revenue durability, EPS expectations and China access receive no new evidence.",
      "Only the two Rubin research questions are revisited. The other four are retained.",
    ],
    proposed_change: result.proposed_change,
    what_to_watch: result.what_to_watch,
  };
}

export function applyDemoDecision(
  standing,
  assessment,
  action,
  editedStatement,
) {
  if (!["accept", "edit", "reject", "keep_unresolved"].includes(action))
    throw new Error("Choose a human decision");
  const updated = structuredClone(standing);
  if (action === "reject" || action === "keep_unresolved")
    return { standing: updated, changed: false, decision: action };
  if (!assessment.relevant || assessment.proposed_change.action !== "revise")
    throw new Error("No suggested revision");
  const next =
    action === "edit"
      ? editedStatement?.trim()
      : assessment.proposed_change.revised_statement;
  if (!next || next.length < 10 || next.length > 2000)
    throw new Error("Enter a thesis between 10 and 2,000 characters");
  const changed = next !== standing.statement;
  if (changed) {
    updated.statement = next;
    updated.version += 1;
  }
  return { standing: updated, changed, decision: action };
}

export const decisionLabels = {
  accept: "Accept",
  edit: "Edit",
  reject: "Reject",
  keep_unresolved: "Keep unresolved",
};
export function freshState() {
  return { mode: "landing", stage: "define", history: [] };
}

// Authored synthetic artifacts, selected once when a demo workspace starts.
// Source text, exact citations, IDs and diagnostics are copied from the original.
export function localizeDemo(data, overlay) {
  const result = structuredClone(data);
  result.standing.statement = overlay.statement;
  result.standing.falsifiers = structuredClone(overlay.falsifiers);
  result.standing.drivers.forEach((driver, i) => {
    for (const key of ["title", "statement", "falsifiers", "what_to_watch"])
      driver[key] = structuredClone(overlay.drivers[i][key]);
  });
  for (const event of ["irrelevant", "rubin"])
    for (const key of ["information", "source"])
      result.events[event][key] = overlay.events[event][key];
  result.rubin_assessment.reasoning = overlay.reasoning;
  result.rubin_assessment.driver_impacts[0].reasoning =
    overlay.driver_reasoning;
  result.rubin_assessment.proposed_change = structuredClone(
    overlay.proposed_change,
  );
  result.rubin_assessment.what_to_watch = structuredClone(
    overlay.what_to_watch,
  );
  result.accepted_statement = overlay.proposed_change.revised_statement;
  result.explanations = structuredClone(overlay.explanations);
  return result;
}
