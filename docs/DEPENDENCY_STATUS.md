# Dependency audit status

Audit date: 2026-11-06. These results describe the checked lockfiles, not a guarantee that the application has no vulnerabilities.

High and critical advisories were addressed before launch. Moderate advisories remain in retained legacy and development dependency chains. Avoid unrelated major dependency migrations during the launch; review these remaining advisories when maintaining those components.

| Package | Severity | Dependency scope | Advisory |
| --- | --- | --- | --- |
| backend/archiver | moderate | Runtime or retained shared module | Transitive dependency; inspect npm audit for the chain |
| backend/archiver-utils | moderate | Runtime or retained shared module | Transitive dependency; inspect npm audit for the chain |
| backend/dockerode | moderate | Runtime or retained shared module | Transitive dependency; inspect npm audit for the chain |
| backend/glob | moderate | Runtime or retained shared module | [Glob: AbortSignal cancellation bypass allows post-timeout filesystem traversal](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) |
| backend/minimatch | moderate | Runtime or retained shared module | [minimatch has potential denial of service via globparts amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) |
| backend/uuid | moderate | Runtime or retained shared module | [uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided](https://github.com/advisories/GHSA-w5hq-g745-h8pq) |
| backend/zip-stream | moderate | Runtime or retained shared module | Transitive dependency; inspect npm audit for the chain |
| frontend/@typescript-eslint/eslint-plugin | moderate | Development | Transitive dependency; inspect npm audit for the chain |
| frontend/@typescript-eslint/parser | moderate | Development | Transitive dependency; inspect npm audit for the chain |
| frontend/@typescript-eslint/type-utils | moderate | Development | Transitive dependency; inspect npm audit for the chain |
| frontend/@typescript-eslint/typescript-estree | moderate | Development | Transitive dependency; inspect npm audit for the chain |
| frontend/@typescript-eslint/utils | moderate | Development | Transitive dependency; inspect npm audit for the chain |
| frontend/glob | moderate | Development | [Glob: AbortSignal cancellation bypass allows post-timeout filesystem traversal](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) |
| frontend/minimatch | moderate | Development | [minimatch has potential denial of service via globparts amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) |
| frontend/sucrase | moderate | Development | Transitive dependency; inspect npm audit for the chain |

Run `npm audit --prefix backend` and `npm audit --prefix frontend` to inspect current advisories. CI rejects high or critical production dependency advisories. The retained cloud/builder dependencies are not required infrastructure for local review.
