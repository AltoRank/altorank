import React from "react";
import { Document, Page, Text, View, StyleSheet, Image } from "@react-pdf/renderer";
import type { ReportData } from "./metrics";

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: "Helvetica", fontSize: 10, color: "#1a1a1a" },
  header: { flexDirection: "row", justifyContent: "space-between", marginBottom: 30 },
  logo: { width: 100, height: 40 },
  title: { fontSize: 22, fontWeight: "bold", marginBottom: 4 },
  subtitle: { fontSize: 11, color: "#666" },
  sectionTitle: { fontSize: 14, fontWeight: "bold", marginTop: 20, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: "#e0e0e0", paddingBottom: 4 },
  statsRow: { flexDirection: "row", gap: 16, marginBottom: 16 },
  statBox: { flex: 1, backgroundColor: "#f8f9fa", borderRadius: 6, padding: 12 },
  statValue: { fontSize: 20, fontWeight: "bold" },
  statLabel: { fontSize: 9, color: "#666", marginTop: 2 },
  table: { marginTop: 8 },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#eee", paddingVertical: 6 },
  tableHeader: { flexDirection: "row", borderBottomWidth: 2, borderBottomColor: "#333", paddingBottom: 4, marginBottom: 2 },
  tableCell: { flex: 1, fontSize: 9 },
  tableCellSmall: { width: 60, fontSize: 9, textAlign: "right" },
  footer: { position: "absolute", bottom: 30, left: 40, right: 40, textAlign: "center", fontSize: 8, color: "#999" },
  note: { fontSize: 8, color: "#666", marginTop: -8, marginBottom: 12 },
});

interface ReportPDFProps {
  data: ReportData;
}

export function ReportPDF({ data }: ReportPDFProps) {
  const accentColor = data.agency.accent_color ?? "#2563eb";

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            {data.agency.logo_url && (
              <Image src={data.agency.logo_url} style={styles.logo} />
            )}
            <Text style={[styles.title, { color: accentColor }]}>
              SEO Performance Report
            </Text>
            <Text style={styles.subtitle}>
              {data.workspace.name} — {data.workspace.domain}
            </Text>
            <Text style={styles.subtitle}>{data.period}</Text>
          </View>
          <View>
            <Text style={{ fontSize: 11, fontWeight: "bold" }}>{data.agency.name}</Text>
          </View>
        </View>

        {/* Key Metrics */}
        <Text style={styles.sectionTitle}>Key Metrics</Text>
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: accentColor }]}>{data.articlesPublished}</Text>
            <Text style={styles.statLabel}>Articles Published</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: accentColor }]}>{data.totalKeywords}</Text>
            <Text style={styles.statLabel}>Keywords Tracked</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: accentColor }]}>{data.avgPosition || "—"}</Text>
            <Text style={styles.statLabel}>Avg Position</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: accentColor }]}>{data.liveBacklinks}</Text>
            <Text style={styles.statLabel}>Live Backlinks</Text>
          </View>
        </View>

        {/* Analytics */}
        {(data.ga4Summary || data.gscSummary) && (
          <>
            <Text style={styles.sectionTitle}>Traffic & Search</Text>
            <View style={styles.statsRow}>
              {data.ga4Summary && (
                <>
                  <View style={styles.statBox}>
                    <Text style={styles.statValue}>{data.ga4Summary.pageviews.toLocaleString()}</Text>
                    <Text style={styles.statLabel}>Pageviews (GA4)</Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statValue}>{data.ga4Summary.sessions.toLocaleString()}</Text>
                    <Text style={styles.statLabel}>Sessions (GA4)</Text>
                  </View>
                </>
              )}
              {data.gscSummary && (
                <>
                  <View style={styles.statBox}>
                    <Text style={styles.statValue}>{data.gscSummary.clicks.toLocaleString()}</Text>
                    <Text style={styles.statLabel}>Clicks (GSC)</Text>
                  </View>
                  <View style={styles.statBox}>
                    <Text style={styles.statValue}>{data.gscSummary.impressions.toLocaleString()}</Text>
                    <Text style={styles.statLabel}>Impressions (GSC)</Text>
                  </View>
                </>
              )}
              {/* The one estimated figure in the report, labelled as one. It
                  sits beside the clicks it is made of, and prints an em dash
                  when nothing could be priced rather than a zero the client
                  would read as a verdict. */}
              {data.organicValue && (
                <View style={styles.statBox}>
                  <Text style={[styles.statValue, { color: accentColor }]}>{data.organicValue.formatted}</Text>
                  <Text style={styles.statLabel}>Estimated organic value</Text>
                </View>
              )}
            </View>
            {data.organicValue && <Text style={styles.note}>{data.organicValue.note}</Text>}
          </>
        )}

        {/* AI visibility. Omitted entirely when the workspace has never been
            probed: an absent section reads as "not measured", whereas a section
            of zeroes reads as "measured, and you are invisible". */}
        {data.geoSummary && (
          <>
            <Text style={styles.sectionTitle}>AI Visibility</Text>
            <View style={styles.statsRow}>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, { color: accentColor }]}>
                  {Math.round(data.geoSummary.mentionRate * 100)}%
                </Text>
                <Text style={styles.statLabel}>Answers naming you</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={[styles.statValue, { color: accentColor }]}>
                  {Math.round(data.geoSummary.citationRate * 100)}%
                </Text>
                <Text style={styles.statLabel}>Answers linking you</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{data.geoSummary.promptsTracked}</Text>
                <Text style={styles.statLabel}>Questions tracked</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statValue}>{data.geoSummary.engines.length}</Text>
                <Text style={styles.statLabel}>AI engines</Text>
              </View>
            </View>

            {/* Who the engines cite instead. This is the part that makes the
                number actionable rather than merely alarming. */}
            {data.geoSummary.topCompetitors.length > 0 && (
              <View style={styles.table}>
                <View style={styles.tableHeader}>
                  <Text style={styles.tableCell}>Cited instead of you</Text>
                  <Text style={styles.tableCellSmall}>Answers</Text>
                </View>
                {data.geoSummary.topCompetitors.map((c, i) => (
                  <View key={i} style={styles.tableRow}>
                    <Text style={styles.tableCell}>{c.domain}</Text>
                    <Text style={styles.tableCellSmall}>{c.citations}</Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}

        {/* Top Articles */}
        {data.topArticles.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Top Articles</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={styles.tableCell}>Title</Text>
                <Text style={styles.tableCellSmall}>SEO Score</Text>
                <Text style={styles.tableCellSmall}>Position</Text>
              </View>
              {data.topArticles.map((a, i) => (
                <View key={i} style={styles.tableRow}>
                  <Text style={styles.tableCell}>{a.title}</Text>
                  <Text style={styles.tableCellSmall}>{a.seo_score}/100</Text>
                  <Text style={styles.tableCellSmall}>{a.position ?? "—"}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* Keyword Movers */}
        {data.keywordMovers.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Keyword Movement</Text>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={styles.tableCell}>Keyword</Text>
                <Text style={styles.tableCellSmall}>Before</Text>
                <Text style={styles.tableCellSmall}>After</Text>
                <Text style={styles.tableCellSmall}>Change</Text>
              </View>
              {data.keywordMovers.slice(0, 10).map((k, i) => (
                <View key={i} style={styles.tableRow}>
                  <Text style={styles.tableCell}>{k.term}</Text>
                  <Text style={styles.tableCellSmall}>#{k.previousPosition}</Text>
                  <Text style={styles.tableCellSmall}>#{k.currentPosition}</Text>
                  <Text style={[styles.tableCellSmall, { color: k.change > 0 ? "#16a34a" : "#dc2626" }]}>
                    {k.change > 0 ? `+${k.change}` : k.change}
                  </Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* Footer */}
        <Text style={styles.footer}>
          Generated by {data.agency.name}{data.agency.remove_branding ? "" : " — Powered by AltoRank"}
        </Text>
      </Page>
    </Document>
  );
}
