// ---------------------------------------------------------------------------
// Invented drafts and pages for the found-on-site tests
// ---------------------------------------------------------------------------
//
// Every sentence here was written for these tests. None of it is a customer's
// article, and the domains are reserved example names. The shapes mirror the
// incident the feature exists for (a real signup, 2026-09-22, published one of
// our drafts on a hand-coded site after light edits), not its text.
//
// Per language, three pages against one draft:
//
//   copy          our draft, lightly edited: about 80% of its words kept in
//                 order, every heading translated into another language, a
//                 few sentences reworded, the call to action replaced with
//                 the agency's own, all inside the site's nav and footer.
//   sameOutline   a different article on the same topic: the same title and
//                 the same headings, word for word, with different prose.
//                 The false positive that matters most, since it is what a
//                 competitor writing to the same brief looks like.
//
// plus one unrelated page from the same site.

export interface FixtureDraft {
  title: string;
  intro: string;
  sections: Array<{ heading: string; body: string }>;
  cta: string;
}

/** The draft as the body HTML our editor produces: H2s and paragraphs, no H1. */
export function draftHtml(d: FixtureDraft): string {
  return [
    `<p>${d.intro}</p>`,
    ...d.sections.flatMap((s) => [`<h2>${s.heading}</h2>`, `<p>${s.body}</p>`]),
    `<p>${d.cta}</p>`,
  ].join("\n");
}

/** The same draft as the Tiptap document stored in `articles.content`. */
export function draftDoc(d: FixtureDraft): Record<string, unknown> {
  const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
  const h = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
  return {
    type: "doc",
    content: [p(d.intro), ...d.sections.flatMap((s) => [h(s.heading), p(s.body)]), p(d.cta)],
  };
}

/** A whole page on the customer's site, chrome included. */
export function sitePage(opts: { title: string; h1: string; body: string; lang: string; ogTitle?: string }): string {
  return `<!doctype html>
<html lang="${opts.lang}">
<head>
  <meta charset="utf-8">
  <title>${opts.title} | Acme Ajans</title>
  ${opts.ogTitle ? `<meta property="og:title" content="${opts.ogTitle}">` : ""}
  <style>body{font-family:sans-serif}</style>
  <script>window.dataLayer=[];</script>
</head>
<body>
  <header><nav><a href="/">Ana sayfa</a> <a href="/hizmetler">Hizmetler</a> <a href="/blog">Blog</a> <a href="/iletisim">İletişim</a></nav></header>
  <main>
    <article>
      <h1>${opts.h1}</h1>
      <p class="meta">Acme Ajans · 5 dk okuma</p>
      ${opts.body}
    </article>
    <aside><h3>Son yazılar</h3><ul><li><a href="/blog/web-sitesi-hizi">Web sitesi hızı neden önemli</a></li><li><a href="/blog/mobil-uygulama-bakimi">Mobil uygulama bakımı</a></li></ul></aside>
  </main>
  <footer><p>© 2026 Acme Ajans. Tüm hakları saklıdır.</p><p>Bu site çerez kullanır. <a href="/gizlilik">Gizlilik politikası</a></p></footer>
</body>
</html>`;
}

// ── Turkish ───────────────────────────────────────────────────────────────────

export const TR_DRAFT: FixtureDraft = {
  title: "Kahve Dükkanları İçin Sadakat Programı Nasıl Kurulur",
  intro:
    "Küçük bir kahve dükkanı işletiyorsanız, müdavimleriniz en değerli varlığınızdır. Her sabah aynı saatte gelen ve siparişini söylemeden bilen bir müşteri, reklam bütçesiyle satın alınamayacak bir güven ilişkisi demektir. Bu yazıda, sadakat programını sıfırdan kurmanın adımlarını, maliyetleri ve sık yapılan hataları ele alıyoruz.",
  sections: [
    {
      heading: "Sadakat programı neden işe yarar",
      body: "Yeni bir müşteri kazanmak, mevcut bir müşteriyi elde tutmaktan genellikle beş kat daha pahalıdır. Sadakat programı, müşterinin bir sonraki ziyaretini küçük bir ödülle garanti altına almaya çalışır. Damga kartı gibi basit bir yöntem bile ziyaret sıklığını belirgin biçimde artırabilir, çünkü müşteri kartı doldurmaya yaklaştıkça başka bir dükkana gitme isteği azalır.",
    },
    {
      heading: "Damga kartı mı dijital uygulama mı",
      body: "Kağıt damga kartı ucuzdur ve kurulumu bir öğleden sonra sürer. Ancak kartlar kaybolur, kopyalanabilir ve size hiçbir veri bırakmaz. Dijital bir uygulama ise hangi ürünlerin birlikte satıldığını, hangi saatlerin sakin geçtiğini ve hangi müşterilerin uzun süredir gelmediğini gösterir. Tek şubeli bir dükkan için tablet üzerinde çalışan basit bir sistem çoğu zaman yeterlidir.",
    },
    {
      heading: "Ödül yapısını belirlemek",
      body: "Ödül, müşterinin kolayca anlayabileceği kadar sade olmalıdır. En yaygın yapı, dokuz kahveden sonra onuncunun ücretsiz olmasıdır. Bazı dükkanlar ise puan sistemi kullanır ve puanları pasta, çekirdek kahve ya da atölye katılımı ile değiştirir. Önemli olan, ödülün maliyetini kar marjınıza göre hesaplamak ve programı en az üç ay değiştirmeden denemektir.",
    },
    {
      heading: "Personeli programa dahil etmek",
      body: "En iyi tasarlanmış program bile kasadaki çalışan onu anlatmazsa başarısız olur. Her siparişte kısa bir cümleyle programı hatırlatmak, ilk hafta içinde katılımı ikiye katlayabilir. Personele haftalık katılım hedefi koymak ve küçük bir prim vermek, programın rafta unutulmasını engeller.",
    },
    {
      heading: "Sonuçları ölçmek",
      body: "Programın işe yarayıp yaramadığını anlamak için üç sayıya bakın: aylık tekrar eden müşteri oranı, ortalama sepet tutarı ve kullanılan ödül sayısı. Bu sayıları programdan önceki üç ayla karşılaştırın. Tekrar eden müşteri oranı artmıyorsa, sorun büyük olasılıkla ödülün çekici olmaması ya da programın yeterince duyurulmamasıdır.",
    },
    {
      heading: "Sık yapılan hatalar",
      body: "Birçok dükkan ödülü çok uzağa koyar; yirmi kahveden sonra verilen bir ödül müşteriyi motive etmez. Bir diğer hata, programı sık sık değiştirmektir; müşteri kuralları öğrenemeden yeni bir kampanya başlar. Son olarak, toplanan verinin hiç okunmaması en pahalı hatadır, çünkü program asıl değerini bu veriden üretir.",
    },
  ],
  cta: "Sadakat programınızı kurmak için yardıma mı ihtiyacınız var? Ekibimizle ücretsiz bir görüşme planlayın ve dükkanınıza uygun sistemi birlikte seçelim.",
};

/**
 * The copy: headings in English, the title reworded, the intro's last sentence
 * and a handful of others rewritten, one sentence dropped, and the agency's
 * own call to action where ours was.
 */
export const TR_COPY_BODY = `
<p>Küçük bir kahve dükkanınız varsa, müdavimleriniz en değerli varlığınızdır. Her sabah aynı saatte gelen ve siparişini söylemeden bilen bir müşteri, reklam bütçesiyle satın alınamayacak bir güven ilişkisi demektir. Bu rehberde adımları, maliyetleri ve hataları anlatıyoruz.</p>
<h2>Why a loyalty program works</h2>
<p>Yeni bir müşteri kazanmak, mevcut bir müşteriyi elde tutmaktan genellikle beş kat daha pahalıdır. Sadakat programı, müşterinin bir sonraki ziyaretini küçük bir ödülle garanti altına almaya çalışır. Damga kartı gibi basit bir yöntem bile ziyaret sıklığını artırabilir, çünkü müşteri kartı doldurmaya yaklaştıkça başka bir dükkana gitme isteği azalır.</p>
<h2>Stamp card or digital app</h2>
<p>Kağıt damga kartı ucuzdur ve kurulumu bir öğleden sonra sürer. Ancak kartlar kaybolur, kopyalanabilir ve size hiçbir veri bırakmaz. Dijital bir uygulama ise hangi ürünlerin birlikte satıldığını, hangi saatlerin sakin geçtiğini ve hangi müşterilerin uzun süredir gelmediğini gösterir. Tek şubeniz varsa tablette çalışan basit bir sistem yeterli olur.</p>
<h2>Designing the reward</h2>
<p>Ödül, müşterinin kolayca anlayabileceği kadar sade olmalıdır. En yaygın yapı, dokuz kahveden sonra onuncunun ücretsiz olmasıdır. Bazı dükkanlar ise puan sistemi kullanır ve puanları pasta, çekirdek kahve ya da atölye katılımı ile değiştirir. Önemli olan, ödülün maliyetini kar marjınıza göre hesaplamak ve programı üç ay boyunca değiştirmeden denemektir.</p>
<h2>Getting the staff on board</h2>
<p>En iyi tasarlanmış program bile kasadaki çalışan onu anlatmazsa başarısız olur. Her siparişte kısa bir cümleyle programı hatırlatmak, ilk hafta içinde katılımı ikiye katlayabilir. Ekibe haftalık bir hedef ve küçük bir prim vermek işe yarar.</p>
<h2>Measuring results</h2>
<p>Programın işe yarayıp yaramadığını anlamak için üç sayıya bakın: aylık tekrar eden müşteri oranı, ortalama sepet tutarı ve kullanılan ödül sayısı. Bu sayıları programdan önceki üç ayla karşılaştırın. Tekrar eden müşteri oranı artmıyorsa, sorun büyük olasılıkla ödülün çekici olmaması ya da programın yeterince duyurulmamasıdır.</p>
<h2>Common mistakes</h2>
<p>Birçok dükkan ödülü çok uzağa koyar; yirmi kahveden sonra verilen bir ödül müşteriyi motive etmez. Bir diğer hata, programı sık sık değiştirmektir. Son olarak, toplanan verinin hiç okunmaması en pahalı hatadır, çünkü program asıl değerini bu veriden üretir.</p>
<p>Acme Ajans olarak kafeler ve restoranlar için sadakat uygulamaları tasarlıyor ve geliştiriyoruz. Projeniz için teklif almak isterseniz iletişim sayfamızdan bize yazın.</p>
`;

export const TR_COPY_PAGE = sitePage({
  lang: "tr",
  title: "Kahve Dükkanınız İçin Sadakat Programı Kurma Rehberi",
  h1: "Kahve Dükkanınız İçin Sadakat Programı Kurma Rehberi",
  body: TR_COPY_BODY,
});

/** Same title, same six headings, different prose on the same points. */
export const TR_SAME_OUTLINE_PAGE = sitePage({
  lang: "tr",
  title: "Kahve Dükkanları İçin Sadakat Programı Nasıl Kurulur",
  h1: "Kahve Dükkanları İçin Sadakat Programı Nasıl Kurulur",
  body: `
<p>Mahalle kahvecileri için sadakat, zincir markalarla rekabet etmenin en ucuz yoludur. Müşteri sizi tanıdığında fiyat farkını daha az önemser ve yolunu değiştirip size uğrar. Aşağıda, bir programı hangi sırayla kuracağınızı ve nelere dikkat edeceğinizi özetledik.</p>
<h2>Sadakat programı neden işe yarar</h2>
<p>İnsanlar yarım kalmış bir şeyi tamamlamayı sever. Kartında yedi damgası olan bir müşteri, yolunun üstündeki başka bir kafeyi geçip sizin kapınızı açar. Üstelik program, düzenli gelenlere teşekkür etmenin somut bir yolunu sunar ve bu da ağızdan ağıza tavsiyeyi besler.</p>
<h2>Damga kartı mı dijital uygulama mı</h2>
<p>Karton kartın tek avantajı hızıdır; matbaadan yüz tane bastırıp ertesi gün başlayabilirsiniz. Uygulama biraz daha zahmetlidir ama müşteri telefonunu nadiren unutur. Ayrıca kimlerin azaldığını görüp onlara özel bir teklif göndermek, kağıtla mümkün değildir.</p>
<h2>Ödül yapısını belirlemek</h2>
<p>Hedef ulaşılabilir görünmelidir. Sekiz ya da on alışverişte bir hediye içecek, çoğu işletme için dengeli bir başlangıçtır. Yüksek marjlı ürünleri ödül yapmak, kampanyanın maliyetini düşürür ve müşteriye yeni lezzetler denetir.</p>
<h2>Personeli programa dahil etmek</h2>
<p>Barista programa inanmıyorsa müşteri de inanmaz. Sabah toplantısında o günün kayıt sayısını paylaşmak ve en çok üye kazandıran kişiyi ödüllendirmek, ekibin konuyu sahiplenmesini sağlar.</p>
<h2>Sonuçları ölçmek</h2>
<p>Bir tablo açın ve her hafta yeni üye sayısını, kullanılan hediyeleri ve toplam ciroyu not edin. Üç ayın sonunda eğilimi göreceksiniz. Rakamlar yerinde sayıyorsa ödülü ya da duyuru biçimini değiştirmeyi deneyin.</p>
<h2>Sık yapılan hatalar</h2>
<p>Karmaşık kurallar koymak, müşteriyi ilk günden kaçırır. Ödülü yalnızca pahalı ürünlerde geçerli kılmak da güveni zedeler. Bir de kampanyayı sessizce bitirmek var; bunu yapmak, en sadık müşterilerinizi kırmanın en hızlı yoludur.</p>
<p>Daha fazla fikir için bültenimize abone olun.</p>
`,
});

// ── English ───────────────────────────────────────────────────────────────────

export const EN_DRAFT: FixtureDraft = {
  title: "How to Choose a Standing Desk for a Small Home Office",
  intro:
    "A standing desk is one of the few office purchases you will touch every working hour, so small differences in how it is built add up quickly. In a small home office the constraints are sharper: less floor space, thinner walls, and often a desk that has to share a room with a bed or a bookshelf. This guide walks through the decisions that matter, in the order you should make them.",
  sections: [
    {
      heading: "Why height range matters",
      body: "The desk has to reach both your sitting and your standing elbow height, and many cheaper frames fall short at one end. Measure yourself in the shoes you actually wear at home, then add a few centimetres of margin for a keyboard tray or a thick mat. A frame that tops out too low forces you to hunch, which defeats the purpose of standing at all.",
    },
    {
      heading: "Single motor or dual motor",
      body: "A single motor drives both legs through a shaft, which is cheaper and usually fine for a light setup. Dual motors lift each leg on its own, move more quietly, and cope better with two monitors and a heavy desktop computer. If you share a wall with a sleeping child or a neighbour, the noise figure on the specification sheet deserves a second look.",
    },
    {
      heading: "Desktop size and depth",
      body: "Width gets all the attention, but depth decides whether the desk feels cramped. Below sixty centimetres of depth, a monitor ends up too close to your eyes unless you mount it on an arm. Measure the room with the chair pulled out, not just the wall the desk will stand against.",
    },
    {
      heading: "Stability at standing height",
      body: "Every standing desk wobbles a little at full height; the question is how much. Look for a frame with a crossbar or wide feet, and read reviews that mention typing at standing height rather than just raising and lowering the desk. A monitor that shakes each time you press a key will send you back to sitting within a week.",
    },
    {
      heading: "Cable management",
      body: "A desk that moves needs cables that can move with it. Leave enough slack for the full travel of the frame, bundle the cables into a single spine, and keep the power strip on the desk rather than on the floor. It takes twenty minutes on the first day and saves a tangle of unplugged chargers later.",
    },
    {
      heading: "Common mistakes",
      body: "The most common mistake is buying for the room you wish you had instead of the one you work in. The second is ignoring the weight limit and then adding a second monitor. The third is standing all day in the first week; alternate every half hour until your legs get used to it.",
    },
  ],
  cta: "Want help planning your home office? Book a free call with our team and we will send you a shortlist of desks that fit your room and your budget.",
};

export const EN_COPY_PAGE = sitePage({
  lang: "en",
  title: "Choosing a Standing Desk for a Small Home Office",
  h1: "Choosing a Standing Desk for a Small Home Office",
  ogTitle: "Choosing a Standing Desk for a Small Home Office",
  body: `
<p>A standing desk is one of the few office purchases you will touch every working hour, so small differences in how it is built add up quickly. In a small home office the constraints are sharper: less floor space, thin walls, and often a desk that has to share a room with a bed. Here is what matters, in the order you should decide it.</p>
<h2>Warum der Höhenbereich zählt</h2>
<p>The desk has to reach both your sitting and your standing elbow height, and many cheaper frames fall short at one end. Measure yourself in the shoes you actually wear at home, then add a few centimetres of margin for a keyboard tray or a thick mat. A frame that tops out too low makes you hunch.</p>
<h2>Ein Motor oder zwei Motoren</h2>
<p>A single motor drives both legs through a shaft, which is cheaper and usually fine for a light setup. Dual motors lift each leg on its own, move more quietly, and cope better with two monitors and a heavy desktop computer. If you share a wall with a sleeping child or a neighbour, check the noise figure on the specification sheet.</p>
<h2>Größe und Tiefe der Tischplatte</h2>
<p>Width gets all the attention, but depth decides whether the desk feels cramped. Below sixty centimetres of depth, a monitor ends up too close to your eyes unless you mount it on an arm. Measure the room with the chair pulled out, not just the wall the desk will stand against.</p>
<h2>Stabilität im Stehen</h2>
<p>Every standing desk wobbles a little at full height; the question is how much. Look for a frame with a crossbar or wide feet, and read reviews that mention typing at standing height. A monitor that shakes each time you press a key will send you back to sitting within a week.</p>
<h2>Kabelmanagement</h2>
<p>A desk that moves needs cables that can move with it. Leave enough slack for the full travel of the frame, bundle the cables into a single spine, and keep the power strip on the desk rather than on the floor.</p>
<h2>Häufige Fehler</h2>
<p>The most common mistake is buying for the room you wish you had instead of the one you work in. The second is ignoring the weight limit and then adding a second monitor. The third is standing all day in the first week; alternate every half hour until your legs get used to it.</p>
<p>Acme Agency builds websites and apps for furniture retailers. Get in touch through our contact page for a quote.</p>
`,
});

export const EN_SAME_OUTLINE_PAGE = sitePage({
  lang: "en",
  title: "How to Choose a Standing Desk for a Small Home Office",
  h1: "How to Choose a Standing Desk for a Small Home Office",
  body: `
<p>Working from a spare bedroom changes what a good desk looks like. You cannot hide a bulky frame in a corner, and every extra centimetre of desktop comes out of the space you walk through. Here are the points we check before recommending a model to anyone with a compact room.</p>
<h2>Why height range matters</h2>
<p>People of very different heights often share one desk at home, so the lowest and highest settings both count. Tall users need a generous maximum, while shorter users need a low minimum to sit with relaxed shoulders. Check both numbers against your own measurements before you look at anything else.</p>
<h2>Single motor or dual motor</h2>
<p>One motor is enough for a laptop and a lamp. Two motors earn their price once you load the frame with screens, speakers and a tower, because they lift evenly and strain less over the years. They also tend to hum rather than grind, which matters late in the evening.</p>
<h2>Desktop size and depth</h2>
<p>A narrow room tempts you toward a shallow top, but your eyes need distance from the screen. Think about what else lives on the surface, such as notebooks, a microphone or a drawing tablet, and pick a size that leaves elbow room after all of it is in place.</p>
<h2>Stability at standing height</h2>
<p>Shake is the complaint we hear most often. Heavier steel, a lower centre of gravity and feet that spread wide all help. If you can, try a floor model in a shop and type on it at your standing height for a minute before buying online.</p>
<h2>Cable management</h2>
<p>A tray under the desktop hides the adapters, and a flexible sleeve carries the cords down one leg. Plan the route before you mount anything, so that nothing snags when the frame travels up and down.</p>
<h2>Common mistakes</h2>
<p>Buyers often overlook the warranty on the motors, choose a glossy top that shows every fingerprint, or forget that a desk against a radiator will warp. A few minutes of reading the small print avoids all three.</p>
<p>Subscribe to our newsletter for more home office guides.</p>
`,
});

/** A page on the same site about something else entirely. */
export const UNRELATED_PAGE = sitePage({
  lang: "en",
  title: "Our services",
  h1: "Web and mobile development",
  body: `
<p>We design and build websites, online shops and mobile apps for small businesses. Every project starts with a short workshop where we map your goals, your customers and the pages that matter most. From there we sketch, prototype and test with real users before a single line of production code is written.</p>
<h2>What we build</h2>
<p>Marketing sites that load in under a second, shops that connect to your stock system, and apps for iOS and Android that your team can update without calling us. We host what we build and keep it patched.</p>
<h2>How we work</h2>
<p>Fixed prices for fixed scopes, weekly demos, and a single contact person from the first call to launch day. After launch we offer a maintenance plan with a monthly report on speed, uptime and search visibility.</p>
`,
});
