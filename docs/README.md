# docs

Owner: Agent 8 — demo walkthrough, setup, runbook, fixture provenance, limitations, and verification reports.

| Doc | Purpose |
| --- | --- |
| [environment-setup.md](environment-setup.md) | Prerequisites, env vars, how to run fixture verification |
| [demo-walkthrough.md](demo-walkthrough.md) | Repeatable demo script for judges/staff |
| [runbook.md](runbook.md) | Minimal ops: start, smoke, recover |
| [fixture-provenance.md](fixture-provenance.md) | Where fixture numbers come from |
| [known-limitations.md](known-limitations.md) | Honest scope boundaries |
| [verification-report.md](verification-report.md) | Latest Agent 8 verification results |
| [portions-served.md](portions-served.md) | Portion entry/CSV, normalized recommendations, API, and mask-integration handoff |
| [calibration.md](calibration.md) | IT_4 camera calibration (credit card), focus lock, recalibration; area method (why depth was removed) |
| [deploy.md](deploy.md) | Step-by-step: local production stack + Cloudflare Tunnel on your own domain |

Root install narrative stays in [`README.md`](../README.md) (Agent 1).

### Run every test

```bash
./test-all.sh            # offline: every package's tests, dashboard build, integration, Python, scripts
./test-all.sh --live     # + deploy/local.sh up, smoke test, live E2E suites and demo.py --simulate
```

Ends with a PASS/FAIL table and a non-zero exit code on failure. Options `--only a,b`, `--skip a,b`,
`--install`, `--fail-fast` (`--keep-going` is the default), `-v`, `--list`, `-h`. Live suites write only
to test halls and restore any settings they change. Logs go to `tests/.logs/` (gitignored). Details:
[runbook.md](runbook.md#run-every-test-test-allsh).
