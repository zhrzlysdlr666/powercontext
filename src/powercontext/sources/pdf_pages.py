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

"""Page-level PDF Source: every physical page is durable, citable evidence.

A financial report is only reproducible if a citation names the *exact* document revision and
the physical page it came from, so the page identity carries the SHA-256 of the bytes that were
parsed. A re-issued report therefore produces a different identity for every page instead of
silently overwriting what an earlier citation meant.
"""

from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from urllib.parse import quote

from pydantic import BaseModel

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

PDF_PAGE_SOURCE_NAME = "pdf-page"
PDF_PAGE_SOURCE_TYPE = "pdf-page"
_PDF_ID_PREFIX = "pdf:"


class PDFDocumentInput(BaseModel):
    """A complete offline PDF delivered as raw bytes."""

    document_id: str
    content: bytes


class PDFPageInput(BaseModel):
    """One physical page, addressed by document revision and one-based page number."""

    document_id: str
    document_sha256: str
    page_number: int
    text: str


# The published contract names the page model ``PDFPageInput``; ``PDFPage`` is the alias the
# adapters and projections use internally.
PDFPage = PDFPageInput


class PDFPageSource(Source):
    """A captured PDF page whose identity pins the document revision."""

    source_id: str
    document_id: str
    document_sha256: str
    page_number: int
    text: str


def pdf_page_source_id(document_id: str, document_sha256: str, page_number: int) -> str:
    """Build the stable page identity ``pdf:<document>:<revision>:<page>``.

    The published contract caps an identity at 256 characters, and a document identifier is
    free-form: a caller may hand over a whole path or a long title. A readable identity is
    kept when it fits so a citation stays legible, and from the same three values a fixed
    64-character digest of the identifier is used when it does not. Both forms are stable,
    differ between documents, and stay well inside the cap.
    """

    if not isinstance(document_id, str) or not document_id:
        raise ValueError("document_id must be a non-empty string")
    if document_id != document_id.strip():
        raise ValueError("document_id must not contain leading or trailing whitespace")
    if not isinstance(document_sha256, str) or len(document_sha256) != 64:
        raise ValueError("document_sha256 must be a 64-character hex digest")
    if not isinstance(page_number, int) or isinstance(page_number, bool) or page_number < 1:
        raise ValueError("page_number must be a positive integer")
    readable = (
        f"{_PDF_ID_PREFIX}{quote(document_id, safe='')}:"
        f"{quote(document_sha256, safe='')}:{page_number}"
    )
    if len(readable) <= MAX_SOURCE_ID_LENGTH:
        return readable
    digest = sha256(document_id.encode("utf-8")).hexdigest()
    return f"{_PDF_ID_PREFIX}h:{digest}:{quote(document_sha256, safe='')}:{page_number}"


def _fail(message: str) -> None:
    raise ValueError(message)


def parse_pdf_document(value: PDFDocumentInput) -> tuple[PDFPageInput, ...]:
    """Parse every physical page of one PDF, atomically.

    Pages are returned in physical order starting at one. A page with no extractable text is
    still a page: it is returned with ``text=""`` rather than skipped, so page numbers keep
    matching the printed document. Encrypted documents are opened with the empty user password
    when the owner only restricted permissions. Any unreadable input raises ``ValueError`` and
    no partial page list escapes.
    """

    if not isinstance(value.document_id, str) or not value.document_id:
        _fail("document_id must be a non-empty string")
    if value.document_id != value.document_id.strip():
        _fail("document_id must not contain leading or trailing whitespace")
    content = value.content
    if not isinstance(content, (bytes, bytearray)) or not content:
        _fail("document content must be non-empty bytes")

    reader = _open_reader(bytes(content))
    digest = sha256(bytes(content)).hexdigest()
    pages: list[PDFPageInput] = []
    try:
        for index, page in enumerate(reader.pages, start=1):
            extracted = page.extract_text()
            pages.append(
                PDFPageInput(
                    document_id=value.document_id,
                    document_sha256=digest,
                    page_number=index,
                    text="" if extracted is None else str(extracted),
                )
            )
    except ValueError:
        raise
    except Exception as error:  # noqa: BLE001 - pypdf raises a broad set of read errors
        _fail(f"unreadable PDF page: {error}")
    if not pages:
        _fail("document must contain at least one page")
    return tuple(pages)


def _open_reader(content: bytes):
    try:
        from pypdf import PdfReader
    except ImportError as error:  # pragma: no cover - declared runtime dependency
        raise ValueError(f"pypdf is required to parse PDF documents: {error}") from error
    try:
        reader = PdfReader(BytesIO(content), strict=False)
        if reader.is_encrypted:
            # An empty user password opens the very common "permissions only" case; anything
            # genuinely password protected keeps raising instead of yielding empty pages.
            result = reader.decrypt("")
            if not result:
                _fail("encrypted PDF requires a user password")
    except ValueError:
        raise
    except Exception as error:  # noqa: BLE001 - normalise every reader failure to ValueError
        _fail(f"unreadable PDF document: {error}")
    return reader


class PDFPageSourceAdapter:
    """Resolve pages into captured Sources and read them back unchanged."""

    input_class = PDFPageInput
    name = PDF_PAGE_SOURCE_NAME
    source_class = PDFPageSource

    async def resolve(self, value: PDFPage, /) -> PDFPageSource:
        source_id = pdf_page_source_id(value.document_id, value.document_sha256, value.page_number)
        return PDFPageSource(
            name=source_id,
            materialization=SourceMaterialization.CAPTURED,
            source_id=source_id,
            document_id=value.document_id,
            document_sha256=value.document_sha256,
            page_number=value.page_number,
            text=value.text,
        )

    async def read(self, source: PDFPageSource, /) -> PDFPage:
        return PDFPageInput(
            document_id=source.document_id,
            document_sha256=source.document_sha256,
            page_number=source.page_number,
            text=source.text,
        )


class PDFPageTextEvidenceProjection:
    """Project one page as the standard ``powercontext.text-evidence`` shape."""

    name = "powercontext.text-evidence"
    version = "1"
    source_class = PDFPageSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: PDFPageSource, /) -> TextEvidence:
        return TextEvidence(
            source_type=PDF_PAGE_SOURCE_TYPE,
            source_id=source.source_id,
            content=f"{source.document_id}\n{source.text}",
            metadata={
                "document_id": source.document_id,
                "document_sha256": source.document_sha256,
                "page_number": source.page_number,
            },
        )


PDF_PAGE_SOURCE_DEFINITION = AdapterSourceDefinition(
    PDFPageSourceAdapter(),
    projections=(PDFPageTextEvidenceProjection(),),
)


async def search_pdf_pages(memory, question: str, limit: int = 10):
    """Return up to ``limit`` citations, one per distinct page, for one question.

    Retrieval runs over the page evidence already indexed in Memory and returns the exact
    Memory entry version behind every page, so each citation re-reads the page the answer
    was drawn from. The ranking itself lives in :mod:`powercontext.sources.pdf_retrieval`;
    pages are distinct by construction because one page is one entry.
    """

    from powercontext.sources.pdf_retrieval import search_pages

    return await search_pages(memory, question, limit=limit)


__all__ = [
    "PDFDocumentInput",
    "PDFPage",
    "PDFPageInput",
    "PDFPageSource",
    "PDF_PAGE_SOURCE_DEFINITION",
    "PDF_PAGE_SOURCE_NAME",
    "PDF_PAGE_SOURCE_TYPE",
    "parse_pdf_document",
    "pdf_page_source_id",
    "search_pdf_pages",
]
