#!/usr/bin/env python3
"""Validate the lecture-25 bone tumor question bank."""

from __future__ import annotations

from collections import Counter
import json
import re
from pathlib import Path


EXPECTED_SOURCE_ANSWERS = {
    "bone-tumor-g01": [set("ACEGIKM"), set("BDFHJLNO")],
    "bone-tumor-g02": [set("C"), set("AEGH"), set("B"), set("F"), set("D")],
    "bone-tumor-g03": [
        {"N1", "P2", "L1", "F18", "T7"},
        {"F5", "F6", "F11", "F14", "F19"},
        {"N3", "P3", "L3", "F1", "F9", "T3", "T6", "T11", "T13"},
        {"N2", "N5", "P2", "L2", "F12", "T8", "T14"},
        {"N2", "P1", "L4", "F3", "F13", "T5"},
        {"N1", "L5", "F8", "T2"},
        {"N2", "L6", "F8", "F14", "T2"},
        {"N2", "P4", "F10", "T12"},
        {"N2", "L7", "F2", "F21", "T2"},
        {"N1", "L8", "F22", "T2"},
        {"N1", "N6", "L9", "F4", "F20", "T10"},
        {"N4", "P5", "L1", "F7", "T4"},
        {"N4", "P2", "L1", "F16", "T9"},
        {"N4", "F17", "T1"},
    ],
}

CATEGORIES = ["性质", "好发人群", "好发部位", "影像、症状与病理特点", "治疗"]
CATEGORY_COUNTS = {"性质": 6, "好发人群": 5, "好发部位": 9, "影像、症状与病理特点": 22, "治疗": 14}


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    path = root / "src/data/surgery-bone-tumor-data.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    groups = payload["groups"]

    assert len(groups) == 3
    assert sum(len(group["stems"]) for group in groups) == 21
    assert sum(len(group["options"]) for group in groups) == 79
    assert [group["id"] for group in groups] == list(EXPECTED_SOURCE_ANSWERS)
    assert payload["meta"]["lecturePagesReviewed"] == list(range(1, 9))

    for group in groups:
        assert group["topic"] == "骨科"
        assert group["lectureIds"] == ["lecture-25"]
        assert group["reviewState"] == "已完成讲义校对"
        assert not group["reviewIssues"] and not group["reviewNotes"]
        assert group["hideSource"] is True
        assert group["optionShuffleVersion"] == (4 if group["id"] == "bone-tumor-g03" else 3)

        option_keys = [option["key"] for option in group["options"]]
        source_keys = [option["sourceKey"] for option in group["options"]]
        assert len(option_keys) == len(set(option_keys))
        assert len(source_keys) == len(set(source_keys))
        assert source_keys != group["optionOriginalOrder"], f"{group['id']}: options remain in source order"
        assert set(source_keys) == set(group["optionOriginalOrder"])

        display_to_source = {option["key"]: option["sourceKey"] for option in group["options"]}
        semantic_answers = [
            {display_to_source[key] for key in stem["answer"]}
            for stem in group["stems"]
        ]
        assert semantic_answers == EXPECTED_SOURCE_ANSWERS[group["id"]], f"{group['id']}: answer remapping drift"
        for stem in group["stems"]:
            assert stem["answer"]
            assert set(stem["answer"]) <= set(option_keys)

        evidence = group["lectureEvidence"]
        assert evidence["lectureId"] == "lecture-25"
        assert evidence["page"] in {1, "1～3"}
        assert (root / "public" / evidence["image"]).exists(), f"{group['id']}: missing lecture image"

        values = [group["title"], group["sourceText"]]
        values.extend(option["label"] for option in group["options"])
        values.extend(stem["text"] for stem in group["stems"])
        assert not any(re.search(r"\s{2,}|[|•“”‘’]", value) for value in values), f"{group['id']}: punctuation or spacing issue"

    group3 = groups[2]
    category_order = list(dict.fromkeys(option["category"] for option in group3["options"]))
    assert category_order == CATEGORIES
    assert Counter(option["category"] for option in group3["options"]) == Counter(CATEGORY_COUNTS)
    assert all("category" not in option for group in groups[:2] for option in group["options"])
    assert all("category" in option for option in group3["options"])
    duplicate_labels = [label for label, count in Counter(option["label"] for option in group3["options"]).items() if count > 1]
    assert duplicate_labels == []

    labels = [option["label"] for option in group3["options"]]
    assert "肿瘤样病变" in labels
    assert "好发人群" in CATEGORIES and "好发部位" in CATEGORIES
    assert any("Codman三角" in label and "ALP" in label for label in labels)
    assert any("地舒单抗" in label for label in labels)
    assert any("阿司匹林" in label for label in labels)
    group2 = groups[1]
    biopsy = next(option for option in group2["options"] if option["sourceKey"] == "C")
    assert biopsy["label"] == "活检"
    assert any(biopsy["key"] in stem["answer"] for stem in group2["stems"] if stem["text"] == "骨肿瘤确诊金标准")
    nature_keys = {option["key"] for option in group3["options"] if option["category"] == "性质"}
    for stem in group3["stems"]:
        if stem["text"] != "骨软骨瘤：恶变提示":
            assert set(stem["answer"]) & nature_keys, f"{stem['text']}: missing tumor nature"
    print({"groups": 3, "stems": 21, "options": 79, "categorized_options": 56, "status": "ok"})


if __name__ == "__main__":
    main()
