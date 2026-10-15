<?php
/**
 * altorank_post_date_fields(): a post is dated when the article first went
 * live, and only when this request creates and publishes it.
 *
 * @package AltoRank
 */

$past = '2026-10-01T09:30:00.000Z';

altorank_test_same(
	'date: a new published post takes the first-publish time',
	array(
		'post_date_gmt' => '2026-10-01 09:30:00',
		'post_date'     => '2026-10-01 09:30:00',
	),
	altorank_post_date_fields( $past, true, 'publish' )
);
altorank_test_same( 'date: a new draft floats', array(), altorank_post_date_fields( $past, true, 'draft' ) );
altorank_test_same( 'date: an edit never changes the date', array(), altorank_post_date_fields( $past, false, 'publish' ) );
altorank_test_same( 'date: an edit with no status change never changes the date', array(), altorank_post_date_fields( $past, false, null ) );
altorank_test_same( 'date: no time sent leaves WordPress to decide', array(), altorank_post_date_fields( '', true, 'publish' ) );
altorank_test_same( 'date: an unreadable time is ignored', array(), altorank_post_date_fields( 'not a date', true, 'publish' ) );
altorank_test_same(
	'date: a future time is ignored rather than scheduling the post',
	array(),
	altorank_post_date_fields( gmdate( 'c', time() + 3600 ), true, 'publish' )
);
