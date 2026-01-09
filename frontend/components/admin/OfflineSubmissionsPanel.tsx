import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import axios from "axios";
import { Ionicons } from "@expo/vector-icons";

import { BASE_API } from "../../constants/api";
import { useAuth } from "../../contexts/AuthContext";
import { Card, Button } from "../ui/ProUI";

type OfflineSubmission = {
  submission_id: number;
  submitted_at: string;
  status: "submitted" | "approved" | "rejected";
  submitted_by: number;

  approved_by?: number | null;
  approved_at?: string | null;
  reject_reason?: string | null;

  device_name?: string | null;
  device_serial?: string | null;
};

export default function OfflineSubmissionsPanel() {
  const { token, hasRole } = useAuth();
  const isAdmin = hasRole("admin");

  const [items, setItems] = useState<OfflineSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "submitted" | "approved" | "rejected">(
    "submitted"
  );

  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const notify = (title: string, message?: string) => {
    if (typeof window !== "undefined" && window.alert) {
      window.alert(message ? `${title}\n\n${message}` : title);
    } else {
      console.log(title, message);
    }
  };

  const errorText = (err: any, fallback = "Server error.") => {
    const d = err?.response?.data;
    if (typeof d === "string") return d;
    if (d?.error) return String(d.error);
    if (d?.message) return String(d.message);
    if (err?.message) return String(err.message);
    try {
      return JSON.stringify(d ?? err);
    } catch {
      return fallback;
    }
  };

  const api = useMemo(
    () =>
      axios.create({
        baseURL: BASE_API,
        timeout: 20000,
        headers: { Authorization: `Bearer ${token ?? ""}` },
      }),
    [token]
  );

  const load = useCallback(async () => {
    if (!token || !isAdmin) return;
    try {
      setLoading(true);
      setError(null);
      const res = await api.get<OfflineSubmission[]>("/offlineExport/submissions");
      setItems(res.data || []);
    } catch (e) {
      const msg = errorText(e);
      setError(msg);
      notify("Failed to load submissions", msg);
    } finally {
      setLoading(false);
    }
  }, [api, token, isAdmin]);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const approve = async (id: number) => {
    if (!token || !isAdmin) return;
    try {
      setBusyId(id);
      await api.post(`/offlineExport/submissions/${id}/approve`);
      notify("Approved", `Submission #${id} approved.`);
      await load();
    } catch (e) {
      notify("Approve failed", errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  const openReject = (id: number) => {
    setRejectingId(id);
    setRejectReason("");
  };

  const submitReject = async () => {
    if (!token || !isAdmin || !rejectingId) return;
    try {
      setBusyId(rejectingId);
      await api.post(`/offlineExport/submissions/${rejectingId}/reject`, {
        reason: rejectReason.trim() || "Rejected by admin",
      });
      notify("Rejected", `Submission #${rejectingId} rejected.`);
      setRejectingId(null);
      setRejectReason("");
      await load();
    } catch (e) {
      notify("Reject failed", errorText(e));
    } finally {
      setBusyId(null);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((x) => (statusFilter === "all" ? true : x.status === statusFilter))
      .filter((x) => {
        if (!q) return true;
        const hay = [
          String(x.submission_id),
          x.status,
          x.device_name ?? "",
          x.device_serial ?? "",
          String(x.submitted_by),
          x.reject_reason ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
  }, [items, query, statusFilter]);

  if (!isAdmin) {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed-outline" size={32} color="#9ca3af" />
        <Text style={styles.centerTitle}>Admin access only</Text>
        <Text style={styles.centerText}>Only admin users can approve offline submissions.</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Offline Submissions</Text>
          <Text style={styles.subtitle}>Approve or reject offline exported readings.</Text>
        </View>
        <Button variant="ghost" onPress={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </View>

      <Card style={styles.filtersCard}>
        <Text style={styles.sectionTitle}>Filters</Text>

        <Text style={styles.label}>Search</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search by id, device, serial, status…"
          style={styles.input}
          autoCapitalize="none"
        />

        <View style={styles.filterRow}>
          <Button
            variant={statusFilter === "submitted" ? "solid" : "ghost"}
            onPress={() => setStatusFilter("submitted")}
          >
            Submitted
          </Button>
          <View style={{ width: 8 }} />
          <Button
            variant={statusFilter === "approved" ? "solid" : "ghost"}
            onPress={() => setStatusFilter("approved")}
          >
            Approved
          </Button>
          <View style={{ width: 8 }} />
          <Button
            variant={statusFilter === "rejected" ? "solid" : "ghost"}
            onPress={() => setStatusFilter("rejected")}
          >
            Rejected
          </Button>
          <View style={{ width: 8 }} />
          <Button
            variant={statusFilter === "all" ? "solid" : "ghost"}
            onPress={() => setStatusFilter("all")}
          >
            All
          </Button>
        </View>

        <Text style={styles.countText}>
          Showing {filtered.length} of {items.length}
        </Text>
      </Card>

      {loading && items.length === 0 ? (
        <View style={styles.loader}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Button variant="ghost" onPress={load}>
            Retry
          </Button>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="folder-open-outline" size={32} color="#9ca3af" />
          <Text style={styles.centerTitle}>No submissions found</Text>
          <Text style={styles.centerText}>Try switching the status filter or clear search.</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(x) => String(x.submission_id)}
          contentContainerStyle={{ paddingVertical: 8 }}
          renderItem={({ item }) => {
            const isBusy = busyId === item.submission_id;
            const canApproveReject = item.status === "submitted";

            return (
              <Card style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.rowTitle}>
                      Submission #{item.submission_id}
                    </Text>
                    <Text style={styles.meta}>
                      Status: <Text style={styles.metaStrong}>{item.status}</Text>
                    </Text>
                    <Text style={styles.meta}>Submitted at: {item.submitted_at}</Text>
                    <Text style={styles.meta}>Submitted by (user_id): {item.submitted_by}</Text>

                    <Text style={styles.meta}>
                      Device: {item.device_name || "Unknown"}{" "}
                      {item.device_serial ? `• ${item.device_serial}` : ""}
                    </Text>

                    {item.status === "rejected" && item.reject_reason ? (
                      <Text style={styles.rejectReason}>
                        Reject reason: {item.reject_reason}
                      </Text>
                    ) : null}

                    {item.status === "approved" && item.approved_at ? (
                      <Text style={styles.metaSmall}>
                        Approved at: {item.approved_at} • by user_id: {item.approved_by ?? "-"}
                      </Text>
                    ) : null}
                  </View>

                  <View
                    style={[
                      styles.badge,
                      item.status === "submitted"
                        ? styles.badgeSubmitted
                        : item.status === "approved"
                        ? styles.badgeApproved
                        : styles.badgeRejected,
                    ]}
                  >
                    <Text style={styles.badgeText}>{item.status.toUpperCase()}</Text>
                  </View>
                </View>

                <View style={styles.actionsRow}>
                  <Button
                    variant="solid"
                    onPress={() => approve(item.submission_id)}
                    disabled={!canApproveReject || isBusy}
                  >
                    {isBusy ? "Working…" : "Approve"}
                  </Button>

                  <View style={{ width: 8 }} />

                  <Button
                    variant="danger"
                    onPress={() => openReject(item.submission_id)}
                    disabled={!canApproveReject || isBusy}
                  >
                    {isBusy ? "Working…" : "Reject"}
                  </Button>
                </View>
              </Card>
            );
          }}
        />
      )}

      {rejectingId !== null ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Reject Submission #{rejectingId}</Text>
            <Text style={styles.modalLabel}>Reason (optional)</Text>
            <TextInput
              value={rejectReason}
              onChangeText={setRejectReason}
              placeholder="e.g. Invalid photo / wrong meter / duplicate"
              style={styles.input}
              autoCapitalize="sentences"
              multiline
            />

            <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 10 }}>
              <Button
                variant="ghost"
                onPress={() => {
                  setRejectingId(null);
                  setRejectReason("");
                }}
                disabled={busyId === rejectingId}
              >
                Cancel
              </Button>

              <View style={{ width: 8 }} />

              <Button
                variant="danger"
                onPress={submitReject}
                disabled={busyId === rejectingId}
              >
                {busyId === rejectingId ? "Working…" : "Reject"}
              </Button>
            </View>

            {Platform.OS !== "web" ? (
              <Text style={styles.modalHint}>
                Tip: keep the reason short. Admin can re-export if needed.
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: "#f8fafc", gap: 12 },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  title: { fontSize: 22, fontWeight: "700", color: "#0f172a" },
  subtitle: { fontSize: 14, color: "#64748b", marginBottom: 4 },

  loader: { flex: 1, paddingVertical: 24, alignItems: "center", justifyContent: "center" },

  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center", gap: 8 },
  centerTitle: { fontSize: 16, fontWeight: "600", color: "#111827", marginTop: 4 },
  centerText: { fontSize: 14, color: "#6b7280", textAlign: "center", maxWidth: 320 },
  errorText: { fontSize: 14, color: "#b91c1c", textAlign: "center" },

  filtersCard: { padding: 14, borderRadius: 14, backgroundColor: "#ffffff" },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: "#0f172a", marginBottom: 8 },
  label: { fontSize: 12, color: "#64748b", marginTop: 8, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#fff",
    fontSize: 14,
    color: "#111827",
  },
  filterRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 10 },
  countText: { marginTop: 8, fontSize: 12, color: "#6b7280" },

  card: { marginVertical: 6, padding: 14, borderRadius: 14, backgroundColor: "#ffffff" },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  rowTitle: { fontSize: 15, fontWeight: "700", color: "#0f172a" },
  meta: { marginTop: 4, fontSize: 12, color: "#6b7280" },
  metaStrong: { fontWeight: "700", color: "#0f172a" },
  metaSmall: { marginTop: 6, fontSize: 11, color: "#9ca3af" },

  rejectReason: { marginTop: 6, fontSize: 12, color: "#b91c1c" },

  badge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  badgeSubmitted: { backgroundColor: "#fff7ed" },
  badgeApproved: { backgroundColor: "#ecfdf5" },
  badgeRejected: { backgroundColor: "#fef2f2" },
  badgeText: { fontSize: 11, fontWeight: "800", color: "#0f172a" },

  actionsRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 12 },

  modalBackdrop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
  },
  modalTitle: { fontSize: 16, fontWeight: "800", color: "#0f172a" },
  modalLabel: { fontSize: 12, color: "#64748b", marginTop: 10, marginBottom: 4 },
  modalHint: { marginTop: 10, fontSize: 11, color: "#9ca3af" },
});