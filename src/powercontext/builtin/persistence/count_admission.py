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

"""Durable count-threshold admission for Source-driven processing families."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncConnection

from powercontext.builtin.persistence.cursors import SourceCursorRepository
from powercontext.builtin.persistence.processing_intents import ArtifactProcessingIntentRepository
from powercontext.builtin.persistence.tables import SOURCE_JOURNAL_HEADS_TABLE


async def pending_source_count(
    connection: AsyncConnection,
    scope_id: str,
    binding_name: str,
    /,
) -> int:
    """Count persisted journal identities after the family's last success cursor.

    The count covers every durable journal entry for the scope — including
    lineage-only server Sources — and never counts replayed identities,
    because replay does not advance the journal head.
    """

    head = (
        await connection.execute(
            select(SOURCE_JOURNAL_HEADS_TABLE.c.position).where(SOURCE_JOURNAL_HEADS_TABLE.c.scope_id == scope_id)
        )
    ).scalar_one_or_none()
    if head is None:
        return 0
    cursor = await SourceCursorRepository().load(connection, scope_id, binding_name)
    return int(head) - (0 if cursor is None else cursor.cursor.sequence)


async def request_count_admission(
    connection: AsyncConnection,
    scope_id: str,
    binding_name: str,
    threshold: int,
    /,
) -> bool:
    """Request one processing invocation when pending entries reach ``threshold``.

    The caller must run inside an open transaction so the durable request is
    atomic with the journal write or acknowledgement that preceded it. At
    most one request may stay outstanding per scope and binding: the request
    is only issued when every previously requested invocation has been
    handled, which keeps repeated crossings from admitting windows whose
    pending count has already dropped below the threshold.
    """

    pending = await pending_source_count(connection, scope_id, binding_name)
    if pending < threshold:
        return False
    intents = ArtifactProcessingIntentRepository()
    intent = await intents.load(connection, scope_id, binding_name, for_update=True)
    if intent is not None and intent.requested_generation != intent.handled_generation:
        return False
    await intents.request(connection, scope_id, binding_name)
    return True
