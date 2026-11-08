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

"""Row-level CSV Source: capture each data row as durable, citable evidence."""

from __future__ import annotations

import csv
import io
import json
from urllib.parse import quote

from pydantic import BaseModel

from powercontext.limits import MAX_SOURCE_ID_LENGTH
from powercontext.sources import AdapterSourceDefinition, TextEvidence
from powercontext.sources.models import Source, SourceMaterialization

CSV_ROW_SOURCE_NAME = "csv-row"
CSV_ROW_SOURCE_TYPE = "csv-row"
_CSV_ID_PREFIX = "csv:"


class CSVDocumentInput(BaseModel):
    """A complete offline CSV document delivered as raw bytes."""

    document_id: str
    primary_key: str
    content: bytes


class CSVRowInput(BaseModel):
    """One parsed, fully validated CSV data row with original fidelity."""

    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


class CSVRowSource(Source):
    """A captured CSV row whose identity is (document, primary key value)."""

    source_id: str
    document_id: str
    primary_key: str
    primary_key_value: str
    columns: tuple[str, ...]
    values: tuple[str, ...]


def csv_row_source_id(document_id: str, primary_key_value: str) -> str:
    """Build the stable row identity ``csv:<document>:<primary key value>``.

    Both components are percent-encoded with ``quote(component, safe="")`` so
    the ``:`` separator can never collide. The document id must be non-empty
    and free of leading/trailing whitespace; the final identity must not
    exceed 256 characters.
    """

    if not isinstance(document_id, str) or not document_id:
        raise ValueError("document_id must be a non-empty string")
    if document_id != document_id.strip():
        raise ValueError("document_id must not contain leading or trailing whitespace")
    if not isinstance(primary_key_value, str) or not primary_key_value:
        raise ValueError("primary_key_value must be a non-empty string")
    identity = (
        f"{_CSV_ID_PREFIX}{quote(document_id, safe='')}:"
        f"{quote(primary_key_value, safe='')}"
    )
    if len(identity) > MAX_SOURCE_ID_LENGTH:
        raise ValueError(f"source identity must not exceed {MAX_SOURCE_ID_LENGTH} characters")
    return identity


def _fail(message: str) -> None:
    raise ValueError(message)


def _decode_document(content: bytes) -> str:
    try:
        text = content.decode("utf-8")
    except (UnicodeDecodeError, AttributeError) as error:
        _fail(f"document must be valid UTF-8: {error}")
    if text.startswith("\ufeff"):
        text = text[1:]
    return text


def _read_records(text: str) -> list[list[str]]:
    try:
        return list(csv.reader(io.StringIO(text, newline=""), strict=True))
    except csv.Error as error:
        _fail(f"malformed CSV: {error}")


def parse_csv_document(value: CSVDocumentInput) -> tuple[CSVRowInput, ...]:
    """Parse a whole CSV document atomically into row inputs.

    The first record is the header. Header fields must be non-empty, not pure
    whitespace, and unique (compared exactly, without trimming). The primary
    key must name one header column exactly. Data records must match the
    header width, carry a non-blank unique primary key value, and keep every
    field as the original string. Blank physical records are ignored. Any
    encoding, format, or validation error raises ``ValueError`` and no partial
    rows are returned.
    """

    if not isinstance(value.document_id, str) or not value.document_id:
        _fail("document_id must be a non-empty string")
    if value.document_id != value.document_id.strip():
        _fail("document_id must not contain leading or trailing whitespace")
    if not isinstance(value.primary_key, str) or not value.primary_key:
        _fail("primary_key must be a non-empty string")

    text = _decode_document(value.content)
    records = _read_records(text)
    if not records:
        _fail("document must contain a header record")
    header = records[0]
    if not header:
        _fail("header record must not be empty")
    for field in header:
        if not field or not field.strip():
            _fail("header fields must be non-empty and not pure whitespace")
    if len(set(header)) != len(header):
        _fail("header fields must be unique")
    if value.primary_key not in header:
        _fail(f"primary_key {value.primary_key!r} must exactly match one header column")
    key_index = header.index(value.primary_key)
    width = len(header)

    rows: list[CSVRowInput] = []
    seen: set[str] = set()
    for record in records[1:]:
        if not record:
            continue
        if len(record) != width:
            _fail(f"data record width {len(record)} does not match header width {width}")
        primary_key_value = record[key_index]
        if not primary_key_value or not primary_key_value.strip():
            _fail("primary key value must not be empty or pure whitespace")
        if primary_key_value in seen:
            _fail(f"duplicate primary key value {primary_key_value!r}")
        seen.add(primary_key_value)
        rows.append(
            CSVRowInput(
                document_id=value.document_id,
                primary_key=value.primary_key,
                primary_key_value=primary_key_value,
                columns=tuple(header),
                values=tuple(record),
            )
        )
    return tuple(rows)


class CSVRowSourceAdapter:
    """Resolve rows into captured Sources and read them back unchanged."""

    input_class = CSVRowInput
    name = CSV_ROW_SOURCE_NAME
    source_class = CSVRowSource

    async def resolve(self, value: CSVRowInput, /) -> CSVRowSource:
        source_id = csv_row_source_id(value.document_id, value.primary_key_value)
        return CSVRowSource(
            name=source_id,
            materialization=SourceMaterialization.CAPTURED,
            source_id=source_id,
            document_id=value.document_id,
            primary_key=value.primary_key,
            primary_key_value=value.primary_key_value,
            columns=value.columns,
            values=value.values,
        )

    async def read(self, source: CSVRowSource, /) -> CSVRowInput:
        return CSVRowInput(
            document_id=source.document_id,
            primary_key=source.primary_key,
            primary_key_value=source.primary_key_value,
            columns=source.columns,
            values=source.values,
        )


class CSVRowTextEvidenceProjection:
    """Project one row as the standard ``powercontext.text-evidence`` shape."""

    name = "powercontext.text-evidence"
    version = "1"
    source_class = CSVRowSource
    output_class: type[BaseModel] = TextEvidence

    def project(self, source: CSVRowSource, /) -> TextEvidence:
        row = {column: value for column, value in zip(source.columns, source.values, strict=True)}
        return TextEvidence(
            source_type=CSV_ROW_SOURCE_TYPE,
            source_id=source.source_id,
            content=json.dumps(row, ensure_ascii=False, separators=(",", ":")),
            metadata={
                "document_id": source.document_id,
                "primary_key": source.primary_key,
                "primary_key_value": source.primary_key_value,
                "columns": list(source.columns),
                "row": row,
            },
        )


CSV_ROW_SOURCE_DEFINITION = AdapterSourceDefinition(
    CSVRowSourceAdapter(),
    projections=(CSVRowTextEvidenceProjection(),),
)

__all__ = [
    "CSV_ROW_SOURCE_DEFINITION",
    "CSV_ROW_SOURCE_NAME",
    "CSV_ROW_SOURCE_TYPE",
    "CSVDocumentInput",
    "CSVRowInput",
    "CSVRowSource",
    "csv_row_source_id",
    "parse_csv_document",
]
