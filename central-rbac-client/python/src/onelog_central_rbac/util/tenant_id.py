"""tenant_id.py — Extract tenant_id from framework request per spec string.

Spec format: 'query.dept' / 'params.dept' / 'headers.x-tid' / 'body.dept'
Mirror @onelog/central-rbac-client util/extract-tenant-id.ts.

Each framework adapter passes its own extractor callable — this module
just parses the spec string.
"""
from __future__ import annotations

from typing import Callable, Literal

Section = Literal["query", "params", "headers", "body"]


def parse_spec(spec: str) -> tuple[Section, str]:
    """Parse 'query.dept' → ('query', 'dept')."""
    if "." not in spec:
        raise ValueError(f"invalid tenant_id_from spec: {spec!r} (expected 'section.key')")
    section, _, key = spec.partition(".")
    if section not in ("query", "params", "headers", "body"):
        raise ValueError(
            f"invalid tenant_id_from section: {section!r} "
            "(must be query|params|headers|body)"
        )
    return section, key  # type: ignore[return-value]


def make_extractor(
    spec: str,
    get_query: Callable[[str], str | None],
    get_param: Callable[[str], str | None],
    get_header: Callable[[str], str | None],
    get_body_key: Callable[[str], str | None],
) -> str | None:
    """Return tenant_id extracted from request per spec, or None.

    Framework adapters wire the four getters. Body getter may be a no-op
    for GET/DELETE requests.
    """
    section, key = parse_spec(spec)
    if section == "query":
        return get_query(key)
    if section == "params":
        return get_param(key)
    if section == "headers":
        return get_header(key)
    return get_body_key(key)
