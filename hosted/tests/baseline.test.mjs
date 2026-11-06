import test from "node:test";
import assert from "node:assert/strict";
import { baseline, validateBaseline, standingFromBaseline, monitorabilityMap, mapForStanding } from "../public/assets/baseline.js";
import { validReviewStanding, freshSession, restoreSession } from "../public/assets/session.js";
import { baselineView, baselineTile, monitorabilityView, provenanceView } from "../public/assets/baseline-view.js";
import { messages } from "../public/assets/i18n.js";
import { artifactOf, contentSha256 } from "../baseline-artifact.mjs";

// Owner-approved expectations (NVDA_PRODUCT_V1, 2026-10-07), pinned here independently of baseline.js.
const FALSIFIERS = ["D1.F1", "D1.F2", "D2.F1", "D3.F1", "D3.F2", "D3.F3", "D4.F1", "D5.F1"];
const WATCHES = ["W1.1", "W1.2", "W1.3", "W1.4", "W2.1", "W2.2", "W3.1", "W3.2", "W3.3", "W3.4", "W4.1", "W5.1", "W5.2"];
const MONITORED = ["W1.1", "W2.1", "W3.1", "W4.1", "W5.1"];
const GAPS = ["W1.2", "W1.3", "W1.4", "W2.2", "W3.2", "W3.3", "W3.4", "W5.2"];
// [review window in quarterly disclosures | null when the approved text states none, signal label]
const WINDOWS = { "D1.F1": [2, null], "D1.F2": [null, null], "D2.F1": [2, null], "D3.F1": [4, null],
  "D3.F2": [null, "mid_weak"], "D3.F3": [null, "weak"], "D4.F1": [2, null], "D5.F1": [2, null] };
const COVERAGE = ["partial", "gap", "partial", "partial", "gap", "gap", "reported_only", "partial"];
const flat = items => items.flatMap(d => d.falsifiers);
const clone = () => structuredClone(baseline);

test("five drivers, eight conditions and thirteen Watch Items with stable, unique, non-colliding IDs", () => {
  assert.equal(validateBaseline(), true);
  assert.deepEqual(baseline.drivers.map(d => d.id), ["D1", "D2", "D3", "D4", "D5"]);
  assert.deepEqual(baseline.drivers.map(d => d.falsifiers.length), [2, 1, 3, 1, 1]);
  assert.deepEqual(baseline.drivers.map(d => d.watchItems.length), [4, 2, 4, 1, 2]);
  assert.deepEqual(flat(baseline.drivers).map(f => f.id), FALSIFIERS);
  assert.deepEqual(baseline.drivers.flatMap(d => d.watchItems.map(w => w.id)), WATCHES);
  assert.deepEqual(baseline.drivers.flatMap(d => d.watchItems.map(w => w.researchNeedId)),
    WATCHES.map(id => id.replace("W", "N")));
  for (const ids of [FALSIFIERS, WATCHES]) assert.equal(new Set(ids).size, ids.length);
  // The legacy collision: a bare "F3" meant competition on main but benchmark leadership in the approved artifact.
  assert.ok(flat(baseline.drivers).every(f => /^D\d\.F\d+$/.test(f.id)), "falsifier IDs carry their driver");
  assert.equal(flat(baseline.drivers).find(f => f.id === "D3.F3").signal, "weak");
});

test("review windows, signal strengths and trigger semantics match the approved artifact", () => {
  for (const f of flat(baseline.drivers)) {
    const [quarters, signal] = WINDOWS[f.id];
    assert.equal(f.reviewQuarters, quarters, `${f.id} review window`);
    assert.equal(f.signal, signal, `${f.id} signal`);
    // The structured window must agree with the sentence the Owner approved, in both languages.
    const word = /\bnext (two|four)\b/.exec(f.condition.en)?.[1];
    assert.equal(word ? { two: 2, four: 4 }[word] : null, quarters);
    assert.equal(/[两四]/.test(f.condition.zh), quarters !== null, `${f.id} Chinese states the window`);
    if (quarters) assert.match(f.condition.zh, quarters === 2 ? /两/ : /四/);
  }
  const by = id => flat(baseline.drivers).find(f => f.id === id).condition;
  // D1: growth DECELERATION plus weaker guidance; never replaced by an absolute decline requirement.
  assert.match(by("D1.F1").en, /Data Center growth slows in both periods and forward guidance or management commentary/);
  assert.doesNotMatch(by("D1.F1").en, /declin|sequential|attributes/i);
  assert.match(by("D1.F1").zh, /增速.*放缓/);
  assert.match(by("D1.F2").en, /idle, is offered for sublease, or is repriced lower/);
  assert.equal(by("D1.F2").zh, "算力在市场上出现闲置、转租或降价。");
  // D2: delay of at least one quarter OR a revenue-impairing supply disruption; no two-consecutive-quarter requirement.
  assert.match(by("D2.F1").en, /delay of at least one quarter .* or supply disruption that materially impairs the revenue outlook/);
  assert.doesNotMatch(by("D2.F1").en, /consecutive/i);
  // D3: distinct identities for the two Owner-labelled signals.
  assert.match(by("D3.F2").en, /Customer-built accelerators establish a structural performance or cost advantage \(mid-weak signal\)\./);
  assert.match(by("D3.F3").en, /NVIDIA no longer leads in third-party evaluation benchmarks \(weak signal\)\./);
  // D4: the original two-quarter direction rule; the newer 5-point threshold is not substituted.
  assert.match(by("D4.F1").en, /GAAP gross margin declines in both periods and NVIDIA guides to continued pressure without a stated recovery path/);
  assert.doesNotMatch(JSON.stringify(baseline.drivers.find(d => d.id === "D4")), /percentage point|5 pp|百分点/);
  // D5: China-specific, two quarters, no "offset by other markets" escape hatch.
  assert.match(by("D5.F1").en, /constraints that prevent commercially meaningful China sales, with no disclosed recovery path/);
  assert.doesNotMatch(by("D5.F1").en, /offset|other markets|new restrictions/i);
  assert.match(baseline.drivers[4].title.en, /especially China/);
  assert.match(baseline.drivers[4].title.zh, /尤其是中国/);
  assert.match(baseline.statement.en, /especially in China/);
  assert.match(baseline.statement.zh, /尤其是中国/);
});

test("Owner-authored additions are present in both languages", () => {
  const driver = id => baseline.drivers.find(d => d.id === id);
  assert.match(driver("D1").coreAssumption.en, /Aggregate demand for AI training and inference compute continues to exceed total market supply\./);
  assert.match(driver("D1").coreAssumption.zh, /AI训练与推理的算力总需求持续超过市场总供给/);
  assert.match(driver("D1").whatToWatch.en, /Token prices and API call volumes/);
  assert.match(driver("D1").whatToWatch.zh, /Token 价格与 API 调用量/);
  assert.match(driver("D2").coreAssumption.en, /CoWoS and HBM are the key constraints, and NVIDIA holds priority allocations in critical production capacity\./);
  assert.match(driver("D2").coreAssumption.zh, /CoWoS 与 HBM.*优先配额/);
  assert.match(driver("D2").whatToWatch.en, /TSMC CoWoS monthly capacity and expansion plans, NVIDIA's share of CoWoS allocations/);
  assert.match(driver("D2").whatToWatch.zh, /台积电 CoWoS 月产能/);
});

test("every Watch Item either reads manual NVIDIA sources or declares an explicit, bilingual monitoring gap", () => {
  const watches = baseline.drivers.flatMap(d => d.watchItems);
  assert.deepEqual(watches.filter(w => w.sourceFamilies.length).map(w => w.id), MONITORED);
  assert.deepEqual(watches.filter(w => !w.sourceFamilies.length).map(w => w.id), GAPS);
  for (const w of watches) {
    assert.equal(Boolean(w.sourceFamilies.length), !w.gapReason, `${w.id}: sources XOR gap reason`);
    if (w.gapReason) assert.ok(w.gapReason.en && w.gapReason.zh);
    assert.ok(w.sourceFamilies.every(f => baseline.families[f]?.intake === "manual"), `${w.id} families are manual`);
    assert.ok(w.title.zh && w.question.zh && w.observationScope.zh);
  }
  // The measures NVIDIA's own documents cannot establish stay visible as gaps, never as covered.
  const gapText = Object.fromEntries(watches.filter(w => w.gapReason).map(w => [w.id, w.gapReason.en]));
  assert.match(gapText["W1.3"], /idle capacity, subleasing or compute rental prices/);
  assert.match(gapText["W1.4"], /Token pricing and API usage/);
  assert.match(gapText["W2.2"], /TSMC capacity or NVIDIA's allocation share/);
  assert.match(gapText["W3.3"], /customer-built accelerator performance and cost/);
  assert.match(gapText["W3.4"], /benchmark leadership/);
  assert.match(gapText["W5.2"], /Official policy and licensing sources/);
});

test("monitorability map: 4 partial, 3 gap, 1 disclosed-only; nothing is automatically monitored", () => {
  const rows = monitorabilityMap(baseline.drivers);
  assert.deepEqual(rows.map(r => r.falsifierId), FALSIFIERS);
  assert.deepEqual(rows.map(r => r.coverage), COVERAGE);
  for (const row of rows) {
    assert.equal(row.incomplete, false);
    assert.equal(row.automaticallyMonitored, false);
    assert.ok(row.watchItems.length);
    // A declared gap never counts as source coverage.
    assert.ok(row.monitoredWatches.every(w => MONITORED.includes(w.id)));
    assert.ok(row.gapWatches.every(w => GAPS.includes(w.id)));
    assert.equal(row.monitoredWatches.length + row.gapWatches.length, row.watchItems.length);
  }
  assert.deepEqual(rows.flatMap(r => r.gapWatches.map(w => w.id)).sort(), [...GAPS].sort());
  // D2 supply-chain observability is an explicit gap again.
  const d2 = rows.find(r => r.falsifierId === "D2.F1");
  assert.equal(d2.coverage, "partial");
  assert.deepEqual(d2.gapWatches.map(w => w.id), ["W2.2"]);
  // The weakest signals have no connected source at all and are not hard falsifiers.
  for (const id of ["D1.F2", "D3.F2", "D3.F3"]) assert.deepEqual(rows.find(r => r.falsifierId === id).sourceIds, []);
  assert.ok(rows.find(r => r.falsifierId === "D4.F1").gapWatches.length === 0);
});

test("mapping failures surface as gaps and never inherit another condition's coverage", () => {
  const drivers = structuredClone(baseline.drivers);
  drivers[0].falsifiers.push({ id: "D1.F9", condition: "Another testable condition", reviewQuarters: null, signal: null, watchIds: ["absent"] });
  drivers[1].watchItems[0].sourceFamilies = ["unconnected_external_family"];
  const before = structuredClone(drivers), rows = monitorabilityMap(drivers);
  assert.deepEqual(drivers, before);
  assert.equal(rows[0].coverage, "partial");
  assert.equal(rows[1].coverage, "gap");
  assert.equal(rows[2].falsifierId, "D1.F9");
  assert.equal(rows[2].coverage, "gap");
  assert.deepEqual(rows[2].missingLinks, ["absent"]);
  assert.equal(rows[3].falsifierId, "D2.F1");
  assert.equal(rows[3].coverage, "gap");
  assert.deepEqual(rows[3].unavailableSources, ["unconnected_external_family"]);
  assert.equal(rows[3].incomplete, true);
});

test("a gap without a stated reason is a broken mapping, not a declared gap", () => {
  const drivers = structuredClone(baseline.drivers);
  drivers[0].watchItems.find(w => w.id === "W1.3").gapReason = null;
  const row = monitorabilityMap(drivers).find(r => r.falsifierId === "D1.F2");
  assert.equal(row.coverage, "gap");
  assert.equal(row.incomplete, true);
});

test("missing falsifier, unbound watch and disabled manual intake are shown as gaps", () => {
  const drivers = structuredClone(baseline.drivers);
  drivers[0].falsifiers = [];
  drivers[3].watchItems[0].sourceFamilies = [];
  const families = Object.fromEntries(Object.entries(baseline.families).map(([id, value]) => [id, { ...value, intake: "unavailable" }]));
  const rows = monitorabilityMap(drivers);
  assert.equal(rows[0].coverage, "gap");
  assert.equal(rows.find(r => r.falsifierId === "D4.F1").coverage, "gap");
  assert.ok(monitorabilityMap(baseline.drivers, families).every(row => row.coverage === "gap" && !row.automaticallyMonitored));
});

test("validateBaseline rejects collisions, undeclared gaps, missing Chinese and forged approval", () => {
  const broken = mutate => { const copy = clone(); mutate(copy); return () => validateBaseline(copy); };
  assert.throws(broken(b => { b.drivers[2].falsifiers[2].id = "D3.F2"; }), /duplicate falsifier id/);
  assert.throws(broken(b => { b.drivers[2].falsifiers[2].id = "F3"; }), /falsifier id F3/);
  assert.throws(broken(b => { b.drivers[0].watchItems[1].id = "W1.1"; }), /duplicate watch id/);
  assert.throws(broken(b => { b.drivers[0].watchItems[2].gapReason = null; }), /needs sources or a gap reason/);
  assert.throws(broken(b => { b.drivers[0].watchItems[0].gapReason = b.drivers[0].watchItems[2].gapReason; }), /needs sources or a gap reason/);
  assert.throws(broken(b => { b.drivers[3].falsifiers[0].watchIds = []; }), /not bound to a falsifier/);
  assert.throws(broken(b => { b.drivers[0].title.zh = ""; }), /English and Chinese/);
  assert.throws(broken(b => { b.drivers[3].falsifiers[0].signal = "hard"; }), /signal/);
  // Approval can never be implied: an approved status needs a receipt bound to this exact hash, and vice versa.
  assert.throws(broken(b => { b.provenance.approval = null; }), /approval receipt/); // approved status, no receipt
  assert.throws(broken(b => { b.provenance.status = "pending_owner_approval"; }), /approval receipt/); // a receipt on a pending status
  assert.throws(broken(b => { b.provenance.approval.contentSha256 = "0".repeat(64); }), /approval receipt/); // a receipt for another hash
  assert.throws(broken(b => { b.provenance.status = "pending_owner_approval"; b.provenance.approval = { contentSha256: "0".repeat(64) }; }), /approval receipt/);
  assert.doesNotThrow(broken(b => { b.provenance.status = "pending_owner_approval"; b.provenance.approval = null; })); // pending needs no receipt
});

// The exact content the Owner approved on 2026-10-15, pinned here independently of baseline.js, the artifact and the ledger.
// A content edit changes this hash, fails the test below, and needs a new approval before it can ship.
const APPROVED_R2 = "634b812149c40bc129221b0ba451e210319fdc17847e1b80a8c91528777150ee";

test("the baseline carries the Owner's receipt for exactly the approved hash and the content claims nothing itself", () => {
  assert.equal(contentSha256(baseline), APPROVED_R2, "the shipped content is exactly what the Owner approved");
  assert.equal(baseline.provenance.contentSha256, APPROVED_R2);
  assert.equal(baseline.provenance.status, "owner_approved");
  assert.equal(baseline.provenance.approval.contentSha256, APPROVED_R2);
  assert.match(baseline.provenance.approval.approvedAt, /^2026-10-15T\d\d:\d\d:\d\dZ$/);
  // Only provenance says "approved"; the artifact's own content never claims it was confirmed.
  assert.doesNotMatch(JSON.stringify(artifactOf(baseline)), /confirmed|owner_approved/i);
  assert.equal(baseline.provenance.approvedArtifact.contentSha256, "aea8c5330daf816e9c29bee59b72aab8b117207ba3d126d3b0d07df59d128876");
  assert.equal(baseline.asOf, "2026-10-07", "approved investment content keeps its historical as-of date");
  assert.equal(baseline.reconciledAt, "2026-10-14");
});

test("the baseline adopts as a valid Standing in both languages, carrying every approved condition", () => {
  for (const lang of ["en", "zh"]) {
    const standing = standingFromBaseline(lang);
    assert.equal(validReviewStanding(standing), true);
    assert.equal(standing.drivers.length, 5);
    assert.equal(standing.falsifiers.length, 8);
    assert.deepEqual(standing.drivers.map(d => d.falsifiers.length), [2, 1, 3, 1, 1]);
    assert.deepEqual(standing.falsifiers, standing.drivers.flatMap(d => d.falsifiers));
    assert.ok(standing.drivers.every(d => d.what_to_watch));
    // The single free-text assumption keeps the approved statement AND the Owner's core assumption.
    for (const [i, d] of baseline.drivers.entries()) {
      assert.ok(standing.drivers[i].statement.includes(d.statement[lang]));
      assert.ok(standing.drivers[i].statement.includes(d.coreAssumption[lang]));
      assert.equal(standing.drivers[i].what_to_watch, d.whatToWatch[lang]);
    }
  }
  // The bounds are five conditions per driver and 25 in total.
  const over = standingFromBaseline("en");
  over.falsifiers = Array.from({ length: 26 }, (_, i) => `Condition number ${i}`);
  assert.equal(validReviewStanding(over), false);
  over.falsifiers = over.falsifiers.slice(0, 25);
  assert.equal(validReviewStanding(over), true);
  over.drivers[0].falsifiers = Array.from({ length: 6 }, (_, i) => `Condition number ${i}`);
  assert.equal(validReviewStanding(over), false);
});

test("only unchanged authored drivers reuse baseline mappings; edited or unrelated NVDA theses expose missing mappings", () => {
  for (const lang of ["en", "zh"]) {
    const standing = standingFromBaseline(lang);
    standing.version = 2;
    standing.statement = "A human revised the overall thesis.";
    standing.drivers = standing.drivers.map(d => Object.fromEntries(Object.entries(d).reverse()));
    assert.deepEqual(mapForStanding(standing).map(r => r.coverage), COVERAGE);
    standing.drivers[0].falsifiers = ["A materially different human condition."];
    const edited = mapForStanding(standing);
    assert.deepEqual(edited.map(r => r.coverage), ["gap", "partial", "partial", "gap", "gap", "reported_only", "partial"]);
    assert.deepEqual(edited[0].watchItems, []);
    // Custom rows were never approved with a window or signal, so the view must not invent one.
    assert.equal(edited[0].windowDeclared, false);
    assert.doesNotMatch(monitorabilityView([edited[0]], lang), /Review window|复核窗口|signal|信号/);
    standing.ticker = "UNRELATED";
    assert.ok(mapForStanding(standing).every(r => r.coverage === "gap"));
  }
});

test("public baseline navigation survives refresh without manufacturing a user workspace", () => {
  const state = freshSession();
  state.view = "baseline";
  const restored = restoreSession(JSON.stringify(state));
  assert.equal(restored.view, "baseline");
  assert.deepEqual(restored.workspaces, []);
});

test("source links and date labels are the original NVIDIA documents with their EDGAR filing dates", () => {
  assert.deepEqual(baseline.sources.map(s => [s.id, s.url, s.publishedAt]), [
    ["NVDA_FY2026_10K", "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm", "2026-02-25"],
    ["NVDA_Q2FY2027_RELEASE", "https://investor.nvidia.com/news/press-release-details/2026/NVIDIA-Announces-Financial-Results-for-Second-Quarter-Fiscal-2027/", "2026-08-26"],
    // EDGAR filingDate for accession 0001045810-26-000075; the 2026-08-27 label on main was the UTC acceptance date.
    ["NVDA_Q2FY2027_10Q", "https://investor.nvidia.com/files/doc_financials/2027/NVDA-2027-Q2-10Q-Final-including-exhibits.pdf", "2026-08-26"],
  ]);
  assert.equal(baseline.evidenceThrough, [...baseline.sources.map(s => s.publishedAt)].sort().at(-1));
  assert.equal(baseline.sources[1].reference.quote, "GAAP and non-GAAP gross margins were both 75.0%.");
});

test("every UI string the baseline view can render has a Chinese counterpart", () => {
  const dynamic = ["Owner-approved baseline", "Pending Owner approval", "Pending Owner approval · read-only", "Owner baseline · read-only",
    "Mid-weak signal", "Weak signal", "Monitoring gap · no source connected", "Not specified in the approved text · Owner to confirm",
    "Next {count} quarterly disclosures", "No listed NVIDIA source can currently observe this condition.",
    "Source", "Reported disclosure", "Forward-looking assumption", "Relevance · for human review", "Falsifier status",
    "Separate from the approved thesis text. It adds no condition and is not part of an adopted Standing Thesis."];
  for (const key of dynamic) assert.ok(messages.zh[key] && messages.zh[key] !== key, `Missing ${key}`);
  assert.equal(Object.hasOwn(messages.zh, "Owner-confirmed baseline"), false, "the old 'confirmed' claim is gone");
});

test("public view shows every condition, Watch Item, gap and the recorded approval in both languages", () => {
  for (const lang of ["en", "zh"]) {
    const html = baselineView(lang, () => "");
    for (const id of [...FALSIFIERS, ...WATCHES]) assert.ok(html.includes(`<strong>${id}</strong>`) || html.includes(`>${id}<`), `${lang} shows ${id}`);
    assert.equal((html.match(/class="monitor-row"/g) || []).length, 8);
    assert.equal((html.match(/class="driver-card"/g) || []).length, 5);
    // 8 gap Watch Items appear once in the driver cards and once in the map.
    assert.equal((html.match(/class="gap-note"/g) || []).length, 16);
    // Each labelled signal shows as a chip once in its driver card and once in the map.
    const chip = label => (html.match(new RegExp(`pill amber">${label}<`, "g")) || []).length;
    assert.equal(chip(lang === "en" ? "Mid-weak signal" : "mid-weak 信号"), 2);
    assert.equal(chip(lang === "en" ? "Weak signal" : "weak 信号"), 2);
    assert.match(html, lang === "en" ? /Owner-approved baseline/ : /Owner 已批准的基线/);
    assert.match(html, lang === "en" ? /The Owner approved this exact content/ : /Owner 已批准这份内容/);
    assert.doesNotMatch(html, /Pending Owner approval|待 Owner 批准|Owner-confirmed|Owner 已确认/);
    assert.match(html, /2026-10-07/);
    assert.match(html, /2026-10-14/);
    assert.match(html, /2026-08-26/);
    assert.doesNotMatch(html, /2026-08-27/);
    assert.match(html, /75\.0%/);
    assert.ok(html.includes(baseline.provenance.contentSha256));
    assert.ok(html.includes(baseline.provenance.approvedArtifact.contentSha256));
    assert.match(html, lang === "en" ? /no source is automatically monitored/ : /没有任何来源正在被自动监控/);
    assert.match(html, lang === "en" ? /Cannot independently verify/ : /不能独立验证的事实/);
    assert.match(html, lang === "en" ? /Not specified in the approved text · Owner to confirm/ : /批准文本中未指定 · 待 Owner 确认/);
    assert.match(html, lang === "en" ? /Next 4 quarterly disclosures/ : /未来 4 次季度披露/);
  }
});

test("approval status is rendered from the recorded status only", () => {
  const approved = provenanceView("en"), pending = provenanceView("en", { ...baseline.provenance, status: "pending_owner_approval", approval: null });
  assert.match(approved, /The Owner approved this exact content/);
  assert.doesNotMatch(approved, /pending Owner approval/);
  assert.match(pending, /pending Owner approval/);
  assert.doesNotMatch(pending, /The Owner approved this exact content/);
  assert.match(baselineTile("en"), /7 of 8 falsifiers have monitoring gaps/);
  assert.match(baselineTile("zh"), /8 条 falsifier 中有 7 条存在监控盲区/);
  assert.match(baselineTile("en"), /Owner baseline · read-only/);
  assert.match(baselineTile("zh"), /Owner 基线 · 只读/);
  assert.doesNotMatch(baselineTile("en") + baselineTile("zh"), /Pending Owner approval|待 Owner 批准/);
});

// Pinned here, independent of baseline.js: the notice wording the Owner asked for, and the primary-source sentence.
const NOT_ADVICE = { en: "This NVIDIA baseline is not a stock valuation or a buy/sell recommendation.", zh: "此 NVIDIA 基准不是股票估值，也不构成买入或卖出建议。" };
const CHINA_QUOTE = "NVIDIA is not assuming any Data Center compute revenue from China in its outlook.";
const EXHIBIT_URL = "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000073/q2fy27pr.htm";

test("the no-valuation notice is separate from the approved statement and never part of an adopted Standing", () => {
  assert.deepEqual(baseline.notices.map(n => n.id), ["NOT_ADVICE"]);
  assert.deepEqual(baseline.notices[0].text, NOT_ADVICE);
  for (const lang of ["en", "zh"]) {
    // Restoring the caveat must not edit the approved investment statement.
    // `\bvaluation\b` on purpose: the approved D3.F3 says "third-party evaluation benchmarks", which contains "valuation".
    assert.doesNotMatch(baseline.statement[lang], /buy\/sell|\bvaluation\b|买入|估值/);
    assert.equal(standingFromBaseline(lang).statement, baseline.statement[lang]);
    assert.doesNotMatch(JSON.stringify(standingFromBaseline(lang)), /buy\/sell|\bvaluation\b|买入或卖出|股票估值/);
    assert.equal(baselineTile(lang).split(NOT_ADVICE[lang]).length, 2, `${lang} tile shows the notice once`);
    assert.equal(baselineView(lang, () => "").split(NOT_ADVICE[lang]).length, 2, `${lang} page shows the notice once`);
  }
});

test("the D5 China context note keeps the disclosure, the assumption, the relevance and the falsifier status apart", () => {
  assert.equal(baseline.contextNotes.length, 1);
  const [note] = baseline.contextNotes;
  assert.deepEqual([note.id, note.driverId, note.falsifierIds, note.watchIds, note.sourceId, note.publishedAt],
    ["CTX.D5.1", "D5", ["D5.F1"], ["W5.1", "W5.2"], "NVDA_Q2FY2027_RELEASE", "2026-08-26"]);
  assert.equal(note.citation.url, EXHIBIT_URL);
  assert.deepEqual(note.parts.map(p => p.kind), ["reported_disclosure", "forward_looking_assumption", "relevance_for_review", "falsifier_status"]);
  // Only the disclosure carries a primary-source quotation, and it is exactly NVIDIA's sentence.
  assert.deepEqual(note.parts.filter(p => "quote" in p).map(p => p.kind), ["reported_disclosure"]);
  assert.equal(note.parts[0].quote, CHINA_QUOTE);
  const text = kind => note.parts.find(p => p.kind === kind).text;
  assert.match(text("reported_disclosure").en, /On 2026-08-26 .*\(Form 8-K, Exhibit 99\.1\)/);
  assert.match(text("reported_disclosure").zh, /2026-08-26/);
  // An outlook assumption is not a reported result, and the release gives no licensing, export-control or recovery statement.
  assert.match(text("forward_looking_assumption").en, /planning assumption for the third quarter of fiscal 2027, not a reported result/);
  assert.match(text("forward_looking_assumption").en, /does not mention export controls or licensing, and does not discuss a recovery path/);
  assert.match(text("relevance_for_review").en, /may weaken it/);
  assert.match(text("relevance_for_review").en, /its weight is a human judgment/);
  // Neither falsified nor confirmed.
  assert.match(text("falsifier_status").en, /D5\.F1 is not recorded as triggered/);
  assert.match(text("falsifier_status").en, /nothing here confirms D5: later disclosures have not been checked/);
  assert.match(text("falsifier_status").en, /\(W5\.2\) remains a monitoring gap/);
  assert.match(text("falsifier_status").zh, /D5\.F1 未被记录为已触发/);
  assert.match(text("falsifier_status").zh, /不能证实 D5/);
  for (const part of note.parts) assert.doesNotMatch(part.text.en, /has been falsified|is falsified|has triggered|is triggered|thesis (is|remains) (valid|intact)/i);
  // The conditional hypothesis and its falsifier are exactly as approved, and the note is not part of any adopted Standing.
  assert.equal(baseline.drivers[4].falsifiers[0].condition.en,
    "Across the next two quarterly disclosures, NVIDIA reports regulatory or licensing constraints that prevent commercially meaningful China sales, with no disclosed recovery path.");
  assert.equal(baseline.drivers[4].falsifiers[0].reviewQuarters, 2);
  for (const lang of ["en", "zh"]) assert.doesNotMatch(JSON.stringify(standingFromBaseline(lang)), /Data Center compute revenue|CTX\.D5/);
  // The reading list is unchanged: the note adds a citation, not a source or a monitored family.
  assert.equal(baseline.sources.length, 3);
  assert.equal(monitorabilityMap(baseline.drivers).find(r => r.falsifierId === "D5.F1").coverage, "partial");
});

test("the context note renders once, inside D5, as read-only context with a dated citation", () => {
  for (const lang of ["en", "zh"]) {
    const html = baselineView(lang, () => "");
    const cards = html.split('<article class="driver-card">').slice(1);
    assert.equal(cards.length, 5);
    assert.deepEqual(cards.map(card => card.includes('class="context-note"')), [false, false, false, false, true]);
    const note = /<aside class="context-note"[\s\S]*?<\/aside>/.exec(html)[0];
    assert.equal((html.match(/class="context-note"/g) || []).length, 1);
    assert.ok(note.includes(`<blockquote>${CHINA_QUOTE}</blockquote>`));
    assert.ok(note.includes(`href="${EXHIBIT_URL}" target="_blank" rel="noopener noreferrer"`));
    assert.ok(note.includes("2026-08-26") && note.includes('href="#NVDA_Q2FY2027_RELEASE"'));
    assert.equal((note.match(/<dt>/g) || []).length, 4);
    assert.doesNotMatch(note, /<button|data-action/, "read-only: nothing to press");
    assert.match(note, lang === "en" ? /Owner-approved baseline/ : /Owner 已批准的基线/);
    assert.doesNotMatch(note, /Pending Owner approval|待 Owner 批准/);
    for (const heading of ["Reported disclosure", "Forward-looking assumption", "Relevance · for human review", "Falsifier status"])
      assert.ok(note.includes(`<dt>${messages[lang][heading]}`), `${lang} heading ${heading}`);
    // The tile on the home list does not carry the note; it only points into the baseline.
    assert.doesNotMatch(baselineTile(lang), /context-note/);
  }
});

test("validateBaseline rejects invented references, off-source citations, mixed roles and missing notices", () => {
  const broken = mutate => { const copy = clone(); mutate(copy); return () => validateBaseline(copy); };
  assert.throws(broken(b => { b.contextNotes[0].driverId = "D9"; }), /context note CTX\.D5\.1/);
  assert.throws(broken(b => { b.contextNotes[0].sourceId = "NOPE"; }), /context note CTX\.D5\.1/);
  assert.throws(broken(b => { b.contextNotes[0].falsifierIds = ["D4.F1"]; }), /references/);
  assert.throws(broken(b => { b.contextNotes[0].watchIds = ["W9.9"]; }), /references/);
  assert.throws(broken(b => { b.contextNotes[0].citation.url = "https://example.com/q2fy27pr.htm"; }), /citation/);
  assert.throws(broken(b => { b.contextNotes[0].citation.url = "http://www.sec.gov/Archives/x"; }), /citation/);
  assert.throws(broken(b => { b.contextNotes[0].publishedAt = "2026-09-01"; }), /citation/);
  assert.throws(broken(b => { b.contextNotes[0].parts[1].kind = "reported_disclosure"; }), /duplicate part role/);
  assert.throws(broken(b => { b.contextNotes[0].parts[0].kind = "verdict"; }), /parts/);
  assert.throws(broken(b => { b.contextNotes[0].parts[0].quote = "  "; }), /parts/);
  assert.throws(broken(b => { b.contextNotes[0].parts[2].text.zh = ""; }), /English and Chinese/);
  assert.throws(broken(b => { b.contextNotes.push(structuredClone(b.contextNotes[0])); }), /duplicate context note id/);
  assert.throws(broken(b => { b.notices = []; }), /notices/);
  assert.throws(broken(b => { b.notices[0].text.zh = ""; }), /English and Chinese/);
  assert.throws(broken(b => { b.notices.push(structuredClone(b.notices[0])); }), /duplicate notice id/);
  assert.doesNotThrow(broken(b => { b.contextNotes = []; }));
});
