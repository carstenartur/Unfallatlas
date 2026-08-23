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
- deterministic report finalization after all late report decorators, including
  synchronous recovery from the bootstrap accessor installed by
  `ua.accident_coverage.js`;
- preservation of the accident-coverage guard while avoiding duplicate
  full-report semantic passes over large complete evidence cohorts;
- exact appendix-boundary handling without allocating uppercase/lowercase copies
  of the complete numbered accident appendix;
- a load-order regression test with a 21,539-row evidence appendix.

## Deliberately separate follow-up work

Formal two-sample/reference-area statistics, multiplicity correction, exposure-based absolute risk, historical context reconstruction and official black-spot confirmation require their own data and method contracts. They are not silently approximated by this change.
