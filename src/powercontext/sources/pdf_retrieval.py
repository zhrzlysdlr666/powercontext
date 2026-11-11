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

"""Evidence-page retrieval over the pages already stored in Memory.

A financial report question rarely quotes the page that answers it: *"gross margin"*
is not printed on a statement of operations, and *"legal battles"* is filed under
*"Legal Proceedings and Contingencies"*. A single bag-of-words pass over whole pages
therefore loses the page even though the page is right there. This module keeps one
offline index over the page evidence and combines several cheap, explainable views of
the same question:

``lexical``
    BM25 over the question as written, which keeps any number or quoted term intact.
``concept``
    BM25 over the content words only, with a small finance vocabulary expansion so that
    *battles* can reach *proceedings* and *geographies* can reach *segment*.
``phrase``
    Pages where adjacent question words also sit next to each other, which is what
    distinguishes a page *about* a metric from a page that merely repeats its words.
``statement``
    Pages that open a primary financial statement, where line-item questions land even
    when the question's wording never appears.
``neighbour``
    The physical pages either side of a strong hit, because tables and notes run over a
    page boundary while the annotation names a single page.

Every view votes inside a fixed budget and the votes are merged, so a question with no
structural hint still gets a normal lexical ranking, and a page that only one view
believes in still reaches the answer set. Nothing here reads answers, annotations or
grading assets: the index is built from the page text that Memory already holds, and
every returned citation is the Memory entry version that was indexed.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Iterable, Sequence

from powercontext.builtin.artifacts.memory.models import MemoryCitation

if TYPE_CHECKING:  # pragma: no cover - typing only
    from powercontext.builtin.runtime.models import MemoryEntriesPage

BM25_K1 = 1.2
BM25_B = 0.75

_WORD = re.compile(r"[a-z]+|\d+")
_PAGE_SUFFIX = re.compile(r":(\d+)$")
_ITEM_HEADING = re.compile(r"^Item\s+(\d+[A-C]?)\.", re.IGNORECASE)
_PRIMARY_STATEMENT = re.compile(
    r"consolidated statements? of (operations|income|earnings|cash flows?|financial position|equity)"
    r"|consolidated balance sheets?"
    r"|statements? of consolidated (income|operations|cash flows?|financial position|equity)",
    re.IGNORECASE,
)

# Question scaffolding that carries no page signal: every FinanceBench question ends with
# an instruction about how to answer, and those sentences flood a short query.
_INSTRUCTIONS = (
    re.compile(r"give a response to the question by relying on the details shown in[^.]*\.", re.IGNORECASE),
    re.compile(r"respond to the question by assuming the perspective of[^.]*\.", re.IGNORECASE),
    re.compile(r"(please\s+)?respond to the question by[^.]*\.", re.IGNORECASE),
    re.compile(r"answer in (usd|us\$)? ?(millions|billions|thousands)\.?", re.IGNORECASE),
)

_STOPWORDS = frozenset(
    """
    a an the and or of to in for on at by with from is are was were be been being as that this these those
    what which who whom whose when where why how does do did done has have had it its their they them there
    all any each other such than then so if not no may can could should would will shall we our us you your
    state stated explain provide give response question answer during period year years fiscal ended december
    """.split()
)

# Lines that open a page and name its topic: the note and section titles a filing writes for
# itself. Matching a question against those titles reaches a page whose body words differ.
_UPPER_TITLE = re.compile(r"^[A-Z0-9][A-Z0-9&,'()\-/. ]{3,70}$")
_MIXED_TITLE = re.compile(r"^[A-Z][A-Za-z&,'()\-/. ]{3,70}$")
# Small, hand-written bridge between the way questions are phrased and the way filings are
# written. Only one-step synonyms: no document, sector or company specific knowledge.
_EXPANSIONS: dict[str, tuple[str, ...]] = {
    "legal": ("proceedings", "litigation"),
    "battle": ("proceedings", "litigation"),
    "battles": ("proceedings", "litigation"),
    "lawsuit": ("litigation", "proceedings"),
    "geograph": ("geographic", "segment"),
    "geography": ("geographic", "segment"),
    "geographies": ("geographic", "segment"),
    "cyclicality": ("cyclical", "seasonal"),
    "cyclical": ("cyclical", "seasonal"),
    "capex": ("capital", "expenditure", "expenditures"),
    "customer": ("customers", "clients"),
    "customers": ("customer", "clients"),
    "employee": ("employees", "headcount"),
    "employees": ("employee", "headcount"),
    "headcount": ("employees",),
    "restructuring": ("charges", "severance"),
    "buyback": ("repurchase",),
    "dividend": ("dividends",),
    "category": ("categories", "segment"),
    "categories": ("category", "segment"),
    "debt": ("borrowings",),
    "profitability": ("margin", "income"),
    "profitable": ("margin", "income"),
}

# Quota per view when ``limit`` is 20. Views that found nothing leave their slots to the
# lexical views, so the totals stay below ``limit`` and the filler tops them up.
_VIEW_BUDGET = (
    ("statement", 3),
    ("table", 2),
    ("heading", 2),
    ("phrase", 3),
    ("neighbour", 2),
    ("concept", 8),
    ("lexical", 8),
)


@dataclass(frozen=True, slots=True)
class _StoredPage:
    page_number: int
    text: str
    citation: MemoryCitation


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def content_terms(question: str) -> list[str]:
    """Question words that can name something on a page, in the order asked."""

    cleaned = question
    for pattern in _INSTRUCTIONS:
        cleaned = pattern.sub(" ", cleaned)
    return [word for word in _words(cleaned) if word not in _STOPWORDS]


def _expand(terms: Sequence[str]) -> list[str]:
    expanded = list(terms)
    for term in terms:
        for extra in _EXPANSIONS.get(term, ()):
            if extra not in expanded:
                expanded.append(extra)
    return expanded


def _page_number(source_id: str, fallback: int) -> int:
    match = _PAGE_SUFFIX.search(source_id)
    return int(match.group(1)) if match else fallback


class _Corpus:
    """One immutable index over the pages of one Memory revision."""

    def __init__(self, pages: Sequence[_StoredPage]) -> None:
        self.pages = tuple(pages)
        self.postings: dict[str, dict[int, int]] = defaultdict(dict)
        self.lengths: list[int] = []
        self._digits: dict[int, int] = {}
        for position, page in enumerate(self.pages):
            counts = Counter(_words(page.text))
            self.lengths.append(sum(counts.values()))
            self._digits[position] = sum(
                count for term, count in counts.items() if term.isdigit()
            )
            for term, count in counts.items():
                self.postings[term][position] = count
        self.count = len(self.pages)
        self.average_length = (sum(self.lengths) / self.count) if self.count else 0.0
        self.positions: dict[int, int] = {page.page_number: position for position, page in enumerate(self.pages)}
        self.statements = tuple(position for position, page in enumerate(self.pages) if self._opens_statement(page.text))
        self.headings: dict[str, list[int]] = defaultdict(list)
        for position, page in enumerate(self.pages):
            for title in self._titles(page.text):
                self.headings[title].append(position)

    @staticmethod
    def _titles(text: str) -> list[str]:
        """Topic lines that open a page: note titles, section titles, table captions."""

        titles: list[str] = []
        scanned = 0
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped or stripped.lower() == "table of contents":
                continue
            if len(stripped.split()) <= 12 and (_UPPER_TITLE.match(stripped) or _MIXED_TITLE.match(stripped)):
                titles.append(" ".join(_words(stripped)))
            scanned += 1
            if scanned >= 6:
                break
        return titles

    @staticmethod
    def _opens_statement(text: str) -> bool:
        return bool(_PRIMARY_STATEMENT.search(text[:1500]))

    def idf(self, term: str) -> float:
        frequency = len(self.postings.get(term, ()))
        return math.log(1 + (self.count - frequency + 0.5) / (frequency + 0.5))

    def bm25(self, terms: Iterable[str]) -> dict[int, float]:
        scores: dict[int, float] = defaultdict(float)
        weights = Counter(terms)
        for term, weight in weights.items():
            postings = self.postings.get(term)
            if not postings:
                continue
            idf = self.idf(term)
            for position, frequency in postings.items():
                norm = 1 - BM25_B + BM25_B * self.lengths[position] / max(self.average_length, 1e-9)
                scores[position] += idf * weight * frequency * (BM25_K1 + 1) / (frequency + BM25_K1 * norm)
        return scores

    def phrases(self, terms: Sequence[str]) -> dict[int, float]:
        scores: dict[int, float] = defaultdict(float)
        for size in (3, 2):
            for start in range(max(len(terms) - size + 1, 0)):
                phrase = terms[start : start + size]
                if len(set(phrase)) < 2:
                    continue
                shared = None
                for term in phrase:
                    found = set(self.postings.get(term, ()))
                    shared = found if shared is None else (shared & found)
                    if not shared:
                        break
                if not shared:
                    continue
                weight = sum(self.idf(term) for term in phrase)
                for position in shared:
                    scores[position] += weight
        return scores

    def ordered(self, scores: dict[int, float]) -> list[int]:
        return [
            position
            for position, _score in sorted(
                scores.items(), key=lambda item: (-item[1], self.pages[item[0]].page_number)
            )
        ]

    def neighbours(self, positions: Sequence[int]) -> list[int]:
        out: list[int] = []
        for position in positions:
            for delta in (-1, 1):
                near = position + delta
                if 0 <= near < self.count:
                    out.append(near)
        return out

    def headings_for(self, terms: Sequence[str]) -> list[int]:
        """Pages whose own title names something the question asks about."""

        wanted = {term for term in terms if self.idf(term) > math.log(2.0)}
        scores: dict[int, float] = defaultdict(float)
        for title, positions in self.headings.items():
            words = title.split()
            if len(words) < 2:
                continue
            matched = [word for word in words if word in wanted]
            if not matched:
                continue
            value = sum(self.idf(word) for word in matched) / (1 + 0.25 * (len(words) - len(matched)))
            for position in positions:
                for offset in range(3):
                    if position + offset < self.count:
                        scores[position + offset] += value / (1 + offset)
        return self.ordered(scores)

    def tables_for(self, terms: Sequence[str]) -> list[int]:
        """Number-dense pages that also carry the question's own vocabulary.

        Line-item questions are answered inside a table: the wording of the metric may be
        absent while the row it names is surrounded by figures.
        """

        wanted = [term for term in terms if self.postings.get(term)]
        if not wanted:
            return []
        scores: dict[int, float] = defaultdict(float)
        for term in wanted:
            idf = self.idf(term)
            for position in self.postings[term]:
                digits = self._digits.get(position, 0)
                if not digits:
                    continue
                density = digits / max(self.lengths[position], 1)
                scores[position] += idf * density * 4.0
        return self.ordered(scores)

    def rank(self, question: str, limit: int) -> list[_StoredPage]:
        lexical_terms = _words(question)
        concept_terms = content_terms(question)
        lexical = self.ordered(self.bm25(lexical_terms))
        concept_scores = self.bm25(_expand(concept_terms))
        concept = self.ordered(concept_scores)
        phrase = self.ordered(self.phrases(concept_terms))
        # A line-item question is answered by the primary statements themselves, which are
        # the first statement-opening pages in document order, not the page that merely
        # repeats the metric most often.
        statements = list(self.statements)
        heading = self.headings_for(concept_terms)
        tables = self.tables_for(concept_terms) if any(term.isdigit() for term in concept_terms) else []
        neighbours = self.neighbours(list(dict.fromkeys(lexical + concept))[:5])

        views = {
            "lexical": lexical,
            "concept": concept,
            "phrase": phrase,
            "statement": statements,
            "heading": heading,
            "table": tables,
            "neighbour": neighbours,
        }
        chosen: list[int] = []
        seen: set[int] = set()
        for view, budget in _VIEW_BUDGET:
            taken = 0
            for position in views[view]:
                if taken >= budget or len(chosen) >= limit:
                    break
                if position in seen:
                    continue
                seen.add(position)
                chosen.append(position)
                taken += 1
        for view in ("concept", "lexical"):
            for position in views[view]:
                if len(chosen) >= limit:
                    break
                if position not in seen:
                    seen.add(position)
                    chosen.append(position)
        return [self.pages[position] for position in chosen[:limit]]


_CACHE: dict[tuple[str, int, int], _Corpus] = {}
_CACHE_LIMIT = 8


def _cache_key(page: "MemoryEntriesPage") -> tuple[str, int, int] | None:
    if page.memory_ref is None:
        return None
    return (page.memory_ref.artifact_id, page.memory_ref.revision, len(page.entries))


async def page_corpus(memory) -> _Corpus:
    """Return the cached corpus for the Memory head this scoped handle points at."""

    listing = await memory.list()
    key = _cache_key(listing)
    if key is None:
        return _Corpus(())
    cached = _CACHE.get(key)
    if cached is not None:
        return cached
    pages: list[_StoredPage] = []
    for fallback, record in enumerate(listing.entries, start=1):
        source_id = record.entry.sources[0].source_id if record.entry.sources else ""
        pages.append(
            _StoredPage(
                page_number=_page_number(source_id, fallback),
                text=record.entry.text,
                citation=record.citation,
            )
        )
    pages.sort(key=lambda page: page.page_number)
    corpus = _Corpus(pages)
    if len(_CACHE) >= _CACHE_LIMIT:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = corpus
    return corpus


async def search_pages(memory, question: str, *, limit: int) -> tuple[MemoryCitation, ...]:
    """Rank the stored pages for one question and return their exact citations."""

    if not isinstance(question, str) or not question.strip() or limit < 1:
        return ()
    corpus = await page_corpus(memory)
    if not corpus.pages:
        return ()
    return tuple(page.citation for page in corpus.rank(question, limit))
