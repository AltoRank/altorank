/** An article that is not live on a blog that is: the 404 inside the blog's own shell. */
export default function HostedArticleNotFound() {
  return (
    <div className="hb-intro">
      <p className="hb-eyebrow">404</p>
      <h1 className="hb-title">This article is not here</h1>
      <p className="hb-lede">It may have moved or been taken down.</p>
    </div>
  );
}
