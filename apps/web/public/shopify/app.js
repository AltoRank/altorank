// The AltoRank app inside the Shopify admin.
//
// Served as-is (no build step) by app/shopify/route.ts, which loads App
// Bridge and Polaris web components first. Every call to our API carries a
// fresh App Bridge ID token; the server verifies it and decides which store,
// account and site the request may touch (lib/shopify/request-auth.ts).
//
// Rendering builds Polaris markup as strings. Every value that came from the
// server is passed through esc() first; an article body is never put in this
// document at all, only into a sandboxed iframe with no scripts.

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATUS_TONE = {
  review: "attention",
  approved: "info",
  scheduled: "info",
  live: "success",
  error: "critical",
  draft: "neutral",
};

/** @param {{status: string, statusLabel: string}} a */
export function statusBadge(a) {
  const tone = STATUS_TONE[a.status] ?? "neutral";
  return `<s-badge tone="${tone}">${esc(a.statusLabel)}</s-badge>`;
}

/** The first look's banner, or nothing once it is done. */
export function renderFirstLook(firstLook) {
  if (!firstLook || firstLook.state === "done" || firstLook.state === "none") return "";
  if (firstLook.state === "failed") {
    return `<s-banner tone="critical" heading="The first look stopped">
      <s-paragraph>${esc(firstLook.message)}</s-paragraph>
      <s-button slot="secondary-actions" data-action="retry-first-look">Try again</s-button>
    </s-banner>`;
  }
  return `<s-banner tone="info" heading="Reading your store">
    <s-stack gap="small-200">
      <s-paragraph>${esc(firstLook.message)}</s-paragraph>
      ${typeof firstLook.progress === "number" ? `<s-progress value="${Math.round(firstLook.progress)}" max="100"></s-progress>` : ""}
    </s-stack>
  </s-banner>`;
}

export function renderQueue(queue) {
  if (!queue.length) {
    return `<s-section heading="Drafts to review">
      <s-paragraph>Nothing waiting. New drafts appear here when they are written, and nothing reaches your store until you approve it.</s-paragraph>
    </s-section>`;
  }
  const rows = queue
    .map(
      (a) => `<s-table-row>
        <s-table-cell><s-link data-action="open-article" data-id="${esc(a.id)}">${esc(a.title)}</s-link></s-table-cell>
        <s-table-cell>${esc(a.keyword)}</s-table-cell>
        <s-table-cell>${statusBadge(a)}</s-table-cell>
      </s-table-row>`,
    )
    .join("");
  return `<s-section heading="Drafts to review" padding="none">
    <s-table>
      <s-table-header-row>
        <s-table-header list-slot="primary">Article</s-table-header>
        <s-table-header>Keyword</s-table-header>
        <s-table-header list-slot="inline">Status</s-table-header>
      </s-table-header-row>
      <s-table-body>${rows}</s-table-body>
    </s-table>
  </s-section>`;
}

export function renderConnection(connection) {
  if (connection.needsReconnect) {
    return `<s-section heading="Publishing">
      <s-banner tone="warning"><s-paragraph>Reload the app to reconnect your store.</s-paragraph></s-banner>
    </s-section>`;
  }
  const blogOptions = connection.blogs
    .map((b) => `<s-option value="${esc(b.id)}" ${b.id === connection.blogId ? "selected" : ""}>${esc(b.title)}</s-option>`)
    .join("");
  const mode = connection.publishMode;
  return `<s-section heading="Publishing">
    <s-stack gap="base">
      <s-select id="blog" label="Blog" details="Approved articles are added to this blog.">${blogOptions}</s-select>
      <s-select id="publish-mode" label="When an article is approved"
        details="Hidden articles wait in Shopify until you set them visible.">
        <s-option value="draft" ${mode === "draft" ? "selected" : ""}>Add it to Shopify hidden</s-option>
        <s-option value="publish" ${mode === "publish" ? "selected" : ""}>Publish it on the storefront</s-option>
      </s-select>
      <s-button data-action="save-connection">Save</s-button>
    </s-stack>
  </s-section>`;
}

export function renderAccount(state) {
  const plan = state.plan;
  const signIn = state.account.ownerReachable
    ? `<s-button data-action="sign-in-link">Email me a sign-in link</s-button>
       <s-paragraph tone="subdued">Keywords, Search Console and every setting are in the full AltoRank dashboard. The link goes to ${esc(state.account.ownerEmail)}.</s-paragraph>`
    : `<s-paragraph tone="subdued">Keywords, Search Console and every setting are in the full AltoRank dashboard at app.altorank.co.</s-paragraph>`;
  // Shopify hosts the plan picker (App Pricing); it opens over the admin, outside this frame.
  const choose = plan.selectUrl
    ? `<s-button ${plan.needsPlan ? 'variant="primary"' : ""} data-action="choose-plan" data-url="${esc(plan.selectUrl)}">${plan.needsPlan ? "Choose a plan" : "Change plan"}</s-button>`
    : "";
  return `<s-section heading="Your plan">
    <s-stack gap="base">
      <s-paragraph><s-text type="strong">${esc(plan.label)}</s-text> · ${esc(plan.line)}</s-paragraph>
      ${choose}
      ${signIn}
      <s-link data-action="link-account">Use an AltoRank account I already have</s-link>
    </s-stack>
  </s-section>`;
}

export function renderHome(state) {
  return `<s-page heading="AltoRank">
    <s-paragraph slot="subtitle">${esc(state.site.domain)}</s-paragraph>
    ${renderFirstLook(state.firstLook)}
    ${renderQueue(state.queue)}
    ${renderConnection(state.connection)}
    ${renderAccount(state)}
  </s-page>`;
}

export function renderArticle(article) {
  const blocked = article.canApprove
    ? ""
    : `<s-banner tone="warning"><s-paragraph>${esc(article.approveBlockedReason)}</s-paragraph></s-banner>`;
  // Editing happens in the full dashboard; here a draft is read and approved.
  const actions =
    article.status === "review"
      ? `<s-button slot="primary-action" variant="primary" data-action="approve" data-id="${esc(article.id)}" ${article.canApprove ? "" : "disabled"}>Approve</s-button>`
      : "";
  return `<s-page heading="${esc(article.title)}">
    <s-link slot="breadcrumb-actions" data-action="home">AltoRank</s-link>
    ${actions}
    <s-stack gap="base">
      ${blocked}
      <s-section>
        <s-stack gap="small-200">
          <s-paragraph>${statusBadge(article)} · ${esc(article.keyword)}</s-paragraph>
          <iframe title="Article preview" sandbox="" id="article-body"
            style="width:100%;min-height:70vh;border:0;background:#fff"></iframe>
        </s-stack>
      </s-section>
    </s-stack>
  </s-page>`;
}

// ---------------------------------------------------------------------------
// Runtime (browser only)
// ---------------------------------------------------------------------------

async function api(path, init = {}) {
  const send = async () => {
    const token = await window.shopify.idToken();
    return fetch(path, {
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${token}` },
    });
  };
  let res = await send();
  if (res.status === 401 && res.headers.get("X-Shopify-Retry-Invalid-Session-Request")) res = await send();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function toast(message, isError = false) {
  window.shopify?.toast?.show(message, { isError });
}

function mount(html) {
  document.getElementById("app").innerHTML = html;
}

let pollTimer = null;

async function showHome() {
  clearTimeout(pollTimer);
  const state = await api("/api/shopify/state");
  mount(renderHome(state));
  if (state.firstLook?.state === "running") pollTimer = setTimeout(() => showHome().catch(fail), 5000);
}

async function showArticle(id) {
  clearTimeout(pollTimer);
  const article = await api(`/api/shopify/articles/${encodeURIComponent(id)}`);
  mount(renderArticle(article));
  // srcdoc into a sandbox with no permissions: no scripts, no same-origin.
  document.getElementById("article-body").srcdoc = article.html;
}

function fail(err) {
  mount(`<s-page heading="AltoRank"><s-banner tone="critical" heading="Something went wrong">
    <s-paragraph>${esc(err?.message || err)}</s-paragraph>
    <s-button slot="secondary-actions" data-action="home">Reload</s-button>
  </s-banner></s-page>`);
}

async function onAction(target) {
  const action = target.dataset.action;
  const id = target.dataset.id;
  switch (action) {
    case "home":
      return showHome();
    case "open-article":
      return showArticle(id);
    case "approve": {
      target.loading = true;
      await api(`/api/shopify/articles/${encodeURIComponent(id)}/approve`, { method: "POST" });
      toast("Approved");
      return showHome();
    }
    case "save-connection": {
      const blogId = document.getElementById("blog")?.value;
      const publishMode = document.getElementById("publish-mode")?.value;
      await api("/api/shopify/connection", { method: "PUT", body: JSON.stringify({ blogId, publishMode }) });
      toast("Saved");
      return;
    }
    case "sign-in-link": {
      const { sentTo } = await api("/api/shopify/sign-in-link", { method: "POST" });
      toast(`Sign-in link sent to ${sentTo}`);
      return;
    }
    case "choose-plan":
      // _top: the plan page is part of the Shopify admin, not of this app.
      window.open(target.dataset.url, "_top");
      return;
    case "link-account": {
      // A signed, one-time link; signing in and choosing the site happen in a
      // top-level tab, where AltoRank's session cookie works.
      const { url } = await api("/api/shopify/link-token", { method: "POST" });
      window.open(url, "_blank", "noopener");
      return;
    }
    case "retry-first-look":
      await api("/api/shopify/first-look", { method: "POST" });
      return showHome();
  }
}

async function boot() {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!target) return;
    event.preventDefault();
    onAction(target).catch((err) => toast(err.message || String(err), true));
  });
  await api("/api/shopify/session", { method: "POST" });
  await showHome();
}

if (typeof window !== "undefined" && window.shopify) boot().catch(fail);
