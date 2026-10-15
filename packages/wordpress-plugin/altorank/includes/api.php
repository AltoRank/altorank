<?php
/**
 * REST API: the altorank/v1 namespace.
 *
 * Every write route is guarded by altorank_permission_check(), which compares
 * the X-AltoRank-Token header with the token saved in Settings -> AltoRank
 * using hash_equals(). The token never appears in a URL, a log line or a
 * response. /capabilities is the one unauthenticated route and says only
 * which plugin version this is and what it can do.
 *
 * The public site is touched in one place only: the page of a post this plugin
 * wrote carries that article's own structured data (JSON-LD) in its head,
 * see altorank_print_structured_data(). No scripts, no links, no credits,
 * nothing on any other page. Otherwise it writes posts, media and post meta,
 * and that is all.
 *
 * @package AltoRank
 */

defined( 'ABSPATH' ) || exit;

/** Hosts whose iframes survive sanitisation. Everything else is dropped. */
const ALTORANK_IFRAME_HOSTS = array(
	'www.youtube.com',
	'youtube.com',
	'www.youtube-nocookie.com',
	'youtube-nocookie.com',
	'youtu.be',
);

/** JSON-LD kept per article: at most this many blocks, and this many bytes encoded. */
const ALTORANK_STRUCTURED_DATA_MAX_ITEMS = 10;
const ALTORANK_STRUCTURED_DATA_MAX_BYTES = 65536;

/** Post statuses the dashboard may ask for. */
const ALTORANK_ALLOWED_STATUSES = array( 'publish', 'draft', 'pending', 'private' );

/**
 * SEO plugin fields, one row per plugin. Written blind: a key no installed
 * plugin reads is one unused meta row. Keep in step with
 * apps/web/lib/cms/wordpress-seo-meta.ts.
 */
const ALTORANK_SEO_META = array(
	'rank_math' => array(
		'title'       => 'rank_math_title',
		'description' => 'rank_math_description',
		'focus'       => 'rank_math_focus_keyword',
	),
	'yoast'     => array(
		'title'       => '_yoast_wpseo_title',
		'description' => '_yoast_wpseo_metadesc',
		'focus'       => '_yoast_wpseo_focuskw',
	),
	'seopress'  => array(
		'title'       => '_seopress_titles_title',
		'description' => '_seopress_titles_desc',
		'focus'       => '_seopress_analysis_target_kw',
	),
	'aioseo'    => array(
		'title'       => '_aioseo_title',
		'description' => '_aioseo_description',
		'focus'       => '_aioseo_keyphrases',
	),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function altorank_register_routes(): void {
	register_rest_route(
		ALTORANK_REST_NAMESPACE,
		'/capabilities',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => 'altorank_handle_capabilities',
			'permission_callback' => '__return_true',
		)
	);

	register_rest_route(
		ALTORANK_REST_NAMESPACE,
		'/test-integration',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => 'altorank_handle_test_integration',
			'permission_callback' => 'altorank_permission_check',
		)
	);

	register_rest_route(
		ALTORANK_REST_NAMESPACE,
		'/submit',
		array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => 'altorank_handle_submit',
			'permission_callback' => 'altorank_permission_check',
		)
	);

	register_rest_route(
		ALTORANK_REST_NAMESPACE,
		'/edit',
		array(
			'methods'             => 'PUT, PATCH',
			'callback'            => 'altorank_handle_edit',
			'permission_callback' => 'altorank_permission_check',
		)
	);

	register_rest_route(
		ALTORANK_REST_NAMESPACE,
		'/indexnow',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => 'altorank_handle_indexnow',
			'permission_callback' => 'altorank_permission_check',
		)
	);

	register_rest_route(
		ALTORANK_REST_NAMESPACE,
		'/posts',
		array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => 'altorank_handle_posts',
			'permission_callback' => 'altorank_permission_check',
			'args'                => array(
				'page'     => array(
					'type'    => 'integer',
					'default' => 1,
					'minimum' => 1,
				),
				'per_page' => array(
					'type'    => 'integer',
					'default' => 20,
					'minimum' => 1,
					'maximum' => 100,
				),
				'status'   => array(
					'type'    => 'string',
					'default' => 'publish',
					'enum'    => array( 'publish', 'draft', 'pending', 'private', 'future', 'any' ),
				),
			),
		)
	);
}
add_action( 'rest_api_init', 'altorank_register_routes' );

/** The routes register_rest_route() adds above, as WordPress dispatches them. */
const ALTORANK_ROUTES = array( 'capabilities', 'test-integration', 'submit', 'edit', 'indexnow', 'posts' );

/**
 * Error codes WordPress itself raises from `rest_authentication_errors`: the
 * cookie nonce check and the application-password check. These are never
 * cleared, on any route.
 */
const ALTORANK_CORE_AUTH_ERRORS = array(
	'rest_cookie_invalid_nonce',
	'incorrect_password',
	'invalid_username',
	'invalid_email',
	'empty_username',
	'empty_password',
	'application_passwords_disabled',
	'application_passwords_disabled_for_user',
);

/**
 * The route WordPress is about to dispatch, read from the same query var
 * rest_api_loaded() hands to the REST server (so a `rest_route` in the query
 * string or the body is what is read here, as it is there). Empty outside a
 * REST request.
 */
function altorank_dispatched_route(): string {
	global $wp;
	if ( ! is_object( $wp ) || ! isset( $wp->query_vars['rest_route'] ) || ! is_string( $wp->query_vars['rest_route'] ) ) {
		return '';
	}
	$route = untrailingslashit( $wp->query_vars['rest_route'] );
	return '' === $route ? '/' : $route;
}

/** Whether `$route` is exactly one of this plugin's routes. */
function altorank_is_own_route( string $route ): bool {
	foreach ( ALTORANK_ROUTES as $own ) {
		if ( '/' . ALTORANK_REST_NAMESPACE . '/' . $own === $route ) {
			return true;
		}
	}
	return false;
}

/**
 * Some hosts and security plugins (Wordfence, iThemes, "Disable REST API") answer
 * every unauthenticated REST request with a 401 from `rest_authentication_errors`,
 * which runs before any route's permission_callback. The dashboard's requests
 * carry no WordPress cookie, so on such a site the token check never gets to
 * run: the connection test fails with "rest_not_logged_in" and the person is
 * told to disable their security plugin, which is the wrong fix.
 *
 * This clears such a block only when all of these hold:
 *
 * - the route WordPress will dispatch is exactly one of this plugin's routes
 *   (decided from the dispatched route, never from the request path);
 * - the request carries no logged-in user, so nothing runs with a session;
 * - none of the errors is one WordPress itself raised (ALTORANK_CORE_AUTH_ERRORS).
 *
 * Every route it can apply to runs altorank_permission_check() (or is
 * /capabilities, which discloses only the plugin version), so nothing becomes
 * reachable that the token did not already guard. Every other route keeps
 * whatever the site decided.
 *
 * Priority 999: after the plugins that set the error, so there is something to
 * clear.
 *
 * @param WP_Error|null|true $result Current authentication result.
 * @return WP_Error|null|true
 */
function altorank_allow_own_namespace( $result ) {
	if ( ! is_wp_error( $result ) ) {
		return $result;
	}
	if ( is_user_logged_in() ) {
		return $result;
	}
	if ( array_intersect( $result->get_error_codes(), ALTORANK_CORE_AUTH_ERRORS ) ) {
		return $result;
	}
	if ( ! altorank_is_own_route( altorank_dispatched_route() ) ) {
		return $result;
	}
	// No authentication was performed; the route's own permission_callback decides.
	return null;
}
add_filter( 'rest_authentication_errors', 'altorank_allow_own_namespace', 999 );

/**
 * Serve the IndexNow key file without writing to disk.
 *
 * IndexNow verifies a submission by fetching https://{host}/{key}.txt. Writing
 * that file to the web root (what other plugins do) fails on read-only and
 * managed hosts and leaves a stray file behind on uninstall. WordPress is
 * already answering every request for the host, so the plugin answers this one
 * from the option instead: exact path, exact key, text/plain, done. The key
 * arrives in the submit body from the dashboard (`indexnow_key`) and is stored
 * in ALTORANK_OPTION_INDEXNOW_KEY; the dashboard submits URLs to IndexNow with
 * this location. Nothing else in the plugin reads it.
 */
function altorank_serve_indexnow_key(): void {
	$key = (string) get_option( ALTORANK_OPTION_INDEXNOW_KEY, '' );
	if ( '' === $key || ! preg_match( '/^[A-Za-z0-9-]{8,128}$/', $key ) ) {
		return;
	}
	$path = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ), PHP_URL_PATH ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	$home = rtrim( (string) wp_parse_url( home_url(), PHP_URL_PATH ), '/' );
	if ( $path !== $home . '/' . $key . '.txt' ) {
		return;
	}
	status_header( 200 );
	nocache_headers();
	header( 'Content-Type: text/plain; charset=utf-8' );
	echo $key; // phpcs:ignore WordPress.Security.EscapeOutput -- validated against /^[A-Za-z0-9-]+$/ above.
	exit;
}
add_action( 'parse_request', 'altorank_serve_indexnow_key', 0 );

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of the header token with the saved one.
 *
 * An empty saved token refuses everything: a site that has installed the
 * plugin but not yet pasted a token has no credential, not an open door.
 *
 * @return true|WP_Error
 */
function altorank_permission_check( WP_REST_Request $request ) {
	$stored = (string) get_option( ALTORANK_OPTION_TOKEN, '' );
	$given  = (string) $request->get_header( 'X-AltoRank-Token' );

	if ( '' === $stored || '' === $given || ! hash_equals( $stored, $given ) ) {
		return new WP_Error(
			'altorank_forbidden',
			__( 'Invalid integration token. Paste the token from your AltoRank dashboard into Settings -> AltoRank.', 'altorank' ),
			array( 'status' => 403 )
		);
	}

	return true;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function altorank_handle_capabilities(): WP_REST_Response {
	return new WP_REST_Response(
		array(
			'plugin'   => 'altorank',
			'version'  => ALTORANK_VERSION,
			'features' => array(
				'submit'           => true,
				'edit'             => true,
				'posts'            => true,
				'test_integration' => true,
				'media_import'     => true,
				'seo_meta'         => array_keys( ALTORANK_SEO_META ),
				'indexnow_key'     => true,
				'rest_unblock'     => true,
			),
		)
	);
}

/**
 * Creates and immediately deletes a draft. Proves the token, the REST route
 * and the site's ability to write posts, and leaves nothing behind.
 */
function altorank_handle_test_integration() {
	$post_id = wp_insert_post(
		array(
			'post_type'    => 'post',
			'post_status'  => 'draft',
			'post_title'   => 'altorank-test-post-' . time(),
			'post_content' => '',
			'post_author'  => altorank_resolve_author( null ),
		),
		true
	);

	if ( is_wp_error( $post_id ) ) {
		return new WP_Error(
			'altorank_test_failed',
			sprintf(
				/* translators: %s: WordPress error message */
				__( 'Could not create a test draft: %s', 'altorank' ),
				$post_id->get_error_message()
			),
			array( 'status' => 500 )
		);
	}

	wp_delete_post( (int) $post_id, true );

	return new WP_REST_Response(
		array(
			'ok'      => true,
			'version' => ALTORANK_VERSION,
		)
	);
}

/**
 * GET /indexnow: the key this site serves, and where, so the dashboard can
 * confirm the file resolves before it submits URLs. `key` is null until a
 * submit has carried one.
 */
function altorank_handle_indexnow(): WP_REST_Response {
	$key = (string) get_option( ALTORANK_OPTION_INDEXNOW_KEY, '' );
	return new WP_REST_Response(
		array(
			'key'          => '' !== $key ? $key : null,
			'key_location' => '' !== $key ? home_url( '/' . $key . '.txt' ) : null,
		)
	);
}

/**
 * POST /submit: create a post.
 *
 * Idempotent on external_id: an article the dashboard has already sent is
 * updated rather than duplicated, so a retried request cannot produce two
 * posts.
 */
function altorank_handle_submit( WP_REST_Request $request ) {
	$params = altorank_read_params( $request );

	if ( '' === $params['title'] || '' === $params['content'] ) {
		return new WP_Error( 'altorank_bad_request', __( 'title and content are required.', 'altorank' ), array( 'status' => 400 ) );
	}

	$existing = '' !== $params['external_id'] ? altorank_find_post_by_external_id( $params['external_id'] ) : 0;

	return altorank_upsert_post( $existing, $params, true );
}

/**
 * PUT /edit: update a post the dashboard sent earlier.
 *
 * Found by post_id, then by external_id, then by current_slug, and only ever
 * a post this plugin created (one carrying _altorank_external_id): posts
 * written on the site itself are never touched. A body holding only `status`
 * is a status change (the dashboard's unpublish sends status=draft); anything
 * else replaces the fields it names.
 */
function altorank_handle_edit( WP_REST_Request $request ) {
	$params  = altorank_read_params( $request );
	$post_id = altorank_locate_post( $params );

	if ( ! $post_id ) {
		return new WP_Error( 'altorank_not_found', __( 'No post matches post_id, external_id or current_slug.', 'altorank' ), array( 'status' => 404 ) );
	}

	return altorank_upsert_post( $post_id, $params, false );
}

/** GET /posts: paginated read of the site's posts. */
function altorank_handle_posts( WP_REST_Request $request ): WP_REST_Response {
	$page     = max( 1, (int) $request->get_param( 'page' ) );
	$per_page = min( 100, max( 1, (int) $request->get_param( 'per_page' ) ) );
	$status   = (string) $request->get_param( 'status' );

	$query = new WP_Query(
		array(
			'post_type'      => 'post',
			'post_status'    => $status,
			'posts_per_page' => $per_page,
			'paged'          => $page,
			'orderby'        => 'modified',
			'order'          => 'DESC',
		)
	);

	$posts = array();
	foreach ( $query->posts as $post ) {
		$posts[] = array(
			'id'          => $post->ID,
			'title'       => $post->post_title,
			'slug'        => $post->post_name,
			'url'         => get_permalink( $post ),
			'status'      => $post->post_status,
			'date'        => altorank_iso_date( $post->post_date_gmt, $post->post_date ),
			'modified'    => altorank_iso_date( $post->post_modified_gmt, $post->post_modified ),
			'external_id' => (string) get_post_meta( $post->ID, ALTORANK_META_EXTERNAL_ID, true ),
			'excerpt'     => $post->post_excerpt,
		);
	}

	$response = new WP_REST_Response(
		array(
			'posts'       => $posts,
			'page'        => $page,
			'per_page'    => $per_page,
			'total'       => (int) $query->found_posts,
			'total_pages' => (int) $query->max_num_pages,
		)
	);
	$response->header( 'X-WP-Total', (string) $query->found_posts );
	$response->header( 'X-WP-TotalPages', (string) $query->max_num_pages );

	return $response;
}

/**
 * ISO 8601 in UTC. WordPress stores drafts with a zero post_date_gmt, so the
 * local date is converted when the GMT one is empty.
 */
function altorank_iso_date( string $gmt, string $local ): string {
	if ( '' === $gmt || '0000-00-00 00:00:00' === $gmt ) {
		$gmt = get_gmt_from_date( $local );
	}
	return mysql2date( 'c', $gmt, false );
}

// ---------------------------------------------------------------------------
// Post assembly
// ---------------------------------------------------------------------------

/**
 * Read and type the request body. Every field is optional here; the handlers
 * decide what they require. Keys follow the dashboard adapter
 * (apps/web/lib/cms/wordpress-plugin.ts).
 */
function altorank_read_params( WP_REST_Request $request ): array {
	$p = $request->get_json_params();
	if ( ! is_array( $p ) ) {
		$p = $request->get_params();
	}

	$str = static function ( string $key ) use ( $p ): string {
		return isset( $p[ $key ] ) && is_scalar( $p[ $key ] ) ? (string) $p[ $key ] : '';
	};

	$tags = array();
	if ( isset( $p['tags'] ) && is_array( $p['tags'] ) ) {
		foreach ( $p['tags'] as $tag ) {
			if ( is_scalar( $tag ) && '' !== trim( (string) $tag ) ) {
				$tags[] = sanitize_text_field( (string) $tag );
			}
		}
	}

	$external = $str( 'external_id' );
	if ( '' === $external ) {
		$external = $str( 'id' );
	}

	return array(
		'post_id'            => absint( $str( 'post_id' ) ),
		'external_id'        => sanitize_text_field( $external ),
		'title'              => sanitize_text_field( $str( 'title' ) ),
		'content'            => $str( 'content' ),
		'has_content'        => isset( $p['content'] ),
		'slug'               => $str( 'slug' ),
		'current_slug'       => $str( 'current_slug' ),
		'meta_description'   => sanitize_textarea_field( $str( 'meta_description' ) ),
		'focus_keyword'      => sanitize_text_field( $str( 'focus_keyword' ) ),
		'featured_image_url' => esc_url_raw( $str( 'featured_image_url' ) ),
		'tags'               => $tags,
		'category'           => sanitize_text_field( $str( 'category' ) ),
		'author'             => sanitize_text_field( $str( 'author' ) ),
		'status'             => sanitize_key( $str( 'status' ) ),
		'has_status'         => isset( $p['status'] ),
		'published_at'       => $str( 'published_at' ),
		'indexnow_key'       => preg_match( '/^[A-Za-z0-9-]{8,128}$/', $str( 'indexnow_key' ) ) ? $str( 'indexnow_key' ) : '',
	);
}

/** Whether a post exists, is a post, and was created by this plugin. */
function altorank_is_own_post( int $post_id ): bool {
	return $post_id > 0
		&& 'post' === get_post_type( $post_id )
		&& '' !== (string) get_post_meta( $post_id, ALTORANK_META_EXTERNAL_ID, true );
}

/** The post a /edit request means, or 0. Only posts this plugin created qualify. */
function altorank_locate_post( array $params ): int {
	if ( $params['post_id'] && altorank_is_own_post( $params['post_id'] ) ) {
		return $params['post_id'];
	}
	if ( '' !== $params['external_id'] ) {
		$found = altorank_find_post_by_external_id( $params['external_id'] );
		if ( $found ) {
			return $found;
		}
	}
	if ( '' !== $params['current_slug'] ) {
		$post = get_page_by_path( sanitize_title( $params['current_slug'] ), OBJECT, 'post' );
		if ( $post instanceof WP_Post && altorank_is_own_post( (int) $post->ID ) ) {
			return (int) $post->ID;
		}
	}
	return 0;
}

function altorank_find_post_by_external_id( string $external_id ): int {
	$found = get_posts(
		array(
			'post_type'      => 'post',
			'post_status'    => 'any',
			'posts_per_page' => 1,
			'fields'         => 'ids',
			'meta_key'       => ALTORANK_META_EXTERNAL_ID, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
			'meta_value'     => $external_id, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
			'no_found_rows'  => true,
		)
	);
	return $found ? (int) $found[0] : 0;
}

/**
 * The status a post lands in.
 *
 * "Post as draft" applies to new posts: the dashboard has approved the
 * article, and this setting decides whether that approval publishes it here
 * or hands it to an editor. Edits honour the status they ask for, so a
 * refresh of a live post does not demote it and an unpublish does demote it,
 * with one exception: while "Post as draft" is on, an edit cannot put a post
 * on the site that is not already there. Publishing it is the editor's call.
 *
 * @param string $current The post's status now, for an edit; '' for a new post.
 */
function altorank_resolve_status( array $params, bool $is_new, string $current = '' ): ?string {
	$hold = '1' === (string) get_option( ALTORANK_OPTION_POST_AS_DRAFT, '1' );
	if ( $is_new && $hold ) {
		return 'draft';
	}
	if ( ! $params['has_status'] ) {
		return $is_new ? 'publish' : null;
	}
	if ( ! in_array( $params['status'], ALTORANK_ALLOWED_STATUSES, true ) ) {
		return $is_new ? 'publish' : null;
	}
	if ( ! $is_new && $hold && 'publish' === $params['status'] && 'publish' !== $current ) {
		return null;
	}
	return $params['status'];
}

/**
 * The post's date, or nothing to let WordPress decide.
 *
 * Set only on a post this request creates and publishes, from `published_at`:
 * when the article first went live, which is also the "Published" line in the
 * body and the BlogPosting's datePublished. An edit never sends or changes a
 * date, so a date an editor corrected stays. A post that lands as a draft
 * keeps a floating date and gets the real one when an editor publishes it. A
 * time in the future is ignored: WordPress would schedule the post instead of
 * publishing it.
 */
function altorank_post_date_fields( string $published_at, bool $creates_row, ?string $status ): array {
	if ( ! $creates_row || 'publish' !== $status || '' === $published_at ) {
		return array();
	}
	$ts = strtotime( $published_at );
	if ( false === $ts || $ts > time() ) {
		return array();
	}
	$gmt = gmdate( 'Y-m-d H:i:s', $ts );
	return array(
		'post_date_gmt' => $gmt,
		'post_date'     => get_date_from_gmt( $gmt ),
	);
}

/**
 * Create or update. `$is_new` is about the request, not the row: a /submit
 * that matched an existing external_id still counts as new for the
 * draft-by-default rule, because that is what the dashboard asked for.
 *
 * @return WP_REST_Response|WP_Error
 */
function altorank_upsert_post( int $post_id, array $params, bool $is_new ) {
	$postarr = array(
		'post_type' => 'post',
	);
	if ( $post_id ) {
		$postarr['ID'] = $post_id;
	}

	if ( '' !== $params['title'] ) {
		$postarr['post_title'] = $params['title'];
	}

	$content    = null;
	$structured = null;
	if ( $params['has_content'] ) {
		list( $body, $structured ) = altorank_extract_structured_data( $params['content'] );
		$content                   = altorank_sanitize_content( $body );
		$postarr['post_content']   = $content;
	}

	if ( '' !== $params['slug'] ) {
		$postarr['post_name'] = altorank_unique_slug( $params['slug'], $post_id );
	} elseif ( ! $post_id && '' !== $params['title'] ) {
		$postarr['post_name'] = altorank_unique_slug( $params['title'], 0 );
	}

	$status = altorank_resolve_status( $params, $is_new, $post_id ? (string) get_post_status( $post_id ) : '' );
	if ( null !== $status ) {
		$postarr['post_status'] = $status;
	}

	if ( ! $post_id || '' !== $params['author'] ) {
		$postarr['post_author'] = altorank_resolve_author( $params['author'] );
	}

	if ( '' !== $params['meta_description'] ) {
		$postarr['post_excerpt'] = $params['meta_description'];
	}

	if ( $params['tags'] ) {
		$postarr['tags_input'] = $params['tags'];
	}

	$category = altorank_resolve_category( $params['category'], ! $post_id );
	if ( $category ) {
		$postarr['post_category'] = array( $category );
	}

	$postarr += altorank_post_date_fields( $params['published_at'], ! $post_id, $status );

	/**
	 * SEO fields ride inside the same write as the post. Rank Math and Yoast
	 * build their indexable rows on `save_post`, which fires inside
	 * wp_insert_post(); meta written afterwards with update_post_meta() is
	 * read only on the next save, so a freshly published post rendered with
	 * WordPress's default <title> and no description until someone opened it
	 * in the editor. `meta_input` is applied before those hooks run.
	 */
	$meta_input = altorank_seo_meta_input( $params['title'], $params['meta_description'], $params['focus_keyword'] );
	// Recorded when the dashboard sends the article; an edit never rewrites it.
	if ( $is_new && '' !== $params['external_id'] ) {
		$meta_input[ ALTORANK_META_EXTERNAL_ID ] = $params['external_id'];
	}
	if ( null !== $structured ) {
		// A new body replaces the structured data too: none in it clears the old.
		$meta_input[ ALTORANK_META_STRUCTURED_DATA ] = $structured ? (string) wp_json_encode( $structured, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : '';
	}
	if ( $meta_input ) {
		$postarr['meta_input'] = $meta_input;
	}

	$result = altorank_write_post( $postarr );
	if ( is_wp_error( $result ) ) {
		return new WP_Error( 'altorank_write_failed', $result->get_error_message(), array( 'status' => 500 ) );
	}
	$post_id = (int) $result;

	if ( '' !== $params['indexnow_key'] && $params['indexnow_key'] !== (string) get_option( ALTORANK_OPTION_INDEXNOW_KEY, '' ) ) {
		update_option( ALTORANK_OPTION_INDEXNOW_KEY, $params['indexnow_key'], false );
	}

	altorank_rebuild_yoast_indexable( $post_id );

	/**
	 * Images are the one step that reaches out to another server, and the one
	 * step that must not fail the publish: the post row already exists, and a
	 * 500 here would make the dashboard retry and, without the external_id
	 * round trip, duplicate it. A hot-linked or missing picture is reported in
	 * the response instead (`images`), and the URL is left as it came.
	 */
	$images = array(
		'imported'       => 0,
		'failed'         => 0,
		'featured'       => '' === $params['featured_image_url'] ? 'none' : 'failed',
		'featured_error' => null,
	);
	try {
		if ( null !== $content ) {
			$imported = altorank_import_images( $post_id, $content, $images );
			if ( $imported !== $content ) {
				altorank_write_post(
					array(
						'ID'           => $post_id,
						'post_content' => $imported,
					)
				);
			}
		}
	} catch ( \Throwable $e ) {
		$images['failed']++;
	}

	if ( '' !== $params['featured_image_url'] ) {
		try {
			$attachment_id = altorank_sideload_image( $params['featured_image_url'], $post_id );
			if ( is_wp_error( $attachment_id ) ) {
				$images['featured_error'] = $attachment_id->get_error_message();
			} elseif ( set_post_thumbnail( $post_id, $attachment_id ) ) {
				$images['featured'] = 'set';
			}
		} catch ( \Throwable $e ) {
			$images['featured_error'] = $e->getMessage();
		}
	}

	$response = altorank_post_response( $post_id, $post_id && ! $is_new ? 200 : 201 );
	$data     = $response->get_data();
	$data['images'] = $images;
	$response->set_data( $data );
	return $response;
}

/**
 * The one way this plugin writes a post: wp_insert_post() for a new row,
 * wp_update_post() when `ID` is set.
 *
 * Slashed first. Both functions expect slashed input, the way a form post
 * arrives, and strip one level of backslashes from every field and every
 * meta_input value; the body, title and SEO fields here come from JSON, so
 * without wp_slash() every backslash the article carried was lost (and a
 * JSON-encoded meta value such as AIOSEO's keyphrase lost its escapes).
 *
 * With WordPress's save-time kses lifted. Token requests have no WordPress
 * user, and for a request with no user WordPress runs its own kses pass on
 * save (content_save_pre), which strips every iframe - including the YouTube
 * embed altorank_sanitize_content() just allowed. Every body handed to this
 * function has already been through altorank_sanitize_content(), and the
 * title and excerpt through sanitize_*_field(), so the second pass is lifted
 * for exactly this call and put back after, if it was on before.
 *
 * @return int|WP_Error post id
 */
function altorank_write_post( array $postarr ) {
	$had_kses = false !== has_filter( 'content_save_pre', 'wp_filter_post_kses' );
	kses_remove_filters();
	try {
		$slashed = wp_slash( $postarr );
		return isset( $postarr['ID'] ) ? wp_update_post( $slashed, true ) : wp_insert_post( $slashed, true );
	} finally {
		if ( $had_kses ) {
			kses_init_filters();
		}
	}
}

function altorank_post_response( int $post_id, int $code ): WP_REST_Response {
	$post = get_post( $post_id );
	return new WP_REST_Response(
		array(
			'id'       => $post_id,
			'url'      => get_permalink( $post ),
			'slug'     => $post ? $post->post_name : '',
			'status'   => $post ? $post->post_status : '',
			'edit_url' => admin_url( 'post.php?post=' . $post_id . '&action=edit' ),
		),
		$code
	);
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * A slug no other post has. wp_unique_post_slug() skips drafts, so a site that
 * posts as draft would get duplicates the moment two were published; asking
 * for the 'publish' rule regardless of status avoids that.
 */
function altorank_unique_slug( string $wanted, int $post_id ): string {
	$slug = sanitize_title( $wanted );
	if ( '' === $slug ) {
		return '';
	}
	return wp_unique_post_slug( $slug, $post_id, 'publish', 'post', 0 );
}

/**
 * wp_kses() with the post allowlist plus inline SVG charts, keeping YouTube
 * embeds.
 *
 * kses removes every iframe. The one embed an article body legitimately
 * carries is a YouTube video, so those are lifted out first, rebuilt from a
 * fixed attribute list (never the original markup), and put back after
 * sanitising. Any other iframe is dropped.
 *
 * Script blocks never reach here: altorank_extract_structured_data() has
 * already taken the JSON-LD out and dropped every other script whole.
 */
function altorank_sanitize_content( string $html ): string {
	$kept = array();

	$html = preg_replace_callback(
		'#<iframe\b[^>]*>.*?</iframe>#is',
		static function ( array $m ) use ( &$kept ): string {
			if ( ! preg_match( '#\bsrc=["\']([^"\']+)["\']#i', $m[0], $src ) ) {
				return '';
			}
			$url  = $src[1];
			$host = strtolower( (string) wp_parse_url( $url, PHP_URL_HOST ) );
			if ( ! in_array( $host, ALTORANK_IFRAME_HOSTS, true ) ) {
				return '';
			}
			$width  = preg_match( '#\bwidth=["\']?(\d+)#i', $m[0], $w ) ? (int) $w[1] : 560;
			$height = preg_match( '#\bheight=["\']?(\d+)#i', $m[0], $h ) ? (int) $h[1] : 315;

			// A text token, not an HTML comment: wp_kses_post() strips comments.
			$key          = '[altorank-embed-' . count( $kept ) . ']';
			$kept[ $key ] = sprintf(
				'<iframe src="%s" width="%d" height="%d" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>',
				esc_url( $url ),
				$width,
				$height
			);
			return $key;
		},
		$html
	);

	$html = wp_kses( $html, altorank_allowed_html() );

	return $kept ? str_replace( array_keys( $kept ), array_values( $kept ), $html ) : $html;
}

/**
 * What an article body may contain: WordPress's post allowlist, plus the
 * inline SVG the dashboard draws charts with (shapes and text only).
 *
 * Without the SVG elements kses strips the tags and keeps their text, and a
 * chart arrives as a run of loose labels and numbers. No element added here
 * can load or run anything: no script, image, use, foreignObject or link, and
 * no href or event-handler attribute. `style` is filtered by kses's own CSS
 * allowlist.
 */
function altorank_allowed_html(): array {
	$allowed = wp_kses_allowed_html( 'post' );

	$paint = array(
		'class'        => true,
		'fill'         => true,
		'fill-opacity' => true,
		'opacity'      => true,
		'stroke'       => true,
		'stroke-width' => true,
		'transform'    => true,
		'aria-hidden'  => true,
	);
	$text  = $paint + array(
		'x'                 => true,
		'y'                 => true,
		'dx'                => true,
		'dy'                => true,
		'text-anchor'       => true,
		'dominant-baseline' => true,
		'font-size'         => true,
		'font-weight'       => true,
		'font-family'       => true,
	);

	$allowed['svg']   = array(
		'xmlns'               => true,
		'viewbox'             => true,
		'width'               => true,
		'height'              => true,
		'role'                => true,
		'aria-label'          => true,
		'aria-hidden'         => true,
		'focusable'           => true,
		'preserveaspectratio' => true,
		'class'               => true,
		'style'               => true,
	);
	$allowed['g']     = $paint;
	$allowed['title'] = array();
	$allowed['desc']  = array();
	$allowed['text']  = $text;
	$allowed['tspan'] = $text;
	$allowed['rect']  = $paint + array(
		'x'      => true,
		'y'      => true,
		'width'  => true,
		'height' => true,
		'rx'     => true,
		'ry'     => true,
	);
	$allowed['line']  = $paint + array(
		'x1' => true,
		'y1' => true,
		'x2' => true,
		'y2' => true,
	);

	return $allowed;
}

/**
 * Take the article's JSON-LD out of the body.
 *
 * The dashboard appends its structured data (a BlogPosting, a FAQPage) to the
 * body as <script type="application/ld+json"> blocks. kses would strip the
 * tags and leave the JSON as a visible paragraph at the end of the post, and
 * a script in post content does not survive a later save by an editor
 * without unfiltered_html either. So each block is decoded here and kept as
 * data (ALTORANK_META_STRUCTURED_DATA), and altorank_print_structured_data()
 * re-encodes it into the page head. A block that is not valid JSON is dropped;
 * any other <script> is dropped whole, text included.
 *
 * @return array{0: string, 1: array} the body without scripts, and the decoded blocks
 */
function altorank_extract_structured_data( string $html ): array {
	$items = array();
	$bytes = 0;

	$out = preg_replace_callback(
		'#<script\b([^>]*)>(.*?)</script\s*>#is',
		static function ( array $m ) use ( &$items, &$bytes ): string {
			if ( ! preg_match( '#\btype\s*=\s*["\']?application/ld\+json\b#i', $m[1] ) ) {
				return '';
			}
			$decoded = json_decode( trim( $m[2] ), true );
			if ( ! is_array( $decoded ) || ! $decoded || count( $items ) >= ALTORANK_STRUCTURED_DATA_MAX_ITEMS ) {
				return '';
			}
			$size = strlen( (string) wp_json_encode( $decoded ) );
			if ( $bytes + $size > ALTORANK_STRUCTURED_DATA_MAX_BYTES ) {
				return '';
			}
			$bytes  += $size;
			$items[] = $decoded;
			return '';
		},
		$html
	);

	// A body too large for the pattern is left to kses as it was.
	if ( null === $out ) {
		return array( $html, array() );
	}
	return array( rtrim( $out ), $items );
}

/**
 * Print an AltoRank article's JSON-LD in its page head. Nothing on any other
 * page, and nothing for a post without it.
 *
 * Re-encoded from the decoded data, never echoed as received: with
 * JSON_HEX_TAG no `<` or `>` reaches the page, so the data cannot end the
 * script element.
 */
function altorank_print_structured_data(): void {
	if ( ! is_singular( 'post' ) ) {
		return;
	}
	$raw = (string) get_post_meta( (int) get_queried_object_id(), ALTORANK_META_STRUCTURED_DATA, true );
	if ( '' === $raw ) {
		return;
	}
	$items = json_decode( $raw, true );
	if ( ! is_array( $items ) ) {
		return;
	}
	foreach ( array_slice( $items, 0, ALTORANK_STRUCTURED_DATA_MAX_ITEMS ) as $item ) {
		if ( ! is_array( $item ) ) {
			continue;
		}
		$json = wp_json_encode( $item, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( false === $json ) {
			continue;
		}
		echo '<script type="application/ld+json">' . $json . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput -- JSON with every < and > hex-escaped.
	}
}
add_action( 'wp_head', 'altorank_print_structured_data' );

/**
 * Download every remote <img> into the media library and point the post at
 * the copies. Images already on this site are left alone. A download that
 * fails leaves the original URL in place: a hot-linked picture beats a broken
 * one, and the publish still succeeds.
 */
function altorank_import_images( int $post_id, string $content, ?array &$stats = null ): string {
	if ( ! preg_match_all( '#<img\b[^>]*\bsrc=["\']([^"\']+)["\']#i', $content, $matches ) ) {
		return $content;
	}

	$home_host = strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) );

	foreach ( array_unique( $matches[1] ) as $src ) {
		if ( ! preg_match( '#^https?://#i', $src ) ) {
			continue;
		}
		if ( strtolower( (string) wp_parse_url( $src, PHP_URL_HOST ) ) === $home_host ) {
			continue;
		}

		$attachment_id = altorank_sideload_image( $src, $post_id );
		if ( is_wp_error( $attachment_id ) ) {
			if ( null !== $stats ) {
				$stats['failed']++;
			}
			continue;
		}

		$local = wp_get_attachment_url( $attachment_id );
		if ( $local ) {
			$content = str_replace( $src, $local, $content );
			if ( null !== $stats ) {
				$stats['imported']++;
			}
		}
	}

	return $content;
}

/** The attachment previously imported from this URL, or 0. */
function altorank_find_attachment_by_source( string $url ): int {
	$found = get_posts(
		array(
			'post_type'      => 'attachment',
			'post_status'    => 'inherit',
			'posts_per_page' => 1,
			'fields'         => 'ids',
			'meta_key'       => ALTORANK_META_SOURCE_URL, // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key
			'meta_value'     => esc_url_raw( $url ), // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_value
			'no_found_rows'  => true,
		)
	);
	return $found ? (int) $found[0] : 0;
}

/**
 * Import one remote image, once.
 *
 * The source URL is recorded on the attachment as _altorank_source_url, and a
 * later request for the same URL (a refresh of the article, a retried publish)
 * returns the existing attachment instead of importing a second copy.
 *
 * Not media_sideload_image(): that requires an image extension in the URL
 * path, and storage URLs often have none. The file is downloaded, its type
 * read from the bytes, and handed to media_handle_sideload() with a name that
 * carries the right extension.
 *
 * @return int|WP_Error attachment id
 */
function altorank_sideload_image( string $url, int $post_id ) {
	$existing = altorank_find_attachment_by_source( $url );
	if ( $existing ) {
		return $existing;
	}

	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/media.php';
	require_once ABSPATH . 'wp-admin/includes/image.php';

	$tmp = download_url( $url, 30 );
	if ( is_wp_error( $tmp ) ) {
		return $tmp;
	}

	$mime = wp_get_image_mime( $tmp );
	$ext  = $mime ? altorank_extension_for_mime( $mime ) : '';
	if ( '' === $ext ) {
		wp_delete_file( $tmp );
		return new WP_Error( 'altorank_not_an_image', __( 'The URL did not return an image.', 'altorank' ) );
	}

	$name = sanitize_file_name( wp_basename( (string) wp_parse_url( $url, PHP_URL_PATH ) ) );
	if ( '' === $name || false === strpos( $name, '.' ) ) {
		$name = ( '' === $name ? 'image' : $name ) . '.' . $ext;
	}

	$attachment_id = media_handle_sideload(
		array(
			'name'     => $name,
			'tmp_name' => $tmp,
		),
		$post_id
	);

	if ( is_wp_error( $attachment_id ) ) {
		wp_delete_file( $tmp );
		return $attachment_id;
	}

	update_post_meta( (int) $attachment_id, ALTORANK_META_SOURCE_URL, esc_url_raw( $url ) );

	return (int) $attachment_id;
}

function altorank_extension_for_mime( string $mime ): string {
	$map = array(
		'image/jpeg'    => 'jpg',
		'image/png'     => 'png',
		'image/gif'     => 'gif',
		'image/webp'    => 'webp',
		'image/avif'    => 'avif',
		'image/svg+xml' => 'svg',
	);
	return $map[ $mime ] ?? '';
}

/**
 * Fill in the installed SEO plugin's fields, whichever it is. Empty values are
 * skipped, never written as "": an empty Yoast title renders an empty <title>.
 *
 * AIOSEO 4.x keeps its data in its own table and treats _aioseo_* post meta as
 * an import source it picks up on its next scan of the post, so that one is
 * best effort. The other three read post meta directly.
 */
function altorank_seo_meta_input( string $title, string $description, string $focus ): array {
	$meta = array();
	foreach ( ALTORANK_SEO_META as $plugin => $keys ) {
		if ( '' !== $title ) {
			$meta[ $keys['title'] ] = $title;
		}
		if ( '' !== $description ) {
			$meta[ $keys['description'] ] = $description;
		}
		if ( '' !== $focus ) {
			$meta[ $keys['focus'] ] = 'aioseo' === $plugin
				? wp_json_encode( array( 'focus' => array( 'keyphrase' => $focus ) ) )
				: $focus;
		}
	}
	return $meta;
}

/**
 * Yoast keeps a copy of a post's SEO fields in its own indexable table and
 * reads the <title> and description from there, not from post meta. It
 * rebuilds that row on save_post, but only from meta it can see at the time;
 * on some versions a meta_input write still lands a beat late. Rebuilding
 * explicitly after the write makes the first render right on every version.
 * No-op without Yoast. Never fails the publish.
 */
function altorank_rebuild_yoast_indexable( int $post_id ): void {
	if ( function_exists( 'YoastSEO' ) ) {
		try {
			$container  = YoastSEO()->classes;
			$repository = $container->get( 'Yoast\\WP\\SEO\\Repositories\\Indexable_Repository' );
			$builder    = $container->get( 'Yoast\\WP\\SEO\\Builders\\Indexable_Builder' );
			$indexable  = $repository->find_by_id_and_type( $post_id, 'post' );
			if ( $indexable ) {
				$builder->build_for_id_and_type( $post_id, 'post', $indexable );
				$indexable->save();
			}
			return;
		} catch ( \Throwable $e ) {
			// Older container layout; fall through to the action below.
		}
	}
	if ( class_exists( 'WPSEO_Meta' ) ) {
		do_action( 'wpseo_save_indexable', $post_id, get_post( $post_id ) );
	}
}

/**
 * The author for a post: the request's (id, login or email), else the default
 * from settings, else the first administrator. Never 0, which WordPress
 * renders as an authorless post.
 */
function altorank_resolve_author( ?string $requested ): int {
	if ( null !== $requested && '' !== $requested ) {
		$user = is_numeric( $requested ) ? get_user_by( 'id', (int) $requested ) : null;
		if ( ! $user ) {
			$user = get_user_by( 'login', $requested );
		}
		if ( ! $user && is_email( $requested ) ) {
			$user = get_user_by( 'email', $requested );
		}
		if ( $user instanceof WP_User ) {
			return $user->ID;
		}
	}

	$default = absint( get_option( ALTORANK_OPTION_DEFAULT_AUTHOR, 0 ) );
	if ( $default && get_user_by( 'id', $default ) ) {
		return $default;
	}

	$admins = get_users(
		array(
			'role'    => 'administrator',
			'number'  => 1,
			'orderby' => 'ID',
			'order'   => 'ASC',
			'fields'  => 'ID',
		)
	);
	return $admins ? (int) $admins[0] : 1;
}

/**
 * The category for a post: the request's (slug or name, created if missing),
 * else the default from settings on a new post, else none - WordPress then
 * applies its own default.
 */
function altorank_resolve_category( string $requested, bool $is_new ): int {
	if ( '' !== $requested ) {
		$term = get_term_by( 'slug', sanitize_title( $requested ), 'category' );
		if ( ! $term ) {
			$term = get_term_by( 'name', $requested, 'category' );
		}
		if ( $term instanceof WP_Term ) {
			return (int) $term->term_id;
		}
		$created = wp_insert_term( $requested, 'category' );
		if ( ! is_wp_error( $created ) ) {
			return (int) $created['term_id'];
		}
	}

	if ( $is_new ) {
		$default = absint( get_option( ALTORANK_OPTION_DEFAULT_CATEGORY, 0 ) );
		if ( $default && term_exists( $default, 'category' ) ) {
			return $default;
		}
	}

	return 0;
}
