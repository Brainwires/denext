# Security policy

The full policy — supported versions, how to report a vulnerability privately, scope,
and the hardening references — lives in
[POLICIES.md → Security policy](./POLICIES.md#security-policy).

**Short version:** report privately via GitHub Security Advisories on this repository
(**Security → Report a vulnerability**); never in a public issue. Acknowledgement within
3 business days, triage within 7, fix + advisory within 90 days (faster when exploited).

**The kernel sandbox:** an escape from a kernel-held cell of its
[guarantee matrix](https://denext.dev/docs/kernel-sandbox-guarantees) is a vulnerability; a
documented gap is not ([POLICIES.md → Scope](./POLICIES.md#scope)).
