<?php
/**
 * Just enough WordPress to load the plugin and call its functions.
 *
 * Each fake does the one thing the plugin relies on and records what it was
 * given in $GLOBALS['altorank_wp'], so a test can say "the post written had
 * this content" without a database. Anything the plugin calls that is not
 * faked here is a fatal error, which is the point: a new WordPress call gets
 * a fake on purpose, not by accident.
 *
 * @package AltoRank
 */

// A warning or notice in the plugin is a failure, not noise. Deprecations
// are left out: they differ between PHP versions and say nothing about
// behaviour.
error_reporting( E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED );
ini_set( 'display_errors', '1' );
set_error_handler(
	static function ( int $severity, string $message, string $file, int $line ): bool {
		if ( ! ( error_reporting() & $severity ) ) {
			return false;
		}
		throw new ErrorException( $message, 0, $severity, $file, $line );
	}
);

define( 'ABSPATH', __DIR__ . '/' );

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

$GLOBALS['altorank_test_failures'] = array();
$GLOBALS['altorank_test_count']    = 0;

function altorank_test_check( string $name, bool $ok ): void {
	$GLOBALS['altorank_test_count']++;
	if ( ! $ok ) {
		$GLOBALS['altorank_test_failures'][] = $name;
	}
}

function altorank_test_same( string $name, $expected, $actual ): void {
	$ok = $expected === $actual;
	if ( ! $ok ) {
		$name .= ' (expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) . ')';
	}
	altorank_test_check( $name, $ok );
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Fresh fake WordPress state: no user, no options, no posts. */
function altorank_test_reset(): void {
	$GLOBALS['altorank_wp'] = array(
		'user'     => 0,
		'options'  => array(),
		'posts'    => array(),
		'meta'     => array(),
		'filters'  => array(),
		'writes'   => array(),
		'next_id'  => 100,
		'time'     => null,
		'kses'     => true,
		'kses_allowed' => null,
		'kses_input'   => null,
		'singular' => false,
		'queried'  => 0,
	);
	$GLOBALS['wp']          = null;
}
altorank_test_reset();

// ---------------------------------------------------------------------------
// Hooks (recorded, never run) and plugin loading
// ---------------------------------------------------------------------------

$GLOBALS['altorank_test_hooks'] = array();

function add_action( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['altorank_test_hooks'][] = array( $hook, $callback, $priority );
	return true;
}

function add_filter( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['altorank_test_hooks'][] = array( $hook, $callback, $priority );
	return true;
}

function register_activation_hook( $file, $callback ) {}

function plugin_dir_path( $file ) {
	return rtrim( dirname( $file ), '/' ) . '/';
}

function plugin_basename( $file ) {
	return 'altorank/altorank.php';
}

// ---------------------------------------------------------------------------
// Errors, users, i18n
// ---------------------------------------------------------------------------

class WP_Error {
	private $errors = array();

	public function __construct( $code = '', $message = '', $data = '' ) {
		if ( '' !== $code ) {
			$this->errors[ $code ] = array( $message );
		}
	}

	public function add( $code, $message ) {
		$this->errors[ $code ][] = $message;
	}

	public function get_error_codes() {
		return array_keys( $this->errors );
	}

	public function get_error_message() {
		foreach ( $this->errors as $messages ) {
			return (string) $messages[0];
		}
		return '';
	}
}

function is_wp_error( $thing ) {
	return $thing instanceof WP_Error;
}

function is_user_logged_in() {
	return $GLOBALS['altorank_wp']['user'] > 0;
}

function __( $text, $domain = null ) {
	return $text;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function untrailingslashit( $value ) {
	return rtrim( (string) $value, '/\\' );
}

/** WordPress's wp_slash(): addslashes on every string, recursively. */
function wp_slash( $value ) {
	if ( is_array( $value ) ) {
		return array_map( 'wp_slash', $value );
	}
	return is_string( $value ) ? addslashes( $value ) : $value;
}

/** WordPress's wp_unslash(): stripslashes on every string, recursively. */
function wp_unslash( $value ) {
	if ( is_array( $value ) ) {
		return array_map( 'wp_unslash', $value );
	}
	return is_string( $value ) ? stripslashes( $value ) : $value;
}

function wp_json_encode( $data, $flags = 0, $depth = 512 ) {
	return json_encode( $data, $flags, $depth );
}

function wp_parse_url( $url, $component = -1 ) {
	return parse_url( (string) $url, $component );
}

/** WordPress's character filter and protocol check, without the entity rewriting. */
function esc_url( $url, $protocols = null ) {
	$url    = (string) preg_replace( '|[^a-z0-9-~+_.?#=!&;,/:%@$\|*\'()\[\]\x80-\xff]|i', '', (string) $url );
	$scheme = parse_url( $url, PHP_URL_SCHEME );
	$allow  = null === $protocols ? array( 'http', 'https', 'ftp', 'ftps', 'mailto' ) : $protocols;
	if ( is_string( $scheme ) && '' !== $scheme && ! in_array( strtolower( $scheme ), $allow, true ) ) {
		return '';
	}
	return $url;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function get_option( $name, $default = false ) {
	return array_key_exists( $name, $GLOBALS['altorank_wp']['options'] ) ? $GLOBALS['altorank_wp']['options'][ $name ] : $default;
}

function update_option( $name, $value, $autoload = null ) {
	$GLOBALS['altorank_wp']['options'][ $name ] = $value;
	return true;
}

// ---------------------------------------------------------------------------
// kses and post writes
// ---------------------------------------------------------------------------

function has_filter( $hook, $callback = false ) {
	if ( 'content_save_pre' === $hook && 'wp_filter_post_kses' === $callback ) {
		return $GLOBALS['altorank_wp']['kses'] ? 10 : false;
	}
	return false;
}

function kses_remove_filters() {
	$GLOBALS['altorank_wp']['kses'] = false;
}

function kses_init_filters() {
	$GLOBALS['altorank_wp']['kses'] = true;
}

/**
 * Records the write as WordPress would store it: one level of slashes
 * removed from every field and meta value (wp_insert_post() and
 * update_metadata() both unslash), and whether save-time kses was on.
 */
function altorank_test_record_write( string $fn, array $postarr ) {
	if ( 'throw' === ( $postarr['post_title'] ?? '' ) ) {
		throw new RuntimeException( 'write failed' );
	}
	$data = wp_unslash( $postarr );
	$id   = isset( $data['ID'] ) ? (int) $data['ID'] : $GLOBALS['altorank_wp']['next_id']++;

	$GLOBALS['altorank_wp']['writes'][] = array(
		'fn'   => $fn,
		'kses' => $GLOBALS['altorank_wp']['kses'],
		'data' => $data,
	);

	$meta = $data['meta_input'] ?? array();
	unset( $data['meta_input'], $data['ID'] );
	$GLOBALS['altorank_wp']['posts'][ $id ] = array_merge( $GLOBALS['altorank_wp']['posts'][ $id ] ?? array( 'post_type' => 'post' ), $data );
	foreach ( $meta as $key => $value ) {
		$GLOBALS['altorank_wp']['meta'][ $id ][ $key ] = $value;
	}
	return $id;
}

function wp_insert_post( $postarr, $wp_error = false, $fire_after_hooks = true ) {
	return altorank_test_record_write( 'insert', $postarr );
}

function wp_update_post( $postarr = array(), $wp_error = false, $fire_after_hooks = true ) {
	return altorank_test_record_write( 'update', $postarr );
}

// ---------------------------------------------------------------------------
// Sanitising and templates
// ---------------------------------------------------------------------------

/** A stand-in for WordPress's post allowlist: enough to tell it apart. */
function wp_kses_allowed_html( $context = '' ) {
	return array(
		'p'      => array(),
		'figure' => array( 'class' => true ),
		'a'      => array( 'href' => true ),
	);
}

/** Records the allowlist and the HTML it was given; the HTML is returned as is (real kses is not reimplemented here). */
function wp_kses( $html, $allowed, $protocols = array() ) {
	$GLOBALS['altorank_wp']['kses_allowed'] = $allowed;
	$GLOBALS['altorank_wp']['kses_input']   = $html;
	return $html;
}

function is_singular( $post_types = '' ) {
	return $GLOBALS['altorank_wp']['singular'];
}

function get_queried_object_id() {
	return $GLOBALS['altorank_wp']['queried'];
}

function get_post_meta( $post_id, $key = '', $single = false ) {
	$value = $GLOBALS['altorank_wp']['meta'][ (int) $post_id ][ $key ] ?? null;
	if ( null === $value ) {
		return $single ? '' : array();
	}
	return $single ? $value : array( $value );
}

// ---------------------------------------------------------------------------
// Post lookups
// ---------------------------------------------------------------------------

define( 'OBJECT', 'OBJECT' );

class WP_Post {
	public $ID;
	public $post_name;
	public $post_type;

	public function __construct( int $id, array $row ) {
		$this->ID        = $id;
		$this->post_name = $row['post_name'] ?? '';
		$this->post_type = $row['post_type'] ?? 'post';
	}
}

/** Put a post in the fake store; `meta` becomes its post meta. */
function altorank_test_add_post( int $id, array $row, array $meta = array() ): void {
	$GLOBALS['altorank_wp']['posts'][ $id ] = $row + array( 'post_type' => 'post' );
	$GLOBALS['altorank_wp']['meta'][ $id ]  = $meta;
}

function get_post_type( $post = null ) {
	return $GLOBALS['altorank_wp']['posts'][ (int) $post ]['post_type'] ?? false;
}

function get_post_status( $post = null ) {
	return $GLOBALS['altorank_wp']['posts'][ (int) $post ]['post_status'] ?? false;
}

function sanitize_title( $title ) {
	return trim( (string) preg_replace( '/[^a-z0-9]+/', '-', strtolower( (string) $title ) ), '-' );
}

/** Only the meta_key/meta_value lookup the plugin makes. */
function get_posts( $args = array() ) {
	$out = array();
	foreach ( $GLOBALS['altorank_wp']['posts'] as $id => $row ) {
		if ( ( $args['post_type'] ?? 'post' ) !== $row['post_type'] ) {
			continue;
		}
		if ( isset( $args['meta_key'] ) && ( $GLOBALS['altorank_wp']['meta'][ $id ][ $args['meta_key'] ] ?? null ) !== $args['meta_value'] ) {
			continue;
		}
		$out[] = $id;
	}
	return array_slice( $out, 0, (int) ( $args['posts_per_page'] ?? 5 ) );
}

function get_page_by_path( $path, $output = OBJECT, $post_type = 'page' ) {
	foreach ( $GLOBALS['altorank_wp']['posts'] as $id => $row ) {
		if ( $row['post_type'] === $post_type && ( $row['post_name'] ?? '' ) === $path ) {
			return new WP_Post( $id, $row );
		}
	}
	return null;
}

/** The fake site runs on UTC. */
function get_date_from_gmt( $date_string, $format = 'Y-m-d H:i:s' ) {
	return $date_string;
}

/** The fake site's home, which a test may move into a subdirectory. */
function home_url( $path = '', $scheme = null ) {
	return rtrim( $GLOBALS['altorank_wp']['options']['home'] ?? 'https://example.com', '/' ) . '/' . ltrim( (string) $path, '/' );
}

require dirname( __DIR__ ) . '/altorank/altorank.php';
