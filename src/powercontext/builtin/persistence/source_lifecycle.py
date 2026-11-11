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

"""Relational storage for the Source lifecycle graph of one Scope.

The table holds only bindings and derived state; every referenced body stays in the
Artifact tables that already own it. A Scope has one writer, so a read followed by a
write inside the caller's per-Scope lock is the whole concurrency story here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from powercontext.builtin.persistence.database import AsyncDatabase
from powercontext.builtin.persistence.tables import SOURCE_LIFECYCLE_TABLE


@dataclass(frozen=True)
class SourceLifecycleNode:
    """One registered node of the evidence DAG plus its current derived state."""

    scope_id: str
    node_id: str
    family: str
    ordinal: int
    parents: tuple[str, ...]
    policy: str
    reference: dict[str, object]
    revision: int
    sequence: int
    available: bool
    state: str

    @property
    def active(self) -> bool:
        return self.state == "active"


class SourceLifecycleRepository:
    """Read and advance the lifecycle rows of one Scope."""

    def __init__(self, database: AsyncDatabase) -> None:
        self._database = database

    async def nodes(self, scope_id: str, /) -> tuple[SourceLifecycleNode, ...]:
        """Return every registered node in registration order, parents before children."""

        async with self._database.transaction() as connection:
            rows = await connection.execute(
                select(SOURCE_LIFECYCLE_TABLE)
                .where(SOURCE_LIFECYCLE_TABLE.c.scope_id == scope_id)
                .order_by(SOURCE_LIFECYCLE_TABLE.c.ordinal)
            )
            return tuple(_node(scope_id, row) for row in rows.mappings())

    async def insert(self, node: SourceLifecycleNode, /) -> None:
        """Append one validated node; a duplicate identity raises ``IntegrityError``."""

        async with self._database.transaction() as connection:
            await connection.execute(
                insert(SOURCE_LIFECYCLE_TABLE).values(
                    scope_id=node.scope_id,
                    node_id=node.node_id,
                    family=node.family,
                    ordinal=node.ordinal,
                    parents=json.dumps(list(node.parents), separators=(",", ":")),
                    policy=node.policy,
                    reference=json.dumps(node.reference, ensure_ascii=False, sort_keys=True),
                    revision=node.revision,
                    sequence=node.sequence,
                    available=node.available,
                    state=node.state,
                )
            )

    async def advance_source(self, scope_id: str, node_id: str, /, *, available: bool, sequence: int) -> None:
        """Record one applied event on its Source before the state is propagated."""

        await self._write(scope_id, node_id, available=available, sequence=sequence)

    async def set_state(self, scope_id: str, node_id: str, /, *, state: str) -> None:
        """Record the propagated eligibility of one node."""

        await self._write(scope_id, node_id, state=state)

    async def _write(self, scope_id: str, node_id: str, **values: object) -> None:
        async with self._database.transaction() as connection:
            await self._execute(connection, scope_id, node_id, values)

    async def _execute(
        self, connection: AsyncConnection, scope_id: str, node_id: str, values: dict[str, object]
    ) -> None:
        await connection.execute(
            update(SOURCE_LIFECYCLE_TABLE)
            .where(
                SOURCE_LIFECYCLE_TABLE.c.scope_id == scope_id,
                SOURCE_LIFECYCLE_TABLE.c.node_id == node_id,
            )
            .values(**values)
        )


def _node(scope_id: str, row: object) -> SourceLifecycleNode:
    mapping = dict(row)  # type: ignore[arg-type]
    return SourceLifecycleNode(
        scope_id=scope_id,
        node_id=mapping["node_id"],
        family=mapping["family"],
        ordinal=mapping["ordinal"],
        parents=tuple(json.loads(mapping["parents"])),
        policy=mapping["policy"],
        reference=json.loads(mapping["reference"]),
        revision=mapping["revision"],
        sequence=mapping["sequence"],
        available=bool(mapping["available"]),
        state=mapping["state"],
    )
