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

"""Pi session branch capture: raw visible events as durable, citable evidence."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import quote

from pydantic import BaseModel

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import AdapterSourceDefinition, TextEvidence
from powercontext.sources.connectors import ConnectorRunCompletion, ConnectorRunStatus
from powercontext.sources.models import Source, SourceMaterialization

PI_EVENT_SOURCE_NAME = "pi-event"
PI_EVENT_SOURCE_TYPE = "pi-event"
PI_SESSION_CONNECTOR_NAME = "pi-session-history"
PI_SESSION_CONNECTOR_VERSION = "1"
_ID_PREFIX = "pi:"

_CONTROL_EVENT_TYPES = frozenset({"model_change", "thinking_level_change"})
_SUMMARY_EVENT_TYPES = frozenset({"compaction", "branch_summary"})


class PiSessionInput(BaseModel):
    """A complete offline Pi session file delivered as raw JSONL bytes."""

    content: bytes
    leaf_id: str | None = None


class PiEventInput(BaseModel):
    """One raw visible event on the selected branch, root to leaf order."""

    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict


class PiEventSource(Source):
    """A captured Pi event whose identity is (session id, event id)."""

    source_id: str
    session_id: str
    event_id: str
    parent_id: str | None
    event_type: str
    role: str
    content: str
    record: dict


def pi_event_source_id(session_id: str, event_id: str) -> str:
    """Build the stable event identity ``pi:<session>:<event>``.

    Both components are percent-encoded with ``quote(component, safe="")`` so
    the ``:`` separator can never collide. The final identity must not exceed
    256 characters.
    """

    identity = f"{_ID_PREFIX}{quote(session_id, safe='')}:{quote(event_id, safe='')}"
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        raise ValueError(f"source identity must not exceed {MAX_SOURCE_ID_LENGTH} characters")
    return identity


def _fail(message: str) -> None:
    raise ValueError(message)


def _decode(content: bytes) -> str:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as error:
        _fail(f"session must be valid UTF-8: {error}")
    if text.startswith("\ufeff"):
        text = text[1:]
    return text


def _visible_parts(content: object) -> list[str]:
    """Extract visible text bodies from a string or typed block list."""

    parts: list[str] = []
    if isinstance(content, str):
        if content:
            parts.append(content)
        return parts
    if not isinstance(content, list):
        return parts
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text" and isinstance(block.get("text"), str) and block["text"]:
            parts.append(block["text"])
        elif block_type == "toolCall":
            name = block.get("name")
            call_id = block.get("id")
            arguments = block.get("arguments")
            if not isinstance(arguments, dict):
                arguments = {}
            encoded = json.dumps(arguments, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            parts.append(f"[tool_call {name} {call_id}] {encoded}")
    return parts


def _event_body(record: dict) -> tuple[str, str] | None:
    """Return ``(role, body)`` for one visible record, or ``None``.

    Control records (``model_change``, ``thinking_level_change``) keep the
    graph connected but never produce text. Records without a visible body
    are skipped; compaction and branch summaries cannot delete earlier
    evidence because every prior event is emitted independently.
    """

    event_type = record.get("type")
    if event_type in _CONTROL_EVENT_TYPES:
        return None
    if event_type in _SUMMARY_EVENT_TYPES:
        summary = record.get("summary")
        if not isinstance(summary, str) or not summary:
            return None
        return event_type, summary
    if event_type == "custom_message":
        parts = _visible_parts(record.get("content"))
        if not parts:
            return None
        return "custom", "\n".join(parts)
    if event_type != "message":
        return None
    message = record.get("message")
    if not isinstance(message, dict):
        return None
    role = message.get("role")
    if not isinstance(role, str) or not role:
        return None
    if role == "bashExecution":
        command = message.get("command")
        if not isinstance(command, str) or not command:
            return None
        output = message.get("output")
        body = f"$ {command}"
        if isinstance(output, str) and output:
            body = f"{body}\n{output}"
        return role, body
    if role == "toolResult":
        tool_name = message.get("toolName")
        tool_call_id = message.get("toolCallId")
        text = "\n".join(_visible_parts(message.get("content")))
        body = f"[tool_result {tool_name} {tool_call_id}]"
        if text:
            body = f"{body} {text}"
        return role, body
    parts = _visible_parts(message.get("content"))
    if not parts:
        return None
    return role, "\n".join(parts)


def parse_pi_session(value: PiSessionInput) -> tuple[PiEventInput, ...]:
    """Parse a Pi v3 session file into the selected branch's visible events.

    The first JSONL record must be a ``type=session`` / ``version=3`` header
    with a non-empty id. Every following record carries a unique non-empty
    ``id`` and a ``parentId`` that is empty or points at an already seen
    node; any encoding, JSON, duplicate-id, missing-parent, cycle, or
    missing-leaf error raises ``ValueError`` with no partial results. The
    selected leaf defaults to the last node. Returns the visible events on
    the leaf's complete ancestor chain, ordered root to leaf.
    """

    if not isinstance(value.content, (bytes, bytearray)):
        _fail("session content must be bytes")
    text = _decode(bytes(value.content))
    records: list[dict] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            _fail(f"malformed session JSON: {error}")
        if not isinstance(record, dict):
            _fail("every session record must be a JSON object")
        records.append(record)
    if not records:
        _fail("session must contain a header record")
    header = records[0]
    if header.get("type") != "session":
        _fail("first record must have type 'session'")
    version = header.get("version")
    if isinstance(version, bool) or version != 3:
        _fail("session header must declare version 3")
    session_id = header.get("id")
    if not isinstance(session_id, str) or not session_id:
        _fail("session header id must be a non-empty string")

    parent_of: dict[str, str | None] = {}
    order: list[str] = []
    node_records: dict[str, dict] = {}
    for record in records[1:]:
        node_id = record.get("id")
        if not isinstance(node_id, str) or not node_id:
            _fail("every record must carry a non-empty string id")
        if node_id in parent_of:
            _fail(f"duplicate record id {node_id!r}")
        parent_id = record.get("parentId")
        if parent_id is None or parent_id == "":
            parent_id = None
        elif not isinstance(parent_id, str):
            _fail("parentId must be a string or null")
        elif parent_id not in parent_of:
            _fail(f"record {node_id!r} references unseen parent {parent_id!r}")
        parent_of[node_id] = parent_id
        order.append(node_id)
        node_records[node_id] = record

    leaf_id = value.leaf_id
    if leaf_id is None:
        if not order:
            return ()
        leaf_id = order[-1]
    elif not isinstance(leaf_id, str) or leaf_id not in parent_of:
        _fail(f"leaf {leaf_id!r} is not a node of this session")

    chain: list[str] = []
    cursor: str | None = leaf_id
    while cursor is not None:
        chain.append(cursor)
        cursor = parent_of[cursor]
    chain.reverse()

    events: list[PiEventInput] = []
    for node_id in chain:
        record = node_records[node_id]
        visible = _event_body(record)
        if visible is None:
            continue
        role, body = visible
        events.append(
            PiEventInput(
                session_id=session_id,
                event_id=node_id,
                parent_id=parent_of[node_id],
                event_type=record["type"],
                role=role,
                content=f"{role}: {body}",
                record=record,
            )
        )
    return tuple(events)


class PiEventSourceAdapter:
    """Resolve events into captured Sources and read them back unchanged."""

    input_class = PiEventInput
    name = PI_EVENT_SOURCE_NAME
    source_class = PiEventSource

    async def resolve(self, value: PiEventInput, /) -> PiEventSource:
        source_id = pi_event_source_id(value.session_id, value.event_id)
        return PiEventSource(
            name=source_id,
            materialization=SourceMaterialization.CAPTURED,
            source_id=source_id,
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
    """Project one event as the standard ``powercontext.text-evidence`` shape."""

    name = "powercontext.text-evidence"
    version = "1"
    source_class = PiEventSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PiEventSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PI_EVENT_SOURCE_TYPE,
            source_id=source.source_id,
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
    PiEventSourceAdapter(),
    projections=(PiEventTextEvidenceProjection(),),
)


def _record_digest(record: dict) -> str:
    """Canonical fingerprint of one raw record for rewrite detection."""

    encoded = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class PiSessionConnector:
    """Incrementally import the selected branch's events with durable progress.

    Every run re-parses the whole file and the selected branch, submits only
    events whose identity is absent from the checkpoint, and rejects any
    imported event whose raw record changed. The checkpoint (a plain JSON
    mapping of identity to record digest) is returned for
    :class:`ConnectorLifecycle` to commit only after the run succeeds, so a
    failed or corrupt run keeps the previously committed progress.
    """

    name = PI_SESSION_CONNECTOR_NAME
    version = PI_SESSION_CONNECTOR_VERSION
    source_definitions = frozenset({PI_EVENT_SOURCE_NAME})

    def __init__(self, path: str | Path, leaf_id: str | None = None) -> None:
        self.path = Path(path)
        self.leaf_id = leaf_id

    async def run(self, session, /) -> ConnectorRunCompletion:
        raw = self.path.read_bytes()
        events = parse_pi_session(PiSessionInput(content=raw, leaf_id=self.leaf_id))
        checkpoint = session.checkpoint
        imported: dict[str, str] = {}
        if isinstance(checkpoint, dict) and isinstance(checkpoint.get("events"), dict):
            imported = {
                identity: digest
                for identity, digest in checkpoint["events"].items()
                if isinstance(identity, str) and isinstance(digest, str)
            }
        for event in events:
            identity = pi_event_source_id(event.session_id, event.event_id)
            digest = _record_digest(event.record)
            prior = imported.get(identity)
            if prior is not None:
                if prior != digest:
                    _fail(f"imported event {event.event_id!r} was rewritten")
                continue
            await session.submit(identity, PI_EVENT_SOURCE_NAME, event)
            imported[identity] = digest
        return ConnectorRunCompletion(
            status=ConnectorRunStatus.COMPLETE,
            checkpoint={"version": 1, "events": imported},
        )


__all__ = [
    "PI_EVENT_SOURCE_DEFINITION",
    "PI_EVENT_SOURCE_NAME",
    "PI_EVENT_SOURCE_TYPE",
    "PI_SESSION_CONNECTOR_NAME",
    "PI_SESSION_CONNECTOR_VERSION",
    "PiEventInput",
    "PiEventSource",
    "PiSessionConnector",
    "PiSessionInput",
    "parse_pi_session",
    "pi_event_source_id",
]
