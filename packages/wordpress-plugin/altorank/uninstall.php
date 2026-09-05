<?php
/**
 * Runs when the plugin is deleted from the Plugins screen. Removes the
 * plugin's own options. Posts and media it created are the site's content and
 * are left alone, along with the `_altorank_*` meta that says where they came
 * from, so a reinstall does not import the same images a second time.
 *
 * @package AltoRank
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'altorank_integration_token' );
delete_option( 'altorank_post_as_draft' );
delete_option( 'altorank_default_author' );
delete_option( 'altorank_default_category' );
