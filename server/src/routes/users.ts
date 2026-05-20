// /api/users route entry point. The implementation lives in ./users/
// (one file per domain — see ./users/index.ts for the wiring). This
// file exists so existing imports of `routes/users` keep working
// without app.ts or test files having to change paths.

export { default } from './users/index';
export { _resetRefreshLocksForTests, INSIGHTS_ALL_TIME_CAP_DAYS } from './users/index';
