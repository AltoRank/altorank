-- 068: an unguessable share token per workspace
-- Depends on: 001_initial_schema (workspaces)
--
-- The share card's PNG route was cookie-authenticated and `private, no-store`,
-- so a link somebody posted never unfurled for anyone but its author. The
-- public routes (/share/<token>, /api/og/share/<token>) resolve this token
-- through the service role and show only the measured numbers the card
-- already shows. Null until the owner clicks "Copy link"; set back to null by
-- "Revoke link", which kills every copy of the URL at once.
alter table workspaces add column if not exists share_token text;

create unique index if not exists workspaces_share_token
  on workspaces (share_token)
  where share_token is not null;

comment on column workspaces.share_token is
  '128-bit hex token behind /share/<token>. Null = no public link. Generated on first share, cleared on revoke.';
