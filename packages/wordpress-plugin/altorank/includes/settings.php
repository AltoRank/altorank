<?php
/**
 * Settings -> AltoRank.
 *
 * Four options: the integration token, post-as-draft, default author, default
 * category. The token is the only credential the plugin has; it is stored as
 * an option and compared with hash_equals() in includes/api.php.
 *
 * @package AltoRank
 */

defined( 'ABSPATH' ) || exit;

function altorank_register_settings(): void {
	register_setting(
		'altorank',
		ALTORANK_OPTION_TOKEN,
		array(
			'type'              => 'string',
			'sanitize_callback' => 'altorank_sanitize_token',
			'default'           => '',
		)
	);
	register_setting(
		'altorank',
		ALTORANK_OPTION_POST_AS_DRAFT,
		array(
			'type'              => 'string',
			'sanitize_callback' => static fn( $value ): string => '1' === (string) $value ? '1' : '0',
			'default'           => '1',
		)
	);
	register_setting(
		'altorank',
		ALTORANK_OPTION_DEFAULT_AUTHOR,
		array(
			'type'              => 'integer',
			'sanitize_callback' => static fn( $value ): int => get_user_by( 'id', absint( $value ) ) ? absint( $value ) : 0,
			'default'           => 0,
		)
	);
	register_setting(
		'altorank',
		ALTORANK_OPTION_DEFAULT_CATEGORY,
		array(
			'type'              => 'integer',
			'sanitize_callback' => static fn( $value ): int => term_exists( absint( $value ), 'category' ) ? absint( $value ) : 0,
			'default'           => 0,
		)
	);
}
add_action( 'admin_init', 'altorank_register_settings' );

/**
 * The dashboard generates 32 random bytes and shows them as 64 hex characters.
 * Anything else was mistyped and would never match, so it is refused with a
 * message rather than saved and left to fail silently on the first publish.
 * An empty value clears the token and disables the integration.
 */
function altorank_sanitize_token( $value ): string {
	$value = trim( (string) $value );
	if ( '' === $value ) {
		return '';
	}
	if ( ! preg_match( '/^[0-9a-f]{64}$/i', $value ) ) {
		add_settings_error(
			ALTORANK_OPTION_TOKEN,
			'altorank_bad_token',
			__( 'The integration token should be 64 hexadecimal characters, exactly as shown in your AltoRank dashboard. The previous value was kept.', 'altorank' )
		);
		return (string) get_option( ALTORANK_OPTION_TOKEN, '' );
	}
	return strtolower( $value );
}

function altorank_add_settings_page(): void {
	add_options_page(
		__( 'AltoRank', 'altorank' ),
		__( 'AltoRank', 'altorank' ),
		'manage_options',
		'altorank',
		'altorank_render_settings_page'
	);
}
add_action( 'admin_menu', 'altorank_add_settings_page' );

/**
 * The "Test connection" button calls this site's own /test-integration route
 * with the saved token, from the browser, so what is tested is exactly what
 * the dashboard will do. Only loaded on our settings page.
 */
function altorank_enqueue_settings_assets( string $hook ): void {
	if ( 'settings_page_altorank' !== $hook ) {
		return;
	}

	wp_register_script( 'altorank-settings', false, array(), ALTORANK_VERSION, true );
	wp_enqueue_script( 'altorank-settings' );

	$config = array(
		'endpoint' => rest_url( ALTORANK_REST_NAMESPACE . '/test-integration' ),
		'messages' => array(
			'testing'  => __( 'Testing...', 'altorank' ),
			'ok'       => __( 'Connected. The token matches and this site can receive posts.', 'altorank' ),
			'noToken'  => __( 'Save a token first, then test.', 'altorank' ),
			'rejected' => __( 'Rejected: the saved token did not match. Save the settings and try again.', 'altorank' ),
			'failed'   => __( 'Failed: ', 'altorank' ),
		),
	);

	$script = 'window.altorankSettings = ' . wp_json_encode( $config ) . ';'
		. '(function(){'
		. 'var btn=document.getElementById("altorank-test");if(!btn)return;'
		. 'var out=document.getElementById("altorank-test-result");'
		. 'var field=document.getElementById("altorank-token");'
		. 'var cfg=window.altorankSettings;'
		. 'btn.addEventListener("click",function(){'
		. 'var token=(field&&field.value||"").trim();'
		. 'if(!token){out.textContent=cfg.messages.noToken;return;}'
		. 'out.textContent=cfg.messages.testing;btn.disabled=true;'
		. 'fetch(cfg.endpoint,{method:"POST",headers:{"Content-Type":"application/json","X-AltoRank-Token":token},body:"{}"})'
		. '.then(function(r){if(r.ok){out.textContent=cfg.messages.ok;return;}'
		. 'if(r.status===403){out.textContent=cfg.messages.rejected;return;}'
		. 'return r.text().then(function(t){out.textContent=cfg.messages.failed+r.status+" "+t.slice(0,200);});})'
		. '.catch(function(e){out.textContent=cfg.messages.failed+e.message;})'
		. '.finally(function(){btn.disabled=false;});'
		. '});'
		. '})();';

	wp_add_inline_script( 'altorank-settings', $script );
}
add_action( 'admin_enqueue_scripts', 'altorank_enqueue_settings_assets' );

function altorank_render_settings_page(): void {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}

	$token         = (string) get_option( ALTORANK_OPTION_TOKEN, '' );
	$post_as_draft = '1' === (string) get_option( ALTORANK_OPTION_POST_AS_DRAFT, '1' );
	$author        = absint( get_option( ALTORANK_OPTION_DEFAULT_AUTHOR, 0 ) );
	$category      = absint( get_option( ALTORANK_OPTION_DEFAULT_CATEGORY, 0 ) );
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'AltoRank', 'altorank' ); ?></h1>
		<p>
			<?php esc_html_e( 'Articles approved in your AltoRank dashboard arrive here as posts. Nothing is added to your public pages: no scripts, no links, no credits.', 'altorank' ); ?>
		</p>

		<?php settings_errors( 'altorank' ); ?>

		<form method="post" action="options.php">
			<?php settings_fields( 'altorank' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row">
						<label for="altorank-token"><?php esc_html_e( 'Integration token', 'altorank' ); ?></label>
					</th>
					<td>
						<input
							type="text"
							id="altorank-token"
							name="<?php echo esc_attr( ALTORANK_OPTION_TOKEN ); ?>"
							value="<?php echo esc_attr( $token ); ?>"
							class="regular-text code"
							autocomplete="off"
							spellcheck="false"
							pattern="[0-9a-fA-F]{64}"
						/>
						<button type="button" class="button" id="altorank-test"><?php esc_html_e( 'Test connection', 'altorank' ); ?></button>
						<span id="altorank-test-result" class="description" style="margin-left:8px"></span>
						<p class="description">
							<?php esc_html_e( 'Copy this from Integrations -> WordPress plugin in your AltoRank dashboard. One token per site.', 'altorank' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Post as draft', 'altorank' ); ?></th>
					<td>
						<label>
							<input
								type="checkbox"
								name="<?php echo esc_attr( ALTORANK_OPTION_POST_AS_DRAFT ); ?>"
								value="1"
								<?php checked( $post_as_draft ); ?>
							/>
							<?php esc_html_e( 'Save incoming articles as drafts for an editor here to publish', 'altorank' ); ?>
						</label>
						<p class="description">
							<?php esc_html_e( 'On by default. Turn off to publish articles the moment they are approved in AltoRank.', 'altorank' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row">
						<label for="altorank-author"><?php esc_html_e( 'Default author', 'altorank' ); ?></label>
					</th>
					<td>
						<?php
						wp_dropdown_users(
							array(
								'name'              => ALTORANK_OPTION_DEFAULT_AUTHOR,
								'id'                => 'altorank-author',
								'selected'          => $author,
								'show_option_none'  => __( 'First administrator', 'altorank' ),
								'option_none_value' => 0,
								'capability'        => array( 'edit_posts' ),
							)
						);
						?>
					</td>
				</tr>
				<tr>
					<th scope="row">
						<label for="altorank-category"><?php esc_html_e( 'Default category', 'altorank' ); ?></label>
					</th>
					<td>
						<?php
						wp_dropdown_categories(
							array(
								'name'              => ALTORANK_OPTION_DEFAULT_CATEGORY,
								'id'                => 'altorank-category',
								'selected'          => $category,
								'show_option_none'  => __( 'Site default', 'altorank' ),
								'option_none_value' => 0,
								'hide_empty'        => false,
								'hierarchical'      => true,
							)
						);
						?>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}
