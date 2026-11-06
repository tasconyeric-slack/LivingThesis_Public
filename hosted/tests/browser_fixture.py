"""Loopback-only synthetic model fixture. Excluded from deployment."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api.index import app
from hosted import service
from hosted.models import Structure, Assessment

os.environ["DEEPSEEK_API_KEY"] = "synthetic-browser-test-key"


async def synthetic_json(prompt, context, schema):
    zh = context.get("output_language") == "zh"
    if schema is Structure:
        return Structure.model_validate({"statement": context["statement"],
            "drivers": [{"driver_id": f"D{i}", "title": title,
                         "statement": statement, "falsifiers": [falsifier], "what_to_watch": watch}
                        for i, (title, statement, falsifier, watch) in enumerate([
                            ("需求持续性", "需求需要支持增长假设。", "需求持续收缩。", "可比口径的已报告需求。") if zh else ("Demand durability", "Demand must support the growth thesis.", "Sustained demand contraction.", "Comparable reported demand."),
                            ("执行时间表", "产品时间表需要支持投资逻辑。", "已宣布的时间表推迟。", "下一次产品时间表更新。") if zh else ("Execution timing", "The product timetable must support the thesis.", "An announced timetable delay.", "Next product timetable update."),
                            ("利润率持续性", "利润率应与投资假设保持一致。", "利润率持续收缩。", "可比口径的已报告利润率。") if zh else ("Margin durability", "Margins must remain consistent with the thesis.", "Sustained margin contraction.", "Comparable reported margins.")], 1)],
            "falsifiers": ["需求收缩或产品时间表推迟。" if zh else "Demand contracts or the product timetable slips."]})
    quote = context["evidence"]["source_text"]
    if "unrelated" in context["evidence"]["information"].lower() or "under review" in quote.lower():
        relevant = "unrelated" not in context["evidence"]["information"].lower()
        return Assessment.model_validate({"relevant": relevant, "relation": "unresolved",
            "reasoning": "该观察尚不足以确定投资逻辑受到的影响。" if zh else "The observation does not establish a directional thesis impact.", "driver_impacts": [],
            "what_changed": ["尚未确定对驱动因素的方向性影响。" if zh else "No directional driver impact has been established."],
            "proposed_change": {"action": "hold_unresolved" if relevant else "no_change", "reason": "没有得到证据支持的修改。" if zh else "No supported revision."},
            "what_to_watch": ["进一步关注时间表证据。" if zh else "Further evidence on the timetable."]})
    return Assessment.model_validate({"relevant": True, "relation": "weaken",
        "reasoning": "合成来源报告了影响执行时间表的延迟。" if zh else "The synthetic source reports a delay affecting execution timing.",
        "driver_impacts": [{"driver_id": "D2", "relation": "weaken", "reasoning": "已披露的执行时间表推迟。" if zh else "The stated schedule moved later.", "exact_quote": quote}],
        "what_changed": ["合成示例的执行时间表推迟。", "需求和利润率假设保留。"] if zh else ["The synthetic timetable has moved later.", "Demand and margin assumptions are retained."],
        "proposed_change": {"action": "revise", "revised_statement": "增长依赖持续需求和利润率，但执行时间表需要推迟。" if any("\u4e00" <= c <= "\u9fff" for c in context["standing"]["statement"]) else "Growth depends on durable demand and margins, with later execution timing.", "reason": "执行时间表已改变。" if zh else "The execution timetable changed."},
        "what_to_watch": ["下一次时间表更新。" if zh else "Next timetable update."]})


service.model_json = synthetic_json

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]))
