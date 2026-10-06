"""Validate a profile document against the subset of JSON Schema we ship."""

from __future__ import annotations

import re


class SchemaError(ValueError):
    """Validation failed. The message names the path, never the value."""

    def __init__(self, path: str):
        super().__init__(f"profile.yaml does not match the Intelio profile schema ({path})")
        self.path = path


def _is_type(value, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "boolean":
        return isinstance(value, bool)
    return False


def validate(instance, schema, path: str = "$") -> None:
    if not isinstance(schema, dict):
        raise SchemaError(path)
    if "const" in schema and instance != schema["const"]:
        raise SchemaError(path)
    expected = schema.get("type")
    if expected and not _is_type(instance, expected):
        raise SchemaError(path)
    if expected == "string":
        if "minLength" in schema and len(instance) < schema["minLength"]:
            raise SchemaError(path)
        if "maxLength" in schema and len(instance) > schema["maxLength"]:
            raise SchemaError(path)
        pattern = schema.get("pattern")
        if pattern and re.fullmatch(pattern, instance) is None:
            raise SchemaError(path)
    elif expected == "array":
        items = schema.get("items")
        if items:
            for index, value in enumerate(instance):
                validate(value, items, f"{path}[{index}]")
    elif expected == "object":
        properties = schema.get("properties") or {}
        for key in schema.get("required") or []:
            if key not in instance:
                raise SchemaError(f"{path}.{key}")
        if schema.get("additionalProperties") is False:
            extra = [key for key in instance if key not in properties]
            if extra:
                raise SchemaError(path)
        for key, value in instance.items():
            if key in properties:
                validate(value, properties[key], f"{path}.{key}")
