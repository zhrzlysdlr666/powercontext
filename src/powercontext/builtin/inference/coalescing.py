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

"""Coalesce concurrent Embedding requests and reuse a bounded vector cache.

Callers keep their own order and usage: identical texts requested by concurrent
callers are embedded once, provider calls never exceed ``max_batch_size`` items,
and one cancelled caller neither cancels the shared provider call nor loses the
vectors another caller is waiting for.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict

from powercontext.builtin.artifacts.memory import EmbeddingProfile
from powercontext.builtin.inference.models import EmbeddingResult, EmbeddingVector, InferenceUsage
from powercontext.builtin.inference.protocols import EmbeddingModel


class _Waiter:
    """One caller waiting for the vectors of its distinct texts."""

    __slots__ = ("future", "input_tokens", "output_tokens", "remaining", "requests", "results")

    def __init__(self, missing: tuple[str, ...]) -> None:
        self.future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.remaining: set[str] = set(missing)
        self.results: dict[str, EmbeddingVector] = {}
        self.requests = 0
        self.input_tokens: int | None = None
        self.output_tokens: int | None = None

    def charge(self, usage: InferenceUsage) -> None:
        self.requests += usage.requests or 1
        self.input_tokens = _add(self.input_tokens, usage.input_tokens)
        self.output_tokens = _add(self.output_tokens, usage.output_tokens)

    def deliver(self, text: str, vector: EmbeddingVector) -> None:
        if text not in self.remaining:
            return
        self.remaining.discard(text)
        self.results[text] = vector
        if not self.remaining and not self.future.done():
            self.future.set_result(None)

    def fail(self, error: BaseException) -> None:
        if not self.future.done():
            self.future.set_exception(error)
            self.future.exception()  # mark retrieved so an abandoned waiter cannot warn

    def cancel(self) -> None:
        if not self.future.done():
            self.future.cancel()


class CoalescingEmbeddingModel:
    """An EmbeddingModel decorator with cross-call coalescing and an LRU cache."""

    def __init__(
        self,
        model: EmbeddingModel,
        *,
        max_batch_size: int = 16,
        coalesce_ms: int = 10,
        cache_size: int = 256,
    ) -> None:
        if max_batch_size < 1:
            raise ValueError("max_batch_size must be positive")  # noqa: TRY003
        if coalesce_ms < 0:
            raise ValueError("coalesce_ms must not be negative")  # noqa: TRY003
        if cache_size < 0:
            raise ValueError("cache_size must not be negative")  # noqa: TRY003
        self._model = model
        self.profile: EmbeddingProfile = model.profile
        self._max_batch_size = max_batch_size
        self._coalesce_seconds = coalesce_ms / 1000
        self._cache_size = cache_size
        self._cache: OrderedDict[str, EmbeddingVector] = OrderedDict()
        self._pending: dict[str, list[_Waiter]] = {}
        self._order: list[str] = []
        self._lock = asyncio.Lock()
        self._flush_task: asyncio.Task[None] | None = None
        self._calls: set[asyncio.Task[None]] = set()

    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
        sequence = tuple(texts)
        if not sequence:
            return EmbeddingResult(vectors=(), usage=InferenceUsage(requests=0))
        unique = tuple(dict.fromkeys(sequence))
        cached: dict[str, EmbeddingVector] = {}
        missing: list[str] = []
        for text in unique:
            vector = self._cached(text)
            if vector is None:
                missing.append(text)
            else:
                cached[text] = vector
        if not missing:
            return _result(sequence, cached, InferenceUsage(requests=0))

        waiter = _Waiter(tuple(missing))
        waiter.results.update(cached)
        async with self._lock:
            for text in missing:
                if text not in self._pending:
                    self._pending[text] = []
                    self._order.append(text)
                self._pending[text].append(waiter)
            self._start_flush_locked()
        try:
            await asyncio.shield(waiter.future)
        except asyncio.CancelledError:
            waiter.cancel()
            self._detach(waiter)
            raise
        usage = InferenceUsage(
            requests=waiter.requests,
            input_tokens=waiter.input_tokens,
            output_tokens=waiter.output_tokens,
        )
        return _result(sequence, waiter.results, usage)

    def _cached(self, text: str) -> EmbeddingVector | None:
        vector = self._cache.get(text)
        if vector is not None:
            self._cache.move_to_end(text)
        return vector

    def _start_flush_locked(self) -> None:
        if self._flush_task is None or self._flush_task.done():
            self._flush_task = asyncio.create_task(self._flush())

    def _detach(self, waiter: _Waiter) -> None:
        for text, waiters in tuple(self._pending.items()):
            if waiter in waiters:
                waiters.remove(waiter)
                if not waiters:
                    self._pending.pop(text, None)

    async def _flush(self) -> None:
        try:
            while True:
                if self._coalesce_seconds:
                    await asyncio.sleep(self._coalesce_seconds)
                async with self._lock:
                    batch = self._take_batch_locked()
                    if not batch:
                        self._flush_task = None
                        return
                task = asyncio.create_task(self._run_batch(batch))
                self._calls.add(task)
                task.add_done_callback(self._calls.discard)
        finally:
            async with self._lock:
                if not self._order and self._flush_task is asyncio.current_task():
                    self._flush_task = None

    def _take_batch_locked(self) -> tuple[str, ...]:
        batch: list[str] = []
        while self._order and len(batch) < self._max_batch_size:
            batch.append(self._order.pop(0))
        return tuple(batch)

    async def _run_batch(self, batch: tuple[str, ...]) -> None:
        try:
            result = await self._model.embed(batch)
        except Exception as error:
            self._fail(batch, error)
            return
        vectors = result.vectors
        if len(vectors) != len(batch):
            error = ValueError("Embedding provider returned an unexpected vector count")
            self._fail(batch, error)
            return
        usage = result.usage
        promises: list[tuple[str, list[_Waiter]]] = []
        served: dict[int, _Waiter] = {}
        for text in batch:
            waiters = self._pending.pop(text, [])
            promises.append((text, waiters))
            for waiter in waiters:
                served[id(waiter)] = waiter
        for waiter in served.values():
            waiter.charge(usage)
        for (text, waiters), vector in zip(promises, vectors, strict=True):
            self._remember(text, vector)
            for waiter in waiters:
                waiter.deliver(text, vector)

    def _fail(self, batch: tuple[str, ...], error: BaseException) -> None:
        served: dict[int, _Waiter] = {}
        for text in batch:
            for waiter in self._pending.pop(text, []):
                served[id(waiter)] = waiter
        for waiter in served.values():
            waiter.fail(error)

    def _remember(self, text: str, vector: EmbeddingVector) -> None:
        if self._cache_size == 0:
            return
        self._cache[text] = vector
        self._cache.move_to_end(text)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)


def _result(
    sequence: tuple[str, ...],
    vectors: dict[str, EmbeddingVector],
    usage: InferenceUsage,
) -> EmbeddingResult:
    return EmbeddingResult(vectors=tuple(vectors[text] for text in sequence), usage=usage)


def _add(current: int | None, value: int | None) -> int | None:
    if value is None:
        return current
    return value if current is None else current + value


__all__ = ["CoalescingEmbeddingModel"]
