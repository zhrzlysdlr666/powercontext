"""Context Pack wire protocol for incremental context transport (context-02).

A :class:`ContextPack` represents one fully prepared context as an ordered
tuple of UTF-8-safe byte chunks plus a digest and a self-reporting byte
count.  A :class:`ContextPackDelta` carries only the suffix a receiver must
append to a previously received pack in order to rebuild the next context.
Both objects serialize to canonical JSON whose exact byte length is the
measured transport cost, so the receiver can rebuild from the wire alone
without access to any sender-side in-process state.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Iterable

__all__ = [
    "ContextPack",
    "ContextPackDelta",
    "ContextPackError",
    "apply_context_pack_delta",
]

_PACK_SCHEMA = "powercontext.context-pack.v1"
_DELTA_SCHEMA = "powercontext.context-pack-delta.v1"
_DEFAULT_CHUNK_BYTES = 512
_DIGEST_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
_PACK_FIELDS = frozenset({"schema", "items", "digest", "byte_count"})
_DELTA_FIELDS = frozenset(
    {"schema", "base_digest", "target_digest", "prefix_items", "appended"}
)


class ContextPackError(ValueError):
    """Raised when pack or delta construction, encoding, or decoding violates the protocol."""


def _canonical(payload: dict[str, object]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _encode_items(items: Iterable[bytes]) -> list[str]:
    return [base64.b64encode(item).decode("ascii") for item in items]


def _decode_item_list(value: object, *, name: str) -> tuple[bytes, ...]:
    if not isinstance(value, list):
        raise ContextPackError(f"{name} must be a list of base64 strings")
    decoded: list[bytes] = []
    for entry in value:
        if not isinstance(entry, str):
            raise ContextPackError(f"{name} entries must be base64 strings")
        try:
            decoded.append(base64.b64decode(entry.encode("ascii"), validate=True))
        except (binascii.Error, ValueError, UnicodeEncodeError) as error:
            raise ContextPackError(f"{name} entry is not valid base64") from error
    return tuple(decoded)


def _validate_digest(value: object, *, name: str) -> str:
    if not isinstance(value, str) or _DIGEST_PATTERN.fullmatch(value) is None:
        raise ContextPackError(f"{name} must be 'sha256:<64 hex digits>'")
    return value


def _chunk_utf8(content: str, limit: int) -> tuple[bytes, ...]:
    """Split content into deterministic chunks of at most ``limit`` bytes.

    Splitting prefers newline boundaries so appended conversation turns keep
    earlier chunks byte-identical (maximizing reusable delta prefixes), then
    falls back to the last UTF-8 character boundary inside the window.
    """

    if limit <= 0:
        raise ContextPackError("chunk_bytes must be a positive integer")
    data = content.encode("utf-8")
    if not data:
        return ()
    chunks: list[bytes] = []
    start = 0
    total = len(data)
    while start < total:
        end = min(start + limit, total)
        if end < total:
            newline = data.rfind(b"\n", start, end)
            if newline >= start:
                end = newline + 1
            else:
                while end > start and (data[end] & 0xC0) == 0x80:
                    end -= 1
                if end == start:
                    raise ContextPackError(
                        "chunk_bytes is too small to hold one UTF-8 character"
                    )
        chunks.append(data[start:end])
        start = end
    return tuple(chunks)


@dataclass(frozen=True)
class ContextPack:
    """Complete context as ordered chunks with a digest and self-measured size."""

    items: tuple[bytes, ...]
    digest: str

    def __post_init__(self) -> None:
        for item in self.items:
            if not isinstance(item, bytes):
                raise ContextPackError("context pack items must be bytes")
        _validate_digest(self.digest, name="digest")

    @classmethod
    def build(cls, items: Iterable[bytes], /) -> ContextPack:
        materialized = tuple(items)
        unsigned = {"schema": _PACK_SCHEMA, "items": _encode_items(materialized)}
        digest = "sha256:" + hashlib.sha256(_canonical(unsigned)).hexdigest()
        return cls(items=materialized, digest=digest)

    @classmethod
    def from_content(cls, content: str, /, *, chunk_bytes: int = _DEFAULT_CHUNK_BYTES) -> ContextPack:
        if not isinstance(content, str):
            raise ContextPackError("content must be a string")
        return cls.build(_chunk_utf8(content, chunk_bytes))

    @classmethod
    def from_bytes(cls, payload: bytes, /) -> ContextPack:
        try:
            data = json.loads(payload)
        except (ValueError, UnicodeDecodeError) as error:
            raise ContextPackError("context pack payload is not valid JSON") from error
        if not isinstance(data, dict) or _PACK_FIELDS.symmetric_difference(data):
            raise ContextPackError("context pack fields do not match the wire contract")
        if data["schema"] != _PACK_SCHEMA:
            raise ContextPackError("unknown context pack schema")
        if not isinstance(data["byte_count"], int) or isinstance(data["byte_count"], bool):
            raise ContextPackError("byte_count must be an integer")
        if data["byte_count"] < 0:
            raise ContextPackError("byte_count must be non-negative")
        if data["byte_count"] != len(_canonical(data)):
            raise ContextPackError("byte_count does not match the serialized pack")
        items = _decode_item_list(data["items"], name="items")
        digest = _validate_digest(data["digest"], name="digest")
        rebuilt = cls.build(items)
        if rebuilt.digest != digest:
            raise ContextPackError("context pack digest mismatch")
        return rebuilt

    def to_bytes(self) -> bytes:
        unsigned = {"schema": _PACK_SCHEMA, "items": _encode_items(self.items)}
        # byte_count reports its own serialization length; converge on a fixed point.
        count = 0
        for _ in range(16):
            encoded = _canonical(
                {**unsigned, "digest": self.digest, "byte_count": count}
            )
            if len(encoded) == count:
                return encoded
            count = len(encoded)
        raise ContextPackError("byte_count failed to converge")

    @property
    def byte_count(self) -> int:
        return len(self.to_bytes())


@dataclass(frozen=True)
class ContextPackDelta:
    """Suffix update from a base pack to a target pack."""

    base_digest: str
    target_digest: str
    prefix_items: int
    appended: tuple[bytes, ...]

    def __post_init__(self) -> None:
        _validate_digest(self.base_digest, name="base_digest")
        _validate_digest(self.target_digest, name="target_digest")
        if type(self.prefix_items) is not int or self.prefix_items < 0:
            raise ContextPackError("prefix_items must be a non-negative integer")
        for item in self.appended:
            if not isinstance(item, bytes):
                raise ContextPackError("delta appended items must be bytes")

    @classmethod
    def between(cls, base: ContextPack, target: ContextPack, /) -> ContextPackDelta:
        if not isinstance(base, ContextPack) or not isinstance(target, ContextPack):
            raise ContextPackError("between expects two ContextPack objects")
        shared = min(len(base.items), len(target.items))
        prefix = 0
        while prefix < shared and base.items[prefix] == target.items[prefix]:
            prefix += 1
        return cls(
            base_digest=base.digest,
            target_digest=target.digest,
            prefix_items=prefix,
            appended=target.items[prefix:],
        )

    @classmethod
    def from_bytes(cls, payload: bytes, /) -> ContextPackDelta:
        try:
            data = json.loads(payload)
        except (ValueError, UnicodeDecodeError) as error:
            raise ContextPackError("delta payload is not valid JSON") from error
        if not isinstance(data, dict) or _DELTA_FIELDS.symmetric_difference(data):
            raise ContextPackError("delta fields do not match the wire contract")
        if data["schema"] != _DELTA_SCHEMA:
            raise ContextPackError("unknown delta schema")
        base_digest = _validate_digest(data["base_digest"], name="base_digest")
        target_digest = _validate_digest(data["target_digest"], name="target_digest")
        prefix = data["prefix_items"]
        if isinstance(prefix, bool) or not isinstance(prefix, int) or prefix < 0:
            raise ContextPackError("prefix_items must be a non-negative integer")
        appended = _decode_item_list(data["appended"], name="appended")
        return cls(
            base_digest=base_digest,
            target_digest=target_digest,
            prefix_items=prefix,
            appended=appended,
        )

    def to_bytes(self) -> bytes:
        payload = {
            "schema": _DELTA_SCHEMA,
            "base_digest": self.base_digest,
            "target_digest": self.target_digest,
            "prefix_items": self.prefix_items,
            "appended": _encode_items(self.appended),
        }
        return _canonical(payload)

    @property
    def byte_count(self) -> int:
        return len(self.to_bytes())


def apply_context_pack_delta(base: ContextPack, delta: ContextPackDelta, /) -> ContextPack:
    """Validate ``delta`` against ``base`` and rebuild the target pack."""

    if not isinstance(base, ContextPack) or not isinstance(delta, ContextPackDelta):
        raise ContextPackError("apply expects a ContextPack base and a ContextPackDelta")
    if delta.base_digest != base.digest:
        raise ContextPackError("delta base digest does not match the provided base pack")
    prefix = delta.prefix_items
    if prefix > len(base.items):
        raise ContextPackError("delta prefix exceeds the base pack chunk count")
    rebuilt = ContextPack.build(base.items[:prefix] + tuple(delta.appended))
    if rebuilt.digest != delta.target_digest:
        raise ContextPackError("rebuilt pack digest does not match the delta target")
    return rebuilt
