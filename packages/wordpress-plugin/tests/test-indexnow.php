<?php
/**
 * altorank_indexnow_key_location(): the key is reported where the plugin
 * serves it, including on a WordPress in a subdirectory.
 *
 * @package AltoRank
 */

altorank_test_same( 'indexnow: no key, no location', null, altorank_indexnow_key_location() );

$GLOBALS['altorank_wp']['options'][ ALTORANK_OPTION_INDEXNOW_KEY ] = 'abcdef0123456789';
altorank_test_same( 'indexnow: at the site root', 'https://example.com/abcdef0123456789.txt', altorank_indexnow_key_location() );

$GLOBALS['altorank_wp']['options']['home'] = 'http://example.org/blog';
altorank_test_same( 'indexnow: under the home path, with its scheme', 'http://example.org/blog/abcdef0123456789.txt', altorank_indexnow_key_location() );

$GLOBALS['altorank_wp']['options'][ ALTORANK_OPTION_INDEXNOW_KEY ] = '../x';
altorank_test_same( 'indexnow: a malformed key has no location', null, altorank_indexnow_key_location() );
