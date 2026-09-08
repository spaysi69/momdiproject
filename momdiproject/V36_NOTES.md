# v36.0.0

## Why this version exists
v34/v35 explored search-first flows. After real-account evidence showed unacceptable credit loss during a search workflow, v36 removes contact search from normal enrichment entirely.

## Core invariant
One pasted LinkedIn URL -> one explicit research submission -> one contact object -> one request ID -> polling only.

## Company guard
The optional Target Company field is used to classify the returned company as current, former (jobHistory), or mismatch. Beast never automatically launches a second paid research request for a historical company.

## Credit guard
`skipDeduplicationCheck` remains false. Beast records before/after provider credit snapshots. It labels a one-credit delta as expected, zero as no observed debit/deduplication, and anything above one as an anomaly.
