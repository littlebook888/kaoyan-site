#!/usr/bin/env python3
"""Build the eukaryotic-genome and DNA-damage question bank from the supplied Word file."""

from __future__ import annotations

import json
import random
import re
from pathlib import Path

from docx import Document
from PIL import Image


SOURCE_DOCX = Path("/Users/ray/Downloads/生化_真核基因组与DNA损伤_学成选择题.docx")
MIND_MAPS = {
    1: Path("/Users/ray/Downloads/生物化学思维导图 14.jpg"),
    2: Path("/Users/ray/Downloads/生物化学思维导图 15.jpg"),
}
OUTPUT = Path("src/data/biochemistry-lecture20-data.json")
IMAGE_DIR = Path("public/biochemistry/lecture-pages")
LECTURE_NUMBER = 20
TITLE = "生化 真核基因组与 DNA 损伤"
TOPIC = "核酸"

GROUP_RE = re.compile(r"^第\s*(\d+)\s*组[：:]\s*(.+)$")
NUMBERED_RE = re.compile(r"^(\d+)[.．]\s*(.+)$")
OPTION_RE = re.compile(r"^([A-Z])[.．]\s*(.+)$")
EXPECTED_GROUPS = 7
EXPECTED_STEMS = 30


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\u3000", " ")).strip()


def read_paragraphs() -> list[str]:
    if not SOURCE_DOCX.is_file():
        raise FileNotFoundError(f"Missing supplied Word file: {SOURCE_DOCX}")
    document = Document(SOURCE_DOCX)
    return [text for paragraph in document.paragraphs if (text := normalize(paragraph.text))]


def parse_group(number: int, title: str, lines: list[str]) -> dict:
    try:
        stem_marker = lines.index("题干")
        option_marker = lines.index("选项池")
        answer_marker = lines.index("答案")
    except ValueError as error:
        raise ValueError(f"Group {number} is missing 题干, 选项池, or 答案") from error
    if not stem_marker < option_marker < answer_marker:
        raise ValueError(f"Group {number} has invalid section order")

    stems: list[tuple[int, str]] = []
    for line in lines[stem_marker + 1 : option_marker]:
        match = NUMBERED_RE.match(line)
        if match:
            stems.append((int(match.group(1)), match.group(2).strip()))

    options: dict[str, str] = {}
    for line in lines[option_marker + 1 : answer_marker]:
        match = OPTION_RE.match(line)
        if match:
            options[match.group(1)] = match.group(2).strip()

    answers: dict[int, list[str]] = {}
    for line in lines[answer_marker + 1 :]:
        match = NUMBERED_RE.match(line)
        if not match:
            continue
        letters = re.findall(r"[A-Z]", match.group(2))
        if not letters:
            raise ValueError(f"Group {number} has no answer letters in: {line}")
        answers[int(match.group(1))] = letters

    stem_numbers = {item_number for item_number, _ in stems}
    if not stems or stem_numbers != set(answers):
        raise ValueError(f"Group {number}: question and answer numbers do not match")
    if not options:
        raise ValueError(f"Group {number} has no options")
    for stem_number, letters in answers.items():
        missing = [letter for letter in letters if letter not in options]
        if missing:
            raise ValueError(f"Group {number} stem {stem_number}: unknown options {missing}")

    return {
        "source_index": number,
        "title": title,
        "stems": stems,
        "options": options,
        "answers": answers,
    }


def parse_docx() -> list[dict]:
    lines = read_paragraphs()
    headers = [(index, GROUP_RE.match(line)) for index, line in enumerate(lines)]
    headers = [(index, match) for index, match in headers if match]
    if len(headers) != EXPECTED_GROUPS:
        raise ValueError(f"Expected {EXPECTED_GROUPS} groups, found {len(headers)}")

    groups: list[dict] = []
    for position, (start, header) in enumerate(headers):
        assert header is not None
        number = int(header.group(1))
        if number != position + 1:
            raise ValueError(f"Expected group {position + 1}, found group {number}")
        end = headers[position + 1][0] if position + 1 < len(headers) else len(lines)
        groups.append(parse_group(number, header.group(2).strip(), lines[start + 1 : end]))

    stem_count = sum(len(group["stems"]) for group in groups)
    if stem_count != EXPECTED_STEMS:
        raise ValueError(f"Expected {EXPECTED_STEMS} stems, found {stem_count}")
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
        output = IMAGE_DIR / f"lecture-20-page-{page:02d}.webp"
        output.parent.mkdir(parents=True, exist_ok=True)
        prepared.save(output, "WEBP", quality=88, method=6, exact=True)


def lecture_evidence(source_group: int) -> dict:
    if source_group <= 3:
        image_page = 1
        page_title = "思维导图第 277 页"
        description = "真核基因组、断裂基因、重复序列、单顺反子及其他真核基因组特点。"
    else:
        image_page = 2
        page_title = "思维导图第 278 页"
        description = "DNA 损伤类型、碱基改变、直接修复、切除修复、重组修复及修复缺陷疾病。"
    return {
        "lectureId": "lecture-20",
        "lectureNumber": LECTURE_NUMBER,
        "lectureTitle": TITLE,
        "page": image_page,
        "image": f"biochemistry/lecture-pages/lecture-20-page-{image_page:02d}.webp",
        "title": f"第 20 讲《{TITLE}》· {page_title}",
        "description": f"{description}点击可查看对应思维导图。",
        "method": "以用户提供的 Word 为题干、选项和答案依据，并与对应思维导图逐项核对。",
    }


def build_group(source_group: dict, display_index: int) -> dict:
    original_options = list(source_group["options"].values())
    if len(original_options) != len(set(original_options)):
        raise ValueError(f"Group {source_group['source_index']} contains duplicate options")
    if len(original_options) > 26:
        raise ValueError(f"Group {source_group['source_index']} has more than 26 options")

    shuffled = original_options.copy()
    random.Random(30600 + LECTURE_NUMBER * 100 + source_group["source_index"]).shuffle(shuffled)
    if shuffled == original_options and len(shuffled) > 1:
        shuffled = shuffled[1:] + shuffled[:1]
    key_for = {label: chr(65 + position) for position, label in enumerate(shuffled)}

    stems = []
    for number, text in source_group["stems"]:
        answer_labels = [source_group["options"][key] for key in source_group["answers"][number]]
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
        "id": f"bio-20-{display_index:02d}",
        "page": display_index,
        "title": source_group["title"],
        "kind": "B",
        "kindLabel": "B型题",
        "options": [
            {"key": chr(65 + position), "label": label}
            for position, label in enumerate(shuffled)
        ],
        "stems": stems,
        "sourceText": f"《生化_真核基因组与DNA损伤_学成选择题》原第 {source_group['source_index']} 组",
        "reviewState": "已按用户提供的 Word 与对应思维导图核对",
        "reviewIssues": [],
        "reviewNotes": ["题干、选项与答案按 Word 原文录入；网页选项已确定性重新打散。"],
        "topic": TOPIC,
        "lectureIds": ["lecture-20"],
        "optionShuffleVersion": 1,
        "lectureEvidence": lecture_evidence(source_group["source_index"]),
    }


def validate_payload(payload: dict) -> None:
    groups = payload["groups"]
    if len(groups) != EXPECTED_GROUPS:
        raise ValueError(f"Payload has {len(groups)} groups")
    if sum(len(group["stems"]) for group in groups) != EXPECTED_STEMS:
        raise ValueError("Payload stem count changed")
    for group in groups:
        option_keys = {option["key"] for option in group["options"]}
        for stem in group["stems"]:
            if not set(stem["answer"]).issubset(option_keys):
                raise ValueError(f"{group['id']} stem {stem['number']} has an invalid answer")
            expected_mode = "多选" if len(stem["answer"]) > 1 else "单选"
            if stem["answerMode"] != expected_mode:
                raise ValueError(f"{group['id']} stem {stem['number']} has an invalid answer mode")


def main() -> None:
    source_groups = parse_docx()
    build_lecture_images()
    groups = [build_group(group, index) for index, group in enumerate(source_groups, 1)]
    payload = {
        "meta": {
            "title": "生物化学第 20 讲题库",
            "sourceLabel": "《生化_真核基因组与DNA损伤_学成选择题》",
            "sourcePages": 5,
            "lectureCount": 1,
            "groupCount": len(groups),
            "stemCount": sum(len(group["stems"]) for group in groups),
            "correctionGroupCount": 0,
            "generatedBy": "scripts/build_biochemistry_lecture20.py",
            "siteIntegrated": True,
            "lectureLinked": True,
            "answerNote": "完整收录 Word 的 7 组 30 个题干；题干、选项和答案均以 Word 为准，网页选项已重新打散，并逐组关联对应思维导图。",
        },
        "topics": ["全部", TOPIC, "综合"],
        "pages": [
            {"page": group["page"], "image": "", "topic": TOPIC, "searchText": group["title"]}
            for group in groups
        ],
        "groups": groups,
        "lectures": [{"id": "lecture-20", "number": LECTURE_NUMBER, "title": TITLE, "pageCount": 2}],
    }
    validate_payload(payload)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
