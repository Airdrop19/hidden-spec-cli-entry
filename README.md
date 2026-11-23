# Build mend, one patch tool for every AI edit format — entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Airdrop19/hidden-spec-cli-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Airdrop19/hidden-spec-cli-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`main.ts` (Node 22, standard library only) implements mend per the kit's SPEC.md: unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits, three-tier line matching, all-or-nothing writes. `runner.ts` is the kit's trial runner, unchanged.

Practice set: 100 of 100 checks pass locally (`node check.ts practice.json`), including the whitespace-drift and indentation families the strict house applier misses.
