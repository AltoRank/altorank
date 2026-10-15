<?php
/**
 * altorank_allow_own_namespace(): which authentication errors the plugin may
 * clear, decided from the route WordPress dispatches.
 *
 * @package AltoRank
 */

/** A REST request WordPress will dispatch to `$route`, with or without a session. */
function altorank_test_rest_request( string $route, string $request_uri = '', bool $logged_in = false ): void {
	$GLOBALS['wp']                         = (object) array( 'query_vars' => array( 'rest_route' => $route ) );
	$GLOBALS['altorank_wp']['user']        = $logged_in ? 1 : 0;
	$_SERVER['REQUEST_URI']                = '' !== $request_uri ? $request_uri : '/wp-json' . $route;
}

// Results that are not errors pass through untouched.
altorank_test_rest_request( '/altorank/v1/submit' );
altorank_test_same( 'rest auth: null passes through', null, altorank_allow_own_namespace( null ) );
altorank_test_same( 'rest auth: true passes through', true, altorank_allow_own_namespace( true ) );

// The one case it exists for: a security plugin's block on the plugin's own route.
foreach ( array( 'capabilities', 'test-integration', 'submit', 'edit', 'indexnow', 'posts' ) as $own ) {
	altorank_test_rest_request( '/altorank/v1/' . $own );
	altorank_test_same(
		"rest auth: a third-party block on /altorank/v1/$own is cleared",
		null,
		altorank_allow_own_namespace( new WP_Error( 'rest_not_logged_in', 'blocked' ) )
	);
}
altorank_test_rest_request( '/altorank/v1/submit/' );
altorank_test_same(
	'rest auth: a trailing slash is the same route',
	null,
	altorank_allow_own_namespace( new WP_Error( 'rest_cannot_access', 'blocked' ) )
);

// The dispatched route decides, never the request path.
altorank_test_rest_request( '/wp/v2/users', '/wp-json/altorank/v1/submit?rest_route=/wp/v2/users' );
$err = new WP_Error( 'rest_not_logged_in', 'blocked' );
altorank_test_same( 'rest auth: another namespace keeps its error whatever the path says', $err, altorank_allow_own_namespace( $err ) );

altorank_test_rest_request( '/wp/v2/users', '/index.php?rest_route=/altorank/v1/submit' );
$err = new WP_Error( 'rest_not_logged_in', 'blocked' );
altorank_test_same( 'rest auth: the request path is never consulted', $err, altorank_allow_own_namespace( $err ) );

// Only the exact routes, not anything that starts with the namespace.
foreach ( array( '/altorank/v1/other', '/altorank/v1', '/altorank/v1/submit/x', '/AltoRank/v1/submit', '/altorank/v2/submit', '/' ) as $route ) {
	altorank_test_rest_request( $route );
	$err = new WP_Error( 'rest_not_logged_in', 'blocked' );
	altorank_test_same( "rest auth: $route keeps its error", $err, altorank_allow_own_namespace( $err ) );
}

// WordPress's own checks are never cleared, on any route.
foreach ( array( 'rest_cookie_invalid_nonce', 'incorrect_password', 'invalid_username', 'application_passwords_disabled' ) as $code ) {
	altorank_test_rest_request( '/altorank/v1/submit' );
	$err = new WP_Error( $code, 'core' );
	altorank_test_same( "rest auth: core error $code is kept on the plugin's own route", $err, altorank_allow_own_namespace( $err ) );
}

$err = new WP_Error( 'rest_not_logged_in', 'blocked' );
$err->add( 'rest_cookie_invalid_nonce', 'core' );
altorank_test_same( 'rest auth: a core error among others keeps the whole result', $err, altorank_allow_own_namespace( $err ) );

// A request with a session keeps whatever was decided.
altorank_test_rest_request( '/altorank/v1/submit', '', true );
$err = new WP_Error( 'rest_not_logged_in', 'blocked' );
altorank_test_same( 'rest auth: a logged-in request keeps its error', $err, altorank_allow_own_namespace( $err ) );

// Outside a REST request there is no route, so nothing is cleared.
$GLOBALS['wp'] = null;
$err           = new WP_Error( 'rest_not_logged_in', 'blocked' );
altorank_test_same( 'rest auth: no dispatched route keeps the error', $err, altorank_allow_own_namespace( $err ) );

$GLOBALS['wp'] = (object) array( 'query_vars' => array( 'rest_route' => array( '/altorank/v1/submit' ) ) );
$err           = new WP_Error( 'rest_not_logged_in', 'blocked' );
altorank_test_same( 'rest auth: a non-string route keeps the error', $err, altorank_allow_own_namespace( $err ) );

// Registered at 999, on the filter WordPress checks before dispatching.
$registered = array_filter(
	$GLOBALS['altorank_test_hooks'],
	static function ( $hook ) {
		return 'rest_authentication_errors' === $hook[0] && 'altorank_allow_own_namespace' === $hook[1];
	}
);
altorank_test_same( 'rest auth: registered once', 1, count( $registered ) );
altorank_test_same( 'rest auth: registered at priority 999', 999, array_values( $registered )[0][2] ?? null );

unset( $_SERVER['REQUEST_URI'] );
