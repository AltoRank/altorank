<?php
/**
 * Plugin Name:       AltoRank
 * Plugin URI:        https://altorank.co
 * Description:       Receives articles from your AltoRank dashboard as posts. Imports images into the media library, fills in Rank Math, Yoast, SEOPress and AIOSEO fields. Adds nothing to your public pages.
 * Version:           1.0.0
 * Requires at least: 6.4
 * Requires PHP:      8.0
 * Author:            AltoRank
 * Author URI:        https://altorank.co
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       altorank
 *
 * @package AltoRank
 */

defined( 'ABSPATH' ) || exit;

define( 'ALTORANK_VERSION', '1.0.0' );
define( 'ALTORANK_PLUGIN_FILE', __FILE__ );
define( 'ALTORANK_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'ALTORANK_REST_NAMESPACE', 'altorank/v1' );

/** Option names. One token per site; the rest are defaults for incoming posts. */
define( 'ALTORANK_OPTION_TOKEN', 'altorank_integration_token' );
define( 'ALTORANK_OPTION_POST_AS_DRAFT', 'altorank_post_as_draft' );
define( 'ALTORANK_OPTION_DEFAULT_AUTHOR', 'altorank_default_author' );
define( 'ALTORANK_OPTION_DEFAULT_CATEGORY', 'altorank_default_category' );

/** Post meta keys this plugin owns. */
define( 'ALTORANK_META_EXTERNAL_ID', '_altorank_external_id' );
define( 'ALTORANK_META_SOURCE_URL', '_altorank_source_url' );

require_once ALTORANK_PLUGIN_DIR . 'includes/api.php';
require_once ALTORANK_PLUGIN_DIR . 'includes/settings.php';

/**
 * Defaults on activation. Draft-by-default is the point: the dashboard's
 * approval gate decides what is ready, and this setting decides whether a
 * ready article is published outright or handed to an editor here first.
 */
function altorank_activate(): void {
	if ( false === get_option( ALTORANK_OPTION_POST_AS_DRAFT, false ) ) {
		add_option( ALTORANK_OPTION_POST_AS_DRAFT, '1' );
	}
}
register_activation_hook( __FILE__, 'altorank_activate' );

/** "Settings" link on the Plugins screen. */
function altorank_plugin_action_links( array $links ): array {
	$url = admin_url( 'options-general.php?page=altorank' );
	array_unshift( $links, '<a href="' . esc_url( $url ) . '">' . esc_html__( 'Settings', 'altorank' ) . '</a>' );
	return $links;
}
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), 'altorank_plugin_action_links' );
