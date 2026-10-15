<?php
/**
 * /edit finds only posts this plugin created, and "Post as draft" decides
 * whether an edit may put a post on the site.
 *
 * @package AltoRank
 */

/** The params altorank_read_params() would produce, with these fields set. */
function altorank_test_params( array $fields ): array {
	return $fields + array(
		'post_id'      => 0,
		'external_id'  => '',
		'current_slug' => '',
		'status'       => '',
		'has_status'   => false,
	);
}

altorank_test_add_post( 10, array( 'post_name' => 'sent', 'post_status' => 'publish' ), array( ALTORANK_META_EXTERNAL_ID => 'art-1' ) );
altorank_test_add_post( 11, array( 'post_name' => 'written-here', 'post_status' => 'publish' ) );
altorank_test_add_post( 12, array( 'post_name' => 'a-page', 'post_type' => 'page' ), array( ALTORANK_META_EXTERNAL_ID => 'art-2' ) );

altorank_test_same( 'edit scope: its own post by id', 10, altorank_locate_post( altorank_test_params( array( 'post_id' => 10 ) ) ) );
altorank_test_same( 'edit scope: a post written on the site is not found by id', 0, altorank_locate_post( altorank_test_params( array( 'post_id' => 11 ) ) ) );
altorank_test_same( 'edit scope: a page is not found by id', 0, altorank_locate_post( altorank_test_params( array( 'post_id' => 12 ) ) ) );
altorank_test_same( 'edit scope: a missing id is not found', 0, altorank_locate_post( altorank_test_params( array( 'post_id' => 999 ) ) ) );
altorank_test_same( 'edit scope: its own post by external id', 10, altorank_locate_post( altorank_test_params( array( 'external_id' => 'art-1' ) ) ) );
altorank_test_same( 'edit scope: an unknown external id is not found', 0, altorank_locate_post( altorank_test_params( array( 'external_id' => 'nope' ) ) ) );
altorank_test_same( 'edit scope: its own post by slug', 10, altorank_locate_post( altorank_test_params( array( 'current_slug' => 'sent' ) ) ) );
altorank_test_same( 'edit scope: a post written on the site is not found by slug', 0, altorank_locate_post( altorank_test_params( array( 'current_slug' => 'written-here' ) ) ) );
altorank_test_same(
	'edit scope: a foreign id falls through to the external id',
	10,
	altorank_locate_post( altorank_test_params( array( 'post_id' => 11, 'external_id' => 'art-1' ) ) )
);

// Status: "Post as draft" on (the default).
$GLOBALS['altorank_wp']['options'][ ALTORANK_OPTION_POST_AS_DRAFT ] = '1';
$publish = altorank_test_params( array( 'status' => 'publish', 'has_status' => true ) );
$draft   = altorank_test_params( array( 'status' => 'draft', 'has_status' => true ) );
$none    = altorank_test_params( array() );

altorank_test_same( 'status, held: a new post is a draft', 'draft', altorank_resolve_status( $publish, true ) );
altorank_test_same( 'status, held: an edit cannot publish a draft', null, altorank_resolve_status( $publish, false, 'draft' ) );
altorank_test_same( 'status, held: an edit cannot publish a pending post', null, altorank_resolve_status( $publish, false, 'pending' ) );
altorank_test_same( 'status, held: an edit of a live post keeps it live', 'publish', altorank_resolve_status( $publish, false, 'publish' ) );
altorank_test_same( 'status, held: an unpublish still unpublishes', 'draft', altorank_resolve_status( $draft, false, 'publish' ) );
altorank_test_same( 'status, held: an edit without a status leaves it', null, altorank_resolve_status( $none, false, 'publish' ) );

// "Post as draft" off: the dashboard's approval is the publish.
$GLOBALS['altorank_wp']['options'][ ALTORANK_OPTION_POST_AS_DRAFT ] = '0';
altorank_test_same( 'status, open: a new post is published', 'publish', altorank_resolve_status( $none, true ) );
altorank_test_same( 'status, open: an edit may publish', 'publish', altorank_resolve_status( $publish, false, 'draft' ) );
altorank_test_same(
	'status, open: an unknown status on an edit changes nothing',
	null,
	altorank_resolve_status( altorank_test_params( array( 'status' => 'trash', 'has_status' => true ) ), false, 'publish' )
);
