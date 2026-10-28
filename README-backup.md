# Asset record backup

Settings administrators can download a JSON snapshot of saved holdings, net-worth history and dated asset composition. The file also contains reference prices and asset configuration, with an explicit field allowlist that excludes passwords, tokens and API keys. Unsaved Settings edits are not part of the server snapshot.

Import checks the file format, displays its date and record counts, and requires a backup of the current records before confirmation. The server independently validates the file and administrator password. A fingerprint rejects a restore if records changed after the preview. The complete write is atomic.

Restoration replaces holdings and the two historical record sets. Current valuation is recalculated from the existing asset configuration and latest prices; it does not replace prices, configuration, password settings, scheduled jobs, or VR records.

The feature is embedded in `index.html` between the `BEGIN ASSET BACKUP` markers. `src/asset-backup.js` contains the same source for maintenance. The backend is installed by `backend/ms-backup.sql`.

After editing `src/asset-backup.js`, run `node tools/build-backup.cjs` to embed it in the page.

Validation: `node tests/asset-backup.test.cjs`; database regression uses `tests/asset-backup-rollback.sql`, which rolls back all record changes. Browser QA uses synthetic data only.
