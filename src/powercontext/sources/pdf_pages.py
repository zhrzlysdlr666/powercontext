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

"""Capture every physical page of one PDF document as an immutable Source.

A page keeps its extracted text, the digest of the whole document revision it was
read from, and its one-based physical page number. Identity includes the document
digest so a new revision of the same document never overwrites older pages.
"""

from __future__ import annotations

import hashlib
import io
import re
from typing import Annotated

from pydantic import BaseModel, Field, field_validator
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import TEXT_EVIDENCE_PROJECTION_KEY, AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

PDF_PAGE_SOURCE_NAME = "pdf-page"
_READ_ERRORS = (PdfReadError, OSError, ValueError, KeyError, TypeError)
NonEmptyText = Annotated[str, Field(min_length=1)]


class PDFDocumentInput(BaseModel):
    """One complete PDF revision to parse into page Sources."""

    document_id: NonEmptyText
    content: bytes

    @field_validator("document_id")
    @classmethod
    def reject_blank_document_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("document_id must not be blank")  # noqa: TRY003
        return value


class PDFPageInput(BaseModel):
    """One physical page of a parsed PDF document."""

    document_id: NonEmptyText
    document_sha256: str
    page_number: Annotated[int, Field(ge=1)]
    text: str


class PDFPageSource(Source):
    """Captured page text bound to its document revision and physical position."""

    document_id: str
    document_sha256: str
    page_number: int
    text: str


def _page_identity(document_id: str, document_sha256: str, page_number: int) -> str:
    """Derive a stable identity that separates pages and document revisions."""

    candidate = f"{document_id}#{document_sha256[:32]}#{page_number}"
    if len(candidate) <= MAX_SOURCE_ID_LENGTH:
        return candidate
    digest = hashlib.sha256(f"{len(document_id)}:{document_id}{document_sha256}{page_number}".encode()).hexdigest()
    return f"{PDF_PAGE_SOURCE_NAME}:{digest}"


class PDFPageAdapter:
    """Resolve and read the PDF page Source Definition."""

    input_class = PDFPageInput
    name = PDF_PAGE_SOURCE_NAME
    source_class = PDFPageSource

    async def resolve(self, value: PDFPageInput, /) -> PDFPageSource:
        return PDFPageSource(
            name=_page_identity(value.document_id, value.document_sha256, value.page_number),
            materialization=SourceMaterialization.CAPTURED,
            document_id=value.document_id,
            document_sha256=value.document_sha256,
            page_number=value.page_number,
            text=value.text,
        )

    async def read(self, source: PDFPageSource, /) -> PDFPageInput:
        return PDFPageInput(
            document_id=source.document_id,
            document_sha256=source.document_sha256,
            page_number=source.page_number,
            text=source.text,
        )


class PDFPageTextEvidenceProjection:
    """Expose one page as standard text evidence keyed by document and page."""

    name = TEXT_EVIDENCE_PROJECTION_KEY.name
    version = TEXT_EVIDENCE_PROJECTION_KEY.version
    source_class = PDFPageSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PDFPageSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PDF_PAGE_SOURCE_NAME,
            source_id=source.name,
            content=f"{source.document_id}\n{source.text}",
            metadata={
                "document_id": source.document_id,
                "document_sha256": source.document_sha256,
                "page_number": source.page_number,
            },
        )


PDF_PAGE_SOURCE_DEFINITION = AdapterSourceDefinition(
    PDFPageAdapter(),
    projections=(PDFPageTextEvidenceProjection(),),
)


def parse_pdf_document(value: PDFDocumentInput, /) -> tuple[PDFPageInput, ...]:
    """Return every physical page in order, rejecting unreadable documents."""

    if not isinstance(value.content, bytes) or not value.content:
        raise ValueError("PDF document content must be non-empty bytes")  # noqa: TRY003
    if b"%PDF-" not in value.content[:1024]:
        raise ValueError("content is not a PDF document")  # noqa: TRY003

    reader = _open_reader(value.content)
    document_sha256 = hashlib.sha256(value.content).hexdigest()
    pages: list[PDFPageInput] = []
    try:
        total = len(reader.pages)
    except _READ_ERRORS as error:
        raise ValueError("PDF document has no readable page tree") from error  # noqa: TRY003
    if total < 1:
        raise ValueError("PDF document contains no pages")  # noqa: TRY003
    for index in range(total):
        try:
            text = reader.pages[index].extract_text() or ""
        except _READ_ERRORS:
            text = ""
        pages.append(
            PDFPageInput(
                document_id=value.document_id,
                document_sha256=document_sha256,
                page_number=index + 1,
                text=text,
            )
        )
    return tuple(pages)


def _open_reader(content: bytes) -> PdfReader:
    try:
        reader = PdfReader(io.BytesIO(content), strict=False)
        encrypted = reader.is_encrypted
    except _READ_ERRORS as error:
        raise ValueError("content is not a readable PDF document") from error  # noqa: TRY003
    if encrypted and not reader.decrypt(""):
        # An empty user password is a permissions-only marker: the text stays readable.
        raise ValueError("PDF document requires a user password")  # noqa: TRY003
    return reader


_STOPWORDS = frozenset(
    ["a", "about", "above", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can", "could", "did", "do", "does", "during", "each", "few", "for", "from", "further", "had", "has", "have", "how", "in", "into", "is", "it", "its", "may", "might", "more", "most", "must", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "our", "out", "over", "own", "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "who", "whom", "why", "will", "with", "would", "you", "your"]
)


def _informative_terms(question: str) -> tuple[str, ...]:
    """Pick the content-bearing words of a natural-language question."""

    terms: list[str] = []
    seen: set[str] = set()
    for token in re.findall(r"[a-z]+|\d+(?:[.,]\d+)*", question.lower()):
        if len(token) < 2 or token in _STOPWORDS or token in seen:
            continue
        seen.add(token)
        terms.append(token)
    return tuple(terms)


async def _fts_hits(memory: object, request_class: object, query: str, limit: int) -> list[object]:
    page = await memory.search(request_class(query=query, mode="fts", limit=limit))
    return list(page.hits)


def _fuse(rankings: list[list[object]]) -> list[object]:
    """Merge rankings with reciprocal-rank fusion and drop repeated entries."""

    scores: dict[tuple[str, str], float] = {}
    first_hit: dict[tuple[str, str], object] = {}
    for ranking in rankings:
        for rank, hit in enumerate(ranking, start=1):
            key = (hit.entry_id, hit.entry_version_id)
            scores[key] = scores.get(key, 0.0) + 1.0 / (60.0 + rank)
            first_hit.setdefault(key, hit)
    ordered = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    return [first_hit[key] for key, _ in ordered]


async def search_pdf_pages(memory: object, question: str, limit: int = 10) -> tuple[object, ...]:
    """Search page evidence for one question and return distinct page citations."""

    from powercontext.artifacts import MemoryCitation
    from powercontext.builtin.runtime import GetMemoryEntryRequest, SearchMemoryRequest

    if not isinstance(question, str) or not question.strip():
        raise ValueError("question must be a non-empty string")  # noqa: TRY003
    if limit < 1:
        raise ValueError("limit must be positive")  # noqa: TRY003

    pool = max(limit * 5, 100)
    rankings: list[list[object]] = [await _fts_hits(memory, SearchMemoryRequest, question, pool)]
    keywords = _informative_terms(question)
    if keywords:
        keyword_query = " ".join(keywords)
        if keyword_query.lower() != question.strip().lower():
            rankings.append(await _fts_hits(memory, SearchMemoryRequest, keyword_query, pool))

    citations: list[MemoryCitation] = []
    seen: set[str] = set()
    examined = 0
    for hit in _fuse(rankings):
        if len(citations) >= limit or examined >= limit * 4:
            break
        examined += 1
        citation = MemoryCitation(
            memory_ref=hit.memory_ref,
            entry_id=hit.entry_id,
            entry_version_id=hit.entry_version_id,
        )
        entry = (await memory.get(GetMemoryEntryRequest(citation=citation))).entry
        page_sources = [reference for reference in entry.sources if reference.source_type == PDF_PAGE_SOURCE_NAME]
        if not page_sources:
            continue
        identity = page_sources[0].source_id
        if identity in seen:
            continue
        seen.add(identity)
        citations.append(citation)
    return tuple(citations)


__all__ = [
    "PDF_PAGE_SOURCE_DEFINITION",
    "PDF_PAGE_SOURCE_NAME",
    "PDFDocumentInput",
    "PDFPageInput",
    "PDFPageSource",
    "parse_pdf_document",
    "search_pdf_pages",
]
