# Implementation summary for #644

## Implemented

- canonical, evidence-safe involvement and severity wording in the browser analysis layer;
- neutral handling of `IstSonstig` without inferring bus or public transport;
- fail-closed normalization of deterministic report titles, summaries and contextual measure wording;
- same-cohort KSI escalation for the Rad-only published-category pattern;
- descriptive time-window labels without inferred school or commuter trip purpose;
- accident-event labels for `UKATEGORIE` rather than person-count labels;
- conservative pattern and template wording;
- explicit interior zero years in trend series, with support for an explicitly supplied full year range;
- regression tests for the semantic contract and the cross-mask KSI defect.

## Deliberately separate follow-up work

Formal two-sample/reference-area statistics, multiplicity correction, exposure-based absolute risk, historical context reconstruction and official black-spot confirmation require their own data and method contracts. They are not silently approximated by this change.
