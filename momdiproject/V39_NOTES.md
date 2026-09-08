# Prospecting Beast v39.0.0

## Source-aware contact data

v39 preserves all useful contact data returned by the single direct LinkedIn research request while keeping company attribution honest.

- `contactPhone1/2` are shown as person/direct contact methods.
- `companyPhone1/2/3` are preserved and labeled as current-company lines for the current company returned by Seamless.
- `personalEmail` is labeled personal.
- emails whose domain matches the returned current `companyDomain`/`emailDomain`/`website` are labeled as current-company work emails.
- other returned emails are preserved under `company not confirmed by Seamless`; v39 does not invent a historical-company association.
- job history remains visible, with a note when Seamless did not associate a specific phone/email with that historical role.

No additional Seamless research requests are made for classification or UI grouping.
