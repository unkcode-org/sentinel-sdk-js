# Future RUM target-state contract slice

Status: **design only; not part of RUM-TARGET-1.1 SDK interaction-attempt implementation**.

Purpose: distinguish a rage interaction on a native enabled button, a native disabled button, an ARIA-disabled control, or an unroled generic element without inferring state from the absence of a browser click.

## Proposed optional target fields

| Field | Applicability | Meaning |
| --- | --- | --- |
| `target.disabled` | Native button; optional boolean | `true` when the native disabled property is set at the qualified attempt, `false` when inspected and unset. Absent on historical or inapplicable targets. |
| `target.aria_disabled` | Target's own `aria-disabled`; optional boolean | Present only for exact own `"true"` or `"false"`; absent for missing/malformed attributes and historical rows. ARIA state does not enforce native click suppression. |

Both facts remain separate. They are not reasons for disablement and must not read values, associated fields, surrounding text, or page content. A state change during a pointer pair needs an explicit fail-closed rule before implementation. `tag`/`role`/`test_id` remain required as today; optional state never makes an otherwise invalid target valid. Existing `label`/`text` eligibility and all TARGET-1 bounds stay unchanged.

## End-to-end work after SDK attempt validation

1. Approve field names, applicability, validation, and sampling time in a separate human contract/privacy review.
2. Storage: reserve protobuf `Target` fields, regenerate bindings, update domain and read/write validation/mappers, add nullable ClickHouse columns and migration, and verify historical rows read as absent.
3. Ingest: update copied bindings, strict target decoder/domain/mapping, OpenAPI schema, and rejection tests for wrong types or unsupported values. Keep old payloads valid.
4. Query: update copied bindings, read validation/domain/DTO/OpenAPI, preserve absence for historical records, and expose the separate facts only in authorized event detail.
5. Frontend: regenerate contract types, update validation and escaped rendering, label native and ARIA state distinctly, and avoid interpreting absent as enabled.
6. SDK: emit only after all receiving services accept the additive fields. Deploy Storage first, then Query and Ingest compatibility, then frontend, then SDK. An early SDK field would fail Ingest's closed target decoder and could reject a batch.

No target-state field, migration, schema change, or deployment is authorized in RUM-TARGET-1.1.
