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
 * Nothing in this file touches the public site: no scripts, no links, no
 * credits, no meta tags. It writes posts, media and post meta, and that is all.
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
 * Found by post_id, then by external_id, then by current_slug. A body holding
 * only `status` is a status change (the dashboard's unpublish sends
 * status=draft); anything else replaces the fields it names.
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
		'created_at'         => $str( 'created_at' ),
	);
}

/** The post a /edit request means, or 0. */
function altorank_locate_post( array $params ): int {
	if ( $params['post_id'] && 'post' === get_post_type( $params['post_id'] ) ) {
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
		if ( $post instanceof WP_Post ) {
			return $post->ID;
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
 * refresh of a live post does not demote it and an unpublish does demote it.
 */
function altorank_resolve_status( array $params, bool $is_new ): ?string {
	if ( $is_new && '1' === (string) get_option( ALTORANK_OPTION_POST_AS_DRAFT, '1' ) ) {
		return 'draft';
	}
	if ( ! $params['has_status'] ) {
		return $is_new ? 'publish' : null;
	}
	return in_array( $params['status'], ALTORANK_ALLOWED_STATUSES, true ) ? $params['status'] : ( $is_new ? 'publish' : null );
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

	$content = null;
	if ( $params['has_content'] ) {
		$content                 = altorank_sanitize_content( $params['content'] );
		$postarr['post_content'] = $content;
	}

	if ( '' !== $params['slug'] ) {
		$postarr['post_name'] = altorank_unique_slug( $params['slug'], $post_id );
	} elseif ( ! $post_id && '' !== $params['title'] ) {
		$postarr['post_name'] = altorank_unique_slug( $params['title'], 0 );
	}

	$status = altorank_resolve_status( $params, $is_new );
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

	if ( '' !== $params['created_at'] ) {
		$ts = strtotime( $params['created_at'] );
		if ( false !== $ts ) {
			$postarr['post_date_gmt'] = gmdate( 'Y-m-d H:i:s', $ts );
			$postarr['post_date']     = get_date_from_gmt( $postarr['post_date_gmt'] );
		}
	}

	/**
	 * Token requests have no WordPress user, and for a request with no user
	 * WordPress runs its own kses pass on save (content_save_pre), which strips
	 * every iframe - including the YouTube embed altorank_sanitize_content()
	 * just allowed. The body has already been through wp_kses_post() plus that
	 * one rebuilt iframe, and the title and excerpt through sanitize_*_field(),
	 * so the second pass is lifted for exactly this call and put back after.
	 */
	kses_remove_filters();
	try {
		$result = $post_id ? wp_update_post( $postarr, true ) : wp_insert_post( $postarr, true );
	} finally {
		kses_init_filters();
	}
	if ( is_wp_error( $result ) ) {
		return new WP_Error( 'altorank_write_failed', $result->get_error_message(), array( 'status' => 500 ) );
	}
	$post_id = (int) $result;

	if ( '' !== $params['external_id'] ) {
		update_post_meta( $post_id, ALTORANK_META_EXTERNAL_ID, $params['external_id'] );
	}

	// Images: the post exists now, so attachments can be parented to it.
	if ( null !== $content ) {
		$imported = altorank_import_images( $post_id, $content );
		if ( $imported !== $content ) {
			wp_update_post(
				array(
					'ID'           => $post_id,
					'post_content' => $imported,
				)
			);
		}
	}

	if ( '' !== $params['featured_image_url'] ) {
		$attachment_id = altorank_sideload_image( $params['featured_image_url'], $post_id );
		if ( ! is_wp_error( $attachment_id ) ) {
			set_post_thumbnail( $post_id, $attachment_id );
		}
	}

	altorank_write_seo_meta( $post_id, $params['title'], $params['meta_description'], $params['focus_keyword'] );

	return altorank_post_response( $post_id, $post_id && ! $is_new ? 200 : 201 );
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
 * wp_kses_post(), keeping YouTube embeds.
 *
 * wp_kses_post() removes every iframe. The one embed an article body
 * legitimately carries is a YouTube video, so those are lifted out first,
 * rebuilt from a fixed attribute list (never the original markup), and put
 * back after sanitising. Any other iframe is dropped.
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

	$html = wp_kses_post( $html );

	return $kept ? str_replace( array_keys( $kept ), array_values( $kept ), $html ) : $html;
}

/**
 * Download every remote <img> into the media library and point the post at
 * the copies. Images already on this site are left alone. A download that
 * fails leaves the original URL in place: a hot-linked picture beats a broken
 * one, and the publish still succeeds.
 */
function altorank_import_images( int $post_id, string $content ): string {
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
			continue;
		}

		$local = wp_get_attachment_url( $attachment_id );
		if ( $local ) {
			$content = str_replace( $src, $local, $content );
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
function altorank_write_seo_meta( int $post_id, string $title, string $description, string $focus ): void {
	foreach ( ALTORANK_SEO_META as $plugin => $keys ) {
		if ( '' !== $title ) {
			update_post_meta( $post_id, $keys['title'], $title );
		}
		if ( '' !== $description ) {
			update_post_meta( $post_id, $keys['description'], $description );
		}
		if ( '' !== $focus ) {
			$value = 'aioseo' === $plugin
				? wp_json_encode( array( 'focus' => array( 'keyphrase' => $focus ) ) )
				: $focus;
			update_post_meta( $post_id, $keys['focus'], $value );
		}
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
