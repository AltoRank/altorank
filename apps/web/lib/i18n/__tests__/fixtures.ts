// Invented Turkish text for the locale-contract tests. The shape is the one a
// real signup's first draft had on 2026-09-22 (a Turkish web/mobile agency):
// dotless ı and İ in the headings, "%20" and "₺1.500,50" in the prose, a
// source named with a postposition ("Gartner'a göre"), a FAQ heading in
// Turkish. None of it is that draft's text.

export const TR_DOMAIN = "acme-agency.example";
export const TR_BUSINESS = "Acme Ajans";
export const TR_KEYWORD = "web tasarımı";

export const TR_LONG =
  "Küçük işletmeler için web tasarımı yalnızca güzel görünen bir vitrin değildir. " +
  "Ziyaretçi sayfaya geldiğinde aradığını birkaç saniye içinde bulamazsa sekmeyi kapatır ve rakibe gider. " +
  "Bu yüzden menü, başlıklar ve iletişim formu aynı soruyu yanıtlamalıdır: burada ne var ve bir sonraki adım ne? " +
  "İyi bir yapı, içerik ekibinin de işini kolaylaştırır, çünkü her yeni sayfa aynı iskeletin üzerine kurulur. " +
  "Ekibimiz her projede önce mevcut sayfaları inceler, sonra sadeleştirir.";

export const TR_SECTION = (heading: string, ...paragraphs: string[]) =>
  `<h2>${heading}</h2>\n${paragraphs.map((p) => (p.startsWith("<") ? p : `<p>${p}</p>`)).join("\n")}\n`;

export const TR_ARTICLE = `<h1>Web tasarımında dönüşüm oranını artırmanın yolları</h1>
<p>Web tasarımı, bir web sitesinin görünümünü ve kullanılabilirliğini planlama sürecidir. İyi bir web tasarımı ziyaretçiyi müşteriye dönüştürür.</p>
${TR_SECTION("Yazılım seçimi neden önemlidir?", TR_LONG)}
${TR_SECTION("Şirketler için ölçüm araçları", TR_LONG, "<ul><li>Başlangıç paketi: 1.500 TL</li><li>Kurumsal paket: 4.500 TL</li><li>E-ticaret paketi: 9.000 TL</li></ul>")}
${TR_SECTION("İçerik stratejisi nasıl kurulur?", "Önce hedef kitleyi tanımlayın. " + TR_LONG, "<ol><li>Hedefi yazın.</li><li>Sayfaları listeleyin.</li><li>Takvimi kurun.</li></ol>")}
${TR_SECTION("Güçlü bir çağrı cümlesi", "Dönüşüm oranı %42'den %61'e yükseldi. " + TR_LONG)}
${TR_SECTION("Sıkça sorulan sorular", "<h3>Bir web sitesi ne kadar sürede hazırlanır?</h3><p>Kapsama göre değişir; tek sayfalık bir tanıtım sitesi genellikle iki ila üç haftada yayına alınır ve içerik hazırsa süre kısalır.</p><h3>Tasarımı sonradan değiştirebilir miyim?</h3><p>Evet. Tema ve bileşenler ayrıldığı için yeni bir renk paleti ya da yerleşim tüm içeriği yeniden yazmadan uygulanabilir.</p>")}
`;

/** Sentences whose figures and sources the fact checker has to read. */
export const TR_CLAIMS = {
  bareSignBefore: "<p>Türkiye'de küçük işletmelerin %20'si hâlâ bir web sitesine sahip değil.</p>",
  bareWordBefore: "<p>Mobil trafiğin payı yüzde 65 seviyesine ulaştı.</p>",
  money: "<p>Kurumsal bir sitenin bakım ücreti yıllık ₺1.500,50 civarındadır.</p>",
  moneyAfter: "<p>Başlangıç paketi 1.500,50 TL olarak fiyatlandırılıyor.</p>",
  attributedApostrophe: "<p>Gartner'a göre dijital pazarlama bütçeleri %12 arttı.</p>",
  attributedNoun: "<p>Dünya Bankası verilerine göre internet kullanımı yüzde 83 oldu.</p>",
  accordingly: "<p>Buna göre dönüşüm oranı %30 arttı.</p>",
  hollow: "<p>Araştırmalar gösteriyor ki kullanıcılar yavaş sitelerden hemen ayrılıyor.</p>",
  multiplier: "<p>Yeni altyapı sayfaları 3 kat daha hızlı yüklüyor.</p>",
  largeCount: "<p>Platform 20 milyon kullanıcıya ulaştı.</p>",
};

/** A brand writing as "we" without ever writing "biz". */
export const TR_VOICE_SAMPLE =
  "Ekibimiz her projeye dinleyerek başlar. Markanızın hikâyesini anlamadan tasarıma geçmiyoruz. " +
  "Müşterilerimizin sitelerini hızlı, erişilebilir ve kolay yönetilebilir hale getiriyoruz. " +
  "İşletmeniz için doğru yapıyı birlikte kuruyoruz. Karmaşık panellerden kaçının; sade bir yapı her zaman kazanır.";
