<?php
/**
 * altorank_write_post(): every post write is slashed and runs with
 * WordPress's save-time kses lifted, then put back.
 *
 * @package AltoRank
 */

$body  = '<p>Match <code>\d+\.\d+</code> in <code>C:\Users\site</code></p>'
	. '<iframe src="https://www.youtube.com/embed/abc" width="560" height="315" frameborder="0" allowfullscreen></iframe>';
$title = 'Escaping \n in "quotes"';
$aio   = json_encode( array( 'focus' => array( 'keyphrase' => 'café' ) ) );

$id    = altorank_write_post(
	array(
		'post_type'    => 'post',
		'post_title'   => $title,
		'post_content' => $body,
		'meta_input'   => array(
			'_yoast_wpseo_title' => $title,
			'_aioseo_keyphrases' => $aio,
		),
	)
);
$write = $GLOBALS['altorank_wp']['writes'][0];

altorank_test_same( 'write: a new post is inserted', 'insert', $write['fn'] );
altorank_test_same( 'write: backslashes in the body survive', $body, $write['data']['post_content'] );
altorank_test_same( 'write: backslashes in the title survive', $title, $write['data']['post_title'] );
altorank_test_same( 'write: backslashes in SEO meta survive', $title, $GLOBALS['altorank_wp']['meta'][ $id ]['_yoast_wpseo_title'] );
altorank_test_same( 'write: JSON escapes in meta survive', $aio, $GLOBALS['altorank_wp']['meta'][ $id ]['_aioseo_keyphrases'] );
altorank_test_same( 'write: kses is lifted during the write', false, $write['kses'] );
altorank_test_same( 'write: kses is back on afterwards', true, $GLOBALS['altorank_wp']['kses'] );

// The second write (image URLs rewritten after import) goes the same way.
$rewritten = str_replace( 'C:\Users\site', 'C:\Users\site2', $body );
altorank_write_post(
	array(
		'ID'           => $id,
		'post_content' => $rewritten,
	)
);
$second = $GLOBALS['altorank_wp']['writes'][1];
altorank_test_same( 'write: an ID updates', 'update', $second['fn'] );
altorank_test_same( 'write: the update keeps the embed and backslashes', $rewritten, $second['data']['post_content'] );
altorank_test_same( 'write: kses is lifted during the update too', false, $second['kses'] );
altorank_test_same( 'write: kses is back on after the update', true, $GLOBALS['altorank_wp']['kses'] );

// Filters that were off stay off.
$GLOBALS['altorank_wp']['kses'] = false;
altorank_write_post( array( 'post_title' => 'x' ) );
altorank_test_same( 'write: kses that was off is not switched on', false, $GLOBALS['altorank_wp']['kses'] );

// A write that throws still puts the filters back.
$GLOBALS['altorank_wp']['kses'] = true;
$threw                          = false;
try {
	altorank_write_post( array( 'post_title' => 'throw' ) );
} catch ( RuntimeException $e ) {
	$threw = true;
}
altorank_test_check( 'write: the exception reaches the caller', $threw );
altorank_test_same( 'write: kses is restored after a failed write', true, $GLOBALS['altorank_wp']['kses'] );
