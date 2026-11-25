# Project Charter

## Vision
An independently owned, internationally scalable OTA. Long-term scope comparable to Trip.com / iVIVU (hotels, tours, activities, transfers, flights, packages, partner portals, web + mobile).

## Ownership requirements
(Note 2026-11-25, D-015: the repository is public during the experimental phase; ownership of code and data is unchanged — public visibility grants no licence to reuse.)
Owner controls source code, data, business logic, infrastructure, APIs, mobile apps, roadmap.
Third-party supplier APIs allowed; each one's ownership/contract limits recorded in `REPOSITORY_REGISTER.md` (suppliers section, to be added).

## Proposed initial wedge (PENDING OWNER APPROVAL — see DECISIONS.md D-001)
Destination-first: Vietnam (start Phu Quoc / southern Vietnam), hotels + tours/activities + transfers, VND + USD, vi/en/(ko/zh later).
Rationale: a full Trip.com scope is not achievable by a 1-human + 2-AI team; a narrow wedge with real bookings validates the booking core before expansion.

## Out of scope until explicitly approved
Flights (needs IATA/consolidator relationships), native mobile apps, loyalty, multi-country tax engines.

## Success criteria for MVP (draft)
- Real customers complete paid bookings end-to-end with zero double-sells.
- Cancellation/refund and supplier failure paths tested and recoverable.
- Daily reconciliation between bookings, payments and supplier confirmations.

## Business prerequisites (non-technical, Owner action)
Legal entity & licences for travel/e-commerce operations in Vietnam, merchant model (agent vs merchant-of-record), payment gateway contracts, supplier contracts, personal-data compliance. Must be confirmed by a qualified Vietnamese lawyer/accountant.
