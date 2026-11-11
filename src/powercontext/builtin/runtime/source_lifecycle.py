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

"""Propagate Source lifecycle changes to the Memory and Topic Memory built on them.

A Scope declares a small DAG of evidence: Sources at the root, derived Memory in the middle,
derived Topic Memory on top. Withdrawing a Source does not rewrite any body. It recomputes one
eligibility bit per node, then moves only the nodes whose bit flipped: Memory entries go
inactive through the existing tombstone path, Topic Memory is hidden from search and Context
while its Artifact revision stays exactly readable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import IntegrityError

from powercontext.artifacts import ArtifactRef, MemoryCitation
from powercontext.builtin.artifacts.memory.errors import InvalidMemoryCitationError
from powercontext.builtin.persistence.source_lifecycle import SourceLifecycleNode, SourceLifecycleRepository
from powercontext.builtin.sources import validate_scope_id
from powercontext.errors import ArtifactError, ArtifactNotFoundError
from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import SourceRef

if TYPE_CHECKING:
    from powercontext.builtin.runtime.application import BuiltinRuntime

SOURCE_FAMILY = "source"
MEMORY_FAMILY = "memory"
TOPIC_FAMILY = "topic"

GENERATION_PURPOSE = "generation"
AUDIT_PURPOSE = "audit"

_PURPOSES = frozenset({GENERATION_PURPOSE, AUDIT_PURPOSE})
_POLICIES = frozenset({"all", "any"})
NodeFamily = Literal["source", "memory", "topic"]
NodePolicy = Literal["all", "any"]


class SourceLifecycleError(ValueError):
    """A lifecycle request that cannot be honoured by the Scope's current graph."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class SourceLifecycleEvent(BaseModel):
    """One caller-declared availability event for a registered Source.

    ``revision`` names the Source lifecycle version the caller is acting on and must equal the
    revision given at registration; ``sequence`` orders the events of that Source, so a stale or
    contradictory event is rejected instead of silently winning.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    node_id: Annotated[str, Field(min_length=1, max_length=MAX_SOURCE_ID_LENGTH)]
    revision: Annotated[int, Field(strict=True, gt=0)]
    sequence: Annotated[int, Field(strict=True, gt=0)]
    available: Annotated[bool, Field(strict=True)]
    reason: Annotated[str, Field(min_length=1, max_length=1024)]

    @field_validator("node_id", "reason")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("blank")
        return value


@dataclass(frozen=True)
class _Registration:
    """One validated node the caller wants registered."""

    node_id: str
    family: NodeFamily
    parents: tuple[str, ...]
    policy: NodePolicy
    reference: dict[str, object]
    revision: int


class SourceLifecycleApplication:
    """Select the lifecycle service for one Scope."""

    def __init__(self, runtime: BuiltinRuntime) -> None:
        self._runtime = runtime

    def for_scope(self, scope_id: str, /) -> ScopedSourceLifecycle:
        return ScopedSourceLifecycle(self._runtime, scope_id)

    async def inactive_topic_artifact_ids(self, scope_id: str, /) -> frozenset[str]:
        """Return the Topic Memory artifacts that lost their support in this Scope."""

        return await ScopedSourceLifecycle(self._runtime, scope_id).inactive_topic_artifact_ids()


class ScopedSourceLifecycle:
    """Register an evidence graph, apply Source events, and resolve node references."""

    def __init__(self, runtime: BuiltinRuntime, scope_id: str) -> None:
        self._runtime = runtime
        self.scope_id = validate_scope_id(scope_id)

    async def register_source(self, node_id: str, source_ref: SourceRef, /, *, revision: int) -> None:
        """Register one captured Source at a caller-owned lifecycle revision."""

        _require_node_id(node_id)
        if type(revision) is not int or revision < 1:
            raise SourceLifecycleError("revision")
        await self._register(
            _Registration(
                node_id=node_id,
                family=SOURCE_FAMILY,
                parents=(),
                policy="all",
                reference=source_ref.model_dump(mode="json"),
                revision=revision,
            )
        )

    async def register_memory(
        self,
        node_id: str,
        citation: MemoryCitation,
        /,
        *,
        parents: tuple[str, ...],
        policy: NodePolicy = "all",
    ) -> None:
        """Register one Memory entry derived from already-registered parents."""

        await self._register(
            _Registration(
                node_id=_require_node_id(node_id),
                family=MEMORY_FAMILY,
                parents=_require_parents(node_id, parents),
                policy=_require_policy(policy),
                reference=citation.model_dump(mode="json"),
                revision=0,
            )
        )

    async def register_topic(
        self,
        node_id: str,
        artifact_ref: ArtifactRef,
        /,
        *,
        parents: tuple[str, ...],
        policy: NodePolicy = "all",
    ) -> None:
        """Register one Topic Memory revision derived from already-registered parents."""

        await self._register(
            _Registration(
                node_id=_require_node_id(node_id),
                family=TOPIC_FAMILY,
                parents=_require_parents(node_id, parents),
                policy=_require_policy(policy),
                reference=artifact_ref.model_dump(mode="json"),
                revision=0,
            )
        )

    async def apply(self, event: SourceLifecycleEvent, /) -> list[str]:
        """Apply one Source event, propagate it, and return every available node id."""

        async with self._runtime._scoped_operation(self.scope_id), self._runtime._locked(self.scope_id):
            nodes = await self._nodes()
            source = nodes.get(event.node_id)
            if source is None or source.family != SOURCE_FAMILY:
                raise SourceLifecycleError("unknown-source")
            if event.revision != source.revision:
                raise SourceLifecycleError("revision")
            if event.sequence < source.sequence:
                raise SourceLifecycleError("sequence")
            replay = event.sequence == source.sequence
            if replay and event.available != source.available:
                raise SourceLifecycleError("sequence")
            if not replay:
                await self._repository.advance_source(
                    self.scope_id, event.node_id, available=event.available, sequence=event.sequence
                )
                nodes[event.node_id] = replace(source, available=event.available, sequence=event.sequence)
            await self._propagate(nodes, reason=event.reason)
            return sorted(node_id for node_id, node in nodes.items() if node.active)

    async def resolve(self, node_id: str, /, *, purpose: str) -> SourceRef | MemoryCitation | ArtifactRef:
        """Resolve one node for generation (must be usable) or for audit (always readable)."""

        if purpose not in _PURPOSES:
            raise SourceLifecycleError("purpose")
        node = (await self._nodes()).get(node_id)
        if node is None:
            raise SourceLifecycleError("unknown-node")
        if purpose == GENERATION_PURPOSE and not node.active:
            raise SourceLifecycleError("inactive")
        return _decoded(node)

    async def inactive_topic_artifact_ids(self) -> frozenset[str]:
        """Return the Topic Memory artifacts currently excluded from search and Context."""

        nodes = await self._nodes()
        return frozenset(
            str(node.reference.get("artifact_id"))
            for node in nodes.values()
            if node.family == TOPIC_FAMILY and not node.active
        )

    @property
    def _repository(self) -> SourceLifecycleRepository:
        database = getattr(self._runtime, "_lifecycle_database", None)
        if database is None:
            raise SourceLifecycleError("lifecycle-store")
        return SourceLifecycleRepository(database)

    async def _nodes(self) -> dict[str, SourceLifecycleNode]:
        return {node.node_id: node for node in await self._repository.nodes(self.scope_id)}

    async def _register(self, registration: _Registration) -> None:
        async with self._runtime._scoped_operation(self.scope_id), self._runtime._locked(self.scope_id):
            nodes = await self._nodes()
            existing = nodes.get(registration.node_id)
            if existing is not None:
                if _matches(existing, registration):
                    return
                raise SourceLifecycleError("conflict")
            for parent in registration.parents:
                if parent not in nodes:
                    raise SourceLifecycleError("unknown-parent")
            await self._verify_reference(registration)
            available = _available(
                registration.parents,
                registration.policy,
                {node_id: node.available for node_id, node in nodes.items()},
            )
            node = SourceLifecycleNode(
                scope_id=self.scope_id,
                node_id=registration.node_id,
                family=registration.family,
                ordinal=max((item.ordinal for item in nodes.values()), default=0) + 1,
                parents=registration.parents,
                policy=registration.policy,
                reference=registration.reference,
                revision=registration.revision,
                sequence=0,
                available=True if registration.family == SOURCE_FAMILY else available,
                state="active" if registration.family == SOURCE_FAMILY or available else "inactive",
            )
            try:
                await self._repository.insert(node)
            except IntegrityError as error:
                raise SourceLifecycleError("conflict") from error
            if node.family == MEMORY_FAMILY and not node.active:
                await self._set_memory_eligibility(node, active=False, reason="lifecycle:unsupported")

    async def _propagate(self, nodes: dict[str, SourceLifecycleNode], *, reason: str) -> None:
        """Recompute every node's eligibility in registration order and move the flipped ones."""

        ordered = sorted(nodes.values(), key=lambda node: node.ordinal)
        available: dict[str, bool] = {}
        for node in ordered:
            available[node.node_id] = (
                node.available
                if node.family == SOURCE_FAMILY
                else _available(node.parents, node.policy, available)
            )
        for node in ordered:
            desired = "active" if available[node.node_id] else "inactive"
            if node.state == desired:
                continue
            if node.family == MEMORY_FAMILY:
                await self._set_memory_eligibility(node, active=desired == "active", reason=reason)
            await self._repository.set_state(self.scope_id, node.node_id, state=desired)
            nodes[node.node_id] = replace(node, state=desired)

    async def _set_memory_eligibility(self, node: SourceLifecycleNode, *, active: bool, reason: str) -> None:
        """Move one Memory entry between active and inactive without touching its body."""

        citation = MemoryCitation.model_validate(node.reference)
        async with self._runtime._context(self.scope_id) as context:
            service = context.artifacts.memory
            try:
                current, entries = await service.head_entries(context.artifacts.memory_artifact_id)
            except ArtifactNotFoundError as error:
                raise SourceLifecycleError("memory-missing") from error
            entry = next((item for item in entries if item.entry_id == citation.entry_id), None)
            if entry is None:
                raise SourceLifecycleError("memory-entry-missing")
            states = {item.entry_id: item.state for item in current.content.manifest.entries}
            if (states.get(entry.entry_id) == "active") == active:
                return
            if active:
                await service.reactivate(current, entries=(entry,), reason=reason)
            else:
                await service.forget(current, entries=(entry,), reason=reason)

    async def _verify_reference(self, registration: _Registration) -> None:
        """Prove the registered reference exists and can be read back right now."""

        if registration.family == SOURCE_FAMILY:
            await self._verify_source(SourceRef.model_validate(registration.reference))
            return
        if registration.family == MEMORY_FAMILY:
            await self._verify_memory(MemoryCitation.model_validate(registration.reference))
            return
        await self._verify_topic(ArtifactRef.model_validate(registration.reference))

    async def _verify_source(self, reference: SourceRef) -> None:
        async with self._runtime._context(self.scope_id) as context:
            refs = [context.sources.catalog.as_ref(source) for source in await context.sources.list()]
        if reference not in refs:
            raise SourceLifecycleError("source-missing")

    async def _verify_memory(self, citation: MemoryCitation) -> None:
        async with self._runtime._context(self.scope_id) as context:
            service = context.artifacts.memory
            try:
                await service.validate_citation(citation)
            except (ArtifactNotFoundError, InvalidMemoryCitationError) as error:
                raise SourceLifecycleError("memory-missing") from error

    async def _verify_topic(self, reference: ArtifactRef) -> None:
        reader = self._runtime.records.for_scope(self.scope_id)
        try:
            await reader.get_artifact_revision(reference.family, reference.artifact_id, reference.revision)
        except (ArtifactError, LookupError) as error:
            raise SourceLifecycleError("topic-missing") from error


def _available(parents: tuple[str, ...], policy: str, available: dict[str, bool]) -> bool:
    support = [available.get(parent, False) for parent in parents]
    if not support:
        return False
    return all(support) if policy == "all" else any(support)


def _matches(node: SourceLifecycleNode, registration: _Registration) -> bool:
    return (
        node.family == registration.family
        and node.parents == registration.parents
        and node.policy == registration.policy
        and node.revision == registration.revision
        and node.reference == json.loads(json.dumps(registration.reference, ensure_ascii=False, sort_keys=True))
    )


def _decoded(node: SourceLifecycleNode) -> SourceRef | MemoryCitation | ArtifactRef:
    if node.family == SOURCE_FAMILY:
        return SourceRef.model_validate(node.reference)
    if node.family == MEMORY_FAMILY:
        return MemoryCitation.model_validate(node.reference)
    return ArtifactRef.model_validate(node.reference)


def _require_node_id(node_id: object) -> str:
    if type(node_id) is not str or not node_id.strip() or len(node_id) > MAX_SOURCE_ID_LENGTH:
        raise SourceLifecycleError("node-id")
    return node_id


def _require_parents(node_id: str, parents: object) -> tuple[str, ...]:
    if type(parents) is not tuple:
        raise SourceLifecycleError("parents")
    if not parents:
        raise SourceLifecycleError("parents")
    for parent in parents:
        if type(parent) is not str or not parent.strip():
            raise SourceLifecycleError("parents")
    if len(set(parents)) != len(parents):
        raise SourceLifecycleError("parents")
    if node_id in parents:
        raise SourceLifecycleError("cycle")
    return parents


def _require_policy(policy: object) -> NodePolicy:
    if policy not in _POLICIES:
        raise SourceLifecycleError("policy")
    return policy  # type: ignore[return-value]
