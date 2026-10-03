/**
 * Scrap SpacetimeDB module entry (module assembly — Agent 1).
 *
 * Table definitions live in schema.ts (Agent 2); reducers in reducers.ts
 * (Agent 5). The CLI builds this file, so it must export the schema as the
 * default export plus every reducer.
 */

export { default } from './schema';
export * from './reducers';
