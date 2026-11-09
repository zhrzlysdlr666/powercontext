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

"""Source lifecycle graph persistence.

The graph is stored as one canonical document per Scope rather than one row per node: node
registration is immutable and every accepted event rewrites availability in place, so a single
row is both the smallest representation and the only state a reader has to reconcile.
"""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from powercontext.builtin.persistence.codec import stored_bytes
from powercontext.builtin.persistence.database import AsyncDatabase
from powercontext.builtin.persistence.tables import SOURCE_LIFECYCLE_TABLE


class SourceLifecycleStore:
    """Read and replace the lifecycle document of one Scope."""

    def __init__(self, database: AsyncDatabase) -> None:
        self._database = database

    async def load(self, scope_id: str, /) -> bytes | None:
        async with self._database.transaction() as connection:
            return await load_lifecycle(connection, scope_id)

    async def store(self, scope_id: str, payload: bytes, /) -> None:
        async with self._database.transaction() as connection:
            await store_lifecycle(connection, scope_id, payload)


async def load_lifecycle(connection: AsyncConnection, scope_id: str, /) -> bytes | None:
    row = (
        await connection.execute(
            select(SOURCE_LIFECYCLE_TABLE.c.payload).where(SOURCE_LIFECYCLE_TABLE.c.scope_id == scope_id)
        )
    ).first()
    return None if row is None else stored_bytes(row[0], column="payload")


async def store_lifecycle(connection: AsyncConnection, scope_id: str, payload: bytes, /) -> None:
    updated = await connection.execute(
        update(SOURCE_LIFECYCLE_TABLE)
        .where(SOURCE_LIFECYCLE_TABLE.c.scope_id == scope_id)
        .values(payload=payload)
    )
    if updated.rowcount == 1:
        return
    # The Scope row is the parent key, so a first write can only race with another writer that
    # holds the same Scope lock this runtime holds; a retry-free insert is therefore safe.
    await connection.execute(
        SOURCE_LIFECYCLE_TABLE.insert().values(scope_id=scope_id, payload=payload)
    )


__all__ = ("SourceLifecycleStore", "load_lifecycle", "store_lifecycle")
