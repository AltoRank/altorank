/**
 * Postgres "undefined column" (a select naming it) and PostgREST's schema-cache
 * miss (an insert or update naming it): the code is deployed and the migration
 * that adds the column is not. Callers that must work either side of a
 * migration read again without the column when this is true.
 */
export function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === "42703" || error?.code === "PGRST204";
}
