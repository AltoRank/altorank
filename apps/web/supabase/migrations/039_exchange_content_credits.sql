-- 039: credits pay for the article, in the direction that makes a followed
--      link defensible
-- Depends on: 008_backlink_exchange (backlink_credits)
--
-- The exchange paid the HOST for hosting: `host_link` credited the provider,
-- `place_link` debited the requester. Value flowed to whoever published the
-- link, which is the definition of a paid link, so the placement had to carry
-- rel="nofollow sponsored" and therefore passed no authority. That was the
-- whole objection to the feature.
--
-- Reversed, it is ordinary publishing. The writer supplies an article and is
-- credited for the work; the publisher receives the article and is debited for
-- it; the citation is the writer's byline. Nobody is paid to carry a link, in
-- either direction, so the byline can be followed.
--
-- The two old reasons stay in the constraint. No row ever used them - the host
-- side of the exchange could not run before 632e896, so the ledger is empty -
-- but a check constraint that silently invalidates history is a bad habit even
-- when the history is empty.

ALTER TABLE backlink_credits DROP CONSTRAINT IF EXISTS backlink_credits_reason_check;
ALTER TABLE backlink_credits
  ADD CONSTRAINT backlink_credits_reason_check
  CHECK (reason IN ('supply_article', 'receive_article', 'host_link', 'place_link', 'bonus', 'adjustment'));

COMMENT ON COLUMN backlink_credits.reason IS
  'supply_article credits the writer, receive_article debits the publisher. host_link and place_link are the retired pre-039 pair that paid the host for the link; no row ever used them.';

COMMENT ON COLUMN backlink_credits.dr_at_time IS
  'Retired by 039: the price is flat per article, because a price that scaled with the publisher domain rating was pricing the link rather than the writing. NULL on every row written after 039.';
