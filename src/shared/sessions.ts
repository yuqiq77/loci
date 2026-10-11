// Single source for the default session title: the schema default, the
// title-job guard and conditional update, and the client refetch check all
// compare against this value, so the sites cannot drift (MC-110).
//
// The unification is compile-time only: the generated migration and every
// existing row hold the literal. Changing this value requires a data
// migration (column default + historical 'New chat' rows), or auto-titling
// silently dies for pre-existing sessions.
export const DEFAULT_SESSION_TITLE = "New chat";
