# Copyright (c) 2026 OceanBase.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Capture the raw visible events of one Pi session branch as Sources.

The Pi session file is a JSONL tree: every record carries ``id``/``parentId`` and
the selected leaf determines one root-to-leaf path. This module parses that path
into immutable events, projects each event as text evidence, and re-imports only
the events a binding has not captured yet while rejecting silent history edits.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Iterable
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, field_validator

from powercontext.errors import InvalidConnectorRunError
from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import (
    TEXT_EVIDENCE_PROJECTION_KEY,
    AdapterSourceDefinition,
    ConnectorRunCompletion,
    ConnectorRunSession,
    ConnectorRunStatus,
    TextEvidence,
)
from powercontext.sources.models import Source, SourceMaterialization

PI_EVENT_SOURCE_NAME = "pi-event"
PI_SESSION_CONNECTOR_NAME = "pi-session-history"
PI_SESSION_FORMAT_VERSION = 3
NonEmptyText = Annotated[str, Field(min_length=1)]


class PiSessionInput(BaseModel):
    """Raw Pi session archive plus the leaf that selects one branch."""

    content: bytes
    leaf_id: str | None = None

    @field_validator("leaf_id")
    @classmethod
    def reject_blank_leaf(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("leaf_id must be a non-empty string when provided")  # noqa: TRY003
        return value


class PiEventInput(BaseModel):
    """One visible event on the selected branch with its complete raw record."""

    session_id: NonEmptyText
    event_id: NonEmptyText
    parent_id: str | None = None
    event_type: NonEmptyText
    role: NonEmptyText
    content: NonEmptyText
    record: dict[str, JsonValue]


class PiEventSource(Source):
    """Captured Pi event retained verbatim for exact citation replay."""

    session_id: str
    event_id: str
    parent_id: str | None = None
    event_type: str
    role: str
    content: str
    record: dict[str, JsonValue]


def _event_identity(session_id: str, event_id: str) -> str:
    """Derive a stable, collision-free identity bounded by the Source id limit."""

    readable = f"{session_id}/{event_id}"
    if len(readable) <= MAX_SOURCE_ID_LENGTH and ":" not in readable and "/" not in session_id:
        return readable
    digest = hashlib.sha256(f"{len(session_id)}:{session_id}{event_id}".encode()).hexdigest()
    return f"pi-event:{digest}"


class PiEventAdapter:
    """Resolve and read the Pi session event Source Definition."""

    input_class = PiEventInput
    name = PI_EVENT_SOURCE_NAME
    source_class = PiEventSource

    async def resolve(self, value: PiEventInput, /) -> PiEventSource:
        return PiEventSource(
            name=_event_identity(value.session_id, value.event_id),
            materialization=SourceMaterialization.CAPTURED,
            session_id=value.session_id,
            event_id=value.event_id,
            parent_id=value.parent_id,
            event_type=value.event_type,
            role=value.role,
            content=value.content,
            record=value.record,
        )

    async def read(self, source: PiEventSource, /) -> PiEventInput:
        return PiEventInput(
            session_id=source.session_id,
            event_id=source.event_id,
            parent_id=source.parent_id,
            event_type=source.event_type,
            role=source.role,
            content=source.content,
            record=source.record,
        )


class PiEventTextEvidenceProjection:
    """Expose one captured Pi event as standard text evidence."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PiEventSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PiEventSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PI_EVENT_SOURCE_NAME,
            source_id=source.name,
            content=source.content,
            metadata={
                "session_id": source.session_id,
                "event_id": source.event_id,
                "parent_id": source.parent_id,
                "event_type": source.event_type,
                "role": source.role,
            },
        )


PI_EVENT_SOURCE_DEFINITION = AdapterSourceDefinition(
    PiEventAdapter(),
    projections=(PiEventTextEvidenceProjection(),),
)


class PiSessionCheckpoint(BaseModel):
    """Opaque per-binding progress: imported event identities plus digests."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal["1"] = "1"
    session_id: str
    events: dict[str, str] = Field(default_factory=dict)

    @field_validator("events")
    @classmethod
    def validate_digests(cls, value: dict[str, str]) -> dict[str, str]:
        for event_id, digest in value.items():
            if not event_id or not event_id.strip():
                raise ValueError("checkpoint event ids must be non-empty")  # noqa: TRY003
            if not digest.startswith("sha256:") or len(digest) != 71 or digest != digest.lower():
                raise ValueError("checkpoint digests must use lowercase sha256:<hex>")  # noqa: TRY003
            try:
                int(digest.removeprefix("sha256:"), 16)
            except ValueError as error:
                raise ValueError("checkpoint digest must contain hexadecimal") from error  # noqa: TRY003
        return value


def parse_pi_session(value: PiSessionInput, /) -> tuple[PiEventInput, ...]:
    """Parse every visible event on the selected branch, root first."""

    records = _read_records(value.content)
    header, entries = records[0], records[1:]
    session_id = _session_id(header)
    by_id, parents = _index_entries(entries)
    chain = _branch_chain(by_id, parents, value.leaf_id, entries)
    events: list[PiEventInput] = []
    for event_id in chain:
        event = _event_for(session_id, event_id, by_id[event_id], parents[event_id])
        if event is not None:
            events.append(event)
    return tuple(events)


def _index_entries(entries: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, str | None]]:
    by_id: dict[str, dict[str, Any]] = {}
    parents: dict[str, str | None] = {}
    for entry in entries:
        event_id = entry.get("id")
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("Pi session entries require a non-empty string id")  # noqa: TRY003
        if event_id in by_id:
            raise ValueError(f"duplicate Pi session entry id {event_id!r}")  # noqa: TRY003
        if "parentId" not in entry:
            raise ValueError(f"Pi session entry {event_id!r} is missing parentId")  # noqa: TRY003
        parent_id = entry["parentId"]
        if parent_id is not None and (not isinstance(parent_id, str) or parent_id not in by_id):
            raise ValueError(f"Pi session entry {event_id!r} references an unknown parent")  # noqa: TRY003
        by_id[event_id] = entry
        parents[event_id] = parent_id
    return by_id, parents


def _branch_chain(
    by_id: dict[str, dict[str, Any]],
    parents: dict[str, str | None],
    leaf_id: str | None,
    entries: list[dict[str, Any]],
) -> list[str]:
    selected = leaf_id if leaf_id is not None else (entries[-1]["id"] if entries else None)
    if not isinstance(selected, str) or selected not in by_id:
        raise ValueError("selected Pi session leaf does not exist")  # noqa: TRY003
    chain: list[str] = []
    cursor: str | None = selected
    while cursor is not None:
        chain.append(cursor)
        cursor = parents[cursor]
    chain.reverse()
    return chain


def _event_for(
    session_id: str,
    event_id: str,
    record: dict[str, Any],
    parent_id: str | None,
) -> PiEventInput | None:
    event_type = record.get("type")
    if not isinstance(event_type, str) or not event_type:
        raise ValueError(f"Pi session entry {event_id!r} has no type")  # noqa: TRY003
    role, body = _visible_text(event_type, record)
    if role is None or not body:
        return None
    return PiEventInput(
        session_id=session_id,
        event_id=event_id,
        parent_id=parent_id,
        event_type=event_type,
        role=role,
        content=f"{role}: {body}",
        record=record,
    )


class PiSessionConnector:
    """Import newly captured events of one Pi session branch."""

    name = PI_SESSION_CONNECTOR_NAME
    version = "1"
    source_definitions = frozenset({PI_EVENT_SOURCE_NAME})

    def __init__(self, path: str | Path, leaf_id: str | None = None) -> None:
        self._path = Path(path)
        if leaf_id is not None and (not isinstance(leaf_id, str) or not leaf_id.strip()):
            raise ValueError("leaf_id must be a non-empty string when provided")  # noqa: TRY003
        self._leaf_id = leaf_id

    async def run(self, session: ConnectorRunSession, /) -> ConnectorRunCompletion:
        previous = _checkpoint(session.checkpoint)
        content = await asyncio.to_thread(self._path.read_bytes)
        events = parse_pi_session(PiSessionInput(content=content, leaf_id=self._leaf_id))
        session_id = events[0].session_id if events else _session_id(_read_records(content)[0])

        captured = previous.events if previous.session_id == session_id else {}
        digests: dict[str, str] = dict(captured)
        pending: list[PiEventInput] = []
        for event in events:
            digest = _record_digest(event.record)
            known = captured.get(event.event_id)
            if known is not None and known != digest:
                raise ValueError(  # noqa: TRY003
                    f"Pi event {event.event_id!r} was modified after it was captured"
                )
            digests[event.event_id] = digest
            if known is None:
                pending.append(event)

        for event in pending:
            await session.submit(event.event_id, PI_EVENT_SOURCE_NAME, event)

        checkpoint = PiSessionCheckpoint(session_id=session_id, events=digests)
        return ConnectorRunCompletion(
            status=ConnectorRunStatus.COMPLETE,
            checkpoint=checkpoint.model_dump(mode="json"),
        )


def _checkpoint(value: JsonValue | None) -> PiSessionCheckpoint:
    if value is None:
        return PiSessionCheckpoint(session_id="")
    try:
        return PiSessionCheckpoint.model_validate(value)
    except ValidationError as error:
        raise InvalidConnectorRunError("checkpoint", "does not match PiSessionCheckpoint") from error


def _read_records(content: bytes) -> list[dict[str, Any]]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise ValueError("Pi session archive is not valid UTF-8") from error  # noqa: TRY003
    records: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError("Pi session archive is not valid JSONL") from error  # noqa: TRY003
        if not isinstance(record, dict):
            raise ValueError("Pi session archive records must be JSON objects")  # noqa: TRY003, TRY004
        records.append(record)
    if not records:
        raise ValueError("Pi session archive is empty")  # noqa: TRY003
    return records


def _session_id(header: dict[str, Any]) -> str:
    if header.get("type") != "session":
        raise ValueError("Pi session archive must start with a session header")  # noqa: TRY003
    if header.get("version") != PI_SESSION_FORMAT_VERSION:
        raise ValueError(f"Pi session archive must use version {PI_SESSION_FORMAT_VERSION}")  # noqa: TRY003
    session_id = header.get("id")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("Pi session header requires a non-empty string id")  # noqa: TRY003
    return session_id


def _visible_text(event_type: str, record: dict[str, Any]) -> tuple[str | None, str]:
    """Return the role and body one record contributes as text evidence."""

    if event_type == "message":
        message = record.get("message")
        return _message_text(message) if isinstance(message, dict) else (None, "")
    if event_type in {"compaction", "branch_summary"}:
        return event_type, _text_or_default(record.get("summary"), "")
    if event_type == "custom_message":
        return "custom", "\n".join(_text_parts(record.get("content"), include_tool_calls=False))
    return None, ""


def _message_text(message: dict[str, Any]) -> tuple[str | None, str]:
    role = message.get("role")
    if not isinstance(role, str) or not role:
        return None, ""
    if role == "toolResult":
        return role, _tool_result_body(message)
    if role == "bashExecution":
        return role, _bash_body(message)
    return role, "\n".join(_text_parts(message.get("content"), include_tool_calls=True))


def _tool_result_body(message: dict[str, Any]) -> str:
    body = "\n".join(_text_parts(message.get("content"), include_tool_calls=False))
    if not body:
        return ""
    name = _text_or_default(message.get("toolName"), "unknown")
    call_id = _text_or_default(message.get("toolCallId"), "unknown")
    return f"[tool_result {name} {call_id}] {body}"


def _bash_body(message: dict[str, Any]) -> str:
    command = _text_or_default(message.get("command"), "")
    output = _text_or_default(message.get("output"), "")
    if not command:
        return output
    return f"$ {command}\n{output}" if output else f"$ {command}"


def _text_parts(content: object, *, include_tool_calls: bool) -> Iterable[str]:
    if isinstance(content, str):
        if content:
            yield content
        return
    if not isinstance(content, list):
        return
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text":
            text = block.get("text")
            if isinstance(text, str) and text:
                yield text
        elif block_type == "toolCall" and include_tool_calls:
            name = _text_or_default(block.get("name"), "unknown")
            call_id = _text_or_default(block.get("id"), "unknown")
            arguments = block.get("arguments")
            rendered = json.dumps(
                {} if arguments is None else arguments,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                default=str,
            )
            yield f"[tool_call {name} {call_id}] {rendered}"


def _text_or_default(value: object, default: str) -> str:
    return value if isinstance(value, str) else default


def _record_digest(record: dict[str, Any]) -> str:
    canonical = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return f"sha256:{hashlib.sha256(canonical.encode()).hexdigest()}"


__all__ = [
    "PI_EVENT_SOURCE_DEFINITION",
    "PI_EVENT_SOURCE_NAME",
    "PI_SESSION_CONNECTOR_NAME",
    "PiEventInput",
    "PiEventSource",
    "PiSessionCheckpoint",
    "PiSessionConnector",
    "PiSessionInput",
    "parse_pi_session",
]
