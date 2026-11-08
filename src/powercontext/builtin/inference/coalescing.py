"""Cross-call embedding coalescing with a bounded LRU vector cache (memory-02).

Concurrent ``embed`` calls that share texts share one underlying request:
identical texts inside a call, across calls in the coalescing window, and
late callers joining an already-dispatched batch all resolve through the same
future. Successful vectors are cached in a bounded LRU; failures are never
cached. Each call is billed only for the distinct underlying batches it
actually waited on, and cancelling one caller never cancels the shared work.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from powercontext.builtin.inference.models import EmbeddingResult, InferenceUsage

__all__ = ["CoalescingEmbeddingModel"]


def _merge_tokens(left: int | None, right: int | None) -> int | None:
    if left is None and right is None:
        return None
    return (left or 0) + (right or 0)


class _Batch:
    """One dispatched underlying request shared by every waiting caller."""

    __slots__ = ("texts", "usage")

    def __init__(self, texts: tuple[str, ...]) -> None:
        self.texts = texts
        self.usage: InferenceUsage | None = None


@dataclass
class _Entry:
    """Registry slot for one unique text waiting for its vector."""

    future: asyncio.Future
    batch: _Batch | None = None


class CoalescingEmbeddingModel:
    """Wrap an embedding model with request coalescing and an LRU vector cache."""

    def __init__(
        self,
        model: Any,
        *,
        max_batch_size: int = 64,
        coalesce_ms: float = 5.0,
        cache_size: int = 1024,
    ) -> None:
        if max_batch_size <= 0:
            raise ValueError("max_batch_size must be positive")
        if coalesce_ms < 0:
            raise ValueError("coalesce_ms must be non-negative")
        if cache_size < 0:
            raise ValueError("cache_size must be non-negative")
        self._model = model
        self._max_batch_size = max_batch_size
        self._coalesce_delay = coalesce_ms / 1000.0
        self._cache_size = cache_size
        self._cache: OrderedDict[str, tuple[float, ...]] = OrderedDict()
        self._entries: dict[str, _Entry] = {}
        self._pending: dict[str, _Entry] = {}
        self._flush_handle: asyncio.TimerHandle | None = None

    @property
    def profile(self):
        return self._model.profile

    async def embed(self, texts: tuple[str, ...], /) -> EmbeddingResult:
        texts = tuple(texts)
        if not texts:
            return EmbeddingResult(vectors=(), usage=InferenceUsage(requests=0))

        loop = asyncio.get_running_loop()
        waited: list[tuple[str, _Entry]] = []  # unique texts this call must resolve
        vectors: dict[str, tuple[float, ...]] = {}
        for text in dict.fromkeys(texts):
            cached = self._cache_get(text)
            if cached is not None:
                vectors[text] = cached
                continue
            entry = self._entries.get(text)
            if entry is None:
                entry = _Entry(future=loop.create_future())
                self._entries[text] = entry
                self._pending[text] = entry
                self._arm_flush(loop)
            waited.append((text, entry))

        batch_usage: list[_Batch] = []
        for text, entry in waited:
            vector = await asyncio.shield(entry.future)
            vectors[text] = vector
            batch = entry.batch
            if batch is not None and all(batch is not seen for seen in batch_usage):
                batch_usage.append(batch)

        usage = InferenceUsage(requests=0)
        for batch in batch_usage:
            other = batch.usage if batch.usage is not None else InferenceUsage(requests=0)
            usage = InferenceUsage(
                requests=usage.requests + other.requests,
                input_tokens=_merge_tokens(usage.input_tokens, other.input_tokens),
                output_tokens=_merge_tokens(usage.output_tokens, other.output_tokens),
            )
        return EmbeddingResult(
            vectors=tuple(vectors[text] for text in texts),
            usage=usage,
        )

    def _cache_get(self, text: str) -> tuple[float, ...] | None:
        if self._cache_size <= 0:
            return None
        vector = self._cache.get(text)
        if vector is not None:
            self._cache.move_to_end(text)
        return vector

    def _cache_put(self, text: str, vector: tuple[float, ...]) -> None:
        if self._cache_size <= 0:
            return
        self._cache[text] = vector
        self._cache.move_to_end(text)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)

    def _arm_flush(self, loop: asyncio.AbstractEventLoop) -> None:
        if self._flush_handle is None:
            self._flush_handle = loop.call_later(self._coalesce_delay, self._flush_due)

    def _flush_due(self) -> None:
        # Timer callbacks run inside the loop; dispatch synchronously so every
        # pending text — including ones registered after the timer fired but
        # before this callback ran — joins the batch now being formed.
        self._flush_handle = None
        if not self._pending:
            return
        chunk: list[tuple[str, _Entry]] = []
        for text, entry in list(self._pending.items()):
            self._pending.pop(text)
            chunk.append((text, entry))
            if len(chunk) == self._max_batch_size:
                self._dispatch(chunk)
                chunk = []
        if chunk:
            self._dispatch(chunk)

    def _dispatch(self, chunk: list[tuple[str, _Entry]]) -> None:
        batch = _Batch(tuple(text for text, _ in chunk))
        for _, entry in chunk:
            entry.batch = batch
        asyncio.get_running_loop().create_task(self._run_batch(batch))

    async def _run_batch(self, batch: _Batch) -> None:
        entries = [
            (text, entry)
            for text, entry in list(self._entries.items())
            if entry.batch is batch
        ]
        try:
            result = await self._model.embed(batch.texts)
            vectors = tuple(result.vectors)
            if len(vectors) != len(batch.texts):
                raise ValueError(
                    "embedding model returned "
                    f"{len(vectors)} vectors for {len(batch.texts)} texts"
                )
        except BaseException as error:  # noqa: BLE001 - propagated to every waiter
            for text, entry in entries:
                if self._entries.get(text) is entry:
                    self._entries.pop(text, None)
                if not entry.future.done():
                    entry.future.set_exception(error)
            return
        batch.usage = result.usage if result.usage is not None else InferenceUsage(requests=0)
        for (text, entry), vector in zip(entries, vectors):
            if self._entries.get(text) is entry:
                self._entries.pop(text, None)
            self._cache_put(text, vector)
            if not entry.future.done():
                entry.future.set_result(vector)
