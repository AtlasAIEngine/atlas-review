## Pre-release migration archive

AtlasEngine was not publicly released before this point. To simplify launch-candidate
bootstrapping, migrations `002` through `021` were squashed into
`backend/src/db/migrations/001_initial.js` (`pre_release_baseline`).

These files are kept only for historical reference and should not be loaded by the
migration runner.

If new schema changes are needed after this squash, add new numbered migrations in
`backend/src/db/migrations/` and register them in `backend/src/db/migrations/index.js`.
