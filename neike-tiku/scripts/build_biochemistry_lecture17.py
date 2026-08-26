#!/usr/bin/env python3
"""Build the checked transcription-and-regulation question bank payload."""

from __future__ import annotations

import json
import random
import re
from pathlib import Path

from docx import Document
from PIL import Image


SOURCE = Path("/Users/ray/Downloads/生化_转录及调控_学成选择题.docx")
MIND_MAPS = {
    1: Path("/Users/ray/Downloads/生物化学思维导图 8.jpg"),
    2: Path("/Users/ray/Downloads/生物化学思维导图 9.jpg"),
}
OUTPUT = Path("src/data/biochemistry-lecture17-data.json")
IMAGE_DIR = Path("public/biochemistry/lecture-pages")
LECTURE_NUMBER = 17
TITLE = "生化 转录及调控"
TOPIC = "核酸"
GROUP_RE = re.compile(r"^第\s*(\d+)\s*组[:：]\s*(.+)$")
ANSWER_GROUP_RE = re.compile(r"^第\s*(\d+)\s*组$")
QUESTION_RE = re.compile(r"^(\d+)\.\s*(.+)$")
OPTION_RE = re.compile(r"^([A-Z])\.\s*(.+)$")
ANSWER_RE = re.compile(r"^(\d+)\.\s*([A-Z](?:、[A-Z])*)$")

# Fixed against the DOCX, the refined biochemistry compendium (pp. 139–148),
# and the two supplied mind maps. Group 6 question 1 adds the 5′ trimming step
# that is explicitly present in the refined lecture but omitted from the DOCX key.
EXPECTED_ANSWER_KEYS = {
    1: {1: "CDEGLOQTU", 2: "ABGHJKNPRS", 3: "HI", 4: "FM"},
    2: {1: "F", 2: "DJ", 3: "C", 4: "G", 5: "EK", 6: "BL", 7: "AI", 8: "HM"},
    3: {1: "CD", 2: "AE", 3: "I", 4: "J", 5: "BFGHKLM", 6: "OPST", 7: "NQRS"},
    4: {1: "ADGLP", 2: "BCFMN", 3: "BEHIJKO"},
    5: {1: "CDFG", 2: "AIKLM", 3: "BEHP", 4: "JQR", 5: "NO"},
    6: {1: "ADEFGHI", 2: "CJKLM", 3: "BD", 4: "C", 5: "NPQ", 6: "NOQ"},
    7: {1: "BD", 2: "A", 3: "CE", 4: "FGHI", 5: "JNO", 6: "K", 7: "L", 8: "M"},
    8: {1: "B", 2: "D", 3: "DK", 4: "F", 5: "E", 6: "H", 7: "G", 8: "C", 9: "A", 10: "J", 11: "I"},
}


def parse_workbook():
    document = Document(SOURCE)
    groups = []
    current = None
    mode = ""
    answer_group = None

    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        if text == "答案":
            mode = "answers"
            continue
        if mode == "answers":
            group_match = ANSWER_GROUP_RE.match(text)
            if group_match:
                answer_group = int(group_match.group(1))
                continue
            answer_match = ANSWER_RE.match(text)
            if answer_group is not None and answer_match:
                number = int(answer_match.group(1))
                groups[answer_group - 1]["answers"][number] = list(answer_match.group(2).replace("、", ""))
            continue

        group_match = GROUP_RE.match(text)
        if group_match:
            current = {
                "source_index": int(group_match.group(1)),
                "title": group_match.group(2).strip(),
                "stems": [],
                "options": [],
                "answers": {},
            }
            groups.append(current)
            mode = ""
            continue
        if current is None:
            continue
        if text in {"题干", "选项池"}:
            mode = "stems" if text == "题干" else "options"
            continue
        if mode == "stems":
            question_match = QUESTION_RE.match(text)
            if question_match:
                current["stems"].append((int(question_match.group(1)), question_match.group(2).strip()))
        elif mode == "options":
            option_match = OPTION_RE.match(text)
            if option_match:
                current["options"].append((option_match.group(1), option_match.group(2).strip()))

    if len(groups) != 8:
        raise ValueError(f"Expected 8 groups, found {len(groups)}")
    for group in groups:
        expected_numbers = {number for number, _ in group["stems"]}
        if set(group["answers"]) != expected_numbers:
            raise ValueError(f"Group {group['source_index']}: question and answer keys do not match")
        checked = EXPECTED_ANSWER_KEYS[group["source_index"]]
        imported = {number: "".join(answer) for number, answer in group["answers"].items()}
        # Apply the single lecture-backed correction while requiring every other
        # imported answer to remain exactly as supplied.
        if group["source_index"] == 6:
            imported[1] = checked[1]
            group["answers"][1] = list(checked[1])
        if imported != checked:
            raise ValueError(f"Group {group['source_index']}: answer key differs from checked import")
        option_map = dict(group["options"])
        if not all(set(answer).issubset(option_map) for answer in group["answers"].values()):
            raise ValueError(f"Group {group['source_index']}: answer has an unknown option")

        # The poly(A) tail participates specifically in translation initiation.
        # Keep the supplied option position and answer key, but use the precise
        # lecture wording instead of the overly broad "参与翻译过程".
        if group["source_index"] == 5:
            group["options"] = [
                (key, "参与翻译的起始过程" if label == "参与翻译过程" else label)
                for key, label in group["options"]
            ]
    return groups


def fit_width(image: Image.Image, max_width: int = 2200):
    if image.width <= max_width:
        return image.convert("RGB")
    height = round(image.height * max_width / image.width)
    return image.convert("RGB").resize((max_width, height), Image.Resampling.LANCZOS)


def save_webp(image: Image.Image, output: Path):
    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, "WEBP", quality=88, method=6, exact=True)


def build_lecture_images():
    pages = {}
    for page, source in MIND_MAPS.items():
        if not source.is_file():
            raise FileNotFoundError(f"Missing supplied mind map: {source}")
        with Image.open(source) as image:
            pages[page] = fit_width(image)
        save_webp(pages[page], IMAGE_DIR / f"lecture-17-page-{page:02d}.webp")

    width = max(image.width for image in pages.values())
    gap = 24
    height = sum(image.height for image in pages.values()) + gap
    combined = Image.new("RGB", (width, height), "white")
    y = 0
    for page in (1, 2):
        image = pages[page]
        combined.paste(image, ((width - image.width) // 2, y))
        y += image.height + gap
    save_webp(combined, IMAGE_DIR / "lecture-17-page-01-02.webp")


def evidence(source_group):
    mapping = {
        1: ("01", "思维导图第 273 页", "模板链、编码链、原料、方向及转录不对称性。"),
        2: ("01", "思维导图第 273 页", "原核 RNA 聚合酶各亚基、核心酶与全酶。"),
        3: ("01", "思维导图第 273 页", "原核转录起始、延长及两类终止机制。"),
        4: ("02", "思维导图第 274 页", "真核 RNA 聚合酶 I、II、III 的敏感性与产物。"),
        5: ("02", "思维导图第 274 页", "前体 mRNA 的加帽、加尾、剪接、编辑及选择性剪接。"),
        6: ("02", "思维导图第 274 页", "前体 tRNA、rRNA 加工及自身剪接内含子。"),
        7: ("02", "思维导图第 274 页", "RNA 干扰与真核 mRNA 质量监控。"),
        8: ("01-02", "思维导图第 273–274 页", "原核启动与终止序列、真核加尾及剪接边界。"),
    }
    image_page, page_title, description = mapping[source_group]
    return {
        "lectureId": "lecture-17",
        "lectureNumber": LECTURE_NUMBER,
        "lectureTitle": TITLE,
        "page": source_group,
        "image": f"biochemistry/lecture-pages/lecture-17-page-{image_page}.webp",
        "title": f"第 17 讲《{TITLE}》· {page_title}",
        "description": f"{description} 点击可查看对应思维导图。",
        "method": "以《精编版》生化合集第 139–148 页为主，结合转录讲义与思维导图逐项复核。",
    }


def make_group(source_group, display_index):
    original = dict(source_group["options"])
    labels = list(original.values())
    shuffled = labels.copy()
    random.Random(30600 + LECTURE_NUMBER * 100 + source_group["source_index"]).shuffle(shuffled)
    if shuffled == labels and len(shuffled) > 1:
        shuffled = shuffled[1:] + shuffled[:1]
    output_keys = {label: chr(65 + index) for index, label in enumerate(shuffled)}
    stems = []
    for number, text in source_group["stems"]:
        answers = [output_keys[original[key]] for key in source_group["answers"][number]]
        stems.append({
            "number": number,
            "text": text.replace("（多选）", "").rstrip(),
            "answerRaw": "、".join(answers),
            "answer": answers,
            "answerMode": "多选" if len(answers) > 1 else "单选",
        })
    review_notes = []
    if source_group["source_index"] == 6:
        review_notes.append("第 1 题补入前体 tRNA 加工中的 5′端多余核苷酸切除。")
    return {
        "id": f"bio-17-{display_index:02d}",
        "page": display_index,
        "title": source_group["title"],
        "kind": "B",
        "kindLabel": "B型题",
        "options": [{"key": chr(65 + index), "label": label} for index, label in enumerate(shuffled)],
        "stems": stems,
        "sourceText": source_group["title"],
        "reviewState": "已按精编版生化合集、转录讲义与思维导图核对",
        "reviewIssues": [],
        "reviewNotes": review_notes,
        "topic": TOPIC,
        "lectureIds": ["lecture-17"],
        "optionShuffleVersion": 1,
        "lectureEvidence": evidence(source_group["source_index"]),
    }


def main():
    source_groups = parse_workbook()
    build_lecture_images()
    groups = [make_group(group, index) for index, group in enumerate(source_groups, 1)]
    payload = {
        "meta": {
            "title": "生物化学第 17 讲题库",
            "sourceLabel": "生化第 17 讲学成题（转录及调控）",
            "sourcePages": 8,
            "lectureCount": 1,
            "groupCount": len(groups),
            "stemCount": sum(len(group["stems"]) for group in groups),
            "correctionGroupCount": 1,
            "generatedBy": "scripts/build_biochemistry_lecture17.py",
            "siteIntegrated": True,
            "lectureLinked": True,
            "answerNote": "完整收录《转录及调控》8 组 52 题；选项已重新打散，答案以精编版讲义为主完成核对。",
        },
        "topics": ["全部", TOPIC, "综合"],
        "pages": [{"page": group["page"], "image": "", "topic": TOPIC, "searchText": group["title"]} for group in groups],
        "groups": groups,
        "lectures": [{"id": "lecture-17", "number": LECTURE_NUMBER, "title": TITLE, "pageCount": 2}],
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
