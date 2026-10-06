"""A small YAML subset reader for profile.yaml and pin/hermes.yaml.

Supports comments, scalar mappings, one level of nested mappings, scalar
lists, and empty [] / {}. It is not a general YAML parser.
"""

from __future__ import annotations


class YamlError(ValueError):
    """The file is not in the supported subset. The message never echoes values."""


def _scalar(text: str):
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ("'", '"'):
        return text[1:-1]
    lowered = text.casefold()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in ("null", "~"):
        return None
    return text


def _strip_comment(text: str) -> str:
    quote = None
    for index, char in enumerate(text):
        if char in ("'", '"'):
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
            continue
        if char == "#" and quote is None:
            return text[:index].rstrip()
    return text.rstrip()


def parse_yaml_subset(text: str):
    if not isinstance(text, str):
        raise YamlError("YAML subset expected text")
    if "\x00" in text:
        raise YamlError("YAML subset rejected a control character")
    lines = []
    for raw in text.splitlines():
        if "\t" in raw:
            raise YamlError("YAML subset rejected a tab")
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        lines.append((indent, _strip_comment(stripped)))
    value, index = _parse_block(lines, 0, 0)
    if index != len(lines):
        raise YamlError("YAML subset has trailing structure")
    return value


def _parse_block(lines, index, indent):
    result = {}
    while index < len(lines):
        ind, text = lines[index]
        if ind < indent:
            break
        if ind > indent or text.startswith("- "):
            raise YamlError("YAML subset has unexpected structure")
        if ":" not in text:
            raise YamlError("YAML subset expected a key")
        key, rest = text.split(":", 1)
        key = key.strip()
        rest = rest.strip()
        if not key or any(char.isspace() for char in key):
            raise YamlError("YAML subset expected a key")
        if key in result:
            raise YamlError("YAML subset rejected a duplicate key")
        index += 1
        if rest == "":
            if index < len(lines) and lines[index][0] > ind:
                child_indent, child_text = lines[index]
                if child_text.startswith("- "):
                    child, index = _parse_list(lines, index, child_indent)
                else:
                    child, index = _parse_block(lines, index, child_indent)
            else:
                child = None
        elif rest == "[]":
            child = []
        elif rest == "{}":
            child = {}
        else:
            child = _scalar(rest)
        result[key] = child
    return result, index


def _parse_list(lines, index, indent):
    items = []
    while index < len(lines):
        ind, text = lines[index]
        if ind < indent:
            break
        if ind != indent or not text.startswith("- "):
            raise YamlError("YAML subset expected a list item")
        item = text[2:].strip()
        if not item or item.startswith("- "):
            raise YamlError("YAML subset expected a scalar list item")
        items.append(_scalar(item))
        index += 1
    return items, index
