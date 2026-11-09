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

"""Evidence dependency lifecycle: withdraw a Source and everything derived from it.

Every node in a Scope's evidence graph is registered once with an explicit parent set and an
``all``/``any`` support policy. A Source node also carries the exact revision its derivations were
built from, so an event that claims a different revision is rejected instead of silently
invalidating downstream artifacts.

Availability is derived, never stored per descendant: the graph is acyclic by construction
(parents must already exist), so one pass over the registered nodes yields the complete truth.
Only the two families that hold mutable state need side effects — Memory entries are deactivated
so they leave every search projection, and Topic artifacts are excluded from Topic search and
therefore from Prepared Context, which recalls Topics through that same search.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from powercontext.artifacts import ArtifactRef, MemoryCitation
from powercontext.builtin.sources import validate_scope_id
from powercontext.builtin.statistics import ModelUsagePurpose
from powercontext.sources import SourceRef

if TYPE_CHECKING:
    from powercontext.builtin.runtime.application import BuiltinRuntime

_SOURCE = "source"
_MEMORY = "memory"
_TOPIC = "topic"
_POLICIES = frozenset({"all", "any"})
_GENERATION = "generation"
_AUDIT = "audit"


class SourceLifecycleError(RuntimeError):
    """Reject an event, registration, or resolution that the graph cannot honor."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code if not detail else f"{code}: {detail}")
        self.code = code
        self.detail = detail


class SourceLifecycleEvent(BaseModel):
    """One monotonic availability statement about a registered Source node."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    node_id: str
    revision: StrictInt = Field(ge=1)
    sequence: StrictInt = Field(ge=1)
    available: bool
    reason: str

    @field_validator("node_id", "reason")
    @classmethod
    def require_text(cls, value: str) -> str:
        if not value.strip() or value != value.strip():
            raise ValueError("must be a non-empty trimmed string")  # noqa: TRY003
        return value


class _NodeState(BaseModel):
    """One registered graph node, including the last accepted event for a Source."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["source", "memory", "topic"]
    reference: dict[str, Any]
    parents: tuple[str, ...] = ()
    policy: Literal["all", "any"] | None = None
    revision: StrictInt | None = Field(default=None, ge=1)
    sequence: StrictInt | None = Field(default=None, ge=1)
    available: bool = True
    reason: str | None = None


class _LifecycleGraph(BaseModel):
    """The complete authoritative lifecycle document of one Scope."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    nodes: dict[str, _NodeState] = {}


class LifecycleApplication:
    """Select the lifecycle service for one Scope."""

    def __init__(self, runtime: BuiltinRuntime) -> None:
        self._runtime = runtime

    def for_scope(self, scope_id: str, /) -> ScopedSourceLifecycleApplication:
        return ScopedSourceLifecycleApplication(self._runtime, scope_id)

    async def inactive_topic_artifact_ids(self, scope_id: str, /) -> frozenset[str]:
        """Return the Topic artifact ids this Scope must keep out of search."""

        graph = await self.for_scope(scope_id)._load()
        return frozenset(
            ArtifactRef.model_validate(node.reference).artifact_id
            for node in graph.nodes.values()
            if node.kind == _TOPIC and not node.available
        )

    async def unavailable_source_refs(self, scope_id: str, /) -> frozenset[tuple[str, int]]:
        """Return ``(source_id, revision)`` pairs whose evidence is withdrawn."""

        graph = await self.for_scope(scope_id)._load()
        return frozenset(
            (SourceRef.model_validate(node.reference).source_id, int(node.revision))
            for node in graph.nodes.values()
            if node.kind == _SOURCE and not node.available
        )


class ScopedSourceLifecycleApplication:
    """Register evidence nodes and apply availability events for one Scope."""

    def __init__(self, runtime: BuiltinRuntime, scope_id: str) -> None:
        self._runtime = runtime
        self.scope_id = validate_scope_id(scope_id)

    async def register_source(self, node_id: str, reference: SourceRef, /, *, revision: int) -> None:
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise SourceLifecycleError("invalid-revision")
        async with self._runtime._scoped_operation(self.scope_id), self._runtime._locked(self.scope_id):
            graph = await self._load()
            _require_absent(graph, node_id)
            graph.nodes[node_id] = _NodeState(
                kind=_SOURCE,
                reference=reference.model_dump(mode="json"),
                revision=revision,
            )
            await self._persist(graph)

    async def register_memory(
        self,
        node_id: str,
        citation: MemoryCitation,
        /,
        *,
        parents: Sequence[str],
        policy: str,
    ) -> None:
        await self._register(node_id, _MEMORY, citation, parents=parents, policy=policy)

    async def register_topic(
        self,
        node_id: str,
        reference: ArtifactRef,
        /,
        *,
        parents: Sequence[str],
        policy: str,
    ) -> None:
        await self._register(node_id, _TOPIC, reference, parents=parents, policy=policy)

    async def apply(self, event: SourceLifecycleEvent, /) -> list[str]:
        """Accept one event, propagate it, and return every currently available node id."""

        async with self._runtime._scoped_operation(self.scope_id), self._runtime._locked(self.scope_id):
            graph = await self._load()
            node = graph.nodes.get(event.node_id)
            if node is None:
                raise SourceLifecycleError("unknown-node", event.node_id)
            if node.kind != _SOURCE:
                raise SourceLifecycleError("not-a-source", event.node_id)
            if node.revision != event.revision:
                raise SourceLifecycleError("revision-mismatch", event.node_id)
            if node.sequence is not None:
                if event.sequence < node.sequence:
                    raise SourceLifecycleError("sequence-regression", event.node_id)
                if event.sequence == node.sequence:
                    if (event.available, event.reason) == (node.available, node.reason):
                        return _available_ids(_evaluate(graph.nodes))
                    raise SourceLifecycleError("sequence-conflict", event.node_id)
            before = {node_id: item.available for node_id, item in graph.nodes.items()}
            graph.nodes[event.node_id] = node.model_copy(
                update={
                    "sequence": event.sequence,
                    "available": event.available,
                    "reason": event.reason,
                }
            )
            active = _synchronize(graph)
            changed = [
                node_id
                for node_id, item in graph.nodes.items()
                if item.kind == _MEMORY and before[node_id] != item.available
            ]
            if changed:
                await self._reconcile_memory(graph, changed)
            await self._persist(graph)
            return _available_ids(active)

    async def resolve(self, node_id: str, /, *, purpose: str) -> SourceRef | MemoryCitation | ArtifactRef:
        """Return the exact registered reference, refusing generation use when unavailable."""

        if purpose not in {_GENERATION, _AUDIT}:
            raise SourceLifecycleError("invalid-purpose", purpose)
        graph = await self._load()
        node = graph.nodes.get(node_id)
        if node is None:
            raise SourceLifecycleError("unknown-node", node_id)
        if purpose == _GENERATION and not node.available:
            raise SourceLifecycleError("unavailable", node_id)
        return _reference(node)

    async def _register(
        self,
        node_id: str,
        kind: Literal["memory", "topic"],
        reference: MemoryCitation | ArtifactRef,
        /,
        *,
        parents: Sequence[str],
        policy: str,
    ) -> None:
        if policy not in _POLICIES:
            raise SourceLifecycleError("invalid-policy", policy)
        ordered = _ordered_parents(parents)
        async with self._runtime._scoped_operation(self.scope_id), self._runtime._locked(self.scope_id):
            graph = await self._load()
            _require_absent(graph, node_id)
            for parent in ordered:
                if parent not in graph.nodes:
                    raise SourceLifecycleError("unknown-parent", parent)
            graph.nodes[node_id] = _NodeState(
                kind=kind,
                reference=reference.model_dump(mode="json"),
                parents=ordered,
                policy=policy,
            )
            _synchronize(graph)
            if not graph.nodes[node_id].available and kind == _MEMORY:
                await self._reconcile_memory(graph, [node_id])
            await self._persist(graph)

    async def _reconcile_memory(self, graph: _LifecycleGraph, node_ids: Sequence[str]) -> None:
        """Move exactly these Memory nodes to the state the graph says they must hold."""

        targets: list[tuple[MemoryCitation, bool]] = [
            (MemoryCitation.model_validate(graph.nodes[node_id].reference), graph.nodes[node_id].available)
            for node_id in node_ids
        ]
        async with self._runtime._context(
            self.scope_id,
            embedding_purpose=ModelUsagePurpose.MEMORY_INDEXING,
        ) as context:
            service = context.artifacts.memory
            artifact_id = context.artifacts.memory_artifact_id
            for target, available in targets:
                # Entry versions are immutable, so a citation anchored in an older Revision still
                # names the exact version the current head holds; only the head may be written.
                entry = await service.validate_citation(target)
                head = await service.head(artifact_id)
                if available:
                    await service.reactivate(head, entries=(entry,), reason="source-restored")
                else:
                    await service.forget(head, entries=(entry,), reason="source-withdrawn")

    async def _load(self) -> _LifecycleGraph:
        store = self._runtime._lifecycle_store
        if store is None:
            # A Runtime composed without the store has no registered nodes, so every read is empty
            # rather than failing: recall must keep working when lifecycle tracking is unused.
            return _LifecycleGraph()
        payload = await store.load(self.scope_id)
        return _LifecycleGraph() if payload is None else _LifecycleGraph.model_validate_json(payload)

    async def _persist(self, graph: _LifecycleGraph) -> None:
        store = self._runtime._lifecycle_store
        if store is None:
            raise SourceLifecycleError("lifecycle-store")
        await store.store(self.scope_id, graph.model_dump_json().encode("utf-8"))


def _evaluate(nodes: Mapping[str, _NodeState]) -> dict[str, bool]:
    """Resolve every node's availability in one topological sweep."""

    resolved = {
        node_id: node.available for node_id, node in nodes.items() if node.kind == _SOURCE
    }
    pending = [node_id for node_id, node in nodes.items() if node.kind != _SOURCE]
    while pending:
        remaining: list[str] = []
        for node_id in pending:
            node = nodes[node_id]
            if any(parent not in resolved for parent in node.parents):
                remaining.append(node_id)
                continue
            support = [resolved[parent] for parent in node.parents]
            resolved[node_id] = all(support) if node.policy == "all" else any(support)
        if len(remaining) == len(pending):
            raise SourceLifecycleError("graph-unresolved", remaining[0])
        pending = remaining
    return resolved


def _synchronize(graph: _LifecycleGraph) -> dict[str, bool]:
    active = _evaluate(graph.nodes)
    for node_id, node in graph.nodes.items():
        if node.kind == _SOURCE or node.available == active[node_id]:
            continue
        graph.nodes[node_id] = node.model_copy(update={"available": active[node_id]})
    return active


def _available_ids(active: Mapping[str, bool]) -> list[str]:
    return sorted(node_id for node_id, available in active.items() if available)


def _reference(node: _NodeState) -> SourceRef | MemoryCitation | ArtifactRef:
    if node.kind == _SOURCE:
        return SourceRef.model_validate(node.reference)
    if node.kind == _MEMORY:
        return MemoryCitation.model_validate(node.reference)
    return ArtifactRef.model_validate(node.reference)


def _require_absent(graph: _LifecycleGraph, node_id: object) -> None:
    if not isinstance(node_id, str) or not node_id.strip() or node_id != node_id.strip():
        raise SourceLifecycleError("invalid-node-id")
    if node_id in graph.nodes:
        raise SourceLifecycleError("duplicate-node", node_id)


def _ordered_parents(parents: Sequence[str]) -> tuple[str, ...]:
    ordered = tuple(dict.fromkeys(parents))
    if not ordered:
        raise SourceLifecycleError("empty-parents")
    for parent in ordered:
        if not parent.strip() or parent != parent.strip():
            raise SourceLifecycleError("invalid-parent", parent)
    return ordered


__all__ = ("LifecycleApplication", "ScopedSourceLifecycleApplication", "SourceLifecycleError", "SourceLifecycleEvent")
