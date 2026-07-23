# Rendered DOCX finding: orphaned Top-Abweichungen heading

Parent: issue #415

## Observed final-page layout

The deterministic Bonn DOCX Golden artifact is rendered through LibreOffice Writer and extracted with Poppler.

In the current final PDF:

- page 1 ends with the standalone line `Top-Abweichungen (Ausschnitt vs. Stadt):` at approximately y=746.5–757.6 pt;
- page 2 starts with the related table header `Muster | Lokal | Lokal % | Stadt % | Faktor | 95%-KI (lokaler Anteil)` and its data row;
- no explanatory body text or table row follows the heading on page 1.

This is a final rendered-page defect, not merely an OOXML or source-model concern. The heading and its table need to remain together during Word/LibreOffice pagination.

## Required correction

The DOCX renderer should mark the subsection heading to stay with the next table, or place heading and table into a pagination-safe block that both Microsoft Word and LibreOffice understand.

The fix must not:

- insert a hard-coded page break for one specific fixture;
- depend on page numbers known before rendering;
- merge unrelated statistics tables into one unbreakable block;
- weaken the final Poppler audit.

## Acceptance contract

A final-page audit must locate the visible heading and verify at least one of the following on the same page:

1. the complete related table header and first data row; or
2. a renderer-supported continuation marker followed by the table on the next page.

For the standard Bonn artifact, the preferred result is heading, header and first row on page 2.

The final audit must fail when:

- the heading is the last meaningful content on a page;
- the table starts on another page without an explicit continuation relation;
- only the source DOCX structure, rather than the rendered pages, claims they belong together.
