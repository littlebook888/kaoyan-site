#!/usr/bin/env python3
"""Build the translation question bank directly from the supplied Word file."""

from __future__ import annotations

import json
import random
import re
from pathlib import Path

from docx import Document
from PIL import Image


SOURCE_DOCX = Path("/Users/ray/Downloads/生化_翻译_学成选择题.docx")
MIND_MAP = Path("/Users/ray/Downloads/生物化学思维导图 10.jpg")
OUTPUT = Path("src/data/biochemistry-lecture18-data.json")
IMAGE_OUTPUT = Path("public/biochemistry/lecture-pages/lecture-18-page-01.webp")
LECTURE_NUMBER = 18
TITLE = "生化 翻译"
TOPIC = "氨基酸与蛋白质"

GROUP_HEADER = re.compile(r"^第(\d+)组[：:]\s*(.+)$")
NUMBERED_ITEM = re.compile(r"^(\d+)[.．]\s*(.+)$")
OPTION_ITEM = re.compile(r"^([A-Z])[.．]\s*(.+)$")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\u3000", " ")).strip()


def read_paragraphs() -> list[str]:
    if not SOURCE_DOCX.is_file():
        raise FileNotFoundError(f"Missing supplied Word file: {SOURCE_DOCX}")
    document = Document(SOURCE_DOCX)
    return [text for paragraph in document.paragraphs if (text := normalize(paragraph.text))]


def parse_answers(lines: list[str]) -> dict[int, dict[int, list[str]]]:
    answers: dict[int, dict[int, list[str]]] = {}
    current_group: int | None = None
    for line in lines:
        header = GROUP_HEADER.match(line)
        if header:
            current_group = int(header.group(1))
            answers[current_group] = {}
            answer_text = header.group(2)
        elif current_group is not None:
            answer_text = line
        else:
            continue

        for item in re.split(r"[；;]", answer_text):
            match = NUMBERED_ITEM.match(item.strip())
            if not match:
                continue
            number = int(match.group(1))
            letters = re.findall(r"[A-Z]", match.group(2))
            if not letters:
                raise ValueError(f"No answer letters found in: {item}")
            answers[current_group][number] = letters
    return answers


def parse_group_section(number: int, title: str, lines: list[str], answer_map: dict[int, list[str]]) -> dict:
    try:
        stem_marker = lines.index("题干")
        option_marker = lines.index("选项池")
    except ValueError as error:
        raise ValueError(f"Group {number} is missing 题干 or 选项池") from error

    stem_lines = lines[stem_marker + 1:option_marker]
    option_lines = lines[option_marker + 1:]
    stems: list[tuple[str, list[str]]] = []
    options_by_key: dict[str, str] = {}

    for line in stem_lines:
        match = NUMBERED_ITEM.match(line)
        if not match:
            continue
        stem_number = int(match.group(1))
        if stem_number not in answer_map:
            raise ValueError(f"Group {number} stem {stem_number} has no answer")
        stems.append((match.group(2).replace("（多选）", "").strip(), answer_map[stem_number]))

    for line in option_lines:
        match = OPTION_ITEM.match(line)
        if match:
            options_by_key[match.group(1)] = match.group(2).strip()

    if len(stems) != len(answer_map):
        raise ValueError(f"Group {number}: parsed {len(stems)} stems but found {len(answer_map)} answers")
    if not options_by_key:
        raise ValueError(f"Group {number} has no options")

    resolved_stems = []
    for stem_text, answer_keys in stems:
        missing = [key for key in answer_keys if key not in options_by_key]
        if missing:
            raise ValueError(f"Group {number} has missing option keys: {missing}")
        resolved_stems.append((stem_text, [options_by_key[key] for key in answer_keys]))

    return {
        "title": title,
        "source": f"《生化_翻译_学成选择题》原第 {number} 组",
        "options": list(options_by_key.values()),
        "stems": resolved_stems,
        "note": "题干、选项与答案均按用户提供的 Word 原文录入，网页选项顺序重新打散。",
    }


def parse_word_groups() -> list[dict]:
    paragraphs = read_paragraphs()
    try:
        answer_start = paragraphs.index("答案")
    except ValueError as error:
        raise ValueError("The supplied Word file has no 答案 section") from error

    question_lines = paragraphs[:answer_start]
    answers = parse_answers(paragraphs[answer_start + 1:])
    headers = [(index, GROUP_HEADER.match(line)) for index, line in enumerate(question_lines)]
    headers = [(index, match) for index, match in headers if match]
    if len(headers) != 10:
        raise ValueError(f"Expected 10 original groups in Word, found {len(headers)}")

    groups = []
    for position, (start, header) in enumerate(headers):
        assert header is not None
        number = int(header.group(1))
        title = header.group(2)
        end = headers[position + 1][0] if position + 1 < len(headers) else len(question_lines)
        if number not in answers:
            raise ValueError(f"Group {number} has no answer section")
        groups.append(parse_group_section(number, title, question_lines[start + 1:end], answers[number]))
    return groups


def merge_eighth_and_ninth_groups(groups: list[dict]) -> list[dict]:
    if len(groups) != 10:
        raise ValueError(f"Expected 10 groups before merging, found {len(groups)}")
    eighth, ninth = groups[7], groups[8]
    merged = {
        "title": "翻译的干扰",
        "source": "《生化_翻译_学成选择题》原第 8、9 组",
        "options": list(dict.fromkeys(eighth["options"] + ninth["options"])),
        "stems": eighth["stems"] + ninth["stems"],
        "note": "按用户要求仅合并 Word 原第 8、9 组；两组题干和答案完整保留，共用一个重新打散的选项池。",
    }
    return groups[:7] + [merged, groups[9]]


def save_mind_map() -> None:
    if not MIND_MAP.is_file():
        raise FileNotFoundError(f"Missing supplied mind map: {MIND_MAP}")
    with Image.open(MIND_MAP) as image:
        image = image.convert("RGB")
        if image.width > 2200:
            height = round(image.height * 2200 / image.width)
            image = image.resize((2200, height), Image.Resampling.LANCZOS)
        IMAGE_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
        image.save(IMAGE_OUTPUT, "WEBP", quality=88, method=6, exact=True)


def build_group(spec: dict, index: int) -> dict:
    original_options = spec["options"]
    if len(original_options) != len(set(original_options)):
        raise ValueError(f"Group {index} contains duplicate options")
    if len(original_options) > 26:
        raise ValueError(f"Group {index} has more than 26 options")

    shuffled = original_options.copy()
    random.Random(30600 + LECTURE_NUMBER * 100 + index).shuffle(shuffled)
    if shuffled == original_options and len(shuffled) > 1:
        shuffled = shuffled[1:] + shuffled[:1]
    key_for = {label: chr(65 + position) for position, label in enumerate(shuffled)}

    stems = []
    for number, (text, answer_labels) in enumerate(spec["stems"], 1):
        if not set(answer_labels).issubset(key_for):
            raise ValueError(f"Group {index} stem {number} has an unknown answer")
        answer = [key_for[label] for label in answer_labels]
        stems.append({
            "number": number,
            "text": text.replace("（多选）", "").strip(),
            "answerRaw": "、".join(answer),
            "answer": answer,
            "answerMode": "多选" if len(answer) > 1 else "单选",
        })

    return {
        "id": f"bio-18-{index:02d}",
        "page": index,
        "title": spec["title"],
        "kind": "B",
        "kindLabel": "B型题",
        "options": [{"key": chr(65 + position), "label": label} for position, label in enumerate(shuffled)],
        "stems": stems,
        "sourceText": spec["source"],
        "reviewState": "已按用户提供的 Word、精编版讲义与思维导图核对",
        "reviewIssues": [],
        "reviewNotes": [spec["note"]],
        "topic": TOPIC,
        "lectureIds": ["lecture-18"],
        "optionShuffleVersion": 2,
        "lectureEvidence": {
            "lectureId": "lecture-18",
            "lectureNumber": LECTURE_NUMBER,
            "lectureTitle": TITLE,
            "page": 1,
            "image": "biochemistry/lecture-pages/lecture-18-page-01.webp",
            "title": "第 18 讲《生化 翻译》· 思维导图第 275 页",
            "description": "翻译体系、能量、起始延长终止、翻译后加工及翻译干扰。点击可查看对应思维导图。",
            "method": "以用户提供的 Word 为分组、题干、选项和答案依据，结合精编版讲义与思维导图复核知识点。",
        },
    }


def main() -> None:
    save_mind_map()
    specs = merge_eighth_and_ninth_groups(parse_word_groups())
    groups = [build_group(spec, index) for index, spec in enumerate(specs, 1)]
    stem_count = sum(len(group["stems"]) for group in groups)
    if len(groups) != 9 or stem_count != 81:
        raise ValueError(f"Expected 9 groups and 81 stems, found {len(groups)} and {stem_count}")

    payload = {
        "meta": {
            "title": "生物化学第 18 讲题库",
            "sourceLabel": "《生化_翻译_学成选择题》",
            "sourcePages": 8,
            "lectureCount": 1,
            "groupCount": len(groups),
            "stemCount": stem_count,
            "correctionGroupCount": 0,
            "generatedBy": "scripts/build_biochemistry_lecture18.py",
            "siteIntegrated": True,
            "lectureLinked": True,
            "answerNote": "完整收录 Word 原 10 组的 81 个题干；按要求合并原第 8、9 组后整理为 9 组，原第 10 组单独保留。题干、选项和答案均以 Word 原文为准，网页选项已重新打散。",
        },
        "topics": ["全部", TOPIC, "综合"],
        "pages": [{"page": group["page"], "image": "", "topic": TOPIC, "searchText": group["title"]} for group in groups],
        "groups": groups,
        "lectures": [{"id": "lecture-18", "number": LECTURE_NUMBER, "title": TITLE, "pageCount": 1}],
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
