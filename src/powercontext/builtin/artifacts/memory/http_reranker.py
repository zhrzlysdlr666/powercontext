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

"""HTTP cross-encoder reranking for coarse Memory search candidates."""

from __future__ import annotations

import math

import httpx

from powercontext.builtin.artifacts.memory.models import MemoryHit
from powercontext.builtin.artifacts.memory.reranking import MemoryRerankDecision
from powercontext.builtin.inference import InferenceUsage

DEFAULT_HTTP_RERANK_POLICY_ID = "http-cross-encoder-v1"


class HTTPMemoryReranker:
    """Score candidates through an HTTP service and select across batches.

    Each request carries at most ``batch_size`` candidates whose ``rank`` is
    the candidate's original one-based position in the full pool, never a
    per-batch index. Every response must cover exactly its batch, and the
    final selection is one global ordering over all scores, so a later batch
    can outrank an earlier one. Only ranks are returned; the coarse hits keep
    their entry and version identity.
    """

    def __init__(
        self,
        endpoint: str,
        *,
        client: httpx.AsyncClient,
        batch_size: int = 32,
        policy_id: str = DEFAULT_HTTP_RERANK_POLICY_ID,
    ) -> None:
        if not isinstance(endpoint, str) or not endpoint.strip():
            raise ValueError("rerank endpoint must be a non-empty string")  # noqa: TRY003
        if type(batch_size) is not int or batch_size <= 0:
            raise ValueError("batch_size must be a positive integer")  # noqa: TRY003
        if not isinstance(policy_id, str) or not policy_id.strip():
            raise ValueError("policy_id must be a non-empty string")  # noqa: TRY003
        self.endpoint = endpoint
        self.batch_size = batch_size
        self.policy_id = policy_id
        self._client = client

    async def rerank(
        self,
        query: str,
        candidates: tuple[MemoryHit, ...],
        limit: int,
        /,
    ) -> MemoryRerankDecision:
        """Score every candidate once and return the best original ranks."""

        if not candidates:
            raise ValueError("rerank requires at least one candidate")  # noqa: TRY003
        if type(limit) is not int or limit < 1 or limit > len(candidates):
            raise ValueError("rerank limit must be between one and the candidate count")  # noqa: TRY003

        scores: dict[int, float] = {}
        requests = 0
        for start in range(0, len(candidates), self.batch_size):
            ranks = list(range(start + 1, min(start + self.batch_size, len(candidates)) + 1))
            payload = {
                "query": query,
                "candidates": [{"rank": rank, "text": candidates[rank - 1].text} for rank in ranks],
            }
            response = await self._client.post(self.endpoint, json=payload)
            response.raise_for_status()
            requests += 1
            scores.update(_validated_scores(response, ranks))

        ordered = sorted(scores, key=lambda rank: (-scores[rank], rank))
        return MemoryRerankDecision(
            selected_ranks=tuple(ordered[:limit]),
            usage=InferenceUsage(requests=requests),
        )


def _validated_scores(response: httpx.Response, ranks: list[int], /) -> dict[int, float]:
    """Validate one batch response and map its scores onto the global ranks."""

    try:
        payload = response.json()
    except ValueError as error:  # includes JSONDecodeError
        raise ValueError(f"rerank response must be valid JSON: {error}") from None
    if not isinstance(payload, dict) or set(payload) != {"scores"}:
        raise ValueError("rerank response must contain exactly one 'scores' field")  # noqa: TRY003
    rows = payload["scores"]
    if not isinstance(rows, list):
        raise ValueError("rerank scores must be a list")  # noqa: TRY003
    if len(rows) != len(ranks):
        raise ValueError("rerank response must cover exactly its batch")  # noqa: TRY003

    expected = set(ranks)
    observed: set[int] = set()
    scored: dict[int, float] = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"rank", "score"}:
            raise ValueError("every rerank score must contain exactly 'rank' and 'score'")  # noqa: TRY003
        rank = row["rank"]
        if type(rank) is not int or rank not in expected or rank in observed:
            raise ValueError("rerank scores must cover each batch rank exactly once")  # noqa: TRY003
        score = row["score"]
        if type(score) not in (int, float) or not math.isfinite(score):
            raise ValueError("rerank score must be a finite number")  # noqa: TRY003
        observed.add(rank)
        scored[rank] = float(score)
    if observed != expected:
        raise ValueError("rerank scores must cover each batch rank exactly once")  # noqa: TRY003
    return scored


__all__ = ["DEFAULT_HTTP_RERANK_POLICY_ID", "HTTPMemoryReranker"]
