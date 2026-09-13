-- Source lineage and provider dates survive discovery and are scoped by the
-- existing keyword workspace policies. Additive; old rows remain unknown.
ALTER TABLE public.keywords ADD COLUMN IF NOT EXISTS research_evidence jsonb;
COMMENT ON COLUMN public.keywords.research_evidence IS 'Discovery source/seed/family, locale, fetch time and provider metric dates/intent; not qualification approval';

ALTER TABLE public.domain_audits ADD COLUMN IF NOT EXISTS research_summary jsonb;
COMMENT ON COLUMN public.domain_audits.research_summary IS 'Seed family coverage, recovery, competitor classification, provider failures and bounded discovery stop reason';
