<?php
/**
 * Plugin unit tests without WordPress: `php tests/run.php`.
 *
 * bootstrap.php defines the handful of WordPress functions the plugin calls
 * as small in-memory fakes, loads the plugin, and every test-*.php file in
 * this directory then calls the plugin's functions directly. Exits non-zero
 * when any check fails. Run by apps/web/lib/cms/__tests__/wordpress-plugin-php.test.ts
 * whenever `php` is on the PATH.
 *
 * @package AltoRank
 */

require __DIR__ . '/bootstrap.php';

$files = glob( __DIR__ . '/test-*.php' );
sort( $files );
foreach ( $files as $file ) {
	altorank_test_reset();
	require $file;
}

$failures = $GLOBALS['altorank_test_failures'];
fwrite( STDOUT, sprintf( "%d checks, %d failed\n", $GLOBALS['altorank_test_count'], count( $failures ) ) );
foreach ( $failures as $failure ) {
	fwrite( STDOUT, 'FAIL: ' . $failure . "\n" );
}
exit( $failures ? 1 : 0 );
