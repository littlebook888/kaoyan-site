#!/usr/bin/env python3
"""Build the gene-expression-regulation question bank from the supplied Word file."""

from __future__ import annotations

import json
import random
import re
from pathlib import Path

from docx import Document
from PIL import Image


SOURCE_DOCX = Path("/Users/ray/Downloads/生化_基因表达调控_学成选择题_修订版.docx")
MIND_MAPS = {
    1: Path("/Users/ray/Downloads/生物化学思维导图 11.jpg"),
    2: Path("/Users/ray/Downloads/生物化学思维导图 12.jpg"),
    3: Path("/Users/ray/Downloads/生物化学思维导图 13.jpg"),
}
OUTPUT = Path("src/data/biochemistry-lecture19-data.json")
IMAGE_DIR = Path("public/biochemistry/lecture-pages")
LECTURE_NUMBER = 19
TITLE = "生化 基因表达调控"
TOPIC = "核酸"

GROUP_RE = re.compile(r"^第\s*(\d+)\s*组[：:]\s*(.+)$")
ANSWER_GROUP_RE = re.compile(r"^第\s*(\d+)\s*组$")
NUMBERED_RE = re.compile(r"^(\d+)[.．]\s*(.+)$")
OPTION_RE = re.compile(r"^([A-Z])[.．]\s*(.+)$")

EXPECTED_GROUPS = 10
EXPECTED_STEMS = 60

# The source Word intentionally groups related facts into a few long options.
# Groups 6 and 7 are easier to answer cleanly when those compound statements
# are presented as independent choices.  Answers inherit every fragment from
# the original correct option, so splitting never changes the tested fact.
OPTION_SPLITS = {
    6: {
        "A": ["富含谷氨酰胺结构域", "与 GC 盒结合"],
        "B": ["二聚化结构域"],
        "D": ["酸性激活结构域", "与 TFⅡD 相互作用，协助组装转录起始复合物"],
        "F": ["富含脯氨酸结构域", "与 CAAT 盒结合"],
    },
    7: {
        "D": ["属于转录激活因子", "结合增强子", "只在特定时间、特定组织被诱导"],
        "I": ["RNApol Ⅰ、Ⅱ、Ⅲ对应不同类型的启动子", "对应的通用转录因子为 TFⅠ、TFⅡ、TFⅢ"],
    },
}


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\u3000", " ")).strip()


def parse_docx() -> list[dict]:
    if not SOURCE_DOCX.is_file():
        raise FileNotFoundError(f"Missing supplied Word file: {SOURCE_DOCX}")

    lines = [normalize(paragraph.text) for paragraph in Document(SOURCE_DOCX).paragraphs]
    lines = [line for line in lines if line]
    try:
        answer_index = lines.index("答案")
    except ValueError as error:
        raise ValueError("The supplied Word file has no 答案 section") from error

    question_lines = lines[:answer_index]
    answer_lines = lines[answer_index + 1 :]
    answers: dict[int, dict[int, list[str]]] = {}
    current_answer_group: int | None = None
    for line in answer_lines:
        group_match = ANSWER_GROUP_RE.match(line)
        if group_match:
            current_answer_group = int(group_match.group(1))
            answers[current_answer_group] = {}
            continue
        item_match = NUMBERED_RE.match(line)
        if current_answer_group is None or not item_match:
            continue
        letters = re.findall(r"[A-Z]", item_match.group(2))
        if not letters:
            raise ValueError(f"No answer letters found in: {line}")
        answers[current_answer_group][int(item_match.group(1))] = letters

    groups: list[dict] = []
    current: dict | None = None
    mode = ""
    for line in question_lines:
        group_match = GROUP_RE.match(line)
        if group_match:
            current = {
                "source_index": int(group_match.group(1)),
                "title": group_match.group(2).strip(),
                "stems": [],
                "options": [],
            }
            groups.append(current)
            mode = ""
            continue
        if current is None:
            continue
        if line == "题干":
            mode = "stems"
            continue
        if line == "选项池":
            mode = "options"
            continue
        if mode == "stems":
            item_match = NUMBERED_RE.match(line)
            if item_match:
                current["stems"].append((int(item_match.group(1)), item_match.group(2).strip()))
        elif mode == "options":
            option_match = OPTION_RE.match(line)
            if option_match:
                current["options"].append((option_match.group(1), option_match.group(2).strip()))

    if len(groups) != EXPECTED_GROUPS:
        raise ValueError(f"Expected {EXPECTED_GROUPS} groups, found {len(groups)}")
    if sum(len(group["stems"]) for group in groups) != EXPECTED_STEMS:
        raise ValueError("The supplied Word file no longer contains the expected 60 stems")

    for expected_index, group in enumerate(groups, 1):
        source_index = group["source_index"]
        if source_index != expected_index:
            raise ValueError(f"Expected source group {expected_index}, found {source_index}")
        option_map = dict(group["options"])
        group_answers = answers.get(source_index, {})
        stem_numbers = {number for number, _ in group["stems"]}
        if set(group_answers) != stem_numbers:
            raise ValueError(f"Group {source_index}: question and answer numbers do not match")
        for number, letters in group_answers.items():
            missing = [letter for letter in letters if letter not in option_map]
            if missing:
                raise ValueError(f"Group {source_index} stem {number}: unknown options {missing}")
        group["answers"] = group_answers

    return groups


def fit_width(image: Image.Image, max_width: int = 2200) -> Image.Image:
    image = image.convert("RGB")
    if image.width <= max_width:
        return image
    height = round(image.height * max_width / image.width)
    return image.resize((max_width, height), Image.Resampling.LANCZOS)


def build_lecture_images() -> None:
    for page, source in MIND_MAPS.items():
        if not source.is_file():
            raise FileNotFoundError(f"Missing supplied mind map: {source}")
        with Image.open(source) as image:
            prepared = fit_width(image)
        output = IMAGE_DIR / f"lecture-19-page-{page:02d}.webp"
        output.parent.mkdir(parents=True, exist_ok=True)
        prepared.save(output, "WEBP", quality=88, method=6, exact=True)


def lecture_evidence(source_group: int) -> dict:
    mapping = {
        1: (3, "思维导图第 276 页", "基因表达的时空特异性、管家基因、诱导基因及各调控层次。"),
        2: (1, "思维导图第 273 页", "乳糖操纵子的调节基因、调控序列与结构基因。"),
        3: (1, "思维导图第 273 页", "乳糖操纵子的负性、正性及葡萄糖-乳糖协同调节。"),
        4: (1, "思维导图第 273 页", "色氨酸操纵子的阻遏粗调与衰减精调。"),
        5: (2, "思维导图第 274 页", "真核启动子、增强子、沉默子与绝缘子。"),
        6: (2, "思维导图第 274 页", "转录因子的 DNA 结合、转录激活及蛋白互作结构域。"),
        7: (2, "思维导图第 274 页", "通用、上游、激活、抑制及可诱导转录因子。"),
        8: (2, "思维导图第 274 页", "RNApolⅡ结合启动子所需的转录因子、中介子与 TAF。"),
        9: (2, "思维导图第 274 页", "RNApolⅡ转录起始复合体的装配顺序与进入延长阶段。"),
        10: (2, "思维导图第 274 页", "miRNA、siRNA、RISC 与转录后基因沉默。"),
    }
    image_page, page_title, description = mapping[source_group]
    return {
        "lectureId": "lecture-19",
        "lectureNumber": LECTURE_NUMBER,
        "lectureTitle": TITLE,
        "page": image_page,
        "image": f"biochemistry/lecture-pages/lecture-19-page-{image_page:02d}.webp",
        "title": f"第 19 讲《{TITLE}》· {page_title}",
        "description": f"{description} 点击可查看对应思维导图。",
        "method": "以用户提供的修订版 Word 为题干、选项和答案依据，并与对应思维导图逐项核对。",
    }


def build_group(source_group: dict, display_index: int) -> dict:
    original_options = dict(source_group["options"])
    split_map = OPTION_SPLITS.get(source_group["source_index"], {})
    expanded_options = {
        key: split_map.get(key, [label])
        for key, label in source_group["options"]
    }
    labels = [
        fragment
        for key, _ in source_group["options"]
        for fragment in expanded_options[key]
    ]
    if len(labels) != len(set(labels)):
        raise ValueError(f"Group {source_group['source_index']} contains duplicate option text")
    if len(labels) > 26:
        raise ValueError(f"Group {source_group['source_index']} has more than 26 options")

    shuffled = labels.copy()
    random.Random(30600 + LECTURE_NUMBER * 100 + source_group["source_index"]).shuffle(shuffled)
    if shuffled == labels and len(shuffled) > 1:
        shuffled = shuffled[1:] + shuffled[:1]
    key_for = {label: chr(65 + position) for position, label in enumerate(shuffled)}

    stems = []
    for number, text in source_group["stems"]:
        answer_labels = [
            fragment
            for key in source_group["answers"][number]
            for fragment in expanded_options[key]
        ]
        answer = [key_for[label] for label in answer_labels]
        stems.append(
            {
                "number": number,
                "text": text.replace("（多选）", "").strip(),
                "answerRaw": "、".join(answer),
                "answer": answer,
                "answerMode": "多选" if len(answer) > 1 else "单选",
            }
        )

    return {
        "id": f"bio-19-{display_index:02d}",
        "page": display_index,
        "title": source_group["title"],
        "kind": "B",
        "kindLabel": "B型题",
        "options": [
            {"key": chr(65 + position), "label": label}
            for position, label in enumerate(shuffled)
        ],
        "stems": stems,
        "sourceText": f"《生化_基因表达调控_学成选择题_修订版》原第 {source_group['source_index']} 组",
        "reviewState": "已按修订版 Word 与对应思维导图核对",
        "reviewIssues": [],
        "reviewNotes": [
            "题干、选项和答案按 Word 原文录入；网页选项顺序重新打散。"
            + (" 复合选项已拆分为独立知识点，答案同步重映射。" if split_map else "")
        ],
        "topic": TOPIC,
        "lectureIds": ["lecture-19"],
        "optionShuffleVersion": 2 if split_map else 1,
        "lectureEvidence": lecture_evidence(source_group["source_index"]),
    }


def main() -> None:
    source_groups = parse_docx()
    build_lecture_images()
    groups = [build_group(group, index) for index, group in enumerate(source_groups, 1)]
    payload = {
        "meta": {
            "title": "生物化学第 19 讲题库",
            "sourceLabel": "《生化_基因表达调控_学成选择题_修订版》",
            "sourcePages": 8,
            "lectureCount": 1,
            "groupCount": len(groups),
            "stemCount": sum(len(group["stems"]) for group in groups),
            "correctionGroupCount": 0,
            "generatedBy": "scripts/build_biochemistry_lecture19.py",
            "siteIntegrated": True,
            "lectureLinked": True,
            "answerNote": "完整收录修订版 Word 的 10 组 60 个题干；题干、选项和答案均以 Word 为准，网页选项已重新打散，并逐组关联对应思维导图。",
        },
        "topics": ["全部", TOPIC, "综合"],
        "pages": [
            {"page": group["page"], "image": "", "topic": TOPIC, "searchText": group["title"]}
            for group in groups
        ],
        "groups": groups,
        "lectures": [{"id": "lecture-19", "number": LECTURE_NUMBER, "title": TITLE, "pageCount": 3}],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
