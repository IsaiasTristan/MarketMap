# Pairs Validation — estimator change precommit (2026-09-20)

This note is written and committed **before** the new estimator runs, so the
change is an auditable specification fix rather than a threshold shopped after
seeing the result.

## What is changing

The pooled event-study t-statistic and the decay band were computed on the
**raw event mean tested against zero** (`weeklyHac` → `neweyWestTStat`), while
every displayed number was **event minus control**. The two are different
quantities, which is why a slice could show positive excess with a negative t
(the `>= 60%` stock-specific bucket), the pooled t could exceed both component
ts, and cross-sector could post t = 2.04 on a 5bp excess.

The estimator becomes a **two-way-demeaned excess**: for each event, subtract
the pair's control-week mean and the event-week's control mean and add back the
grand control mean (a baseline fitted on control weeks only, then applied to
events). The t-statistic is Newey-West at lag = horizon − 1 on the per-week
means of those residuals — by construction the test of the number shown.

Missing pair or week controls are **dropped and counted**, never zero-filled.

## What is NOT changing

- The **event definition** (`UNPRICED`: 4-week signal-gap change > 8pp while the
  1-month relative return stays within ±3%).
- The **event population** — the same fired pair-weeks are tested.
- The **held-out split date** (2026-01-01).

This is a mis-specified estimator being corrected, not a threshold being retuned
toward a nicer number. Only the second activity burns the reserve; this is the
first.

## Expected outcome, recorded in advance

Aggregating ~5,038 events to roughly 82 independent weeks means almost every t
on the page will fall. The pooled 1.44 is expected to shrink. The 2.04
cross-sector anomaly is expected to **evaporate rather than become a finding**.
That is the correct outcome, not a regression. We do **not** compute both the old
and new specifications and keep the better one.

## Newey-West stability at long horizons

Lag h − 1 is standard, but at h = 26 that is 25 lags against ~82 effective
weeks, which produces unstable and sometimes non-positive-definite standard
errors. A **non-overlapping cross-check** (sample every h-th week, plain t) is
computed alongside the HAC t at horizons ≥ 8 and flagged in the UI when the two
disagree in sign.

## Held-out framing

The 2026 data has been inside the pooled headline and visible in the year panel,
so it is **observed out-of-sample**, not a pristine reserve — recoverable as
evidence but not as a clean out-of-sample claim. The headline is split into
**in-sample** (pre-2026-01-01) and **observed out-of-sample** (2026 onward) so
the in-sample vs out-of-sample delta is the visible output.

A new **forward reserve** is declared from today and displayed nowhere until its
trigger is met.

## Precommitted acceptance criteria

**Observed out-of-sample (2026):** counts as confirmation only if, at the
4-week headline horizon, it shows the **same sign as the in-sample excess**,
a **Newey-West t ≥ 1.5**, on **at least 500 events with a complete forward
window**. Do not celebrate the current +0.46% / t 1.33 on 1,100 events — an
out-of-sample number beating in-sample on a small sample is a hallmark of noise,
not confirmation.

**Forward reserve (`VALIDATION_FORWARD_RESERVE_FROM = 2026-09-20`):** stays
hidden until it accumulates **≥ 1,000 events with a complete 4-week forward
window AND spans ≥ 6 calendar months** (whichever is later). Only then is it
read, once, against the same acceptance criterion above.

Every future look at either sample is an opportunity to construct a reason the
number obtained is the good one; the criteria above are fixed so that
temptation has nothing to grab.
