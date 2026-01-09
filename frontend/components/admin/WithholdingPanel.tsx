import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
  useWindowDimensions,
} from "react-native";
import axios from "axios";
import { Ionicons } from "@expo/vector-icons";
import { BASE_API } from "../../constants/api";
import { useAuth } from "../../contexts/AuthContext";

type Props = { token: string | null };

type WtCode = {
  wt_id: string;
  wt_code: string;
  wt_description: string;
  e_wt: number | null;
  w_wt: number | null;
  l_wt: number | null;
  last_updated?: string;
  updated_by?: string;
};

type SortMode = "newest" | "oldest" | "codeAsc" | "codeDesc";

const fmtDate = (iso?: string) => {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : String(iso);
};

const toNumOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function notify(title: string, message?: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && window.alert) {
    window.alert(message ? `${title}\n\n${message}` : title);
  } else {
    Alert.alert(title, message);
  }
}

function errorText(err: any, fallback = "Server error.") {
  const d = err?.response?.data;
  if (typeof d === "string") return d;
  if (d?.error) return String(d.error);
  if (d?.message) return String(d.message);
  if (err?.message) return String(err.message);
  try { return JSON.stringify(d ?? err); } catch { return fallback; }
}

const Chip = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
  <TouchableOpacity onPress={onPress} style={[styles.chip, active ? styles.chipActive : styles.chipIdle]}>
    <Text style={[styles.chipText, active ? styles.chipTextActive : styles.chipTextIdle]}>{label}</Text>
  </TouchableOpacity>
);

export default function WithholdingPanel({ token }: Props) {
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const isBiller = hasRole("biller");
  const isOperator = hasRole("operator");
  const canEdit = isAdmin || isBiller;

  const { width } = useWindowDimensions();
  const isMobile = width < 640;

  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rows, setRows] = useState<WtCode[]>([]);
  const [query, setQuery] = useState("");
  const [onlyNonZero, setOnlyNonZero] = useState(false);
  const [hasAnyRate, setHasAnyRate] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("newest");

  const [filtersVisible, setFiltersVisible] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);

  const [c_code, setC_code] = useState("");
  const [c_desc, setC_desc] = useState("");
  const [c_e, setC_e] = useState("");
  const [c_w, setC_w] = useState("");
  const [c_l, setC_l] = useState("");

  const [editVisible, setEditVisible] = useState(false);
  const [editRow, setEditRow] = useState<WtCode | null>(null);

  const [e_code, setE_code] = useState("");
  const [e_desc, setE_desc] = useState("");
  const [e_e, setE_e] = useState("");
  const [e_w, setE_w] = useState("");
  const [e_l, setE_l] = useState("");

  const authHeader = useMemo(() => ({ Authorization: `Bearer ${token ?? ""}` }), [token]);
  const api = useMemo(() => axios.create({ baseURL: BASE_API, headers: authHeader, timeout: 15000 }), [authHeader]);

  const basePath = "/wt";

  useEffect(() => { loadAll(); }, [token]);

  const loadAll = async () => {
    if (!token) {
      setBusy(false);
      notify("Not logged in", "Please log in to manage withholding codes.");
      return;
    }
    try {
      setBusy(true);
      const res = await api.get<WtCode[]>(basePath);
      setRows(res.data || []);
    } catch (err) {
      notify("Load failed", errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nz = (v: number | null) => (v == null ? false : (onlyNonZero ? Number(v) > 0 : true));
    return rows.filter((r) => {
      const textOk = !q
        ? true
        : [r.wt_id, r.wt_code, r.wt_description, r.updated_by]
            .some((v) => String(v ?? "").toLowerCase().includes(q));
      const rateOk = hasAnyRate ? (nz(r.e_wt) || nz(r.w_wt) || nz(r.l_wt)) : true;
      return textOk && rateOk;
    });
  }, [rows, query, onlyNonZero, hasAnyRate]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    switch (sortMode) {
      case "codeAsc":
        return arr.sort((a, b) => a.wt_code.localeCompare(b.wt_code, undefined, { numeric: true }));
      case "codeDesc":
        return arr.sort((a, b) => b.wt_code.localeCompare(a.wt_code, undefined, { numeric: true }));
      case "oldest":
        return arr.sort((a, b) => (Date.parse(a.last_updated || "") || 0) - (Date.parse(b.last_updated || "") || 0));
      case "newest":
      default:
        return arr.sort((a, b) => (Date.parse(b.last_updated || "") || 0) - (Date.parse(a.last_updated || "") || 0));
    }
  }, [filtered, sortMode]);

  const onCreate = async () => {
    if (!canEdit) return;
    if (!c_code.trim()) {
      notify("Missing info", "Please enter a withholding code.");
      return;
    }
    try {
      setSubmitting(true);
      await api.post(basePath, {
        wt_code: c_code.trim(),
        wt_description: c_desc.trim(),
        e_wt: toNumOrNull(c_e),
        w_wt: toNumOrNull(c_w),
        l_wt: toNumOrNull(c_l),
      });
      setCreateVisible(false);
      setC_code(""); setC_desc(""); setC_e(""); setC_w(""); setC_l("");
      await loadAll();
      notify("Success", "Withholding code created.");
    } catch (err) {
      notify("Create failed", errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (row: WtCode) => {
    if (!canEdit) return;
    setEditRow(row);
    setE_code(row.wt_code || "");
    setE_desc(row.wt_description || "");
    setE_e(row.e_wt != null ? String(row.e_wt) : "");
    setE_w(row.w_wt != null ? String(row.w_wt) : "");
    setE_l(row.l_wt != null ? String(row.l_wt) : "");
    setEditVisible(true);
  };

  const onUpdate = async () => {
    if (!editRow || !canEdit) return;
    try {
      setSubmitting(true);
      await api.put(`${basePath}/${encodeURIComponent(editRow.wt_id)}`, {
        wt_code: e_code.trim(),
        wt_description: e_desc.trim(),
        e_wt: toNumOrNull(e_e),
        w_wt: toNumOrNull(e_w),
        l_wt: toNumOrNull(e_l),
      });
      setEditVisible(false);
      await loadAll();
      notify("Updated", "Withholding code updated.");
    } catch (err) {
      notify("Update failed", errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = (row: WtCode) => {
    if (!canEdit) return;
    const go = async () => {
      try {
        setSubmitting(true);
        await api.delete(`${basePath}/${encodeURIComponent(row.wt_id)}`);
        await loadAll();
        notify("Deleted", "Withholding code removed.");
      } catch (err) {
        notify("Delete failed", errorText(err));
      } finally {
        setSubmitting(false);
      }
    };

    if (Platform.OS === "web" && window.confirm) {
      if (window.confirm(`Delete ${row.wt_code} (${row.wt_id})?`)) go();
    } else {
      Alert.alert("Confirm delete", `Delete ${row.wt_code}?`, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: go },
      ]);
    }
  };

  return (
    <View style={styles.page}>
      <View style={styles.grid}>
        <View style={styles.card}>
          
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Withholding Codes</Text>

            {canEdit && (
              <TouchableOpacity style={styles.btn} onPress={() => setCreateVisible(true)}>
                <Text style={styles.btnText}>+ New</Text>
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.filtersBar}>
            <View style={[styles.searchWrap, { flex: 1 }]}>
              <Ionicons name="search" size={16} color="#94a3b8" style={{ marginRight: 6 }} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search by ID, code, or description…"
                placeholderTextColor="#9aa5b1"
                style={styles.search}
              />
            </View>

            <TouchableOpacity style={styles.btnGhost} onPress={() => setFiltersVisible(true)}>
              <Ionicons name="options-outline" size={16} color="#394e6a" style={{ marginRight: 6 }} />
              <Text style={styles.btnGhostText}>Filters</Text>
            </TouchableOpacity>
          </View>

          {busy ? (
            <View style={styles.loader}><ActivityIndicator /></View>
          ) : (
            <FlatList
              data={sorted}
              keyExtractor={(r) => r.wt_id}
              style={{ flex: 1 }}
              contentContainerStyle={sorted.length === 0 ? styles.emptyPad : { paddingBottom: 24 }}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons name="cash-outline" size={42} color="#cbd5e1" />
                  <Text style={styles.emptyTitle}>No withholding codes</Text>
                  <Text style={styles.emptyText}>Try adjusting your search or create a new one.</Text>
                </View>
              }
              renderItem={({ item }) => (
                <View style={[styles.row, isMobile && styles.rowMobile]}>
                  
                  <View style={styles.rowMain}>
                    <Text style={styles.rowTitle}>
                      {item.wt_code} <Text style={styles.rowSub}>({item.wt_id})</Text>
                    </Text>
                    <Text style={styles.rowMeta}>{item.wt_description || "—"}</Text>
                    <Text style={styles.rowMeta}>
                      ELECTRIC: {item.e_wt ?? "—"} • WATER: {item.w_wt ?? "—"} • LPG: {item.l_wt ?? "—"}
                    </Text>

                    {item.last_updated ? (
                      <Text style={styles.rowMetaSmall}>
                        Updated {fmtDate(item.last_updated)} {item.updated_by ? `• by ${item.updated_by}` : ""}
                      </Text>
                    ) : null}
                  </View>

                  {canEdit && (
                    isMobile ? (
                      <View style={styles.rowActionsMobile}>
                        <TouchableOpacity style={[styles.actionBtn, styles.actionEdit]} onPress={() => openEdit(item)}>
                          <Ionicons name="create-outline" size={16} color="#1f2937" />
                          <Text style={[styles.actionText, styles.actionEditText]}>Update</Text>
                        </TouchableOpacity>

                        <TouchableOpacity style={[styles.actionBtn, styles.actionDelete]} onPress={() => onDelete(item)}>
                          <Ionicons name="trash-outline" size={16} color="#fff" />
                          <Text style={[styles.actionText, styles.actionDeleteText]}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.rowActions}>
                        <TouchableOpacity style={[styles.actionBtn, styles.actionEdit]} onPress={() => openEdit(item)}>
                          <Ionicons name="create-outline" size={16} color="#1f2937" />
                          <Text style={[styles.actionText, styles.actionEditText]}>Update</Text>
                        </TouchableOpacity>

                        <TouchableOpacity style={[styles.actionBtn, styles.actionDelete]} onPress={() => onDelete(item)}>
                          <Ionicons name="trash-outline" size={16} color="#fff" />
                          <Text style={[styles.actionText, styles.actionDeleteText]}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    )
                  )}
                </View>
              )}
            />
          )}

        </View>
      </View>

      <Modal visible={filtersVisible} transparent animationType="fade" onRequestClose={() => setFiltersVisible(false)}>
        <View style={styles.promptOverlay}>
          <View style={styles.promptCard}>
            <Text style={styles.modalTitle}>Filters & Sort</Text>
            <View style={styles.modalDivider} />

            <Text style={styles.dropdownLabel}>Sort by</Text>
            <View style={styles.chipsRow}>
              <Chip label="Newest"  active={sortMode === "newest"}  onPress={() => setSortMode("newest")} />
              <Chip label="Oldest"  active={sortMode === "oldest"}  onPress={() => setSortMode("oldest")} />
              <Chip label="Code ↑"  active={sortMode === "codeAsc"} onPress={() => setSortMode("codeAsc")} />
              <Chip label="Code ↓"  active={sortMode === "codeDesc"} onPress={() => setSortMode("codeDesc")} />
            </View>

            <Text style={[styles.dropdownLabel, { marginTop: 10 }]}>Other</Text>

            <View style={styles.chipsRow}>
              <Chip label="Only non-zero" active={onlyNonZero} onPress={() => setOnlyNonZero((v) => !v)} />
              <Chip label="Has any rate" active={hasAnyRate} onPress={() => setHasAnyRate((v) => !v)} />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.btnGhostAlt]}
                onPress={() => {
                  setSortMode("newest");
                  setOnlyNonZero(false);
                  setHasAnyRate(false);
                }}
              >
                <Text style={styles.btnGhostTextAlt}>Reset</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.btn]} onPress={() => setFiltersVisible(false)}>
                <Text style={styles.btnText}>Done</Text>
              </TouchableOpacity>
            </View>

          </View>
        </View>
      </Modal>

      {canEdit && (
        <Modal visible={createVisible} animationType="fade" transparent onRequestClose={() => setCreateVisible(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>New Withholding Code</Text>
              <View style={styles.modalDivider} />

              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Code</Text>
                  <TextInput
                    placeholder="e.g., WH-01"
                    value={c_code}
                    onChangeText={setC_code}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>

                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Description</Text>
                  <TextInput
                    placeholder="Description"
                    value={c_desc}
                    onChangeText={setC_desc}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>

                <Text style={styles.sectionTitle}>Rates (%)</Text>

                <View style={styles.grid3}>
                  <View style={styles.inputRow}>
                    <Text style={styles.inputLabel}>Electric %</Text>
                    <TextInput
                      keyboardType="numeric"
                      value={c_e}
                      onChangeText={setC_e}
                      style={styles.input}
                      placeholderTextColor="#9aa5b1"
                      editable={canEdit}
                    />
                  </View>

                  <View style={styles.inputRow}>
                    <Text style={styles.inputLabel}>Water %</Text>
                    <TextInput
                      keyboardType="numeric"
                      value={c_w}
                      onChangeText={setC_w}
                      style={styles.input}
                      placeholderTextColor="#9aa5b1"
                      editable={canEdit}
                    />
                  </View>

                  <View style={styles.inputRow}>
                    <Text style={styles.inputLabel}>LPG %</Text>
                    <TextInput
                      keyboardType="numeric"
                      value={c_l}
                      onChangeText={setC_l}
                      style={styles.input}
                      placeholderTextColor="#9aa5b1"
                      editable={canEdit}
                    />
                  </View>
                </View>

                <Text style={styles.helpText}>
                  Leave blank to save as <Text style={{ fontWeight: "700" }}>null</Text>.
                </Text>

              </ScrollView>

              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btnGhostAlt]} onPress={() => setCreateVisible(false)}>
                  <Text style={styles.btnGhostTextAlt}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} onPress={onCreate} disabled={submitting}>
                  <Text style={styles.btnText}>{submitting ? "Saving…" : "Create"}</Text>
                </TouchableOpacity>
              </View>

            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}

      {canEdit && (
        <Modal visible={editVisible} animationType="fade" transparent onRequestClose={() => setEditVisible(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>{editRow ? `Edit • ${editRow.wt_code}` : "Edit Withholding Code"}</Text>
              <View style={styles.modalDivider} />

              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>

                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Code</Text>
                  <TextInput
                    placeholder="e.g., WH-01"
                    value={e_code}
                    onChangeText={setE_code}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>

                <View style={styles.inputRow}>
                  <Text style={styles.inputLabel}>Description</Text>
                  <TextInput
                    placeholder="Description"
                    value={e_desc}
                    onChangeText={setE_desc}
                    style={styles.input}
                    placeholderTextColor="#9aa5b1"
                    editable={canEdit}
                  />
                </View>

                <Text style={styles.sectionTitle}>Rates (%)</Text>

                <View style={styles.grid3}>
                  <View style={styles.inputRow}>
                    <Text style={styles.inputLabel}>Electric %</Text>
                    <TextInput
                      keyboardType="numeric"
                      value={e_e}
                      onChangeText={setE_e}
                      style={styles.input}
                      placeholderTextColor="#9aa5b1"
                      editable={canEdit}
                    />
                  </View>

                  <View style={styles.inputRow}>
                    <Text style={styles.inputLabel}>Water %</Text>
                    <TextInput
                      keyboardType="numeric"
                      value={e_w}
                      onChangeText={setE_w}
                      style={styles.input}
                      placeholderTextColor="#9aa5b1"
                      editable={canEdit}
                    />
                  </View>

                  <View style={styles.inputRow}>
                    <Text style={styles.inputLabel}>LPG %</Text>
                    <TextInput
                      keyboardType="numeric"
                      value={e_l}
                      onChangeText={setE_l}
                      style={styles.input}
                      placeholderTextColor="#9aa5b1"
                      editable={canEdit}
                    />
                  </View>
                </View>

                {editRow?.last_updated ? (
                  <Text style={styles.helpText}>
                    Last updated: {fmtDate(editRow.last_updated)} {editRow.updated_by ? `• ${editRow.updated_by}` : ""}
                  </Text>
                ) : null}

              </ScrollView>

              <View style={styles.modalActions}>
                <TouchableOpacity style={[styles.btnGhostAlt]} onPress={() => setEditVisible(false)}>
                  <Text style={styles.btnGhostTextAlt}>Close</Text>
                </TouchableOpacity>

                <TouchableOpacity style={[styles.btn, submitting && styles.btnDisabled]} onPress={onUpdate} disabled={submitting}>
                  <Text style={styles.btnText}>{submitting ? "Saving…" : "Save"}</Text>
                </TouchableOpacity>
              </View>

            </View>
          </KeyboardAvoidingView>
        </Modal>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0 },
  grid: { flex: 1, padding: 14, gap: 14, minHeight: 0 },
  card: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 14,
    ...(Platform.select({
      web: { boxShadow: "0 10px 30px rgba(15, 23, 42, 0.08)" } as any,
      default: { elevation: 2 },
    }) as any),
  },

  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },

  cardTitle: { fontSize: 18, fontWeight: "700", color: "#0f172a" },

  btn: {
    backgroundColor: "#2563eb",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  btnText: { color: "#fff", fontWeight: "700" },
  btnDisabled: { opacity: 0.6 },

  filtersBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 10,
    flexWrap: "wrap",
  },

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f1f5f9",
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },

  search: {
    flex: 1,
    height: 40,
    color: "#0f172a",
  },

  btnGhost: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#e2e8f0",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },

  btnGhostText: { color: "#394e6a", fontWeight: "700" },

  loader: { paddingVertical: 24, alignItems: "center", justifyContent: "center" },

  row: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
  },

  rowMobile: {
    flexDirection: "column",
    alignItems: "stretch",
  },

  rowMain: {
    flex: 1,
    paddingRight: 10,
  },

  rowTitle: { fontSize: 16, fontWeight: "700", color: "#0f172a" },
  rowSub: { color: "#64748b", fontWeight: "600" },

  rowMeta: { color: "#334155", marginTop: 6 },

  rowMetaSmall: { color: "#94a3b8", marginTop: 2, fontSize: 12 },

  rowActions: {
    width: 200,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
  },

  rowActionsMobile: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    justifyContent: "flex-start",
    alignItems: "center",
  },

  actionBtn: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  actionEdit: { backgroundColor: "#e2e8f0" },
  actionDelete: { backgroundColor: "#ef4444" },

  actionText: { fontWeight: "700" },
  actionEditText: { color: "#1f2937" },
  actionDeleteText: { color: "#fff" },

  emptyPad: { paddingVertical: 30 },

  empty: { alignItems: "center", gap: 6 },
  emptyTitle: { fontWeight: "800", color: "#0f172a" },
  emptyText: { color: "#94a3b8" },

  modalWrap: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.36)",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
  },

  modalCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    width: "100%",
    maxWidth: 720,
    padding: 14,
    ...(Platform.select({
      web: { boxShadow: "0 14px 44px rgba(15, 23, 42, 0.16)" } as any,
      default: { elevation: 3 },
    }) as any),
  },

  modalTitle: { fontSize: 18, fontWeight: "800", color: "#0f172a" },

  modalDivider: { height: 1, backgroundColor: "#e2e8f0", marginVertical: 10 },

  modalActions: {
    marginTop: 10,
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },

  btnGhostAlt: {
    backgroundColor: "#f1f5f9",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },

  btnGhostTextAlt: { color: "#334155", fontWeight: "700" },

  inputRow: { marginBottom: 10 },

  inputLabel: { color: "#334155", fontWeight: "700", marginBottom: 6 },

  input: {
    backgroundColor: "#f8fafc",
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 10,
    height: 40,
    paddingHorizontal: 10,
    color: "#0f172a",
  },

  sectionTitle: { marginTop: 10, marginBottom: 6, fontWeight: "800", color: "#0f172a" },

  helpText: { color: "#94a3b8", fontSize: 12, lineHeight: 16, marginTop: 2 },

  grid3: {
    gap: 10,
    ...(Platform.OS === "web"
      ? ({
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          columnGap: 10,
          rowGap: 10,
        } as any)
      : {}),
  },

  promptOverlay: {
    flex: 1,
    backgroundColor: "rgba(15,23,42,0.36)",
    alignItems: "center",
    justifyContent: "center",
    padding: 14,
  },

  promptCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    width: "100%",
    maxWidth: 560,
    padding: 14,
    ...(Platform.select({
      web: { boxShadow: "0 14px 44px rgba(15, 23, 42, 0.16)" } as any,
      default: { elevation: 3 },
    }) as any),
  },

  dropdownLabel: { fontWeight: "800", color: "#0f172a", marginBottom: 8 },

  chipsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },

  chip: {
    borderWidth: 1,
    borderColor: "#cbd5e1",
    backgroundColor: "#f8fafc",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },

  chipActive: { backgroundColor: "#e0ecff", borderColor: "#93c5fd" },
  chipIdle: {},

  chipText: { fontWeight: "700" },
  chipTextActive: { color: "#1d4ed8" },
  chipTextIdle: { color: "#334155" },

});