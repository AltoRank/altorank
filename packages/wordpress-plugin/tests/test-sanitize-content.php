<?php
/**
 * altorank_sanitize_content(): YouTube embeds are rebuilt from a fixed
 * template and put back only where they were lifted from; the media import
 * accepts raster images only.
 *
 * The kses fake returns its input unchanged, so these checks are about what
 * the plugin does around kses, not kses itself.
 *
 * @package AltoRank
 */

$embed = '<iframe src="https://www.youtube.com/embed/abc123" width="640" height="360"></iframe>';

// One embed comes back once, in place, from the fixed template.
$out = altorank_sanitize_content( '<p>a</p>' . $embed . '<p>b</p>' );
altorank_test_same( 'embeds: one iframe out for one in', 1, substr_count( $out, '<iframe ' ) );
altorank_test_check( 'embeds: rebuilt with the YouTube source', false !== strpos( $out, 'src="https://www.youtube.com/embed/abc123" width="640" height="360"' ) );
altorank_test_check( 'embeds: back where it was', 0 === strpos( $out, '<p>a</p><iframe ' ) && '</iframe><p>b</p>' === substr( $out, -strlen( '</iframe><p>b</p>' ) ) );
altorank_test_check( 'embeds: no placeholder left behind', false === strpos( $out, '[altorank-embed-' ) );

// Placeholder-shaped text written in the body is only text: it never turns
// into markup, in a text node or inside an attribute value.
$written = '<p>[altorank-embed-0]</p><img src="https://example.com/a.png" alt="[altorank-embed-0]"><a href="https://example.com/" title="[altorank-embed-1]">x</a>';
$out     = altorank_sanitize_content( $written . $embed . $embed );
altorank_test_same( 'embeds: written placeholders stay text', 2, substr_count( $out, '<iframe ' ) );
altorank_test_check( 'embeds: the written text is unchanged', 0 === strpos( $out, $written ) );
altorank_test_check( 'embeds: no quote enters an attribute from a placeholder', false !== strpos( $out, 'alt="[altorank-embed-0]"' ) && false !== strpos( $out, 'title="[altorank-embed-1]"' ) );

// The token differs per call, so one body cannot learn another's.
altorank_sanitize_content( $embed );
$first = $GLOBALS['altorank_wp']['kses_input'] ?? '';
altorank_sanitize_content( $embed );
$second = $GLOBALS['altorank_wp']['kses_input'] ?? '';
altorank_test_check( 'embeds: kses saw a placeholder', 1 === preg_match( '#^\[altorank-embed-[0-9a-f]{16,}-0\]$#', $first ) );
altorank_test_check( 'embeds: the placeholder changes from call to call', $first !== $second );

// Only YouTube, only http(s), host read from the URL as printed.
foreach (
	array(
		'other host'          => '<iframe src="https://example.com/embed/x"></iframe>',
		'lookalike host'      => '<iframe src="https://www.youtube.com.example.com/embed/x"></iframe>',
		'userinfo'            => '<iframe src="https://www.youtube.com@example.com/embed/x"></iframe>',
		'backslash userinfo'  => '<iframe src="https://example.com\\@www.youtube.com/embed/x"></iframe>',
		'script scheme'       => '<iframe src="javascript://www.youtube.com/%0aalert(1)"></iframe>',
		'data scheme'         => '<iframe src="data:text/html,x"></iframe>',
		'no source'           => '<iframe srcdoc="<p>x</p>"></iframe>',
	) as $label => $frame
) {
	$out = altorank_sanitize_content( '<p>a</p>' . $frame );
	if ( 'backslash userinfo' === $label ) {
		// The printed URL loses the backslash, so the browser loads YouTube: kept, as YouTube.
		altorank_test_check( "embeds: $label resolves to the printed host", false === strpos( $out, '<iframe ' ) || false !== strpos( $out, '@www.youtube.com/embed/x"' ) );
		continue;
	}
	altorank_test_same( "embeds: $label is dropped", '<p>a</p>', $out );
}

// Every attribute of the rebuilt iframe comes from the template.
$out = altorank_sanitize_content( '<iframe onload="x()" src="https://www.youtube.com/embed/abc" style="position:fixed" width="1"></iframe>' );
altorank_test_check( 'embeds: original attributes are not carried over', false === strpos( $out, 'onload' ) && false === strpos( $out, 'position' ) );

// Media import: raster images only. An SVG is a document, not a picture.
altorank_test_same( 'media: svg is not an importable type', '', altorank_extension_for_mime( 'image/svg+xml' ) );
altorank_test_same( 'media: png is', 'png', altorank_extension_for_mime( 'image/png' ) );
