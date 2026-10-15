<?php
/**
 * JSON-LD is lifted out of the body and printed in the page head; inline SVG
 * charts are sanitised with an allowlist instead of being stripped to text.
 *
 * @package AltoRank
 */

$posting = array(
	'@context'      => 'https://schema.org',
	'@type'         => 'BlogPosting',
	'headline'      => 'Prices </script> and "quotes"',
	'datePublished' => '2026-10-01T09:00:00.000Z',
);
$faq     = array(
	'@context'   => 'https://schema.org',
	'@type'      => 'FAQPage',
	'mainEntity' => array(
		array(
			'@type'          => 'Question',
			'name'           => 'Does C:\path work?',
			'acceptedAnswer' => array(
				'@type' => 'Answer',
				'text'  => 'Yes.',
			),
		),
	),
);
// The dashboard escapes "</" as "<\/" (lib/publishing/schema.ts jsonLdScript).
$tag = static function ( array $schema ): string {
	return '<script type="application/ld+json" data-altorank-schema>' . str_replace( '</', '<\/', json_encode( $schema, JSON_UNESCAPED_SLASHES ) ) . '</script>';
};

$html = "<p>Body</p>\n" . $tag( $posting ) . "\n" . $tag( $faq );
list( $body, $items ) = altorank_extract_structured_data( $html );

altorank_test_same( 'structured data: the body keeps its prose', '<p>Body</p>', $body );
altorank_test_check( 'structured data: no script is left in the body', false === stripos( $body, '<script' ) );
altorank_test_check( 'structured data: no JSON is left in the body', false === strpos( $body, '@context' ) );
altorank_test_same( 'structured data: both blocks are kept', 2, count( $items ) );
altorank_test_same( 'structured data: the posting decodes intact', $posting, $items[0] );
altorank_test_same( 'structured data: the FAQ decodes intact', $faq, $items[1] );

// Anything that is not valid JSON-LD is dropped whole, text included.
list( $body, $items ) = altorank_extract_structured_data( '<p>a</p><script type="application/ld+json">{not json</script><script>var x = 1;</script><p>b</p>' );
altorank_test_same( 'structured data: invalid JSON and other scripts leave nothing behind', '<p>a</p><p>b</p>', $body );
altorank_test_same( 'structured data: nothing kept from them', array(), $items );

// A body without any keeps its text and yields nothing.
list( $body, $items ) = altorank_extract_structured_data( '<p>plain</p>' );
altorank_test_same( 'structured data: plain body unchanged', '<p>plain</p>', $body );
altorank_test_same( 'structured data: plain body has none', array(), $items );

// Bounded.
list( , $items ) = altorank_extract_structured_data( str_repeat( $tag( $posting ), ALTORANK_STRUCTURED_DATA_MAX_ITEMS + 3 ) );
altorank_test_same( 'structured data: at most the item cap is kept', ALTORANK_STRUCTURED_DATA_MAX_ITEMS, count( $items ) );

// Printing: only on a single post that has it, re-encoded so it cannot end the element.
$GLOBALS['altorank_wp']['meta'][7][ ALTORANK_META_STRUCTURED_DATA ] = json_encode( array( $posting, $faq ) );
$GLOBALS['altorank_wp']['singular'] = true;
$GLOBALS['altorank_wp']['queried']  = 7;
ob_start();
altorank_print_structured_data();
$out = (string) ob_get_clean();

altorank_test_same( 'structured data: one script element per block', 2, substr_count( $out, '<script type="application/ld+json">' ) );
altorank_test_same( 'structured data: every element is closed once', 2, substr_count( $out, '</script>' ) );
preg_match_all( '#<script type="application/ld\+json">(.*?)</script>#s', $out, $printed );
foreach ( $printed[1] as $i => $json ) {
	altorank_test_check( "structured data: no angle bracket inside printed block $i", false === strpbrk( $json, '<>' ) );
}
altorank_test_same( 'structured data: the printed posting decodes to what was approved', $posting, json_decode( $printed[1][0] ?? '', true ) );
altorank_test_same( 'structured data: the printed FAQ decodes to what was approved', $faq, json_decode( $printed[1][1] ?? '', true ) );

$GLOBALS['altorank_wp']['singular'] = false;
ob_start();
altorank_print_structured_data();
altorank_test_same( 'structured data: nothing printed off a single post', '', ob_get_clean() );

$GLOBALS['altorank_wp']['singular'] = true;
$GLOBALS['altorank_wp']['queried']  = 8;
ob_start();
altorank_print_structured_data();
altorank_test_same( 'structured data: nothing printed for a post without it', '', ob_get_clean() );

$printing = array_filter(
	$GLOBALS['altorank_test_hooks'],
	static function ( $hook ) {
		return 'wp_head' === $hook[0] && 'altorank_print_structured_data' === $hook[1];
	}
);
altorank_test_same( 'structured data: printed from wp_head', 1, count( $printing ) );

// Charts: kses runs with an SVG allowlist that can load or run nothing.
$chart = '<figure class="infographic"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 80" width="100%" role="img" aria-label="x"><title>x</title><text x="1" y="2" text-anchor="end" font-size="13">A</text><rect x="1" y="2" width="3" height="4" rx="3" fill="#123456" opacity="0.6"></rect></svg><figcaption>c</figcaption></figure>';
altorank_sanitize_content( $chart );
$allowed = $GLOBALS['altorank_wp']['kses_allowed'];
altorank_test_check( 'charts: kses ran with an allowlist', is_array( $allowed ) );
altorank_test_check( 'charts: the post allowlist is the base', isset( $allowed['p'], $allowed['figure'] ) );
foreach ( array( 'svg', 'title', 'text', 'rect', 'g' ) as $element ) {
	altorank_test_check( "charts: <$element> is allowed", isset( $allowed[ $element ] ) );
}
altorank_test_check( 'charts: viewBox is allowed (kses compares lower case)', ! empty( $allowed['svg']['viewbox'] ) );
foreach ( array( 'script', 'foreignobject', 'use', 'image', 'iframe', 'object', 'embed', 'style' ) as $element ) {
	altorank_test_check( "charts: <$element> is not allowed", ! isset( $allowed[ $element ] ) );
}
foreach ( array( 'svg', 'g', 'title', 'desc', 'text', 'tspan', 'rect', 'line' ) as $element ) {
	foreach ( array_keys( $allowed[ $element ] ?? array() ) as $attribute ) {
		altorank_test_check( "charts: <$element $attribute> is not a link or handler", ! preg_match( '/^(on|href$|xlink|src$)/', $attribute ) );
	}
}
