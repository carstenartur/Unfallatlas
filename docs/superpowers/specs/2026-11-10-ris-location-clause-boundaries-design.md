# Preserve independent locations in council evidence

## Intent and evidence

The reported disappearance is repaired and live, but Carsten correctly questions the remaining 7,037 / 109,560 coverage. The existing diagnostic audit contains a reproducible additional loss: in Hannover SIM 15-2724/2022 the first section consumes the independently specified Eckerstraße section. SIM 15-1618/2025 also loses two textual street references because a closing quotation mark prevents sentence separation. The work continues the authorized location repair and audit; it does not set a target percentage or claim every council record has a mappable location.

## Approach

Keep the existing deterministic mapper, verified gazetteer and evidence model. Limit each section's internal parsing span at a clearly coordinated new street section with its own two-boundary structure. Preserve the complete original sentence as evidence and retain unresolved sibling locations. A separate, shared sentence splitter recognizes closing quotation marks while retaining punctuation. Reference abbreviations such as `bzw.` and `Nr.` stay within their sentence; potentially terminal abbreviations such as `usw.`, `etc.`, `e. V.` and `u. a.` can end it.

The implementer may choose small private helpers inside `risLocation.js`. This is an implementation choice, not a new user-selected architecture. Splitting on every conjunction would sever endpoints and shared restrictions; widening unresolved measures to entire roads would misstate precision. Both are excluded.

## Required outcomes

- The unchanged Sodenstraße/Eckerstraße evidence yields the verified Eckerstraße section; ambiguous Angerstraße remains unresolved. Reversing sibling order preserves the result.
- Section anchors remain anchors. An additional boundary or requested extension must not be hidden by the new split; shared trailing restrictions and negations remain in the evidence and must not make a previously uncertain extent falsely precise.
- Endpoint syntax and its qualifying clause have separate bounds. A closing parenthesis does not drop a shared restriction; a semicolon or a validated independent following section clause ends it. A neutral `von` in the shared lead-in is not a spatial boundary. Leading negation remains within its own clause.
- Quoted sentence endings permit independent textual locations for Clemensstraße and Feuerwehrstraße. Neither an unspecified modal filter nor a barrier becomes a whole-road geometry.
- Abbreviations such as `bzw.` and `Nr.` remain within their sentence. Regional Hannover scope is checked independently for each resulting sentence, including quoted sentence boundaries.
- Limit sentence-boundary exceptions to the observed reference forms `bzw.`, `Nr.` and `Hausnr.`. General abbreviations such as `ggf.` may end a sentence and keep the pre-existing separation behavior.
- Reassess retained source evidence via Hannover location revision 8, preserving source timestamps, official geometries and existing retained-evidence safeguards. Bonn's revision is unchanged.
- A second deterministic traffic-title diagnostic sample is reported separately from the unchanged first 34-case audit. Report exact outcomes and reasons, without population extrapolation.
- As a bounded regression control, replay all 32 already mapped/partial SIM traffic records in the same fixed pool on identical saved title and location-evidence inputs. Preserve every previously reproduced kind/label/geometry combination; do not replace the original diagnostic samples or interpret saved snippets as complete documents.
- The newly sampled `Geh-/Fuß- und (Fahr)radweg` wording must not turn one explicit street reference into an apparent list of locations. Ignore only this compound's internal conjunction for the multiplicity guard; preserve the original subject, evidence and geometry rules. The Wilkenburger example gains a text reference, not a whole-road geometry.
- A spaced dash introducing the explicitly observed construction action `Abriss` after a complete house number is a title separator. Preserve the existing complete-range/operator checks. The public stored title of SIM 15-2055/2016 independently identifies Bemeroder Straße 73; its full text could not be reread in the second audit.
- Describe an unresolved record as not yet assigned to the map. Failure of automatic extraction does not establish absence of a place. The unavailable-gazetteer wording must also cover a source outside the gazetteer's verified geographical scope.

## Validation

Use failing regressions for the observed losses, existing section-extension and regional-scope tests, real-source replay against ATKIS, focused refresh tests, independent review and the existing required CI. Confirm live data after deployment. No inferred coordinates, broad title cleanup, new network service or new dependency is needed.
