// How many keywords one "Generate" run proposes: the default and the ceiling.
//
// A module of its own, with no imports, because the Generate tab is a client
// component and reads these two numbers. They used to live in ./pipeline,
// which is the server's research pipeline: importing them pulled the whole of
// it into the browser bundle, and once the pipeline reached a module that
// resolves hostnames (node:dns, via the business-profile check), every
// dashboard page that renders the calendar controls failed to compile.
export const GENERATE_DEFAULT = 5;
export const GENERATE_MAX = 30;
