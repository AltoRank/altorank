-- 031: one workspace per domain per account
-- Depends on: 001_initial_schema (workspaces)
--
-- A workspace is a site. Two rows for the same domain in one account would
-- run two crawls, two keyword sets and two draft pipelines against one
-- website and count twice against every quota. Case-insensitive, because
-- "Acme.com" and "acme.com" are one site. Different accounts may still share
-- a domain: an agency and its client can both legitimately work on it.

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_agency_domain_unique
  ON workspaces (agency_id, lower(domain))
  WHERE domain IS NOT NULL;
